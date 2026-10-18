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

  /** Índices de los segmentos cuya celda toca el entorno de `p` (para consultas de afuera, como el nodado). */
  near(p, tol) {
    return this.#candidates(p, tol);
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
 * Grafo no dirigido a partir de los segmentos indexados, ya NODADO como en el
 * Trace de QGIS: dos elementos quedan conectados donde comparten un vértice,
 * donde un vértice de uno cae sobre el segmento del otro (un contacto que
 * termina en el borde de un polígono) y donde sus segmentos se cruzan. Los
 * vértices que distan menos de `tol` se funden en un solo nodo. Sin eso, el
 * camino más corto no puede pasar de un elemento a otro por esos puntos, no
 * recorre los vértices del vecino que caen sobre el borde, y el trazo salta
 * tramos o se va en línea recta.
 *
 * El elemento en construcción queda FUERA: está en el índice para poder
 * engancharse a él, pero si además entrara al grafo, el camino más corto
 * podría devolverse por el propio trazo en vez de seguir el borde que se está
 * trazando — y el trace se salta un tramo o vuelve al punto de partida.
 *
 * @param {SnapIndex} index
 * @param {{tol?: number, maxSegments?: number}} opts `tol` en las unidades del
 *   índice (0 = solo coincidencias exactas); con más de `maxSegments` no se
 *   buscan cruces (cuesta O(n·vecinos)).
 * @returns {Map} nodos { point, edges }, con `splits[i]` = paradas del
 *   segmento i del índice: [{ t, key }] ordenadas por t, de 0 a 1.
 */
export function buildGraph(index, { tol = 0, maxSegments = 60000 } = {}) {
  const tt = tol > 0 ? tol : 1e-6; // tolerancia de coincidencia
  const nodes = new Map();
  const splits = new Array(index.segments.length).fill(null);

  /* ---- 1. nodos: vértices fundidos dentro de la tolerancia */
  const cell = Math.max(tt, 1e-9);
  const cgrid = new Map();
  let nextId = 0;
  const cellOf = (v) => Math.floor(v / cell);
  const addNode = (p, prefix = 'v') => {
    const key = `${prefix}${nextId++}`;
    const n = { point: p.slice(), edges: [] };
    nodes.set(key, n);
    const ck = `${cellOf(p[0])},${cellOf(p[1])}`;
    let arr = cgrid.get(ck);
    if (!arr) cgrid.set(ck, (arr = []));
    arr.push(key);
    return key;
  };
  const findNode = (p) => {
    const cx = cellOf(p[0]);
    const cy = cellOf(p[1]);
    let best = null;
    let bd = tt * tt;
    for (let x = cx - 1; x <= cx + 1; x++) {
      for (let y = cy - 1; y <= cy + 1; y++) {
        for (const k of cgrid.get(`${x},${y}`) || []) {
          const q = nodes.get(k).point;
          const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
          if (d <= bd) {
            bd = d;
            best = k;
          }
        }
      }
    }
    return best;
  };
  const nodeFor = (p) => findNode(p) ?? addNode(p);

  const live = []; // segmentos del grafo (sin los del borrador)
  index.segments.forEach((s, i) => {
    if (s.meta && s.meta.draft) return;
    const ka = nodeFor(s.a);
    const kb = nodeFor(s.b);
    if (ka === kb) return;
    splits[i] = [{ t: 0, key: ka }, { t: 1, key: kb }];
    live.push(i);
  });

  const len = (i) => Math.hypot(index.segments[i].b[0] - index.segments[i].a[0], index.segments[i].b[1] - index.segments[i].a[1]);
  const addStop = (i, t, key) => {
    const arr = splits[i];
    if (arr.some((q) => q.key === key)) return;
    arr.push({ t, key });
  };

  /* ---- 2. vértices que caen sobre el segmento de otro elemento */
  const vertexKeys = [...nodes.keys()];
  for (const k of vertexKeys) {
    const p = nodes.get(k).point;
    for (const i of index.near(p, tt)) {
      const arr = splits[i];
      if (!arr) continue;
      const s = index.segments[i];
      const r = nearestOnSegment(p, s.a, s.b);
      if (r.distSq > tt * tt) continue;
      const L = len(i);
      // los extremos ya están; solo interesa lo que cae en medio
      if (r.t * L <= tt || (1 - r.t) * L <= tt) continue;
      addStop(i, r.t, k);
    }
  }

  /* ---- 3. cruces entre segmentos */
  if (live.length <= maxSegments) {
    const done = new Set();
    for (const i of live) {
      const si = index.segments[i];
      const mid = [(si.a[0] + si.b[0]) / 2, (si.a[1] + si.b[1]) / 2];
      const reach = len(i) / 2 + tt;
      for (const j of index.near(mid, reach)) {
        if (j <= i || !splits[j]) continue;
        const key = i * 4294967296 + j;
        if (done.has(key)) continue;
        done.add(key);
        const sj = index.segments[j];
        const x = segmentCross(si.a, si.b, sj.a, sj.b);
        if (!x) continue;
        const Li = len(i);
        const Lj = len(j);
        // un cruce en un extremo ya lo resolvió el nodado por vértices
        if (x.t * Li <= tt || (1 - x.t) * Li <= tt || x.u * Lj <= tt || (1 - x.u) * Lj <= tt) continue;
        const k = nodeFor(x.point);
        addStop(i, x.t, k);
        addStop(j, x.u, k);
      }
    }
  }

  /* ---- 4. aristas entre paradas consecutivas */
  const seen = new Map();
  for (const i of live) {
    const arr = splits[i].sort((p, q) => p.t - q.t);
    for (let m = 0; m + 1 < arr.length; m++) {
      const ka = arr[m].key;
      const kb = arr[m + 1].key;
      if (ka === kb) continue;
      const pa = nodes.get(ka).point;
      const pb = nodes.get(kb).point;
      const w = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      const ek = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      if (seen.has(ek)) continue; // trazos superpuestos: una sola arista
      seen.set(ek, true);
      nodes.get(ka).edges.push({ to: kb, w });
      nodes.get(kb).edges.push({ to: ka, w });
    }
  }
  nodes.splits = splits;
  return nodes;
}

/** Cruce propio de dos segmentos: { point, t, u } con t, u en (0, 1), o null (paralelos o sin cruce). */
function segmentCross(a, b, c, d) {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12 * (Math.hypot(rx, ry) * Math.hypot(sx, sy) || 1)) return null;
  const qx = c[0] - a[0];
  const qy = c[1] - a[1];
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return { point: [a[0] + t * rx, a[1] + t * ry], t, u };
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
 * Inserta nodos temporales donde el snap cayó en medio de una arista del
 * grafo (el tramo entre dos paradas consecutivas de su segmento), sin tocar
 * el grafo persistente.
 */
function overlayFor(index, graph, snaps) {
  const extra = new Map();
  const extraAdj = new Map();
  const temps = []; // nodos temporales, con el tramo del grafo en que caen
  const keys = snaps.map((snap, i) => {
    if (!snap) return null;
    const seg = index.segments[snap.segment];
    const stops = graph.splits?.[snap.segment];
    if (!seg || !stops) return null;
    // el tramo [stops[j], stops[j+1]] que contiene a t
    let j = 0;
    while (j + 2 < stops.length && stops[j + 1].t <= snap.t) j++;
    const A = stops[j];
    const B = stops[j + 1];
    if (Math.abs(snap.t - A.t) <= EPS) return A.key;
    if (Math.abs(B.t - snap.t) <= EPS) return B.key;
    const key = `#tmp${i}`;
    extra.set(key, { point: snap.point.slice(), edges: [] });
    temps.push({ key, ka: A.key, kb: B.key, ta: A.t, tb: B.t, t: snap.t, len: Math.hypot(seg.b[0] - seg.a[0], seg.b[1] - seg.a[1]) });
    return key;
  });

  // Cada tramo se parte por los puntos que caen en él, EN ORDEN: A — p1 — p2 — B. Sin eso, dos puntos del
  // mismo tramo se conectarían cada uno con los dos extremos y el camino pasaría por encima del otro punto
  // (saldría un ida y vuelta absurdo hasta la esquina).
  const link = (k1, k2, w) => {
    const link1 = (from, to) => {
      if (extra.has(from)) extra.get(from).edges.push({ to, w });
      else {
        if (!extraAdj.has(from)) extraAdj.set(from, []);
        extraAdj.get(from).push({ to, w });
      }
    };
    link1(k1, k2);
    link1(k2, k1);
  };
  const cut = new Set(); // aristas del grafo que los puntos temporales parten (ya no se pueden recorrer enteras)
  const groups = new Map();
  for (const t of temps) {
    const g = `${t.ka}|${t.kb}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(t);
  }
  for (const list of groups.values()) {
    list.sort((p, q) => p.t - q.t);
    const { ka, kb, ta, tb, len } = list[0];
    cut.add(ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`);
    let prevKey = ka;
    let prevT = ta;
    for (const t of list) {
      link(prevKey, t.key, (t.t - prevT) * len);
      prevKey = t.key;
      prevT = t.t;
    }
    link(prevKey, kb, (tb - prevT) * len);
  }

  return { extra, extraAdj, keys, cut };
}

/**
 * Camino más corto sobre el borde de la geometría existente entre dos puntos
 * snapeados — el equivalente de la herramienta Trace de QGIS.
 *
 * Con `alt` devuelve el recorrido alterno: el más corto que no pasa por los
 * vértices intermedios del principal (por el otro lado de un polígono, por
 * ejemplo); si no hay otro, el mismo.
 *
 * @returns {Array<[number,number]>|null} puntos en pantalla, incluidos ambos
 *   extremos, o null si no hay camino (features desconectadas).
 */
export function tracePath(index, graph, snapA, snapB, { maxVisited = 200000, alt = false } = {}) {
  if (!snapA || !snapB) return null;
  // Mismo punto: no hay nada que trazar, y sin este corte Dijkstra devolvería
  // un ida y vuelta hasta el extremo más cercano.
  if (Math.hypot(snapA.point[0] - snapB.point[0], snapA.point[1] - snapB.point[1]) < 1e-6) {
    return null;
  }
  const { extra, extraAdj, keys, cut } = overlayFor(index, graph, [snapA, snapB]);
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
    let own = extra.has(k) ? extra.get(k).edges : (graph.get(k)?.edges ?? []);
    if (cut.size && !extra.has(k)) own = own.filter((e) => !cut.has(k < e.to ? `${k}|${e.to}` : `${e.to}|${k}`));
    const bonus = extraAdj.get(k);
    return bonus ? own.concat(bonus) : own;
  };
  if (!pointOf(startKey) || !pointOf(endKey)) return null;

  const search = (blocked, blockedNodes) => {
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
        if (done.has(e.to) || blockedNodes?.has(e.to)) continue;
        if (blocked && blocked.has(key < e.to ? `${key}|${e.to}` : `${e.to}|${key}`)) continue;
        const nd = priority + e.w;
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, key);
          heap.push(e.to, nd);
        }
      }
    }
    if (!done.has(endKey)) return null;
    const out = [];
    for (let k = endKey; k !== undefined; k = prev.get(k)) {
      out.push(k);
      if (k === startKey) break;
    }
    return out.reverse();
  };

  let route = search(null);
  if (!route) return null;
  if (alt) {
    const blocked = new Set();
    for (let i = 0; i + 1 < route.length; i++) blocked.add(route[i] < route[i + 1] ? `${route[i]}|${route[i + 1]}` : `${route[i + 1]}|${route[i]}`);
    // sin pasar de nuevo por los vértices del principal (si no, «el otro camino» daría media vuelta sobre el mismo borde)
    route = search(blocked, new Set(route.slice(1, -1))) || route;
  }
  const path = route.map(pointOf).filter(Boolean).map((p) => p.slice());
  return path.length >= 2 ? path : null;
}
