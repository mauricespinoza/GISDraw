/** node test/georef.test.mjs */
import { solveGeoref, fitTransform, warpToUtm, solve } from '../src/georef.js';

let pass = 0;
let fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.error('✗', m)));
const near = (a, b, t, m) => ok(Math.abs(a - b) <= t, `${m}: ${a} ≠ ${b}`);

// imagen 1000×800 escaneada a 5 m/píxel, girada 3°, esquina en (340000, 6305000)
const ang = (3 * Math.PI) / 180;
const truth = ([c, r]) => {
  const x = c * 5;
  const y = -r * 5;
  return [340000 + x * Math.cos(ang) - y * Math.sin(ang), 6305000 + x * Math.sin(ang) + y * Math.cos(ang)];
};
const pts = [[0, 0], [1000, 0], [1000, 800], [0, 800], [500, 400], [250, 600], [800, 150]];
const gcps = pts.map((p) => ({ src: p, dst: truth(p) }));

for (const kind of ['helmert', 'affine', 'poly2', 'tps']) {
  const s = solveGeoref(gcps, kind);
  near(s.rms, 0, 1e-4, `${kind}: RMS nulo con puntos exactos`);
  const q = s.forward([123, 456]);
  const t = truth([123, 456]);
  near(q[0], t[0], 1e-3, `${kind}: directa x`);
  near(q[1], t[1], 1e-3, `${kind}: directa y`);
  const back = s.inverse(t);
  near(back[0], 123, 1e-3, `${kind}: inversa col`);
  near(back[1], 456, 1e-3, `${kind}: inversa fila`);
}

// un punto con error: el residuo aparece en ese punto (afín), no en TPS
const bad = gcps.map((g, i) => (i === 4 ? { ...g, dst: [g.dst[0] + 30, g.dst[1]] } : g));
const af = solveGeoref(bad, 'affine');
ok(af.residuals[4].d > af.residuals[0].d, 'afín: el punto malo tiene el mayor residuo');
ok(af.rms > 5, 'afín: RMS refleja el error');
const tp = solveGeoref(bad, 'tps');
near(tp.rms, 0, 1e-3, 'TPS pasa exacto por todos los puntos');
// desactivar el punto malo
const off = solveGeoref(bad.map((g, i) => (i === 4 ? { ...g, on: false } : g)), 'affine');
near(off.rms, 0, 1e-4, 'punto desactivado no entra al ajuste');
ok(off.residuals[4].d > 25, 'pero su residuo se sigue informando');

let threw = false;
try {
  solveGeoref(gcps.slice(0, 2), 'affine');
} catch {
  threw = true;
}
ok(threw, 'afín con 2 puntos se rechaza');
near(solve([[2, 1], [1, 3]], [3, 5])[1], 1.4, 1e-12, 'sistema lineal');

// remuestreo: imagen 4×4 roja, salida con píxeles opacos
const img = { data: new Uint8ClampedArray(4 * 4 * 4).map((_, i) => (i % 4 === 0 || i % 4 === 3 ? 255 : 0)) };
const sol = solveGeoref([{ src: [0, 0], dst: [0, 40] }, { src: [4, 0], dst: [40, 40] }, { src: [0, 4], dst: [0, 0] }], 'affine');
const wr = warpToUtm(img, 4, 4, sol);
ok(wr.w === 4 && wr.h === 4 && Math.abs(wr.cell - 10) < 1e-9, `remuestreo a 10 m (${wr.w}×${wr.h}, ${wr.cell})`);
ok(wr.rgba[0] === 255 && wr.rgba[3] === 255, 'píxel copiado');

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLARON` : ''}`);
if (fail) process.exit(1);
