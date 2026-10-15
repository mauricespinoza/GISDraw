/**
 * Mapas base de teselas web, pintados sobre la vista UTM.
 *
 * Las teselas vienen en Web Mercator y el dibujo está en UTM. Entre las dos la
 * relación no es lineal, pero dentro de UNA tesela sí lo es a menos de un
 * píxel: cada tesela se pinta con la transformación afín que lleva tres de sus
 * esquinas a su lugar en UTM. El mosaico resultante queda reproyectado a
 * trozos, sin warping por píxel y sin costo apreciable.
 */

import { fromLonLat } from '../proj.js';
import { latToTileY, lonToTileX } from './dem.js';

export const BASEMAPS = {
  opentopomap: {
    label: 'OpenTopoMap',
    url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
    subdomains: 'abc',
    maxZoom: 17,
    attribution: '© OpenStreetMap, SRTM | OpenTopoMap (CC-BY-SA)',
  },
  osm: {
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '© OpenStreetMap',
  },
  esri_imagery: {
    label: 'Esri World Imagery (satélite)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    attribution: 'Esri, Maxar, Earthstar Geographics',
  },
  esri_topo: {
    label: 'Esri World Topo',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 19,
    attribution: 'Esri',
  },
  esri_ocean: {
    label: 'Esri Ocean (batimetría)',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Ocean/World_Ocean_Base/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 13,
    attribution: 'Esri, GEBCO, NOAA, Garmin',
  },
  esri_hillshade: {
    label: 'Esri World Hillshade',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
    maxZoom: 16,
    attribution: 'Esri, USGS, NGA, NASA',
  },
  carto_light: {
    label: 'Carto claro',
    url: 'https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png',
    maxZoom: 19,
    attribution: '© OpenStreetMap © CARTO',
  },
};

const images = new Map(); // url -> {img, ok}

function tileUrl(src, z, x, y) {
  const s = src.subdomains ? src.subdomains[(x + y) % src.subdomains.length] : '';
  return src.url.replace('{s}', s).replace('{z}', z).replace('{x}', x).replace('{y}', y);
}

function getTile(url, onLoad) {
  let e = images.get(url);
  if (!e) {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    e = { img, ok: false, failed: false };
    img.onload = () => {
      e.ok = true;
      onLoad();
    };
    img.onerror = () => {
      e.failed = true;
    };
    img.src = url;
    images.set(url, e);
    if (images.size > 1500) images.delete(images.keys().next().value);
  }
  return e;
}

const tileLon = (x, z) => (x / 2 ** z) * 360 - 180;
const tileLat = (y, z) => {
  const n = Math.PI - (2 * Math.PI * y) / 2 ** z;
  return (180 / Math.PI) * Math.atan(Math.sinh(n));
};

/**
 * Pinta el mapa base en `ctx` (canvas del tamaño de la vista, ya escalado por
 * devicePixelRatio). `requestRedraw` se llama cuando llega una tesela.
 */
export function drawBasemap(ctx, view, sourceId, lonLatBox, requestRedraw) {
  const src = BASEMAPS[sourceId] || BASEMAPS.opentopomap;
  const midLat = (lonLatBox.north + lonLatBox.south) / 2;
  const dpr = ctx.canvas.width / view.w;
  let z = Math.log2((156543.034 * Math.cos((midLat * Math.PI) / 180)) / (view.mpp / dpr));
  z = Math.max(0, Math.min(src.maxZoom, Math.round(z - 0.3)));
  const n = 2 ** z;
  const x0 = Math.floor(lonToTileX(lonLatBox.west, z));
  const x1 = Math.floor(lonToTileX(lonLatBox.east, z));
  const y0 = Math.max(0, Math.floor(latToTileY(lonLatBox.north, z)));
  const y1 = Math.min(n - 1, Math.floor(latToTileY(lonLatBox.south, z)));
  if ((x1 - x0 + 1) * (y1 - y0 + 1) > 400) return;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.imageSmoothingQuality = 'high';
  const S = (lon, lat) => {
    const [x, y] = fromLonLat(lon, lat);
    const [sx, sy] = view.toScreen(x, y);
    return [sx * dpr, sy * dpr];
  };
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const wx = ((tx % n) + n) % n;
      const e = getTile(tileUrl(src, z, wx, ty), requestRedraw);
      if (!e.ok) continue;
      const p0 = S(tileLon(tx, z), tileLat(ty, z));
      const p1 = S(tileLon(tx + 1, z), tileLat(ty, z));
      const p2 = S(tileLon(tx, z), tileLat(ty + 1, z));
      const a = (p1[0] - p0[0]) / 256;
      const b = (p1[1] - p0[1]) / 256;
      const c = (p2[0] - p0[0]) / 256;
      const d = (p2[1] - p0[1]) / 256;
      ctx.setTransform(a, b, c, d, p0[0], p0[1]);
      // medio píxel de solape para que no se vean las juntas
      ctx.drawImage(e.img, -0.3, -0.3, 256.6, 256.6);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}
