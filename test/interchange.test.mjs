/**
 * Intercambio: SVG / Illustrator (pegar y exportar con capas), FieldDraw y
 * lámina por partes con factor de símbolos.
 *
 *   node test/interchange.test.mjs
 */

import { importSvg, parsePathD, parseColor, parseTransform, unitMmOf, parseXml, PT_MM } from '../src/io/svgImport.js';
import { selectionSvg, illustratorJsx, xmlId } from '../src/io/illustrator.js';
import { importFieldDraw, fieldDrawLineStyle, readZip } from '../src/io/fielddraw.js';
import { composeLayout, defaultLayout, symbolFactor, pageGeometry, pageToGround, fitFrame, niceScale, frameExtent } from '../src/layout/compose.js';
import { styleToSymbolXml, waveSvg } from '../src/io/qml.js';
import { makeNode, makePath, makeText, shapeBBox } from '../src/vector.js';
import { defaultStyle } from '../src/style.js';
import { newDocument, addShapes } from '../src/doc.js';
import { fromLonLat } from '../src/proj.js';

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

/* ------------------------------------------------------------ SVG básico */
{
  ok(parseColor('#abc').color === '#aabbcc' && parseColor('rgb(255, 0, 0)').color === '#ff0000' && parseColor('none') === 'none', 'colores');
  near(parseColor('rgba(0,0,0,.5)').alpha, 0.5, 1e-9, 'alfa');
  const m = parseTransform('translate(10 20) scale(2)');
  ok(m[0] === 2 && m[4] === 10 && m[5] === 20, 'transformación');
  const r = parseTransform('rotate(90)');
  near(r[1], 1, 1e-9, 'rotación');
  const subs = parsePathD('M0 0 10 0 10 10z m 20 0 c 0 5 5 5 5 0 s 5 -5 5 0 q 2 2 4 0 t 4 0 a 3 3 0 0 1 6 0 h2 v2 H0 V0');
  ok(subs.length === 2 && subs[0].closed && subs[0].nodes.length === 3, 'path: M con pares implícitos y z');
  ok(subs[1].nodes.length >= 9 && subs[1].nodes[1].hIn && subs[1].nodes[0].hOut, 'path: curvas a cúbicas');
  ok(parsePathD('M0 0a5 5 0 1 0 10 0')[0].nodes.length === 3, 'arco con banderas pegadas');
  const root = parseXml('<svg xmlns="http://www.w3.org/2000/svg" width="210mm" height="297mm" viewBox="0 0 210 297"/>');
  near(unitMmOf(root, ''), 1, 1e-9, 'unidad mm por viewBox');
  near(unitMmOf(parseXml('<svg viewBox="0 0 100 100"/>'), '<!-- Generator: Adobe Illustrator -->'), PT_MM, 1e-9, 'Illustrator mide en puntos');
}

/* ---------------------------------------------- pegar desde Illustrator */
const AI = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generator: Adobe Illustrator 28.0 -->
<svg id="Capa_1" data-name="Capa 1" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">
  <defs><style>.cls-1{fill:#86efac;stroke:#000;stroke-width:2px;}.cls-2{fill:none;stroke:#0000ff;stroke-dasharray:6 3;stroke-linecap:round;}.cls-3{font-family:MyriadPro-Bold, 'Myriad Pro';font-size:12px;}</style>
  <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#1d4ed8" stop-opacity=".5"/></linearGradient>
  <clipPath id="cp"><rect x="0" y="0" width="50" height="50"/></clipPath></defs>
  <g id="Unidades" data-name="Unidades geológicas">
    <path class="cls-1" d="M10,10h50v40H10Z M20 20h10v10h-10z"/>
    <circle cx="120" cy="30" r="15" fill="url(#g1)"/>
  </g>
  <g id="Fallas">
    <polyline class="cls-2" points="0,90 50,80 100,95"/>
    <g clip-path="url(#cp)"><rect x="-10" y="-10" width="40" height="40" fill="#f00" opacity=".5"/></g>
  </g>
  <text class="cls-3" transform="translate(30 70) rotate(-10)"><tspan x="0" y="0">Fm. </tspan><tspan x="25" y="0">Abanico</tspan><tspan x="0" y="14.4">Ki</tspan></text>
</svg>`;
{
  const center = [350000, 6300000];
  const r = importSvg(AI, { refScale: 25000, center });
  ok(r.layers.map((l) => l.name).join('|') === 'Capa 1|Unidades geológicas|Fallas', `capas: ${r.layers.map((l) => l.name)}`);
  const unidades = r.layers[1].shapes;
  const poly = unidades[0];
  ok(poly.type === 'path' && poly.closed && poly.holes?.length === 1, 'contorno con hueco');
  ok(poly.style.fill === '#86efac' && poly.style.stroke === '#000000' && poly.style.align === 'center', 'estilo por clase CSS');
  near(poly.style.strokeWidth, 2 * PT_MM, 1e-4, 'grosor 2 pt en mm');
  // 50 pt de ancho a 1:25 000 = 17,64 mm de papel = 441 m de terreno
  const b = shapeBBox(poly);
  near(b.w, 50 * PT_MM * 25, 0.01, 'ancho en terreno');
  ok(unidades[1].style.fillType === 'linear' && unidades[1].style.gradient.stops.length === 2, 'degradado');
  near(unidades[1].style.gradient.angle, -90, 1e-9, 'ángulo del degradado');
  const fallas = r.layers[2].shapes;
  ok(fallas[0].style.dash === '6 3' && fallas[0].style.cap === 'round' && !fallas[0].closed, 'segmentado en múltiplos del grosor');
  const clip = fallas[1];
  ok(clip.type === 'group' && clip.clip && clip.children.length === 2, 'máscara de recorte');
  near(clip.children[1].style.opacity, 0.5, 1e-9, 'opacidad');
  const text = r.layers[0].shapes[0];
  ok(text.type === 'text' && text.text === 'Fm. Abanico\nKi' && text.fontSize === 12 && text.rotation === -10 && text.fontWeight === 700, `texto: ${JSON.stringify(text.text)} ${text.fontSize} ${text.rotation} ${text.fontWeight}`);
  // todo el dibujo queda centrado en la vista
  const all = r.shapes.map((s) => shapeBBox(s, { mmToM: 25, ptToM: 25 * 0.352778, mpp: 1 }));
  const minX = Math.min(...all.map((q) => q.x));
  const maxX = Math.max(...all.map((q) => q.x + q.w));
  near((minX + maxX) / 2, center[0], 80, 'centrado en x (el texto ocupa a la derecha de su ancla)');
}

/* -------------------------------- copiar en GISDrawer → pegar (ida y vuelta) */
{
  const p = makePath([makeNode(350000, 6300000), makeNode(350500, 6300200)], { style: { ...defaultStyle(), stroke: '#0000ff', ornament: 'thrust' } });
  const t = makeText(350100, 6300100, 'Qal', { ...defaultStyle(), fill: '#111111' }, 9);
  const svg = selectionSvg([p, t], { refScale: 25000, name: 'Fallas & co' });
  ok(svg.includes('width=') && svg.includes('pt"') && svg.includes('data-name="Fallas &amp; co"'), 'SVG en puntos con capa');
  // 500 m de terreno a 1:25 000 = 20 mm = 56,7 pt
  const w = Number(/viewBox="0 0 ([\d.]+)/.exec(svg)[1]);
  near(w, (500 / 25) * (72 / 25.4) + 8, 0.05, 'ancho en puntos');
  const back = importSvg(svg, { refScale: 25000 });
  ok(back.gisdrawer && back.gisdrawer.shapes.length === 2 && back.gisdrawer.shapes[0].style.ornament === 'thrust', 'GISDrawer recupera sus formas exactas');
  ok(back.gisdrawer.shapes[0].nodes[1].x === 350500, 'coordenadas exactas');
  // sin los metadatos (como si Illustrator lo devolviera): igual se importa el dibujo
  const plain = importSvg(svg.replace(/<metadata[\s\S]*?<\/metadata>/, ''), { refScale: 25000, center: [0, 0] });
  ok(!plain.gisdrawer && plain.shapes.length > 0, 'el SVG sin metadatos se importa como dibujo');
  ok(xmlId('Capa 1: Fallas') === 'Capa_1_Fallas' && xmlId('1a') === '_1a', 'ids XML');
}

/* ------------------------------------------------------------- FieldDraw */
{
  const proj = {
    format: 'fielddraw-project',
    version: 1,
    name: 'Cajón del Maipo',
    units: [{ id: 'u1', name: 'Fm. Abanico', code: 'OMa', color: '#a5d6a7' }],
    ornaments: { 'thrust-fault': { color: '#0000ff', width: 1.35, size: 1.2, spacing: 30, offset: -4.5, minzoom: 11 } },
    features: [
      { type: 'Feature', properties: { id: 'p1', kind: 'polygon', type: 'u1', unit: 'Fm. Abanico', code: 'OMa', certainty: 'observed' }, geometry: { type: 'Polygon', coordinates: [[[-70.3, -33.7], [-70.29, -33.7], [-70.29, -33.69], [-70.3, -33.69], [-70.3, -33.7]]] } },
      { type: 'Feature', properties: { id: 'l1', kind: 'line', type: 'thrust-fault', certainty: 'inferred', flip: true }, geometry: { type: 'LineString', coordinates: [[-70.3, -33.7], [-70.28, -33.69]] } },
      { type: 'Feature', properties: { id: 'l2', kind: 'line', type: 'stratigraphic-contact', certainty: 'covered' }, geometry: { type: 'LineString', coordinates: [[-70.3, -33.71], [-70.28, -33.7]] } },
      { type: 'Feature', properties: { id: 'm1', kind: 'point', geomKind: 'measurement', type: 'bedding', strike: 20, dip: 35, dipAzimuth: 110 }, geometry: { type: 'Point', coordinates: [-70.295, -33.695] } },
      { type: 'Feature', properties: { id: 'm2', kind: 'point', geomKind: 'measurement', type: 'joint', strike: 0, dip: 89 }, geometry: { type: 'Point', coordinates: [-70.29, -33.695] } },
      { type: 'Feature', properties: { id: 'c1', kind: 'point', geomKind: 'control-point', name: 'MC-01', unitId: 'u1' }, geometry: { type: 'Point', coordinates: [-70.292, -33.692] } },
    ],
  };
  const r = importFieldDraw(JSON.stringify(proj), { refScale: 25000 });
  ok(r.count === 6 && r.layers.map((l) => l.name).join('|') === 'FieldDraw · Unidades|FieldDraw · Trazas|FieldDraw · Medidas|FieldDraw · Puntos de control', `capas FieldDraw: ${r.layers.map((l) => l.name)}`);
  const [units, lines, meas, ctrl] = r.layers;
  const poly = units.items[0];
  const [x0, y0] = fromLonLat(-70.3, -33.7);
  ok(poly.closed && poly.nodes.length === 4 && Math.abs(poly.nodes[0].x - x0) < 1e-6 && Math.abs(poly.nodes[0].y - y0) < 1e-6, 'polígono en UTM 19S');
  ok(poly.style.fill === '#a5d6a7' && poly.attrs.code === 'OMa' && units.labels.field === 'code', 'unidad con su color y código');
  const thrust = lines.items[0].style;
  ok(thrust.ornament === 'thrust' && thrust.ornamentSide === 'right' && thrust.dash === 'inferred', 'falla inversa: ornamento, lado (flip) y certeza');
  near(thrust.strokeWidth, 0.675, 1e-9, 'grosor = 0,5 mm × peso');
  near(thrust.ornamentSpacing, 30 * 25.4 / 96, 0.01, 'separación en mm');
  near(thrust.ornamentSize, 1.2, 1e-9, 'tamaño del ornamento');
  ok(lines.items[1].style.dash === 'covered' && lines.items[1].style.stroke === '#000000' && lines.items[1].style.casing, 'contacto cubierto con halo');
  const bed = meas.items[0];
  ok(bed.type === 'group' && bed.children.some((c) => c.type === 'text' && c.text === '35') && bed.attrs.strike === 20, 'medida: símbolo con manteo y atributos');
  ok(meas.items[1].children.filter((c) => c.type === 'path').length === 3, 'vertical: tic a ambos lados');
  ok(ctrl.items[0].type === 'point' && ctrl.items[0].style.fill === '#a5d6a7' && ctrl.items[0].name === 'MC-01', 'punto de control con color de unidad');
  const gj = importFieldDraw(JSON.stringify({ type: 'FeatureCollection', features: proj.features.slice(1, 2) }));
  ok(gj.count === 1, 'GeoJSON de FieldDraw');
  let bad = false;
  try {
    importFieldDraw('{"hola":1}');
  } catch {
    bad = true;
  }
  ok(bad, 'rechaza lo que no es FieldDraw');
  ok(fieldDrawLineStyle({ type: 'normal-fault' }, null).ornamentSide === 'left', 'normal sin flip a la izquierda');
}

/* -------------------------------------------------------------- ZIP */
{
  // paquete .fdproj.zip almacenado (sin compresión), como lo escribe FieldDraw
  const name = new TextEncoder().encode('project.fdproj.json');
  const data = new TextEncoder().encode('{"format":"fielddraw-project","features":[]}');
  const local = new Uint8Array(30 + name.length + data.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);
  local.set(data, 30 + name.length);
  const central = new Uint8Array(46 + name.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint32(20, data.length, true);
  cv.setUint16(28, name.length, true);
  cv.setUint32(42, 0, true);
  central.set(name, 46);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(16, local.length, true);
  const zip = new Uint8Array([...local, ...central, ...end]);
  const entries = await readZip(zip);
  ok(entries.length === 1 && entries[0].name === 'project.fdproj.json', 'ZIP: entrada');
  ok(new TextDecoder().decode(await entries[0].data()).includes('fielddraw-project'), 'ZIP: contenido');
}

/* ------------------------------------------- lámina por partes y factor */
{
  near(symbolFactor(25000, { scale: 50000, symbolScale: 'auto' }), Math.SQRT1_2, 1e-9, 'auto = raíz de la razón');
  ok(symbolFactor(25000, { scale: 1000000, symbolScale: 'auto' }) === 0.5, 'auto acotado');
  ok(symbolFactor(25000, { scale: 50000, symbolScale: 'paper' }) === 1 && symbolFactor(25000, { scale: 50000, symbolScale: 'map' }) === 0.5, 'papel y mapa');
  ok(symbolFactor(25000, { scale: 50000, symbolScale: 'custom', symbolFactor: 0.8 }) === 0.8, 'manual');
  let doc = newDocument();
  const line = makePath([makeNode(350000, 6300000), makeNode(351000, 6300500)], { style: { ...defaultStyle(), stroke: '#000000', strokeWidth: 1 } });
  doc = addShapes(doc, doc.activeLayerId, [line]);
  const L = { ...defaultLayout(doc), center: [350500, 6300250], scale: 50000, legend: true };
  const out = composeLayout(doc, L);
  const names = out.parts.map((p) => p.name);
  ok(names.includes('Fondo') && names.includes('Marco') && names.includes('Leyenda') && names.includes(doc.layers.find((l) => l.kind === 'vector').name), `partes: ${names}`);
  ok(out.svg.includes('data-name="Marco"') && out.svg.includes('id="Fondo"'), 'SVG con un grupo por parte');
  // 1 mm a factor 0,707
  ok(new RegExp(`stroke-width="${(Math.SQRT1_2).toFixed(2)}"`).test(out.svg), 'grosor con el factor automático');
  const paper = composeLayout(doc, { ...L, symbolScale: 'paper' });
  ok(/stroke-width="1"/.test(paper.svg), 'grosor fijo en papel');
  const jsx = illustratorJsx(out, { title: 'Mapa geológico' });
  ok(jsx.startsWith('// GISDrawer') && jsx.includes('#target illustrator') && jsx.includes('createFromFile') && jsx.includes('doc.layers.add()'), 'script de Illustrator');
  ok((jsx.match(/\{name:/g) || []).length === out.parts.length && !/[^\x00-\x7f]/.test(jsx), 'una capa por parte, texto ASCII');
}

/* ----------------------------------- layout: marco, elementos y encuadre */
{
  ok(niceScale(1234) === 1500 && niceScale(25000) === 25000 && niceScale(26000) === 30000 && niceScale(61000) === 75000, 'escala redonda');
  let doc = newDocument();
  doc = addShapes(doc, doc.activeLayerId, [makePath([makeNode(350000, 6300000), makeNode(352000, 6301000)], { style: defaultStyle() })]);
  const L = { ...defaultLayout(doc), center: [351000, 6300500], scale: 25000 };
  const g = pageGeometry(L);
  ok(!g.custom, 'marco automático');
  const c = pageToGround(L, g, g.fx + g.fw / 2, g.fy + g.fh / 2);
  near(c[0], 351000, 1e-6, 'el centro del marco es el centro del mapa');
  const left = pageToGround(L, g, g.fx, g.fy + g.fh / 2);
  near(left[0], 351000 - (g.fw / 2) * 25, 1e-6, 'borde izquierdo');
  const fit = fitFrame(L, g, { minX: 350000, maxX: 352000, minY: 6300000, maxY: 6301000 });
  ok(fit.center[0] === 351000 && fit.center[1] === 6300500, 'encuadre: centro');
  const ext = frameExtent({ ...L, ...fit }, g);
  ok(ext.maxX - ext.minX >= 2000 && ext.maxY - ext.minY >= 1000, 'encuadre: la caja cabe');
  ok(fit.scale === niceScale(fit.scale) || fit.scale > 0, 'escala del encuadre');
  const exact = fitFrame(L, g, { minX: 350000, maxX: 352000, minY: 6300000, maxY: 6301000 }, { round: false, margin: 0 });
  near((2000 * 1000) / g.fw, exact.scale, 1, 'encuadre exacto al ancho');
  // marco puesto a mano
  const g2 = pageGeometry({ ...L, frame: { x: 20, y: 30, w: 120, h: 90 } });
  ok(g2.custom && g2.fx === 20 && g2.fw === 120 && g2.fh === 90, 'marco manual manda');
  // elementos movibles y eliminables
  const base = composeLayout(doc, L);
  ok(['title', 'legend', 'north', 'scalebar', 'info'].every((e) => base.parts.some((p) => p.el === e)), 'elementos con data-el');
  ok(base.svg.includes('data-el="legend"') && /class="lv"/.test(base.svg), 'grupos de elemento y de contenido del mapa');
  const moved = composeLayout(doc, { ...L, offsets: { legend: [12.5, -3] } });
  ok(moved.parts.find((p) => p.el === 'legend').svg.includes('translate(12.5 -3)'), 'desplazamiento del elemento');
  const gone = composeLayout(doc, { ...L, showTitle: false, showInfo: false, north: false, scalebar: false, legend: false });
  ok(!['title', 'info', 'north', 'scalebar', 'legend'].some((e) => gone.parts.some((p) => p.el === e && p.el !== 'info' && p.el !== 'legend')), 'elementos eliminados');
  ok(!gone.parts.some((p) => p.el === 'title'), 'sin título');
  const noTitle = pageGeometry({ ...L, showTitle: false });
  ok(noTitle.titleH === 0 && noTitle.fh > g.fh, 'sin título el marco gana alto');
  const custom = composeLayout(doc, { ...L, frame: { x: 20, y: 30, w: 120, h: 90 } });
  ok(custom.svg.includes('<clipPath id="frame"><rect x="20" y="30" width="120" height="90"/>'), 'el recorte sigue al marco');
}

/* -------------------------------------------------- onda en el QML */
{
  const st = { ...defaultStyle(), stroke: '#000000', strokeWidth: 0.35, wavy: true, waveAmp: 0.7, waveLen: 3.6, casing: true, casingWidth: 0.3 };
  const xml = styleToSymbolXml(st, 'line', '0');
  ok(xml.includes('class="MarkerLine"') && !xml.includes('class="SimpleLine"'), 'discordancia: onda como MarkerLine, sin línea recta');
  ok(xml.includes('name="interval" value="3.600"') && xml.includes('name="offset_along_line" value="1.800"'), 'un ciclo por longitud de onda, desde media onda');
  const w = waveSvg(st);
  ok(w.includes('data-gd="wave"') && (w.match(/<path/g) || []).length === 2, 'SVG de la onda con su halo');
  const ys = [...w.matchAll(/L[-\d.]+ ([-\d.]+)/g)].map((m) => Number(m[1]));
  near(Math.max(...ys), 0.7, 0.01, 'amplitud');
  const both = styleToSymbolXml({ ...st, ornament: 'thrust' }, 'line', '0');
  ok((both.match(/class="MarkerLine"/g) || []).length === 2, 'onda + ornamento');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLARON` : ''}`);
if (fail) process.exit(1);
