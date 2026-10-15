/**
 * El documento: capas, formas, selección e historial.
 *
 * Inmutable por convención: cada edición reemplaza los objetos que cambian y
 * comparte el resto. El historial guarda entonces referencias a documentos
 * enteros sin copiar nada, y deshacer es volver a una referencia anterior.
 *
 * Una capa es de uno de estos tipos:
 *  - vector     formas dibujadas o importadas, con atributos y etiquetas.
 *  - basemap    teselas web (OSM, imágenes satelitales, topográfico).
 *  - hillshade  relieve sombreado calculado de un modelo de elevación.
 *  - image      imagen georreferenciada (GeoTIFF o georreferenciada aquí).
 *
 * Todas comparten visible / bloqueo / opacidad / modo de fusión; el orden de
 * `layers` es de abajo hacia arriba, como se pintan.
 */

import { cloneShape, newId, walkShapes } from './vector.js';

export const BLEND_MODES = {
  normal: 'Normal',
  multiply: 'Multiplicar',
  screen: 'Trama',
  overlay: 'Superponer',
  'soft-light': 'Luz suave',
  'hard-light': 'Luz fuerte',
  darken: 'Oscurecer',
  lighten: 'Aclarar',
  'color-burn': 'Subexponer color',
  difference: 'Diferencia',
  luminosity: 'Luminosidad',
};

export function defaultLabels() {
  return {
    enabled: false,
    field: '',
    fields: [], // varios campos unidos con `sep` (los vacíos se omiten); manda sobre `field`
    sep: 'space',
    template: '', // si no está vacío manda sobre todo lo anterior: "{codigo} ({edad:1} Ma)"
    fontFamily: 'Helvetica, Arial, sans-serif',
    fontSize: 8, // pt
    fontWeight: 400,
    italic: false,
    color: '#111827',
    halo: true,
    haloColor: '#ffffff',
    haloWidth: 0.5, // mm
    placement: 'auto', // auto | horizontal | curved | centroid
    offset: 1.2, // mm, para puntos y paralelo a líneas
    repeat: 0, // mm entre repeticiones en líneas; 0 = una vez
    avoidOverlap: true,
    minScale: 0, // no etiquetar con escala de vista mayor a este denominador (0 = siempre)
    upper: false,
    background: false,
    backgroundColor: '#ffffff',
  };
}

export function makeVectorLayer(name = 'Capa', extra = {}) {
  return {
    id: newId('L'),
    kind: 'vector',
    name,
    visible: true,
    locked: false,
    opacity: 1,
    blend: 'normal',
    items: [],
    fields: [],
    labels: defaultLabels(),
    expanded: true,
    ...extra,
  };
}

export function makeRasterLayer(kind, name, settings = {}, extra = {}) {
  return {
    id: newId('R'),
    kind,
    name,
    visible: true,
    locked: true,
    opacity: 1,
    blend: kind === 'hillshade' ? 'multiply' : 'normal',
    settings,
    ...extra,
  };
}

export function newDocument() {
  const base = makeRasterLayer('basemap', 'Mapa base: OpenTopoMap', { source: 'opentopomap' });
  const dibujo = makeVectorLayer('Dibujo');
  return {
    version: 1,
    crs: 'EPSG:32719',
    refScale: 25000,
    title: 'Sin título',
    layers: [base, dibujo],
    activeLayerId: dibujo.id,
    layout: null,
  };
}

/* ------------------------------------------------------------- consultas */

export function findLayer(doc, id) {
  return doc.layers.find((l) => l.id === id) || null;
}

/** Capa vectorial dueña de una forma (de primer nivel o dentro de un grupo). */
export function layerOfShape(doc, shapeId) {
  for (const l of doc.layers) {
    if (l.kind !== 'vector') continue;
    let hit = false;
    walkShapes(l.items, (s) => {
      if (s.id === shapeId) hit = true;
    });
    if (hit) return l;
  }
  return null;
}

/** Forma de PRIMER NIVEL por id (lo que se selecciona y ordena). */
export function findTopShape(doc, id) {
  for (const l of doc.layers) {
    if (l.kind !== 'vector') continue;
    const s = l.items.find((x) => x.id === id);
    if (s) return { layer: l, shape: s };
  }
  return null;
}

export function allTopShapes(doc, { visibleOnly = true, unlockedOnly = false } = {}) {
  const out = [];
  for (const l of doc.layers) {
    if (l.kind !== 'vector') continue;
    if (visibleOnly && !l.visible) continue;
    if (unlockedOnly && l.locked) continue;
    for (const s of l.items) {
      if (visibleOnly && s.visible === false) continue;
      if (unlockedOnly && s.locked) continue;
      out.push({ layer: l, shape: s });
    }
  }
  return out;
}

/* ------------------------------------------------------------ mutaciones */

export function updateLayer(doc, layerId, f) {
  return { ...doc, layers: doc.layers.map((l) => (l.id === layerId ? f(l) : l)) };
}

export function addShapes(doc, layerId, shapes) {
  return updateLayer(doc, layerId, (l) => ({ ...l, items: [...l.items, ...shapes], fields: mergeFields(l.fields, shapes) }));
}

export function replaceShapes(doc, map) {
  // map: Map(id -> nueva forma | null para borrar)
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector' || !l.items.some((s) => map.has(s.id))) return l;
      const items = [];
      for (const s of l.items) {
        if (!map.has(s.id)) items.push(s);
        else if (map.get(s.id)) items.push(map.get(s.id));
      }
      return { ...l, items };
    }),
  };
}

export function mapShapes(doc, ids, f) {
  const set = ids instanceof Set ? ids : new Set(ids);
  const map = new Map();
  for (const { shape } of allTopShapes(doc, { visibleOnly: false })) {
    if (set.has(shape.id)) map.set(shape.id, f(shape));
  }
  return replaceShapes(doc, map);
}

export function removeShapes(doc, ids) {
  const map = new Map([...ids].map((id) => [id, null]));
  return replaceShapes(doc, map);
}

export function mergeFields(fields, shapes) {
  const set = new Set(fields || []);
  for (const s of shapes) for (const k of Object.keys(s.attrs || {})) set.add(k);
  return [...set];
}

export function addLayer(doc, layer, aboveId = null) {
  const layers = doc.layers.slice();
  const idx = aboveId ? layers.findIndex((l) => l.id === aboveId) : layers.length - 1;
  layers.splice(idx + 1, 0, layer);
  return { ...doc, layers, activeLayerId: layer.kind === 'vector' ? layer.id : doc.activeLayerId };
}

export function removeLayer(doc, id) {
  const layers = doc.layers.filter((l) => l.id !== id);
  let active = doc.activeLayerId;
  if (active === id) active = [...layers].reverse().find((l) => l.kind === 'vector')?.id || null;
  return { ...doc, layers, activeLayerId: active };
}

export function moveLayer(doc, id, delta) {
  const layers = doc.layers.slice();
  const i = layers.findIndex((l) => l.id === id);
  const j = Math.max(0, Math.min(layers.length - 1, i + delta));
  if (i < 0 || i === j) return doc;
  const [l] = layers.splice(i, 1);
  layers.splice(j, 0, l);
  return { ...doc, layers };
}

export function duplicateLayer(doc, id) {
  const l = findLayer(doc, id);
  if (!l) return doc;
  const copy = { ...JSON.parse(JSON.stringify(l)), id: newId(l.id[0]), name: `${l.name} (copia)` };
  if (copy.items) copy.items = l.items.map(cloneShape);
  return addLayer(doc, copy, id);
}

/* ------------------------------------------------------------- historial */

export class History {
  constructor(doc, limit = 200) {
    this.past = [];
    this.future = [];
    this.doc = doc;
    this.limit = limit;
    this.listeners = new Set();
  }

  onChange(f) {
    this.listeners.add(f);
  }

  emit(meta) {
    for (const f of this.listeners) f(this.doc, meta);
  }

  /** Cambio definitivo: entra al historial. */
  commit(next, meta = {}) {
    if (next === this.doc) return;
    this.past.push(this.doc);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.doc = next;
    this.emit(meta);
  }

  /** Cambio en curso (arrastre): se ve pero no se apila. Cerrar con `commit`. */
  preview(next, meta = {}) {
    this.doc = next;
    this.emit({ ...meta, preview: true });
  }

  /** Marca el inicio de un arrastre: lo que venga con preview se deshace junto. */
  begin() {
    this.anchor = this.doc;
  }

  end(meta = {}) {
    if (this.anchor && this.anchor !== this.doc) {
      this.past.push(this.anchor);
      if (this.past.length > this.limit) this.past.shift();
      this.future = [];
    }
    this.anchor = null;
    this.emit(meta);
  }

  /** Cambio que no debe deshacerse (visibilidad de capa, capa activa…). */
  silent(next, meta = {}) {
    this.doc = next;
    // los documentos anteriores conservan su propia visibilidad; es lo esperable
    this.emit(meta);
  }

  undo() {
    if (!this.past.length) return false;
    this.future.push(this.doc);
    this.doc = this.past.pop();
    this.emit({ undo: true });
    return true;
  }

  redo() {
    if (!this.future.length) return false;
    this.past.push(this.doc);
    this.doc = this.future.pop();
    this.emit({ redo: true });
    return true;
  }

  reset(doc) {
    this.past = [];
    this.future = [];
    this.doc = doc;
    this.emit({ reset: true });
  }
}
