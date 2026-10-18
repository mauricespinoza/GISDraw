/**
 * Importación de Illustrator (.ai) / PDF vectorial.
 *
 *   node test/pdf.test.mjs
 */

import { deflateSync } from 'node:zlib';
import { inflate, pdfToSvg, importPdf, isPdfBytes } from '../src/io/pdfImport.js';
import { packLayers, unpackLayers } from '../src/io/transport.js';
import { importSvg, parsePathD } from '../src/io/svgImport.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}

/** PDF mínimo: objetos sueltos (o dentro de un flujo de objetos) y tabla xref. */
function buildPdf(objs, { root = 1, objStm = false, header = '%PDF-1.6\n%\xe2\xe3\xcf\xd3\n' } = {}) {
  const parts = [Buffer.from(header, 'latin1')];
  let len = parts[0].length;
  const push = (b) => {
    parts.push(b);
    len += b.length;
  };
  const loose = [];
  const packed = [];
  objs.forEach((o, i) => ((objStm && typeof o === 'string' && i + 1 !== root) ? packed : loose).push([i + 1, o]));
  if (packed.length) {
    let head = '';
    let body = '';
    for (const [n, o] of packed) {
      head += `${n} ${body.length} `;
      body += `${o}\n`;
    }
    const data = deflateSync(Buffer.from(head + body, 'latin1'));
    loose.push([objs.length + 1, { dict: `/Type /ObjStm /N ${packed.length} /First ${head.length} /Filter /FlateDecode`, data }]);
  }
  for (const [n, o] of loose) {
    if (typeof o === 'string') push(Buffer.from(`${n} 0 obj\n${o}\nendobj\n`, 'latin1'));
    else {
      push(Buffer.from(`${n} 0 obj\n<< ${o.dict} /Length ${o.data.length} >>\nstream\n`, 'latin1'));
      push(o.data);
      push(Buffer.from('\nendstream\nendobj\n', 'latin1'));
    }
  }
  push(Buffer.from(`trailer\n<< /Root ${root} 0 R /Size ${objs.length + 2} >>\n%%EOF\n`, 'latin1'));
  return new Uint8Array(Buffer.concat(parts));
}
const flate = (s) => ({ dict: '/Filter /FlateDecode', data: deflateSync(Buffer.from(s, 'latin1')) });

/* --------------------------------------------------------------- inflate */
{
  const src = Buffer.from('Mapa geológico '.repeat(500) + Array.from({ length: 3000 }, (_, i) => String.fromCharCode(i % 251)).join(''), 'latin1');
  for (const level of [0, 1, 9]) {
    const out = inflate(new Uint8Array(deflateSync(src, { level })));
    ok(Buffer.from(out).equals(src), `inflate nivel ${level}`);
  }
  // basura al final: devuelve igual lo descomprimido
  const junk = Buffer.concat([deflateSync(src), Buffer.from('\r\nbasura')]);
  ok(Buffer.from(inflate(new Uint8Array(junk))).equals(src), 'inflate tolera basura al final');
}

/* ---------------------------------------- un .ai como lo guarda Illustrator */
// capas como contenido opcional, fuente Type0 Identity-H con ToUnicode y kerning en TJ,
// tinta plana con función de tipo 4, CMYK, recorte, degradado y flujo de objetos
const toUni = `/CIDInit /ProcSet findresource begin 12 dict begin begincmap
1 begincodespacerange <0000> <FFFF> endcodespacerange
3 beginbfchar <0001> <0046> <0002> <00F3> <0003> <0020> endbfchar
1 beginbfrange <0010> <0012> <0061> endbfrange
endcmap CMapName currentdict /CMap defineresource pop end end`;
const content = `%!PS
q 0 0 595 842 re W n
/OC /MC0 BDC
0.8 0.1 0.6 0 k
10 10 m 150 10 l 150 120 l 10 120 l h 40 40 m 40 80 l 80 80 l 80 40 l h f*
/CS0 cs 1 scn /GS0 gs 200 20 m 230 100 260 100 290 20 c f
/Pattern cs /P0 scn 250 150 100 40 re f
q 160 130 60 60 re W n 0 g 140 120 120 120 re f Q
EMC
/OC /MC1 BDC
1 0 0 RG 2 w [6 3] 0 d 1 J 20 200 m 380 180 l S
BT /T1_0 1 Tf 12 0 0 12 100 700 Tm [(\\000\\001)-20(\\000\\002\\000\\020)]TJ (\\000\\003\\000\\021\\000\\022)Tj 0 -1.2 Td (\\000\\020)Tj ET
EMC
/OC /MC2 BDC 0 0 1 rg 300 250 30 30 re f EMC
Q`;
const objs = [
  '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [5 0 R 6 0 R 7 0 R] /D << /OFF [7 0 R] >> >> >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Properties << /MC0 5 0 R /MC1 6 0 R /MC2 7 0 R >> /ColorSpace << /CS0 [/Separation /PANTONE#20300#20C /DeviceRGB 8 0 R] >> /ExtGState << /GS0 << /ca 0.5 >> >> /Pattern << /P0 << /PatternType 2 /Matrix [1 0 0 1 250 50] /Shading << /ShadingType 2 /ColorSpace /DeviceRGB /Coords [0 0 100 0] /Function << /FunctionType 2 /Domain [0 1] /C0 [1 0 0] /C1 [0 0 1] /N 1 >> >> >> >> /Font << /T1_0 9 0 R >> >> >>',
  flate(content),
  '<< /Type /OCG /Name (Geolog\\355a) >>',
  '<< /Type /OCG /Name <FEFF0045007300740072007500630074007500720061007300> >>',
  '<< /Type /OCG /Name (Oculta) >>',
  { dict: '/FunctionType 4 /Domain [0 1] /Range [0 1 0 1 0 1]', data: Buffer.from('{dup 0.2 mul exch dup 0.8 mul exch 0 mul}') },
  '<< /Type /Font /Subtype /Type0 /BaseFont /ABCDEF+MyriadPro-Bold /Encoding /Identity-H /DescendantFonts [10 0 R] /ToUnicode 11 0 R >>',
  '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /ABCDEF+MyriadPro-Bold /DW 500 /W [1 [600 550] 16 18 520] /FontDescriptor 12 0 R >>',
  flate(toUni),
  '<< /Type /FontDescriptor /FontName /ABCDEF+MyriadPro-Bold /Flags 32 >>',
];
const ai = buildPdf(objs, { objStm: true });
{
  ok(isPdfBytes(ai), 'reconoce el .ai como PDF');
  const r = pdfToSvg(ai, { name: 'mapa' });
  ok(r.layers.join('|') === 'Geología|Estructuras|Oculta', `capas: ${r.layers.join('|')}`);
  ok(r.hiddenLayers.join() === 'Oculta', 'capa oculta');
  ok(r.svg.includes('fill="#33e666"') && r.svg.includes('fill-rule="evenodd"'), 'CMYK y par-impar');
  ok(r.svg.includes('290 822Z" fill="#33cc00"') && r.svg.includes('fill-opacity="0.5"'), 'tinta plana (función tipo 4) y transparencia');
  ok(/<linearGradient[^>]*><stop offset="0" stop-color="#ff0000"\/><stop offset="1" stop-color="#0000ff"\/>/.test(r.svg), 'degradado');
  ok(/<clipPath id="c\d+"><path d="M160 712L220 712L220 652L160 652Z"\/>/.test(r.svg), 'recorte (sin el de la página)');
  ok(r.svg.includes('stroke-dasharray="6 3"') && r.svg.includes('stroke-linecap="round"'), 'segmentado');
  const texts = [...r.svg.matchAll(/<text[^>]*>(.*?)<\/text>/g)].map((m) => m[1].replace(/<[^>]+>/g, '|'));
  ok(texts.length === 1, `un texto: ${texts.length}`);
  ok(texts[0] === '|F||óa|| bc||a|', `texto con kerning y dos líneas: ${texts[0]}`);
  ok(/font-family="Myriad Pro" font-weight="700"/.test(r.svg), 'fuente y negrita');

  const res = importPdf(ai, { refScale: 25000, name: 'mapa' });
  const names = res.layers.map((l) => l.name);
  ok(names.includes('Geología') && names.includes('Estructuras') && names.includes('Oculta'), `capas importadas: ${names}`);
  const geo = res.layers.find((l) => l.name === 'Geología');
  ok(geo.shapes.length === 4, `objetos de Geología: ${geo.shapes.length}`);
  const est = res.layers.find((l) => l.name === 'Estructuras');
  const t = est.shapes.find((s) => s.type === 'text');
  ok(t && t.text === 'Fóa bc\na' && Math.abs(t.fontSize - 12) < 0.01 && t.fontWeight === 700, `texto importado: ${JSON.stringify(t && [t.text, t.fontSize, t.fontWeight])}`);
  const line = est.shapes.find((s) => s.type === 'path');
  // 2 pt de trazo → mm de papel a la escala de referencia
  ok(line && Math.abs(line.style.strokeWidth - 2 * 25.4 / 72) < 0.01, `grosor de trazo: ${line?.style.strokeWidth}`);
}

/* ------------------------------------------------- imágenes incrustadas */
{
  const raw = (bytes) => ({ dict: '/Filter /FlateDecode', data: deflateSync(Buffer.from(bytes)) });
  const img = raw([0, 1, 2, 3]); // índices de paleta, 2×2
  img.dict += ' /Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace [/Indexed /DeviceRGB 3 <FF000000FF000000FFFFFFFF>] /SMask 6 0 R';
  const smask = raw([255, 128, 0, 255]);
  smask.dict += ' /Type /XObject /Subtype /Image /Width 2 /Height 2 /BitsPerComponent 8 /ColorSpace /DeviceGray';
  const jpg = { dict: '/Type /XObject /Subtype /Image /Width 4 /Height 3 /BitsPerComponent 8 /ColorSpace /DeviceCMYK /Filter /DCTDecode', data: Buffer.from([0xff, 0xd8, 1, 2, 3, 0xff, 0xd9]) };
  const pdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [7 0 R] >> >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R /Im1 8 0 R >> /Properties << /MC0 7 0 R >> >> >>',
    flate('/OC /MC0 BDC q 100 0 0 50 20 30 cm /Im0 Do Q q 100 0 0 50 20 130 cm /Im0 Do Q q -40 0 0 30 190 10 cm /Im1 Do Q EMC 0 0 1 RG 10 10 m 190 190 l S'),
    img,
    smask,
    '<< /Type /OCG /Name (Fotos) >>',
    jpg,
  ]);
  const r = pdfToSvg(pdf);
  ok(r.images.length === 3 && r.images.every((im) => im.layer === 'Fotos'), `imágenes en su capa: ${r.images.map((i) => i.layer)}`);
  ok(r.layers.includes('Fotos'), 'una capa con solo imágenes figura entre las capas');
  const [a, b2, c] = r.images;
  ok(a.box.join() === '20,120,120,170', `recuadro en la página: ${a.box}`);
  ok(a.px === b2.px, 'la misma imagen colocada dos veces se lee una vez');
  const px = [...a.px.rgba];
  ok(px.slice(0, 8).join() === '255,0,0,255,0,255,0,128' && px.slice(8).join() === '0,0,255,0,255,255,255,255', `paleta y máscara suave: ${px}`);
  // fila 0 de la imagen arriba: el píxel (0,0) va a la esquina superior izquierda del recuadro
  ok(Math.abs(a.T[0] - 50) < 1e-9 && Math.abs(a.T[3] - 25) < 1e-9 && Math.abs(a.T[5]) < 1e-9, `matriz de píxel a página: ${a.T}`);
  ok(c.px.jpeg && c.px.jpeg[0] === 0xff && c.px.w === 4, 'JPEG se entrega tal cual');
  ok(c.T[0] < 0 && Math.abs(c.T[4] - 40) < 1e-9, `imagen volteada en horizontal: ${c.T}`);
  const res = importPdf(pdf, { refScale: 1000, center: [0, 0] });
  // 1 pt a 1:1000 = 0,3528 m; las imágenes cuentan para centrar el conjunto
  const [x0, y0, x1, y1] = res.images[0].bounds;
  ok(Math.abs(x1 - x0 - 100 * 0.35278) < 0.01 && Math.abs(y1 - y0 - 50 * 0.35278) < 0.01 && y1 > y0, `imagen en el terreno: ${res.images[0].bounds}`);
  ok(Math.abs(res.images[1].bounds[1] - res.images[0].bounds[3] - 50 * 0.35278) < 0.01, 'la segunda copia queda 50 pt más arriba');
}

/* ------------------------------------------- filtros, números y rutas rápidas */
{
  // ASCII85 + Flate (lo que escribe, por ejemplo, reportlab), con la «z» de cuatro ceros
  const a85 = (bytes) => {
    let out = '';
    for (let i = 0; i < bytes.length; i += 4) {
      const chunk = bytes.slice(i, i + 4);
      const n = chunk.length;
      let v = 0;
      for (let k = 0; k < 4; k++) v = v * 256 + (chunk[k] ?? 0);
      if (n === 4 && v === 0) {
        out += 'z';
        continue;
      }
      let c = '';
      for (let k = 0; k < 5; k++, v = Math.floor(v / 85)) c = String.fromCharCode(33 + (v % 85)) + c;
      out += c.slice(0, n + 1);
    }
    return `${out}~>`;
  };
  const content = 'q 1 0 0 rg 10 10 m 60.5 10 l 60.5 -.5 l h f Q  0 0 1 RG .5 w 0 0 m 5 5 l S';
  const body = Buffer.concat([deflateSync(Buffer.from(content)), Buffer.alloc(8)]);
  const enc = { dict: '/Filter [/ASCII85Decode /FlateDecode]', data: Buffer.from(a85(body), 'latin1') };
  const pdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 4 0 R /Resources << >> >>',
    enc,
  ]);
  const r = pdfToSvg(pdf);
  ok(r.svg.includes('fill="#ff0000"') && r.svg.includes('M10 90L60.5 90L60.5 100.5Z'), `ASCII85 + Flate, números con punto inicial: ${r.svg.slice(200, 420)}`);
  ok(r.svg.includes('stroke="#0000ff"') && r.svg.includes('stroke-width="0.5"'), 'trazo con ".5 w"');

  // rutas SVG: exponentes, signos pegados, decimales sin cero y banderas de arco pegadas
  const sub = parsePathD('M10-5.5e1L.5.5 1e-1,2')[0];
  ok(sub.nodes.length === 3 && sub.nodes[0].y === -55 && sub.nodes[1].x === 0.5 && sub.nodes[1].y === 0.5 && Math.abs(sub.nodes[2].x - 0.1) < 1e-12 && sub.nodes[2].y === 2, `números compactos: ${JSON.stringify(sub.nodes.map((n) => [n.x, n.y]))}`);
  const arc = parsePathD('M0 0a5 5 0 01 10 0')[0];
  ok(arc.nodes.length >= 3 && Math.abs(arc.nodes[arc.nodes.length - 1].x - 10) < 1e-9, 'arco con banderas pegadas');
  const moved = parsePathD('M1 2 c1 1 2 2 3 3', [2, 0, 0, 3, 10, 20])[0];
  ok(moved.nodes[0].x === 12 && moved.nodes[0].y === 26 && moved.nodes[1].hIn.x === 10 + 2 * 3 && moved.nodes[0].hOut.y === 20 + 3 * 3, 'parsePathD con matriz');

  // estilos compartidos entre trazos hermanos: cada forma conserva el suyo (sin compartir objetos)
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>.a{fill:#f00}</style><g id="L"><path class="a" d="M0 0L1 1L2 0z"/><path class="a" d="M0 5L1 6L2 5z"/><path d="M0 9L1 9" stroke="#00f"/></g></svg>';
  const res = importSvg(svg, { refScale: 1000 });
  const [p1, p2, p3] = res.layers[0].shapes;
  ok(p1.style !== p2.style && p1.style.gradient !== p2.style.gradient && p1.style.fill === '#ff0000' && p2.style.fill === '#ff0000', 'estilos iguales pero objetos distintos');
  ok(p3.style.stroke === '#0000ff' && p3.style.fill !== '#ff0000', 'otro trazo, otro estilo');
  p1.style.fill = '#00ff00';
  ok(p2.style.fill === '#ff0000', 'cambiar uno no cambia al hermano');
}

/* ------------------------------------- formas entre hilos (empaquetadas) */
{
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g id="Capa_1" data-name="Capa 1"><path d="M0 0C10 0 10 10 20 10L30 30 0 30z M5 5L10 5L10 10z" fill="#336699" stroke="#000" stroke-width="2"/><path d="M1 1L2 2" stroke="#f00" stroke-dasharray="3 1"/><g id="G"><path d="M3 3L9 3L9 9z" fill="#fa0"/><path d="M4 4L8 4L8 8z" fill="#af0"/></g><text x="5" y="5" font-size="9">Hola</text></g></svg>';
  const r = importSvg(svg, { refScale: 25000 });
  const { layers, transfer } = packLayers(r.layers);
  ok(transfer.length > 0 && layers[0].shapes.every((s) => s.type !== 'path' || ArrayBuffer.isView(s.nodes)), 'los nodos viajan como arreglos de números');
  ok(layers[0].shapes[0].style && Object.keys(layers[0].shapes[0].style).length < 12, 'el estilo viaja como diferencia con el de por defecto');
  const back = unpackLayers(layers);
  ok(JSON.stringify(back, (k, v) => (k === 'id' ? undefined : v)) === JSON.stringify(r.layers, (k, v) => (k === 'id' ? undefined : v)), 'ida y vuelta idéntica');
  ok(back[0].shapes.length === r.layers[0].shapes.length && back[0].shapes[0].id === r.layers[0].shapes[0].id, 'conserva los identificadores');
}

/* ------------------------------------------------- casos que no se leen */
{
  const legacy = new Uint8Array(Buffer.from('%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator(TM) 8.0\n'));
  let err = '';
  try {
    pdfToSvg(legacy);
  } catch (e) {
    err = e.message;
  }
  ok(/formato antiguo/.test(err), `.ai antiguo: ${err}`);
  const noPdf = buildPdf([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    flate('BT /F1 12 Tf 10 100 Td (This is an Adobe Illustrator File that was saved without PDF Content.) Tj ET'),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]);
  err = '';
  try {
    pdfToSvg(noPdf);
  } catch (e) {
    err = e.message;
  }
  ok(/compatible con PDF/.test(err), `.ai sin contenido PDF: ${err}`);
}

console.log(`${pass} ok, ${fail} fallos`);
if (fail) process.exit(1);
