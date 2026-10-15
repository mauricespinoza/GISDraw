/** Anillos de una feature GeoJSON, tomados de `vertexEdit.js` de FieldDraw. */

export function ringsOfFeature(feature) {
  const g = feature.geometry;
  if (!g) return null;
  if (g.type === 'LineString') return { rings: [g.coordinates.slice()], closed: false };
  if (g.type === 'Polygon') {
    return { rings: g.coordinates.map((r) => dropClosing(r)), closed: true };
  }
  return null;
}

function dropClosing(ring) {
  if (ring.length > 1) {
    const a = ring[0];
    const b = ring[ring.length - 1];
    if (a[0] === b[0] && a[1] === b[1]) return ring.slice(0, -1);
  }
  return ring.slice();
}

export function geometryFromRings(feature, rings) {
  const g = feature.geometry;
  if (g.type === 'LineString') return { type: 'LineString', coordinates: rings[0] };
  return { type: 'Polygon', coordinates: rings.map((r) => [...r, r[0]]) };
}
