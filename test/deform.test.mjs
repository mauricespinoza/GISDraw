/**
 * Herramienta Deform: arrastre con gradiente, subdivisión de tramos largos y
 * nodos compartidos (Move Joined) sin abrir el cierre topológico.
 *
 *   node test/deform.test.mjs
 */

import { applyDeform, deformWeight, dragWeight, prepareDeform, prepareDrag } from '../src/deform.js';
import { buildTopology } from '../src/smoothTopo.js';
import { flattenNodes, makeNode, makePath } from '../src/vector.js';
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
const poly = (pts) => makePath(pts.map(([x, y]) => N(x, y)), { closed: true });
const line = (pts) => makePath(pts.map(([x, y]) => N(x, y)));
const base = newDocument();
const docWith = (shapes) => addShapes(base, base.activeLayerId, shapes);
const get = (doc, id) => allTopShapes(doc, { visibleOnly: false }).find((x) => x.shape.id === id).shape;

/* peso */
ok(deformWeight(0, 10) === 1 && deformWeight(10, 10) === 0 && deformWeight(20, 10) === 0, 'peso 1 en el centro, 0 en el borde y fuera');
ok(deformWeight(3, 10) > deformWeight(6, 10) && deformWeight(6, 10) > 0, 'el peso decrece con la distancia');

/* línea densa: gradiente */
{
  const L = line(Array.from({ length: 21 }, (_, i) => [i * 10, 0]));
  const doc = docWith([L]);
  const prep = prepareDeform(doc, [L.id], { x: 100, y: 0 }, 50, { joined: false });
  const out = get(applyDeform(prep, 0, 20), L.id);
  const y = (x) => out.nodes.find((n) => Math.abs(n.x - x) < 1e-9)?.y;
  ok(Math.abs(y(100) - 20) < 1e-9, 'el nodo tomado se mueve todo el arrastre');
  ok(y(110) < 20 && y(110) > y(120) && y(120) > y(140) && y(140) > 0, 'los vecinos se mueven cada vez menos');
  ok(y(150) === 0 && y(0) === 0 && y(200) === 0, 'fuera del radio no se mueve nada');
  ok(Math.abs(y(90) - y(110)) < 1e-9, 'simétrico a ambos lados');
}

/* línea de pocos nodos: se subdivide el tramo bajo el área */
{
  const L = line([[0, 0], [200, 0]]);
  const doc = docWith([L]);
  const prep = prepareDeform(doc, [L.id], { x: 100, y: 0 }, 50, { joined: false });
  ok(prep.count > 3, `un tramo largo se subdivide para curvarse: ${prep.count} nodos se mueven`);
  const out = get(applyDeform(prep, 0, 30), L.id);
  ok(out.nodes[0].x === 0 && out.nodes[0].y === 0 && out.nodes.at(-1).x === 200, 'los extremos lejanos no se mueven');
  ok(Math.max(...out.nodes.map((n) => n.y)) > 25, 'el centro sube casi todo el arrastre');
  ok(get(prep.base, L.id).nodes.every((n) => n.y === 0), 'subdividir no cambia la forma');
}

/* dos polígonos que comparten borde */
const A = poly([[0, 0], [100, 0], [100, 100], [0, 100]]);
const B = poly([[100, 0], [200, 0], [200, 100], [100, 100]]);
const sharedOkWith = (doc, id) => [...buildTopology(doc, [id], 1e-6).arcs.values()].some((a) => a.members.length === 2);
const sharedOk = (doc) => {
  const topo = buildTopology(doc, [A.id], 1e-6);
  return [...topo.arcs.values()].some((a) => a.members.length === 2);
};
const edgeOf = (s) => flattenNodes(s.nodes, true, 0.01).filter(([x]) => x > 90 && x < 140);
{
  // Move Joined: solo A seleccionada, B sigue el borde común
  const doc = docWith([A, B]);
  const prep = prepareDeform(doc, [A.id], { x: 100, y: 50 }, 40, { joined: true, tol: 1e-6 });
  const next = applyDeform(prep, 25, 0);
  const a2 = get(next, A.id);
  const b2 = get(next, B.id);
  ok(a2.nodes.length > 4 && b2.nodes.length > 4, 'el borde común se subdivide en las dos');
  ok(Math.max(...a2.nodes.map((n) => n.x)) > 120, 'el borde de A se empuja hacia B');
  ok(sharedOk(next), 'con Move Joined A y B siguen compartiendo el borde (sin gap)');
  const ea = a2.nodes.filter((n) => n.x > 100.001).map((n) => `${n.x.toFixed(6)},${n.y.toFixed(6)}`).sort().join();
  const eb = b2.nodes.filter((n) => n.x > 100.001 && n.x < 199).map((n) => `${n.x.toFixed(6)},${n.y.toFixed(6)}`).sort().join();
  ok(ea === eb && ea.length > 0, 'los nodos movidos son los mismos en A y B');
  ok(b2.nodes.some((n) => n.x === 200 && n.y === 0) && b2.nodes.some((n) => n.x === 200 && n.y === 100), 'el resto de B no se toca');
}
{
  // sin Move Joined: B no se toca
  const doc = docWith([A, B]);
  const prep = prepareDeform(doc, [A.id], { x: 100, y: 50 }, 40, { joined: false, tol: 1e-6 });
  const next = applyDeform(prep, 25, 0);
  ok(get(next, B.id) === B, 'sin Move Joined la vecina no seleccionada no se mueve');
}
{
  // las dos seleccionadas: se mueven igual aunque Move Joined esté apagado
  const doc = docWith([A, B]);
  const prep = prepareDeform(doc, [A.id, B.id], { x: 100, y: 50 }, 40, { joined: false, tol: 1e-6 });
  const next = applyDeform(prep, 25, 10);
  ok(sharedOk(next), 'seleccionadas juntas siguen compartiendo el borde');
}
{
  // forma bloqueada: no se deforma
  const locked = { ...B, locked: true };
  const doc = docWith([A, locked]);
  const prep = prepareDeform(doc, [A.id, locked.id], { x: 100, y: 50 }, 40, { joined: true, tol: 1e-6 });
  ok(get(applyDeform(prep, 25, 0), locked.id) === locked, 'una forma bloqueada no se deforma');
}
{
  // nada a la vista
  const doc = docWith([A]);
  const prep = prepareDeform(doc, [A.id], { x: 1000, y: 1000 }, 40, { joined: true });
  ok(prep.count === 0 && applyDeform(prep, 5, 5) === prep.base, 'sin nodos en el área no cambia nada');
}

/* ---- Deform en líneas que comparten nodos (Move Joined) ---- */
{
  const A = line([[0, 0], [50, 0], [100, 0]]);
  const C = line([[50, 0], [50, -80]]); // en T, comparte el nodo (50, 0)
  const doc = docWith([A, C]);
  const prep = prepareDeform(doc, [A.id], { x: 50, y: 0 }, 30, { joined: true, tol: 1e-6 });
  const next = applyDeform(prep, 0, 10);
  const c2 = get(next, C.id);
  ok(c2.nodes[0].x === 50 && Math.abs(c2.nodes[0].y - 10) < 1e-9, 'el extremo de la línea en T sigue al nodo compartido');
  ok(c2.nodes.length > 2 && c2.nodes[1].y > -10 && c2.nodes[1].y < 10, 'la vecina se curva junto (sin punta): su tramo se subdivide y sigue el gradiente');
  ok(get(applyDeform(prepareDeform(doc, [A.id], { x: 50, y: 0 }, 30, { joined: false, tol: 1e-6 }), 0, 10), C.id) === C, 'sin Move Joined la vecina no se mueve');
  // seleccionada la de la T: arrastra a A
  const a3 = get(applyDeform(prepareDeform(doc, [C.id], { x: 50, y: -5 }, 30, { joined: true, tol: 1e-6 }), 0, 10), A.id);
  ok(a3.nodes.some((n) => n.x === 50 && n.y > 5) && a3.nodes.length > 3, 'tomando la línea en T, la línea A se deforma con ella');
}
{
  // T de un dibujo anterior: la línea termina SOBRE el tramo, sin nodo común
  const A = line([[0, 0], [100, 0]]);
  const C = line([[40, 0], [40, -80]]);
  const doc = docWith([A, C]);
  const next = applyDeform(prepareDeform(doc, [A.id], { x: 40, y: 0 }, 30, { joined: true, tol: 1e-6, nodeTol: 0.01 }), 0, 12);
  const c2 = get(next, C.id);
  const a2 = get(next, A.id);
  ok(Math.abs(c2.nodes[0].y - 12) < 1e-9 && a2.nodes.some((n) => n.x === 40 && Math.abs(n.y - 12) < 1e-9), 'una T sin nodo común se noda al empezar y se mueven juntas');
}

/* ================================================================= DRAG */
ok(dragWeight(0) === 1 && dragWeight(1) === 0 && dragWeight(0.5) > 0.4 && dragWeight(0.5) < 0.6, 'peso de Drag: 1 en el nodo, 0 al final');
{
  // línea abierta: por defecto llega a los extremos, que no se mueven
  const L = line(Array.from({ length: 11 }, (_, i) => [i * 10, 0]));
  const doc = docWith([L]);
  const prep = prepareDrag(doc, { id: L.id, ring: -1, index: 3 }, { reach: 1 });
  const out = get(applyDeform(prep, 0, 30), L.id);
  const y = out.nodes.map((n) => n.y);
  ok(y[3] === 30, 'el nodo tomado se mueve todo');
  ok(y[0] === 0 && y[10] === 0, 'los extremos quedan fijos');
  ok(y[2] < 30 && y[1] < y[2] && y[4] < 30 && y[5] < y[4] && y[9] > 0, 'los demás se mueven cada vez menos hacia cada extremo');
  ok(out.nodes.every((n, i) => n.x === i * 10), 'solo se mueven en la dirección del arrastre');
  // más localizado
  const loc = get(applyDeform(prepareDrag(doc, { id: L.id, ring: -1, index: 3 }, { reach: 0.3 }), 0, 30), L.id).nodes.map((n) => n.y);
  ok(loc[3] === 30 && loc[7] === 0 && loc[8] === 0 && loc[5] < y[5], 'con menos alcance el movimiento es más localizado');
}
{
  // anillo cerrado: el punto opuesto queda fijo
  const P = poly(Array.from({ length: 8 }, (_, i) => [Math.cos((i * Math.PI) / 4) * 50, Math.sin((i * Math.PI) / 4) * 50]));
  const doc = docWith([P]);
  const out = get(applyDeform(prepareDrag(doc, { id: P.id, ring: -1, index: 0 }, { reach: 1 }), 20, 0), P.id);
  ok(Math.abs(out.nodes[0].x - (P.nodes[0].x + 20)) < 1e-9 && out.nodes[4].x === P.nodes[4].x, 'polígono: el nodo opuesto queda fijo');
  ok(Math.abs(out.nodes[1].x - out.nodes[7].x) < 1e-9 && out.nodes[2].x !== P.nodes[2].x, 'simétrico hacia ambos lados');
}
{
  // dos polígonos que comparten borde: Move Joined mantiene el cierre
  const A2 = poly([[0, 0], [50, 0], [100, 0], [100, 50], [100, 100], [50, 100], [0, 100]]);
  const B2 = poly([[100, 0], [200, 0], [200, 100], [100, 100], [100, 50]]);
  const doc = docWith([A2, B2]);
  const prep = prepareDrag(doc, { id: A2.id, ring: -1, index: 3 }, { reach: 1, ids: [A2.id], joined: true, tol: 1e-6 });
  const next = applyDeform(prep, 30, 0);
  const b2 = get(next, B2.id);
  ok(b2.nodes[4].x === 130, 'el nodo compartido de B sigue al de A');
  ok(sharedOkWith(next, A2.id), 'siguen compartiendo el borde (sin gap)');
  const off = applyDeform(prepareDrag(doc, { id: A2.id, ring: -1, index: 3 }, { reach: 1, ids: [A2.id], joined: false, tol: 1e-6 }), 30, 0);
  ok(get(off, B2.id) === B2, 'sin Move Joined y sin seleccionarla, B no se mueve');
  const both = applyDeform(prepareDrag(doc, { id: A2.id, ring: -1, index: 3 }, { reach: 1, ids: [A2.id, B2.id], joined: false, tol: 1e-6 }), 30, 0);
  ok(get(both, B2.id).nodes[4].x === 130, 'seleccionadas juntas se mueven juntas aunque Move Joined esté apagado');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
