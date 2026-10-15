/**
 * Etiquetado de capas por atributos.
 *
 * Qué texto: un campo, o una plantilla con varios — "{codigo} ({edad} Ma)".
 * Dónde:
 *  - puntos y textos: a la derecha y arriba del símbolo, a `offset` mm;
 *  - líneas: CURVADA a lo largo del trazo, centrada en el tramo más largo y
 *    siempre legible de izquierda a derecha (si la línea va hacia el oeste se
 *    recorre al revés); o paralela y recta si se pide "horizontal";
 *  - polígonos: en el polo de inaccesibilidad (el punto interior más alejado
 *    del borde), que es donde un cartógrafo pone el rótulo de una unidad y que,
 *    a diferencia del centroide, cae siempre dentro aunque la forma sea una C.
 *
 * Las colisiones se resuelven con prioridad por orden de capa (arriba gana) y,
 * dentro de la capa, por tamaño del elemento: una etiqueta que pisaría a otra
 * ya puesta no se dibuja. Es lo mismo que hace QGIS con su motor PAL, en
 * versión greedy.
 */

import { esc } from './style.js';
import { flattenShape, polylineLength } from './vector.js';

/* --------------------------------------------------------- texto de la etiqueta */

export function labelText(shape, cfg) {
  const attrs = shape.attrs || {};
  let t;
  if (cfg.template && cfg.template.trim()) {
    t = cfg.template.replace(/\{([^}]+)\}/g, (_, k) => {
      const key = k.trim();
      if (key === '$nombre') return shape.name ?? '';
      if (key === '$area_ha') return attrs.__area_ha ?? '';
      const v = attrs[key];
      return v == null ? '' : String(v);
    });
  } else if (cfg.field) {
    t = cfg.field === '$nombre' ? shape.name : attrs[cfg.field];
  }
  if (t == null) return '';
  t = String(t).trim();
  return cfg.upper ? t.toUpperCase() : t;
}

/* ------------------------------------------------------------- polylabel */

function pointToRingsDist(x, y, rings) {
  let inside = false;
  let minSq = Infinity;
  for (const ring of rings) {
    for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
      const a = ring[i];
      const b = ring[j];
      if (a[1] > y !== b[1] > y && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
      let px = b[0];
      let py = b[1];
      let dx = a[0] - px;
      let dy = a[1] - py;
      if (dx !== 0 || dy !== 0) {
        const t = ((x - px) * dx + (y - py) * dy) / (dx * dx + dy * dy);
        if (t > 1) {
          px = a[0];
          py = a[1];
        } else if (t > 0) {
          px += dx * t;
          py += dy * t;
        }
      }
      dx = x - px;
      dy = y - py;
      minSq = Math.min(minSq, dx * dx + dy * dy);
    }
  }
  return (inside ? 1 : -1) * Math.sqrt(minSq);
}

/** Polo de inaccesibilidad (algoritmo de Mapbox `polylabel`). */
export function polylabel(rings, precision = 1) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of rings[0]) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const cellSize = Math.min(width, height);
  if (cellSize === 0) return { x: minX, y: minY, d: 0 };
  let h = cellSize / 2;
  const cell = (x, y, hh) => {
    const d = pointToRingsDist(x, y, rings);
    return { x, y, h: hh, d, max: d + hh * Math.SQRT2 };
  };
  const queue = [];
  for (let x = minX; x < maxX; x += cellSize) for (let y = minY; y < maxY; y += cellSize) queue.push(cell(x + h, y + h, h));
  // centroide como primera apuesta
  let A = 0;
  let cx = 0;
  let cy = 0;
  const ring = rings[0];
  for (let i = 0, len = ring.length, j = len - 1; i < len; j = i++) {
    const a = ring[i];
    const b = ring[j];
    const f = a[0] * b[1] - b[0] * a[1];
    cx += (a[0] + b[0]) * f;
    cy += (a[1] + b[1]) * f;
    A += f * 3;
  }
  let best = A ? cell(cx / A, cy / A, 0) : cell(minX + width / 2, minY + height / 2, 0);
  const bboxCell = cell(minX + width / 2, minY + height / 2, 0);
  if (bboxCell.d > best.d) best = bboxCell;
  let guard = 0;
  while (queue.length && guard++ < 5000) {
    queue.sort((a, b) => a.max - b.max);
    const c = queue.pop();
    if (c.d > best.d) best = c;
    if (c.max - best.d <= precision) continue;
    h = c.h / 2;
    queue.push(cell(c.x - h, c.y - h, h), cell(c.x + h, c.y - h, h), cell(c.x - h, c.y + h, h), cell(c.x + h, c.y + h, h));
  }
  return { x: best.x, y: best.y, d: best.d };
}

/* --------------------------------------------------------------- colisiones */

class Occupancy {
  constructor() {
    this.boxes = [];
  }
  hits(b) {
    return this.boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
  }
  add(b) {
    this.boxes.push(b);
  }
}

/* ---------------------------------------------------------- medida de texto */

let measureCtx = null;
export function measureText(text, fontPx, family, weight = 400, italic = false) {
  try {
    if (!measureCtx && typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
    if (!measureCtx && typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d');
  } catch {
    measureCtx = null;
  }
  if (!measureCtx) return text.length * fontPx * 0.56;
  measureCtx.font = `${italic ? 'italic ' : ''}${weight} ${fontPx}px ${family}`;
  return measureCtx.measureText(text).width;
}

/* ------------------------------------------------------------- render */

const r2 = (v) => Math.round(v * 100) / 100;

/** Tramo más recto y largo de la polilínea donde cabe `need` px. */
function bestStretch(pts, need) {
  // ventana deslizante sobre la longitud acumulada; puntúa por rectitud
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  if (total < need * 1.05) return null;
  let best = null;
  const step = Math.max(need / 4, total / 40);
  for (let s = 0; s + need <= total; s += step) {
    const a = pointAt(pts, cum, s);
    const b = pointAt(pts, cum, s + need);
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const straight = chord / need; // 1 = recto
    const centrality = 1 - Math.abs(s + need / 2 - total / 2) / total;
    const score = straight * 2 + centrality;
    if (!best || score > best.score) best = { start: s, end: s + need, score, straight };
  }
  return best && best.straight > 0.6 ? best : null;
}

function pointAt(pts, cum, d) {
  let i = 1;
  while (i < cum.length - 1 && cum[i] < d) i++;
  const t = (d - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1]);
  return [pts[i - 1][0] + t * (pts[i][0] - pts[i - 1][0]), pts[i - 1][1] + t * (pts[i][1] - pts[i - 1][1])];
}

function slicePolyline(pts, from, to) {
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const out = [pointAt(pts, cum, from)];
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > from && cum[i] < to) out.push(pts[i]);
  out.push(pointAt(pts, cum, to));
  return out;
}

/**
 * SVG de las etiquetas de todas las capas visibles.
 * @param layers capas vectoriales en orden de pintado (abajo→arriba)
 * @param ctx { P, mmToPx, ptToPx, viewW, viewH, scale, uid }
 */
export function renderLabels(layers, ctx) {
  const occ = new Occupancy();
  const out = [];
  const defs = [];
  let n = 0;
  // arriba gana: se recorren de la capa superior a la inferior
  for (let li = layers.length - 1; li >= 0; li--) {
    const layer = layers[li];
    const cfg = layer.labels;
    if (!layer.visible || !cfg?.enabled || (!cfg.field && !cfg.template)) continue;
    if (cfg.minScale && ctx.scale > cfg.minScale) continue;
    const fs = cfg.fontSize * ctx.ptToPx;
    // en pantalla, menos de 3 px no se lee; en el layout las unidades son mm
    if (fs < (ctx.minFont ?? 3)) continue;
    const haloW = cfg.halo ? 2 * cfg.haloWidth * ctx.mmToPx : 0;
    const paint = `font-family="${esc(cfg.fontFamily)}" font-size="${r2(fs)}" font-weight="${cfg.fontWeight}"${
      cfg.italic ? ' font-style="italic"' : ''
    } fill="${esc(cfg.color)}"${
      cfg.halo ? ` stroke="${esc(cfg.haloColor)}" stroke-width="${r2(haloW)}" stroke-linejoin="round" paint-order="stroke fill"` : ''
    }`;

    // candidatos con prioridad: los elementos grandes primero
    const cands = [];
    for (const s of layer.items) {
      if (s.visible === false) continue;
      const text = labelText(s, cfg);
      if (!text) continue;
      cands.push({ s, text });
    }

    for (const { s, text } of cands) {
      const tw = measureText(text, fs, cfg.fontFamily, cfg.fontWeight, cfg.italic);
      const th = fs * 1.15;
      const pad = haloW / 2 + 1;

      if (s.type === 'point' || s.type === 'text') {
        const [x, y] = ctx.P(s.x, s.y);
        const off = cfg.offset * ctx.mmToPx + (s.type === 'point' ? ((s.style.pointSize || 2.5) * ctx.mmToPx) / 2 : 0);
        const tx = x + off;
        const ty = y - off * 0.4;
        const box = { x0: tx - pad, y0: ty - th + fs * 0.2 - pad, x1: tx + tw + pad, y1: ty + fs * 0.25 + pad };
        if (offscreen(box, ctx)) continue;
        if (cfg.avoidOverlap && occ.hits(box)) continue;
        occ.add(box);
        out.push(bg(cfg, box) + `<text x="${r2(tx)}" y="${r2(ty)}" ${paint}>${esc(text)}</text>`);
        continue;
      }

      if (s.type !== 'path') continue;
      const rings = flattenShape(s, ctx.mpp * 0.5).map((r) => ({ ...r, scr: r.pts.map(([x, y]) => ctx.P(x, y)) }));
      if (!rings.length || rings[0].scr.length < 2) continue;

      if (s.closed && cfg.placement !== 'curved') {
        const scrRings = rings.map((r) => r.scr);
        const pl = polylabel(scrRings, 1.5);
        if (pl.d < Math.min(tw, th) * 0.2 && cfg.avoidOverlap) continue; // polígono muy chico a esta escala
        const box = { x0: pl.x - tw / 2 - pad, y0: pl.y - th / 2 - pad, x1: pl.x + tw / 2 + pad, y1: pl.y + th / 2 + pad };
        if (offscreen(box, ctx)) continue;
        if (cfg.avoidOverlap && occ.hits(box)) continue;
        occ.add(box);
        out.push(bg(cfg, box) + `<text x="${r2(pl.x)}" y="${r2(pl.y + fs * 0.35)}" text-anchor="middle" ${paint}>${esc(text)}</text>`);
        continue;
      }

      // líneas (o contorno de polígono con placement curvo)
      let pts = rings[0].scr;
      const total = polylineLength(pts);
      const need = tw + fs * 0.6;
      const reps = cfg.repeat > 0 ? Math.max(1, Math.floor(total / (cfg.repeat * ctx.mmToPx + need))) : 1;
      const stretches = [];
      if (reps === 1) {
        const st = bestStretch(pts, need);
        if (st) stretches.push(st);
      } else {
        const seg = total / reps;
        for (let k = 0; k < reps; k++) {
          const sub = slicePolyline(pts, k * seg, (k + 1) * seg);
          const st = bestStretch(sub, need);
          if (st) stretches.push({ ...st, sub });
        }
      }
      for (const st of stretches) {
        let piece = slicePolyline(st.sub || pts, st.start, st.end);
        // legible: de izquierda a derecha
        if (piece[piece.length - 1][0] < piece[0][0]) piece = piece.slice().reverse();
        const xs = piece.map((p) => p[0]);
        const ys = piece.map((p) => p[1]);
        const box = {
          x0: Math.min(...xs) - fs * 0.6,
          y0: Math.min(...ys) - fs * 0.9 - pad,
          x1: Math.max(...xs) + fs * 0.6,
          y1: Math.max(...ys) + fs * 0.4 + pad,
        };
        if (offscreen(box, ctx)) continue;
        if (cfg.avoidOverlap && occ.hits(box)) continue;
        occ.add(box);
        if (cfg.placement === 'horizontal') {
          const mid = piece[Math.floor(piece.length / 2)];
          out.push(`<text x="${r2(mid[0])}" y="${r2(mid[1] - cfg.offset * ctx.mmToPx)}" text-anchor="middle" ${paint}>${esc(text)}</text>`);
          continue;
        }
        const pid = `${ctx.uid}lp${n++}`;
        // desplazada sobre la línea (offset) para no tapar el trazo
        const dy = -(cfg.offset * ctx.mmToPx);
        defs.push(`<path id="${pid}" d="M${piece.map((p) => `${r2(p[0])} ${r2(p[1])}`).join('L')}"/>`);
        out.push(
          `<text ${paint} dy="${r2(dy)}"><textPath href="#${pid}" startOffset="50%" text-anchor="middle">${esc(text)}</textPath></text>`,
        );
      }
    }
  }
  return `<defs>${defs.join('')}</defs>${out.join('')}`;
}

function offscreen(b, ctx) {
  return b.x1 < 0 || b.y1 < 0 || b.x0 > ctx.viewW || b.y0 > ctx.viewH;
}

function bg(cfg, box) {
  if (!cfg.background) return '';
  return `<rect x="${r2(box.x0)}" y="${r2(box.y0)}" width="${r2(box.x1 - box.x0)}" height="${r2(box.y1 - box.y0)}" rx="2" fill="${esc(
    cfg.backgroundColor,
  )}" fill-opacity="0.85"/>`;
}
