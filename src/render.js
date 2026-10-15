/**
 * La pila de capas en pantalla.
 *
 * Cada capa es un elemento propio dentro de #stage —<svg> las vectoriales,
 * <canvas> las raster— apilados en el orden del documento. Así la opacidad y
 * el MODO DE FUSIÓN de una capa (multiplicar, trama, superponer…) son CSS
 * puro (`mix-blend-mode`) y se componen contra todo lo que hay debajo, igual
 * que en un programa de dibujo: un relieve en "multiplicar" oscurece el mapa
 * base y los polígonos geológicos sin tocar sus colores.
 *
 * Arriba de todo van las etiquetas (una sola capa: las de todas las capas
 * compiten por el espacio) y la capa de interacción del editor.
 */

import { renderLabels } from './labels.js';
import { shapeToSvg } from './style.js';
import { paperUnits } from './view.js';

export class StageRenderer {
  constructor({ stage, view, raster, getDoc, editor }) {
    this.stage = stage;
    this.view = view;
    this.raster = raster;
    this.getDoc = getDoc;
    this.editor = editor;
    this.vectorEls = new Map();
    this.labelsEl = svgEl('labels-svg');
    this.overlayEl = svgEl('overlay-svg');
    this.pending = false;
    this.lastLayersSig = '';
    this.vectorCache = new Map(); // layerId -> {layer, viewKey}
  }

  request(opts = {}) {
    this.settled = this.settled || !!opts.settled;
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      const settled = this.settled;
      this.settled = false;
      this.render({ settled });
    });
  }

  ctxFor(uid) {
    const u = paperUnits(this.view, this.getDoc().refScale);
    return {
      P: (x, y) => this.view.toScreen(x, y),
      mmToPx: u.mmToPx,
      ptToPx: u.ptToPx,
      viewW: this.view.w,
      viewH: this.view.h,
      mpp: this.view.mpp,
      scale: this.view.scale,
      defs: [],
      uid,
    };
  }

  render({ settled = false } = {}) {
    const doc = this.getDoc();
    const v = this.view;
    const viewKey = `${v.cx}|${v.cy}|${v.mpp}|${v.w}|${v.h}|${doc.refScale}`;

    // reconstruir el orden de elementos si cambió la lista de capas
    const sig = doc.layers.map((l) => `${l.id}:${l.kind}`).join(',');
    if (sig !== this.lastLayersSig) {
      this.lastLayersSig = sig;
      const keep = new Set(doc.layers.map((l) => l.id));
      for (const [id] of this.vectorEls) if (!keep.has(id)) this.vectorEls.delete(id);
      for (const id of [...this.raster.state.keys()]) if (!keep.has(id)) this.raster.forget(id);
      const els = doc.layers.map((l) => (l.kind === 'vector' ? this.vectorEl(l) : this.raster.element(l)));
      this.stage.replaceChildren(...els, this.labelsEl, this.overlayEl);
      this.vectorCache.clear();
    }

    for (const l of doc.layers) {
      if (l.kind === 'vector') {
        const el = this.vectorEl(l);
        el.style.display = l.visible ? '' : 'none';
        el.style.opacity = l.opacity;
        el.style.mixBlendMode = l.blend || 'normal';
        const cached = this.vectorCache.get(l.id);
        if (l.visible && (!cached || cached.layer !== l || cached.viewKey !== viewKey)) {
          const ctx = this.ctxFor(`${l.id}_`);
          const ext = v.extent(Math.max(v.w, v.h));
          const body = l.items.map((s) => (visibleIn(s, ext) ? shapeToSvg(s, ctx) : '')).join('');
          el.innerHTML = `<defs>${ctx.defs.join('')}</defs>${body}`;
          this.vectorCache.set(l.id, { layer: l, viewKey });
        }
      } else {
        this.raster.draw(l, { settled });
      }
    }

    const vectors = doc.layers.filter((l) => l.kind === 'vector');
    const labelKey = `${viewKey}|${vectors.map((l) => l.items.length).join(',')}`;
    if (labelKey !== this.lastLabelKey || vectors !== this.lastLabelLayers || this.labelsDirty || !sameRefs(vectors, this.lastLabelLayers)) {
      this.labelsEl.innerHTML = renderLabels(vectors, this.ctxFor('lbl_'));
      this.lastLabelKey = labelKey;
      this.lastLabelLayers = vectors;
      this.labelsDirty = false;
    }
    this.overlayEl.innerHTML = this.editor ? this.editor.overlay() : '';
  }

  vectorEl(layer) {
    let el = this.vectorEls.get(layer.id);
    if (!el) {
      el = svgEl('layer-svg');
      el.dataset.layer = layer.id;
      this.vectorEls.set(layer.id, el);
    }
    return el;
  }
}

function svgEl(cls) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('class', cls);
  return el;
}

function sameRefs(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const bboxCache = new WeakMap();
function visibleIn(shape, ext) {
  let b = bboxCache.get(shape);
  if (!b) {
    b = roughBox(shape);
    bboxCache.set(shape, b);
  }
  if (!b) return true;
  return !(b[0] > ext.maxX || b[2] < ext.minX || b[1] > ext.maxY || b[3] < ext.minY);
}

function roughBox(s) {
  if (s.type === 'text' || s.type === 'point') return null; // tamaño en papel: siempre
  if (s.type === 'group') return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const add = (p) => {
    if (!p) return;
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  };
  for (const n of s.nodes || []) {
    add(n);
    add(n.hIn);
    add(n.hOut);
  }
  return x0 === Infinity ? null : [x0, y0, x1, y1];
}
