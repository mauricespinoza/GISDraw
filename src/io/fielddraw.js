/**
 * Importación de proyectos de FieldDraw (`.fdproj.json`, el paquete
 * `.fdproj.zip` o un GeoJSON exportado por FieldDraw), con su simbología y su
 * georreferencia.
 *
 * FieldDraw guarda el dibujo como GeoJSON en WGS84 (lon, lat) con el TIPO en
 * `properties.type` y la certeza en `properties.certainty`; los colores y
 * grosores de cada tipo de línea viven en `ornaments` y los de las unidades en
 * `units`. Aquí se reproduce su simbología con los mismos valores que usa su
 * exportación a QGIS: trazo de 0,5 mm × el peso del tipo, el color efectivo
 * (el del catálogo o el que el usuario cambió), segmentado según la certeza,
 * halo blanco, y los ornamentos con su tamaño, separación, distancia de las
 * medias flechas y lado (el `flip` de cada traza). Las coordenadas pasan a
 * UTM 19S, el sistema del documento.
 *
 * Las medidas de rumbo y manteo se dibujan con su símbolo (rumbo, tic hacia
 * el manteo y el valor), orientados al norte verdadero —corregidos por la
 * convergencia de cuadrícula— y medidos en mm de papel a la escala de
 * referencia, como el resto de los símbolos.
 */

import { fromLonLat, toLonLat } from '../proj.js';
import { defaultStyle } from '../style.js';
import { makeGroup, makeNode, makePath, makePoint, makeText } from '../vector.js';

/** mm de papel por px de diseño de FieldDraw (96 dpi), como en ornaments.js. */
const PX_MM = 25.4 / 96;

/* Catálogo de FieldDraw (src/symbology.js): color y peso por tipo de línea. */
const LINE_TYPES = {
  'stratigraphic-contact': { label: 'Contacto estratigráfico', color: '#000000', weight: 1 },
  'intrusive-contact': { label: 'Contacto intrusivo', color: '#000000', weight: 1 },
  'structural-contact': { label: 'Contacto estructural', color: '#000000', weight: 1 },
  'thrust-fault': { label: 'Falla inversa / cabalgamiento', color: '#0000ff', weight: 1.35, ornament: 'thrust', spacing: 26, gap: 3 },
  'normal-fault': { label: 'Falla normal', color: '#0000ff', weight: 1.25, ornament: 'normal', spacing: 30 },
  'dextral-fault': { label: 'Falla dextral', color: '#0000ff', weight: 1.25, ornament: 'dextral', spacing: 80, gap: 3 },
  'sinistral-fault': { label: 'Falla sinestral', color: '#0000ff', weight: 1.25, ornament: 'sinistral', spacing: 80, gap: 3 },
  'undefined-fault': { label: 'Falla indiferenciada', color: '#0000ff', weight: 1.15 },
  antiform: { label: 'Antiforme', color: '#ff00ff', weight: 1.3, ornament: 'antiform', spacing: 64 },
  synform: { label: 'Sinforme', color: '#ff00ff', weight: 1.3, ornament: 'synform', spacing: 64 },
  dike: { label: 'Dique', color: '#ff0000', weight: 1.1 },
};

const POLYGON_TYPES = {
  'intrusive-unit': { name: 'Intrusive unit', code: 'INT', color: '#E57373' },
  'volcanic-unit': { name: 'Volcanic unit', code: 'VOL', color: '#BA68C8' },
  'sedimentary-unit': { name: 'Sedimentary unit', code: 'SED', color: '#FFB74D' },
  'metamorphic-unit': { name: 'Metamorphic unit', code: 'MET', color: '#4DB6AC' },
  'quaternary-cover': { name: 'Quaternary cover', code: 'Q', color: '#FFF176' },
  'alteration-zone': { name: 'Alteration zone', code: 'ALT', color: '#A1887F' },
};

const STRUCTURE_TYPES = {
  bedding: { label: 'Estratificación', color: '#212121' },
  foliation: { label: 'Foliación / clivaje', color: '#2E7D32' },
  joint: { label: 'Diaclasa', color: '#1565C0' },
  'fault-plane': { label: 'Plano de falla', color: '#D32F2F' },
};

const CERTAINTY_DASH = { observed: 'solid', inferred: 'inferred', covered: 'covered' };
const HEX = /^#[0-9a-f]{6}$/i;

/* ================================================================ lectura */

/** Texto del proyecto desde un archivo: JSON directo o dentro del paquete ZIP. */
export async function readFieldDrawFile(file) {
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const entries = await readZip(buf);
    const proj = entries.find((e) => e.name === 'project.fdproj.json') || entries.find((e) => /\.(fdproj\.json|fdproj|json)$/i.test(e.name) && !e.name.startsWith('files/'));
    if (!proj) throw new Error('El ZIP no trae un proyecto de FieldDraw');
    return new TextDecoder().decode(await proj.data());
  }
  return new TextDecoder().decode(buf);
}

/** Lector ZIP mínimo (directorio central; sin compresión o deflate). */
export async function readZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP sin directorio central');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(u8.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = u8.subarray(start, start + csize);
    out.push({
      name,
      data: async () => {
        if (method === 0) return raw;
        if (method === 8 && typeof DecompressionStream !== 'undefined') {
          const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
          return new Uint8Array(await new Response(stream).arrayBuffer());
        }
        throw new Error(`Compresión ZIP no soportada (${method})`);
      },
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/* ============================================================ conversión */

/** Color efectivo y peso de un tipo de línea, con lo que el usuario cambió en FieldDraw. */
function lineSpec(type, ornaments) {
  const base = LINE_TYPES[type] || { label: type || 'Línea', color: '#888888', weight: 1 };
  const o = (ornaments && ornaments[type]) || {};
  const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    ...base,
    color: typeof o.color === 'string' && HEX.test(o.color) ? o.color.toLowerCase() : base.color,
    weight: num(o.width, base.weight),
    size: num(o.size, 1),
    spacing: num(o.spacing, base.spacing),
    gap: num(o.gap, base.gap ?? 3),
    offset: num(o.offset, base.ornament && ['thrust', 'normal'].includes(base.ornament) ? -4.5 : 0),
  };
}

/** Estilo de GISDrawer para una traza de FieldDraw. */
export function fieldDrawLineStyle(props, ornaments) {
  const sp = lineSpec(props.type, ornaments);
  const st = {
    ...defaultStyle(),
    fill: 'none',
    stroke: sp.color,
    strokeWidth: +(0.5 * sp.weight).toFixed(3),
    dash: CERTAINTY_DASH[props.certainty] || 'solid',
    cap: props.certainty === 'inferred' ? 'butt' : 'round',
    // el halo blanco de FieldDraw: 1,2 px a cada lado, al 55 %
    casing: true,
    casingColor: '#ffffff',
    casingWidth: +(1.2 * PX_MM).toFixed(3),
    casingOpacity: 0.55,
    opacity: Number.isFinite(Number(props.opacity)) ? Number(props.opacity) : 1,
  };
  if (sp.ornament) {
    // FieldDraw: offset negativo = izquierda del sentido de digitalización; `flip` lo refleja
    const left = (sp.offset <= 0) !== !!props.flip;
    Object.assign(st, {
      ornament: sp.ornament,
      ornamentSize: sp.size,
      ornamentSpacing: +(sp.spacing * PX_MM).toFixed(2),
      ornamentSide: left ? 'left' : 'right',
      ornamentGap: +(sp.gap * PX_MM).toFixed(2),
      ornamentColor: '',
      ornamentHalo: true,
    });
  }
  return st;
}

function unitOf(props, units) {
  const id = props.unitId || props.type;
  const u = (units || []).find((x) => x.id === id) || null;
  const base = POLYGON_TYPES[id] || null;
  return {
    name: u?.name || props.unit || base?.name || id || 'Unidad',
    code: u?.code ?? props.code ?? base?.code ?? '',
    color: (u?.color && HEX.test(u.color) ? u.color : base?.color) || '#999999',
  };
}

/** Color un poco más oscuro, para el borde de la unidad (como en su QML). */
function shade(hex, k = 0.65) {
  const n = parseInt(hex.slice(1), 16);
  const c = (v) => Math.round(v * k).toString(16).padStart(2, '0');
  return `#${c((n >> 16) & 255)}${c((n >> 8) & 255)}${c(n & 255)}`;
}

/** Atributos planos para la tabla de GISDrawer (los objetos van como JSON). */
function flatAttrs(props) {
  const out = {};
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || k === 'opacity') continue;
    out[k] = typeof v === 'object' ? JSON.stringify(v) : v;
  }
  return out;
}

const ring = (coords) => {
  const pts = coords.map(([lon, lat]) => fromLonLat(lon, lat));
  if (pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6) pts.pop();
  }
  return pts.map(([x, y]) => makeNode(x, y));
};

/** Dirección del norte verdadero en la cuadrícula UTM (radianes, horario desde el norte de cuadrícula). */
function convergence(lon, lat) {
  const [x, y] = fromLonLat(lon, lat);
  const [x2, y2] = fromLonLat(lon, lat + 0.01);
  return Math.atan2(x2 - x, y2 - y);
}

/**
 * Símbolo de rumbo y manteo como geometría (grupo): traza del rumbo, tic hacia
 * el manteo y el valor del manteo. Horizontal: cruz en círculo; vertical:
 * tic a los dos lados.
 */
export function structureSymbol(props, [lon, lat], refScale) {
  const spec = STRUCTURE_TYPES[props.type] || { label: props.type || 'Medida', color: '#212121' };
  const mm = refScale / 1000; // metros de terreno por mm de papel
  const [x, y] = fromLonLat(lon, lat);
  const conv = convergence(lon, lat);
  const strike = (Number(props.strike) * Math.PI) / 180 + conv;
  const dipAz = (Number.isFinite(Number(props.dipAzimuth)) ? Number(props.dipAzimuth) : Number(props.strike) + 90) * (Math.PI / 180) + conv;
  const dip = Number(props.dip);
  const dir = (a, len) => [x + Math.sin(a) * len * mm, y + Math.cos(a) * len * mm];
  const style = { ...defaultStyle(), fill: 'none', stroke: spec.color, strokeWidth: 0.35, cap: 'butt', align: 'center' };
  const seg = (p, q, w = 0.35) => makePath([makeNode(...p), makeNode(...q)], { style: { ...style, strokeWidth: w } });
  const parts = [];
  if (dip <= 3) {
    const c = makePath(circleNodes(x, y, 1.2 * mm), { closed: true, style: { ...style, strokeWidth: 0.3 } });
    parts.push(c, seg(dir(0, 2.4), dir(Math.PI, 2.4), 0.3), seg(dir(Math.PI / 2, 2.4), dir(-Math.PI / 2, 2.4), 0.3));
  } else {
    parts.push(seg(dir(strike, 2.5), dir(strike + Math.PI, 2.5), 0.4));
    parts.push(seg([x, y], dir(dipAz, 1.8)));
    if (dip >= 87) parts.push(seg([x, y], dir(dipAz + Math.PI, 1.8)));
  }
  if (dip > 3 && dip < 87) {
    const [tx, ty] = dir(dipAz, 3.2);
    const t = makeText(tx, ty, String(Math.round(dip)), { ...defaultStyle(), fill: spec.color, fillOpacity: 1, fillType: 'solid', stroke: 'none' }, 7);
    t.anchor = 'middle';
    t.halo = true;
    t.haloWidth = 0.4;
    parts.push(t);
  }
  const g = makeGroup(parts, { name: `${spec.label} ${Math.round(Number(props.strike))}/${Math.round(dip)}` });
  g.attrs = flatAttrs(props);
  return g;
}

function circleNodes(cx, cy, r) {
  const k = 0.5523 * r;
  return [
    makeNode(cx + r, cy, { x: cx + r, y: cy - k }, { x: cx + r, y: cy + k }, true),
    makeNode(cx, cy + r, { x: cx + k, y: cy + r }, { x: cx - k, y: cy + r }, true),
    makeNode(cx - r, cy, { x: cx - r, y: cy + k }, { x: cx - r, y: cy - k }, true),
    makeNode(cx, cy - r, { x: cx - k, y: cy - r }, { x: cx + k, y: cy - r }, true),
  ];
}

/**
 * Proyecto de FieldDraw (texto) → capas de GISDrawer.
 * @returns {{ name, layers: [{name, items, fields, labels?}], warnings: string[], count: number }}
 */
export function importFieldDraw(text, { refScale = 25000 } = {}) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`No es un JSON válido (${e.message})`);
  }
  const isProject = raw?.format === 'fielddraw-project';
  if (!isProject && !(raw?.type === 'FeatureCollection' && Array.isArray(raw.features))) throw new Error('No es un proyecto de FieldDraw ni un GeoJSON');
  const features = Array.isArray(raw.features) ? raw.features : [];
  const units = Array.isArray(raw.units) ? raw.units : null;
  const ornaments = raw.ornaments && typeof raw.ornaments === 'object' ? raw.ornaments : null;
  const warnings = [];
  const polys = [];
  const lines = [];
  const meas = [];
  const ctrl = [];
  let skipped = 0;
  let outside = 0;

  for (const f of features) {
    const g = f?.geometry;
    const props = { ...(f?.properties || {}) };
    if (!g || !Array.isArray(g.coordinates)) {
      skipped++;
      continue;
    }
    const lonOf = g.type === 'Point' ? g.coordinates[0] : g.type === 'LineString' ? g.coordinates[0]?.[0] : g.coordinates[0]?.[0]?.[0];
    if (Number.isFinite(lonOf) && (lonOf < -73.5 || lonOf > -64.5)) outside++;
    const op = Number.isFinite(Number(props.opacity)) ? Number(props.opacity) : 1;
    if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
      const u = unitOf(props, units);
      const style = { ...defaultStyle(), fill: u.color, fillOpacity: 0.45, stroke: shade(u.color), strokeWidth: 0.4, align: 'center', dash: CERTAINTY_DASH[props.certainty] || 'solid', opacity: op };
      const polysIn = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
      for (const rings of polysIn) {
        if (!rings?.[0] || rings[0].length < 4) continue;
        const p = makePath(ring(rings[0]), { closed: true, style, name: u.name, holes: rings.slice(1).map(ring), attrs: { ...flatAttrs(props), unit: u.name, code: u.code } });
        polys.push(p);
      }
    } else if (g.type === 'LineString' || g.type === 'MultiLineString') {
      const style = fieldDrawLineStyle(props, ornaments);
      const label = LINE_TYPES[props.type]?.label || props.type || 'Línea';
      for (const coords of g.type === 'LineString' ? [g.coordinates] : g.coordinates) {
        if (!coords || coords.length < 2) continue;
        const nodes = coords.map(([lon, lat]) => makeNode(...fromLonLat(lon, lat)));
        lines.push(makePath(nodes, { style: { ...style }, name: label, attrs: flatAttrs(props) }));
      }
    } else if (g.type === 'Point') {
      const [lon, lat] = g.coordinates;
      if (props.geomKind === 'control-point' || (!Number.isFinite(Number(props.strike)) && props.geomKind !== 'measurement')) {
        const u = props.unitId || props.unit ? unitOf(props, units) : null;
        const pt = makePoint(...fromLonLat(lon, lat), { ...defaultStyle(), fill: u ? u.color : '#ffffff', fillOpacity: 1, stroke: '#111827', strokeWidth: 0.25, pointShape: 'circle', pointSize: 2.4 });
        pt.name = props.name || props.sampleId || 'Punto de control';
        pt.attrs = flatAttrs(props);
        ctrl.push(pt);
      } else if (Number.isFinite(Number(props.strike)) && Number.isFinite(Number(props.dip))) {
        meas.push(structureSymbol(props, [lon, lat], refScale));
      } else skipped++;
    } else skipped++;
  }

  const fieldsOf = (items) => {
    const set = new Set();
    for (const s of items) for (const k of Object.keys(s.attrs || {})) set.add(k);
    return [...set];
  };
  const layers = [];
  // orden de pintado de FieldDraw: unidades abajo, trazas, medidas y puntos de control arriba
  if (polys.length) layers.push({ name: 'FieldDraw · Unidades', items: polys, fields: fieldsOf(polys), labels: { enabled: true, field: 'code' } });
  if (lines.length) layers.push({ name: 'FieldDraw · Trazas', items: lines, fields: fieldsOf(lines) });
  if (meas.length) layers.push({ name: 'FieldDraw · Medidas', items: meas, fields: fieldsOf(meas) });
  if (ctrl.length) layers.push({ name: 'FieldDraw · Puntos de control', items: ctrl, fields: fieldsOf(ctrl), labels: { enabled: true, field: 'name' } });

  if (skipped) warnings.push(`${skipped} elemento(s) sin geometría válida se omitieron`);
  if (outside) warnings.push(`${outside} elemento(s) caen fuera del huso 19; se proyectaron igual a UTM 19S`);
  if (isProject && Array.isArray(raw.offlineFiles) && raw.offlineFiles.length) warnings.push('los mapas offline y el DEM del paquete no se importan');
  if (isProject && Array.isArray(raw.sections) && raw.sections.length) warnings.push(`${raw.sections.length} perfil(es) no se importan`);
  return { name: raw.name || 'FieldDraw', layers, warnings, count: polys.length + lines.length + meas.length + ctrl.length };
}

export { toLonLat };
