/**
 * Estilos de layout guardados: la «plantilla» de una lámina (página, grilla,
 * elementos y su posición, marco, tamaño de símbolos, cuadros de texto…) sin
 * lo que es del mapa concreto (escala, centro, título, subtítulo, autor, fecha
 * y notas). Se guardan con nombre en el navegador y se pueden exportar a un
 * archivo `.gdlayout.json` para llevarlos a otro equipo.
 */

const KEY = 'gd.layoutStyles';

/** Lo que forma parte del estilo. */
export const STYLE_KEYS = [
  'page', 'orientation', 'margin',
  'grid', 'gridInterval', 'geoInterval', 'gridStyle', 'gridColor', 'gridLabelSize', 'zebra',
  'north', 'scalebar', 'legend', 'legendWidth', 'legendTitle', 'showTitle', 'showInfo',
  'symbolScale', 'symbolFactor', 'fontFamily', 'dpi', 'previewDpi',
  'frame', 'offsets', 'texts', 'fitRound',
];

/** Extrae el estilo (copia profunda) de una configuración de layout. */
export function pickStyle(L) {
  const out = {};
  for (const k of STYLE_KEYS) if (L[k] !== undefined) out[k] = JSON.parse(JSON.stringify(L[k]));
  return out;
}

/** Aplica un estilo guardado sobre la configuración: conserva escala, centro y rótulos del mapa. */
export function applyStyle(L, style) {
  const patch = {};
  for (const k of STYLE_KEYS) {
    if (style[k] !== undefined) patch[k] = JSON.parse(JSON.stringify(style[k]));
    else if (k === 'frame') patch.frame = null;
    else if (k === 'offsets') patch.offsets = {};
    else if (k === 'texts') patch.texts = [];
  }
  return { ...L, ...patch };
}

function read() {
  try {
    const v = JSON.parse(localStorage.getItem(KEY));
    return Array.isArray(v) ? v.filter((x) => x && typeof x.name === 'string' && x.style) : [];
  } catch {
    return [];
  }
}

function write(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

export const listStyles = () => read();

/** Guarda (o reemplaza, si el nombre ya existe) un estilo. */
export function saveStyle(name, L) {
  const clean = String(name || '').trim().slice(0, 60);
  if (!clean) throw new Error('Ponle un nombre al estilo');
  const list = read().filter((s) => s.name !== clean);
  list.push({ name: clean, savedAt: new Date().toISOString(), style: pickStyle(L) });
  list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  if (!write(list)) throw new Error('No se pudo guardar en el navegador (almacenamiento lleno o bloqueado)');
  return list;
}

export function deleteStyle(name) {
  const list = read().filter((s) => s.name !== name);
  write(list);
  return list;
}

export function getStyle(name) {
  return read().find((s) => s.name === name)?.style || null;
}

/** Archivo de intercambio. */
export function styleFile(name, style) {
  return JSON.stringify({ app: 'GISDrawer', kind: 'layout-style', name, style }, null, 1);
}

/** Lee un archivo de estilo (o un array de ellos); devuelve [{name, style}]. */
export function parseStyleFile(text) {
  const raw = JSON.parse(text);
  const items = Array.isArray(raw) ? raw : [raw];
  const out = items.filter((x) => x && x.kind === 'layout-style' && x.style && typeof x.style === 'object').map((x) => ({ name: String(x.name || 'Estilo importado'), style: pickStyle(x.style) }));
  if (!out.length) throw new Error('El archivo no es un estilo de layout de GISDrawer');
  return out;
}

export function importStyles(items) {
  let list = read();
  for (const it of items) {
    list = list.filter((s) => s.name !== it.name);
    list.push({ name: it.name, savedAt: new Date().toISOString(), style: it.style });
  }
  list.sort((a, b) => a.name.localeCompare(b.name, 'es'));
  write(list);
  return list;
}
