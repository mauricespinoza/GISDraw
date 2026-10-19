/**
 * Herramienta Deform: se arrastra una zona de una línea o polígono y sus nodos
 * se desplazan en gradiente —todo el arrastre cerca de donde se tomó, cada vez
 * menos hacia los nodos vecinos, nada al borde del área de influencia—, como
 * la edición proporcional de los programas 3D o el «Warp» de Illustrator.
 *
 * Los tramos que cruzan el área se subdividen antes (una vez, al empezar) para
 * que una línea de pocos nodos también se curve con suavidad. Dos formas
 * seleccionadas que comparten nodos se deforman igual porque esos nodos están
 * en el mismo lugar; con Move Joined, además, las formas vecinas NO
 * seleccionadas mueven los nodos que comparten con la selección (y sus bordes
 * comunes se subdividen igual), así no se abre el cierre topológico.
 *
 * Funciones puras doc -> doc, sin DOM.
 */

import { allTopShapes, replaceShapes } from './doc.js';
import { flattenNodes, splitNodes } from './vector.js';

/** Peso del arrastre a la distancia `d` del punto tomado, con radio `r`: 1 en el centro, 0 en el borde, sin escalón. */
export function deformWeight(d, r) {
  const t = d / r;
  if (!(t < 1)) return 0;
  const u = 1 - t * t;
  return u * u;
}

function distToSegment(p, nodes, i, closed, tol) {
  const n = nodes.length;
  const pts = flattenNodes([nodes[i], nodes[(i + 1) % n]], false, tol);
  let best = Infinity;
  for (let k = 0; k + 1 < pts.length; k++) {
    const [ax, ay] = pts[k];
    const [bx, by] = pts[k + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / L)) : 0;
    best = Math.min(best, Math.hypot(p.x - (ax + t * dx), p.y - (ay + t * dy)));
  }
  let len = 0;
  for (let k = 0; k + 1 < pts.length; k++) len += Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]);
  return { dist: best, len };
}

/** Rejilla para saber si un punto coincide (a menos de `tol`) con alguno de un conjunto. */
function pointSet(points, tol) {
  const cell = Math.max(tol, 1e-9);
  const map = new Map();
  const key = (cx, cy) => `${cx},${cy}`;
  for (const p of points) {
    const k = key(Math.floor(p.x / cell), Math.floor(p.y / cell));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(p);
  }
  return (q) => {
    const cx = Math.floor(q.x / cell);
    const cy = Math.floor(q.y / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const p of map.get(key(cx + dx, cy + dy)) || []) if (Math.hypot(p.x - q.x, p.y - q.y) <= tol) return p;
    return null;
  };
}

/**
 * Subdivide los tramos de un anillo que pasan a menos de `radius` del centro y
 * son más largos que `step`, en partes iguales (en el parámetro de la curva:
 * el mismo tramo recorrido al revés queda dividido en los mismos puntos).
 * `only(i)`: si se da, solo los tramos para los que devuelve true.
 */
function subdivideRing(nodes, closed, center, radius, step, only = null) {
  let out = nodes;
  const segs = closed ? nodes.length : nodes.length - 1;
  for (let i = segs - 1; i >= 0; i--) {
    if (only && !only(i)) continue;
    const { dist, len } = distToSegment(center, nodes, i, closed, Math.max(step / 8, 1e-6));
    if (dist >= radius || len <= step) continue;
    const k = Math.min(48, Math.ceil(len / step));
    // partes iguales: se corta al final y se sigue con lo que queda hacia el inicio
    for (let j = k - 1; j >= 1; j--) out = splitNodes(out, closed, i, j / (j + 1));
  }
  return out;
}

/**
 * Prepara una deformación tomada en `center` (mundo) con radio `radius` (m):
 * subdivide lo necesario y calcula el peso de cada nodo. `ids`: formas a
 * deformar; `joined`: arrastrar también los nodos que otras formas comparten
 * con ellas (Move Joined); `tol`: distancia bajo la cual dos nodos son el mismo.
 * @returns {{ base: object, moves: object[], count: number }} `count`: nodos que se mueven.
 */
export function prepareDeform(doc, ids, center, radius, { joined = true, tol = 0.01 } = {}) {
  const sel = ids instanceof Set ? ids : new Set(ids);
  const step = radius / 5;
  const all = allTopShapes(doc, { visibleOnly: false }).filter(({ layer, shape }) => shape.type === 'path' && !shape.locked && !layer.locked && shape.nodes?.length >= 2);
  const targets = all.filter(({ shape }) => sel.has(shape.id)).map(({ shape }) => shape);
  if (!targets.length) return { base: doc, moves: [], count: 0 };

  const ringsOf = (s) => [{ ring: -1, nodes: s.nodes, closed: !!s.closed }, ...(s.holes || []).map((h, i) => ({ ring: i, nodes: h, closed: true }))];
  const withRings = (s, rings) => ({ ...s, nodes: rings[0], holes: s.holes ? rings.slice(1) : s.holes });

  // nodos originales de la selección, para reconocer los bordes compartidos de las vecinas
  const origTarget = pointSet(targets.flatMap((s) => ringsOf(s).flatMap((r) => r.nodes)), tol);
  const map = new Map();
  for (const s of targets) map.set(s.id, withRings(s, ringsOf(s).map((r) => subdivideRing(r.nodes, r.closed, center, radius, step))));
  const neighbors = [];
  if (joined) {
    for (const { shape: s } of all) {
      if (sel.has(s.id)) continue;
      const rings = ringsOf(s);
      if (!rings.some((r) => r.nodes.some((n) => origTarget(n)))) continue;
      // solo se subdividen sus tramos que son también de la selección (ambos extremos compartidos)
      const sub = rings.map((r) => subdivideRing(r.nodes, r.closed, center, radius, step, (i) => origTarget(r.nodes[i]) && origTarget(r.nodes[(i + 1) % r.nodes.length])));
      map.set(s.id, withRings(s, sub));
      neighbors.push(s.id);
    }
  }
  const base = replaceShapes(doc, map);

  // pesos: los nodos de la selección por su distancia; los de las vecinas, solo si coinciden con uno de la selección
  const moves = [];
  const selNodes = [];
  for (const s of targets) {
    const sh = map.get(s.id);
    ringsOf(sh).forEach(({ ring, nodes }) =>
      nodes.forEach((n, index) => {
        const w = deformWeight(Math.hypot(n.x - center.x, n.y - center.y), radius);
        selNodes.push(n);
        if (w > 1e-4) moves.push({ id: s.id, ring, index, w, x: n.x, y: n.y });
      }),
    );
  }
  const onSel = pointSet(selNodes, tol);
  for (const id of neighbors) {
    ringsOf(map.get(id)).forEach(({ ring, nodes }) =>
      nodes.forEach((n, index) => {
        const p = onSel(n);
        if (!p) return;
        const w = deformWeight(Math.hypot(p.x - center.x, p.y - center.y), radius);
        if (w > 1e-4) moves.push({ id, ring, index, w, x: n.x, y: n.y, joined: true });
      }),
    );
  }
  return { base, moves, count: moves.length };
}

/** Documento con el arrastre (`dx`, `dy`, en metros) aplicado a una deformación preparada. */
export function applyDeform(prep, dx, dy) {
  if (!prep.moves.length) return prep.base;
  const byShape = new Map();
  for (const m of prep.moves) {
    if (!byShape.has(m.id)) byShape.set(m.id, []);
    byShape.get(m.id).push(m);
  }
  const shapes = new Map(allTopShapes(prep.base, { visibleOnly: false }).map(({ shape }) => [shape.id, shape]));
  const out = new Map();
  const shift = (p, w) => (p ? { x: p.x + w * dx, y: p.y + w * dy } : p);
  for (const [id, list] of byShape) {
    const s = shapes.get(id);
    if (!s) continue;
    const nodes = s.nodes.slice();
    const holes = s.holes ? s.holes.map((h) => h.slice()) : s.holes;
    for (const m of list) {
      const ring = m.ring < 0 ? nodes : holes[m.ring];
      const n = ring[m.index];
      ring[m.index] = { ...n, x: n.x + m.w * dx, y: n.y + m.w * dy, hIn: shift(n.hIn, m.w), hOut: shift(n.hOut, m.w) };
    }
    out.set(id, { ...s, nodes, holes });
  }
  return replaceShapes(prep.base, out);
}

/** Peso de Drag a la fracción `t` del alcance: 1 en el nodo tomado, 0 al final, con transición suave. */
export const dragWeight = (t) => (t >= 1 ? 0 : t <= 0 ? 1 : 0.5 * (1 + Math.cos(Math.PI * t)));

/**
 * Herramienta Drag: se toma UN nodo y se arrastra; los nodos vecinos lo
 * siguen cada vez menos A LO LARGO DEL TRAZO. Con `reach` = 1 (por defecto)
 * el gradiente llega justo hasta los extremos de la línea —que quedan
 * fijos— o, en un anillo cerrado, hasta el punto opuesto; con menos, el
 * movimiento es más localizado. A diferencia de Deform, la influencia se
 * mide por el recorrido del trazo y no por la distancia en el plano.
 *
 * Los nodos de otras formas que coinciden con los que se mueven se arrastran
 * igual (manteniendo el cierre): los de las formas en `ids` siempre, y con
 * `joined` (Move Joined) también los de cualquier otra.
 * @returns {{ base: object, moves: object[], count: number }} lo mismo que `prepareDeform`, para `applyDeform`.
 */
export function prepareDrag(doc, { id, ring, index }, { reach = 1, ids = [], joined = true, tol = 0.01 } = {}) {
  const all = allTopShapes(doc, { visibleOnly: false }).filter(({ layer, shape }) => shape.type === 'path' && !shape.locked && !layer.locked && shape.nodes?.length >= 2);
  const own = all.find(({ shape }) => shape.id === id)?.shape;
  const nodes = own && (ring < 0 ? own.nodes : own.holes?.[ring]);
  if (!nodes?.[index]) return { base: doc, moves: [], count: 0 };
  const closed = ring < 0 ? !!own.closed : true;
  const n = nodes.length;
  const seg = (i) => Math.hypot(nodes[(i + 1) % n].x - nodes[i].x, nodes[(i + 1) % n].y - nodes[i].y);
  const r = Math.max(1e-6, Math.min(1, reach));
  const moves = [];
  const put = (j, w) => w > 1e-4 && moves.push({ id, ring, index: j, w, x: nodes[j].x, y: nodes[j].y });
  put(index, 1);
  if (closed) {
    // recorrido acumulado hacia adelante desde el nodo tomado
    const per = Array.from({ length: n }, (_, i) => seg(i)).reduce((a, b) => a + b, 0);
    const half = per / 2;
    let f = 0;
    const fwd = new Array(n).fill(0);
    for (let k = 1; k < n; k++) {
      f += seg((index + k - 1) % n);
      fwd[(index + k) % n] = f;
    }
    for (let j = 0; j < n; j++) if (j !== index) put(j, dragWeight(Math.min(fwd[j], per - fwd[j]) / (half * r)));
  } else {
    // hacia cada extremo, con su propio largo: el extremo queda fijo
    let total = 0;
    for (let j = index; j < n - 1; j++) total += seg(j);
    let acc = 0;
    for (let j = index + 1; j < n; j++) {
      acc += seg(j - 1);
      put(j, total ? dragWeight(acc / (total * r)) : 0);
    }
    total = 0;
    for (let j = index; j > 0; j--) total += seg(j - 1);
    acc = 0;
    for (let j = index - 1; j >= 0; j--) {
      acc += seg(j);
      put(j, total ? dragWeight(acc / (total * r)) : 0);
    }
  }

  // nodos compartidos: los que coinciden con uno que se mueve lo siguen con el mismo peso
  const moved = pointSet(moves.map((m) => ({ x: m.x, y: m.y, w: m.w })), tol);
  const sel = new Set(ids);
  for (const { shape: s } of all) {
    if (!(joined || sel.has(s.id))) continue;
    const rings = [{ ring: -1, nodes: s.nodes }, ...(s.holes || []).map((h, i) => ({ ring: i, nodes: h }))];
    for (const rr of rings) {
      rr.nodes.forEach((q, j) => {
        if (s.id === id && rr.ring === ring) return;
        const p = moved(q);
        if (p) moves.push({ id: s.id, ring: rr.ring, index: j, w: p.w, x: q.x, y: q.y, joined: true });
      });
    }
  }
  return { base: doc, moves, count: moves.length };
}
