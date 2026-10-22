/**
 * Modos de la app.
 *
 * - Canvas (por defecto): solo dibujo. Sin mapa base, relieve, coordenadas,
 *   georreferenciación, atributos ni formatos GIS.
 * - GIS: todo lo anterior, como era antes de que existieran los modos.
 *
 * El modo es un ajuste de la app, no del proyecto: las capas de mapa base y
 * relieve de un proyecto siguen en él y solo se ocultan en Canvas, así que al
 * volver a GIS se ven igual.
 */

export const MODES = { canvas: 'Canvas', gis: 'GIS' };

/** Capas que solo existen en modo GIS (el resto, incluidas las imágenes, se ve en ambos). */
export const isGisLayer = (l) => l.kind === 'basemap' || l.kind === 'hillshade';

/** Pestañas del panel que solo existen en modo GIS. */
export const GIS_TABS = ['relief', 'georef', 'attrs'];

export const modeOf = (settings) => (settings?.mode === 'gis' ? 'gis' : 'canvas');

/* ------------------------------------------------------------------ lienzo */

/** Hojas del lienzo (mm, vertical: ancho × alto). `Carta` es Letter: la clave coincide con la del layout. */
export const CANVAS_SIZES = {
  Carta: { label: 'Letter', mm: [216, 279] },
  A4: { label: 'A4', mm: [210, 297] },
  A3: { label: 'A3', mm: [297, 420] },
  A2: { label: 'A2', mm: [420, 594] },
  A1: { label: 'A1', mm: [594, 841] },
  A0: { label: 'A0', mm: [841, 1189] },
};

/** Centro del lienzo en el mundo: el de la vista inicial (Santiago), así no hay que mover nada al cambiar de modo. */
export const CANVAS_CENTER = [346000, 6297000];

export const defaultCanvas = () => ({ size: 'A4', orientation: 'portrait', w: 210, h: 297 });

/** Lienzo válido (y con sus medidas al día) a partir de lo guardado en un proyecto. */
export function normalizeCanvas(c) {
  const out = { ...defaultCanvas(), ...(c || {}) };
  if (CANVAS_SIZES[out.size]) [out.w, out.h] = CANVAS_SIZES[out.size].mm;
  else {
    out.size = 'custom';
    out.w = Math.max(10, Number(out.w) || 210);
    out.h = Math.max(10, Number(out.h) || 297);
  }
  out.orientation = out.orientation === 'landscape' ? 'landscape' : 'portrait';
  // posición de la hoja en el mundo (centro): sin ella, la de la vista inicial
  if (Number.isFinite(out.cx) && Number.isFinite(out.cy)) {
    out.cx = Number(out.cx);
    out.cy = Number(out.cy);
  } else {
    delete out.cx;
    delete out.cy;
  }
  return out;
}

/** Medidas de la hoja en mm, con la orientación aplicada. */
export function canvasMm(c) {
  const { w, h } = normalizeCanvas(c);
  const [a, b] = [Math.min(w, h), Math.max(w, h)];
  return normalizeCanvas(c).orientation === 'landscape' ? [b, a] : [a, b];
}

/** Hoja en el mundo (metros UTM, y hacia arriba): { x, y, w, h } con (x, y) en la esquina inferior izquierda. */
export function canvasRect(doc) {
  const c = normalizeCanvas(doc.canvas);
  const [w, h] = canvasMm(c).map((mm) => (mm * doc.refScale) / 1000);
  const [cx, cy] = Number.isFinite(c.cx) ? [c.cx, c.cy] : CANVAS_CENTER;
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

/** Medida mínima de la hoja personalizada (mm). */
export const CANVAS_MIN_MM = 10;

/**
 * Hoja personalizada que cubre un rectángulo del mundo ({x, y, w, h}, y hacia
 * arriba): ajustes de `canvas` con medidas en mm de papel a la escala `refScale`
 * y el centro en el mundo. Con 0,01 mm de resolución; no baja de `CANVAS_MIN_MM`.
 */
export function canvasCovering(rect, refScale) {
  const mm = (m) => Math.max(CANVAS_MIN_MM, Math.round(((m * 1000) / refScale) * 100) / 100);
  const w = mm(rect.w);
  const h = mm(rect.h);
  return { size: 'custom', orientation: w > h ? 'landscape' : 'portrait', w, h, cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2 };
}

/** Hoja que mejor calza con unas medidas (mm), o la personalizada. */
export function canvasFromMm(w, h) {
  const [a, b] = [Math.min(w, h), Math.max(w, h)];
  for (const [key, { mm }] of Object.entries(CANVAS_SIZES)) {
    if (Math.abs(mm[0] - a) <= 1.5 && Math.abs(mm[1] - b) <= 1.5) return normalizeCanvas({ size: key, orientation: w > h ? 'landscape' : 'portrait' });
  }
  return normalizeCanvas({ size: 'custom', orientation: w > h ? 'landscape' : 'portrait', w: Math.round(a), h: Math.round(b) });
}

/**
 * Grosor de trazo (mm) y letra (pt) por defecto: los de una figura que ocupa
 * media hoja. En A4 son 0,35 mm (1 pt) y 9 pt; en otra hoja crecen con la raíz
 * del área (una figura de media hoja A3 es 1,41 veces más grande que en A4).
 */
export function canvasDefaults(c) {
  const [w, h] = canvasMm(c);
  const f = Math.sqrt((w * h) / (210 * 297));
  return { strokeWidth: Math.round(0.35 * f * 20) / 20, fontSize: Math.round(9 * f * 2) / 2, factor: f };
}

/** Pestañas del panel que solo existen en el modo Canvas. */
export const CANVAS_TABS = ['canvas'];
