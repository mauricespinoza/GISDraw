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

import { hasRuns, styleArray } from './richText.js';

export const NBSP = '\u00A0';

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
 *   lines: {t: string, w: number, pieces: {t: string, st: object}[], ms: number, adv: number,
 *           words?: {t: string, x: number, pieces: object[]}[], last?: boolean}[],
 *   boxed: boolean, boxW: number, width: number, height: number,
 *   x0: number, top: number, lh: number, track: number, align: string
 * }} medidas en las unidades de salida; `x0` y `top` son el borde izquierdo y
 *   superior del cuadro RESPECTO DEL ANCLA (x, y de la forma), sin rotar.
 *   Cada renglón se reparte en `pieces`: trozos de un mismo formato (`st` es el
 *   tramo de `runs` o `{}`); `ms` es el mayor `scale` del renglón y `adv` lo
 *   que baja su línea base respecto de la del renglón anterior.
 *
 * `measure(texto, tamaño, st)` mide un trozo; `st` puede traer `bold` / `italic`.
 */
export function layoutText(shape, fs, mmUnit, measure) {
  const align = alignOf(shape);
  const boxW = shape.boxWidth > 0 ? shape.boxWidth * mmUnit : 0;
  const boxed = boxW > 0;
  const lhMul = shape.lineHeight > 0 ? shape.lineHeight : 1.2;
  const lh = lhMul * fs;
  const track = ((shape.letterSpacing || 0) / 1000) * fs;
  const wordGap = ((shape.wordSpacing || 0) / 1000) * fs;
  const text = String(shape.text ?? '');
  const styles = hasRuns(shape) ? styleArray(shape.runs, text.length) : null;
  const NONE = {};
  const st = (i) => (styles ? styles[i] || NONE : NONE);

  /** Trozos de formato uniforme de text[a, a+len). */
  const piecesOf = (a, len) => {
    const out = [];
    for (let k = 0; k < len; k++) {
      const cur = st(a + k);
      const last = out[out.length - 1];
      if (last && last.st === cur) last.t += text[a + k];
      else out.push({ t: text[a + k], st: cur });
    }
    return out;
  };
  const measPiece = (pc) => {
    if (!pc.t) return 0;
    const sc = pc.st.scale || 1;
    const spaces = (pc.t.match(/ /g) || []).length;
    return measure(hardSpaces(pc.t), fs * sc, pc.st) + track * sc * pc.t.length + wordGap * sc * spaces;
  };
  const measPieces = (pcs) => pcs.reduce((w, pc) => w + measPiece(pc), 0);
  const maxScale = (pcs) => pcs.reduce((m, pc) => Math.max(m, pc.st.scale || 1), 0) || 1;
  const joinPieces = (...lists) => {
    const out = [];
    for (const pc of lists.flat()) {
      const last = out[out.length - 1];
      if (last && last.st === pc.st) last.t += pc.t;
      else out.push({ t: pc.t, st: pc.st });
    }
    return out;
  };
  const mkLine = (pcs, last) => ({ t: pcs.map((p) => p.t).join(''), w: measPieces(pcs), pieces: pcs, ms: maxScale(pcs), last });

  const lines = [];
  let base = 0;
  for (const para of text.split('\n')) {
    if (!boxed) {
      lines.push(mkLine(piecesOf(base, para.length), true));
    } else {
      // ajuste de línea: se corta en los espacios, y una palabra más larga que el cuadro queda entera
      const tokens = [];
      const re = / +|[^ ]+/g;
      let m;
      while ((m = re.exec(para))) tokens.push({ a: base + m.index, len: m[0].length, space: m[0][0] === ' ' });
      let line = [];
      let lineW = 0;
      let pending = null;
      for (const tok of tokens) {
        const pcs = piecesOf(tok.a, tok.len);
        if (tok.space) {
          pending = pcs;
          continue;
        }
        const withSp = line.length && pending ? joinPieces(line, pending, pcs) : joinPieces(line, pcs);
        const w = measPieces(withSp);
        if (line.length && w > boxW) {
          lines.push(mkLine(line, false));
          line = pcs;
          lineW = measPieces(pcs);
        } else {
          line = withSp;
          lineW = w;
        }
        pending = null;
      }
      void lineW;
      lines.push(mkLine(pending ? joinPieces(line, pending) : line, true));
    }
    base += para.length + 1;
  }

  if (boxed && align === 'justify') {
    for (const l of lines) {
      if (l.last) continue;
      // palabras con sus trozos (los espacios entre ellas se reparten)
      const words = [];
      let a = 0;
      for (const mm of l.t.matchAll(/[^ ]+/g)) {
        // posición de la palabra dentro del renglón → trozos
        const pcs = [];
        let pos = 0;
        for (const pc of l.pieces) {
          const lo = Math.max(mm.index, pos);
          const hi = Math.min(mm.index + mm[0].length, pos + pc.t.length);
          if (hi > lo) pcs.push({ t: pc.t.slice(lo - pos, hi - pos), st: pc.st });
          pos += pc.t.length;
        }
        words.push({ t: mm[0], pieces: pcs, w: measPieces(pcs) });
        a++;
      }
      void a;
      if (words.length < 2) continue;
      const gap = Math.max(0, (boxW - words.reduce((sum, w) => sum + w.w, 0)) / (words.length - 1));
      let x = 0;
      l.words = words.map((w) => {
        const o = { t: w.t, x, pieces: w.pieces };
        x += w.w + gap;
        return o;
      });
      l.w = boxW;
    }
  }

  // la línea base de cada renglón baja según su mayor tamaño
  lines.forEach((l, i) => {
    l.adv = i === 0 ? 0 : lh * l.ms;
  });
  const width = boxed ? boxW : Math.max(0, ...lines.map((l) => l.w));
  const ascent = fs * 0.95 * lines[0].ms;
  const height = ascent + lines.reduce((sum, l) => sum + l.adv, 0) + fs * 0.25 * lines[lines.length - 1].ms;
  const x0 = boxed ? 0 : align === 'center' ? -width / 2 : align === 'right' ? -width : 0;
  return { lines, boxed, boxW, width, height, x0, top: -ascent, lh, track, wordGap, align };
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
