/**
 * GeoTIFF: modelos de elevación (una banda) e imágenes (RGB/RGBA).
 *
 * El sistema sale de las GeoKeys (ProjectedCSTypeGeoKey o GeographicTypeGeoKey);
 * si el archivo no lo declara, se pide el EPSG. Una imagen que NO está en UTM
 * 19S se remuestrea una vez, al importarla, a una grilla UTM: después se
 * pinta con un solo drawImage y se mueve con la vista sin costo.
 */

import { loadGeoTIFF } from './loader.js';
import { fromDocTransform, lonLatToTransform, toDocTransform } from './crs.js';

const MAX_IMAGE = 4096;

export async function readGeoTIFF(arrayBuffer, { epsgOverride = null } = {}) {
  const GeoTIFF = await loadGeoTIFF();
  const tiff = await GeoTIFF.fromArrayBuffer(arrayBuffer);
  const image = await tiff.getImage();
  const keys = image.getGeoKeys() || {};
  let epsg = epsgOverride || keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey || null;
  if (epsg === 32767) epsg = null; // "definido por el usuario"
  const [x0, y0, x1, y1] = image.getBoundingBox();
  const w = image.getWidth();
  const h = image.getHeight();
  const spp = image.getSamplesPerPixel();
  const nodataRaw = image.getGDALNoData();
  const photometric = image.fileDirectory.PhotometricInterpretation;
  const isRGB = spp >= 3 || photometric === 2;
  return { tiff, image, epsg, bbox: { x0, y0, x1, y1 }, w, h, spp, nodata: nodataRaw, isRGB, keys };
}

/** DEM de una banda -> grilla para `gridSampler` (dem.js). */
export async function geotiffToDemGrid(info) {
  if (!info.epsg) throw new Error('El GeoTIFF no declara su sistema de coordenadas; indica el EPSG');
  const [band] = await info.image.readRasters({ samples: [0] });
  const data = band instanceof Float32Array ? band : Float32Array.from(band);
  const { x0, y0, x1, y1 } = info.bbox;
  const grid = {
    data,
    w: info.w,
    h: info.h,
    x0,
    y0: y1,
    dx: (x1 - x0) / info.w,
    dy: -(y1 - y0) / info.h,
    nodata: info.nodata ?? -32768,
    crs: `EPSG:${info.epsg}`,
  };
  grid.toGrid = await lonLatToTransform(info.epsg);
  return grid;
}

/**
 * Imagen RGB(A) -> { bitmap, x0, y0, x1, y1 } alineada a UTM 19S.
 * `onProgress(fracción)` para archivos grandes.
 */
export async function geotiffToUtmImage(info) {
  if (!info.epsg) throw new Error('El GeoTIFF no declara su sistema de coordenadas; indica el EPSG');
  const scale = Math.min(1, MAX_IMAGE / Math.max(info.w, info.h));
  const rw = Math.max(1, Math.round(info.w * scale));
  const rh = Math.max(1, Math.round(info.h * scale));
  const rgb = await info.image.readRGB({ width: rw, height: rh, interleave: true, enableAlpha: info.spp >= 4 });
  const ch = info.spp >= 4 ? 4 : 3;
  const { x0, y0, x1, y1 } = info.bbox;

  if (info.epsg === 32719) {
    const px = new Uint8ClampedArray(rw * rh * 4);
    for (let i = 0; i < rw * rh; i++) {
      px[i * 4] = rgb[i * ch];
      px[i * 4 + 1] = rgb[i * ch + 1];
      px[i * 4 + 2] = rgb[i * ch + 2];
      px[i * 4 + 3] = ch === 4 ? rgb[i * ch + 3] : 255;
    }
    const bitmap = await createImageBitmap(new ImageData(px, rw, rh));
    return { bitmap, x0, y0, x1, y1 };
  }

  // remuestreo a una grilla UTM que cubre la imagen
  const toDoc = await toDocTransform(info.epsg);
  const fromDoc = await fromDocTransform(info.epsg);
  let ux0 = Infinity;
  let uy0 = Infinity;
  let ux1 = -Infinity;
  let uy1 = -Infinity;
  for (let k = 0; k <= 16; k++) {
    const t = k / 16;
    for (const [x, y] of [
      [x0 + t * (x1 - x0), y0],
      [x0 + t * (x1 - x0), y1],
      [x0, y0 + t * (y1 - y0)],
      [x1, y0 + t * (y1 - y0)],
    ]) {
      const [ux, uy] = toDoc(x, y);
      ux0 = Math.min(ux0, ux);
      uy0 = Math.min(uy0, uy);
      ux1 = Math.max(ux1, ux);
      uy1 = Math.max(uy1, uy);
    }
  }
  const ow = rw;
  const oh = Math.max(1, Math.round((rw * (uy1 - uy0)) / (ux1 - ux0)));
  const cw = (ux1 - ux0) / ow;
  const chh = (uy1 - uy0) / oh;
  const out = new Uint8ClampedArray(ow * oh * 4);
  const step = 16;
  for (let j = 0; j < oh; j += 1) {
    for (let i = 0; i < ow; i += step) {
      // proyección exacta en los extremos del tramo, lineal en medio
      const ia = i;
      const ib = Math.min(ow - 1, i + step);
      const A = fromDoc(ux0 + (ia + 0.5) * cw, uy1 - (j + 0.5) * chh);
      const B = fromDoc(ux0 + (ib + 0.5) * cw, uy1 - (j + 0.5) * chh);
      for (let ii = ia; ii <= ib && ii < ow; ii++) {
        const t = ib === ia ? 0 : (ii - ia) / (ib - ia);
        const sx = A[0] + t * (B[0] - A[0]);
        const sy = A[1] + t * (B[1] - A[1]);
        const pi = Math.floor(((sx - x0) / (x1 - x0)) * rw);
        const pj = Math.floor(((y1 - sy) / (y1 - y0)) * rh);
        if (pi < 0 || pj < 0 || pi >= rw || pj >= rh) continue;
        const s = (pj * rw + pi) * ch;
        const o = (j * ow + ii) * 4;
        out[o] = rgb[s];
        out[o + 1] = rgb[s + 1];
        out[o + 2] = rgb[s + 2];
        out[o + 3] = ch === 4 ? rgb[s + 3] : 255;
      }
    }
  }
  const bitmap = await createImageBitmap(new ImageData(out, ow, oh));
  return { bitmap, x0: ux0, y0: uy0, x1: ux1, y1: uy1 };
}

/**
 * Escribe un GeoTIFF RGBA en UTM 19S (para la georreferenciación y la
 * exportación de rasters calculados).
 */
export async function writeUtmGeoTIFF(rgba, w, h, x0, y1, cell) {
  const GeoTIFF = await loadGeoTIFF();
  const metadata = {
    width: w,
    height: h,
    SamplesPerPixel: 4,
    BitsPerSample: [8, 8, 8, 8],
    PhotometricInterpretation: 2,
    ExtraSamples: [2],
    ModelPixelScale: [cell, cell, 0],
    ModelTiepoint: [0, 0, 0, x0, y1, 0],
    GTModelTypeGeoKey: 1,
    GTRasterTypeGeoKey: 1,
    ProjectedCSTypeGeoKey: 32719,
  };
  return GeoTIFF.writeArrayBuffer(rgba, metadata);
}
