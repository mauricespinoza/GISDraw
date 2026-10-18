/**
 * Join (unir líneas), Merge (fusionar polígonos), Split (dividir con una línea)
 * y Hole (hueco).
 *
 *   node test/geomops.test.mjs
 */

import { createRequire } from 'node:module';
import { joinPaths } from '../src/ops.js';
import { mergePolygons, splitPolygons, holePolygons, holeWithPoints, selectedLines } from '../src/geomOps.js';
import { makeNode, makePath, makeRectPath } from '../src/vector.js';
import { defaultStyle } from '../src/style.js';
import { newDocument, addShapes } from '../src/doc.js';

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

const base = newDocument();
const layerId = base.activeLayerId;
const docWith = (shapes) => addShapes(base, layerId, shapes);
const items = (doc) => doc.layers.find((l) => l.id === layerId).items;
const area = (nodes) => Math.abs(nodes.reduce((a, p, i) => a + (p.x * nodes[(i + 1) % nodes.length].y - nodes[(i + 1) % nodes.length].x * p.y), 0) / 2);
const netArea = (s) => area(s.nodes) - (s.holes || []).reduce((a, h) => a + area(h), 0);
const line = (...pts) => makePath(pts.map(([x, y]) => makeNode(x, y)));
const rect = (x0, y0, x1, y1, st = {}) => {
  const r = makeRectPath(x0, y0, x1, y1, { ...defaultStyle(), fill: '#aabbcc', ...st });
  return r;
};

/* ================================================================= JOIN */
{
  const l1 = line([0, 0], [10, 0]);
  const l3 = line([30, 0], [20, 0]); // al revés
  const l2 = line([10.1, 0], [20, 0.05]);
  const doc = docWith([l1, l3, l2]);
  const r = joinPaths(doc, new Set([l1.id, l2.id, l3.id]), 0.5);
  const it = items(r.doc);
  ok(!r.error && it.length === 1 && it[0].id === l1.id, 'tres líneas → una, con el id de la primera');
  ok(it[0].nodes.length === 4 && it[0].nodes.map((n) => Math.round(n.x)).join() === '0,10,20,30', `encadenadas en orden y fundidas: ${it[0].nodes.map((n) => n.x)}`);
  const far = joinPaths(docWith([line([0, 0], [10, 0]), line([20, 0], [30, 0]), line([50, 0], [40, 0])]), new Set(items(docWith([])).map((s) => s.id)), 0);
  ok(far.error, 'sin selección no une');
  const a = line([0, 0], [10, 0]);
  const b = line([20, 0], [30, 0]);
  const c = line([-20, 0], [-10, 0]);
  const r2 = joinPaths(docWith([a, b, c]), new Set([a.id, b.id, c.id]), 0.01);
  const n2 = items(r2.doc)[0].nodes.map((n) => n.x);
  ok(items(r2.doc).length === 1 && n2.join() === '-20,-10,0,10,20,30', `une también por la cabeza, con tramos rectos: ${n2}`);
  const poly = rect(0, 0, 5, 5);
  const rp = joinPaths(docWith([a, poly]), new Set([a.id, poly.id]), 0);
  ok(rp.error && /polígonos/.test(rp.error), 'mezclar línea y polígono: error que remite a Fusionar');
  const one = joinPaths(docWith([line([0, 0], [1, 0], [1, 1])]), new Set(items(docWith([line([0, 0], [1, 0], [1, 1])])).map((s) => s.id)), 0);
  ok(one.error, 'ids de otro documento: sin efecto');
}

/* ================================================================ MERGE */
{
  const a = rect(0, 0, 100, 100);
  const b = rect(100, 0, 200, 100, { fill: '#ff0000' });
  const doc = docWith([a, b]);
  const r = mergePolygons(J, doc, new Set([a.id, b.id]));
  const it = items(r.doc);
  ok(!r.error && it.length === 1 && it[0].id === a.id, 'dos polígonos contiguos → uno, con el id del primero');
  ok(Math.abs(netArea(it[0]) - 20000) < 1e-6, `área 20000: ${netArea(it[0])}`);
  ok(it[0].nodes.length === 4, `sin vértices alineados sobrantes: ${it[0].nodes.length}`);
  ok(it[0].style.fill === '#aabbcc', 'conserva el estilo del primero');

  const c = rect(50, 50, 150, 150);
  const r2 = mergePolygons(J, docWith([a, c]), new Set([a.id, c.id]));
  ok(Math.abs(netArea(items(r2.doc)[0]) - (10000 + 10000 - 2500)) < 1e-6, 'traslapados: unión (17500)');

  const far = rect(500, 500, 600, 600);
  const r3 = mergePolygons(J, docWith([a, far]), new Set([a.id, far.id]));
  ok(items(r3.doc).length === 2 && r3.warning, 'separados: dos polígonos y aviso');

  // una «C» cerrada con otro polígono forma un hueco
  const ring = [rect(0, 0, 100, 20), rect(0, 80, 100, 100), rect(0, 0, 20, 100), rect(80, 0, 100, 100)];
  const r4 = mergePolygons(J, docWith(ring), new Set(ring.map((s) => s.id)));
  const m4 = items(r4.doc);
  ok(m4.length === 1 && m4[0].holes?.length === 1 && Math.abs(area(m4[0].holes[0]) - 3600) < 1e-6, 'cuatro lados forman un polígono con un hueco');
  ok(mergePolygons(J, docWith([a]), new Set([a.id])).error, 'uno solo: error');

  const lock = rect(0, 0, 10, 10);
  lock.locked = true;
  ok(mergePolygons(J, docWith([a, lock]), new Set([a.id, lock.id])).error, 'los bloqueados no se fusionan');
}

/* ================================================================ SPLIT */
{
  const sq = rect(0, 0, 100, 100);
  const cut = line([50, -10], [50, 110]);
  const doc = docWith([sq, cut]);
  const r = splitPolygons(J, doc, new Set([sq.id]), selectedLines(doc, new Set([cut.id])));
  const it = items(r.doc).filter((s) => s.closed);
  ok(!r.error && it.length === 2 && r.ids.length === 2, 'un polígono y una línea que lo cruza → dos polígonos');
  ok(it.every((s) => Math.abs(netArea(s) - 5000) < 1e-6) && it.some((s) => s.id === sq.id), 'mitades iguales; una conserva el id');
  ok(items(r.doc).some((s) => s.id === cut.id), 'la línea se conserva');
  ok(it.every((s) => s.style.fill === '#aabbcc'), 'cada parte conserva el estilo');

  // la línea termina justo en el borde (con coordenadas exactas)
  const exact = line([50, 0], [50, 100]);
  const r2 = splitPolygons(J, docWith([sq, exact]), new Set([sq.id]), [[[50, 0], [50, 100]]]);
  ok(!r2.error && items(r2.doc).filter((s) => s.closed).length === 2, 'línea de borde a borde exacta');

  // termina dentro: no divide
  const r3 = splitPolygons(J, doc, new Set([sq.id]), [[[50, -10], [50, 60]]]);
  ok(r3.error && /atraviesa/.test(r3.error), `línea que termina dentro: ${r3.error}`);

  // dos líneas → cuatro partes
  const r4 = splitPolygons(J, doc, new Set([sq.id]), [[[50, -10], [50, 110]], [[-10, 50], [110, 50]]]);
  ok(items(r4.doc).filter((s) => s.closed).length === 4, 'dos líneas cruzadas → 4 partes');

  // línea quebrada
  const r5 = splitPolygons(J, doc, new Set([sq.id]), [[[20, -10], [50, 50], [80, 110]]]);
  const p5 = items(r5.doc).filter((s) => s.closed);
  ok(p5.length === 2 && Math.abs(p5[0].nodes.length - p5[1].nodes.length) <= 2 && Math.abs(netArea(p5[0]) + netArea(p5[1]) - 10000) < 1e-6, 'línea quebrada: las partes suman el área original');

  // polígono con hueco: la línea pasa por el hueco
  const holed = rect(0, 0, 100, 100);
  holed.holes = [[makeNode(40, 40), makeNode(60, 40), makeNode(60, 60), makeNode(40, 60)]];
  const r6 = splitPolygons(J, docWith([holed]), new Set([holed.id]), [[[50, -10], [50, 110]]]);
  const p6 = items(r6.doc).filter((s) => s.closed);
  ok(p6.length === 2 && Math.abs(p6[0].nodes.length) >= 4 && Math.abs(netArea(p6[0]) + netArea(p6[1]) - (10000 - 400)) < 1e-6, 'con hueco: dos partes y el hueco se reparte');

  ok(splitPolygons(J, doc, new Set([cut.id]), [[[0, 0], [1, 1]]]).error, 'sin polígono: error');
  ok(splitPolygons(J, doc, new Set([sq.id]), []).error, 'sin línea: error');
}

/* ================================================================= HOLE */
{
  const big = rect(0, 0, 100, 100);
  const small = rect(30, 30, 60, 60, { fill: '#00ff00' });
  const doc = docWith([big, small]);
  const r = holePolygons(J, doc, new Set([big.id, small.id]));
  const it = items(r.doc);
  ok(!r.error && it.length === 1 && it[0].id === big.id && it[0].holes?.length === 1, 'forma dentro → hueco, y la forma se consume');
  ok(Math.abs(netArea(it[0]) - (10000 - 900)) < 1e-6, 'área neta 9100');
  const r2 = holePolygons(J, doc, new Set([big.id, small.id]), { keepCutters: true });
  ok(items(r2.doc).length === 2 && items(r2.doc)[0].holes?.length === 1, 'conservando la forma: queda también el polígono interior');

  const bite = rect(80, 80, 150, 150);
  const r3 = holePolygons(J, docWith([big, bite]), new Set([big.id, bite.id]));
  ok(items(r3.doc)[0].holes === null && Math.abs(netArea(items(r3.doc)[0]) - (10000 - 400)) < 1e-6, 'traslape: le muerde una esquina');

  const away = rect(300, 300, 320, 320);
  ok(holePolygons(J, docWith([big, away]), new Set([big.id, away.id])).error, 'sin contacto: error');
  const edge = rect(100, 0, 150, 100);
  ok(holePolygons(J, docWith([big, edge]), new Set([big.id, edge.id])).error, 'solo en el borde: error');
  const all = rect(-10, -10, 200, 200);
  ok(holePolygons(J, docWith([big, all]), new Set([big.id, all.id])).error, 'que cubre todo: error');
  ok(holePolygons(J, docWith([big]), new Set([big.id])).error, 'uno solo: error');

  // forma dibujada
  const r4 = holeWithPoints(J, docWith([big]), new Set([big.id]), [[20, 20], [40, 20], [40, 40], [20, 40]]);
  ok(!r4.error && items(r4.doc)[0].holes?.length === 1, 'hueco con una forma dibujada');
  ok(holeWithPoints(J, docWith([big]), new Set([big.id]), [[200, 200], [210, 200], [210, 210]]).error, 'dibujada fuera: error');
  ok(holeWithPoints(J, docWith([big]), new Set([big.id]), [[1, 1], [2, 2]]).error, 'dibujada con 2 puntos: error');

  // varios huecos en el mismo polígono
  const h2 = rect(70, 10, 90, 30);
  const r5 = holePolygons(J, docWith([big, small, h2]), new Set([big.id, small.id, h2.id]));
  ok(items(r5.doc)[0].holes?.length === 2, 'dos formas → dos huecos');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
