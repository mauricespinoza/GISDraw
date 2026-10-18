/**
 * Operaciones de edición sobre la selección: portapapeles, orden, alinear,
 * distribuir, agrupar, máscara de recorte y "seleccionar lo mismo".
 *
 * Todas son funciones puras doc -> doc (o -> ids), sin DOM, para poder
 * probarlas y para que el historial las deshaga sin saber qué hicieron.
 */

import { allTopShapes, findTopShape, replaceShapes } from './doc.js';
import { cloneNode, cloneShape, makeGroup, newId, shapeBBox, splitNodes, translateShape, unionBBox } from './vector.js';

/* ------------------------------------------------------------ portapapeles */

/** Copia: formas de primer nivel en orden de pintado. */
export function copyShapes(doc, ids) {
  const out = [];
  for (const { shape } of allTopShapes(doc, { visibleOnly: false })) if (ids.has(shape.id)) out.push(shape);
  return out.map((s) => JSON.parse(JSON.stringify(s)));
}

/**
 * Pega en la capa activa. `inPlace` deja las coordenadas tal cual (pegar en el
 * lugar, Ctrl+Mayús+V); si no, desplaza un poco para que se note la copia.
 */
export function pasteShapes(doc, clip, layerId, { inPlace = false, offset = 0 } = {}) {
  const shapes = clip.map((s) => {
    const c = cloneShape(s);
    return inPlace || !offset ? c : translateShape(c, offset, -offset);
  });
  const next = {
    ...doc,
    layers: doc.layers.map((l) => (l.id === layerId ? { ...l, items: [...l.items, ...shapes] } : l)),
  };
  return { doc: next, ids: new Set(shapes.map((s) => s.id)) };
}

/* ------------------------------------------------------------------ orden */

/**
 * Traer adelante / enviar atrás dentro de cada capa.
 * mode: 'front' | 'forward' | 'backward' | 'back'
 */
export function arrange(doc, ids, mode) {
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector' || l.locked || !l.items.some((s) => ids.has(s.id))) return l;
      let items = l.items.slice();
      if (mode === 'front') {
        items = [...items.filter((s) => !ids.has(s.id)), ...items.filter((s) => ids.has(s.id))];
      } else if (mode === 'back') {
        items = [...items.filter((s) => ids.has(s.id)), ...items.filter((s) => !ids.has(s.id))];
      } else if (mode === 'forward') {
        for (let i = items.length - 2; i >= 0; i--) {
          if (ids.has(items[i].id) && !ids.has(items[i + 1].id)) [items[i], items[i + 1]] = [items[i + 1], items[i]];
        }
      } else if (mode === 'backward') {
        for (let i = 1; i < items.length; i++) {
          if (ids.has(items[i].id) && !ids.has(items[i - 1].id)) [items[i], items[i - 1]] = [items[i - 1], items[i]];
        }
      }
      return { ...l, items };
    }),
  };
}

/* ------------------------------------------------------- alinear / distribuir */

function selectedWithBoxes(doc, ids, est) {
  const out = [];
  for (const { shape } of allTopShapes(doc, { visibleOnly: false })) {
    if (ids.has(shape.id) && !shape.locked) out.push({ shape, box: shapeBBox(shape, est) });
  }
  return out;
}

/**
 * Alinea a la caja de la selección (o a `key`, el objeto clave de Illustrator).
 * how: left | hcenter | right | top | vcenter | bottom
 * Recuerda que y crece hacia el NORTE: "arriba" es el máximo de y.
 */
export function align(doc, ids, how, est, keyId = null) {
  const items = selectedWithBoxes(doc, ids, est);
  if (items.length < (keyId ? 2 : 2)) return doc;
  const ref = keyId ? items.find((i) => i.shape.id === keyId)?.box : unionBBox(items.map((i) => i.box));
  if (!ref) return doc;
  const map = new Map();
  for (const { shape, box } of items) {
    if (shape.id === keyId) continue;
    let dx = 0;
    let dy = 0;
    if (how === 'left') dx = ref.x - box.x;
    if (how === 'right') dx = ref.x + ref.w - (box.x + box.w);
    if (how === 'hcenter') dx = ref.x + ref.w / 2 - (box.x + box.w / 2);
    if (how === 'bottom') dy = ref.y - box.y;
    if (how === 'top') dy = ref.y + ref.h - (box.y + box.h);
    if (how === 'vcenter') dy = ref.y + ref.h / 2 - (box.y + box.h / 2);
    if (dx || dy) map.set(shape.id, translateShape(shape, dx, dy));
  }
  return replaceShapes(doc, map);
}

/**
 * Distribuye centros (o espacios, con `spacing`) a intervalos iguales.
 * axis: 'h' | 'v'
 */
export function distribute(doc, ids, axis, est, { spacing = false } = {}) {
  const items = selectedWithBoxes(doc, ids, est);
  if (items.length < 3) return doc;
  const pos = (b) => (axis === 'h' ? b.x : b.y);
  const size = (b) => (axis === 'h' ? b.w : b.h);
  items.sort((a, b) => pos(a.box) + size(a.box) / 2 - (pos(b.box) + size(b.box) / 2));
  const first = items[0].box;
  const last = items[items.length - 1].box;
  const map = new Map();
  if (spacing) {
    const span = pos(last) + size(last) - pos(first);
    const used = items.reduce((s, i) => s + size(i.box), 0);
    const gap = (span - used) / (items.length - 1);
    let cursor = pos(first) + size(first) + gap;
    for (let i = 1; i < items.length - 1; i++) {
      const d = cursor - pos(items[i].box);
      map.set(items[i].shape.id, translateShape(items[i].shape, axis === 'h' ? d : 0, axis === 'v' ? d : 0));
      cursor += size(items[i].box) + gap;
    }
  } else {
    const c0 = pos(first) + size(first) / 2;
    const c1 = pos(last) + size(last) / 2;
    for (let i = 1; i < items.length - 1; i++) {
      const target = c0 + ((c1 - c0) * i) / (items.length - 1);
      const d = target - (pos(items[i].box) + size(items[i].box) / 2);
      map.set(items[i].shape.id, translateShape(items[i].shape, axis === 'h' ? d : 0, axis === 'v' ? d : 0));
    }
  }
  return replaceShapes(doc, map);
}

/* --------------------------------------------------------- grupos y recorte */

/** Agrupa en la capa de la forma superior. Devuelve {doc, id}. */
export function group(doc, ids, { clip = false } = {}) {
  // por capa: se agrupa lo de la capa con más elementos seleccionados
  let target = null;
  for (const l of doc.layers) {
    if (l.kind !== 'vector' || l.locked) continue;
    const n = l.items.filter((s) => ids.has(s.id)).length;
    if (n && (!target || n > target.n)) target = { l, n };
  }
  if (!target || target.n < (clip ? 2 : 2)) return { doc, id: null };
  const { l } = target;
  const chosen = l.items.filter((s) => ids.has(s.id));
  let children = chosen;
  if (clip) {
    // la máscara es el objeto de MÁS ARRIBA, como en Illustrator; va primero
    const mask = chosen[chosen.length - 1];
    children = [mask, ...chosen.slice(0, -1)];
    if (mask.type !== 'path' || !mask.closed) return { doc, id: null, error: 'La máscara (objeto superior) debe ser una forma cerrada' };
  }
  const g = makeGroup(children, { clip });
  const top = l.items.findIndex((s) => s.id === chosen[chosen.length - 1].id);
  const items = [];
  l.items.forEach((s, i) => {
    if (i === top) items.push(g);
    if (!ids.has(s.id)) items.push(s);
  });
  return {
    doc: { ...doc, layers: doc.layers.map((x) => (x.id === l.id ? { ...l, items } : x)) },
    id: g.id,
  };
}

/** Desagrupa (o libera la máscara). Devuelve {doc, ids} con los hijos. */
export function ungroup(doc, ids) {
  const released = new Set();
  const next = {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector' || l.locked || !l.items.some((s) => ids.has(s.id) && s.type === 'group')) return l;
      const items = [];
      for (const s of l.items) {
        if (ids.has(s.id) && s.type === 'group') {
          let kids = s.children;
          if (s.clip) kids = [...kids.slice(1), kids[0]]; // la máscara vuelve arriba
          for (const k of kids) {
            items.push(k);
            released.add(k.id);
          }
        } else items.push(s);
      }
      return { ...l, items };
    }),
  };
  return { doc: next, ids: released };
}

/** Mueve la selección a otra capa (arriba de todo en esa capa). */
export function moveToLayer(doc, ids, layerId) {
  const target = doc.layers.find((l) => l.id === layerId);
  if (!target || target.locked) return doc;
  const moving = [];
  // lo de capas bloqueadas no se mueve
  for (const { shape, layer } of allTopShapes(doc, { visibleOnly: false })) if (ids.has(shape.id) && !layer.locked) moving.push(shape);
  const removed = replaceShapes(doc, new Map(moving.map((s) => [s.id, null])));
  return {
    ...removed,
    layers: removed.layers.map((l) => (l.id === layerId ? { ...l, items: [...l.items, ...moving] } : l)),
  };
}

/* -------------------------------------------------------- seleccionar lo mismo */

export const SAME_CRITERIA = {
  fill: 'Mismo relleno',
  stroke: 'Mismo trazo (color)',
  fillstroke: 'Mismo relleno y trazo',
  strokeWidth: 'Mismo grosor de trazo',
  dash: 'Mismo tipo de línea',
  style: 'Mismo estilo completo',
  type: 'Mismo tipo de objeto',
  opacity: 'Misma opacidad',
  attr: 'Mismo valor de atributo…',
  layer: 'Todo en la misma capa',
};

const norm = (c) => String(c || 'none').toLowerCase();

function sameKey(shape, criterion, field) {
  const s = shape.style || {};
  switch (criterion) {
    case 'fill':
      return s.fillType && s.fillType !== 'solid' ? `${s.fillType}:${JSON.stringify(s.gradient)}` : `${norm(s.fill)}|${s.fillOpacity}`;
    case 'stroke':
      return `${norm(s.stroke)}|${s.strokeOpacity}`;
    case 'fillstroke':
      return `${sameKey(shape, 'fill')}#${sameKey(shape, 'stroke')}`;
    case 'strokeWidth':
      return String(Math.round((s.strokeWidth || 0) * 1000));
    case 'dash':
      return `${s.dash || 'solid'}`;
    case 'opacity':
      return String(s.opacity ?? 1);
    case 'type':
      return shape.type === 'path' ? (shape.closed ? 'polygon' : 'line') : shape.type;
    case 'style':
      return JSON.stringify(s);
    case 'attr':
      return JSON.stringify(shape.attrs?.[field] ?? null);
    default:
      return '';
  }
}

/**
 * Ids de todo lo que coincide con alguno de los objetos de referencia.
 * `scope`: 'layer' (solo la capa de la referencia) | 'all' (capas visibles y desbloqueadas)
 */
export function selectSame(doc, refIds, criterion, { scope = 'all', field = '' } = {}) {
  const refs = [...refIds].map((id) => findTopShape(doc, id)).filter(Boolean);
  if (!refs.length) return new Set();
  if (criterion === 'layer') {
    const layers = new Set(refs.map((r) => r.layer.id));
    return new Set(
      allTopShapes(doc, { unlockedOnly: true })
        .filter((x) => layers.has(x.layer.id))
        .map((x) => x.shape.id),
    );
  }
  const keys = new Set(refs.map((r) => sameKey(r.shape, criterion, field)));
  const layers = new Set(refs.map((r) => r.layer.id));
  const out = new Set();
  for (const { layer, shape } of allTopShapes(doc, { unlockedOnly: true })) {
    if (scope === 'layer' && !layers.has(layer.id)) continue;
    if (keys.has(sameKey(shape, criterion, field))) out.add(shape.id);
  }
  return out;
}

/** Selección por expresión simple sobre atributos: campo, operador y valor. */
export function selectByAttribute(doc, layerId, field, op, value) {
  const layer = doc.layers.find((l) => l.id === layerId);
  if (!layer) return new Set();
  const num = Number(value);
  const isNum = value !== '' && Number.isFinite(num);
  const test = (v) => {
    if (op === 'contiene') return String(v ?? '').toLowerCase().includes(String(value).toLowerCase());
    if (op === 'vacío') return v == null || v === '';
    const a = isNum ? Number(v) : String(v ?? '');
    const b = isNum ? num : String(value);
    switch (op) {
      case '=':
        return a === b;
      case '≠':
        return a !== b;
      case '<':
        return a < b;
      case '>':
        return a > b;
      case '≤':
        return a <= b;
      case '≥':
        return a >= b;
      default:
        return false;
    }
  };
  return new Set(layer.items.filter((s) => test(s.attrs?.[field])).map((s) => s.id));
}

/* ------------------------------------------------- unir y cortar trazos */

/** Nodos en sentido inverso, con los manejadores intercambiados. */
export function reverseNodes(nodes) {
  return nodes
    .slice()
    .reverse()
    .map((n) => ({ ...cloneNode(n), hIn: n.hOut ? { ...n.hOut } : null, hOut: n.hIn ? { ...n.hIn } : null }));
}

/**
 * Unir (Ctrl+J, como en Illustrator). Un trazo abierto: se cierra. Dos o más
 * trazos abiertos: se encadenan en UNO por los extremos más cercanos (el
 * siguiente en unirse es siempre el que queda más cerca de alguno de los dos
 * extremos de la cadena, invirtiéndolo si hace falta); si los extremos están a
 * menos de `tol` metros se funden en un solo vértice, si no se agrega un
 * tramo recto. El resultado conserva el estilo y los atributos del primero (el
 * de más abajo).
 */
export function joinPaths(doc, ids, tol = 0) {
  const paths = [];
  for (const { shape } of allTopShapes(doc, { visibleOnly: false })) {
    if (ids.has(shape.id) && shape.type === 'path' && !shape.locked) paths.push(shape);
  }
  const open = paths.filter((p) => !p.closed);
  if (open.length === 1 && paths.length === 1) {
    if (open[0].nodes.length < 3) return { error: 'Hacen falta al menos 3 vértices para cerrar el trazo' };
    return { doc: replaceShapes(doc, new Map([[open[0].id, { ...open[0], closed: true }]])), id: open[0].id };
  }
  if (!paths.length) return { error: 'Selecciona dos o más trazos abiertos para unir (o uno para cerrarlo)' };
  if (open.length !== paths.length) return { error: 'Para unir, selecciona solo líneas (trazos abiertos); los polígonos se fusionan con «Fusionar»' };
  const d = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const [first, ...rest] = open;
  let chain = first.nodes.map(cloneNode);
  const left = rest.slice();
  while (left.length) {
    // el trazo restante y el extremo de la cadena (cola o cabeza) más cercanos entre sí
    let best = null;
    left.forEach((r, ri) => {
      const A = chain[0];
      const Z = chain[chain.length - 1];
      const B = r.nodes[0];
      const E = r.nodes[r.nodes.length - 1];
      for (const [dist, atTail, rev] of [
        [d(Z, B), true, false],
        [d(Z, E), true, true],
        [d(A, E), false, false],
        [d(A, B), false, true],
      ]) {
        if (!best || dist < best.dist) best = { dist, atTail, rev, ri };
      }
    });
    const [r] = left.splice(best.ri, 1);
    const piece = best.rev ? reverseNodes(r.nodes) : r.nodes.map(cloneNode);
    // `near` hacia la cola: cadena + pieza; hacia la cabeza: pieza + cadena
    let a = best.atTail ? chain : piece;
    let b = best.atTail ? piece : chain;
    if (best.dist <= tol) {
      const merged = { ...a[a.length - 1], hOut: b[0].hOut, smooth: false };
      chain = [...a.slice(0, -1), merged, ...b.slice(1)];
    } else {
      a = a.map(cloneNode);
      b = b.map(cloneNode);
      a[a.length - 1].hOut = null;
      b[0].hIn = null;
      chain = [...a, ...b];
    }
  }
  const map = new Map([[first.id, { ...first, nodes: chain }]]);
  for (const r of rest) map.set(r.id, null);
  return { doc: replaceShapes(doc, map), id: first.id };
}

/**
 * Tijera (C): corta el trazo `id` en el tramo `seg`, parámetro `t`. Una línea
 * queda en dos líneas con el mismo estilo; un polígono se abre en ese punto.
 */
export function splitPath(doc, id, seg, t) {
  const found = findTopShape(doc, id);
  const shape = found?.shape;
  if (found?.layer?.locked) return { error: `La capa «${found.layer.name}» está bloqueada` };
  if (!shape || shape.type !== 'path' || shape.locked) return { error: 'Solo se pueden cortar trazos' };
  if (shape.holes?.length) return { error: 'Un polígono con huecos no se puede abrir con la tijera' };
  // cortar sobre un vértice existente no inserta otro
  let nodes;
  let k;
  if (t < 1e-6) {
    nodes = shape.nodes.map(cloneNode);
    k = seg;
  } else if (t > 1 - 1e-6) {
    nodes = shape.nodes.map(cloneNode);
    k = (seg + 1) % nodes.length;
  } else {
    nodes = splitNodes(shape.nodes, shape.closed, seg, t);
    k = seg + 1;
  }
  if (shape.closed) {
    const ring = [...nodes.slice(k), ...nodes.slice(0, k), cloneNode(nodes[k])];
    ring[0].hIn = null;
    ring[ring.length - 1].hOut = null;
    return { doc: replaceShapes(doc, new Map([[id, { ...shape, nodes: ring, closed: false, name: shape.name }]])), ids: [id] };
  }
  if (k <= 0 || k >= nodes.length - 1) return { error: 'Corta entre los extremos del trazo, no en ellos' };
  const first = nodes.slice(0, k + 1);
  const second = nodes.slice(k).map(cloneNode);
  first[first.length - 1] = { ...first[first.length - 1], hOut: null };
  second[0].hIn = null;
  const other = { ...JSON.parse(JSON.stringify(shape)), id: newId('p'), nodes: second };
  const next = {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector' || !l.items.some((s) => s.id === id)) return l;
      const items = [];
      for (const s of l.items) {
        if (s.id === id) items.push({ ...shape, nodes: first }, other);
        else items.push(s);
      }
      return { ...l, items };
    }),
  };
  return { doc: next, ids: [id, other.id] };
}

/* ------------------------------------------------- ocultar y bloquear */

/** Ctrl+2 / Ctrl+3: bloquea u oculta los objetos indicados. */
export function setShapeFlag(doc, ids, flag, value) {
  const map = new Map();
  for (const { shape } of allTopShapes(doc, { visibleOnly: false })) if (ids.has(shape.id)) map.set(shape.id, { ...shape, [flag]: value });
  return map.size ? replaceShapes(doc, map) : doc;
}

/** Ctrl+Alt+2 / Ctrl+Alt+3: desbloquear o mostrar todo; devuelve también los ids que cambiaron. */
export function resetShapeFlag(doc, flag) {
  const map = new Map();
  const want = flag === 'locked' ? false : true;
  for (const { shape } of allTopShapes(doc, { visibleOnly: false })) {
    const cur = flag === 'locked' ? !!shape.locked : shape.visible !== false;
    if (cur !== want) map.set(shape.id, { ...shape, [flag]: want });
  }
  return { doc: map.size ? replaceShapes(doc, map) : doc, ids: [...map.keys()] };
}
