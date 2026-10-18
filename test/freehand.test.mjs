/**
 * Trazo libre: suavizado del lápiz (0–100 %) y re-suavizado de un trazo recién dibujado.
 *
 *   node test/freehand.test.mjs
 */

import { DEFAULT_SMOOTH, canResmooth, freehandParams, freehandToNodes, makePath, nodesSignature, resmooth } from '../src/vector.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}

// una mano temblorosa dibujando una curva: seno con ruido determinista
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
const raw = Array.from({ length: 300 }, (_, i) => ({ x: 346000 + i * 0.5, y: 6297000 + 20 * Math.sin(i / 25) + rnd() * 1.2 }));
const mpp = 0.5;

ok(DEFAULT_SMOOTH === 50, 'suavizado por defecto 50 %');
const p0 = freehandParams(0);
const p50 = freehandParams(50);
const p100 = freehandParams(100);
ok(p0.tension === 0 && p0.passes === 0 && p0.tolerance < 0.3, 'nivel 0: sin curvatura ni promedio, tolerancia mínima');
ok(Math.abs(p50.tension - 0.25) < 1e-9 && p50.tolerance > 1.2 && p50.tolerance < 2, `nivel 50 ≈ el comportamiento anterior (tensión 0,25, ~1,5 px): ${p50.tension}, ${p50.tolerance}`);
ok(p100.tension === 0.5 && p100.passes === 6 && p100.tolerance > 9, 'nivel 100: máximo');
ok(freehandParams(-5).tension === 0 && freehandParams(500).tension === 0.5 && freehandParams('x').tension === 0, 'niveles fuera de rango o inválidos se acotan');

// más suavizado → menos nodos y trazo menos nervioso
const turning = (nodes) => {
  let t = 0;
  for (let i = 1; i < nodes.length - 1; i++) {
    const a = Math.atan2(nodes[i].y - nodes[i - 1].y, nodes[i].x - nodes[i - 1].x);
    const b = Math.atan2(nodes[i + 1].y - nodes[i].y, nodes[i + 1].x - nodes[i].x);
    t += Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
  }
  return t;
};
const n0 = freehandToNodes(raw, 0, mpp);
const n50 = freehandToNodes(raw, 50, mpp);
const n100 = freehandToNodes(raw, 100, mpp);
ok(n0.length > n50.length && n50.length > n100.length, `menos nodos al suavizar más: ${n0.length} > ${n50.length} > ${n100.length}`);
ok(turning(n0) > turning(n100), 'el trazo se vuelve menos nervioso');
ok(n0.every((n) => !n.hIn && !n.hOut), 'nivel 0: segmentos rectos');
ok(n100.slice(1, -1).every((n) => n.hIn && n.hOut && n.smooth), 'nivel 100: nodos con manijas');
ok(n100[0].x === raw[0].x && n100[0].y === raw[0].y && n100[n100.length - 1].x === raw[299].x && n100[n100.length - 1].y === raw[299].y, 'los extremos del trazo abierto no se mueven');
ok(JSON.stringify(freehandToNodes(raw, 50, mpp)) === JSON.stringify(n50), 'determinista');

// sin lazos: ninguna manija pasa de la mitad del segmento vecino (en un Catmull-Rom con pocos puntos sí)
const tight = (nodes) => nodes.every((n, i) => (!n.hOut || i === nodes.length - 1 || Math.hypot(n.hOut.x - n.x, n.hOut.y - n.y) <= 0.5 * Math.hypot(nodes[i + 1].x - n.x, nodes[i + 1].y - n.y) + 1e-9) && (!n.hIn || i === 0 || Math.hypot(n.hIn.x - n.x, n.hIn.y - n.y) <= 0.5 * Math.hypot(nodes[i - 1].x - n.x, nodes[i - 1].y - n.y) + 1e-9));
ok(tight(n100) && tight(n50), 'las manijas no sobrepasan el segmento vecino');
// y la tangente en cada nodo es una sola recta (nodo suave)
ok(n100.slice(1, -1).every((n) => Math.abs((n.hIn.x - n.x) * (n.hOut.y - n.y) - (n.hIn.y - n.y) * (n.hOut.x - n.x)) < 1e-6), 'manijas alineadas');

// la tolerancia depende de los metros por píxel de cuando se dibujó
ok(freehandToNodes(raw, 50, 2).length < n50.length, 'a otro zoom, otra tolerancia');

// forma cerrada
const circle = Array.from({ length: 80 }, (_, i) => ({ x: 100 * Math.cos((i / 80) * 2 * Math.PI) + rnd(), y: 100 * Math.sin((i / 80) * 2 * Math.PI) + rnd() }));
const nc = freehandToNodes(circle, 60, 1, true);
ok(nc.length >= 3 && nc.every((n) => n.hIn && n.hOut), 'cerrado: todos los nodos con manijas (sin extremos)');

// re-suavizar un trazo recién dibujado
const nodes = freehandToNodes(raw, 50, mpp);
const shape = makePath(nodes, { closed: false });
shape.freehand = { pts: raw, mpp, closed: false, level: 50, sig: nodesSignature(nodes) };
ok(canResmooth(shape), 'recién dibujado: se puede re-suavizar');
const more = resmooth(shape, 90);
ok(more.nodes.length < shape.nodes.length && more.freehand.level === 90 && canResmooth(more), 'suavizar más: menos nodos y sigue siendo re-suavizable');
const back = resmooth(more, 50);
ok(JSON.stringify(back.nodes) === JSON.stringify(shape.nodes), 'volver al nivel anterior da el mismo trazo');
ok(shape.nodes.length === nodes.length, 'resmooth no modifica el original');
const moved = { ...shape, nodes: shape.nodes.map((n) => ({ ...n, x: n.x + 5 })) };
ok(!canResmooth(moved), 'trazo movido: ya no se re-suaviza');
const edited = { ...shape, nodes: shape.nodes.map((n, i) => (i === 3 ? { ...n, hOut: { x: n.x + 1, y: n.y + 9 } } : n)) };
ok(!canResmooth(edited), 'manija editada: ya no se re-suaviza');
ok(!canResmooth(makePath(nodes)) && !canResmooth(null), 'sin datos de trazo libre: no');

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
