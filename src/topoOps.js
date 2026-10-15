/**
 * Topología sobre el dibujo: confirmación de vértices compartidos (de
 * FieldDraw) y construcción de polígonos a partir de líneas de contacto.
 *
 * CONFIRMAR TOPOLOGÍA. Los contactos dibujados a mano casi coinciden pero no
 * comparten vértices; esto los fusiona dentro de una tolerancia en metros e
 * inserta en cada línea los vértices del vecino que caen sobre ella. Corre el
 * algoritmo de FieldDraw (`topology.js`, que trabaja en lon/lat) y devuelve las
 * formas a UTM. Las curvas Bézier se aplanan antes: la topología es de
 * polilíneas.
 *
 * CONSTRUIR POLÍGONOS. El flujo del geólogo: dibujar los contactos y las fallas
 * como LÍNEAS y que las unidades salgan solas, cerradas y sin huecos ni
 * traslapes entre vecinas. Se nodan todas las líneas entre sí (JSTS) y el
 * poligonizador devuelve cada región cerrada como un polígono.
 */

import { confirmTopology } from './topology.js';
import { fromLonLat, toLonLat } from './proj.js';
import { flattenShape, makeNode, makePath } from './vector.js';
import { loadScript } from './io/loader.js';
import { defaultStyle } from './style.js';

/** Formas -> features GeoJSON en lon/lat (solo trazos). */
function toFeatures(shapes, tol) {
  const out = [];
  for (const s of shapes) {
    if (s.type !== 'path') continue;
    const rings = flattenShape(s, tol).map((r) => r.pts.map(([x, y]) => toLonLat(x, y)));
    const geometry = s.closed ? { type: 'Polygon', coordinates: rings } : { type: 'LineString', coordinates: rings[0] };
    out.push({ type: 'Feature', properties: { id: s.id }, geometry, shape: s });
  }
  return out;
}

function ringToNodes(ring, closed) {
  let pts = ring.map(([lon, lat]) => fromLonLat(lon, lat));
  if (closed && pts.length > 1) {
    const a = pts[0];
    const b = pts[pts.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) pts = pts.slice(0, -1);
  }
  return pts.map(([x, y]) => makeNode(x, y));
}

/**
 * @returns {{ map: Map<id, forma>, stats }} formas cambiadas, listas para
 *   `replaceShapes`.
 */
export function confirmShapesTopology(shapes, toleranceMeters = 2, tolFlatten = 0.2) {
  const feats = toFeatures(shapes, tolFlatten);
  const res = confirmTopology(feats, { toleranceMeters });
  const map = new Map();
  res.features.forEach((f, i) => {
    if (f === feats[i]) return; // sin cambios
    const s = feats[i].shape;
    const g = f.geometry;
    if (g.type === 'LineString') map.set(s.id, { ...s, nodes: ringToNodes(g.coordinates, false) });
    else {
      const [outer, ...holes] = g.coordinates;
      map.set(s.id, { ...s, nodes: ringToNodes(outer, true), holes: holes.length ? holes.map((h) => ringToNodes(h, true)) : null });
    }
  });
  return { map, stats: { fusionados: res.fusionados, insertados: res.insertados, compartidos: res.compartidos, degenerados: res.degenerados } };
}

async function jsts() {
  if (!globalThis.jsts) await loadScript('vendor/jsts.min.js');
  if (!globalThis.jsts) throw new Error('JSTS no se cargó');
  return globalThis.jsts;
}

const toArray = (c) => (Array.isArray(c) ? c : c?.toArray ? Array.from(c.toArray()) : []);

/**
 * Polígonos de las regiones cerradas que forman las líneas dadas.
 * Opcional: `snap` (m) acerca extremos casi coincidentes antes de nodar,
 * para que un contacto que "casi" toca a otro cierre la región igual.
 */
export async function polygonizeShapes(shapes, { snap = 1, style = null, minArea = 1 } = {}) {
  const J = await jsts();
  const gf = new J.geom.GeometryFactory();
  const C = (x, y) => new J.geom.Coordinate(x, y);
  // extremos cercanos -> mismo punto (el poligonizador exige nodos exactos)
  const lines = [];
  for (const s of shapes) {
    if (s.type !== 'path') continue;
    for (const r of flattenShape(s, 0.2)) lines.push(r.pts.map((p) => p.slice()));
  }
  if (snap > 0) {
    const ends = [];
    for (const l of lines) ends.push(l[0], l[l.length - 1]);
    for (const l of lines) {
      for (const idx of [0, l.length - 1]) {
        const p = l[idx];
        // al vértice más cercano de OTRA línea, si está a menos de snap
        let best = null;
        for (const m of lines) {
          if (m === l) continue;
          for (const q of m) {
            const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
            if (d > 0 && d <= snap && (!best || d < best.d)) best = { q, d };
          }
        }
        if (best) l[idx] = best.q.slice();
      }
    }
  }
  const geoms = lines.filter((l) => l.length >= 2).map((l) => gf.createLineString(l.map(([x, y]) => C(x, y))));
  if (!geoms.length) throw new Error('Selecciona líneas que encierren regiones');
  // unión = nodado completo de todas las líneas entre sí
  let noded = geoms[0];
  for (let i = 1; i < geoms.length; i++) noded = noded.union(geoms[i]);
  noded = noded.union(gf.createPoint(geoms[0].getCoordinateN(0)));
  const pz = new J.operation.polygonize.Polygonizer();
  pz.add(noded);
  const polys = toArray(pz.getPolygons()).filter((p) => p.getArea() >= minArea);
  const st = style || { ...defaultStyle(), fill: '#bef264', fillOpacity: 0.5, stroke: '#365314', strokeWidth: 0.2 };
  return polys.map((p, i) => {
    const ring = (lr) => {
      const cs = lr.getCoordinates();
      return cs.slice(0, -1).map((c) => makeNode(c.x, c.y));
    };
    const holes = [];
    for (let k = 0; k < p.getNumInteriorRing(); k++) holes.push(ring(p.getInteriorRingN(k)));
    const shape = makePath(ring(p.getExteriorRing()), { closed: true, holes: holes.length ? holes : null, style: { ...st } });
    shape.name = `Polígono ${i + 1}`;
    return shape;
  });
}
