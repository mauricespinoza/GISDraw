/**
 * Texto (alineación, espaciados, cuadro, espacios), capas bloqueadas, halo del
 * trazo en polígonos, cuadros de texto del layout y estilos de layout.
 *
 *   node test/text.test.mjs
 */

import { layoutText, hardSpaces, alignOf, anchorOf, textCorners, approxMeasure, NBSP } from '../src/textLayout.js';
import { textToSvg, pathToSvg, defaultStyle } from '../src/style.js';
import { makeText, makePath, makeNode, shapeBBox, scaleShape, makePoint } from '../src/vector.js';
import { newDocument, addShapes, replaceShapes, removeShapes, mapShapes, makeVectorLayer, addLayer, findLayer, updateLayer } from '../src/doc.js';
import { arrange, group, moveToLayer, splitPath } from '../src/ops.js';
import { composeLayout, defaultLayout, layoutTextShape } from '../src/layout/compose.js';
import { pickStyle, applyStyle, saveStyle, listStyles, deleteStyle, getStyle, styleFile, parseStyleFile, importStyles } from '../src/layout/styles.js';
import { styleToSymbolXml } from '../src/io/qml.js';
import { Editor } from '../src/editor.js';

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
const ctx = { P: (x, y) => [x, y], mmToPx: 1, ptToPx: 0.352778, viewW: 300, viewH: 300, defs: [], uid: 't_' };
const T = (over) => ({ ...makeText(10, 20, 'Hola mundo', undefined, 10), ...over });

/* ------------------------------------------------------------ composición */
{
  ok(hardSpaces('a  b') === `a${NBSP}${NBSP}b` && hardSpaces(' a ') === `${NBSP}a${NBSP}` && hardSpaces('a b') === 'a b', 'espacios duros: tandas y extremos');
  ok(alignOf({ anchor: 'middle' }) === 'center' && alignOf({ align: 'justify' }) === 'justify' && alignOf({}) === 'left', 'alineación desde anchor');
  ok(anchorOf({ align: 'right' }) === 'end' && anchorOf({ align: 'justify' }) === 'start', 'text-anchor');
  const fs = 10;
  const free = layoutText(T({ text: 'uno\ndos tres' }), fs, 1, approxMeasure);
  ok(free.lines.length === 2 && !free.boxed && free.width === free.lines[1].w, 'texto de punto: sin ajuste');
  const boxed = layoutText(T({ text: 'uno dos tres cuatro cinco seis', boxWidth: 40 }), fs, 1, approxMeasure);
  ok(boxed.boxed && boxed.lines.length > 1 && boxed.lines.every((l) => l.w <= 40 + 1e-6 || !l.t.includes(' ')), 'ajuste de línea al ancho del cuadro');
  ok(boxed.width === 40 && boxed.x0 === 0, 'el cuadro mide su ancho');
  const long = layoutText(T({ text: 'supercalifragilisticoespialidoso', boxWidth: 10 }), fs, 1, approxMeasure);
  ok(long.lines.length === 1, 'una palabra más larga que el cuadro queda entera');
  const lh = layoutText(T({ text: 'a\nb', lineHeight: 2 }), fs, 1, approxMeasure);
  near(lh.lh, 20, 1e-9, 'interlineado');
  const tr = layoutText(T({ text: 'abcd', letterSpacing: 500 }), fs, 1, approxMeasure);
  near(tr.lines[0].w, 4 * fs * 0.56 + 4 * 5, 1e-6, 'espaciado de letras (milésimas de em)');
  const just = layoutText(T({ text: 'aa bb cc dd ee ff gg hh ii jj', boxWidth: 60, align: 'justify' }), fs, 1, approxMeasure);
  const jl = just.lines[0];
  ok(jl.words && jl.words.length >= 2 && Math.abs(jl.words[jl.words.length - 1].x + approxMeasure(jl.words[jl.words.length - 1].t, fs) - 60) < 1e-6, 'justificado: la línea llena el cuadro');
  ok(!just.lines[just.lines.length - 1].words, 'el último renglón no se justifica');
  const c = layoutText(T({ text: 'abcdef', align: 'center' }), fs, 1, approxMeasure);
  near(c.x0, -c.width / 2, 1e-9, 'sin cuadro, centrado sobre el ancla');
  // la caja sigue la orientación del texto
  const m = layoutText(T({ text: 'abcdef' }), fs, 1, approxMeasure);
  const flat = textCorners(m, 100, 100, 0).corners;
  const turned = textCorners(m, 100, 100, 90).corners;
  near(flat[1][1], flat[0][1], 1e-9, 'sin giro, el borde superior es horizontal');
  near(turned[1][0], turned[0][0], 1e-9, 'girado 90°, el borde superior es vertical');
}

/* --------------------------------------------------------------- dibujo SVG */
{
  const svg = textToSvg(T({ text: 'a   b', halo: false }), ctx);
  ok(svg.includes(`a${NBSP}${NBSP}${NBSP}b`) && svg.includes('xml:space="preserve"'), 'varios espacios se respetan en el SVG');
  const sp = textToSvg(T({ letterSpacing: 200, wordSpacing: 100, halo: false }), ctx);
  ok(sp.includes('letter-spacing="0.71"') && sp.includes('word-spacing="0.35"'), 'espaciados en el SVG');
  const right = textToSvg(T({ text: 'uno dos tres cuatro', boxWidth: 30, align: 'right', halo: false }), ctx);
  ok(right.includes('text-anchor="end"') && /x="40"/.test(right), 'cuadro a la derecha: el texto termina en el borde del cuadro');
  const j = textToSvg(T({ text: 'aa bb cc dd ee ff gg hh ii jj kk', boxWidth: 40, align: 'justify', halo: false }), ctx);
  ok((j.match(/text-anchor="start"/g) || []).length > 3, 'justificado: una palabra por tspan con su x');
  const lines = textToSvg(T({ text: 'a\nb\nc', lineHeight: 1.5, halo: false }), ctx);
  ok((lines.match(/<tspan/g) || []).length === 3 && lines.includes('dy="5.29"'), 'interlineado en el SVG');
  const old = { ...makeText(0, 0, 'viejo', undefined, 10) };
  delete old.align;
  delete old.lineHeight;
  ok(textToSvg(old, ctx).includes('viejo'), 'textos antiguos (sin los campos nuevos) siguen dibujándose');
  // el estirado de un texto con cuadro escala el cuadro
  const sc = scaleShape(T({ boxWidth: 40 }), { x: 0, y: 0 }, 2, 2);
  ok(sc.fontSize === 20 && sc.boxWidth === 80, 'estirar escala tamaño y cuadro');
  const bb = shapeBBox(T({ text: 'abcdef', rotation: 90 }), { mmToM: 1, ptToM: 1, mpp: 1 });
  const bb0 = shapeBBox(T({ text: 'abcdef', rotation: 0 }), { mmToM: 1, ptToM: 1, mpp: 1 });
  ok(bb.h > bb0.h && bb.w < bb0.w, 'la caja del texto girado se gira');
}

/* ---------------------------------------------------- halo del trazo (polígono) */
{
  const sq = makePath([makeNode(0, 0), makeNode(50, 0), makeNode(50, 50), makeNode(0, 50)], { closed: true, style: { ...defaultStyle(), stroke: '#0000ff', strokeWidth: 1, casing: true, casingColor: '#ffff00', casingWidth: 0.5, casingOpacity: 0.7 } });
  const c = { ...ctx, viewW: 100, viewH: 100 };
  const out = pathToSvg(sq, c);
  ok(out.includes('stroke="#ffff00"') && out.indexOf('#ffff00') < out.indexOf('#0000ff'), 'el halo del polígono va debajo del trazo');
  ok(out.includes('stroke-opacity="0.7"') && out.includes('stroke-width="3"'), 'halo hacia afuera: 2 × (grosor + halo)');
  const center = pathToSvg({ ...sq, style: { ...sq.style, align: 'center' } }, c);
  ok(center.includes('stroke-width="2"') && center.indexOf('#ffff00') < center.indexOf('#0000ff'), 'halo con borde centrado');
  ok(!pathToSvg({ ...sq, style: { ...sq.style, casing: false } }, c).includes('#ffff00'), 'sin halo');
  const q = styleToSymbolXml(sq.style, 'polygon', '0');
  ok(q.includes('ffff00') || q.includes('255,255,0'), 'el halo del polígono pasa a QGIS');
}

/* ------------------------------------------------------------ capas bloqueadas */
{
  let doc = newDocument();
  const a = makePath([makeNode(0, 0), makeNode(10, 0), makeNode(10, 10)], { closed: true, style: defaultStyle() });
  const b = makePoint(5, 5, defaultStyle());
  doc = addShapes(doc, doc.activeLayerId, [a, b]);
  const lid = doc.activeLayerId;
  const locked = updateLayer(doc, lid, (l) => ({ ...l, locked: true }));
  const style = mapShapes(locked, [a.id], (s) => ({ ...s, style: { ...s.style, fill: '#ff0000' } }));
  ok(findLayer(style, lid).items[0].style.fill === 'none', 'una capa bloqueada no cambia de estilo');
  ok(findLayer(removeShapes(locked, new Set([a.id])), lid).items.length === 2, 'ni se borra');
  ok(findLayer(replaceShapes(locked, new Map([[a.id, null]])), lid).items.length === 2, 'replaceShapes la salta');
  ok(findLayer(replaceShapes(locked, new Map([[a.id, null]]), { includeLocked: true }), lid).items.length === 1, '…salvo que se fuerce');
  ok(arrange(locked, new Set([a.id]), 'front').layers.find((l) => l.id === lid).items[0].id === a.id, 'ni se reordena');
  ok(group(locked, new Set([a.id, b.id])).id === null, 'ni se agrupa');
  const other = makeVectorLayer('Otra');
  const two = addLayer(locked, other);
  ok(findLayer(moveToLayer(two, new Set([a.id]), other.id), other.id).items.length === 0, 'ni se mueve a otra capa');
  ok(moveToLayer(locked, new Set([a.id]), lid) === locked, 'ni a una capa bloqueada');
  const line = makePath([makeNode(0, 0), makeNode(10, 0), makeNode(20, 0)], { style: defaultStyle() });
  const dl = updateLayer(addShapes(newDocument(), doc.activeLayerId, []), doc.activeLayerId, (l) => l);
  void dl;
  let d2 = addShapes(newDocument(), newDocument().activeLayerId, []);
  d2 = addShapes(d2, d2.activeLayerId, [line]);
  d2 = updateLayer(d2, d2.activeLayerId, (l) => ({ ...l, locked: true }));
  ok(splitPath(d2, line.id, 0, 0.5).error, 'la tijera tampoco corta una capa bloqueada');
  // el editor no deja seleccionar lo bloqueado
  const msgs = [];
  const ed = Object.create(Editor.prototype);
  ed.history = { doc: locked };
  ed.selection = new Set();
  ed.onMessage = (m) => msgs.push(m);
  ed.changed = () => {};
  Object.defineProperty(ed, 'doc', { get: () => locked });
  ed.setSelection([a.id, b.id]);
  ok(ed.selection.size === 0 && msgs.some((m) => /bloqueada/.test(m)), 'la selección excluye capas bloqueadas y avisa');
}

/* ---------------------------------------------- cuadros de texto del layout */
{
  let doc = newDocument();
  doc = addShapes(doc, doc.activeLayerId, [makePath([makeNode(350000, 6300000), makeNode(351000, 6300500)], { style: defaultStyle() })]);
  const t = { id: 'lt1', x: 30, y: 25, text: 'Mapa\ngeológico', fontSize: 14, align: 'center', anchor: 'middle', boxWidth: 60, color: '#ff0000', lineHeight: 1.3 };
  const L = { ...defaultLayout(doc), center: [350500, 6300250], texts: [t], offsets: { 'text:lt1': [5, -2] } };
  const out = composeLayout(doc, L);
  const part = out.parts.find((p) => p.el === 'text:lt1');
  ok(part && part.name.startsWith('Texto: Mapa') && part.svg.includes('translate(5 -2)') && part.svg.includes('fill="#ff0000"'), 'el cuadro de texto es un elemento movible del layout');
  ok(out.svg.includes('data-el="text:lt1"'), 'con data-el para arrastrarlo');
  const s = layoutTextShape(t);
  ok(s.type === 'text' && s.boxWidth === 60 && s.align === 'center' && s.style.fill === '#ff0000', 'forma de texto del layout');
  ok(!composeLayout(doc, { ...L, texts: [] }).parts.some((p) => p.el?.startsWith('text:')), 'sin textos no hay elementos de texto');
}

/* ------------------------------------------------------ estilos de layout */
{
  const mem = new Map();
  globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
  const doc = newDocument();
  const L = { ...defaultLayout(doc), page: 'A3', orientation: 'portrait', title: 'Mi mapa', scale: 50000, center: [1, 2], frame: { x: 10, y: 20, w: 100, h: 120 }, offsets: { legend: [3, 4] }, texts: [{ id: 'a', x: 1, y: 2, text: 'hola' }], gridColor: '#123456' };
  const st = pickStyle(L);
  ok(st.page === 'A3' && st.frame.w === 100 && st.offsets.legend[1] === 4 && st.texts.length === 1 && st.gridColor === '#123456', 'el estilo guarda página, marco, posiciones, textos y grilla');
  ok(!('scale' in st) && !('center' in st) && !('title' in st) && !('author' in st) && !('date' in st), 'y no guarda lo del mapa concreto');
  st.texts[0].text = 'otro';
  ok(L.texts[0].text === 'hola', 'copia profunda');
  saveStyle('Mi estilo A3', L);
  saveStyle('Otro', { ...L, page: 'A4' });
  ok(listStyles().map((s) => s.name).join('|') === 'Mi estilo A3|Otro', 'lista ordenada');
  saveStyle('Mi estilo A3', { ...L, page: 'A2' });
  ok(listStyles().length === 2 && getStyle('Mi estilo A3').page === 'A2', 'guardar con el mismo nombre reemplaza');
  const target = { ...defaultLayout(doc), scale: 10000, center: [9, 9], title: 'Otro mapa', frame: null };
  const applied = applyStyle(target, getStyle('Otro'));
  ok(applied.page === 'A4' && applied.scale === 10000 && applied.center[0] === 9 && applied.title === 'Otro mapa', 'aplicar conserva escala, centro y títulos');
  ok(applied.frame && applied.frame.w === 100 && applied.texts.length === 1, 'aplicar trae marco y textos');
  const bare = applyStyle({ ...target, frame: { x: 1, y: 1, w: 9, h: 9 }, texts: [{ id: 'z' }] }, { page: 'A4' });
  ok(bare.frame === null && bare.texts.length === 0, 'un estilo sin marco ni textos los quita');
  const file = styleFile('Otro', getStyle('Otro'));
  const back = parseStyleFile(file);
  ok(back[0].name === 'Otro' && back[0].style.page === 'A4', 'archivo de estilo');
  deleteStyle('Otro');
  importStyles(back);
  ok(listStyles().some((s) => s.name === 'Otro'), 'importar');
  let err = '';
  try {
    parseStyleFile('{"hola":1}');
  } catch (e) {
    err = e.message;
  }
  ok(/no es un estilo/i.test(err), 'rechaza archivos ajenos');
  let err2 = '';
  try {
    saveStyle('  ', L);
  } catch (e) {
    err2 = e.message;
  }
  ok(/nombre/i.test(err2), 'pide nombre');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLARON` : ''}`);
if (fail) process.exit(1);
