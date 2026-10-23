/**
 * Paneles laterales: Capas, Estilo, Geología, Etiquetas, Relieve, Organizar,
 * Atributos, Georreferenciación y Layout.
 *
 * Cada panel se reconstruye entero cuando cambia algo que muestra (selección,
 * capa activa, documento confirmado). Durante un arrastre de deslizador o de
 * selector de color NO se reconstruye: el cambio va como vista previa al
 * historial y se confirma al soltar, así un ajuste completo es UN deshacer.
 */

import { adjustRuns } from '../richText.js';
import { BLEND_MODES, defaultLabels, findLayer, makeRasterLayer, makeVectorLayer, addLayer, removeLayer, moveLayer, duplicateLayer, updateLayer, mapShapes, layerOfShape, layerColor } from '../doc.js';
import { DASHES, MARKERS, POINT_SHAPES, defaultStyle, textMeasurer } from '../style.js';
import { ORNAMENTS, ORNAMENT_LIMITS, ornamentDefaults } from '../ornaments.js';
import { PATTERNS, PATTERN_GROUPS, patternPreview } from '../patterns.js';
import { BASEMAPS } from '../raster/basemap.js';
import { DEM_SOURCES, OPENTOPO_TYPES } from '../raster/dem.js';
import { PALETTES, defaultHillshadeSettings, paletteLUT } from '../raster/hillshade.js';
import { SAME_CRITERIA, align, arrange, distribute, group, moveToLayer, selectByAttribute, selectSame, ungroup } from '../ops.js';
import { measure, shapeBBox, unionBBox, walkShapes } from '../vector.js';
import { LABEL_SEPARATORS, labelText } from '../labels.js';
import { RAMPS, applyRenderer, buildRenderer, clearRenderer, countClasses, defaultRendererOptions, fieldChoices, rampCss } from '../symbology.js';
import { h, sec, row, select, slider, num, text, color, check, btn, closePopSliders } from './dom.js';
import { TAB_ICONS, LAYER_ICONS } from './icons.js';
import { askConfirm, askText } from './dialog.js';
import { alignOf, layoutText } from '../textLayout.js';
import { CANVAS_SIZES, CANVAS_TABS, GIS_TABS, canvasDefaults, canvasMm, isGisLayer, normalizeCanvas } from '../mode.js';

/** Validador de un nombre de campo nuevo: no vacío, sin repetir. */
const fieldName = (existing = []) => (v) => {
  if (!v) return 'Escribe un nombre.';
  if (existing.includes(v)) return `El campo «${v}» ya existe.`;
  return '';
};

export const TABS = {
  layers: 'Capas',
  canvas: 'Lienzo',
  style: 'Estilo',
  geology: 'Geología',
  labels: 'Etiquetas',
  relief: 'Relieve',
  arrange: 'Organizar',
  attrs: 'Atributos',
  georef: 'Georref.',
  layout: 'Layout',
};

/** Tipos de línea de FieldDraw: colores y grosores (mm de papel) de su simbología. */
const LINE_PRESETS = [
  { short: 'Contacto', label: 'Contacto', style: { stroke: '#000000', strokeWidth: 0.35 } },
  { short: 'Inversa', label: 'Falla inversa / cabalgamiento', style: { stroke: '#0000ff', strokeWidth: 0.5, ...ornamentDefaults('thrust') } },
  { short: 'Normal', label: 'Falla normal', style: { stroke: '#0000ff', strokeWidth: 0.45, ...ornamentDefaults('normal') } },
  { short: 'Dextral', label: 'Falla dextral', style: { stroke: '#0000ff', strokeWidth: 0.45, ...ornamentDefaults('dextral') } },
  { short: 'Sinestral', label: 'Falla sinestral', style: { stroke: '#0000ff', strokeWidth: 0.45, ...ornamentDefaults('sinistral') } },
  { short: 'Falla ind.', label: 'Falla indiferenciada', style: { stroke: '#0000ff', strokeWidth: 0.4 } },
  { short: 'Antiforme', label: 'Antiforme (traza axial)', style: { stroke: '#ff00ff', strokeWidth: 0.45, ...ornamentDefaults('antiform') } },
  { short: 'Sinforme', label: 'Sinforme (traza axial)', style: { stroke: '#ff00ff', strokeWidth: 0.45, ...ornamentDefaults('synform') } },
  { short: 'Dique', label: 'Dique', style: { stroke: '#ff0000', strokeWidth: 0.4 } },
  { short: 'Discordancia', label: 'Discordancia (ondulada)', style: { stroke: '#000000', strokeWidth: 0.35, wavy: true, waveAmp: 0.7, waveLen: 3.6 } },
];

/** Colores rápidos: los de la simbología geológica habitual y unos neutros. */
const QUICK_COLORS = ['#000000', '#4b5563', '#9ca3af', '#ffffff', '#0000ff', '#ff0000', '#ff00ff', '#8b4513', '#15803d', '#86efac', '#fde047', '#f97316', '#0ea5e9', '#c4b5fd'];

/** Grosor máximo del trazo (mm de papel) y su escala cuadrática en el deslizador (0–1000). */
const MAX_STROKE = 30;
const widthOf = (v) => +(MAX_STROKE * (v / 1000) ** 2).toFixed(2);

/** Tamaño máximo del símbolo de punto (mm de papel), también en escala cuadrática. */
const MAX_POINT = 60;
const pointOf = (v) => Math.max(0.2, +(MAX_POINT * (v / 1000) ** 2).toFixed(2));

export const FONTS = {
  'Helvetica, Arial, sans-serif': 'Helvetica / Arial',
  "'Times New Roman', Times, serif": 'Times',
  'Georgia, serif': 'Georgia',
  "'Gill Sans', 'Gill Sans MT', Calibri, sans-serif": 'Gill Sans',
  "Futura, 'Trebuchet MS', sans-serif": 'Futura',
  "'Avenir Next', Avenir, sans-serif": 'Avenir',
  "Optima, 'Segoe UI', sans-serif": 'Optima',
  "'Courier New', monospace": 'Courier',
};

export class Panels {
  constructor(app) {
    this.app = app;
    this.tab = localStorage.getItem('gd.tab') || 'layers';
    if (!this.tabAllowed(this.tab)) this.tab = 'layers';
    this.tabsEl = document.getElementById('tabs');
    this.body = document.getElementById('panel-body');
    this.expanded = new Set();
    this.renderTabs();
  }

  renderTabs() {
    this.tabsEl.replaceChildren(
      ...Object.entries(TABS).filter(([k]) => this.tabAllowed(k)).map(([k, label]) =>
        h('button', { class: k === this.tab ? 'on' : '', onclick: () => this.show(k), 'aria-label': label }, h('span', { class: 'tab-ico', html: TAB_ICONS[k] || '' }), h('span', {}, label)),
      ),
    );
  }

  /** Relieve, Georref. y Atributos solo en GIS; Lienzo solo en Canvas. */
  tabAllowed(k) {
    return this.app.mode === 'gis' ? !CANVAS_TABS.includes(k) : !GIS_TABS.includes(k);
  }

  show(tab) {
    this.tab = tab;
    try {
      localStorage.setItem('gd.tab', tab);
    } catch {
      /* sin almacenamiento */
    }
    this.renderTabs();
    this.render();
    this.onShow?.(tab);
  }

  render() {
    closePopSliders();
    const scroll = this.body.scrollTop;
    if (!this.tabAllowed(this.tab)) this.tab = 'layers';
    const fn = {
      layers: () => this.layersPanel(),
      canvas: () => this.canvasPanel(),
      style: () => this.stylePanel(),
      geology: () => this.geologyPanel(),
      labels: () => this.labelsPanel(),
      relief: () => this.reliefPanel(),
      arrange: () => this.arrangePanel(),
      attrs: () => this.attrsPanel(),
      georef: () => (this.app.georef ? this.app.georef.panel() : this.georefIntro()),
      layout: () => this.app.layoutPanel(),
    }[this.tab];
    this.body.replaceChildren(...[].concat(fn()));
    this.body.scrollTop = scroll;
  }

  get doc() {
    return this.app.history.doc;
  }

  georefIntro() {
    return sec(
      'Georreferenciación',
      h('p', { class: 'hint' }, 'Carga un mapa escaneado, una foto o una figura (JPG, PNG o TIFF) y ubícala con puntos de control: un toque en la imagen y otro en el mapa. Transformaciones Helmert, afín, polinomial y thin-plate spline, con residuos por punto.'),
      btn('Abrir imagen para georreferenciar…', () => this.app.startGeoref(), 'primary'),
    );
  }

  /* ================================================================ LIENZO */

  canvasPanel() {
    const app = this.app;
    const c = normalizeCanvas(this.doc.canvas);
    const [w, hh] = canvasMm(c);
    const d = canvasDefaults(c);
    const sizes = { ...Object.fromEntries(Object.entries(CANVAS_SIZES).map(([k, v]) => [k, `${v.label} (${v.mm[0]} × ${v.mm[1]} mm)`])), custom: 'Personalizado…' };
    const orient = (o, label) => btn(label, () => app.setCanvas({ orientation: o }), c.orientation === o ? 'primary' : '');
    const custom =
      c.size === 'custom'
        ? [
            row('Ancho (mm)', num(c.w, (v) => v >= 10 && app.setCanvas({ size: 'custom', w: v }), { step: 1, min: 10 })),
            row('Alto (mm)', num(c.h, (v) => v >= 10 && app.setCanvas({ size: 'custom', h: v }), { step: 1, min: 10 })),
          ]
        : [];
    return [
      sec(
        'Hoja',
        row('Tamaño', select(sizes, c.size, (v) => app.setCanvas(v === 'custom' ? { size: 'custom', w: w, h: hh } : { size: v }))),
        ...custom,
        h('div', { class: 'grid-btns two' }, orient('portrait', 'Vertical'), orient('landscape', 'Horizontal')),
        h('p', { class: 'hint' }, `Hoja de ${Math.round(w)} × ${Math.round(hh)} mm. El dibujo puede salir de la hoja; la hoja marca el área de la lámina.`),
        c.size === 'custom' ? h('p', { class: 'hint' }, 'Arrastra los vértices o los bordes de la hoja en el lienzo para cambiar su tamaño (se redondea al mm).') : null,
        btn('▣ Encajar a objetos', () => app.fitCanvasToObjects()),
        h('p', { class: 'hint' }, 'Reduce (o amplía) la hoja a la caja exacta de lo dibujado en las capas visibles y la deja como Personalizado.'),
        btn('⛶ Encuadrar la hoja', () => app.fitCanvas()),
      ),
      sec(
        'Valores por defecto',
        h('p', { class: 'hint' }, `Para una figura de media hoja: trazo de ${d.strokeWidth} mm y letra de ${d.fontSize} pt${c.size === 'A4' ? ' (A4)' : ` (a escala de ${Math.round(d.factor * 100)} % respecto de A4)`}. Al cambiar el tamaño de la hoja se vuelven a calcular.`),
        row('Grosor de trazo (mm)', num(app.currentStyle.strokeWidth, (v) => v > 0 && app.setCurrentStyle({ ...app.currentStyle, strokeWidth: v }), { step: 0.05, min: 0.05, slide: [0.05, 5], log: true })),
        row('Letra (pt)', num(app.currentStyle.fontSize || 10, (v) => v > 0 && app.setCurrentStyle({ ...app.currentStyle, fontSize: v }), { step: 0.5, min: 1, slide: [4, 72], log: true })),
        btn('Usar los de media hoja', () => app.applyCanvasDefaults()),
      ),
    ];
  }

  /* ================================================================ CAPAS */

  layersPanel() {
    const app = this.app;
    const doc = this.doc;
    const list = h('div', {});
    // de arriba hacia abajo, como en cualquier programa de dibujo
    // capas a las que pertenece lo seleccionado: se resaltan con color
    const selLayers = new Set([...app.editor.selection].map((id) => layerOfShape(doc, id)?.id));
    for (const l of [...doc.layers].reverse()) if (app.mode === 'gis' || !isGisLayer(l)) list.append(this.layerRow(l, selLayers.has(l.id)));
    const tip = (el, t) => (el && el.setAttribute('data-tip', t), el);
    const add = h(
      'div',
      { class: `grid-btns${app.mode === 'gis' ? '' : ' one'}` },
      tip(btn('+ Capa', () => {
        const l = makeVectorLayer(`Capa ${doc.layers.filter((x) => x.kind === 'vector').length + 1}`);
        app.history.commit(addLayer(this.doc, l, this.doc.activeLayerId));
      }), 'Capa vectorial nueva, sobre la activa'),
      app.mode === 'gis' && tip(btn('+ Mapa', () => {
        const l = makeRasterLayer('basemap', 'Mapa base: Esri satélite', { source: 'esri_imagery' });
        app.history.commit({ ...addLayer(this.doc, l), layers: [l, ...this.doc.layers] });
      }), 'Mapa base en línea (satélite, topográfico…), al fondo'),
      app.mode === 'gis' && tip(btn('+ Relieve', () => {
        const l = makeRasterLayer('hillshade', 'Relieve sombreado', defaultHillshadeSettings());
        const layers = this.doc.layers.slice();
        // por defecto sobre los mapas base y bajo el dibujo
        const firstVector = layers.findIndex((x) => x.kind === 'vector');
        layers.splice(firstVector < 0 ? layers.length : firstVector, 0, l);
        app.history.commit({ ...this.doc, layers });
        this.show('relief');
      }), 'Relieve sombreado de un modelo de elevación, bajo el dibujo'),
    );
    // mostrar / ocultar / bloquear / desbloquear todas las capas visibles en la lista (las del otro modo no se tocan)
    const setAll = (key, value, msg) => {
      const shown = new Set(this.doc.layers.filter((l) => app.mode === 'gis' || !isGisLayer(l)).map((l) => l.id));
      if (!this.doc.layers.some((l) => shown.has(l.id) && !!l[key] !== value)) return app.message(msg);
      app.history.commit({ ...this.doc, layers: this.doc.layers.map((l) => (shown.has(l.id) ? { ...l, [key]: value } : l)) });
    };
    const all = h(
      'div',
      { class: 'grid-btns two' },
      tip(btn('Show all', () => setAll('visible', true, 'Todas las capas ya están visibles')), 'Mostrar todas las capas'),
      tip(btn('Hide all', () => setAll('visible', false, 'Todas las capas ya están ocultas')), 'Ocultar todas las capas'),
      tip(btn('Lock all', () => setAll('locked', true, 'Todas las capas ya están bloqueadas')), 'Bloquear todas las capas'),
      tip(btn('Unlock all', () => setAll('locked', false, 'Ninguna capa está bloqueada')), 'Desbloquear todas las capas'),
    );
    return [
      sec('Capas', list, all, add),
      sec(
        'Documento',
        app.mode === 'gis' && row('Escala ref. 1:', num(doc.refScale, (v) => v > 0 && app.history.commit({ ...this.doc, refScale: v }), { step: 500 })),
        h('p', { class: 'hint' }, `Grosores (mm) y textos (pt) se miden en el papel a esta escala.${app.mode === 'gis' ? ' Sistema: WGS84 / UTM 19S (EPSG:32719).' : ''}`),
      ),
    ];
  }

  layerRow(l, hasSel = false) {
    const app = this.app;
    const doc = this.doc;
    const active = l.id === doc.activeLayerId;
    const set = (patch, final = true) => {
      const next = updateLayer(this.doc, l.id, (x) => ({ ...x, ...patch }));
      if (final) app.history.commit(next);
      else app.history.preview(next);
    };
    const kindIcon = h('span', { class: 'kind-ico', html: LAYER_ICONS[l.kind] || '' });
    const count = l.kind === 'vector' ? h('small', {}, `(${l.items.length})`) : null;
    const name = h(
      'div',
      {
        class: 'name',
        title: 'Toca para activar; doble toque para renombrar',
        onclick: () => {
          if (l.kind === 'vector') app.history.silent({ ...this.doc, activeLayerId: l.id });
          else if (l.kind === 'hillshade') {
            this.reliefLayerId = l.id;
          }
          if (this.expanded.has(l.id)) this.expanded.delete(l.id);
          else this.expanded.add(l.id);
          this.render();
        },
        ondblclick: async () => {
          const n = await askText('Renombrar capa', l.name, { label: 'Nombre', validate: (v) => (v ? '' : 'Escribe un nombre.') });
          if (n) set({ name: n });
        },
      },
      kindIcon,
      ` ${l.name}`,
      count,
    );
    const el = h(
      'div',
      { class: `layer${active ? ' active' : ''}${hasSel ? ' has-sel' : ''}`, style: `--lc:${layerColor(doc, l.id)}` },
      h('button', { class: `ico${l.visible ? '' : ' off'}`, title: 'Visible', html: l.visible ? LAYER_ICONS.eye : LAYER_ICONS.eyeOff, onclick: () => set({ visible: !l.visible }) }),
      h('button', { class: `ico${l.locked ? '' : ' off'}`, title: 'Bloqueo', html: l.locked ? LAYER_ICONS.lock : LAYER_ICONS.unlock, onclick: () => set({ locked: !l.locked }) }),
      name,
      h(
        'div',
        {},
        h('button', { class: 'ico', title: 'Subir', html: LAYER_ICONS.up, onclick: () => app.history.commit(moveLayer(this.doc, l.id, +1)) }),
        h('button', { class: 'ico', title: 'Bajar', html: LAYER_ICONS.down, onclick: () => app.history.commit(moveLayer(this.doc, l.id, -1)) }),
      ),
    );
    if (this.expanded.has(l.id)) {
      const more = h('div', { class: 'more' });
      more.append(
        row(
          'Opacidad',
          ...slider({
            min: 0,
            max: 100,
            value: Math.round(l.opacity * 100),
            fmt: (v) => `${v}%`,
            oninput: (v) => set({ opacity: v / 100 }, false),
            onchange: (v) => set({ opacity: v / 100 }),
          }),
        ),
        row('Fusión', select(BLEND_MODES, l.blend || 'normal', (v) => set({ blend: v }))),
      );
      if (l.kind === 'basemap') {
        more.append(row('Fuente', select(Object.fromEntries(Object.entries(BASEMAPS).map(([k, b]) => [k, b.label])), l.settings.source, (v) => set({ settings: { ...l.settings, source: v }, name: `Mapa base: ${BASEMAPS[v].label}` }))));
      }
      const actions = h('div', { class: 'grid-btns' });
      if (l.kind === 'vector') {
        actions.append(
          btn('Zoom a capa', () => app.zoomToShapes(l.items)),
          app.mode === 'gis' && btn('Aplicar QML/QLR', () => app.applyQmlToLayer(l.id)),
          btn('Seleccionar todo', () => {
            app.history.silent({ ...this.doc, activeLayerId: l.id });
            app.editor.setSelection(l.items.filter((s) => !s.locked && s.visible !== false).map((s) => s.id));
          }),
        );
      }
      if (l.kind === 'image') actions.append(btn('Zoom a imagen', () => app.zoomToImage(l)));
      actions.append(
        btn('Duplicar', () => app.history.commit(duplicateLayer(this.doc, l.id))),
        btn('Eliminar', async () => {
          const n = l.shapes?.length || 0;
          if (await askConfirm(`Se eliminará la capa «${l.name}»${n ? ` con ${n} objeto(s)` : ''}. Se puede deshacer con Ctrl+Z.`, { title: 'Eliminar capa', ok: 'Eliminar', danger: true })) app.history.commit(removeLayer(this.doc, l.id));
        }, 'danger'),
      );
      more.append(actions);
      el.append(more);
    }
    return el;
  }

  /* ================================================================ ESTILO */

  /** Estilo que se muestra: el del primer objeto seleccionado, o el de dibujo. */
  shownStyle() {
    const shapes = this.app.editor.selectedShapes();
    let target = null;
    for (const s of shapes) {
      walkShapes([s], (x) => {
        if (!target && x.style) target = x;
      });
    }
    return { style: { ...defaultStyle(), ...(target ? target.style : this.app.currentStyle) }, target, shapes };
  }

  stylePanel() {
    const app = this.app;
    const { style: s, target, shapes } = this.shownStyle();
    const edit = (patch, final = true) => app.editStyle(patch, final);
    const live = (k) => (v) => edit({ [k]: v }, false);
    const fin = (k) => (v) => edit({ [k]: v }, true);
    const pct = (k) =>
      slider({ min: 0, max: 100, value: Math.round((s[k] ?? 1) * 100), fmt: (v) => `${v}%`, oninput: (v) => live(k)(v / 100), onchange: (v) => fin(k)(v / 100) });

    const lockedLayer = findLayer(this.doc, this.doc.activeLayerId);
    const head = lockedLayer?.locked && !shapes.length
      ? h('p', { class: 'hint target' }, `La capa activa «${lockedLayer.name}» está bloqueada: sus objetos no se pueden seleccionar ni editar (desbloquéala con el candado en Capas). Lo de aquí vale para lo próximo que dibujes en otra capa.`)
      : this.styleHead(shapes);
    const quick = (k) =>
      h(
        'div',
        { class: 'quick-colors' },
        ...QUICK_COLORS.map((c) => h('button', { class: `qc${s[k] === c ? ' on' : ''}`, style: `--c:${c}`, title: c, 'aria-label': c, onclick: () => edit({ [k]: c }) })),
      );

    const hasFill = s.fill && s.fill !== 'none';
    const fillSec = sec(
      'Relleno',
      row(
        'Relleno',
        check('Con relleno', hasFill, (v) => edit({ fill: v ? s.lastFill || '#86efac' : 'none', lastFill: hasFill ? s.fill : s.lastFill })),
        color(hasFill ? s.fill : s.lastFill || '#86efac', live('fill'), fin('fill')),
      ),
      quick('fill'),
      row('Opacidad', ...pct('fillOpacity')),
      row('Tipo', select({ solid: 'Sólido', linear: 'Degradado lineal', radial: 'Degradado radial' }, s.fillType || 'solid', fin('fillType'))),
    );
    if (s.fillType === 'linear' || s.fillType === 'radial') {
      const g = s.gradient || { angle: 90, stops: [[0, '#ffffff', 1], [1, '#1d4ed8', 1]] };
      const setStop = (i, patch, final) => {
        const stops = g.stops.map((st, j) => (j === i ? [patch.offset ?? st[0], patch.color ?? st[1], patch.alpha ?? st[2]] : st));
        edit({ gradient: { ...g, stops } }, final);
      };
      g.stops.forEach((st, i) =>
        fillSec.append(
          row(
            `Color ${i + 1}`,
            color(st[1], (v) => setStop(i, { color: v }, false), (v) => setStop(i, { color: v }, true)),
            ...slider({ min: 0, max: 100, value: Math.round(st[2] * 100), fmt: (v) => `${v}%`, oninput: (v) => setStop(i, { alpha: v / 100 }, false), onchange: (v) => setStop(i, { alpha: v / 100 }, true) }),
          ),
        ),
      );
      if (s.fillType === 'linear') {
        fillSec.append(row('Ángulo', ...slider({ min: 0, max: 360, value: g.angle ?? 90, fmt: (v) => `${v}°`, oninput: (v) => edit({ gradient: { ...g, angle: v } }, false), onchange: (v) => edit({ gradient: { ...g, angle: v } }, true) })));
      }
      fillSec.append(
        h(
          'div',
          { class: 'grid-btns two' },
          btn('+ Parada', () => {
            const stops = [...g.stops, [1, g.stops[g.stops.length - 1][1], 1]].map((st, i, arr) => [i / (arr.length - 1), st[1], st[2]]);
            edit({ gradient: { ...g, stops } });
          }),
          btn('Invertir', () => edit({ gradient: { ...g, stops: g.stops.map((st, i) => [st[0], g.stops[g.stops.length - 1 - i][1], g.stops[g.stops.length - 1 - i][2]]) } })),
        ),
      );
    }

    const hasStroke = s.stroke && s.stroke !== 'none';
    const strokeSec = sec(
      'Trazo',
      row(
        'Trazo',
        check('Con trazo', hasStroke, (v) => edit({ stroke: v ? s.lastStroke || '#c2410c' : 'none', lastStroke: hasStroke ? s.stroke : s.lastStroke })),
        color(hasStroke ? s.stroke : s.lastStroke || '#c2410c', live('stroke'), fin('stroke')),
      ),
      quick('stroke'),
      // escala cuadrática: fino donde se necesita (0,1–1 mm) y hasta 30 mm
      row('Grosor (mm)', num(s.strokeWidth, fin('strokeWidth'), { step: 0.05, min: 0 }), ...slider({ min: 0, max: 1000, value: Math.round(Math.sqrt((s.strokeWidth || 0) / MAX_STROKE) * 1000), fmt: (v) => widthOf(v).toFixed(2), oninput: (v) => live('strokeWidth')(widthOf(v)), onchange: (v) => fin('strokeWidth')(widthOf(v)) }).slice(0, 1)),
      row('Opacidad', ...pct('strokeOpacity')),
      row('Tipo de línea', select({ ...Object.fromEntries(Object.entries(DASHES).map(([k, d]) => [k, d.label])), ...(DASHES[s.dash] ? {} : { [s.dash]: `Personalizada (${s.dash})` }) }, s.dash || 'solid', fin('dash'))),
      row('Patrón propio', text(DASHES[s.dash] ? '' : s.dash, (v) => v.trim() && edit({ dash: v.trim() }), 'p.ej. 6 2 1 2 (× grosor)')),
      row('Escala guiones', ...slider({ min: 25, max: 400, value: Math.round((s.dashScale || 1) * 100), fmt: (v) => `${v}%`, oninput: (v) => live('dashScale')(v / 100), onchange: (v) => fin('dashScale')(v / 100) })),
      row('Extremos', select({ round: 'Redondos', butt: 'Planos', square: 'Cuadrados' }, s.cap || 'round', fin('cap'))),
      row('Esquinas', select({ round: 'Redondas', miter: 'En punta', bevel: 'Biseladas' }, s.join || 'round', fin('join'))),
      row('Alinear borde', select({ outside: 'Hacia afuera (no tapa el relleno)', center: 'Centrado', inside: 'Hacia adentro' }, s.align || 'outside', fin('align'))),
      row('Halo', check('Activado', s.casing, fin('casing')), color(s.casingColor || '#ffffff', live('casingColor'), fin('casingColor'))),
      s.casing ? row('Ancho halo (mm)', num(s.casingWidth, fin('casingWidth'), { step: 0.05, min: 0, slide: [0, 3], oninput: live('casingWidth') })) : null,
      s.casing ? row('Opacidad halo', ...slider({ min: 0, max: 100, value: Math.round((s.casingOpacity ?? 1) * 100), fmt: (v) => `${v}%`, oninput: (v) => live('casingOpacity')(v / 100), onchange: (v) => fin('casingOpacity')(v / 100) })) : null,
      h('p', { class: 'hint' }, 'El halo del trazo (en líneas y en el borde de polígonos) se agrega a cada lado, por debajo: el centro conserva el color del trazo. Útil para que se lea sobre una imagen oscura.'),
      h('p', { class: 'hint' }, 'El borde de polígonos crece solo hacia afuera: aumentar el grosor nunca resta superficie visible al relleno.'),
    );

    const lineSec = sec(
      'Línea abierta',
      row('Inicio', select(MARKERS, s.markerStart || 'none', fin('markerStart'))),
      row('Final', select(MARKERS, s.markerEnd || 'none', fin('markerEnd'))),
      row('Tamaño puntas', ...slider({ min: 40, max: 400, value: Math.round((s.markerSize || 1) * 100), fmt: (v) => `${v}%`, oninput: (v) => live('markerSize')(v / 100), onchange: (v) => fin('markerSize')(v / 100) })),
    );

    const objSec = sec(
      'Objeto',
      row('Opacidad', ...pct('opacity')),
      row('Fusión', select(BLEND_MODES, s.blend || 'normal', fin('blend'))),
      row('Símbolo punto', select(POINT_SHAPES, s.pointShape || 'circle', fin('pointShape'))),
      row('Tamaño punto', num(s.pointSize, fin('pointSize'), { step: 0.1, min: 0.2 }), ...slider({ min: 0, max: 1000, value: Math.round(Math.sqrt((s.pointSize || 2.5) / MAX_POINT) * 1000), fmt: (v) => `${pointOf(v)} mm`, oninput: (v) => live('pointSize')(pointOf(v)), onchange: (v) => fin('pointSize')(pointOf(v)) })),
      h('p', { class: 'hint' }, `Símbolo de punto hasta ${MAX_POINT} mm (el campo numérico admite más).`),
      ...this.fieldSymbology(shapes),
    );

    const out = [head];
    const texts = [];
    walkShapes(shapes, (x) => {
      if (x.type === 'text') texts.push(x);
    });
    if (shapes.length === 1 && target?.type === 'text') out.push(this.textSection(target));
    else if (texts.length && shapes.length > 1) out.push(this.multiTextSection(texts, shapes));
    const smoothSec = sec(
      'Trazo libre (lápiz)',
      row('Suavizado', ...slider({ min: 0, max: 100, step: 1, value: app.smoothLevel(), fmt: (v) => `${v} %`, oninput: (v) => app.setSmooth(v, false), onchange: (v) => app.setSmooth(v, true) })),
      h('p', { class: 'hint' }, 'Es el suavizado por defecto del lápiz (B): 0 % deja el trazo casi como se dibujó, 100 % lo redondea mucho. Un trazo libre recién dibujado se puede re-suavizar con este control (o con el de la barra de arriba) mientras esté seleccionado y sin editar sus nodos.'),
    );
    out.push(strokeSec, fillSec, lineSec, objSec, smoothSec);
    if (shapes.length) {
      let length = 0;
      let area = 0;
      for (const sh of shapes) {
        const m = measure(sh);
        length += m.length;
        area += m.area;
      }
      out.push(
        sec(
          'Medidas',
          h('p', { class: 'hint' }, `Longitud: ${fmtLen(length)} · Área: ${fmtArea(area)}`),
          h('div', { class: 'grid-btns two' }, btn('Guardar estilo como predeterminado', () => app.setCurrentStyle(s)), btn('Invertir dirección', () => app.editor.reverseSelected())),
        ),
      );
    }
    return out;
  }

  styleHead(shapes) {
    return shapes.length
      ? h('p', { class: 'hint target' }, `Editando ${shapes.length} objeto(s) seleccionado(s).`)
      : h('p', { class: 'hint target' }, 'Sin selección: estos ajustes se usan para lo próximo que dibujes.');
  }

  /* ============================================================== GEOLOGÍA */

  /** Tipos de línea geológicos, ornamentos de falla y pliegue, discordancia y tramas de litología. */
  geologyPanel() {
    const app = this.app;
    const { style: s, shapes } = this.shownStyle();
    const edit = (patch, final = true) => app.editStyle(patch, final);
    const live = (k) => (v) => edit({ [k]: v }, false);
    const fin = (k) => (v) => edit({ [k]: v }, true);
    const pct = (k) =>
      slider({ min: 0, max: 100, value: Math.round((s[k] ?? 1) * 100), fmt: (v) => `${v}%`, oninput: (v) => live(k)(v / 100), onchange: (v) => fin(k)(v / 100) });

    const orn = s.ornament || 'none';
    const lim = ORNAMENT_LIMITS;
    const ornSec = sec(
      'Ornamento de falla / pliegue',
      row('Ornamento', select(Object.fromEntries(Object.entries(ORNAMENTS).map(([k, o]) => [k, o.label])), orn, (v) => edit(ornamentDefaults(v)))),
      orn !== 'none' ? row('Tamaño', ...slider({ min: Math.round(lim.size.min * 100), max: Math.round(lim.size.max * 100), value: Math.round((s.ornamentSize || 1) * 100), fmt: (v) => `${v}%`, oninput: (v) => live('ornamentSize')(v / 100), onchange: (v) => fin('ornamentSize')(v / 100) })) : null,
      orn !== 'none' ? row('Separación (mm)', num(s.ornamentSpacing, fin('ornamentSpacing'), { step: 0.5, min: lim.spacing.min, max: lim.spacing.max, slide: [lim.spacing.min, lim.spacing.max], oninput: live('ornamentSpacing') })) : null,
      orn === 'dextral' || orn === 'sinistral' ? row('Dist. a la traza (mm)', num(s.ornamentGap, fin('ornamentGap'), { step: 0.1, min: lim.gap.min, max: lim.gap.max, slide: [lim.gap.min, lim.gap.max], oninput: live('ornamentGap') })) : null,
      ORNAMENTS[orn]?.flippable
        ? row('Lado', select({ left: 'Izquierda del sentido de digitalización', right: 'Derecha' }, s.ornamentSide || 'left', fin('ornamentSide')), btn('⇄', () => edit({ ornamentSide: (s.ornamentSide || 'left') === 'left' ? 'right' : 'left' }), 'sm'))
        : null,
      orn !== 'none' ? row('Color', check('Distinto al trazo', !!s.ornamentColor, (v) => edit({ ornamentColor: v ? s.stroke : '' })), s.ornamentColor ? color(s.ornamentColor, live('ornamentColor'), fin('ornamentColor')) : null) : null,
      orn !== 'none' ? check('Halo blanco bajo el ornamento', s.ornamentHalo !== false, fin('ornamentHalo')) : null,
      h('p', { class: 'hint' }, 'Dientes, tics y flechas como en FieldDraw. Los dientes y el tic van a la izquierda del sentido en que dibujaste la línea; «⇄» los pasa al otro lado sin redibujar.'),
    );

    const presetSec = sec(
      'Tipos de línea geológicos',
      row('Certeza', select({ solid: 'Observada (continua)', inferred: 'Inferida (segmentada)', covered: 'Cubierta (punteada)' }, this.certainty || 'solid', (v) => { this.certainty = v; edit({ dash: v }); })),
      h(
        'div',
        { class: 'grid-btns' },
        ...LINE_PRESETS.map((p) => h('button', { class: 'btn sm', title: p.label, onclick: () => edit({ ...defaultStyle(), ...ornamentDefaults('none'), fill: 'none', ...p.style, dash: this.certainty || 'solid' }) }, p.short)),
      ),
      h('p', { class: 'hint' }, 'Aplica el color, grosor y ornamento de cada tipo, con los mismos colores de FieldDraw.'),
    );

    // trama de litología: selector con miniaturas, agrupado
    const patSec = sec('Trama de litología');
    const pcol = s.patternColor || '#1f2937';
    const bgc = s.fill && s.fill !== 'none' ? s.fill : '#ffffff';
    patSec.append(
      h('div', { class: 'pat-grid' }, h('button', { class: `pat none${(s.pattern || 'none') === 'none' ? ' on' : ''}`, title: 'Sin trama', onclick: () => edit({ pattern: 'none' }) }, '∅')),
    );
    for (const g of PATTERN_GROUPS) {
      const items = Object.entries(PATTERNS).filter(([, p]) => p.group === g.id);
      patSec.append(
        h('h4', { class: 'pat-h' }, g.label),
        h(
          'div',
          { class: 'pat-grid' },
          ...items.map(([k, p]) => h('button', { class: `pat${s.pattern === k ? ' on' : ''}`, title: p.label, html: patternPreview(k, pcol, bgc, 44), onclick: () => edit({ pattern: k, patternColor: s.patternColor || '#1f2937' }) })),
        ),
      );
    }
    if (s.pattern && s.pattern !== 'none') {
      patSec.append(
        h('p', { class: 'hint' }, `Trama: ${PATTERNS[s.pattern]?.label || s.pattern}. El color de la unidad es el relleno; la trama va encima.`),
        row('Color trama', color(pcol, live('patternColor'), fin('patternColor'))),
        row('Tamaño (mm)', num(s.patternSize, fin('patternSize'), { step: 0.5, min: 1 }), ...slider({ min: 2, max: 20, step: 0.5, value: s.patternSize || 5, fmt: (v) => v, oninput: live('patternSize'), onchange: fin('patternSize') }).slice(0, 1)),
        row('Opacidad trama', ...pct('patternOpacity')),
      );
    }

    const wavySec = sec(
      'Discordancia (línea ondulada)',
      row('Forma', select({ straight: 'Recta', wavy: 'Ondulada' }, s.wavy ? 'wavy' : 'straight', (v) => edit({ wavy: v === 'wavy' }))),
      s.wavy ? row('Amplitud (mm)', num(s.waveAmp, fin('waveAmp'), { step: 0.1, min: 0.1, slide: [0.1, 5], oninput: live('waveAmp') })) : null,
      s.wavy ? row('Long. onda (mm)', num(s.waveLen, fin('waveLen'), { step: 0.2, min: 0.8, slide: [0.8, 20], oninput: live('waveLen') })) : null,
    );
    return [this.styleHead(shapes), presetSec, ornSec, wavySec, patSec];
  }

  textSection(t) {
    const app = this.app;
    const set = (patch, final = true) => {
      const next = mapShapes(this.doc, [t.id], (x) => ({ ...x, ...patch }));
      if (final) app.history.commit(next);
      else app.history.preview(next);
    };
    // desplazar el ancla `dmm` mm de papel a lo largo del renglón (mundo: y crece al norte)
    const k = this.doc.refScale / 1000;
    const a = ((t.rotation || 0) * Math.PI) / 180;
    const moveLocal = (dmm) => ({ x: t.x + dmm * k * Math.cos(a), y: t.y - dmm * k * Math.sin(a) });
    return sec('Texto', ...this.textControls(t, set, { moveLocal }));
  }

  /** Propiedades de texto comunes a varios textos seleccionados (se aplican a todos). */
  multiTextSection(texts, shapes) {
    const app = this.app;
    const t = texts[0];
    const ids = shapes.map((x) => x.id);
    const set = (patch, final = true) => {
      if (!final && !app.history.anchor) app.history.begin();
      const base = app.history.anchor || app.history.doc;
      const deep = (x) => (x.type === 'group' ? { ...x, children: x.children.map(deep) } : x.type === 'text' ? { ...x, ...patch } : x);
      const next = mapShapes(base, ids, deep);
      if (final) {
        if (app.history.anchor) {
          app.history.preview(next);
          app.history.end();
        } else app.history.commit(next);
      } else app.history.preview(next);
    };
    return sec(
      `Texto (${texts.length} textos)`,
      row('Fuente', select({ ...FONTS, ...(FONTS[t.fontFamily] ? {} : { [t.fontFamily]: t.fontFamily }) }, t.fontFamily, (v) => set({ fontFamily: v }))),
      row('Tamaño (pt)', num(t.fontSize, (v) => set({ fontSize: v }), { step: 0.5, min: 1, slide: [1, 96], log: true })),
      row('Estilo', check('Negrita', t.fontWeight >= 600, (v) => set({ fontWeight: v ? 700 : 400 })), check('Cursiva', t.italic, (v) => set({ italic: v }))),
      row('Halo', check('Activado', t.halo, (v) => set({ halo: v })), color(t.haloColor || '#ffffff', (v) => set({ haloColor: v }, false), (v) => set({ haloColor: v }))),
      row('Ancho halo (mm)', num(t.haloWidth ?? 0.5, (v) => set({ haloWidth: v }), { step: 0.1, min: 0, slide: [0, 3] })),
      row('Opacidad halo', ...slider({ min: 0, max: 100, value: Math.round((t.haloOpacity ?? 1) * 100), fmt: (v) => `${v}%`, oninput: (v) => set({ haloOpacity: v / 100 }, false), onchange: (v) => set({ haloOpacity: v / 100 }) })),
      h('p', { class: 'hint' }, 'Color de letra, opacidad y demás ajustes de relleno/trazo están en las secciones de abajo y valen para todos los objetos seleccionados.'),
    );
  }

  /**
   * Controles de un texto, comunes al texto del mapa y a los cuadros de texto
   * del layout: fuente, tamaño, alineación (izquierda, centro, derecha,
   * justificado), interlineado, espaciado de letras y de palabras, ancho del
   * cuadro, rotación y halo. `set(patch, final)` escribe el cambio.
   * `color` (opcional) = [valor, función] para el color de la letra.
   */
  textControls(t, set, { color: colorCtl = null, moveLocal = null } = {}) {
    const ta = h('textarea', {}, t.text);
    ta.addEventListener('change', () => {
      const runs = adjustRuns(t.text || '', ta.value, t.runs);
      set({ text: ta.value, runs: runs.length ? runs : undefined, name: ta.value.split('\n')[0].slice(0, 40) });
    });
    const align = alignOf(t);
    const alignBtn = (id, label, tip) =>
      h('button', { class: `btn sm${align === id ? ' on' : ''}`, title: tip, type: 'button', onclick: () => this.setAlign(t, id, set, moveLocal) }, label);
    const sl = (key, min, max, step, def, fmt) =>
      slider({ min, max, step, value: t[key] ?? def, fmt, oninput: (v) => set({ [key]: v }, false), onchange: (v) => set({ [key]: v }) });
    return [
      row('Texto', ta),
      row('Fuente', select({ ...FONTS, ...(FONTS[t.fontFamily] ? {} : { [t.fontFamily]: t.fontFamily }) }, t.fontFamily, (v) => set({ fontFamily: v }))),
      row('Tamaño (pt)', num(t.fontSize, (v) => set({ fontSize: v }), { step: 0.5, min: 1, slide: [1, 96], log: true })),
      h('p', { class: 'hint' }, 'También se cambia estirando la esquina de la caja de selección; el borde izquierdo o derecho cambia el ancho del cuadro.'),
      row('Estilo', check('Negrita', t.fontWeight >= 600, (v) => set({ fontWeight: v ? 700 : 400 })), check('Cursiva', t.italic, (v) => set({ italic: v }))),
      colorCtl ? row('Color', color(colorCtl[0], (v) => colorCtl[1](v, false), (v) => colorCtl[1](v, true))) : null,
      row(
        'Alinear',
        h('div', { class: 'grid-btns four', style: { flex: 1 } }, alignBtn('left', '⬅', 'Izquierda'), alignBtn('center', '↔', 'Centro'), alignBtn('right', '➡', 'Derecha'), alignBtn('justify', '☰', 'Justificado (en cuadro de texto)')),
      ),
      row('Ancho cuadro (mm)', num(t.boxWidth || '', (v) => set({ boxWidth: v > 0 ? v : null }), { step: 1, min: 0 }), btn('Auto', () => set({ boxWidth: null }), 'sm')),
      row('Interlineado', ...sl('lineHeight', 0.6, 3, 0.05, 1.2, (v) => `×${(+v).toFixed(2)}`)),
      row('Espac. letras', ...sl('letterSpacing', -100, 800, 10, 0, (v) => `${v}`)),
      row('Espac. palabras', ...sl('wordSpacing', -300, 1500, 10, 0, (v) => `${v}`)),
      h('p', { class: 'hint' }, 'Espaciados en milésimas de em (como el «tracking» de Illustrator). Varios espacios seguidos se respetan.'),
      row('Rotación', ...slider({ min: -180, max: 180, value: t.rotation || 0, fmt: (v) => `${v}°`, oninput: (v) => set({ rotation: v }, false), onchange: (v) => set({ rotation: v }) })),
      row('Halo', check('Activado', t.halo, (v) => set({ halo: v })), color(t.haloColor, (v) => set({ haloColor: v }, false), (v) => set({ haloColor: v }))),
      row('Ancho halo (mm)', num(t.haloWidth, (v) => set({ haloWidth: v }), { step: 0.1, min: 0, slide: [0, 3] })),
      row('Opacidad halo', ...slider({ min: 0, max: 100, value: Math.round((t.haloOpacity ?? 1) * 100), fmt: (v) => `${v}%`, oninput: (v) => set({ haloOpacity: v / 100 }, false), onchange: (v) => set({ haloOpacity: v / 100 }) })),
      h('p', { class: 'hint' }, 'El halo del texto es externo: rodea las letras sin tapar su interior.'),
    ];
  }

  /** Alineación de un texto; justificar necesita un cuadro de texto, así que si no lo hay se crea uno del ancho actual. */
  setAlign(t, id, set, moveLocal = null) {
    const patch = { align: id, anchor: id === 'center' ? 'middle' : id === 'right' ? 'end' : 'start' };
    if (id === 'justify' && !(t.boxWidth > 0)) {
      const PT_MM = 72 / 25.4;
      const m = layoutText(t, t.fontSize, PT_MM, textMeasurer(t));
      patch.boxWidth = Math.max(20, +(m.width / PT_MM).toFixed(1));
      // el cuadro parte del borde izquierdo del texto actual (si estaba centrado o a la derecha, el ancla se corre)
      if (moveLocal && m.x0) Object.assign(patch, moveLocal(m.x0 / PT_MM));
    }
    set(patch);
  }

  /** Objeto de muestra para la vista previa de etiquetas: el seleccionado de la capa o el primero con texto. */
  sampleShape(layer) {
    const sel = this.app.editor.selectedShapes().find((s) => layer.items.some((x) => x.id === s.id));
    if (sel) return sel;
    return layer.items.find((s) => s.attrs && Object.keys(s.attrs).length) || layer.items[0] || null;
  }

  /* ======================================= SIMBOLOGÍA POR CAMPO (QGIS) */

  /**
   * Categorizado / Graduado sobre un campo de atributos de la capa del objeto
   * seleccionado (o la activa). La configuración y las clases se guardan en la
   * capa; «Clasificar y aplicar» pinta cada objeto según su clase.
   */
  fieldSymbology(shapes) {
    const app = this.app;
    const doc = this.doc;
    const sel = shapes[0] ? app.layerOf(shapes[0].id) : null;
    const layer = sel?.kind === 'vector' ? sel : findLayer(doc, doc.activeLayerId);
    if (!layer || layer.kind !== 'vector') return [];
    const opts = (this.symOpts ||= {});
    const r = layer.renderer;
    const o = (opts[layer.id] ||= { ...defaultRendererOptions(), ...(r ? { field: r.field, mode: r.mode, ramp: r.ramp, reverse: r.reverse, method: r.method, n: r.n, target: r.target } : {}) });
    const fields = fieldChoices(layer);
    const refresh = () => this.render();
    const run = () => {
      if (layer.locked) return app.message(`La capa «${layer.name}» está bloqueada: no se puede cambiar su estilo`);
      try {
        const rr = buildRenderer(layer.items, o);
        app.history.commit(applyRenderer(this.doc, layer.id, rr));
        app.message(`Simbología por «${o.field}»: ${rr.classes.length} clase(s)`, 3500);
      } catch (e) {
        app.message(e.message, 6000);
      }
    };
    const out = [
      h('h3', {}, 'Simbología por campo de atributos'),
      h('p', { class: 'hint' }, `Capa «${layer.name}» (${layer.items.length} objetos). Pinta cada objeto según el valor de un campo, como el renderizador Categorizado o Graduado de QGIS.`),
      row('Campo', select({ '': '— elegir campo —', ...fields }, o.field, (v) => { o.field = v; refresh(); })),
      row('Tipo', select({ categorized: 'Categorizado (un color por valor)', graduated: 'Graduado (clases numéricas)' }, o.mode, (v) => { o.mode = v; refresh(); })),
      row('Rampa', select(Object.fromEntries(Object.entries(RAMPS).map(([k, v]) => [k, v.label])), o.ramp, (v) => { o.ramp = v; refresh(); })),
      row('', h('div', { class: 'palette-bar', style: { background: rampCss(o.ramp, o.reverse) } }), check('Invertir', o.reverse, (v) => { o.reverse = v; refresh(); })),
    ];
    if (o.mode === 'graduated') {
      out.push(
        row('Método', select({ quantile: 'Cuantiles (igual cantidad)', equal: 'Intervalos iguales', pretty: 'Cortes redondos', jenks: 'Cortes naturales (Jenks)' }, o.method, (v) => (o.method = v))),
        row('Clases', num(o.n, (v) => (o.n = Math.max(2, Math.min(30, Math.round(v)))), { step: 1, min: 2, max: 30, slide: [2, 30] })),
      );
    }
    out.push(
      row('Aplicar a', select({ auto: 'Automático (relleno en polígonos y puntos, trazo en líneas)', fill: 'Relleno', stroke: 'Trazo', both: 'Relleno y trazo' }, o.target, (v) => (o.target = v))),
      btn('Clasificar y aplicar', run, 'primary'),
    );
    if (r) {
      const { counts, other } = countClasses(r, layer.items);
      const setClass = (i, patch) => {
        const classes = r.classes.map((c, j) => (j === i ? { ...c, ...patch } : c));
        app.history.commit(applyRenderer(this.doc, layer.id, { ...r, classes }));
      };
      out.push(
        h('h4', { class: 'pat-h' }, `Clases de «${r.field}» (${r.mode === 'graduated' ? 'graduado' : 'categorizado'})`),
        ...r.classes.map((c, i) =>
          h('div', { class: 'cls-row' }, color(c.color, null, (v) => setClass(i, { color: v })), text(c.label, (v) => setClass(i, { label: v || c.label })), h('span', { class: 'cnt', title: 'objetos' }, String(counts[i]))),
        ),
        other
          ? h('div', { class: 'cls-row' }, color(r.other?.color || '#9ca3af', null, (v) => app.history.commit(applyRenderer(this.doc, layer.id, { ...r, other: { ...(r.other || {}), color: v } }))), h('span', { class: 'lbl' }, r.other?.label || 'Otros valores'), h('span', { class: 'cnt' }, String(other)))
          : null,
        h(
          'div',
          { class: 'grid-btns two' },
          btn('Reaplicar', () => app.history.commit(applyRenderer(this.doc, layer.id, r))),
          btn('Quitar clasificación', () => app.history.commit(clearRenderer(this.doc, layer.id)), 'danger'),
        ),
        h('p', { class: 'hint' }, 'Los colores ya aplicados quedan en cada objeto. Los rótulos de clase salen en la leyenda del layout y, al exportar a QGIS, como un renderizador Categorizado/Graduado sobre el campo.'),
      );
    }
    return out;
  }

  /* ============================================================= ETIQUETAS */

  labelsPanel() {
    const app = this.app;
    const doc = this.doc;
    const vectors = doc.layers.filter((l) => l.kind === 'vector');
    if (!vectors.length) return h('div', { class: 'empty' }, 'No hay capas vectoriales.');
    const layer = findLayer(doc, this.labelLayerId) || findLayer(doc, doc.activeLayerId) || vectors[vectors.length - 1];
    if (layer.kind !== 'vector') return h('div', { class: 'empty' }, 'Elige una capa vectorial.');
    const c = { ...defaultLabels(), ...(layer.labels || {}) };
    const set = (patch, final = true) => {
      const next = updateLayer(this.doc, layer.id, (l) => ({ ...l, labels: { ...defaultLabels(), ...l.labels, ...patch } }));
      if (final) app.history.commit(next);
      else app.history.preview(next);
    };
    const fields = { '': '— elegir campo —', ...fieldChoices(layer) };
    const addField = (f) => f && set({ fields: [...(c.fields || []), f] });
    const sample = this.sampleShape(layer);
    const preview = sample ? labelText(sample, c) : '';
    return [
      sec(
        'Capa',
        row(
          'Capa',
          select(Object.fromEntries(vectors.map((l) => [l.id, l.name])), layer.id, (v) => {
            this.labelLayerId = v;
            this.render();
          }),
        ),
        check('Etiquetar esta capa', c.enabled, (v) => set({ enabled: v })),
      ),
      sec(
        'Texto de la etiqueta',
        row('Campo', select(fields, c.field, (v) => set({ field: v }))),
        h('h4', { class: 'pat-h' }, 'Combinar varios campos'),
        ...(c.fields || []).map((f, i) =>
          row(
            `${i + 1}.`,
            select({ ...fields, [f]: f }, f, (v) => set({ fields: c.fields.map((x, j) => (j === i ? v : x)) })),
            btn('↑', () => i > 0 && set({ fields: c.fields.map((x, j) => (j === i - 1 ? c.fields[i] : j === i ? c.fields[i - 1] : x)) }), 'sm'),
            btn('✕', () => set({ fields: c.fields.filter((_, j) => j !== i) }), 'sm'),
          ),
        ),
        row('Añadir', select({ '': '+ elegir campo…', ...fieldChoices(layer) }, '', addField)),
        (c.fields || []).length > 1 ? row('Separador', select(Object.fromEntries(Object.entries(LABEL_SEPARATORS).map(([k, v]) => [k, v[0]])), c.sep || 'space', (v) => set({ sep: v }))) : null,
        h('h4', { class: 'pat-h' }, 'Plantilla (avanzado)'),
        row('Plantilla', text(c.template, (v) => set({ template: v }), '{codigo} ({edad:1} Ma)')),
        row('Insertar', select({ '': '+ campo en la plantilla…', ...fieldChoices(layer) }, '', (f) => f && set({ template: `${c.template || ''}{${f}}` }))),
        h('p', { class: 'hint' }, 'Prioridad: plantilla, luego varios campos, luego el campo único. Con varios campos se omiten los vacíos (sin separadores sueltos). En la plantilla: {campo:2} fija decimales, {campo|upper} (también lower, title) cambia las mayúsculas y {codigo||nombre} usa el segundo si el primero está vacío.'),
        check('MAYÚSCULAS', c.upper, (v) => set({ upper: v })),
        h('p', { class: 'hint target' }, sample ? `Vista previa (${sample.name || 'objeto'}): ${preview || '(vacío)'}` : 'Sin objetos para la vista previa.'),
      ),
      sec(
        'Tipografía',
        row('Fuente', select(FONTS, c.fontFamily, (v) => set({ fontFamily: v }))),
        row('Tamaño (pt)', num(c.fontSize, (v) => set({ fontSize: v }), { step: 0.5, min: 2, slide: [2, 72], log: true })),
        row('Estilo', check('Negrita', c.fontWeight >= 600, (v) => set({ fontWeight: v ? 700 : 400 })), check('Cursiva', c.italic, (v) => set({ italic: v }))),
        row('Color', color(c.color, (v) => set({ color: v }, false), (v) => set({ color: v }))),
        row('Halo', check('Activado', c.halo, (v) => set({ halo: v })), color(c.haloColor, (v) => set({ haloColor: v }, false), (v) => set({ haloColor: v }))),
        row('Ancho halo (mm)', num(c.haloWidth, (v) => set({ haloWidth: v }), { step: 0.1, min: 0, slide: [0, 3] })),
        row('Fondo', check('Placa', c.background, (v) => set({ background: v })), color(c.backgroundColor, (v) => set({ backgroundColor: v }, false), (v) => set({ backgroundColor: v }))),
      ),
      sec(
        'Ubicación',
        row('Colocación', select({ auto: 'Automática', curved: 'Curvada sobre la línea', horizontal: 'Horizontal', centroid: 'Interior del polígono' }, c.placement, (v) => set({ placement: v }))),
        row('Desplaz. (mm)', num(c.offset, (v) => set({ offset: v }), { step: 0.2, slide: [-10, 10] })),
        row('Repetir cada (mm)', num(c.repeat, (v) => set({ repeat: v }), { step: 10, min: 0, slide: [0, 500] })),
        check('Evitar superposición', c.avoidOverlap, (v) => set({ avoidOverlap: v })),
        row('Visible hasta 1:', num(c.minScale || '', (v) => set({ minScale: v }), { step: 1000, min: 0 })),
        h('p', { class: 'hint' }, 'Puntos: arriba a la derecha. Líneas: sobre el tramo más recto, siempre legibles de izquierda a derecha. Polígonos: en el punto interior más alejado del borde.'),
      ),
    ];
  }

  /* =============================================================== RELIEVE */

  reliefPanel() {
    const app = this.app;
    const doc = this.doc;
    const hs = doc.layers.filter((l) => l.kind === 'hillshade');
    const addBtn = btn('+ Nueva capa de relieve', () => {
      const l = makeRasterLayer('hillshade', 'Relieve sombreado', defaultHillshadeSettings());
      const layers = this.doc.layers.slice();
      const firstVector = layers.findIndex((x) => x.kind === 'vector');
      layers.splice(firstVector < 0 ? layers.length : firstVector, 0, l);
      this.reliefLayerId = l.id;
      app.history.commit({ ...this.doc, layers });
    }, 'primary');
    const keyRow = row('Clave OpenTopography', text(app.settings.opentopoKey || '', (v) => app.saveSettings({ opentopoKey: v.trim() }), 'opentopography.org → My Account'));
    if (!hs.length) {
      return [
        sec(
          'Relieve sombreado',
          h('p', { class: 'hint' }, 'Genera sombreado y color de elevación a partir de modelos gratuitos: Terrarium (tierra y batimetría, sin clave), Copernicus GLO-30, SRTM, NASADEM, ALOS y GEBCO vía OpenTopography, o tu propio GeoTIFF.'),
          addBtn,
        ),
        sec('Ajustes', keyRow),
      ];
    }
    const layer = hs.find((l) => l.id === this.reliefLayerId) || hs[hs.length - 1];
    this.reliefLayerId = layer.id;
    const s = { ...defaultHillshadeSettings(), ...layer.settings };
    const set = (patch, final = true) => {
      const next = updateLayer(this.doc, layer.id, (l) => ({ ...l, settings: { ...defaultHillshadeSettings(), ...l.settings, ...patch } }));
      if (final) app.history.commit(next);
      else app.history.preview(next);
    };
    const sl = (k, min, max, step, fmt = (v) => v) =>
      slider({ min, max, step, value: s[k], fmt, oninput: (v) => set({ [k]: v }, false), onchange: (v) => set({ [k]: v }) });

    // barra de la paleta
    const range = s.rangeMode === 'manual' ? { min: s.min, max: s.max } : app.raster.lastRange || { min: -4000, max: 5000 };
    const lut = paletteLUT(s.palette, range.min, range.max, s.paletteReverse);
    const stops = [];
    for (let i = 0; i <= 10; i++) {
      const k = Math.round((i / 10) * (lut.N - 1)) * 3;
      stops.push(`rgb(${lut.lut[k]},${lut.lut[k + 1]},${lut.lut[k + 2]}) ${i * 10}%`);
    }
    const bar = h('div', { class: 'palette-bar', style: { background: `linear-gradient(90deg, ${stops.join(',')})` } });

    const srcSec = sec(
      'Modelo de elevación',
      hs.length > 1 ? row('Capa', select(Object.fromEntries(hs.map((l) => [l.id, l.name])), layer.id, (v) => {
        this.reliefLayerId = v;
        this.render();
      })) : null,
      row('Fuente', select(Object.fromEntries(Object.entries(DEM_SOURCES).map(([k, d]) => [k, d.label])), s.source, (v) => set({ source: v }))),
    );
    if (s.source === 'opentopo') {
      srcSec.append(row('Modelo', select(OPENTOPO_TYPES, s.demtype, (v) => set({ demtype: v }))), keyRow);
      srcSec.append(h('p', { class: 'hint' }, 'La clave es gratuita (opentopography.org). Se descarga la extensión visible con margen; al alejar mucho la vista pide un área mayor.'));
    }
    if (s.source === 'file') {
      srcSec.append(
        row('Archivo', h('span', { class: 'hint', style: { flex: 1 } }, s.fileName || 'ninguno'), btn('Elegir…', () => app.importDemForLayer(layer.id))),
      );
    }
    if (s.source === 'terrarium') srcSec.append(h('p', { class: 'hint' }, 'Terrarium (AWS Open Data): SRTM/GMTED en tierra y ETOPO1/GEBCO en el mar. Ideal para mapas topo-batimétricos.'));

    return [
      srcSec,
      sec(
        'Sombreado',
        row('Azimut luz', ...sl('azimuth', 0, 360, 1, (v) => `${v}°`)),
        row('Altura luz', ...sl('altitude', 1, 90, 1, (v) => `${v}°`)),
        row('Exageración', ...sl('zFactor', 0.1, 10, 0.1, (v) => `×${v}`)),
        row('Intensidad', ...sl('shadeStrength', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)),
        check('Multidireccional (4 luces)', s.multidirectional, (v) => set({ multidirectional: v })),
      ),
      sec(
        'Paleta de colores',
        row('Paleta', select(Object.fromEntries(Object.entries(PALETTES).map(([k, p]) => [k, p.label])), s.palette, (v) => set({ palette: v }))),
        row('', bar),
        row('Mezcla', select({ multiply: 'Multiplicar', overlay: 'Superponer', 'soft-light': 'Luz suave', screen: 'Trama', normal: 'Normal' }, s.paletteBlend, (v) => set({ paletteBlend: v }))),
        row('Opacidad paleta', ...sl('paletteOpacity', 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`)),
        check('Invertir paleta', s.paletteReverse, (v) => set({ paletteReverse: v })),
        row('Rango', select({ auto: 'Automático (lo visible)', manual: 'Manual' }, s.rangeMode, (v) => set({ rangeMode: v, min: Math.round(range.min), max: Math.round(range.max) }))),
        s.rangeMode === 'manual' ? row('Mín / máx (m)', num(s.min, (v) => set({ min: v }), { step: 50 }), num(s.max, (v) => set({ max: v }), { step: 50 })) : h('p', { class: 'hint' }, `Rango actual: ${Math.round(range.min)} a ${Math.round(range.max)} m`),
        check('Mar transparente', s.seaTransparent, (v) => set({ seaTransparent: v })),
      ),
      sec(
        'Ajustes de imagen',
        row('Brillo', ...sl('brightness', -0.5, 0.5, 0.01, (v) => `${Math.round(v * 100)}`)),
        row('Contraste', ...sl('contrast', -0.8, 0.8, 0.01, (v) => `${Math.round(v * 100)}`)),
        row('Gamma', ...sl('gamma', 0.3, 3, 0.05, (v) => v.toFixed(2))),
        row('Saturación', ...sl('saturation', 0, 2, 0.05, (v) => `${Math.round(v * 100)}%`)),
        row('Resolución', ...sl('resolution', 0.25, 4, 0.25, (v) => `×${v}`)),
        h('div', { class: 'grid-btns two' }, btn('Restablecer', () => set({ ...defaultHillshadeSettings(), source: s.source, demtype: s.demtype, fileId: s.fileId, fileName: s.fileName })), btn('Exportar GeoTIFF', () => app.exportHillshade(layer.id))),
        h('p', { class: 'hint' }, 'La capa entera también tiene opacidad y modo de fusión (pestaña Capas). En "Multiplicar" oscurece lo que está debajo sin cambiar sus colores.'),
      ),
      sec('', addBtn),
    ];
  }

  /* ============================================================= ORGANIZAR */

  arrangePanel() {
    const app = this.app;
    const ed = app.editor;
    const ids = ed.selection;
    const n = ids.size;
    const est = ed.est();
    const doIt = (f) => () => {
      const next = f(this.doc);
      if (next && next !== this.doc) app.history.commit(next);
    };
    const vectors = this.doc.layers.filter((l) => l.kind === 'vector');
    const sameState = this.sameState || (this.sameState = { criterion: 'fillstroke', scope: 'all', field: '' });
    const attrState = this.attrState || (this.attrState = { field: '', op: '=', value: '' });
    const active = findLayer(this.doc, this.doc.activeLayerId);
    const fieldsOf = (l) => Object.fromEntries((l?.fields || []).map((f) => [f, f]));

    return [
      sec(
        'Edición',
        h('p', { class: 'hint' }, n ? `${n} objeto(s) seleccionado(s)` : 'Nada seleccionado'),
        h(
          'div',
          { class: 'grid-btns' },
          btn('Copiar', () => app.copy()),
          btn('Cortar', () => app.cut()),
          btn('Pegar', () => app.paste(false)),
          btn('Pegar en el lugar', () => app.paste(true)),
          btn('Duplicar', () => ed.duplicate()),
          btn('Eliminar', () => ed.deleteSelection(), 'danger'),
        ),
      ),
      sec(
        'Orden',
        h(
          'div',
          { class: 'grid-btns four' },
          btn('⤒ Al frente', doIt((d) => arrange(d, ids, 'front'))),
          btn('↑ Adelante', doIt((d) => arrange(d, ids, 'forward'))),
          btn('↓ Atrás', doIt((d) => arrange(d, ids, 'backward'))),
          btn('⤓ Al fondo', doIt((d) => arrange(d, ids, 'back'))),
        ),
      ),
      sec(
        'Alinear',
        h(
          'div',
          { class: 'grid-btns' },
          btn('⇤ Izquierda', doIt((d) => align(d, ids, 'left', est))),
          btn('↔ Centro H', doIt((d) => align(d, ids, 'hcenter', est))),
          btn('⇥ Derecha', doIt((d) => align(d, ids, 'right', est))),
          btn('⤒ Arriba', doIt((d) => align(d, ids, 'top', est))),
          btn('↕ Centro V', doIt((d) => align(d, ids, 'vcenter', est))),
          btn('⤓ Abajo', doIt((d) => align(d, ids, 'bottom', est))),
        ),
        h('h3', {}, 'Distribuir'),
        h(
          'div',
          { class: 'grid-btns four' },
          btn('Centros H', doIt((d) => distribute(d, ids, 'h', est))),
          btn('Centros V', doIt((d) => distribute(d, ids, 'v', est))),
          btn('Espacio H', doIt((d) => distribute(d, ids, 'h', est, { spacing: true }))),
          btn('Espacio V', doIt((d) => distribute(d, ids, 'v', est, { spacing: true }))),
        ),
      ),
      sec(
        'Grupos y máscara de recorte',
        h(
          'div',
          { class: 'grid-btns two' },
          btn('Agrupar', () => {
            const r = group(this.doc, ids);
            if (r.id) {
              app.history.commit(r.doc);
              ed.setSelection([r.id]);
            }
          }),
          btn('Desagrupar', () => {
            const r = ungroup(this.doc, ids);
            if (r.ids.size) {
              app.history.commit(r.doc);
              ed.setSelection(r.ids);
            }
          }),
          btn('Crear máscara', () => {
            const r = group(this.doc, ids, { clip: true });
            if (r.error) app.message(r.error);
            else if (r.id) {
              app.history.commit(r.doc);
              ed.setSelection([r.id]);
            } else app.message('Selecciona la forma de recorte (arriba) y lo que debe recortar');
          }),
          btn('Liberar máscara', () => {
            const r = ungroup(this.doc, ids);
            if (r.ids.size) {
              app.history.commit(r.doc);
              ed.setSelection(r.ids);
            }
          }),
        ),
        h('p', { class: 'hint' }, 'Máscara: la forma cerrada de MÁS ARRIBA recorta a las demás seleccionadas, como en Illustrator.'),
        row('Mover a capa', select({ '': '— elegir —', ...Object.fromEntries(vectors.map((l) => [l.id, l.name])) }, '', (v) => v && n && app.history.commit(moveToLayer(this.doc, ids, v)))),
      ),
      this.topologySection(),
      sec(
        'Seleccionar lo mismo',
        row('Criterio', select(SAME_CRITERIA, sameState.criterion, (v) => {
          sameState.criterion = v;
          this.render();
        })),
        sameState.criterion === 'attr'
          ? row('Campo', select({ '': '—', ...fieldsOf(findLayer(this.doc, ed.selectedShapes()[0] ? app.layerOf(ed.selectedShapes()[0].id)?.id : this.doc.activeLayerId)) }, sameState.field, (v) => (sameState.field = v)))
          : null,
        row('Alcance', select({ all: 'Todas las capas visibles', layer: 'Solo la capa del objeto' }, sameState.scope, (v) => (sameState.scope = v))),
        btn('Seleccionar', () => {
          if (!n) return app.message('Selecciona primero un objeto de referencia');
          ed.setSelection(selectSame(this.doc, ids, sameState.criterion, { scope: sameState.scope, field: sameState.field }));
          app.message(`${ed.selection.size} objeto(s) seleccionado(s)`);
        }, 'primary'),
      ),
      sec(
        'Seleccionar por atributo (capa activa)',
        row('Campo', select({ '': '—', ...fieldsOf(active) }, attrState.field, (v) => (attrState.field = v))),
        row('Operador', select(['=', '≠', '<', '>', '≤', '≥', 'contiene', 'vacío'], attrState.op, (v) => (attrState.op = v))),
        row('Valor', text(attrState.value, (v) => (attrState.value = v))),
        btn('Seleccionar', () => {
          const sel = selectByAttribute(this.doc, this.doc.activeLayerId, attrState.field, attrState.op, attrState.value);
          ed.setSelection(sel);
          app.message(`${sel.size} objeto(s) seleccionado(s)`);
        }, 'primary'),
      ),
    ];
  }

  topologySection() {
    const app = this.app;
    const ed = app.editor;
    const st = this.topoState || (this.topoState = { tol: 2, snap: 2 });
    const targets = () => {
      const sel = ed.selectedShapes();
      if (sel.length) return sel;
      const l = findLayer(this.doc, this.doc.activeLayerId);
      return l?.kind === 'vector' ? l.items.filter((s) => !s.locked) : [];
    };
    return sec(
      'Topología',
      row('Tolerancia (m)', num(st.tol, (v) => (st.tol = v), { step: 0.5, min: 0.01, slide: [0.01, 100], log: true })),
      h(
        'div',
        { class: 'grid-btns two' },
        btn('Confirmar topología', async () => {
          const { confirmShapesTopology } = await import('../topoOps.js');
          const { map, stats } = confirmShapesTopology(targets(), st.tol);
          const { replaceShapes } = await import('../doc.js');
          if (map.size) app.history.commit(replaceShapes(this.doc, map));
          app.message(`Topología: ${stats.fusionados} vértice(s) fusionados, ${stats.insertados} insertados, ${map.size} forma(s) cambiadas`, 5000);
        }, 'primary'),
        btn('Polígonos desde líneas', async () => {
          const layer = ed.ensureDrawableLayer();
          if (!layer) return;
          const lines = targets().filter((s) => s.type === 'path');
          if (lines.length < 1) return app.message('Selecciona los contactos (líneas) que cierran las unidades');
          app.message('Construyendo polígonos…', 0);
          const { polygonizeShapes } = await import('../topoOps.js');
          try {
            const polys = await polygonizeShapes(lines, { snap: st.snap, style: { ...app.currentStyle, fill: app.currentStyle.fill !== 'none' ? app.currentStyle.fill : '#bef264', fillOpacity: 0.5 } });
            if (!polys.length) return app.message('Las líneas no encierran ninguna región');
            const { addShapes } = await import('../doc.js');
            // los polígonos van debajo de las líneas, como en un mapa
            const next = addShapes(this.doc, layer.id, polys);
            const items = next.layers.find((l) => l.id === layer.id).items;
            const reordered = [...items.slice(-polys.length), ...items.slice(0, -polys.length)];
            app.history.commit(updateLayer(next, layer.id, (l) => ({ ...l, items: reordered })));
            ed.setSelection(polys.map((p) => p.id));
            app.message(`${polys.length} polígono(s) creados`, 4000);
          } catch (err) {
            app.message(`Polígonos: ${err.message}`, 6000);
          }
        }),
      ),
      row('Cerrar huecos (m)', num(st.snap, (v) => (st.snap = v), { step: 0.5, min: 0, slide: [0, 100] })),
      h('p', { class: 'hint' }, 'Actúan sobre la selección o, si no hay, sobre la capa activa. Confirmar topología hace que los bordes vecinos compartan vértices. Polígonos desde líneas convierte contactos y fallas en unidades cerradas, sin huecos ni traslapes.'),
    );
  }

  /* ============================================================= ATRIBUTOS */

  attrsPanel() {
    const app = this.app;
    const shapes = app.editor.selectedShapes();
    if (shapes.length !== 1) {
      const active = findLayer(this.doc, this.doc.activeLayerId);
      return [
        h('div', { class: 'empty' }, shapes.length ? `${shapes.length} objetos seleccionados: elige uno para ver sus atributos.` : 'Selecciona un objeto para ver y editar sus atributos.'),
        active?.kind === 'vector'
          ? sec(
              `Campos de «${active.name}»`,
              h('p', { class: 'hint' }, (active.fields || []).join(', ') || 'sin campos'),
              btn('+ Campo a la capa', async () => {
                const f = await askText('Campo nuevo', '', { label: `Nombre del campo en «${active.name}»`, placeholder: 'p. ej. codigo, edad, nombre', validate: fieldName(active.fields) });
                if (!f) return;
                app.history.commit(updateLayer(this.doc, active.id, (l) => ({ ...l, fields: [...new Set([...(l.fields || []), f])] })));
              }),
            )
          : null,
      ];
    }
    const s = shapes[0];
    const layer = app.layerOf(s.id);
    const fields = [...new Set([...(layer?.fields || []), ...Object.keys(s.attrs || {})])];
    const setAttr = (k, v) => {
      let val = v;
      if (v !== '' && Number.isFinite(Number(v)) && typeof s.attrs?.[k] !== 'string') val = Number(v);
      app.history.commit(mapShapes(this.doc, [s.id], (x) => ({ ...x, attrs: { ...(x.attrs || {}), [k]: val } })));
    };
    const table = h('table', { class: 'attr-table' });
    for (const k of fields) {
      const inp = h('input', { value: s.attrs?.[k] ?? '' });
      inp.addEventListener('change', () => setAttr(k, inp.value));
      table.append(h('tr', {}, h('td', {}, k), h('td', {}, inp)));
    }
    const m = measure(s);
    const box = shapeBBox(s, app.editor.est());
    return [
      sec(
        'Objeto',
        row('Nombre', text(s.name, (v) => app.history.commit(mapShapes(this.doc, [s.id], (x) => ({ ...x, name: v }))))),
        row('Bloqueado', check('No editable', s.locked, (v) => app.history.commit(mapShapes(this.doc, [s.id], (x) => ({ ...x, locked: v }))))),
        h('p', { class: 'hint' }, `Tipo: ${s.type === 'path' ? (s.closed ? 'polígono' : 'línea') : s.type} · Capa: ${layer?.name || '—'}`),
        m.length ? h('p', { class: 'hint' }, `Longitud ${fmtLen(m.length)}${m.area ? ` · Área ${fmtArea(m.area)}` : ''}`) : null,
        h('p', { class: 'hint' }, `Centro: ${Math.round(box.x + box.w / 2)} E, ${Math.round(box.y + box.h / 2)} N`),
      ),
      sec(
        'Atributos',
        fields.length ? table : h('p', { class: 'hint' }, 'Sin atributos.'),
        btn('+ Campo', async () => {
          const f = await askText('Campo nuevo', '', { label: 'Nombre del campo', placeholder: 'p. ej. codigo, edad, nombre', validate: fieldName(fields) });
          if (!f) return;
          app.history.commit(updateLayer(mapShapes(this.doc, [s.id], (x) => ({ ...x, attrs: { ...(x.attrs || {}), [f]: '' } })), layer.id, (l) => ({ ...l, fields: [...new Set([...(l.fields || []), f])] })));
        }),
      ),
    ];
  }
}

export function fmtLen(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(3)} km` : `${m.toFixed(1)} m`;
}

export function fmtArea(m2) {
  if (m2 >= 1e6) return `${(m2 / 1e6).toFixed(3)} km²`;
  if (m2 >= 1e4) return `${(m2 / 1e4).toFixed(2)} ha`;
  return `${m2.toFixed(1)} m²`;
}

export { unionBBox };
