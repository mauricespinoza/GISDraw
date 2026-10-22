/**
 * El editor: herramientas, entrada (lápiz, dedo, ratón y teclado), snapping,
 * trace y la capa de interacción (selección, manejadores, nodos, borradores).
 *
 * REPARTO DE LA ENTRADA — lo que hace usable un dibujo en tablet:
 *  - Apple Pencil (`pointerType: pen`): SIEMPRE usa la herramienta activa. Su
 *    hover (iPad recientes) mueve el cursor de snapping y la línea elástica
 *    sin tocar la pantalla.
 *  - Dedo: un dedo desplaza, dos dedos hacen zoom y desplazan. Un toque corto
 *    con el dedo selecciona; fuera de lo seleccionado, además, anula la
 *    herramienta activa y vuelve a Selección. Así la palma o un dedo
 *    apoyado nunca dibujan por error. Para pantallas táctiles sin lápiz hay un
 *    ajuste "el dedo dibuja".
 *  - Ratón: botón izquierdo = herramienta, central o barra espaciadora =
 *    desplazar, derecho = terminar el trazo en curso (como en QGIS) o, sin
 *    trazo en curso, menú contextual; rueda = zoom; en trackpad, dos dedos
 *    desplazan y el pellizco hace zoom.
 *  - Mantener el dedo (o el lápiz con selección/nodos) quieto ~0,5 s abre el
 *    mismo menú contextual que el botón derecho.
 */

import { imageRect } from './raster/rasterView.js';
import { addShapes, allTopShapes, findTopShape, inLockedLayer, layerOfShape, mapShapes, removeShapes, replaceShapes } from './doc.js';
import { frozenPoints, setNodesFrozen, splitPath } from './ops.js';
import { layoutText, textCorners } from './textLayout.js';
import { pickShape, shapesInBox, shapesInLasso, shapeDistance, flatRings } from './hit.js';
import { SnapIndex, buildGraph, smartTrace, pointKey } from './snapping.js';
import { smoothAlong } from './smoothTool.js';
import { buildTopology, smoothTopology } from './smoothTopo.js';
import { applyDeform, frozenTest, prepareDeform, prepareDrag } from './deform.js';
import { nodeInto } from './tidy.js';
import { defaultStyle, nodesD, shapeD, esc, textMeasurer } from './style.js';
import { paperUnits } from './view.js';
import {
  makeEllipsePath,
  makeNode,
  makePath,
  makePoint,
  makeRectPath,
  makeText,
  nearestOnPath,
  rotateShape,
  scaleShape,
  shapeBBox,
  simplify,
  splitNodes,
  translateShape,
  unionBBox,
  cloneNode,
  flattenNodes,
  DEFAULT_SMOOTH,
  freehandToNodes,
  nodesSignature,
} from './vector.js';

export const TOOLS = {
  select: { label: 'Selección', key: 'v' },
  node: { label: 'Nodos', key: 'a' },
  drag: { label: 'Drag (nodo con arrastre proporcional)', key: 'j' },
  split: { label: 'Dividir / Split (tocar una línea que cruza, o arrastrar un corte)', key: 'u' },
  reshape: { label: 'Reshape (redibujar el contorno con una línea)', key: 'r' },
  lasso: { label: 'Lazo', key: 'q' },
  pen: { label: 'Pluma / línea', key: 'p' },
  polygon: { label: 'Polígono', key: 'y' },
  pencil: { label: 'Lápiz (trazo libre)', key: 'b' },
  smooth: { label: 'Suavizar (pincel)', key: 'n' },
  deform: { label: 'Deform (empujar nodos en gradiente)', key: 'g' },
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
const SNAP_PX_PEN = 3; // el lápiz es preciso: casi sin imán, el trazo cae donde se apoya la punta
/** Tolerancia de simplificación (px) del pincel de Suavizar para una intensidad. */
const smoothTolPx = (level) => 0.3 + (Math.max(0, Math.min(100, level)) / 100) * 2.5;
const GUIDE_PX = 6; // snap ligero a guías de alineación
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
    this.imageSel = null; // id de la capa de imagen seleccionada (mover/escalar), solo si su capa está desbloqueada
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

  /**
   * Dividir (Split) o hacer un hueco (Hole) dibujando una forma nueva: la
   * línea o el contorno que se dibuje a continuación no queda en el dibujo,
   * solo corta a los polígonos `ids`. Enter, doble toque o «Terminar» lo ejecuta;
   * Esc lo cancela.
   */
  beginCut(kind, ids) {
    this.setTool(kind === 'split' ? 'pen' : 'polygon');
    this.cutMode = { kind, ids: [...ids], tool: this.tool };
    this.onMessage(
      kind === 'split'
        ? 'Dividir: dibuja la línea que cruza el polígono de borde a borde (clic en cada vértice; Enter o doble clic para terminar; Esc cancela)'
        : 'Hueco: dibuja el contorno del hueco (clic en cada vértice; Enter o doble clic para cerrar; Esc cancela)',
      9000,
    );
  }

  setTool(tool) {
    if (!TOOLS[tool]) return;
    if (this.cutMode && tool !== this.cutMode.tool) {
      this.cutMode = null;
      this.draft = null;
      this.hover = null;
    }
    if (this.draft) this.finishDraft(false);
    this.tool = tool;
    this.preview = null;
    this.guides = null;
    this.activeNode = null;
    this.host.dataset.tool = tool;
    if (tool === 'split') this.onMessage('Dividir: con una línea o polígono seleccionado, toca otra línea que lo cruce, o arrastra el corte (se ve la línea auxiliar). Sin selección corta lo que cruces', 7000);
    if (tool === 'reshape') this.onMessage('Reshape: con el polígono (o la línea) seleccionado, arrastra una línea que salga del contorno y vuelva a entrar (crece) o lo atraviese (se recorta el lado menor; con Alt, el mayor)', 8000);
    this.changed();
  }

  /** La selección nunca incluye objetos de capas bloqueadas: no se mueven, ni se restilan, ni se borran. */
  setSelection(ids) {
    const all = [...ids];
    const free = all.filter((id) => !inLockedLayer(this.doc, id));
    if (free.length < all.length) {
      const name = layerOfShape(this.doc, all.find((id) => inLockedLayer(this.doc, id)))?.name;
      this.onMessage(`La capa «${name}» está bloqueada: sus objetos no se pueden seleccionar ni editar`);
    }
    this.selection = new Set(free);
    this.imageSel = null;
    this.activeNode = null;
    this.changed();
  }

  changed() {
    this.onChange(this);
  }

  /** Tras deshacer o cambiar el documento: limpiar ids que ya no existen. */
  pruneSelection() {
    const alive = new Set(allTopShapes(this.doc, { visibleOnly: false, unlockedOnly: false }).filter((x) => !x.layer.locked).map((x) => x.shape.id));
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
    // vértices a menos de ~0,4 px se funden: los trazos digitalizados a ojo quedan conectados
    if (!this._graph) this._graph = buildGraph(this.snapIndex(), { tol: this.view.mpp * 0.4 });
    return this._graph;
  }

  /** Punto de mundo con snapping (a vértices y segmentos, y al propio borrador). */
  snapTolPx() {
    return this.inputType === 'pen' ? SNAP_PX_PEN : SNAP_PX;
  }

  snapPoint(wp, { force = false } = {}) {
    if (!this.settings.snap && !force) return { point: this.guidePoint(wp), snap: null };
    const tol = this.snapTolPx() * this.view.mpp;
    // primero el borrador: cerrar el polígono / unir al inicio
    if (this.draft?.nodes.length) {
      const first = this.draft.nodes[0];
      if (Math.hypot(first.x - wp[0], first.y - wp[1]) < tol) return { point: [first.x, first.y], snap: { type: 'first' } };
    }
    const s = this.snapIndex().query(wp, tol);
    if (s) {
      this.guides = null;
      return { point: s.point, snap: s };
    }
    return { point: this.guidePoint(wp), snap: null };
  }

  /* ------------------------------------------------- guías de alineación */

  /**
   * Vértices de todo el dibujo (aunque estén lejos) ordenados por x y por y,
   * para alinear lo que se dibuja con ellos: mismo nivel (y) o misma vertical
   * (x). Se rehace solo cuando cambia el documento (en un arrastre, el de antes
   * de empezar, que no incluye lo que se mueve).
   */
  alignIndex() {
    const doc = this.history.anchor || this.doc;
    if (this._align && this._alignDoc === doc) return this._align;
    const xs = [];
    const ys = [];
    const add = (n) => {
      xs.push([n.x, n.y]);
      ys.push([n.y, n.x]);
    };
    const visit = (sh) => {
      if (sh.visible === false) return;
      if (sh.type === 'group') sh.children.forEach(visit);
      else if (sh.type === 'path') {
        sh.nodes.forEach(add);
        for (const h of sh.holes || []) h.forEach(add);
      } else if (sh.type === 'point' || sh.type === 'text') add(sh);
    };
    for (const l of doc.layers) if (l.kind === 'vector' && l.visible) l.items.forEach(visit);
    xs.sort((a, b) => a[0] - b[0]);
    ys.sort((a, b) => a[0] - b[0]);
    this._align = { xs, ys };
    this._alignDoc = doc;
    return this._align;
  }

  /**
   * Alineación con otros vértices: si el punto queda a menos de GUIDE_PX de la
   * x o la y de alguno (también del borrador), se lleva a ese nivel y se
   * dibuja la guía. Es un snap ligero: no engancha al vértice, solo al eje.
   * `exclude`: puntos que no cuentan (lo que se está moviendo).
   */
  guidePoint(wp, { exclude = [] } = {}) {
    this.guides = null;
    if (this.settings.guides === false || this.inputType === 'pen') return wp; // con lápiz, sin imán a guías
    const tol = GUIDE_PX * this.view.mpp;
    const { xs, ys } = this.alignIndex();
    const extra = (this.draft?.nodes || []).map((n) => [n.x, n.y]);
    const skip = (x, y) => exclude.some((q) => Math.abs(q[0] - x) < 1e-6 && Math.abs(q[1] - y) < 1e-6);
    // el candidato más cercano en el eje (`k`) y, de los empatados en ese eje, el más próximo en el otro
    const best = (arr, k, pts) => {
      let lo = 0;
      let hi = arr.length;
      const target = wp[k];
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid][0] < target - tol) lo = mid + 1;
        else hi = mid;
      }
      let out = null;
      const consider = (v, other) => {
        const x = k === 0 ? v : other;
        const y = k === 0 ? other : v;
        if (skip(x, y)) return;
        const d = Math.abs(v - target);
        if (d > tol) return;
        const along = Math.abs(other - wp[1 - k]);
        if (!out || d < out.d - 1e-9 || (Math.abs(d - out.d) < 1e-9 && along < out.along)) out = { v, other, d, along };
      };
      for (let i = lo; i < arr.length && arr[i][0] <= target + tol; i++) consider(arr[i][0], arr[i][1]);
      for (const p of pts) consider(p[k], p[1 - k]);
      return out;
    };
    const gx = best(xs, 0, extra);
    const gy = best(ys, 1, extra);
    if (!gx && !gy) return wp;
    const point = [gx ? gx.v : wp[0], gy ? gy.v : wp[1]];
    this.guides = [];
    if (gx) this.guides.push({ axis: 'x', value: gx.v, from: [gx.v, gx.other], to: point });
    if (gy) this.guides.push({ axis: 'y', value: gy.v, from: [gy.other, gy.v], to: point });
    return point;
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
        this.guides = null;
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
    // toque de varios dedos (dos = deshacer, tres = rehacer): se sigue desde que baja el primer dedo
    if (e.pointerType === 'touch') {
      const n = [...this.pointers.values()].filter((q) => q.type === 'touch').length;
      if (!this.tapSession) this.tapSession = { t0: performance.now(), max: n, moved: false };
      else this.tapSession.max = Math.max(this.tapSession.max, n);
    }
    if (e.pointerType === 'pen') this.penSeen = true;
    this.inputType = e.pointerType;
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
    if (e.pointerType) this.inputType = e.pointerType;
    const sp = this.screenPoint(e);
    const p = this.pointers.get(e.pointerId);
    if (p) p.sp = sp;
    if (p && this.tapSession && Math.hypot(sp[0] - p.start[0], sp[1] - p.start[1]) > 14) this.tapSession.moved = true;
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
      if (DRAW_TOOLS.has(this.tool) || this.tool === 'node') this.updateHover(sp, e.altKey);
      else if (this.tool === 'smooth' || this.tool === 'deform') {
        this.hover = { sp, wp: this.view.toWorld(...sp), brush: true };
        this.changed();
      }
      return;
    }
    // trazo libre: el navegador junta varias muestras del lápiz por cuadro; usarlas todas
    // da un trazo fiel aunque se dibuje rápido
    if (d.mode === 'pencil' && e.getCoalescedEvents) {
      const evs = e.getCoalescedEvents();
      for (let i = 0; i < evs.length - 1; i++) this.toolMove(evs[i], this.screenPoint(evs[i]));
    }
    this.toolMove(e, sp);
  }

  onUp(e, cancelled = false) {
    if (this.lp?.id === e.pointerId) this.clearLongPress();
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    this.endTapSession(cancelled);
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

  /**
   * Gestos de toque de varios dedos, como en las tablets de dibujo: un toque
   * corto de DOS dedos, dos veces seguidas, deshace; de TRES dedos, dos veces,
   * rehace. (Con `gestureTaps: 'single'` basta un toque.) No cuenta si los
   * dedos se movieron (eso es desplazar o hacer zoom).
   */
  endTapSession(cancelled) {
    const ts = this.tapSession;
    if (!ts || [...this.pointers.values()].some((q) => q.type === 'touch')) return;
    this.tapSession = null;
    const now = performance.now();
    if (cancelled || ts.moved || ts.max < 2 || ts.max > 3 || now - ts.t0 > 380) return;
    const need = this.settings.gestureTaps === 'single' ? 1 : 2;
    const last = this.lastMultiTap;
    if (need > 1 && !(last && last.n === ts.max && now - last.t < 500)) {
      this.lastMultiTap = { n: ts.max, t: now };
      return;
    }
    this.lastMultiTap = null;
    if (ts.max === 2) {
      if (this.history.undo()) this.onMessage('Deshacer', 900);
    } else if (this.history.redo()) this.onMessage('Rehacer', 900);
    this.changed();
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
    }
    // con Drag, Deform o varias formas en Nodos: el vértice de lo seleccionado bajo el puntero
    if (!node && ['node', 'drag', 'deform'].includes(this.tool)) {
      const sn = this.selectedNodeAt(sp);
      if (sn) node = { id: sn.id, ring: sn.ring, index: sn.index };
    }
    if (node) {
      this.activeNode = node;
      this.changed();
    }
    if (!node && hit && !this.selection.has(hit.shape.id)) this.setSelection([hit.shape.id]);
    this.onContextMenu(sp, { hit: hit?.shape || null, node, wp: this.view.toWorld(...sp) });
  }

  fingerTap(sp) {
    // Dividir / Reshape: el dedo corta con un toque igual que el lápiz o el ratón
    if (this.tool === 'split' || this.tool === 'reshape') {
      const hit = pickShape(this.doc, sp, this.view, this.units(), 14);
      this.onCutTouch?.({ kind: this.tool, hit: hit?.shape || null, shift: this.addMode });
      return;
    }
    // con el dedo, un toque mientras se dibuja con el lápiz no hace nada:
    // evita vértices fantasma al apoyar la mano
    if (this.draft) return;
    const hit = pickShape(this.doc, sp, this.view, this.units(), 14);
    if (this.tool === 'eyedropper' && hit) return this.applyEyedropper(hit.shape, sp);
    // tocar con el dedo fuera de lo seleccionado anula la herramienta activa y vuelve a Selección
    if (this.tool !== 'select' && !(hit && this.selection.has(hit.shape.id))) this.setTool('select');
    if (hit) {
      if (this.addMode) this.toggleSel(hit.shape.id);
      else this.setSelection([hit.shape.id]);
    } else if (!this.addMode) this.setSelection([]);
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
    // herramientas con radio (Suavizar, Deform): la rueda del ratón agranda o achica el círculo;
    // Ctrl/Alt + rueda (y el pellizco del trackpad) siguen haciendo zoom, y el trackpad desplaza
    const radiusKey = this.tool === 'deform' ? 'deformRadius' : this.tool === 'smooth' ? 'smoothRadius' : null;
    if (radiusKey && !e.ctrlKey && !e.metaKey && !e.altKey && !this.isTrackpadWheel(e) && e.deltaY) {
      const [lo, hi] = radiusKey === 'deformRadius' ? [10, 300] : [6, 80];
      const cur = this.settings[radiusKey] ?? (radiusKey === 'deformRadius' ? 60 : 18);
      const v = Math.max(lo, Math.min(hi, Math.round(cur * (e.deltaY < 0 ? 1.12 : 1 / 1.12))));
      this.hover = { sp, wp: this.view.toWorld(...sp), brush: true };
      if (v !== cur) this.onRadius?.(radiusKey, v);
      this.changed();
      return;
    }
    // Rueda del ratón = zoom (el ajuste «Rueda: desplazar» la deja para mover
    // el mapa, y entonces Ctrl/Alt hacen zoom). El trackpad desplaza con dos
    // dedos y hace zoom con el pellizco (llega con Ctrl).
    const zoomy = e.ctrlKey || e.metaKey || e.altKey || (this.settings.wheelMode !== 'pan' && !this.isTrackpadWheel(e));
    if (zoomy) {
      let dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY;
      // muesca de rueda: el mismo paso de zoom con cualquier escalado de pantalla
      if (!e.ctrlKey && typeof e.wheelDeltaY === 'number' && e.wheelDeltaY && e.wheelDeltaY % 120 === 0) dy = -(e.wheelDeltaY / 120) * 100;
      const k = Math.exp(Math.max(-150, Math.min(150, dy)) * (e.ctrlKey ? 0.01 : 0.0022));
      this.view.zoomAt(k, sp[0], sp[1]);
    } else {
      this.view.panBy(-e.deltaX, -e.deltaY);
    }
  }

  /**
   * ¿Esta rueda es un trackpad? La señal fiable es `wheelDeltaY` (Chrome,
   * Edge, Safari): una muesca de rueda vale siempre un múltiplo de 120, sea
   * cual sea el escalado de pantalla de Windows. `deltaY`, en cambio, se
   * escala (con 150 % una muesca da 66,67 px, fraccionario): por eso antes la
   * rueda se tomaba por trackpad y desplazaba en vez de hacer zoom. Firefox no
   * tiene `wheelDeltaY` pero entrega la rueda en líneas (`deltaMode` 1).
   */
  isTrackpadWheel(e) {
    const now = performance.now();
    let pad;
    if (e.deltaX !== 0 && Math.abs(e.deltaX) > Math.abs(e.deltaY) / 4) pad = true;
    else if (e.deltaMode !== 0) pad = false;
    else if (typeof e.wheelDeltaY === 'number' && e.wheelDeltaY !== 0) pad = e.wheelDeltaY % 120 !== 0;
    else pad = !Number.isInteger(e.deltaY) && Math.abs(e.deltaY) < 10;
    // un gesto de trackpad dura varios eventos: no alternar a mitad de camino
    if (pad) this.lastTrackpad = now;
    return pad || now - (this.lastTrackpad || -1e9) < 250;
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
        if (hit) this.applyEyedropper(hit.shape, sp);
        return;
      }
      case 'pen':
      case 'polygon':
        return this.penDown(e, sp, wp);
      case 'smooth':
        return this.smoothDown(e, sp, wp);
      case 'deform':
        return this.deformDown(e, sp, wp);
      case 'drag':
        return this.dragDown(e, sp, wp);
      case 'split':
      case 'reshape':
        this.drag = { mode: 'cutline', kind: this.tool, pts: [wp], sp0: sp, moved: false };
        return;
      case 'pencil': {
        if (!this.ensureDrawableLayer()) return;
        const ep = this.endpointAt(sp);
        if (ep) {
          // sobre el último nodo de la línea seleccionada: el trazo la continúa
          const n = ep.atStart ? ep.shape.nodes[0] : ep.shape.nodes[ep.shape.nodes.length - 1];
          this.drag = { mode: 'pencil', pts: [{ x: n.x, y: n.y }], startSnap: null, continues: { id: ep.shape.id, atStart: ep.atStart } };
          this.preview = { kind: 'pencil', pts: this.drag.pts };
          return;
        }
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
        const snapped = ['line', 'arrow'].includes(this.tool) ? this.snapPoint(wp).point : this.guidePoint(wp);
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
      case 'imove': {
        if (Math.hypot(sp[0] - d.sp0[0], sp[1] - d.sp0[1]) > 3) d.moved = true;
        if (!d.moved) return;
        const dx = wp[0] - d.start[0];
        const dy = wp[1] - d.start[1];
        const [x0, y0, x1, y1] = d.b0;
        this.history.preview(this.withBounds(d.base, d.id, [x0 + dx, y0 + dy, x1 + dx, y1 + dy]));
        return;
      }
      case 'iscale': {
        // escalar la imagen con su esquina superior izquierda fija
        const [x0, y0, x1, y1] = d.b0;
        const k = Math.max(0.02, Math.min(100, Math.max((wp[0] - x0) / (x1 - x0), (y1 - wp[1]) / (y1 - y0))));
        this.history.preview(this.withBounds(d.base, d.id, [x0, y1 - (y1 - y0) * k, x0 + (x1 - x0) * k, y1]));
        return;
      }
      case 'tscale': {
        // estirar un texto = cambiar su tamaño de letra, con la esquina (o borde) opuesta fija
        const { frame: f, handle } = d;
        const hp = f.pos[handle];
        const opp = [2 * f.center[0] - hp[0], 2 * f.center[1] - hp[1]];
        const vx = hp[0] - opp[0];
        const vy = hp[1] - opp[1];
        const k = Math.max(0.05, Math.min(60, ((sp[0] - opp[0]) * vx + (sp[1] - opp[1]) * vy) / (vx * vx + vy * vy || 1)));
        const [ox, oy] = this.view.toWorld(opp[0], opp[1]);
        this.history.preview(replaceShapes(d.base, new Map([[d.shape.id, scaleShape(d.shape, { x: ox, y: oy }, k, k)]])));
        return;
      }
      case 'twidth': {
        // estirar un lado = ancho del cuadro de texto: el texto se reajusta a la nueva medida
        const { frame: f, handle, shape } = d;
        const a = ((shape.rotation || 0) * Math.PI) / 180;
        const ux = [Math.cos(a), Math.sin(a)];
        const dist = (sp[0] - d.start[0]) * ux[0] + (sp[1] - d.start[1]) * ux[1];
        const left = f.rot(f.m.x0, 0); // borde izquierdo de la primera línea base (px)
        let leftPx = [left[0], left[1]];
        let widthPx = f.m.width;
        if (handle === 'e') widthPx = Math.max(24, widthPx + dist);
        else {
          const w2 = Math.max(24, widthPx - dist);
          leftPx = [leftPx[0] + ux[0] * (widthPx - w2), leftPx[1] + ux[1] * (widthPx - w2)];
          widthPx = w2;
        }
        const [wx, wy] = this.view.toWorld(leftPx[0], leftPx[1]);
        this.history.preview(replaceShapes(d.base, new Map([[shape.id, { ...shape, x: wx, y: wy, boxWidth: +(widthPx / f.u.mmToPx).toFixed(2) }]])));
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
      case 'smooth':
        return this.smoothMove(sp, wp);
      case 'deform':
        return this.deformMove(sp, wp);
      case 'cutline': {
        // el trazo del corte (línea auxiliar): se empieza a ver al arrastrar más de 6 px
        if (!d.moved && Math.hypot(sp[0] - d.sp0[0], sp[1] - d.sp0[1]) < 6) return;
        d.moved = true;
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot(wp[0] - last[0], wp[1] - last[1]) >= this.view.mpp * 1.5) d.pts.push(wp);
        d.end = wp;
        this.changed();
        return;
      }
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
        let end = ['line', 'arrow'].includes(this.tool) ? this.snapPoint(wp).point : this.guidePoint(wp);
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
    this.guides = null;
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
      case 'imove':
        if (!d.moved) {
          this.history.anchor = null;
          return;
        }
        this.history.end();
        return;
      case 'iscale':
        this.history.end();
        return;
      case 'scale':
      case 'tscale':
      case 'twidth':
      case 'rotate':
      case 'node':
      case 'bezier':
        if (d.tapHit && Math.hypot(sp[0] - d.sp0[0], sp[1] - d.sp0[1]) < TAP_MOVE) {
          this.history.anchor = null;
          if (e.shiftKey || this.addMode) this.toggleSel(d.tapHit);
          else this.setSelection([d.tapHit]);
          return;
        }
        this.history.end();
        this.snapDirty = true;
        this.guides = null;
        this.changed();
        return;
      case 'smooth':
        if (d.moved) {
          this.history.end();
          this.snapDirty = true;
        } else this.history.anchor = null;
        this.changed();
        return;
      case 'deform':
        if (d.moved) {
          this.history.end();
          this.snapDirty = true;
        } else this.history.cancel();
        this.changed();
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
      case 'cutline': {
        const pts = d.pts.slice();
        if (d.moved && d.end) pts.push(d.end);
        this.drag = null;
        this.changed();
        if (d.moved && pts.length >= 2) {
          const line = simplify(pts.map((q) => ({ x: q[0], y: q[1] })), this.view.mpp * 1.2).map((q) => [q.x, q.y]);
          this.onCutLine?.({ kind: d.kind, pts: line, alt: e.altKey });
        } else {
          // un toque: Split corta lo seleccionado con la línea tocada; Reshape solo elige
          const hit = pickShape(this.doc, sp, this.view, this.units(), 10);
          this.onCutTouch?.({ kind: d.kind, hit: hit?.shape || null, shift: e.shiftKey || this.addMode });
        }
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

  /** El texto seleccionado, si es el único objeto: su caja sigue la orientación del texto. */
  singleText() {
    if (this.selection.size !== 1) return null;
    const s = this.selectedShapes()[0];
    return s && s.type === 'text' && !s.locked ? s : null;
  }

  /** Caja girada de un texto en pantalla (px): esquinas, puntos medios y asa de giro. */
  textFrame(shape) {
    const u = this.units();
    const [ax, ay] = this.view.toScreen(shape.x, shape.y);
    const fs = shape.fontSize * u.ptToPx;
    const m = layoutText(shape, fs, u.mmToPx, textMeasurer(shape));
    const { corners, center, rot } = textCorners(m, ax, ay, shape.rotation || 0);
    const [nw, ne, se, sw] = corners;
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const n = mid(nw, ne);
    const up = [nw[0] - sw[0], nw[1] - sw[1]];
    const len = Math.hypot(up[0], up[1]) || 1;
    const pos = { nw, ne, se, sw, n, e: mid(ne, se), s: mid(se, sw), w: mid(sw, nw), rotate: [n[0] + (up[0] / len) * 26, n[1] + (up[1] / len) * 26] };
    return { m, ax, ay, fs, u, corners, center, rot, pos };
  }

  handleAt(sp) {
    const text = this.singleText();
    if (text) {
      const f = this.textFrame(text);
      for (const k of [...HANDLE_KEYS, 'rotate']) if (Math.hypot(sp[0] - f.pos[k][0], sp[1] - f.pos[k][1]) < 12) return `T${k}`;
      return null;
    }
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

  /** Rectángulo de pantalla de la imagen seleccionada: [x0, y0, x1, y1], o null. */
  imageScreenRect() {
    const l = this.imageSel && this.doc.layers.find((x) => x.id === this.imageSel && x.kind === 'image');
    const img = l && imageRect(l);
    if (!img) return null;
    const [x0, y0] = this.view.toScreen(img.x0, img.y1);
    const [x1, y1] = this.view.toScreen(img.x1, img.y0);
    return [x0, y0, x1, y1];
  }

  /** Capa de imagen visible y DESBLOQUEADA bajo un punto del mundo (la de más arriba). */
  pickImage(wp) {
    for (let i = this.doc.layers.length - 1; i >= 0; i--) {
      const l = this.doc.layers[i];
      if (l.kind !== 'image' || !l.visible || l.locked) continue;
      const img = imageRect(l);
      if (img && wp[0] >= img.x0 && wp[0] <= img.x1 && wp[1] >= img.y0 && wp[1] <= img.y1) return l;
    }
    return null;
  }

  imageBounds(layer) {
    const img = imageRect(layer);
    return [img.x0, img.y0, img.x1, img.y1];
  }

  withBounds(doc, id, b) {
    return { ...doc, layers: doc.layers.map((l) => (l.id === id ? { ...l, settings: { ...l.settings, bounds: b } } : l)) };
  }

  selectDown(e, sp, wp, shift) {
    const add = shift || this.addMode;
    if (this.imageSel && !this.selection.size) {
      const r = this.imageScreenRect();
      if (r && Math.hypot(sp[0] - r[2], sp[1] - r[3]) < 12) {
        const l = this.doc.layers.find((x) => x.id === this.imageSel);
        this.history.begin();
        this.drag = { mode: 'iscale', id: l.id, b0: this.imageBounds(l), base: this.doc };
        return;
      }
    }
    const handle = this.selection.size ? this.handleAt(sp) : null;
    if (handle?.startsWith('T')) {
      const text = this.singleText();
      const f = this.textFrame(text);
      const k = handle.slice(1);
      this.history.begin();
      if (k === 'rotate') {
        const [cx, cy] = this.view.toWorld(f.center[0], f.center[1]);
        this.drag = { mode: 'rotate', start: wp, center: { x: cx, y: cy }, shapes: [text], base: this.doc };
      } else if (k === 'e' || k === 'w') {
        this.drag = { mode: 'twidth', handle: k, shape: text, frame: f, start: sp, base: this.doc };
      } else {
        this.drag = { mode: 'tscale', handle: k, shape: text, frame: f, base: this.doc };
      }
      return;
    }
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
      // los extremos de las líneas coinciden con los manejadores: un toque sin arrastrar elige lo que hay debajo
      this.drag.sp0 = sp;
      this.drag.tapHit = pickShape(this.doc, sp, this.view, this.units(), e.pointerType === 'mouse' ? 6 : 10)?.shape.id || null;
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
    const img = this.pickImage(wp);
    if (img) {
      if (!add) this.setSelection([]);
      this.imageSel = img.id;
      this.history.begin();
      this.drag = { mode: 'imove', id: img.id, start: wp, sp0: sp, b0: this.imageBounds(img), base: this.doc, moved: false };
      this.changed();
      return;
    }
    this.imageSel = null;
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
            // doble clic (PC) o doble toque (lápiz, dedo): esquina ↔ curva. Se detecta aquí y no con
            // `dblclick`, que Safari no envía con el lápiz ni con el dedo.
            const now = performance.now();
            const lt = this.lastNodeTap;
            if (lt && lt.id === shape.id && lt.ring === ring && lt.index === i && now - lt.t < 420) {
              this.lastNodeTap = null;
              this.clearLongPress();
              return this.toggleSmooth(shape.id, ring, i);
            }
            this.lastNodeTap = { id: shape.id, ring, index: i, t: now };
            this.activeNode = { id: shape.id, ring, index: i };
            if (this.frozenAt(nodes[i])) return this.frozenNotice();
            this.history.begin();
            this.drag = { mode: 'node', id: shape.id, ring, index: i, joined: this.settings.moveJoined === false ? [] : this.findJoined(shape, ring, i) };
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
    // varias formas seleccionadas (p. ej. vecinas que comparten borde): insertar en la que está bajo el
    // puntero, y el nodo queda compartido por todas las que tienen ese tramo
    if (!shape && this.selection.size > 1) {
      // tiradores Bézier de cualquiera de las seleccionadas
      for (const s of this.selectedShapes()) {
        if (s.type !== 'path' || s.locked) continue;
        for (const ring of [-1, ...(s.holes || []).map((_, i) => i)]) {
          const nodes = this.ringNodes(s, ring);
          for (let i = 0; i < nodes.length; i++) {
            for (const kind of ['hIn', 'hOut']) {
              if (!nodes[i][kind]) continue;
              const [hx, hy] = this.view.toScreen(nodes[i][kind].x, nodes[i][kind].y);
              if (Math.hypot(sp[0] - hx, sp[1] - hy) < tol) {
                this.activeNode = { id: s.id, ring, index: i };
                this.history.begin();
                this.drag = { mode: 'bezier', id: s.id, ring, index: i, kind, alt: e.altKey };
                this.changed();
                return;
              }
            }
          }
        }
      }
      // sobre un vértice de cualquiera de las seleccionadas: se mueve (con «Move Joined», junto con los que lo comparten)
      let best = null;
      for (const s of this.selectedShapes()) {
        if (s.type !== 'path' || s.locked) continue;
        for (const ring of [-1, ...(s.holes || []).map((_, i) => i)]) {
          this.ringNodes(s, ring).forEach((n, i) => {
            const [nx, ny] = this.view.toScreen(n.x, n.y);
            const dist = Math.hypot(sp[0] - nx, sp[1] - ny);
            if (dist < tol && (!best || dist < best.dist)) best = { dist, s, ring, i };
          });
        }
      }
      if (best) {
        const { s, ring, i } = best;
        if (e.altKey) return this.toggleSmooth(s.id, ring, i);
        this.activeNode = { id: s.id, ring, index: i };
        if (this.frozenAt(this.ringNodes(s, ring)[i])) return this.frozenNotice();
        this.history.begin();
        this.drag = { mode: 'node', id: s.id, ring, index: i, joined: this.settings.moveJoined === false ? [] : this.findJoined(s, ring, i) };
        this.changed();
        return;
      }
      for (const s of this.selectedShapes()) {
        if (s.type !== 'path' || s.locked) continue;
        for (const ring of [-1, ...(s.holes || []).map((_, i) => i)]) {
          const near = nearestOnPath(this.ringNodes(s, ring), ring < 0 ? s.closed : true, { x: wp[0], y: wp[1] });
          if (near && near.dist / this.view.mpp < 8 && (e.altKey || this.settings.insertOnTap)) return this.insertNode(s.id, ring, near.segIndex, near.t);
        }
      }
    }
    const hit = pickShape(this.doc, sp, this.view, this.units(), 10);
    // con varias seleccionadas, tocar una de ellas no deshace la selección (el doble clic inserta un nodo compartido)
    if (hit && this.selection.size > 1 && this.selection.has(hit.shape.id)) return;
    this.setSelection(hit ? [hit.shape.id] : []);
  }

  /* ------------------------------------------------ nodos congelados */

  /** Distancia bajo la cual dos nodos son el mismo (la de Move Joined). */
  joinTol() {
    return Math.min(this.view.mpp * 0.35, 0.5);
  }

  /** ¿El nodo `n` está congelado (en esta forma o en otra que lo comparte)? */
  frozenAt(n) {
    return !!n && (n.frozen || frozenTest(this.doc, this.joinTol())(n));
  }

  frozenNotice() {
    this.onMessage('Nodo congelado: no se mueve (menú contextual → Unfreeze node)');
    this.changed();
  }

  /**
   * Freeze / Unfreeze del nodo `a` ({id, ring, index}): se marca en todas las
   * formas que lo comparten. Un nodo congelado no se mueve con las
   * transformaciones y limita las deformaciones en gradiente.
   */
  freezeNode(a, value = true) {
    const sh = allTopShapes(this.doc, { visibleOnly: false }).find((x) => x.shape.id === a.id)?.shape;
    const n = sh && this.ringNodes(sh, a.ring)?.[a.index];
    if (!n) return;
    const r = setNodesFrozen(this.doc, [{ x: n.x, y: n.y }], value, this.joinTol());
    if (r.count) this.history.commit(r.doc);
    this.onMessage(value ? 'Nodo congelado: no se mueve con transformaciones y frena las deformaciones' : 'Nodo descongelado');
  }

  /** Unfreeze nodes: descongela todos los nodos de la selección (y los que comparten su lugar). */
  unfreezeSelection() {
    const pts = frozenPoints(this.doc, this.selection);
    if (!pts.length) return this.onMessage('La selección no tiene nodos congelados');
    const r = setNodesFrozen(this.doc, pts, false, this.joinTol());
    if (r.count) this.history.commit(r.doc);
    this.onMessage(`${pts.length} nodo(s) descongelado(s)`);
  }

  /** Unfreeze all nodes: descongela todos los nodos del documento, en todas las capas (también ocultas o bloqueadas). */
  unfreezeAll() {
    const pts = frozenPoints(this.doc);
    if (!pts.length) return this.onMessage('No hay nodos congelados en el documento');
    const r = setNodesFrozen(this.doc, pts, false, 0);
    if (r.count) this.history.commit(r.doc);
    this.onMessage(`${r.count} nodo(s) descongelado(s) en todo el documento`);
  }

  updateRing(shape, ring, f) {
    if (ring < 0) return { ...shape, nodes: f(shape.nodes) };
    const holes = shape.holes.slice();
    holes[ring] = f(holes[ring]);
    return { ...shape, holes };
  }

  /**
   * Nodos de OTRAS formas (líneas y polígonos, huecos incluidos) que comparten
   * el vértice `index` del anillo `ring` de `shape`: mismas coordenadas, con una
   * tolerancia mínima por números de coma flotante o por importaciones. Son los
   * que se mueven junto con él cuando «Move Joined» está activo.
   */
  findJoined(shape, ring, index) {
    const n = this.ringNodes(shape, ring)[index];
    if (!n) return [];
    const tol = Math.min(this.view.mpp * 0.35, 0.5);
    const out = [];
    for (const { shape: s } of allTopShapes(this.doc, { unlockedOnly: true })) {
      if (s.type !== 'path') continue;
      const rings = [-1, ...(s.holes || []).map((_, i) => i)];
      for (const r of rings) {
        this.ringNodes(s, r).forEach((q, i) => {
          if (s.id === shape.id && r === ring && i === index) return;
          if (Math.hypot(q.x - n.x, q.y - n.y) <= tol) out.push({ id: s.id, ring: r, index: i });
        });
      }
    }
    return out;
  }

  /** Posiciones originales del nodo arrastrado y de los que se mueven con él. */
  nodeOrigins(d) {
    if (d._origins) return d._origins;
    const base = this.history.anchor || this.doc;
    const out = [];
    for (const t of [{ id: d.id, ring: d.ring, index: d.index }, ...(d.joined || [])]) {
      const sh = allTopShapes(base).find((x) => x.shape.id === t.id)?.shape;
      const n = sh && this.ringNodes(sh, t.ring)?.[t.index];
      if (n) out.push([n.x, n.y]);
    }
    d._origins = out;
    return out;
  }

  nodeDrag(e, wp) {
    const d = this.drag;
    this.lastNodeTap = null; // arrastrar no es parte de un doble toque
    let p = wp;
    const joined = d.joined || [];
    if (this.settings.snap) {
      // no engancharse a la propia forma ni a las que se mueven con ella
      const skip = new Set([d.id, ...joined.map((j) => j.id)]);
      const s = this.snapIndex().query(wp, this.snapTolPx() * this.view.mpp);
      if (s && !skip.has(s.meta?.id)) p = s.point;
    }
    this.guides = null;
    if (p === wp) {
      // sin snap duro: alinear con otros vértices (sin contar este nodo ni los que lo acompañan en su lugar original)
      const orig = this.nodeOrigins(d);
      p = this.guidePoint(wp, { exclude: orig });
    }
    const move = (nodes, index) =>
      nodes.map((n, i) => {
        if (i !== index) return n;
        const dx = p[0] - n.x;
        const dy = p[1] - n.y;
        return {
          ...n,
          x: p[0],
          y: p[1],
          hIn: n.hIn ? { x: n.hIn.x + dx, y: n.hIn.y + dy } : null,
          hOut: n.hOut ? { x: n.hOut.x + dx, y: n.hOut.y + dy } : null,
        };
      });
    const targets = [{ id: d.id, ring: d.ring, index: d.index }, ...joined];
    const ids = new Set(targets.map((t) => t.id));
    const doc = mapShapes(this.history.anchor || this.doc, ids, (shape) => {
      let out = shape;
      for (const t of targets) if (t.id === shape.id) out = this.updateRing(out, t.ring, (nodes) => move(nodes, t.index));
      return out;
    });
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

  /** Esquina ↔ curva del nodo (doble clic / doble toque, Alt+clic, Mayús+C). */
  toggleSmooth(id, ring, index) {
    let toCurve = false;
    this.history.commit(
      mapShapes(this.doc, [id], (shape) => {
        const closed = ring < 0 ? !!shape.closed : true;
        return this.updateRing(shape, ring, (nodes) =>
          nodes.map((n, i) => {
            if (i !== index) return n;
            if (n.hIn || n.hOut) return { ...n, hIn: null, hOut: null, smooth: false };
            toCurve = true;
            const N = nodes.length;
            // en el extremo de un trazo abierto solo hay un vecino: la manija va hacia ese lado
            const prev = closed ? nodes[(i - 1 + N) % N] : nodes[i - 1] || null;
            const next = closed ? nodes[(i + 1) % N] : nodes[i + 1] || null;
            const k = prev && next ? 1 / 6 : 1 / 3;
            const dx = ((next || n).x - (prev || n).x) * k;
            const dy = ((next || n).y - (prev || n).y) * k;
            return { ...n, smooth: true, hIn: prev ? { x: n.x - dx, y: n.y - dy } : null, hOut: next ? { x: n.x + dx, y: n.y + dy } : null };
          }),
        );
      }),
    );
    this.activeNode = { id, ring, index };
    this.onMessage(toCurve ? 'Nodo de curva: arrastra sus manijas' : 'Nodo de esquina');
    this.changed();
  }

  /**
   * Inserta un nodo en el tramo `seg` del anillo. Si otras líneas o polígonos
   * tienen ese MISMO tramo (sus dos nodos coinciden con los de este) —las
   * seleccionadas siempre y, con Move Joined, cualquiera— el nodo se inserta
   * también en ellas, en el mismo punto: queda compartido y el cierre no se pierde.
   */
  insertNode(id, ring, seg, t) {
    const found = findTopShape(this.doc, id);
    if (!found) return;
    const shape = found.shape;
    const nodes = this.ringNodes(shape, ring);
    const closed = ring < 0 ? !!shape.closed : true;
    const A = nodes[seg];
    const B = nodes[(seg + 1) % nodes.length];
    const split = splitNodes(nodes, closed, seg, t);
    const P = split[seg + 1];
    const tol = Math.min(this.view.mpp * 0.35, 0.5);
    const same = (p, q) => Math.hypot(p.x - q.x, p.y - q.y) <= tol;
    const at = (n) => {
      const dx = P.x - n.x;
      const dy = P.y - n.y;
      const mv = (h) => (h ? { x: h.x + dx, y: h.y + dy } : h);
      return { ...n, x: P.x, y: P.y, hIn: mv(n.hIn), hOut: mv(n.hOut) };
    };
    const sel = this.selection;
    const joined = this.settings.moveJoined !== false;
    const map = new Map([[id, this.updateRing(shape, ring, () => split)]]);
    let shared = 0;
    for (const { layer, shape: s } of allTopShapes(this.doc, { visibleOnly: false })) {
      if (s.type !== 'path' || s.locked || layer.locked || !(sel.has(s.id) || joined)) continue;
      let cur = map.get(s.id) || s;
      for (const r of [-1, ...(s.holes || []).map((_, i) => i)]) {
        if (s.id === id && r === ring) continue;
        const ns = this.ringNodes(cur, r);
        const cl = r < 0 ? !!cur.closed : true;
        const segs = cl ? ns.length : ns.length - 1;
        for (let i = 0; i < segs; i++) {
          const a = ns[i];
          const b = ns[(i + 1) % ns.length];
          if (!((same(a, A) && same(b, B)) || (same(a, B) && same(b, A)))) continue;
          const near = nearestOnPath([a, b], false, P);
          const out = splitNodes(ns, cl, i, near ? near.t : 0.5);
          out[i + 1] = at(out[i + 1]);
          cur = this.updateRing(cur, r, () => out);
          shared++;
          break;
        }
      }
      if (cur !== s) map.set(s.id, cur);
    }
    this.history.commit(replaceShapes(this.doc, map));
    this.activeNode = { id, ring, index: seg + 1 };
    if (shared) this.onMessage(`Nodo agregado y compartido con ${shared} borde(s) vecino(s)`);
    this.snapDirty = true;
    this.changed();
  }

  /**
   * Borra el nodo activo y elige solo el vecino (el siguiente; el anterior si no
   * hay más allá). Si se borra otra vez sin elegir otro, sigue en la misma
   * dirección: dos borrados seguidos dejan elegido el tercero.
   */
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
    // ¿Segundo borrado seguido? (el nodo que se borra es el que se eligió solo tras el anterior): se sigue en la misma dirección
    const prev = this.nodeRun;
    const consecutive = prev && prev.id === a.id && prev.ring === a.ring && prev.index === a.index;
    let dir = consecutive ? prev.dir : 1;
    const n = nodes.length;
    const closed = shape.closed || a.ring >= 0;
    const left = n - 1;
    // vecino en la dirección: adelante es el que ocupa el lugar del borrado; en un trazo abierto sin nada más allá, se invierte
    const pick = (d) => (d > 0 ? (a.index < n - 1 || closed ? a.index % left : -1) : a.index > 0 || closed ? (a.index - 1 + left) % left : -1);
    let next = pick(dir);
    if (next < 0) {
      dir = -dir;
      next = pick(dir);
    }
    this.history.commit(mapShapes(this.doc, [a.id], (s) => this.updateRing(s, a.ring, (ns) => ns.filter((_, i) => i !== a.index))));
    this.activeNode = next >= 0 ? { id: a.id, ring: a.ring, index: next } : null;
    this.nodeRun = this.activeNode ? { ...this.activeNode, dir } : null;
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
    if (!this.draft && !this.cutMode && this.tool === 'pen') {
      // tocar el último nodo de la línea seleccionada y seguir dibujando: la continúa
      const ep = this.endpointAt(sp);
      if (ep) {
        const nodes = this.continuationNodes(ep.shape, ep.atStart);
        this.draft = { nodes, snaps: nodes.map(() => null), layerId: layer.id, continues: { id: ep.shape.id, atStart: ep.atStart } };
        this.hover = { sp, wp, snap: null };
        this.onMessage('Continuando la línea: clic para agregar nodos, Enter para terminar');
        this.changed();
        return;
      }
    }
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
        // Alt = el otro camino (por el otro lado de un polígono, por ejemplo)
        const path = this.traceFor(prevSnap, snap, { alt: e.altKey });
        if (path && path.length > 2) {
          for (const q of path.slice(1, -1)) {
            nodes.push(makeNode(q[0], q[1]));
            this.draft.snaps.push({ traced: true }); // vértice de un recorrido: se deshace junto con el recorrido
          }
        } else if (!path && Math.hypot(prevSnap.point[0] - snap.point[0], prevSnap.point[1] - snap.point[1]) > this.view.mpp) {
          this.onMessage('Trace: esos dos puntos no están conectados por ningún borde (se unieron en línea recta)');
        }
      }
    }
    nodes.push(makeNode(point[0], point[1]));
    this.draft.snaps.push(snap && snap.type !== 'first' ? snap : null);
    this.drag = { mode: 'pen-handle', sp0: sp };
    this.hover = { sp, wp: point, snap };
    this.changed();
  }

  /**
   * Recorrido de Trace de `prevSnap` a `snap`, el mismo en la vista previa y al
   * poner el vértice: va por el camino más corto, pero sigue el sentido que ya
   * llevaba desde ese origen (no cambia de lado en un anillo apenas el otro
   * parece más corto) y no vuelve a pasar por los vértices ya puestos.
   */
  traceFor(prevSnap, snap, { alt = false, preview = false } = {}) {
    const avoid = new Set((this.draft?.nodes || []).slice(0, -1).map((n) => pointKey([n.x, n.y])));
    const prefer = this.traceDir?.from === prevSnap ? this.traceDir.first : null;
    const path = smartTrace(this.snapIndex(), this.graph(), prevSnap, snap, { prefer, avoid, alt, maxVisited: preview ? 40000 : undefined });
    if (path && !alt) this.traceDir = { from: prevSnap, first: path.first };
    return path;
  }

  updateHover(sp, alt = false) {
    const wp = this.view.toWorld(...sp);
    const { point, snap } = this.snapPoint(wp);
    let tracePreview = null;
    if (this.settings.trace && this.draft && snap?.segment != null && this.draft.snaps.length) {
      const prev = this.draft.snaps[this.draft.snaps.length - 1];
      if (prev?.segment != null) tracePreview = this.traceFor(prev, snap, { alt, preview: true });
    }
    this.hover = { sp, wp: point, snap, tracePreview };
    this.changed();
  }

  /**
   * Extremo de una línea SELECCIONADA (abierta, sin huecos, desbloqueada) bajo el
   * puntero, a menos de 12 px: permite seguir dibujándola con la Pluma o el
   * Lápiz. Una línea sin seleccionar no cuenta: tocar su extremo empieza una
   * línea nueva que comparte ese vértice (el flujo de los contactos).
   */
  endpointAt(sp) {
    let best = null;
    for (const s of this.selectedShapes()) {
      if (s.type !== 'path' || s.closed || s.locked || s.holes?.length || s.nodes.length < 2 || inLockedLayer(this.doc, s.id)) continue;
      for (const atStart of [false, true]) {
        const n = atStart ? s.nodes[0] : s.nodes[s.nodes.length - 1];
        const [x, y] = this.view.toScreen(n.x, n.y);
        const d = Math.hypot(sp[0] - x, sp[1] - y);
        if (d < 12 && (!best || d < best.d)) best = { shape: s, atStart, d };
      }
    }
    return best;
  }

  /** Nodos de la línea en el orden en que se sigue dibujando (si se sigue desde su inicio, invertidos). */
  continuationNodes(shape, atStart) {
    const nodes = shape.nodes.map(cloneNode);
    return atStart ? nodes.reverse().map((n) => ({ ...n, hIn: n.hOut ? { ...n.hOut } : null, hOut: n.hIn ? { ...n.hIn } : null })) : nodes;
  }

  /** Reemplaza la línea continuada por la versión con los nodos nuevos (mismo id, estilo y atributos). */
  commitContinued(id, atStart, nodes, closed) {
    const found = findTopShape(this.doc, id);
    if (!found) return false;
    const final = atStart ? nodes.slice().reverse().map((n) => ({ ...n, hIn: n.hOut ? { ...n.hOut } : null, hOut: n.hIn ? { ...n.hIn } : null })) : nodes;
    const added = atStart ? final.slice(0, final.length - found.shape.nodes.length) : final.slice(found.shape.nodes.length);
    let doc = mapShapes(this.doc, [id], (s) => {
      const { freehand, ...rest } = s; // ya no es el trazo libre original
      return { ...rest, nodes: final, closed: closed || s.closed };
    });
    if (this.settings.moveJoined !== false && added.length) {
      doc = nodeInto(doc, added.map((n) => ({ x: n.x, y: n.y })), { exclude: id, tol: Math.max(this.view.mpp * 0.6, 1e-6) }).doc;
    }
    this.history.commit(doc);
    this.snapDirty = true;
    this.setSelection([id]);
    return true;
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
    if (this.cutMode) {
      // la forma dibujada es solo la cortadora: no entra al dibujo
      const mode = this.cutMode;
      this.cutMode = null;
      const pts = flattenNodes(nodes, closed, Math.max(1e-3, this.view.mpp * 0.2)).map((p) => [p[0], p[1]]);
      this.setTool('select');
      this.onCut?.(mode, pts);
      return;
    }
    if (d.continues && this.commitContinued(d.continues.id, d.continues.atStart, nodes, closed)) {
      this.onMessage('Línea continuada');
      return;
    }
    const st = this.getCurrentStyle();
    const style = { ...st };
    if (!closed) style.fillOpen = false;
    const shape = makePath(nodes, { closed, style });
    this.commitNewShape(d.layerId, shape);
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
    // un recorrido de Trace entero (sus vértices intermedios) sale de una vez
    while (this.draft.snaps.length && this.draft.snaps[this.draft.snaps.length - 1]?.traced) {
      this.draft.nodes.pop();
      this.draft.snaps.pop();
    }
    if (!this.draft.nodes.length) this.draft = null;
    this.changed();
    return true;
  }

  /* --------------------------------------------------------- suavizar */

  /** Suavizar (pincel): trazos seleccionados o, si no hay, el que está bajo el puntero. */
  smoothDown(e, sp, wp) {
    let ids = this.selectedShapes().filter((s) => s.type === 'path' && !s.locked).map((s) => s.id);
    if (!ids.length) {
      const hit = pickShape(this.doc, sp, this.view, this.units(), 14);
      if (hit?.shape.type === 'path' && !hit.shape.locked) {
        ids = [hit.shape.id];
        this.setSelection(ids);
      }
    }
    if (!ids.length) {
      this.onMessage('Suavizar: pasa el pincel sobre un trazo (o selecciónalo primero)');
      return;
    }
    this.history.begin();
    this.drag = { mode: 'smooth', ids, last: wp, moved: false };
    this.smoothMove(sp, wp);
  }

  /* --------------------------------------------------------- deform */

  /**
   * Deform: se toma una zona de las líneas o polígonos seleccionados (o del que
   * está bajo el puntero) y se arrastra; los nodos se mueven en gradiente
   * dentro del radio. Con Move Joined arrastra también los nodos que otras
   * formas comparten con la selección.
   */
  deformDown(e, sp, wp) {
    let ids = this.selectedShapes().filter((s) => s.type === 'path' && !s.locked).map((s) => s.id);
    if (!ids.length) {
      const hit = pickShape(this.doc, sp, this.view, this.units(), 14);
      if (hit?.shape.type === 'path' && !hit.shape.locked) {
        ids = [hit.shape.id];
        this.setSelection(ids);
      }
    }
    if (!ids.length) {
      this.onMessage('Deform: selecciona una línea o polígono (o toca uno) y arrastra una zona');
      return;
    }
    const radius = (this.settings.deformRadius ?? 60) * this.view.mpp;
    const prep = prepareDeform(this.doc, ids, { x: wp[0], y: wp[1] }, radius, {
      joined: this.settings.moveJoined !== false,
      tol: Math.min(this.view.mpp * 0.35, 0.5),
      nodeTol: Math.max(this.view.mpp * 0.6, 1e-6),
    });
    if (!prep.count) {
      this.onMessage('Deform: no hay trazo dentro del área; acércate a la línea o agranda el radio ([ ])');
      return;
    }
    this.history.begin();
    this.drag = { mode: 'deform', prep, start: wp, moved: false };
    this.hover = { sp, wp, brush: true };
    this.changed();
  }

  /** Nodo de los trazos seleccionados bajo el puntero (a menos de 12 px), o null. */
  selectedNodeAt(sp) {
    let best = null;
    for (const s of this.selectedShapes()) {
      if (s.type !== 'path' || s.locked) continue;
      for (const ring of [-1, ...(s.holes || []).map((_, i) => i)]) {
        this.ringNodes(s, ring).forEach((n, index) => {
          const [x, y] = this.view.toScreen(n.x, n.y);
          const d = Math.hypot(sp[0] - x, sp[1] - y);
          if (d < 12 && (!best || d < best.d)) best = { id: s.id, ring, index, d, n };
        });
      }
    }
    return best;
  }

  /**
   * Drag: se toma un nodo de una línea o polígono seleccionado y se arrastra;
   * los vecinos lo siguen cada vez menos a lo largo del trazo (hasta los
   * extremos, que quedan fijos, o lo que diga el alcance). Tocar otra forma la
   * selecciona (Mayús la suma: varias formas que comparten nodos se arrastran
   * juntas; con Move Joined, también las vecinas no seleccionadas).
   */
  dragDown(e, sp, wp) {
    const node = this.selectedNodeAt(sp);
    if (!node) {
      const hit = pickShape(this.doc, sp, this.view, this.units(), 10);
      if (hit && (e.shiftKey || this.addMode)) this.toggleSel(hit.shape.id);
      else this.setSelection(hit ? [hit.shape.id] : []);
      if (hit && hit.shape.type === 'path') this.onMessage('Drag: toma un nodo y arrástralo');
      return;
    }
    const prep = prepareDrag(this.doc, node, {
      reach: (this.settings.dragReach ?? 100) / 100,
      ids: this.selectedShapes().map((s) => s.id),
      joined: this.settings.moveJoined !== false,
      tol: Math.min(this.view.mpp * 0.35, 0.5),
    });
    this.activeNode = { id: node.id, ring: node.ring, index: node.index };
    if (prep.frozen) return this.frozenNotice();
    // vértices a los que puede engancharse el nodo arrastrado: los de las formas visibles en la vista, menos los que se mueven
    const moving = new Set(prep.moves.map((m) => `${m.id}|${m.ring}|${m.index}`));
    const ext = this.view.extent(SNAP_PX);
    const targets = [];
    for (const { shape: s } of allTopShapes(this.doc)) {
      if (s.type === 'point') {
        targets.push([s.x, s.y]);
        continue;
      }
      if (s.type !== 'path') continue;
      for (const ring of [-1, ...(s.holes || []).map((_, i) => i)]) {
        this.ringNodes(s, ring).forEach((n, i) => {
          if (n.x < ext.minX || n.x > ext.maxX || n.y < ext.minY || n.y > ext.maxY || moving.has(`${s.id}|${ring}|${i}`)) return;
          targets.push([n.x, n.y]);
        });
      }
    }
    this.history.begin();
    this.drag = { mode: 'deform', prep, start: [node.n.x, node.n.y], moved: false, grab: [wp[0] - node.n.x, wp[1] - node.n.y], targets };
    this.changed();
  }

  deformMove(sp, wp) {
    const d = this.drag;
    this.hover = { sp, wp, brush: true };
    // en Drag el nodo sigue al puntero manteniendo dónde se tomó
    let dx = wp[0] - (d.grab ? d.grab[0] : 0) - d.start[0];
    let dy = wp[1] - (d.grab ? d.grab[1] : 0) - d.start[1];
    // Drag con Snap: el nodo arrastrado se engancha al vértice más cercano (a menos de 12 px)
    d.snapTo = null;
    if (d.targets && this.settings.snap) {
      const px = d.start[0] + dx;
      const py = d.start[1] + dy;
      let best = SNAP_PX * this.view.mpp;
      for (const t of d.targets) {
        const dist = Math.hypot(t[0] - px, t[1] - py);
        if (dist < best) {
          best = dist;
          d.snapTo = t;
        }
      }
      if (d.snapTo) {
        dx = d.snapTo[0] - d.start[0];
        dy = d.snapTo[1] - d.start[1];
      }
    }
    if (!d.moved && Math.hypot(dx, dy) < this.view.mpp * 2) return this.changed();
    d.moved = true;
    d.dx = dx;
    d.dy = dy;
    this.history.preview(applyDeform(d.prep, dx, dy));
  }

  /** Cada tramo del pincel suaviza un poco lo que toca: pasar de nuevo suaviza más. */
  smoothMove(sp, wp) {
    const d = this.drag;
    this.hover = { sp, wp, brush: true };
    const step = Math.hypot(wp[0] - d.last[0], wp[1] - d.last[1]);
    if (step < this.view.mpp * 3 && d.moved) {
      this.changed();
      return;
    }
    const brush = [d.last, wp];
    d.last = wp;
    const o = {
      radius: (this.settings.smoothRadius ?? 18) * this.view.mpp,
      tol: this.view.mpp * smoothTolPx(this.settings.smoothLevel ?? 50),
      level: this.settings.smoothLevel ?? 50,
      flat: this.view.mpp * 0.5,
    };
    // por arcos: lo que comparten dos formas se suaviza una vez y las dos lo reciben igual (no se pierde el cierre)
    const topo = buildTopology(this.doc, d.ids, Math.min(this.view.mpp * 0.35, 0.5));
    const next = smoothTopology(topo, this.doc, (nodes, closed) => smoothAlong(nodes, closed, brush, o));
    const changed = next !== this.doc;
    if (changed) {
      d.moved = true;
      this.history.preview(next);
    } else this.changed();
  }

  /* --------------------------------------------------------- lápiz y formas */

  finishPencil(d) {
    this.preview = null;
    const layer = this.ensureDrawableLayer();
    if (!layer || d.pts.length < 2) return this.changed();
    const mpp = this.view.mpp;
    if (d.continues) {
      const found = findTopShape(this.doc, d.continues.id);
      if (found) {
        const more = simplify(d.pts, mpp * 0.25);
        if (this.settings.snap && more.length > 1) {
          const { point } = this.snapPoint([more[more.length - 1].x, more[more.length - 1].y]);
          more[more.length - 1] = { x: point[0], y: point[1] };
        }
        const fresh = freehandToNodes(more, this.settings.pencilSmooth ?? DEFAULT_SMOOTH, mpp, false);
        const base = this.continuationNodes(found.shape, d.continues.atStart);
        const last = base[base.length - 1];
        // el trazo nuevo arranca en el último nodo: se funden (la manija de salida es la del trazo nuevo)
        const joint = { ...last, hOut: fresh[0].hOut, smooth: !!(last.hIn && fresh[0].hOut) };
        if (fresh.length >= 2 && this.commitContinued(d.continues.id, d.continues.atStart, [...base.slice(0, -1), joint, ...fresh.slice(1)], false)) {
          this.onMessage('Línea continuada');
          return;
        }
      }
    }
    // puntos originales (casi sin simplificar): de ellos sale el trazo y, después, cualquier otro nivel de suavizado
    let pts = simplify(d.pts, mpp * 0.25).map((p) => ({ x: Math.round(p.x * 1000) / 1000, y: Math.round(p.y * 1000) / 1000 }));
    // terminar cerca del inicio = forma cerrada
    const first = pts[0];
    const last = pts[pts.length - 1];
    const closed = pts.length > 3 && Math.hypot(first.x - last.x, first.y - last.y) < SNAP_PX * mpp;
    if (closed) pts = pts.slice(0, -1);
    else if (this.settings.snap) {
      // engancha el final a la geometría existente
      const { point } = this.snapPoint([last.x, last.y]);
      pts[pts.length - 1] = { x: point[0], y: point[1] };
    }
    const level = this.settings.pencilSmooth ?? DEFAULT_SMOOTH;
    const nodes = freehandToNodes(pts, level, mpp, closed);
    const shape = makePath(nodes, { closed, style: { ...this.getCurrentStyle() } });
    shape.freehand = { pts, mpp, closed, level, sig: nodesSignature(nodes) };
    shape.name = closed ? 'Polígono libre' : 'Trazo libre';
    this.commitNewShape(layer.id, shape);
    this.snapDirty = true;
    this.setSelection([shape.id]);
  }

  /**
   * Agrega una forma recién dibujada. Con Move Joined, sus nodos que quedaron
   * (por snap) sobre el trazo de otra línea o polígono se insertan también en
   * ese trazo: quedan COMPARTIDOS y luego Nodos, Drag y Deform los mueven
   * juntos. Todo en un solo paso de deshacer.
   */
  commitNewShape(layerId, shape) {
    let doc = addShapes(this.doc, layerId, [shape]);
    if (this.settings.moveJoined !== false && shape.type === 'path') {
      const pts = [...shape.nodes, ...(shape.holes || []).flat()].map((n) => ({ x: n.x, y: n.y }));
      // la tolerancia cubre lo que se separa el trazo aplanado (donde engancha el snap) de la curva real
      const r = nodeInto(doc, pts, { exclude: shape.id, tol: Math.max(this.view.mpp * 0.6, 1e-6) });
      doc = r.doc;
      if (r.inserted) this.onMessage(`${r.inserted} nodo(s) compartido(s) con las líneas que toca (Move Joined)`);
    }
    this.history.commit(doc);
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
      this.commitNewShape(layer.id, shape);
      this.snapDirty = true;
      this.setSelection([shape.id]);
    } else this.changed();
  }

  /** Tamaño de un texto nuevo: el de dibujo, pero nunca menor que lo legible a la escala de la vista. */
  newTextSize() {
    const base = this.getCurrentStyle().fontSize || 10;
    // en Canvas el tamaño por defecto manda (la hoja se ve entera, con letra chica en pantalla)
    if (this.settings.mode !== 'gis') return base;
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

  /**
   * Cuentagotas: toma el estilo COMPLETO del elemento tocado —color y grosor
   * de trazo, tipo de línea, relleno, opacidad, ornamentos…— (en un grupo, el
   * del elemento bajo el puntero) y lo aplica a la selección o, sin
   * selección, lo deja como estilo para lo próximo que se dibuje.
   */
  applyEyedropper(shape, sp = null) {
    let leaf = shape;
    while (leaf?.type === 'group' && leaf.children?.length) {
      const kids = leaf.clip ? leaf.children.slice(1) : leaf.children;
      leaf = sp ? kids.reduce((a, c) => (shapeDistance(c, sp, this.view, this.units()) < shapeDistance(a, sp, this.view, this.units()) ? c : a)) : kids[kids.length - 1];
    }
    if (!leaf?.style) return;
    // todas las claves (las que el elemento no trae explícitas son las por defecto): así el grosor y el trazo siempre viajan
    const style = { ...defaultStyle(), ...leaf.style };
    this.pickedStyle = style;
    if (this.selection.size) {
      const apply = (s) => (s.type === 'group' ? { ...s, children: s.children.map((c, i) => (s.clip && i === 0 ? c : apply(c))) } : { ...s, style: { ...s.style, ...style } });
      const ids = this.selectedShapes().filter((s) => s.id !== shape.id && !s.locked).map((s) => s.id);
      if (ids.length) this.history.commit(mapShapes(this.doc, ids, apply));
    }
    const stroke = style.stroke && style.stroke !== 'none' ? `trazo ${style.stroke} de ${Number(style.strokeWidth || 0).toFixed(2)} mm` : 'sin trazo';
    const fill = style.fill && style.fill !== 'none' ? `relleno ${style.fill}` : 'sin relleno';
    this.onMessage(`Estilo tomado: ${stroke}, ${fill}${this.selection.size ? ' → aplicado a la selección' : ' → para lo próximo que dibujes'}`);
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
      // sobre un nodo el doble clic cambia esquina ↔ curva (ya lo hizo nodeDown): no insertar otro
      const P = (x, y) => this.view.toScreen(x, y);
      for (const ring of [-1, ...(hit.shape.holes || []).map((_, i) => i)]) {
        if (this.ringNodes(hit.shape, ring).some((n) => Math.hypot(sp[0] - P(n.x, n.y)[0], sp[1] - P(n.x, n.y)[1]) < 12)) return;
      }
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
      else if (this.cutMode) {
        this.setTool('select');
        this.onMessage('Cancelado');
      } else if (this.tool !== 'select') this.setTool('select');
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
    const single = this.tool === 'select' ? this.singleText() : null;
    if (single) {
      // caja del texto girada con él, con asas para estirar (tamaño), ensanchar (cuadro) y girar
      const f = this.textFrame(single);
      const pt = (p) => `${r2(p[0])},${r2(p[1])}`;
      out.push(`<polygon points="${f.corners.map(pt).join(' ')}" fill="none" stroke="#0ea5e9" stroke-dasharray="4 3"/>`);
      for (const k of HANDLE_KEYS) {
        const [hx, hy] = f.pos[k];
        const side = k === 'e' || k === 'w';
        out.push(`<rect class="h" x="${r2(hx - 5)}" y="${r2(hy - 5)}" width="10" height="10" ${side ? 'rx="5"' : ''} fill="${side ? '#0ea5e9' : '#fff'}" stroke="#0ea5e9" stroke-width="1.5" transform="rotate(${single.rotation || 0} ${r2(hx)} ${r2(hy)})"/>`);
      }
      out.push(`<line x1="${r2(f.pos.n[0])}" y1="${r2(f.pos.n[1])}" x2="${r2(f.pos.rotate[0])}" y2="${r2(f.pos.rotate[1])}" stroke="#0ea5e9"/>`);
      out.push(`<circle cx="${r2(f.pos.rotate[0])}" cy="${r2(f.pos.rotate[1])}" r="6" fill="#fff" stroke="#0ea5e9" stroke-width="1.5"/>`);
    } else if (box && this.tool === 'select') {
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

    // imagen raster seleccionada (capa desbloqueada): caja y asa de escala
    const ir = this.tool === 'select' ? this.imageScreenRect() : null;
    if (ir) {
      out.push(`<rect x="${r2(ir[0])}" y="${r2(ir[1])}" width="${r2(ir[2] - ir[0])}" height="${r2(ir[3] - ir[1])}" fill="rgba(14,165,233,.05)" stroke="#0ea5e9" stroke-dasharray="4 3"/>`);
      out.push(`<rect class="h" x="${r2(ir[2] - 5)}" y="${r2(ir[3] - 5)}" width="10" height="10" fill="#fff" stroke="#0ea5e9" stroke-width="1.5"/>`);
    }

    // nodos
    const ns = this.tool === 'node' ? this.nodeTarget() : null;
    if (this.tool === 'node' && !ns && this.selection.size > 1) {
      for (const s of this.selectedShapes()) {
        if (s.type !== 'path') continue;
        for (const ring of [-1, ...(s.holes || []).map((_, i) => i)]) {
          for (const n of this.ringNodes(s, ring)) {
            const [x, y] = P(n.x, n.y);
            for (const h of ['hIn', 'hOut']) {
              if (!n[h]) continue;
              const [hx, hy] = P(n[h].x, n[h].y);
              out.push(`<line x1="${r2(x)}" y1="${r2(y)}" x2="${r2(hx)}" y2="${r2(hy)}" stroke="#f59e0b"/>`);
              out.push(`<circle cx="${r2(hx)}" cy="${r2(hy)}" r="4.5" fill="#f59e0b" stroke="#fff"/>`);
            }
            out.push(`<rect x="${r2(x - 4)}" y="${r2(y - 4)}" width="8" height="8" fill="#fff" stroke="#0ea5e9" stroke-width="1.5"/>`);
          }
        }
      }
    }
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

    // guías de alineación
    if (this.guides?.length) {
      const ext = this.view.extent(0);
      for (const g of this.guides) {
        const a = g.axis === 'x' ? P(g.value, ext.minY) : P(ext.minX, g.value);
        const b = g.axis === 'x' ? P(g.value, ext.maxY) : P(ext.maxX, g.value);
        out.push(`<line x1="${r2(a[0])}" y1="${r2(a[1])}" x2="${r2(b[0])}" y2="${r2(b[1])}" stroke="#ec4899" stroke-width="1" stroke-dasharray="5 4" stroke-opacity="0.75"/>`);
        const [fx, fy] = P(g.from[0], g.from[1]);
        out.push(`<circle cx="${r2(fx)}" cy="${r2(fy)}" r="4" fill="none" stroke="#ec4899" stroke-width="1.5"/>`);
      }
    }

    // pincel de Suavizar
    if (this.tool === 'smooth' && this.hover?.brush) {
      const [bx, by] = this.hover.sp;
      out.push(`<circle cx="${r2(bx)}" cy="${r2(by)}" r="${this.settings.smoothRadius ?? 18}" fill="rgba(14,165,233,.08)" stroke="#0ea5e9" stroke-width="1.5" stroke-dasharray="3 3"/>`);
    }

    // Deform: área de influencia (donde se tomó, mientras se arrastra) y cuánto se movió cada nodo
    if (this.tool === 'drag') {
      // nodos de las formas seleccionadas: se toma uno para arrastrar
      for (const s of this.selectedShapes()) {
        if (s.type !== 'path' || s.locked) continue;
        for (const ring of [-1, ...(s.holes || []).map((_, i) => i)]) {
          this.ringNodes(s, ring).forEach((n, i) => {
            const [x, y] = P(n.x, n.y);
            const a = this.activeNode && this.activeNode.id === s.id && this.activeNode.ring === ring && this.activeNode.index === i;
            out.push(`<rect x="${r2(x - 4.5)}" y="${r2(y - 4.5)}" width="9" height="9" fill="${a ? '#a855f7' : '#fff'}" stroke="#a855f7" stroke-width="1.5"/>`);
          });
        }
      }
    }
    if (this.drag?.mode === 'deform' && this.drag.snapTo) {
      const [x, y] = P(this.drag.snapTo[0], this.drag.snapTo[1]);
      out.push(`<rect x="${r2(x - 7)}" y="${r2(y - 7)}" width="14" height="14" fill="none" stroke="#db2777" stroke-width="2"/>`);
    }
    if (this.tool === 'deform' || this.drag?.mode === 'deform') {
      const dd = this.drag?.mode === 'deform' ? this.drag : null;
      const R = this.settings.deformRadius ?? 60;
      const at = this.tool !== 'deform' ? null : dd ? P(dd.start[0], dd.start[1]) : this.hover?.brush ? this.hover.sp : null;
      if (at) out.push(`<circle cx="${r2(at[0])}" cy="${r2(at[1])}" r="${R}" fill="rgba(168,85,247,.07)" stroke="#a855f7" stroke-width="1.5" stroke-dasharray="4 3"/>`);
      if (dd?.moved) {
        const moves = dd.prep.moves.length > 600 ? dd.prep.moves.filter((_, i) => i % Math.ceil(dd.prep.moves.length / 600) === 0) : dd.prep.moves;
        for (const m of moves) {
          if (m.w < 0.04) continue;
          const [x0, y0] = P(m.x, m.y);
          const [x1, y1] = P(m.x + m.w * dd.dx, m.y + m.w * dd.dy);
          const L = Math.hypot(x1 - x0, y1 - y0);
          if (L < 2) continue;
          const ux = (x1 - x0) / L;
          const uy = (y1 - y0) / L;
          const k = Math.min(6, L * 0.4);
          out.push(`<circle cx="${r2(x0)}" cy="${r2(y0)}" r="2" fill="#a855f7" opacity=".6"/>`);
          out.push(`<path d="M${r2(x0)} ${r2(y0)}L${r2(x1)} ${r2(y1)}M${r2(x1 - k * (ux - uy * 0.5))} ${r2(y1 - k * (uy + ux * 0.5))}L${r2(x1)} ${r2(y1)}L${r2(x1 - k * (ux + uy * 0.5))} ${r2(y1 - k * (uy - ux * 0.5))}" fill="none" stroke="#a855f7" stroke-width="1.3" stroke-linecap="round" opacity="${r2(0.35 + 0.65 * m.w)}"/>`);
        }
      }
    }

    // borrador de pluma/polígono
    if (this.draft) {
      const nodes = this.draft.nodes;
      let d = nodesD(nodes, false, P);
      // el borrador toma el color del trazo (o, si no hay trazo, el del relleno)
      const cs = this.getCurrentStyle();
      const color = esc(cs.stroke !== 'none' ? cs.stroke : cs.fill && cs.fill !== 'none' ? cs.fill : '#0ea5e9');
      const w = Math.max(1, cs.strokeWidth * units.mmToPx);
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
        if (last.hOut && !this.drag) {
          // el tramo que se está por poner ya sale curvo por la manija del último nodo
          const [cx, cy] = P(last.hOut.x, last.hOut.y);
          out.push(`<path d="M${r2(lx)} ${r2(ly)}C${r2(cx)} ${r2(cy)} ${r2(hx)} ${r2(hy)} ${r2(hx)} ${r2(hy)}" fill="none" stroke="${color}" stroke-width="${r2(w)}" stroke-dasharray="5 4" opacity="0.7"/>`);
        } else out.push(`<line x1="${r2(lx)}" y1="${r2(ly)}" x2="${r2(hx)}" y2="${r2(hy)}" stroke="${color}" stroke-width="${r2(w)}" stroke-dasharray="5 4" opacity="0.7"/>`);
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
      // manijas de curvatura de los nodos puestos (las del último, más vivas): así se ve qué se arrastra
      nodes.forEach((n, i) => {
        const live = i === nodes.length - 1;
        const [x, y] = P(n.x, n.y);
        for (const hk of ['hIn', 'hOut']) {
          if (!n[hk]) continue;
          const [hx, hy] = P(n[hk].x, n[hk].y);
          out.push(`<line x1="${r2(x)}" y1="${r2(y)}" x2="${r2(hx)}" y2="${r2(hy)}" stroke="#f59e0b" stroke-width="1.5" opacity="${live ? 1 : 0.55}"/>`);
          out.push(`<circle cx="${r2(hx)}" cy="${r2(hy)}" r="${live ? 5 : 3.5}" fill="#f59e0b" stroke="#fff" stroke-width="1.5" opacity="${live ? 1 : 0.7}"/>`);
        }
      });
    }

    // línea auxiliar del corte (Split) o del reshape mientras se arrastra
    if (this.drag?.mode === 'cutline' && this.drag.moved) {
      const pts = [...this.drag.pts, this.drag.end].filter(Boolean);
      const color = this.drag.kind === 'split' ? '#e11d48' : '#a855f7';
      out.push(`<path d="M${pts.map((q) => P(q[0], q[1]).map(r2).join(' ')).join('L')}" fill="none" stroke="#fff" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round" opacity=".85"/>`);
      out.push(`<path d="M${pts.map((q) => P(q[0], q[1]).map(r2).join(' ')).join('L')}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="6 4" stroke-linecap="round" stroke-linejoin="round"/>`);
      const [sx, sy] = P(pts[0][0], pts[0][1]);
      out.push(`<circle cx="${r2(sx)}" cy="${r2(sy)}" r="4.5" fill="${color}" stroke="#fff" stroke-width="1.5"/>`);
      const [ex, ey] = P(pts[pts.length - 1][0], pts[pts.length - 1][1]);
      out.push(`<circle cx="${r2(ex)}" cy="${r2(ey)}" r="4.5" fill="#fff" stroke="${color}" stroke-width="2"/>`);
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
    // nodos congelados de lo seleccionado: un rombo oscuro con borde blanco
    for (const s of this.selectedShapes()) {
      if (s.type !== 'path') continue;
      for (const ring of [-1, ...(s.holes || []).map((_, i) => i)]) {
        for (const n of this.ringNodes(s, ring)) {
          if (!n.frozen) continue;
          const [x, y] = P(n.x, n.y);
          out.push(`<path d="M${r2(x)} ${r2(y - 7)}L${r2(x + 7)} ${r2(y)}L${r2(x)} ${r2(y + 7)}L${r2(x - 7)} ${r2(y)}Z" fill="#1e3a8a" stroke="#fff" stroke-width="1.5"/>`);
          out.push(`<circle cx="${r2(x)}" cy="${r2(y)}" r="1.8" fill="#fff"/>`);
        }
      }
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
