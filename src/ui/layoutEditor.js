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

import { composeLayout, defaultLayout, fitFrame, frameExtent, pageGeometry, pageToGround, PAGES, SYMBOL_SCALES, symbolFactor } from '../layout/compose.js';
import { allTopShapes } from '../doc.js';
import { shapeBBox, unionBBox } from '../vector.js';
import { computeHillshadeImage, imageFiles } from '../raster/rasterView.js';
import { drawBasemap, BASEMAPS } from '../raster/basemap.js';
import { lonLatBBox } from '../raster/dem.js';
import { View } from '../view.js';
import { h, sec, row, select, num, text, check, btn, color } from './dom.js';
import { download } from '../io/store.js';
import { loadScript } from '../io/loader.js';

/** Lado máximo (px) de las imágenes raster de la lámina. */
const MAX_RASTER_PX = 9000;

export class LayoutEditor {
  constructor(app) {
    this.app = app;
    this.el = h('div', { id: 'layout-preview' });
    this.content = h('div', { class: 'lp-content' });
    this.overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.overlay.setAttribute('class', 'lp-overlay');
    this.stage = h('div', { class: 'lp-page' }, this.content, this.overlay);
    this.bar = h(
      'div',
      { class: 'lp-bar' },
      btn('⛶ Encuadrar capas vectoriales', () => this.fitVectors(), 'primary sm'),
      btn('＋', () => this.zoomBy(1.25), 'sm'),
      btn('－', () => this.zoomBy(0.8), 'sm'),
      btn('▭ Marco automático', () => this.resetFrame(), 'sm'),
      h('span', { class: 'lp-hint' }, 'Arrastra dentro del marco = mover el mapa · rueda = zoom · vértices del marco = tamaño · arrastra un elemento para moverlo · Supr lo elimina'),
    );
    this.el.append(this.stage, this.bar);
    document.getElementById('viewport').append(this.el);
    this.el.hidden = true;
    this.rasterCache = new Map(); // clave -> href
    this.pending = 0;
    this.sel = null; // 'frame' | 'title' | 'legend' | 'north' | 'scalebar' | 'info' | null
    this.geom = null;
    this.live = { s: 1, tx: 0, ty: 0 }; // transformación en vivo del contenido del mapa (mm de página)
    this.gesture = null;
    this.bind();
  }

  /* --------------------------------------------------------- interacción */

  bind() {
    const st = this.stage;
    st.addEventListener('pointerdown', (e) => this.onDown(e));
    st.addEventListener('pointermove', (e) => this.onMove(e));
    st.addEventListener('pointerup', (e) => this.onUp(e));
    st.addEventListener('pointercancel', (e) => this.onUp(e, true));
    st.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    st.addEventListener('contextmenu', (e) => e.preventDefault());
    // en captura: con el layout abierto, Supr / flechas no deben tocar el dibujo de atrás
    window.addEventListener(
      'keydown',
      (e) => {
        if (this.el.hidden) return;
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
        const mod = e.ctrlKey || e.metaKey;
        if (mod) return;
        const stop = () => {
          e.stopImmediatePropagation();
          e.preventDefault();
        };
        if (e.key === 'Delete' || e.key === 'Backspace') {
          stop();
          if (this.sel && this.sel !== 'frame') this.deleteElement(this.sel);
        } else if (e.key === 'Escape') {
          stop();
          this.select(null);
        } else if (e.key.startsWith('Arrow')) {
          stop();
          const k = e.shiftKey ? 5 : 0.5;
          const dx = e.key === 'ArrowLeft' ? -k : e.key === 'ArrowRight' ? k : 0;
          const dy = e.key === 'ArrowUp' ? -k : e.key === 'ArrowDown' ? k : 0;
          if (this.sel && this.sel !== 'frame') this.nudgeElement(this.sel, dx, dy);
          else this.panByMm(-dx, -dy);
        }
      },
      true,
    );
  }

  /** Punto del puntero en mm de página. */
  mm(e) {
    const r = this.stage.getBoundingClientRect();
    return [((e.clientX - r.left) * this.geom.W) / r.width, ((e.clientY - r.top) * this.geom.H) / r.height];
  }

  /** mm de página por píxel de pantalla. */
  mmPerPx() {
    return this.geom ? this.geom.W / this.stage.getBoundingClientRect().width : 1;
  }

  inFrame(p) {
    const g = this.geom;
    return p[0] >= g.fx && p[0] <= g.fx + g.fw && p[1] >= g.fy && p[1] <= g.fy + g.fh;
  }

  select(sel) {
    this.sel = sel;
    this.drawOverlay();
  }

  elementGroup(name) {
    return this.content.querySelector(`[data-el="${name}"]`);
  }

  onDown(e) {
    if (!this.geom || (e.pointerType === 'mouse' && e.button > 1)) return;
    const p = this.mm(e);
    const handle = e.target.closest?.('[data-h]')?.dataset.h;
    try {
      this.stage.setPointerCapture?.(e.pointerId);
    } catch {
      /* puntero sintético */
    }
    clearTimeout(this.liveT);
    if (handle === 'del') {
      this.deleteElement(this.sel);
      return;
    }
    if (handle) {
      this.gesture = { mode: 'resize', handle, f0: this.frameRect(), start: p };
      return;
    }
    const el = e.target.closest?.('[data-el]');
    if (el && e.pointerType !== 'touch-pan') {
      const name = el.dataset.el;
      this.select(name);
      this.gesture = { mode: 'move', el: name, start: p, base: [...(this.L.offsets?.[name] || [0, 0])] };
      return;
    }
    if (this.inFrame(p)) {
      this.select('frame');
      this.gesture = { mode: 'pan', start: p, t0: { ...this.live } };
      return;
    }
    this.select(null);
    this.gesture = null;
  }

  onMove(e) {
    const gs = this.gesture;
    if (!gs) return;
    const p = this.mm(e);
    const dx = p[0] - gs.start[0];
    const dy = p[1] - gs.start[1];
    if (gs.mode === 'move') {
      const g = this.elementGroup(gs.el)?.querySelector(':scope > .eo');
      if (g) g.setAttribute('transform', `translate(${gs.base[0] + dx} ${gs.base[1] + dy})`);
      gs.delta = [dx, dy];
      this.drawOverlay();
    } else if (gs.mode === 'pan') {
      this.live = { s: gs.t0.s, tx: gs.t0.tx + dx, ty: gs.t0.ty + dy };
      this.applyLive();
    } else if (gs.mode === 'resize') {
      gs.rect = this.resized(gs.f0, gs.handle, p);
      this.drawOverlay(gs.rect);
    }
  }

  onUp(e, cancelled = false) {
    const gs = this.gesture;
    this.gesture = null;
    if (!gs || cancelled) {
      if (gs) this.schedule(0);
      return;
    }
    if (gs.mode === 'move' && gs.delta) {
      const o = { ...(this.L.offsets || {}), [gs.el]: [+(gs.base[0] + gs.delta[0]).toFixed(2), +(gs.base[1] + gs.delta[1]).toFixed(2)] };
      this.set({ offsets: o });
    } else if (gs.mode === 'pan') {
      this.commitLive();
    } else if (gs.mode === 'resize' && gs.rect) {
      this.commitFrame(gs.rect);
    }
  }

  onWheel(e) {
    if (!this.geom) return;
    const p = this.mm(e);
    if (!this.inFrame(p)) return;
    e.preventDefault();
    let dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
    if (typeof e.wheelDeltaY === 'number' && e.wheelDeltaY && e.wheelDeltaY % 120 === 0) dy = -(e.wheelDeltaY / 120) * 100;
    const k = Math.exp(-Math.max(-150, Math.min(150, dy)) * 0.0022);
    this.zoomLive(k, p);
    clearTimeout(this.liveT);
    this.liveT = setTimeout(() => this.commitLive(), 350);
  }

  /** Acumula un zoom de factor `k` alrededor de `c` (mm de página) en la transformación en vivo. */
  zoomLive(k, c) {
    const { s, tx, ty } = this.live;
    const ns = Math.max(0.02, Math.min(50, s * k));
    const kk = ns / s;
    this.live = { s: ns, tx: c[0] + kk * (tx - c[0]), ty: c[1] + kk * (ty - c[1]) };
    this.applyLive();
  }

  zoomBy(k) {
    if (!this.geom) return;
    const g = this.geom;
    this.zoomLive(k, [g.fx + g.fw / 2, g.fy + g.fh / 2]);
    clearTimeout(this.liveT);
    this.liveT = setTimeout(() => this.commitLive(), 250);
  }

  panByMm(dx, dy) {
    this.live = { ...this.live, tx: this.live.tx + dx, ty: this.live.ty + dy };
    this.applyLive();
    clearTimeout(this.liveT);
    this.liveT = setTimeout(() => this.commitLive(), 350);
  }

  /** Mueve y escala al instante el contenido del mapa (mientras se recalcula lo pesado). */
  applyLive() {
    const { s, tx, ty } = this.live;
    const t = s === 1 && !tx && !ty ? '' : `matrix(${s} 0 0 ${s} ${tx} ${ty})`;
    for (const n of this.content.querySelectorAll('.lv')) {
      if (t) n.setAttribute('transform', t);
      else n.removeAttribute('transform');
    }
  }

  /** Convierte la transformación en vivo en nuevo centro y escala del mapa. */
  commitLive() {
    const { s, tx, ty } = this.live;
    if (!this.geom || (s === 1 && !tx && !ty)) return;
    const L = this.L;
    const g = this.geom;
    const F = [g.fx + g.fw / 2, g.fy + g.fh / 2];
    // el punto de página q que la transformación lleva al centro del marco
    const q = [(F[0] - tx) / s, (F[1] - ty) / s];
    const c = pageToGround(L, g, q[0], q[1]);
    this.set({ center: [Math.round(c[0]), Math.round(c[1])], scale: Math.max(100, Math.round(L.scale / s)) });
  }

  frameRect() {
    const g = this.geom;
    return { x: g.fx, y: g.fy, w: g.fw, h: g.fh };
  }

  resized(f0, h, p) {
    const g = this.geom;
    const min = 30;
    const lim = 2;
    const px = Math.max(lim, Math.min(g.W - lim, p[0]));
    const py = Math.max(lim, Math.min(g.H - lim, p[1]));
    let { x, y, w, h: hh } = { ...f0, h: f0.h };
    const r = x + w;
    const b = y + hh;
    if (h.includes('w')) {
      x = Math.min(px, r - min);
      w = r - x;
    }
    if (h.includes('e')) w = Math.max(min, px - x);
    if (h.includes('n')) {
      y = Math.min(py, b - min);
      hh = b - y;
    }
    if (h.includes('s')) hh = Math.max(min, py - y);
    return { x: +x.toFixed(1), y: +y.toFixed(1), w: +w.toFixed(1), h: +hh.toFixed(1) };
  }

  /**
   * Cambia el marco: el contenido del mapa NO se mueve respecto de la página
   * (el marco recorta o descubre más mapa), así que el centro se recalcula.
   */
  commitFrame(rect) {
    const L = this.L;
    const g = this.geom;
    const c = pageToGround(L, g, rect.x + rect.w / 2, rect.y + rect.h / 2);
    this.set({ frame: rect, center: [Math.round(c[0]), Math.round(c[1])] });
  }

  resetFrame() {
    const L = this.L;
    if (!L.frame && !Object.keys(L.offsets || {}).length) return this.app.message('El marco y los elementos ya están en su lugar automático');
    const g = pageGeometry({ ...L, frame: null });
    const cur = pageGeometry(L);
    const c = pageToGround(L, cur, g.fx + g.fw / 2, g.fy + g.fh / 2);
    this.set({ frame: null, offsets: {}, center: [Math.round(c[0]), Math.round(c[1])] });
  }

  deleteElement(name) {
    const patch = { title: { showTitle: false }, legend: { legend: false }, north: { north: false }, scalebar: { scalebar: false }, info: { showInfo: false } }[name];
    if (!patch) return;
    this.sel = null;
    this.set(patch);
    this.app.message('Elemento eliminado del layout (se puede volver a activar en el panel · Ctrl+Z)', 4000);
  }

  nudgeElement(name, dx, dy) {
    const cur = this.L.offsets?.[name] || [0, 0];
    this.set({ offsets: { ...(this.L.offsets || {}), [name]: [+(cur[0] + dx).toFixed(2), +(cur[1] + dy).toFixed(2)] } });
  }

  /** Encuadra todo lo vectorial visible (sin rasters ni servicios en línea) en el marco. */
  fitVectors() {
    const doc = this.app.history.doc;
    const L = this.L;
    const est = { mmToM: doc.refScale / 1000, ptToM: (doc.refScale / 1000) * 0.352778, mpp: L.scale / 3779.5 };
    const shapes = allTopShapes(doc).map((x) => x.shape);
    const box = unionBBox(shapes.map((s) => shapeBBox(s, est)));
    if (!box) return this.app.message('No hay objetos en las capas vectoriales visibles');
    const g = pageGeometry(L);
    const fit = fitFrame(L, g, { minX: box.x, maxX: box.x + box.w, minY: box.y, maxY: box.y + box.h }, { round: L.fitRound !== false });
    this.live = { s: 1, tx: 0, ty: 0 };
    this.set(fit);
    this.app.message(`Encuadre a 1:${fit.scale.toLocaleString('es-CL')} con ${shapes.length} objeto(s) vectoriales`, 3500);
  }

  /** Selección y vértices del marco, dibujados sobre la página (en mm). */
  drawOverlay(frameDrag = null) {
    const g = this.geom;
    const ov = this.overlay;
    ov.replaceChildren();
    if (!g) return;
    ov.setAttribute('viewBox', `0 0 ${g.W} ${g.H}`);
    const u = this.mmPerPx();
    const NS = 'http://www.w3.org/2000/svg';
    const add = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      ov.append(n);
      return n;
    };
    if (this.sel === 'frame' || frameDrag) {
      const r = frameDrag || this.frameRect();
      add('rect', { x: r.x, y: r.y, width: r.w, height: r.h, fill: frameDrag ? 'rgba(14,165,233,.08)' : 'none', stroke: '#0ea5e9', 'stroke-width': 1.4 * u, 'stroke-dasharray': `${4 * u} ${3 * u}` });
      const hs = 9 * u;
      const cx = r.x + r.w / 2;
      const cy = r.y + r.h / 2;
      const pts = { nw: [r.x, r.y], n: [cx, r.y], ne: [r.x + r.w, r.y], e: [r.x + r.w, cy], se: [r.x + r.w, r.y + r.h], s: [cx, r.y + r.h], sw: [r.x, r.y + r.h], w: [r.x, cy] };
      for (const [k, [x, y]] of Object.entries(pts)) {
        const n = add('rect', { x: x - hs / 2, y: y - hs / 2, width: hs, height: hs, fill: '#fff', stroke: '#0ea5e9', 'stroke-width': 1.5 * u, 'data-h': k, class: 'lp-handle' });
        n.style.cursor = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' }[k];
      }
    } else if (this.sel) {
      const gEl = this.elementGroup(this.sel);
      if (!gEl) return;
      let b;
      try {
        b = gEl.getBBox();
      } catch {
        return;
      }
      const pad = 1.2;
      add('rect', { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad, fill: 'none', stroke: '#0ea5e9', 'stroke-width': 1.4 * u, 'stroke-dasharray': `${4 * u} ${3 * u}` });
      const r = 7 * u;
      add('circle', { cx: b.x + b.width + pad, cy: b.y - pad, r, fill: '#ef4444', stroke: '#fff', 'stroke-width': 1.2 * u, 'data-h': 'del', class: 'lp-handle' }).style.cursor = 'pointer';
      add('path', { d: `M${b.x + b.width + pad - r * 0.45} ${b.y - pad - r * 0.45}l${r * 0.9} ${r * 0.9}m0 ${-r * 0.9}l${-r * 0.9} ${r * 0.9}`, stroke: '#fff', 'stroke-width': 1.6 * u, 'stroke-linecap': 'round', 'pointer-events': 'none' });
    }
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
    // hasta 9 000 px por lado (A0 a 200 dpi, A3 a 600 dpi)
    const wpx = Math.max(50, Math.min(MAX_RASTER_PX, Math.round((g.fw / 25.4) * dpi)));
    const hpx = Math.max(50, Math.min(MAX_RASTER_PX, Math.round((g.fh / 25.4) * dpi)));
    const v = new View(wpx, hpx);
    v.cx = (ext.minX + ext.maxX) / 2;
    v.cy = (ext.minY + ext.maxY) / 2;
    v.mpp = (ext.maxX - ext.minX) / wpx;
    const out = [];
    let group = null;
    const flush = () => {
      if (group) {
        out.push({ index: group.index, href: group.canvas.toDataURL('image/png'), opacity: 1, name: group.names.reverse().join(' + ') });
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
        group = { index: i, canvas, ctx: canvas.getContext('2d'), names: [] };
      }
      group.names.push(l.name);
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
      // la resolución de la capa (×0,25…×2) se respeta, pero nunca por debajo de 1 píxel de
      // DEM por píxel de salida: a la lámina no se le aplica el ahorro de la vista de trabajo
      const s = { ...l.settings, resolution: Math.max(1, l.settings.resolution || 1) };
      const PAD = 2;
      const r = await computeHillshadeImage(v.snapshot(), s, this.app.settings, signal, () => null, { pad: PAD });
      if (!r) return null;
      const full = document.createElement('canvas');
      full.width = r.w;
      full.height = r.h;
      full.getContext('2d').putImageData(new ImageData(r.rgba, r.w, r.h), 0, 0);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(full, PAD, PAD, r.w - 2 * PAD, r.h - 2 * PAD, 0, 0, v.w, v.h); // quita el margen de Horn
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
    // encajar la página en el área visible
    const L = this.L;
    const g0 = pageGeometry(L);
    const vw = this.el.clientWidth - 40;
    const vh = this.el.clientHeight - 40 - this.bar.offsetHeight;
    const k = Math.min(vw / g0.W, vh / g0.H);
    const { svg, geometry } = await this.build(this.previewDpi(L, k), abort.signal);
    if (abort.signal.aborted) return;
    // un gesto en curso (mover el mapa con el ratón) manda: se recalcula al soltar
    if (this.gesture) return this.schedule(300);
    this.stage.style.width = `${geometry.W * k}px`;
    this.stage.style.height = `${geometry.H * k}px`;
    this.geom = geometry;
    this.live = { s: 1, tx: 0, ty: 0 };
    this.content.innerHTML = svg.replace(/width="[\d.]+mm" height="[\d.]+mm"/, 'width="100%" height="100%"');
    if (this.sel && this.sel !== 'frame' && !this.elementGroup(this.sel)) this.sel = null;
    this.drawOverlay();
    this.app.message('');
  }

  /**
   * Resolución de la vista previa. Antes era fija en 72 dpi —menos que los 96
   * de la pantalla de trabajo, y la página se agranda para llenar el área— y
   * por eso el relieve se veía mucho más borroso que en la vista de capas.
   * Ahora sigue a la pantalla: los píxeles que ocupa la página (× la densidad
   * de píxeles del equipo), entre 96 y 400 dpi.
   */
  previewDpi(L, pxPerMm) {
    if (L.previewDpi && L.previewDpi !== 'auto') return Number(L.previewDpi);
    const auto = Math.round(pxPerMm * 25.4 * (window.devicePixelRatio || 1));
    return Math.max(96, Math.min(400, auto));
  }

  /* --------------------------------------------------------------- export */

  async exportAs(kind) {
    const L = this.L;
    this.app.message(`Generando ${kind.toUpperCase()} a ${L.dpi} dpi…`, 0);
    const built = await this.build(L.dpi);
    const { svg, geometry } = built;
    const name =
      String(L.title || 'mapa')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^\w-]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'mapa';
    if (kind === 'svg') {
      download(svg, `${name}.svg`, 'image/svg+xml');
    } else if (kind === 'jsx') {
      const { illustratorJsx } = await import('../io/illustrator.js');
      download(illustratorJsx(built, { title: L.title || 'Mapa' }), `${name}_illustrator.jsx`, 'text/plain');
      this.app.message('Script de Illustrator descargado: en Illustrator, Archivo → Scripts → Otro script… y elige el archivo. Crea una capa por cada capa de la lámina.', 9000);
      return;
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

  /** Armonía de tamaños entre la escala de referencia del dibujo y la de la lámina. */
  symbolSection(L) {
    const ref = this.app.history.doc.refScale;
    const f = symbolFactor(ref, L);
    const fmt = (v) => Number(v).toLocaleString('es-CL');
    return sec(
      'Tamaño de símbolos y textos',
      row('Modo', select(SYMBOL_SCALES, L.symbolScale || 'auto', (v) => this.set({ symbolScale: v }))),
      L.symbolScale === 'custom' ? row('Factor ×', num(L.symbolFactor, (v) => v > 0 && this.set({ symbolFactor: v }), { step: 0.05, min: 0.05 })) : null,
      h(
        'p',
        { class: 'hint' },
        `Dibujo a 1:${fmt(ref)}, lámina a 1:${fmt(L.scale)}: grosores, ornamentos, tramas y textos al ${Math.round(f * 100)} % de su tamaño en el estilo. «Automático» toma el punto medio entre dejarlos fijos en papel y escalarlos con el mapa, para que el cambio de escala no sea brusco.`,
      ),
      ref !== L.scale
        ? btn(`Usar 1:${fmt(L.scale)} como escala de referencia del dibujo`, () => {
            if (!confirm(`¿Cambiar la escala de referencia del dibujo de 1:${fmt(ref)} a 1:${fmt(L.scale)}? Los tamaños en pantalla pasarán a medirse a esa escala.`)) return;
            this.app.history.commit({ ...this.app.history.doc, refScale: L.scale });
            this.schedule(0);
          })
        : null,
    );
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
        btn('⛶ Encuadrar capas vectoriales', () => this.fitVectors(), 'primary'),
        check('Redondear la escala al encuadrar', L.fitRound !== false, (x) => this.set({ fitRound: x })),
        h('p', { class: 'hint' }, 'Encuadra solo lo dibujado en capas vectoriales visibles (no los rasters ni los mapas en línea). En la vista previa: arrastrar dentro del marco mueve el mapa, la rueda hace zoom y los vértices del marco cambian su tamaño (el mapa no se desplaza respecto de la hoja).'),
        h(
          'div',
          { class: 'grid-btns two' },
          btn('Marco y elementos automáticos', () => this.resetFrame()),
          btn(`Marco: ${L.frame ? `${L.frame.w.toFixed(0)}×${L.frame.h.toFixed(0)} mm` : 'automático'}`, () => this.select('frame')),
        ),
      ),
      this.symbolSection(L),
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
        check('Título', L.showTitle !== false, set('showTitle')),
        check('Datos (autor, fecha, sistema, notas, fuentes)', L.showInfo !== false, set('showInfo')),
        check('Norte (verdadero, con convergencia)', L.north, set('north')),
        check('Escala gráfica y numérica', L.scalebar, set('scalebar')),
        check('Leyenda (columna lateral)', L.legend, set('legend')),
        L.legend ? row('Ancho columna (mm)', num(L.legendWidth, set('legendWidth'), { step: 2, min: 40 })) : null,
        L.legend ? row('Título leyenda', text(L.legendTitle, set('legendTitle'))) : null,
        h('p', { class: 'hint' }, 'La leyenda junta un símbolo por estilo distinto de cada capa visible, rotulado con el campo de etiqueta de la capa.'),
      ),
      sec(
        'Exportar',
        row('Resolución', select({ 150: '150 dpi', 200: '200 dpi', 300: '300 dpi', 400: '400 dpi', 600: '600 dpi', 800: '800 dpi (muy pesado)' }, L.dpi, (x) => this.set({ dpi: Number(x) }))),
        row('Vista previa', select({ auto: 'Automática (sigue a la pantalla)', 96: 'Rápida (96 dpi)', 150: 'Nítida (150 dpi)', 250: 'Alta (250 dpi)', 400: 'Muy alta (400 dpi)', 600: 'Máxima (600 dpi, lenta)' }, String(L.previewDpi || 'auto'), (x) => this.set({ previewDpi: x === 'auto' ? 'auto' : Number(x) }))),
        h(
          'div',
          { class: 'grid-btns' },
          btn('PDF', () => this.exportAs('pdf').catch((e) => this.app.message(e.message, 6000)), 'primary'),
          btn('SVG', () => this.exportAs('svg').catch((e) => this.app.message(e.message, 6000))),
          btn('PNG', () => this.exportAs('png').catch((e) => this.app.message(e.message, 6000))),
        ),
        btn('Illustrator con capas (.jsx)', () => this.exportAs('jsx').catch((e) => this.app.message(e.message, 6000)), 'primary'),
        h('p', { class: 'hint' }, 'El SVG lleva un grupo con nombre por cada capa de la lámina. El script .jsx (Archivo → Scripts → Otro script… en Illustrator) arma el documento con una capa real de Illustrator por cada una: capas del mapa, etiquetas, grilla, marco, título, leyenda…'),
        btn('Actualizar vista previa', () => this.schedule(0)),
      ),
    ];
  }
}
