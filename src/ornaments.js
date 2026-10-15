/**
 * Ornamentos de falla y de pliegue sobre una línea, como en FieldDraw:
 * dientes en las inversas (cabalgamientos), tics con bolita en las normales,
 * pares de medias flechas en las de rumbo, y flechas perpendiculares al eje en
 * los pliegues (divergentes en un antiforme, convergentes en un sinforme).
 *
 * La geometría de cada símbolo es la de `ornaments.js` de FieldDraw, en las
 * mismas unidades de diseño (px de pantalla), que aquí se convierten a
 * milímetros de papel con `U` = 0,2646 mm por unidad. Así un diente mide lo
 * mismo en el papel a cualquier escala del mapa.
 *
 * Marco local de cada símbolo: x a lo largo de la línea en el sentido en que
 * se digitalizó, y NEGATIVA hacia la izquierda de ese sentido. Los dientes y
 * el tic van a la izquierda; `side: 'right'` los pasa al otro lado (una falla
 * se digitalizó "al revés" y se arregla con el interruptor, no redibujando).
 * Las de rumbo y los pliegues son simétricas: el lado no les afecta.
 */

/** mm de papel por unidad de diseño (1 px a 96 dpi). */
export const U = 25.4 / 96;

export const ORNAMENTS = {
  none: { label: 'Ninguno' },
  thrust: { label: 'Cabalgamiento / falla inversa (dientes)', spacing: 6.9, flippable: true, color: '#0000ff', width: 0.36 },
  normal: { label: 'Falla normal (tic con bolita)', spacing: 7.9, flippable: true, color: '#0000ff', width: 0.33 },
  dextral: { label: 'Falla dextral (medias flechas)', spacing: 21, gap: 0.8, color: '#0000ff', width: 0.33 },
  sinistral: { label: 'Falla sinestral (medias flechas)', spacing: 21, gap: 0.8, color: '#0000ff', width: 0.33 },
  antiform: { label: 'Antiforme (flechas divergentes)', spacing: 17, color: '#ff00ff', width: 0.34 },
  synform: { label: 'Sinforme (flechas convergentes)', spacing: 17, color: '#ff00ff', width: 0.34 },
};

export const ORNAMENT_LIMITS = {
  size: { min: 0.4, max: 2.5, step: 0.05 },
  spacing: { min: 2.5, max: 60, step: 0.5 },
  gap: { min: 0.3, max: 3.2, step: 0.1 },
};

/** Opacidad del halo del ornamento: la misma que el halo de la traza en FieldDraw. */
export const HALO_OPACITY = 0.55;
const HALO_EXTRA = 2.4; // unidades de diseño

/* Primitivas en unidades de diseño. Cada símbolo es una lista:
 *   { poly: [[x,y]…] }                relleno
 *   { circle: [cx, cy, r] }           relleno
 *   { line: [[x,y],[x,y]], w }        trazo
 */

function halfArrow(x0, x1, y, up) {
  const dir = x1 > x0 ? 1 : -1;
  return [
    { line: [[x0, y], [x1, y]], w: 1.6 },
    { poly: [[x1, y], [x1 - dir * 5, y + (up ? -4 : 4)], [x1 - dir * 3.2, y]] },
  ];
}

function foldArrow(x, yTail, yHead) {
  const dir = Math.sign(yHead - yTail);
  return [
    { line: [[x, yTail], [x, yHead - dir * 3.6]], w: 1.5 },
    { poly: [[x, yHead], [x - 2.9, yHead - dir * 4.4], [x + 2.9, yHead - dir * 4.4]] },
  ];
}

/** Símbolo de un tipo, centrado en x = 0 sobre la traza. `gap` en unidades de diseño. */
export function symbolOf(type, gap = 3) {
  switch (type) {
    case 'thrust':
      return { prims: [{ poly: [[-5.5, 0], [5.5, 0], [0, -9]] }], halfWidth: 5.5 };
    case 'normal':
      return {
        prims: [{ line: [[0, 0], [0, -4]], w: 1.4 }, { circle: [0, -6.5, 2.5] }],
        halfWidth: 2.5,
      };
    case 'dextral':
    case 'sinistral': {
      const d = type === 'dextral';
      // arriba (izquierda de la traza) y abajo; siempre con la barba hacia afuera
      const top = d ? [-9, 9] : [9, -9];
      const bot = d ? [9, -9] : [-9, 9];
      return { prims: [...halfArrow(top[0], top[1], -gap, true), ...halfArrow(bot[0], bot[1], gap, false)], halfWidth: 9 };
    }
    case 'antiform':
      return { prims: [...foldArrow(0, -0.6, -10.1), ...foldArrow(0, 0.6, 10.1)], halfWidth: 3 };
    case 'synform':
      return { prims: [...foldArrow(0, -10.1, -0.6), ...foldArrow(0, 10.1, 0.6)], halfWidth: 3 };
    default:
      return null;
  }
}

/** Posición y tangente a distancia `d` a lo largo de una polilínea en pantalla. */
function walk(pts, cum, d) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const seg = Math.max(1e-9, cum[i] - cum[i - 1]);
  const t = (d - cum[i - 1]) / seg;
  const a = pts[i - 1];
  const b = pts[i];
  return { x: a[0] + t * (b[0] - a[0]), y: a[1] + t * (b[1] - a[1]), ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
}

const r2 = (v) => Math.round(v * 100) / 100;

/**
 * Posiciones de los símbolos a lo largo de una polilínea en pantalla.
 * Repartidos desde media separación del inicio, y sin pisar los extremos.
 */
export function placements(pts, spacingPx, halfWidthPx) {
  if (pts.length < 2 || spacingPx <= 0) return [];
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  const out = [];
  // una línea más corta que un símbolo lleva uno solo, al centro, si cabe
  if (total < spacingPx) {
    if (total >= 2 * halfWidthPx) out.push(walk(pts, cum, total / 2));
    return out;
  }
  for (let d = spacingPx / 2; d <= total - halfWidthPx * 0.6; d += spacingPx) {
    if (d < halfWidthPx * 0.6) continue;
    out.push(walk(pts, cum, d));
  }
  return out;
}

/**
 * SVG de los ornamentos de una línea.
 *
 * @param pts   polilínea en coordenadas de pantalla/papel (la línea BASE, no la ondulada)
 * @param st    estilo: ornament, ornamentSize, ornamentSpacing (mm), ornamentSide,
 *              ornamentGap (mm), ornamentColor, ornamentHalo
 * @param mmToPx conversión de mm a unidades de salida
 * @returns { halo, symbols } cadenas SVG; el halo va POR DEBAJO de la traza y
 *   los símbolos por ENCIMA, igual que en FieldDraw: así ningún blanco cae
 *   sobre la línea.
 */
export function ornamentsSvg(pts, st, mmToPx, strokeColor) {
  const def = ORNAMENTS[st.ornament];
  if (!def || st.ornament === 'none') return { halo: '', symbols: '' };
  const size = Math.min(ORNAMENT_LIMITS.size.max, Math.max(ORNAMENT_LIMITS.size.min, st.ornamentSize || 1));
  const k = U * size * mmToPx; // unidades de diseño -> salida
  const gapDesign = ((st.ornamentGap ?? def.gap ?? 0.8) / U);
  const sym = symbolOf(st.ornament, gapDesign);
  const spacing = (st.ornamentSpacing ?? def.spacing) * mmToPx;
  const pos = placements(pts, spacing, sym.halfWidth * k);
  if (!pos.length) return { halo: '', symbols: '' };
  const flip = def.flippable && st.ornamentSide === 'right' ? -1 : 1;
  const color = st.ornamentColor || strokeColor;

  const fills = [];
  const lines = [];
  const lineW = [];
  for (const p of pos) {
    const c = Math.cos(p.ang);
    const s = Math.sin(p.ang);
    const T = ([x, y]) => {
      const ly = y * flip * k;
      const lx = x * k;
      return [p.x + lx * c - ly * s, p.y + lx * s + ly * c];
    };
    for (const pr of sym.prims) {
      if (pr.poly) fills.push(`M${pr.poly.map((q) => T(q).map(r2).join(' ')).join('L')}Z`);
      else if (pr.circle) {
        const [cx, cy, r] = pr.circle;
        const [X, Y] = T([cx, cy]);
        const R = r * k;
        fills.push(`M${r2(X - R)} ${r2(Y)}a${r2(R)} ${r2(R)} 0 1 0 ${r2(2 * R)} 0a${r2(R)} ${r2(R)} 0 1 0 ${r2(-2 * R)} 0Z`);
      } else if (pr.line) {
        lines.push(`M${pr.line.map((q) => T(q).map(r2).join(' ')).join('L')}`);
        lineW.push(pr.w);
      }
    }
  }
  const lw = (lineW[0] || 1.5) * k;
  const fillD = fills.join('');
  const lineD = lines.join('');
  const extra = HALO_EXTRA * k;
  const symbols =
    `<g fill="${color}" stroke="${color}">` +
    (fillD ? `<path d="${fillD}" stroke="none"/>` : '') +
    (lineD ? `<path d="${lineD}" fill="none" stroke-width="${r2(lw)}" stroke-linecap="butt"/>` : '') +
    '</g>';
  const halo = st.ornamentHalo === false
    ? ''
    : `<g fill="#ffffff" stroke="#ffffff" stroke-linejoin="round" stroke-linecap="round" opacity="${HALO_OPACITY}">` +
      (fillD ? `<path d="${fillD}" stroke-width="${r2(extra)}"/>` : '') +
      (lineD ? `<path d="${lineD}" fill="none" stroke-width="${r2(lw + extra)}"/>` : '') +
      '</g>';
  return { halo, symbols };
}

/** Ajustes por defecto al elegir un tipo de ornamento. */
export function ornamentDefaults(type) {
  const d = ORNAMENTS[type];
  if (!d || type === 'none') return { ornament: 'none' };
  return {
    ornament: type,
    ornamentSize: 1,
    ornamentSpacing: d.spacing,
    ornamentSide: 'left',
    ornamentGap: d.gap ?? 0.8,
    ornamentColor: '',
    ornamentHalo: true,
  };
}
