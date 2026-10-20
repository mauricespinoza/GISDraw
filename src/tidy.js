/**
 * Tidy: deja que varias líneas y polígonos COMPARTAN sus nodos donde están
 * cerca (a menos del umbral), sin aplanar las curvas.
 *
 * 1. Fusión: los nodos de formas distintas que caen a menos del umbral se
 *    juntan en su punto medio (sus manijas Bézier se mueven con ellos). Dos
 *    nodos del mismo trazo nunca se fusionan entre sí: así no se colapsa un
 *    tramo corto.
 * 2. Nodado: un nodo que cae sobre el tramo de otra forma (a menos del
 *    umbral, lejos de sus nodos) se inserta en ese tramo, en el mismo lugar.
 * 3. Misma curva: los tramos de formas distintas que unen los mismos dos
 *    nodos compartidos adoptan los MISMOS tiradores Bézier (los del primero
 *    que sea curvo), para que el borde común sea una sola geometría.
 *
 * Con eso los bordes comunes quedan con los mismos nodos en ambos lados, que
 * es lo que necesitan Move Joined, Trace, Drag, Deform y el suavizado por
 * arcos. Función pura doc -> doc.
 */

import { allTopShapes, replaceShapes } from './doc.js';
import { cubicAt, nearestOnPath, splitNodes } from './vector.js';

const ringsOf = (s) => [{ ring: -1, nodes: s.nodes, closed: !!s.closed }, ...(s.holes || []).map((h, i) => ({ ring: i, nodes: h, closed: true }))];
const shiftNode = (n, x, y) => {
  const dx = x - n.x;
  const dy = y - n.y;
  const mv = (p) => (p ? { x: p.x + dx, y: p.y + dy } : p);
  return { ...n, x, y, hIn: mv(n.hIn), hOut: mv(n.hOut) };
};

/** Quita nodos seguidos repetidos (pueden quedar al fusionar). */
function dedupe(nodes, closed, eps) {
  const out = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(prev.x - n.x, prev.y - n.y) <= eps) {
      out[out.length - 1] = { ...prev, hOut: n.hOut };
      continue;
    }
    out.push(n);
  }
  if (closed && out.length > 1 && Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= eps) {
    const last = out.pop();
    out[0] = { ...out[0], hIn: last.hIn };
  }
  return out;
}

/**
 * @param ids formas a ordenar (solo trazos desbloqueados)
 * @param tol umbral de cercanía (m)
 * @returns {{ doc: object, merged: number, inserted: number, shaped: number }} `merged`: grupos de nodos fusionados; `inserted`: nodos insertados; `shaped`: bordes comunes que adoptaron la misma curva.
 */
export function tidyShapes(doc, ids, tol) {
  const sel = ids instanceof Set ? ids : new Set(ids);
  const shapes = allTopShapes(doc, { visibleOnly: false })
    .filter(({ layer, shape }) => sel.has(shape.id) && shape.type === 'path' && !shape.locked && !layer.locked)
    .map(({ shape }) => shape);
  if (shapes.length < 1 || !(tol > 0)) return { doc, merged: 0, inserted: 0, shaped: 0 };

  // anillos de trabajo (copias)
  const rings = [];
  for (const s of shapes) for (const r of ringsOf(s)) rings.push({ shape: s, ring: r.ring, closed: r.closed, nodes: r.nodes.slice() });

  // 1) fusión de nodos de anillos distintos
  const cell = tol;
  const grid = new Map();
  const clusters = []; // { x, y, members: [{ ri, i }], rings: Set }
  const key = (cx, cy) => `${cx},${cy}`;
  rings.forEach((r, ri) =>
    r.nodes.forEach((n, i) => {
      const cx = Math.floor(n.x / cell);
      const cy = Math.floor(n.y / cell);
      let best = null;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const c of grid.get(key(cx + dx, cy + dy)) || []) {
            const d = Math.hypot(c.x - n.x, c.y - n.y);
            if (d <= tol && !c.rings.has(ri) && (!best || d < best.d)) best = { c, d };
          }
        }
      }
      if (best) {
        best.c.members.push({ ri, i });
        best.c.rings.add(ri);
        return;
      }
      const c = { x: n.x, y: n.y, members: [{ ri, i }], rings: new Set([ri]) };
      clusters.push(c);
      const k = key(cx, cy);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(c);
    }),
  );
  let merged = 0;
  for (const c of clusters) {
    if (c.members.length < 2) continue;
    let sx = 0;
    let sy = 0;
    for (const { ri, i } of c.members) {
      sx += rings[ri].nodes[i].x;
      sy += rings[ri].nodes[i].y;
    }
    // un nodo congelado no se mueve: los demás se juntan en él
    const fixed = c.members.map(({ ri, i }) => rings[ri].nodes[i]).find((nd) => nd.frozen);
    const x = fixed ? fixed.x : sx / c.members.length;
    const y = fixed ? fixed.y : sy / c.members.length;
    let moved = false;
    for (const { ri, i } of c.members) {
      const n = rings[ri].nodes[i];
      if (n.x !== x || n.y !== y) moved = true;
      rings[ri].nodes[i] = shiftNode(n, x, y);
      rings[ri].touched = true;
    }
    if (moved) merged++;
  }

  // 2) nodado: nodos de un anillo que caen sobre un tramo de otro
  let inserted = 0;
  const all = rings.flatMap((r, ri) => r.nodes.map((n) => ({ ri, n })));
  rings.forEach((q, qi) => {
    const segs = q.closed ? q.nodes.length : q.nodes.length - 1;
    if (segs < 1) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of q.nodes) {
      minX = Math.min(minX, n.x, n.hIn?.x ?? n.x, n.hOut?.x ?? n.x);
      maxX = Math.max(maxX, n.x, n.hIn?.x ?? n.x, n.hOut?.x ?? n.x);
      minY = Math.min(minY, n.y, n.hIn?.y ?? n.y, n.hOut?.y ?? n.y);
      maxY = Math.max(maxY, n.y, n.hIn?.y ?? n.y, n.hOut?.y ?? n.y);
    }
    const adds = new Map(); // tramo -> [{ t, x, y }]
    for (const { ri, n } of all) {
      if (ri === qi) continue;
      if (n.x < minX - tol || n.x > maxX + tol || n.y < minY - tol || n.y > maxY + tol) continue;
      if (q.nodes.some((m) => Math.hypot(m.x - n.x, m.y - n.y) <= tol)) continue; // ya hay (o hubo) un nodo ahí
      const near = nearestOnPath(q.nodes, q.closed, n);
      if (!near || near.dist > tol || near.t <= 1e-6 || near.t >= 1 - 1e-6) continue;
      const list = adds.get(near.segIndex) || [];
      if (list.some((a) => Math.hypot(a.x - n.x, a.y - n.y) <= 1e-9)) continue;
      list.push({ t: near.t, x: n.x, y: n.y });
      adds.set(near.segIndex, list);
    }
    if (!adds.size) return;
    let nodes = q.nodes;
    for (const seg of [...adds.keys()].sort((a, b) => b - a)) {
      let prevT = 1;
      for (const a of adds.get(seg).sort((u, v) => v.t - u.t)) {
        nodes = splitNodes(nodes, q.closed, seg, a.t / prevT);
        // el nodo nuevo, exactamente donde está el del vecino
        nodes[seg + 1] = shiftNode(nodes[seg + 1], a.x, a.y);
        prevT = a.t;
        inserted++;
      }
    }
    q.nodes = nodes;
    q.touched = true;
  });

  // 3) los tramos que unen los mismos dos nodos compartidos toman los mismos tiradores
  let shaped = 0;
  const pk = (n) => `${n.x},${n.y}`;
  const groups = new Map();
  rings.forEach((r, ri) => {
    const cnt = r.nodes.length;
    const segs = r.closed ? cnt : cnt - 1;
    for (let i = 0; i < segs; i++) {
      const j = (i + 1) % cnt;
      const ka = pk(r.nodes[i]);
      const kb = pk(r.nodes[j]);
      if (ka === kb) continue;
      const fwd = ka < kb;
      const gk = fwd ? `${ka}|${kb}` : `${kb}|${ka}`;
      const list = groups.get(gk) || [];
      list.push({ ri, i, j, fwd });
      groups.set(gk, list);
    }
  });
  const same = (p, q) => (!p && !q) || (p && q && Math.abs(p.x - q.x) < 1e-9 && Math.abs(p.y - q.y) < 1e-9);
  for (const list of groups.values()) {
    if (list.length < 2 || new Set(list.map((m) => m.ri)).size < list.length) continue; // dos tramos del mismo anillo: ambiguo
    // curva canónica: del nodo "menor" al "mayor"
    const canon = (m) => {
      const a = rings[m.ri].nodes[m.i];
      const b = rings[m.ri].nodes[m.j];
      return m.fwd ? { lo: a, hi: b, c1: a.hOut, c2: b.hIn } : { lo: b, hi: a, c1: b.hIn, c2: a.hOut };
    };
    const ref = list.find((m) => {
      const c = canon(m);
      return c.c1 || c.c2;
    });
    if (!ref) continue;
    const rc = canon(ref);
    const chord = Math.hypot(rc.hi.x - rc.lo.x, rc.hi.y - rc.lo.y);
    const mid = (c) => cubicAt(c.lo, c.c1 || c.lo, c.c2 || c.hi, c.hi, 0.5);
    const rm = mid(rc);
    let changed = false;
    for (const m of list) {
      if (m === ref) continue;
      const c = canon(m);
      if (same(c.c1, rc.c1) && same(c.c2, rc.c2)) continue;
      const cm = mid(c);
      if (Math.hypot(cm[0] - rm[0], cm[1] - rm[1]) > Math.max(tol * 10, chord * 0.2)) continue; // otro borde, no el mismo
      const r = rings[m.ri];
      const cp = (p) => (p ? { x: p.x, y: p.y } : null);
      if (m.fwd) {
        r.nodes[m.i] = { ...r.nodes[m.i], hOut: cp(rc.c1) };
        r.nodes[m.j] = { ...r.nodes[m.j], hIn: cp(rc.c2) };
      } else {
        r.nodes[m.j] = { ...r.nodes[m.j], hIn: cp(rc.c1) };
        r.nodes[m.i] = { ...r.nodes[m.i], hOut: cp(rc.c2) };
      }
      r.touched = true;
      changed = true;
    }
    if (changed) shaped++;
  }

  // formas nuevas
  const out = new Map();
  const eps = tol * 1e-6;
  for (const r of rings) {
    if (!r.touched) continue;
    const s = out.get(r.shape.id) || r.shape;
    const nodes = dedupe(r.nodes, r.closed, eps);
    if (nodes.length < (r.closed ? 3 : 2)) continue;
    out.set(r.shape.id, r.ring < 0 ? { ...s, nodes } : { ...s, holes: s.holes.map((h, i) => (i === r.ring ? nodes : h)) });
  }
  return { doc: out.size ? replaceShapes(doc, out) : doc, merged, inserted, shaped };
}

/**
 * Nodado al dibujar: cada punto de `points` que cae SOBRE el trazo de otra
 * forma (a menos de `tol`, lejos de sus nodos) se inserta en ese trazo como
 * nodo, exactamente en ese lugar. Es lo que hace que una línea que termina en
 * medio de otra (un contacto en T, un trazo de lápiz enganchado a un borde)
 * quede COMPARTIENDO un nodo con ella, y Move Joined, Drag y Deform la
 * arrastren junto. `exclude`: la forma recién dibujada; `only` / `skip`:
 * conjuntos de ids donde insertar o no.
 * @returns {{ doc: object, inserted: number }}
 */
export function nodeInto(doc, points, { exclude = null, tol = 0.01, only = null, skip = null } = {}) {
  if (!points.length) return { doc, inserted: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const out = new Map();
  let inserted = 0;
  for (const { layer, shape } of allTopShapes(doc, { visibleOnly: false })) {
    if (shape.id === exclude || (only && !only.has(shape.id)) || skip?.has(shape.id) || shape.type !== 'path' || shape.locked || layer.locked) continue;
    let cur = shape;
    for (const r of ringsOf(shape)) {
      let nodes = r.ring < 0 ? cur.nodes : cur.holes[r.ring];
      // descarte rápido por caja (con las manijas)
      let bx0 = Infinity;
      let by0 = Infinity;
      let bx1 = -Infinity;
      let by1 = -Infinity;
      for (const n of nodes) {
        for (const q of [n, n.hIn, n.hOut]) {
          if (!q) continue;
          bx0 = Math.min(bx0, q.x);
          bx1 = Math.max(bx1, q.x);
          by0 = Math.min(by0, q.y);
          by1 = Math.max(by1, q.y);
        }
      }
      if (bx0 > maxX + tol || bx1 < minX - tol || by0 > maxY + tol || by1 < minY - tol) continue;
      const adds = new Map();
      for (const p of points) {
        if (nodes.some((m) => Math.hypot(m.x - p.x, m.y - p.y) <= tol)) continue; // ya comparten un nodo
        const near = nearestOnPath(nodes, r.closed, p);
        if (!near || near.dist > tol || near.t <= 1e-6 || near.t >= 1 - 1e-6) continue;
        const list = adds.get(near.segIndex) || [];
        if (!list.some((a) => Math.hypot(a.x - p.x, a.y - p.y) <= 1e-9)) list.push({ t: near.t, x: p.x, y: p.y });
        adds.set(near.segIndex, list);
      }
      if (!adds.size) continue;
      for (const seg of [...adds.keys()].sort((a, b) => b - a)) {
        let prevT = 1;
        for (const a of adds.get(seg).sort((u, v) => v.t - u.t)) {
          nodes = splitNodes(nodes, r.closed, seg, a.t / prevT);
          nodes[seg + 1] = shiftNode(nodes[seg + 1], a.x, a.y);
          prevT = a.t;
          inserted++;
        }
      }
      cur = r.ring < 0 ? { ...cur, nodes } : { ...cur, holes: cur.holes.map((h, i) => (i === r.ring ? nodes : h)) };
    }
    if (cur !== shape) out.set(shape.id, cur);
  }
  return { doc: out.size ? replaceShapes(doc, out) : doc, inserted };
}
