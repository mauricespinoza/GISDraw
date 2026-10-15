/**
 * Simbología por campo (Categorizado / Graduado), etiquetas con varios
 * campos y plantillas, y su traducción a QGIS.
 *
 *   node test/attributes.test.mjs
 */

import { buildRenderer, applyRenderer, classIndex, classBreaks, rampColors, uniqueValues, rendererLabel, countClasses, clearRenderer, fieldChoices } from '../src/symbology.js';
import { labelText, evalTemplate, hasLabelSource } from '../src/labels.js';
import { labelExpression, labelingXml, fieldRendererXml, styleToSymbolXml } from '../src/io/qml.js';
import { legendEntries } from '../src/layout/compose.js';
import { makeNode, makePath, makePoint } from '../src/vector.js';
import { defaultStyle } from '../src/style.js';
import { newDocument, addShapes, findLayer, makeVectorLayer, addLayer } from '../src/doc.js';

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

const poly = (attrs, name) => makePath([makeNode(0, 0), makeNode(10, 0), makeNode(10, 10)], { closed: true, attrs, name, style: { ...defaultStyle(), fill: 'none' } });
const line = (attrs) => makePath([makeNode(0, 0), makeNode(10, 10)], { attrs, style: { ...defaultStyle(), stroke: '#000000' } });

const items = [
  poly({ unidad: 'Kia', edad: 100, espesor: 10 }, 'a'),
  poly({ unidad: 'Kia', edad: 100, espesor: 20 }, 'b'),
  poly({ unidad: 'Ms', edad: 12.5, espesor: 35 }, 'c'),
  poly({ unidad: 'Q', edad: 0.5, espesor: 50 }, 'd'),
  poly({ unidad: '', edad: '', espesor: 90 }, 'e'),
];

/* ---------------------------------------------------------- valores y rampas */
{
  const u = uniqueValues(items, 'unidad');
  ok(u.values.map((v) => v.key).join('|') === 'Kia|Ms|Q|', 'valores únicos con el vacío al final');
  ok(u.values[0].count === 2, 'conteo');
  ok(uniqueValues(items, 'edad').numeric, 'detecta campo numérico');
  ok(uniqueValues(items, '$nombre').values.length === 5, '$nombre como campo');
  ok(rampColors('viridis', 5).length === 5 && rampColors('viridis', 5)[0] === '#440154', 'rampa degradada');
  ok(rampColors('geo', 20).length === 20, 'rampa cualitativa se repite');
  ok(rampColors('blues', 3, true)[0] === rampColors('blues', 3)[2], 'invertir');
  const choices = fieldChoices({ fields: ['x'], items });
  ok(choices.x && choices.unidad && choices.$nombre && choices.$tipo && !choices.__area_ha, 'campos disponibles');
}

/* ---------------------------------------------------------------- cortes */
{
  const v = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const eq = classBreaks(v, 3, 'equal');
  near(eq[1], 4, 1e-9, 'intervalos iguales');
  const q = classBreaks(v, 2, 'quantile');
  near(q[1], 5.5, 1e-9, 'mediana');
  const pr = classBreaks([3, 97], 4, 'pretty');
  ok(pr[0] === 0 && pr[pr.length - 1] >= 97, `cortes redondos: ${pr}`);
  const jk = classBreaks([1, 2, 2, 3, 50, 51, 52, 100, 101, 102], 3, 'jenks');
  ok(jk.length === 4 && jk[1] === 50 && jk[2] === 100, `Jenks separa los grupos: ${jk}`);
  ok(classBreaks([5, 5, 5], 4, 'quantile').length === 2, 'valores iguales');
  ok(classBreaks([15, 120, 340, 610, 880, 1500], 4, 'jenks').length === 5, 'Jenks conserva la clase del máximo solo');
}

/* ----------------------------------------------------- categorizado y graduado */
{
  const r = buildRenderer(items, { field: 'unidad', mode: 'categorized', ramp: 'geo' });
  ok(r.classes.length === 4 && r.classes[3].label === '(vacío)' && r.classes[0].count === 2, 'categorizado: clases');
  ok(classIndex(r, items[1]) === 0 && classIndex(r, items[4]) === 3, 'índice de clase');
  const g = buildRenderer(items, { field: 'espesor', mode: 'graduated', ramp: 'viridis', n: 3, method: 'equal' });
  ok(g.classes.length === 3 && g.classes.reduce((a, c) => a + c.count, 0) === 5, 'graduado: todos caen en una clase');
  ok(classIndex(g, items[0]) === 0 && classIndex(g, items[4]) === 2, 'graduado: extremos (el máximo cae en la última)');
  ok(/–/.test(g.classes[0].label), 'rótulo de rango');
  ok(buildRenderer(items, { field: 'edad', mode: 'graduated', n: 2 }).classes.length === 2, 'graduado ignora vacíos');
  let err = '';
  try {
    buildRenderer(items, { field: 'unidad', mode: 'graduated' });
  } catch (e) {
    err = e.message;
  }
  ok(/numéricos/.test(err), 'graduado de un campo de texto avisa');
  try {
    buildRenderer(items, { field: '' });
  } catch (e) {
    err = e.message;
  }
  ok(/campo/i.test(err), 'sin campo avisa');

  // aplicar al documento: polígonos → relleno; líneas → trazo; punto → relleno
  let doc = newDocument();
  const ln = line({ unidad: 'Kia' });
  const pt = makePoint(1, 1, { ...defaultStyle(), fill: '#ffffff' }, { unidad: 'Ms' });
  doc = addShapes(doc, doc.activeLayerId, [...items, ln, pt]);
  const layer = findLayer(doc, doc.activeLayerId);
  const rr = buildRenderer(layer.items, { field: 'unidad', mode: 'categorized', ramp: 'set1' });
  const doc2 = applyRenderer(doc, layer.id, rr);
  const L2 = findLayer(doc2, layer.id);
  ok(L2.renderer && L2.items[0].style.fill === rr.classes[0].color && L2.items[0].style.fillOpacity === 0.6, 'polígono: relleno de su clase (con opacidad si no tenía)');
  ok(L2.items[5].style.stroke === rr.classes[0].color && L2.items[5].style.fill === 'none', 'línea: trazo');
  ok(L2.items[6].style.fill === rr.classes[1].color, 'punto: relleno');
  ok(L2.items[0].style.stroke === layer.items[0].style.stroke, 'el trazo del polígono no cambia en automático');
  const both = applyRenderer(doc, layer.id, { ...rr, target: 'both' });
  ok(findLayer(both, layer.id).items[0].style.stroke === rr.classes[0].color, 'relleno y trazo');
  ok(rendererLabel(rr, items[2]) === 'Ms' && rendererLabel(rr, { attrs: { unidad: 'zzz' } }) === 'Otros valores', 'rótulo de clase y otros');
  const cc = countClasses(rr, layer.items);
  ok(cc.counts[0] === 3 && cc.other === 0, 'conteo de clases');
  ok(findLayer(clearRenderer(doc2, layer.id), layer.id).renderer === null, 'quitar clasificación');

  // la leyenda lleva los rótulos de clase y sigue su orden
  const entries = legendEntries([L2])[0].entries;
  ok(entries.map((e) => e.label).join('|').startsWith('Kia') && entries.some((e) => e.label === 'Ms'), `leyenda por clases: ${entries.map((e) => e.label)}`);

  // exportación a QGIS: renderizador real sobre el campo (el GeoPackage se prueba en el navegador)
  const spec = { mode: 'categorized', attr: 'unidad', numeric: false, classes: [{ key: 'Kia', label: 'Kia', style: items[0].style }, { key: 'Ms', label: 'Ms', style: items[2].style }], other: { label: 'Otros', style: items[3].style } };
  const x = fieldRendererXml(spec, 'polygon');
  ok(x.includes('type="categorizedSymbol" attr="unidad"') && x.includes('value="Kia"') && x.includes('value="" label="Otros"') && x.includes('<source-symbol>'), 'QML categorizado por campo');
  const gx = fieldRendererXml({ mode: 'graduated', attr: 'espesor', classes: [{ lower: 0, upper: 10, label: '0 – 10', style: items[0].style }] }, 'polygon');
  ok(gx.includes('graduatedSymbol') && gx.includes('lower="0" upper="10"'), 'QML graduado');
  ok(fieldRendererXml({ ...spec, attr: 'Edad (Ma)' }, 'polygon').includes('attr="&quot;Edad (Ma)&quot;"'), 'campo con espacios entrecomillado');
}

/* ------------------------------------------------------- etiquetas con campos */
{
  const s = poly({ codigo: 'Kia', edad: 100.456, nombre: 'Fm. Abanico', vacio: '' }, 'Unidad X');
  ok(labelText(s, { field: 'codigo' }) === 'Kia', 'campo único');
  ok(labelText(s, { fields: ['codigo', 'vacio', 'edad'], sep: 'dash' }) === 'Kia – 100.456', 'varios campos omiten los vacíos');
  ok(labelText(s, { fields: ['codigo', 'edad'], sep: 'paren' }) === 'Kia (100.456)', 'separador paréntesis');
  ok(labelText(s, { fields: ['vacio', 'codigo'], sep: 'paren' }) === 'Kia', 'paréntesis con un solo valor');
  ok(labelText(s, { fields: ['codigo', '$nombre', '$tipo'], sep: 'comma' }) === 'Kia, Unidad X, polígono', 'campos especiales');
  ok(labelText(s, { template: '{codigo} ({edad:1} Ma)' }) === 'Kia (100.5 Ma)', 'plantilla con decimales');
  ok(evalTemplate('{vacio||nombre||codigo}', s) === 'Fm. Abanico', 'alternativas: la primera con valor');
  ok(evalTemplate('{vacio||codigo}', s) === 'Kia' && evalTemplate('{codigo|lower}', s) === 'kia' && evalTemplate('{nombre|upper}', s) === 'FM. ABANICO', 'alternativa y filtros');
  ok(evalTemplate('{nombre|title}', { attrs: { nombre: 'FORMACIÓN abanico' } }) === 'Formación Abanico', 'title');
  ok(labelText(s, { template: '{codigo}', fields: ['edad'], upper: true }) === 'KIA', 'la plantilla manda sobre los campos; mayúsculas');
  ok(hasLabelSource({ fields: ['a'] }) && !hasLabelSource({ fields: [] }) && hasLabelSource({ template: '{a}' }), 'hay de dónde sacar el texto');

  const e1 = labelExpression({ fields: ['codigo', 'edad'], sep: 'dash' });
  ok(e1.expr.includes('array_to_string(array_filter(array(') && e1.expr.includes("' – '"), 'QGIS: varios campos');
  ok(labelExpression({ fields: ['a', 'b'], sep: 'paren' }).expr.includes("' ('"), 'QGIS: paréntesis');
  ok(labelExpression({ field: 'codigo' }).field === 'codigo' && labelExpression({ field: '$nombre' }).field === 'gd_name', 'QGIS: campo simple');
  const e2 = labelExpression({ template: '{codigo||$nombre} ({edad:1}) {x|upper}' });
  ok(e2.expr.includes('coalesce(nullif(') && e2.expr.includes('format_number("edad", 1)') && e2.expr.includes('upper('), `QGIS: plantilla: ${e2.expr}`);
  const xml = labelingXml({ enabled: true, fields: ['codigo', 'edad'], sep: 'space', fontFamily: 'Arial', fontSize: 8, fontWeight: 400, color: '#000000', haloColor: '#ffffff', haloWidth: 0.5 }, 'polygon');
  ok(xml.includes('isExpression="1"') && xml.includes('array_to_string'), 'labeling XML con expresión');
  ok(!labelingXml({ enabled: true, fields: [], field: '', template: '' }, 'polygon'), 'sin origen no hay etiquetado');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLARON` : ''}`);
if (fail) process.exit(1);
