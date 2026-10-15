/**
 * Modelos de elevación GRATUITOS y su muestreo sobre la grilla UTM de la vista.
 *
 * Fuentes:
 *
 * - **Terrarium (AWS Open Data / Mapzen)** — global, sin clave, teselas PNG
 *   hasta z15. En tierra combina SRTM, GMTED, NED y otros; en el mar trae
 *   BATIMETRÍA (ETOPO1 / GEBCO). Es lo que hace posible un mapa topo-batimétrico
 *   del margen chileno sin descargar nada a mano.
 * - **OpenTopography** — con clave de API gratuita (opentopography.org). Se
 *   pide la extensión visible y llega como ASCII grid:
 *     COP30 / COP90  Copernicus GLO-30/90 (el mejor DEM global abierto)
 *     NASADEM, SRTMGL1, SRTMGL3, AW3D30 (ALOS)
 *     GEBCOIceTopo   GEBCO 2023, batimetría + topografía a 15"
 * - **Archivo propio** — GeoTIFF (vía `io/geotiff.js`) o ASCII grid.
 *
 * Todas terminan como un muestreador `sample(lon, lat) -> metros | NaN` y la
 * grilla de la vista se arma en UTM con `sampleGrid`.
 */

import { toLonLat } from '../proj.js';

export const DEM_SOURCES = {
  terrarium: { label: 'Terrarium AWS (tierra + batimetría, sin clave)', key: false },
  opentopo: { label: 'OpenTopography (requiere clave gratuita)', key: true },
  file: { label: 'Archivo (GeoTIFF / ASCII grid)', key: false },
};

export const OPENTOPO_TYPES = {
  COP30: 'Copernicus GLO-30 (30 m)',
  COP90: 'Copernicus GLO-90 (90 m)',
  NASADEM: 'NASADEM (30 m)',
  SRTMGL1: 'SRTM GL1 (30 m)',
  SRTMGL3: 'SRTM GL3 (90 m)',
  AW3D30: 'ALOS World 3D (30 m)',
  GEBCOIceTopo: 'GEBCO 2023 topo-batimetría (~450 m)',
};

/* ------------------------------------------------------------ Terrarium */

const TERRARIUM_URL = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
const TERRARIUM_MAX_Z = 15;
const tileCache = new Map(); // "z/x/y" -> Promise<Float32Array|null>

export function decodeTerrarium(rgba, n = 256) {
  const out = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    out[i] = rgba[i * 4] * 256 + rgba[i * 4 + 1] + rgba[i * 4 + 2] / 256 - 32768;
  }
  return out;
}

async function loadTerrariumTile(z, x, y) {
  const key = `${z}/${x}/${y}`;
  if (!tileCache.has(key)) {
    const p = (async () => {
      const url = TERRARIUM_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      const c = new OffscreenCanvas(256, 256);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      return decodeTerrarium(g.getImageData(0, 0, 256, 256).data);
    })().catch(() => null);
    tileCache.set(key, p);
    if (tileCache.size > 600) tileCache.delete(tileCache.keys().next().value);
  }
  return tileCache.get(key);
}

export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;
export const latToTileY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
};

/** Zoom de teselas cuyo píxel se parece a `mpp` metros. */
export function zoomForMpp(mpp, lat, max = TERRARIUM_MAX_Z) {
  const z = Math.log2((156543.034 * Math.cos((lat * Math.PI) / 180)) / Math.max(mpp, 0.01));
  return Math.max(0, Math.min(max, Math.round(z)));
}

/**
 * Muestreador Terrarium para una extensión lon/lat: descarga las teselas
 * necesarias y devuelve `sample(lon, lat)` bilineal.
 */
export async function terrariumSampler(bbox, z, signal) {
  const x0 = Math.floor(lonToTileX(bbox.west, z));
  const x1 = Math.floor(lonToTileX(bbox.east, z));
  const y0 = Math.floor(latToTileY(bbox.north, z));
  const y1 = Math.floor(latToTileY(bbox.south, z));
  const n = 2 ** z;
  const tiles = new Map();
  const jobs = [];
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 600) throw new Error('Demasiadas teselas de DEM para esta vista');
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      if (y < 0 || y >= n) continue;
      const xx = ((x % n) + n) % n;
      jobs.push(loadTerrariumTile(z, xx, y).then((t) => tiles.set(`${x}/${y}`, t)));
    }
  }
  await Promise.all(jobs);
  if (signal?.aborted) throw new DOMException('cancelado', 'AbortError');
  const val = (px, py) => {
    const tx = Math.floor(px / 256);
    const ty = Math.floor(py / 256);
    const t = tiles.get(`${tx}/${ty}`);
    if (!t) return NaN;
    const ix = Math.min(255, Math.max(0, Math.floor(px - tx * 256)));
    const iy = Math.min(255, Math.max(0, Math.floor(py - ty * 256)));
    return t[iy * 256 + ix];
  };
  return (lon, lat) => {
    const px = lonToTileX(lon, z) * 256 - 0.5;
    const py = latToTileY(lat, z) * 256 - 0.5;
    const fx = Math.floor(px);
    const fy = Math.floor(py);
    const tx = px - fx;
    const ty = py - fy;
    const a = val(fx, fy);
    const b = val(fx + 1, fy);
    const c = val(fx, fy + 1);
    const d = val(fx + 1, fy + 1);
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

/* ------------------------------------------------------------- grillas */

/**
 * Grilla regular en un CRS cualquiera.
 * { data: Float32Array, w, h, x0, y0, dx, dy (dy negativo = filas hacia el sur),
 *   nodata, toGrid(lon,lat)->[x,y] en el CRS de la grilla }
 */
export function gridSampler(grid) {
  const { data, w, h, x0, y0, dx, dy, nodata } = grid;
  const val = (i, j) => {
    if (i < 0 || j < 0 || i >= w || j >= h) return NaN;
    const v = data[j * w + i];
    return v === nodata || v < -1e30 ? NaN : v;
  };
  return (lon, lat) => {
    const [gx, gy] = grid.toGrid(lon, lat);
    const fi = (gx - x0) / dx - 0.5;
    const fj = (gy - y0) / dy - 0.5;
    const i = Math.floor(fi);
    const j = Math.floor(fj);
    const tx = fi - i;
    const ty = fj - j;
    const a = val(i, j);
    const b = val(i + 1, j);
    const c = val(i, j + 1);
    const d = val(i + 1, j + 1);
    // en los bordes, el vecino que exista
    if (Number.isNaN(a) || Number.isNaN(b) || Number.isNaN(c) || Number.isNaN(d)) {
      const ii = Math.round(fi);
      const jj = Math.round(fj);
      return val(ii, jj);
    }
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  };
}

/** ESRI ASCII grid (el formato que entrega OpenTopography). Coordenadas en grados. */
export function parseAsciiGrid(text) {
  const lines = text.split(/\r?\n/);
  const hdr = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^\s*([a-zA-Z_]+)\s+(-?[\d.eE+-]+)\s*$/.exec(lines[i]);
    if (!m) break;
    hdr[m[1].toLowerCase()] = Number(m[2]);
  }
  const w = hdr.ncols;
  const h = hdr.nrows;
  const cs = hdr.cellsize ?? hdr.dx;
  const dyc = hdr.cellsize ?? hdr.dy;
  if (!w || !h || !cs) throw new Error('ASCII grid sin cabecera válida');
  const data = new Float32Array(w * h);
  let k = 0;
  for (; i < lines.length && k < w * h; i++) {
    const parts = lines[i].trim().split(/\s+/);
    for (const p of parts) if (p !== '') data[k++] = Number(p);
  }
  const xll = hdr.xllcorner ?? hdr.xllcenter - cs / 2;
  const yll = hdr.yllcorner ?? hdr.yllcenter - dyc / 2;
  return { data, w, h, x0: xll, y0: yll + h * dyc, dx: cs, dy: -dyc, nodata: hdr.nodata_value ?? -9999 };
}

/** Descarga de OpenTopography para una extensión lon/lat. */
export async function fetchOpenTopography(bbox, demtype, apiKey, signal) {
  if (!apiKey) throw new Error('Falta la clave de API de OpenTopography (Ajustes → DEM)');
  const u = new URL('https://portal.opentopography.org/API/globaldem');
  u.searchParams.set('demtype', demtype);
  u.searchParams.set('south', bbox.south.toFixed(5));
  u.searchParams.set('north', bbox.north.toFixed(5));
  u.searchParams.set('west', bbox.west.toFixed(5));
  u.searchParams.set('east', bbox.east.toFixed(5));
  u.searchParams.set('outputFormat', 'AAIGrid');
  u.searchParams.set('API_Key', apiKey);
  const res = await fetch(u, { signal });
  const text = await res.text();
  if (!res.ok || !/ncols/i.test(text.slice(0, 200))) {
    throw new Error(`OpenTopography: ${text.slice(0, 200) || res.status}`);
  }
  const grid = parseAsciiGrid(text);
  grid.toGrid = (lon, lat) => [lon, lat];
  grid.crs = 'EPSG:4326';
  return grid;
}

/* ------------------------------------------------------------ grilla de vista */

/**
 * Elevaciones en la grilla UTM de la vista: `w` x `h` celdas de `cell` m con
 * esquina superior izquierda en (x0, y0). La conversión UTM→lon/lat se hace
 * cada 16 celdas y se interpola: en 16 celdas la proyección es lineal a
 * mucho menos de un píxel, y el costo baja de millones de llamadas a miles.
 */
export function sampleGrid(sample, x0, y0, cell, w, h) {
  const step = 16;
  const gw = Math.ceil(w / step) + 1;
  const gh = Math.ceil(h / step) + 1;
  const lon = new Float64Array(gw * gh);
  const lat = new Float64Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      const [lo, la] = toLonLat(x0 + i * step * cell, y0 - j * step * cell);
      lon[j * gw + i] = lo;
      lat[j * gw + i] = la;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const gj = Math.min(gh - 2, Math.floor(y / step));
    const ty = y / step - gj;
    for (let x = 0; x < w; x++) {
      const gi = Math.min(gw - 2, Math.floor(x / step));
      const tx = x / step - gi;
      const k = gj * gw + gi;
      const lo =
        (lon[k] * (1 - tx) + lon[k + 1] * tx) * (1 - ty) + (lon[k + gw] * (1 - tx) + lon[k + gw + 1] * tx) * ty;
      const la =
        (lat[k] * (1 - tx) + lat[k + 1] * tx) * (1 - ty) + (lat[k + gw] * (1 - tx) + lat[k + gw + 1] * tx) * ty;
      out[y * w + x] = sample(lo, la);
    }
  }
  return out;
}

/** bbox lon/lat de una extensión UTM (muestreando el borde: la proyección curva los lados). */
export function lonLatBBox(ext) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;
  for (let k = 0; k <= 8; k++) {
    const t = k / 8;
    for (const [x, y] of [
      [ext.minX + t * (ext.maxX - ext.minX), ext.minY],
      [ext.minX + t * (ext.maxX - ext.minX), ext.maxY],
      [ext.minX, ext.minY + t * (ext.maxY - ext.minY)],
      [ext.maxX, ext.minY + t * (ext.maxY - ext.minY)],
    ]) {
      const [lo, la] = toLonLat(x, y);
      west = Math.min(west, lo);
      east = Math.max(east, lo);
      south = Math.min(south, la);
      north = Math.max(north, la);
    }
  }
  return { west, east, south, north };
}
