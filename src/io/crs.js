/**
 * Sistemas de coordenadas de lo que entra y sale.
 *
 * El documento está en UTM 19S/WGS84. Lo importado se lleva a ese sistema:
 * WGS84 geográfico y UTM WGS84 se resuelven con `proj.js` sin dependencias;
 * el resto (PSAD56, SAD69, SIRGAS, Web Mercator, o cualquier WKT que traiga un
 * GeoPackage) pasa por proj4, que se carga solo si hace falta.
 */

import { fromLonLat, makeUtm, toLonLat } from '../proj.js';
import { loadScript } from './loader.js';

let proj4Promise = null;
export function loadProj4() {
  if (!proj4Promise) {
    proj4Promise = loadScript('vendor/proj4.js').then(() => {
      if (!globalThis.proj4) throw new Error('proj4 no se cargó');
      return globalThis.proj4;
    });
  }
  return proj4Promise;
}

/** Definiciones proj4 conocidas por código EPSG. */
export function proj4Def(epsg) {
  const c = Number(epsg);
  if (c === 4326 || c === 4674 || c === 4979) return '+proj=longlat +datum=WGS84 +no_defs';
  if (c === 3857 || c === 900913) return '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs';
  if (c >= 32601 && c <= 32660) return `+proj=utm +zone=${c - 32600} +datum=WGS84 +units=m +no_defs`;
  if (c >= 32701 && c <= 32760) return `+proj=utm +zone=${c - 32700} +south +datum=WGS84 +units=m +no_defs`;
  // PSAD56 / UTM 17S-20S (el datum de la cartografía IGM antigua)
  if (c >= 24877 && c <= 24880)
    return `+proj=utm +zone=${c - 24860} +south +ellps=intl +towgs84=-288,175,-376,0,0,0,0 +units=m +no_defs`;
  if (c === 4248) return '+proj=longlat +ellps=intl +towgs84=-288,175,-376,0,0,0,0 +no_defs';
  // SAD69 / UTM 18S-25S
  if (c >= 29188 && c <= 29195) return `+proj=utm +zone=${c - 29170} +south +ellps=aust_SA +towgs84=-57,1,-41,0,0,0,0 +units=m +no_defs`;
  // SIRGAS 2000 / UTM 17S-25S (GRS80, prácticamente WGS84)
  if (c >= 31977 && c <= 31985) return `+proj=utm +zone=${c - 31960} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`;
  return null;
}

const isLonLat = (c) => c === 4326 || c === 4674 || c === 4979;

/**
 * Transformación (x, y) en `src` -> [x, y] UTM 19S.
 * `src` puede ser un código EPSG, un WKT o un string proj4.
 */
export async function toDocTransform(src) {
  const code = typeof src === 'number' || /^\d+$/.test(String(src)) ? Number(src) : epsgFromText(src);
  if (code === 32719) return (x, y) => [x, y];
  if (code && isLonLat(code)) return (x, y) => fromLonLat(x, y);
  if (code >= 32701 && code <= 32760) {
    const u = makeUtm(code - 32700, true);
    return (x, y) => fromLonLat(...u.inverse(x, y));
  }
  if (code >= 32601 && code <= 32660) {
    const u = makeUtm(code - 32600, false);
    return (x, y) => fromLonLat(...u.inverse(x, y));
  }
  const def = (code && proj4Def(code)) || (typeof src === 'string' && !/^\d+$/.test(src) ? src : null);
  if (!def) throw new Error(`Sistema de coordenadas desconocido (${src}). Indica el EPSG o una definición proj4.`);
  const proj4 = await loadProj4();
  const t = proj4(def, 'WGS84');
  return (x, y) => {
    const [lon, lat] = t.forward([x, y]);
    return fromLonLat(lon, lat);
  };
}

/** Inversa: UTM 19S -> sistema `src` (para muestrear rasters en su propia grilla). */
export async function fromDocTransform(src) {
  const code = typeof src === 'number' || /^\d+$/.test(String(src)) ? Number(src) : epsgFromText(src);
  if (code === 32719) return (x, y) => [x, y];
  if (code && isLonLat(code)) return (x, y) => toLonLat(x, y);
  if (code >= 32701 && code <= 32760) {
    const u = makeUtm(code - 32700, true);
    return (x, y) => u.forward(...toLonLat(x, y));
  }
  const def = (code && proj4Def(code)) || (typeof src === 'string' ? src : null);
  if (!def) throw new Error(`Sistema de coordenadas desconocido (${src})`);
  const proj4 = await loadProj4();
  const t = proj4('WGS84', def);
  return (x, y) => t.forward(toLonLat(x, y));
}

/** lon/lat -> sistema `src` (para muestrear un DEM en su grilla). */
export async function lonLatToTransform(src) {
  const code = Number(src);
  if (isLonLat(code)) return (lon, lat) => [lon, lat];
  if (code === 32719) return (lon, lat) => fromLonLat(lon, lat);
  if (code >= 32701 && code <= 32760) {
    const u = makeUtm(code - 32700, true);
    return (lon, lat) => u.forward(lon, lat);
  }
  const def = proj4Def(code) || (typeof src === 'string' ? src : null);
  if (!def) throw new Error(`Sistema de coordenadas desconocido (${src})`);
  const proj4 = await loadProj4();
  const t = proj4('WGS84', def);
  return (lon, lat) => t.forward([lon, lat]);
}

/** EPSG de un WKT (AUTHORITY final) o de un "EPSG:xxxx". */
export function epsgFromText(text) {
  if (!text) return null;
  const s = String(text);
  const m = /^\s*EPSG:(\d+)\s*$/i.exec(s) || /urn:ogc:def:crs:EPSG::(\d+)/i.exec(s);
  if (m) return Number(m[1]);
  // la última AUTHORITY de un WKT es la del sistema completo
  const all = [...s.matchAll(/AUTHORITY\["EPSG","(\d+)"\]/gi)];
  if (all.length) return Number(all[all.length - 1][1]);
  const id = [...s.matchAll(/ID\["EPSG",(\d+)\]/gi)];
  if (id.length) return Number(id[id.length - 1][1]);
  return null;
}
