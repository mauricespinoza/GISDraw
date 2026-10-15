/**
 * Operaciones de edición sobre la selección: portapapeles, orden, alinear,
 * distribuir, agrupar, máscara de recorte y "seleccionar lo mismo".
 *
 * Todas son funciones puras doc -> doc (o -> ids), sin DOM, para poder
 * probarlas y para que el historial las deshaga sin saber qué hicieron.
 */

import { allTopShapes, findTopShape, replaceShapes } from './doc.js';
import { cloneShape, makeGroup, shapeBBox, translateShape, unionBBox } from './vector.js';

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
      if (l.kind !== 'vector' || !l.items.some((s) => ids.has(s.id))) return l;
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
    if (l.kind !== 'vector') continue;
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
      if (l.kind !== 'vector' || !l.items.some((s) => ids.has(s.id) && s.type === 'group')) return l;
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
  const moving = [];
  for (const { shape } of allTopShapes(doc, { visibleOnly: false })) if (ids.has(shape.id)) moving.push(shape);
  const removed = replaceShapes(doc, new Map([...ids].map((id) => [id, null])));
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
