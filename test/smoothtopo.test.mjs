/**
 * Suavizado con topología: los nodos compartidos se suavizan juntos y no se
 * pierde el cierre (sin huecos ni solapes entre polígonos vecinos).
 *
 *   node test/smoothtopo.test.mjs
 */

import { buildTopology, simplifyArc, smoothArcLevel, smoothTopology } from '../src/smoothTopo.js';
import { tidyShapes } from '../src/tidy.js';
import { smoothAlong } from '../src/smoothTool.js';
import { flattenNodes, makeNode, makePath } from '../src/vector.js';
import { addShapes, allTopShapes, newDocument, updateLayer } from '../src/doc.js';

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
const poly = (pts, extra = {}) => makePath(pts.map(([x, y]) => N(x, y)), { closed: true, ...extra });
const line = (pts) => makePath(pts.map(([x, y]) => N(x, y)));
const base = newDocument();
const layerId = base.activeLayerId;
const docWith = (shapes) => addShapes(base, layerId, shapes);
const get = (doc, id) => allTopShapes(doc, { visibleOnly: false }).find((x) => x.shape.id === id).shape;
const flat = (s) => flattenNodes(s.nodes, s.closed, 0.01);
const TOL = 0.2;

// Vecinos A (izquierda) y B (derecha) con un borde común en zigzag x=100, y de 0 a 100
const zig = [[100, 0], [104, 20], [96, 40], [104, 60], [96, 80], [100, 100]];
const A = poly([[0, 0], ...zig, [0, 100]]);
const B = poly([[200, 0], [200, 100], ...zig.slice().reverse()]); // recorre el borde común al revés
const wiggle = 6;
// el borde exterior de A también tiene detalle para que se suavice
A.nodes.splice(1, 0, N(30, -wiggle), N(60, wiggle));

const sharedFlat = (doc) => {
  // puntos del borde común vistos desde A: desde (100,0) hasta (100,100)
  const f = flat(get(doc, A.id));
  const i0 = f.findIndex(([x, y]) => x === 100 && y === 0);
  const i1 = f.findIndex(([x, y]) => x === 100 && y === 100);
  return f.slice(i0, i1 + 1);
};
const onPolyline = (p, pl, e = 1e-6) => {
  for (let i = 0; i + 1 < pl.length; i++) {
    const [ax, ay] = pl[i];
    const [bx, by] = pl[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const L = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((p[0] - ax) * dx + (p[1] - ay) * dy) / L));
    if (Math.hypot(p[0] - (ax + t * dx), p[1] - (ay + t * dy)) < e) return true;
  }
  return false;
};

/* ----------------------------------------- A y B comparten un borde */
{
  const doc = docWith([A, B]);
  const topo = buildTopology(doc, [A.id], TOL);
  ok(topo.sharesNodes, 'detecta que A comparte nodos con B');
  ok([...topo.arcs.values()].some((a) => a.members.length === 2), 'el borde común es un solo arco usado por los dos');

  const next = smoothTopology(topo, doc, (nodes, closed) => smoothArcLevel(nodes, closed, 70, 0.5));
  ok(next !== doc, 'se suavizó algo');
  const a2 = get(next, A.id);
  const b2 = get(next, B.id);
  ok(b2 !== B, 'B, que no estaba seleccionada, se actualiza porque comparte el borde');
  ok(a2.closed && b2.closed, 'siguen cerrados');

  // sin gaps: el borde común visto desde A está completo sobre el contorno de B
  const shared = sharedFlat(next);
  const fb = flat(b2);
  ok(shared.length > 4 && shared.every((p) => onPolyline(p, [...fb, fb[0]])), 'el borde común coincide en A y B tras suavizar');
  ok(sharedFlat(next).length !== sharedFlat(doc).length || a2.nodes.some((n) => n.hOut), 'el borde común se suavizó (ahora con curvas)');

  // los extremos del borde común (nodos de unión) no se mueven
  const has = (s, x, y) => s.nodes.some((n) => Math.hypot(n.x - x, n.y - y) < 1e-6);
  ok(has(a2, 100, 0) && has(a2, 100, 100) && has(b2, 100, 0) && has(b2, 100, 100), 'los nodos de unión quedan en su sitio');

  // la topología sigue siendo la misma: un arco común, dos miembros
  const again = buildTopology(next, [A.id], 0.05);
  ok([...again.arcs.values()].filter((a) => a.members.length === 2).length === 1, 'tras suavizar siguen compartiendo exactamente un arco');

  // el resto de B (borde exterior propio) no se suaviza: B no estaba seleccionada
  ok(b2.nodes.some((n) => n.x === 200 && n.y === 100) && b2.nodes.some((n) => n.x === 200 && n.y === 0), 'el contorno propio de B queda intacto');
}

/* ----------------------------------------- seleccionados los dos */
{
  const doc = docWith([A, B]);
  const topo = buildTopology(doc, [A.id, B.id], TOL);
  const next = smoothTopology(topo, doc, (nodes, closed) => smoothArcLevel(nodes, closed, 60, 0.5));
  const shared = sharedFlat(next);
  const fb = flat(get(next, B.id));
  ok(shared.every((p) => onPolyline(p, [...fb, fb[0]])), 'seleccionados juntos: el borde común sigue idéntico');
  const arcs = [...topo.arcs.values()];
  ok(arcs.length === 3, `A y B se parten en 3 arcos (común, A, B): ${arcs.length}`);
}

/* ----------------------------------------- forma bloqueada */
{
  const locked = { ...B, locked: true };
  const doc = docWith([A, locked]);
  const topo = buildTopology(doc, [A.id], TOL);
  const next = smoothTopology(topo, doc, (nodes, closed) => smoothArcLevel(nodes, closed, 70, 0.5));
  const a2 = get(next, A.id);
  const f = flat(a2);
  const fb = flat(locked);
  const i0 = f.findIndex(([x, y]) => x === 100 && y === 0);
  const i1 = f.findIndex(([x, y]) => x === 100 && y === 100);
  ok(get(next, B.id) === locked, 'la forma bloqueada no se toca');
  ok(f.slice(i0, i1 + 1).every((p) => onPolyline(p, [...fb, fb[0]])), 'el borde compartido con la bloqueada se deja como estaba (sin gap)');
  ok(a2 !== A, 'lo propio de A sí se suaviza');
}

/* ----------------------------------------- línea que termina en un vértice */
{
  const P = poly([[0, 0], [10, 3], [20, -3], [30, 3], [40, 0], [40, 40], [0, 40]]);
  const L = line([[20, -3], [20, -30]]); // toca el vértice (20,-3) de P
  const doc = docWith([P, L]);
  const topo = buildTopology(doc, [P.id], TOL);
  ok(topo.sharesNodes, 'una línea que toca un vértice cuenta como compartir');
  const next = smoothTopology(topo, doc, (nodes, closed) => smoothArcLevel(nodes, closed, 80, 0.5));
  const p2 = get(next, P.id);
  ok(p2.nodes.some((n) => Math.hypot(n.x - 20, n.y + 3) < 1e-9), 'el vértice donde toca la línea no se mueve');
  ok(p2.nodes.length !== P.nodes.length || p2.nodes.some((n) => n.hOut), 'el resto del polígono sí se suaviza');
  ok(get(next, L.id) === L, 'la línea no cambia (su arco no es de la selección)');
}

/* ----------------------------------------- sin compartir */
{
  const Q = poly([[0, 0], [10, 4], [20, -4], [30, 4], [40, 0], [40, 40], [0, 40]]);
  const R = poly([[500, 500], [510, 500], [510, 510]]);
  const doc = docWith([Q, R]);
  const topo = buildTopology(doc, [Q.id], TOL);
  ok(!topo.sharesNodes && topo.arcs.size === 2, 'sin nodos en común: no hay compartido');
  const next = smoothTopology(topo, doc, (nodes, closed) => smoothArcLevel(nodes, closed, 70, 0.5));
  const q2 = get(next, Q.id);
  ok(q2.closed && q2.nodes.length >= 3 && get(next, R.id) === R, 'un polígono suelto se suaviza entero como siempre');
}

/* ----------------------------------------- pincel sobre el borde común */
{
  const doc = docWith([A, B]);
  const topo = buildTopology(doc, [A.id], TOL);
  const brush = [[98, 38], [102, 42]];
  const o = { radius: 25, tol: 0.5, level: 70, flat: 0.5 };
  const next = smoothTopology(topo, doc, (nodes, closed) => smoothAlong(nodes, closed, brush, o));
  ok(next !== doc, 'el pincel modifica el borde común');
  const shared = sharedFlat(next);
  const fb = flat(get(next, B.id));
  ok(shared.every((p) => onPolyline(p, [...fb, fb[0]])), 'con el pincel el borde común sigue idéntico en A y B');
  const touched = flat(get(next, A.id)).length;
  ok(touched > 0 && get(next, A.id).closed && get(next, B.id).closed, 'siguen cerrados');
}

/* ----------------------------------------- polígono con hueco compartido */
{
  const hole = [[40, 40], [40, 60], [60, 60], [60, 40]].map(([x, y]) => N(x, y));
  const O = poly([[0, 0], [100, 0], [100, 100], [0, 100]], { holes: [hole] });
  // isla que llena el hueco: comparte el anillo del hueco entero
  const island = poly([[40, 40], [60, 40], [60, 60], [40, 60]]);
  island.nodes.splice(1, 0, N(50, 37));
  hole.splice(1, 0, N(50, 37)); // hueco con el mismo nodo extra: en el mismo orden inverso
  const doc = docWith([O, island]);
  const topo = buildTopology(doc, [island.id], TOL);
  ok(topo.sharesNodes, 'la isla comparte el anillo del hueco');
  const next = smoothTopology(topo, doc, (nodes, closed) => smoothArcLevel(nodes, closed, 80, 0.5));
  const o2 = get(next, O.id);
  const i2 = get(next, island.id);
  ok(o2.holes.length === 1 && i2.closed, 'hueco e isla siguen cerrados');
  const fi = flat(i2);
  const fh = flattenNodes(o2.holes[0], true, 0.01);
  ok(fi.every((p) => onPolyline(p, [...fh, fh[0]])), 'el hueco y la isla siguen coincidiendo');
}

/* ================================================================= SIMPLIFICAR */
{
  // línea casi recta con ruido: se reduce y no se aleja más que la tolerancia
  const pts = Array.from({ length: 60 }, (_, i) => [i * 5, Math.sin(i / 6) * 20 + (i % 2 ? 0.3 : -0.3)]);
  const L = line(pts);
  const s2 = simplifyArc(L.nodes, false, 1);
  ok(s2 && s2.length < L.nodes.length / 3, `reduce los nodos: ${L.nodes.length} → ${s2?.length}`);
  ok(s2[0].x === 0 && s2.at(-1).x === pts.at(-1)[0], 'los extremos se conservan');
  const maxDev = Math.max(...pts.map(([x, y]) => onPolyline([x, y], s2.map((n) => [n.x, n.y]), 1.0001) ? 0 : 1));
  ok(maxDev === 0, 'ningún punto original queda a más de la tolerancia');
  ok(simplifyArc(line([[0, 0], [10, 0]]).nodes, false, 1) === null, 'una línea de dos nodos no se toca');
  ok(simplifyArc(L.nodes, false, 1, { curves: true }).slice(1, -1).every((n) => n.hIn && n.hOut), 'con curvas, los nodos que quedan son de curva');

  // dos polígonos con borde común detallado: se simplifica igual en ambos
  const wav = Array.from({ length: 21 }, (_, i) => [100 + (i % 2) * 0.4, i * 5]);
  const P1 = poly([[0, 0], ...wav, [0, 100]]);
  const P2 = poly([[200, 0], [200, 100], ...wav.slice().reverse()]);
  const doc = docWith([P1, P2]);
  const topo = buildTopology(doc, [P1.id], TOL);
  const next = smoothTopology(topo, doc, (nodes, closed) => simplifyArc(nodes, closed, 1));
  const a2 = get(next, P1.id);
  const b2 = get(next, P2.id);
  ok(a2.nodes.length < P1.nodes.length && b2.nodes.length < P2.nodes.length, 'el borde común se simplifica en los dos');
  ok([...buildTopology(next, [P1.id], 1e-6).arcs.values()].some((a) => a.members.length === 2), 'y lo siguen compartiendo');
}

/* ================================================================= TIDY */
{
  // dos polígonos dibujados a ojo: casi comparten el borde
  const P1 = poly([[0, 0], [100.3, 0.2], [99.8, 50], [100.2, 100], [0, 100]]);
  const P2 = poly([[100, 0], [200, 0], [200, 100], [99.9, 100.1]]); // sin nodo en (100,50)
  const doc = docWith([P1, P2]);
  const r = tidyShapes(doc, [P1.id, P2.id], 1);
  ok(r.merged >= 2, `fusiona los vértices cercanos: ${r.merged}`);
  ok(r.inserted >= 1, `inserta en el vecino el nodo que cae sobre su borde: ${r.inserted}`);
  const a2 = get(r.doc, P1.id);
  const b2 = get(r.doc, P2.id);
  const key = (n) => `${n.x.toFixed(9)},${n.y.toFixed(9)}`;
  const ka = new Set(a2.nodes.map(key));
  const shared = b2.nodes.filter((n) => ka.has(key(n)));
  ok(shared.length === 3, `comparten los tres nodos del borde: ${shared.length}`);
  ok([...buildTopology(r.doc, [P1.id], 1e-9).arcs.values()].some((a) => a.members.length === 2), 'el borde común es un arco compartido');
  ok(a2.closed && b2.closed && a2.nodes.length === 5 && b2.nodes.length === 5, 'siguen cerrados, sin nodos repetidos');
  // umbral chico: no hace nada
  const none = tidyShapes(doc, [P1.id, P2.id], 0.05);
  ok(none.merged === 0 && none.inserted === 0 && none.doc === doc, 'con un umbral más chico que la separación no cambia nada');
  // nodos del mismo trazo no se fusionan entre sí
  const Z = line([[0, 0], [0.2, 0], [50, 0]]);
  ok(tidyShapes(docWith([Z]), [Z.id], 1).doc === docWith([Z]) || get(tidyShapes(docWith([Z]), [Z.id], 1).doc, Z.id).nodes.length === 3, 'no colapsa nodos del mismo trazo');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
