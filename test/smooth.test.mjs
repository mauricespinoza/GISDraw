/**
 * Herramienta Suavizar (pincel): solo se suaviza el sector bajo el pincel.
 *
 *   node test/smooth.test.mjs
 */

import { smoothAlong, smoothParams } from '../src/smoothTool.js';
import { makeNode } from '../src/vector.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}

// trazo de mano temblorosa: una onda de 200 de largo con ruido, 81 nodos
let seed = 3;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
const wave = (x) => 20 * Math.sin(x / 30);
const zig = Array.from({ length: 81 }, (_, i) => makeNode(i * 2.5, wave(i * 2.5) + rnd() * 5));
const o = { radius: 12, tol: 0.4, level: 60 };
const rough = (nodes, x0, x1) => {
  const pts = nodes.filter((n) => n.x > x0 && n.x < x1);
  return pts.reduce((a, n) => a + Math.abs(n.y - wave(n.x)), 0) / Math.max(1, pts.length);
};

// pincel sobre el sector central
const out = smoothAlong(zig, false, [[90, 0], [110, 0]], o);
ok(out && out.length < zig.length, `reduce nodos: ${zig.length} → ${out?.length}`);
// fuera del sector los nodos son los mismos objetos y en el mismo orden
const head = out.slice(0, 10);
ok(head.every((n, i) => n === zig[i]), 'el inicio del trazo queda intacto');
const tail = out.slice(-10);
ok(tail.every((n, i) => n === zig[zig.length - 10 + i]), 'el final del trazo queda intacto');
ok(out.some((n) => n.hIn || n.hOut), 'el sector queda con curvas');
// el sector queda más cerca de la onda (menos ruido)
ok(rough(out, 85, 115) < rough(zig, 85, 115), `el sector tiene menos ruido (${rough(out, 85, 115).toFixed(2)} < ${rough(zig, 85, 115).toFixed(2)})`);
// los extremos del sector siguen siendo continuos con lo de afuera
ok(out.every((n, i) => i === 0 || n.x >= out[i - 1].x - 1e-9), 'x sigue creciendo: sin retrocesos');

// pincel lejos del trazo: nada
ok(smoothAlong(zig, false, [[90, 120]], o) === null, 'pincel lejos: null');
ok(smoothAlong(zig.slice(0, 2), false, [[0, 0]], o) === null, 'menos de 3 nodos: null');

// pasar de nuevo suaviza más
let again = out;
for (let k = 0; k < 3; k++) again = smoothAlong(again, false, [[90, 0], [110, 0]], o) || again;
ok(rough(again, 85, 115) <= rough(out, 85, 115) + 0.5 && again.length <= out.length, 'varias pasadas: igual o más liso, con igual o menos nodos');

// el pincel sobre el principio de una línea abierta conserva el primer nodo
const start = smoothAlong(zig, false, [[0, 0], [15, 0]], o);
ok(start && start[0].x === 0 && start[0].y === zig[0].y, 'el primer nodo no se mueve');
ok(start[start.length - 1] === zig[zig.length - 1], 'y el último tampoco');

// polígono de contorno tembloroso: 72 nodos en un círculo de radio 100
const ring = Array.from({ length: 72 }, (_, i) => {
  const a = (i / 72) * 2 * Math.PI;
  const r = 100 + rnd() * 3;
  return makeNode(r * Math.cos(a), r * Math.sin(a));
});
const whole = smoothAlong(ring, true, [[0, 0]], { radius: 200, tol: 0.4, level: 70 });
ok(whole && whole.length >= 3 && whole.length < ring.length, `anillo entero: ${ring.length} → ${whole?.length}`);
ok(whole.every((n) => n.hIn && n.hOut), 'anillo cerrado: todos los nodos con manijas');

// un sector que no cruza el nodo 0 (arriba, en y ≈ 100)
const part = smoothAlong(ring, true, [[-25, 100], [25, 100]], { radius: 15, tol: 0.4, level: 60 });
ok(part && part.length < ring.length, `sector de un polígono: ${ring.length} → ${part?.length}`);
ok(part.filter((n) => ring.includes(n)).length >= ring.length - 22, 'el resto del anillo queda igual');
ok(part.filter((n) => ring.includes(n)).length >= 40, 'la mayor parte del anillo conserva sus nodos');

// sector que cruza el nodo 0 (la corrida envuelve el final y el inicio del anillo: el nodo 0 está en x = 100, y = 0)
const wrap = smoothAlong(ring, true, [[100, -20], [100, 20]], { radius: 12, tol: 0.4, level: 60 });
ok(wrap && wrap.length < ring.length && wrap.length >= 3, `sector que envuelve el nodo 0: ${ring.length} → ${wrap?.length}`);
ok(wrap.filter((n) => ring.includes(n)).length >= 40, 'y conserva los nodos de afuera');
// el anillo sigue girando en el mismo sentido (área con signo igual)
const area = (nodes) => nodes.reduce((a, p, i) => a + (p.x * nodes[(i + 1) % nodes.length].y - nodes[(i + 1) % nodes.length].x * p.y), 0) / 2;
ok(area(wrap) > 0 && area(part) > 0 && area(whole) > 0 && Math.abs(area(wrap) - area(ring)) / area(ring) < 0.02, 'mismo sentido y casi la misma área');

// parámetros
const p10 = smoothParams(10);
const p100 = smoothParams(100);
ok(p10.passes < p100.passes && p10.tolPx < p100.tolPx && p10.tension < p100.tension, 'más intensidad, más de todo');

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
