/**
 * Pruebas sin navegador de lo que es aritmética pura: proyección, geometría,
 * borde hacia afuera, operaciones de edición, etiquetas y relieve.
 *
 *   node test/core.test.mjs
 */

import { UTM19S, formatDMS, parseDMS, makeUtm } from '../src/proj.js';
import { makeNode, makePath, makeRectPath, makeEllipsePath, makePoint, flattenNodes, measure, ringArea, splitNodes, scaleShape, rotateShape, shapeBBox } from '../src/vector.js';
import { defaultStyle, pathToSvg, dashArray } from '../src/style.js';
import { newDocument, addShapes, History, makeVectorLayer, addLayer, removeShapes } from '../src/doc.js';
import { align, arrange, distribute, group, ungroup, selectSame, selectByAttribute, pasteShapes, copyShapes, joinPaths, splitPath, setShapeFlag, resetShapeFlag } from '../src/ops.js';
import { niceFontSize } from '../src/editor.js';
import { polylabel, labelText } from '../src/labels.js';
import { hillshade, compose, paletteLUT, elevationRange } from '../src/raster/hillshade.js';
import { decodeTerrarium, parseAsciiGrid, gridSampler } from '../src/raster/dem.js';
import { SnapIndex, buildGraph, tracePath } from '../src/snapping.js';
import { shapeGeometry, geometryToShapes } from '../src/io/features.js';
import { evalFilter, qgisExprToTemplate, buildQLR, describeStyle, styleToSymbolXml } from '../src/io/qml.js';
import { ornamentSymbolSvg, ORNAMENTS } from '../src/ornaments.js';
import { PATTERNS, patternTileSvg } from '../src/patterns.js';
import { sanitizeTableName } from '../src/io/gpkg.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}
const near = (a, b, tol, msg) => ok(Math.abs(a - b) <= tol, `${msg}: ${a} ≠ ${b}`);

/* ---------------------------------------------------------- proyección */
{
  // valores de referencia de proj4 (+proj=utm +zone=19 +south +datum=WGS84)
  const [x, y] = UTM19S.forward(-70.65, -33.45);
  near(x, 346642.695, 0.002, 'UTM19S x Santiago');
  near(y, 6297606.8325, 0.002, 'UTM19S y Santiago');
  const [lon, lat] = UTM19S.inverse(x, y);
  near(lon, -70.65, 1e-9, 'inversa lon');
  near(lat, -33.45, 1e-9, 'inversa lat');
  const [x2, y2] = UTM19S.forward(-72.5, -45);
  near(x2, 224146.271, 0.002, 'UTM19S fuera de zona x');
  near(y2, 5011088.1614, 0.002, 'UTM19S fuera de zona y');
  const u18 = makeUtm(18, true);
  ok(u18.epsg === 32718, 'EPSG zona 18S');
  ok(formatDMS(-33.4534444, true) === `33°27'12.4"S`, `DMS lat: ${formatDMS(-33.4534444, true)}`);
  ok(formatDMS(-70.999999, false) === `71°00'00.0"W`, 'DMS sin 60"');
  near(parseDMS(`33°27'12.4"S`), -33.45344444, 1e-7, 'parse DMS');
  near(parseDMS('-70.5'), -70.5, 0, 'parse decimal');
  near(parseDMS('70 30 0 W'), -70.5, 1e-12, 'parse con espacios');
}

/* ---------------------------------------------------------- geometría */
{
  const sq = makeRectPath(0, 0, 100, 50);
  const m = measure(sq);
  near(m.area, 5000, 1e-6, 'área rectángulo');
  near(m.length, 300, 1e-6, 'perímetro rectángulo');
  ok(ringArea([[0, 0], [1, 0], [1, 1], [0, 1]]) > 0, 'antihorario = área positiva');
  const el = makeEllipsePath(0, 0, 100, 100);
  near(measure(el).area, Math.PI * 1e4, 40, 'área de la elipse Bézier ≈ πr²');
  const line = makePath([makeNode(0, 0), makeNode(10, 0)]);
  const split = splitNodes(line.nodes, false, 0, 0.3);
  ok(split.length === 3 && Math.abs(split[1].x - 3) < 1e-9, 'insertar nodo en recta');
  const curved = flattenNodes([makeNode(0, 0, null, { x: 0, y: 10 }), makeNode(10, 10, { x: 10, y: 0 })], false, 0.01);
  ok(curved.length > 10, 'curva se subdivide');
  const sc = scaleShape(sq, { x: 0, y: 0 }, 2, 3);
  const b = shapeBBox(sc);
  ok(b.w === 200 && b.h === 150, 'escalar');
  const rot = rotateShape(makePath([makeNode(1, 0), makeNode(2, 0)]), { x: 0, y: 0 }, 90);
  near(rot.nodes[0].x, 0, 1e-12, 'rotar x');
  near(rot.nodes[0].y, 1, 1e-12, 'rotar y');
}

/* -------------------------------------------------- borde hacia afuera */
{
  const st = { ...defaultStyle(), fill: '#ff0000', fillOpacity: 1, stroke: '#000000', strokeWidth: 1, align: 'outside' };
  const poly = makeRectPath(0, 0, 10, 10, st);
  const ctx = { P: (x, y) => [x, -y], mmToPx: 4, ptToPx: 1.4, viewW: 100, viewH: 100, defs: [], uid: 't' };
  const svg = pathToSvg(poly, ctx);
  ok(/stroke-width="8"/.test(svg), 'afuera: trazo al doble del ancho');
  ok(/clip-path=/.test(svg), 'afuera: recortado');
  ok(ctx.defs.some((d) => d.includes('clip-rule="evenodd"') && d.includes('M-400')), 'máscara par-impar con rectángulo exterior');
  const ctx2 = { ...ctx, defs: [] };
  const center = pathToSvg({ ...poly, style: { ...st, align: 'center' } }, ctx2);
  ok(/stroke-width="4"/.test(center) && !/clip-path/.test(center), 'centrado: ancho normal sin máscara');
  const ctx3 = { ...ctx, defs: [] };
  const lineSvg = pathToSvg(makePath([makeNode(0, 0), makeNode(10, 0)], { style: { ...st, casing: true, casingWidth: 0.5, casingColor: '#ffffff' } }), ctx3);
  ok(/stroke="#ffffff"[^>]*stroke-width="8"/.test(lineSvg), 'borde de línea = núcleo + 2×borde, por debajo');
  ok(lineSvg.indexOf('#ffffff') < lineSvg.indexOf('stroke="#000000"'), 'el borde se pinta antes que el núcleo');
  ok(dashArray({ dash: 'dash' }, 2) === '8 4', 'segmentada escala con el grosor');
  ok(dashArray({ dash: '6 2 1 2' }, 1) === '6 2 1 2', 'patrón libre');
}

/* ----------------------------------------------------------- operaciones */
{
  let doc = newDocument();
  const L = doc.activeLayerId;
  const a = makeRectPath(0, 0, 10, 10, { ...defaultStyle(), fill: '#ff0000' });
  const b = makeRectPath(30, 5, 50, 25, { ...defaultStyle(), fill: '#00ff00' });
  const c = makeRectPath(100, 0, 110, 10, { ...defaultStyle(), fill: '#ff0000' });
  a.attrs = { unidad: 'Kia', edad: 100 };
  b.attrs = { unidad: 'Qa', edad: 1 };
  c.attrs = { unidad: 'Kia', edad: 95 };
  doc = addShapes(doc, L, [a, b, c]);
  const layerItems = (d) => d.layers.find((l) => l.id === L).items;

  const al = align(doc, new Set([a.id, b.id, c.id]), 'left', null);
  ok(layerItems(al).every((s) => shapeBBox(s).x === 0), 'alinear a la izquierda');
  const dist = distribute(doc, new Set([a.id, b.id, c.id]), 'h', null);
  const mid = shapeBBox(layerItems(dist)[1]);
  near(mid.x + mid.w / 2, 55, 1e-9, 'distribuir centros');
  const front = arrange(doc, new Set([a.id]), 'front');
  ok(layerItems(front)[2].id === a.id, 'traer al frente');
  const back = arrange(doc, new Set([c.id]), 'backward');
  ok(layerItems(back)[1].id === c.id, 'enviar atrás un paso');

  const same = selectSame(doc, new Set([a.id]), 'fill');
  ok(same.size === 2 && same.has(c.id), 'seleccionar mismo relleno');
  const byAttr = selectByAttribute(doc, L, 'edad', '>', '50');
  ok(byAttr.size === 2, 'seleccionar por atributo numérico');
  ok(selectByAttribute(doc, L, 'unidad', 'contiene', 'q').size === 1, 'contiene, sin mayúsculas');

  const g = group(doc, new Set([a.id, b.id]), { clip: true });
  ok(g.id && layerItems(g.doc).length === 2, 'máscara agrupa');
  const grp = layerItems(g.doc).find((s) => s.id === g.id);
  ok(grp.clip && grp.children[0].id === b.id, 'la máscara es el objeto superior');
  const ug = ungroup(g.doc, new Set([g.id]));
  ok(layerItems(ug.doc).length === 3 && ug.ids.size === 2, 'liberar máscara');

  const clip = copyShapes(doc, new Set([a.id]));
  const pasted = pasteShapes(doc, clip, L, { inPlace: true });
  const copy = layerItems(pasted.doc)[3];
  ok(copy.id !== a.id && shapeBBox(copy).x === 0, 'pegar en el lugar conserva coordenadas');

  const h = new History(doc);
  h.commit(removeShapes(doc, [a.id]));
  ok(layerItems(h.doc).length === 2, 'borrar');
  h.undo();
  ok(layerItems(h.doc).length === 3, 'deshacer');
  h.begin();
  h.preview(removeShapes(h.doc, [b.id]));
  h.preview(removeShapes(h.doc, [c.id]));
  h.end();
  h.undo();
  ok(layerItems(h.doc).length === 3, 'un arrastre entero se deshace de una vez');
}

/* -------------------------------------------------------------- etiquetas */
{
  // C: el centroide cae fuera, el polo de inaccesibilidad no
  const C = [[0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10], [0, 0]];
  const p = polylabel([C], 0.05);
  ok(p.x < 2 && p.d > 0.9, `polylabel dentro de la C (${p.x.toFixed(2)}, ${p.y.toFixed(2)})`);
  const s = { attrs: { codigo: 'Kia', edad: 'Cretácico' }, name: 'x' };
  ok(labelText(s, { template: '{codigo} ({edad})' }) === 'Kia (Cretácico)', 'plantilla de etiqueta');
  ok(labelText(s, { field: 'codigo', upper: true }) === 'KIA', 'campo en mayúsculas');
  ok(labelText(s, { field: 'nada' }) === '', 'campo vacío no etiqueta');
}

/* ----------------------------------------------------------------- relieve */
{
  // plano que baja hacia el este
  const w = 20;
  const h = 20;
  const z = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) z[j * w + i] = -i * 10; // baja hacia el este
  const west = hillshade(z, w, h, 10, { azimuth: 270, altitude: 45 });
  const east = hillshade(z, w, h, 10, { azimuth: 90, altitude: 45 });
  // la ladera baja hacia el este, o sea MIRA al este: la luz del este la ilumina más
  ok(east[210] > west[210], 'ladera que mira al este se ilumina con luz del este');
  const flat = hillshade(new Float32Array(100), 10, 10, 10, { altitude: 45 });
  near(flat[55], Math.cos(Math.PI / 4), 1e-6, 'terreno plano = cos(zenit)');
  const nan = new Float32Array(9).fill(NaN);
  ok(Number.isNaN(hillshade(nan, 3, 3, 1)[4]), 'sin dato se respeta');

  const lut = paletteLUT('etopo', -1000, 1000);
  const idxSea = Math.round(((-500 + 1000) / 2000) * (lut.N - 1)) * 3;
  const idxLand = Math.round(((500 + 1000) / 2000) * (lut.N - 1)) * 3;
  ok(lut.lut[idxSea + 2] > lut.lut[idxSea], 'mar azul');
  ok(lut.lut[idxLand + 1] > lut.lut[idxLand + 2], 'tierra no azul');
  const elev = new Float32Array([0, 100, 200, 300]);
  const shade = new Float32Array([1, 1, 0.5, 0]);
  const rgba = compose(elev, shade, 2, 2, { palette: 'none', shadeStrength: 1 }, { min: 0, max: 300 });
  ok(rgba[0] === 255 && rgba[12] === 0, 'gris = sombra');
  const mult = compose(elev, shade, 2, 2, { palette: 'viridis', paletteOpacity: 1, paletteBlend: 'multiply' }, { min: 0, max: 300 });
  ok(mult[12] === 0 && mult[13] === 0, 'multiplicar por sombra cero = negro');
  const bright = compose(elev, shade, 2, 2, { palette: 'none', brightness: 0.5 }, { min: 0, max: 300 });
  ok(bright[12] >= 127, 'brillo');
  const r = elevationRange(new Float32Array([NaN, 1, 2, 3, 4, 5]));
  ok(r.min >= 1 && r.max <= 5, 'rango ignora NaN');
}

/* ------------------------------------------------------------------ DEM */
{
  const px = new Uint8ClampedArray([128, 0, 0, 255]);
  near(decodeTerrarium(px, 1)[0], 0, 1e-9, 'terrarium 0 m');
  const asc = 'ncols 2\nnrows 2\nxllcorner -71\nyllcorner -34\ncellsize 1\nNODATA_value -9999\n1 2\n3 -9999\n';
  const g = parseAsciiGrid(asc);
  ok(g.w === 2 && g.data[3] === -9999 && g.y0 === -32, 'ASCII grid');
  g.toGrid = (lon, lat) => [lon, lat];
  const s = gridSampler(g);
  near(s(-70.5, -32.5), 1, 1e-9, 'muestreo en celda');
}

/* -------------------------------------------------------------- trace */
{
  // cuadrado; trazar de un lado al opuesto debe seguir el borde por el camino corto
  const idx = new SnapIndex(10);
  idx.addPolyline([[0, 0], [100, 0], [100, 100], [0, 100]], true, { id: 'sq' });
  const graph = buildGraph(idx);
  const a = idx.query([50, 1], 5);
  const b = idx.query([99, 50], 5);
  const path = tracePath(idx, graph, a, b);
  ok(path && path.length === 3 && path[1][0] === 100 && path[1][1] === 0, 'trace sigue el borde por la esquina');
}

/* ----------------------------------------------------- formas <-> geometría */
{
  const poly = makeRectPath(0, 0, 10, 10);
  const g = shapeGeometry(poly);
  ok(g.type === 'Polygon' && ringArea(g.coordinates[0]) > 0, 'exterior antihorario');
  const back = geometryToShapes({ type: 'MultiPolygon', coordinates: [g.coordinates, g.coordinates] }, { a: 1 }, (x, y) => [x, y]);
  ok(back.length === 2 && back[0].closed && back[0].nodes.length === 4 && back[1].attrs.a === 1, 'multipolígono en partes');
  const pt = shapeGeometry(makePoint(5, 6));
  ok(pt.type === 'Point' && pt.coordinates[1] === 6, 'punto');
}

/* ------------------------------------------------------------------ QML */
{
  ok(evalFilter(['==', ['get', 'u'], 'Kia'], { u: 'Kia' }), 'filtro ==');
  ok(evalFilter(['all', ['>=', ['get', 'e'], 10], ['<=', ['get', 'e'], 20]], { e: '15' }), 'filtro rango con texto numérico');
  ok(!evalFilter(['any', ['==', ['get', 'u'], 'a'], ['==', ['get', 'u'], 'b']], { u: 'c' }), 'filtro any');
  ok(qgisExprToTemplate(`"codigo" || ' (' || "edad" || ')'`) === '{codigo} ({edad})', 'expresión QGIS a plantilla');
  ok(sanitizeTableName('Geología – Unidades 2') === 'geologia_unidades_2', `nombre de tabla: ${sanitizeTableName('Geología – Unidades 2')}`);
}

/* ------------------------------------------------- unir, cortar, ocultar */
{
  const a = makePath([makeNode(0, 0), makeNode(10, 0)]);
  const b = makePath([makeNode(20, 0), makeNode(10.2, 0)]);
  let doc = addShapes(newDocument(), newDocument().activeLayerId, []);
  doc = addShapes(doc, doc.activeLayerId, [a, b]);
  const r = joinPaths(doc, new Set([a.id, b.id]), 0.5);
  const items = r.doc.layers.find((l) => l.id === doc.activeLayerId).items;
  ok(items.length === 1 && items[0].id === a.id, 'unir deja un trazo');
  ok(items[0].nodes.length === 3 && items[0].nodes[2].x === 20, `unir funde extremos cercanos e invierte el segundo: ${items[0].nodes.map((n) => n.x)}`);
  const far = joinPaths(doc, new Set([a.id, b.id]), 0.01);
  ok(far.doc.layers.find((l) => l.id === doc.activeLayerId).items[0].nodes.length === 4, 'unir lejos agrega un tramo');
  const one = joinPaths(addShapes(newDocument(), newDocument().activeLayerId, []), new Set(), 0);
  ok(one.error, 'unir sin selección da error');

  const line = makePath([makeNode(0, 0), makeNode(10, 0), makeNode(20, 0)]);
  let d2 = addShapes(newDocument(), newDocument().activeLayerId, []);
  d2 = addShapes(d2, d2.activeLayerId, [line]);
  const cut = splitPath(d2, line.id, 0, 0.5);
  const parts = cut.doc.layers.find((l) => l.id === d2.activeLayerId).items;
  ok(parts.length === 2 && parts[0].nodes.length === 2 && parts[1].nodes.length === 3, 'tijera parte una línea en dos');
  near(parts[0].nodes[1].x, 5, 1e-9, 'tijera corta en el punto');
  ok(parts[1].nodes[0].x === 5 && JSON.stringify(parts[1].style) === JSON.stringify(line.style) && parts[1].id !== line.id, 'la segunda parte conserva el estilo con id propio');
  ok(splitPath(d2, line.id, 0, 0).error, 'tijera en el extremo no corta');
  const onNode = splitPath(d2, line.id, 0, 1);
  ok(onNode.doc.layers.find((l) => l.id === d2.activeLayerId).items.map((s) => s.nodes.length).join() === '2,2', 'tijera sobre un vértice');

  const sq = makeRectPath(0, 0, 10, 10);
  let d3 = addShapes(newDocument(), newDocument().activeLayerId, []);
  d3 = addShapes(d3, d3.activeLayerId, [sq]);
  const opened = splitPath(d3, sq.id, 1, 0.5).doc.layers.find((l) => l.id === d3.activeLayerId).items[0];
  ok(!opened.closed && opened.nodes.length === 6, `tijera abre un polígono: ${opened.nodes.length}`);
  ok(opened.nodes[0].x === opened.nodes[5].x && opened.nodes[0].y === opened.nodes[5].y, 'el polígono abierto empieza y termina en el corte');

  const hidden = setShapeFlag(d3, new Set([sq.id]), 'visible', false);
  ok(hidden.layers.find((l) => l.id === d3.activeLayerId).items[0].visible === false, 'ocultar');
  const shown = resetShapeFlag(hidden, 'visible');
  ok(shown.ids.length === 1 && shown.doc.layers.find((l) => l.id === d3.activeLayerId).items[0].visible === true, 'mostrar todo');
}

/* ------------------------------------------------- texto y QLR */
{
  ok(niceFontSize(3.2) === 3.5 && niceFontSize(37) === 38 && niceFontSize(431) === 440, 'tamaños de letra limpios');
  const qlr = buildQLR(
    [
      { table: 'contactos', name: 'Contactos', kind: 'line', styles: [{ ...defaultStyle(), stroke: '#000000', ornament: 'thrust' }], labels: [''], labelCfg: null },
      { table: 'unidades', name: 'Unidades & co', kind: 'polygon', styles: [{ ...defaultStyle(), fill: '#86efac', pattern: 'none' }], labels: ['Kia'], labelCfg: { enabled: true, field: 'codigo', fontFamily: 'Helvetica', fontSize: 8, color: '#000000', haloColor: '#ffffff', haloWidth: 0.5, halo: true } },
    ],
    { gpkgName: 'mapa.gpkg', title: 'Mapa' },
  );
  ok(qlr.includes('<qlr>') && qlr.includes('./mapa.gpkg|layername=unidades'), 'QLR apunta al GeoPackage');
  ok(qlr.indexOf('layername=unidades') < qlr.indexOf('layername=contactos'), 'QLR: la capa de más arriba primero');
  ok(qlr.includes('Unidades &amp; co') && qlr.includes('label="Kia"') && qlr.includes('EPSG:32719'), 'QLR: nombres escapados, rótulos y SRS');
  ok(qlr.includes('fieldName="codigo"') && qlr.includes('labelsEnabled="1"'), 'QLR: etiquetas');
  ok(/Cabalgamiento/.test(describeStyle({ ...defaultStyle(), ornament: 'thrust' }, 'line')), 'rótulo de leyenda de una falla');
}

/* ------------------------------------------- ornamentos y tramas en QML */
{
  const dec = (x) => Buffer.from(x.replace(/^base64:/, ''), 'base64').toString('utf8');
  const refs = (xml) => [...xml.matchAll(/value="(base64:[^"]+)"/g)].map((m) => dec(m[1]));
  for (const k of Object.keys(ORNAMENTS).filter((x) => x !== 'none')) {
    const st = { ...defaultStyle(), stroke: '#0000ff', ornament: k, ornamentSpacing: ORNAMENTS[k].spacing };
    const o = ornamentSymbolSvg(st);
    ok(o && o.sizeMm > 1 && o.svg.includes('viewBox'), `SVG de ornamento ${k}`);
    const xml = styleToSymbolXml(st, 'line', '0');
    ok(xml.includes('class="MarkerLine"') && xml.includes('class="SvgMarker"') && xml.includes('class="SimpleLine"'), `QML línea con ornamento ${k}`);
    ok(xml.includes(`name="offset_along_line" value="${(ORNAMENTS[k].spacing / 2).toFixed(3)}"`), `ornamento ${k} empieza a media separación`);
    ok(refs(xml).length === 1 && refs(xml)[0].startsWith('<svg'), `SVG incrustado de ${k}`);
  }
  const left = ornamentSymbolSvg({ ...defaultStyle(), ornament: 'thrust' });
  const right = ornamentSymbolSvg({ ...defaultStyle(), ornament: 'thrust', ornamentSide: 'right' });
  ok(!left.svg.includes('scale(1,-1)') && right.svg.includes('scale(1,-1)'), 'el lado derecho voltea el símbolo');
  ok(ornamentSymbolSvg({ ...defaultStyle(), ornament: 'none' }) === null, 'sin ornamento no hay símbolo');
  ok(!ornamentSymbolSvg({ ...defaultStyle(), ornament: 'normal', ornamentHalo: false }).svg.includes('#ffffff'), 'sin halo no hay blanco');
  ok(!styleToSymbolXml(defaultStyle(), 'line', '0').includes('MarkerLine'), 'línea común sin MarkerLine');

  const keys = Object.keys(PATTERNS);
  let allOk = true;
  for (const k of keys) {
    const xml = styleToSymbolXml({ ...defaultStyle(), fill: '#bef264', pattern: k, patternColor: '#112233', patternSize: 6, patternOpacity: 0.8 }, 'polygon', '0');
    const r = refs(xml);
    if (!(xml.includes('class="SVGFill"') && r.length === 1 && r[0].includes('#112233') && r[0].includes('opacity="0.8"') && xml.indexOf('SimpleFill') < xml.indexOf('SVGFill'))) allOk = false;
  }
  ok(allOk, `las ${keys.length} tramas salen como SVGFill sobre el relleno`);
  const pat = styleToSymbolXml({ ...defaultStyle(), fill: '#bef264', pattern: 'sandstone', patternSize: 7.5 }, 'polygon', '0');
  ok(pat.includes('name="patternWidth" value="7.500"'), 'ancho de la trama en mm');
  ok(pat.includes('line_style" value="no"') || pat.includes('name="line_style" value="no"'), 'la trama no dibuja contorno propio');
  ok(!styleToSymbolXml({ ...defaultStyle(), fill: '#bef264' }, 'polygon', '0').includes('SVGFill'), 'polígono sin trama');
  ok(patternTileSvg('nope') === null, 'trama inexistente');
}

{
  // textos: ida y vuelta por JSON (guardar/abrir proyecto) y normalización
  const { normalizeDoc } = await import('../src/doc.js');
  const { makeText } = await import('../src/vector.js');
  const { elementTransform } = await import('../src/layout/compose.js');
  const tx = { ...makeText(1, 2, 'Hola mundo', undefined, 12), runs: [{ s: 0, e: 4, bold: true, color: '#ff0000' }, { s: 2, e: 99, italic: true }] };
  const nd = newDocument();
  let d = addShapes(nd, nd.activeLayerId, [tx]);
  d = { ...d, layout: { texts: [{ id: 'x', x: 5, y: 6, text: 'Cuadro', runs: [{ s: 1, e: 3, scale: 2 }] }], scales: { legend: { s: 1.5, a: [3, 4] } } } };
  const back = normalizeDoc(JSON.parse(JSON.stringify({ app: 'GISDrawer', ...d })));
  const t2 = back.layers.find((l) => l.kind === 'vector').items[0];
  ok(t2.text === 'Hola mundo' && t2.fontSize === 12 && t2.runs.length === 2 && t2.runs[1].e === 10, 'texto del mapa sobrevive guardar/abrir con sus tramos');
  ok(back.layout.texts[0].text === 'Cuadro' && back.layout.texts[0].runs[0].scale === 2 && back.layout.scales.legend.s === 1.5, 'texto del layout y escalas sobreviven');
  ok(elementTransform({ offsets: { a: [1, 2] }, scales: { a: { s: 2, a: [3, 4] } } }, 'a') === 'translate(1 2) translate(3 4) scale(2) translate(-3 -4)', 'transformación de elemento con escala');
  ok(elementTransform({}, 'a') === 'translate(0 0)', 'sin escala solo desplaza');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLARON` : ''}`);
if (fail) process.exit(1);
