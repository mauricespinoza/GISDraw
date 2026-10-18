/**
 * Trace: el camino sigue la geometría existente sin saltar vértices ni quedarse
 * corto cuando los elementos se tocan en un vértice, en medio de un segmento
 * (contacto que termina en el borde de un polígono), se cruzan o quedan a unos
 * milímetros.
 *
 *   node test/trace.test.mjs
 */

import { SnapIndex, buildGraph, tracePath } from '../src/snapping.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}
const same = (p, x, y, tol = 1e-6) => Math.abs(p[0] - x) <= tol && Math.abs(p[1] - y) <= tol;
const length = (path) => path.reduce((a, p, i) => (i ? a + Math.hypot(p[0] - path[i - 1][0], p[1] - path[i - 1][1]) : 0), 0);
const build = (feats, tol = 0) => {
  const idx = new SnapIndex(10);
  for (const f of feats) idx.addPolyline(f.pts, !!f.closed, f.meta || { id: f.id });
  return { idx, graph: buildGraph(idx, { tol }) };
};
const trace = (b, from, to, tol = 1, opts) => tracePath(b.idx, b.graph, b.idx.query(from, tol), b.idx.query(to, tol), opts);

const square = { id: 'sq', closed: true, pts: [[0, 0], [100, 0], [100, 100], [0, 100]] };

// ---- un contacto que termina en MEDIO del borde de un polígono (sin vértice ahí)
{
  const b = build([square, { id: 'c', pts: [[50, 100], [50, 200], [80, 230]] }]);
  const path = trace(b, [80, 230], [0, 100]);
  ok(path && same(path[0], 80, 230) && same(path[path.length - 1], 0, 100), 'el trace llega hasta el destino a través del contacto');
  ok(path && path.some((p) => same(p, 50, 100)) && path.some((p) => same(p, 50, 200)), `pasa por el punto donde el contacto toca el borde y por su vértice: ${JSON.stringify(path)}`);
}

// ---- el vecino tiene un vértice sobre el borde largo: el trace lo recorre
{
  const a = { id: 'a', closed: true, pts: [[0, 0], [100, 0], [100, 50], [0, 50]] };
  const nb = { id: 'b', closed: true, pts: [[0, 0], [40, 0], [100, 0], [100, -50], [0, -50]] };
  const b = build([a, nb]);
  const path = trace(b, [0, 0], [100, 0]);
  ok(path && path.some((p) => same(p, 40, 0)), `incluye el vértice (40, 0) del vecino: ${JSON.stringify(path)}`);
  ok(path && Math.abs(length(path) - 100) < 1e-6, 'y no da un rodeo');
}

// ---- vértices casi coincidentes (digitalizados a ojo) se funden con la tolerancia
{
  const l1 = { id: 'l1', pts: [[0, 0], [50, 0]] };
  const l2 = { id: 'l2', pts: [[50.3, 0.2], [100, 0]] };
  const sin = build([l1, l2], 0);
  ok(trace(sin, [10, 0], [90, 0]) === null, 'sin tolerancia, extremos separados no se conectan');
  const con = build([l1, l2], 0.5);
  const path = trace(con, [10, 0], [90, 0]);
  ok(path && same(path[0], 10, 0) && same(path[path.length - 1], 90, 0.04, 0.01), 'con tolerancia, se conectan y el trace llega al final');
}

// ---- dos líneas que se cruzan sin compartir vértice: el trace gira en el cruce
{
  const b = build([{ id: 'x1', pts: [[0, 0], [100, 100]] }, { id: 'x2', pts: [[0, 100], [100, 0]] }]);
  const path = trace(b, [10, 10], [90, 10]);
  ok(path && path.some((p) => same(p, 50, 50)), `pasa por el cruce (50, 50): ${JSON.stringify(path)}`);
  ok(path && path.length === 3, 'sin vértices de más');
}

// ---- el recorrido alterno rodea el polígono por el otro lado
{
  const b = build([square]);
  const short = trace(b, [20, 0], [100, 30]);
  const alt = trace(b, [20, 0], [100, 30], 1, { alt: true });
  ok(short && alt && length(alt) > length(short) + 1, `alterno más largo: ${length(short)} < ${length(alt)}`);
  ok(alt && alt.some((p) => same(p, 0, 0)) && alt.some((p) => same(p, 0, 100)) && alt.some((p) => same(p, 100, 100)), 'el alterno pasa por los otros tres vértices');
  ok(short && short.length === 3 && same(short[1], 100, 0), 'el principal da la vuelta por la esquina cercana');
  // dos puntos del MISMO tramo: el alterno rodea todo el polígono (no sale a la esquina y vuelve)
  const sameEdge = trace(b, [20, 0], [60, 0], 1, { alt: true });
  ok(sameEdge && [[0, 0], [0, 100], [100, 100], [100, 0]].every(([x, y]) => sameEdge.some((p) => same(p, x, y))), `mismo tramo, alterno: ${JSON.stringify(sameEdge)}`);
  ok(sameEdge && Math.abs(length(sameEdge) - (20 + 100 + 100 + 100 + 40)) < 1e-6, 'y con la longitud del rodeo (360)');
  // en una línea abierta no hay otro camino: devuelve el mismo
  const open = build([{ id: 'o', pts: [[0, 0], [50, 0], [100, 0]] }]);
  const a1 = trace(open, [10, 0], [90, 0]);
  const a2 = trace(open, [10, 0], [90, 0], 1, { alt: true });
  ok(a1 && a2 && length(a1) === length(a2), 'sin alternativa, el recorrido es el mismo');
}

// ---- sin conexión: no hay camino
{
  const b = build([square, { id: 'far', pts: [[300, 0], [400, 0]] }]);
  ok(trace(b, [50, 0], [350, 0]) === null, 'elementos desconectados: null');
  ok(trace(b, [50, 0], [50, 0]) === null, 'mismo punto: null');
}

// ---- los segmentos del borrador no entran al grafo
{
  const b = build([{ id: 'r', pts: [[0, 0], [100, 0]] }, { meta: { draft: true, id: 'd' }, pts: [[0, 0], [0, 100]] }, { id: 's', pts: [[0, 100], [100, 100]] }]);
  ok(trace(b, [50, 0], [50, 100]) === null, 'el borrador no conecta nada');
}

// ---- tramos sobre el mismo segmento (con paradas) se unen directo
{
  const b = build([square, { id: 'c', pts: [[50, 0], [50, -50]] }]);
  const p = trace(b, [10, 0], [30, 0]);
  ok(p && p.length === 2, `dos puntos del mismo tramo: línea directa (${p?.length})`);
  const q = trace(b, [10, 0], [90, 0]);
  ok(q && q.some((x) => same(x, 50, 0)), 'dos puntos separados por una parada: pasa por ella');
}

// ---- rendimiento: miles de segmentos con cruces
{
  const feats = [];
  for (let i = 0; i < 60; i++) feats.push({ id: `h${i}`, pts: [[0, i * 10], [600, i * 10 + 3]] });
  for (let i = 0; i < 60; i++) feats.push({ id: `v${i}`, pts: [[i * 10, 0], [i * 10 + 3, 600]] });
  const t0 = Date.now();
  const b = build(feats, 0.5);
  const p = trace(b, [5, 0.2], [595, 603 - 3 + 0.0], 3);
  ok(Date.now() - t0 < 2000, `reja de 120 líneas con ${60 * 60} cruces: ${Date.now() - t0} ms`);
  ok(p === null || p.length >= 2, 'devuelve un recorrido o null sin errores');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
