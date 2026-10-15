/**
 * Composición de un texto: líneas, ajuste al ancho del cuadro, justificado,
 * espaciados e interlineado. Es la base común de lo que se dibuja (style.js),
 * de la caja que se selecciona (editor), de lo que se toca (hit.js) y de las
 * cajas de texto del layout.
 *
 * Campos del texto (todos opcionales, con compatibilidad hacia atrás):
 *   align          'left' | 'center' | 'right' | 'justify'  (si falta, sale de `anchor`)
 *   boxWidth       mm de papel; >0 = cuadro de texto con ajuste de línea
 *   lineHeight     múltiplo del tamaño (1,2 por defecto)
 *   letterSpacing  milésimas de em entre letras (como el «tracking» de Illustrator)
 *   wordSpacing    milésimas de em extra entre palabras
 *
 * Sin `boxWidth` el texto es «de punto»: `x, y` es el ancla (inicio, centro o
 * fin del renglón según `anchor`). Con `boxWidth` es «de área»: `x` es el borde
 * izquierdo del cuadro y la alineación se aplica dentro de él. En ambos `y` es
 * la línea base del primer renglón.
 *
 * Los espacios se respetan: una tanda de varios espacios (y los de los
 * extremos) se escribe con espacios duros, que ningún visor colapsa.
 *
 * Todo es independiente de las unidades: `fs` es el tamaño de letra y `mmUnit`
 * las unidades de salida por mm de papel, y `measure(texto, fs)` mide un renglón.
 */

export const NBSP = ' ';

/** Espacios que no se colapsan: las tandas de 2 o más y los de los extremos. */
export function hardSpaces(s) {
  return String(s).replace(/ {2,}|^ | $/g, (m) => NBSP.repeat(m.length));
}

export function alignOf(shape) {
  if (shape.align) return shape.align;
  return shape.anchor === 'middle' ? 'center' : shape.anchor === 'end' ? 'right' : 'left';
}

/** `text-anchor` de SVG para un texto sin cuadro (respeta `anchor` si no hay `align`). */
export function anchorOf(shape) {
  const a = alignOf(shape);
  return a === 'center' ? 'middle' : a === 'right' ? 'end' : 'start';
}

/**
 * @returns {{
 *   lines: {t: string, w: number, words?: {t: string, x: number}[]}[],
 *   boxed: boolean, boxW: number, width: number, height: number,
 *   x0: number, top: number, lh: number, track: number, align: string
 * }} medidas en las unidades de salida; `x0` y `top` son el borde izquierdo y
 *   superior del cuadro RESPECTO DEL ANCLA (x, y de la forma), sin rotar.
 */
export function layoutText(shape, fs, mmUnit, measure) {
  const align = alignOf(shape);
  const boxW = shape.boxWidth > 0 ? shape.boxWidth * mmUnit : 0;
  const boxed = boxW > 0;
  const lh = (shape.lineHeight > 0 ? shape.lineHeight : 1.2) * fs;
  const track = ((shape.letterSpacing || 0) / 1000) * fs;
  const wordGap = ((shape.wordSpacing || 0) / 1000) * fs;
  const meas = (s) => {
    if (!s) return 0;
    const spaces = (s.match(/ /g) || []).length;
    return measure(hardSpaces(s), fs) + track * s.length + wordGap * spaces;
  };

  const lines = [];
  for (const para of String(shape.text ?? '').split('\n')) {
    if (!boxed) {
      lines.push({ t: para, w: meas(para) });
      continue;
    }
    // ajuste de línea: se corta en los espacios, y una palabra más larga que el cuadro queda entera
    const tokens = para.split(/( +)/);
    let line = '';
    let pending = '';
    for (const tok of tokens) {
      if (!tok) continue;
      if (/^ +$/.test(tok)) {
        pending = tok;
        continue;
      }
      const cand = line ? line + pending + tok : pending + tok;
      if (line && meas(cand) > boxW) {
        lines.push({ t: line, w: meas(line) });
        line = tok;
      } else line = cand;
      pending = '';
    }
    lines.push({ t: line + pending, w: meas(line + pending) });
    // el último renglón de un párrafo no se justifica
    lines[lines.length - 1].last = true;
  }
  if (!boxed) for (const l of lines) l.last = true;

  if (boxed && align === 'justify') {
    for (const l of lines) {
      if (l.last) continue;
      const words = l.t.split(/ +/).filter(Boolean);
      if (words.length < 2) continue;
      const ws = words.map((w) => meas(w));
      const gap = Math.max(0, (boxW - ws.reduce((a, b) => a + b, 0)) / (words.length - 1));
      let x = 0;
      l.words = words.map((t, i) => {
        const o = { t, x };
        x += ws[i] + gap;
        return o;
      });
      l.w = boxW;
    }
  }

  const width = boxed ? boxW : Math.max(0, ...lines.map((l) => l.w));
  const height = fs * 0.95 + (lines.length - 1) * lh + fs * 0.25;
  const x0 = boxed ? 0 : align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
  return { lines, boxed, boxW, width, height, x0, top: -fs * 0.95, lh, track, wordGap, align };
}

/**
 * Esquinas de la caja del texto, ya giradas y trasladadas, a partir del ancla
 * `(ax, ay)` y la rotación (° horarios en pantalla; eje y hacia abajo).
 * Devuelve [nw, ne, se, sw] más `center`.
 */
export function textCorners(m, ax, ay, rotation = 0) {
  const a = (rotation * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const rot = (x, y) => [ax + x * c - y * s, ay + x * s + y * c];
  const x0 = m.x0;
  const x1 = m.x0 + m.width;
  const y0 = m.top;
  const y1 = m.top + m.height;
  return { corners: [rot(x0, y0), rot(x1, y0), rot(x1, y1), rot(x0, y1)], center: rot((x0 + x1) / 2, (y0 + y1) / 2), rot };
}

/** Ancho de un renglón con la fuente real (lienzo); sin lienzo, una estimación. */
let measureCtx = null;
export function measureText(text, fontPx, family, weight = 400, italic = false) {
  try {
    if (!measureCtx && typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(1, 1).getContext('2d');
    if (!measureCtx && typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d');
  } catch {
    measureCtx = null;
  }
  if (!measureCtx) return text.length * fontPx * 0.56;
  measureCtx.font = `${italic ? 'italic ' : ''}${weight} ${fontPx}px ${family}`;
  return measureCtx.measureText(text).width;
}

/** Estimación sin lienzo (pruebas y cajas aproximadas): 0,56 em por carácter. */
export const approxMeasure = (t, fs) => t.length * fs * 0.56;
