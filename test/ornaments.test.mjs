/**
 * Ornamentos de falla, línea ondulada, tramas de litología y halo de texto.
 *   node test/ornaments.test.mjs
 */
import { placements, ornamentsSvg, symbolOf, ornamentDefaults, ORNAMENTS, U } from '../src/ornaments.js';
import { PATTERNS, PATTERN_IDS, patternDef, patternPreview } from '../src/patterns.js';
import { defaultStyle, pathToSvg, pointToSvg, textToSvg, wavyPoints, screenLine } from '../src/style.js';
import { makePath, makeNode, makeRectPath, makePoint, makeText } from '../src/vector.js';

let pass = 0;
let fail = 0;
const ok = (c, m) => (c ? pass++ : (fail++, console.error('✗', m)));
const near = (a, b, t, m) => ok(Math.abs(a - b) <= t, `${m}: ${a} ≠ ${b}`);
const nums = (s) => (s.match(/-?\d+(\.\d+)?/g) || []).map(Number);
const ctx = (extra = {}) => ({ P: (x, y) => [x, y], mmToPx: 1, ptToPx: 0.352778, viewW: 1000, viewH: 1000, defs: [], uid: 't', flatTol: 0.05, ...extra });

/* ------------------------------------------------------------- colocación */
{
  // 100 de largo, separación 20 -> a 10, 30, 50, 70, 90
  const p = placements([[0, 0], [100, 0]], 20, 2);
  ok(p.length === 5, `5 símbolos (${p.length})`);
  near(p[0].x, 10, 1e-9, 'primero a media separación');
  near(p[4].x, 90, 1e-9, 'último');
  ok(p.every((q) => Math.abs(q.ang) < 1e-12), 'tangente a lo largo de la línea');
  // línea más corta que la separación: uno solo, al centro
  const one = placements([[0, 0], [12, 0]], 20, 2);
  ok(one.length === 1 && Math.abs(one[0].x - 6) < 1e-9, 'línea corta con un símbolo al centro');
  ok(placements([[0, 0], [3, 0]], 20, 2).length === 0 || placements([[0, 0], [3, 0]], 20, 2).length === 1, 'sin errores en líneas minúsculas');
  // sigue una línea quebrada
  const bent = placements([[0, 0], [50, 0], [50, 50]], 25, 2);
  ok(bent.some((q) => Math.abs(q.ang - Math.PI / 2) < 1e-9), 'gira con el segmento vertical');
}

/* --------------------------------------------------- lado de dientes y tics */
{
  const base = { ...ornamentDefaults('thrust'), ornamentSpacing: 40 };
  const line = [[0, 50], [100, 50]];
  // izquierda del sentido de avance (+x) = hacia ARRIBA en pantalla (y menor)
  const left = ornamentsSvg(line, base, 1, '#00f');
  const ysL = nums(left.symbols.match(/d="([^"]+)"/)[1]).filter((_, i) => i % 2 === 1);
  ok(Math.min(...ysL) < 50 && Math.max(...ysL) <= 50 + 1e-9, 'dientes a la izquierda: la punta está arriba y la base sobre la línea');
  const right = ornamentsSvg(line, { ...base, ornamentSide: 'right' }, 1, '#00f');
  const ysR = nums(right.symbols.match(/d="([^"]+)"/)[1]).filter((_, i) => i % 2 === 1);
  ok(Math.max(...ysR) > 50 && Math.min(...ysR) >= 50 - 1e-9, 'dientes a la derecha: punta abajo');
  // el diente mide lo mismo que en FieldDraw: 11 × 9 unidades de diseño
  const xsL = nums(left.symbols.match(/d="([^"]+)"/)[1]).filter((_, i) => i % 2 === 0);
  const first = xsL.slice(0, 3);
  near(Math.max(...first) - Math.min(...first), 11 * U, 0.02, 'ancho del diente = 11 u');
  near(50 - Math.min(...ysL), 9 * U, 0.02, 'alto del diente = 9 u');
  // el halo va aparte (para dibujarlo debajo de la traza)
  ok(left.halo.includes('#ffffff') && !left.symbols.includes('#ffffff'), 'halo blanco separado de los símbolos');
  ok(ornamentsSvg(line, { ...base, ornamentHalo: false }, 1, '#00f').halo === '', 'halo desactivable');
  // los pliegues y las de rumbo no cambian con el lado
  const a = ornamentsSvg(line, { ...ornamentDefaults('antiform'), ornamentSpacing: 40 }, 1, '#f0f');
  const b = ornamentsSvg(line, { ...ornamentDefaults('antiform'), ornamentSpacing: 40, ornamentSide: 'right' }, 1, '#f0f');
  ok(a.symbols === b.symbols, 'antiforme simétrico: el lado no cambia nada');
}

/* ------------------------------------------- medias flechas: sentido de rumbo */
{
  // El bloque del lado NORTE de una falla dextral se mueve hacia el este, sea cual
  // sea el sentido en que se digitalizó la línea.
  const flipLine = (pts) => pts.slice().reverse();
  for (const [kind, northGoesEast] of [['dextral', true], ['sinistral', false]]) {
    for (const pts of [[[0, 50], [200, 50]], flipLine([[0, 50], [200, 50]])]) {
      const o = ornamentsSvg(pts, { ...ornamentDefaults(kind), ornamentSpacing: 400 }, 1, '#00f');
      // dos astiles: "M x y L x y" cada uno
      const lines = o.symbols.match(/d="([^"]+)"/g).map((m) => nums(m)).find((v) => v.length === 8);
      const shafts = [lines.slice(0, 4), lines.slice(4, 8)];
      const north = shafts.find((s) => s[1] < 50);
      const east = north[2] > north[0];
      ok(east === northGoesEast, `${kind}: el bloque norte va al ${northGoesEast ? 'este' : 'oeste'} (línea ${pts[0][0] === 0 ? 'directa' : 'invertida'})`);
    }
  }
  const gap = ornamentsSvg([[0, 50], [200, 50]], { ...ornamentDefaults('dextral'), ornamentSpacing: 400, ornamentGap: 2 }, 1, '#00f').symbols;
  const v = nums(gap.match(/d="([^"]+)"/g).map((m) => m).find((m) => nums(m).length === 8));
  near(Math.abs(v[1] - 50), 2, 1e-6, 'distancia de la flecha a la traza = gap');
}

/* ------------------------------------------------- dirección de los pliegues */
{
  const head = (type) => {
    const sym = symbolOf(type);
    return sym.prims.filter((p) => p.poly).map((p) => p.poly[0][1]); // y de las puntas
  };
  const ant = head('antiform');
  ok(ant[0] < ant[1] === true && ant[0] < 0 && ant[1] > 0, 'antiforme: puntas hacia afuera del eje');
  const syn = head('synform');
  ok(Math.abs(syn[0]) < 2 && Math.abs(syn[1]) < 2, 'sinforme: puntas hacia el eje');
}

/* ------------------------------------------------------------------ onda */
{
  const straight = [[0, 0], [100, 0]];
  const w = wavyPoints(straight, 2, 10);
  const ys = w.map((p) => p[1]);
  near(Math.max(...ys), 2, 0.05, 'amplitud máxima');
  near(Math.min(...ys), -2, 0.05, 'amplitud mínima');
  near(w[0][1], 0, 1e-9, 'arranca en fase cero');
  ok(w.length > 150, 'muestreada fina');
  // 10 ciclos exactos: termina en cero y es más larga que la recta
  near(w[w.length - 1][1], 0, 1e-6, 'termina en cero (10 ciclos)');
  const len = w.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - w[i - 1][0], p[1] - w[i - 1][1]) : 0), 0);
  ok(len > 100, 'la onda es más larga que la recta');
  ok(wavyPoints(straight, 0, 10) === straight, 'amplitud 0 = recta');
  // en una línea vertical la onda va en x
  const vert = wavyPoints([[0, 0], [0, 100]], 2, 10);
  ok(Math.max(...vert.map((p) => Math.abs(p[0]))) > 1.9, 'onda perpendicular a la línea');
  const shape = makePath([makeNode(0, 0), makeNode(100, 0)], { style: { ...defaultStyle(), wavy: true, waveAmp: 2, waveLen: 10, stroke: '#000', strokeWidth: 0.5 } });
  const svg = pathToSvg(shape, ctx());
  ok(svg.split('L').length > 100, 'pathToSvg dibuja la onda');
  ok(pathToSvg({ ...shape, style: { ...shape.style, wavy: false } }, ctx()).includes('M0 0L100 0'), 'sin onda es la recta original (M..L)');
}

/* ------------------------------------------------------------ tramas */
{
  ok(PATTERN_IDS.length >= 30, `catálogo de tramas (${PATTERN_IDS.length})`);
  for (const k of PATTERN_IDS) {
    const d = PATTERNS[k].draw('#123456');
    ok(!/NaN|undefined/.test(d) && d.includes('#123456'), `trama ${k} bien formada y con color`);
    ok(!/stroke-width="0"/.test(d), `trama ${k} sin trazos de ancho 0`);
  }
  for (const k of ['sandstone', 'conglomerate', 'limestone', 'dolomite', 'shale', 'granite', 'basalt', 'gneiss', 'coal', 'alluvium']) ok(PATTERNS[k], `trama clásica: ${k}`);
  const def = patternDef('p1', 'sandstone', '#000', 20);
  ok(def.startsWith('<pattern id="p1"') && def.includes('width="20"') && def.includes('scale(2)'), 'mosaico escalado al tamaño pedido');
  ok(patternDef('x', 'no-existe', '#000', 10) === '', 'trama desconocida no rompe');
  ok(patternPreview('limestone').includes('<pattern'), 'miniatura del selector');

  const st = { ...defaultStyle(), fill: '#fde68a', fillOpacity: 1, pattern: 'sandstone', patternColor: '#111', patternSize: 4, stroke: '#000', strokeWidth: 0.3 };
  const a = makeRectPath(0, 0, 50, 50, st);
  const b = makeRectPath(60, 0, 110, 50, st);
  const c = ctx();
  const sa = pathToSvg(a, c);
  pathToSvg(b, c);
  ok(sa.includes('fill="url(#t') && sa.includes('fill="#fde68a"'), 'color de la unidad + trama encima');
  ok(sa.indexOf('#fde68a') < sa.indexOf('url(#t'), 'la trama va sobre el color');
  ok(c.defs.filter((d) => d.startsWith('<pattern')).length === 1, 'dos polígonos con la misma trama comparten un solo mosaico');
  const c2 = ctx();
  pathToSvg(makeRectPath(0, 0, 10, 10, { ...st, pattern: 'granite' }), c2);
  pathToSvg(a, c2);
  ok(c2.defs.filter((d) => d.startsWith('<pattern')).length === 2, 'tramas distintas = mosaicos distintos');
  ok(!pathToSvg(makeRectPath(0, 0, 10, 10, { ...st, pattern: 'none' }), ctx()).includes('<pattern') , 'sin trama no hay mosaico');
}

/* ------------------------------------------------- halo del texto y de la línea */
{
  const t = makeText(10, 10, 'Hola', null, 10);
  const svg = textToSvg(t, ctx());
  const texts = svg.match(/<text [^>]*>/g);
  ok(texts.length === 2, 'halo = un texto debajo + el texto de relleno');
  ok(texts[0].includes('stroke="#ffffff"') && texts[0].includes('stroke-width='), 'el de abajo lleva el trazo del halo');
  ok(!texts[1].includes('stroke') && !svg.includes('paint-order'), 'el de arriba no lleva trazo: el halo solo asoma por fuera');
  ok(svg.indexOf(texts[0]) < svg.indexOf(texts[1]), 'orden: halo antes que el relleno');
  const nohalo = textToSvg({ ...t, halo: false }, ctx());
  ok(nohalo.match(/<text /g).length === 1, 'sin halo un solo texto');

  // halo de línea: más ancho que el trazo, por debajo, y el centro conserva el color
  const line = makePath([makeNode(0, 0), makeNode(100, 0)], { style: { ...defaultStyle(), stroke: '#c00', strokeWidth: 1, casing: true, casingWidth: 0.5, casingColor: '#fff', casingOpacity: 0.6 } });
  const ls = pathToSvg(line, ctx());
  const widths = [...ls.matchAll(/stroke-width="([\d.]+)"/g)].map((m) => Number(m[1]));
  ok(widths[0] === 2 && widths[1] === 1, 'halo de 2 (1 + 2×0,5) bajo el trazo de 1');
  ok(ls.indexOf('stroke="#fff"') < ls.indexOf('stroke="#c00"'), 'el halo se dibuja antes que el trazo');
  ok(ls.includes('stroke-opacity="0.6"'), 'opacidad del halo');
}

/* ----------------------------------------- ornamento integrado en la línea */
{
  const line = makePath([makeNode(0, 0), makeNode(100, 0)], {
    style: { ...defaultStyle(), stroke: '#00f', strokeWidth: 0.5, casing: true, casingColor: '#fff', ...ornamentDefaults('thrust') },
  });
  const svg = pathToSvg(line, ctx({ mmToPx: 3.78 }));
  const iHalo = svg.indexOf('opacity="0.55"');
  const iCasing = svg.indexOf('stroke="#fff"', iHalo + 10);
  const iCore = svg.lastIndexOf('fill="none" stroke="#00f"');
  const iSym = svg.lastIndexOf('<g fill="#00f"');
  ok(iHalo > 0 && iHalo < iCasing && iCasing < iCore && iCore < iSym, 'orden de capas: halo del ornamento, halo de línea, trazo, símbolos');
  // 100 px de línea con la separación de FieldDraw (6,9 mm = 26 px a 3,78 px/mm): 4 dientes
  ok((svg.match(/M[\d. -]+L[\d. -]+L[\d. -]+Z/g) || []).length === 8, 'cuatro dientes (el conteo cuenta halo y símbolo)');
  // a escalas muy pequeñas no se dibujan (no son legibles)
  ok(!pathToSvg(line, ctx({ mmToPx: 0.05 })).includes('<g fill="#00f"'), 'ornamento omitido cuando sería menor a 1,5 px');
  ok(!pathToSvg({ ...line, style: { ...line.style, ornament: 'none' } }, ctx()).includes('<g fill="#00f"'), 'sin ornamento no hay símbolos');
  for (const k of Object.keys(ORNAMENTS)) ok(ornamentDefaults(k).ornament === k, `defaults de ${k}`);
}

/* ---------- salida en mm de papel (lámina / imagen): lo que se ve se exporta, también lo chico */
{
  const PX = 25.4 / 96; // un píxel de pantalla, en mm
  const mm = (extra = {}) => ctx({ mmToPx: 1, pxUnit: PX, ...extra });
  const line = (size) => makePath([makeNode(0, 0), makeNode(100, 0)], { style: { ...defaultStyle(), stroke: '#00f', strokeWidth: 0.4, ...ornamentDefaults('thrust'), ornamentSize: size } });
  for (const size of [1, 0.5, 0.3]) ok(pathToSvg(line(size), mm()).includes('<g fill="#00f"'), `ornamento de tamaño ${size} en mm de papel`);
  ok(!pathToSvg(line(0.3), ctx({ mmToPx: 1 })).includes('<g fill="#00f"'), 'sin pxUnit sigue el mínimo de pantalla (1,5 px)');
  // punto de 1 mm: radio 0,5 mm, no el mínimo de 1 unidad
  const pt = makePoint(5, 5, { ...defaultStyle(), fill: '#c00', stroke: 'none', pointSize: 1, pointShape: 'circle' });
  const r = Number(/a([\d.]+) /.exec(pointToSvg(pt, mm()))?.[1]);
  ok(Math.abs(r - 0.5) < 0.01, 'punto de 1 mm: radio de 0,5 mm → ' + r);
  // trama de 1 mm: baldosa de 1 mm
  const poly = makeRectPath(0, 0, 10, 10, { ...defaultStyle(), fill: '#eee', stroke: 'none', pattern: 'dots', patternSize: 1 });
  const dctx = mm();
  pathToSvg(poly, dctx);
  ok(/width="1"/.test(dctx.defs.join('')), 'trama de 1 mm: baldosa de 1 mm');
  // letra de 2 pt (0,7 mm) se dibuja
  ok(textToSvg(makeText(5, 5, 'a', undefined, 2), mm({ ptToPx: 0.352778 })).includes('<text'), 'texto de 2 pt en mm de papel');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLARON` : ''}`);
if (fail) process.exit(1);
