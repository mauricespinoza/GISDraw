/**
 * El layout de un mapa: la lámina completa en SVG, en MILÍMETROS.
 *
 * Todo sale de aquí como un único SVG con viewBox en mm, que es a la vez la
 * vista previa, el SVG exportado (se abre en Illustrator con medidas reales),
 * la fuente del PDF y la del PNG. Así no pueden discrepar.
 *
 * Partes:
 *  - marco del mapa a una escala exacta 1:S alrededor de un centro UTM;
 *  - grilla UTM (líneas, cruces o solo marcas) y/o graticulado geográfico en
 *    grados sexagesimales, con rótulos y borde de cebra;
 *  - norte verdadero, girado según la convergencia de meridianos del centro
 *    (en UTM el norte de la cuadrícula NO es el norte geográfico);
 *  - escala gráfica y numérica, leyenda automática, título y datos.
 *
 * Las capas raster llegan ya pintadas como imágenes (`rasters`), porque
 * calcularlas es asíncrono; esto es solo composición.
 */

import { fromLonLat, toLonLat, formatDMSShort } from '../proj.js';
import { defaultStyle, esc, shapeToSvg, textToSvg } from '../style.js';
import { renderLabels, labelText, hasLabelSource } from '../labels.js';
import { classIndex, rendererLabel } from '../symbology.js';
import { lonLatBBox } from '../raster/dem.js';
import { makeNode, makePath, makePoint, walkShapes } from '../vector.js';
import { xmlId } from '../io/illustrator.js';

export const PAGES = {
  A4: [210, 297],
  A3: [297, 420],
  A2: [420, 594],
  A1: [594, 841],
  A0: [841, 1189],
  Carta: [216, 279],
  Oficio: [216, 330],
};

export function defaultLayout(doc, view) {
  return {
    page: 'A4',
    orientation: 'landscape',
    margin: 10,
    scale: doc.refScale,
    center: view ? [Math.round(view.cx), Math.round(view.cy)] : [350000, 6300000],
    title: doc.title && doc.title !== 'Sin título' ? doc.title : 'Mapa geológico',
    subtitle: '',
    author: '',
    date: new Date().toLocaleDateString('es-CL'),
    grid: 'both', // none | utm | geo | both
    gridInterval: 0, // m; 0 = automático
    geoInterval: 0, // minutos; 0 = automático
    gridStyle: 'crosses', // lines | crosses | ticks
    gridColor: '#1f2937',
    gridLabelSize: 6, // pt
    zebra: true,
    north: true,
    scalebar: true,
    legend: true,
    legendWidth: 62,
    legendTitle: 'Leyenda',
    texts: [], // cuadros de texto del layout: { id, x, y, text, fontSize (pt), align, boxWidth (mm), … }
    frame: null, // { x, y, w, h } del marco del mapa en mm; null = automático según la página
    scales: {}, // escala de cada elemento (alrededor de su esquina sup. izq.): { legend: { s, a: [x, y] }, … }
    offsets: {}, // desplazamiento en mm de cada elemento respecto de su lugar por defecto: { legend: [dx, dy], … }
    showTitle: true,
    showInfo: true,
    previewDpi: 'auto', // 'auto' o dpi fijos de la vista previa
    symbolScale: 'auto', // auto | paper | map | custom
    symbolFactor: 1, // solo con 'custom'
    notes: '',
    fontFamily: 'Helvetica, Arial, sans-serif',
    dpi: 200,
  };
}

/* ---------------------------------------------------------- utilidades */

/** Intervalo "redondo" (1, 2, 2.5, 5 × 10^n) cercano a `raw`. */
export function niceInterval(raw) {
  const e = Math.floor(Math.log10(raw));
  const f = raw / 10 ** e;
  const n = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
  return n * 10 ** e;
}

const GEO_STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 60, 120, 300, 600]; // minutos

export function niceGeoInterval(spanDeg, target = 4) {
  const raw = (spanDeg * 60) / target;
  return GEO_STEPS.find((s) => s >= raw) || 600;
}

/** Ángulo (° horario desde arriba) del norte verdadero en un punto UTM. */
export function northRotation(x, y) {
  const [lon, lat] = toLonLat(x, y);
  const [x2, y2] = fromLonLat(lon, lat + 0.01);
  return (Math.atan2(x2 - x, y2 - y) * 180) / Math.PI;
}

/** Longitud y divisiones de la escala gráfica para un ancho máximo en mm. */
export function scaleBarSpec(scale, maxMm) {
  const maxM = (maxMm * scale) / 1000;
  const total = niceInterval(maxM * 0.8);
  let parts = 4;
  const lead = total / 10 ** Math.floor(Math.log10(total));
  if (lead === 2.5 || lead === 5) parts = 5;
  if (lead === 2) parts = 4;
  if (lead === 1) parts = 5;
  const unitKm = total >= 1000;
  return { totalM: total, parts, mm: (total * 1000) / scale, unit: unitKm ? 'km' : 'm', fmt: (m) => (unitKm ? `${+(m / 1000).toFixed(2)}` : `${Math.round(m)}`) };
}

const r2 = (v) => Math.round(v * 100) / 100;
const fmtThousands = (v) => Math.round(v).toLocaleString('es-CL').replace(/\./g, ' ');

/* --------------------------------------------------- tamaño de los símbolos */

export const SYMBOL_SCALES = {
  auto: 'Automático (armonizado)',
  map: 'Como en pantalla a esa escala',
  paper: 'Fijo en papel (mm y pt del estilo)',
  custom: 'Factor manual',
};

/**
 * Factor que multiplica grosores, ornamentos, tramas y textos en la lámina.
 *
 * Los tamaños del estilo están en mm y pt de papel A LA ESCALA DE REFERENCIA
 * del documento. Si la lámina va a otra escala hay dos extremos: dejarlos
 * fijos en papel (`paper`: la geometría se achica o agranda y los símbolos
 * no, lo que a una escala mucho menor amontona el dibujo) o escalarlos con el
 * mapa (`map`: se ve igual que en pantalla a esa escala, pero a una escala
 * mucho menor los textos se vuelven ilegibles). `auto` toma el punto medio
 * geométrico —la raíz de la razón de escalas— y lo acota a ×0,5…×2: a 1:50 000
 * un dibujo hecho a 1:25 000 sale con los símbolos al 71 % y no al 100 % ni
 * al 50 %.
 */
export function symbolFactor(refScale, L) {
  const ratio = refScale > 0 && L.scale > 0 ? refScale / L.scale : 1;
  switch (L.symbolScale) {
    case 'paper':
      return 1;
    case 'map':
      return ratio;
    case 'custom':
      return L.symbolFactor > 0 ? L.symbolFactor : 1;
    default:
      return Math.min(2, Math.max(0.5, Math.sqrt(ratio)));
  }
}

/**
 * Un cuadro de texto del layout como forma de texto en milímetros de PÁGINA
 * (x, y = ancla; tamaño en pt reales de papel, sin el factor de símbolos).
 */
export function layoutTextShape(t) {
  return {
    id: t.id,
    type: 'text',
    x: t.x,
    y: t.y,
    text: t.text ?? '',
    runs: t.runs,
    fontSize: t.fontSize || 10,
    fontFamily: t.fontFamily || 'Helvetica, Arial, sans-serif',
    fontWeight: t.fontWeight || 400,
    italic: !!t.italic,
    anchor: t.anchor || 'start',
    align: t.align,
    boxWidth: t.boxWidth,
    lineHeight: t.lineHeight,
    letterSpacing: t.letterSpacing,
    wordSpacing: t.wordSpacing,
    rotation: t.rotation || 0,
    halo: !!t.halo,
    haloColor: t.haloColor || '#ffffff',
    haloWidth: t.haloWidth ?? 0.5,
    haloOpacity: t.haloOpacity,
    style: { ...defaultStyle(), fill: t.color || '#111827', fillOpacity: 1, fillType: 'solid', stroke: 'none', opacity: 1 },
    visible: true,
  };
}

/** Transformación de un elemento del layout: desplazamiento + escala propia alrededor de su ancla. */
export function elementTransform(L, el, off = L.offsets?.[el] || [0, 0], sc = L.scales?.[el]) {
  let t = `translate(${r2(off[0])} ${r2(off[1])})`;
  if (sc && sc.s && sc.s !== 1) t += ` translate(${r2(sc.a[0])} ${r2(sc.a[1])}) scale(${+sc.s.toFixed(4)}) translate(${r2(-sc.a[0])} ${r2(-sc.a[1])})`;
  return t;
}

/* --------------------------------------------------------- geometría de página */

export function pageGeometry(L) {
  let [W, H] = PAGES[L.page] || PAGES.A4;
  if (L.orientation === 'landscape') [W, H] = [H, W];
  const m = L.margin;
  const titleH = L.title && L.showTitle !== false ? 13 + (L.subtitle ? 5 : 0) : 0;
  const side = L.legend ? L.legendWidth : 0;
  const pad = L.grid === 'none' ? 1 : L.grid === 'both' ? 9 : 7; // espacio para rótulos fuera del marco
  const zebra = L.zebra && L.grid !== 'none' ? 1.6 : 0;
  let fx = m + pad + zebra;
  let fy = m + titleH + pad + zebra;
  let fw = W - 2 * m - side - 2 * (pad + zebra) - (side ? 4 : 0);
  let fh = H - 2 * m - titleH - 2 * (pad + zebra);
  // marco puesto a mano (arrastrando sus vértices): manda sobre el automático
  const custom = !!(L.frame && L.frame.w > 0 && L.frame.h > 0);
  if (custom) ({ x: fx, y: fy, w: fw, h: fh } = L.frame);
  return { W, H, fx, fy, fw, fh, side, titleH, pad, zebra, custom };
}

/** Coordenada UTM bajo un punto de la página (mm). */
export function pageToGround(L, g, px, py) {
  const k = 1000 / L.scale;
  return [L.center[0] + (px - (g.fx + g.fw / 2)) / k, L.center[1] - (py - (g.fy + g.fh / 2)) / k];
}

/** Escala «redonda» (1, 1,5, 2, 2,5, 3, 4, 5, 7,5 × 10ⁿ) igual o mayor que `raw`. */
export function niceScale(raw) {
  const e = 10 ** Math.floor(Math.log10(raw));
  const f = raw / e;
  const n = [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10].find((x) => x >= f - 1e-9) || 10;
  return Math.round(n * e);
}

/**
 * Centro y escala para que la caja `bbox` (UTM) quepa en el marco, con un
 * margen relativo. `round`: sube la escala a un valor redondo.
 */
export function fitFrame(L, g, bbox, { margin = 0.06, round = true } = {}) {
  const w = Math.max(bbox.maxX - bbox.minX, 1);
  const h = Math.max(bbox.maxY - bbox.minY, 1);
  const raw = Math.max((w * 1000) / g.fw, (h * 1000) / g.fh) * (1 + 2 * margin);
  return { center: [Math.round((bbox.minX + bbox.maxX) / 2), Math.round((bbox.minY + bbox.maxY) / 2)], scale: round ? niceScale(raw) : Math.ceil(raw) };
}

/** Extensión UTM del marco. */
export function frameExtent(L, g = pageGeometry(L)) {
  const wM = (g.fw * L.scale) / 1000;
  const hM = (g.fh * L.scale) / 1000;
  return { minX: L.center[0] - wM / 2, maxX: L.center[0] + wM / 2, minY: L.center[1] - hM / 2, maxY: L.center[1] + hM / 2 };
}

/* --------------------------------------------------------------- lámina */

/**
 * @param doc documento
 * @param L   configuración del layout
 * @param rasters [{ index, href, opacity, blend }] imágenes que cubren el marco
 *   exacto, con el índice de su capa (o de la primera del grupo compuesto)
 * @param attribution texto de fuentes
 */
export function composeLayout(doc, L, rasters = [], attribution = '') {
  const g = pageGeometry(L);
  const ext = frameExtent(L, g);
  const k = 1000 / L.scale; // mm por metro
  const P = (x, y) => [g.fx + (x - ext.minX) * k, g.fy + (ext.maxY - y) * k];
  const font = esc(L.fontFamily);
  const defs = [`<clipPath id="frame"><rect x="${r2(g.fx)}" y="${r2(g.fy)}" width="${r2(g.fw)}" height="${r2(g.fh)}"/></clipPath>`];

  const f = symbolFactor(doc.refScale, L);
  // Cada parte es una capa de la lámina (y una capa de Illustrator al exportar).
  const parts = [];
  // el contenido del mapa va recortado al marco, con un grupo `lv` que la vista previa desplaza al mover el mapa
  const mapContent = (inner) => `<g clip-path="url(#frame)"><g class="lv">${inner}</g></g>`;
  const off = (name) => L.offsets?.[name] || [0, 0];
  // un elemento del layout (movible y eliminable): lleva su desplazamiento propio
  const element = (el, name, svg) =>
    svg &&
    parts.push({ name, el, svg: `<g class="eo" transform="${elementTransform(L, el)}">${svg}</g>` });
  const part = (name, svg, extra = {}) => svg && parts.push({ name, svg, ...extra });
  const frameRect = `<rect x="${r2(g.fx)}" y="${r2(g.fy)}" width="${r2(g.fw)}" height="${r2(g.fh)}" fill="#ffffff"/>`;
  part('Fondo', `<rect width="${g.W}" height="${g.H}" fill="#fff"/>${frameRect}`, { locked: true });

  // ---- contenido del mapa, capa por capa
  const vectors = [];
  doc.layers.forEach((l, i) => {
    if (!l.visible) return;
    if (l.kind === 'vector') {
      const ctx = { P, mmToPx: f, ptToPx: 0.352778 * f, viewW: g.W, viewH: g.H, defs, uid: `L${i}_`, flatTol: 0.05 };
      part(l.name, mapContent(l.items.map((sh) => shapeToSvg(sh, ctx)).join('')), { opacity: l.opacity, blend: l.blend, locked: l.locked, map: true });
      vectors.push(l);
    } else {
      const r = rasters.find((x) => x.index === i);
      if (r) {
        part(r.name || l.name, mapContent(`<image x="${r2(g.fx)}" y="${r2(g.fy)}" width="${r2(g.fw)}" height="${r2(g.fh)}" preserveAspectRatio="none" href="${r.href}"/>`), { opacity: r.opacity ?? 1, blend: r.blend, locked: l.locked, map: true });
      }
    }
  });
  const lctx = { P, mmToPx: f, ptToPx: 0.352778 * f, viewW: g.W, viewH: g.H, mpp: 1 / k, scale: L.scale, defs: [], uid: 'lbl_', minFont: 0.8 };
  const labels = renderLabels(vectors, lctx);
  if (labels) part('Etiquetas', mapContent(labels), { map: true });

  // ---- grillas
  part('Grilla y coordenadas', gridSvg(L, g, ext, P, defs, font));

  // ---- marco
  part('Marco', `<rect x="${r2(g.fx)}" y="${r2(g.fy)}" width="${r2(g.fw)}" height="${r2(g.fh)}" fill="none" stroke="#000" stroke-width="0.35"/>`);

  // ---- título
  if (L.title && L.showTitle !== false) {
    element(
      'title',
      'Título',
      `<text x="${r2(L.margin)}" y="${r2(L.margin + 8)}" font-family="${font}" font-size="${r2(16 * 0.352778 * 1.6)}" font-weight="700">${esc(L.title)}</text>` +
        (L.subtitle ? `<text x="${r2(L.margin)}" y="${r2(L.margin + 13.5)}" font-family="${font}" font-size="3.6" fill="#374151">${esc(L.subtitle)}</text>` : ''),
    );
  }

  // ---- leyenda, norte, escala y datos: columna lateral, o dentro del marco si no hay leyenda
  const sideX = g.W - L.margin - g.side;
  const centerRot = northRotation(L.center[0], L.center[1]);
  const info = (x, y, w) => (L.showInfo !== false ? infoSvg(L, x, y, w, centerRot, attribution, font) : '');
  if (g.side) {
    if (L.legend) element('legend', 'Leyenda', legendSvg(doc, vectors, L, sideX, g.fy, g.side, g.fy + g.fh - 52, font, f).svg);
    const blockY = g.fy + g.fh - 48;
    if (L.north) element('north', 'Norte', northArrowSvg(sideX + 10, blockY + 12, centerRot, font));
    if (L.scalebar) element('scalebar', 'Escala', scaleBarSvg(L, sideX + 22, blockY + 6, g.side - 24, font));
    element('info', 'Datos', info(sideX, blockY + 26, g.side));
  } else {
    const bx = g.fx + 4;
    const by = g.fy + g.fh - 22;
    const plate = (x, y, w, h) => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" fill="#fff" fill-opacity="0.85" stroke="#000" stroke-width="0.2"/>`;
    if (L.north) element('north', 'Norte', plate(bx - 2, by - 2, 16, 20) + northArrowSvg(bx + 7, by + 8, centerRot, font, 0.8));
    const sw = Math.min(80, g.fw - 30);
    if (L.scalebar) element('scalebar', 'Escala', plate(bx + 14, by - 2, sw + 12, 20) + scaleBarSvg(L, bx + 20, by + 3, sw, font));
    element('info', 'Datos', L.showInfo !== false ? `<text x="${r2(g.fx)}" y="${r2(g.H - L.margin + 4)}" font-family="${font}" font-size="2.2" fill="#374151">${esc(crsNote(centerRot))}${attribution ? ` · ${esc(attribution)}` : ''}</text>` : '');
  }

  // ---- cuadros de texto del layout
  const tctx = { P: (x, y) => [x, y], mmToPx: 1, ptToPx: 0.352778, viewW: g.W, viewH: g.H, defs, uid: 'lt_', flatTol: 0.05 };
  for (const t of L.texts || []) {
    element(`text:${t.id}`, `Texto: ${String(t.text || '').split('\n')[0].slice(0, 28) || '(vacío)'}`, textToSvg(layoutTextShape(t), { ...tctx, uid: `lt${t.id}_` }));
  }

  // Un grupo de primer nivel por parte, con id y data-name como los escribe
  // Illustrator: así el SVG se abre con la estructura de capas reconocible.
  const used = new Set(['frame']);
  for (const p of parts) p.id = xmlId(p.name, used);
  const group = (p) =>
    `<g id="${p.id}" data-name="${esc(p.name)}"${p.el ? ` data-el="${p.el}"` : ''}${p.opacity != null && p.opacity < 1 ? ` opacity="${p.opacity}"` : ''}${p.blend && p.blend !== 'normal' ? ` style="mix-blend-mode:${p.blend}"` : ''}>${p.svg}</g>`;
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${g.W}mm" height="${g.H}mm" viewBox="0 0 ${g.W} ${g.H}"><defs>${defs.join('')}</defs>${parts.map(group).join('')}</svg>`,
    parts,
    defs: defs.join(''),
    geometry: g,
    extent: ext,
    symbolFactor: f,
  };
}

function crsNote(rot) {
  return `Datum WGS84 · UTM Huso 19 Sur (EPSG:32719) · Convergencia de cuadrícula ${rot >= 0 ? '+' : ''}${rot.toFixed(2)}°`;
}

/* ---------------------------------------------------------------- grillas */

function gridSvg(L, g, ext, P, defs, font) {
  if (L.grid === 'none') return '';
  const out = [];
  const col = esc(L.gridColor);
  const fs = L.gridLabelSize * 0.352778;
  const x0 = g.fx;
  const y0 = g.fy;
  const x1 = g.fx + g.fw;
  const y1 = g.fy + g.fh;
  const both = L.grid === 'both';
  const zebraW = g.zebra;

  // --- UTM
  if (L.grid === 'utm' || both) {
    const wM = ext.maxX - ext.minX;
    const step = L.gridInterval > 0 ? L.gridInterval : niceInterval(wM / 6);
    const xs = [];
    const ys = [];
    for (let x = Math.ceil(ext.minX / step) * step; x <= ext.maxX; x += step) xs.push(x);
    for (let y = Math.ceil(ext.minY / step) * step; y <= ext.maxY; y += step) ys.push(y);
    const lines = [];
    if (L.gridStyle === 'lines') {
      for (const x of xs) lines.push(`M${r2(P(x, 0)[0])} ${r2(y0)}V${r2(y1)}`);
      for (const y of ys) lines.push(`M${r2(x0)} ${r2(P(0, y)[1])}H${r2(x1)}`);
    } else if (L.gridStyle === 'crosses') {
      const c = 2;
      for (const x of xs) for (const y of ys) {
        const [px, py] = P(x, y);
        lines.push(`M${r2(px - c)} ${r2(py)}H${r2(px + c)}M${r2(px)} ${r2(py - c)}V${r2(py + c)}`);
      }
    }
    // marcas en el borde (siempre)
    const t = 2;
    for (const x of xs) {
      const px = P(x, 0)[0];
      lines.push(`M${r2(px)} ${r2(y0)}v${t}M${r2(px)} ${r2(y1)}v${-t}`);
    }
    for (const y of ys) {
      const py = P(0, y)[1];
      lines.push(`M${r2(x0)} ${r2(py)}h${t}M${r2(x1)} ${r2(py)}h${-t}`);
    }
    out.push(`<path d="${lines.join('')}" fill="none" stroke="${col}" stroke-width="0.18" clip-path="url(#frame)"/>`);
    // rótulos: afuera si es la única grilla; adentro (con halo) si hay graticulado
    const halo = both ? ' stroke="#fff" stroke-width="0.6" paint-order="stroke fill"' : '';
    const lab = (x, y, text, anchor, rot = 0) =>
      `<text x="${r2(x)}" y="${r2(y)}" font-family="${font}" font-size="${r2(fs)}" fill="${col}" text-anchor="${anchor}"${rot ? ` transform="rotate(${rot} ${r2(x)} ${r2(y)})"` : ''}${halo}>${text}</text>`;
    const off = both ? -(t + 0.8) : zebraW + 1;
    for (const x of xs) {
      const px = P(x, 0)[0];
      const txt = fmtThousands(x);
      out.push(lab(px, both ? y0 + t + fs + 0.4 : y0 - off - 0.4, txt, 'middle'));
      out.push(lab(px, both ? y1 - t - 0.8 : y1 + off + fs, txt, 'middle'));
    }
    for (const y of ys) {
      const py = P(0, y)[1];
      const txt = fmtThousands(y);
      out.push(lab(both ? x0 + t + fs + 0.3 : x0 - off - 0.4, py, txt, 'middle', -90));
      out.push(lab(both ? x1 - t - 0.6 : x1 + off + fs, py, txt, 'middle', -90));
    }
  }

  // --- geográfico
  if (L.grid === 'geo' || both) {
    const bb = lonLatBBox(ext);
    const stepMin = L.geoInterval > 0 ? L.geoInterval : niceGeoInterval(bb.east - bb.west);
    const step = stepMin / 60;
    const lons = [];
    const lats = [];
    for (let v = Math.ceil(bb.west / step - 1e-9) * step; v <= bb.east + 1e-9; v += step) lons.push(v);
    for (let v = Math.ceil(bb.south / step - 1e-9) * step; v <= bb.north + 1e-9; v += step) lats.push(v);
    const N = 40;
    const lines = [];
    if (L.gridStyle === 'lines') {
      for (const lon of lons) {
        const pts = [];
        for (let i = 0; i <= N; i++) pts.push(P(...fromLonLat(lon, bb.south + ((bb.north - bb.south) * i) / N)));
        lines.push(`M${pts.map((p) => `${r2(p[0])} ${r2(p[1])}`).join('L')}`);
      }
      for (const lat of lats) {
        const pts = [];
        for (let i = 0; i <= N; i++) pts.push(P(...fromLonLat(bb.west + ((bb.east - bb.west) * i) / N, lat)));
        lines.push(`M${pts.map((p) => `${r2(p[0])} ${r2(p[1])}`).join('L')}`);
      }
      out.push(`<path d="${lines.join('')}" fill="none" stroke="${col}" stroke-width="0.15" stroke-dasharray="1.2 0.8" clip-path="url(#frame)"/>`);
    }
    // cruces de meridianos/paralelos con los bordes del marco (bisección)
    const edgeX = (lat, targetX) => bisect((lon) => P(...fromLonLat(lon, lat))[0] - targetX, bb.west - 1, bb.east + 1);
    const edgeYlon = (lon, targetY) => bisect((lat) => P(...fromLonLat(lon, lat))[1] - targetY, bb.south - 1, bb.north + 1);
    const lab = (x, y, text, anchor, rot = 0) =>
      `<text x="${r2(x)}" y="${r2(y)}" font-family="${font}" font-size="${r2(fs)}" fill="#000" text-anchor="${anchor}"${rot ? ` transform="rotate(${rot} ${r2(x)} ${r2(y)})"` : ''}>${text}</text>`;
    const off = zebraW + 1;
    const ticks = [];
    for (const lon of lons) {
      for (const [ey, top] of [[y0, true], [y1, false]]) {
        const lat = edgeYlon(lon, ey);
        if (lat == null) continue;
        const px = P(...fromLonLat(lon, lat))[0];
        if (px < x0 - 0.01 || px > x1 + 0.01) continue;
        ticks.push(`M${r2(px)} ${r2(ey)}v${top ? -zebraW - 0.6 : zebraW + 0.6}`);
        out.push(lab(px, top ? ey - off - 0.4 : ey + off + fs, esc(formatDMSShort(lon, false)), 'middle'));
      }
    }
    for (const lat of lats) {
      for (const [ex, left] of [[x0, true], [x1, false]]) {
        const lon = edgeX(lat, ex);
        if (lon == null) continue;
        const py = P(...fromLonLat(lon, lat))[1];
        if (py < y0 - 0.01 || py > y1 + 0.01) continue;
        ticks.push(`M${r2(ex)} ${r2(py)}h${left ? -zebraW - 0.6 : zebraW + 0.6}`);
        out.push(lab(left ? ex - off - 0.4 : ex + off + fs, py, esc(formatDMSShort(lat, true)), 'middle', -90));
      }
    }
    // borde de cebra: tramos alternos entre subdivisiones del graticulado
    if (L.zebra) {
      const sub = step / 2;
      const zs = [];
      const band = (a, b, side, i) => {
        const fill = i % 2 ? '#fff' : '#000';
        if (side === 'top') zs.push(`<rect x="${r2(Math.min(a, b))}" y="${r2(y0 - zebraW)}" width="${r2(Math.abs(b - a))}" height="${r2(zebraW)}" fill="${fill}"/>`);
        if (side === 'bottom') zs.push(`<rect x="${r2(Math.min(a, b))}" y="${r2(y1)}" width="${r2(Math.abs(b - a))}" height="${r2(zebraW)}" fill="${fill}"/>`);
        if (side === 'left') zs.push(`<rect x="${r2(x0 - zebraW)}" y="${r2(Math.min(a, b))}" width="${r2(zebraW)}" height="${r2(Math.abs(b - a))}" fill="${fill}"/>`);
        if (side === 'right') zs.push(`<rect x="${r2(x1)}" y="${r2(Math.min(a, b))}" width="${r2(zebraW)}" height="${r2(Math.abs(b - a))}" fill="${fill}"/>`);
      };
      for (const [side, ey] of [['top', y0], ['bottom', y1]]) {
        const cuts = [x0];
        for (let lon = Math.ceil(bb.west / sub) * sub - sub; lon <= bb.east + sub; lon += sub) {
          const lat = edgeYlon(lon, ey);
          if (lat == null) continue;
          const px = P(...fromLonLat(lon, lat))[0];
          if (px > x0 && px < x1) cuts.push(px);
        }
        cuts.push(x1);
        const first = Math.round((bb.west - (bb.west % sub)) / sub);
        for (let i = 0; i < cuts.length - 1; i++) band(cuts[i], cuts[i + 1], side, i + first);
      }
      for (const [side, ex] of [['left', x0], ['right', x1]]) {
        const cuts = [y1];
        for (let lat = Math.ceil(bb.south / sub) * sub - sub; lat <= bb.north + sub; lat += sub) {
          const lon = edgeX(lat, ex);
          if (lon == null) continue;
          const py = P(...fromLonLat(lon, lat))[1];
          if (py > y0 && py < y1) cuts.push(py);
        }
        cuts.push(y0);
        const first = Math.round((bb.south - (bb.south % sub)) / sub);
        for (let i = 0; i < cuts.length - 1; i++) band(cuts[i], cuts[i + 1], side, i + first);
      }
      out.push(`<g>${zs.join('')}</g><rect x="${r2(x0 - zebraW)}" y="${r2(y0 - zebraW)}" width="${r2(g.fw + 2 * zebraW)}" height="${r2(g.fh + 2 * zebraW)}" fill="none" stroke="#000" stroke-width="0.2"/>`);
    }
    out.push(`<path d="${ticks.join('')}" stroke="#000" stroke-width="0.25"/>`);
  }
  return out.join('');
}

function bisect(f, a, b) {
  let fa = f(a);
  const fb = f(b);
  if (Number.isNaN(fa) || Number.isNaN(fb) || fa * fb > 0) return null;
  for (let i = 0; i < 60; i++) {
    const m = (a + b) / 2;
    const fm = f(m);
    if (fa * fm <= 0) b = m;
    else {
      a = m;
      fa = fm;
    }
  }
  return (a + b) / 2;
}

/* ------------------------------------------------------------ elementos */

export function northArrowSvg(cx, cy, rot, font, s = 1) {
  return `<g transform="translate(${r2(cx)} ${r2(cy)}) rotate(${r2(rot)}) scale(${s})"><path d="M0 -9 L3.2 4 L0 2.2 Z" fill="#000"/><path d="M0 -9 L-3.2 4 L0 2.2 Z" fill="#fff" stroke="#000" stroke-width="0.3"/><text x="0" y="-10.5" font-family="${font}" font-size="4" font-weight="700" text-anchor="middle">N</text></g>`;
}

export function scaleBarSvg(L, x, y, maxW, font) {
  const sp = scaleBarSpec(L.scale, maxW);
  const seg = sp.mm / sp.parts;
  const parts = [];
  for (let i = 0; i < sp.parts; i++) {
    parts.push(`<rect x="${r2(x + i * seg)}" y="${r2(y)}" width="${r2(seg)}" height="1.6" fill="${i % 2 ? '#fff' : '#000'}" stroke="#000" stroke-width="0.2"/>`);
  }
  const labels = [];
  // rótulos intermedios solo si caben; si no, 0, la mitad (si existe) y el final
  const every = seg >= 7 ? 1 : sp.parts % 2 === 0 ? sp.parts / 2 : sp.parts;
  for (let i = 0; i <= sp.parts; i++) {
    if (i % every && i !== sp.parts) continue;
    labels.push(`<text x="${r2(x + i * seg)}" y="${r2(y + 4.6)}" font-family="${font}" font-size="2.4" text-anchor="middle">${sp.fmt((sp.totalM * i) / sp.parts)}${i === sp.parts ? ` ${sp.unit}` : ''}</text>`);
  }
  const num = `<text x="${r2(x + sp.mm / 2)}" y="${r2(y - 1.4)}" font-family="${font}" font-size="2.8" text-anchor="middle">Escala 1:${fmtThousands(L.scale).replace(/ /g, '.')}</text>`;
  return `<g>${num}${parts.join('')}${labels.join('')}</g>`;
}

function infoSvg(L, x, y, w, rot, attribution, font) {
  const lines = [];
  if (L.author) lines.push([L.author, 2.6, 700]);
  if (L.date) lines.push([L.date, 2.4, 400]);
  for (const t of wrap(crsNote(rot), 52)) lines.push([t, 2.2, 400]);
  if (L.notes) for (const t of wrap(L.notes, 52)) lines.push([t, 2.2, 400]);
  if (attribution) for (const t of wrap(`Fuentes: ${attribution}`, 56)) lines.push([t, 1.9, 400]);
  let yy = y;
  return lines
    .map(([t, fs, fw]) => {
      yy += fs * 1.35;
      return `<text x="${r2(x)}" y="${r2(yy)}" font-family="${font}" font-size="${fs}" font-weight="${fw}" fill="#111827">${esc(t)}</text>`;
    })
    .join('');
}

function wrap(text, n) {
  const out = [];
  let cur = '';
  for (const w of String(text).split(/\s+/)) {
    if ((cur + ' ' + w).trim().length > n) {
      if (cur) out.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}

/* ---------------------------------------------------------------- leyenda */

/** Entradas de leyenda: un símbolo por estilo distinto en cada capa visible. */
export function legendEntries(vectors) {
  const groups = [];
  for (let i = vectors.length - 1; i >= 0; i--) {
    const l = vectors[i];
    if (l.legend === false) continue;
    const seen = new Map();
    walkShapes(l.items, (s, parent) => {
      if (s.type === 'group' || s.type === 'text' || s.visible === false) return;
      if (parent?.clip && parent.children[0] === s) return;
      const kind = s.type === 'point' ? 'point' : s.closed ? 'polygon' : 'line';
      const key = `${kind}|${JSON.stringify(s.style)}`;
      const cfg = l.labels || {};
      // con simbología por campo, la leyenda lleva el rótulo de la clase
      const cls = l.renderer ? rendererLabel(l.renderer, parent || s) : null;
      const label = cls || (l.legendField && s.attrs?.[l.legendField]) || (hasLabelSource(cfg) ? labelText(s, { ...cfg, upper: false }) : '') || s.name || l.name;
      const order = l.renderer ? classIndex(l.renderer, parent || s) : 0;
      if (!seen.has(key)) seen.set(key, { kind, style: s.style, labels: new Set([label]), order: order < 0 ? 1e6 : order });
      else seen.get(key).labels.add(label);
    });
    const entries = [...seen.values()].sort((a, b) => a.order - b.order).map((e) => ({ ...e, label: e.labels.size === 1 ? [...e.labels][0] : [...e.labels].slice(0, 3).join(', ') + (e.labels.size > 3 ? '…' : '') }));
    if (entries.length) groups.push({ layer: l.name, entries });
  }
  return groups;
}

function legendSvg(doc, vectors, L, x, y, w, maxY, font, f = 1) {
  const out = [`<text x="${r2(x)}" y="${r2(y + 4)}" font-family="${font}" font-size="3.6" font-weight="700">${esc(L.legendTitle || 'Leyenda')}</text>`];
  let yy = y + 9;
  // las muestras llevan el mismo factor que el mapa, para que se lean igual
  const ctx = { P: (a, b) => [a, b], mmToPx: f, ptToPx: 0.352778 * f, viewW: 1000, viewH: 1000, defs: [], uid: 'leg_', flatTol: 0.05 };
  for (const grp of legendEntries(vectors)) {
    if (yy > maxY) break;
    out.push(`<text x="${r2(x)}" y="${r2(yy)}" font-family="${font}" font-size="2.6" font-weight="700" fill="#374151">${esc(grp.layer)}</text>`);
    yy += 2.5;
    for (const e of grp.entries) {
      if (yy > maxY) {
        out.push(`<text x="${r2(x)}" y="${r2(yy + 3)}" font-family="${font}" font-size="2.2" fill="#6b7280">…</text>`);
        break;
      }
      const sx = x + 1;
      const sy = yy + 0.8;
      let sym;
      if (e.kind === 'polygon') sym = makePath([makeNode(sx, sy), makeNode(sx + 8, sy), makeNode(sx + 8, sy + 4.5), makeNode(sx, sy + 4.5)], { closed: true, style: e.style });
      else if (e.kind === 'line') {
        // con ornamento u onda la muestra va RECTA y un poco más larga, para que se lea el símbolo
        const plain = (!e.style.ornament || e.style.ornament === 'none') && !e.style.wavy;
        sym = plain
          ? makePath([makeNode(sx, sy + 3.5), makeNode(sx + 3, sy + 1.2), makeNode(sx + 5.5, sy + 3.2), makeNode(sx + 8, sy + 1)], { style: e.style })
          : makePath([makeNode(sx, sy + 3.2), makeNode(sx + 9, sy + 3.2)], { style: e.style });
      }
      else sym = makePoint(sx + 4, sy + 2.25, e.style);
      const svgSym = shapeToSvg(sym, { ...ctx, defs: ctx.defs, viewW: 2000, viewH: 2000 });
      out.push(svgSym);
      for (const [i, t] of wrap(e.label, Math.max(14, Math.floor((w - 12) / 1.45))).slice(0, 2).entries()) {
        out.push(`<text x="${r2(x + 12)}" y="${r2(yy + 3.6 + i * 2.8)}" font-family="${font}" font-size="2.5">${esc(t)}</text>`);
      }
      yy += 6.6;
    }
    yy += 2.4;
  }
  out.unshift(`<defs>${ctx.defs.join('')}</defs>`);
  return { svg: `<g>${out.join('')}</g>`, bottom: yy };
}
