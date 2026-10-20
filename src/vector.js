/**
 * Modelo vectorial: formas, nodos Bézier y geometría.
 *
 * Heredado del editor de GeoPhoto Studio (`lib/vector.js`), con un cambio de
 * fondo: las coordenadas ya no son píxeles de una foto sino METROS UTM 19S
 * (x = Este, y = Norte). Eso es lo que convierte el dibujo en un dato: una
 * forma mide lo que mide, se exporta sin reproyectar y el snapping trabaja en
 * metros.
 *
 * Las formas son inmutables: toda edición devuelve un objeto nuevo. Gracias a
 * eso el historial guarda referencias y no copias, y las cachés de geometría
 * aplanada pueden colgar de un WeakMap.
 *
 * Tipos:
 *  - path   nodos {x, y, hIn, hOut, smooth}, `closed`, y `holes` opcional
 *           (anillos interiores, cada uno una lista de nodos).
 *  - text   rótulo libre, tamaño en pt a la escala de referencia.
 *  - point  símbolo puntual (círculo, cuadrado, triángulo…), tamaño en mm.
 *  - group  `children`; con `clip: true` el PRIMER hijo es la máscara de
 *           recorte, igual que en Illustrator.
 */

import { defaultStyle, defaultTextStyle } from './style.js';
import { approxMeasure, layoutText } from './textLayout.js';

let counter = 0;
export function newId(prefix = 's') {
  counter = (counter + 1) % 1e6;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/* ------------------------------------------------------------ constructores */

export function makeNode(x, y, hIn = null, hOut = null, smooth = false) {
  return { x, y, hIn, hOut, smooth };
}

export function makePath(nodes, { closed = false, style, name, attrs, holes } = {}) {
  return {
    id: newId('p'),
    type: 'path',
    nodes,
    closed,
    holes: holes || null,
    style: style || defaultStyle(),
    name: name || (closed ? 'Polígono' : 'Línea'),
    attrs: attrs || {},
    visible: true,
    locked: false,
  };
}

export function makeRectPath(x0, y0, x1, y1, style) {
  const [ax, bx] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [ay, by] = [Math.min(y0, y1), Math.max(y0, y1)];
  const p = makePath(
    [makeNode(ax, ay), makeNode(bx, ay), makeNode(bx, by), makeNode(ax, by)],
    { closed: true, style },
  );
  p.name = 'Rectángulo';
  return p;
}

export function makeEllipsePath(cx, cy, rx, ry, style) {
  const k = 0.5522847498;
  const nodes = [
    makeNode(cx, cy + ry, { x: cx - rx * k, y: cy + ry }, { x: cx + rx * k, y: cy + ry }, true),
    makeNode(cx + rx, cy, { x: cx + rx, y: cy + ry * k }, { x: cx + rx, y: cy - ry * k }, true),
    makeNode(cx, cy - ry, { x: cx + rx * k, y: cy - ry }, { x: cx - rx * k, y: cy - ry }, true),
    makeNode(cx - rx, cy, { x: cx - rx, y: cy - ry * k }, { x: cx - rx, y: cy + ry * k }, true),
  ];
  const p = makePath(nodes, { closed: true, style });
  p.name = 'Elipse';
  return p;
}

export function makeText(x, y, text, style, fontSize = 10) {
  return {
    id: newId('t'),
    type: 'text',
    x,
    y,
    text: text || 'Texto',
    fontSize, // pt
    fontFamily: 'Helvetica, Arial, sans-serif',
    fontWeight: 400,
    italic: false,
    anchor: 'start',
    align: 'left', // left | center | right | justify (justificar necesita boxWidth)
    boxWidth: null, // mm de papel; >0 = cuadro de texto con ajuste de línea
    lineHeight: 1.2, // múltiplo del tamaño
    letterSpacing: 0, // milésimas de em
    wordSpacing: 0, // milésimas de em
    rotation: 0, // grados, horario en pantalla
    halo: true,
    haloColor: '#ffffff',
    haloWidth: 0.6, // mm
    style: style || defaultTextStyle(),
    name: 'Texto',
    attrs: {},
    visible: true,
    locked: false,
  };
}

export function makePoint(x, y, style, attrs) {
  return {
    id: newId('o'),
    type: 'point',
    x,
    y,
    style: style || { ...defaultStyle(), fill: '#e11d48', fillOpacity: 1, stroke: '#ffffff', strokeWidth: 0.3, pointShape: 'circle', pointSize: 2.5 },
    name: 'Punto',
    attrs: attrs || {},
    visible: true,
    locked: false,
  };
}

export function makeGroup(children, { clip = false, name } = {}) {
  return {
    id: newId('g'),
    type: 'group',
    children,
    clip,
    name: name || (clip ? 'Grupo de recorte' : 'Grupo'),
    attrs: {},
    visible: true,
    locked: false,
  };
}

/* --------------------------------------------------------------- clonado */

export function cloneNode(n) {
  return {
    x: n.x,
    y: n.y,
    hIn: n.hIn ? { ...n.hIn } : null,
    hOut: n.hOut ? { ...n.hOut } : null,
    smooth: !!n.smooth,
    ...(n.frozen ? { frozen: true } : {}),
  };
}

/** Copia profunda con ids nuevos (pegar, duplicar). La copia no hereda los nodos congelados. */
export function cloneShape(shape) {
  const base = JSON.parse(JSON.stringify(shape));
  const thaw = (nodes) => nodes?.forEach((n) => delete n.frozen);
  const reid = (s) => {
    s.id = newId(s.type === 'group' ? 'g' : s.id?.[0] || 's');
    if (s.type === 'group') s.children.forEach(reid);
    thaw(s.nodes);
    s.holes?.forEach(thaw);
    return s;
  };
  return reid(base);
}

/* ------------------------------------------------------- transformaciones */

/**
 * Aplica `f({x,y}) -> {x,y}` a todos los puntos de la forma (nodos, manejadores, anclas).
 * Los nodos congelados (Freeze node) no se transforman: quedan donde están, con sus manijas.
 */
export function mapPoints(shape, f) {
  switch (shape.type) {
    case 'text':
    case 'point': {
      const p = f({ x: shape.x, y: shape.y });
      return { ...shape, x: p.x, y: p.y };
    }
    case 'group':
      return { ...shape, children: shape.children.map((c) => mapPoints(c, f)) };
    default: {
      const mapNodes = (nodes) =>
        nodes.map((n) => {
          if (n.frozen) return n;
          const p = f(n);
          return {
            x: p.x,
            y: p.y,
            hIn: n.hIn ? f(n.hIn) : null,
            hOut: n.hOut ? f(n.hOut) : null,
            smooth: !!n.smooth,
          };
        });
      return {
        ...shape,
        nodes: mapNodes(shape.nodes),
        holes: shape.holes ? shape.holes.map(mapNodes) : shape.holes,
      };
    }
  }
}

export const translateShape = (shape, dx, dy) => mapPoints(shape, (p) => ({ x: p.x + dx, y: p.y + dy }));

export function scaleShape(shape, origin, sx, sy) {
  const out = mapPoints(shape, (p) => ({
    x: origin.x + (p.x - origin.x) * sx,
    y: origin.y + (p.y - origin.y) * sy,
  }));
  if (shape.type === 'text') {
    const k = Math.sqrt(Math.abs(sx * sy));
    out.fontSize = Math.max(1, Math.round(shape.fontSize * k * 100) / 100);
    // un cuadro de texto crece con el estirado: el ajuste de línea se mantiene
    if (shape.boxWidth > 0) out.boxWidth = Math.round(shape.boxWidth * k * 10) / 10;
  }
  return out;
}

export function rotateShape(shape, origin, deg) {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const out = mapPoints(shape, (p) => {
    const dx = p.x - origin.x;
    const dy = p.y - origin.y;
    return { x: origin.x + dx * c - dy * s, y: origin.y + dx * s + dy * c };
  });
  // En pantalla y crece hacia abajo: una rotación antihoraria del mundo es
  // horaria negativa del rótulo.
  if (shape.type === 'text') out.rotation = ((shape.rotation || 0) - deg) % 360;
  return out;
}

/* --------------------------------------------------------- Bézier y aplanado */

function cubicAt(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return [a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y];
}

export function segmentControls(a, b) {
  return [a, a.hOut || a, b.hIn || b, b];
}

/**
 * Nodos -> polilínea [[x,y],...]. Los tramos rectos dan sus extremos; los
 * curvos se subdividen según su longitud de control, con `tol` en las mismas
 * unidades que las coordenadas.
 */
export function flattenNodes(nodes, closed, tol = 0.5) {
  const out = [];
  if (!nodes || !nodes.length) return out;
  out.push([nodes[0].x, nodes[0].y]);
  const n = nodes.length;
  const count = closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % n];
    if (!a.hOut && !b.hIn) {
      out.push([b.x, b.y]);
      continue;
    }
    const [p0, p1, p2, p3] = segmentControls(a, b);
    const len =
      Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
    const steps = Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len / Math.max(tol, 1e-9)) * 1.5)));
    for (let s = 1; s <= steps; s++) out.push(cubicAt(p0, p1, p2, p3, s / steps));
  }
  if (closed && out.length > 1) {
    const f = out[0];
    const l = out[out.length - 1];
    if (f[0] !== l[0] || f[1] !== l[1]) out.push([f[0], f[1]]);
  }
  return out;
}

/** Anillos aplanados de un path: [{pts, closed, hole}] */
export function flattenShape(shape, tol = 0.5) {
  if (shape.type !== 'path') return [];
  const rings = [{ pts: flattenNodes(shape.nodes, shape.closed, tol), closed: shape.closed, hole: false }];
  for (const h of shape.holes || []) rings.push({ pts: flattenNodes(h, true, tol), closed: true, hole: true });
  return rings;
}

export function segmentCount(nodes, closed) {
  const n = nodes?.length || 0;
  if (n < 2) return 0;
  return closed ? n : n - 1;
}

/** Punto más cercano sobre el trazo (por muestreo). {segIndex, t, dist, point} */
export function nearestOnPath(nodes, closed, pt, samples = 24) {
  const count = segmentCount(nodes, closed);
  let best = null;
  for (let i = 0; i < count; i++) {
    const a = nodes[i];
    const b = nodes[(i + 1) % nodes.length];
    const [p0, p1, p2, p3] = segmentControls(a, b);
    const straight = !a.hOut && !b.hIn;
    const steps = straight ? 1 : samples;
    for (let s = 0; s < steps; s++) {
      const q0 = cubicAt(p0, p1, p2, p3, s / steps);
      const q1 = cubicAt(p0, p1, p2, p3, (s + 1) / steps);
      const dx = q1[0] - q0[0];
      const dy = q1[1] - q0[1];
      const L = dx * dx + dy * dy;
      let u = L ? ((pt.x - q0[0]) * dx + (pt.y - q0[1]) * dy) / L : 0;
      u = Math.max(0, Math.min(1, u));
      const x = q0[0] + u * dx;
      const y = q0[1] + u * dy;
      const d = Math.hypot(pt.x - x, pt.y - y);
      if (!best || d < best.dist) best = { segIndex: i, t: (s + u) / steps, dist: d, point: { x, y } };
    }
  }
  return best;
}

/** Inserta un nodo en el segmento `index` en t (de Casteljau). */
export function splitNodes(nodes, closed, index, t = 0.5) {
  const out = nodes.map(cloneNode);
  const n = out.length;
  const a = out[index];
  const b = out[(index + 1) % n];
  const p1 = a.hOut || { x: a.x, y: a.y };
  const p2 = b.hIn || { x: b.x, y: b.y };
  const lerp = (p, q, k) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k });
  const q0 = lerp(a, p1, t);
  const q1 = lerp(p1, p2, t);
  const q2 = lerp(p2, b, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const isLine = !a.hOut && !b.hIn;
  // en un tramo recto t es lineal (así lo entrega nearestOnPath); la cúbica
  // con los controles en los extremos NO lo es y correría el nodo
  const [mx, my] = isLine ? [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t] : cubicAt(a, p1, p2, b, t);
  const node = makeNode(mx, my, isLine ? null : r0, isLine ? null : r1, !isLine);
  if (!isLine) {
    a.hOut = q0;
    b.hIn = q2;
  }
  out.splice(index + 1, 0, node);
  return out;
}

/* --------------------------------------------------------------- trazo libre */

/** Ramer–Douglas–Peucker sobre [{x,y}]. */
export function simplify(points, tolerance) {
  if (points.length < 3) return points.slice();
  const sqTol = tolerance * tolerance;
  const sqSegDist = (p, a, b) => {
    let x = a.x;
    let y = a.y;
    let dx = b.x - x;
    let dy = b.y - y;
    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = b.x;
        y = b.y;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }
    dx = p.x - x;
    dy = p.y - y;
    return dx * dx + dy * dy;
  };
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxSq = sqTol;
    let index = -1;
    for (let i = first + 1; i < last; i++) {
      const sq = sqSegDist(points[i], points[first], points[last]);
      if (sq > maxSq) {
        index = i;
        maxSq = sq;
      }
    }
    if (index > 0) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Polilínea -> nodos suaves (Catmull-Rom -> Bézier). */
export function polylineToNodes(points, smoothing = 0.28, closed = false) {
  const n = points.length;
  if (n < 3 || smoothing <= 0) return points.map((p) => makeNode(p.x, p.y));
  return points.map((p, i) => {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = (next.x - prev.x) * smoothing;
    const dy = (next.y - prev.y) * smoothing;
    const first = !closed && i === 0;
    const last = !closed && i === n - 1;
    return makeNode(p.x, p.y, first ? null : { x: p.x - dx, y: p.y - dy }, last ? null : { x: p.x + dx, y: p.y + dy }, true);
  });
}

/* ----------------------------------------------------------- trazo libre */

export const DEFAULT_SMOOTH = 50; // % de suavizado del lápiz por defecto

/**
 * Qué hace un nivel de suavizado (0–100 %): 0 deja el trazo casi como se
 * dibujó (poligonal); 100 lo redondea mucho. `window` = pasadas de promedio
 * contra el temblor de la mano, `tolerance` = px de simplificación y
 * `tension` = curvatura de las manijas.
 */
export function freehandParams(level) {
  const t = Math.max(0, Math.min(100, Number(level) || 0)) / 100;
  return { passes: Math.round(t * 6), tolerance: 0.25 * Math.exp(t * Math.log(40)), tension: t * 0.5 };
}

/** Puntos a intervalos regulares `step` a lo largo de la polilínea (el último punto original se conserva en un trazo abierto). */
export function resamplePolyline(pts, step, closed) {
  const ring = closed ? [...pts, pts[0]] : pts;
  const out = [{ x: ring[0].x, y: ring[0].y }];
  let carry = 0; // lo recorrido desde el último punto puesto
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let at = step - carry;
    while (at <= len) {
      out.push({ x: a.x + ((b.x - a.x) * at) / len, y: a.y + ((b.y - a.y) * at) / len });
      at += step;
    }
    carry = len - (at - step);
  }
  const last = ring[ring.length - 1];
  if (closed) {
    if (out.length > 1 && Math.hypot(out[out.length - 1].x - out[0].x, out[out.length - 1].y - out[0].y) < step * 0.5) out.pop();
  } else out.push({ x: last.x, y: last.y });
  return out;
}

/**
 * Densifica una línea poco detallada (pocos vértices muy separados) a unos 3 px
 * entre puntos, como si se hubiera dibujado a mano a esa vista. Así el
 * promedio del suavizado actúa sobre una distancia y no sobre una cantidad de
 * puntos: sin esto, el promedio de un polígono de pluma de cuatro esquinas lo
 * encogería hacia su centro.
 */
export function densifyForSmoothing(pts, mpp, closed) {
  let len = 0;
  for (let i = 0; i + 1 < pts.length; i++) len += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
  if (closed && pts.length > 1) len += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y);
  const step = Math.max(mpp * 3, len / 4000);
  return pts.length >= 2 && len > 0 ? resamplePolyline(pts, step, closed) : pts;
}

/** Promedio móvil 1-2-1 (los extremos de un trazo abierto no se mueven). */
export function relaxPoints(pts, passes, closed) {
  let cur = pts;
  for (let k = 0; k < passes && cur.length > 2; k++) {
    const n = cur.length;
    cur = cur.map((p, i) => {
      if (!closed && (i === 0 || i === n - 1)) return p;
      const a = cur[(i - 1 + n) % n];
      const b = cur[(i + 1) % n];
      return { x: 0.25 * a.x + 0.5 * p.x + 0.25 * b.x, y: 0.25 * a.y + 0.5 * p.y + 0.25 * b.y };
    });
  }
  return cur;
}

/**
 * Puntos del lápiz → nodos de un trazo. `raw` son los puntos dibujados
 * (con el final ya descartado si el trazo se cierra) y `mpp` los metros por
 * píxel en que se dibujó, que fija la tolerancia.
 */
export function freehandToNodes(raw, level, mpp, closed = false) {
  const { passes, tolerance, tension } = freehandParams(level);
  const pts = simplify(relaxPoints(raw, passes, closed), tolerance * mpp);
  return curveThrough(pts, tension, closed);
}

/**
 * Nodos con manijas a lo largo de la tangente de cada punto (la dirección de
 * vecino a vecino), de largo proporcional al segmento vecino. Así el trazo se
 * redondea sin los lazos y sobrepasos de un Catmull-Rom con muy pocos puntos.
 * `tension` 0–0,5; satura en 0,45 del segmento (0 = poligonal).
 */
export function curveThrough(points, tension, closed) {
  const n = points.length;
  if (n < 3 || tension <= 0) return points.map((p) => makeNode(p.x, p.y));
  const t = tension * 2; // 0–1
  const k = 0.45 * (2 * t - t * t);
  return points.map((p, i) => {
    const prev = points[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const next = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    let dx = next.x - prev.x;
    let dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const lin = Math.hypot(p.x - prev.x, p.y - prev.y) * k;
    const lout = Math.hypot(next.x - p.x, next.y - p.y) * k;
    const first = !closed && i === 0;
    const last = !closed && i === n - 1;
    return makeNode(p.x, p.y, first ? null : { x: p.x - dx * lin, y: p.y - dy * lin }, last ? null : { x: p.x + dx * lout, y: p.y + dy * lout }, true);
  });
}

/** Huella de los nodos: cambia si el trazo se edita o se mueve (entonces ya no se puede re-suavizar). */
export function nodesSignature(nodes) {
  let a = 0;
  for (const p of nodes) a += p.x + 1.7 * p.y + (p.hIn ? 0.3 * p.hIn.x : 0) + (p.hOut ? 0.7 * p.hOut.y : 0);
  return `${nodes.length}:${a.toFixed(3)}`;
}

/** ¿Se puede re-suavizar? Trazo libre recién dibujado y sin tocar. */
export function canResmooth(shape) {
  return !!(shape && shape.type === 'path' && shape.freehand && !shape.holes && shape.freehand.sig === nodesSignature(shape.nodes));
}

/** ¿Se puede suavizar con el control de Suavizado? Cualquier línea o polígono sin huecos (no solo el trazo libre recién dibujado). */
export function canSmooth(shape) {
  return !!(shape && shape.type === 'path' && !shape.holes?.length && !shape.locked && shape.nodes?.length >= 3) || canResmooth(shape);
}

/**
 * Toma la geometría actual como «original» del suavizado: una línea de pluma,
 * importada o ya editada se re-suaviza igual que un trazo libre, siempre desde
 * su forma de antes (nivel 0 = tal cual está). `mpp`: metros por píxel de la vista.
 */
export function adoptFreehand(shape, mpp) {
  if (canResmooth(shape)) return shape;
  const pts = simplify(flattenNodes(shape.nodes, shape.closed, mpp * 0.25).map(([x, y]) => ({ x, y })), mpp * 0.1);
  const open = shape.closed && pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < mpp * 1e-3 ? pts.slice(0, -1) : pts;
  const raw = densifyForSmoothing(open, mpp, !!shape.closed);
  return { ...shape, freehand: { pts: raw, mpp, closed: !!shape.closed, level: 0, sig: nodesSignature(shape.nodes) } };
}

/** Trazo libre con otro nivel de suavizado, a partir de los puntos originales. */
export function resmooth(shape, level) {
  const f = shape.freehand;
  const nodes = freehandToNodes(f.pts, level, f.mpp, f.closed);
  return { ...shape, nodes, freehand: { ...f, level, sig: nodesSignature(nodes) } };
}

/* ------------------------------------------------------------------- bbox */

/** Caja en coordenadas de mundo. Para textos se estima con `mpp` (m/px) y `ptToPx`. */
export function shapeBBox(shape, est = null) {
  switch (shape.type) {
    case 'point': {
      const r = est ? (est.mmToM * (shape.style.pointSize || 2.5)) / 2 : 0;
      return { x: shape.x - r, y: shape.y - r, w: 2 * r, h: 2 * r };
    }
    case 'text': {
      // caja girada del texto (estimada sin lienzo) y su caja envolvente en el mundo
      const sizeM = est ? est.ptToM * shape.fontSize : 0;
      const m = layoutText(shape, sizeM, est ? est.mmToM : 0, approxMeasure);
      // en el mundo y crece hacia el norte: el eje y local (hacia abajo) se invierte
      const a = ((shape.rotation || 0) * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const pts = [[m.x0, m.top], [m.x0 + m.width, m.top], [m.x0 + m.width, m.top + m.height], [m.x0, m.top + m.height]].map(([lx, ly]) => [shape.x + lx * c - ly * s, shape.y - (lx * s + ly * c)]);
      const xs = pts.map((p) => p[0]);
      const ys = pts.map((p) => p[1]);
      return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    case 'group': {
      const kids = shape.clip ? [shape.children[0]] : shape.children;
      return unionBBox(kids.filter(Boolean).map((c) => shapeBBox(c, est))) || { x: 0, y: 0, w: 0, h: 0 };
    }
    default: {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const ring of flattenShape(shape, 1)) {
        for (const [x, y] of ring.pts) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
      if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
      return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
    }
  }
}

export function unionBBox(boxes) {
  const valid = boxes.filter(Boolean);
  if (!valid.length) return null;
  const x = Math.min(...valid.map((b) => b.x));
  const y = Math.min(...valid.map((b) => b.y));
  const x2 = Math.max(...valid.map((b) => b.x + b.w));
  const y2 = Math.max(...valid.map((b) => b.y + b.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

/** Recorre formas (incluidos hijos de grupos) llamando f(shape, parentGroup). */
export function walkShapes(shapes, f, parent = null) {
  for (const s of shapes) {
    f(s, parent);
    if (s.type === 'group') walkShapes(s.children, f, s);
  }
}

/* --------------------------------------------------------------- medición */

export function ringArea(pts) {
  let a = 0;
  // positiva si el anillo va en sentido antihorario (y hacia el norte)
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return a / 2;
}

export function polylineLength(pts) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

/** Longitud (m) y área (m²) de una forma. */
export function measure(shape) {
  if (shape.type !== 'path') return { length: 0, area: 0 };
  const rings = flattenShape(shape, 0.1);
  const length = polylineLength(rings[0].pts);
  if (!shape.closed) return { length, area: 0 };
  let area = Math.abs(ringArea(rings[0].pts));
  for (const r of rings.slice(1)) area -= Math.abs(ringArea(r.pts));
  return { length, area };
}
