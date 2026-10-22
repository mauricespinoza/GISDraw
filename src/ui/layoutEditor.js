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

import { openRichEditor } from './richEditor.js';
import { composeLayout, defaultLayout, fitFrame, layoutTextShape, frameExtent, elementTransform, pageGeometry, pageToGround, PAGES, SYMBOL_SCALES, symbolFactor } from '../layout/compose.js';
import { allTopShapes, findLayer, findTopShape, mapShapes, updateLayer } from '../doc.js';
import { pickShape } from '../hit.js';
import { makeText, newId, scaleShape, shapeBBox, translateShape, unionBBox } from '../vector.js';
import { addShapes } from '../doc.js';
import { applyStyle, deleteStyle, getStyle, importStyles, listStyles, parseStyleFile, pickStyle, saveStyle, styleFile } from '../layout/styles.js';
import { defaultStyle } from '../style.js';
import { computeHillshadeImage, imageRect } from '../raster/rasterView.js';
import { drawBasemap, BASEMAPS } from '../raster/basemap.js';
import { lonLatBBox } from '../raster/dem.js';
import { View } from '../view.js';
import { h, sec, row, select, num, text, check, btn, color } from './dom.js';
import { download } from '../io/store.js';
import { askConfirm, askText } from './dialog.js';
import { loadScript } from '../io/loader.js';
import { isGisLayer } from '../mode.js';

/** Codifica un canvas a data URL sin bloquear: toBlob (PNG, o JPEG si es opaco) y lectura asíncrona. */
function encodeCanvas(canvas, opaque) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) return reject(new Error('No se pudo codificar la imagen del mapa'));
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = () => reject(fr.error);
        fr.readAsDataURL(blob);
      },
      opaque ? 'image/jpeg' : 'image/png',
      0.95,
    );
  });
}

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
      (this.textBtn = btn('T Cuadro de texto', () => this.startAddText(), 'sm')),
      h('span', { class: 'lp-hint' }, 'Arrastra dentro del marco = mover el mapa · rueda = zoom · vértices del marco = tamaño · arrastra un elemento (o un objeto vectorial del mapa) para moverlo · cuadrito de su esquina inferior = escalarlo · candado = bloquearlo · imágenes pegadas: clic y arrastrar · Supr lo elimina'),
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
    st.addEventListener('dblclick', (e) => {
      const el = e.target.closest?.('[data-el^="text:"]');
      if (el) this.editText(el.dataset.el.slice(5));
    });
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
          if (this.sel === 'shapes') {
            this.app.editor.deleteSelection();
            this.select(null);
            this.schedule(0);
          } else if (this.sel?.startsWith('image:')) this.app.message('Para quitar la imagen elimina su capa en la pestaña Capas');
          else if (this.sel && this.sel !== 'frame') {
            if (this.isLocked(this.sel)) this.app.message('Elemento bloqueado: desbloquéalo con el candado');
            else this.deleteElement(this.sel);
          }
        } else if (e.key === 'Escape') {
          stop();
          this.adding = false;
          this.textBtn?.classList.remove('on');
          this.select(null);
        } else if (e.key.startsWith('Arrow')) {
          stop();
          const k = e.shiftKey ? 5 : 0.5;
          const dx = e.key === 'ArrowLeft' ? -k : e.key === 'ArrowRight' ? k : 0;
          const dy = e.key === 'ArrowUp' ? -k : e.key === 'ArrowDown' ? k : 0;
          if (this.sel === 'shapes') this.transformVectors(dx, dy);
          else if (this.sel?.startsWith('image:')) this.transformImage(dx, dy);
          else if (this.sel && this.sel !== 'frame') {
            if (!this.isLocked(this.sel)) this.nudgeElement(this.sel, dx, dy);
          }
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

  /* ------------------------------------------------ bloqueo de elementos */

  isLocked(name) {
    const L = this.L;
    return !!(L.lockAll || L.locks?.[name]);
  }

  toggleLock(name) {
    const locks = { ...(this.L.locks || {}) };
    if (locks[name]) delete locks[name];
    else locks[name] = true;
    this.set({ locks });
    this.app.message(locks[name] ? 'Elemento bloqueado: ya no se mueve ni se escala por accidente' : 'Elemento desbloqueado', 2500);
    this.app.panels?.render();
  }

  /* ------------------------------------------ imágenes raster dentro del marco */

  /** Rectángulo de una capa de imagen en mm de página: {x, y, w, h}. */
  imagePageRect(layer) {
    const img = imageRect(layer);
    if (!img) return null;
    const c = this.vctx();
    const [x0, y0] = c.toPage(img.x0, img.y1);
    const [x1, y1] = c.toPage(img.x1, img.y0);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  /**
   * Capa de imagen visible bajo el punto, la de más arriba.
   * Las que cubren todo el marco no cuentan: son fondo y ahí se arrastra el mapa.
   */
  pickImage(p) {
    const g = this.geom;
    const layers = this.app.history.doc.layers;
    for (let i = layers.length - 1; i >= 0; i--) {
      const l = layers[i];
      if (l.kind !== 'image' || !l.visible) continue;
      const r = this.imagePageRect(l);
      if (!r || p[0] < r.x || p[0] > r.x + r.w || p[1] < r.y || p[1] > r.y + r.h) continue;
      if (r.x <= g.fx && r.y <= g.fy && r.x + r.w >= g.fx + g.fw && r.y + r.h >= g.fy + g.fh) continue;
      return l;
    }
    return null;
  }

  selectedImage() {
    const id = this.sel?.startsWith('image:') ? this.sel.slice(6) : null;
    const l = id && findLayer(this.app.history.doc, id);
    return l?.kind === 'image' ? l : null;
  }

  /** Mueve (dx, dy mm de página) y/o escala (s, esquina sup. izq. fija) la imagen seleccionada. */
  transformImage(dx, dy, s = 1) {
    const l = this.selectedImage();
    const r = l && this.imagePageRect(l);
    if (!r) return;
    const c = this.vctx();
    const ext = frameExtent(c.L, c.g);
    const toGround = (px, py) => [ext.minX + (px - c.g.fx) / c.k, ext.maxY - (py - c.g.fy) / c.k];
    const [x0, y1] = toGround(r.x + dx, r.y + dy);
    const [x1, y0] = toGround(r.x + dx + r.w * s, r.y + dy + r.h * s);
    this.app.history.commit(updateLayer(this.app.history.doc, l.id, (ly) => ({ ...ly, settings: { ...ly.settings, bounds: [x0, y0, x1, y1] } })));
    this.schedule(0);
  }

  /* ------------------------------------- objetos vectoriales dentro del marco */

  /** Contexto para tratar la hoja como una «vista» del mapa: página (mm) ↔ terreno (m). */
  vctx() {
    const L = this.L;
    const g = this.geom;
    const ext = frameExtent(L, g);
    const k = 1000 / L.scale; // mm por metro
    const f = symbolFactor(this.app.history.doc.refScale, L);
    const ppm = this.stage.getBoundingClientRect().width / g.W; // px de pantalla por mm de página
    const toPage = (x, y) => [g.fx + (x - ext.minX) * k, g.fy + (ext.maxY - y) * k];
    const view = { mpp: 1 / (k * ppm), toScreen: (x, y) => toPage(x, y).map((v) => v * ppm) };
    const units = { mmToPx: f * ppm, ptToPx: 0.352778 * f * ppm, mmToM: f / k, ptToM: (0.352778 * f) / k };
    return { L, g, k, f, ppm, toPage, view, units, est: { mmToM: units.mmToM, ptToM: units.ptToM, mpp: view.mpp } };
  }

  /** Objeto vectorial bajo un punto de la página (mm), o null. */
  pickVector(p) {
    const c = this.vctx();
    const hit = pickShape(this.app.history.doc, [p[0] * c.ppm, p[1] * c.ppm], c.view, c.units, 6);
    return hit?.shape || null;
  }

  selectedVectors() {
    const doc = this.app.history.doc;
    return [...this.app.editor.selection].map((id) => findTopShape(doc, id)?.shape).filter(Boolean);
  }

  /** Caja (mm de página) de los objetos vectoriales seleccionados. */
  vectorBox() {
    const shapes = this.selectedVectors();
    if (!shapes.length) return null;
    const c = this.vctx();
    const b = unionBBox(shapes.map((s) => shapeBBox(s, c.est)));
    if (!b) return null;
    const [x0, y0] = c.toPage(b.x, b.y + b.h);
    return { x: x0, y: y0, w: b.w * c.k, h: b.h * c.k };
  }

  /** Mueve (dx, dy en mm de página) y/o escala (s, alrededor de la esquina sup. izq.) los objetos seleccionados. */
  transformVectors(dx, dy, s = 1) {
    const box = this.vectorBox();
    const ids = [...this.app.editor.selection];
    if (!box || !ids.length) return;
    const c = this.vctx();
    const ext = frameExtent(c.L, c.g);
    const origin = { x: ext.minX + (box.x - c.g.fx) / c.k, y: ext.maxY - (box.y - c.g.fy) / c.k };
    const gx = dx / c.k;
    const gy = -dy / c.k;
    const doc = this.app.history.doc;
    this.app.history.commit(
      mapShapes(doc, ids, (sh) => {
        let out = s !== 1 ? scaleShape(sh, origin, s, s) : sh;
        if (gx || gy) out = translateShape(out, gx, gy);
        return out;
      }),
    );
    this.schedule(0);
  }

  selectVector(shape, add) {
    const ed = this.app.editor;
    const ids = add ? (ed.selection.has(shape.id) ? [...ed.selection].filter((x) => x !== shape.id) : [...ed.selection, shape.id]) : ed.selection.has(shape.id) ? [...ed.selection] : [shape.id];
    ed.setSelection(ids);
    this.select(ids.length ? 'shapes' : null);
  }

  select(sel) {
    const changed = sel !== this.sel;
    if (sel !== 'shapes' && this.app.editor.selection.size) this.app.editor.setSelection([]);
    this.sel = sel;
    this.drawOverlay();
    // el panel muestra los controles del cuadro de texto seleccionado
    if (changed && this.app.panels?.tab === 'layout' && (sel?.startsWith('text:') || this.prevSelText)) this.app.panels.render();
    this.prevSelText = !!sel?.startsWith('text:');
  }

  elementGroup(name) {
    return this.content.querySelector(`[data-el="${name}"]`);
  }

  onDown(e) {
    if (!this.geom || (e.pointerType === 'mouse' && e.button > 1)) return;
    const p = this.mm(e);
    if (this.adding) {
      this.adding = false;
      this.stage.style.cursor = '';
      this.textBtn?.classList.remove('on');
      this.addText(p);
      return;
    }
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
    if (handle === 'lock') {
      this.toggleLock(this.sel);
      return;
    }
    if (handle === 'isc') {
      const l = this.selectedImage();
      const r = l && this.imagePageRect(l);
      if (r) this.gesture = { mode: 'iscale', start: [0, 0], r, s: 1 };
      return;
    }
    if (handle === 'vsc') {
      const b = this.vectorBox();
      if (b) this.gesture = { mode: 'vscale', start: [0, 0], box: b, w0: Math.max(1e-3, b.w), h0: Math.max(1e-3, b.h), s: 1 };
      return;
    }
    if (handle === 'sc' && this.sel && this.sel !== 'frame' && !this.isLocked(this.sel)) {
      const eo = this.elementGroup(this.sel)?.querySelector(':scope > .eo');
      if (eo) {
        const lb = eo.getBBox(); // en coordenadas locales (sin la transformación propia)
        const sc = this.L.scales?.[this.sel];
        const s0 = sc?.s || 1;
        const a = sc?.a || [lb.x, lb.y];
        const off = this.L.offsets?.[this.sel] || [0, 0];
        const A = [off[0] + a[0], off[1] + a[1]]; // ancla en la página
        const B = this.elementGroup(this.sel).getBBox();
        this.gesture = { mode: 'scale', start: [0, 0], el: this.sel, a, off, s0, A, w0: Math.max(1e-3, B.x + B.width - A[0]), h0: Math.max(1e-3, B.y + B.height - A[1]) };
        return;
      }
    }
    if (handle) {
      this.gesture = { mode: 'resize', handle, f0: this.frameRect(), start: p };
      return;
    }
    const el = e.target.closest?.('[data-el]');
    const lockedEl = el && this.isLocked(el.dataset.el);
    if (el && e.pointerType !== 'touch-pan' && !(lockedEl && this.inFrame(p))) {
      const name = el.dataset.el;
      this.select(name);
      if (lockedEl) {
        this.gesture = null;
        return;
      }
      this.gesture = { mode: 'move', el: name, start: p, base: [...(this.L.offsets?.[name] || [0, 0])] };
      return;
    }
    if (this.inFrame(p)) {
      const v = this.pickVector(p);
      if (v) {
        this.selectVector(v, e.shiftKey);
        if (this.sel === 'shapes') this.gesture = { mode: 'vmove', start: p };
        return;
      }
      const img = this.pickImage(p);
      if (img) {
        this.select(`image:${img.id}`);
        this.gesture = { mode: 'imove', start: p };
        return;
      }
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
    } else if (gs.mode === 'imove') {
      gs.delta = [dx, dy];
      this.drawOverlay();
    } else if (gs.mode === 'iscale') {
      gs.s = Math.max(0.05, Math.min(40, Math.max((p[0] - gs.r.x) / gs.r.w, (p[1] - gs.r.y) / gs.r.h)));
      this.drawOverlay();
    } else if (gs.mode === 'vmove') {
      gs.delta = [dx, dy];
      this.drawOverlay();
    } else if (gs.mode === 'vscale') {
      gs.s = Math.max(0.05, Math.min(40, Math.max((p[0] - gs.box.x) / gs.w0, (p[1] - gs.box.y) / gs.h0)));
      this.drawOverlay();
    } else if (gs.mode === 'scale') {
      const k = Math.max(0.05, Math.min(40, Math.max((p[0] - gs.A[0]) / gs.w0, (p[1] - gs.A[1]) / gs.h0)));
      gs.s = +(gs.s0 * k).toFixed(4);
      const eo = this.elementGroup(gs.el)?.querySelector(':scope > .eo');
      if (eo) eo.setAttribute('transform', elementTransform(this.L, gs.el, gs.off, { s: gs.s, a: gs.a }));
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
    } else if (gs.mode === 'imove') {
      if (gs.delta && Math.hypot(...gs.delta) > 0.3) this.transformImage(gs.delta[0], gs.delta[1]);
      else this.drawOverlay();
    } else if (gs.mode === 'iscale') {
      if (Math.abs(gs.s - 1) > 0.005) this.transformImage(0, 0, gs.s);
      else this.drawOverlay();
    } else if (gs.mode === 'vmove') {
      if (gs.delta && Math.hypot(...gs.delta) > 0.3) this.transformVectors(gs.delta[0], gs.delta[1]);
      else this.drawOverlay();
    } else if (gs.mode === 'vscale') {
      if (Math.abs(gs.s - 1) > 0.005) this.transformVectors(0, 0, gs.s);
      else this.drawOverlay();
    } else if (gs.mode === 'scale' && gs.s) {
      this.set({ scales: { ...(this.L.scales || {}), [gs.el]: { s: gs.s, a: gs.a.map((v) => +v.toFixed(2)) } } });
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
    if (!L.frame && !Object.keys(L.offsets || {}).length && !Object.keys(L.scales || {}).length) return this.app.message('El marco y los elementos ya están en su lugar automático');
    const g = pageGeometry({ ...L, frame: null });
    const cur = pageGeometry(L);
    const c = pageToGround(L, cur, g.fx + g.fw / 2, g.fy + g.fh / 2);
    this.set({ frame: null, offsets: {}, scales: {}, center: [Math.round(c[0]), Math.round(c[1])] });
  }

  deleteElement(name) {
    if (name?.startsWith('text:')) {
      const id = name.slice(5);
      const L = this.L;
      const o = { ...(L.offsets || {}) };
      delete o[name];
      const sc = { ...(L.scales || {}) };
      delete sc[name];
      const lk = { ...(L.locks || {}) };
      delete lk[name];
      this.sel = null;
      this.set({ texts: (L.texts || []).filter((t) => t.id !== id), offsets: o, scales: sc, locks: lk });
      this.app.message('Cuadro de texto eliminado (Ctrl+Z lo recupera)', 3000);
      this.app.panels?.render();
      return;
    }
    const patch = { title: { showTitle: false }, legend: { legend: false }, north: { north: false }, scalebar: { scalebar: false }, scalenum: { scalenum: false }, info: { showInfo: false } }[name];
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
    } else if (this.sel?.startsWith('image:')) {
      const l = this.selectedImage();
      const r0 = l && this.imagePageRect(l);
      if (!r0) return;
      const gs = this.gesture;
      let b = r0;
      if (gs?.mode === 'imove' && gs.delta) b = { ...r0, x: r0.x + gs.delta[0], y: r0.y + gs.delta[1] };
      if (gs?.mode === 'iscale') b = { ...r0, w: r0.w * gs.s, h: r0.h * gs.s };
      add('rect', { x: b.x, y: b.y, width: b.w, height: b.h, fill: 'rgba(14,165,233,.06)', stroke: '#0ea5e9', 'stroke-width': 1.4 * u, 'stroke-dasharray': `${4 * u} ${3 * u}`, 'pointer-events': 'none' });
      const hs = 8 * u;
      add('rect', { x: b.x + b.w - hs / 2, y: b.y + b.h - hs / 2, width: hs, height: hs, fill: '#fff', stroke: '#0ea5e9', 'stroke-width': 1.5 * u, 'data-h': 'isc', class: 'lp-handle' }).style.cursor = 'nwse-resize';
    } else if (this.sel === 'shapes') {
      const b0 = this.vectorBox();
      if (!b0) return;
      const gs = this.gesture;
      let b = b0;
      if (gs?.mode === 'vmove' && gs.delta) b = { ...b0, x: b0.x + gs.delta[0], y: b0.y + gs.delta[1] };
      if (gs?.mode === 'vscale') b = { ...b0, w: b0.w * gs.s, h: b0.h * gs.s };
      const pad = 1.2;
      add('rect', { x: b.x - pad, y: b.y - pad, width: b.w + 2 * pad, height: b.h + 2 * pad, fill: 'rgba(14,165,233,.06)', stroke: '#0ea5e9', 'stroke-width': 1.4 * u, 'stroke-dasharray': `${4 * u} ${3 * u}`, 'pointer-events': 'none' });
      const hs = 8 * u;
      add('rect', { x: b.x + b.w + pad - hs / 2, y: b.y + b.h + pad - hs / 2, width: hs, height: hs, fill: '#fff', stroke: '#0ea5e9', 'stroke-width': 1.5 * u, 'data-h': 'vsc', class: 'lp-handle' }).style.cursor = 'nwse-resize';
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
      const hs = 8 * u;
      const locked = this.isLocked(this.sel);
      // candado: bloquea o libera este elemento (si está bloqueado no se mueve, escala ni borra)
      const lx = b.x - pad;
      const ly = b.y - pad;
      add('circle', { cx: lx, cy: ly, r, fill: locked ? '#0ea5e9' : '#64748b', stroke: '#fff', 'stroke-width': 1.2 * u, 'data-h': 'lock', class: 'lp-handle' }).style.cursor = 'pointer';
      add('rect', { x: lx - r * 0.4, y: ly - r * 0.1, width: r * 0.8, height: r * 0.6, fill: '#fff', 'pointer-events': 'none' });
      add('path', { d: `M${lx - r * 0.24} ${ly - r * 0.1}v${-r * 0.2}a${r * 0.24} ${r * 0.24} 0 0 1 ${r * 0.48} 0${locked ? `v${r * 0.2}` : ''}`, fill: 'none', stroke: '#fff', 'stroke-width': 1.1 * u, 'pointer-events': 'none' });
      if (!locked) {
        add('rect', { x: b.x + b.width + pad - hs / 2, y: b.y + b.height + pad - hs / 2, width: hs, height: hs, fill: '#fff', stroke: '#0ea5e9', 'stroke-width': 1.5 * u, 'data-h': 'sc', class: 'lp-handle' }).style.cursor = 'nwse-resize';
        add('circle', { cx: b.x + b.width + pad, cy: b.y - pad, r, fill: '#ef4444', stroke: '#fff', 'stroke-width': 1.2 * u, 'data-h': 'del', class: 'lp-handle' }).style.cursor = 'pointer';
        add('path', { d: `M${b.x + b.width + pad - r * 0.45} ${b.y - pad - r * 0.45}l${r * 0.9} ${r * 0.9}m0 ${-r * 0.9}l${-r * 0.9} ${r * 0.9}`, stroke: '#fff', 'stroke-width': 1.6 * u, 'stroke-linecap': 'round', 'pointer-events': 'none' });
      }
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

  /**
   * Imágenes raster para el marco, agrupando rasters consecutivas.
   * El resultado se guarda en caché (clave: marco, resolución y capas raster):
   * mover un elemento o exportar de nuevo no recalcula relieve ni teselas.
   */
  async rasters(L, dpi, { signal } = {}) {
    const doc = this.app.history.doc;
    const g = pageGeometry(L);
    const ext = frameExtent(L, g);
    const gisOn = this.app.mode === 'gis';
    const key = JSON.stringify([gisOn, dpi, ext, doc.layers.filter((l) => l.kind !== 'vector').map((l) => [l.id, l.kind, l.visible, l.opacity, l.blend, l.settings])]);
    const hit = this.rasterCache.get(key);
    if (hit) return hit;
    // hasta 9 000 px por lado (A0 a 200 dpi, A3 a 600 dpi)
    const wpx = Math.max(50, Math.min(MAX_RASTER_PX, Math.round((g.fw / 25.4) * dpi)));
    const hpx = Math.max(50, Math.min(MAX_RASTER_PX, Math.round((g.fh / 25.4) * dpi)));
    const v = new View(wpx, hpx);
    v.cx = (ext.minX + ext.maxX) / 2;
    v.cy = (ext.minY + ext.maxY) / 2;
    v.mpp = (ext.maxX - ext.minX) / wpx;
    const out = [];
    const encoding = []; // la codificación (PNG/JPEG) corre en paralelo y sin bloquear la interfaz
    let group = null;
    const flush = () => {
      if (!group) return;
      const item = { index: group.index, href: '', opacity: 1, name: group.names.reverse().join(' + ') };
      out.push(item);
      encoding.push(encodeCanvas(group.canvas, group.opaque).then((href) => (item.href = href)));
      group = null;
    };
    for (let i = 0; i < doc.layers.length; i++) {
      const l = doc.layers[i];
      if (!l.visible || (!gisOn && isGisLayer(l))) continue;
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
        group = { index: i, canvas, ctx: canvas.getContext('2d'), names: [], opaque: true };
      }
      // solo un grupo de mapas base sin transparencia ni fusión se puede guardar como JPEG (mucho más rápido y liviano)
      if (l.kind !== 'basemap' || l.opacity < 1 || (l.blend && l.blend !== 'normal')) group.opaque = false;
      group.names.push(l.name);
      group.ctx.globalAlpha = l.opacity;
      group.ctx.globalCompositeOperation = l.blend && l.blend !== 'normal' ? l.blend : 'source-over';
      group.ctx.drawImage(c, 0, 0, wpx, hpx);
      group.ctx.globalAlpha = 1;
      group.ctx.globalCompositeOperation = 'source-over';
    }
    flush();
    await Promise.all(encoding);
    if (!signal?.aborted) {
      this.rasterCache.set(key, out);
      while (this.rasterCache.size > 3) this.rasterCache.delete(this.rasterCache.keys().next().value);
    }
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
      const img = imageRect(l);
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
      if (!l.visible || (this.app.mode !== 'gis' && isGisLayer(l))) continue;
      if (l.kind === 'basemap') src.add(BASEMAPS[l.settings.source]?.attribution);
      if (l.kind === 'hillshade') src.add(l.settings.source === 'terrarium' ? 'DEM Terrarium/AWS (SRTM, GMTED, ETOPO1)' : l.settings.source === 'opentopo' ? `DEM ${l.settings.demtype} (OpenTopography)` : `DEM ${l.settings.fileName || 'propio'}`);
    }
    return [...src].filter(Boolean).join('; ');
  }

  /**
   * Una región del mundo (rect {x, y, w, h}) compuesta como lámina SIN adornos —sin título, grilla,
   * leyenda ni marco— a la escala de referencia: la base de «Exportar imagen». Las capas raster
   * (mapa base, relieve, imágenes) salen a la resolución `dpi`.
   * @returns {{ svg: string, geometry: { W: number, H: number } }} W, H en mm de papel
   */
  async renderRegion(rect, { dpi, transparent = false, signal } = {}) {
    const doc = this.app.history.doc;
    const W = (rect.w * 1000) / doc.refScale;
    const H = (rect.h * 1000) / doc.refScale;
    const L = {
      ...defaultLayout(doc, this.app.view),
      ...(doc.layout || {}),
      page: 'custom', pageMm: [W, H], margin: 0, title: '', subtitle: '', showTitle: false, grid: 'none', zebra: false,
      north: false, scalebar: false, scalenum: false, legend: false, showInfo: false, texts: [], offsets: {}, scales: {},
      frame: { x: 0, y: 0, w: W, h: H }, scale: doc.refScale, center: [rect.x + rect.w / 2, rect.y + rect.h / 2], symbolScale: 'paper',
    };
    const rasters = await this.rasters(L, dpi, { signal });
    return composeLayout(doc, L, rasters, '', { transparent, bare: true });
  }

  async build(dpi, signal) {
    const L = this.L;
    const rasters = await this.rasters(L, dpi, { signal });
    // en Canvas no hay coordenadas: la lámina sale sin grilla
    return composeLayout(this.app.history.doc, this.app.mode === 'gis' ? L : { ...L, grid: 'none' }, rasters, this.attribution());
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
    if (this.sel && this.sel !== 'frame' && this.sel !== 'shapes' && !this.sel.startsWith('image:') && !this.elementGroup(this.sel)) this.sel = null;
    this.drawOverlay();
    this.app.message('');
    const after = this.afterPreview;
    this.afterPreview = null;
    after?.();
  }

  /* ----------------------------------------------- cuadros de texto del layout */

  startAddText() {
    this.adding = !this.adding;
    this.textBtn?.classList.toggle('on', this.adding);
    this.stage.style.cursor = this.adding ? 'text' : '';
    if (this.adding) this.app.message('Haz clic en la hoja donde va el texto (Esc cancela)', 4000);
  }

  textById(id) {
    return (this.L.texts || []).find((t) => t.id === id);
  }

  /** Cambia un cuadro de texto; `final` falso = vista previa mientras se arrastra un deslizador. */
  updateText(id, patch, final = true) {
    const L = this.L;
    const texts = (L.texts || []).map((t) => (t.id === id ? { ...t, ...patch } : t));
    const doc = this.app.history.doc;
    const next = { ...doc, layout: { ...L, texts } };
    if (final) this.app.history.commit(next);
    else this.app.history.preview(next);
    this.schedule(final ? 0 : 120);
  }

  addText(p) {
    const L = this.L;
    const t = {
      id: newId('lt'),
      x: +p[0].toFixed(1),
      y: +p[1].toFixed(1),
      text: 'Texto',
      fontSize: 10,
      fontFamily: L.fontFamily,
      fontWeight: 400,
      italic: false,
      align: 'left',
      anchor: 'start',
      boxWidth: null,
      lineHeight: 1.2,
      letterSpacing: 0,
      wordSpacing: 0,
      rotation: 0,
      color: '#111827',
      halo: false,
      haloColor: '#ffffff',
      haloWidth: 0.5,
    };
    this.afterPreview = () => {
      this.select(`text:${t.id}`);
      this.editText(t.id, true);
    };
    this.set({ texts: [...(L.texts || []), t] });
  }

  /** Edita el texto sobre la propia hoja (cuadro de edición encima del texto). */
  editText(id, isNew = false) {
    const t = this.textById(id);
    const gEl = this.elementGroup(`text:${id}`);
    if (!t || !gEl) return;
    this.closeEditor?.();
    const r = gEl.getBoundingClientRect();
    const host = this.el.getBoundingClientRect();
    const sr = this.stage.getBoundingClientRect();
    const pxPerMm = sr.width / this.geom.W;
    const fpx = Math.max(13, t.fontSize * 0.352778 * pxPerMm);
    const ed = openRichEditor({
      host: this.el,
      rect: { left: Math.max(4, r.left - host.left - 6), top: Math.max(4, r.top - host.top - 6 + 44), width: Math.max(260, r.width + 24, t.boxWidth ? t.boxWidth * pxPerMm + 16 : 0) },
      shape: layoutTextShape(t),
      fontPx: fpx,
      color: t.color || '#111827',
      isNew,
      onDone: (res) => {
        this.closeEditor = null;
        if ((!res && isNew) || (res && !res.text.trim())) return this.deleteElement(`text:${id}`);
        if (!res) return;
        if (res.text !== t.text || JSON.stringify(res.runs) !== JSON.stringify(t.runs || [])) this.updateText(id, { text: res.text, runs: res.runs.length ? res.runs : undefined });
      },
    });
    this.closeEditor = () => ed.close(true);
  }

  /**
   * Convierte un cuadro de texto del layout en un texto del mapa, en una capa
   * vectorial, en la coordenada del terreno que queda bajo él. El tamaño se
   * deshace del factor de símbolos del layout, así a esa escala se ve igual.
   */
  textToLayer(id, layerId, remove) {
    const doc = this.app.history.doc;
    const layer = doc.layers.find((l) => l.id === layerId);
    const t = this.textById(id);
    if (!layer || layer.kind !== 'vector' || !t) return this.app.message('Elige una capa vectorial');
    if (layer.locked) return this.app.message(`La capa «${layer.name}» está bloqueada`);
    const L = this.L;
    const g = this.geom;
    const off = L.offsets?.[`text:${id}`] || [0, 0];
    const [gx, gy] = pageToGround(L, g, t.x + off[0], t.y + off[1]);
    const f = symbolFactor(doc.refScale, L);
    const shape = makeText(gx, gy, t.text || '', { ...defaultStyle(), fill: t.color || '#111827', fillOpacity: 1, fillType: 'solid', stroke: 'none' }, +(t.fontSize / f).toFixed(2));
    Object.assign(shape, {
      fontFamily: t.fontFamily,
      fontWeight: t.fontWeight || 400,
      italic: !!t.italic,
      align: t.align,
      anchor: t.anchor || 'start',
      boxWidth: t.boxWidth ? +(t.boxWidth / f).toFixed(2) : null,
      lineHeight: t.lineHeight,
      letterSpacing: t.letterSpacing,
      wordSpacing: t.wordSpacing,
      runs: t.runs,
      rotation: t.rotation || 0,
      halo: !!t.halo,
      haloColor: t.haloColor || '#ffffff',
      haloWidth: (t.haloWidth ?? 0.5) / f,
      name: String(t.text || 'Texto').split('\n')[0].slice(0, 40),
    });
    let next = addShapes(doc, layerId, [shape]);
    if (remove) {
      const o = { ...(L.offsets || {}) };
      delete o[`text:${id}`];
      next = { ...next, layout: { ...L, texts: (L.texts || []).filter((x) => x.id !== id), offsets: o } };
      this.sel = null;
    }
    this.app.history.commit(next);
    this.schedule(0);
    this.app.message(`Texto añadido a la capa «${layer.name}»${remove ? ' y quitado del layout' : ''}`, 4000);
  }

  /* --------------------------------------------------- estilos de layout */

  stylesSection() {
    const L = this.L;
    const list = listStyles();
    const names = Object.fromEntries(list.map((s) => [s.name, s.name]));
    this.styleChoice = this.styleChoice && names[this.styleChoice] ? this.styleChoice : list[0]?.name || '';
    return sec(
      'Estilos de layout',
      list.length ? row('Estilo', select({ ...names }, this.styleChoice, (v) => (this.styleChoice = v))) : h('p', { class: 'hint' }, 'Aún no hay estilos guardados.'),
      h(
        'div',
        { class: 'grid-btns two' },
        btn('Guardar como estilo…', async () => {
          const name = await askText('Guardar estilo de layout', this.styleChoice || 'Mi estilo', {
            label: 'Nombre del estilo',
            hint: 'Guarda la página, la grilla, los elementos y su posición, el marco, el tamaño de símbolos y los cuadros de texto.',
            validate: (v) => (v ? '' : 'Escribe un nombre.'),
            preview: (v) => (names[v] ? `Reemplazará el estilo «${v}».` : ''),
          });
          if (!name) return;
          try {
            saveStyle(name, L);
            this.styleChoice = name.trim();
            this.app.message(`Estilo «${name.trim()}» guardado`, 3000);
            this.app.panels.render();
          } catch (e) {
            this.app.message(e.message, 5000);
          }
        }, 'primary'),
        list.length ? btn('Aplicar', () => this.applyNamedStyle(this.styleChoice)) : null,
      ),
      list.length
        ? h(
            'div',
            { class: 'grid-btns three' },
            btn('Borrar', async () => {
              if (!(await askConfirm(`Se borrará el estilo «${this.styleChoice}» de este navegador.`, { title: 'Borrar estilo de layout', ok: 'Borrar', danger: true }))) return;
              deleteStyle(this.styleChoice);
              this.app.panels.render();
            }, 'danger'),
            btn('Exportar…', () => {
              const st = getStyle(this.styleChoice);
              if (st) download(styleFile(this.styleChoice, st), `${this.styleChoice.replace(/[^\w-]+/g, '_')}.gdlayout.json`, 'application/json');
            }),
            btn('Importar…', () => this.importStyleFile()),
          )
        : btn('Importar estilo…', () => this.importStyleFile()),
      h('p', { class: 'hint' }, 'Un estilo guarda la página, la grilla, los elementos y su posición, el marco, el tamaño de símbolos y los cuadros de texto. No guarda la escala, el centro ni el título, autor, fecha y notas del mapa.'),
    );
  }

  applyNamedStyle(name) {
    const st = getStyle(name);
    if (!st) return;
    const L = this.L;
    // el marco guardado cambia el terreno visible: el centro se conserva (el mapa no se mueve)
    this.app.history.commit({ ...this.app.history.doc, layout: applyStyle(L, st) });
    this.schedule(0);
    this.app.message(`Estilo «${name}» aplicado`, 3000);
  }

  async importStyleFile() {
    const { pickFiles } = await import('../io/store.js');
    const [f] = await pickFiles('.json');
    if (!f) return;
    try {
      const items = parseStyleFile(await f.text());
      importStyles(items);
      this.styleChoice = items[0].name;
      this.app.message(`${items.length} estilo(s) importado(s)`, 3000);
      this.app.panels.render();
    } catch (e) {
      this.app.message(e.message, 6000);
    }
  }

  /** Controles del cuadro de texto seleccionado, con «Añadir a capa». */
  textSection() {
    const id = this.sel?.slice(5);
    const t = this.textById(id);
    if (!t) return null;
    const set = (patch, final = true) => this.updateText(id, patch, final);
    const a = ((t.rotation || 0) * Math.PI) / 180;
    const moveLocal = (dmm) => ({ x: +(t.x + dmm * Math.cos(a)).toFixed(2), y: +(t.y + dmm * Math.sin(a)).toFixed(2) });
    const doc = this.app.history.doc;
    const vectors = doc.layers.filter((l) => l.kind === 'vector' && !l.locked);
    this.targetLayer = vectors.find((l) => l.id === this.targetLayer)?.id || (vectors.find((l) => l.id === doc.activeLayerId) || vectors[0])?.id || '';
    const del = btn('Eliminar cuadro de texto', () => this.deleteElement(this.sel), 'danger');
    return sec(
      'Cuadro de texto del layout',
      h('p', { class: 'hint' }, 'Doble clic en la hoja para escribir sobre el texto. Se mueve arrastrándolo.'),
      ...this.app.panels.textControls({ ...t, name: undefined }, set, { color: [t.color || '#111827', (v, final) => set({ color: v }, final)], moveLocal }),
      vectors.length
        ? sec(
            'Añadir a una capa del mapa',
            row('Capa', select(Object.fromEntries(vectors.map((l) => [l.id, l.name])), this.targetLayer, (v) => (this.targetLayer = v))),
            h('div', { class: 'grid-btns two' }, btn('Añadir copia', () => this.textToLayer(id, this.targetLayer, false)), btn('Pasar a la capa', () => this.textToLayer(id, this.targetLayer, true), 'primary')),
            h('p', { class: 'hint' }, 'El texto pasa al mapa en la coordenada del terreno que queda bajo él, con el tamaño que lo deja igual en esta escala. «Pasar» lo quita del layout.'),
          )
        : h('p', { class: 'hint' }, 'No hay capas vectoriales desbloqueadas donde añadirlo.'),
      del,
    );
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
      L.symbolScale === 'custom' ? row('Factor ×', num(L.symbolFactor, (v) => v > 0 && this.set({ symbolFactor: v }), { step: 0.05, min: 0.05, slide: [0.1, 5], log: true })) : null,
      h(
        'p',
        { class: 'hint' },
        `Dibujo a 1:${fmt(ref)}, lámina a 1:${fmt(L.scale)}: grosores, ornamentos, tramas y textos al ${Math.round(f * 100)} % de su tamaño en el estilo. «Automático» toma el punto medio entre dejarlos fijos en papel y escalarlos con el mapa, para que el cambio de escala no sea brusco.`,
      ),
      ref !== L.scale
        ? btn(`Usar 1:${fmt(L.scale)} como escala de referencia del dibujo`, async () => {
            if (!(await askConfirm(`La escala de referencia del dibujo pasa de 1:${fmt(ref)} a 1:${fmt(L.scale)}: los grosores y textos en pantalla pasarán a medirse a esa escala.`, { title: 'Cambiar escala de referencia', ok: 'Cambiar' }))) return;
            this.app.history.commit({ ...this.app.history.doc, refScale: L.scale });
            this.schedule(0);
          })
        : null,
    );
  }

  /* ---------------------------------------------------------------- panel */

  panel() {
    const L = this.L;
    const g0 = pageGeometry(L);
    const set = (k) => (v) => this.set({ [k]: v });
    const v = this.app.view;
    return [
      this.sel?.startsWith('text:') ? this.textSection() : null,
      this.stylesSection(),
      sec(
        'Página',
        row('Tamaño', select(Object.keys(PAGES), L.page, set('page'))),
        row('Orientación', select({ landscape: 'Horizontal', portrait: 'Vertical' }, L.orientation, set('orientation'))),
        row('Margen (mm)', num(L.margin, set('margin'), { step: 1, min: 0, slide: [0, 40] })),
      ),
      sec(
        'Mapa',
        row('Escala 1:', num(L.scale, set('scale'), { step: 1000, min: 100, slide: [1000, 2e6], log: true })),
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
        ...(this.app.mode !== 'gis' ? [h('p', { class: 'hint' }, 'La grilla de coordenadas es del modo GIS: cambia a GIS (botón arriba) para usarla.')] : [
        row('Grilla', select({ none: 'Sin grilla', utm: 'UTM (m)', geo: 'Geográfica (° \' ")', both: 'UTM + geográfica' }, L.grid, set('grid'))),
        row('Estilo', select({ crosses: 'Cruces', lines: 'Líneas', ticks: 'Solo marcas en el borde' }, L.gridStyle, set('gridStyle'))),
        row('Intervalo UTM (m)', num(L.gridInterval || '', set('gridInterval'), { step: 500, min: 0 })),
        row('Intervalo geo (min)', num(L.geoInterval || '', set('geoInterval'), { step: 1, min: 0 })),
        h('p', { class: 'hint' }, 'Intervalos vacíos o 0 = automáticos.'),
        row('Color', color(L.gridColor, null, set('gridColor'))),
        row('Rótulos (pt)', num(L.gridLabelSize, set('gridLabelSize'), { step: 0.5, min: 3, slide: [3, 24] })),
        check('Borde de cebra', L.zebra, set('zebra')),
        ]),
      ),
      sec(
        'Elementos',
        row('Título', text(L.title, set('title'))),
        row('Subtítulo', text(L.subtitle, set('subtitle'))),
        row('Autor', text(L.author, set('author'))),
        row('Fecha', text(L.date, set('date'))),
        row('Notas', text(L.notes, set('notes'))),
        check('Bloquear posición y tamaño de todos los elementos', !!L.lockAll, set('lockAll')),
        this.sel && !this.sel.startsWith('image:') && this.sel !== 'frame' && this.sel !== 'shapes' ? check(`Bloquear solo el elemento seleccionado (${this.sel.startsWith('text:') ? 'texto' : this.sel})`, !!L.locks?.[this.sel], () => this.toggleLock(this.sel)) : null,
        h('p', { class: 'hint' }, 'Un elemento bloqueado no se mueve al arrastrar (el clic sobre él dentro del marco arrastra el mapa). El candado de su caja de selección también lo bloquea o libera.'),
        check('Título', L.showTitle !== false, set('showTitle')),
        check('Datos (autor, fecha, sistema, notas, fuentes)', L.showInfo !== false, set('showInfo')),
        check('Norte (verdadero, con convergencia)', L.north, set('north')),
        check('Escala gráfica (barra)', L.scalebar, set('scalebar')),
        L.scalebar ? check('Fondo sólido bajo la escala gráfica', L.scalebarBg ?? !g0.side, set('scalebarBg')) : null,
        check('Escala numérica (1:…)', L.scalenum ?? L.scalebar, set('scalenum')),
        L.scalenum ?? L.scalebar ? check('Fondo sólido bajo la escala numérica', L.scalenumBg ?? !g0.side, set('scalenumBg')) : null,
        row('Color del fondo', color(L.scaleBgColor || '#ffffff', null, set('scaleBgColor'))),
        h('p', { class: 'hint' }, 'La escala gráfica y la numérica son dos elementos independientes: se mueven y escalan por separado.'),
        check('Leyenda (columna lateral)', L.legend, set('legend')),
        L.legend ? row('Ancho columna (mm)', num(L.legendWidth, set('legendWidth'), { step: 2, min: 40, slide: [40, 200] })) : null,
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
    ].filter(Boolean);
  }
}
