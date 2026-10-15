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
console.log(n + ' comprobaciones OK');
