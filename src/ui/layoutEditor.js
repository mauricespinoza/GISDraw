/**
 * Editor de layout: vista previa de la lámina sobre el área del mapa,
 * controles en el panel y exportación a SVG, PDF y PNG.
 *
 * Las capas raster se repintan para el marco exacto del layout: el relieve se
 * recalcula a la resolución de salida (no es una captura de pantalla
 * ampliada), y el mapa base pide teselas al zoom que corresponde a esos dpi.
 * Las rasters consecutivas se componen en UNA imagen con sus modos de fusión
 * aplicados, porque el PDF no conoce `mix-blend-mode`: así un relieve en
 * "multiplicar" sale igual en pantalla, en SVG y en PDF.
 */

import { composeLayout, defaultLayout, frameExtent, pageGeometry, PAGES } from '../layout/compose.js';
import { computeHillshadeImage, imageFiles } from '../raster/rasterView.js';
import { drawBasemap, BASEMAPS } from '../raster/basemap.js';
import { lonLatBBox } from '../raster/dem.js';
import { View } from '../view.js';
import { h, sec, row, select, num, text, check, btn, color } from './dom.js';
import { download } from '../io/store.js';
import { loadScript } from '../io/loader.js';

export class LayoutEditor {
  constructor(app) {
    this.app = app;
    this.el = h('div', { id: 'layout-preview' });
    this.stage = h('div', { class: 'lp-page' });
    this.el.append(this.stage);
    document.getElementById('viewport').append(this.el);
    this.el.hidden = true;
    this.rasterCache = new Map(); // clave -> href
    this.pending = 0;
  }

  get L() {
    const doc = this.app.history.doc;
    return { ...defaultLayout(doc, this.app.view), ...(doc.layout || {}) };
  }

  set(patch) {
    const doc = this.app.history.doc;
    this.app.history.commit({ ...doc, layout: { ...this.L, ...patch } });
    this.schedule();
  }

  show() {
    this.el.hidden = false;
    if (!this.app.history.doc.layout) this.app.history.silent({ ...this.app.history.doc, layout: defaultLayout(this.app.history.doc, this.app.view) });
    this.schedule(0);
  }

  hide() {
    this.el.hidden = true;
  }

  schedule(ms = 250) {
    clearTimeout(this.t);
    this.t = setTimeout(() => this.preview().catch((e) => this.app.message(`Layout: ${e.message}`, 6000)), ms);
  }

  /** Imágenes raster para el marco, agrupando rasters consecutivas. */
  async rasters(L, dpi, { signal } = {}) {
    const doc = this.app.history.doc;
    const g = pageGeometry(L);
    const ext = frameExtent(L, g);
    const wpx = Math.max(50, Math.min(6000, Math.round((g.fw / 25.4) * dpi)));
    const hpx = Math.max(50, Math.min(6000, Math.round((g.fh / 25.4) * dpi)));
    const v = new View(wpx, hpx);
    v.cx = (ext.minX + ext.maxX) / 2;
    v.cy = (ext.minY + ext.maxY) / 2;
    v.mpp = (ext.maxX - ext.minX) / wpx;
    const out = [];
    let group = null;
    const flush = () => {
      if (group) {
        out.push({ index: group.index, href: group.canvas.toDataURL('image/png'), opacity: 1 });
        group = null;
      }
    };
    for (let i = 0; i < doc.layers.length; i++) {
      const l = doc.layers[i];
      if (!l.visible) continue;
      if (l.kind === 'vector') {
        flush();
        continue;
      }
      const c = await this.rasterCanvas(l, v, signal);
      if (!c) continue;
      if (!group) {
        const canvas = document.createElement('canvas');
        canvas.width = wpx;
        canvas.height = hpx;
        group = { index: i, canvas, ctx: canvas.getContext('2d') };
      }
      group.ctx.globalAlpha = l.opacity;
      group.ctx.globalCompositeOperation = l.blend && l.blend !== 'normal' ? l.blend : 'source-over';
      group.ctx.drawImage(c, 0, 0, wpx, hpx);
      group.ctx.globalAlpha = 1;
      group.ctx.globalCompositeOperation = 'source-over';
    }
    flush();
    return out;
  }

  async rasterCanvas(l, v, signal) {
    const canvas = document.createElement('canvas');
    canvas.width = v.w;
    canvas.height = v.h;
    const ctx = canvas.getContext('2d');
    if (l.kind === 'basemap') {
      const bbox = lonLatBBox(v.extent(0));
      // esperar a que lleguen las teselas (máx. ~10 s)
      for (let i = 0; i < 40; i++) {
        const pending = drawBasemap(ctx, v, l.settings.source, bbox, () => null);
        if (!pending) break;
        await new Promise((r) => setTimeout(r, 250));
        if (signal?.aborted) return null;
      }
      return canvas;
    }
    if (l.kind === 'image') {
      const img = imageFiles.get(l.settings.fileId);
      if (!img) return null;
      const [ax, ay] = v.toScreen(img.x0, img.y1);
      const [bx, by] = v.toScreen(img.x1, img.y0);
      ctx.drawImage(img.bitmap, ax, ay, bx - ax, by - ay);
      return canvas;
    }
    if (l.kind === 'hillshade') {
      const s = { ...l.settings, resolution: 1 };
      const r = await computeHillshadeImage(v.snapshot(), s, this.app.settings, signal, () => null, { pad: 2 });
      if (!r) return null;
      const full = document.createElement('canvas');
      full.width = r.w;
      full.height = r.h;
      full.getContext('2d').putImageData(new ImageData(r.rgba, r.w, r.h), 0, 0);
      ctx.drawImage(full, 2, 2, v.w, v.h, 0, 0, v.w, v.h); // quitar el margen de Horn
      return canvas;
    }
    return null;
  }

  attribution() {
    const src = new Set();
    for (const l of this.app.history.doc.layers) {
      if (!l.visible) continue;
      if (l.kind === 'basemap') src.add(BASEMAPS[l.settings.source]?.attribution);
      if (l.kind === 'hillshade') src.add(l.settings.source === 'terrarium' ? 'DEM Terrarium/AWS (SRTM, GMTED, ETOPO1)' : l.settings.source === 'opentopo' ? `DEM ${l.settings.demtype} (OpenTopography)` : `DEM ${l.settings.fileName || 'propio'}`);
    }
    return [...src].filter(Boolean).join('; ');
  }

  async build(dpi, signal) {
    const L = this.L;
    const rasters = await this.rasters(L, dpi, { signal });
    return composeLayout(this.app.history.doc, L, rasters, this.attribution());
  }

  async preview() {
    if (this.el.hidden) return;
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.app.message('Componiendo lámina…', 0);
    const { svg, geometry } = await this.build(72, abort.signal);
    if (abort.signal.aborted) return;
    // encajar la página en el área visible
    const vw = this.el.clientWidth - 40;
    const vh = this.el.clientHeight - 40;
    const k = Math.min(vw / geometry.W, vh / geometry.H);
    this.stage.style.width = `${geometry.W * k}px`;
    this.stage.style.height = `${geometry.H * k}px`;
    this.stage.innerHTML = svg.replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="100%" height="100%"');
    this.app.message('');
  }

  /* --------------------------------------------------------------- export */

  async exportAs(kind) {
    const L = this.L;
    this.app.message(`Generando ${kind.toUpperCase()} a ${L.dpi} dpi…`, 0);
    const { svg, geometry } = await this.build(L.dpi);
    const name = (L.title || 'mapa').replace(/[^\w\-áéíóúñÁÉÍÓÚÑ]+/g, '_');
    if (kind === 'svg') {
      download(svg, `${name}.svg`, 'image/svg+xml');
    } else if (kind === 'png') {
      const scale = L.dpi / 25.4;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(geometry.W * scale);
      canvas.height = Math.round(geometry.H * scale);
      const img = new Image();
      img.src = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      await img.decode();
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      canvas.toBlob((b) => download(b, `${name}.png`), 'image/png');
    } else if (kind === 'pdf') {
      await loadScript('vendor/jspdf.umd.min.js');
      await loadScript('vendor/svg2pdf.umd.min.js');
      const { jsPDF } = globalThis.jspdf;
      const pdf = new jsPDF({ orientation: geometry.W > geometry.H ? 'landscape' : 'portrait', unit: 'mm', format: [geometry.W, geometry.H] });
      const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
      // svg2pdf necesita el SVG en el documento para resolver estilos
      const holder = h('div', { style: { position: 'fixed', left: '-99999px', top: '0' } });
      holder.append(el);
      document.body.append(holder);
      try {
        await pdf.svg(el, { x: 0, y: 0, width: geometry.W, height: geometry.H });
      } finally {
        holder.remove();
      }
      pdf.setProperties({ title: L.title || 'Mapa', creator: 'GISDrawer' });
      pdf.save(`${name}.pdf`);
    }
    this.app.message(`${kind.toUpperCase()} exportado`);
  }

  /* ---------------------------------------------------------------- panel */

  panel() {
    const L = this.L;
    const set = (k) => (v) => this.set({ [k]: v });
    const v = this.app.view;
    return [
      sec(
        'Página',
        row('Tamaño', select(Object.keys(PAGES), L.page, set('page'))),
        row('Orientación', select({ landscape: 'Horizontal', portrait: 'Vertical' }, L.orientation, set('orientation'))),
        row('Margen (mm)', num(L.margin, set('margin'), { step: 1, min: 0 })),
      ),
      sec(
        'Mapa',
        row('Escala 1:', num(L.scale, set('scale'), { step: 1000, min: 100 })),
        row('Centro E', num(L.center[0], (x) => this.set({ center: [x, L.center[1]] }), { step: 100 })),
        row('Centro N', num(L.center[1], (y) => this.set({ center: [L.center[0], y] }), { step: 100 })),
        h(
          'div',
          { class: 'grid-btns two' },
          btn('Centrar en la vista', () => this.set({ center: [Math.round(v.cx), Math.round(v.cy)] })),
          btn('Escala de la vista', () => this.set({ scale: Math.round(v.scale / 500) * 500 || 500 })),
        ),
        h('p', { class: 'hint' }, 'Los símbolos y textos salen al tamaño en papel definido en el estilo (mm, pt).'),
      ),
      sec(
        'Grilla y coordenadas',
        row('Grilla', select({ none: 'Sin grilla', utm: 'UTM (m)', geo: 'Geográfica (° \' ")', both: 'UTM + geográfica' }, L.grid, set('grid'))),
        row('Estilo', select({ crosses: 'Cruces', lines: 'Líneas', ticks: 'Solo marcas en el borde' }, L.gridStyle, set('gridStyle'))),
        row('Intervalo UTM (m)', num(L.gridInterval || '', set('gridInterval'), { step: 500, min: 0 })),
        row('Intervalo geo (min)', num(L.geoInterval || '', set('geoInterval'), { step: 1, min: 0 })),
        h('p', { class: 'hint' }, 'Intervalos vacíos o 0 = automáticos.'),
        row('Color', color(L.gridColor, null, set('gridColor'))),
        row('Rótulos (pt)', num(L.gridLabelSize, set('gridLabelSize'), { step: 0.5, min: 3 })),
        check('Borde de cebra', L.zebra, set('zebra')),
      ),
      sec(
        'Elementos',
        row('Título', text(L.title, set('title'))),
        row('Subtítulo', text(L.subtitle, set('subtitle'))),
        row('Autor', text(L.author, set('author'))),
        row('Fecha', text(L.date, set('date'))),
        row('Notas', text(L.notes, set('notes'))),
        check('Norte (verdadero, con convergencia)', L.north, set('north')),
        check('Escala gráfica y numérica', L.scalebar, set('scalebar')),
        check('Leyenda (columna lateral)', L.legend, set('legend')),
        L.legend ? row('Ancho columna (mm)', num(L.legendWidth, set('legendWidth'), { step: 2, min: 40 })) : null,
        L.legend ? row('Título leyenda', text(L.legendTitle, set('legendTitle'))) : null,
        h('p', { class: 'hint' }, 'La leyenda junta un símbolo por estilo distinto de cada capa visible, rotulado con el campo de etiqueta de la capa.'),
      ),
      sec(
        'Exportar',
        row('Resolución', select({ 150: '150 dpi', 200: '200 dpi', 300: '300 dpi', 400: '400 dpi' }, L.dpi, (x) => this.set({ dpi: Number(x) }))),
        h(
          'div',
          { class: 'grid-btns' },
          btn('PDF', () => this.exportAs('pdf').catch((e) => this.app.message(e.message, 6000)), 'primary'),
          btn('SVG', () => this.exportAs('svg').catch((e) => this.app.message(e.message, 6000))),
          btn('PNG', () => this.exportAs('png').catch((e) => this.app.message(e.message, 6000))),
        ),
        btn('Actualizar vista previa', () => this.schedule(0)),
      ),
    ];
  }
}
