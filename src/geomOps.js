/**
 * Operaciones sobre polígonos con JSTS: fusionar (Merge), dividir con una
 * línea (Split) y hacer huecos (Hole). Las líneas de unión (Join) están en
 * `ops.js`.
 *
 * Los trazos Bézier se aplanan para operar (la geometría booleana es de
 * polilíneas), así que un polígono con curvas queda con sus curvas hechas
 * de vértices. Cada operación devuelve `{ doc, ids }` o `{ error }`, como las
 * de `ops.js`, para que quien llama solo confirme el cambio.
 */

import { flattenNodes, flattenShape, makeNode, newId } from './vector.js';
import { allTopShapes } from './doc.js';
import { loadScript } from './io/loader.js';

export async function loadJsts() {
  if (!globalThis.jsts) await loadScript('vendor/jsts.min.js');
  if (!globalThis.jsts) throw new Error('JSTS no se cargó');
  return globalThis.jsts;
}

const toArray = (c) => (Array.isArray(c) ? c : c?.toArray ? Array.from(c.toArray()) : []);

/** Polígonos (cerrados, sin bloquear, en capas sin bloquear) elegidos, en el orden del dibujo (el de más abajo primero). */
function pickPolygons(doc, ids) {
  const out = [];
  for (const { layer, shape } of allTopShapes(doc, { visibleOnly: false })) {
    if (ids.has(shape.id) && shape.type === 'path' && shape.closed && !shape.locked && !layer.locked) out.push(shape);
  }
  return out;
}

/** Puntos de un anillo sin el cierre duplicado ni repetidos consecutivos. */
function cleanRing(pts) {
  const out = [];
  for (const p of pts) if (!out.length || Math.hypot(p[0] - out[out.length - 1][0], p[1] - out[out.length - 1][1]) > 1e-9) out.push([p[0], p[1]]);
  while (out.length > 1 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= 1e-9) out.pop();
  return out;
}

/** Polígono de JSTS de un trazo cerrado (con sus huecos). */
function polygonOf(J, shape, tol) {
  const gf = new J.geom.GeometryFactory();
  const C = (p) => new J.geom.Coordinate(p[0], p[1]);
  const ring = (pts) => {
    const r = cleanRing(pts);
    return gf.createLinearRing([...r, r[0]].map(C));
  };
  const rings = flattenShape(shape, tol);
  const outer = rings.find((r) => !r.hole) || rings[0];
  const holes = rings.filter((r) => r !== outer).map((r) => ring(r.pts));
  let poly = gf.createPolygon(ring(outer.pts), holes);
  if (!poly.isValid()) poly = poly.buffer(0); // autointersecciones: se corrigen
  return poly;
}

/** Polígono de JSTS de una lista de puntos [x, y] (anillo abierto o cerrado). */
function polygonOfPoints(J, pts) {
  const gf = new J.geom.GeometryFactory();
  const r = cleanRing(pts);
  let poly = gf.createPolygon(gf.createLinearRing([...r, r[0]].map((p) => new J.geom.Coordinate(p[0], p[1]))));
  if (!poly.isValid()) poly = poly.buffer(0);
  return poly;
}

/** Todos los polígonos (con área) de una geometría cualquiera. */
function polygonsOf(g, minArea = 1e-9) {
  const out = [];
  const walk = (x) => {
    if (!x || x.isEmpty()) return;
    const t = x.getGeometryType();
    if (t === 'Polygon') {
      if (x.getArea() > minArea) out.push(x);
    } else for (let i = 0; i < x.getNumGeometries(); i++) walk(x.getGeometryN(i));
  };
  walk(g);
  return out;
}

/** Quita vértices alineados con sus vecinos (la unión deja el rastro del borde común). */
function dropCollinear(pts, eps = 1e-7) {
  if (pts.length < 4) return pts;
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i - 1 + n) % n];
    const b = pts[i];
    const c = pts[(i + 1) % n];
    const cross = Math.abs((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0]));
    const base = Math.hypot(c[0] - a[0], c[1] - a[1]) || 1;
    const dot = (b[0] - a[0]) * (c[0] - a[0]) + (b[1] - a[1]) * (c[1] - a[1]);
    // alineado y ENTRE los vecinos (un pico agudo no es redundante)
    if (cross / base <= eps && dot > 0 && dot < base * base) continue;
    out.push(b);
  }
  return out.length >= 3 ? out : pts;
}

const ringPts = (lr) => dropCollinear(cleanRing(lr.getCoordinates().map((c) => [c.x, c.y])));

/** Trazo cerrado con la forma de un polígono de JSTS y el estilo, atributos y demás de `template`. */
function shapeFrom(poly, template, id, name) {
  const holes = [];
  for (let k = 0; k < poly.getNumInteriorRing(); k++) holes.push(ringPts(poly.getInteriorRingN(k)).map((p) => makeNode(p[0], p[1])));
  const base = JSON.parse(JSON.stringify(template));
  delete base.freehand;
  return { ...base, id, closed: true, nodes: ringPts(poly.getExteriorRing()).map((p) => makeNode(p[0], p[1])), holes: holes.length ? holes : null, name: name ?? base.name };
}

/** Reemplaza `first.id` por `pieces` (en su lugar y capa) y quita `remove`. */
function replaceWith(doc, firstId, pieces, remove = []) {
  const gone = new Set(remove);
  return {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector' || !l.items.some((s) => s.id === firstId || gone.has(s.id))) return l;
      const items = [];
      for (const s of l.items) {
        if (s.id === firstId) items.push(...pieces);
        else if (!gone.has(s.id)) items.push(s);
      }
      return { ...l, items };
    }),
  };
}

const byAreaDesc = (a, b) => b.getArea() - a.getArea();

/**
 * Fusionar (Merge): la unión de dos o más polígonos. Los que se tocan o se
 * traslapan quedan en uno solo (con los huecos que resulten); los que no, en
 * polígonos aparte. El resultado conserva el estilo y los atributos del de más
 * abajo.
 */
export function mergePolygons(J, doc, ids, { tol = 0.05 } = {}) {
  const polys = pickPolygons(doc, ids);
  if (polys.length < 2) return { error: 'Selecciona dos o más polígonos (trazos cerrados) para fusionar' };
  let u = polygonOf(J, polys[0], tol);
  for (const p of polys.slice(1)) u = u.union(polygonOf(J, p, tol));
  const pieces = polygonsOf(u).sort(byAreaDesc);
  if (!pieces.length) return { error: 'La fusión no dio ningún polígono' };
  const base = polys[0];
  const shapes = pieces.map((p, i) => shapeFrom(p, base, i === 0 ? base.id : newId('p'), pieces.length > 1 ? `${base.name || 'Polígono'} ${i + 1}` : base.name));
  return {
    doc: replaceWith(doc, base.id, shapes, polys.slice(1).map((p) => p.id)),
    ids: shapes.map((s) => s.id),
    pieces: shapes.length,
    warning: shapes.length > 1 ? `Los polígonos no se tocan: quedaron ${shapes.length} polígonos separados` : null,
  };
}

/** Puntos de la línea alargados un poco en los dos extremos, para que cruce aunque termine justo en el borde. */
function extendLine(pts, by) {
  const out = pts.map((p) => [p[0], p[1]]);
  const grow = (a, b) => {
    const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
    return len ? [a[0] + ((a[0] - b[0]) / len) * by, a[1] + ((a[1] - b[1]) / len) * by] : a;
  };
  if (out.length >= 2) {
    out[0] = grow(out[0], out[1]);
    out[out.length - 1] = grow(out[out.length - 1], out[out.length - 2]);
  }
  return out;
}

/** Partes en que una línea divide un polígono (≥ 2 si lo atraviesa de lado a lado; si no, el mismo). */
function splitOne(J, poly, linePts) {
  const gf = poly.getFactory();
  const env = poly.getEnvelopeInternal();
  const diag = Math.hypot(env.getWidth(), env.getHeight());
  const line = gf.createLineString(extendLine(linePts, diag * 0.002).map((p) => new J.geom.Coordinate(p[0], p[1])));
  // borde + línea, nodados entre sí; cada región cerrada que cae dentro del polígono es una parte
  const noded = poly.getBoundary().union(line);
  const pz = new J.operation.polygonize.Polygonizer();
  pz.add(noded);
  const parts = toArray(pz.getPolygons()).filter((p) => p.getArea() > diag * diag * 1e-12 && poly.contains(p.getInteriorPoint()));
  return parts.length > 1 ? parts : [poly];
}

/**
 * Dividir (Split) polígonos con líneas: `lines` son listas de puntos [x, y]
 * (una línea existente aplanada o una dibujada). Cada polígono se parte donde
 * una línea lo atraviesa de lado a lado; la parte más grande conserva el id.
 * Las líneas no se tocan.
 */
export function splitPolygons(J, doc, polyIds, lines, { tol = 0.05 } = {}) {
  const polys = pickPolygons(doc, polyIds);
  if (!polys.length) return { error: 'Selecciona un polígono para dividir' };
  if (!lines.length) return { error: 'Falta la línea con la que dividir' };
  let next = doc;
  const ids = [];
  let divided = 0;
  for (const shape of polys) {
    let pieces = [polygonOf(J, shape, tol)];
    for (const line of lines) pieces = pieces.flatMap((p) => splitOne(J, p, line));
    if (pieces.length < 2) {
      ids.push(shape.id);
      continue;
    }
    divided++;
    pieces.sort(byAreaDesc);
    const shapes = pieces.map((p, i) => shapeFrom(p, shape, i === 0 ? shape.id : newId('p'), `${shape.name || 'Polígono'} ${i + 1}`));
    next = replaceWith(next, shape.id, shapes);
    ids.push(...shapes.map((s) => s.id));
  }
  if (!divided) return { error: 'La línea no atraviesa el polígono de lado a lado (debe cruzarlo de borde a borde)' };
  return { doc: next, ids, divided };
}

/**
 * Hueco (Hole): al polígono de más abajo se le resta lo que cubren los demás
 * (un polígono dentro de él le abre un hueco; uno que lo traslapa le muerde un
 * trozo). Con `keepCutters` las formas que cortan se conservan; si no, se
 * consumen, como «Restar frontal» de Illustrator.
 */
export function holePolygons(J, doc, ids, { keepCutters = false, tol = 0.05 } = {}) {
  const polys = pickPolygons(doc, ids);
  if (polys.length < 2) return { error: 'Para hacer un hueco selecciona el polígono y, encima, la o las formas que lo abren' };
  const [base, ...cutters] = polys;
  return cutBase(J, doc, base, cutters.map((c) => polygonOf(J, c, tol)), keepCutters ? [] : cutters.map((c) => c.id), tol);
}

/** Hueco con una forma dibujada (puntos [x, y] del contorno): el polígono `polyId` pierde esa zona. */
export function holeWithPoints(J, doc, polyIds, pts, { tol = 0.05 } = {}) {
  const polys = pickPolygons(doc, polyIds);
  if (!polys.length) return { error: 'Selecciona un polígono para hacerle un hueco' };
  if (pts.length < 3) return { error: 'La forma del hueco necesita al menos 3 vértices' };
  const cutter = polygonOfPoints(J, pts);
  let next = doc;
  const ids = [];
  let cut = 0;
  for (const base of polys) {
    const r = cutBase(J, next, base, [cutter], [], tol);
    if (r.error) {
      ids.push(base.id);
      continue;
    }
    next = r.doc;
    ids.push(...r.ids);
    cut++;
  }
  if (!cut) return { error: 'La forma dibujada no toca el polígono' };
  return { doc: next, ids };
}

function cutBase(J, doc, base, cutGeoms, removeIds, tol) {
  const poly = polygonOf(J, base, tol);
  let cutter = cutGeoms[0];
  for (const c of cutGeoms.slice(1)) cutter = cutter.union(c);
  if (!poly.intersects(cutter)) return { error: 'Las formas no se tocan: no hay dónde abrir el hueco' };
  const rest = poly.difference(cutter);
  const pieces = polygonsOf(rest).sort(byAreaDesc);
  if (!pieces.length) return { error: 'El hueco cubre todo el polígono' };
  if (Math.abs(rest.getArea() - poly.getArea()) < 1e-9) return { error: 'Las formas solo se tocan en el borde: no hay hueco' };
  const shapes = pieces.map((p, i) => shapeFrom(p, base, i === 0 ? base.id : newId('p'), pieces.length > 1 ? `${base.name || 'Polígono'} ${i + 1}` : base.name));
  return { doc: replaceWith(doc, base.id, shapes, removeIds), ids: shapes.map((s) => s.id) };
}

/** Puntos [x, y] de una línea (aplanada) para usarla como cortadora. */
export function linePoints(shape, tol = 0.05) {
  return flattenNodes(shape.nodes, false, tol).map((p) => [p[0], p[1]]);
}

/** Líneas abiertas elegidas, como listas de puntos. */
export function selectedLines(doc, ids, tol = 0.05) {
  const out = [];
  for (const { shape } of allTopShapes(doc, { visibleOnly: false })) {
    if (ids.has(shape.id) && shape.type === 'path' && !shape.closed) out.push(linePoints(shape, tol));
  }
  return out;
}
