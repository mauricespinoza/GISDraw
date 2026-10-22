/**
 * Exportar imagen: TIFF, dpi dentro de PNG/JPEG y límites de tamaño.
 *
 *   node test/imageexport.test.mjs
 */

import { buildTiff, jpegWithDpi, mmToPx, pngWithDpi, sizeProblem } from '../src/io/imageExport.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}

ok(mmToPx(210, 300) === 2480 && mmToPx(297, 300) === 3508, 'A4 a 300 dpi = 2480 × 3508 px');
ok(mmToPx(25.4, 96) === 96 && mmToPx(0.001, 72) === 1, 'conversión mm → px y mínimo de 1 px');
ok(sizeProblem(2480, 3508) === '' && sizeProblem(20000, 100) !== '' && sizeProblem(12000, 12000) !== '', 'límites de tamaño');

/* ---- TIFF: se vuelve a leer lo escrito */
async function readTiff(blob) {
  const dv = new DataView(await blob.arrayBuffer());
  const le = dv.getUint16(0) === 0x4949;
  ok(le && dv.getUint16(2, true) === 42, 'cabecera TIFF little-endian');
  const ifd = dv.getUint32(4, true);
  const n = dv.getUint16(ifd, true);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const p = ifd + 2 + i * 12;
    const type = dv.getUint16(p + 2, true);
    const count = dv.getUint32(p + 4, true);
    const raw = type === 3 && count === 1 ? dv.getUint16(p + 8, true) : dv.getUint32(p + 8, true);
    tags[dv.getUint16(p, true)] = { type, count, raw };
  }
  return { dv, tags };
}
for (const alpha of [false, true]) {
  const W = 5;
  const H = 7;
  const spp = alpha ? 4 : 3;
  const px = (x, y) => [x * 40, y * 30, (x + y) * 10, alpha ? 255 - x * 20 : 255];
  const rows = (y0, n) => {
    const a = new Uint8ClampedArray(n * W * 4);
    for (let y = 0; y < n; y++) for (let x = 0; x < W; x++) a.set(px(x, y0 + y), (y * W + x) * 4);
    return a;
  };
  const blob = buildTiff({ width: W, height: H, dpi: 300, alpha, readRows: rows, rowsPerStrip: 3 }); // 3 franjas: 3 + 3 + 1
  const { dv, tags } = await readTiff(blob);
  ok(tags[256].raw === W && tags[257].raw === H, `ancho y alto (alfa ${alpha})`);
  ok(tags[277].raw === spp && tags[258].count === spp, `canales (alfa ${alpha})`);
  ok(tags[259].raw === 1 && tags[262].raw === 2 && (alpha ? tags[338].raw === 2 : !tags[338]), `sin compresión, RGB, alfa sin premultiplicar solo si hay (${alpha})`);
  ok(dv.getUint32(tags[282].raw, true) === 300 && dv.getUint32(tags[282].raw + 4, true) === 1 && tags[296].raw === 2, `300 dpi en pulgadas (${alpha})`);
  ok(tags[273].count === 3 && tags[279].count === 3, 'tres franjas');
  let good = true;
  for (let s = 0; s < 3; s++) {
    const off = dv.getUint32(tags[273].raw + s * 4, true);
    const cnt = dv.getUint32(tags[279].raw + s * 4, true);
    const rowsIn = Math.min(3, H - s * 3);
    if (cnt !== rowsIn * W * spp) good = false;
    for (let y = 0; y < rowsIn; y++) for (let x = 0; x < W; x++) {
      const e = px(x, s * 3 + y);
      for (let c = 0; c < spp; c++) if (dv.getUint8(off + (y * W + x) * spp + c) !== e[c]) good = false;
    }
  }
  ok(good && blob.size === dv.getUint32(tags[273].raw + 8, true) + W * 1 * spp, `píxeles y tamaños de las franjas (alfa ${alpha})`);
  // una sola franja
  const one = await readTiff(buildTiff({ width: W, height: H, dpi: 72, alpha, readRows: rows }));
  ok(one.tags[273].count === 1 && one.tags[279].raw === W * H * spp, `una franja: offset y bytes dentro de la entrada (alfa ${alpha})`);
}

/* ---- PNG con pHYs */
{
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = new Uint8Array(25);
  new DataView(ihdr.buffer).setUint32(0, 13);
  ihdr.set([0x49, 0x48, 0x44, 0x52], 4);
  const rest = [0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82];
  const png = new Uint8Array([...sig, ...ihdr, ...rest]);
  const out = pngWithDpi(png, 300);
  const dv = new DataView(out.buffer);
  ok(out.length === png.length + 21 && String.fromCharCode(...out.subarray(37, 41)) === 'pHYs', 'pHYs tras IHDR');
  ok(dv.getUint32(41) === 11811 && dv.getUint32(45) === 11811 && out[49] === 1, '300 dpi = 11 811 px/m');
  // CRC del pHYs: lo que da zlib/PNG para estos datos
  let c = 0xffffffff;
  const t = [];
  for (let n = 0; n < 256; n++) {
    let k = n;
    for (let j = 0; j < 8; j++) k = k & 1 ? 0xedb88320 ^ (k >>> 1) : k >>> 1;
    t[n] = k >>> 0;
  }
  for (const b of out.subarray(37, 50)) c = t[(c ^ b) & 255] ^ (c >>> 8);
  ok(((c ^ 0xffffffff) >>> 0) === dv.getUint32(50), 'CRC del chunk pHYs');
  ok(pngWithDpi(new Uint8Array([1, 2, 3]), 300).length === 3, 'no-PNG: sin cambios');
}

/* ---- JPEG con JFIF */
{
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const o = jpegWithDpi(jpg, 300);
  ok(o[13] === 1 && (o[14] << 8 | o[15]) === 300 && (o[16] << 8 | o[17]) === 300, '300 dpi en JFIF');
  ok(jpg[13] === 0 && jpegWithDpi(new Uint8Array([1, 2, 3, 4]), 300).length === 4, 'el original no se toca; sin JFIF no cambia');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
