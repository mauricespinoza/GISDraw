/**
 * Trace: el camino sigue la geometría existente sin saltar vértices ni quedarse
 * corto cuando los elementos se tocan en un vértice, en medio de un segmento
 * (contacto que termina en el borde de un polígono), se cruzan o quedan a unos
 * milímetros.
 *
 *   node test/trace.test.mjs
 */

import { SnapIndex, buildGraph, tracePath, smartTrace, pathLength, pointKey } from '../src/snapping.js';

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

// ---- Trace inteligente: sentido, sin repetir puntos
{
  const b = build([square]);
  const A = b.idx.query([0, 40], 1); // punto de partida en el borde izquierdo
  const at = (x, y) => b.idx.query([x, y], 1);
  const free = smartTrace(b.idx, b.graph, A, at(100, 40));
  ok(free && free.length === 4 && pathLength(free) === 180, `libre: el más corto (${pathLength(free)})`);
  // se sale hacia ARRIBA (primer vértice (0,100)); el cursor sigue por el borde derecho: casi toda la vuelta
  const up = smartTrace(b.idx, b.graph, A, at(100, 10));
  ok(up && same(up[1], 0, 0) || up && same(up[1], 0, 100), 'primer destino cerca: sale por el lado corto');
  const first = smartTrace(b.idx, b.graph, A, at(100, 90)); // el más corto sale hacia arriba
  ok(first && same(first[1], 0, 100), `parte hacia arriba: ${JSON.stringify(first)}`);
  // con el sentido recordado, un destino más lejano sigue hacia arriba aunque ya convenga (poco) el otro lado
  const keep = smartTrace(b.idx, b.graph, A, at(100, 20), { prefer: first.first });
  ok(keep && same(keep[1], 0, 100), `mantiene el sentido: ${JSON.stringify(keep)}`);
  ok(pathLength(keep) > pathLength(smartTrace(b.idx, b.graph, A, at(100, 20))), 'aunque sea más largo que el otro lado');
  // cuando el otro lado es MUCHO más corto, cambia
  const flip = smartTrace(b.idx, b.graph, A, at(0, 20), { prefer: first.first });
  ok(flip && same(flip[flip.length - 1], 0, 20) && pathLength(flip) <= 20.01, `cambia de lado si el otro cuesta mucho menos: ${pathLength(flip)}`);
  // no vuelve a pasar por lo ya trazado
  const used = new Set([pointKey([0, 100]), pointKey([100, 100])]);
  const avoid = smartTrace(b.idx, b.graph, A, at(100, 40), { avoid: used });
  ok(avoid && !avoid.slice(1, -1).some((p) => same(p, 0, 100) || same(p, 100, 100)), `evita lo ya trazado: ${JSON.stringify(avoid)}`);
  const seen = new Set();
  ok(avoid && avoid.every((p) => !seen.has(pointKey(p)) && seen.add(pointKey(p))), 'ningún punto dos veces');
  // sí puede terminar en un punto ya trazado (cerrar el anillo)
  const close = smartTrace(b.idx, b.graph, at(0, 100), at(0, 0), { avoid: new Set([pointKey([0, 0])]) });
  ok(close && same(close[close.length - 1], 0, 0), 'termina en un punto ya trazado');
}

// ---- el trace sigue por donde pasó el cursor (track)
{
  const rect = { id: 'r', closed: true, pts: [[0, 0], [200, 0], [200, 100], [0, 100]] };
  const b = build([rect]);
  const at = (x, y) => b.idx.query([x, y], 1);
  const along = (pts, step = 3) => {
    const out = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [a, c] = [pts[i], pts[i + 1]];
      const n = Math.max(1, Math.ceil(Math.hypot(c[0] - a[0], c[1] - a[1]) / step));
      for (let k = 0; k < n; k++) out.push([a[0] + ((c[0] - a[0]) * k) / n, a[1] + ((c[1] - a[1]) * k) / n]);
    }
    out.push(pts[pts.length - 1].slice());
    return out;
  };
  const A = at(0, 80);
  // el cursor baja un poco (titubeo), vuelve, sube a la esquina y dobla: el trazo dobla con él, no da la vuelta larga
  const wiggle = [...along([[0, 75], [0, 60]]), ...along([[0, 88], [0, 100], [40, 100]])];
  const corner = smartTrace(b.idx, b.graph, A, at(40, 100), { track: { pts: wiggle, r: 8 } });
  ok(corner && same(corner[1], 0, 100) && Math.abs(pathLength(corner) - 60) < 1e-6, `dobla la esquina por donde pasó el cursor: ${JSON.stringify(corner)}`);
  // el cursor dio la vuelta por abajo y la derecha: sigue por ahí aunque sea más largo
  const around = along([[0, 70], [0, 0], [200, 0], [200, 100], [120, 100]]);
  const long = smartTrace(b.idx, b.graph, A, at(120, 100), { track: { pts: around, r: 8 } });
  ok(long && same(long[1], 0, 0) && long.some((p) => same(p, 200, 100)), `en el anillo sigue el sentido del cursor: ${JSON.stringify(long)}`);
  // pero si el cursor dio casi toda la vuelta y el destino quedó junto al inicio, gana el corto
  const almost = along([[0, 70], [0, 0], [200, 0], [200, 100], [10, 100]]);
  const back = smartTrace(b.idx, b.graph, A, at(10, 100), { track: { pts: almost, r: 8 } });
  ok(back && same(back[1], 0, 100) && Math.abs(pathLength(back) - 30) < 1e-6, `destino a un paso por el otro lado: el corto (${JSON.stringify(back)})`);
  // sin recorrido del cursor: el más corto
  const plain = smartTrace(b.idx, b.graph, A, at(120, 100));
  ok(plain && same(plain[1], 0, 100), 'sin recorrido, el más corto');
}

// ---- dos bordes casi superpuestos: si el cursor sigue el que tiene vértices, el trace no los salta
{
  const straight = { id: 's', pts: [[0, 0], [100, 0]] };
  const wavy = { id: 'w', pts: [[0, 0], [25, 3], [50, 4], [75, 3], [100, 0]] };
  const b = build([straight, wavy]);
  const A = b.idx.query([0, 0], 0.5);
  const B = b.idx.query([100, 0], 0.5);
  const pts = [];
  for (let x = 2; x <= 98; x += 2) pts.push([x, x <= 25 ? (3 * x) / 25 : x <= 50 ? 3 + (x - 25) / 25 : x <= 75 ? 4 - (x - 50) / 25 : 3 - (3 * (x - 75)) / 25]);
  const p = smartTrace(b.idx, b.graph, A, B, { track: { pts, r: 1.5 } });
  ok(p && [[25, 3], [50, 4], [75, 3]].every(([x, y]) => p.some((q) => same(q, x, y))), `recorre los vértices del borde seguido: ${JSON.stringify(p)}`);
}

// ---- un snap tomado en un índice anterior se vuelve a ubicar en el nuevo (pan / zoom)
{
  const c = { id: 'c', pts: [[50, 100], [50, 200], [80, 230]] };
  const old = build([square, c]);
  const snap = old.idx.query([50, 150], 1);
  const now = build([{ id: 'x', pts: [[500, 500], [600, 500]] }, c, square]); // otro orden: otros números de segmento
  ok(now.idx.segments[snap.segment].meta.id !== 'c', 'el número de segmento viejo apunta a otro elemento');
  const live = now.idx.locate(snap.point, 0.1, 'c');
  ok(live && live.meta.id === 'c' && same(live.point, 50, 150), `se ubica en el mismo elemento y punto: ${JSON.stringify(live?.point)}`);
  const v = now.idx.locate([50, 200], 0.1, 'c');
  ok(v && v.type === 'vertex' && same(v.point, 50, 200), 'un vértice sigue siendo vértice');
  const path = tracePath(now.idx, now.graph, live, now.idx.query([0, 100], 1));
  ok(path && path.some((p) => same(p, 50, 100)) && same(path[path.length - 1], 0, 100), `traza desde el snap reubicado: ${JSON.stringify(path)}`);
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
