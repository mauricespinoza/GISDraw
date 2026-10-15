/**
 * GeoJSON. Al importar se respeta el `crs` heredado (GeoJSON 2008) si viene;
 * si no, se asume WGS84 lon/lat como manda el RFC 7946. Al exportar se puede
 * elegir WGS84 (lo estándar) o UTM 19S con el `crs` declarado.
 */

import { toLonLat } from '../proj.js';
import { epsgFromText, toDocTransform } from './crs.js';
import { geometryToShapes, guessName, layerFeatures } from './features.js';

export async function importGeoJSON(text) {
  const gj = JSON.parse(text);
  const crsName = gj.crs?.properties?.name;
  const epsg = crsName ? epsgFromText(crsName) : 4326;
  const T = await toDocTransform(epsg || 4326);
  const feats = gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : [{ type: 'Feature', properties: {}, geometry: gj }];
  const items = [];
  const fields = new Set();
  for (const f of feats) {
    const attrs = { ...(f.properties || {}) };
    for (const k of Object.keys(attrs)) {
      fields.add(k);
      if (attrs[k] !== null && typeof attrs[k] === 'object') attrs[k] = JSON.stringify(attrs[k]);
    }
    for (const s of geometryToShapes(f.geometry, attrs, T)) {
      s.name = guessName(attrs, s.name);
      items.push(s);
    }
  }
  return { items, fields: [...fields] };
}

export function exportGeoJSON(layer, { wgs84 = true, tol = 0.1 } = {}) {
  const tr = (c) => {
    if (!wgs84) return [round(c[0], 3), round(c[1], 3)];
    const [lon, lat] = toLonLat(c[0], c[1]);
    return [round(lon, 8), round(lat, 8)];
  };
  const mapCoords = (g) => {
    if (g.type === 'Point') return { type: 'Point', coordinates: tr(g.coordinates) };
    if (g.type === 'LineString') return { type: 'LineString', coordinates: g.coordinates.map(tr) };
    return { type: 'Polygon', coordinates: g.coordinates.map((r) => r.map(tr)) };
  };
  const features = layerFeatures(layer, tol).map(({ shape, geometry }) => ({
    type: 'Feature',
    properties: { ...(shape.attrs || {}), gd_name: shape.name, ...(shape.type === 'text' ? { gd_text: shape.text } : {}) },
    geometry: mapCoords(geometry),
  }));
  const fc = { type: 'FeatureCollection', name: layer.name, features };
  if (!wgs84) fc.crs = { type: 'name', properties: { name: 'urn:ogc:def:crs:EPSG::32719' } };
  return JSON.stringify(fc);
}

const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;
