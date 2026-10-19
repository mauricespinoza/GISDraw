/**
 * Herramienta Suavizar (pincel), como la de Illustrator: se pasa sobre un
 * trazo y solo el SECTOR bajo el pincel se suaviza —se promedian los quiebres,
 * se simplifica y se rehace con curvas—; el resto del trazo queda intacto.
 * Pasar varias veces suaviza más.
 */

import { curveThrough, flattenNodes, relaxPoints, simplify } from './vector.js';

/** Puntos {x, y} de los nodos con las curvas aplanadas (las utilidades de vector.js trabajan con {x, y}). */
const flatPts = (nodes, closed, tol) => flattenNodes(nodes, closed, tol).map(([x, y]) => ({ x, y }));

/** Puntos a intervalos regulares `step` a lo largo de la polilínea (el último punto original se conserva en un trazo abierto). */
function resample(pts, step, closed) {
  const ring = closed ? [...pts, pts[0]] : pts;
  const out = [{ x: ring[0].x, y: ring[0].y }];
  let carry = 0; // lo recorrido desde el último punto puesto
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i];
    const b = ring[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    let at = step - carry;
    while (at <= len) {
      out.push({ x: a.x + ((b.x - a.x) * at) / len, y: a.y + ((b.y - a.y) * at) / len });
      at += step;
    }
    carry = len - (at - step);
  }
  const last = ring[ring.length - 1];
  if (closed) {
    if (out.length > 1 && Math.hypot(out[out.length - 1].x - out[0].x, out[out.length - 1].y - out[0].y) < step * 0.5) out.pop();
  } else out.push({ x: last.x, y: last.y });
  return out;
}

/**
 * Suavizado con peso: los puntos se vuelven a muestrear a intervalos
 * regulares (el promedio actúa sobre una distancia, no sobre una cantidad de
 * puntos) y cada uno se acerca a su versión promediada en proporción a qué tan
 * dentro del pincel está (1 hasta la mitad del radio, 0 a `radius`). La escala del
 * promedio sale de la intensidad: de ~35 % a ~85 % del radio.
 */
function blend(pts, brush, radius, level, closed) {
  const t = Math.max(0, Math.min(100, Number(level) || 0)) / 100;
  const step = radius / 6;
  const sigma = radius * (0.35 + 0.5 * t);
  const passes = Math.max(1, Math.round(2 * (sigma / step) ** 2));
  const even = resample(pts, step, closed);
  const soft = relaxPoints(even, passes, closed);
  return even.map((p, i) => {
    const d = distToBrush([p.x, p.y], brush) / radius;
    if (d >= 1) return p;
    const u = Math.min(1, (1 - d) / 0.5); // peso pleno hasta la mitad del radio, y de ahí cae a 0
    const w = u * u * (3 - 2 * u);
    return { x: p.x + w * (soft[i].x - p.x), y: p.y + w * (soft[i].y - p.y) };
  });
}

/** Distancia de un punto a una polilínea de pincel [[x, y], …]. */
function distToBrush(p, brush) {
  if (brush.length === 1) return Math.hypot(p[0] - brush[0][0], p[1] - brush[0][1]);
  let best = Infinity;
  for (let i = 0; i + 1 < brush.length; i++) {
    const a = brush[i];
    const b = brush[i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy)));
  }
  return best;
}

/**
 * Parámetros de un nivel de intensidad (1–100 %): pasadas de promedio, tolerancia de
 * simplificación en px y tensión de las manijas. Es una pasada suave: la
 * intensidad se acumula pasando el pincel de nuevo.
 */
export function smoothParams(level) {
  const t = Math.max(0, Math.min(100, Number(level) || 0)) / 100;
  return { passes: 1 + Math.round(t * 3), tolPx: 0.3 + t * 2.5, tension: 0.2 + t * 0.25 };
}

/**
 * Suaviza los tramos de un anillo de nodos que toca el pincel.
 * @param {object[]} nodes nodos {x, y, hIn, hOut, smooth}
 * @param {boolean} closed
 * @param {number[][]} brush puntos recientes del pincel (mundo)
 * @param {{radius: number, tol: number, level: number, flat?: number}} o `radius` y `tol` en metros
 * @returns {object[]|null} nodos nuevos, o null si el pincel no tocó nada
 */
export function smoothAlong(nodes, closed, brush, { radius, tol, level, flat = tol }) {
  const n = nodes.length;
  if (n < 3 || !brush.length) return null;
  const segs = closed ? n : n - 1;
  // tramos (entre nodo i e i+1) que pasan bajo el pincel
  const hit = new Array(segs).fill(false);
  for (let i = 0; i < segs; i++) {
    const pts = flatPts([nodes[i], nodes[(i + 1) % n]], false, flat);
    hit[i] = pts.some((p) => distToBrush([p.x, p.y], brush) <= radius);
  }
  if (!hit.some(Boolean)) return null;
  const { tension } = smoothParams(level);

  // anillo cerrado tocado por todas partes: se suaviza entero
  if (closed && hit.every(Boolean)) {
    const pts = flatPts(nodes, true, flat);
    pts.pop(); // cierre duplicado
    const out = curveThrough(simplify(blend(pts, brush, radius, level, true), tol), tension, true);
    return out.length >= 3 ? out : null;
  }

  // corridas de tramos seguidos (en un anillo, la que cruza el nodo 0 se junta con la del final)
  const runs = [];
  let i = 0;
  const start = closed ? hit.findIndex((h, k) => h && !hit[(k - 1 + segs) % segs]) : 0;
  const order = closed ? Array.from({ length: segs }, (_, k) => (start + k) % segs) : Array.from({ length: segs }, (_, k) => k);
  while (i < order.length) {
    if (!hit[order[i]]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < order.length && hit[order[j + 1]]) j++;
    runs.push({ a: order[i], b: (order[j] + 1) % n, len: j - i + 1 });
    i = j + 1;
  }

  // rehace cada corrida: puntos aplanados → promedio con peso (pleno bajo el pincel, nulo a su radio) →
  // simplificación → curvas. La corrida se alarga un tramo a cada lado para que el suavizado muera sin
  // dejar escalón en el borde del sector (el nodo del extremo, con peso 0, queda donde estaba).
  const replace = new Map(); // índice del nodo inicial → { len: tramos que cubre, made: nodos nuevos }
  for (const r of runs) {
    let a = r.a;
    let len = r.len;
    if (closed || a > 0) {
      a = (a - 1 + n) % n;
      len++;
    }
    if (closed || r.a + r.len < n - 1) len++;
    if (closed && len >= n) continue; // (esto lo cubre el caso del anillo entero)
    const sub = [];
    for (let k = 0; k <= len; k++) sub.push(nodes[(a + k) % n]);
    const pts = flatPts(sub, false, flat);
    const made = curveThrough(simplify(blend(pts, brush, radius, level, false), tol), tension, false);
    if (made.length < 2) continue;
    made[0] = { ...made[0], hIn: sub[0].hIn ? { ...sub[0].hIn } : null };
    made[made.length - 1] = { ...made[made.length - 1], hOut: sub[sub.length - 1].hOut ? { ...sub[sub.length - 1].hOut } : null };
    replace.set(a, { len, made });
  }
  if (!replace.size) return null;

  // se arma el resultado recorriendo los nodos: cada corrida entra donde empezaba y sus nodos viejos se saltan
  const out = [];
  const skip = new Set();
  for (const [a, { len }] of replace) for (let k = 1; k <= len; k++) skip.add((a + k) % n);
  for (let k = 0; k < n; k++) {
    if (replace.has(k)) {
      out.push(...replace.get(k).made);
    } else if (!skip.has(k)) out.push(nodes[k]);
  }
  return out.length >= 2 ? out : null;
}
