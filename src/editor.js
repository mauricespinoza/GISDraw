/**
 * El editor: herramientas, entrada (lápiz, dedo, ratón y teclado), snapping,
 * trace y la capa de interacción (selección, manejadores, nodos, borradores).
 *
 * REPARTO DE LA ENTRADA — lo que hace usable un dibujo en tablet:
 *  - Apple Pencil (`pointerType: pen`): SIEMPRE usa la herramienta activa. Su
 *    hover (iPad recientes) mueve el cursor de snapping y la línea elástica
 *    sin tocar la pantalla.
 *  - Dedo: un dedo desplaza, dos dedos hacen zoom y desplazan. Un toque corto
 *    con el dedo selecciona (con selección / nodos). Así la palma o un dedo
 *    apoyado nunca dibujan por error. Para pantallas táctiles sin lápiz hay un
 *    ajuste "el dedo dibuja".
 *  - Ratón: botón izquierdo = herramienta, central o barra espaciadora =
 *    desplazar, derecho = terminar el trazo en curso (como en QGIS) o, sin
 *    trazo en curso, menú contextual; rueda = zoom; en trackpad, dos dedos
 *    desplazan y el pellizco hace zoom.
 *  - Mantener el dedo (o el lápiz con selección/nodos) quieto ~0,5 s abre el
 *    mismo menú contextual que el botón derecho.
 */

import { addShapes, allTopShapes, findTopShape, layerOfShape, mapShapes, removeShapes, replaceShapes } from './doc.js';
import { splitPath } from './ops.js';
import { pickShape, shapesInBox, shapesInLasso, shapeDistance, flatRings } from './hit.js';
import { SnapIndex, buildGraph, tracePath } from './snapping.js';
import { nodesD, shapeD, esc } from './style.js';
import { paperUnits } from './view.js';
import {
  makeEllipsePath,
  makeNode,
  makePath,
  makePoint,
  makeRectPath,
  makeText,
  nearestOnPath,
  polylineToNodes,
  rotateShape,
  scaleShape,
  shapeBBox,
  simplify,
  splitNodes,
  translateShape,
  unionBBox,
  cloneNode,
} from './vector.js';

export const TOOLS = {
  select: { label: 'Selección', key: 'v' },
  node: { label: 'Nodos', key: 'a' },
  lasso: { label: 'Lazo', key: 'q' },
  pen: { label: 'Pluma / línea', key: 'p' },
  polygon: { label: 'Polígono', key: 'y' },
  pencil: { label: 'Lápiz (trazo libre)', key: 'b' },
  line: { label: 'Segmento', key: '\\' },
  arrow: { label: 'Flecha', key: 'w' },
  rect: { label: 'Rectángulo', key: 'm' },
  ellipse: { label: 'Elipse', key: 'e' },
  text: { label: 'Texto', key: 't' },
  point: { label: 'Punto', key: 'o' },
  scissors: { label: 'Tijera (cortar trazo)', key: 'c' },
  eyedropper: { label: 'Cuentagotas', key: 'i' },
  pan: { label: 'Mano', key: 'h' },
  zoom: { label: 'Zoom (Alt = alejar)', key: 'z' },
};

const DRAW_TOOLS = new Set(['pen', 'polygon', 'pencil', 'line', 'arrow', 'rect', 'ellipse', 'text', 'point']);
const HANDLE_KEYS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const SNAP_PX = 12;
const TAP_MS = 350;
const TAP_MOVE = 8;
const LONG_PRESS_MS = 550;
const MIN_TEXT_PX = 16; // tamaño mínimo en pantalla de un texto nuevo

/** Redondea hacia arriba a un tamaño tipográfico "limpio". */
export function niceFontSize(pt) {
  if (pt <= 12) return Math.ceil(pt * 2) / 2;
  if (pt <= 100) return Math.ceil(pt / 2) * 2;
  if (pt <= 1000) return Math.ceil(pt / 10) * 10;
  return Math.ceil(pt / 100) * 100;
}

export class Editor {
  constructor({ history, view, host, settings, getCurrentStyle, onChange, onMessage, onEditText }) {
    this.history = history;
    this.view = view;
    this.host = host; // elemento que recibe la entrada
    this.settings = settings; // { fingerDraws, snap, trace, smoothing }
    this.getCurrentStyle = getCurrentStyle;
    this.onChange = onChange || (() => {});
    this.onMessage = onMessage || (() => {});
    this.onEditText = onEditText || (() => {});
    this.tool = 'select';
    this.selection = new Set();
    this.draft = null; // { nodes, snaps, closedTool }
    this.preview = null;
    this.hover = null; // {sp, wp, snap, tracePreview}
    this.activeNode = null; // {id, ring: -1|holeIndex, index}
    this.addMode = false; // "añadir a la selección" para el dedo/lápiz
    this.pointers = new Map();
    this.drag = null;
    this.spaceDown = false;
    this.clipboard = [];
    this.snapDirty = true;
    this.lastTap = null;
    this.bind();
  }

  /* ---------------------------------------------------------------- estado */

  get doc() {
    return this.history.doc;
  }

  units() {
    return paperUnits(this.view, this.doc.refScale);
  }

  est() {
    const u = this.units();
    return { mmToM: u.mmToM, ptToM: u.ptToM, mpp: this.view.mpp };
  }

  setTool(tool) {
    if (!TOOLS[tool]) return;
    if (this.draft) this.finishDraft(false);
    this.tool = tool;
    this.preview = null;
    this.activeNode = null;
    this.host.dataset.tool = tool;
    this.changed();
  }

  setSelection(ids) {
    this.selection = new Set(ids);
    this.activeNode = null;
    this.changed();
  }

  changed() {
    this.onChange(this);
  }

  /** Tras deshacer o cambiar el documento: limpiar ids que ya no existen. */
  pruneSelection() {
    const alive = new Set(allTopShapes(this.doc, { visibleOnly: false }).map((x) => x.shape.id));
    for (const id of [...this.selection]) if (!alive.has(id)) this.selection.delete(id);
    this.snapDirty = true;
  }

  activeLayer() {
    const l = this.doc.layers.find((x) => x.id === this.doc.activeLayerId);
    return l && l.kind === 'vector' ? l : null;
  }

  ensureDrawableLayer() {
    const l = this.activeLayer();
    if (!l) {
      this.onMessage('Elige una capa vectorial activa para dibujar');
      return null;
    }
    if (l.locked) {
      this.onMessage(`La capa «${l.name}» está bloqueada`);
      return null;
    }
    if (!l.visible) {
      this.onMessage(`La capa «${l.name}» está oculta`);
      return null;
    }
    return l;
  }

  selectedShapes() {
    return [...this.selection].map((id) => findTopShape(this.doc, id)?.shape).filter(Boolean);
  }

  selectionBox() {
    const shapes = this.selectedShapes();
    return unionBBox(shapes.map((s) => shapeBBox(s, this.est())));
  }

  /* ---------------------------------------------------------------- snapping */

  snapIndex() {
    if (this.snapDirty || !this._snap || this._snapView !== `${this.view.cx}|${this.view.cy}|${this.view.mpp}|${this.view.w}`) {
      const idx = new SnapIndex(64 * this.view.mpp);
      const ext = this.view.extent(200);
      const tol = this.view.mpp * 0.5;
      const addShape = (s) => {
        if (s.visible === false) return;
        if (s.type === 'group') return s.children.forEach(addShape);
        if (s.type === 'point' || s.type === 'text') {
          idx.addPolyline([[s.x, s.y], [s.x + 1e-6, s.y]], false, { id: s.id });
          return;
        }
        if (s.type !== 'path') return;
        const b = shapeBBox(s);
        if (b.x > ext.maxX || b.x + b.w < ext.minX || b.y > ext.maxY || b.y + b.h < ext.minY) return;
        for (const r of flatRings(s, tol)) {
          const pts = r.closed ? r.pts.slice(0, -1) : r.pts;
          idx.addPolyline(pts, r.closed, { id: s.id });
        }
      };
      for (const l of this.doc.layers) if (l.kind === 'vector' && l.visible) l.items.forEach(addShape);
      this._snap = idx;
      this._graph = null;
      this._snapView = `${this.view.cx}|${this.view.cy}|${this.view.mpp}|${this.view.w}`;
      this.snapDirty = false;
    }
    return this._snap;
  }

  graph() {
    if (!this._graph) this._graph = buildGraph(this.snapIndex());
    return this._graph;
  }

  /** Punto de mundo con snapping (a vértices y segmentos, y al propio borrador). */
  snapPoint(wp, { force = false } = {}) {
    if (!this.settings.snap && !force) return { point: wp, snap: null };
    const tol = SNAP_PX * this.view.mpp;
    // primero el borrador: cerrar el polígono / unir al inicio
    if (this.draft?.nodes.length) {
      const first = this.draft.nodes[0];
      if (Math.hypot(first.x - wp[0], first.y - wp[1]) < tol) return { point: [first.x, first.y], snap: { type: 'first' } };
    }
    const s = this.snapIndex().query(wp, tol);
    if (s) return { point: s.point, snap: s };
    return { point: wp, snap: null };
  }

  /* ---------------------------------------------------------------- entrada */

  bind() {
    const h = this.host;
    h.addEventListener('pointerdown', (e) => this.onDown(e));
    h.addEventListener('pointermove', (e) => this.onMove(e));
    h.addEventListener('pointerup', (e) => this.onUp(e));
    h.addEventListener('pointercancel', (e) => this.onUp(e, true));
    h.addEventListener('pointerleave', (e) => {
      if (e.pointerType !== 'touch' && !this.drag) {
        this.hover = null;
        this.changed();
      }
    });
    h.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    h.addEventListener('contextmenu', (e) => e.preventDefault());
    h.addEventListener('dblclick', (e) => this.onDoubleClick(e));
    // Safari: el pellizco del trackpad llega como gesture*
    h.addEventListener('gesturestart', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => {
      if (e.code === 'Space') this.spaceDown = false;
    });
  }

  screenPoint(e) {
    const r = this.host.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  isToolPointer(e) {
    if (e.pointerType === 'pen') return true;
    if (e.pointerType === 'mouse') return e.button === 0 && !this.spaceDown;
    return !!this.settings.fingerDraws;
  }

  onDown(e) {
    try {
      this.host.setPointerCapture?.(e.pointerId);
    } catch {
      /* puntero sintético o ya liberado: no hace falta capturarlo */
    }
    const sp = this.screenPoint(e);
    this.pointers.set(e.pointerId, { sp, type: e.pointerType, t: performance.now(), start: sp });
    if (e.pointerType === 'pen') this.penSeen = true;
    this.onPointerStart?.();

    // mantener apretado = menú contextual (dedo; lápiz solo con selección y nodos)
    this.clearLongPress();
    if (this.pointers.size === 1 && (e.pointerType === 'touch' || (e.pointerType === 'pen' && ['select', 'node', 'lasso', 'scissors'].includes(this.tool)))) {
      this.lp = { id: e.pointerId, sp };
      this.lpTimer = setTimeout(() => this.longPress(), LONG_PRESS_MS);
    }

    // dos dedos: gesto de cámara, cancela lo que hubiera empezado el primero
    const touches = [...this.pointers.values()].filter((p) => p.type === 'touch');
    if (touches.length >= 2) {
      this.clearLongPress();
      if (this.drag && this.drag.mode !== 'pinch') this.cancelDrag();
      const [a, b] = touches;
      this.drag = { mode: 'pinch', dist: Math.hypot(a.sp[0] - b.sp[0], a.sp[1] - b.sp[1]), mid: mid(a.sp, b.sp) };
      return;
    }

    if (e.pointerType === 'mouse' && (e.button === 1 || (e.button === 0 && this.spaceDown))) {
      this.drag = { mode: 'pan', last: sp };
      e.preventDefault();
      return;
    }
    if (e.pointerType === 'mouse' && e.button === 2) {
      if (this.draft) this.finishDraft(this.tool === 'polygon');
      else this.openContextMenu(sp, e);
      return;
    }
    if (this.tool === 'pan' || (!this.isToolPointer(e) && e.pointerType === 'touch')) {
      this.drag = { mode: 'pan', last: sp, fingerTap: e.pointerType === 'touch', start: sp, t: performance.now() };
      return;
    }
    this.toolDown(e, sp);
  }

  onMove(e) {
    const sp = this.screenPoint(e);
    const p = this.pointers.get(e.pointerId);
    if (p) p.sp = sp;
    if (this.lp && this.lp.id === e.pointerId && Math.hypot(sp[0] - this.lp.sp[0], sp[1] - this.lp.sp[1]) > TAP_MOVE) this.clearLongPress();
    const d = this.drag;

    if (d?.mode === 'pinch') {
      const touches = [...this.pointers.values()].filter((q) => q.type === 'touch');
      if (touches.length < 2) return;
      const [a, b] = touches;
      const dist = Math.hypot(a.sp[0] - b.sp[0], a.sp[1] - b.sp[1]);
      const m = mid(a.sp, b.sp);
      this.view.panBy(m[0] - d.mid[0], m[1] - d.mid[1]);
      if (d.dist > 0 && dist > 0) this.view.zoomAt(d.dist / dist, m[0], m[1]);
      d.dist = dist;
      d.mid = m;
      return;
    }
    if (d?.mode === 'pan') {
      this.view.panBy(sp[0] - d.last[0], sp[1] - d.last[1]);
      d.last = sp;
      return;
    }
    if (!d) {
      // hover del lápiz o del ratón: cursor de snapping y línea elástica
      if (e.pointerType === 'touch') return;
      if (DRAW_TOOLS.has(this.tool) || this.tool === 'node') this.updateHover(sp);
      return;
    }
    this.toolMove(e, sp);
  }

  onUp(e, cancelled = false) {
    if (this.lp?.id === e.pointerId) this.clearLongPress();
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.mode === 'pinch') {
      if ([...this.pointers.values()].filter((q) => q.type === 'touch').length < 2) this.drag = null;
      return;
    }
    if (d.mode === 'pan') {
      this.drag = null;
      // toque corto con el dedo = seleccionar
      if (d.fingerTap && !cancelled && p) {
        const moved = Math.hypot(p.sp[0] - d.start[0], p.sp[1] - d.start[1]);
        if (moved < TAP_MOVE && performance.now() - d.t < TAP_MS * 2) this.fingerTap(p.sp);
      }
      this.view.emit();
      return;
    }
    if (cancelled) {
      this.cancelDrag();
      return;
    }
    this.toolUp(e, this.screenPoint(e));
  }

  clearLongPress() {
    clearTimeout(this.lpTimer);
    this.lp = null;
  }

  longPress() {
    const lp = this.lp;
    this.lp = null;
    if (!lp || !this.pointers.has(lp.id) || this.drag?.mode === 'pinch') return;
    // abandona lo que hubiera empezado el toque (desplazar, mover, recuadro)
    if (this.drag) this.cancelDrag();
    navigator.vibrate?.(12);
    this.openContextMenu(lp.sp, null);
  }

  /** Menú contextual: selecciona lo que está bajo el puntero y avisa a la app. */
  openContextMenu(sp, e) {
    if (!this.onContextMenu) return;
    const hit = pickShape(this.doc, sp, this.view, this.units(), e?.pointerType === 'mouse' ? 6 : 12);
    let node = null;
    if (this.tool === 'node' && this.nodeTarget()) {
      const shape = this.nodeTarget();
      const rings = [-1, ...(shape.holes || []).map((_, i) => i)];
      for (const ring of rings) {
        this.ringNodes(shape, ring).forEach((n, i) => {
          const [x, y] = this.view.toScreen(n.x, n.y);
          if (!node && Math.hypot(sp[0] - x, sp[1] - y) < 14) node = { id: shape.id, ring, index: i };
        });
      }
      if (node) {
        this.activeNode = node;
        this.changed();
      }
    }
    if (!node && hit && !this.selection.has(hit.shape.id)) this.setSelection([hit.shape.id]);
    this.onContextMenu(sp, { hit: hit?.shape || null, node, wp: this.view.toWorld(...sp) });
  }

  fingerTap(sp) {
    if (this.tool === 'select' || this.tool === 'node' || this.tool === 'lasso' || this.tool === 'eyedropper') {
      const hit = pickShape(this.doc, sp, this.view, this.units(), 14);
      if (this.tool === 'eyedropper' && hit) return this.applyEyedropper(hit.shape);
      if (hit) {
        if (this.addMode) this.toggleSel(hit.shape.id);
        else this.setSelection([hit.shape.id]);
      } else if (!this.addMode) this.setSelection([]);
    } else if (this.draft) {
      // con el dedo, un toque mientras se dibuja con el lápiz no hace nada:
      // evita vértices fantasma al apoyar la mano
    }
  }

  cancelDrag() {
    const d = this.drag;
    this.drag = null;
    if (d && ['move', 'scale', 'rotate', 'node', 'bezier'].includes(d.mode)) {
      if (this.history.anchor) this.history.preview(this.history.anchor);
      this.history.anchor = null;
    }
    this.preview = null;
    this.changed();
  }

  onWheel(e) {
    e.preventDefault();
    const sp = this.screenPoint(e);
    // Rueda del ratón = zoom (ajuste «Rueda: desplazar» la deja para mover el
    // mapa, y entonces Ctrl/Alt hacen zoom). Un trackpad se reconoce porque
    // entrega deltaX o valores fraccionarios: sus dos dedos siempre desplazan
    // y su pellizco (Ctrl) hace zoom.
    const now = performance.now();
    if (e.deltaMode === 0 && !e.ctrlKey && (e.deltaX !== 0 || !Number.isInteger(e.deltaY))) this.lastTrackpad = now;
    const trackpad = now - (this.lastTrackpad || -1e9) < 600;
    const wheelZooms = this.settings.wheelMode !== 'pan';
    const zoomy = e.ctrlKey || e.metaKey || e.altKey || (wheelZooms && !trackpad);
    if (zoomy) {
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      const k = Math.exp(Math.max(-150, Math.min(150, dy)) * (e.ctrlKey ? 0.01 : 0.0022));
      this.view.zoomAt(k, sp[0], sp[1]);
    } else {
      this.view.panBy(-e.deltaX, -e.deltaY);
    }
  }

  /* ---------------------------------------------------------- herramientas */

  toolDown(e, sp) {
    const wp = this.view.toWorld(...sp);
    // un modo externo (georreferenciación) puede quedarse con el toque
    if (this.intercept && this.intercept(e, sp, wp)) return;
    const shift = e.shiftKey;
    switch (this.tool) {
      case 'select':
        return this.selectDown(e, sp, wp, shift);
      case 'node':
        return this.nodeDown(e, sp, wp);
      case 'lasso':
        this.drag = { mode: 'lasso', pts: [wp] };
        return;
      case 'zoom':
        this.drag = { mode: 'zoombox', start: wp, sp0: sp };
        return;
      case 'scissors':
        return this.scissorsAt(sp, wp);
      case 'eyedropper': {
        const hit = pickShape(this.doc, sp, this.view, this.units(), 10, { includeLocked: true });
        if (hit) this.applyEyedropper(hit.shape);
        return;
      }
      case 'pen':
      case 'polygon':
        return this.penDown(e, sp, wp);
      case 'pencil': {
        if (!this.ensureDrawableLayer()) return;
        const { point, snap } = this.snapPoint(wp);
        this.drag = { mode: 'pencil', pts: [{ x: point[0], y: point[1] }], startSnap: snap };
        this.preview = { kind: 'pencil', pts: this.drag.pts };
        return;
      }
      case 'line':
      case 'arrow':
      case 'rect':
      case 'ellipse': {
        if (!this.ensureDrawableLayer()) return;
        const snapped = ['line', 'arrow'].includes(this.tool) ? this.snapPoint(wp).point : wp;
        this.drag = { mode: 'create', start: snapped };
        this.preview = { kind: this.tool, start: snapped, end: snapped };
        return;
      }
      case 'text':
        // el cuadro de texto se abre al SOLTAR: si se enfoca al apretar, el
        // propio clic le quita el foco y el texto se cierra sin poder escribir
        if (!this.ensureDrawableLayer()) return;
        this.drag = { mode: 'text', sp0: sp, wp };
        return;
      case 'point': {
        const l = this.ensureDrawableLayer();
        if (!l) return;
        const { point } = this.snapPoint(wp);
        const st = this.getCurrentStyle();
        const pt = makePoint(point[0], point[1], {
          ...st,
          fill: st.fill !== 'none' ? st.fill : st.stroke,
          fillOpacity: 1,
          fillType: 'solid',
          stroke: st.fill !== 'none' ? st.stroke : '#ffffff',
          strokeWidth: Math.min(st.strokeWidth, 0.4),
        });
        this.history.commit(addShapes(this.doc, l.id, [pt]));
        this.setSelection([pt.id]);
        return;
      }
      default:
    }
  }

  toolMove(e, sp) {
    const d = this.drag;
    const wp = this.view.toWorld(...sp);
    switch (d.mode) {
      case 'move': {
        let dx = wp[0] - d.start[0];
        let dy = wp[1] - d.start[1];
        if (e.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0;
          else dx = 0;
        }
        if (Math.hypot(sp[0] - d.sp0[0], sp[1] - d.sp0[1]) > 3) d.moved = true;
        if (!d.moved) return;
        const map = new Map(d.shapes.map((s) => [s.id, translateShape(s, dx, dy)]));
        this.history.preview(replaceShapes(d.base, map));
        return;
      }
      case 'scale': {
        const { box, handle } = d;
        const ax = handle.includes('w') ? box.x + box.w : handle.includes('e') ? box.x : box.x + box.w / 2;
        // 'n' es arriba en pantalla = máximo y
        const ay = handle.includes('n') ? box.y : handle.includes('s') ? box.y + box.h : box.y + box.h / 2;
        const anchor = e.altKey ? { x: box.x + box.w / 2, y: box.y + box.h / 2 } : { x: ax, y: ay };
        const fx = handle.includes('w') ? box.x : box.x + box.w;
        const fy = handle.includes('n') ? box.y + box.h : box.y;
        let sx = handle.includes('e') || handle.includes('w') ? (wp[0] - anchor.x) / (fx - anchor.x || 1) : 1;
        let sy = handle.includes('n') || handle.includes('s') ? (wp[1] - anchor.y) / (fy - anchor.y || 1) : 1;
        if (e.shiftKey || d.shapes.some((s) => s.type === 'text')) {
          // proporcional: en esquinas manda el eje que más cambió; en bordes, ese eje
          let k;
          if (handle.length === 2) k = Math.max(Math.abs(sx), Math.abs(sy));
          else k = Math.abs('ew'.includes(handle) ? sx : sy);
          sx = Math.sign(sx || 1) * k;
          sy = Math.sign(sy || 1) * k;
        }
        sx = Number.isFinite(sx) && Math.abs(sx) > 0.001 ? sx : 0.001;
        sy = Number.isFinite(sy) && Math.abs(sy) > 0.001 ? sy : 0.001;
        const map = new Map(d.shapes.map((s) => [s.id, scaleShape(s, anchor, sx, sy)]));
        this.history.preview(replaceShapes(d.base, map));
        return;
      }
      case 'rotate': {
        const a0 = Math.atan2(d.start[1] - d.center.y, d.start[0] - d.center.x);
        const a1 = Math.atan2(wp[1] - d.center.y, wp[0] - d.center.x);
        let deg = ((a1 - a0) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        d.deg = deg;
        const map = new Map(d.shapes.map((s) => [s.id, rotateShape(s, d.center, deg)]));
        this.history.preview(replaceShapes(d.base, map));
        return;
      }
      case 'marquee':
      case 'zoombox':
        d.end = wp;
        this.preview = { kind: 'marquee', start: d.start, end: wp };
        this.changed();
        return;
      case 'lasso':
        d.pts.push(wp);
        this.preview = { kind: 'lasso', pts: d.pts };
        this.changed();
        return;
      case 'node':
        return this.nodeDrag(e, wp);
      case 'bezier':
        return this.bezierDrag(e, wp);
      case 'pen-handle': {
        const n = this.draft.nodes[this.draft.nodes.length - 1];
        if (Math.hypot(sp[0] - d.sp0[0], sp[1] - d.sp0[1]) < 4) return;
        n.hOut = { x: wp[0], y: wp[1] };
        n.hIn = { x: 2 * n.x - wp[0], y: 2 * n.y - wp[1] };
        n.smooth = true;
        this.changed();
        return;
      }
      case 'pencil': {
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot(wp[0] - last.x, wp[1] - last.y) < this.view.mpp * 1.2) return;
        d.pts.push({ x: wp[0], y: wp[1] });
        this.changed();
        return;
      }
      case 'create': {
        let end = ['line', 'arrow'].includes(this.tool) ? this.snapPoint(wp).point : wp;
        if (e.shiftKey) end = constrain(d.start, end, this.tool);
        this.preview = { kind: this.tool, start: d.start, end, fromCenter: e.altKey };
        this.changed();
        return;
      }
      default:
    }
  }

  toolUp(e, sp) {
    const d = this.drag;
    this.drag = null;
    const wp = this.view.toWorld(...sp);
    switch (d.mode) {
      case 'move':
        if (!d.moved) {
          this.history.anchor = null;
          // clic sin arrastre sobre algo ya seleccionado y varios: quedarse solo con eso
          if (d.clickedSelected && !e.shiftKey && !this.addMode && this.selection.size > 1) this.setSelection([d.hitId]);
          return;
        }
        this.history.end();
        this.snapDirty = true;
        return;
      case 'scale':
      case 'rotate':
      case 'node':
      case 'bezier':
        this.history.end();
        this.snapDirty = true;
        return;
      case 'marquee': {
        this.preview = null;
        const box = rectOf(d.start, d.end || d.start);
        if (box.w / this.view.mpp < 3 && box.h / this.view.mpp < 3) {
          if (!e.shiftKey && !this.addMode) this.setSelection([]);
          this.changed();
          return;
        }
        const ids = shapesInBox(this.doc, box, this.est(), { contain: e.altKey });
        this.setSelection(e.shiftKey || this.addMode ? [...this.selection, ...ids] : ids);
        return;
      }
      case 'lasso': {
        this.preview = null;
        if (d.pts.length < 3) return this.changed();
        const ids = shapesInLasso(this.doc, d.pts, this.est());
        this.setSelection(e.shiftKey || this.addMode ? [...this.selection, ...ids] : ids);
        return;
      }
      case 'pen-handle':
        this.updateHover(sp);
        return;
      case 'zoombox': {
        this.preview = null;
        const box = rectOf(d.start, d.end || d.start);
        if (box.w / this.view.mpp < 6 && box.h / this.view.mpp < 6) this.view.zoomAt(e.altKey ? 2 : 0.5, sp[0], sp[1]);
        else this.view.fit(box);
        this.changed();
        return;
      }
      case 'text':
        return this.textAt(d.sp0, d.wp);
      case 'pencil':
        return this.finishPencil(d);
      case 'create':
        return this.finishCreate(d, this.preview);
      default:
    }
  }

  /* --------------------------------------------------------- selección */

  toggleSel(id) {
    const s = new Set(this.selection);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.setSelection(s);
  }

  handleAt(sp) {
    const box = this.selectionBox();
    if (!box) return null;
    const P = (x, y) => this.view.toScreen(x, y);
    const [x0, y0] = P(box.x, box.y + box.h);
    const [x1, y1] = P(box.x + box.w, box.y);
    const hs = 12;
    const pos = handlePositions(x0, y0, x1, y1);
    for (const k of HANDLE_KEYS) if (Math.hypot(sp[0] - pos[k][0], sp[1] - pos[k][1]) < hs) return k;
    if (Math.hypot(sp[0] - (x0 + x1) / 2, sp[1] - (y0 - 26)) < hs) return 'rotate';
    return null;
  }

  selectDown(e, sp, wp, shift) {
    const add = shift || this.addMode;
    const handle = this.selection.size ? this.handleAt(sp) : null;
    if (handle) {
      const shapes = this.selectedShapes().filter((s) => !s.locked);
      if (!shapes.length) return;
      this.history.begin();
      const box = this.selectionBox();
      if (handle === 'rotate') {
        this.drag = { mode: 'rotate', start: wp, center: { x: box.x + box.w / 2, y: box.y + box.h / 2 }, shapes, base: this.doc };
      } else {
        this.drag = { mode: 'scale', handle, box, shapes, base: this.doc };
      }
      return;
    }
    const hit = pickShape(this.doc, sp, this.view, this.units(), e.pointerType === 'mouse' ? 6 : 10);
    if (hit) {
      const id = hit.shape.id;
      const already = this.selection.has(id);
      if (add) this.toggleSel(id);
      else if (!already) this.setSelection([id]);
      if (!this.selection.has(id)) return;
      const shapes = this.selectedShapes().filter((s) => !s.locked);
      this.history.begin();
      this.drag = { mode: 'move', start: wp, sp0: sp, shapes, base: this.doc, moved: false, clickedSelected: already, hitId: id };
      // Alt al arrastrar = duplicar, como en Illustrator
      if (e.altKey) {
        this.duplicate(0, true);
        this.drag.shapes = this.selectedShapes();
        this.drag.base = this.doc;
      }
      return;
    }
    this.drag = { mode: 'marquee', start: wp };
  }

  /* --------------------------------------------------------- nodos */

  nodeTarget() {
    if (this.selection.size !== 1) return null;
    const s = this.selectedShapes()[0];
    return s && s.type === 'path' && !s.locked ? s : null;
  }

  ringNodes(shape, ring) {
    return ring < 0 ? shape.nodes : shape.holes[ring];
  }

  nodeDown(e, sp, wp) {
    const shape = this.nodeTarget();
    const tol = 12;
    if (shape) {
      const P = (x, y) => this.view.toScreen(x, y);
      const rings = [-1, ...(shape.holes || []).map((_, i) => i)];
      // manejadores Bézier del nodo activo primero
      for (const ring of rings) {
        const nodes = this.ringNodes(shape, ring);
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          for (const kind of ['hIn', 'hOut']) {
            if (!n[kind]) continue;
            const [hx, hy] = P(n[kind].x, n[kind].y);
            if (Math.hypot(sp[0] - hx, sp[1] - hy) < tol) {
              this.activeNode = { id: shape.id, ring, index: i };
              this.history.begin();
              this.drag = { mode: 'bezier', id: shape.id, ring, index: i, kind, alt: e.altKey };
              this.changed();
              return;
            }
          }
        }
        for (let i = 0; i < nodes.length; i++) {
          const [nx, ny] = P(nodes[i].x, nodes[i].y);
          if (Math.hypot(sp[0] - nx, sp[1] - ny) < tol) {
            if (e.altKey) return this.toggleSmooth(shape.id, ring, i);
            this.activeNode = { id: shape.id, ring, index: i };
            this.history.begin();
            this.drag = { mode: 'node', id: shape.id, ring, index: i };
            this.changed();
            return;
          }
        }
      }
      // sobre el trazo: insertar nodo (Alt) o simplemente nada
      for (const ring of rings) {
        const nodes = this.ringNodes(shape, ring);
        const near = nearestOnPath(nodes, ring < 0 ? shape.closed : true, { x: wp[0], y: wp[1] });
        if (near && near.dist / this.view.mpp < 8 && (e.altKey || this.settings.insertOnTap)) {
          this.insertNode(shape.id, ring, near.segIndex, near.t);
          return;
        }
      }
    }
    const hit = pickShape(this.doc, sp, this.view, this.units(), 10);
    this.setSelection(hit ? [hit.shape.id] : []);
  }

  updateRing(shape, ring, f) {
    if (ring < 0) return { ...shape, nodes: f(shape.nodes) };
    const holes = shape.holes.slice();
    holes[ring] = f(holes[ring]);
    return { ...shape, holes };
  }

  nodeDrag(e, wp) {
    const d = this.drag;
    let p = wp;
    if (this.settings.snap) {
      // no engancharse a la propia forma
      const s = this.snapIndex().query(wp, SNAP_PX * this.view.mpp);
      if (s && s.meta?.id !== d.id) p = s.point;
    }
    const doc = mapShapes(this.history.anchor || this.doc, [d.id], (shape) =>
      this.updateRing(shape, d.ring, (nodes) =>
        nodes.map((n, i) => {
          if (i !== d.index) return n;
          const dx = p[0] - n.x;
          const dy = p[1] - n.y;
          return {
            ...n,
            x: p[0],
            y: p[1],
            hIn: n.hIn ? { x: n.hIn.x + dx, y: n.hIn.y + dy } : null,
            hOut: n.hOut ? { x: n.hOut.x + dx, y: n.hOut.y + dy } : null,
          };
        }),
      ),
    );
    this.history.preview(doc);
  }

  bezierDrag(e, wp) {
    const d = this.drag;
    const p = { x: wp[0], y: wp[1] };
    const doc = mapShapes(this.history.anchor || this.doc, [d.id], (shape) =>
      this.updateRing(shape, d.ring, (nodes) =>
        nodes.map((n, i) => {
          if (i !== d.index) return n;
          const mirror = { x: 2 * n.x - p.x, y: 2 * n.y - p.y };
          const keep = d.alt || e.altKey || !n.smooth; // Alt rompe la simetría
          if (d.kind === 'hOut') return { ...n, hOut: p, hIn: !keep && n.hIn ? mirror : n.hIn, smooth: !keep && n.smooth };
          return { ...n, hIn: p, hOut: !keep && n.hOut ? mirror : n.hOut, smooth: !keep && n.smooth };
        }),
      ),
    );
    this.history.preview(doc);
  }

  toggleSmooth(id, ring, index) {
    this.history.commit(
      mapShapes(this.doc, [id], (shape) =>
        this.updateRing(shape, ring, (nodes) =>
          nodes.map((n, i) => {
            if (i !== index) return n;
            if (n.hIn || n.hOut) return { ...n, hIn: null, hOut: null, smooth: false };
            const prev = nodes[(i - 1 + nodes.length) % nodes.length];
            const next = nodes[(i + 1) % nodes.length];
            const dx = (next.x - prev.x) / 6;
            const dy = (next.y - prev.y) / 6;
            return { ...n, smooth: true, hIn: { x: n.x - dx, y: n.y - dy }, hOut: { x: n.x + dx, y: n.y + dy } };
          }),
        ),
      ),
    );
    this.activeNode = { id, ring, index };
    this.changed();
  }

  insertNode(id, ring, seg, t) {
    this.history.commit(
      mapShapes(this.doc, [id], (shape) => this.updateRing(shape, ring, (nodes) => splitNodes(nodes, ring < 0 ? shape.closed : true, seg, t))),
    );
    this.activeNode = { id, ring, index: seg + 1 };
    this.snapDirty = true;
    this.changed();
  }

  deleteActiveNode() {
    const a = this.activeNode;
    if (!a) return false;
    const found = findTopShape(this.doc, a.id);
    if (!found) return false;
    const shape = found.shape;
    const nodes = this.ringNodes(shape, a.ring);
    const min = shape.closed || a.ring >= 0 ? 3 : 2;
    if (nodes.length <= min) {
      this.onMessage('No quedan nodos suficientes; borra la forma completa con la herramienta de selección');
      return true;
    }
    this.history.commit(mapShapes(this.doc, [a.id], (s) => this.updateRing(s, a.ring, (ns) => ns.filter((_, i) => i !== a.index))));
    this.activeNode = null;
    this.snapDirty = true;
    this.changed();
    return true;
  }

  /** Abre o cierra el trazo seleccionado. */
  toggleClosed() {
    const s = this.nodeTarget() || this.selectedShapes().find((x) => x.type === 'path');
    if (!s) return;
    this.history.commit(mapShapes(this.doc, [s.id], (x) => ({ ...x, closed: !x.closed, holes: x.closed ? null : x.holes })));
  }

  reverseSelected() {
    const ids = this.selectedShapes().filter((s) => s.type === 'path').map((s) => s.id);
    if (!ids.length) return;
    this.history.commit(
      mapShapes(this.doc, ids, (s) => ({
        ...s,
        nodes: s.nodes
          .slice()
          .reverse()
          .map((n) => ({ ...cloneNode(n), hIn: n.hOut ? { ...n.hOut } : null, hOut: n.hIn ? { ...n.hIn } : null })),
      })),
    );
  }

  /* --------------------------------------------------------- pluma */

  penDown(e, sp, wp) {
    const layer = this.ensureDrawableLayer();
    if (!layer) return;
    const { point, snap } = this.snapPoint(wp);
    // doble toque del lápiz en el mismo lugar = terminar
    const now = performance.now();
    if (this.draft && this.lastTap && now - this.lastTap.t < 380 && Math.hypot(sp[0] - this.lastTap.sp[0], sp[1] - this.lastTap.sp[1]) < 14) {
      this.lastTap = null;
      // el primer toque ya agregó el vértice; terminar
      this.finishDraft(this.tool === 'polygon');
      return;
    }
    this.lastTap = { t: now, sp };
    if (!this.draft) this.draft = { nodes: [], snaps: [], layerId: layer.id };
    const nodes = this.draft.nodes;
    if (snap?.type === 'first' && nodes.length >= 2) {
      this.finishDraft(true);
      return;
    }
    // TRACE: entre el vértice anterior y este, seguir la geometría existente
    if (this.settings.trace && snap?.segment != null && nodes.length) {
      const prevSnap = this.draft.snaps[this.draft.snaps.length - 1];
      if (prevSnap?.segment != null) {
        const path = tracePath(this.snapIndex(), this.graph(), prevSnap, snap);
        if (path && path.length > 2) {
          for (const q of path.slice(1, -1)) {
            nodes.push(makeNode(q[0], q[1]));
            this.draft.snaps.push(null);
          }
        }
      }
    }
    nodes.push(makeNode(point[0], point[1]));
    this.draft.snaps.push(snap && snap.type !== 'first' ? snap : null);
    this.drag = { mode: 'pen-handle', sp0: sp };
    this.hover = { sp, wp: point, snap };
    this.changed();
  }

  updateHover(sp) {
    const wp = this.view.toWorld(...sp);
    const { point, snap } = this.snapPoint(wp);
    let tracePreview = null;
    if (this.settings.trace && this.draft && snap?.segment != null && this.draft.snaps.length) {
      const prev = this.draft.snaps[this.draft.snaps.length - 1];
      if (prev?.segment != null) tracePreview = tracePath(this.snapIndex(), this.graph(), prev, snap, { maxVisited: 40000 });
    }
    this.hover = { sp, wp: point, snap, tracePreview };
    this.changed();
  }

  finishDraft(close) {
    const d = this.draft;
    this.draft = null;
    this.hover = null;
    this.lastTap = null;
    if (!d) return;
    // un doble toque deja dos vértices iguales al final
    const nodes = d.nodes.filter((n, i) => i === 0 || Math.hypot(n.x - d.nodes[i - 1].x, n.y - d.nodes[i - 1].y) > this.view.mpp * 0.5);
    const closed = close || this.tool === 'polygon';
    if (nodes.length < (closed ? 3 : 2)) {
      this.changed();
      return;
    }
    const st = this.getCurrentStyle();
    const style = { ...st };
    if (!closed) style.fillOpen = false;
    const shape = makePath(nodes, { closed, style });
    this.history.commit(addShapes(this.doc, d.layerId, [shape]));
    this.snapDirty = true;
    this.setSelection([shape.id]);
  }

  cancelDraft() {
    this.draft = null;
    this.hover = null;
    this.changed();
  }

  undoDraftNode() {
    if (!this.draft) return false;
    this.draft.nodes.pop();
    this.draft.snaps.pop();
    if (!this.draft.nodes.length) this.draft = null;
    this.changed();
    return true;
  }

  /* --------------------------------------------------------- lápiz y formas */

  finishPencil(d) {
    this.preview = null;
    const layer = this.ensureDrawableLayer();
    if (!layer || d.pts.length < 2) return this.changed();
    let pts = simplify(d.pts, this.view.mpp * (this.settings.pencilTolerance ?? 1.5));
    // terminar cerca del inicio = forma cerrada
    const first = pts[0];
    const last = pts[pts.length - 1];
    const closed = pts.length > 3 && Math.hypot(first.x - last.x, first.y - last.y) < SNAP_PX * this.view.mpp;
    if (closed) pts = pts.slice(0, -1);
    else if (this.settings.snap) {
      // engancha el final a la geometría existente
      const { point } = this.snapPoint([last.x, last.y]);
      pts[pts.length - 1] = { x: point[0], y: point[1] };
    }
    const smooth = this.settings.smoothing ?? 0.25;
    const nodes = polylineToNodes(pts, smooth, closed);
    const shape = makePath(nodes, { closed, style: { ...this.getCurrentStyle() } });
    shape.name = closed ? 'Polígono libre' : 'Trazo libre';
    this.history.commit(addShapes(this.doc, layer.id, [shape]));
    this.snapDirty = true;
    this.setSelection([shape.id]);
  }

  finishCreate(d, pv) {
    this.preview = null;
    const layer = this.ensureDrawableLayer();
    if (!layer || !pv) return this.changed();
    let { start, end } = pv;
    if (pv.fromCenter && (this.tool === 'rect' || this.tool === 'ellipse')) start = [2 * start[0] - end[0], 2 * start[1] - end[1]];
    const w = Math.abs(end[0] - start[0]);
    const h = Math.abs(end[1] - start[1]);
    const minM = 3 * this.view.mpp;
    const st = { ...this.getCurrentStyle() };
    let shape = null;
    if (this.tool === 'rect' && w > minM && h > minM) shape = makeRectPath(start[0], start[1], end[0], end[1], st);
    else if (this.tool === 'ellipse' && w > minM && h > minM)
      shape = makeEllipsePath((start[0] + end[0]) / 2, (start[1] + end[1]) / 2, w / 2, h / 2, st);
    else if ((this.tool === 'line' || this.tool === 'arrow') && Math.hypot(w, h) > minM) {
      shape = makePath([makeNode(start[0], start[1]), makeNode(end[0], end[1])], {
        style: { ...st, markerEnd: this.tool === 'arrow' ? (st.markerEnd !== 'none' ? st.markerEnd : 'arrow') : st.markerEnd },
      });
      shape.name = this.tool === 'arrow' ? 'Flecha' : 'Segmento';
    }
    if (shape) {
      this.history.commit(addShapes(this.doc, layer.id, [shape]));
      this.snapDirty = true;
      this.setSelection([shape.id]);
    } else this.changed();
  }

  /** Tamaño de un texto nuevo: el de dibujo, pero nunca menor que lo legible a la escala de la vista. */
  newTextSize() {
    const base = this.getCurrentStyle().fontSize || 10;
    const minPt = MIN_TEXT_PX / this.units().ptToPx;
    return base >= minPt ? base : niceFontSize(minPt);
  }

  textAt(sp, wp) {
    const l = this.ensureDrawableLayer();
    if (!l) return;
    const hit = pickShape(this.doc, sp, this.view, this.units(), 6);
    if (hit && hit.shape.type === 'text') {
      this.setSelection([hit.shape.id]);
      this.onEditText(hit.shape);
      return;
    }
    const st = this.getCurrentStyle();
    const t = makeText(wp[0], wp[1], '', { ...st, fill: st.stroke !== 'none' ? st.stroke : '#111827', fillOpacity: 1, fillType: 'solid', stroke: 'none' }, this.newTextSize());
    t.text = '';
    this.history.commit(addShapes(this.doc, l.id, [t]));
    this.setSelection([t.id]);
    this.onEditText(t, true);
  }

  scissorsAt(sp, wp) {
    const hit = pickShape(this.doc, sp, this.view, this.units(), 10);
    if (!hit || hit.shape.type !== 'path') return this.onMessage('Toca una línea o polígono para cortarlo');
    const near = nearestOnPath(hit.shape.nodes, hit.shape.closed, { x: wp[0], y: wp[1] });
    if (!near || near.dist / this.view.mpp > 12) return;
    // cerca de un vértice: cortar en el vértice
    let { segIndex, t } = near;
    const a = hit.shape.nodes[segIndex];
    const b = hit.shape.nodes[(segIndex + 1) % hit.shape.nodes.length];
    if (Math.hypot(a.x - near.point.x, a.y - near.point.y) / this.view.mpp < 8) t = 0;
    else if (Math.hypot(b.x - near.point.x, b.y - near.point.y) / this.view.mpp < 8) t = 1;
    const r = splitPath(this.doc, hit.shape.id, segIndex, t);
    if (r.error) return this.onMessage(r.error);
    this.history.commit(r.doc);
    this.snapDirty = true;
    this.setSelection(r.ids);
    this.onMessage(hit.shape.closed ? 'Polígono abierto en el punto' : 'Trazo cortado en dos');
  }

  applyEyedropper(shape) {
    const style = shape.style ? { ...shape.style } : null;
    if (!style) return;
    this.onMessage('Estilo copiado');
    this.pickedStyle = style;
    if (this.selection.size) {
      const ids = this.selectedShapes().filter((s) => s.id !== shape.id && s.type !== 'group').map((s) => s.id);
      if (ids.length) this.history.commit(mapShapes(this.doc, ids, (s) => ({ ...s, style: { ...s.style, ...style } })));
    }
    this.onStylePicked?.(style);
    this.changed();
  }

  onDoubleClick(e) {
    const sp = this.screenPoint(e);
    if (this.draft && (this.tool === 'pen' || this.tool === 'polygon')) return; // lo resuelve penDown
    const hit = pickShape(this.doc, sp, this.view, this.units(), 8);
    if (!hit) return;
    if (hit.shape.type === 'text') {
      this.setSelection([hit.shape.id]);
      this.onEditText(hit.shape);
      return;
    }
    if (this.tool === 'select' && hit.shape.type === 'path') {
      this.setSelection([hit.shape.id]);
      this.setTool('node');
      return;
    }
    if (this.tool === 'node' && hit.shape.type === 'path') {
      const wp = this.view.toWorld(...sp);
      const near = nearestOnPath(hit.shape.nodes, hit.shape.closed, { x: wp[0], y: wp[1] });
      if (near && near.dist / this.view.mpp < 10) this.insertNode(hit.shape.id, -1, near.segIndex, near.t);
    }
  }

  /* --------------------------------------------------------- comandos */

  deleteSelection() {
    if (this.tool === 'node' && this.activeNode) return this.deleteActiveNode();
    if (!this.selection.size) return false;
    const ids = this.selectedShapes()
      .filter((s) => !s.locked && !layerOfShape(this.doc, s.id)?.locked)
      .map((s) => s.id);
    this.history.commit(removeShapes(this.doc, ids));
    this.setSelection([]);
    this.snapDirty = true;
    return true;
  }

  duplicate(offsetPx = 10, silentPreview = false) {
    const shapes = this.selectedShapes();
    if (!shapes.length) return;
    const off = offsetPx * this.view.mpp;
    const copies = shapes.map((s) => {
      const c = JSON.parse(JSON.stringify(s));
      const reid = (x) => {
        x.id = `${x.id}_${Math.random().toString(36).slice(2, 6)}`;
        if (x.type === 'group') x.children.forEach(reid);
      };
      reid(c);
      return off ? translateShape(c, off, -off) : c;
    });
    // las copias quedan sobre sus originales, en la misma capa
    let doc = this.doc;
    for (const c of copies) {
      const orig = shapes[copies.indexOf(c)];
      const layer = layerOfShape(doc, orig.id);
      doc = {
        ...doc,
        layers: doc.layers.map((l) => {
          if (l.id !== layer.id) return l;
          const items = l.items.slice();
          items.splice(items.findIndex((x) => x.id === orig.id) + 1, 0, c);
          return { ...l, items };
        }),
      };
    }
    if (silentPreview) this.history.preview(doc);
    else this.history.commit(doc);
    this.selection = new Set(copies.map((c) => c.id));
    this.snapDirty = true;
    this.changed();
  }

  nudge(dxPx, dyPx) {
    const ids = this.selectedShapes()
      .filter((s) => !s.locked)
      .map((s) => s.id);
    if (!ids.length) return;
    this.history.commit(mapShapes(this.doc, ids, (s) => translateShape(s, dxPx * this.view.mpp, -dyPx * this.view.mpp)));
    this.snapDirty = true;
  }

  selectAll() {
    const l = this.activeLayer();
    const items = l ? l.items : [];
    this.setSelection(items.filter((s) => s.visible !== false && !s.locked).map((s) => s.id));
  }

  onKey(e) {
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    const mod = e.ctrlKey || e.metaKey;
    if (e.code === 'Space') {
      this.spaceDown = true;
      e.preventDefault();
      return;
    }
    if (e.key === 'Escape') {
      if (this.draft) this.cancelDraft();
      else if (this.tool !== 'select') this.setTool('select');
      else this.setSelection([]);
      return;
    }
    if (e.key === 'Enter' && this.draft) {
      e.preventDefault();
      this.finishDraft(this.tool === 'polygon');
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && !mod) {
      if (this.draft && e.key === 'Backspace') {
        this.undoDraftNode();
      } else this.deleteSelection();
      e.preventDefault();
      return;
    }
    if (e.key.startsWith('Arrow') && !mod) {
      const k = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -k : e.key === 'ArrowRight' ? k : 0;
      const dy = e.key === 'ArrowUp' ? -k : e.key === 'ArrowDown' ? k : 0;
      this.nudge(dx, dy);
      e.preventDefault();
      return;
    }
    if (mod || e.altKey) {
      this.onCommandKey?.(e);
      return;
    }
    if (this.onPlainKey?.(e)) return;
    const key = e.key.toLowerCase();
    // Mayús+C: convertir punto de ancla (esquina ↔ curva), como en Illustrator
    if (key === 'c' && e.shiftKey) {
      const a = this.activeNode;
      if (a) this.toggleSmooth(a.id, a.ring, a.index);
      else this.onMessage('Elige un nodo con la herramienta Nodos (A)');
      e.preventDefault();
      return;
    }
    if (e.shiftKey) return;
    if (key === 'k') {
      this.settings.trace = !this.settings.trace;
      this.onMessage(`Trace ${this.settings.trace ? 'activado' : 'desactivado'}`);
      this.changed();
      return;
    }
    if (key === 's' && !e.shiftKey) {
      this.settings.snap = !this.settings.snap;
      this.onMessage(`Snapping ${this.settings.snap ? 'activado' : 'desactivado'}`);
      this.changed();
      return;
    }
    for (const [id, def] of Object.entries(TOOLS)) {
      if (def.key === key) {
        this.setTool(id);
        e.preventDefault();
        return;
      }
    }
  }

  /* --------------------------------------------------------- overlay */

  /** SVG de la capa de interacción (en pantalla). */
  overlay() {
    const P = (x, y) => this.view.toScreen(x, y);
    const out = [];
    const r2 = (v) => Math.round(v * 10) / 10;
    const units = this.units();

    // contorno de lo seleccionado
    for (const s of this.selectedShapes()) {
      if (s.type === 'path') {
        out.push(`<path d="${shapeD(s, P)}" fill="none" stroke="#0ea5e9" stroke-width="1" vector-effect="non-scaling-stroke"/>`);
      }
    }
    const box = this.selectionBox();
    if (box && this.tool === 'select') {
      const [x0, y0] = P(box.x, box.y + box.h);
      const [x1, y1] = P(box.x + box.w, box.y);
      out.push(`<rect x="${r2(x0)}" y="${r2(y0)}" width="${r2(x1 - x0)}" height="${r2(y1 - y0)}" fill="none" stroke="#0ea5e9" stroke-dasharray="4 3"/>`);
      const pos = handlePositions(x0, y0, x1, y1);
      for (const k of HANDLE_KEYS) {
        out.push(`<rect class="h" x="${r2(pos[k][0] - 5)}" y="${r2(pos[k][1] - 5)}" width="10" height="10" fill="#fff" stroke="#0ea5e9" stroke-width="1.5"/>`);
      }
      const cx = (x0 + x1) / 2;
      out.push(`<line x1="${r2(cx)}" y1="${r2(y0)}" x2="${r2(cx)}" y2="${r2(y0 - 26)}" stroke="#0ea5e9"/>`);
      out.push(`<circle cx="${r2(cx)}" cy="${r2(y0 - 26)}" r="6" fill="#fff" stroke="#0ea5e9" stroke-width="1.5"/>`);
    }

    // nodos
    const ns = this.tool === 'node' ? this.nodeTarget() : null;
    if (ns) {
      const rings = [-1, ...(ns.holes || []).map((_, i) => i)];
      for (const ring of rings) {
        const nodes = this.ringNodes(ns, ring);
        nodes.forEach((n, i) => {
          const active = this.activeNode && this.activeNode.id === ns.id && this.activeNode.ring === ring && this.activeNode.index === i;
          const [x, y] = P(n.x, n.y);
          for (const h of ['hIn', 'hOut']) {
            if (!n[h]) continue;
            const [hx, hy] = P(n[h].x, n[h].y);
            out.push(`<line x1="${r2(x)}" y1="${r2(y)}" x2="${r2(hx)}" y2="${r2(hy)}" stroke="#f59e0b"/>`);
            out.push(`<circle cx="${r2(hx)}" cy="${r2(hy)}" r="4.5" fill="#f59e0b" stroke="#fff"/>`);
          }
          out.push(
            `<rect x="${r2(x - 5)}" y="${r2(y - 5)}" width="10" height="10" fill="${active ? '#0ea5e9' : '#fff'}" stroke="#0ea5e9" stroke-width="1.5"/>`,
          );
        });
      }
    }

    // borrador de pluma/polígono
    if (this.draft) {
      const nodes = this.draft.nodes;
      let d = nodesD(nodes, false, P);
      const color = esc(this.getCurrentStyle().stroke !== 'none' ? this.getCurrentStyle().stroke : '#0ea5e9');
      const w = Math.max(1, this.getCurrentStyle().strokeWidth * units.mmToPx);
      if (this.hover?.tracePreview) {
        out.push(
          `<path d="M${this.hover.tracePreview.map((p) => P(p[0], p[1]).map(r2).join(' ')).join('L')}" fill="none" stroke="#22c55e" stroke-width="${r2(
            w + 3,
          )}" stroke-opacity="0.5" stroke-linejoin="round"/>`,
        );
      } else if (this.hover) {
        const last = nodes[nodes.length - 1];
        const [lx, ly] = P(last.x, last.y);
        const [hx, hy] = P(this.hover.wp[0], this.hover.wp[1]);
        out.push(`<line x1="${r2(lx)}" y1="${r2(ly)}" x2="${r2(hx)}" y2="${r2(hy)}" stroke="${color}" stroke-width="${r2(w)}" stroke-dasharray="5 4" opacity="0.7"/>`);
        if (this.tool === 'polygon' && nodes.length > 1) {
          const [fx, fy] = P(nodes[0].x, nodes[0].y);
          out.push(`<line x1="${r2(hx)}" y1="${r2(hy)}" x2="${r2(fx)}" y2="${r2(fy)}" stroke="${color}" stroke-width="1" stroke-dasharray="2 4" opacity="0.6"/>`);
        }
      }
      out.push(`<path d="${d}" fill="none" stroke="${color}" stroke-width="${r2(w)}" stroke-linejoin="round" stroke-linecap="round"/>`);
      nodes.forEach((n, i) => {
        const [x, y] = P(n.x, n.y);
        out.push(`<circle cx="${r2(x)}" cy="${r2(y)}" r="${i === 0 ? 6 : 4}" fill="${i === 0 ? '#22c55e' : '#fff'}" stroke="#0f172a"/>`);
      });
    }

    // vista previa de creación
    const pv = this.preview;
    if (pv) {
      if (pv.kind === 'marquee') {
        const [x0, y0] = P(pv.start[0], pv.start[1]);
        const [x1, y1] = P(pv.end[0], pv.end[1]);
        out.push(
          `<rect x="${r2(Math.min(x0, x1))}" y="${r2(Math.min(y0, y1))}" width="${r2(Math.abs(x1 - x0))}" height="${r2(Math.abs(y1 - y0))}" fill="rgba(14,165,233,0.08)" stroke="#0ea5e9" stroke-dasharray="4 3"/>`,
        );
      } else if (pv.kind === 'lasso' || pv.kind === 'pencil') {
        const pts = pv.kind === 'lasso' ? pv.pts : pv.pts.map((p) => [p.x, p.y]);
        const color = pv.kind === 'lasso' ? '#0ea5e9' : esc(this.getCurrentStyle().stroke);
        const w = pv.kind === 'lasso' ? 1.2 : Math.max(1, this.getCurrentStyle().strokeWidth * units.mmToPx);
        out.push(
          `<path d="M${pts.map((p) => P(p[0], p[1]).map(r2).join(' ')).join('L')}" fill="${pv.kind === 'lasso' ? 'rgba(14,165,233,0.08)' : 'none'}" stroke="${color}" stroke-width="${r2(
            w,
          )}" stroke-linejoin="round" stroke-linecap="round"${pv.kind === 'lasso' ? ' stroke-dasharray="4 3"' : ''}/>`,
        );
      } else if (pv.start) {
        let s = pv.start;
        const en = pv.end;
        if (pv.fromCenter) s = [2 * s[0] - en[0], 2 * s[1] - en[1]];
        const [x0, y0] = P(s[0], s[1]);
        const [x1, y1] = P(en[0], en[1]);
        const st = this.getCurrentStyle();
        const color = esc(st.stroke !== 'none' ? st.stroke : '#0ea5e9');
        const w = r2(Math.max(1, st.strokeWidth * units.mmToPx));
        if (pv.kind === 'rect') out.push(`<rect x="${r2(Math.min(x0, x1))}" y="${r2(Math.min(y0, y1))}" width="${r2(Math.abs(x1 - x0))}" height="${r2(Math.abs(y1 - y0))}" fill="none" stroke="${color}" stroke-width="${w}"/>`);
        if (pv.kind === 'ellipse') out.push(`<ellipse cx="${r2((x0 + x1) / 2)}" cy="${r2((y0 + y1) / 2)}" rx="${r2(Math.abs(x1 - x0) / 2)}" ry="${r2(Math.abs(y1 - y0) / 2)}" fill="none" stroke="${color}" stroke-width="${w}"/>`);
        if (pv.kind === 'line' || pv.kind === 'arrow') out.push(`<line x1="${r2(x0)}" y1="${r2(y0)}" x2="${r2(x1)}" y2="${r2(y1)}" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`);
      }
    }

    // cursor de snapping
    if (this.hover?.snap && (DRAW_TOOLS.has(this.tool) || this.tool === 'node')) {
      const [x, y] = P(this.hover.wp[0], this.hover.wp[1]);
      const t = this.hover.snap.type;
      if (t === 'vertex' || t === 'first') out.push(`<rect x="${r2(x - 6)}" y="${r2(y - 6)}" width="12" height="12" fill="none" stroke="#db2777" stroke-width="2"/>`);
      else out.push(`<path d="M${r2(x - 6)} ${r2(y - 6)}L${r2(x + 6)} ${r2(y + 6)}M${r2(x - 6)} ${r2(y + 6)}L${r2(x + 6)} ${r2(y - 6)}" stroke="#db2777" stroke-width="2"/>`);
    }
    return out.join('');
  }
}

/* ------------------------------------------------------------------ util */

function mid(a, b) {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

function rectOf(a, b) {
  return { x: Math.min(a[0], b[0]), y: Math.min(a[1], b[1]), w: Math.abs(b[0] - a[0]), h: Math.abs(b[1] - a[1]) };
}

function handlePositions(x0, y0, x1, y1) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return { nw: [x0, y0], n: [cx, y0], ne: [x1, y0], e: [x1, cy], se: [x1, y1], s: [cx, y1], sw: [x0, y1], w: [x0, cy] };
}

function constrain(start, end, tool) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  if (tool === 'line' || tool === 'arrow') {
    const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const len = Math.hypot(dx, dy);
    return [start[0] + Math.cos(ang) * len, start[1] + Math.sin(ang) * len];
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return [start[0] + Math.sign(dx || 1) * s, start[1] + Math.sign(dy || 1) * s];
}

export { shapeDistance };
