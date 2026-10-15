/**
 * Formas <-> geometrías GeoJSON (en coordenadas del documento, UTM 19S).
 *
 * Al exportar, las curvas Bézier se aplanan a una tolerancia en metros: un
 * GIS no entiende curvas, y aplanar a 10 cm es invisible a cualquier escala de
 * terreno. Los grupos se recorren; un grupo de recorte exporta SOLO lo que se
 * ve (sus hijos) y no la máscara, que es un artificio gráfico.
 */

import { makeNode, makePath, makePoint, makeText, flattenShape, walkShapes } from '../vector.js';
import { ringArea } from '../vector.js';

export function shapeGeometry(shape, tol = 0.1) {
  switch (shape.type) {
    case 'point':
      return { type: 'Point', coordinates: [shape.x, shape.y] };
    case 'text':
      return { type: 'Point', coordinates: [shape.x, shape.y] };
    case 'path': {
      const rings = flattenShape(shape, tol);
      if (!shape.closed) return { type: 'LineString', coordinates: rings[0].pts };
      // GeoJSON: exterior antihorario, huecos horarios
      const fix = (pts, ccw) => {
        const a = ringArea(pts);
        return (a > 0) === ccw ? pts : pts.slice().reverse();
      };
      return { type: 'Polygon', coordinates: rings.map((r, i) => fix(r.pts, i === 0)) };
    }
    default:
      return null;
  }
}

/** Lista plana {shape, geometry, kind} de una capa (grupos incluidos). */
export function layerFeatures(layer, tol = 0.1) {
  const out = [];
  walkShapes(layer.items, (s, parent) => {
    if (s.type === 'group') return;
    if (parent?.clip && parent.children[0] === s) return; // máscara
    const geometry = shapeGeometry(s, tol);
    if (!geometry) return;
    const kind = geometry.type === 'Point' ? 'point' : geometry.type === 'LineString' ? 'line' : 'polygon';
    out.push({ shape: s, geometry, kind });
  });
  return out;
}

/**
 * Geometría (ya transformada a UTM por `T`) -> formas. Las multigeometrías se
 * separan en partes con los mismos atributos.
 */
export function geometryToShapes(geometry, attrs, T, style) {
  if (!geometry) return [];
  const pt = (c) => {
    const [x, y] = T(c[0], c[1]);
    return makeNode(x, y);
  };
  const ringNodes = (ring) => {
    const nodes = ring.map(pt);
    const f = nodes[0];
    const l = nodes[nodes.length - 1];
    if (nodes.length > 1 && f.x === l.x && f.y === l.y) nodes.pop();
    return nodes;
  };
  const withAttrs = (s) => {
    s.attrs = { ...attrs };
    return s;
  };
  switch (geometry.type) {
    case 'Point': {
      const [x, y] = T(geometry.coordinates[0], geometry.coordinates[1]);
      return [withAttrs(makePoint(x, y, style?.point))];
    }
    case 'MultiPoint':
      return geometry.coordinates.map((c) => geometryToShapes({ type: 'Point', coordinates: c }, attrs, T, style)[0]);
    case 'LineString':
      return [withAttrs(makePath(geometry.coordinates.map(pt), { closed: false, style: style?.line }))];
    case 'MultiLineString':
      return geometry.coordinates.map((l) => withAttrs(makePath(l.map(pt), { closed: false, style: style?.line })));
    case 'Polygon': {
      const [outer, ...holes] = geometry.coordinates;
      return [withAttrs(makePath(ringNodes(outer), { closed: true, holes: holes.length ? holes.map(ringNodes) : null, style: style?.polygon }))];
    }
    case 'MultiPolygon':
      return geometry.coordinates.flatMap((p) => geometryToShapes({ type: 'Polygon', coordinates: p }, attrs, T, style));
    case 'GeometryCollection':
      return geometry.geometries.flatMap((g) => geometryToShapes(g, attrs, T, style));
    default:
      return [];
  }
}

/** Nombre de una forma importada: el primer campo que parezca un nombre. */
export function guessName(attrs, fallback) {
  for (const k of ['name', 'nombre', 'NAME', 'NOMBRE', 'codigo', 'CODIGO', 'unidad', 'UNIDAD', 'label', 'id']) {
    if (attrs[k] != null && attrs[k] !== '') return String(attrs[k]);
  }
  return fallback;
}

export { makeText };
