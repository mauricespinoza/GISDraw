/**
 * Exportar a imagen: formatos, tamaño en píxeles según los dpi y los
 * codificadores que el navegador no trae: TIFF (sin compresión, RGB o RGBA,
 * con la resolución escrita) y la resolución (dpi) dentro de PNG y JPEG, para
 * que Illustrator, Photoshop o QGIS abran la imagen con su tamaño de papel.
 */

export const IMAGE_FORMATS = {
  png: { label: 'PNG (sin pérdida, admite transparencia)', mime: 'image/png', ext: 'png', alpha: true },
  jpg: { label: 'JPG (liviano, sin transparencia)', mime: 'image/jpeg', ext: 'jpg', alpha: false, quality: true },
  tiff: { label: 'TIFF (sin compresión, admite transparencia)', mime: 'image/tiff', ext: 'tif', alpha: true },
  webp: { label: 'WebP (liviano, admite transparencia)', mime: 'image/webp', ext: 'webp', alpha: true, quality: true },
};

export const IMAGE_DPIS = [72, 96, 150, 200, 300, 400, 600, 1200];

/** Lado máximo (px) y total de píxeles que los navegadores dibujan de forma fiable. */
export const MAX_SIDE_PX = 16000;
export const MAX_TOTAL_PX = 120e6;

/** Píxeles de una medida en mm a `dpi`. */
export const mmToPx = (mm, dpi) => Math.max(1, Math.round((mm / 25.4) * dpi));

/** Texto de error si la imagen es demasiado grande para el navegador, o ''. */
export function sizeProblem(wPx, hPx) {
  if (wPx > MAX_SIDE_PX || hPx > MAX_SIDE_PX || wPx * hPx > MAX_TOTAL_PX) {
    return `La imagen sería de ${wPx.toLocaleString('es-CL')} × ${hPx.toLocaleString('es-CL')} px (${Math.round((wPx * hPx) / 1e6)} Mpx): demasiado grande. Baja los dpi (máximo ${MAX_SIDE_PX.toLocaleString('es-CL')} px por lado y ${MAX_TOTAL_PX / 1e6} Mpx).`;
  }
  return '';
}

/* ------------------------------------------------------------------- PNG */

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** PNG con el chunk pHYs (píxeles por metro) tras la cabecera IHDR. */
export function pngWithDpi(bytes, dpi) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const SIG = 8;
  const ihdrEnd = SIG + 4 + 4 + 13 + 4; // longitud + tipo + datos + CRC
  if (u8.length < ihdrEnd || u8[1] !== 0x50 || u8[2] !== 0x4e || u8[3] !== 0x47) return u8;
  const ppm = Math.round(dpi / 0.0254);
  const chunk = new Uint8Array(4 + 4 + 9 + 4);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, 9);
  chunk.set([0x70, 0x48, 0x59, 0x73], 4); // 'pHYs'
  dv.setUint32(8, ppm);
  dv.setUint32(12, ppm);
  chunk[16] = 1; // metros
  dv.setUint32(17, crc32(chunk.subarray(4, 17)));
  const out = new Uint8Array(u8.length + chunk.length);
  out.set(u8.subarray(0, ihdrEnd), 0);
  out.set(chunk, ihdrEnd);
  out.set(u8.subarray(ihdrEnd), ihdrEnd + chunk.length);
  return out;
}

/* ------------------------------------------------------------------ JPEG */

/** JPEG con la densidad (puntos por pulgada) en su cabecera JFIF, si la tiene. */
export function jpegWithDpi(bytes, dpi) {
  const u8 = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes);
  const jfif = u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff && u8[3] === 0xe0 && u8[6] === 0x4a && u8[7] === 0x46 && u8[8] === 0x49 && u8[9] === 0x46;
  if (!jfif) return u8;
  const d = Math.min(65535, Math.max(1, Math.round(dpi)));
  u8[13] = 1; // puntos por pulgada
  u8[14] = d >> 8;
  u8[15] = d & 255;
  u8[16] = d >> 8;
  u8[17] = d & 255;
  return u8;
}

/* ------------------------------------------------------------------ TIFF */

/**
 * TIFF sin compresión, 8 bits por canal (RGB, o RGBA con alfa sin premultiplicar).
 * `readRows(y, n)` devuelve los RGBA de las filas y…y+n−1 (como `getImageData`):
 * se escribe por franjas, sin tener la imagen entera duplicada en memoria.
 * @returns {Blob}
 */
export function buildTiff({ width, height, dpi, alpha, readRows, rowsPerStrip = 256 }) {
  const spp = alpha ? 4 : 3;
  const rps = Math.min(rowsPerStrip, height);
  const nStrips = Math.ceil(height / rps);
  const entries = alpha ? 13 : 12;
  const ifdSize = 2 + entries * 12 + 4;
  // zona de datos fuera del IFD: BitsPerSample, XRes, YRes, StripOffsets, StripByteCounts
  const bpsAt = 8 + ifdSize;
  const xresAt = bpsAt + spp * 2;
  const yresAt = xresAt + 8;
  const offAt = yresAt + 8;
  const cntAt = offAt + (nStrips > 1 ? nStrips * 4 : 0);
  const dataAt = cntAt + (nStrips > 1 ? nStrips * 4 : 0);
  const head = new Uint8Array(dataAt);
  const dv = new DataView(head.buffer);
  head.set([0x49, 0x49, 42, 0]);
  dv.setUint32(4, 8, true);
  dv.setUint16(8, entries, true);
  let p = 10;
  const entry = (tag, type, count, value) => {
    dv.setUint16(p, tag, true);
    dv.setUint16(p + 2, type, true);
    dv.setUint32(p + 4, count, true);
    if (type === 3 && count === 1) dv.setUint16(p + 8, value, true);
    else dv.setUint32(p + 8, value, true);
    p += 12;
  };
  const SHORT = 3;
  const LONG = 4;
  const RATIONAL = 5;
  const stripBytes = (i) => Math.min(rps, height - i * rps) * width * spp;
  entry(256, LONG, 1, width);
  entry(257, LONG, 1, height);
  entry(258, SHORT, spp, bpsAt);
  entry(259, SHORT, 1, 1); // sin compresión
  entry(262, SHORT, 1, 2); // RGB
  entry(273, LONG, nStrips, nStrips > 1 ? offAt : dataAt);
  entry(277, SHORT, 1, spp);
  entry(278, LONG, 1, rps);
  entry(279, LONG, nStrips, nStrips > 1 ? cntAt : stripBytes(0));
  entry(282, RATIONAL, 1, xresAt);
  entry(283, RATIONAL, 1, yresAt);
  entry(296, SHORT, 1, 2); // pulgadas
  if (alpha) entry(338, SHORT, 1, 2); // alfa sin premultiplicar
  dv.setUint32(p, 0, true); // sin más IFD
  for (let i = 0; i < spp; i++) dv.setUint16(bpsAt + i * 2, 8, true);
  const d = Math.round(dpi);
  dv.setUint32(xresAt, d, true);
  dv.setUint32(xresAt + 4, 1, true);
  dv.setUint32(yresAt, d, true);
  dv.setUint32(yresAt + 4, 1, true);
  let off = dataAt;
  for (let i = 0; i < nStrips; i++) {
    if (nStrips > 1) {
      dv.setUint32(offAt + i * 4, off, true);
      dv.setUint32(cntAt + i * 4, stripBytes(i), true);
    }
    off += stripBytes(i);
  }
  const parts = [head];
  for (let i = 0; i < nStrips; i++) {
    const y0 = i * rps;
    const n = Math.min(rps, height - y0);
    const src = readRows(y0, n);
    const out = new Uint8Array(n * width * spp);
    for (let k = 0, q = 0; k < n * width; k++) {
      out[q++] = src[k * 4];
      out[q++] = src[k * 4 + 1];
      out[q++] = src[k * 4 + 2];
      if (alpha) out[q++] = src[k * 4 + 3];
    }
    parts.push(out);
  }
  return new Blob(parts, { type: 'image/tiff' });
}
