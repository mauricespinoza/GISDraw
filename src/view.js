/**
 * La vista: qué pedazo del mundo UTM cae en la pantalla.
 *
 * Es un estado mínimo —centro en metros y metros por píxel— y no hay rotación:
 * el norte de la cuadrícula UTM queda siempre arriba, que es lo que se espera
 * de un dibujo cartográfico. La convergencia de meridianos la muestra el norte
 * del layout, no la vista.
 */

/** Pantallas CSS: 96 px por pulgada. */
export const PX_PER_M = 96 / 0.0254;

export class View {
  constructor(width = 800, height = 600) {
    this.cx = 346000; // Santiago, por defecto
    this.cy = 6297000;
    this.mpp = 25; // metros por píxel
    this.w = width;
    this.h = height;
    this.listeners = new Set();
  }

  onChange(f) {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  emit() {
    for (const f of this.listeners) f(this);
  }

  resize(w, h) {
    this.w = w;
    this.h = h;
    this.emit();
  }

  /** mundo -> pantalla */
  toScreen(x, y) {
    return [this.w / 2 + (x - this.cx) / this.mpp, this.h / 2 - (y - this.cy) / this.mpp];
  }

  /** pantalla -> mundo */
  toWorld(sx, sy) {
    return [this.cx + (sx - this.w / 2) * this.mpp, this.cy - (sy - this.h / 2) * this.mpp];
  }

  /** Extensión visible {minX, minY, maxX, maxY} con margen en píxeles. */
  extent(pad = 0) {
    const [minX, maxY] = this.toWorld(-pad, -pad);
    const [maxX, minY] = this.toWorld(this.w + pad, this.h + pad);
    return { minX, minY, maxX, maxY };
  }

  /** Denominador de escala en pantalla (1:N), suponiendo 96 dpi. */
  get scale() {
    return this.mpp * PX_PER_M;
  }

  setScale(denominator) {
    this.mpp = denominator / PX_PER_M;
    this.emit();
  }

  zoomAt(factor, sx = this.w / 2, sy = this.h / 2) {
    const [wx, wy] = this.toWorld(sx, sy);
    this.mpp = Math.min(20000, Math.max(0.002, this.mpp * factor));
    // el punto bajo el cursor no se mueve
    this.cx = wx - (sx - this.w / 2) * this.mpp;
    this.cy = wy + (sy - this.h / 2) * this.mpp;
    this.emit();
  }

  panBy(dxPx, dyPx) {
    this.cx -= dxPx * this.mpp;
    this.cy += dyPx * this.mpp;
    this.emit();
  }

  fit(box, pad = 40) {
    if (!box || !(box.w >= 0)) return;
    this.cx = box.x + box.w / 2;
    this.cy = box.y + box.h / 2;
    const sx = box.w / Math.max(1, this.w - 2 * pad);
    const sy = box.h / Math.max(1, this.h - 2 * pad);
    this.mpp = Math.max(0.01, sx, sy, 0.05);
    this.emit();
  }

  snapshot() {
    return { cx: this.cx, cy: this.cy, mpp: this.mpp, w: this.w, h: this.h };
  }
}

/**
 * Conversión de unidades de papel a píxeles de pantalla para una escala de
 * referencia: 1 mm en el papel a 1:S son S mm de terreno.
 */
export function paperUnits(view, refScale) {
  const mmToM = refScale / 1000;
  const mmToPx = mmToM / view.mpp;
  return { mmToPx, ptToPx: mmToPx * 0.352778, mmToM, ptToM: mmToM * 0.352778 };
}
