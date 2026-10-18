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
import { ICONS } from './ui/icons.js';
import { h } from './ui/dom.js';
import { DASHES, defaultStyle } from './style.js';
import { copyShapes, pasteShapes, arrange, group, ungroup, joinPaths, splitPath, setShapeFlag, resetShapeFlag, selectSame } from './ops.js';
import { formatDMS, toLonLat } from './proj.js';
import { shapeBBox, unionBBox, walkShapes, newId } from './vector.js';
import { saveDoc, loadDoc, saveFile, loadFile, download, pickFiles } from './io/store.js';
import { parseQML, styleFor } from './io/qml.js';
import { parseAsciiGrid } from './raster/dem.js';
import { lonLatToTransform } from './io/crs.js';
import { selectionSvg } from './io/illustrator.js';
import { APP_VERSION } from './version.js';

const SETTINGS_KEY = 'gd.settings';

class App {
  constructor() {
    this.settings = {
      snap: true,
      trace: false,
      fingerDraws: false,
      smoothing: 0.25,
      pencilTolerance: 1.5,
      opentopoKey: '',
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
    this.editor.onContextMenu = (sp, info) => this.showContextMenu(sp, info);
    this.editor.onPointerStart = () => this.hideContextMenu();
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
    this.panels.onShow = (tab) => (tab === 'layout' ? this.layout.show() : this.layout.hide());
    this.clipboard = [];

    this.history.onChange((doc, meta) => this.onDocChange(doc, meta));
    this.view.onChange(() => this.onViewChange());

    this.buildToolbar();
    this.buildTopbar();
    this.buildContextMenu();
    this.setupTooltips();
    this.setupClipboard();
    this.observeSize();
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
    if (['style', 'geology'].includes(this.panels.tab)) this.panels.render();
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
    for (const b of this.toolbarEl.querySelectorAll('button[data-tool]')) b.classList.toggle('on', b.dataset.tool === this.editor.tool);
    const sig = `${[...this.editor.selection].join(',')}|${this.editor.tool}`;
    if (sig !== this.lastSelSig) {
      this.lastSelSig = sig;
      if (['style', 'geology', 'attrs', 'arrange'].includes(this.panels.tab)) this.panels.render();
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
    if (document.activeElement !== this.scaleInput) this.scaleInput.value = Math.round(this.view.scale).toLocaleString('es-CL');
    clearTimeout(this.viewSaveT);
    this.viewSaveT = setTimeout(() => writeJSON('gd.view', { cx: this.view.cx, cy: this.view.cy, mpp: this.view.mpp }), 400);
  }

  scheduleSave() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => saveDoc(this.history.doc), 800);
    if (!this.flushBound) {
      // al cerrar o ocultar la pestaña se guarda ya, sin esperar los 800 ms
      this.flushBound = true;
      const now = () => {
        if (!this.saveT) return;
        clearTimeout(this.saveT);
        this.saveT = null;
        saveDoc(this.history.doc);
      };
      addEventListener('pagehide', now);
      document.addEventListener('visibilitychange', () => document.hidden && now());
    }
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
    const saved = await loadDoc();
    if (saved?.layers) {
      this.history.reset(normalizeDoc(saved));
      // archivos pesados (DEM, imágenes) desde IndexedDB
      for (const l of saved.layers) {
        const fid = l.settings?.fileId;
        if (fid && !demFiles.has(fid) && !imageFiles.has(fid)) this.reloadFile(fid, l).catch(() => null);
      }
    } else {
      this.history.reset(this.history.doc);
    }
    this.view.emit();
    this.editor.setTool('select');
    this.panels.render();
    this.panels.onShow?.(this.panels.tab);
  }

  async reloadFile(fileId) {
    const rec = await loadFile(fileId);
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
    const groups = [['select', 'node', 'lasso'], ['pen', 'polygon', 'pencil', 'line', 'arrow'], ['rect', 'ellipse', 'text', 'point'], ['scissors', 'eyedropper', 'pan', 'zoom']];
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
    if (!bar || bar.contains(document.activeElement)) return;
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
    items.push(lbl('Trazo'), ...colorIn('stroke'));
    const w = h('input', { type: 'number', class: 'pb-num', min: 0, step: 0.05, value: Number(st.strokeWidth || 0).toFixed(2), 'data-tip': 'Grosor del trazo (mm en el papel)' });
    w.addEventListener('change', () => {
      const v = Number(String(w.value).replace(',', '.'));
      if (Number.isFinite(v) && v >= 0) this.editStyle({ strokeWidth: v }, true);
    });
    const widths = h('select', { class: 'pb-sel pb-w', 'data-tip': 'Grosores frecuentes', onchange: (e) => e.target.value && this.editStyle({ strokeWidth: Number(e.target.value) }, true) }, h('option', { value: '' }, '▾'), ...[0.1, 0.18, 0.25, 0.35, 0.5, 0.7, 1, 1.4, 2, 3, 5, 8, 12, 20, 30].map((v) => h('option', { value: v }, `${v} mm`)));
    items.push(w, h('span', { class: 'pb-u' }, 'mm'), widths);
    const dash = h('select', { class: 'pb-sel', 'data-tip': 'Tipo de línea', onchange: (e) => this.editStyle({ dash: e.target.value }, true) }, ...Object.entries(DASHES).map(([k, d]) => h('option', { value: k, selected: (st.dash || 'solid') === k }, d.label)));
    items.push(dash, h('span', { class: 'pb-sep' }));
    items.push(lbl('Relleno'), ...colorIn('fill'));
    const op = h('input', { type: 'number', class: 'pb-num pb-pct', min: 0, max: 100, step: 5, value: Math.round((st.opacity ?? 1) * 100), 'data-tip': 'Opacidad del objeto (%)' });
    op.addEventListener('change', () => {
      const v = Math.max(0, Math.min(100, Number(op.value)));
      if (Number.isFinite(v)) this.editStyle({ opacity: v / 100 }, true);
    });
    items.push(h('span', { class: 'pb-sep' }), lbl('Opac.'), op, h('span', { class: 'pb-u' }, '%'));
    if (text) {
      const fs = h('input', { type: 'number', class: 'pb-num', min: 0.5, step: 0.5, value: text.fontSize, 'data-tip': 'Tamaño de letra (pt a la escala de referencia)' });
      fs.addEventListener('change', () => {
        const v = Number(fs.value);
        if (v > 0) this.history.commit(mapShapes(this.history.doc, [text.id], (x) => ({ ...x, fontSize: v })));
      });
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
    $('btn-finger').onclick = () => this.saveSettings({ fingerDraws: !this.settings.fingerDraws });
    $('btn-redraw').onclick = () => {
      const n = this.raster.redrawHillshades(this.history.doc.layers);
      if (n) this.message('Recalculando relieve para la vista actual…', 2500);
    };
    $('btn-panel').onclick = () => this.togglePanel();
    $('btn-help').onclick = () => this.toggleHelp();
    if (window.innerWidth < 900) document.getElementById('app').classList.add('panel-hidden');
    this.scaleInput = $('in-scale');
    this.scaleInput.addEventListener('change', () => {
      const v = Number(this.scaleInput.value.replace(/[.\s]/g, '').replace(',', '.'));
      if (v > 0) this.view.setScale(v);
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
    document.addEventListener('pointerdown', (e) => {
      if (!menu.hidden && !menu.contains(e.target) && e.target.id !== 'btn-file') menu.hidden = true;
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
    return [
      h('div', { class: 'mh' }, 'Proyecto'),
      item('Nuevo', () => {
        if (confirm('¿Empezar un dibujo nuevo? (El actual se puede deshacer con Ctrl+Z)')) this.history.commit(newDocument());
      }),
      item('Abrir proyecto (.gisdrawer)…', () => this.openProject()),
      item('Guardar proyecto (.gisdrawer)', () => this.saveProject()),
      h('div', { class: 'mh' }, 'Importar'),
      item('GeoPackage (.gpkg)…', () => this.importGpkg()),
      item('GeoJSON…', () => this.importGeoJSON()),
      item('GeoTIFF / ASCII grid de elevación…', () => this.importDemForLayer(null)),
      item('GeoTIFF imagen (orto, mapa escaneado)…', () => this.importImage()),
      item('Georreferenciar imagen (JPG/PNG/TIFF)…', () => this.startGeoref()),
      item('Estilo QGIS (.qml / .qlr) a la capa activa…', () => this.applyQmlToLayer(this.history.doc.activeLayerId)),
      item('Proyecto FieldDraw (.fdproj.json / .zip / GeoJSON)…', () => this.importFieldDraw()),
      item('Illustrator (.ai, .svg) / PDF vectorial, una capa por capa…', () => this.importSvgFile()),
      item('Desde Google Drive…', () => this.importFromDrive()),
      item('Configurar Google Drive…', () => this.configureDrive()),
      h('div', { class: 'mh' }, 'Exportar'),
      item('GeoPackage (todas las capas, con estilo QGIS)', () => this.exportGpkg()),
      item('Simbología QGIS (.qlr) + GeoPackage', () => this.exportQLR()),
      item('Estilo QGIS (.qml) de la capa activa', () => this.exportQML()),
      item('GeoJSON de la capa activa (WGS84)', () => this.exportGeoJSON(true)),
      item('GeoJSON de la capa activa (UTM 19S)', () => this.exportGeoJSON(false)),
      item('Illustrator con capas (.jsx, lámina del layout)', () => this.layout.exportAs('jsx')),
      item('SVG de la lámina con capas (Illustrator, Inkscape)', () => this.layout.exportAs('svg')),
      item('Imagen PNG de la vista', () => this.exportView('png')),
      item('SVG de la vista (vectorial)', () => this.exportView('svg')),
      h('div', { class: 'mh' }, 'Vista'),
      item(`Rueda del mouse: ${this.settings.wheelMode === 'pan' ? 'desplaza (Ctrl/Alt = zoom) → cambiar a zoom' : 'zoom → cambiar a desplazar'}`, () => {
        this.saveSettings({ wheelMode: this.settings.wheelMode === 'pan' ? 'zoom' : 'pan' });
        this.message(`Rueda del mouse: ${this.settings.wheelMode === 'pan' ? 'desplaza el mapa' : 'zoom'}`);
      }),
      item('Ir a coordenadas…', () => this.gotoCoords()),
      item('Layout de impresión (PDF / SVG / PNG)…', () => this.showPanel('layout')),
      item('Zoom a todo el dibujo', () => this.zoomToShapes(allTopShapes(this.history.doc).map((x) => x.shape))),
    ];
  }

  syncToggles() {
    const set = (id, on) => document.getElementById(id)?.classList.toggle('on', !!on);
    set('btn-snap', this.settings.snap);
    set('btn-trace', this.settings.trace);
    set('btn-finger', this.settings.fingerDraws);
  }

  updateUndo() {
    document.getElementById('btn-undo').disabled = !this.history.past.length;
    document.getElementById('btn-redo').disabled = !this.history.future.length;
  }

  updateAttribution() {
    const src = new Set();
    for (const l of this.history.doc.layers) {
      if (!l.visible) continue;
      if (l.kind === 'basemap') src.add(BASEMAPS[l.settings.source]?.attribution);
      if (l.kind === 'hillshade') src.add(l.settings.source === 'terrarium' ? 'DEM: Terrarium/AWS (SRTM, GMTED, ETOPO1)' : l.settings.source === 'opentopo' ? `DEM: ${l.settings.demtype} vía OpenTopography` : 'DEM: archivo');
    }
    document.getElementById('attribution').textContent = [...src].filter(Boolean).join(' · ');
  }

  updateCoords(wp) {
    const [lon, lat] = toLonLat(wp[0], wp[1]);
    const z = this.raster.elevationAt(wp[0], wp[1]);
    document.getElementById('coords').innerHTML = `${formatDMS(lat, true)} ${formatDMS(lon, false)}<br>${Math.round(wp[0])} E ${Math.round(wp[1])} N${z != null ? ` · ${Math.round(z)} m` : ''}`;
  }

  updateContextBar() {
    const bar = document.getElementById('contextbar');
    const ed = this.editor;
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
    } else if (ed.tool === 'node' && ed.nodeTarget()) {
      items.push(
        b('Borrar nodo', () => ed.deleteActiveNode()),
        b('Esquina / curva', () => ed.activeNode && ed.toggleSmooth(ed.activeNode.id, ed.activeNode.ring, ed.activeNode.index)),
        b(this.settings.insertOnTap ? 'Insertar al tocar ✓' : 'Insertar al tocar', () => {
          this.saveSettings({ insertOnTap: !this.settings.insertOnTap });
          this.updateContextBar();
        }, this.settings.insertOnTap ? 'on' : ''),
        b('Abrir / cerrar', () => ed.toggleClosed()),
        b('Invertir', () => ed.reverseSelected()),
      );
    } else if (['select', 'lasso'].includes(ed.tool)) {
      items.push(b(ed.addMode ? 'Añadir a selección ✓' : 'Añadir a selección', () => {
        ed.addMode = !ed.addMode;
        this.updateContextBar();
      }, ed.addMode ? 'on' : ''));
      if (ed.selection.size) {
        items.push(
          b('Duplicar', () => ed.duplicate()),
          b('Copiar', () => this.copy()),
          b('Al frente', () => this.history.commit(arrange(this.history.doc, ed.selection, 'front'))),
          b('Al fondo', () => this.history.commit(arrange(this.history.doc, ed.selection, 'back'))),
          b('Eliminar', () => ed.deleteSelection()),
        );
      }
      if (this.clipboard.length) items.push(b('Pegar', () => this.paste(false)), b('Pegar en el lugar', () => this.paste(true)));
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
      groups.push([
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
        n === 1 ? it('Atributos…', '', () => this.showPanel('attrs')) : null,
        n === 1 && sel[0].type === 'text' ? it('Editar texto', 'Doble clic', () => this.editText(sel[0])) : null,
        n === 1 && sel[0].type === 'path' ? it('Editar nodos', 'A', () => ed.setTool('node')) : null,
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
        paths.length && paths.length <= 2 && paths.some((p) => !p.closed) ? it(paths.length === 1 ? 'Cerrar trazo' : 'Unir trazos', 'Ctrl+J', () => this.joinSelected()) : null,
        paths.length ? it('Invertir dirección', '', () => ed.reverseSelected()) : null,
        it('Seleccionar mismo relleno y trazo', '', () => ed.setSelection(selectSame(doc, ed.selection, 'fillstroke', { scope: 'all' }))),
      ]);
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
      () => prompt('Coordenadas', t),
    ) ?? prompt('Coordenadas', t);
  }

  joinSelected() {
    const r = joinPaths(this.history.doc, this.editor.selection, 2 * this.view.mpp);
    if (r.error) return this.message(r.error);
    this.history.commit(r.doc);
    this.editor.setSelection([r.id]);
    this.editor.snapDirty = true;
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
      const text = dt?.getData('image/svg+xml') || dt?.getData('text/plain') || '';
      const html = dt?.getData('text/html') || '';
      const files = [...(dt?.files || []), ...[...(dt?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile())];
      const img = files.find((f) => f && /^image\//.test(f.type) && f.type !== 'image/svg+xml');
      const run = async () => {
        if (img && !/<svg[\s>]/i.test(text)) return this.pasteImage(img);
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
    this.message(`Imagen pegada como capa «${name}» en el centro de la vista. Para ubicarla con precisión: Archivo → Georreferenciar imagen.`, 7000);
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
          if (img && !/<svg[\s>]/i.test(text)) return this.pasteImage(await item.getType(img));
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
    if (k === 'd') return run(() => ed.duplicate());
    if (k === 'a' && e.shiftKey) return run(() => ed.setSelection([]));
    if (k === 'a') return run(() => ed.selectAll());
    if (k === 's') return run(() => this.saveProject());
    if (k === 'o') return run(() => this.openProject().catch((err) => this.message(`Error: ${err.message}`, 6000)));
    if (k === 'p') return run(() => this.showPanel('layout'));
    if (k === 'j') return run(() => this.joinSelected());
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

  gotoCoords() {
    const t = prompt('Coordenadas: "lat, lon" (grados o 33°27\'S, 70°40\'W) o "E N" en UTM 19S', '');
    if (!t) return;
    import('./proj.js').then(({ parseDMS, fromLonLat }) => {
      const parts = t.split(/[,;]|\s{2,}/).map((p) => p.trim()).filter(Boolean);
      let x;
      let y;
      if (parts.length === 1) {
        const m = t.trim().split(/\s+/);
        if (m.length === 2 && Number(m[0]) > 1000) [x, y] = m.map(Number);
      }
      if (x == null && parts.length >= 2) {
        const a = parseDMS(parts[0]);
        const b = parseDMS(parts[1]);
        if (Math.abs(a) > 1000) [x, y] = [a, b];
        else [x, y] = fromLonLat(b, a);
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) return this.message('No entendí las coordenadas');
      this.view.cx = x;
      this.view.cy = y;
      if (this.view.mpp > 20) this.view.mpp = 10;
      this.view.emit();
    });
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

  saveProject() {
    this.flushEdits();
    const doc = this.history.doc;
    download(JSON.stringify({ app: 'GISDrawer', ...doc }), `${fileBase(doc.title)}.gisdrawer`, 'application/json');
  }

  async openProject(file = null) {
    const [f] = file ? [file] : await pickFiles('.gisdrawer,.json');
    if (!f) return;
    const raw = JSON.parse(await f.text());
    if (!raw.layers) throw new Error('No es un proyecto de GISDrawer');
    delete raw.app;
    const doc = normalizeDoc(raw);
    this.history.commit(doc);
    for (const l of doc.layers) if (l.settings?.fileId) this.reloadFile(l.settings.fileId).catch(() => null);
    this.zoomToShapes(allTopShapes(doc).map((x) => x.shape));
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
    const doc0 = this.history.doc;
    const opts = { refScale: doc0.refScale, center: [this.view.cx, this.view.cy] };
    const buf = new Uint8Array(await f.arrayBuffer());
    const head = new TextDecoder('latin1').decode(buf.subarray(0, 1024));
    let r;
    if (/%PDF-|%!PS-Adobe/.test(head) || /\.(ai|pdf)$/i.test(f.name)) {
      this.message(`Leyendo ${f.name}…`, 0);
      const { importPdf } = await import('./io/pdfImport.js');
      r = importPdf(buf, { ...opts, name: f.name.replace(/\.\w+$/, '') });
    } else {
      const { importSvg } = await import('./io/svgImport.js');
      r = importSvg(new TextDecoder().decode(buf), opts);
    }
    if (r.gisdrawer) {
      this.clipboard = r.gisdrawer.shapes;
      return this.pasteInternal(true);
    }
    let doc = doc0;
    const all = [];
    for (const L of r.layers) {
      if (!L.shapes.length) continue;
      const layer = makeVectorLayer(L.name || f.name.replace(/\.\w+$/, ''), { items: L.shapes });
      if (r.hiddenLayers?.includes(L.name)) layer.visible = false;
      doc = addLayer(doc, layer, doc.activeLayerId);
      all.push(...L.shapes);
    }
    if (!all.length) return this.message(`${f.name} no trae formas vectoriales${r.warnings.length ? ` · ${r.warnings.join(' · ')}` : ''}`, 6000);
    this.history.commit(doc);
    this.zoomToShapes(all);
    this.message(`${all.length} objeto(s) en ${r.layers.length} capa(s) desde ${f.name}${r.warnings.length ? ` · ${r.warnings.join(' · ')}` : ''}`, 6000);
  }

  /** Importa un archivo según su extensión (lo usa Google Drive, que entrega un archivo cualquiera). */
  async importFile(f) {
    const ext = (/\.(\w+)$/.exec(f.name)?.[1] || '').toLowerCase();
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
        return this.startGeoref(f);
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
      const link = prompt('Enlace de Google Drive del archivo (compartido con «cualquier persona con el enlace»):', '');
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

  configureDrive() {
    const s = this.settings;
    const clientId = prompt(
      'Google Drive — ID de cliente OAuth (opcional; habilita el selector de archivos con tu cuenta).\n' +
        'Google Cloud Console → APIs y servicios → Credenciales → ID de cliente de OAuth, tipo «Aplicación web», ' +
        `con ${location.origin} en «Orígenes de JavaScript autorizados». Activa «Google Drive API» y «Google Picker API».`,
      s.googleClientId || '',
    );
    if (clientId === null) return;
    const apiKey = prompt('Google Drive — Clave de API del mismo proyecto (Credenciales → Crear credenciales → Clave de API).\nSin ID de cliente, sirve para abrir archivos compartidos por enlace.', s.googleApiKey || '');
    if (apiKey === null) return;
    this.saveSettings({ googleClientId: clientId.trim(), googleApiKey: apiKey.trim() });
    this.message(clientId.trim() || apiKey.trim() ? 'Google Drive configurado: Archivo → Importar → Desde Google Drive' : 'Google Drive sin configurar', 5000);
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
      if (!info.epsg) rec.epsg = Number(prompt('El GeoTIFF no declara su sistema. EPSG:', '32719')) || null;
    } else {
      rec.epsg = Number(prompt('Sistema del ASCII grid (EPSG):', '4326')) || 4326;
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
    const rec = { kind: 'image', name: f.name, buffer, epsg: info.epsg ? null : Number(prompt('El GeoTIFF no declara su sistema. EPSG:', '32719')) || null };
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
  async exportView(kind) {
    const w = Math.round(this.view.w);
    const hgt = Math.round(this.view.h);
    const stage = document.getElementById('stage');
    if (kind === 'svg') {
      const parts = [];
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
    ['V', 'Selección'], ['A', 'Nodos'], ['Q', 'Lazo'], ['P', 'Pluma / línea'], ['Y', 'Polígono'], ['B', 'Lápiz'],
    ['\\', 'Segmento'], ['W', 'Flecha'], ['M', 'Rectángulo'], ['E', 'Elipse'], ['T', 'Texto'], ['O', 'Punto'],
    ['C', 'Tijera'], ['I', 'Cuentagotas'], ['H', 'Mano'], ['Z', 'Zoom (Alt = alejar)'], ['Espacio', 'Mano temporal'],
  ]],
  ['Color', [['X', 'Alternar relleno / trazo'], ['Mayús+X', 'Intercambiar relleno y trazo'], ['D', 'Colores predeterminados'], ['/', 'Ninguno']]],
  ['Edición', [
    ['Ctrl+Z / Ctrl+Mayús+Z', 'Deshacer / rehacer'], ['Ctrl+C / X / V', 'Copiar / cortar / pegar (también desde y hacia Illustrator)'], ['Ctrl+F / Ctrl+B', 'Pegar en el lugar delante / detrás'],
    ['Ctrl+D', 'Duplicar'], ['Alt+arrastrar', 'Duplicar al mover'], ['Supr', 'Eliminar'], ['Flechas', 'Mover 1 px (Mayús: 10)'],
    ['Ctrl+A / Ctrl+Mayús+A', 'Seleccionar todo / nada'], ['Ctrl+G / Ctrl+Mayús+G', 'Agrupar / desagrupar'], ['Ctrl+J', 'Unir o cerrar trazos'],
    ['Ctrl+7 / Ctrl+Alt+7', 'Máscara de recorte / liberar'], ['Ctrl+] / Ctrl+[', 'Adelante / atrás (Mayús: al frente / al fondo)'],
    ['Ctrl+2 / Ctrl+Alt+2', 'Bloquear / desbloquear todo'], ['Ctrl+3 / Ctrl+Alt+3', 'Ocultar / mostrar todo'], ['Mayús+C', 'Nodo esquina ↔ curva'],
  ]],
  ['Dibujo', [['Enter / doble clic', 'Terminar línea'], ['Clic en el 1er vértice', 'Cerrar polígono'], ['⌫', 'Quitar último vértice'], ['Esc', 'Cancelar'], ['S / K', 'Snapping / trace'], ['Mayús', 'Restringir ángulo o proporción']]],
  ['Vista y archivo', [
    ['Ctrl+0', 'Zoom a todo'], ['Ctrl+1', 'Escala de referencia'], ['Ctrl++ / Ctrl+−', 'Acercar / alejar'], ['Rueda del mouse', 'Zoom (Archivo → Vista: cambiar a desplazar)'], ['Trackpad', 'Dos dedos desplazan, pellizco = zoom'],
    ['Tab', 'Mostrar / ocultar panel'], ['F7 / Ctrl+F10', 'Capas / Estilo'], ['Ctrl+L', 'Capa nueva'], ['Ctrl+S / Ctrl+O', 'Guardar / abrir proyecto'], ['Ctrl+P', 'Layout de impresión'], ['? o F1', 'Esta ayuda'],
  ]],
  ['Ratón y tablet', [['Botón derecho', 'Menú contextual (o terminar línea)'], ['Mantener el dedo', 'Menú contextual'], ['Un dedo / dos dedos', 'Desplazar / zoom'], ['Toque corto con el dedo', 'Seleccionar']]],
];

function helpContent(close) {
  return [
    h('div', { class: 'help-card' },
      h('div', { class: 'help-head' }, h('h2', {}, 'Atajos de teclado'), h('button', { class: 'help-x', onclick: close, 'aria-label': 'Cerrar' }, '✕')),
      h('p', { class: 'hint' }, `Inspirados en Illustrator. En Mac, Ctrl es ⌘ y Alt es ⌥. Versión de la app: ${APP_VERSION}.`),
      h('div', { class: 'help-grid' }, ...SHORTCUTS.map(([title, rows]) => h('section', {}, h('h3', {}, title), h('table', {}, ...rows.map(([k, d]) => h('tr', {}, h('td', {}, h('kbd', {}, k)), h('td', {}, d))))))),
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
