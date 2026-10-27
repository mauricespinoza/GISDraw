/**
 * Diálogo Transformar (mover, rotar, escalar con valores exactos) y lectura
 * de coordenadas escritas a mano (Ir a coordenadas, puntos de control).
 *
 *   node test/transform.test.mjs
 */

import { transformShapes, reflectShapes } from '../src/ops.js';
import { makeGroup, makeNode, makePath, makeRectPath, makeText, reflectShape, scaleShape, scaleSizes, shapeBBox } from '../src/vector.js';
import { defaultStyle } from '../src/style.js';
import { newDocument, addShapes, History } from '../src/doc.js';
import { parseCoordText, fromLonLat } from '../src/proj.js';

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

const base = newDocument();
const layerId = base.activeLayerId;
const items = (doc) => doc.layers.find((l) => l.id === layerId).items;
const a = makeRectPath(0, 0, 10, 10, { ...defaultStyle(), strokeWidth: 0.5 });
const b = makeRectPath(20, 0, 30, 10, { ...defaultStyle(), strokeWidth: 1 });
const doc = addShapes(base, layerId, [a, b]);

/* ------------------------------------------------------------- mover */
{
  const d = transformShapes(doc, [a.id], { dx: 5, dy: -2 });
  const bb = shapeBBox(items(d)[0]);
  ok(near(bb.x, 5) && near(bb.y, -2) && near(bb.w, 10), 'mover desplaza sin deformar');
  ok(items(d)[1] === b, 'lo no seleccionado no cambia');
  ok(transformShapes(doc, [a.id], {}) === doc, 'sin cambios devuelve el mismo documento');
}

/* ------------------------------------------------------------- escalar */
{
  const d = transformShapes(doc, [a.id, b.id], { sx: 2, sy: 2 });
  const all = items(d).map((s) => shapeBBox(s));
  ok(near(all[0].x, -15) && near(all[1].x + all[1].w, 45), 'escala desde el centro de la selección');
  ok(near(all[0].w, 20), 'escala 200 % duplica el ancho');
  const e = transformShapes(doc, [a.id, b.id], { sx: 2, sy: 2, pivot: 'each' });
  ok(near(shapeBBox(items(e)[0]).x, -5), 'escala desde el centro de cada objeto');
  ok(items(d)[0].style.strokeWidth === 0.5, 'sin «escalar grosores» el trazo se mantiene');
  const f = transformShapes(doc, [a.id], { sx: 2, sy: 2, strokes: true });
  ok(near(items(f)[0].style.strokeWidth, 1), 'con «escalar grosores» el trazo crece igual');
  const g = transformShapes(doc, [a.id], { sx: 2, sy: 0.5 });
  const bg = shapeBBox(items(g)[0]);
  ok(near(bg.w, 20) && near(bg.h, 5), 'escala no uniforme');
}

/* ------------------------------------------------------------- rotar */
{
  const d = transformShapes(doc, [b.id], { angle: 90 });
  const bb = shapeBBox(items(d)[1]);
  ok(near(bb.x, 20) && near(bb.y, 0) && near(bb.w, 10), 'rotar un cuadrado 90° en su centro lo deja en su sitio');
  const n = items(d)[1].nodes[1];
  const n0 = b.nodes[1];
  ok(near(n.x - 25, -(n0.y - 5)) && near(n.y - 5, n0.x - 25), 'la rotación es antihoraria');
}

/* --------------------------------------------- historial: cancelar */
{
  const h = new History(doc);
  h.begin();
  h.preview(transformShapes(doc, [a.id], { dx: 3 }));
  h.cancel();
  ok(h.doc === doc && !h.past.length, 'cancelar el diálogo no deja rastro');
  h.begin();
  h.preview(transformShapes(doc, [a.id], { dx: 3 }));
  h.end();
  ok(h.past.length === 1 && h.undo() && h.doc === doc, 'aplicar es un solo deshacer');
}

/* -------------------------------------------------- coordenadas */
{
  const utm = parseCoordText('346000 6297000');
  ok(utm && utm[0] === 346000 && utm[1] === 6297000, 'E N en metros');
  const ll = parseCoordText('-33.45, -70.67');
  const ref = fromLonLat(-70.67, -33.45);
  ok(ll && near(ll[0], ref[0], 1e-3) && near(ll[1], ref[1], 1e-3), 'lat, lon decimales');
  const dms = parseCoordText('33°27\'S, 70°40\'W');
  const ref2 = fromLonLat(-(70 + 40 / 60), -(33 + 27 / 60));
  ok(dms && near(dms[0], ref2[0], 1e-3), 'lat, lon sexagesimales');
  ok(parseCoordText('') === null && parseCoordText('hola') === null && parseCoordText('-95, 10') === null, 'texto inválido → null');
}

/* ------------------------------------- escalar: también las medidas de papel */
{
  const st = { ...defaultStyle(), strokeWidth: 1, casing: true, casingWidth: 0.4, pattern: 'dots', patternSize: 5, ornament: 'triangle', ornamentSpacing: 6, waveAmp: 0.7, pointSize: 2 };
  const r = makeRectPath(0, 0, 10, 10, st);
  const t = makeText(5, 5, 'Fm', undefined, 10);
  const g = makeGroup([r, t]);
  const k = 2;
  const out = scaleSizes(scaleShape(g, { x: 0, y: 0 }, k, k), k);
  const [r2, t2] = out.children;
  ok(near(r2.style.strokeWidth, 2) && near(r2.style.casingWidth, 0.8) && near(r2.style.patternSize, 10) && near(r2.style.ornamentSpacing, 12), 'trazo, halo, trama y ornamentos ×2 en un grupo');
  ok(near(r2.style.waveAmp, 1.4) && near(r2.style.pointSize, 4), 'onda y punto ×2');
  ok(near(t2.fontSize, 20) && near(t2.haloWidth, 1.2), 'texto dentro de un grupo: letra y halo ×2');
  ok(near(shapeBBox(r2).w, 20), 'la geometría también ×2');
  ok(scaleSizes(r, 1) === r, 'k = 1 no toca nada');
  const dd = transformShapes(doc, [a.id], { sx: 2, sy: 2, strokes: true });
  ok(near(items(dd)[0].style.strokeWidth, 1), 'diálogo Transformar con la opción marcada');
}

{
  // reflejar: eje vertical, horizontal, diagonal y con ángulo
  const tri = makePath([makeNode(0, 0), makeNode(10, 0), makeNode(0, 4)], { closed: true, style: { ...defaultStyle(), ornament: 'thrust' } });
  const nd = newDocument();
  const L = nd.activeLayerId;
  const doc = addShapes(nd, L, [tri]);
  const get = (d) => d.layers.find((l) => l.id === L).items[0];
  const v = get(reflectShapes(doc, new Set([tri.id]), 'v'));
  ok(v.nodes[0].x === 10 && v.nodes[1].x === 0 && v.nodes[2].x === 10 && v.nodes[2].y === 4, 'reflejar ↔: x se invierte en el centro de la selección');
  ok(v.style.ornamentSide === 'right', 'reflejar cambia de lado los dientes del ornamento');
  const hz = get(reflectShapes(doc, new Set([tri.id]), 'h'));
  ok(hz.nodes[0].y === 4 && hz.nodes[2].y === 0 && hz.nodes[1].x === 10, 'reflejar ↕: y se invierte');
  const p = reflectShape(makeRectPath(2, 0, 3, 1), { x: 0, y: 0 }, 45);
  ok(Math.abs(p.nodes[0].x - 0) < 1e-9 && Math.abs(p.nodes[0].y - 2) < 1e-9, 'diagonal 45°: (x, y) → (y, x)');
  const twice = reflectShape(reflectShape(tri, { x: 3, y: 1 }, 30), { x: 3, y: 1 }, 30);
  ok(twice.nodes.every((n, i) => Math.abs(n.x - tri.nodes[i].x) < 1e-9 && Math.abs(n.y - tri.nodes[i].y) < 1e-9) && twice.style.ornamentSide === 'left', 'reflejar dos veces deja todo igual');
  const t = reflectShape({ ...makeText(5, 0, 'Falla'), rotation: -30 }, { x: 0, y: 0 }, 90);
  ok(t.x === -5 && Math.abs(t.rotation - 30) < 1e-9, 'texto: cambia de lugar y de inclinación, sigue legible');
  ok(reflectShape(makeText(5, 0, 'x'), { x: 0, y: 0 }, 90).rotation === 0, 'texto horizontal no queda cabeza abajo');
  const g = reflectShape(makeGroup([tri]), { x: 0, y: 0 }, 0);
  ok(g.children[0].nodes[2].y === -4, 'reflejar entra en grupos');
  const tr = get(transformShapes(doc, new Set([tri.id]), { reflect: 90, dx: 100 }));
  ok(tr.nodes[0].x === 110, 'Transformar: reflejo y luego desplazamiento');
}

{
  // en el lugar: cada objeto escala (tamaño y grosor) sobre su propio centro
  const a = makeRectPath(0, 0, 10, 10, { ...defaultStyle(), strokeWidth: 1 });
  const b = makeRectPath(100, 40, 120, 44, { ...defaultStyle(), strokeWidth: 0.5 });
  const nd = newDocument();
  const L = nd.activeLayerId;
  const doc = addShapes(nd, L, [a, b]);
  const out = transformShapes(doc, new Set([a.id, b.id]), { sx: 2, sy: 2, pivot: 'each', strokes: true }).layers.find((l) => l.id === L).items;
  const c = (s) => { const q = shapeBBox(s); return [q.x + q.w / 2, q.y + q.h / 2, q.w]; };
  ok(c(out[0]).every((v, i) => Math.abs(v - [5, 5, 20][i]) < 1e-9) && c(out[1]).every((v, i) => Math.abs(v - [110, 42, 40][i]) < 1e-9), 'en el lugar: el centro de cada objeto no se mueve y el tamaño se duplica');
  ok(out[0].style.strokeWidth === 2 && out[1].style.strokeWidth === 1, 'en el lugar: el grosor escala también');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
