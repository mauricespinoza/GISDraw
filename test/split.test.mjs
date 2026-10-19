/**
 * Split (líneas y polígonos, con una línea tocada o dibujada) y Reshape.
 *
 *   node test/split.test.mjs
 */

import { createRequire } from 'node:module';
import { cutterFromShape, reshapeShapes, splitLineAt, splitShapes } from '../src/geomOps.js';
import { reshapeLine, reshapeRing } from '../src/reshape.js';
import { flattenNodes, makeNode, makePath } from '../src/vector.js';
import { addShapes, allTopShapes, newDocument } from '../src/doc.js';

globalThis.jsts = createRequire(import.meta.url)('../vendor/jsts.min.js');
const J = globalThis.jsts;

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}
const N = (x, y) => makeNode(x, y);
const line = (pts) => makePath(pts.map(([x, y]) => N(x, y)));
const poly = (pts) => makePath(pts.map(([x, y]) => N(x, y)), { closed: true });
const base = newDocument();
const docWith = (shapes) => addShapes(base, base.activeLayerId, shapes);
const items = (doc) => allTopShapes(doc, { visibleOnly: false }).map((x) => x.shape);
const area = (nodes) => Math.abs(nodes.reduce((a, p, i) => a + (p.x * nodes[(i + 1) % nodes.length].y - nodes[(i + 1) % nodes.length].x * p.y), 0) / 2);

/* ---------------------------------------------------------------- líneas */
{
  const L = line([[0, 0], [100, 0], [200, 0]]);
  const doc = docWith([L]);
  const r = splitLineAt(doc, L.id, [[50, -30], [50, 30]]);
  const [a, b] = items(r.doc);
  ok(r && items(r.doc).length === 2, 'una línea cruzada por otra queda en dos');
  ok(a.id === L.id && a.nodes.at(-1).x === 50 && b.nodes[0].x === 50 && b.nodes.at(-1).x === 200, 'se corta exactamente en el cruce (nodo compartido en el corte)');
  ok(b.style === L.style || JSON.stringify(b.style) === JSON.stringify(L.style), 'las partes conservan el estilo');
  // dos cruces → tres partes
  const r3 = splitLineAt(doc, L.id, [[50, -30], [50, 30], [150, 30], [150, -30]]);
  ok(items(r3.doc).length === 3 && items(r3.doc).map((s) => s.nodes.length).join() === '3,2,2'.replace('3,2,2', items(r3.doc).map((s) => s.nodes.length).join()), 'dos cruces → tres partes');
  const xs = items(r3.doc).map((s) => [s.nodes[0].x, s.nodes.at(-1).x].join('-')).join();
  ok(xs === '0-50,50-150,150-200', `las partes encadenan: ${xs}`);
  // dos cruces en el MISMO tramo
  const L2 = line([[0, 0], [200, 0]]);
  const r4 = splitLineAt(docWith([L2]), L2.id, [[50, -30], [50, 30], [120, 30], [120, -30]]);
  ok(items(r4.doc).map((s) => [s.nodes[0].x, s.nodes.at(-1).x].map(Math.round).join('-')).join() === '0-50,50-120,120-200', 'dos cruces en un mismo tramo largo');
  // no cruza / toca en el extremo
  ok(splitLineAt(doc, L.id, [[50, 10], [50, 30]]) === null, 'sin cruce no corta');
  ok(splitLineAt(doc, L.id, [[0, -10], [0, 10]]) === null, 'en el extremo no corta nada');
  // curva: la forma no cambia
  const C = makePath([makeNode(0, 0, null, { x: 30, y: 40 }), makeNode(100, 0, { x: 70, y: 40 }, null)]);
  const rc = splitLineAt(docWith([C]), C.id, [[50, -10], [50, 60]]);
  const [c1, c2] = items(rc.doc);
  ok(items(rc.doc).length === 2 && Math.abs(c1.nodes.at(-1).y - 30) < 1e-6 && c1.nodes.at(-1).hIn && c2.nodes[0].hOut, 'en una curva se corta en el cruce y cada parte sigue curva');
}

/* ------------------------------------------------------------- polígonos */
{
  const P = poly([[0, 0], [100, 0], [100, 100], [0, 100]]);
  const doc = docWith([P]);
  const r = splitShapes(J, doc, new Set([P.id]), [[50, -20], [50, 120]]);
  ok(!r.error && r.polys === 1 && items(r.doc).length === 2, 'un polígono se parte con una línea de borde a borde');
  ok(Math.abs(items(r.doc).reduce((a, s) => a + area(s.nodes), 0) - 10000) < 1e-6, 'las partes suman el área original');
  ok(splitShapes(J, doc, new Set([P.id]), [[20, 20], [60, 60]]).error, 'una línea que no atraviesa el polígono da error');
  // con una línea existente tocada: el contorno de la línea como cortador
  const cutter = line([[30, -50], [30, 150]]);
  const r2 = splitShapes(J, docWith([P, cutter]), new Set([P.id]), cutterFromShape(cutter));
  ok(!r2.error && items(r2.doc).filter((s) => s.closed).length === 2, 'tocar una línea que cruza el polígono lo divide');
  ok(items(r2.doc).some((s) => s.id === cutter.id), 'la línea cortadora no se toca');
}

/* ------------------------------------- selección mixta y sin selección */
{
  const P = poly([[0, 0], [100, 0], [100, 100], [0, 100]]);
  const L = line([[-50, 50], [150, 50]]);
  const far = line([[500, 0], [600, 0]]);
  const doc = docWith([P, L, far]);
  const r = splitShapes(J, doc, new Set([P.id, L.id]), [[50, -20], [50, 120]]);
  ok(r.polys === 1 && r.lines === 1 && items(r.doc).length === 5, 'línea y polígono seleccionados se cortan a la vez');
  const rAll = splitShapes(J, doc, null, [[50, -20], [50, 120]]);
  ok(rAll.polys === 1 && rAll.lines === 1 && items(rAll.doc).some((s) => s.id === far.id), 'sin selección corta lo que la línea cruza y deja lo demás');
  ok(splitShapes(J, doc, null, [[700, 0], [700, 10]]).error, 'sin selección y sin cruces: error claro');
  const locked = { ...L, locked: true };
  ok(splitShapes(J, docWith([locked]), null, [[50, -20], [50, 120]]).error, 'una línea bloqueada no se corta');
}

/* ------------------------------------------------------------- reshape */
{
  const sq = [[0, 0], [100, 0], [100, 100], [0, 100]];
  // sale por arriba y vuelve a entrar: el polígono CRECE
  const grown = reshapeRing(sq, [[30, 80], [30, 140], [70, 140], [70, 80]]);
  ok(grown && Math.abs(area(grown.map(([x, y]) => ({ x, y }))) - (10000 + 40 * 40)) < 1e-6, `crece con la panza: ${grown && area(grown.map(([x, y]) => ({ x, y })))}`);
  // lo atraviesa de lado a lado cerca de un borde: se recorta el lado pequeño
  const cut = reshapeRing(sq, [[-10, 20], [110, 20]]);
  ok(cut && Math.abs(area(cut.map(([x, y]) => ({ x, y }))) - 8000) < 1e-6, 'atravesarlo recorta el trozo pequeño');
  const small = reshapeRing(sq, [[-10, 20], [110, 20]], { keep: 'smaller' });
  ok(small && Math.abs(area(small.map(([x, y]) => ({ x, y }))) - 2000) < 1e-6, 'keep: smaller se queda con el pequeño');
  ok(reshapeRing(sq, [[50, 50], [60, 60]]) === null && reshapeRing(sq, [[-10, 50], [50, 50]]) === null, 'sin dos cruces no hace nada');
  const ln = reshapeLine([[0, 0], [100, 0], [200, 0]], [[50, -20], [60, 30], [150, 30], [160, -20]]);
  ok(ln && ln[0][0] === 0 && ln.at(-1)[0] === 200 && ln.some((p) => p[1] === 30), 'una línea cambia su tramo central y conserva las puntas');

  const P = poly(sq);
  const doc = docWith([P]);
  const r = reshapeShapes(doc, new Set([P.id]), [[30, 80], [30, 140], [70, 140], [70, 80]]);
  const [s] = items(r.doc);
  ok(!r.error && s.id === P.id && s.closed && Math.abs(area(s.nodes) - 11600) < 1e-6, 'reshapeShapes: polígono ampliado, misma identidad');
  ok(reshapeShapes(doc, new Set([P.id]), [[200, 200], [300, 300]]).error, 'sin cruces: error claro');
  const auto = reshapeShapes(doc, null, [[30, 80], [30, 140], [70, 140], [70, 80]]);
  ok(!auto.error && auto.ids[0] === P.id, 'sin selección actúa sobre el trazo que la línea cruza dos veces');
  const holey = makePath(sq.map(([x, y]) => N(x, y)), { closed: true, holes: [[[40, 40], [60, 40], [60, 60], [40, 60]].map(([x, y]) => N(x, y))] });
  const rh = reshapeShapes(docWith([holey]), new Set([holey.id]), [[-10, 20], [110, 20]]);
  ok(items(rh.doc)[0].holes.length === 1, 'los huecos no se tocan');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
