/**
 * Paneles laterales: Capas, Estilo, Etiquetas, Relieve, Organizar, Atributos.
 *
 * Cada panel se reconstruye entero cuando cambia algo que muestra (selección,
 * capa activa, documento confirmado). Durante un arrastre de deslizador o de
 * selector de color NO se reconstruye: el cambio va como vista previa al
 * historial y se confirma al soltar, así un ajuste completo es UN deshacer.
 */

import { BLEND_MODES, defaultLabels, findLayer, makeRasterLayer, makeVectorLayer, addLayer, removeLayer, moveLayer, duplicateLayer, updateLayer, mapShapes } from '../doc.js';
import { DASHES, MARKERS, POINT_SHAPES, defaultStyle } from '../style.js';
import { BASEMAPS } from '../raster/basemap.js';
import { DEM_SOURCES, OPENTOPO_TYPES } from '../raster/dem.js';
import { PALETTES, defaultHillshadeSettings, paletteLUT } from '../raster/hillshade.js';
import { SAME_CRITERIA, align, arrange, distribute, group, moveToLayer, selectByAttribute, selectSame, ungroup } from '../ops.js';
import { measure, shapeBBox, unionBBox, walkShapes } from '../vector.js';
import { h, sec, row, select, slider, num, text, color, check, btn } from './dom.js';

export const TABS = {
  layers: 'Capas',
  style: 'Estilo',
  labels: 'Etiquetas',
  relief: 'Relieve',
  arrange: 'Organizar',
  attrs: 'Atributos',
  georef: 'Georref.',
  layout: 'Layout',
};

const FONTS = {
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
    this.tabsEl = document.getElementById('tabs');
    this.body = document.getElementById('panel-body');
    this.expanded = new Set();
    this.renderTabs();
  }

  renderTabs() {
    this.tabsEl.replaceChildren(
      ...Object.entries(TABS).map(([k, label]) =>
        h('button', { class: k === this.tab ? 'on' : '', onclick: () => this.show(k) }, label),
      ),
    );
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
    const scroll = this.body.scrollTop;
    const fn = {
      layers: () => this.layersPanel(),
      style: () => this.stylePanel(),
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

  /* ================================================================ CAPAS */

  layersPanel() {
    const app = this.app;
    const doc = this.doc;
    const list = h('div', {});
    // de arriba hacia abajo, como en cualquier programa de dibujo
    for (const l of [...doc.layers].reverse()) list.append(this.layerRow(l));
    const add = h(
      'div',
      { class: 'grid-btns' },
      btn('+ Vectorial', () => {
        const l = makeVectorLayer(`Capa ${doc.layers.filter((x) => x.kind === 'vector').length + 1}`);
        app.history.commit(addLayer(this.doc, l, this.doc.activeLayerId));
      }),
      btn('+ Mapa base', () => {
        const l = makeRasterLayer('basemap', 'Mapa base: Esri satélite', { source: 'esri_imagery' });
        app.history.commit({ ...addLayer(this.doc, l), layers: [l, ...this.doc.layers] });
      }),
      btn('+ Relieve', () => {
        const l = makeRasterLayer('hillshade', 'Relieve sombreado', defaultHillshadeSettings());
        const layers = this.doc.layers.slice();
        // por defecto sobre los mapas base y bajo el dibujo
        const firstVector = layers.findIndex((x) => x.kind === 'vector');
        layers.splice(firstVector < 0 ? layers.length : firstVector, 0, l);
        app.history.commit({ ...this.doc, layers });
        this.show('relief');
      }),
    );
    return [
      sec('Capas', list, add),
      sec(
        'Documento',
        row('Escala ref. 1:', num(doc.refScale, (v) => v > 0 && app.history.commit({ ...this.doc, refScale: v }), { step: 500 })),
        h('p', { class: 'hint' }, 'Grosores (mm) y textos (pt) se miden en el papel a esta escala. Sistema: WGS84 / UTM 19S (EPSG:32719).'),
      ),
    ];
  }

  layerRow(l) {
    const app = this.app;
    const doc = this.doc;
    const active = l.id === doc.activeLayerId;
    const set = (patch, final = true) => {
      const next = updateLayer(this.doc, l.id, (x) => ({ ...x, ...patch }));
      if (final) app.history.commit(next);
      else app.history.preview(next);
    };
    const kindIcon = { vector: '✎', basemap: '🗺', hillshade: '⛰', image: '🖼' }[l.kind] || '';
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
        ondblclick: () => {
          const n = prompt('Nombre de la capa', l.name);
          if (n) set({ name: n });
        },
      },
      `${kindIcon} ${l.name}`,
      count,
    );
    const el = h(
      'div',
      { class: `layer${active ? ' active' : ''}` },
      h('button', { class: `ico${l.visible ? '' : ' off'}`, title: 'Visible', onclick: () => set({ visible: !l.visible }) }, '👁'),
      h('button', { class: `ico${l.locked ? '' : ' off'}`, title: 'Bloqueo', onclick: () => set({ locked: !l.locked }) }, l.locked ? '🔒' : '🔓'),
      name,
      h(
        'div',
        {},
        h('button', { class: 'ico', title: 'Subir', onclick: () => app.history.commit(moveLayer(this.doc, l.id, +1)) }, '▲'),
        h('button', { class: 'ico', title: 'Bajar', onclick: () => app.history.commit(moveLayer(this.doc, l.id, -1)) }, '▼'),
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
          btn('Aplicar QML/QLR', () => app.applyQmlToLayer(l.id)),
          btn('Seleccionar todo', () => {
            app.history.silent({ ...this.doc, activeLayerId: l.id });
            app.editor.setSelection(l.items.filter((s) => !s.locked && s.visible !== false).map((s) => s.id));
          }),
        );
      }
      if (l.kind === 'image') actions.append(btn('Zoom a imagen', () => app.zoomToImage(l)));
      actions.append(
        btn('Duplicar', () => app.history.commit(duplicateLayer(this.doc, l.id))),
        btn('Eliminar', () => {
          if (confirm(`¿Eliminar la capa «${l.name}»?`)) app.history.commit(removeLayer(this.doc, l.id));
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

    const head = shapes.length
      ? h('p', { class: 'hint' }, `Editando ${shapes.length} objeto(s) seleccionado(s).`)
      : h('p', { class: 'hint' }, 'Sin selección: estos ajustes se usan para lo próximo que dibujes.');

    const hasFill = s.fill && s.fill !== 'none';
    const fillSec = sec(
      'Relleno',
      row(
        'Relleno',
        check('Con relleno', hasFill, (v) => edit({ fill: v ? s.lastFill || '#86efac' : 'none', lastFill: hasFill ? s.fill : s.lastFill })),
        color(hasFill ? s.fill : s.lastFill || '#86efac', live('fill'), fin('fill')),
      ),
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
      row('Grosor (mm)', num(s.strokeWidth, fin('strokeWidth'), { step: 0.05, min: 0 }), ...slider({ min: 0, max: 300, value: Math.round((s.strokeWidth || 0) * 100), fmt: (v) => (v / 100).toFixed(2), oninput: (v) => live('strokeWidth')(v / 100), onchange: (v) => fin('strokeWidth')(v / 100) }).slice(0, 1)),
      row('Opacidad', ...pct('strokeOpacity')),
      row('Tipo de línea', select({ ...Object.fromEntries(Object.entries(DASHES).map(([k, d]) => [k, d.label])), ...(DASHES[s.dash] ? {} : { [s.dash]: `Personalizada (${s.dash})` }) }, s.dash || 'solid', fin('dash'))),
      row('Patrón propio', text(DASHES[s.dash] ? '' : s.dash, (v) => v.trim() && edit({ dash: v.trim() }), 'p.ej. 6 2 1 2 (× grosor)')),
      row('Escala guiones', ...slider({ min: 25, max: 400, value: Math.round((s.dashScale || 1) * 100), fmt: (v) => `${v}%`, oninput: (v) => live('dashScale')(v / 100), onchange: (v) => fin('dashScale')(v / 100) })),
      row('Extremos', select({ round: 'Redondos', butt: 'Planos', square: 'Cuadrados' }, s.cap || 'round', fin('cap'))),
      row('Esquinas', select({ round: 'Redondas', miter: 'En punta', bevel: 'Biseladas' }, s.join || 'round', fin('join'))),
      row('Alinear borde', select({ outside: 'Hacia afuera (no tapa el relleno)', center: 'Centrado', inside: 'Hacia adentro' }, s.align || 'outside', fin('align'))),
      h('p', { class: 'hint' }, 'El borde de polígonos crece solo hacia afuera: aumentar el grosor nunca resta superficie visible al relleno.'),
    );

    const lineSec = sec(
      'Línea abierta',
      row('Borde de línea', check('Activado', s.casing, fin('casing')), color(s.casingColor || '#ffffff', live('casingColor'), fin('casingColor'))),
      row('Ancho borde', num(s.casingWidth, fin('casingWidth'), { step: 0.05, min: 0 })),
      h('p', { class: 'hint' }, 'El borde de línea se agrega a cada lado del trazo, por debajo: el núcleo conserva su grosor completo.'),
      row('Inicio', select(MARKERS, s.markerStart || 'none', fin('markerStart'))),
      row('Final', select(MARKERS, s.markerEnd || 'none', fin('markerEnd'))),
      row('Tamaño puntas', ...slider({ min: 40, max: 400, value: Math.round((s.markerSize || 1) * 100), fmt: (v) => `${v}%`, oninput: (v) => live('markerSize')(v / 100), onchange: (v) => fin('markerSize')(v / 100) })),
    );

    const objSec = sec(
      'Objeto',
      row('Opacidad', ...pct('opacity')),
      row('Fusión', select(BLEND_MODES, s.blend || 'normal', fin('blend'))),
      row('Símbolo punto', select(POINT_SHAPES, s.pointShape || 'circle', fin('pointShape'))),
      row('Tamaño punto', num(s.pointSize, fin('pointSize'), { step: 0.1, min: 0.2 })),
    );

    const out = [head];
    if (target?.type === 'text') out.push(this.textSection(target));
    out.push(fillSec, strokeSec, lineSec, objSec);
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

  textSection(t) {
    const app = this.app;
    const set = (patch, final = true) => {
      const next = mapShapes(this.doc, [t.id], (x) => ({ ...x, ...patch }));
      if (final) app.history.commit(next);
      else app.history.preview(next);
    };
    const ta = h('textarea', {}, t.text);
    ta.addEventListener('change', () => set({ text: ta.value }));
    return sec(
      'Texto',
      row('Texto', ta),
      row('Fuente', select({ ...FONTS, ...(FONTS[t.fontFamily] ? {} : { [t.fontFamily]: t.fontFamily }) }, t.fontFamily, (v) => set({ fontFamily: v }))),
      row('Tamaño (pt)', num(t.fontSize, (v) => set({ fontSize: v }), { step: 0.5, min: 1 })),
      row('Estilo', check('Negrita', t.fontWeight >= 600, (v) => set({ fontWeight: v ? 700 : 400 })), check('Cursiva', t.italic, (v) => set({ italic: v }))),
      row('Anclaje', select({ start: 'Izquierda', middle: 'Centro', end: 'Derecha' }, t.anchor, (v) => set({ anchor: v }))),
      row('Rotación', ...slider({ min: -180, max: 180, value: t.rotation || 0, fmt: (v) => `${v}°`, oninput: (v) => set({ rotation: v }, false), onchange: (v) => set({ rotation: v }) })),
      row('Halo', check('Activado', t.halo, (v) => set({ halo: v })), color(t.haloColor, (v) => set({ haloColor: v }, false), (v) => set({ haloColor: v }))),
      row('Ancho halo', num(t.haloWidth, (v) => set({ haloWidth: v }), { step: 0.1, min: 0 })),
    );
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
    const fields = { '': '— elegir campo —', $nombre: 'Nombre del objeto', ...Object.fromEntries((layer.fields || []).map((f) => [f, f])) };
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
        'Texto',
        row('Campo', select(fields, c.field, (v) => set({ field: v }))),
        row('Plantilla', text(c.template, (v) => set({ template: v }), '{codigo} ({edad})')),
        h('p', { class: 'hint' }, 'La plantilla combina campos entre llaves y manda sobre el campo. Campos de la capa: ' + ((layer.fields || []).join(', ') || '—')),
        check('MAYÚSCULAS', c.upper, (v) => set({ upper: v })),
      ),
      sec(
        'Tipografía',
        row('Fuente', select(FONTS, c.fontFamily, (v) => set({ fontFamily: v }))),
        row('Tamaño (pt)', num(c.fontSize, (v) => set({ fontSize: v }), { step: 0.5, min: 2 })),
        row('Estilo', check('Negrita', c.fontWeight >= 600, (v) => set({ fontWeight: v ? 700 : 400 })), check('Cursiva', c.italic, (v) => set({ italic: v }))),
        row('Color', color(c.color, (v) => set({ color: v }, false), (v) => set({ color: v }))),
        row('Halo', check('Activado', c.halo, (v) => set({ halo: v })), color(c.haloColor, (v) => set({ haloColor: v }, false), (v) => set({ haloColor: v }))),
        row('Ancho halo (mm)', num(c.haloWidth, (v) => set({ haloWidth: v }), { step: 0.1, min: 0 })),
        row('Fondo', check('Placa', c.background, (v) => set({ background: v })), color(c.backgroundColor, (v) => set({ backgroundColor: v }, false), (v) => set({ backgroundColor: v }))),
      ),
      sec(
        'Ubicación',
        row('Colocación', select({ auto: 'Automática', curved: 'Curvada sobre la línea', horizontal: 'Horizontal', centroid: 'Interior del polígono' }, c.placement, (v) => set({ placement: v }))),
        row('Desplaz. (mm)', num(c.offset, (v) => set({ offset: v }), { step: 0.2 })),
        row('Repetir cada (mm)', num(c.repeat, (v) => set({ repeat: v }), { step: 10, min: 0 })),
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
        row('Resolución', ...sl('resolution', 0.25, 2, 0.25, (v) => `×${v}`)),
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
      row('Tolerancia (m)', num(st.tol, (v) => (st.tol = v), { step: 0.5, min: 0.01 })),
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
      row('Cerrar huecos (m)', num(st.snap, (v) => (st.snap = v), { step: 0.5, min: 0 })),
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
              btn('+ Campo a la capa', () => {
                const f = prompt('Nombre del campo nuevo');
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
        btn('+ Campo', () => {
          const f = prompt('Nombre del campo');
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
