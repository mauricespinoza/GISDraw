/**
 * Pegar: centro de la vista, delante / detrás de la selección y los formatos
 * de texto del portapapeles (SVG en HTML, WKT, GeoJSON, tabla de QGIS).
 *
 *   node test/paste.test.mjs
 */

import { makeRectPath, shapeBBox } from '../src/vector.js';
import { newDocument, addShapes } from '../src/doc.js';
import { pasteShapes, insertShapes, copyShapes } from '../src/ops.js';
import { parseWkt, featuresFromText, svgFromHtml, svgFromDataUrl, imageSourcesFromHtml, looksLonLat, hasSvg } from '../src/io/clipFormats.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}

{
  const nd = newDocument();
  const L = nd.activeLayerId;
  const a = makeRectPath(0, 0, 10, 10);
  const b = makeRectPath(20, 0, 10, 10);
  const c = makeRectPath(40, 0, 10, 10);
  const doc = addShapes(nd, L, [a, b, c]);
  const items = (d) => d.layers.find((l) => l.id === L).items;
  const clip = copyShapes(doc, new Set([a.id]));

  const centered = pasteShapes(doc, clip, L, { center: [500, 300] });
  const bb = shapeBBox(items(centered.doc)[3]);
  ok(Math.abs(bb.x + bb.w / 2 - 500) < 1e-9 && Math.abs(bb.y + bb.h / 2 - 300) < 1e-9, 'Ctrl+V pega en el centro de la vista');
  const inPlace = pasteShapes(doc, clip, L, { inPlace: true, center: [500, 300] });
  ok(shapeBBox(items(inPlace.doc)[3]).x === 0, 'en el lugar no se centra');

  const front = pasteShapes(doc, clip, L, { inPlace: true, where: 'front', anchor: new Set([a.id]) });
  ok(items(front.doc)[1].id === [...front.ids][0] && items(front.doc).length === 4, 'Ctrl+F: justo delante de lo seleccionado');
  const back = pasteShapes(doc, clip, L, { inPlace: true, where: 'back', anchor: new Set([b.id, c.id]) });
  ok(items(back.doc)[1].id === [...back.ids][0], 'Ctrl+B: justo detrás de lo seleccionado más bajo');
  const bottom = insertShapes(doc, L, clip, { where: 'back' });
  ok(items(bottom)[0].id === clip[0].id, 'sin selección, detrás = al fondo de la capa');
  const top = insertShapes(doc, L, clip, { where: 'front' });
  ok(items(top)[3].id === clip[0].id, 'sin selección, delante = arriba de la capa');
}

{
  ok(parseWkt('POINT (1 2)').geometry.coordinates[1] === 2, 'WKT punto');
  const mp = parseWkt('SRID=4326;MultiPolygon Z (((0 0 1, 1 0 1, 1 1 1, 0 0 1)),((5 5,6 5,6 6,5 5)))');
  ok(mp.srid === 4326 && mp.geometry.type === 'MultiPolygon' && mp.geometry.coordinates.length === 2, 'EWKT multipolígono Z');
  ok(parseWkt('MULTIPOINT ((1 2), (3 4))').geometry.coordinates.length === 2 && parseWkt('MULTIPOINT (1 2, 3 4)').geometry.coordinates[1][0] === 3, 'multipunto con y sin paréntesis');
  ok(parseWkt('GEOMETRYCOLLECTION (POINT (1 2), LINESTRING (0 0, 1 1))').geometry.geometries.length === 2, 'colección');
  ok(parseWkt('POINT EMPTY') === null && parseWkt('hola') === null, 'WKT vacío o inválido');

  const q = featuresFromText('wkt_geom\tid\tnombre\nPoint (300000 6000000)\t1\tA\nLineString (0 0, 1 1)\tNULL\tB');
  ok(q.features.length === 2 && q.features[0].properties.id === 1 && q.features[1].properties.id === null && q.features[0].properties.nombre === 'A', 'tabla de QGIS con atributos');
  ok(!looksLonLat(q.coords), 'UTM no parece lon/lat');
  const gj = featuresFromText('{"type":"FeatureCollection","features":[{"type":"Feature","properties":{"u":"Kia"},"geometry":{"type":"Point","coordinates":[-70,-33]}}]}');
  ok(gj.features[0].properties.u === 'Kia' && looksLonLat(gj.coords), 'GeoJSON en texto');
  ok(featuresFromText('LINESTRING (0 0, 1 1)\nPOINT (3 3)').features.length === 2, 'varias líneas de WKT');
  ok(featuresFromText('hola mundo') === null && featuresFromText('{"a":1}') === null, 'texto cualquiera no es geometría');

  ok(svgFromHtml('<div><svg width="10"><svg><rect/></svg><circle/></svg></div>') === '<svg width="10"><svg><rect/></svg><circle/></svg>', 'SVG en línea dentro de HTML, con anidados');
  ok(hasSvg(svgFromHtml('<p><svg><rect/></svg></p><p><svg><circle/></svg></p>')) && /<rect\/>[\s\S]*<circle\/>/.test(svgFromHtml('<p><svg><rect/></svg></p><p><svg><circle/></svg></p>')), 'varios SVG se juntan');
  ok(svgFromHtml(`<img src="data:image/svg+xml;base64,${btoa('<svg><rect/></svg>')}">`) === '<svg><rect/></svg>', 'SVG como data URL en un <img>');
  ok(svgFromDataUrl('data:image/svg+xml,%3Csvg%3E%3C/svg%3E') === '<svg></svg>', 'data URL con escapes');
  ok(imageSourcesFromHtml('<img alt=x src="https://a.com/b.png?x=1&amp;y=2">')[0] === 'https://a.com/b.png?x=1&y=2', 'URL de imagen en HTML copiado');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLARON` : ''}`);
if (fail) process.exit(1);
