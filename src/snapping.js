import { nearestOnSegment } from './geom.js';

/**
 * Índice de snapping y grafo de trazado, ambos en coordenadas de PANTALLA.
 *
 * Se reconstruye cuando el mapa se mueve o cambian los datos. A escala de
 * terreno (miles de segmentos en el viewport) proyectar y reindexar cuesta
 * pocos milisegundos, y a cambio las tolerancias quedan expresadas en píxeles
 * — que es como el geólogo las percibe — sin pelear con la latitud.
 */

/** Dos vértices a menos de 0,005 px se consideran el mismo nodo del grafo. */
const KEY_DECIMALS = 2;
const nodeKey = (p) => `${p[0].toFixed(KEY_DECIMALS)},${p[1].toFixed(KEY_DECIMALS)}`;

export class SnapIndex {
  constructor(cellSize = 64) {
    this.cellSize = cellSize;
    this.grid = new Map();
    this.segments = [];
  }

  clear() {
    this.grid.clear();
    this.segments.length = 0;
  }

  get size() {
    return this.segments.length;
  }

  addPolyline(pts, closed = false, meta = null) {
    if (pts.length < 2) return;
    const n = closed ? pts.length : pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      if (a[0] === b[0] && a[1] === b[1]) continue;
      const idx = this.segments.length;
      this.segments.push({ a, b, meta });
      this.#insert(idx, a, b);
    }
  }

  #insert(idx, a, b) {
    const c = this.cellSize;
    const x0 = Math.floor(Math.min(a[0], b[0]) / c);
    const x1 = Math.floor(Math.max(a[0], b[0]) / c);
    const y0 = Math.floor(Math.min(a[1], b[1]) / c);
    const y1 = Math.floor(Math.max(a[1], b[1]) / c);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        let arr = this.grid.get(k);
        if (!arr) {
          arr = [];
          this.grid.set(k, arr);
        }
        arr.push(idx);
      }
    }
  }

  #candidates(p, tol) {
    const c = this.cellSize;
    const x0 = Math.floor((p[0] - tol) / c);
    const x1 = Math.floor((p[0] + tol) / c);
    const y0 = Math.floor((p[1] - tol) / c);
    const y1 = Math.floor((p[1] + tol) / c);
    const seen = new Set();
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const arr = this.grid.get(`${x},${y}`);
        if (arr) for (const i of arr) seen.add(i);
      }
    }
    return seen;
  }

  /**
   * El vértice gana al segmento cuando ambos caen dentro de la tolerancia,
   * igual que en QGIS: si el geólogo apunta cerca de un nodo, quiere el nodo.
   */
  query(p, tol) {
    const tolSq = tol * tol;
    let bestVertex = null;
    let bestSegment = null;

    for (const i of this.#candidates(p, tol)) {
      const s = this.segments[i];
      const da = (p[0] - s.a[0]) ** 2 + (p[1] - s.a[1]) ** 2;
      if (da <= tolSq && (!bestVertex || da < bestVertex.distSq)) {
        bestVertex = { point: s.a.slice(), distSq: da, segment: i, t: 0, meta: s.meta };
      }
      const db = (p[0] - s.b[0]) ** 2 + (p[1] - s.b[1]) ** 2;
      if (db <= tolSq && (!bestVertex || db < bestVertex.distSq)) {
        bestVertex = { point: s.b.slice(), distSq: db, segment: i, t: 1, meta: s.meta };
      }
      const r = nearestOnSegment(p, s.a, s.b);
      if (r.distSq <= tolSq && (!bestSegment || r.distSq < bestSegment.distSq)) {
        bestSegment = { point: r.point, distSq: r.distSq, segment: i, t: r.t, meta: s.meta };
      }
    }

    if (bestVertex) return { ...bestVertex, type: 'vertex' };
    if (bestSegment) return { ...bestSegment, type: 'segment' };
    return null;
  }
}

/* ============================================================ TRAZADO */

/**
 * Grafo no dirigido a partir de los segmentos indexados. Dos features que
 * comparten un vértice quedan conectadas, que es lo que permite trazar a lo
 * largo del borde de un polígono existente o de un contacto ya dibujado.
 *
 * El elemento en construcción queda FUERA: está en el índice para poder
 * engancharse a él, pero si además entrara al grafo, el camino más corto
 * podría devolverse por el propio trazo en vez de seguir el borde que se está
 * trazando — y el trace se salta un tramo o vuelve al punto de partida.
 */
export function buildGraph(index) {
  const nodes = new Map();
  const nodeOf = (p) => {
    const k = nodeKey(p);
    let n = nodes.get(k);
    if (!n) {
      n = { point: p.slice(), edges: [] };
      nodes.set(k, n);
    }
    return { key: k, node: n };
  };
  for (const s of index.segments) {
    if (s.meta && s.meta.draft) continue;
    const A = nodeOf(s.a);
    const B = nodeOf(s.b);
    if (A.key === B.key) continue;
    const w = Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1]);
    A.node.edges.push({ to: B.key, w });
    B.node.edges.push({ to: A.key, w });
  }
  return nodes;
}

class MinHeap {
  constructor() {
    this.items = [];
  }
  get size() {
    return this.items.length;
  }
  push(key, priority) {
    const items = this.items;
    items.push({ key, priority });
    let i = items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (items[p].priority <= items[i].priority) break;
      [items[p], items[i]] = [items[i], items[p]];
      i = p;
    }
  }
  pop() {
    const items = this.items;
    const top = items[0];
    const last = items.pop();
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && items[l].priority < items[m].priority) m = l;
        if (r < items.length && items[r].priority < items[m].priority) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        i = m;
      }
    }
    return top;
  }
}

const EPS = 1e-6;

/**
 * Inserta nodos temporales donde el snap cayó en medio de un segmento, sin
 * tocar el grafo persistente.
 */
function overlayFor(index, snaps) {
  const extra = new Map();
  const extraAdj = new Map();
  const keys = snaps.map((snap, i) => {
    if (!snap) return null;
    const seg = index.segments[snap.segment];
    if (!seg) return null;
    if (snap.t <= EPS) return nodeKey(seg.a);
    if (snap.t >= 1 - EPS) return nodeKey(seg.b);

    const key = `#tmp${i}`;
    const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
    const wa = snap.t * len;
    const wb = (1 - snap.t) * len;
    const ka = nodeKey(seg.a);
    const kb = nodeKey(seg.b);
    extra.set(key, { point: snap.point.slice(), edges: [{ to: ka, w: wa }, { to: kb, w: wb }] });
    for (const [k, w] of [[ka, wa], [kb, wb]]) {
      if (!extraAdj.has(k)) extraAdj.set(k, []);
      extraAdj.get(k).push({ to: key, w });
    }
    return key;
  });

  // Si ambos puntos caen dentro del MISMO segmento hay que unirlos directo:
  // sin esta arista el camino más corto los conectaría rodeando por un
  // extremo, y el trazo saldría con un ida y vuelta absurdo.
  const [sa, sb] = snaps;
  if (
    sa && sb &&
    sa.segment === sb.segment &&
    extra.has(keys[0]) && extra.has(keys[1])
  ) {
    const seg = index.segments[sa.segment];
    const len = Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]);
    const w = Math.abs(sa.t - sb.t) * len;
    extra.get(keys[0]).edges.push({ to: keys[1], w });
    extra.get(keys[1]).edges.push({ to: keys[0], w });
  }

  return { extra, extraAdj, keys };
}

/**
 * Camino más corto sobre el borde de la geometría existente entre dos puntos
 * snapeados — el equivalente de la herramienta Trace de QGIS.
 *
 * @returns {Array<[number,number]>|null} puntos en pantalla, incluidos ambos
 *   extremos, o null si no hay camino (features desconectadas).
 */
export function tracePath(index, graph, snapA, snapB, { maxVisited = 200000 } = {}) {
  if (!snapA || !snapB) return null;
  // Mismo punto: no hay nada que trazar, y sin este corte Dijkstra devolvería
  // un ida y vuelta hasta el extremo más cercano.
  if (Math.hypot(snapA.point[0] - snapB.point[0], snapA.point[1] - snapB.point[1]) < 1e-6) {
    return null;
  }
  const { extra, extraAdj, keys } = overlayFor(index, [snapA, snapB]);
  const [startKey, endKey] = keys;
  if (!startKey || !endKey) return null;
  if (startKey === endKey) return null;

  const pointOf = (k) => {
    const e = extra.get(k);
    if (e) return e.point;
    const n = graph.get(k);
    return n ? n.point : null;
  };
  const edgesOf = (k) => {
    const own = extra.has(k) ? extra.get(k).edges : (graph.get(k)?.edges ?? []);
    const bonus = extraAdj.get(k);
    return bonus ? own.concat(bonus) : own;
  };
  if (!pointOf(startKey) || !pointOf(endKey)) return null;

  const dist = new Map([[startKey, 0]]);
  const prev = new Map();
  const done = new Set();
  const heap = new MinHeap();
  heap.push(startKey, 0);
  let visited = 0;

  while (heap.size > 0) {
    const { key, priority } = heap.pop();
    if (done.has(key)) continue;
    done.add(key);
    if (key === endKey) break;
    if (++visited > maxVisited) return null;

    for (const e of edgesOf(key)) {
      if (done.has(e.to)) continue;
      const nd = priority + e.w;
      if (nd < (dist.get(e.to) ?? Infinity)) {
        dist.set(e.to, nd);
        prev.set(e.to, key);
        heap.push(e.to, nd);
      }
    }
  }

  if (!done.has(endKey)) return null;

  const path = [];
  for (let k = endKey; k !== undefined; k = prev.get(k)) {
    const p = pointOf(k);
    if (p) path.push(p.slice());
    if (k === startKey) break;
  }
  path.reverse();
  return path.length >= 2 ? path : null;
}
