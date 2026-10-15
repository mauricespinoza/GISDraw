import { applyRun, scaleRuns, adjustRuns, normalizeRuns } from '../src/richText.js';
import { layoutText, approxMeasure } from '../src/textLayout.js';
import { textToSvg } from '../src/style.js';

let n = 0;
const ok = (c, m) => { if (!c) { console.error('✗', m); process.exit(1); } n++; };

let r = applyRun([], 2, 5, { color: '#ff0000' }, 10);
ok(r.length === 1 && r[0].s === 2 && r[0].e === 5, 'color en tramo');
r = applyRun(r, 4, 8, { scale: 2 }, 10);
ok(r.length === 3 && r[1].color === '#ff0000' && r[1].scale === 2 && r[2].scale === 2 && !r[2].color, 'tramos partidos');
r = applyRun(r, 0, 10, { color: null, scale: null }, 10);
ok(r.length === 0, 'quitar formato');
r = scaleRuns(applyRun([], 0, 3, { scale: 2 }, 6), 0, 6, 1.5, 6);
ok(r.find((x) => x.s === 0).scale === 3 && r.find((x) => x.s === 3).scale === 1.5, 'escala multiplicada');
const adj = adjustRuns('hola mundo', 'hola bello mundo', [{ s: 5, e: 10, color: '#00f' }]);
ok(adj.length === 1 && adj[0].s === 11 && adj[0].e === 16, 'ajuste al insertar: ' + JSON.stringify(adj));
ok(normalizeRuns([{ s: 0, e: 3, color: '#f00' }, { s: 3, e: 5, color: '#f00' }], 5).length === 1, 'fusiona contiguos');

const shape = { type: 'text', x: 0, y: 0, text: 'ab cd', fontSize: 10, fontFamily: 'sans-serif', style: { fill: '#000', fillOpacity: 1 }, runs: [{ s: 3, e: 5, color: '#ff0000', scale: 2 }] };
const m = layoutText(shape, 10, 1, approxMeasure);
ok(m.lines[0].pieces.length === 2 && m.lines[0].ms === 2, 'piezas y escala máxima');
const plain = layoutText({ ...shape, runs: undefined }, 10, 1, approxMeasure);
ok(m.width > plain.width && m.height > plain.height, 'más ancho y alto con tramo grande');
const svg = textToSvg(shape, { P: (x, y) => [x, y], mmToPx: 1, ptToPx: 0.352778, viewW: 300, viewH: 300, defs: [], uid: 't_' });
ok(/<tspan[^>]*fill="#ff0000"/.test(svg) && /font-size="7.06"/.test(svg), 'tspan con color y tamaño: ' + svg);

// importación de SVG de Illustrator con varios estilos → tramos
const { importSvg } = await import('../src/io/svgImport.js');
const ai = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200mm" height="100mm"><text transform="translate(10 20)" font-size="10"><tspan x="0" y="0">Hola </tspan><tspan fill="#ff0000" font-size="20" font-weight="700">mundo</tspan><tspan> fin</tspan></text></svg>';
const imp = importSvg(ai, { refScale: 1000, center: [0, 0] }).shapes[0];
ok(imp.text === 'Hola mundo fin' && imp.runs.length === 1, 'import: un solo tramo distinto: ' + JSON.stringify(imp.runs));
ok(imp.runs[0].s === 5 && imp.runs[0].e === 10 && imp.runs[0].color === '#ff0000' && imp.runs[0].scale === 2 && imp.runs[0].bold === true, 'import: color, escala y negrita');
const ai2 = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100" width="200mm" height="100mm"><text font-size="10"><tspan x="0" y="10">uno</tspan><tspan x="0" y="22" fill="#0000ff">dos  </tspan></text></svg>';
const imp2 = importSvg(ai2, { refScale: 1000, center: [0, 0] }).shapes[0];
ok(imp2.text === 'uno\ndos' && imp2.runs.length === 1 && imp2.runs[0].s === 4 && imp2.runs[0].e === 7, 'import: varias líneas: ' + JSON.stringify(imp2.runs));
const plainImp = importSvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 50 50" width="50mm" height="50mm"><text font-size="10" x="1" y="10">solo</text></svg>', { refScale: 1000, center: [0, 0] }).shapes[0];
ok(!plainImp.runs, 'import: texto simple sin tramos');

// copiar / pegar interno
const { newDocument, addShapes, makeVectorLayer, addLayer } = await import('../src/doc.js');
const { copyShapes, pasteShapes } = await import('../src/ops.js');
const { makeText, makeGroup } = await import('../src/vector.js');
let doc = newDocument();
doc = addLayer(doc, makeVectorLayer('A'));
const lay = doc.layers[doc.layers.length - 1];
const t1 = makeText(10, 10, 'x', { fill: '#000' }, 10);
t1.runs = [{ s: 0, e: 1, color: '#f00' }];
const g = makeGroup([makeText(0, 0, 'y', { fill: '#000' }, 10)]);
doc = addShapes(doc, lay.id, [t1, g]);
const clip = copyShapes(doc, new Set([t1.id, g.id]));
const p1 = pasteShapes(doc, clip, lay.id, { offset: 5 });
const p2 = pasteShapes(p1.doc, clip, lay.id, { offset: 10 });
const all = p2.doc.layers.find((l) => l.id === lay.id).items;
const ids = new Set();
const walk = (s) => { ids.add(s.id); (s.children || []).forEach(walk); };
all.forEach(walk);
ok(all.length === 6 && ids.size === 9, 'pegar dos veces: ids únicos ' + all.length + ' ' + ids.size);
const pasted = all[2];
ok(pasted.x === 15 && pasted.runs[0].color === '#f00' && pasted.runs !== t1.runs, 'pegado conserva tramos y no comparte referencias');
console.log(n + ' comprobaciones OK');
