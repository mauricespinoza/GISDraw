/**
 * Formas de un hilo a otro sin pagar la copia estructurada de millones de
 * objetos pequeños (un .ai grande trae decenas de miles de trazos con cientos
 * de miles de nodos): los nodos viajan como un solo arreglo de números por
 * trazo y cada estilo como lo que difiere del estilo por defecto.
 *
 * `pack` deja el resultado listo para `postMessage` (y la lista de buffers a
 * transferir); `unpack` lo vuelve a dejar como estaba.
 */

import { defaultStyle } from '../style.js';

const STRIDE = 7; // x, y, hInX, hInY, hOutX, hOutY, suave (NaN = sin manija)

function packNodes(nodes, transfer) {
  const a = new Float64Array(nodes.length * STRIDE);
  nodes.forEach((n, i) => {
    const o = i * STRIDE;
    a[o] = n.x;
    a[o + 1] = n.y;
    a[o + 2] = n.hIn ? n.hIn.x : NaN;
    a[o + 3] = n.hIn ? n.hIn.y : NaN;
    a[o + 4] = n.hOut ? n.hOut.x : NaN;
    a[o + 5] = n.hOut ? n.hOut.y : NaN;
    a[o + 6] = n.smooth ? 1 : 0;
  });
  transfer.push(a.buffer);
  return a;
}

function unpackNodes(a) {
  const out = new Array(a.length / STRIDE);
  for (let i = 0, o = 0; i < out.length; i++, o += STRIDE) {
    out[i] = {
      x: a[o],
      y: a[o + 1],
      hIn: a[o + 2] === a[o + 2] ? { x: a[o + 2], y: a[o + 3] } : null,
      hOut: a[o + 4] === a[o + 4] ? { x: a[o + 4], y: a[o + 5] } : null,
      smooth: a[o + 6] === 1,
    };
  }
  return out;
}

/** Lo que el estilo tiene distinto del estilo por defecto. */
function styleDiff(style, base) {
  const d = {};
  for (const k in style) {
    const v = style[k];
    const b = base[k];
    if (v === b) continue;
    if (v && typeof v === 'object' && JSON.stringify(v) === JSON.stringify(b)) continue;
    d[k] = v;
  }
  return d;
}

/** Capas ({ name, shapes }) listas para `postMessage`, más los buffers a transferir. */
export function packLayers(layers) {
  const transfer = [];
  const base = defaultStyle();
  const seen = new Map(); // un objeto compartido entre listas se empaqueta una vez
  const one = (s) => {
    if (seen.has(s)) return seen.get(s);
    const p = { ...s };
    if (s.type === 'group') p.children = s.children.map(one);
    if (s.type === 'path') {
      p.nodes = packNodes(s.nodes, transfer);
      if (s.holes) p.holes = s.holes.map((h) => packNodes(h, transfer));
    }
    if (s.style) p.style = styleDiff(s.style, base);
    seen.set(s, p);
    return p;
  };
  return { layers: layers.map((l) => ({ ...l, shapes: l.shapes.map(one) })), transfer };
}

/** Inversa de `packLayers`. */
export function unpackLayers(layers) {
  const seen = new Map();
  const one = (p) => {
    if (seen.has(p)) return seen.get(p);
    const s = { ...p };
    if (p.type === 'group') s.children = p.children.map(one);
    if (p.type === 'path') {
      s.nodes = unpackNodes(p.nodes);
      if (p.holes) s.holes = p.holes.map(unpackNodes);
    }
    if (p.style) s.style = { ...defaultStyle(), ...p.style };
    seen.set(p, s);
    return s;
  };
  return layers.map((l) => ({ ...l, shapes: l.shapes.map(one) }));
}
