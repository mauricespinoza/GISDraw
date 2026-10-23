/**
 * GISDrawer: arranque y pegamento entre documento, vista, editor, capas raster,
 * paneles y archivos.
 */

import { openRichEditor } from './ui/richEditor.js';
import { History, addLayer, addShapes, findLayer, findTopShape, layerOfShape, makeRasterLayer, makeVectorLayer, mapShapes, newDocument, normalizeDoc, updateLayer, allTopShapes } from './doc.js';
import { View, paperUnits } from './view.js';
import { Editor, TOOLS } from './editor.js';
import { StageRenderer } from './render.js';
import { RasterView, demFiles, imageFiles, imageRect } from './raster/rasterView.js';
import { BASEMAPS } from './raster/basemap.js';
import { Panels } from './ui/panels.js';
import { LayoutEditor } from './ui/layoutEditor.js';
import { ALIGN_ICONS, ICONS } from './ui/icons.js';
import { h, popSlider, popSliderOpen } from './ui/dom.js';
import { askChoice, askConfirm, askForm, askText } from './ui/dialog.js';
import { DASHES, defaultStyle } from './style.js';
import { align, copyShapes, deleteEmpty, distribute, frozenPoints, pasteShapes, arrange, group, ungroup, ungroupAll, joinPaths, splitPath, setShapeFlag, resetShapeFlag, selectSame, transformShapes } from './ops.js';
import { coordPreview, formatDMS, parseCoordText, toLonLat } from './proj.js';
import { shapeBBox, unionBBox, walkShapes, newId, DEFAULT_SMOOTH, canResmooth, canSmooth, adoptFreehand, resmooth } from './vector.js';
import { saveDoc, loadDoc, saveFile, loadFile, download, pickFiles, getDocKey, putDocKey } from './io/store.js';
import { parseQML, styleFor } from './io/qml.js';
import { parseAsciiGrid } from './raster/dem.js';
import { lonLatToTransform, proj4Def } from './io/crs.js';
import { selectionSvg } from './io/illustrator.js';
import { assetMeta, packProject, referencedFiles, unpackFiles } from './io/project.js';
import { forgetRecent, hasContent, listRecent, loadRecent, rememberProject } from './io/recent.js';
import { buildTopology, simplifyArc, smoothArcLevel, smoothTopology } from './smoothTopo.js';
import { tidyShapes } from './tidy.js';
import { APP_VERSION, APP_AUTHOR, CHANGELOG } from './version.js';
import { CANVAS_MIN_MM, CANVAS_TABS, GIS_TABS, MODES, canvasCovering, canvasDefaults, canvasFromMm, canvasMm, canvasRect, modeOf, normalizeCanvas } from './mode.js';

const SETTINGS_KEY = 'gd.settings';

const makeCanvas = (w, h) => {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};
const canvasBlob = (c) => (c.convertToBlob ? c.convertToBlob({ type: 'image/png' }) : new Promise((r) => c.toBlob(r, 'image/png')));

/**
 * Lee el .ai / PDF en un hilo aparte (la interfaz sigue viva mientras tanto).
 * Si el navegador no puede crear el hilo, se lee aquí mismo.
 */
async function importPdfOffThread(buf, opts) {
  let worker = null;
  try {
    worker = await new Promise((resolve, reject) => {
      const w = new Worker(new URL('./io/importWorker.js', import.meta.url), { type: 'module' });
      w.onerror = (e) => {
        e.preventDefault?.();
        w.terminate();
        reject(new Error('worker'));
      };
      w.postMessage({ buf: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), opts });
      w.onmessage = (e) => resolve({ w, data: e.data });
    });
  } catch {
    worker = null;
  }
  if (worker) {
    worker.w.terminate();
    if (!worker.data.ok) throw new Error(worker.data.error);
    const { unpackLayers } = await import('./io/transport.js');
    return { ...worker.data.result, layers: unpackLayers(worker.data.result.layers) };
  }
  const { importPdf } = await import('./io/pdfImport.js');
  return importPdf(buf, opts);
}

/**
 * Imagen de un PDF / .ai (píxeles o JPEG, con su alfa) → imagen alineada a
 * los ejes, ya girada o volteada como en la página, en PNG para guardarla.
 */
async function rasterizePdfImage(im) {  // → { bitmap, blob: Promise<Blob> }
  const { px, T, box } = im;
  const src = makeCanvas(px.w, px.h);
  const sctx = src.getContext('2d');
  if (px.rgba) sctx.putImageData(new ImageData(px.rgba, px.w, px.h), 0, 0);
  else {
    const bmp = await createImageBitmap(new Blob([px.jpeg], { type: 'image/jpeg' }));
    sctx.drawImage(bmp, 0, 0, px.w, px.h);
    if (px.alpha) {
      const id = sctx.getImageData(0, 0, px.w, px.h);
      for (let i = 0, k = 3; i < px.alpha.length; i++, k += 4) id.data[k] = px.alpha[i];
      sctx.putImageData(id, 0, 0);
    }
  }
  // misma cantidad de píxeles que la original, hasta 8192 de lado
  const bw = box[2] - box[0];
  const bh = box[3] - box[1];
  let ppu = Math.sqrt((px.w * px.h) / (im.area || bw * bh || 1));
  ppu = Math.min(ppu, 8192 / Math.max(bw, bh, 1e-9));
  const W = Math.max(1, Math.round(bw * ppu));
  const H = Math.max(1, Math.round(bh * ppu));
  // imagen sin girar, volteada ni transparente, de su tamaño: no hace falta volver a dibujarla
  const plain = (im.opacity ?? 1) === 1 && Math.abs(T[1]) < 1e-9 && Math.abs(T[2]) < 1e-9 && T[0] > 0 && T[3] > 0 && Math.abs(W - px.w) <= 1 && Math.abs(H - px.h) <= 1;
  let out = src;
  if (!plain) {
    out = makeCanvas(W, H);
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.globalAlpha = im.opacity ?? 1;
    ctx.setTransform(T[0] * ppu, T[1] * ppu, T[2] * ppu, T[3] * ppu, T[4] * ppu, T[5] * ppu);
    ctx.drawImage(src, 0, 0);
  }
  return { bitmap: await createImageBitmap(out), blob: canvasBlob(out) };
}

class App {
  constructor() {
    this.settings = {
      snap: true,
      trace: false,
      moveJoined: true,
      guides: true, // snap ligero a guías de alineación
      smoothLevel: 50, // intensidad del pincel de Suavizar (%)
      smoothRadius: 18, // radio del pincel de Suavizar (px)
      deformRadius: 60, // radio de influencia de Deform (px)
      dragReach: 100, // alcance de Drag a lo largo del trazo (%: 100 = hasta los extremos)
      gestureTaps: 'double', // dos dedos = deshacer, tres = rehacer: 'double' (dos toques) o 'single'
      fingerDraws: false,
      pencilSmooth: DEFAULT_SMOOTH, // % de suavizado del lápiz (trazo libre)
      opentopoKey: '',
      mode: 'canvas',
      googleClientId: '',
      googleApiKey: '',
      wheelMode: 'zoom',
      ...readJSON(SETTINGS_KEY),
    };
    this.currentStyle = { ...defaultStyle(), ...readJSON('gd.style') };
    this.history = new History(newDocument());
    this.view = new View();
    this.viewport = document.getElementById('viewport');
    this.raster = new RasterView(this.view, () => this.settings);
    this.editor = new Editor({
      history: this.history,
      view: this.view,
      host: document.getElementById('input-host'),
      settings: this.settings,
      getCurrentStyle: () => this.currentStyle,
      onChange: () => this.onEditorChange(),
      onMessage: (m) => this.message(m),
      onEditText: (t, isNew) => this.editText(t, isNew),
    });
    this.editor.onCommandKey = (e) => this.commandKey(e);
    this.editor.onPlainKey = (e) => this.plainKey(e);
    this.editor.onCutLine = (c) => this.runCutLine(c).catch((err) => this.message(`Error: ${err.message}`, 6000));
    this.editor.onCutTouch = (c) => this.runCutTouch(c).catch((err) => this.message(`Error: ${err.message}`, 6000));
    this.editor.onRadius = (key, v) => {
      this.saveSettings({ [key]: v });
      this.renderPropbar();
      this.message(`Radio: ${v} px`, 900);
    };
    this.editor.onContextMenu = (sp, info) => this.showContextMenu(sp, info);
    this.editor.onPointerStart = () => this.hideContextMenu();
    this.editor.onCut = (mode, pts) => this.runCut(mode, pts);
    this.swatchFront = 'stroke';
    this.editor.onStylePicked = (st) => {
      if (!this.editor.selection.size) this.setCurrentStyle(st);
    };
    this.renderer = new StageRenderer({
      stage: document.getElementById('stage'),
      view: this.view,
      raster: this.raster,
      getDoc: () => this.history.doc,
      editor: this.editor,
    });
    this.raster.onNeedRedraw = () => this.renderer.request();
    this.raster.onStatus = (_, msg) => this.message(msg, msg ? 0 : 1);
    this.raster.onStaleChange = () => this.updateRedraw();
    this.raster.onRendered = () => {
      if (this.panels.tab === 'relief') this.panels.render();
    };
    this.layout = new LayoutEditor(this);
    this.panels = new Panels(this);
    this.panels.onShow = (tab) => {
      this.updatePage();
      return tab === 'layout' ? this.layout.show() : this.layout.hide();
    };
    this.clipboard = [];

    this.history.onChange((doc, meta) => this.onDocChange(doc, meta));
    this.view.onChange(() => this.onViewChange());

    this.buildToolbar();
    this.buildTopbar();
    this.buildContextMenu();
    this.setupTooltips();
    this.setupClipboard();
    this.observeSize();
    this.applyMode();
    this.restore();
  }

  /* ------------------------------------------------------------- estado */

  saveSettings(patch) {
    Object.assign(this.settings, patch);
    writeJSON(SETTINGS_KEY, this.settings);
    this.syncToggles();
  }

  /**
   * `render: false` durante un arrastre de deslizador o del selector de color:
   * reconstruir el panel en ese momento destruiría el control en uso (el
   * selector de color se cerraba al primer movimiento).
   */
  setCurrentStyle(st, { render = true } = {}) {
    this.currentStyle = { ...defaultStyle(), ...st };
    writeJSON('gd.style', this.currentStyle);
    this.updateSwatch();
    if (!render) return;
    if (['style', 'geology', 'canvas'].includes(this.panels.tab)) this.panels.render();
    this.renderPropbar();
  }

  layerOf(id) {
    return layerOfShape(this.history.doc, id);
  }

  onDocChange(doc, meta = {}) {
    if (!meta.preview) this.editor.pruneSelection();
    this.editor.snapDirty = true;
    this.renderer.request();
    this.updateRedraw();
    this.updatePage();
    if (!meta.preview) {
      if (!this.layout.el.hidden) this.layout.schedule();
      this.panels.render();
      this.renderPropbar();
      this.updateUndo();
      this.updateAttribution();
      this.scheduleSave();
    }
  }

  onEditorChange() {
    this.renderer.request();
    this.syncToggles();
    this.updateContextBar();
    if (this.lastTool !== this.editor.tool) {
      this.lastTool = this.editor.tool;
      for (const b of this.toolbarEl.querySelectorAll('button[data-tool]')) b.classList.toggle('on', b.dataset.tool === this.editor.tool);
    }
    const sig = `${[...this.editor.selection].join(',')}|${this.editor.tool}`;
    if (sig !== this.lastSelSig) {
      this.lastSelSig = sig;
      // en celulares la barra de propiedades solo aparece con algo seleccionado
      document.getElementById('app').classList.toggle('has-sel', this.editor.selection.size > 0);
      if (['layers', 'style', 'geology', 'attrs', 'arrange'].includes(this.panels.tab)) this.panels.render();
      this.renderPropbar();
    }
    this.updateSwatch();
    if (this.editor.hover?.wp) this.updateCoords(this.editor.hover.wp);
  }

  /** Botón «Redraw»: visible si hay relieve; resaltado cuando la imagen en caché ya no cubre la vista. */
  updateRedraw() {
    const b = document.getElementById('btn-redraw');
    if (!b) return;
    const st = this.raster.hillshadeStale(this.history.doc.layers);
    b.hidden = st === null;
    b.classList.toggle('stale', st === true);
  }

  onViewChange() {
    this.renderer.request();
    this.updateRedraw();
    this.updateScaleBox();
    this.updatePage();
    clearTimeout(this.viewSaveT);
    this.viewSaveT = setTimeout(() => writeJSON('gd.view', { cx: this.view.cx, cy: this.view.cy, mpp: this.view.mpp }), 400);
  }

  /** Escala 1:N en GIS; zoom en % en Canvas (100 % = la hoja a su tamaño real en pantalla). */
  updateScaleBox() {
    if (!this.scaleInput || document.activeElement === this.scaleInput) return;
    const canvas = this.mode !== 'gis';
    const n = this.history.doc.refScale;
    this.scaleInput.value = canvas ? String(Math.round((n / this.view.scale) * 100)) : Math.round(this.view.scale).toLocaleString('es-CL');
    const label = document.getElementById('scale-label');
    if (label) label.textContent = canvas ? 'Zoom' : '1:';
    const unit = document.getElementById('scale-unit');
    if (unit) unit.textContent = canvas ? '%' : '';
  }

  /** Hoja del lienzo (solo en Canvas): un rectángulo blanco que sigue a la vista. */
  updatePage() {
    const el = document.getElementById('page');
    if (!el) return;
    el.hidden = this.mode === 'gis';
    if (el.hidden) return;
    const r = canvasRect(this.history.doc);
    const [x0, y0] = this.view.toScreen(r.x, r.y + r.h);
    const [x1, y1] = this.view.toScreen(r.x + r.w, r.y);
    Object.assign(el.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    this.updatePageHandles([x0, y0, x1, y1]);
  }

  /**
   * Tiradores de la hoja personalizada: 4 vértices y 4 bordes. Solo con la hoja en «Personalizado»
   * y la pestaña Lienzo a la vista (así no estorban al dibujar).
   */
  updatePageHandles([x0, y0, x1, y1]) {
    const host = document.getElementById('page-edit');
    if (!host) return;
    const on = this.mode !== 'gis' && this.history.doc.canvas?.size === 'custom' && this.panels?.tab === 'canvas' && !document.getElementById('app').classList.contains('panel-hidden');
    host.hidden = !on;
    if (!on) return;
    if (!host.firstChild) {
      host.append(h('div', { class: 'pe-frame' }));
      for (const k of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
        const hd = h('div', { class: `pe-h ${k}${k.length === 1 ? ' edge' : ''}`, 'data-h': k });
        hd.addEventListener('pointerdown', (e) => this.pageHandleDown(e, k));
        host.append(hd);
      }
    }
    const mx = (x0 + x1) / 2;
    const my = (y0 + y1) / 2;
    const at = { nw: [x0, y0], n: [mx, y0], ne: [x1, y0], e: [x1, my], se: [x1, y1], s: [mx, y1], sw: [x0, y1], w: [x0, my] };
    Object.assign(host.firstChild.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` });
    for (const hd of host.querySelectorAll('.pe-h')) {
      const [x, y] = at[hd.dataset.h];
      hd.style.left = `${x}px`;
      hd.style.top = `${y}px`;
    }
  }

  /** Arrastre de un tirador: el lado u esquina opuesta queda fija; las medidas se redondean al mm. */
  pageHandleDown(e, k) {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    el.setPointerCapture?.(e.pointerId);
    const doc0 = this.history.doc;
    const r = canvasRect(doc0);
    const m = doc0.refScale / 1000; // metros de terreno por mm de papel
    const vr = this.viewport.getBoundingClientRect();
    this.history.begin();
    const move = (ev) => {
      const [wx, wy] = this.view.toWorld(ev.clientX - vr.left, ev.clientY - vr.top);
      let { x, y, w, h } = r;
      const size = (v) => Math.max(CANVAS_MIN_MM, Math.round(v / m)) * m;
      if (k.includes('w')) {
        w = size(r.x + r.w - wx);
        x = r.x + r.w - w;
      } else if (k.includes('e')) w = size(wx - r.x);
      if (k.includes('n')) h = size(wy - r.y); // norte: y hacia arriba
      else if (k.includes('s')) {
        h = size(r.y + r.h - wy);
        y = r.y + r.h - h;
      }
      this.history.preview({ ...this.history.doc, canvas: normalizeCanvas({ ...doc0.canvas, ...canvasCovering({ x, y, w, h }, doc0.refScale) }) });
    };
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      this.history.end(); // un solo paso de deshacer; guarda y refresca el panel
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  /** Encajar a objetos: la hoja pasa a ser exactamente la caja de lo dibujado (capas visibles). */
  fitCanvasToObjects() {
    const doc = this.history.doc;
    const box = unionBBox(allTopShapes(doc).map((x) => shapeBBox(x.shape, this.editor.est())));
    if (!box || !(box.w >= 0)) return this.message('No hay objetos dibujados (en capas visibles) a los que encajar la hoja');
    this.setCanvas(canvasCovering(box, doc.refScale), { defaults: false });
    const [w, h] = canvasMm(this.history.doc.canvas);
    this.message(`Hoja encajada a los objetos: ${w.toFixed(1)} × ${h.toFixed(1)} mm${w <= CANVAS_MIN_MM || h <= CANVAS_MIN_MM ? ` (mínimo ${CANVAS_MIN_MM} mm)` : ''}`);
  }

  /** Encuadra la hoja entera en la vista. */
  fitCanvas() {
    const r = canvasRect(this.history.doc);
    this.view.fit({ x: r.x, y: r.y, w: r.w, h: r.h }, 64); // deja libre la barra de propiedades de arriba
  }

  /**
   * Cambia la hoja del lienzo (tamaño, orientación) y ajusta el grosor de
   * trazo y la letra por defecto a una figura de media hoja.
   */
  setCanvas(patch, { fit = true, defaults = true } = {}) {
    const doc = this.history.doc;
    const canvas = normalizeCanvas({ ...doc.canvas, ...patch });
    this.history.commit({ ...doc, canvas });
    // el layout de impresión sigue a la hoja (si es una de sus hojas)
    if (doc.layout && ['A4', 'A3', 'A2', 'A1', 'A0', 'Carta'].includes(canvas.size)) {
      this.history.silent({ ...this.history.doc, layout: { ...doc.layout, page: canvas.size, orientation: canvas.orientation } });
    }
    if (defaults) this.applyCanvasDefaults();
    if (fit) this.fitCanvas();
    this.updatePage();
  }

  /** Grosor de trazo y letra por defecto de esta hoja (media página). */
  applyCanvasDefaults() {
    const d = canvasDefaults(this.history.doc.canvas);
    this.setCurrentStyle({ ...this.currentStyle, strokeWidth: d.strokeWidth, fontSize: d.fontSize });
    this.saveSettings({ canvasStyleInit: true });
  }

  scheduleSave() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => this.flushSave(), 800);
    if (!this.flushBound) {
      // al cerrar o ocultar la pestaña se guarda ya, sin esperar los 800 ms
      this.flushBound = true;
      const now = () => this.saveT && this.flushSave();
      addEventListener('pagehide', now);
      document.addEventListener('visibilitychange', () => document.hidden && now());
    }
  }

  /**
   * Guarda ya el documento en el navegador: como «el actual» (lo que se abre
   * al volver a la app) y como su versión en la lista de recientes.
   */
  flushSave(meta = {}) {
    clearTimeout(this.saveT);
    this.saveT = null;
    const doc = this.history.doc;
    return Promise.all([saveDoc(doc), rememberProject(doc, meta).catch(() => null)]);
  }

  /** Proyectos recientes: elegir uno de los últimos 10 y abrir su última versión. */
  async openRecent() {
    await this.flushSave();
    const list = await listRecent();
    const cur = this.history.doc.projectId;
    const when = (iso) => {
      const d = new Date(iso);
      return Number.isFinite(d.getTime()) ? d.toLocaleString('es-CL', { dateStyle: 'medium', timeStyle: 'short' }) : '';
    };
    const id = await askChoice({
      title: 'Abrir reciente',
      hint: 'Los últimos 10 proyectos en este navegador, con su última versión (se guardan solos mientras trabajas).',
      empty: 'Todavía no hay proyectos recientes.',
      items: list.map((x) => ({
        value: x.id,
        label: `${x.name}${x.id === cur ? '  (abierto)' : ''}`,
        hint: [when(x.savedAt), x.source === 'drive' ? 'Google Drive' : x.source === 'archivo' ? 'archivo' : 'navegador', `${x.shapes} objeto(s)`].filter(Boolean).join(' · '),
        onRemove: x.id === cur ? null : () => forgetRecent(x.id),
      })),
    });
    if (!id || id === cur) return;
    const doc = await loadRecent(id);
    if (!doc?.layers) {
      await forgetRecent(id);
      throw new Error('Ese proyecto ya no está guardado en este navegador');
    }
    this.loadDocument(normalizeDoc(doc));
    await this.restoreFileHandle();
    this.message(`Abierto: ${list.find((x) => x.id === id)?.name || 'proyecto'}`, 3000);
  }

  /** Pone un documento como el actual: sus archivos raster y la vista. */
  loadDocument(doc, embedded = new Map(), meta = {}) {
    this.history.commit(doc);
    for (const l of doc.layers) if (l.settings?.fileId) this.reloadFile(l.settings.fileId, embedded.get(l.settings.fileId)).catch(() => null);
    if (this.mode !== 'gis') this.fitCanvas();
    else this.zoomToShapes(allTopShapes(doc).map((x) => x.shape));
    return this.flushSave(meta);
  }

  /**
   * Imágenes y modelos de elevación de un proyecto guardado en Drive (van como
   * archivos aparte) que no están en este navegador: se bajan, se guardan y se
   * muestran. Avisa de los que no se pueden recuperar.
   */
  async fetchDriveAssets(doc) {
    const need = [];
    const lost = [];
    for (const [id, layerName] of referencedFiles(doc)) {
      if (imageFiles.has(id) || demFiles.has(id) || (await loadFile(id))?.buffer) continue;
      if (doc.driveAssets?.[id]?.driveId) need.push(id);
      else lost.push(layerName);
    }
    if (need.length) {
      const gd = await import('./io/gdrive.js');
      const { googleApiKey: apiKey } = this.settings;
      let done = 0;
      for (const id of need) {
        const m = doc.driveAssets[id];
        this.message(`Bajando de Google Drive las imágenes del proyecto… ${done + 1}/${need.length}`, 0);
        try {
          const f = await gd.downloadDriveFile({ id: m.driveId, name: m.name || id, mimeType: m.mime || 'application/octet-stream' }, { apiKey });
          const { driveId, ...meta } = m;
          const rec = { ...meta, buffer: await f.arrayBuffer() };
          await saveFile(id, rec);
          await this.reloadFile(id, rec);
          done++;
        } catch (err) {
          lost.push(`${m.name || id} (${err.message})`);
        }
      }
      if (done) this.message(`${done} imagen(es) del proyecto bajadas de Google Drive`, 3500);
    }
    if (lost.length) this.message(`Faltan archivos raster en este equipo: ${lost.slice(0, 3).join(', ')}${lost.length > 3 ? '…' : ''}. Inicia sesión con Google (o vuelve a importarlos) y abre de nuevo.`, 12000);
  }

  message(text, ms = 2600) {
    const el = document.getElementById('status');
    clearTimeout(this.msgT);
    if (!text) {
      el.hidden = true;
      return;
    }
    el.textContent = text;
    el.hidden = false;
    if (ms) this.msgT = setTimeout(() => (el.hidden = true), ms);
  }

  /* --------------------------------------------------------- arranque */

  async restore() {
    const v = readJSON('gd.view');
    if (v?.mpp) Object.assign(this.view, { cx: v.cx, cy: v.cy, mpp: v.mpp });
    let saved = await loadDoc();
    // sin «actual» (o vacío): el último de los recientes
    if (!saved?.layers || !hasContent(saved)) {
      const [last] = await listRecent();
      const rec = last && (await loadRecent(last.id));
      if (rec?.layers) saved = rec;
    }
    if (saved?.layers) {
      this.history.reset(normalizeDoc(saved));
      // archivos pesados (DEM, imágenes) desde IndexedDB
      for (const l of saved.layers) {
        const fid = l.settings?.fileId;
        if (fid && !demFiles.has(fid) && !imageFiles.has(fid)) this.reloadFile(fid).catch(() => null);
      }
    } else {
      this.history.reset(this.history.doc);
    }
    if (this.mode !== 'gis') {
      // la vista guardada puede ser de otro lugar (GIS): si no cae sobre la hoja, se encuadra la hoja
      const r = canvasRect(this.history.doc);
      const inside = Math.abs(this.view.cx - (r.x + r.w / 2)) < r.w && Math.abs(this.view.cy - (r.y + r.h / 2)) < r.h && this.view.mpp < r.h / 20;
      if (!v?.mpp || !inside) this.fitCanvas();
      if (!this.settings.canvasStyleInit) this.applyCanvasDefaults();
    }
    this.view.emit();
    await this.restoreFileHandle();
    this.editor.setTool('select');
    this.panels.render();
    this.panels.onShow?.(this.panels.tab);
  }

  async reloadFile(fileId, known = null) {
    const rec = known || (await loadFile(fileId));
    if (!rec) return;
    if (rec.kind === 'dem') demFiles.set(fileId, await this.buildDem(rec));
    if (rec.kind === 'image') imageFiles.set(fileId, await this.buildImage(rec));
    this.renderer.vectorCache.clear();
    for (const st of this.raster.state.values()) st.key = '';
    this.renderer.request({ settled: true });
  }

  observeSize() {
    const ro = new ResizeObserver(() => {
      const r = this.viewport.getBoundingClientRect();
      this.view.resize(r.width, r.height);
    });
    ro.observe(this.viewport);
  }

  /* --------------------------------------------------------- barras */

  buildToolbar() {
    this.toolbarEl = document.getElementById('toolbar');
    const groups = [['select', 'node', 'drag', 'lasso'], ['pen', 'polygon', 'pencil', 'smooth', 'deform', 'line', 'arrow'], ['split', 'reshape'], ['rect', 'ellipse', 'text', 'point'], ['scissors', 'eyedropper', 'pan', 'zoom']];
    const els = [];
    groups.forEach((g, gi) => {
      if (gi) els.push(h('div', { class: 'tsep' }));
      for (const t of g) {
        const b = h('button', { 'data-tool': t, 'aria-label': TOOLS[t].label, 'data-tip': `${TOOLS[t].label}  ${TOOLS[t].key.toUpperCase()}`, html: ICONS[t], onclick: () => this.editor.setTool(t) });
        els.push(b);
      }
    });
    els.push(h('div', { class: 'tsep' }), this.buildSwatch());
    this.toolbarEl.replaceChildren(...els);
    this.updateSwatch();
  }

  /**
   * Relleno y trazo, como en Illustrator: cada cuadro abre su selector de
   * color (el input va encima, transparente, para que funcione también en
   * iPad); el que está al frente es el que afectan X, / y el menú.
   */
  buildSwatch() {
    const chip = (kind) => {
      const input = h('input', { type: 'color', class: 'sw-input', 'aria-label': kind === 'fill' ? 'Color de relleno' : 'Color de trazo' });
      input.addEventListener('pointerdown', () => this.setSwatchFront(kind));
      input.addEventListener('input', () => this.editStyle({ [kind]: input.value }, false));
      input.addEventListener('change', () => this.editStyle({ [kind]: input.value }, true));
      const el = h('div', { class: `sw-chip sw-${kind}`, 'data-tip': kind === 'fill' ? 'Relleno (X alterna)' : 'Trazo (X alterna)' }, h('div', { class: 'sw-paint' }), input);
      el.input = input;
      return el;
    };
    this.swFill = chip('fill');
    this.swStroke = chip('stroke');
    const mini = (label, tip, f) => h('button', { class: 'sw-mini', 'data-tip': tip, 'aria-label': tip, onclick: f }, label);
    this.swatch = h(
      'div',
      { class: 'swatch' },
      h('div', { class: 'sw-chips' }, this.swFill, this.swStroke),
      h(
        'div',
        { class: 'sw-row' },
        mini('◩', 'Predeterminado  D', () => this.defaultColors()),
        mini('⇄', 'Intercambiar  Mayús+X', () => this.swapColors()),
        mini('⌀', 'Ninguno  /', () => this.noneColor()),
      ),
    );
    this.setSwatchFront(this.swatchFront);
    return this.swatch;
  }

  setSwatchFront(kind) {
    this.swatchFront = kind;
    this.swatch?.classList.toggle('fill-front', kind === 'fill');
  }

  shownStyle() {
    const sel = this.editor.selectedShapes();
    let target = null;
    for (const s of sel) walkShapes([s], (x) => {
      if (!target && x.style) target = x;
    });
    return target?.style || this.currentStyle;
  }

  defaultColors() {
    this.editStyle({ fill: 'none', stroke: '#000000', strokeWidth: 0.35, strokeOpacity: 1 }, true);
    this.message('Predeterminado: sin relleno, trazo negro 0,35 mm');
  }

  swapColors() {
    const st = this.shownStyle();
    this.editStyle({ fill: st.stroke || 'none', stroke: st.fill || 'none', fillOpacity: st.fill === 'none' ? 1 : st.fillOpacity }, true);
  }

  noneColor() {
    const st = this.shownStyle();
    const k = this.swatchFront;
    if (st[k] === 'none') return;
    this.editStyle(k === 'fill' ? { fill: 'none', lastFill: st.fill } : { stroke: 'none', lastStroke: st.stroke }, true);
  }

  updateSwatch() {
    if (!this.swatch) return;
    const st = this.shownStyle();
    const paint = (chip, color) => {
      const none = !color || color === 'none';
      chip.classList.toggle('none', none);
      chip.firstChild.style.setProperty('--c', none ? 'transparent' : color);
      if (!none && /^#[0-9a-f]{6}$/i.test(color)) chip.input.value = color;
    };
    paint(this.swFill, st.fill);
    paint(this.swStroke, st.stroke);
  }

  /* ------------------------------------------------ barra de propiedades */

  /** Barra de control (como la de Illustrator): trazo, grosor, tipo, relleno y opacidad a mano. */
  renderPropbar() {
    const bar = document.getElementById('propbar');
    if (!bar || bar.contains(document.activeElement) || popSliderOpen('pb')) return;
    const ed = this.editor;
    const sel = ed.selectedShapes();
    const st = { ...defaultStyle(), ...this.shownStyle() };
    const text = sel.length === 1 && sel[0].type === 'text' ? sel[0] : null;
    const items = [];
    const lbl = (t) => h('span', { class: 'pb-l' }, t);
    const colorIn = (kind) => {
      const has = st[kind] && st[kind] !== 'none';
      const i = h('input', { type: 'color', value: has && /^#[0-9a-f]{6}$/i.test(st[kind]) ? st[kind] : kind === 'fill' ? '#86efac' : '#000000' });
      i.addEventListener('input', () => this.editStyle({ [kind]: i.value }, false));
      i.addEventListener('change', () => this.editStyle({ [kind]: i.value }, true));
      const wrap = h('label', { class: `pb-color${has ? '' : ' none'}`, 'data-tip': kind === 'fill' ? 'Color de relleno' : 'Color de trazo' }, i);
      const off = h('button', { class: `pb-btn${has ? '' : ' on'}`, 'data-tip': has ? 'Quitar' : 'Activar', onclick: () => this.editStyle(has ? { [kind]: 'none', [kind === 'fill' ? 'lastFill' : 'lastStroke']: st[kind] } : { [kind]: (kind === 'fill' ? st.lastFill : st.lastStroke) || (kind === 'fill' ? '#86efac' : '#000000') }, true) }, '⌀');
      return [wrap, off];
    };
    items.push(h('span', { class: 'pb-head' }, sel.length ? `${sel.length} sel.` : 'Nuevo'));
    // con el lápiz (o un trazo libre seleccionado) el suavizado va primero: es lo que se está ajustando
    const smooth = this.smoothControl();
    if (smooth) items.push(...smooth, h('span', { class: 'pb-sep' }));
    items.push(lbl('Trazo'), ...colorIn('stroke'));
    const w = h('input', { type: 'number', class: 'pb-num', min: 0, step: 0.05, value: Number(st.strokeWidth || 0).toFixed(2), 'data-tip': 'Grosor del trazo (mm en el papel)' });
    w.addEventListener('change', () => {
      const v = Number(String(w.value).replace(',', '.'));
      if (Number.isFinite(v) && v >= 0) this.editStyle({ strokeWidth: v }, true);
    });
    const widths = h('select', { class: 'pb-sel pb-w', 'data-tip': 'Grosores frecuentes', onchange: (e) => e.target.value && this.editStyle({ strokeWidth: Number(e.target.value) }, true) }, h('option', { value: '' }, '▾'), ...[0.1, 0.18, 0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 3, 5, 8, 12, 20, 30].map((v) => h('option', { value: v }, `${v} mm`)));
    // tocar el número abre un deslizador: se ve el cambio en vivo y queda un solo deshacer
    const reRender = () => setTimeout(() => this.renderPropbar(), 0);
    popSlider(w, { min: 0.05, max: 30, step: 0.01, log: true, get: () => Number(st.strokeWidth) || 0.35, fmt: (v) => v.toFixed(2), oninput: (v) => this.editStyle({ strokeWidth: v }, false), onchange: (v) => this.editStyle({ strokeWidth: v }, true), onclose: reRender, cls: 'pb' });
    items.push(w, h('span', { class: 'pb-u' }, 'mm'), widths);
    const dash = h('select', { class: 'pb-sel', 'data-tip': 'Tipo de línea', onchange: (e) => this.editStyle({ dash: e.target.value }, true) }, ...Object.entries(DASHES).map(([k, d]) => h('option', { value: k, selected: (st.dash || 'solid') === k }, d.label)));
    items.push(dash, h('span', { class: 'pb-sep' }));
    items.push(lbl('Relleno'), ...colorIn('fill'));
    const op = h('input', { type: 'number', class: 'pb-num pb-pct', min: 0, max: 100, step: 5, value: Math.round((st.opacity ?? 1) * 100), 'data-tip': 'Opacidad del objeto (%)' });
    op.addEventListener('change', () => {
      const v = Math.max(0, Math.min(100, Number(op.value)));
      if (Number.isFinite(v)) this.editStyle({ opacity: v / 100 }, true);
    });
    popSlider(op, { min: 0, max: 100, step: 1, get: () => Math.round((st.opacity ?? 1) * 100), oninput: (v) => this.editStyle({ opacity: v / 100 }, false), onchange: (v) => this.editStyle({ opacity: v / 100 }, true), onclose: reRender, cls: 'pb' });
    items.push(h('span', { class: 'pb-sep' }), lbl('Opac.'), op, h('span', { class: 'pb-u' }, '%'));
    if (text) {
      const fs = h('input', { type: 'number', class: 'pb-num', min: 0.5, step: 0.5, value: text.fontSize, 'data-tip': 'Tamaño de letra (pt a la escala de referencia)' });
      fs.addEventListener('change', () => {
        const v = Number(fs.value);
        if (v > 0) this.history.commit(mapShapes(this.history.doc, [text.id], (x) => ({ ...x, fontSize: v })));
      });
      const fsBase = this.history.doc;
      const setFs = (v, final) => {
        const next = mapShapes(fsBase, [text.id], (x) => ({ ...x, fontSize: v }));
        if (!final) {
          if (!this.history.anchor) this.history.begin();
          this.history.preview(next);
        } else if (this.history.anchor) {
          this.history.preview(next);
          this.history.end();
        } else this.history.commit(next);
      };
      popSlider(fs, { min: 1, max: 96, step: 0.5, log: true, get: () => text.fontSize, oninput: (v) => setFs(v, false), onchange: (v) => setFs(v, true), onclose: reRender, cls: 'pb' });
      items.push(h('span', { class: 'pb-sep' }), lbl('Letra'), fs, h('span', { class: 'pb-u' }, 'pt'));
    }
    items.push(
      h('span', { class: 'pb-sep' }),
      h('button', { class: 'pb-btn pb-more', 'data-tip': 'Todo el estilo  Ctrl+F10', onclick: () => this.showPanel('style') }, 'Estilo…'),
      h('button', { class: 'pb-btn pb-more', 'data-tip': 'Tramas, fallas y tipos de línea geológicos', onclick: () => this.showPanel('geology') }, 'Geología…'),
    );
    bar.replaceChildren(...items);
  }

  buildTopbar() {
    const $ = (id) => document.getElementById(id);
    $('btn-undo').onclick = () => this.history.undo();
    $('btn-redo').onclick = () => this.history.redo();
    $('btn-snap').onclick = () => this.saveSettings({ snap: !this.settings.snap });
    $('btn-trace').onclick = () => this.saveSettings({ trace: !this.settings.trace });
    $('btn-joined').onclick = () => this.saveSettings({ moveJoined: !this.settings.moveJoined });
    $('btn-guides').onclick = () => {
      this.saveSettings({ guides: this.settings.guides === false });
      this.editor.guides = null;
      this.editor.changed();
    };
    $('btn-finger').onclick = () => this.saveSettings({ fingerDraws: !this.settings.fingerDraws });
    $('btn-redraw').onclick = () => {
      const n = this.raster.redrawHillshades(this.history.doc.layers);
      if (n) this.message('Recalculando relieve para la vista actual…', 2500);
    };
    $('btn-mode-canvas').onclick = () => this.setMode('canvas');
    $('btn-mode-gis').onclick = () => this.setMode('gis');
    $('btn-google').onclick = () => this.configureDrive();
    this.updateGoogleButton();
    $('btn-panel').onclick = () => this.togglePanel();
    $('btn-help').onclick = () => this.toggleHelp();
    if (window.innerWidth < 900) document.getElementById('app').classList.add('panel-hidden');
    this.scaleInput = $('in-scale');
    this.scaleInput.addEventListener('change', () => {
      const v = Number(this.scaleInput.value.replace(/[.\s]/g, '').replace(',', '.'));
      if (!(v > 0)) return;
      if (this.mode === 'gis') this.view.setScale(v);
      else this.view.setScale(this.history.doc.refScale / (v / 100));
    });
    // deslizador de zoom (Canvas, %) o de escala (GIS, 1:N), logarítmico
    const zoomTo = (v) => (this.mode === 'gis' ? this.view.setScale(v) : this.view.setScale(this.history.doc.refScale / (v / 100)));
    popSlider(this.scaleInput, {
      min: () => (this.mode === 'gis' ? 100 : 5),
      max: () => (this.mode === 'gis' ? 1e7 : 3200),
      log: true,
      get: () => (this.mode === 'gis' ? this.view.scale : (this.history.doc.refScale / this.view.scale) * 100),
      fmt: (v) => (this.mode === 'gis' ? Math.round(v).toLocaleString('es-CL') : String(Math.round(v))),
      oninput: zoomTo,
    });
    const menu = $('menu-file');
    $('btn-file').onclick = (e) => {
      e.stopPropagation();
      if (!menu.hidden) {
        menu.hidden = true;
        return;
      }
      const r = e.currentTarget.getBoundingClientRect();
      menu.style.left = `${r.left}px`;
      menu.style.top = `${r.bottom + 4}px`;
      menu.replaceChildren(...this.fileMenuItems());
      menu.hidden = false;
    };
    const geomMenu = $('menu-geom');
    $('btn-geom').onclick = (e) => {
      e.stopPropagation();
      if (!geomMenu.hidden) {
        geomMenu.hidden = true;
        return;
      }
      menu.hidden = true;
      const r = e.currentTarget.getBoundingClientRect();
      geomMenu.style.left = `${r.left}px`;
      geomMenu.style.top = `${r.bottom + 4}px`;
      geomMenu.replaceChildren(...this.geomMenuItems());
      geomMenu.hidden = false;
    };
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target.id !== 'btn-file') menu.hidden = true;
      if (!geomMenu.hidden && !geomMenu.contains(e.target) && e.target.id !== 'btn-geom') geomMenu.hidden = true;
    });
    this.viewport.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'touch') return;
      const r = this.viewport.getBoundingClientRect();
      this.updateCoords(this.view.toWorld(e.clientX - r.left, e.clientY - r.top));
    });
    this.syncToggles();
  }

  fileMenuItems() {
    const item = (label, f) =>
      h('button', {
        onclick: () => {
          document.getElementById('menu-file').hidden = true;
          Promise.resolve(f()).catch((err) => this.message(`Error: ${err.message}`, 6000));
        },
      }, label);
    const gis = this.mode === 'gis';
    return [
      h('div', { class: 'mh' }, 'Proyecto'),
      item('Nuevo', async () => {
        if (!(await askConfirm('Se empieza un dibujo vacío. El actual queda en Archivo → Abrir reciente (y se puede recuperar con Ctrl+Z).', { title: 'Dibujo nuevo', ok: 'Empezar' }))) return;
        await this.flushSave();
        this.fileHandle = null;
        this.history.commit(newDocument());
        if (this.mode !== 'gis') {
          this.applyCanvasDefaults();
          this.fitCanvas();
        }
      }),
      item('Abrir proyecto (.gisdrawer)…', () => this.openProject()),
      item('Abrir reciente…', () => this.openRecent()),
      item(`Guardar proyecto${this.fileHandle ? ` en ${this.fileHandle.name}` : ' (.gisdrawer, con imágenes incrustadas)'}   Ctrl+S`, () => this.saveProject()),
      item('Guardar proyecto como…   Ctrl+Mayús+S', () => this.saveProject({ as: true })),
      item(this.history.doc.driveFileId ? `Guardar en Google Drive (actualiza ${this.history.doc.fileName || 'el archivo'})   Ctrl+S+D` : 'Guardar en Google Drive (elegir carpeta)…   Ctrl+S+D', () => this.saveToDrive()),
      item('Guardar en Google Drive en otra carpeta…', () => this.saveToDrive({ choose: true })),
      h('div', { class: 'mh' }, 'Importar'),
      gis && item('GeoPackage (.gpkg)…', () => this.importGpkg()),
      gis && item('GeoJSON…', () => this.importGeoJSON()),
      gis && item('GeoTIFF / ASCII grid de elevación…', () => this.importDemForLayer(null)),
      gis && item('GeoTIFF imagen (orto, mapa escaneado)…', () => this.importImage()),
      gis && item('Georreferenciar imagen (JPG/PNG/TIFF)…', () => this.startGeoref()),
      gis && item('Estilo QGIS (.qml / .qlr) a la capa activa…', () => this.applyQmlToLayer(this.history.doc.activeLayerId)),
      gis && item('Proyecto FieldDraw (.fdproj.json / .zip / GeoJSON)…', () => this.importFieldDraw()),
      !gis && item('Imagen (PNG / JPG) como capa de imagen…', () => this.importPlainImage()),
      item('Illustrator (.ai, .svg) / PDF vectorial, una capa por capa…', () => this.importSvgFile()),
      item('Desde Google Drive…', () => this.importFromDrive()),
      item('Cuenta de Google y Drive…', () => this.configureDrive()),
      h('div', { class: 'mh' }, 'Exportar'),
      gis && item('GeoPackage (todas las capas, con estilo QGIS)', () => this.exportGpkg()),
      gis && item('Simbología QGIS (.qlr) + GeoPackage', () => this.exportQLR()),
      gis && item('Estilo QGIS (.qml) de la capa activa', () => this.exportQML()),
      gis && item('GeoJSON de la capa activa (WGS84)', () => this.exportGeoJSON(true)),
      gis && item('GeoJSON de la capa activa (UTM 19S)', () => this.exportGeoJSON(false)),
      item('Illustrator con capas (.jsx, lámina del layout)', () => this.layout.exportAs('jsx')),
      item('SVG de la lámina con capas (Illustrator, Inkscape)', () => this.layout.exportAs('svg')),
      item('Imagen (PNG, JPG, TIFF, WebP) con dpi a elección…', () => this.exportImageDialog()),
      item('Imagen PNG de la vista (tal como se ve)', () => this.exportView('png')),
      item('SVG de la vista (vectorial)', () => this.exportView('svg')),
      h('div', { class: 'mh' }, 'Vista'),
      item(`Rueda del mouse: ${this.settings.wheelMode === 'pan' ? 'desplaza (Ctrl/Alt = zoom) → cambiar a zoom' : 'zoom → cambiar a desplazar'}`, () => {
        this.saveSettings({ wheelMode: this.settings.wheelMode === 'pan' ? 'zoom' : 'pan' });
        this.message(`Rueda del mouse: ${this.settings.wheelMode === 'pan' ? 'desplaza el mapa' : 'zoom'}`);
      }),
      item(`Gestos de tablet (2 dedos = deshacer, 3 = rehacer): ${this.settings.gestureTaps === 'single' ? 'un toque → cambiar a dos toques' : 'dos toques → cambiar a un toque'}`, () => {
        this.saveSettings({ gestureTaps: this.settings.gestureTaps === 'single' ? 'double' : 'single' });
        this.message(`Gestos de tablet: ${this.settings.gestureTaps === 'single' ? 'un toque' : 'dos toques seguidos'}`);
      }),
      gis && item('Ir a coordenadas…', () => this.gotoCoords()),
      item(`Cambiar a modo ${this.mode === 'gis' ? MODES.canvas : MODES.gis}`, () => this.setMode(this.mode === 'gis' ? 'canvas' : 'gis')),
      item('Layout de impresión (PDF / SVG / PNG)…', () => this.showPanel('layout')),
      item('Zoom a todo el dibujo', () => this.zoomToShapes(allTopShapes(this.history.doc).map((x) => x.shape))),
      item(`Atajos, gestos y versión (${APP_VERSION})…`, () => this.toggleHelp(true)),
      item('Acerca de la app…', () => {
        this.toggleHelp(true);
        document.getElementById('about')?.scrollIntoView({ block: 'start' });
      }),
    ].filter(Boolean);
  }

  get mode() {
    return modeOf(this.settings);
  }

  /**
   * Canvas / GIS. El modo no toca el proyecto: solo decide qué se muestra
   * (mapa base y relieve, coordenadas, pestañas y menús GIS).
   */
  setMode(mode, { silent = false } = {}) {
    mode = mode === 'gis' ? 'gis' : 'canvas';
    const before = this.mode;
    if (mode !== before) {
      // cada modo recuerda su vista: GIS donde se estaba trabajando, Canvas la hoja
      this.modeViews = { ...this.modeViews, [before]: { cx: this.view.cx, cy: this.view.cy, mpp: this.view.mpp } };
      this.saveSettings({ mode });
    }
    this.applyMode();
    if (mode !== before) {
      const v = this.modeViews?.[mode];
      if (v) Object.assign(this.view, v), this.view.emit();
      else if (mode === 'canvas') this.fitCanvas();
    }
    if (!silent) this.message(mode === 'gis' ? 'Modo GIS: mapa base, relieve, coordenadas y formatos GIS' : 'Modo Canvas: solo dibujo', 3500);
  }

  applyMode() {
    const gis = this.mode === 'gis';
    document.getElementById('app').classList.toggle('mode-gis', gis);
    document.getElementById('app').classList.toggle('mode-canvas', !gis);
    document.getElementById('btn-mode-canvas')?.classList.toggle('on', !gis);
    document.getElementById('btn-mode-gis')?.classList.toggle('on', gis);
    if ((!gis && GIS_TABS.includes(this.panels.tab)) || (gis && CANVAS_TABS.includes(this.panels.tab))) this.panels.tab = 'layers';
    this.panels.renderTabs();
    this.panels.render();
    this.panels.onShow?.(this.panels.tab);
    this.updateRedraw();
    this.updateAttribution();
    this.updateScaleBox();
    this.updatePage();
    if (this.layout) this.layout.schedule?.();
    for (const st of this.raster.state.values()) st.key = '';
    this.renderer.request({ settled: true });
  }

  syncToggles() {
    const set = (id, on) => document.getElementById(id)?.classList.toggle('on', !!on);
    set('btn-snap', this.settings.snap);
    set('btn-trace', this.settings.trace);
    set('btn-joined', this.settings.moveJoined !== false);
    set('btn-guides', this.settings.guides !== false);
    set('btn-finger', this.settings.fingerDraws);
  }

  updateUndo() {
    document.getElementById('btn-undo').disabled = !this.history.past.length;
    document.getElementById('btn-redo').disabled = !this.history.future.length;
  }

  updateAttribution() {
    const src = new Set();
    for (const l of this.history.doc.layers) {
      if (!l.visible || (this.mode !== 'gis' && (l.kind === 'basemap' || l.kind === 'hillshade'))) continue;
      if (l.kind === 'basemap') src.add(BASEMAPS[l.settings.source]?.attribution);
      if (l.kind === 'hillshade') src.add(l.settings.source === 'terrarium' ? 'DEM: Terrarium/AWS (SRTM, GMTED, ETOPO1)' : l.settings.source === 'opentopo' ? `DEM: ${l.settings.demtype} vía OpenTopography` : 'DEM: archivo');
    }
    document.getElementById('attribution').textContent = [...src].filter(Boolean).join(' · ');
  }

  updateCoords(wp) {
    if (this.mode !== 'gis') return;
    const [lon, lat] = toLonLat(wp[0], wp[1]);
    const z = this.raster.elevationAt(wp[0], wp[1]);
    document.getElementById('coords').innerHTML = `${formatDMS(lat, true)} ${formatDMS(lon, false)}<br>${Math.round(wp[0])} E ${Math.round(wp[1])} N${z != null ? ` · ${Math.round(z)} m` : ''}`;
  }

  /** Duplicar, cortar, copiar, orden y pegar: lo que se hace con la selección (selección y nodos). */
  selectionActions(items, b, { duplicate = true } = {}) {
    const ed = this.editor;
    if (ed.selection.size) {
      items.push(
        this.canSimplify() ? b('Simplificar', () => this.simplifyDialog().catch((err) => this.message(`Error: ${err.message}`, 6000))) : null,
        duplicate ? b('Duplicar', () => ed.duplicate()) : null,
        b('Cortar', () => this.cut()),
        b('Copiar', () => this.copy()),
        b('Al frente', () => this.history.commit(arrange(this.history.doc, ed.selection, 'front'))),
        b('Al fondo', () => this.history.commit(arrange(this.history.doc, ed.selection, 'back'))),
        b('Eliminar', () => ed.deleteSelection()),
      );
    }
    for (let i = items.length - 1; i >= 0; i--) if (!items[i]) items.splice(i, 1);
    if (ed.selection.size >= 2) items.push(...this.alignIcons());
    if (this.clipboard.length) items.push(b('Pegar', () => this.paste(false)), b('Pegar en el lugar', () => this.paste(true)));
  }

  /**
   * Alinear (≥ 2 objetos) y distribuir (≥ 3) como iconos de la barra flotante. Alinean a la caja de la
   * selección; «distribuir» reparte centros o espacios entre los dos extremos.
   */
  alignIcons() {
    const ed = this.editor;
    const n = ed.selection.size;
    const run = (f) => () => {
      const next = f(this.history.doc, ed.selection, ed.est());
      if (next !== this.history.doc) this.history.commit(next);
    };
    const ib = (key, tip, f, min = 2) => {
      const el = h('button', { class: 'ico', title: tip, 'data-tip': tip, 'aria-label': tip, html: ALIGN_ICONS[key], onclick: run(f) });
      if (n < min) el.disabled = true;
      return el;
    };
    const sep = () => h('span', { class: 'sep' });
    return [
      sep(),
      ib('left', 'Alinear a la izquierda', (d, ids, est) => align(d, ids, 'left', est)),
      ib('hcenter', 'Centrar horizontalmente', (d, ids, est) => align(d, ids, 'hcenter', est)),
      ib('right', 'Alinear a la derecha', (d, ids, est) => align(d, ids, 'right', est)),
      ib('top', 'Alinear arriba', (d, ids, est) => align(d, ids, 'top', est)),
      ib('vcenter', 'Centrar verticalmente', (d, ids, est) => align(d, ids, 'vcenter', est)),
      ib('bottom', 'Alinear abajo', (d, ids, est) => align(d, ids, 'bottom', est)),
      sep(),
      ib('distHCenters', 'Distribuir centros horizontalmente (3 o más)', (d, ids, est) => distribute(d, ids, 'h', est), 3),
      ib('distVCenters', 'Distribuir centros verticalmente (3 o más)', (d, ids, est) => distribute(d, ids, 'v', est), 3),
      ib('distHSpace', 'Distribuir espacio horizontal igual (3 o más)', (d, ids, est) => distribute(d, ids, 'h', est, { spacing: true }), 3),
      ib('distVSpace', 'Distribuir espacio vertical igual (3 o más)', (d, ids, est) => distribute(d, ids, 'v', est, { spacing: true }), 3),
    ];
  }

  /** Tablet o celular: pantalla táctil (o ya se usó un lápiz). */
  isTouchUI() {
    return this.editor.penSeen || !!window.matchMedia?.('(pointer: coarse)').matches;
  }

  /** ¿Está congelado el nodo activo (el elegido con la herramienta Nodos)? `null` si no hay nodo activo. */
  activeNodeFrozen() {
    const ed = this.editor;
    const a = ed.tool === 'node' ? ed.activeNode : null;
    const shape = a && ed.nodeTarget();
    if (!shape || shape.id !== a.id) return null;
    const nd = ed.ringNodes(shape, a.ring)?.[a.index];
    return nd ? !!ed.frozenAt(nd) : null;
  }

  /** Hay líneas o polígonos editables seleccionados: se puede simplificar. */
  canSimplify() {
    return this.editor.selectedShapes().some((s) => s.type === 'path' && !s.locked);
  }

  updateContextBar() {
    const bar = document.getElementById('contextbar');
    const ed = this.editor;
    // se llama en cada movimiento del puntero: rehacer los botones solo si cambia lo que muestran
    const nodeFrozen = this.activeNodeFrozen();
    const an = ed.tool === 'node' && ed.activeNode ? `${ed.activeNode.id}:${ed.activeNode.ring}:${ed.activeNode.index}:${nodeFrozen}` : '';
    const sig = [ed.tool, !!ed.draft, ed.nodeTarget()?.id, an, ed.selection.size, ed.selection.size ? this.canSimplify() : '', this.clipboard.length, ed.addMode, this.settings.trace, this.settings.insertOnTap, this.settings.moveJoined, this.isTouchUI()].join('|');
    if (sig === this.ctxBarSig) return;
    this.ctxBarSig = sig;
    const touch = this.isTouchUI();
    const b = (label, f, cls = '') => h('button', { class: cls, onclick: f }, label);
    const items = [];
    if (ed.draft) {
      items.push(
        b('Terminar', () => ed.finishDraft(false), 'primary'),
        b('Cerrar forma', () => ed.finishDraft(true)),
        b('Quitar vértice', () => ed.undoDraftNode()),
        b(this.settings.trace ? 'Trace ✓' : 'Trace', () => this.saveSettings({ trace: !this.settings.trace }), this.settings.trace ? 'on' : ''),
        b('Cancelar', () => ed.cancelDraft()),
      );
    } else if (ed.tool === 'node') {
      if (ed.nodeTarget()) {
        items.push(
          b('Borrar nodo', () => ed.deleteActiveNode()),
          b('Esquina / curva', () => ed.activeNode && ed.toggleSmooth(ed.activeNode.id, ed.activeNode.ring, ed.activeNode.index)),
        );
        // con un nodo elegido: dejarlo fijo (Freeze) o liberarlo, según esté
        if (ed.activeNode && nodeFrozen != null) {
          items.push(
            b(nodeFrozen ? 'Unfreeze node' : 'Freeze node', () => {
              ed.freezeNode(ed.activeNode, !nodeFrozen);
              this.updateContextBar();
            }, nodeFrozen ? 'on' : ''),
          );
        }
      }
      items.push(
        b(this.settings.insertOnTap ? 'Insertar al tocar ✓' : 'Insertar al tocar', () => {
          this.saveSettings({ insertOnTap: !this.settings.insertOnTap });
          this.updateContextBar();
        }, this.settings.insertOnTap ? 'on' : ''),
      );
      // en tablet, una barra más despejada: Move Joined sigue en la barra superior y Duplicar en el menú contextual (mantener apretado)
      if (!touch) {
        items.push(b(this.settings.moveJoined !== false ? 'Move Joined ✓' : 'Move Joined', () => {
          this.saveSettings({ moveJoined: this.settings.moveJoined === false });
          this.updateContextBar();
        }, this.settings.moveJoined !== false ? 'on' : ''));
      }
      if (ed.nodeTarget()) {
        if (!touch) items.push(b('Abrir / cerrar', () => ed.toggleClosed()));
        items.push(b('Invertir', () => ed.reverseSelected()));
      }
      this.selectionActions(items, b, { duplicate: !touch });
    } else if (['select', 'lasso'].includes(ed.tool)) {
      items.push(b(ed.addMode ? 'Añadir a selección ✓' : 'Añadir a selección', () => {
        ed.addMode = !ed.addMode;
        this.updateContextBar();
      }, ed.addMode ? 'on' : ''));
      this.selectionActions(items, b);
    }
    bar.replaceChildren(...items);
    bar.hidden = !items.length;
  }

  showPanel(tab) {
    document.getElementById('app').classList.remove('panel-hidden');
    this.panels.show(tab);
  }

  togglePanel() {
    document.getElementById('app').classList.toggle('panel-hidden');
    this.updatePage();
  }

  /* --------------------------------------------------- menú contextual */

  buildContextMenu() {
    this.ctxEl = document.getElementById('ctx-menu');
    document.addEventListener('pointerdown', (e) => {
      // en el lienzo lo cierra el editor (el mismo clic derecho lo abre)
      if (!this.ctxEl.hidden && !this.ctxEl.contains(e.target) && !e.target.closest?.('#input-host')) this.hideContextMenu();
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        this.hideContextMenu();
        this.toggleHelp(false);
      }
    });
    window.addEventListener('blur', () => this.hideContextMenu());
    // el clic secundario (y mantener apretado en pantallas táctiles) nunca abre el menú del navegador:
    // solo el de la app, y solo sobre el lienzo. Se exceptúan los campos de texto, donde el menú del
    // sistema (copiar / pegar) hace falta. Mayús + clic secundario en Firefox lo fuerza el navegador y no se puede impedir.
    document.addEventListener(
      'contextmenu',
      (e) => {
        if (e.target.closest?.('input:not([type=range]):not([type=checkbox]):not([type=color]):not([type=button]), textarea, [contenteditable=true], [contenteditable=""]')) return;
        e.preventDefault();
      },
      true,
    );
  }

  hideContextMenu() {
    if (this.ctxEl) this.ctxEl.hidden = true;
  }

  /** Menú del botón derecho o de mantener apretado: lo que tiene sentido según lo que hay bajo el puntero. */
  showContextMenu(sp, info = {}) {
    const ed = this.editor;
    const doc = this.history.doc;
    const sel = ed.selectedShapes();
    const n = sel.length;
    const groups = [];
    const it = (label, key, f, opts = {}) => ({ label, key, f, ...opts });
    const run = (f) => () => {
      this.hideContextMenu();
      Promise.resolve(f()).catch((err) => this.message(`Error: ${err.message}`, 6000));
    };
    const commitSel = (r) => {
      if (r.error) return this.message(r.error);
      this.history.commit(r.doc);
      if (r.id) ed.setSelection([r.id]);
      else if (r.ids) ed.setSelection(r.ids);
    };

    if (ed.draft) {
      groups.push([
        it('Terminar línea', 'Enter', () => ed.finishDraft(false)),
        it('Cerrar forma', '', () => ed.finishDraft(true)),
        it('Quitar último vértice', '⌫', () => ed.undoDraftNode()),
        it('Cancelar trazo', 'Esc', () => ed.cancelDraft()),
      ]);
    }
    if (info.node) {
      const a = info.node;
      const nd = ed.ringNodes(allTopShapes(doc, { visibleOnly: false }).find((x) => x.shape.id === a.id)?.shape || { nodes: [] }, a.ring)?.[a.index];
      const frozen = ed.frozenAt(nd);
      groups.push([
        frozen ? it('Unfreeze node (descongelar)', '', () => ed.freezeNode(a, false)) : it('Freeze node (dejar fijo)', '', () => ed.freezeNode(a, true)),
        it('Borrar nodo', 'Supr', () => ed.deleteActiveNode()),
        it('Esquina ↔ curva', 'Mayús+C', () => ed.toggleSmooth(a.id, a.ring, a.index)),
        a.ring < 0 ? it('Cortar en este nodo', 'C', () => commitSel(splitPath(this.history.doc, a.id, a.index, 0))) : null,
      ]);
    }
    if (n) {
      const paths = sel.filter((s) => s.type === 'path');
      groups.push([
        it('Cortar', 'Ctrl+X', () => this.cut()),
        it('Copiar', 'Ctrl+C', () => this.copy()),
        it('Duplicar', 'Ctrl+D', () => ed.duplicate()),
        it('Eliminar', 'Supr', () => ed.deleteSelection(), { danger: true }),
      ]);
      groups.push([
        it('Estilo…', 'Ctrl+F10', () => this.showPanel('style')),
        it('Geología: tramas y fallas…', '', () => this.showPanel('geology')),
        n === 1 && this.mode === 'gis' ? it('Atributos…', '', () => this.showPanel('attrs')) : null,
        n === 1 && sel[0].type === 'text' ? it('Editar texto', 'Doble clic', () => this.editText(sel[0])) : null,
        n === 1 && sel[0].type === 'path' ? it('Editar nodos', 'A', () => ed.setTool('node')) : null,
        it('Transformar: mover, rotar, escalar…', 'Ctrl+Mayús+M', () => this.transformDialog()),
        paths.length ? it('Simplificar (menos nodos)…', '', () => this.simplifyDialog()) : null,
        paths.length > 1 ? it('Tidy: compartir nodos cercanos…', '', () => this.tidyDialog()) : null,
        paths.some((s) => [s.nodes, ...(s.holes || [])].some((r) => r?.some((q) => q.frozen))) ? it('Unfreeze nodes (descongelar todos)', '', () => ed.unfreezeSelection()) : null,
      ]);
      groups.push([
        it('Traer al frente', 'Ctrl+Mayús+]', () => this.history.commit(arrange(doc, ed.selection, 'front'))),
        it('Hacia adelante', 'Ctrl+]', () => this.history.commit(arrange(doc, ed.selection, 'forward'))),
        it('Hacia atrás', 'Ctrl+[', () => this.history.commit(arrange(doc, ed.selection, 'backward'))),
        it('Enviar al fondo', 'Ctrl+Mayús+[', () => this.history.commit(arrange(doc, ed.selection, 'back'))),
      ]);
      groups.push([
        n > 1 ? it('Agrupar', 'Ctrl+G', () => commitSel(group(doc, ed.selection))) : null,
        sel.some((s) => s.type === 'group') ? it('Desagrupar', 'Ctrl+Mayús+G', () => commitSel(ungroup(doc, ed.selection))) : null,
        paths.length ? it('Invertir dirección', '', () => ed.reverseSelected()) : null,
        it('Seleccionar mismo relleno y trazo', '', () => ed.setSelection(selectSame(doc, ed.selection, 'fillstroke', { scope: 'all' }))),
      ]);
      const g = this.geomState();
      groups.push(
        [
          g.canJoin ? it(g.lines.length === 1 ? 'Cerrar trazo (Join)' : 'Unir líneas (Join)', 'Ctrl+J', () => this.joinSelected()) : null,
          g.canMerge ? it('Fusionar polígonos (Merge)', 'Ctrl+J', () => this.mergeSelected()) : null,
          it('Dividir (Split): línea que cruza o corte arrastrado…', 'U', () => ed.setTool('split')),
          g.polys.length + g.lines.length ? it('Reshape: redibujar el contorno con una línea…', 'R', () => ed.setTool('reshape')) : null,
          g.canHole ? it('Hueco con la forma de arriba (Hole)', '', () => this.holeSelected(false)) : null,
          g.canHole ? it('Hueco conservando la forma (Hole)', '', () => this.holeSelected(true)) : null,
          g.canHoleDraw ? it('Hueco dibujando una forma (Hole)…', '', () => this.holeByDrawing()) : null,
        ],
      );
      groups.push([
        it('Bloquear', 'Ctrl+2', () => this.lockSelection()),
        it('Ocultar', 'Ctrl+3', () => this.hideSelection()),
        it('Zoom a la selección', '', () => this.zoomToShapes(sel)),
      ]);
    }
    groups.push([
      this.clipboard.length || navigator.clipboard?.readText ? it('Pegar', 'Ctrl+V', () => this.paste(false)) : null,
      this.clipboard.length || navigator.clipboard?.readText ? it('Pegar en el lugar', 'Ctrl+F', () => this.paste(true)) : null,
      it('Seleccionar todo', 'Ctrl+A', () => ed.selectAll()),
      n ? it('Deseleccionar', 'Ctrl+Mayús+A', () => ed.setSelection([])) : null,
    ]);
    groups.push([
      it('Desbloquear todo', 'Ctrl+Alt+2', () => this.unlockAll()),
      it('Mostrar todo', 'Ctrl+Alt+3', () => this.showAll()),
      it('Zoom a todo el dibujo', 'Ctrl+0', () => this.zoomToShapes(allTopShapes(doc).map((x) => x.shape))),
      it(`Escala de referencia 1:${Number(doc.refScale).toLocaleString('es-CL')}`, 'Ctrl+1', () => this.view.setScale(doc.refScale)),
      info.wp ? it('Copiar coordenadas de este punto', '', () => this.copyCoords(info.wp)) : null,
    ]);

    const els = [];
    for (const g of groups) {
      const items = g.filter(Boolean);
      if (!items.length) continue;
      if (els.length) els.push(h('div', { class: 'msep' }));
      for (const x of items) els.push(h('button', { class: x.danger ? 'danger' : '', onclick: run(x.f) }, h('span', {}, x.label), x.key ? h('kbd', {}, x.key) : null));
    }
    const m = this.ctxEl;
    m.replaceChildren(...els);
    m.hidden = false;
    const vr = this.viewport.getBoundingClientRect();
    const mw = m.offsetWidth;
    const mh = m.offsetHeight;
    m.style.left = `${Math.max(4, Math.min(vr.left + sp[0], window.innerWidth - mw - 6))}px`;
    m.style.top = `${Math.max(4, Math.min(vr.top + sp[1], window.innerHeight - mh - 6))}px`;
  }

  copyCoords(wp) {
    const [lon, lat] = toLonLat(wp[0], wp[1]);
    const t = `${lat.toFixed(6)}, ${lon.toFixed(6)}  (${formatDMS(lat, true)} ${formatDMS(lon, false)} · ${Math.round(wp[0])} E ${Math.round(wp[1])} N UTM 19S)`;
    navigator.clipboard?.writeText(t).then(
      () => this.message('Coordenadas copiadas'),
      () => askText('Coordenadas', t, { ok: 'Cerrar', hint: 'No se pudo copiar solo: selecciona el texto y cópialo.' }),
    ) ?? askText('Coordenadas', t, { ok: 'Cerrar' });
  }

  /** Qué se puede hacer con la selección: Join, Merge, Split y Hole. */
  geomState() {
    const sel = this.editor.selectedShapes().filter((s) => s.type === 'path');
    const lines = sel.filter((s) => !s.closed);
    const polys = sel.filter((s) => s.closed);
    return {
      lines,
      polys,
      canJoin: lines.length >= 1 && !polys.length,
      canMerge: polys.length >= 2 && !lines.length,
      canSplitSel: polys.length >= 1 && lines.length >= 1,
      canSplitDraw: polys.length >= 1,
      canHole: polys.length >= 2,
      canHoleDraw: polys.length >= 1,
    };
  }

  /** Tolerancia (m) con que se aplanan las curvas al operar: lo que se ve en el papel, sin facetas. */
  geomTol() {
    return Math.max(1e-3, Math.min(this.history.doc.refScale * 5e-5, this.view.mpp * 0.25));
  }

  /** Confirma el resultado de una operación de geometría y selecciona lo que quedó. */
  applyGeom(r, done = '') {
    if (r.error) return this.message(r.error, 6000);
    this.history.commit(r.doc);
    this.editor.setSelection(r.ids || (r.id ? [r.id] : []));
    this.editor.snapDirty = true;
    this.message(r.warning || done, r.warning ? 7000 : 3000);
  }

  /** Ctrl+J: une líneas (Join) o fusiona polígonos (Merge), según lo seleccionado. */
  async joinOrMerge() {
    const g = this.geomState();
    if (g.polys.length >= 2 && !g.lines.length) return this.mergeSelected();
    return this.joinSelected();
  }

  /** Join: dos o más líneas en una; una sola línea se cierra. */
  joinSelected() {
    const r = joinPaths(this.history.doc, this.editor.selection, 2 * this.view.mpp);
    this.applyGeom(r, this.geomState().lines.length > 1 ? 'Líneas unidas en una' : 'Trazo cerrado');
  }

  /** Merge: la unión de los polígonos seleccionados. */
  async mergeSelected() {
    const { mergePolygons, loadJsts } = await import('./geomOps.js');
    const r = mergePolygons(await loadJsts(), this.history.doc, this.editor.selection, { tol: this.geomTol() });
    this.applyGeom(r, 'Polígonos fusionados');
  }

  /** Split con las líneas seleccionadas (existentes) sobre los polígonos seleccionados. */
  async splitSelected() {
    const { splitPolygons, selectedLines, loadJsts } = await import('./geomOps.js');
    const tol = this.geomTol();
    const doc = this.history.doc;
    const r = splitPolygons(await loadJsts(), doc, this.editor.selection, selectedLines(doc, this.editor.selection, tol), { tol });
    this.applyGeom(r, `${r.divided || 1} polígono(s) dividido(s)`);
  }

  /** Split dibujando una línea nueva que cruce el polígono (la línea no queda dibujada). */
  splitByDrawing() {
    const polys = this.geomState().polys;
    if (!polys.length) return this.message('Selecciona un polígono para dividir');
    this.editor.beginCut('split', polys.map((p) => p.id));
  }

  /**
   * Split con la línea dibujada al arrastrar: corta lo seleccionado (líneas en
   * los cruces, polígonos de borde a borde) o, sin selección, todo lo visible
   * y desbloqueado que la línea cruza.
   */
  async runCutLine({ kind, pts, alt }) {
    const { splitShapes, reshapeShapes, loadJsts } = await import('./geomOps.js');
    const tol = this.geomTol();
    const doc = this.history.doc;
    const ids = this.editor.selection.size ? new Set(this.editor.selection) : null;
    if (kind === 'reshape') {
      const r = reshapeShapes(doc, ids, pts, { tol, keep: alt ? 'smaller' : 'larger' });
      return this.applyGeom(r, `Reshape: ${r.changed || 1} forma(s) redibujada(s)${alt ? ' (se conservó el trozo menor)' : ''}`);
    }
    const r = splitShapes(await loadJsts(), doc, ids, pts, { tol });
    this.applyGeom(r, `Dividido: ${r.lines ? `${r.lines} línea(s)` : ''}${r.lines && r.polys ? ' y ' : ''}${r.polys ? `${r.polys} polígono(s)` : ''}`);
  }

  /**
   * Un toque con Split: con algo seleccionado, la línea (o contorno) tocada lo
   * corta donde lo cruza; sin selección, el toque selecciona.
   */
  async runCutTouch({ kind, hit, shift }) {
    const ed = this.editor;
    const sel = new Set(ed.selection);
    if (!hit) {
      if (!shift) ed.setSelection([]);
      return;
    }
    if (kind === 'reshape') return ed.setSelection(shift ? [...sel, hit.id] : [hit.id]);
    const targets = new Set([...sel].filter((id) => id !== hit.id));
    if (!targets.size || hit.type !== 'path') {
      ed.setSelection(shift && hit.type === 'path' ? [...sel, hit.id] : [hit.id]);
      return this.message('Dividir: con la línea o el polígono seleccionado, toca otra línea que lo cruce (o arrastra un corte)', 5000);
    }
    const { splitShapes, cutterFromShape, loadJsts } = await import('./geomOps.js');
    const tol = this.geomTol();
    const r = splitShapes(await loadJsts(), this.history.doc, targets, cutterFromShape(hit, tol), { tol });
    if (r.error) {
      // no cruza nada: el toque elige esa línea (si no, con varias seleccionadas no habría forma de quedarse con una)
      ed.setSelection(shift ? [...sel, hit.id] : [hit.id]);
      return this.message(r.error, 6000);
    }
    this.applyGeom(r, `Dividido: ${r.lines ? `${r.lines} línea(s)` : ''}${r.lines && r.polys ? ' y ' : ''}${r.polys ? `${r.polys} polígono(s)` : ''}`);
  }

  /** Hole: al polígono de más abajo se le resta lo que cubren los demás. */
  async holeSelected(keep) {
    const { holePolygons, loadJsts } = await import('./geomOps.js');
    const r = holePolygons(await loadJsts(), this.history.doc, this.editor.selection, { keepCutters: keep, tol: this.geomTol() });
    this.applyGeom(r, 'Hueco hecho');
  }

  /** Hole dibujando el contorno del hueco. */
  holeByDrawing() {
    const polys = this.geomState().polys;
    if (!polys.length) return this.message('Selecciona un polígono para hacerle un hueco');
    this.editor.beginCut('hole', polys.map((p) => p.id));
  }

  /** La forma dibujada para Split / Hole llegó: se aplica y se descarta. */
  async runCut(mode, pts) {
    const { splitPolygons, holeWithPoints, loadJsts } = await import('./geomOps.js');
    const J = await loadJsts();
    const tol = this.geomTol();
    const doc = this.history.doc;
    const ids = new Set(mode.ids);
    const r = mode.kind === 'split' ? splitPolygons(J, doc, ids, [pts], { tol }) : holeWithPoints(J, doc, ids, pts, { tol });
    this.applyGeom(r, mode.kind === 'split' ? 'Polígono dividido' : 'Hueco hecho');
  }

  /** Menú «Geometría»: lo que no aplica a la selección se ve apagado, con la razón en el tooltip. */
  geomMenuItems() {
    const g = this.geomState();
    const item = (label, f, enabled, why, key = '') =>
      h('button', {
        disabled: !enabled,
        title: enabled ? '' : why,
        onclick: () => {
          document.getElementById('menu-geom').hidden = true;
          Promise.resolve(f()).catch((err) => this.message(`Error: ${err.message}`, 6000));
        },
      }, h('span', {}, label), key ? h('kbd', {}, key) : null);
    return [
      h('div', { class: 'mh' }, 'Líneas'),
      item(g.lines.length === 1 ? 'Cerrar trazo (Join)' : 'Unir líneas (Join)', () => this.joinSelected(), g.canJoin, 'Selecciona dos o más líneas (o una para cerrarla)', 'Ctrl+J'),
      item('Invertir dirección', () => this.editor.reverseSelected(), g.lines.length + g.polys.length > 0, 'Selecciona un trazo'),
      h('div', { class: 'mh' }, 'Polígonos'),
      item('Fusionar polígonos (Merge)', () => this.mergeSelected(), g.canMerge, 'Selecciona dos o más polígonos', 'Ctrl+J'),
      item('Dividir (Split): tocar una línea que cruza, o arrastrar un corte…', () => this.editor.setTool('split'), true, '', 'U'),
      item('Reshape: redibujar el contorno con una línea…', () => this.editor.setTool('reshape'), g.lines.length + g.polys.length > 0, 'Selecciona un polígono o una línea', 'R'),
      item('Hueco con la forma de arriba (Hole)', () => this.holeSelected(false), g.canHole, 'Selecciona el polígono y, encima, la forma que lo abre'),
      item('Hueco conservando la forma (Hole)', () => this.holeSelected(true), g.canHole, 'Selecciona el polígono y, encima, la forma que lo abre'),
      item('Hueco dibujando una forma (Hole)…', () => this.holeByDrawing(), g.canHoleDraw, 'Selecciona un polígono'),
      h('div', { class: 'mh' }, 'Selección'),
      item('Transformar: mover, rotar, escalar…', () => this.transformDialog(), this.editor.selection.size > 0, 'Selecciona uno o más objetos', 'Ctrl+Mayús+M'),
      item('Unfreeze nodes (descongelar todos)', () => this.editor.unfreezeSelection(), this.editor.selection.size > 0, 'Selecciona los objetos con nodos congelados'),
      item('Desagrupar todo (todos los niveles)', () => this.ungroupEverything(), this.history.doc.layers.some((l) => l.kind === 'vector' && l.items.some((x) => x.type === 'group')), 'No hay grupos en el documento'),
      item('Borrar vacíos (sin relleno ni trazo)', () => this.deleteEmptyShapes(), true, ''),
      item('Unfreeze all nodes (todo el documento)', () => this.editor.unfreezeAll(), frozenPoints(this.history.doc).length > 0, 'No hay nodos congelados en el documento'),
      h('div', { class: 'mh' }, 'Limpieza'),
      item('Simplificar: menos nodos, misma forma…', () => this.simplifyDialog(), g.lines.length + g.polys.length > 0, 'Selecciona líneas o polígonos'),
      item('Tidy: compartir nodos cercanos…', () => this.tidyDialog(), g.lines.length + g.polys.length > 0, 'Selecciona las líneas o polígonos que deben compartir nodos'),
    ];
  }

  /** Geometría → Desagrupar todo: deshace todos los grupos, anidados incluidos, de todas las capas. */
  ungroupEverything() {
    const r = ungroupAll(this.history.doc);
    if (!r.count) return this.message('No hay grupos en el documento');
    this.history.commit(r.doc);
    this.editor.setSelection([]);
    this.editor.snapDirty = true;
    this.message(`${r.count} grupo(s) deshecho(s), en todos los niveles`);
  }

  /** Geometría → Borrar vacíos: líneas sin trazo y polígonos sin relleno ni trazo. */
  deleteEmptyShapes() {
    const r = deleteEmpty(this.history.doc);
    if (!r.count) return this.message('No hay líneas ni polígonos vacíos (las capas y formas bloqueadas no se tocan)');
    this.history.commit(r.doc);
    this.editor.setSelection([]);
    this.editor.snapDirty = true;
    this.message(`${r.count} objeto(s) vacío(s) borrado(s)`);
  }

  /** Unidad de las distancias de los diálogos: mm de papel en Canvas, metros en GIS. */
  lengthUnit() {
    const gis = this.mode === 'gis';
    return { gis, unit: gis ? 'm' : 'mm', k: gis ? 1 : this.history.doc.refScale / 1000 };
  }

  /** Cuenta los nodos de unas formas. */
  nodeCount(doc, ids) {
    let n = 0;
    for (const { shape } of allTopShapes(doc, { visibleOnly: false })) if (ids.has(shape.id) && shape.type === 'path') n += shape.nodes.length + (shape.holes || []).reduce((a, h) => a + h.length, 0);
    return n;
  }

  /**
   * Simplificar: menos nodos sin perder la forma. Tolerancia con deslizador y
   * vista previa en vivo; los bordes compartidos con otras formas se
   * simplifican igual en todas (por arcos), así no se abre el cierre.
   */
  async simplifyDialog() {
    const ids = new Set(this.editor.selectedShapes().filter((s) => s.type === 'path' && !s.locked).map((s) => s.id));
    if (!ids.size) return this.message('Selecciona líneas o polígonos para simplificar');
    const { gis, unit, k } = this.lengthUnit();
    const mpp = this.view.mpp;
    const round = (v) => Number(v.toPrecision(3));
    this.history.begin();
    const base = this.history.doc;
    const topo = buildTopology(base, ids, Math.min(mpp * 0.35, 0.5));
    const before = this.nodeCount(base, ids);
    const curvy = this.editor.selectedShapes().some((s) => s.type === 'path' && s.nodes.some((n) => n.hIn || n.hOut));
    const run = (v) => {
      const tol = Math.max(1e-9, Number(v.tol) * k);
      const next = smoothTopology(topo, base, (nodes, closed) => simplifyArc(nodes, closed, tol, { curves: v.curves, flat: Math.min(tol / 4, mpp * 0.5) }));
      this.history.preview(next);
      this.message(`Simplificar: ${before} → ${this.nodeCount(next, ids)} nodos`, 0);
      return next;
    };
    const tol0 = round((1.5 * mpp) / k);
    const asked = askForm({
      title: 'Simplificar',
      hint: `Quita los nodos que no hacen falta: ningún punto del trazo se aleja más que la tolerancia. ${ids.size} forma(s), ${before} nodos.`,
      fields: [
        { key: 'tol', label: `Tolerancia (${unit})`, type: 'number', value: tol0, min: round((0.1 * mpp) / k), max: round((40 * mpp) / k), step: gis ? 0.01 : 0.01, unit, log: true },
        { key: 'curves', label: 'Rehacer con curvas suaves (para trazos curvos)', type: 'check', value: curvy },
      ],
      ok: 'Simplificar',
      live: true,
      validate: (v) => (Number(v.tol) > 0 ? '' : 'La tolerancia debe ser mayor que 0.'),
      onchange: (v) => Number(v.tol) > 0 && run(v),
    });
    run({ tol: tol0, curves: curvy }); // vista previa desde que se abre
    const r = await asked;
    if (!r) {
      this.message('');
      return this.history.cancel();
    }
    run(r);
    this.history.end();
    this.editor.snapDirty = true;
    this.message(`Simplificado: ${before} → ${this.nodeCount(this.history.doc, ids)} nodos`, 4000);
  }

  /**
   * Tidy: las líneas y polígonos seleccionados pasan a compartir sus nodos
   * donde están a menos del umbral (fusiona vértices cercanos e inserta en
   * cada borde los vértices del vecino que caen sobre él). Vista previa en vivo.
   */
  async tidyDialog() {
    const ids = new Set(this.editor.selectedShapes().filter((s) => s.type === 'path' && !s.locked).map((s) => s.id));
    if (ids.size < 2) return this.message('Tidy: selecciona dos o más líneas o polígonos (Mayús + clic, o el lazo)');
    const { unit, k } = this.lengthUnit();
    const mpp = this.view.mpp;
    const round = (v) => Number(v.toPrecision(3));
    this.history.begin();
    const base = this.history.doc;
    const run = (v) => {
      const res = tidyShapes(base, ids, Math.max(1e-9, Number(v.tol) * k));
      this.history.preview(res.doc);
      this.message(`Tidy: ${res.merged} grupo(s) de nodos fusionados, ${res.inserted} nodo(s) insertados en bordes vecinos, ${res.shaped} borde(s) con la misma curva`, 0);
      return res;
    };
    const tol0 = round(((this.settings.tidyPx ?? 6) * mpp) / k);
    const asked = askForm({
      title: 'Tidy: compartir nodos cercanos',
      hint: 'Los nodos de formas distintas a menos del umbral se juntan en uno, y los que caen sobre el borde de una vecina se agregan a ese borde. Los bordes comunes comparten también los tiradores de la curva Bézier.',
      fields: [{ key: 'tol', label: `Umbral de cercanía (${unit})`, type: 'number', value: tol0, min: round((0.5 * mpp) / k), max: round((80 * mpp) / k), step: 0.01, unit, log: true }],
      ok: 'Aplicar',
      live: true,
      validate: (v) => (Number(v.tol) > 0 ? '' : 'El umbral debe ser mayor que 0.'),
      onchange: (v) => Number(v.tol) > 0 && run(v),
    });
    run({ tol: tol0 }); // vista previa desde que se abre
    const r = await asked;
    if (!r) {
      this.message('');
      return this.history.cancel();
    }
    const res = run(r);
    this.saveSettings({ tidyPx: Math.round((Number(r.tol) * k) / mpp) });
    this.history.end();
    this.editor.snapDirty = true;
    this.message(res.merged + res.inserted ? `Tidy: ${res.merged} grupo(s) de nodos fusionados, ${res.inserted} insertado(s)` : 'Tidy: no había nodos a menos del umbral', 4000);
  }

  /**
   * Transformar con valores exactos: desplazamiento (mm de papel en Canvas,
   * metros en GIS), rotación y escala, con deslizadores y vista previa en vivo.
   * Aceptar deja un solo paso en el historial; Cancelar no deja nada.
   */
  async transformDialog() {
    const ed = this.editor;
    const ids = new Set(ed.selection);
    const sel = ed.selectedShapes();
    if (!sel.length) return this.message('Selecciona algo para transformar');
    const gis = this.mode === 'gis';
    const k = gis ? 1 : this.history.doc.refScale / 1000; // metros del mundo por unidad mostrada
    const unit = gis ? 'm' : 'mm';
    const box = unionBBox(sel.map((s) => shapeBBox(s, ed.est())));
    const f = (v) => (gis ? Math.round(v) : (v / k).toFixed(1));
    const last = this.lastTransform || {};
    this.history.begin();
    const base = this.history.doc;
    const opts = (v) => ({
      dx: (Number(v.dx) || 0) * k,
      dy: (Number(v.dy) || 0) * k,
      angle: Number(v.angle) || 0,
      sx: (Number(v.sx) || 100) / 100,
      sy: (v.uniform ? Number(v.sx) || 100 : Number(v.sy) || 100) / 100,
      pivot: v.pivot,
      strokes: v.strokes,
    });
    const r = await askForm({
      title: 'Transformar',
      hint: `${sel.length} objeto(s) · ${f(box.w)} × ${f(box.h)} ${unit}. Se aplica en orden: escala, rotación y desplazamiento.`,
      fields: [
        { key: 'dx', label: `Mover → este (${unit})`, type: 'number', value: 0, step: gis ? 1 : 0.5 },
        { key: 'dy', label: `Mover ↑ norte (${unit})`, type: 'number', value: 0, step: gis ? 1 : 0.5 },
        { key: 'angle', label: 'Rotar (°, antihorario)', type: 'number', value: 0, min: -180, max: 180, step: 1, unit: '°' },
        { key: 'sx', label: 'Escala', type: 'number', value: 100, min: 5, max: 500, step: 1, unit: '%', log: true },
        { key: 'uniform', label: 'Escala uniforme (vertical = horizontal)', type: 'check', value: last.uniform ?? true },
        { key: 'sy', label: 'Escala vertical', type: 'number', value: 100, min: 5, max: 500, step: 1, unit: '%', log: true, when: (v) => !v.uniform },
        { key: 'strokes', label: 'Escalar también grosores, tramas, ornamentos y letras', type: 'check', value: last.strokes ?? true },
        { key: 'pivot', label: 'Centro de rotación y escala', type: 'select', value: last.pivot || 'center', options: { center: 'Centro de la selección', each: 'Centro de cada objeto' } },
      ],
      ok: 'Aplicar',
      live: true,
      validate: (v) => (Number(v.sx) > 0 && (v.uniform || Number(v.sy) > 0) ? '' : 'La escala debe ser mayor que 0 %.'),
      onchange: (v) => this.history.preview(transformShapes(base, ids, opts(v), ed.est())),
    });
    if (!r) return this.history.cancel();
    this.lastTransform = { uniform: r.uniform, strokes: r.strokes, pivot: r.pivot };
    this.history.preview(transformShapes(base, ids, opts(r), ed.est()));
    this.history.end();
  }

  lockSelection() {
    const ed = this.editor;
    if (!ed.selection.size) return;
    this.history.commit(setShapeFlag(this.history.doc, ed.selection, 'locked', true));
    ed.setSelection([]);
    this.message('Bloqueado · Ctrl+Alt+2 desbloquea todo');
  }

  hideSelection() {
    const ed = this.editor;
    if (!ed.selection.size) return;
    this.history.commit(setShapeFlag(this.history.doc, ed.selection, 'visible', false));
    ed.setSelection([]);
    this.message('Oculto · Ctrl+Alt+3 muestra todo');
  }

  unlockAll() {
    const r = resetShapeFlag(this.history.doc, 'locked');
    if (!r.ids.length) return this.message('No hay objetos bloqueados');
    this.history.commit(r.doc);
    this.editor.setSelection(r.ids);
  }

  showAll() {
    const r = resetShapeFlag(this.history.doc, 'visible');
    if (!r.ids.length) return this.message('No hay objetos ocultos');
    this.history.commit(r.doc);
    this.editor.setSelection(r.ids);
  }

  /* ------------------------------------------------------ portapapeles */

  setupClipboard() {
    const editable = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const put = (e, svg) => {
      if (!svg) return;
      e.clipboardData.setData('text/plain', svg);
      try {
        e.clipboardData.setData('image/svg+xml', svg);
      } catch {
        /* tipo no admitido por el navegador: basta el texto */
      }
      e.preventDefault();
    };
    document.addEventListener('copy', (e) => {
      if (editable(e.target) || !this.editor.selection.size) return;
      put(e, this.copy({ toSystem: false }));
    });
    document.addEventListener('cut', (e) => {
      if (editable(e.target) || !this.editor.selection.size) return;
      put(e, this.cut({ toSystem: false }));
    });
    document.addEventListener('paste', (e) => {
      if (editable(e.target)) return;
      e.preventDefault();
      const dt = e.clipboardData;
      const inPlace = !!this.pasteInPlaceNext;
      this.pasteInPlaceNext = false;
      let text = dt?.getData('image/svg+xml') || dt?.getData('text/plain') || '';
      const html = dt?.getData('text/html') || '';
      // el código SVG puede venir bajo otro nombre de formato (según versión de Illustrator y sistema)
      if (!/<svg[\s>]/i.test(text) && !/<svg[\s>]/i.test(html)) {
        for (const t of dt?.types || []) {
          if (/^(Files|text\/(plain|html)|image\/svg\+xml)$/.test(t)) continue;
          const v = dt.getData(t);
          if (/<svg[\s>]/i.test(v)) text = v;
        }
      }
      const types = [...(dt?.types || [])];
      const files = [...(dt?.files || []), ...[...(dt?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile())];
      const img = files.find((f) => f && /^image\//.test(f.type) && f.type !== 'image/svg+xml');
      const run = async () => {
        if (img && !/<svg[\s>]/i.test(text) && !/<svg[\s>]/i.test(html)) {
          // Illustrator con «Incluir código SVG» manda también una imagen: antes de dejarla como capa de
          // imagen (no se mueve ni escala), se busca el SVG por la API asíncrona del portapapeles
          const viaApi = await this.readSvgFromClipboardApi();
          if (viaApi) return this.pasteText(viaApi, inPlace);
          return this.imageOnlyPaste(img, types);
        }
        if (/<svg[\s>]/i.test(text || html)) return this.pasteText(/<svg[\s>]/i.test(text) ? text : html, inPlace);
        // una imagen dentro de HTML (<img src="data:...">) copiada de una página o documento
        const m = /<img[^>]+src=["'](data:image\/[^"']+)["']/i.exec(html);
        if (m && !this.clipboard.length) return this.pasteImage(await (await fetch(m[1])).blob());
        return this.pasteText(text || html, inPlace);
      };
      run().catch((err) => this.message(`Pegar: ${err.message}`, 6000));
    });
  }

  /* ------------------------------------------------------ ayuda */

  /** Globos de ayuda con el atajo, solo con ratón (en tablet estorban). */
  setupTooltips() {
    const tip = document.getElementById('tip');
    let t = null;
    let cur = null;
    const hide = () => {
      clearTimeout(t);
      tip.hidden = true;
      cur = null;
    };
    document.addEventListener('pointerover', (e) => {
      if (e.pointerType !== 'mouse') return;
      const el = e.target.closest?.('[data-tip]');
      if (el === cur) return;
      hide();
      if (!el) return;
      cur = el;
      t = setTimeout(() => {
        const [label, key] = el.dataset.tip.split(/\s{2,}/);
        tip.replaceChildren(h('span', {}, label), key ? h('kbd', {}, key) : '');
        tip.hidden = false;
        const r = el.getBoundingClientRect();
        const w = tip.offsetWidth;
        const hgt = tip.offsetHeight;
        const vertical = el.closest('#toolbar');
        let x = vertical ? r.right + 8 : r.left + r.width / 2 - w / 2;
        let y = vertical ? r.top + r.height / 2 - hgt / 2 : r.bottom + 8;
        if (y + hgt > window.innerHeight - 4) y = r.top - hgt - 8;
        x = Math.max(4, Math.min(x, window.innerWidth - w - 4));
        tip.style.left = `${x}px`;
        tip.style.top = `${Math.max(4, y)}px`;
      }, 450);
    });
    document.addEventListener('pointerdown', hide, true);
    document.addEventListener('pointerout', (e) => {
      if (cur && !cur.contains(e.relatedTarget)) hide();
    });
  }

  toggleHelp(force) {
    const el = document.getElementById('help');
    const show = force ?? el.hidden;
    if (!show) {
      el.hidden = true;
      return;
    }
    if (!el.childElementCount) el.append(...helpContent(() => this.toggleHelp(false)));
    el.onpointerdown = (e) => e.target === el && this.toggleHelp(false);
    el.hidden = false;
  }

  /* --------------------------------------------------------- edición */

  /** Cambia el estilo de la selección (todas las hojas de los grupos) o el de dibujo. */
  /** Trazos libres seleccionados que aún se pueden re-suavizar (recién dibujados y sin editar). */
  resmoothable() {
    return this.editor.selectedShapes().filter(canSmooth);
  }

  /** Suavizado actual: el del trazo libre seleccionado, o el que se usará al dibujar. */
  smoothLevel() {
    const sel = this.resmoothable();
    if (sel.length) return canResmooth(sel[0]) ? sel[0].freehand.level : 0; // una línea que no es trazo libre parte de «tal cual está»
    return this.settings.pencilSmooth ?? DEFAULT_SMOOTH;
  }

  /**
   * Nivel de suavizado (0–100 %). Es el de por defecto para los próximos trazos
   * libres y, si hay trazos libres recién dibujados seleccionados, los
   * re-suaviza en vivo a partir de los puntos originales.
   */
  setSmooth(level, final) {
    level = Math.max(0, Math.min(100, Math.round(level)));
    const targets = this.resmoothable();
    // es también el valor de los próximos trazos libres, salvo que solo se esté suavizando una línea ajena (pluma, importada…)
    if (!targets.length || targets.some(canResmooth) || this.editor.tool === 'pencil') this.saveSettings({ pencilSmooth: level });
    if (!targets.length) return;
    if (!final && !this.history.anchor) this.history.begin();
    const base = this.history.anchor || this.history.doc;
    const ids = targets.map((s) => s.id);
    // nodos compartidos con otras líneas o polígonos (misma tolerancia que Move Joined): se suavizan por arcos, sin romper el cierre
    const key = ids.join();
    if (this.smoothTopoCache?.base !== base || this.smoothTopoCache.key !== key) this.smoothTopoCache = { base, key, topo: buildTopology(base, ids, Math.min(this.view.mpp * 0.35, 0.5)) };
    const topo = this.smoothTopoCache.topo;
    const next = topo.sharesNodes
      ? smoothTopology(topo, base, (nodes, closed) => smoothArcLevel(nodes, closed, level, this.view.mpp))
      : mapShapes(base, ids, (s) => resmooth(adoptFreehand(s, this.view.mpp), level));
    if (final) {
      if (this.history.anchor) {
        this.history.preview(next);
        this.history.end();
      } else this.history.commit(next);
    } else this.history.preview(next);
  }

  /** Control de suavizado (lápiz activo o trazo libre seleccionado); null si no viene al caso. */
  smoothControl() {
    if (this.editor.tool === 'drag') {
      // Drag: alcance del gradiente a lo largo del trazo
      const val = h('span', { class: 'pb-u pb-val' }, `${this.settings.dragReach} %`);
      const r = h('input', { type: 'range', class: 'pb-range pb-wide', min: 5, max: 100, step: 1, value: this.settings.dragReach, 'data-tip': 'Alcance: 100 % = el gradiente llega hasta los extremos de la línea (que quedan fijos) o al punto opuesto del polígono; menos = movimiento más localizado alrededor del nodo ([ y ])' });
      r.addEventListener('input', () => {
        val.textContent = `${r.value} %`;
        this.saveSettings({ dragReach: Number(r.value) });
      });
      const joined = this.settings.moveJoined !== false;
      const mj = h('button', { class: `pb-btn${joined ? ' pb-on' : ''}`, 'data-tip': 'Move Joined: arrastrar también los nodos que otras líneas y polígonos comparten (mantiene el cierre topológico)', onclick: () => (this.saveSettings({ moveJoined: !joined }), this.renderPropbar()) }, joined ? 'Move Joined ✓' : 'Move Joined');
      return [h('span', { class: 'pb-l' }, 'Alcance'), r, val, mj];
    }
    if (this.editor.tool === 'deform') {
      // Deform: radio del área de influencia (también con [ y ]) y si arrastra lo compartido
      const val = h('span', { class: 'pb-u pb-val' }, `${this.settings.deformRadius} px`);
      const r = h('input', { type: 'range', class: 'pb-range pb-wide', min: 10, max: 300, step: 1, value: this.settings.deformRadius, 'data-tip': 'Área de influencia: los nodos dentro del círculo se mueven, más cuanto más cerca de donde se toma ([ y ] la achican o agrandan)' });
      r.addEventListener('input', () => {
        val.textContent = `${r.value} px`;
        this.saveSettings({ deformRadius: Number(r.value) });
        this.editor.changed();
      });
      const joined = this.settings.moveJoined !== false;
      const mj = h('button', { class: `pb-btn${joined ? ' pb-on' : ''}`, 'data-tip': 'Move Joined: arrastrar también los nodos que otras líneas y polígonos comparten con la selección (mantiene el cierre topológico)', onclick: () => (this.saveSettings({ moveJoined: !joined }), this.renderPropbar()) }, joined ? 'Move Joined ✓' : 'Move Joined');
      return [h('span', { class: 'pb-l' }, 'Radio'), r, val, mj];
    }
    if (this.editor.tool === 'smooth') {
      // pincel de Suavizar: intensidad y radio
      const range = (key, min, max, label, tip, unit) => {
        const val = h('span', { class: 'pb-u pb-val' }, `${this.settings[key]}${unit}`);
        const r = h('input', { type: 'range', class: 'pb-range', min, max, step: 1, value: this.settings[key], 'data-tip': tip });
        r.addEventListener('input', () => {
          val.textContent = `${r.value}${unit}`;
          this.saveSettings({ [key]: Number(r.value) });
          this.editor.changed();
        });
        return [h('span', { class: 'pb-l' }, label), r, val];
      };
      return [
        ...range('smoothLevel', 1, 100, 'Intensidad', 'Cuánto suaviza cada pasada del pincel (pasar de nuevo suaviza más)', ' %'),
        ...range('smoothRadius', 6, 80, 'Radio', 'Tamaño del pincel en píxeles', ' px'),
      ];
    }
    if (this.editor.tool !== 'pencil' && !this.resmoothable().length) return null;
    const n = this.resmoothable().length;
    const level = this.smoothLevel();
    const val = h('span', { class: 'pb-u pb-val' }, `${level} %`);
    const r = h('input', { type: 'range', class: 'pb-range', min: 0, max: 100, step: 1, value: level, 'data-tip': n ? `Suavizado de la selección (${n} línea${n > 1 ? 's' : ''}): 0 = tal cual está, 100 = muy redondeado. Se aplica en vivo a cualquier línea o polígono; con el lápiz es también el valor para los próximos trazos.` : 'Suavizado del trazo libre: 0 = tal cual se dibujó, 100 = muy redondeado. Es el valor para los próximos trazos.' });
    r.addEventListener('input', () => {
      val.textContent = `${r.value} %`;
      this.setSmooth(Number(r.value), false);
    });
    r.addEventListener('change', () => this.setSmooth(Number(r.value), true));
    return [h('span', { class: 'pb-l' }, 'Suavizado'), r, val];
  }

  editStyle(patch, final) {
    const ed = this.editor;
    const sel = ed.selectedShapes();
    if (!sel.length) {
      this.setCurrentStyle({ ...this.currentStyle, ...patch }, { render: final });
      return;
    }
    if (!final && !this.history.anchor) this.history.begin();
    const base = this.history.anchor || this.history.doc;
    const apply = (s) => {
      if (s.type === 'group') return { ...s, children: s.children.map((c, i) => (s.clip && i === 0 ? c : apply(c))) };
      return { ...s, style: { ...s.style, ...patch } };
    };
    const next = mapShapes(base, sel.map((s) => s.id), apply);
    if (final) {
      if (this.history.anchor) {
        this.history.preview(next);
        this.history.end();
      } else this.history.commit(next);
    } else this.history.preview(next);
  }

  /**
   * Copia lo seleccionado. Además del portapapeles interno, deja en el del
   * sistema un SVG en puntos (Illustrator lo pega como dibujo editable) que
   * lleva dentro las formas de GISDrawer (al pegarlo aquí vuelve exacto y
   * georreferenciado). Devuelve ese SVG.
   */
  copy({ toSystem = true } = {}) {
    this.clipboard = copyShapes(this.history.doc, this.editor.selection);
    this.pasteN = 0;
    this.updateContextBar();
    if (!this.clipboard.length) return null;
    const svg = selectionSvg(this.clipboard, { refScale: this.history.doc.refScale, est: this.editor.est(), name: this.layerOf(this.clipboard[0].id)?.name || 'GISDrawer' });
    if (toSystem && svg) navigator.clipboard?.writeText(svg).catch(() => null);
    this.message(`${this.clipboard.length} objeto(s) copiado(s) · se pueden pegar en Illustrator`);
    return svg;
  }

  cut(opts) {
    const svg = this.copy(opts);
    this.editor.deleteSelection();
    return svg;
  }

  /**
   * Pega un recorte (captura de pantalla o imagen copiada). Una imagen sin
   * georreferencia casi siempre es un mapa o una figura que hay que ubicar:
   * se ofrece georreferenciarla; si no, queda como capa de imagen en la vista
   * (y se puede georreferenciar después desde Archivo).
   */
  async pasteImage(file, { georef = false } = {}) {
    const n = this.history.doc.layers.filter((l) => l.kind === 'image').length + 1;
    const name = `Recorte ${n}`;
    if (georef) return this.startGeoref(file);
    const bitmap = await createImageBitmap(file);
    const v = this.view;
    const wM = Math.min(v.w * 0.6, (v.h * 0.6 * bitmap.width) / bitmap.height) * v.mpp;
    const hM = (wM * bitmap.height) / bitmap.width;
    const bounds = [v.cx - wM / 2, v.cy - hM / 2, v.cx + wM / 2, v.cy + hM / 2];
    const fileId = newId('F');
    const rec = { kind: 'image', name, format: 'bitmap', mime: file.type, buffer: await file.arrayBuffer(), bounds };
    imageFiles.set(fileId, { bitmap, x0: bounds[0], y0: bounds[1], x1: bounds[2], y1: bounds[3] });
    await saveFile(fileId, rec);
    const l = makeRasterLayer('image', name, { fileId });
    const doc = this.history.doc;
    const layers = doc.layers.slice();
    const fv = layers.findIndex((x) => x.kind === 'vector');
    layers.splice(fv < 0 ? layers.length : fv, 0, l);
    this.history.commit({ ...doc, layers });
    this.lastPastedImage = file;
    this.message(`Imagen pegada como capa «${name}» en el centro de la vista.${this.mode === 'gis' ? ' Para ubicarla con precisión: Archivo → Georreferenciar imagen.' : ''}`, 7000);
  }

  /**
   * Lo copiado solo trae una imagen (Illustrator deja el SVG en un formato propio que el navegador no
   * puede leer): en vez de crear en silencio una capa de imagen fija, se explica y se ofrece la vía vectorial.
   */
  async imageOnlyPaste(img, types = []) {
    const pick = await askChoice({
      title: 'Solo llegó una imagen, no el dibujo vectorial',
      hint: `El navegador no puede leer el SVG que Illustrator deja en el portapapeles (formatos recibidos: ${types.join(', ') || 'ninguno'}). Para traer el dibujo vectorial y editable: en Illustrator, Archivo → Exportar → Exportar selección (o Exportar como) → SVG, o guarda el .ai, y elígelo aquí.`,
      items: [
        { value: 'file', label: 'Importar un archivo .svg / .ai / .pdf…', hint: 'Dibujo vectorial editable, una capa por capa de Illustrator' },
        { value: 'image', label: 'Pegar solo como imagen', hint: 'Capa de imagen fija: no se puede mover ni escalar sin georreferenciar' },
      ],
      cancel: 'Cancelar',
    });
    if (pick === 'file') return this.importSvgFile();
    if (pick === 'image') return this.pasteImage(img);
  }

  /** Busca código SVG en cualquier formato del portapapeles con la API asíncrona (puede pedir permiso). */
  async readSvgFromClipboardApi() {
    try {
      for (const item of (await navigator.clipboard?.read?.()) || []) {
        for (const t of item.types) {
          if (/^(image\/(png|jpeg|gif|webp|bmp))$/.test(t)) continue;
          const v = await (await item.getType(t)).text();
          if (/<svg[\s>]/i.test(v)) return v;
        }
      }
    } catch {
      /* sin permiso o sin API */
    }
    return '';
  }

  /** Pegar desde un botón o Ctrl+F/B: el portapapeles del sistema si se puede leer, si no el interno. */
  async paste(inPlace, where = 'front') {
    let text = '';
    try {
      if (navigator.clipboard?.read) {
        for (const item of await navigator.clipboard.read()) {
          const img = item.types.find((t) => /^image\//.test(t) && t !== 'image/svg+xml');
          if (item.types.includes('image/svg+xml')) text = await (await item.getType('image/svg+xml')).text();
          else if (item.types.includes('text/plain')) text = await (await item.getType('text/plain')).text();
          // el código SVG puede llegar solo como HTML (algunas versiones de Illustrator y navegadores)
          if (!/<svg[\s>]/i.test(text) && item.types.includes('text/html')) {
            const html = await (await item.getType('text/html')).text();
            if (/<svg[\s>]/i.test(html)) text = html;
          }
          if (img && !/<svg[\s>]/i.test(text)) return this.imageOnlyPaste(await item.getType(img), item.types);
        }
      } else text = (await navigator.clipboard?.readText()) || '';
    } catch {
      try {
        text = (await navigator.clipboard?.readText()) || '';
      } catch {
        /* sin permiso: queda el portapapeles interno */
      }
    }
    return this.pasteText(text, inPlace, where);
  }

  /**
   * Pega texto del portapapeles: SVG (de Illustrator, Inkscape, un navegador
   * o el propio GISDrawer) se convierte en dibujo; cualquier otra cosa deja
   * pasar al portapapeles interno.
   */
  async pasteText(text, inPlace = false, where = 'front') {
    if (/<svg[\s>]/i.test(text || '')) {
      const { importSvg } = await import('./io/svgImport.js');
      const doc = this.history.doc;
      const r = importSvg(text, { refScale: doc.refScale, center: [this.view.cx, this.view.cy] });
      if (r.gisdrawer) {
        this.clipboard = r.gisdrawer.shapes;
        this.pasteN = 0;
        return this.pasteInternal(inPlace, where);
      }
      if (!r.shapes.length) return this.message('El SVG del portapapeles no trae formas');
      const layer = this.editor.ensureDrawableLayer();
      if (!layer) return;
      const ids = new Set(r.shapes.map((x) => x.id));
      const next = addShapes(doc, layer.id, r.shapes);
      this.history.commit(where === 'back' ? arrange(next, ids, 'back') : next);
      this.editor.setSelection(ids);
      this.editor.snapDirty = true;
      const [w, hgt] = r.sizeMm;
      this.message(`${r.shapes.length} objeto(s) pegados desde SVG (${w.toFixed(0)} × ${hgt.toFixed(0)} mm de papel a 1:${doc.refScale.toLocaleString('es-CL')})${r.warnings.length ? ` · ${r.warnings.join(' · ')}` : ''}`, r.warnings.length ? 9000 : 4000);
      return;
    }
    if (this.clipboard.length) return this.pasteInternal(inPlace, where);
    this.message('El portapapeles no trae dibujo. Desde Illustrator: Preferencias → Gestión del portapapeles → «Copiar como: código SVG».', 9000);
  }

  pasteInternal(inPlace, where = 'front') {
    if (!this.clipboard.length) return;
    const layer = this.editor.ensureDrawableLayer();
    if (!layer) return;
    const r = pasteShapes(this.history.doc, this.clipboard, layer.id, { inPlace, offset: inPlace ? 0 : 12 * this.view.mpp * (this.pasteN = (this.pasteN || 0) + 1) });
    const ids = new Set(r.ids);
    this.history.commit(where === 'back' ? arrange(r.doc, ids, 'back') : r.doc);
    this.editor.setSelection(ids);
  }

  commandKey(e) {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const ed = this.editor;
    const doc = this.history.doc;
    const run = (f) => {
      e.preventDefault();
      f();
    };
    if (!mod) return;
    if (e.key === 'F10') return run(() => this.showPanel('style'));
    if (k === 'z' && !e.shiftKey) return run(() => this.history.undo());
    if ((k === 'z' && e.shiftKey) || k === 'y') return run(() => this.history.redo());
    // Ctrl+C/X/V los atienden los eventos copy/cut/paste del navegador (ver
    // setupClipboard): son los únicos que leen y escriben el portapapeles del
    // sistema sin pedir permiso, y por ahí entra lo copiado en Illustrator.
    if (k === 'c' || k === 'x') return;
    if (k === 'v') {
      this.pasteInPlaceNext = e.shiftKey || e.altKey;
      return;
    }
    // Ctrl+F / Ctrl+B: pegar en el lugar, delante o detrás (Illustrator)
    if (k === 'f') return run(() => this.paste(true));
    if (k === 'b') return run(() => this.paste(true, 'back'));
    // Ctrl+S+D (S y luego D, sin soltar Ctrl): guardar en Google Drive, en el mismo archivo
    if (k === 'd' && this.sChordT) {
      clearTimeout(this.sChordT);
      this.sChordT = null;
      return run(() => this.saveToDrive().catch((err) => this.message(`Error: ${err.message}`, 6000)));
    }
    if (k === 'd') return run(() => ed.duplicate());
    if (k === 'm' && e.shiftKey) return run(() => this.transformDialog());
    if (k === 'a' && e.shiftKey) return run(() => ed.setSelection([]));
    if (k === 'a') return run(() => ed.selectAll());
    if (k === 's' && e.shiftKey) return run(() => this.saveProject({ as: true }).catch((err) => this.message(`Error: ${err.message}`, 6000)));
    if (k === 's') {
      // Ctrl+S: guardado rápido en el mismo archivo. Se espera un instante por si sigue la D (Ctrl+S+D = Drive)
      return run(() => {
        clearTimeout(this.sChordT);
        this.sChordT = setTimeout(() => {
          this.sChordT = null;
          this.saveProject().catch((err) => this.message(`Error: ${err.message}`, 6000));
        }, 450);
      });
    }
    if (k === 'o') return run(() => this.openProject().catch((err) => this.message(`Error: ${err.message}`, 6000)));
    if (k === 'p') return run(() => this.showPanel('layout'));
    if (k === 'j') return run(() => this.joinOrMerge());
    if (k === 'l')
      return run(() => {
        const l = makeVectorLayer(`Capa ${doc.layers.filter((x) => x.kind === 'vector').length + 1}`);
        this.history.commit(addLayer(doc, l, doc.activeLayerId));
        this.message(`Nueva capa: ${l.name}`);
      });
    if (e.code === 'Digit1') return run(() => this.view.setScale(doc.refScale));
    if (e.code === 'Digit2') return run(() => (e.altKey ? this.unlockAll() : this.lockSelection()));
    if (e.code === 'Digit3') return run(() => (e.altKey ? this.showAll() : this.hideSelection()));
    if (k === 'g' && !e.shiftKey)
      return run(() => {
        const r = group(doc, ed.selection);
        if (r.id) {
          this.history.commit(r.doc);
          ed.setSelection([r.id]);
        }
      });
    if (k === 'g' && e.shiftKey)
      return run(() => {
        const r = ungroup(doc, ed.selection);
        if (r.ids.size) {
          this.history.commit(r.doc);
          ed.setSelection(r.ids);
        }
      });
    if (e.code === 'Digit7')
      return run(() => {
        const r = e.altKey ? ungroup(doc, ed.selection) : group(doc, ed.selection, { clip: true });
        if (r.error) return this.message(r.error);
        if (r.id || r.ids?.size) {
          this.history.commit(r.doc);
          ed.setSelection(r.id ? [r.id] : r.ids);
        }
      });
    if (e.code === 'BracketRight') return run(() => this.history.commit(arrange(doc, ed.selection, e.shiftKey ? 'front' : 'forward')));
    if (e.code === 'BracketLeft') return run(() => this.history.commit(arrange(doc, ed.selection, e.shiftKey ? 'back' : 'backward')));
    if (k === '0') return run(() => this.zoomToShapes(allTopShapes(doc).map((x) => x.shape)));
    if (k === '=' || k === '+') return run(() => this.view.zoomAt(1 / 1.5));
    if (k === '-') return run(() => this.view.zoomAt(1.5));
  }

  /** Atajos de una tecla que no son herramientas (X, Mayús+X, D, /, Tab, ?, F1, F7). */
  plainKey(e) {
    const run = (f) => {
      e.preventDefault();
      f();
      return true;
    };
    if (e.key === '?' || e.key === 'F1') return run(() => this.toggleHelp());
    if (e.key === 'Tab' && (document.activeElement === document.body || !document.activeElement)) return run(() => this.togglePanel());
    if (e.key === 'F7') return run(() => this.showPanel('layers'));
    if (e.key === '/') return run(() => this.noneColor());
    const k = e.key.toLowerCase();
    if (k === 'x' && e.shiftKey) return run(() => this.swapColors());
    if (k === 'x') return run(() => this.setSwatchFront(this.swatchFront === 'fill' ? 'stroke' : 'fill'));
    if (k === 'd' && !e.shiftKey) return run(() => this.defaultColors());
    // [ y ]: radio de Deform y del pincel de Suavizar
    if ((e.key === '[' || e.key === ']') && this.editor.tool === 'drag') {
      const v = Math.max(5, Math.min(100, this.settings.dragReach + (e.key === ']' ? 10 : -10)));
      return run(() => {
        this.saveSettings({ dragReach: v });
        this.renderPropbar();
        this.message(`Alcance: ${v} %`, 1200);
      });
    }
    if ((e.key === '[' || e.key === ']') && (this.editor.tool === 'deform' || this.editor.tool === 'smooth')) {
      const key = this.editor.tool === 'deform' ? 'deformRadius' : 'smoothRadius';
      const [lo, hi] = key === 'deformRadius' ? [10, 300] : [6, 80];
      const v = Math.max(lo, Math.min(hi, Math.round(this.settings[key] * (e.key === ']' ? 1.2 : 1 / 1.2))));
      return run(() => {
        this.saveSettings({ [key]: v });
        this.renderPropbar();
        this.editor.changed();
        this.message(`Radio: ${v} px`, 1200);
      });
    }
    return false;
  }

  /* --------------------------------------------------------- texto */

  /**
   * Cuadro de edición de texto sobre el mapa. Se abre con la letra a un
   * tamaño legible (no el del mapa, que puede ser diminuto), crece con lo que
   * se escribe y se cierra con Enter (Mayús+Enter = salto de línea), Esc o
   * tocando fuera.
   */
  editText(shape, isNew = false) {
    const host = document.getElementById('text-editor').parentElement;
    const [x, y] = this.view.toScreen(shape.x, shape.y);
    const fpx = Math.max(15, Math.min(40, shape.fontSize * paperUnits(this.view, this.history.doc.refScale).ptToPx));
    this.closeTextEditor?.();
    const color = shape.style?.fill && shape.style.fill !== 'none' ? shape.style.fill : '#111827';
    const ed = openRichEditor({
      host,
      rect: { left: Math.max(4, Math.min(x - 8, this.view.w - 260)), top: Math.max(4, y - fpx * 1.35), width: Math.min(this.view.w - 16, Math.max(260, (shape.text || '').split('\n').reduce((m, l) => Math.max(m, l.length), 9) * fpx * 0.62 + 20)) },
      shape,
      fontPx: fpx,
      color,
      isNew,
      onDone: (res) => {
        this.closeTextEditor = null;
        const current = findTopShape(this.history.doc, shape.id)?.shape;
        if (!current) return;
        // Esc descarta: un texto nuevo desaparece, uno existente queda como estaba
        if ((!res && isNew) || (res && !res.text.trim())) {
          this.history.commit(mapShapes(this.history.doc, [shape.id], () => null));
          this.editor.setSelection([]);
          return;
        }
        if (!res) return;
        const runs = res.runs;
        if (res.text !== current.text || JSON.stringify(runs) !== JSON.stringify(current.runs || [])) {
          this.history.commit(mapShapes(this.history.doc, [shape.id], (s) => {
            const n = { ...s, text: res.text, name: res.text.split('\n')[0].slice(0, 40) };
            if (runs.length) n.runs = runs;
            else delete n.runs;
            return n;
          }));
        }
        if (isNew) this.editor.setTool('select');
      },
    });
    this.closeTextEditor = () => ed.close(true);
  }

  /* --------------------------------------------------------- vista */

  zoomToShapes(shapes) {
    const box = unionBBox(shapes.map((s) => shapeBBox(s, this.editor.est())));
    if (box) this.view.fit(box.w || box.h ? box : { x: box.x - 500, y: box.y - 500, w: 1000, h: 1000 });
  }

  zoomToImage(layer) {
    const img = imageRect(layer);
    if (img) this.view.fit({ x: img.x0, y: img.y0, w: img.x1 - img.x0, h: img.y1 - img.y0 });
  }

  async gotoCoords() {
    const t = await askText('Ir a coordenadas', '', {
      placeholder: '33°27\'12"S, 70°40\'W  ·  -33.45, -70.67  ·  346000 6297000',
      hint: '«lat, lon» en grados (decimales o con °\'") o «E N» en metros UTM 19S.',
      ok: 'Ir',
      preview: coordPreview,
      validate: (v) => (parseCoordText(v) ? '' : 'No entiendo esas coordenadas.'),
    });
    const xy = t && parseCoordText(t);
    if (!xy) return;
    [this.view.cx, this.view.cy] = xy;
    if (this.view.mpp > 20) this.view.mpp = 10;
    this.view.emit();
  }

  /**
   * Sistema de coordenadas de un archivo que no lo declara: lista de los
   * habituales en Chile y un código EPSG libre, validado.
   */
  async askEpsg(title, value = 32719) {
    const common = {
      32719: 'WGS84 / UTM 19S (32719)',
      32718: 'WGS84 / UTM 18S (32718)',
      32720: 'WGS84 / UTM 20S (32720)',
      4326: 'WGS84 geográficas, lat/lon (4326)',
      24879: 'PSAD56 / UTM 19S (24879)',
      24878: 'PSAD56 / UTM 18S (24878)',
      29189: 'SAD69 / UTM 19S (29189)',
      31979: 'SIRGAS 2000 / UTM 19S (31979)',
      3857: 'Web Mercator (3857)',
      other: 'Otro código EPSG…',
    };
    const r = await askForm({
      title,
      fields: [
        { key: 'pick', label: 'Sistema', type: 'select', options: common, value: common[value] ? value : 'other' },
        { key: 'code', label: 'EPSG (si es «otro»)', type: 'text', value: common[value] ? '' : String(value), placeholder: 'p. ej. 32719' },
      ],
      validate: (v) => (v.pick !== 'other' || proj4Def(v.code) ? '' : 'Código EPSG no reconocido (UTM WGS84, PSAD56, SAD69, SIRGAS, 4326 o 3857).'),
    });
    if (!r) return null;
    return Number(r.pick === 'other' ? r.code : r.pick);
  }

  async startGeoref(file = null) {
    const { startGeoref } = await import('./ui/georefSession.js');
    return startGeoref(this, file);
  }

  layoutPanel() {
    return this.layout.panel();
  }

  /* --------------------------------------------------------- archivos */

  /** Cierra los editores de texto abiertos (confirmando lo escrito) para que el guardado no pierda nada. */
  flushEdits() {
    this.closeTextEditor?.();
    this.layout?.closeEditor?.();
  }

  /**
   * Registro de un archivo raster para incrustarlo en el proyecto: el de
   * IndexedDB o, si aún no se escribió allí (recién pegado, importación de PDF
   * en curso) o falló, la imagen que está en memoria codificada como PNG.
   */
  async fileRecord(id) {
    const rec = await loadFile(id);
    if (rec?.buffer) return rec;
    const img = imageFiles.get(id);
    if (!img?.bitmap) return null;
    const c = new OffscreenCanvas(img.bitmap.width, img.bitmap.height);
    c.getContext('2d').drawImage(img.bitmap, 0, 0);
    const blob = await c.convertToBlob({ type: 'image/png' });
    return { kind: 'image', name: 'imagen.png', format: 'bitmap', mime: 'image/png', buffer: await blob.arrayBuffer(), bounds: [img.x0, img.y0, img.x1, img.y1] };
  }

  /** Proyecto como Blob, con sus imágenes y modelos de elevación incrustados; avisa si alguno no pudo ir. */
  async projectBlob() {
    this.flushEdits();
    const r = await packProject(this.history.doc, (id) => this.fileRecord(id));
    if (r.missing.length) this.message(`Atención: no se pudo incrustar el archivo de ${r.missing.length} capa(s) (${r.missing.slice(0, 3).join(', ')}); en otro equipo esas capas quedarán vacías. Vuelve a importarlas y guarda de nuevo.`, 12000);
    return r;
  }

  /** ¿El navegador deja escribir de nuevo en el mismo archivo? (Chrome / Edge de escritorio) */
  get canWriteFiles() {
    return typeof window.showSaveFilePicker === 'function';
  }

  /** Archivo del disco ligado al proyecto (para Ctrl+S); se recuerda por proyecto en el navegador. */
  async setFileHandle(handle) {
    this.fileHandle = handle || null;
    const id = this.history.doc.projectId;
    if (id) await putDocKey(`handle:${id}`, this.fileHandle).catch(() => null);
  }

  async restoreFileHandle() {
    this.fileHandle = null;
    const id = this.history.doc.projectId;
    if (!id || !this.canWriteFiles) return;
    const h = await getDocKey(`handle:${id}`).catch(() => null);
    if (h && typeof h.createWritable === 'function') this.fileHandle = h;
  }

  /**
   * Guardar proyecto. Ctrl+S: en el MISMO archivo de la última vez (abierto o
   * guardado), sin preguntar; la primera vez, o con «Guardar como…»
   * (Ctrl+Mayús+S), se elige dónde. Donde el navegador no deja escribir en
   * un archivo (Safari, Firefox, iPad) se descarga una copia.
   */
  async saveProject({ as = false } = {}) {
    const doc = this.history.doc;
    const r = await this.projectBlob();
    const suggested = /\.gisdrawer$/i.test(doc.fileName || '') ? doc.fileName : `${fileBase(doc.title)}.gisdrawer`;
    const size = r.count ? ` con ${r.count} archivo(s) raster (${(r.blob.size / 1048576).toFixed(1)} MB)` : '';
    if (this.canWriteFiles) {
      let handle = as ? null : this.fileHandle;
      if (handle) {
        // el permiso de escritura puede haber vencido (otra sesión): se vuelve a pedir
        const ok = (await handle.queryPermission?.({ mode: 'readwrite' })) === 'granted' || (await handle.requestPermission?.({ mode: 'readwrite' })) === 'granted';
        if (!ok) handle = null;
      }
      if (!handle) {
        try {
          handle = await window.showSaveFilePicker({ suggestedName: suggested, types: [{ description: 'Proyecto GISDrawer', accept: { 'application/json': ['.gisdrawer'] } }] });
        } catch (err) {
          if (err?.name === 'AbortError') return;
          throw err;
        }
      }
      const w = await handle.createWritable();
      await w.write(r.blob);
      await w.close();
      await this.setFileHandle(handle);
      this.history.silent({ ...this.history.doc, fileName: handle.name });
      rememberProject(this.history.doc, { name: handle.name, source: 'archivo' }).catch(() => null);
      if (!r.missing.length) this.message(`Guardado en ${handle.name}${size}`, 3000);
      return;
    }
    download(r.blob, suggested, 'application/json');
    this.history.silent({ ...this.history.doc, fileName: suggested });
    rememberProject(this.history.doc, { name: suggested, source: 'archivo' }).catch(() => null);
    if (!r.missing.length) this.message(`Proyecto descargado${size}. Este navegador no deja escribir en el mismo archivo: guarda una copia nueva (el trabajo además queda guardado solo en el navegador).`, 6000);
  }

  async openProject(file = null) {
    let handle = null;
    let f = file;
    if (!f && typeof window.showOpenFilePicker === 'function') {
      // con el selector del sistema queda el archivo ligado: Ctrl+S guarda ahí mismo
      try {
        [handle] = await window.showOpenFilePicker({ types: [{ description: 'Proyecto GISDrawer', accept: { 'application/json': ['.gisdrawer', '.json'] } }] });
      } catch (err) {
        if (err?.name === 'AbortError') return;
        throw err;
      }
      f = await handle.getFile();
    } else if (!f) [f] = await pickFiles('.gisdrawer,.json');
    if (!f) return;
    const raw = JSON.parse(await f.text());
    if (!raw.layers) throw new Error('No es un proyecto de GISDrawer');
    delete raw.app;
    // archivos raster incrustados: se pasan a IndexedDB (para la próxima vez) y se cargan ya
    const embedded = unpackFiles(raw);
    for (const [id, rec] of embedded) await saveFile(id, rec);
    const doc = normalizeDoc(raw);
    if (f.driveId) doc.driveFileId = f.driveId; // abierto desde Drive: «Guardar en Drive» lo actualiza
    else delete doc.driveFileId;
    doc.fileName = f.name;
    await this.flushSave();
    await this.loadDocument(doc, embedded, { name: f.name, source: f.driveId ? 'drive' : 'archivo' });
    await this.setFileHandle(handle);
    if (embedded.size) this.message(`Proyecto abierto con ${embedded.size} archivo(s) raster incrustado(s)`, 3500);
    await this.fetchDriveAssets(doc);
  }

  async importGpkg(files = null) {
    files ??= await pickFiles('.gpkg', true);
    if (!files.length) return;
    this.message('Leyendo GeoPackage…', 0);
    const { importGeoPackage } = await import('./io/gpkg.js');
    let doc = this.history.doc;
    const all = [];
    const warnings = [];
    for (const f of files) {
      const res = await importGeoPackage(await f.arrayBuffer(), { refScale: doc.refScale });
      warnings.push(...res.warnings);
      for (const L of res.layers) {
        const layer = makeVectorLayer(L.name, { items: L.items, fields: L.fields });
        if (L.labels) layer.labels = { ...layer.labels, ...L.labels };
        doc = addLayer(doc, layer, doc.activeLayerId);
        all.push(...L.items);
      }
    }
    this.history.commit(doc);
    if (all.length) this.zoomToShapes(all);
    this.message(`${all.length} elemento(s) importados${warnings.length ? ` · ${warnings.length} aviso(s): ${warnings.slice(0, 2).join(' / ')}` : ''}`, warnings.length ? 9000 : 3000);
  }

  /** Proyecto de FieldDraw: una capa por tipo (unidades, trazas, medidas, puntos de control), con su simbología. */
  async importFieldDraw(file = null) {
    const [f] = file ? [file] : await pickFiles('.json,.fdproj,.zip,.geojson');
    if (!f) return;
    this.message('Leyendo proyecto de FieldDraw…', 0);
    const { readFieldDrawFile, importFieldDraw } = await import('./io/fielddraw.js');
    const r = importFieldDraw(await readFieldDrawFile(f), { refScale: this.history.doc.refScale });
    if (!r.count) return this.message('El proyecto no trae elementos dibujables');
    let doc = this.history.doc;
    const all = [];
    for (const L of r.layers) {
      const layer = makeVectorLayer(L.name, { items: L.items, fields: L.fields });
      if (L.labels) layer.labels = { ...layer.labels, ...L.labels };
      doc = addLayer(doc, layer, doc.activeLayerId);
      all.push(...L.items);
    }
    this.history.commit(doc);
    this.zoomToShapes(all);
    this.message(`FieldDraw «${r.name}»: ${r.count} elemento(s) en ${r.layers.length} capa(s)${r.warnings.length ? ` · ${r.warnings.join(' · ')}` : ''}`, r.warnings.length ? 9000 : 4000);
  }

  /**
   * Archivo SVG (Illustrator, Inkscape…), .ai nativo de Illustrator o PDF
   * vectorial: una capa de GISDrawer por cada capa de primer nivel (en el .ai,
   * por cada capa de Illustrator; las ocultas llegan ocultas).
   */
  async importSvgFile(file = null) {
    const [f] = file ? [file] : await pickFiles('.svg,.ai,.pdf,image/svg+xml,application/pdf,application/illustrator,application/postscript');
    if (!f) return;
    const buf = new Uint8Array(await f.arrayBuffer());
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 1024));
    const base = f.name.replace(/\.\w+$/, '');
    if (/%PDF-|%!PS-Adobe/.test(head) || /\.(ai|pdf)$/i.test(f.name)) return this.openPdfProject(buf, f.name);
    const doc0 = this.history.doc;
    const { importSvg } = await import('./io/svgImport.js');
    const r = importSvg(new TextDecoder().decode(buf), { refScale: doc0.refScale, center: [this.view.cx, this.view.cy] });
    if (r.gisdrawer) {
      this.clipboard = r.gisdrawer.shapes;
      return this.pasteInternal(true);
    }
    let doc = doc0;
    const all = [];
    for (const L of r.layers) {
      if (!L.shapes.length) continue;
      const layer = makeVectorLayer(L.name || base, { items: L.shapes });
      doc = addLayer(doc, layer, doc.activeLayerId);
      all.push(...L.shapes);
    }
    if (!all.length) return this.message(`${f.name} no trae formas vectoriales${r.warnings.length ? ` · ${r.warnings.join(' · ')}` : ''}`, 6000);
    this.history.commit(doc);
    this.zoomToShapes(all);
    this.message(`${all.length} objeto(s) en ${r.layers.length} capa(s) desde ${f.name}${r.warnings.length ? ` · ${r.warnings.join(' · ')}` : ''}`, 6000);
  }

  /**
   * .ai de Illustrator o PDF: se abre como PROYECTO NUEVO (Ctrl+Z vuelve al
   * anterior), con una capa vectorial por capa de Illustrator y una capa de
   * imagen por cada imagen incrustada, bajo las vectoriales. El mapa base
   * queda oculto: la figura no está georreferenciada.
   */
  async openPdfProject(buf, fileName) {
    this.flushEdits();
    this.message(`Leyendo ${fileName}…`, 0);
    await new Promise((r) => setTimeout(r, 30));
    const title = fileName.replace(/\.\w+$/, '');
    const fresh = { ...newDocument(), title };
    const canvasMode = this.mode !== 'gis';
    // en Canvas la hoja toma el tamaño de la mesa de trabajo del .ai y el dibujo cae sobre ella
    const r = await importPdfOffThread(buf, { refScale: fresh.refScale, center: [this.view.cx, this.view.cy], name: title, placeCanvas: canvasMode });
    if (r.canvas) fresh.canvas = r.canvas;
    if (!r.layers.some((L) => L.shapes.length) && !r.images.length) return this.message(`${fileName} no trae formas ni imágenes${r.warnings.length ? ` · ${r.warnings.join(' · ')}` : ''}`, 6000);
    const placeholder = fresh.activeLayerId; // la capa «Dibujo» vacía del proyecto nuevo
    let doc = { ...fresh, layers: fresh.layers.map((l) => (l.kind === 'basemap' ? { ...l, visible: false } : l)) };
    const all = [];
    for (const L of r.layers) {
      if (!L.shapes.length) continue;
      const layer = makeVectorLayer(L.name || title, { items: L.shapes });
      if (r.hiddenLayers?.includes(L.name)) layer.visible = false;
      doc = addLayer(doc, layer, doc.activeLayerId);
      all.push(...L.shapes);
    }
    if (all.length) doc = { ...doc, layers: doc.layers.filter((l) => l.id !== placeholder) };
    // imágenes: debajo de las capas vectoriales, en el orden en que se dibujan
    const boxes = [];
    if (r.images.length) {
      this.message(`Preparando ${r.images.length} imagen(es) de ${fileName}…`, 0);
      const built = new Map();
      const count = new Map();
      for (const im of r.images) count.set(im.layer, (count.get(im.layer) || 0) + 1);
      const seen = new Map();
      for (const im of r.images) {
        // una misma imagen colocada varias veces con igual tamaño comparte el archivo
        const key = [im.T.slice(0, 4).map((v) => v.toFixed(6)).join(), im.opacity].join('|');
        let byPx = built.get(im.px);
        if (!byPx) built.set(im.px, (byPx = new Map()));
        let fileId = byPx.get(key);
        if (!fileId) {
          const { bitmap, blob } = await rasterizePdfImage(im);
          fileId = newId('F');
          imageFiles.set(fileId, { bitmap, x0: im.bounds[0], y0: im.bounds[1], x1: im.bounds[2], y1: im.bounds[3] });
          // el PNG para guardar se codifica y escribe en segundo plano: el dibujo ya se puede ver y usar
          const id = fileId;
          blob
            .then((b) => b.arrayBuffer())
            .then((buffer) => saveFile(id, { kind: 'image', name: `${title}.png`, format: 'bitmap', mime: 'image/png', buffer, bounds: im.bounds }))
            .catch(() => null);
          byPx.set(key, fileId);
        }
        const k = (seen.get(im.layer) || 0) + 1;
        seen.set(im.layer, k);
        const name = `${im.layer || title}${count.get(im.layer) > 1 ? ` · imagen ${k}` : ' · imagen'}`;
        const l = makeRasterLayer('image', name, { fileId, bounds: im.bounds });
        if (r.hiddenLayers?.includes(im.layer)) l.visible = false;
        const layers = doc.layers.slice();
        const fv = layers.findIndex((x) => x.kind === 'vector');
        layers.splice(fv < 0 ? layers.length : fv, 0, l);
        doc = { ...doc, layers };
        boxes.push({ x: im.bounds[0], y: im.bounds[1], w: im.bounds[2] - im.bounds[0], h: im.bounds[3] - im.bounds[1] });
      }
    }
    this.history.commit(doc);
    if (canvasMode) {
      this.applyCanvasDefaults();
      this.fitCanvas();
    } else {
      const box = unionBBox([...all.map((s) => shapeBBox(s, this.editor.est())), ...boxes]);
      if (box) this.view.fit(box);
    }
    const nVec = doc.layers.filter((l) => l.kind === 'vector').length;
    this.message(`Proyecto nuevo «${title}»: ${all.length} objeto(s) en ${nVec} capa(s)${r.images.length ? ` y ${r.images.length} imagen(es)` : ''} · Ctrl+Z vuelve al proyecto anterior${r.warnings.length ? ` · ${r.warnings.join(' · ')}` : ''}`, 9000);
  }

  /** Imagen PNG / JPG como capa de imagen en el centro de la vista (modo Canvas). */
  async importPlainImage() {
    const [f] = await pickFiles('image/png,image/jpeg,.png,.jpg,.jpeg');
    if (!f) return;
    return this.pasteImage(f);
  }

  /** Importa un archivo según su extensión (lo usa Google Drive, que entrega un archivo cualquiera). */
  async importFile(f) {
    const ext = (/\.(\w+)$/.exec(f.name)?.[1] || '').toLowerCase();
    if (this.mode !== 'gis' && ['gpkg', 'geojson', 'fdproj', 'zip', 'asc', 'tif', 'tiff', 'qml', 'qlr'].includes(ext)) {
      throw new Error(`.${ext} es un formato GIS: cambia a modo GIS (botón GIS, arriba) para importarlo`);
    }
    switch (ext) {
      case 'gisdrawer':
        return this.openProject(f);
      case 'gpkg':
        return this.importGpkg([f]);
      case 'geojson':
        return this.importGeoJSON([f]);
      case 'json': {
        const raw = JSON.parse(await f.text());
        if (raw?.layers && raw.app === 'GISDrawer') return this.openProject(f);
        if (this.mode !== 'gis') throw new Error('Este .json es un formato GIS: cambia a modo GIS (botón GIS, arriba) para importarlo');
        if (raw?.type === 'FeatureCollection' || raw?.type === 'Feature') return this.importGeoJSON([f]);
        return this.importFieldDraw(f);
      }
      case 'fdproj':
      case 'zip':
        return this.importFieldDraw(f);
      case 'svg':
      case 'ai':
      case 'pdf':
        return this.importSvgFile(f);
      case 'asc':
        return this.importDemForLayer(null, f);
      case 'tif':
      case 'tiff': {
        // GeoTIFF de una banda: elevación; en color: imagen; sin georreferencia: a georreferenciar
        const { readGeoTIFF } = await import('./io/geotiff.js');
        const info = await readGeoTIFF(await f.arrayBuffer()).catch(() => null);
        if (!info) return this.startGeoref(f);
        return info.isRGB ? this.importImage(f) : this.importDemForLayer(null, f);
      }
      case 'jpg':
      case 'jpeg':
      case 'png':
        return this.mode === 'gis' ? this.startGeoref(f) : this.pasteImage(f);
      case 'qml':
      case 'qlr':
        return this.applyQmlToLayer(this.history.doc.activeLayerId, f);
      default:
        throw new Error(`No sé importar archivos .${ext || '(sin extensión)'}`);
    }
  }

  /** Google Drive: selector de Google con sesión iniciada, o enlace compartido con la clave de API. */
  async importFromDrive() {
    const { googleClientId: clientId, googleApiKey: apiKey } = this.settings;
    if (!clientId && !apiKey) {
      this.message('Primero configura Google Drive (ID de cliente y/o clave de API de Google Cloud)', 6000);
      return this.configureDrive();
    }
    const gd = await import('./io/gdrive.js');
    let picked;
    if (clientId) picked = await gd.pickDriveFiles({ clientId, apiKey });
    else {
      const link = await askText('Abrir desde Google Drive', '', {
        label: 'Enlace del archivo',
        placeholder: 'https://drive.google.com/file/d/…',
        hint: 'El archivo debe estar compartido con «cualquier persona con el enlace».',
        validate: (v) => (gd.parseDriveId(v) ? '' : 'No reconozco el enlace de Google Drive.'),
      });
      if (!link) return;
      const id = gd.parseDriveId(link);
      if (!id) throw new Error('No reconozco el enlace de Google Drive');
      picked = [{ id }];
    }
    for (const p of picked) {
      this.message(`Bajando ${p.name || 'archivo'} de Google Drive…`, 0);
      const file = await gd.downloadDriveFile(p, {
        apiKey,
        onProgress: (q) => this.message(`Bajando ${p.name || 'archivo'} de Google Drive… ${Math.round(q * 100)} %`, 0),
      });
      this.message('');
      await this.importFile(file);
    }
  }

  /** Cuenta de Google: inicio de sesión, credenciales y atajos de Drive. */
  async configureDrive() {
    const { openGoogleDialog } = await import('./ui/googleDialog.js');
    openGoogleDialog(this);
  }

  /** Botón «G» de la barra: la inicial de la cuenta si hay sesión. */
  async updateGoogleButton() {
    const b = document.getElementById('btn-google');
    if (!b) return;
    const { googleUser, isSignedIn } = await import('./io/gdrive.js');
    const u = googleUser();
    b.classList.toggle('on', isSignedIn());
    b.textContent = u?.name ? u.name[0].toUpperCase() : 'G';
    b.dataset.tip = u ? `Google: ${u.name} (${u.email})${isSignedIn() ? '' : ' · sesión vencida'}` : 'Cuenta de Google / Drive';
  }

  /**
   * Guarda el proyecto en Google Drive. La primera vez crea el archivo (en «Mi
   * unidad» o, con `choose`, en la carpeta que se elija) y recuerda su id en
   * el proyecto; las siguientes lo actualiza.
   */
  /**
   * Guardar en Google Drive. La primera vez (o «en otra carpeta») se elige la
   * carpeta y el nombre; después se actualiza el mismo archivo. Para que sea
   * rápido, las imágenes y modelos de elevación se suben una sola vez, como
   * archivos binarios en una carpeta junto al proyecto, y cada guardado sube
   * solo el JSON del dibujo con sus referencias.
   */
  async saveToDrive({ choose = false } = {}) {
    const { googleClientId: clientId, googleApiKey: apiKey } = this.settings;
    if (!clientId) {
      this.message('Primero configura tu cuenta de Google (ID de cliente)', 6000);
      return this.configureDrive();
    }
    const gd = await import('./io/gdrive.js');
    this.flushEdits();
    await gd.ensureSignedIn(clientId);
    this.updateGoogleButton();
    let doc = this.history.doc;
    let name = /\.gisdrawer$/i.test(doc.fileName || '') ? doc.fileName : `${fileBase(doc.title)}.gisdrawer`;
    let fileId = choose ? null : doc.driveFileId || null;
    let folderId = choose ? null : doc.driveFolderId || null;
    if (!fileId) {
      const folder = await gd.pickDriveFolder({ clientId, apiKey, startIn: this.settings.driveFolder?.id || null });
      if (!folder) return;
      folderId = folder.id;
      this.saveSettings({ driveFolder: folder });
      const n = await askText('Guardar en Google Drive', name, { label: `Nombre del archivo en «${folder.name}»`, ok: 'Guardar', validate: (v) => (v ? '' : 'Escribe un nombre.') });
      if (!n) return;
      name = /\.gisdrawer$/i.test(n) ? n : `${n}.gisdrawer`;
    }
    const t0 = performance.now();

    // 1) archivos raster que aún no están en Drive: una vez, binarios (sin base64)
    const assets = { ...(doc.driveAssets || {}) };
    let assetsFolder = doc.driveAssetsFolder || null;
    const pending = [...referencedFiles(doc).keys()].filter((id) => !assets[id]?.driveId);
    let uploaded = 0;
    for (const id of pending) {
      const rec = await this.fileRecord(id);
      if (!rec?.buffer) continue;
      try {
        if (!assetsFolder) {
          const parent = folderId || (fileId ? await gd.driveParentOf(fileId) : null);
          assetsFolder = (await gd.createDriveFolder(`${name.replace(/\.gisdrawer$/i, '')} – imágenes (GISDrawer)`, parent)).id;
        }
        this.message(`Subiendo a Google Drive ${uploaded + 1}/${pending.length}: ${rec.name || 'imagen'} (${(rec.buffer.byteLength / 1048576).toFixed(1)} MB)…`, 0);
        const r = await gd.uploadDriveFile({ name: rec.name || id, mimeType: rec.mime || 'application/octet-stream', data: new Blob([rec.buffer]), parentId: assetsFolder });
        assets[id] = assetMeta(rec, r.id);
        uploaded++;
      } catch (err) {
        // si no se pudo subir aparte, va incrustado en el proyecto (más lento, pero no se pierde)
        console.warn('GISDrawer: imagen incrustada en vez de enlazada', err);
      }
    }

    // 2) el proyecto: solo el dibujo y las referencias
    doc = { ...this.history.doc, driveAssets: assets, driveAssetsFolder: assetsFolder, driveFolderId: folderId };
    const packed = await packProject(doc, (id) => this.fileRecord(id), { linked: assets });
    if (packed.missing.length) this.message(`Atención: falta el archivo de ${packed.missing.length} capa(s) (${packed.missing.slice(0, 3).join(', ')}); en otro equipo quedarán vacías.`, 9000);
    this.message(`Guardando en Google Drive (${(packed.blob.size / 1048576).toFixed(2)} MB)…`, 0);
    let res;
    try {
      res = await gd.uploadDriveFile({ name, mimeType: 'application/json', data: packed.blob, fileId, parentId: fileId ? null : folderId });
    } catch (err) {
      // el archivo guardado antes ya no existe o no es accesible: se crea uno nuevo
      if (fileId && (err.status === 404 || err.status === 403)) res = await gd.uploadDriveFile({ name, mimeType: 'application/json', data: packed.blob, parentId: folderId });
      else throw err;
    }
    this.history.silent({ ...this.history.doc, driveFileId: res.id, driveFolderId: folderId, driveAssets: assets, driveAssetsFolder: assetsFolder, fileName: res.name || name });
    rememberProject(this.history.doc, { name: res.name || name, source: 'drive' }).catch(() => null);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    this.message(`Guardado en Google Drive: ${res.name} (${secs} s${uploaded ? `, ${uploaded} imagen(es) subidas una vez` : ''})`, 5000);
    return res;
  }

  async importGeoJSON(files = null) {
    files ??= await pickFiles('.geojson,.json', true);
    if (!files.length) return;
    const { importGeoJSON } = await import('./io/geojson.js');
    let doc = this.history.doc;
    const all = [];
    for (const f of files) {
      const res = await importGeoJSON(await f.text());
      const layer = makeVectorLayer(f.name.replace(/\.(geo)?json$/i, ''), { items: res.items, fields: res.fields });
      doc = addLayer(doc, layer, doc.activeLayerId);
      all.push(...res.items);
    }
    this.history.commit(doc);
    if (all.length) this.zoomToShapes(all);
  }

  async applyQmlToLayer(layerId, file = null) {
    const layer = findLayer(this.history.doc, layerId);
    if (!layer || layer.kind !== 'vector') return this.message('Elige una capa vectorial');
    if (layer.locked) return this.message(`La capa «${layer.name}» está bloqueada: no se puede cambiar su estilo`);
    const [f] = file ? [file] : await pickFiles('.qml,.qlr,.xml');
    if (!f) return;
    const parsed = parseQML(await f.text(), { refScale: this.history.doc.refScale, layerName: layer.name });
    const items = layer.items.map((s) => {
      const st = styleFor(parsed.rules, s.attrs || {});
      return st ? { ...s, style: { ...defaultStyle(), ...st } } : s;
    });
    let next = updateLayer(this.history.doc, layerId, (l) => ({ ...l, items, labels: parsed.labels ? { ...l.labels, ...parsed.labels } : l.labels }));
    this.history.commit(next);
    this.message(`Estilo ${parsed.rendererType} aplicado (${parsed.rules.length} regla(s))${parsed.warnings.length ? ` · ${parsed.warnings[0]}` : ''}`, 6000);
  }

  async buildDem(rec) {
    if (rec.format === 'asc') {
      const grid = parseAsciiGrid(new TextDecoder().decode(rec.buffer));
      grid.toGrid = await lonLatToTransform(rec.epsg || 4326);
      return grid;
    }
    const { readGeoTIFF, geotiffToDemGrid } = await import('./io/geotiff.js');
    const info = await readGeoTIFF(rec.buffer, { epsgOverride: rec.epsg || null });
    return geotiffToDemGrid(info);
  }

  async buildImage(rec) {
    // imagen pegada (PNG/JPG) con sus límites en UTM
    if (rec.format === 'bitmap') {
      const bitmap = await createImageBitmap(new Blob([rec.buffer], { type: rec.mime || 'image/png' }));
      const [x0, y0, x1, y1] = rec.bounds;
      return { bitmap, x0, y0, x1, y1 };
    }
    const { readGeoTIFF, geotiffToUtmImage } = await import('./io/geotiff.js');
    const info = await readGeoTIFF(rec.buffer, { epsgOverride: rec.epsg || null });
    return geotiffToUtmImage(info);
  }

  async importDemForLayer(layerId, file = null) {
    const [f] = file ? [file] : await pickFiles('.tif,.tiff,.asc');
    if (!f) return;
    this.message('Leyendo modelo de elevación…', 0);
    const buffer = await f.arrayBuffer();
    const rec = { kind: 'dem', name: f.name, buffer, format: /\.asc$/i.test(f.name) ? 'asc' : 'tif', epsg: null };
    if (rec.format === 'tif') {
      const { readGeoTIFF } = await import('./io/geotiff.js');
      const info = await readGeoTIFF(buffer);
      if (!info.epsg) rec.epsg = await this.askEpsg('El GeoTIFF no declara su sistema de coordenadas');
    } else {
      rec.epsg = (await this.askEpsg('Sistema del ASCII grid', 4326)) || 4326;
    }
    const fileId = newId('F');
    const grid = await this.buildDem(rec);
    demFiles.set(fileId, grid);
    await saveFile(fileId, rec);
    let doc = this.history.doc;
    const settings = { source: 'file', fileId, fileName: f.name };
    if (layerId) doc = updateLayer(doc, layerId, (l) => ({ ...l, settings: { ...l.settings, ...settings } }));
    else {
      const { defaultHillshadeSettings } = await import('./raster/hillshade.js');
      const l = makeRasterLayer('hillshade', `Relieve: ${f.name}`, { ...defaultHillshadeSettings(), ...settings });
      const layers = doc.layers.slice();
      const fv = layers.findIndex((x) => x.kind === 'vector');
      layers.splice(fv < 0 ? layers.length : fv, 0, l);
      doc = { ...doc, layers };
      this.panels.reliefLayerId = l.id;
    }
    this.history.commit(doc);
    // zoom al DEM
    const g = grid;
    const toDoc = await (await import('./io/crs.js')).toDocTransform(rec.epsg || g.crs?.replace('EPSG:', '') || 4326);
    const a = toDoc(g.x0, g.y0);
    const b = toDoc(g.x0 + g.w * g.dx, g.y0 + g.h * g.dy);
    this.view.fit({ x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) });
    this.message('');
    this.showPanel('relief');
  }

  async importImage(file = null) {
    const [f] = file ? [file] : await pickFiles('.tif,.tiff');
    if (!f) return;
    this.message('Leyendo GeoTIFF…', 0);
    const buffer = await f.arrayBuffer();
    const { readGeoTIFF } = await import('./io/geotiff.js');
    const info = await readGeoTIFF(buffer);
    const rec = { kind: 'image', name: f.name, buffer, epsg: info.epsg ? null : await this.askEpsg('El GeoTIFF no declara su sistema de coordenadas') };
    const img = await this.buildImage(rec);
    const fileId = newId('F');
    imageFiles.set(fileId, img);
    await saveFile(fileId, rec);
    const l = makeRasterLayer('image', f.name, { fileId });
    const doc = this.history.doc;
    const layers = doc.layers.slice();
    const fv = layers.findIndex((x) => x.kind === 'vector');
    layers.splice(fv < 0 ? layers.length : fv, 0, l);
    this.history.commit({ ...doc, layers });
    this.view.fit({ x: img.x0, y: img.y0, w: img.x1 - img.x0, h: img.y1 - img.y0 });
    this.message('');
  }

  async exportGpkg() {
    this.message('Generando GeoPackage…', 0);
    const { exportGeoPackage } = await import('./io/gpkg.js');
    const bytes = await exportGeoPackage(this.history.doc);
    download(new Blob([bytes], { type: 'application/geopackage+sqlite3' }), `${fileBase(this.history.doc.title)}.gpkg`);
    this.message('GeoPackage exportado (EPSG:32719, con estilo QGIS)');
  }

  /**
   * Simbología para QGIS: un .qlr (definición de capas con su estilo y
   * etiquetas) y el GeoPackage al que apunta, con el mismo nombre. Dejando
   * ambos en la misma carpeta, arrastrar el .qlr a QGIS carga todo con el
   * aspecto del dibujo.
   */
  async exportQLR() {
    this.message('Generando simbología QGIS…', 0);
    const { exportGeoPackage } = await import('./io/gpkg.js');
    const { buildQLR } = await import('./io/qml.js');
    const base = fileBase(this.history.doc.title);
    const manifest = [];
    const bytes = await exportGeoPackage(this.history.doc, { manifest });
    download(new Blob([bytes], { type: 'application/geopackage+sqlite3' }), `${base}.gpkg`);
    const qlr = buildQLR(manifest, { gpkgName: `${base}.gpkg`, title: this.history.doc.title || 'GISDrawer' });
    setTimeout(() => download(qlr, `${base}.qlr`, 'application/xml'), 400);
    this.message(`Simbología exportada: ${base}.qlr + ${base}.gpkg (${manifest.length} capa(s)). Déjalos en la misma carpeta y arrastra el .qlr a QGIS.`, 8000);
  }

  /** Estilo .qml de la capa activa (para «Cargar estilo» en QGIS sobre una capa existente). */
  async exportQML() {
    const layer = findLayer(this.history.doc, this.history.doc.activeLayerId);
    if (!layer || layer.kind !== 'vector') return this.message('Elige una capa vectorial activa');
    const { exportGeoPackage } = await import('./io/gpkg.js');
    const { buildCategorizedQML } = await import('./io/qml.js');
    const manifest = [];
    await exportGeoPackage(this.history.doc, { layerIds: [layer.id], manifest });
    for (const t of manifest) {
      download(buildCategorizedQML(t.styles, t.kind, t.labelCfg, t.labels), `${t.table}.qml`, 'application/xml');
    }
    this.message(manifest.length > 1 ? `${manifest.length} estilos .qml (uno por tipo de geometría). Se aplican sobre el campo gd_style.` : 'Estilo .qml exportado (categorizado por el campo gd_style)', 6000);
  }

  async exportGeoJSON(wgs84) {
    const layer = findLayer(this.history.doc, this.history.doc.activeLayerId);
    if (!layer || layer.kind !== 'vector') return this.message('Elige una capa vectorial activa');
    const { exportGeoJSON } = await import('./io/geojson.js');
    download(exportGeoJSON(layer, { wgs84 }), `${layer.name.replace(/\W+/g, '_')}${wgs84 ? '' : '_utm19s'}.geojson`, 'application/geo+json');
  }

  async exportHillshade(layerId) {
    const snap = this.raster.snapshotOf(layerId);
    if (!snap?.rendered) return this.message('El relieve aún no se ha calculado');
    const { canvas, rendered: r } = snap;
    const rgba = canvas.getContext('2d').getImageData(0, 0, r.w, r.h).data;
    const { writeUtmGeoTIFF } = await import('./io/geotiff.js');
    const buf = await writeUtmGeoTIFF(rgba, r.w, r.h, r.x0, r.y0, r.cell);
    download(new Blob([buf], { type: 'image/tiff' }), 'relieve_utm19s.tif');
  }

  /** Vista actual a PNG (raster compuesto) o SVG (vectores + rasters incrustados). */
  /**
   * Exportar imagen: PNG, JPG, TIFF o WebP, de la hoja del lienzo (Canvas), de todo lo dibujado o de la
   * vista, a 72–1200 dpi. El tamaño de papel sale de la escala de referencia (1 mm de papel = refScale/1000 m).
   */
  async exportImageDialog() {
    const { IMAGE_DPIS, IMAGE_FORMATS, mmToPx, sizeProblem } = await import('./io/imageExport.js');
    const doc = this.history.doc;
    const canvasMode = this.mode !== 'gis';
    const areas = {
      ...(canvasMode ? { sheet: 'Hoja del lienzo' } : {}),
      all: 'Todo lo dibujado (capas visibles)',
      view: 'Lo que se ve ahora en pantalla',
    };
    const regionOf = (area) => {
      if (area === 'sheet') return canvasRect(doc);
      if (area === 'view') return { x: this.view.cx - (this.view.w * this.view.mpp) / 2, y: this.view.cy - (this.view.h * this.view.mpp) / 2, w: this.view.w * this.view.mpp, h: this.view.h * this.view.mpp };
      return unionBBox(allTopShapes(doc).map((x) => shapeBBox(x.shape, this.editor.est())));
    };
    const last = this.settings.imageExport || {};
    const v = await askForm({
      title: 'Exportar imagen',
      hint: `El tamaño en papel sale de la escala de referencia 1:${doc.refScale.toLocaleString('es-CL')}. Más dpi, más píxeles: 300 dpi para imprimir, 72–96 para pantalla.`,
      fields: [
        { key: 'area', label: 'Qué exportar', type: 'select', options: areas, value: areas[last.area] ? last.area : canvasMode ? 'sheet' : 'all' },
        { key: 'format', label: 'Formato', type: 'select', options: Object.fromEntries(Object.entries(IMAGE_FORMATS).map(([k, f]) => [k, f.label])), value: last.format || 'png' },
        { key: 'dpi', label: 'Resolución', type: 'select', options: Object.fromEntries(IMAGE_DPIS.map((d) => [d, `${d} dpi${d === 72 ? ' (pantalla)' : d === 300 ? ' (impresión)' : d >= 1200 ? ' (muy pesado)' : ''}`])), value: last.dpi || 300 },
        { key: 'quality', label: 'Calidad', type: 'number', min: 10, max: 100, step: 1, unit: '%', value: last.quality || 92, when: (x) => IMAGE_FORMATS[x.format].quality },
        { key: 'background', label: 'Fondo', type: 'select', options: { white: 'Blanco', transparent: 'Transparente' }, value: last.background || 'white', when: (x) => IMAGE_FORMATS[x.format].alpha },
      ],
      ok: 'Exportar',
      validate: (x) => {
        const r = regionOf(x.area);
        if (!r || !(r.w > 0) || !(r.h > 0)) return 'No hay nada que exportar en esa área (¿hay objetos en capas visibles?)';
        return sizeProblem(mmToPx((r.w * 1000) / doc.refScale, Number(x.dpi)), mmToPx((r.h * 1000) / doc.refScale, Number(x.dpi)));
      },
    });
    if (!v) return;
    this.saveSettings({ imageExport: { area: v.area, format: v.format, dpi: Number(v.dpi), quality: v.quality, background: v.background } });
    await this.exportImage(regionOf(v.area), { ...v, dpi: Number(v.dpi) });
  }

  async exportImage(rect, { format, dpi, quality = 92, background = 'white' }) {
    const { IMAGE_FORMATS, buildTiff, jpegWithDpi, mmToPx, pngWithDpi } = await import('./io/imageExport.js');
    const fmt = IMAGE_FORMATS[format];
    const transparent = fmt.alpha && background === 'transparent';
    this.message(`Generando imagen ${format.toUpperCase()} a ${dpi} dpi…`, 0);
    try {
      const { svg, geometry } = await this.layout.renderRegion(rect, { dpi, transparent });
      const wPx = mmToPx(geometry.W, dpi);
      const hPx = mmToPx(geometry.H, dpi);
      const canvas = document.createElement('canvas');
      canvas.width = wPx;
      canvas.height = hPx;
      const ctx = canvas.getContext('2d', { willReadFrequently: format === 'tiff' });
      if (!ctx || canvas.width !== wPx) throw new Error('El navegador no pudo crear una imagen tan grande: baja los dpi');
      if (!transparent) {
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, wPx, hPx);
      }
      const img = new Image();
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      try {
        img.src = url;
        await img.decode();
        ctx.drawImage(img, 0, 0, wPx, hPx);
      } finally {
        URL.revokeObjectURL(url);
      }
      let blob;
      if (format === 'tiff') {
        blob = buildTiff({ width: wPx, height: hPx, dpi, alpha: transparent, readRows: (y, n) => ctx.getImageData(0, y, wPx, n).data });
      } else {
        const raw = await new Promise((res) => canvas.toBlob(res, fmt.mime, quality / 100));
        if (!raw) throw new Error('No se pudo codificar la imagen');
        if (raw.type !== fmt.mime) throw new Error(`Este navegador no sabe guardar ${format.toUpperCase()}: elige PNG, JPG o TIFF`);
        const bytes = new Uint8Array(await raw.arrayBuffer());
        const tagged = format === 'png' ? pngWithDpi(bytes, dpi) : format === 'jpg' ? jpegWithDpi(bytes, dpi) : bytes;
        blob = new Blob([tagged], { type: fmt.mime });
      }
      const base =
        String(this.history.doc.title || 'mapa')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^\w-]+/g, '_')
          .replace(/^_+|_+$/g, '') || 'mapa';
      download(blob, `${base}_${dpi}dpi.${fmt.ext}`, fmt.mime);
      this.message(`Imagen ${format.toUpperCase()} exportada: ${wPx.toLocaleString('es-CL')} × ${hPx.toLocaleString('es-CL')} px a ${dpi} dpi (${(blob.size / 1e6).toFixed(1)} MB)`, 7000);
    } catch (err) {
      this.message(`No se pudo exportar la imagen: ${err.message}`, 8000);
    }
  }

  async exportView(kind) {
    const w = Math.round(this.view.w);
    const hgt = Math.round(this.view.h);
    const stage = document.getElementById('stage');
    if (kind === 'svg') {
      const parts = [`<rect width="${w}" height="${hgt}" fill="#ffffff"/>`];
      for (const el of stage.children) {
        if (el.classList.contains('overlay-svg') || el.style.display === 'none') continue;
        const blend = el.style.mixBlendMode && el.style.mixBlendMode !== 'normal' ? ` style="mix-blend-mode:${el.style.mixBlendMode}"` : '';
        const op = el.style.opacity !== '' && el.style.opacity !== '1' ? ` opacity="${el.style.opacity}"` : '';
        if (el.tagName.toLowerCase() === 'canvas') {
          const url = el.toDataURL('image/png');
          const r = el.getBoundingClientRect();
          const vr = this.viewport.getBoundingClientRect();
          parts.push(`<image x="${r.left - vr.left}" y="${r.top - vr.top}" width="${r.width}" height="${r.height}" href="${url}"${op}${blend}/>`);
        } else {
          parts.push(`<g${op}${blend}>${el.innerHTML}</g>`);
        }
      }
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">${parts.join('')}</svg>`;
      download(svg, 'vista.svg', 'image/svg+xml');
      return;
    }
    const scale = 2;
    const out = document.createElement('canvas');
    out.width = w * scale;
    out.height = hgt * scale;
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, out.width, out.height);
    const vr = this.viewport.getBoundingClientRect();
    for (const el of stage.children) {
      if (el.classList.contains('overlay-svg') || el.style.display === 'none') continue;
      ctx.globalAlpha = el.style.opacity === '' ? 1 : Number(el.style.opacity);
      ctx.globalCompositeOperation = el.style.mixBlendMode && el.style.mixBlendMode !== 'normal' ? el.style.mixBlendMode : 'source-over';
      if (el.tagName.toLowerCase() === 'canvas') {
        const r = el.getBoundingClientRect();
        ctx.drawImage(el, (r.left - vr.left) * scale, (r.top - vr.top) * scale, r.width * scale, r.height * scale);
      } else {
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hgt}" viewBox="0 0 ${w} ${hgt}">${el.innerHTML}</svg>`;
        const img = new Image();
        img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await img.decode();
        ctx.drawImage(img, 0, 0, out.width, out.height);
      }
    }
    out.toBlob((b) => download(b, 'vista.png'), 'image/png');
  }
}

const SHORTCUTS = [
  ['Herramientas', [
    ['V', 'Selección'], ['A', 'Nodos'], ['Q', 'Lazo'], ['P', 'Pluma / línea'], ['Y', 'Polígono'], ['B', 'Lápiz'], ['N', 'Suavizar (pincel local)'],
    ['\\', 'Segmento'], ['W', 'Flecha'], ['M', 'Rectángulo'], ['E', 'Elipse'], ['T', 'Texto'], ['O', 'Punto'],
    ['C', 'Tijera'], ['I', 'Cuentagotas'], ['H', 'Mano'], ['Z', 'Zoom (Alt = alejar)'], ['Espacio', 'Mano temporal'],
  ]],
  ['Color', [['X', 'Alternar relleno / trazo'], ['Mayús+X', 'Intercambiar relleno y trazo'], ['D', 'Colores predeterminados'], ['/', 'Ninguno']]],
  ['Edición', [
    ['Ctrl+Z / Ctrl+Mayús+Z', 'Deshacer / rehacer'], ['Ctrl+C / X / V', 'Copiar / cortar / pegar (también desde y hacia Illustrator)'], ['Ctrl+F / Ctrl+B', 'Pegar en el lugar delante / detrás'],
    ['Ctrl+D', 'Duplicar'], ['Ctrl+Mayús+M', 'Transformar: mover, rotar, escalar con valores exactos'], ['Alt+arrastrar', 'Duplicar al mover'], ['Supr', 'Eliminar'], ['Flechas', 'Mover 1 px (Mayús: 10)'],
    ['Ctrl+A / Ctrl+Mayús+A', 'Seleccionar todo / nada'], ['Ctrl+G / Ctrl+Mayús+G', 'Agrupar / desagrupar'], ['Ctrl+J', 'Unir líneas (Join) / fusionar polígonos (Merge)'],
    ['Ctrl+7 / Ctrl+Alt+7', 'Máscara de recorte / liberar'], ['Ctrl+] / Ctrl+[', 'Adelante / atrás (Mayús: al frente / al fondo)'],
    ['Ctrl+2 / Ctrl+Alt+2', 'Bloquear / desbloquear todo'], ['Ctrl+3 / Ctrl+Alt+3', 'Ocultar / mostrar todo'], ['Mayús+C', 'Nodo esquina ↔ curva'],
  ]],
  ['Dibujo', [['Enter / doble clic', 'Terminar línea'], ['Clic en el 1er vértice', 'Cerrar polígono'], ['⌫', 'Quitar último vértice'], ['Esc', 'Cancelar'], ['S / K', 'Snapping / trace'], ['Alt (con Trace)', 'Recorrido alterno, por el otro lado'], ['Move Joined', 'Mover juntos los nodos compartidos (botón de eslabones)'], ['Freeze node', 'Botón de la barra flotante al elegir un nodo (o menú contextual sobre él): queda fijo ante transformaciones y frena Deform, Drag y Suavizar (Unfreeze nodes lo libera; Geometría → Unfreeze all nodes, todos los del documento)'], ['Guías', 'Alinear con el nivel o la vertical de otros vértices, aunque estén lejos'], ['Mayús', 'Restringir ángulo o proporción']]],
  ['Tablet (táctil)', [['Dos dedos, dos toques', 'Deshacer'], ['Tres dedos, dos toques', 'Rehacer'], ['Mantener el dedo', 'Menú contextual (Join, Merge, Split, Hole…)'], ['Dos dedos arrastrar / pellizcar', 'Desplazar / zoom']]],
  ['Vista y archivo', [
    ['Ctrl+0', 'Zoom a todo'], ['Ctrl+1', 'Escala de referencia'], ['Ctrl++ / Ctrl+−', 'Acercar / alejar'], ['Rueda del mouse', 'Zoom (Archivo → Vista: cambiar a desplazar)'], ['Trackpad', 'Dos dedos desplazan, pellizco = zoom'],
    ['Tab', 'Mostrar / ocultar panel'], ['F7 / Ctrl+F10', 'Capas / Estilo'], ['Ctrl+L', 'Capa nueva'], ['Ctrl+S', 'Guardar en el mismo archivo'], ['Ctrl+Mayús+S', 'Guardar como…'], ['Ctrl+S+D', 'Guardar en el mismo archivo de Google Drive'], ['Ctrl+O', 'Abrir proyecto'], ['Ctrl+P', 'Layout de impresión'], ['? o F1', 'Esta ayuda'],
  ]],
  ['Ratón y tablet', [['Botón derecho', 'Menú contextual (o terminar línea)'], ['Mantener el dedo', 'Menú contextual'], ['Un dedo / dos dedos', 'Desplazar / zoom'], ['Toque corto con el dedo', 'Seleccionar']]],
];

function helpContent(close) {
  return [
    h('div', { class: 'help-card' },
      h('div', { class: 'help-head' }, h('h2', {}, 'Atajos de teclado'), h('button', { class: 'help-x', onclick: close, 'aria-label': 'Cerrar' }, '✕')),
      h('p', { class: 'hint' }, `Inspirados en Illustrator. En Mac, Ctrl es ⌘ y Alt es ⌥. Versión de la app: ${APP_VERSION}.`),
      h('div', { class: 'help-grid' }, ...SHORTCUTS.map(([title, rows]) => h('section', {}, h('h3', {}, title), h('table', {}, ...rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d))))))),
      h('section', { class: 'about', id: 'about' },
        h('h3', {}, 'Acerca de la app'),
        h('p', {}, h('b', {}, 'GISDrawer'), ` ${APP_VERSION} · dibujo vectorial georreferenciado`),
        h('p', {}, APP_AUTHOR.name, ' · ', h('a', { href: `mailto:${APP_AUTHOR.email}` }, APP_AUTHOR.email)),
        h('h3', {}, 'Últimos cambios'),
        h('ul', { class: 'changelog' }, ...CHANGELOG.map(([v, d]) => h('li', {}, h('b', {}, v), ` ${d}`))),
      ),
    ),
  ];
}

/** Nombre de archivo a partir del título (sin tildes ni símbolos). */
function fileBase(title) {
  return (
    String(title || 'dibujo')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'dibujo'
  );
}

function readJSON(key) {
  try {
    return JSON.parse(localStorage.getItem(key)) || {};
  } catch {
    return {};
  }
}

function writeJSON(key, v) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* sin almacenamiento */
  }
}

window.gisdrawer = new App();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  // Si ya había un service worker y llega uno nuevo (versión publicada), la
  // página se recarga sola una vez para no seguir con el código viejo.
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', async () => {
    if (!hadController || reloading) return;
    reloading = true;
    const app = window.gisdrawer;
    app.message(`Nueva versión (${APP_VERSION}): recargando…`, 0);
    // esperar a que termine un trazo en curso, y guardar antes de recargar
    while (app.editor.draft || app.editor.drag) await new Promise((r) => setTimeout(r, 500));
    await saveDoc(app.history.doc).catch(() => null);
    location.reload();
  });
  navigator.serviceWorker.register('sw.js').then((reg) => reg.update()).catch(() => null);
}

export { paperUnits, walkShapes };
