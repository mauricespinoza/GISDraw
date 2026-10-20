/**
 * Freeze node: un nodo congelado no se mueve con las transformaciones ni con
 * las herramientas de deformación, y frena el gradiente de Deform y Drag.
 *
 *   node test/freeze.test.mjs
 */

import { applyDeform, prepareDeform, prepareDrag } from '../src/deform.js';
import { frozenPoints, setNodesFrozen, transformShapes } from '../src/ops.js';
import { smoothAlong } from '../src/smoothTool.js';
import { buildTopology, simplifyArc, smoothTopology } from '../src/smoothTopo.js';
import { cloneShape, makeNode, makePath, rotateShape, translateShape } from '../src/vector.js';
import { addShapes, allTopShapes, newDocument } from '../src/doc.js';

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
const get = (doc, id) => allTopShapes(doc, { visibleOnly: false }).find((x) => x.shape.id === id).shape;
const at = (nodes, x) => nodes.find((n) => Math.abs(n.x - x) < 1e-9);

/* congelar y descongelar, en todas las formas que comparten el nodo */
{
  const A = poly([[0, 0], [10, 0], [10, 10], [0, 10]]);
  const B = poly([[10, 0], [20, 0], [20, 10], [10, 10]]);
  let doc = docWith([A, B]);
  const r = setNodesFrozen(doc, [{ x: 10, y: 0 }], true, 0.01);
  ok(r.count === 2, 'Freeze marca el nodo en las dos formas que lo comparten');
  doc = r.doc;
  ok(get(doc, A.id).nodes[1].frozen && get(doc, B.id).nodes[0].frozen, 'nodo compartido congelado en ambas');
  ok(frozenPoints(doc, [A.id]).length === 1, 'frozenPoints de la selección');
  const u = setNodesFrozen(doc, frozenPoints(doc, [A.id]), false, 0.01);
  ok(u.count === 2 && !get(u.doc, B.id).nodes[0].frozen && !('frozen' in get(u.doc, A.id).nodes[1]), 'Unfreeze nodes lo descongela en todas');
}

/* transformaciones: el nodo congelado queda donde está */
{
  const L = line([[0, 0], [10, 0], [20, 0]]);
  L.nodes[1] = { ...L.nodes[1], frozen: true };
  const t = translateShape(L, 5, 5);
  ok(t.nodes[1].x === 10 && t.nodes[1].y === 0 && t.nodes[1].frozen, 'mover: el congelado no se mueve');
  ok(t.nodes[0].x === 5 && t.nodes[2].y === 5, 'mover: los demás sí');
  const r = rotateShape(L, { x: 0, y: 0 }, 90);
  ok(r.nodes[1].x === 10 && r.nodes[1].y === 0, 'rotar: el congelado no se mueve');
  const doc = docWith([L]);
  const s = get(transformShapes(doc, [L.id], { sx: 2, sy: 2 }), L.id);
  ok(s.nodes[1].x === 10 && s.nodes[1].y === 0, 'escalar (Transformar): el congelado no se mueve');
  ok(!cloneShape(L).nodes[1].frozen, 'duplicar/pegar no copia el congelado');
}

/* Deform: el gradiente llega a 0 en el congelado y no lo cruza */
{
  const L = line(Array.from({ length: 21 }, (_, i) => [i * 10, 0]));
  L.nodes[12] = { ...L.nodes[12], frozen: true }; // x = 120
  const doc = docWith([L]);
  const out = get(applyDeform(prepareDeform(doc, [L.id], { x: 100, y: 0 }, 60, { joined: false }), 0, 20), L.id);
  ok(Math.abs(at(out.nodes, 100).y - 20) < 1e-9, 'Deform: el nodo tomado se mueve todo');
  ok(at(out.nodes, 120).y === 0 && at(out.nodes, 120).frozen, 'Deform: el congelado no se mueve');
  ok(at(out.nodes, 130).y === 0 && at(out.nodes, 150).y === 0, 'Deform: más allá del congelado, nada');
  ok(at(out.nodes, 110).y > 0 && at(out.nodes, 110).y < at(out.nodes, 90).y, 'Deform: hacia el congelado el peso cae antes que hacia el otro lado');
  ok(at(out.nodes, 70).y > 0, 'Deform: el otro lado sigue con su gradiente');
}

/* Drag: el congelado hace de extremo fijo */
{
  const L = line(Array.from({ length: 11 }, (_, i) => [i * 10, 0]));
  L.nodes[8] = { ...L.nodes[8], frozen: true }; // x = 80
  const doc = docWith([L]);
  const prep = prepareDrag(doc, { id: L.id, ring: -1, index: 4 });
  const out = get(applyDeform(prep, 0, 10), L.id);
  ok(Math.abs(at(out.nodes, 40).y - 10) < 1e-9, 'Drag: el nodo tomado sigue al puntero');
  ok(at(out.nodes, 80).y === 0 && at(out.nodes, 90).y === 0 && at(out.nodes, 100).y === 0, 'Drag: el congelado y lo que sigue quedan quietos');
  ok(at(out.nodes, 60).y > 0 && at(out.nodes, 60).y < 10, 'Drag: gradiente hasta el congelado');
  ok(Math.abs(at(out.nodes, 60).y - 5) < 1e-9, 'Drag: a medio camino del congelado, la mitad');
  ok(at(out.nodes, 0).y === 0 && at(out.nodes, 20).y > 0, 'Drag: el otro lado llega hasta su extremo');
  ok(prepareDrag(doc, { id: L.id, ring: -1, index: 8 }).frozen, 'Drag: tomar un nodo congelado no lo mueve');

  // anillo: congelado en el punto opuesto
  const R = poly([[0, 0], [10, 0], [20, 0], [20, 10], [20, 20], [10, 20], [0, 20], [0, 10]]);
  R.nodes[4] = { ...R.nodes[4], frozen: true };
  const rd = get(applyDeform(prepareDrag(docWith([R]), { id: R.id, ring: -1, index: 0 }), -5, -5), R.id);
  ok(rd.nodes[4].x === 20 && rd.nodes[4].y === 20, 'Drag en anillo: el congelado no se mueve');
  ok(rd.nodes[0].x === -5 && rd.nodes[2].x < 20, 'Drag en anillo: el resto sigue');
}

/* Suavizar (pincel): el congelado se queda */
{
  const zig = Array.from({ length: 21 }, (_, i) => ({ ...N(i * 10, i % 2 ? 6 : -6) }));
  zig[10] = { ...zig[10], frozen: true };
  const out = smoothAlong(zig, false, [[60, 0], [140, 0]], { radius: 30, tol: 0.4, level: 70 });
  ok(out && out.some((n) => n.frozen && n.x === 100 && n.y === zig[10].y), 'Suavizar: el nodo congelado sigue en su lugar');
  ok(out.filter((n) => n.frozen).length === 1, 'Suavizar: un solo nodo congelado');
}

/* Simplificar / suavizar por arcos: el congelado corta el arco */
{
  const L = line(Array.from({ length: 21 }, (_, i) => [i * 10, i % 2 ? 0.01 : 0]));
  L.nodes[7] = { ...L.nodes[7], frozen: true };
  const doc = docWith([L]);
  const topo = buildTopology(doc, [L.id], 0.01);
  const out = get(smoothTopology(topo, doc, (nodes, closed) => simplifyArc(nodes, closed, 1)), L.id);
  ok(out.nodes.length < 21, 'Simplificar quita nodos');
  ok(out.nodes.some((n) => n.frozen && n.x === 70 && n.y === L.nodes[7].y), 'Simplificar conserva el nodo congelado');
}

console.log(`${pass} ok, ${fail} fallas`);
if (fail) process.exit(1);
