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

import { cloneNode, flattenNodes, flattenShape, makeNode, nearestOnPath, newId, splitNodes } from './vector.js';
import { reshapeLine, reshapeRing, crossings } from './reshape.js';
import { allTopShapes, findTopShape, mapShapes } from './doc.js';
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

/* ====================================================================== SPLIT */

/** Trazos abiertos o cerrados, desbloqueados y en capas desbloqueadas, en el orden del dibujo. */
function editablePaths(doc, ids = null, { visibleOnly = false } = {}) {
  const out = [];
  for (const { layer, shape } of allTopShapes(doc, { visibleOnly })) {
    if (shape.type !== 'path' || shape.locked || layer.locked || (ids && !ids.has(shape.id))) continue;
    out.push(shape);
  }
  return out;
}

/**
 * Corta una LÍNEA (trazo abierto) en todos los puntos donde la cruza `cutPts`
 * (lista de puntos [x, y]). Los nodos nuevos se insertan exactamente en el
 * cruce (las curvas se conservan) y la línea queda en tantas líneas como
 * tramos: la primera conserva el id, las demás son copias con el mismo estilo
 * y atributos, justo después en la capa. Devuelve null si no hay cruces
 * interiores.
 */
export function splitLineAt(doc, id, cutPts, { tol = 0.05 } = {}) {
  const found = findTopShape(doc, id);
  const shape = found?.shape;
  if (!shape || shape.type !== 'path' || shape.closed || shape.nodes.length < 2) return null;
  const flat = flattenNodes(shape.nodes, false, tol).map((p) => [p[0], p[1]]);
  const cuts = crossings(flat, cutPts, false);
  if (!cuts.length) return null;
  // posición de cada cruce sobre los nodos originales (tramo + parámetro de la curva)
  const n = shape.nodes.length;
  const pos = [];
  for (const c of cuts) {
    const near = nearestOnPath(shape.nodes, false, { x: c.point[0], y: c.point[1] });
    if (!near) continue;
    const u = near.segIndex + near.t;
    if (u <= 1e-6 || u >= n - 1 - 1e-6) continue; // en un extremo no corta nada
    if (!pos.some((q) => Math.abs(q - u) < 1e-6)) pos.push(u);
  }
  if (!pos.length) return null;
  pos.sort((a, b) => a - b);
  let nodes = shape.nodes.map(cloneNode);
  let shift = 0;
  let lastSeg = -1;
  let lastT = 0;
  const idx = [];
  for (const u of pos) {
    const seg = Math.floor(u);
    const t = u - seg;
    const tt = seg === lastSeg ? (t - lastT) / (1 - lastT) : t;
    nodes = splitNodes(nodes, false, seg + shift, tt);
    idx.push(seg + shift + 1);
    shift++;
    lastSeg = seg;
    lastT = t;
  }
  const cutsAt = idx;
  const bounds = [0, ...cutsAt, nodes.length - 1];
  const pieces = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const part = nodes.slice(bounds[i], bounds[i + 1] + 1).map(cloneNode);
    if (i > 0) part[0] = { ...part[0], hIn: null };
    if (i + 1 < bounds.length - 1) part[part.length - 1] = { ...part[part.length - 1], hOut: null };
    if (part.length >= 2) pieces.push(part);
  }
  if (pieces.length < 2) return null;
  const shapes = pieces.map((nds, i) => (i === 0 ? { ...shape, nodes: nds } : { ...JSON.parse(JSON.stringify(shape)), id: newId('p'), nodes: nds, freehand: undefined }));
  shapes[0] = { ...shapes[0], freehand: undefined };
  const next = {
    ...doc,
    layers: doc.layers.map((l) => {
      if (l.kind !== 'vector' || !l.items.some((x) => x.id === id)) return l;
      const items = [];
      for (const x of l.items) {
        if (x.id === id) items.push(...shapes);
        else items.push(x);
      }
      return { ...l, items };
    }),
  };
  return { doc: next, ids: shapes.map((x) => x.id) };
}

/**
 * Split: corta con `cutPts` las formas `ids` (o, sin `ids`, todas las visibles
 * y desbloqueadas que la línea cruza): las líneas en cada cruce y los polígonos
 * de borde a borde. Lo que la línea no cruza se deja como está.
 * @returns {{ doc, ids, lines, polys }|{ error }}
 */
export function splitShapes(J, doc, ids, cutPts, { tol = 0.05 } = {}) {
  if (!cutPts || cutPts.length < 2) return { error: 'Falta la línea de corte' };
  let next = doc;
  const out = [];
  let lines = 0;
  let polys = 0;
  for (const shape of editablePaths(doc, ids, { visibleOnly: !ids })) {
    // con selección se devuelve completa (lo que no se cortó sigue seleccionado); sin selección, solo las partes nuevas
    const keep = () => ids && out.push(shape.id);
    if (!shape.closed) {
      const r = splitLineAt(next, shape.id, cutPts, { tol });
      if (r) {
        next = r.doc;
        out.push(...r.ids);
        lines++;
      } else keep();
    } else {
      const r = splitPolygons(J, next, new Set([shape.id]), [cutPts], { tol });
      if (!r.error) {
        next = r.doc;
        out.push(...r.ids);
        polys++;
      } else keep();
    }
  }
  if (!lines && !polys) return { error: ids ? 'El corte no cruza lo seleccionado (una línea se corta donde la cruza; un polígono, de borde a borde)' : 'La línea de corte no cruza nada' };
  return { doc: next, ids: out, lines, polys };
}

/** Contorno de una forma como línea de corte [x, y] (un polígono vuelve al primer punto). */
export function cutterFromShape(shape, tol = 0.05) {
  const pts = flattenNodes(shape.nodes, !!shape.closed, tol).map((p) => [p[0], p[1]]);
  if (shape.closed && pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-9) pts.push([a[0], a[1]]);
  }
  return pts;
}

/* =================================================================== RESHAPE */

/**
 * Reshape: el contorno de los polígonos `ids` (o líneas) se redibuja con la
 * línea trazada `linePts`, que debe cruzarlo al menos dos veces. En un
 * polígono, entre el primer y el último cruce se queda el trozo MAYOR
 * (`keep: 'larger'`): si la línea sale y vuelve a entrar el polígono CRECE, y
 * si lo atraviesa se RECORTA el lado pequeño. `keep: 'smaller'` lo invierte.
 * Los huecos no se tocan; las curvas del contorno se aplanan (tolerancia `tol`).
 * Sin `ids`: el primer trazo (de arriba) que la línea cruza al menos dos veces.
 * @returns {{ doc, ids, changed }|{ error }}
 */
export function reshapeShapes(doc, ids, linePts, { tol = 0.05, keep = 'larger' } = {}) {
  if (!linePts || linePts.length < 2) return { error: 'Traza una línea que cruce el contorno al menos dos veces' };
  const cands = editablePaths(doc, ids, { visibleOnly: !ids });
  if (!ids) cands.reverse(); // el de arriba primero
  let next = doc;
  const out = [];
  for (const shape of cands) {
    const pts = flattenNodes(shape.nodes, !!shape.closed, tol).map((p) => [p[0], p[1]]);
    let ring = pts;
    if (shape.closed && ring.length > 1) {
      const a = ring[0];
      const b = ring[ring.length - 1];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-9) ring = ring.slice(0, -1);
    }
    const res = shape.closed ? reshapeRing(ring, linePts, { keep }) : reshapeLine(ring, linePts);
    if (!res) continue;
    const nodes = res.map(([x, y]) => makeNode(x, y));
    next = mapShapes(next, [shape.id], (s) => {
      const { freehand, ...rest } = s;
      return { ...rest, nodes };
    });
    out.push(shape.id);
    if (!ids) break;
  }
  if (!out.length) return { error: 'La línea no cruza el contorno al menos dos veces (sal del polígono y vuelve a entrar, o atraviésalo)' };
  return { doc: next, ids: out, changed: out.length };
}
