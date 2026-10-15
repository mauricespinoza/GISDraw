/**
 * Simbología por campo de atributos, como el renderizador «Categorizado» y
 * «Graduado» de QGIS.
 *
 * Un `renderer` vive en la capa (`layer.renderer`) y guarda la configuración y
 * las clases con su color y rótulo. «Aplicar» escribe ese color en el estilo de
 * cada objeto de la capa —en GISDrawer cada objeto lleva su estilo—, así que lo
 * dibujado, el PDF y el GeoPackage no necesitan saber nada del renderizador;
 * éste sirve para volver a clasificar si cambian los datos, para rotular la
 * leyenda con los nombres de las clases y para exportar a QGIS un renderizador
 * real sobre el campo (editable allá).
 *
 * Todo son funciones puras sin DOM.
 */

import { replaceShapes, findLayer } from './doc.js';

/* ------------------------------------------------------------------ valores */

export const FIELD_KINDS = { $nombre: 'Nombre del objeto', $tipo: 'Tipo de geometría' };

export function kindOf(shape) {
  if (shape.type === 'point') return 'punto';
  if (shape.type === 'text') return 'texto';
  if (shape.type === 'group') return 'grupo';
  return shape.closed ? 'polígono' : 'línea';
}

/** Valor de un campo para un objeto: atributo, `$nombre` o `$tipo`. */
export function fieldValue(shape, field) {
  if (field === '$nombre') return shape.name ?? '';
  if (field === '$tipo') return kindOf(shape);
  if (field === '$area_ha') return shape.attrs?.__area_ha ?? '';
  const v = shape.attrs?.[field];
  return v == null ? '' : v;
}

const isNum = (v) => v !== '' && v != null && Number.isFinite(typeof v === 'number' ? v : Number(String(v).replace(',', '.')));
const toNum = (v) => (typeof v === 'number' ? v : Number(String(v).replace(',', '.')));

/** Campos que ofrece una capa: sus atributos más los especiales. */
export function fieldChoices(layer) {
  const out = {};
  for (const f of layer?.fields || []) out[f] = f;
  const attrKeys = new Set();
  for (const s of layer?.items || []) for (const k of Object.keys(s.attrs || {})) if (!k.startsWith('__')) attrKeys.add(k);
  for (const k of attrKeys) out[k] = k;
  return { ...out, ...FIELD_KINDS };
}

/** Valores distintos de un campo, ordenados (numéricos como números), con su conteo. */
export function uniqueValues(items, field) {
  const map = new Map();
  const visit = (s) => {
    // un grupo se clasifica por sus propios atributos, no por los de sus hojas
    const v = fieldValue(s, field);
    const key = String(v);
    const e = map.get(key) || { key, value: v, count: 0 };
    e.count++;
    map.set(key, e);
  };
  items.forEach(visit);
  const all = [...map.values()];
  const numeric = all.filter((e) => e.key !== '').every((e) => isNum(e.value));
  all.sort((a, b) => {
    if (a.key === '') return 1;
    if (b.key === '') return -1;
    return numeric ? toNum(a.value) - toNum(b.value) : String(a.key).localeCompare(String(b.key), 'es', { numeric: true, sensitivity: 'base' });
  });
  return { values: all, numeric };
}

/* ------------------------------------------------------------------ rampas */

/** `qual`: cualitativa (se reparte por clase y se repite); si no, degradado interpolado. */
export const RAMPS = {
  geo: { label: 'Geológica (pastel)', qual: true, colors: ['#E57373', '#BA68C8', '#FFB74D', '#4DB6AC', '#FFF176', '#A1887F', '#81C784', '#64B5F6', '#F06292', '#AED581', '#7986CB', '#FF8A65'] },
  paired: { label: 'Pareada', qual: true, colors: ['#a6cee3', '#1f78b4', '#b2df8a', '#33a02c', '#fb9a99', '#e31a1c', '#fdbf6f', '#ff7f00', '#cab2d6', '#6a3d9a', '#ffff99', '#b15928'] },
  tab10: { label: 'Categórica viva', qual: true, colors: ['#4e79a7', '#f28e2b', '#e15759', '#76b7b2', '#59a14f', '#edc948', '#b07aa1', '#ff9da7', '#9c755f', '#bab0ac'] },
  set1: { label: 'Contraste fuerte', qual: true, colors: ['#e41a1c', '#377eb8', '#4daf4a', '#984ea3', '#ff7f00', '#ffff33', '#a65628', '#f781bf', '#999999'] },
  viridis: { label: 'Viridis', colors: ['#440154', '#3b528b', '#21908d', '#5dc863', '#fde725'] },
  magma: { label: 'Magma', colors: ['#000004', '#51127c', '#b73779', '#fc8961', '#fcfdbf'] },
  spectral: { label: 'Espectral', colors: ['#9e0142', '#f46d43', '#fee08b', '#abdda4', '#3288bd', '#5e4fa2'] },
  rdylgn: { label: 'Rojo-amarillo-verde', colors: ['#d73027', '#fc8d59', '#ffffbf', '#91cf60', '#1a9850'] },
  blues: { label: 'Azules', colors: ['#f7fbff', '#9ecae1', '#4292c6', '#08306b'] },
  greens: { label: 'Verdes', colors: ['#f7fcf5', '#a1d99b', '#41ab5d', '#00441b'] },
  oranges: { label: 'Naranjas', colors: ['#fff5eb', '#fdae6b', '#f16913', '#7f2704'] },
  reds: { label: 'Rojos', colors: ['#fff5f0', '#fc9272', '#ef3b2c', '#67000d'] },
  terrain: { label: 'Hipsométrica', colors: ['#2e7d32', '#aed581', '#fff59d', '#bcaaa4', '#8d6e63', '#ffffff'] },
};

const hexRgb = (h) => {
  const n = parseInt(String(h).slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgbHex = (r) => `#${r.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;

/** `n` colores de una rampa. */
export function rampColors(id, n, reverse = false) {
  const ramp = RAMPS[id] || RAMPS.geo;
  let out;
  if (ramp.qual) out = Array.from({ length: n }, (_, i) => ramp.colors[i % ramp.colors.length]);
  else if (n <= 1) out = [ramp.colors[Math.floor(ramp.colors.length / 2)]];
  else {
    const stops = ramp.colors.map(hexRgb);
    out = Array.from({ length: n }, (_, i) => {
      const t = (i / (n - 1)) * (stops.length - 1);
      const a = Math.min(stops.length - 2, Math.floor(t));
      const f = t - a;
      return rgbHex(stops[a].map((v, k) => v + (stops[a + 1][k] - v) * f));
    });
  }
  return reverse ? out.reverse() : out;
}

/** Degradado CSS de una rampa, para su vista previa. */
export function rampCss(id, reverse = false) {
  const ramp = RAMPS[id] || RAMPS.geo;
  const cols = reverse ? [...ramp.colors].reverse() : ramp.colors;
  if (ramp.qual) return `linear-gradient(90deg, ${cols.slice(0, 8).flatMap((c, i, a) => [`${c} ${(i / a.length) * 100}%`, `${c} ${((i + 1) / a.length) * 100}%`]).join(',')})`;
  return `linear-gradient(90deg, ${cols.join(',')})`;
}

/* ------------------------------------------------------------------ cortes */

/** Cortes de clase: devuelve `n + 1` valores crecientes. */
export function classBreaks(values, n, method = 'quantile') {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return [];
  const min = v[0];
  const max = v[v.length - 1];
  if (min === max || n <= 1) return [min, max];
  n = Math.min(n, v.length);
  let br;
  if (method === 'equal') {
    br = Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n);
  } else if (method === 'pretty') {
    const raw = (max - min) / n;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw) || raw;
    const lo = Math.floor(min / step) * step;
    br = [];
    for (let x = lo; x < max + step * 0.999; x += step) br.push(+x.toFixed(10));
    if (br[br.length - 1] < max) br.push(br[br.length - 1] + step);
  } else if (method === 'jenks') {
    br = jenks(v, n);
  } else {
    br = Array.from({ length: n + 1 }, (_, i) => {
      const pos = (i / n) * (v.length - 1);
      const a = Math.floor(pos);
      return v[a] + (v[Math.min(v.length - 1, a + 1)] - v[a]) * (pos - a);
    });
  }
  // cortes repetidos (muchos valores iguales) se fusionan; en Jenks una clase
  // final con un solo valor (el máximo) es legítima y se conserva
  const lastSolo = method === 'jenks' && br.length > 2 && br[br.length - 1] === br[br.length - 2] && br[br.length - 2] > br[br.length - 3];
  br = br.filter((x, i) => i === 0 || x > br[i - 1] + 1e-12 || (lastSolo && i === br.length - 1));
  if (br.length < 2) br = [min, max];
  return br;
}

/** Cortes naturales de Jenks (sobre una muestra de hasta 1 500 valores). */
function jenks(sorted, k) {
  let data = sorted;
  if (data.length > 1500) data = Array.from({ length: 1500 }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / 1499)]);
  const n = data.length;
  k = Math.min(k, n);
  const lower = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(0));
  const vari = Array.from({ length: n + 1 }, () => new Array(k + 1).fill(Infinity));
  for (let i = 1; i <= k; i++) {
    lower[1][i] = 1;
    vari[1][i] = 0;
  }
  for (let l = 2; l <= n; l++) {
    let s1 = 0;
    let s2 = 0;
    let w = 0;
    for (let m = 1; m <= l; m++) {
      const i3 = l - m + 1;
      const val = data[i3 - 1];
      s2 += val * val;
      s1 += val;
      w++;
      const v = s2 - (s1 * s1) / w;
      const i4 = i3 - 1;
      if (i4 !== 0) {
        for (let j = 2; j <= k; j++) {
          if (vari[l][j] >= v + vari[i4][j - 1]) {
            lower[l][j] = i3;
            vari[l][j] = v + vari[i4][j - 1];
          }
        }
      }
    }
    lower[l][1] = 1;
    vari[l][1] = s2 - (s1 * s1) / w;
  }
  const out = new Array(k + 1);
  out[k] = data[n - 1];
  out[0] = data[0];
  let idx = n;
  for (let j = k; j >= 2; j--) {
    const id = lower[idx][j] - 2;
    out[j - 1] = data[Math.max(0, id)];
    idx = lower[idx][j] - 1;
  }
  // lo anterior son los límites SUPERIORES de cada clase; como las clases son
  // [inicio, fin), el corte es el primer valor de la clase siguiente
  for (let j = 1; j < k; j++) out[j] = data.find((x) => x > out[j]) ?? out[j];
  return out;
}

/** Número con los decimales justos para que los rótulos de clase no se repitan. */
export function fmtNum(v, dec) {
  return Number(v).toLocaleString('es-CL', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function decimalsFor(breaks) {
  const distinct = new Set(breaks).size;
  for (let d = 0; d <= 6; d++) {
    if (new Set(breaks.map((b) => b.toFixed(d))).size === distinct) return d;
  }
  return 6;
}

/* -------------------------------------------------------------- renderizador */

export const OTHER_COLOR = '#9ca3af';

export function defaultRendererOptions() {
  return { field: '', mode: 'categorized', ramp: 'geo', reverse: false, method: 'quantile', n: 5, target: 'auto' };
}

/**
 * Clasifica los objetos de una capa por un campo.
 * @returns renderer { field, mode, ramp, reverse, method, n, target, classes, other }
 *   categorized: classes [{ key, label, color, count }]
 *   graduated:   classes [{ min, max, label, color, count }]
 */
export function buildRenderer(items, opts) {
  const o = { ...defaultRendererOptions(), ...opts };
  if (!o.field) throw new Error('Elige un campo');
  const base = { field: o.field, mode: o.mode, ramp: o.ramp, reverse: !!o.reverse, method: o.method, n: o.n, target: o.target, other: { label: 'Otros valores', color: OTHER_COLOR } };
  const { values, numeric } = uniqueValues(items, o.field);
  if (!values.length) throw new Error('La capa no tiene objetos');
  if (o.mode === 'graduated') {
    const nums = [];
    for (const s of items) {
      const v = fieldValue(s, o.field);
      if (isNum(v)) nums.push(toNum(v));
    }
    if (!nums.length) throw new Error(`El campo «${o.field}» no tiene valores numéricos`);
    const br = classBreaks(nums, Math.max(2, Math.min(30, Number(o.n) || 5)), o.method);
    const dec = decimalsFor(br);
    const cols = rampColors(o.ramp, br.length - 1, o.reverse);
    const classes = br.slice(0, -1).map((lo, i) => {
      const hi = br[i + 1];
      const count = nums.filter((x) => (i === br.length - 2 ? x >= lo && x <= hi : x >= lo && x < hi)).length;
      return { min: lo, max: hi, label: `${fmtNum(lo, dec)} – ${fmtNum(hi, dec)}`, color: cols[i], count };
    });
    return { ...base, mode: 'graduated', classes };
  }
  if (values.length > 200) throw new Error(`El campo «${o.field}» tiene ${values.length} valores distintos: demasiados para categorías (usa Graduado si es numérico)`);
  const cols = rampColors(o.ramp, values.length, o.reverse);
  void numeric;
  const classes = values.map((e, i) => ({ key: e.key, label: e.key === '' ? '(vacío)' : String(e.value), color: cols[i], count: e.count }));
  return { ...base, mode: 'categorized', classes };
}

/** Índice de la clase de un objeto, o -1 si no cae en ninguna. */
export function classIndex(r, shape) {
  const v = fieldValue(shape, r.field);
  if (r.mode === 'graduated') {
    if (!isNum(v)) return -1;
    const x = toNum(v);
    const last = r.classes.length - 1;
    for (let i = 0; i <= last; i++) {
      const c = r.classes[i];
      if (x >= c.min && (i === last ? x <= c.max : x < c.max)) return i;
    }
    return -1;
  }
  const key = String(v);
  return r.classes.findIndex((c) => c.key === key);
}

/** Rótulo de la clase de un objeto (para la leyenda), o null. */
export function rendererLabel(r, shape) {
  if (!r?.classes) return null;
  const i = classIndex(r, shape);
  return i >= 0 ? r.classes[i].label : r.other?.label || null;
}

export function colorFor(r, shape) {
  const i = classIndex(r, shape);
  return i >= 0 ? r.classes[i].color : r.other?.color || null;
}

/** Parche de estilo que aplica `color` a un objeto según el objetivo. */
export function colorPatch(shape, color, target = 'auto') {
  const closed = shape.type === 'point' || shape.type === 'text' || (shape.type === 'path' && shape.closed);
  const toFill = target === 'fill' || target === 'both' || (target === 'auto' && closed);
  const toStroke = target === 'stroke' || target === 'both' || (target === 'auto' && !closed);
  const patch = {};
  if (toFill) {
    patch.fill = color;
    patch.fillType = 'solid';
    if (!shape.style?.fill || shape.style.fill === 'none') patch.fillOpacity = shape.type === 'point' || shape.type === 'text' ? 1 : 0.6;
  }
  if (toStroke) {
    patch.stroke = color;
    if (shape.style?.strokeWidth === 0) patch.strokeWidth = 0.5;
  }
  return patch;
}

/** Aplica el renderizador a todos los objetos de la capa y lo guarda en ella. */
export function applyRenderer(doc, layerId, renderer) {
  const layer = findLayer(doc, layerId);
  if (!layer || layer.kind !== 'vector') return doc;
  const map = new Map();
  const paint = (s, color) => {
    if (s.type === 'group') return { ...s, children: s.children.map((c, i) => (s.clip && i === 0 ? c : paint(c, color))) };
    return { ...s, style: { ...s.style, ...colorPatch(s, color, renderer.target) } };
  };
  for (const s of layer.items) {
    const color = colorFor(renderer, s);
    if (color) map.set(s.id, paint(s, color));
  }
  const next = map.size ? replaceShapes(doc, map) : doc;
  return { ...next, layers: next.layers.map((l) => (l.id === layerId ? { ...l, renderer } : l)) };
}

/** Quita el renderizador de la capa (los colores ya aplicados se quedan). */
export function clearRenderer(doc, layerId) {
  return { ...doc, layers: doc.layers.map((l) => (l.id === layerId ? { ...l, renderer: null } : l)) };
}

/**
 * Cuenta de objetos por clase para la tabla del panel, sobre los datos de
 * ahora (el renderizador guardado puede estar desactualizado).
 */
export function countClasses(r, items) {
  const counts = r.classes.map(() => 0);
  let other = 0;
  for (const s of items) {
    const i = classIndex(r, s);
    if (i >= 0) counts[i]++;
    else other++;
  }
  return { counts, other };
}
