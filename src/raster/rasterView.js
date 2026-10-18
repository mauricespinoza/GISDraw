/**
 * Las capas raster en pantalla: un <canvas> por capa dentro de la pila.
 *
 * Dos ritmos distintos:
 *  - mapa base e imágenes se repintan en cada cuadro (es solo drawImage);
 *  - el relieve sombreado se CALCULA (descarga + Horn + paleta): mientras la
 *    vista se mueve, el canvas viejo se desplaza y escala con CSS para seguir
 *    al dedo, y el cálculo nuevo se lanza cuando la vista se queda quieta.
 */

import { drawBasemap } from './basemap.js';
import { compose, elevationRange, hillshade, defaultHillshadeSettings } from './hillshade.js';
import { fetchOpenTopography, gridSampler, lonLatBBox, sampleGrid, terrariumSampler, zoomForMpp } from './dem.js';
import { toLonLat } from '../proj.js';

import { isGisLayer, modeOf } from '../mode.js';

export const demFiles = new Map(); // fileId -> grid (GeoTIFF/ASCII importados)
export const imageFiles = new Map(); // fileId -> { bitmap, x0, y0, x1, y1 } (imagen alineada a UTM)
/** Imagen de una capa con su posición efectiva: `settings.bounds` (movida/escalada en el layout) manda sobre la original. */
export function imageRect(layer) {
  const img = imageFiles.get(layer.settings.fileId);
  if (!img) return null;
  const b = layer.settings.bounds;
  return b ? { ...img, x0: b[0], y0: b[1], x1: b[2], y1: b[3] } : img;
}

const otCache = new Map(); // clave de extensión -> grid de OpenTopography

export class RasterView {
  constructor(view, getSettings) {
    this.view = view;
    this.getSettings = getSettings; // () => ajustes globales (clave de OT, etc.)
    this.state = new Map(); // layerId -> {canvas, rendered, timer, abort, key}
    this.onStatus = () => {};
  }

  element(layer) {
    let st = this.state.get(layer.id);
    if (!st) {
      const canvas = document.createElement('canvas');
      canvas.className = 'layer-canvas';
      canvas.dataset.layer = layer.id;
      st = { canvas, rendered: null, timer: 0, abort: null, key: '' };
      this.state.set(layer.id, st);
    }
    return st.canvas;
  }

  forget(id) {
    const st = this.state.get(id);
    if (st?.abort) st.abort.abort();
    this.state.delete(id);
  }

  sizeCanvas(canvas, scale = window.devicePixelRatio || 1) {
    const w = Math.max(1, Math.round(this.view.w * scale));
    const h = Math.max(1, Math.round(this.view.h * scale));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }

  /** Repinta una capa raster para la vista actual. */
  draw(layer, { settled = false } = {}) {
    const st = this.state.get(layer.id) || (this.element(layer), this.state.get(layer.id));
    const canvas = st.canvas;
    canvas.style.opacity = layer.opacity;
    canvas.style.mixBlendMode = layer.blend || 'normal';
    const off = !layer.visible || (isGisLayer(layer) && modeOf(this.getSettings()) !== 'gis');
    canvas.style.display = off ? 'none' : '';
    if (off) return;
    if (layer.kind === 'basemap') {
      this.sizeCanvas(canvas);
      canvas.style.transform = '';
      const ctx = canvas.getContext('2d');
      drawBasemap(ctx, this.view, layer.settings.source, lonLatBBox(this.view.extent(64)), () => this.requestRedraw(layer));
    } else if (layer.kind === 'image') {
      this.sizeCanvas(canvas);
      this.drawImageLayer(canvas, layer);
    } else if (layer.kind === 'hillshade') {
      this.drawHillshade(st, layer, settled);
    }
  }

  requestRedraw(layer) {
    if (this.redrawPending) return;
    this.redrawPending = true;
    requestAnimationFrame(() => {
      this.redrawPending = false;
      this.onNeedRedraw?.(layer);
    });
  }

  drawImageLayer(canvas, layer) {
    const ctx = canvas.getContext('2d');
    const dpr = canvas.width / this.view.w;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const img = imageRect(layer);
    if (!img) return;
    const [ax, ay] = this.view.toScreen(img.x0, img.y1);
    const [bx, by] = this.view.toScreen(img.x1, img.y0);
    ctx.imageSmoothingEnabled = (bx - ax) / img.bitmap.width < 2;
    ctx.drawImage(img.bitmap, ax * dpr, ay * dpr, (bx - ax) * dpr, (by - ay) * dpr);
  }

  /* ------------------------------------------------------- relieve */

  drawHillshade(st, layer, settled) {
    const v = this.view;
    const s = { ...defaultHillshadeSettings(), ...layer.settings };
    // El relieve se calcula una vez y se reutiliza: mover o hacer zoom solo
    // desplaza/escala la imagen ya calculada. Se vuelve a calcular solo si
    // cambian los ajustes de la capa o si el usuario pide «Redraw» (`force`).
    const key = JSON.stringify(s);
    // vista provisional: escalar el último render
    if (st.rendered) {
      const r = st.rendered;
      const k = r.mpp / v.mpp;
      const [sx, sy] = v.toScreen(r.x0, r.y0);
      st.canvas.style.transformOrigin = '0 0';
      st.canvas.style.transform = `translate(${sx}px, ${sy}px) scale(${k})`;
      st.canvas.style.width = `${r.w / r.res}px`;
      st.canvas.style.height = `${r.h / r.res}px`;
    }
    if (st.rendered && key === st.key && !st.force) return;
    clearTimeout(st.timer);
    st.timer = setTimeout(() => this.computeHillshade(st, layer, s, key), settled || st.force ? 0 : 180);
  }

  async computeHillshade(st, layer, s, key) {
    if (st.abort) st.abort.abort();
    const abort = new AbortController();
    st.abort = abort;
    st.force = false;
    const v = this.view.snapshot();
    this.onStatus(layer.id, 'Calculando relieve…');
    try {
      const r = await computeHillshadeImage(v, s, this.getSettings(), abort.signal, (m) => this.onStatus(layer.id, m));
      if (!r || abort.signal.aborted) return;
      const canvas = st.canvas;
      canvas.width = r.w;
      canvas.height = r.h;
      canvas.getContext('2d').putImageData(new ImageData(r.rgba, r.w, r.h), 0, 0);
      st.rendered = { x0: r.x0, y0: r.y0, mpp: v.mpp, w: r.w, h: r.h, res: r.res, range: r.range, elev: r.elev, cell: r.cell };
      st.key = key;
      this.lastRange = r.range;
      this.drawHillshade(st, layer, false);
      this.onStatus(layer.id, '');
      this.onRendered?.(layer, st.rendered);
      this.onStaleChange?.();
    } catch (err) {
      if (err.name === 'AbortError') return;
      this.onStatus(layer.id, `Relieve: ${err.message}`);
      st.key = key; // no reintentar en bucle
    }
  }

  /** Pide recalcular todos los relieves para la vista actual (botón «Redraw»). Devuelve cuántos. */
  redrawHillshades(layers) {
    let n = 0;
    for (const l of layers) {
      if (l.kind !== 'hillshade' || !l.visible || modeOf(this.getSettings()) !== 'gis') continue;
      const st = this.state.get(l.id);
      if (!st) continue;
      st.force = true;
      this.draw(l, { settled: true });
      n++;
    }
    return n;
  }

  /**
   * Estado del relieve en caché respecto de la vista: null = no hay relieves
   * visibles; true = la imagen ya no cubre la vista o está a otra escala
   * (conviene «Redraw»); false = al día.
   */
  hillshadeStale(layers) {
    let any = false;
    let stale = false;
    const v = this.view;
    if (modeOf(this.getSettings()) !== 'gis') return null;
    for (const l of layers) {
      if (l.kind !== 'hillshade' || !l.visible) continue;
      any = true;
      const r = this.state.get(l.id)?.rendered;
      if (!r) continue;
      const k = r.mpp / v.mpp;
      const e = v.extent(0);
      const cw = r.w / r.res; // tamaño de la imagen en celdas de vista
      const covers = e.minX >= r.x0 - 1 && e.maxX <= r.x0 + cw * r.mpp + 1 && e.minY >= r.y0 - (r.h / r.res) * r.mpp - 1 && e.maxY <= r.y0 + 1;
      if (k > 1.4 || k < 0.7 || !covers) stale = true;
    }
    return any ? stale : null;
  }

  /** Elevación bajo un punto UTM, si hay un relieve calculado. */
  elevationAt(x, y) {
    for (const st of this.state.values()) {
      const r = st.rendered;
      if (!r?.elev) continue;
      const i = Math.floor((x - r.x0) / r.cell);
      const j = Math.floor((r.y0 - y) / r.cell);
      if (i >= 0 && j >= 0 && i < r.w && j < r.h) {
        const e = r.elev[j * r.w + i];
        if (!Number.isNaN(e)) return e;
      }
    }
    return null;
  }

  /** Canvas listo para exportar (el último render calculado) con su georreferencia. */
  snapshotOf(layerId) {
    const st = this.state.get(layerId);
    return st ? { canvas: st.canvas, rendered: st.rendered } : null;
  }
}

/**
 * Relieve para una vista cualquiera (la pantalla o el marco de un layout a
 * resolución de impresión). `v`: {cx, cy, mpp, w, h}.
 * Devuelve { rgba, w, h, x0, y0, cell, res, range, elev } (con 2 celdas de
 * margen para que Horn tenga vecinos en el borde).
 */
export async function computeHillshadeImage(v, settings, appSettings, signal, onStatus = () => {}, { pad = 2 } = {}) {
  const s = { ...defaultHillshadeSettings(), ...settings };
  let res = Math.max(0.25, Math.min(4, s.resolution || 1));
  // tope de memoria (elevación + sombreado + RGBA): ~64 millones de celdas
  while (v.w * v.h * res * res > 64e6 && res > 0.25) res /= 1.1;
  const cell = v.mpp / res;
  const w = Math.round(v.w * res) + 2 * pad;
  const h = Math.round(v.h * res) + 2 * pad;
  const x0 = v.cx - (v.w / 2) * v.mpp - pad * cell;
  const y0 = v.cy + (v.h / 2) * v.mpp + pad * cell;
  const ext = { minX: x0, maxX: x0 + w * cell, minY: y0 - h * cell, maxY: y0 };
  const bbox = lonLatBBox(ext);
  let sample;
  if (s.source === 'file') {
    const grid = demFiles.get(s.fileId);
    if (!grid) throw new Error('Importa un GeoTIFF o ASCII grid de elevación para esta capa');
    sample = gridSampler(grid);
  } else if (s.source === 'opentopo') {
    let grid = null;
    for (const g of otCache.values()) {
      if (g.demtype === s.demtype && g.bbox.west <= bbox.west && g.bbox.east >= bbox.east && g.bbox.south <= bbox.south && g.bbox.north >= bbox.north) grid = g;
    }
    if (!grid) {
      // se pide algo más grande que la vista para no volver a pedir en cada paneo
      const mx = (bbox.east - bbox.west) * 0.5;
      const my = (bbox.north - bbox.south) * 0.5;
      const big = { west: bbox.west - mx, east: bbox.east + mx, south: bbox.south - my, north: bbox.north + my };
      onStatus(`Descargando ${s.demtype} de OpenTopography…`);
      grid = await fetchOpenTopography(big, s.demtype, appSettings.opentopoKey, signal);
      grid.bbox = big;
      grid.demtype = s.demtype;
      otCache.set(JSON.stringify(big) + s.demtype, grid);
    }
    sample = gridSampler(grid);
  } else {
    const [, midLat] = toLonLat(v.cx, v.cy);
    const z = zoomForMpp(cell, midLat);
    sample = await terrariumSampler(bbox, z, signal);
  }
  if (signal?.aborted) return null;
  const elev = sampleGrid(sample, x0, y0, cell, w, h);
  const shade = s.shadeStrength > 0 ? hillshade(elev, w, h, cell, s) : null;
  const range = s.rangeMode === 'manual' ? { min: s.min, max: s.max } : elevationRange(elev);
  const rgba = compose(elev, shade, w, h, s, range);
  return { rgba, w, h, x0, y0, cell, res, range, elev };
}
