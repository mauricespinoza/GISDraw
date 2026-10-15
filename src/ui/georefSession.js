/**
 * Interfaz de georreferenciación, sobre el propio mapa.
 *
 * La imagen (mapa escaneado, foto de libreta, figura de un paper) se pone
 * encima del mapa con una ubicación provisional. Cada punto de control son
 * dos toques: uno SOBRE LA IMAGEN (dónde está el rasgo en la imagen) y otro
 * SOBRE EL MAPA (dónde está de verdad, con snapping a lo ya dibujado), o las
 * coordenadas escritas a mano en UTM o en grados sexagesimales. Con tres o
 * más puntos la imagen se reacomoda en vivo con la transformación elegida y
 * cada punto muestra su residuo en metros.
 *
 * "Aplicar" remuestrea la imagen a UTM 19S, la guarda como GeoTIFF y la deja
 * como capa raster; también se puede descargar el GeoTIFF o los puntos en el
 * formato .points de QGIS.
 */

import { TRANSFORMS, affineOf, solveGeoref, warpToUtm } from '../georef.js';
import { fromLonLat, parseDMS, toLonLat, formatDMS } from '../proj.js';
import { h, sec, row, select, slider, btn } from './dom.js';
import { makeRasterLayer } from '../doc.js';
import { newId } from '../vector.js';
import { imageFiles } from '../raster/rasterView.js';
import { saveFile, download, pickFiles } from '../io/store.js';

export class GeorefSession {
  constructor(app, { name, bitmap, data, w, h }) {
    this.app = app;
    this.name = name;
    this.bitmap = bitmap;
    this.data = data;
    this.w = w;
    this.h = h;
    this.gcps = [];
    this.kind = 'affine';
    this.mode = 'idle'; // idle | src | dst
    this.opacity = 0.7;
    this.visible = true;
    this.sol = null;
    this.error = '';
    // ubicación provisional: la imagen ocupa el 80% de la vista
    const v = app.view;
    const scale = Math.min((v.w * 0.8) / w, (v.h * 0.8) / h) * v.mpp;
    const [ox, oy] = v.toWorld(v.w / 2 - (w * scale) / v.mpp / 2, v.h / 2 - (h * scale) / v.mpp / 2);
    this.initial = { o: [ox, oy], ax: [scale, 0], ay: [0, -scale] };
    this.canvas = h_('canvas', 'georef-canvas');
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'georef-svg');
    const host = document.getElementById('input-host');
    host.before(this.canvas, this.svg);
    app.editor.intercept = (e, sp, wp) => this.onTap(e, sp, wp);
    this.offView = v.onChange(() => this.draw());
    this.draw();
  }

  /* -------------------------------------------------------- transformación */

  affine() {
    if (this.sol) return affineOf(this.sol.forward, this.w, this.h);
    return this.initial;
  }

  /**
   * píxel -> mundo con la VISTA PREVIA afín. Con poly2/TPS la imagen se
   * muestra con su mejor afín; tocar y dibujar marcas usan esa misma afín para
   * que lo que se toca sea lo que se ve. El ajuste real se aplica al remuestrear.
   */
  pixToWorld([c, r]) {
    const A = this.affine();
    return [A.o[0] + A.ax[0] * c + A.ay[0] * r, A.o[1] + A.ax[1] * c + A.ay[1] * r];
  }

  worldToPix([x, y]) {
    const A = this.affine();
    const det = A.ax[0] * A.ay[1] - A.ay[0] * A.ax[1];
    const dx = x - A.o[0];
    const dy = y - A.o[1];
    return [(dx * A.ay[1] - dy * A.ay[0]) / det, (A.ax[0] * dy - A.ax[1] * dx) / det];
  }

  solve() {
    this.error = '';
    const n = this.gcps.filter((g) => g.on !== false && g.dst).length;
    if (n < TRANSFORMS[this.kind].min) {
      this.sol = null;
      return;
    }
    try {
      this.sol = solveGeoref(this.gcps, this.kind);
    } catch (err) {
      this.sol = null;
      this.error = err.message;
    }
  }

  /* -------------------------------------------------------------- dibujo */

  draw() {
    const v = this.app.view;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(v.w * dpr);
    this.canvas.height = Math.round(v.h * dpr);
    const ctx = this.canvas.getContext('2d');
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.canvas.style.opacity = this.visible ? this.opacity : 0;
    if (this.visible) {
      const A = this.affine();
      const [ox, oy] = v.toScreen(...A.o);
      // derivadas en pantalla: x igual, y invertida
      const a = (A.ax[0] / v.mpp) * dpr;
      const b = (-A.ax[1] / v.mpp) * dpr;
      const c = (A.ay[0] / v.mpp) * dpr;
      const d = (-A.ay[1] / v.mpp) * dpr;
      ctx.setTransform(a, b, c, d, ox * dpr, oy * dpr);
      ctx.drawImage(this.bitmap, 0, 0);
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
    // marcas: rojo = en la imagen, verde = en el mapa
    const parts = [];
    this.gcps.forEach((g, i) => {
      const s = v.toScreen(...this.pixToWorld(g.src));
      const off = g.on === false ? ' opacity="0.4"' : '';
      if (g.dst) {
        const d = v.toScreen(...g.dst);
        parts.push(`<line x1="${s[0]}" y1="${s[1]}" x2="${d[0]}" y2="${d[1]}" stroke="#facc15" stroke-width="1.5"${off}/>`);
        parts.push(`<circle cx="${d[0]}" cy="${d[1]}" r="6" fill="#22c55e" stroke="#fff" stroke-width="2"${off}/>`);
      }
      parts.push(`<path d="M${s[0] - 8} ${s[1]}H${s[0] + 8}M${s[0]} ${s[1] - 8}V${s[1] + 8}" stroke="#ef4444" stroke-width="2.5"${off}/>`);
      parts.push(`<text x="${s[0] + 9}" y="${s[1] - 7}" font-size="12" font-weight="700" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke">${i + 1}</text>`);
    });
    this.svg.innerHTML = parts.join('');
  }

  /* ----------------------------------------------------------- interacción */

  onTap(e, sp, wp) {
    if (this.mode === 'src') {
      const p = this.worldToPix(wp);
      if (p[0] < 0 || p[1] < 0 || p[0] > this.w || p[1] > this.h) {
        this.app.message('Toca un punto DENTRO de la imagen');
        return true;
      }
      this.gcps.push({ id: newId('G'), src: p, dst: null, on: true });
      this.mode = 'dst';
      this.app.message('Ahora toca ese mismo lugar en el MAPA (o escribe sus coordenadas)', 4000);
      this.refresh();
      return true;
    }
    if (this.mode === 'dst') {
      const g = this.gcps[this.gcps.length - 1];
      g.dst = this.app.editor.snapPoint(wp).point;
      this.mode = 'idle';
      this.solve();
      this.refresh();
      return true;
    }
    return false; // las demás herramientas siguen funcionando
  }

  refresh() {
    this.draw();
    if (this.app.panels.tab === 'georef') this.app.panels.render();
  }

  close() {
    this.canvas.remove();
    this.svg.remove();
    this.offView?.();
    this.app.editor.intercept = null;
    this.app.georef = null;
    this.app.panels.show('layers');
  }

  /* --------------------------------------------------------------- panel */

  panel() {
    const app = this.app;
    const list = h('table', { class: 'attr-table' });
    list.append(h('tr', {}, h('td', {}, '#'), h('td', {}, 'Imagen → mapa'), h('td', {}, 'Res. (m)'), h('td', {}, '')));
    this.gcps.forEach((g, i) => {
      const r = this.sol?.residuals[i];
      const dst = g.dst ? `${Math.round(g.dst[0])} E ${Math.round(g.dst[1])} N` : '— falta en el mapa —';
      list.append(
        h(
          'tr',
          {},
          h('td', {}, h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: g.on !== false, onchange: (e) => { g.on = e.target.checked; this.solve(); this.refresh(); } }), String(i + 1))),
          h('td', { style: { fontSize: '12px' } }, `${Math.round(g.src[0])}, ${Math.round(g.src[1])} px`, h('br'), dst),
          h('td', { style: { color: r && r.d > 2 * (this.sol?.rms || 0) && r.d > 1 ? '#dc2626' : '' } }, r ? r.d.toFixed(2) : ''),
          h(
            'td',
            {},
            h('button', { class: 'btn sm', title: 'Escribir coordenadas', onclick: () => this.typeCoords(g) }, '⌨'),
            h('button', { class: 'btn sm danger', title: 'Borrar', onclick: () => { this.gcps.splice(i, 1); this.solve(); this.refresh(); } }, '✕'),
          ),
        ),
      );
    });
    const status =
      this.mode === 'src'
        ? 'Toca un rasgo reconocible SOBRE LA IMAGEN…'
        : this.mode === 'dst'
          ? 'Toca el mismo rasgo SOBRE EL MAPA, o escribe sus coordenadas (⌨).'
          : this.error || (this.sol ? `RMS ${this.sol.rms.toFixed(2)} m con ${this.sol.n} puntos` : `Faltan puntos: ${TRANSFORMS[this.kind].label} necesita ${TRANSFORMS[this.kind].min}.`);
    return [
      sec(
        `Georreferenciar: ${this.name}`,
        h('p', { class: 'hint' }, `${this.w} × ${this.h} px. Cada punto: un toque en la imagen y otro en el mapa. Los puntos verdes usan el snapping del dibujo.`),
        row('Transformación', select(Object.fromEntries(Object.entries(TRANSFORMS).map(([k, t]) => [k, `${t.label} (≥${t.min})`])), this.kind, (v) => { this.kind = v; this.solve(); this.refresh(); })),
        h('p', { class: 'hint', style: { fontWeight: 600, color: this.error ? '#dc2626' : '#0f172a' } }, status),
        h(
          'div',
          { class: 'grid-btns two' },
          btn(this.mode === 'idle' ? '+ Añadir punto' : 'Cancelar punto', () => {
            if (this.mode !== 'idle') {
              if (this.mode === 'dst') this.gcps.pop();
              this.mode = 'idle';
            } else {
              this.mode = 'src';
              if (!this.visible) this.visible = true;
            }
            this.refresh();
          }, 'primary'),
          btn(this.visible ? 'Ocultar imagen' : 'Mostrar imagen', () => { this.visible = !this.visible; this.refresh(); }),
        ),
        row('Opacidad', ...slider({ min: 0, max: 100, value: Math.round(this.opacity * 100), fmt: (v) => `${v}%`, oninput: (v) => { this.opacity = v / 100; this.draw(); } })),
      ),
      sec('Puntos de control', this.gcps.length ? list : h('p', { class: 'hint' }, 'Aún no hay puntos.')),
      sec(
        'Resultado',
        h(
          'div',
          { class: 'grid-btns two' },
          btn('Aplicar → capa', () => this.apply(true).catch((e) => app.message(e.message, 5000)), 'primary'),
          btn('Descargar GeoTIFF', () => this.apply(false).catch((e) => app.message(e.message, 5000))),
          btn('Exportar .points', () => this.exportPoints()),
          btn('Importar .points', () => this.importPoints().catch((e) => app.message(e.message, 5000))),
        ),
        btn('Cerrar sin aplicar', () => { if (confirm('¿Cerrar la georreferenciación?')) this.close(); }, 'danger'),
      ),
    ];
  }

  typeCoords(g) {
    const cur = g.dst ? toLonLat(...g.dst) : null;
    const t = prompt(
      'Coordenadas del punto: "E N" (UTM 19S, m) o "lat, lon" en grados (33°27\'12"S, 70°40\'W o decimales)',
      g.dst ? `${formatDMS(cur[1], true)}, ${formatDMS(cur[0], false)}` : '',
    );
    if (!t) return;
    let xy = null;
    const m = t.trim().split(/[\s,;]+/);
    if (m.length === 2 && Number(m[0]) > 1000 && Number(m[1]) > 1000) xy = [Number(m[0]), Number(m[1])];
    else {
      const parts = t.split(/[,;]/);
      if (parts.length >= 2) {
        const lat = parseDMS(parts[0]);
        const lon = parseDMS(parts[1]);
        if (Number.isFinite(lat) && Number.isFinite(lon)) xy = fromLonLat(lon, lat);
      }
    }
    if (!xy) return this.app.message('No entendí las coordenadas');
    g.dst = xy;
    if (this.mode === 'dst') this.mode = 'idle';
    this.solve();
    this.refresh();
  }

  async apply(asLayer) {
    if (!this.sol) throw new Error('Faltan puntos de control');
    this.app.message('Remuestreando a UTM 19S…', 0);
    await new Promise((r) => setTimeout(r, 30));
    const out = warpToUtm(this.data, this.w, this.h, this.sol);
    const { writeUtmGeoTIFF } = await import('../io/geotiff.js');
    const buffer = await writeUtmGeoTIFF(out.rgba, out.w, out.h, out.x0, out.y1, out.cell);
    const base = this.name.replace(/\.[^.]+$/, '');
    if (!asLayer) {
      download(new Blob([buffer], { type: 'image/tiff' }), `${base}_utm19s.tif`);
      this.app.message('GeoTIFF descargado');
      return;
    }
    const bitmap = await createImageBitmap(new ImageData(out.rgba, out.w, out.h));
    const fileId = newId('F');
    imageFiles.set(fileId, { bitmap, x0: out.x0, y0: out.y1 - out.h * out.cell, x1: out.x0 + out.w * out.cell, y1: out.y1 });
    await saveFile(fileId, { kind: 'image', name: `${base}_utm19s.tif`, buffer, epsg: 32719 });
    const l = makeRasterLayer('image', `${base} (georref.)`, { fileId, gcps: this.gcps, kind: this.kind, rms: this.sol.rms });
    const doc = this.app.history.doc;
    const layers = doc.layers.slice();
    const fv = layers.findIndex((x) => x.kind === 'vector');
    layers.splice(fv < 0 ? layers.length : fv, 0, l);
    this.app.history.commit({ ...doc, layers });
    this.app.message(`Imagen georreferenciada (RMS ${this.sol.rms.toFixed(2)} m)`, 4000);
    this.close();
  }

  /** Formato .points de QGIS: mapX,mapY,sourceX,sourceY,enable,dX,dY,residual (fila negativa). */
  exportPoints() {
    const lines = ['#CRS: EPSG:32719', 'mapX,mapY,sourceX,sourceY,enable,dX,dY,residual'];
    this.gcps.forEach((g, i) => {
      if (!g.dst) return;
      const r = this.sol?.residuals[i];
      lines.push([g.dst[0], g.dst[1], g.src[0], -g.src[1], g.on === false ? 0 : 1, r?.dx ?? 0, r?.dy ?? 0, r?.d ?? 0].join(','));
    });
    download(lines.join('\n'), `${this.name.replace(/\.[^.]+$/, '')}.points`, 'text/plain');
  }

  async importPoints() {
    const [f] = await pickFiles('.points,.txt,.csv');
    if (!f) return;
    const text = await f.text();
    if (!/EPSG:32719/.test(text) && /#CRS/.test(text)) this.app.message('Ojo: los puntos no están en EPSG:32719; se leen como si lo estuvieran', 5000);
    const gcps = [];
    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith('#') || /mapX/i.test(line)) continue;
      const v = line.split(/[,\t]/).map(Number);
      if (v.length < 4 || v.slice(0, 4).some((x) => !Number.isFinite(x))) continue;
      gcps.push({ id: newId('G'), dst: [v[0], v[1]], src: [v[2], Math.abs(v[3])], on: v[4] !== 0 });
    }
    this.gcps = gcps;
    this.solve();
    this.refresh();
  }
}

function h_(tag, cls) {
  const el = document.createElement(tag);
  el.className = cls;
  return el;
}

/** Abre una imagen sin georreferencia y empieza la sesión. */
export async function startGeoref(app) {
  const [f] = await pickFiles('image/*,.tif,.tiff');
  if (!f) return;
  let bitmap;
  if (/\.tiff?$/i.test(f.name)) {
    const { loadGeoTIFF } = await import('../io/loader.js');
    const GeoTIFF = await loadGeoTIFF();
    const tiff = await GeoTIFF.fromArrayBuffer(await f.arrayBuffer());
    const img = await tiff.getImage();
    const scale = Math.min(1, 6000 / Math.max(img.getWidth(), img.getHeight()));
    const w = Math.round(img.getWidth() * scale);
    const hh = Math.round(img.getHeight() * scale);
    const rgb = await img.readRGB({ width: w, height: hh, interleave: true });
    const px = new Uint8ClampedArray(w * hh * 4);
    for (let i = 0; i < w * hh; i++) {
      px[i * 4] = rgb[i * 3];
      px[i * 4 + 1] = rgb[i * 3 + 1];
      px[i * 4 + 2] = rgb[i * 3 + 2];
      px[i * 4 + 3] = 255;
    }
    bitmap = await createImageBitmap(new ImageData(px, w, hh));
  } else {
    bitmap = await createImageBitmap(f);
  }
  // limitar a 6000 px de lado: memoria del iPad
  const scale = Math.min(1, 6000 / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const hh = Math.round(bitmap.height * scale);
  const c = new OffscreenCanvas(w, hh);
  const g = c.getContext('2d');
  g.drawImage(bitmap, 0, 0, w, hh);
  const data = g.getImageData(0, 0, w, hh);
  const bmp = scale < 1 ? await createImageBitmap(c) : bitmap;
  if (app.georef) app.georef.close();
  app.georef = new GeorefSession(app, { name: f.name, bitmap: bmp, data, w, h: hh });
  app.showPanel('georef');
  app.message('Toca «+ Añadir punto», luego un rasgo en la imagen y después el mismo rasgo en el mapa', 6000);
}
