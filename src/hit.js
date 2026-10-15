/**
 * Qué hay bajo el lápiz. Geométrico, no por el DOM: así funciona igual con
 * `pointer-events: none` en las capas, con capas bloqueadas por medio y con el
 * Pencil flotando (hover) antes de tocar.
 *
 * Las distancias van en PÍXELES de pantalla: el umbral es lo que el ojo y la
 * punta perciben, sea cual sea el zoom.
 */

import { allTopShapes } from './doc.js';
import { nearestOnPolyline, pointInRing } from './geom.js';
import { flattenShape, shapeBBox } from './vector.js';
import { measureText } from './labels.js';

const flatCache = new WeakMap(); // shape -> {tol, rings}

export function flatRings(shape, tol) {
  const c = flatCache.get(shape);
  if (c && c.tol <= tol * 2 && c.tol >= tol / 2) return c.rings;
  const rings = flattenShape(shape, tol);
  flatCache.set(shape, { tol, rings });
  return rings;
}

/** Distancia (px) de un punto de pantalla a una forma; 0 si cae dentro de un relleno. */
export function shapeDistance(shape, sp, view, units) {
  const P = (x, y) => view.toScreen(x, y);
  switch (shape.type) {
    case 'point': {
      const [x, y] = P(shape.x, shape.y);
      const r = ((shape.style.pointSize || 2.5) * units.mmToPx) / 2;
      return Math.max(0, Math.hypot(sp[0] - x, sp[1] - y) - r);
    }
    case 'text': {
      const [x, y] = P(shape.x, shape.y);
      const fs = shape.fontSize * units.ptToPx;
      const lines = String(shape.text || '').split('\n');
      const w = Math.max(...lines.map((l) => measureText(l, fs, shape.fontFamily, shape.fontWeight)));
      const h = lines.length * fs * 1.2;
      const x0 = shape.anchor === 'middle' ? x - w / 2 : shape.anchor === 'end' ? x - w : x;
      const dx = Math.max(x0 - sp[0], 0, sp[0] - (x0 + w));
      const dy = Math.max(y - fs - sp[1], 0, sp[1] - (y - fs + h));
      return Math.hypot(dx, dy);
    }
    case 'group': {
      if (shape.clip) {
        const mask = shape.children[0];
        const dm = mask ? shapeDistance({ ...mask, style: { ...mask.style, fill: '#000' } }, sp, view, units) : Infinity;
        return dm;
      }
      return Math.min(...shape.children.map((c) => shapeDistance(c, sp, view, units)));
    }
    default: {
      const rings = flatRings(shape, view.mpp * 0.5);
      let best = Infinity;
      const scr = rings.map((r) => r.pts.map(([x, y]) => P(x, y)));
      for (let i = 0; i < scr.length; i++) {
        const n = nearestOnPolyline(sp, scr[i], false);
        if (n) best = Math.min(best, Math.sqrt(n.distSq));
      }
      const filled = shape.closed && shape.style.fill && shape.style.fill !== 'none' && (shape.style.fillOpacity ?? 1) > 0.02;
      if (filled && scr.length && pointInRing(sp, scr[0]) && !scr.slice(1).some((h) => pointInRing(sp, h))) return 0;
      // grosor visible: tocar el trazo cuenta desde su borde
      const half = ((shape.style.strokeWidth || 0) * units.mmToPx) / 2;
      return Math.max(0, best - half);
    }
  }
}

/** Forma de primer nivel más cercana bajo el punto, priorizando la de más arriba. */
export function pickShape(doc, sp, view, units, tol = 8, { includeLocked = false } = {}) {
  const all = allTopShapes(doc, { unlockedOnly: !includeLocked });
  let best = null;
  for (let i = all.length - 1; i >= 0; i--) {
    const { shape, layer } = all[i];
    const d = shapeDistance(shape, sp, view, units);
    if (d > tol) continue;
    // la de más arriba gana salvo que otra esté claramente más cerca
    if (!best || d < best.d - 3) best = { shape, layer, d };
    if (d === 0 && !best) break;
  }
  return best;
}

/** Formas cuya caja intersecta (o queda contenida en) un rectángulo de mundo. */
export function shapesInBox(doc, box, est, { contain = false } = {}) {
  const out = [];
  for (const { shape } of allTopShapes(doc, { unlockedOnly: true })) {
    const b = shapeBBox(shape, est);
    const hit = contain
      ? b.x >= box.x && b.y >= box.y && b.x + b.w <= box.x + box.w && b.y + b.h <= box.y + box.h
      : b.x <= box.x + box.w && b.x + b.w >= box.x && b.y <= box.y + box.h && b.y + b.h >= box.y;
    if (hit) out.push(shape.id);
  }
  return out;
}

/** Formas con algún vértice dentro de un lazo (anillo en coordenadas de mundo). */
export function shapesInLasso(doc, ring, est) {
  const out = [];
  for (const { shape } of allTopShapes(doc, { unlockedOnly: true })) {
    let pts;
    if (shape.type === 'point' || shape.type === 'text') pts = [[shape.x, shape.y]];
    else if (shape.type === 'group') {
      const b = shapeBBox(shape, est);
      pts = [[b.x + b.w / 2, b.y + b.h / 2]];
    } else pts = flatRings(shape, est.mpp * 2)[0]?.pts || [];
    if (pts.some((p) => pointInRing(p, ring))) out.push(shape.id);
  }
  return out;
}
