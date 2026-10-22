/**
 * Modos Canvas / GIS y lienzo (hoja, valores por defecto).
 *
 *   node test/mode.test.mjs
 */

import { CANVAS_SIZES, CANVAS_CENTER, canvasCovering, canvasDefaults, canvasFromMm, canvasMm, canvasRect, defaultCanvas, isGisLayer, modeOf, normalizeCanvas } from '../src/mode.js';
import { newDocument, normalizeDoc } from '../src/doc.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}

ok(modeOf({}) === 'canvas' && modeOf({ mode: 'gis' }) === 'gis' && modeOf({ mode: 'x' }) === 'canvas' && modeOf(null) === 'canvas', 'Canvas por defecto');
ok(isGisLayer({ kind: 'basemap' }) && isGisLayer({ kind: 'hillshade' }) && !isGisLayer({ kind: 'image' }) && !isGisLayer({ kind: 'vector' }), 'capas GIS');

// por defecto: A4 vertical
const c0 = defaultCanvas();
ok(c0.size === 'A4' && c0.orientation === 'portrait' && c0.w === 210 && c0.h === 297, 'A4 vertical por defecto');
ok(newDocument().canvas.size === 'A4' && newDocument().canvas.orientation === 'portrait', 'documento nuevo en A4 vertical');
ok(normalizeDoc({ layers: [] }).canvas.size === 'A4', 'proyecto antiguo sin lienzo → A4 vertical');

// tamaños típicos
for (const [k, mm] of [['Carta', [216, 279]], ['A4', [210, 297]], ['A3', [297, 420]], ['A2', [420, 594]], ['A1', [594, 841]], ['A0', [841, 1189]]]) {
  ok(CANVAS_SIZES[k] && canvasMm({ size: k }).join() === mm.join(), `tamaño ${k}`);
}
ok(CANVAS_SIZES.Carta.label === 'Letter', 'Letter');
ok(canvasMm({ size: 'A3', orientation: 'landscape' }).join() === '420,297', 'horizontal intercambia ancho y alto');
ok(canvasMm({ size: 'custom', w: 400, h: 100, orientation: 'portrait' }).join() === '100,400', 'personalizado vertical');
ok(normalizeCanvas({ size: 'zzz', w: 5, h: -1 }).w === 10, 'medidas mínimas');
ok(normalizeCanvas({ size: 'A3', w: 1, h: 1 }).w === 297, 'una hoja conocida manda sobre w/h');

// hoja en el mundo: mm × escala de referencia, centrada en CANVAS_CENTER
const doc = { canvas: { size: 'A4', orientation: 'portrait' }, refScale: 1000 };
const r = canvasRect(doc);
ok(r.w === 210 && r.h === 297, 'a 1:1000, 1 mm = 1 m');
ok(Math.abs(r.x + r.w / 2 - CANVAS_CENTER[0]) < 1e-6 && Math.abs(r.y + r.h / 2 - CANVAS_CENTER[1]) < 1e-6, 'hoja centrada');
ok(canvasRect({ canvas: { size: 'A4' }, refScale: 25000 }).w === 5250, 'a 1:25000, A4 = 5250 m de ancho');

// hoja a partir de unas medidas (mesa de trabajo de un .ai)
ok(canvasFromMm(210, 297).size === 'A4' && canvasFromMm(210, 297).orientation === 'portrait', 'medidas A4');
ok(canvasFromMm(297, 210).size === 'A4' && canvasFromMm(297, 210).orientation === 'landscape', 'A4 horizontal');
ok(canvasFromMm(612 * 0.352778, 792 * 0.352778).size === 'Carta', 'Letter de un PDF (612 × 792 pt)');
const cu = canvasFromMm(500, 300);
ok(cu.size === 'custom' && cu.w === 300 && cu.h === 500 && cu.orientation === 'landscape', 'medidas propias');

// valores por defecto de una figura de media hoja
const d4 = canvasDefaults({ size: 'A4' });
ok(d4.strokeWidth === 0.35 && d4.fontSize === 9, `A4: ${d4.strokeWidth} mm y ${d4.fontSize} pt`);
const dL = canvasDefaults({ size: 'A4', orientation: 'landscape' });
ok(dL.strokeWidth === 0.35 && dL.fontSize === 9, 'la orientación no cambia los valores');
const d3 = canvasDefaults({ size: 'A3' });
ok(Math.abs(d3.fontSize - 9 * Math.SQRT2) <= 0.5 && d3.strokeWidth > 0.45 && d3.strokeWidth < 0.55, `A3 crece con la hoja: ${d3.strokeWidth} mm, ${d3.fontSize} pt`);
ok(canvasDefaults({ size: 'A0' }).fontSize > canvasDefaults({ size: 'A1' }).fontSize, 'A0 > A1');
ok(Math.abs(canvasDefaults({ size: 'Carta' }).fontSize - 9) <= 0.5, 'Letter ≈ A4');

/* hoja personalizada con posición propia y «Encajar a objetos» */
{
  const doc = { ...newDocument(), refScale: 25000 };
  const box = { x: 1000, y: 2000, w: 500, h: 250 }; // 20 × 10 mm de papel a 1:25.000
  const c = canvasCovering(box, 25000);
  ok(c.size === 'custom' && c.w === 20 && c.h === 10 && c.orientation === 'landscape', 'canvasCovering: medidas en mm de papel');
  const r = canvasRect({ ...doc, canvas: c });
  ok(Math.abs(r.x - 1000) < 1e-6 && Math.abs(r.y - 2000) < 1e-6 && Math.abs(r.w - 500) < 1e-6 && Math.abs(r.h - 250) < 1e-6, 'la hoja cubre exactamente la caja');
  ok(normalizeDoc({ ...doc, canvas: c }).canvas.cx === 1250, 'la posición sobrevive a normalizeDoc (guardar/abrir)');
  ok(canvasRect(doc).x === CANVAS_CENTER[0] - canvasRect(doc).w / 2, 'sin posición: centrada en la vista inicial');
  const tiny = canvasCovering({ x: 0, y: 0, w: 1, h: 1 }, 25000);
  ok(tiny.w === 10 && tiny.h === 10, 'no baja de 10 mm');
  ok(normalizeCanvas({ size: 'A4', cx: 'x', cy: 1 }).cx === undefined, 'posición inválida se descarta');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
