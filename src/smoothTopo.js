/**
 * Suavizado que respeta la topología: líneas y polígonos que comparten nodos
 * (borde común de dos polígonos, una línea que termina en el vértice de otra…)
 * se suavizan juntos, de modo que el borde compartido queda IDÉNTICO en todos
 * los que lo comparten y no se abren huecos ni solapes.
 *
 * Se hace como TopoJSON: los anillos se parten en ARCOS entre nodos de unión
 * (donde cambia quién comparte el nodo, o el extremo de una línea). Cada arco
 * único se suaviza UNA vez, con sus extremos fijos, y todos los anillos que lo
 * usan lo reciben tal cual (invertido si lo recorren al revés). Los nodos de
 * unión no se mueven. Un arco compartido con una forma bloqueada se deja
 * como está. Las formas vecinas no seleccionadas que comparten un arco
 * suavizado se actualizan también: eso es lo que mantiene el cierre.
 *
 * Funciones puras doc -> doc, sin DOM.
 */

import { allTopShapes, replaceShapes } from './doc.js';
import { curveThrough, densifyForSmoothing, flattenNodes, freehandParams, relaxPoints, simplify } from './vector.js';

const swapHandles = (n) => ({ ...n, hIn: n.hOut ? { ...n.hOut } : null, hOut: n.hIn ? { ...n.hIn } : null });
const orient = (nodes, rev) => (rev ? nodes.slice().reverse().map(swapHandles) : nodes);

/** Agrupa los nodos que caen a menos de `tol` entre sí (misma lógica que «Move Joined»). */
function cluster(rings, tol) {
  const cell = Math.max(tol, 1e-6);
  const grid = new Map();
  const cl = []; // { x, y, sx, sy, n }
  const key = (cx, cy) => `${cx},${cy}`;
  for (const r of rings) {
    r.cid = r.nodes.map((nd) => {
      const cx = Math.floor(nd.x / cell);
      const cy = Math.floor(nd.y / cell);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const id of grid.get(key(cx + dx, cy + dy)) || []) {
            const c = cl[id];
            if (Math.hypot(c.x - nd.x, c.y - nd.y) <= tol) {
              c.sx += nd.x;
              c.sy += nd.y;
              c.n++;
              return id;
            }
          }
        }
      }
      const id = cl.length;
      cl.push({ x: nd.x, y: nd.y, sx: nd.x, sy: nd.y, n: 1 });
      const k = key(cx, cy);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(id);
      return id;
    });
  }
  return cl.map((c) => ({ x: c.sx / c.n, y: c.sy / c.n }));
}

/**
 * Analiza la topología del documento: anillos, nodos compartidos y arcos.
 * `ids`: formas que se van a suavizar. `tol`: distancia (m) bajo la cual dos nodos son el mismo.
 */
export function buildTopology(doc, ids, tol) {
  const sel = ids instanceof Set ? ids : new Set(ids);
  const rings = [];
  for (const { layer, shape } of allTopShapes(doc, { visibleOnly: false })) {
    if (shape.type !== 'path' || !shape.nodes?.length) continue;
    const frozen = !!(shape.locked || layer.locked);
    const add = (ring, nodes, closed) => {
      if (nodes.length >= 2) rings.push({ shape, ring, nodes, closed: closed && nodes.length >= 3, selected: sel.has(shape.id) && !frozen, frozen, cid: [] });
    };
    add(-1, shape.nodes, !!shape.closed);
    (shape.holes || []).forEach((h, i) => add(i, h, true));
  }
  const centroid = cluster(rings, tol);

  // quién usa cada nodo y con qué vecinos
  const occ = centroid.map(() => []);
  rings.forEach((r, ri) => {
    const n = r.nodes.length;
    r.cid.forEach((c, i) => {
      const p = r.closed ? r.cid[(i - 1 + n) % n] : i > 0 ? r.cid[i - 1] : -1;
      const q = r.closed ? r.cid[(i + 1) % n] : i < n - 1 ? r.cid[i + 1] : -1;
      occ[c].push({ ri, i, nb: p < q ? `${p}|${q}` : `${q}|${p}` });
    });
  });
  // nodo de unión: lo usan varios y no todos con los mismos vecinos
  const junction = new Set();
  let sharesNodes = false;
  occ.forEach((list, c) => {
    if (list.length < 2) return;
    if (list.some((o) => rings[o.ri].selected) && new Set(list.map((o) => o.ri)).size > 1) sharesNodes = true;
    if (new Set(list.map((o) => o.nb)).size > 1) junction.add(c);
  });
  // un nodo congelado (Freeze node) también corta el arco: queda como extremo fijo
  const frozenC = new Set();
  rings.forEach((r) =>
    r.nodes.forEach((nd, i) => {
      if (!nd.frozen) return;
      frozenC.add(r.cid[i]);
      centroid[r.cid[i]] = { x: nd.x, y: nd.y };
    }),
  );
  for (const c of frozenC) junction.add(c);

  // arcos únicos
  const arcs = new Map();
  const pieces = rings.map(() => []);
  rings.forEach((r, ri) => {
    const n = r.nodes.length;
    const spans = [];
    if (!r.closed) {
      let start = 0;
      for (let i = 1; i < n; i++) {
        if (i === n - 1 || junction.has(r.cid[i])) {
          spans.push({ from: start, to: i });
          start = i;
        }
      }
    } else {
      const J = r.cid.map((c, i) => (junction.has(c) ? i : -1)).filter((i) => i >= 0);
      if (!J.length) spans.push({ from: 0, to: n, whole: true });
      else J.forEach((from, k) => spans.push({ from, to: J.length === 1 ? from + n : J[(k + 1) % J.length] + (k + 1 < J.length ? 0 : n) }));
    }
    for (const sp of spans) {
      const idx = [];
      if (sp.whole) {
        const seq = r.cid.slice();
        const m = seq.indexOf(Math.min(...seq));
        const fwd = Array.from({ length: n }, (_, k) => (m + k) % n);
        const bwd = Array.from({ length: n }, (_, k) => (m - k + n) % n);
        const f = fwd.map((i) => seq[i]).join();
        const b = bwd.map((i) => seq[i]).join();
        sp.reversed = b < f;
        idx.push(...(sp.reversed ? bwd : fwd));
        sp.key = `c:${sp.reversed ? b : f}`;
      } else {
        for (let i = sp.from; i <= sp.to; i++) idx.push(i % n);
        const f = idx.map((i) => r.cid[i]).join();
        const b = idx.map((i) => r.cid[i]).reverse().join();
        sp.reversed = b < f;
        sp.key = `o:${sp.reversed ? b : f}`;
      }
      sp.idx = idx; // índices de nodo del anillo, en el orden del anillo (open) o ya canónico (whole)
      let arc = arcs.get(sp.key);
      if (!arc) {
        const raw = idx.map((i) => r.nodes[i]);
        // nodos del arco en orientación canónica
        // (en un anillo entero los índices ya vienen en orden canónico: solo hay que cambiar las manijas)
        const nodes = sp.whole && !sp.reversed ? raw : sp.whole ? raw.map(swapHandles) : orient(raw, sp.reversed);
        arc = { key: sp.key, closed: !!sp.whole, nodes, members: [], selected: false, frozen: false, ends: sp.whole ? null : [r.cid[idx[sp.reversed ? idx.length - 1 : 0]], r.cid[idx[sp.reversed ? 0 : idx.length - 1]]] };
        arcs.set(sp.key, arc);
      }
      arc.members.push(ri);
      if (r.selected) arc.selected = true;
      if (r.frozen) arc.frozen = true;
      pieces[ri].push(sp);
    }
  });
  return { rings, centroid, arcs, pieces, sharesNodes, frozenC };
}

/**
 * Aplica `fn(nodos, cerrado) → nodos | null` a cada arco único con selección
 * (y sin formas bloqueadas) y reconstruye los anillos que lo usan. Devuelve el
 * mismo `doc` si ningún arco cambió.
 */
export function smoothTopology(topo, doc, fn) {
  const { rings, centroid, arcs, pieces, frozenC = new Set() } = topo;
  const done = new Map(); // key → nodos nuevos
  for (const arc of arcs.values()) {
    if (!arc.selected || arc.frozen) continue;
    const made = fn(arc.nodes, arc.closed);
    if (!made || made.length < (arc.closed ? 3 : 2)) continue;
    if (!arc.closed) {
      const [a, b] = arc.ends;
      made[0] = { ...made[0], x: centroid[a].x, y: centroid[a].y, ...(frozenC.has(a) ? { frozen: true } : {}) };
      made[made.length - 1] = { ...made[made.length - 1], x: centroid[b].x, y: centroid[b].y, ...(frozenC.has(b) ? { frozen: true } : {}) };
    }
    done.set(arc.key, made);
  }
  if (!done.size) return doc;

  const mergeJ = (a, aS, b, bS) => {
    if (!aS && !bS) return a;
    const src = aS ? a : b;
    return { ...a, x: src.x, y: src.y, hIn: a.hIn, hOut: b.hOut, smooth: false, ...(a.frozen || b.frozen ? { frozen: true } : {}) };
  };
  const out = new Map(); // id de forma → forma nueva
  const current = (shape) => out.get(shape.id) || shape;
  rings.forEach((r, ri) => {
    if (!pieces[ri].some((sp) => done.has(sp.key))) return;
    const n = r.nodes.length;
    const parts = pieces[ri].map((sp) => {
      if (done.has(sp.key)) {
        const made = done.get(sp.key);
        return { nodes: orient(made, sp.reversed), smoothed: true, whole: !!sp.whole };
      }
      return { nodes: sp.idx.map((i) => r.nodes[i % n]), smoothed: false, whole: !!sp.whole };
    });
    let nodes;
    if (parts.length === 1 && parts[0].whole) nodes = parts[0].nodes;
    else {
      nodes = [];
      let lastS = false;
      for (const p of parts) {
        if (!nodes.length) nodes.push(...p.nodes);
        else {
          const last = nodes.pop();
          nodes.push(mergeJ(last, lastS, p.nodes[0], p.smoothed), ...p.nodes.slice(1));
        }
        lastS = p.smoothed;
      }
      if (r.closed) {
        // el anillo vuelve al nodo de unión inicial: el último nodo y el primero son el mismo
        const first = nodes[0];
        const last = nodes[nodes.length - 1];
        nodes = [mergeJ(last, lastS, first, parts[0].smoothed), ...nodes.slice(1, -1)];
      }
    }
    const shape = current(r.shape);
    out.set(r.shape.id, r.ring < 0 ? { ...shape, nodes } : { ...shape, holes: shape.holes.map((h, i) => (i === r.ring ? nodes : h)) });
  });
  return out.size ? replaceShapes(doc, out) : doc;
}

/**
 * Suavizado por nivel (0–100 %, el del control Suavizado) de un arco: los
 * mismos parámetros que el lápiz. Los extremos de un arco abierto no se mueven.
 */
export function smoothArcLevel(nodes, closed, level, mpp) {
  if (!(level > 0)) return null;
  const { passes, tolerance, tension } = freehandParams(level);
  let pts = flattenNodes(nodes, closed, mpp * 0.25).map(([x, y]) => ({ x, y }));
  if (closed && pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-9) pts.pop();
  const min = closed ? 3 : 2;
  if (pts.length < min) return null;
  pts = densifyForSmoothing(pts, mpp, closed);
  pts = simplify(relaxPoints(pts, passes, closed), tolerance * mpp);
  if (pts.length < min) return null;
  return curveThrough(pts, tension, closed);
}

/**
 * Simplificar un arco: menos nodos sin perder la forma (Ramer–Douglas–Peucker
 * sobre el trazo aplanado, con tolerancia `tol` en metros). Con `curves` el
 * resultado se rehace con curvas suaves por los nodos que quedan (para trazos
 * curvos); sin ello, con tramos rectos. Los extremos de un arco abierto no se
 * mueven. Devuelve null si no se gana nada.
 */
export function simplifyArc(nodes, closed, tol, { curves = false, flat = tol / 4 } = {}) {
  const min = closed ? 3 : 2;
  if (nodes.length <= min) return null;
  let pts = flattenNodes(nodes, closed, Math.max(flat, 1e-9)).map(([x, y]) => ({ x, y }));
  if (closed && pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 1e-9) pts.pop();
  let out = simplify(pts, tol);
  if (closed && out.length < 3) {
    // un anillo muy chico: se conservan los tres puntos más separados del primero
    out = [pts[0], pts[Math.floor(pts.length / 3)], pts[Math.floor((2 * pts.length) / 3)]];
  }
  if (out.length >= nodes.length || out.length < min) return null;
  return curves ? curveThrough(out, 0.25, closed) : out.map((p) => ({ x: p.x, y: p.y, hIn: null, hOut: null, smooth: false }));
}
