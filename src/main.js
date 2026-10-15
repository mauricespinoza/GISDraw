/**
 * GISDrawer: arranque y pegamento entre documento, vista, editor, capas raster,
 * paneles y archivos.
 */

import { History, addLayer, findLayer, layerOfShape, makeRasterLayer, makeVectorLayer, mapShapes, newDocument, updateLayer, allTopShapes } from './doc.js';
import { View, paperUnits } from './view.js';
import { Editor, TOOLS } from './editor.js';
import { StageRenderer } from './render.js';
import { RasterView, demFiles, imageFiles } from './raster/rasterView.js';
import { BASEMAPS } from './raster/basemap.js';
import { Panels } from './ui/panels.js';
import { LayoutEditor } from './ui/layoutEditor.js';
import { ICONS } from './ui/icons.js';
import { h } from './ui/dom.js';
import { defaultStyle } from './style.js';
import { copyShapes, pasteShapes, arrange, group, ungroup } from './ops.js';
import { formatDMS, toLonLat } from './proj.js';
import { shapeBBox, unionBBox, walkShapes, newId } from './vector.js';
import { saveDoc, loadDoc, saveFile, loadFile, download, pickFiles } from './io/store.js';
import { parseQML, styleFor } from './io/qml.js';
import { parseAsciiGrid } from './raster/dem.js';
import { lonLatToTransform } from './io/crs.js';

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
    this.observeSize();
    this.restore();
  }

  /* ------------------------------------------------------------- estado */

  saveSettings(patch) {
    Object.assign(this.settings, patch);
    writeJSON(SETTINGS_KEY, this.settings);
    this.syncToggles();
  }

  setCurrentStyle(st) {
    this.currentStyle = { ...defaultStyle(), ...st };
    writeJSON('gd.style', this.currentStyle);
    this.updateSwatch();
    if (this.panels.tab === 'style') this.panels.render();
  }

  layerOf(id) {
    return layerOfShape(this.history.doc, id);
  }

  onDocChange(doc, meta = {}) {
    if (!meta.preview) this.editor.pruneSelection();
    this.editor.snapDirty = true;
    this.renderer.request();
    if (!meta.preview) {
      if (!this.layout.el.hidden) this.layout.schedule();
      this.panels.render();
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
      if (['style', 'attrs', 'arrange'].includes(this.panels.tab)) this.panels.render();
    }
    this.updateSwatch();
    if (this.editor.hover?.wp) this.updateCoords(this.editor.hover.wp);
  }

  onViewChange() {
    this.renderer.request();
    if (document.activeElement !== this.scaleInput) this.scaleInput.value = Math.round(this.view.scale).toLocaleString('es-CL');
    clearTimeout(this.viewSaveT);
    this.viewSaveT = setTimeout(() => writeJSON('gd.view', { cx: this.view.cx, cy: this.view.cy, mpp: this.view.mpp }), 400);
  }

  scheduleSave() {
    clearTimeout(this.saveT);
    this.saveT = setTimeout(() => saveDoc(this.history.doc), 800);
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
      this.history.reset(saved);
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
    const groups = [['select', 'node', 'lasso'], ['pen', 'polygon', 'pencil', 'line', 'arrow'], ['rect', 'ellipse', 'text', 'point'], ['eyedropper', 'pan']];
    const els = [];
    groups.forEach((g, gi) => {
      if (gi) els.push(h('div', { class: 'tsep' }));
      for (const t of g) {
        const b = h('button', { 'data-tool': t, title: `${TOOLS[t].label} (${TOOLS[t].key.toUpperCase()})`, html: ICONS[t], onclick: () => this.editor.setTool(t) });
        els.push(b);
      }
    });
    this.swatch = h('div', { class: 'swatch', title: 'Relleno y trazo actuales (abre Estilo)', onclick: () => this.showPanel('style') }, h('div', { style: { left: '0', top: '0' } }), h('div', { style: { left: '10px', top: '10px' } }));
    els.push(h('div', { class: 'tsep' }), this.swatch);
    this.toolbarEl.replaceChildren(...els);
    this.updateSwatch();
  }

  updateSwatch() {
    if (!this.swatch) return;
    const sel = this.editor.selectedShapes()[0];
    const st = sel?.style || this.currentStyle;
    const [fill, stroke] = this.swatch.children;
    const none = 'linear-gradient(45deg, transparent 45%, #ef4444 45%, #ef4444 55%, transparent 55%), #fff';
    fill.style.background = st.fill && st.fill !== 'none' ? st.fill : none;
    stroke.style.background = 'transparent';
    stroke.style.border = `5px solid ${st.stroke && st.stroke !== 'none' ? st.stroke : '#ef4444'}`;
    stroke.style.outline = '1px solid #fff';
  }

  buildTopbar() {
    const $ = (id) => document.getElementById(id);
    $('btn-undo').onclick = () => this.history.undo();
    $('btn-redo').onclick = () => this.history.redo();
    $('btn-snap').onclick = () => this.saveSettings({ snap: !this.settings.snap });
    $('btn-trace').onclick = () => this.saveSettings({ trace: !this.settings.trace });
    $('btn-finger').onclick = () => this.saveSettings({ fingerDraws: !this.settings.fingerDraws });
    $('btn-panel').onclick = () => document.getElementById('app').classList.toggle('panel-hidden');
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
      h('div', { class: 'mh' }, 'Exportar'),
      item('GeoPackage (todas las capas, con estilo QGIS)', () => this.exportGpkg()),
      item('GeoJSON de la capa activa (WGS84)', () => this.exportGeoJSON(true)),
      item('GeoJSON de la capa activa (UTM 19S)', () => this.exportGeoJSON(false)),
      item('Imagen PNG de la vista', () => this.exportView('png')),
      item('SVG de la vista (vectorial)', () => this.exportView('svg')),
      h('div', { class: 'mh' }, 'Vista'),
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

  /* --------------------------------------------------------- edición */

  /** Cambia el estilo de la selección (todas las hojas de los grupos) o el de dibujo. */
  editStyle(patch, final) {
    const ed = this.editor;
    const sel = ed.selectedShapes();
    if (!sel.length) {
      this.setCurrentStyle({ ...this.currentStyle, ...patch });
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

  copy() {
    this.clipboard = copyShapes(this.history.doc, this.editor.selection);
    this.message(`${this.clipboard.length} objeto(s) copiado(s)`);
    this.updateContextBar();
  }

  cut() {
    this.copy();
    this.editor.deleteSelection();
  }

  paste(inPlace) {
    if (!this.clipboard.length) return;
    const layer = this.editor.ensureDrawableLayer();
    if (!layer) return;
    const r = pasteShapes(this.history.doc, this.clipboard, layer.id, { inPlace, offset: inPlace ? 0 : 12 * this.view.mpp });
    this.history.commit(r.doc);
    this.editor.setSelection(r.ids);
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
    if (k === 'z' && !e.shiftKey) return run(() => this.history.undo());
    if ((k === 'z' && e.shiftKey) || k === 'y') return run(() => this.history.redo());
    if (k === 'c') return run(() => this.copy());
    if (k === 'x') return run(() => this.cut());
    if (k === 'v') return run(() => this.paste(e.shiftKey || e.altKey));
    if (k === 'f' && e.shiftKey) return run(() => this.paste(true)); // como "pegar delante" de Illustrator
    if (k === 'd') return run(() => ed.duplicate());
    if (k === 'a') return run(() => ed.selectAll());
    if (k === 's') return run(() => this.saveProject());
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

  /* --------------------------------------------------------- texto */

  editText(shape, isNew = false) {
    const ta = document.getElementById('text-editor');
    const [x, y] = this.view.toScreen(shape.x, shape.y);
    ta.style.left = `${Math.max(4, x)}px`;
    ta.style.top = `${Math.max(4, y - 30)}px`;
    ta.value = shape.text;
    ta.hidden = false;
    ta.focus();
    ta.select();
    const done = (save) => {
      ta.hidden = true;
      ta.onblur = null;
      ta.onkeydown = null;
      const v = ta.value;
      if (!save) {
        if (isNew) this.editor.deleteSelection();
        return;
      }
      if (!v.trim()) {
        this.history.commit(mapShapes(this.history.doc, [shape.id], () => null));
        return;
      }
      if (v !== shape.text) this.history.commit(mapShapes(this.history.doc, [shape.id], (s) => ({ ...s, text: v, name: v.split('\n')[0].slice(0, 40) })));
      if (isNew) this.editor.setTool('select');
    };
    ta.onblur = () => done(true);
    ta.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        ta.blur();
      }
      if (e.key === 'Escape') {
        ta.onblur = null;
        done(false);
      }
    };
  }

  /* --------------------------------------------------------- vista */

  zoomToShapes(shapes) {
    const box = unionBBox(shapes.map((s) => shapeBBox(s, this.editor.est())));
    if (box) this.view.fit(box.w || box.h ? box : { x: box.x - 500, y: box.y - 500, w: 1000, h: 1000 });
  }

  zoomToImage(layer) {
    const img = imageFiles.get(layer.settings.fileId);
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

  async startGeoref() {
    const { startGeoref } = await import('./ui/georefSession.js');
    return startGeoref(this);
  }

  layoutPanel() {
    return this.layout.panel();
  }

  /* --------------------------------------------------------- archivos */

  saveProject() {
    const doc = this.history.doc;
    download(JSON.stringify({ app: 'GISDrawer', ...doc }), `${(doc.title || 'dibujo').replace(/\W+/g, '_')}.gisdrawer`, 'application/json');
  }

  async openProject() {
    const [f] = await pickFiles('.gisdrawer,.json');
    if (!f) return;
    const doc = JSON.parse(await f.text());
    if (!doc.layers) throw new Error('No es un proyecto de GISDrawer');
    delete doc.app;
    this.history.commit(doc);
    for (const l of doc.layers) if (l.settings?.fileId) this.reloadFile(l.settings.fileId).catch(() => null);
    this.zoomToShapes(allTopShapes(doc).map((x) => x.shape));
  }

  async importGpkg() {
    const files = await pickFiles('.gpkg', true);
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

  async importGeoJSON() {
    const files = await pickFiles('.geojson,.json', true);
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

  async applyQmlToLayer(layerId) {
    const layer = findLayer(this.history.doc, layerId);
    if (!layer || layer.kind !== 'vector') return this.message('Elige una capa vectorial');
    const [f] = await pickFiles('.qml,.qlr,.xml');
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
    const { readGeoTIFF, geotiffToUtmImage } = await import('./io/geotiff.js');
    const info = await readGeoTIFF(rec.buffer, { epsgOverride: rec.epsg || null });
    return geotiffToUtmImage(info);
  }

  async importDemForLayer(layerId) {
    const [f] = await pickFiles('.tif,.tiff,.asc');
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

  async importImage() {
    const [f] = await pickFiles('.tif,.tiff');
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
    download(new Blob([bytes], { type: 'application/geopackage+sqlite3' }), `${(this.history.doc.title || 'dibujo').replace(/\W+/g, '_')}.gpkg`);
    this.message('GeoPackage exportado (EPSG:32719, con estilo QGIS)');
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
  navigator.serviceWorker.register('sw.js').catch(() => null);
}

export { paperUnits, walkShapes };
