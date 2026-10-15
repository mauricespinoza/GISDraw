/**
 * Tramas de litología: los rellenos clásicos de un mapa geológico.
 *
 * Cada trama es un mosaico en un cuadrado de 10×10 unidades de diseño, con el
 * color como único parámetro. El mosaico se escala al tamaño de papel pedido
 * (`patternSize`, mm por lado) y se repite como <pattern> de SVG, que
 * también entiende el PDF. La trama va ENCIMA del relleno de color, así el
 * color de la unidad (fondo) y el símbolo de la litología (trama) se eligen
 * por separado, como en las cartas del USGS y del Sernageomin.
 *
 * Los dibujos siguen la convención de uso general (FGDC / USGS): puntos para
 * arenisca, círculos para conglomerado, ladrillos para caliza, ladrillos con
 * rombos para dolomía, líneas discontinuas para lutita, cruces para rocas
 * plutónicas, "v" para volcánicas, bandas onduladas para gneis…
 */

const S = (c, w = 0.7) => `stroke="${c}" stroke-width="${w}" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
const F = (c) => `fill="${c}" stroke="none"`;
const dot = (x, y, r, c) => `<circle cx="${x}" cy="${y}" r="${r}" ${F(c)}/>`;
const ring = (x, y, r, c, w = 0.6) => `<circle cx="${x}" cy="${y}" r="${r}" ${S(c, w)}/>`;
const line = (x1, y1, x2, y2, c, w = 0.7) => `<path d="M${x1} ${y1}L${x2} ${y2}" ${S(c, w)}/>`;
const path = (d, c, w = 0.7) => `<path d="${d}" ${S(c, w)}/>`;
const tri = (x, y, s, c, solid = false) =>
  `<path d="M${x} ${y - s}L${x + s} ${y + s * 0.8}L${x - s} ${y + s * 0.8}Z" ${solid ? F(c) : S(c, 0.6)}/>`;
const cross = (x, y, s, c, w = 0.7) => path(`M${x - s} ${y}H${x + s}M${x} ${y - s}V${y + s}`, c, w);
const xmark = (x, y, s, c, w = 0.7) => path(`M${x - s} ${y - s}L${x + s} ${y + s}M${x - s} ${y + s}L${x + s} ${y - s}`, c, w);
const vee = (x, y, s, c) => path(`M${x - s} ${y - s * 0.8}L${x} ${y + s * 0.8}L${x + s} ${y - s * 0.8}`, c, 0.8);

export const PATTERN_GROUPS = [
  { id: 'sed', label: 'Sedimentarias' },
  { id: 'carb', label: 'Carbonatos y evaporitas' },
  { id: 'plut', label: 'Plutónicas' },
  { id: 'volc', label: 'Volcánicas' },
  { id: 'met', label: 'Metamórficas' },
  { id: 'gen', label: 'Cobertura y generales' },
];

/**
 * id -> { label, group, draw(color) }. Los textos van en español porque el
 * resto de la interfaz lo está.
 */
export const PATTERNS = {
  /* ------------------------------------------------------------ sedimentarias */
  sandstone: {
    label: 'Arenisca',
    group: 'sed',
    draw: (c) => dot(2.5, 2.5, 0.75, c) + dot(7.5, 7.5, 0.75, c) + dot(7.5, 2.5, 0.45, c) + dot(2.5, 7.5, 0.45, c),
  },
  siltstone: {
    label: 'Limolita',
    group: 'sed',
    draw: (c) => line(1, 2.5, 4, 2.5, c) + dot(7.5, 2.5, 0.6, c) + line(6, 7.5, 9, 7.5, c) + dot(2.5, 7.5, 0.6, c),
  },
  shale: {
    label: 'Lutita',
    group: 'sed',
    draw: (c) => line(0, 2.5, 4, 2.5, c) + line(5, 7.5, 9, 7.5, c),
  },
  claystone: { label: 'Arcilla', group: 'sed', draw: (c) => line(0, 2.5, 10, 2.5, c) + line(0, 7.5, 10, 7.5, c) },
  conglomerate: {
    label: 'Conglomerado',
    group: 'sed',
    draw: (c) => ring(3, 3, 2.2, c) + ring(7.8, 7.2, 1.6, c) + dot(8, 2.2, 0.6, c) + dot(2.2, 8, 0.6, c),
  },
  breccia: {
    label: 'Brecha',
    group: 'sed',
    draw: (c) => path('M1 2L4 1L5 4L2 5Z', c, 0.65) + path('M6 6L9 5L9.5 8.5L6.5 9Z', c, 0.65) + dot(7.5, 2, 0.5, c) + dot(2.5, 8, 0.5, c),
  },
  sand: {
    label: 'Arena / dunas',
    group: 'sed',
    draw: (c) => dot(1.5, 1.5, 0.45, c) + dot(5, 3.5, 0.45, c) + dot(8.5, 1.8, 0.45, c) + dot(3, 6.5, 0.45, c) + dot(7, 7.5, 0.45, c) + dot(9.2, 5, 0.35, c) + line(1, 9, 3, 9, c, 0.5),
  },
  alluvium: {
    label: 'Aluvial / fluvial',
    group: 'sed',
    draw: (c) => dot(2, 2, 0.6, c) + ring(6.5, 3, 1.2, c, 0.55) + dot(8.5, 8, 0.6, c) + ring(3, 7.5, 0.9, c, 0.55) + dot(5.5, 6, 0.4, c),
  },
  /* --------------------------------------------------------------- carbonatos */
  limestone: {
    label: 'Caliza',
    group: 'carb',
    draw: (c) => line(0, 0, 10, 0, c, 0.6) + line(0, 5, 10, 5, c, 0.6) + line(5, 0, 5, 5, c, 0.6) + line(0, 5, 0, 10, c, 0.6) + line(10, 5, 10, 10, c, 0.6) + line(0, 10, 10, 10, c, 0.6),
  },
  dolomite: {
    label: 'Dolomía',
    group: 'carb',
    draw: (c) =>
      line(0, 0, 10, 0, c, 0.6) + line(0, 5, 10, 5, c, 0.6) + line(5, 0, 5, 5, c, 0.6) + line(0, 5, 0, 10, c, 0.6) + line(10, 5, 10, 10, c, 0.6) + line(0, 10, 10, 10, c, 0.6) +
      path('M5 5.8L6.6 7.5L5 9.2L3.4 7.5Z', c, 0.6) + path('M0 0.9L1.5 2.5L0 4.1', c, 0.6) + path('M10 0.9L8.5 2.5L10 4.1', c, 0.6),
  },
  marl: {
    label: 'Marga',
    group: 'carb',
    draw: (c) => line(0, 2.5, 10, 2.5, c, 0.6) + line(2.5, 0, 2.5, 5, c, 0.6) + line(0, 7.5, 4, 7.5, c) + line(6, 7.5, 10, 7.5, c),
  },
  gypsum: {
    label: 'Yeso',
    group: 'carb',
    draw: (c) => line(0, 2.5, 10, 2.5, c, 0.6) + line(2.5, 2.5, 2.5, 5, c, 0.6) + line(0, 7.5, 10, 7.5, c, 0.6) + line(7.5, 7.5, 7.5, 10, c, 0.6),
  },
  halite: {
    label: 'Sal (halita)',
    group: 'carb',
    draw: (c) => `<rect x="1.5" y="1.5" width="2.5" height="2.5" ${S(c, 0.6)}/><rect x="6" y="6" width="2.5" height="2.5" ${S(c, 0.6)}/>` + dot(7.2, 2.7, 0.5, c) + dot(2.7, 7.2, 0.5, c),
  },
  coal: {
    label: 'Carbón',
    group: 'carb',
    draw: (c) => `<rect x="1" y="1" width="3" height="3" ${F(c)}/><rect x="6" y="6" width="3" height="3" ${F(c)}/><rect x="6.5" y="1.5" width="1.6" height="1.6" ${F(c)}/><rect x="1.5" y="6.5" width="1.6" height="1.6" ${F(c)}/>`,
  },
  /* ---------------------------------------------------------------- plutónicas */
  granite: {
    label: 'Granito / granitoide',
    group: 'plut',
    draw: (c) => cross(2.5, 2.5, 1.6, c) + cross(7.5, 7.5, 1.6, c),
  },
  granodiorite: {
    label: 'Granodiorita / diorita',
    group: 'plut',
    draw: (c) => cross(2.5, 2.5, 1.5, c) + cross(7.5, 7.5, 1.5, c) + dot(7.5, 2.5, 0.6, c) + dot(2.5, 7.5, 0.6, c),
  },
  gabbro: {
    label: 'Gabro / máfica',
    group: 'plut',
    draw: (c) => xmark(2.5, 2.5, 1.3, c) + xmark(7.5, 7.5, 1.3, c) + dot(7.5, 2.5, 0.5, c) + dot(2.5, 7.5, 0.5, c),
  },
  alteration: {
    label: 'Alteración hidrotermal',
    group: 'plut',
    draw: (c) => xmark(2.5, 2.5, 1.2, c, 0.8) + xmark(7.5, 7.5, 1.2, c, 0.8) + line(6, 2.5, 9, 2.5, c, 0.5) + line(1, 7.5, 4, 7.5, c, 0.5),
  },
  /* ----------------------------------------------------------------- volcánicas */
  basalt: {
    label: 'Basalto / andesita',
    group: 'volc',
    draw: (c) => vee(2.5, 2.5, 1.8, c) + vee(7.5, 7.5, 1.8, c),
  },
  rhyolite: {
    label: 'Riolita / ignimbrita',
    group: 'volc',
    draw: (c) => line(0.8, 2.5, 4.2, 2.5, c, 0.9) + line(5.8, 7.5, 9.2, 7.5, c, 0.9) + dot(7.5, 2.5, 0.5, c) + dot(2.5, 7.5, 0.5, c),
  },
  tuff: {
    label: 'Toba',
    group: 'volc',
    draw: (c) => tri(2.5, 2.8, 1.5, c, true) + tri(7.5, 7.3, 1.5, c, true) + dot(7.5, 2.5, 0.4, c) + dot(2.5, 7.5, 0.4, c),
  },
  volcbreccia: {
    label: 'Brecha volcánica',
    group: 'volc',
    draw: (c) => tri(2.6, 2.8, 1.7, c) + tri(7.4, 7.2, 1.7, c) + dot(7.5, 2.5, 0.5, c) + dot(2.5, 7.5, 0.5, c),
  },
  /* -------------------------------------------------------------- metamórficas */
  gneiss: {
    label: 'Gneis',
    group: 'met',
    draw: (c) => path('M0 2.5Q2.5 0.5 5 2.5T10 2.5', c, 0.75) + path('M0 7.5Q2.5 5.5 5 7.5T10 7.5', c, 0.75),
  },
  schist: {
    label: 'Esquisto',
    group: 'met',
    draw: (c) => path('M1 4Q3 1.5 5 3Q3 5 1 4Z', c, 0.6) + path('M5.5 9Q7.5 6.5 9.5 8Q7.5 10 5.5 9Z', c, 0.6) + dot(8, 2.5, 0.4, c) + dot(2.5, 8, 0.4, c),
  },
  phyllite: {
    label: 'Filita / pizarra',
    group: 'met',
    draw: (c) => line(0, 10, 10, 0, c, 0.55) + line(-5, 5, 5, -5, c, 0.55) + line(5, 15, 15, 5, c, 0.55),
  },
  quartzite: {
    label: 'Cuarcita',
    group: 'met',
    draw: (c) => line(0, 5, 5, 0, c, 0.6) + line(5, 10, 10, 5, c, 0.6) + dot(7.5, 2.5, 0.55, c) + dot(2.5, 7.5, 0.55, c),
  },
  marble: {
    label: 'Mármol',
    group: 'met',
    draw: (c) => path('M5 0.8L9.2 5L5 9.2L0.8 5Z', c, 0.6),
  },
  /* --------------------------------------------------------------- generales */
  till: {
    label: 'Depósito glacial / morrena',
    group: 'gen',
    draw: (c) => ring(2.5, 2.5, 1.3, c, 0.55) + tri(7.5, 3, 1.1, c, true) + dot(2.8, 7.5, 0.6, c) + ring(7.5, 7.7, 0.9, c, 0.55),
  },
  hlines: { label: 'Líneas horizontales', group: 'gen', draw: (c) => line(0, 2.5, 10, 2.5, c) + line(0, 7.5, 10, 7.5, c) },
  vlines: { label: 'Líneas verticales', group: 'gen', draw: (c) => line(2.5, 0, 2.5, 10, c) + line(7.5, 0, 7.5, 10, c) },
  diag: { label: 'Diagonales /', group: 'gen', draw: (c) => line(0, 10, 10, 0, c) + line(-5, 5, 5, -5, c) + line(5, 15, 15, 5, c) },
  diag2: { label: 'Diagonales \\', group: 'gen', draw: (c) => line(0, 0, 10, 10, c) + line(-5, 5, 5, 15, c) + line(5, -5, 15, 5, c) },
  grid: { label: 'Cuadrícula', group: 'gen', draw: (c) => line(0, 5, 10, 5, c, 0.6) + line(5, 0, 5, 10, c, 0.6) },
  hatch: { label: 'Rayado cruzado', group: 'gen', draw: (c) => line(0, 10, 10, 0, c, 0.6) + line(0, 0, 10, 10, c, 0.6) },
  dots: { label: 'Puntos', group: 'gen', draw: (c) => dot(2.5, 2.5, 0.8, c) + dot(7.5, 7.5, 0.8, c) },
};

export const PATTERN_IDS = Object.keys(PATTERNS);

/** Mosaico SVG <pattern> con id, color y tamaño de papel (en unidades de salida). */
export function patternDef(id, key, color, tilePx, opacity = 1) {
  const p = PATTERNS[key];
  if (!p) return '';
  const k = tilePx / 10;
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="${tilePx}" height="${tilePx}"><g transform="scale(${k})"${
    opacity < 1 ? ` opacity="${opacity}"` : ''
  }>${p.draw(color)}</g></pattern>`;
}

/** Miniatura para el selector del panel: un <svg> autónomo (usa un id único). */
export function patternPreview(key, color = '#111827', bg = '#ffffff', px = 44) {
  const id = `pv_${key}`;
  return `<svg width="${px}" height="${px}" viewBox="0 0 ${px} ${px}"><defs>${patternDef(id, key, color, 15)}</defs><rect width="${px}" height="${px}" fill="${bg}"/><rect width="${px}" height="${px}" fill="url(#${id})"/></svg>`;
}
