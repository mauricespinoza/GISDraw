/**
 * La vista y su rotación (gesto de dos dedos en tableta).
 *
 *   node test/view.test.mjs
 */

import { View } from '../src/view.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

const v = new View(800, 600);
ok(v.rot === 0 && v.w === 800 && v.h === 600, 'sin rotación: escenario = pantalla');
ok(near(v.hostToStage(123, 45)[0], 123) && near(v.hostToStage(123, 45)[1], 45), 'sin rotación: pantalla = escenario');

// girar 90° alrededor del centro: el escenario pasa a medir la diagonal
v.rotateAt(90);
ok(v.rot === 90 && v.w === 1000 && v.h === 1000, 'girado: el escenario mide la diagonal');
const [sx, sy] = v.hostToStage(400, 100); // arriba al centro de la pantalla
const [hx, hy] = v.stageToHost(sx, sy);
ok(near(hx, 400) && near(hy, 100), 'hostToStage y stageToHost son inversas');

// el punto de la pantalla que se usa de pivote no se mueve sobre el mapa
const w = new View(800, 600);
const pivot = [650, 120];
const before = w.toWorld(...w.hostToStage(...pivot));
w.rotateAt(33, ...pivot);
const after = w.toWorld(...w.hostToStage(...pivot));
ok(near(before[0], after[0], 1e-4) && near(before[1], after[1], 1e-4), 'el pivote del giro queda fijo');
ok(near(w.rot, 33), 'rotación acumulada');

// una vuelta completa vuelve al norte
w.rotateAt(327, ...pivot);
ok(w.rot === 0 && w.w === 800, 'a 360° queda sin rotación');
const back = w.toWorld(...w.hostToStage(...pivot));
ok(near(before[0], back[0], 1e-4) && near(before[1], back[1], 1e-4), 'tras volver al norte el mapa está donde estaba');

// resetRotation endereza sobre el centro
const r = new View(500, 500);
r.rotateAt(-40, 100, 100);
r.resetRotation();
ok(r.rot === 0, 'resetRotation deja el norte arriba');

// el rango se normaliza a (-180, 180]
const n = new View(100, 100);
n.setRot(270);
ok(n.rot === -90, 'normaliza 270° a -90°');

console.log(`view: ${pass} ok, ${fail} fallos`);
process.exit(fail ? 1 : 0);
