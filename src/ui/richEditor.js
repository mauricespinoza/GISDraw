/**
 * Editor de texto con formato por segmentos, sobre el propio mapa o la hoja
 * del layout: se escribe y se selecciona parte del texto para cambiarle el
 * color, el tamaño, la negrita o la cursiva sin tocar el resto.
 *
 * El texto editable es un `contenteditable` cuyos trozos formateados son
 * `<span data-c data-s data-b data-i>`. La fuente de verdad es el modelo
 * `{ text, runs }` de richText.js: al aplicar un formato se calcula sobre el
 * modelo (con los índices de la selección) y se vuelve a dibujar el DOM, así
 * la lógica es la misma que prueba el resto de la app y no depende de
 * `execCommand`.
 *
 * Cierra con Enter (Mayús+Enter = salto de línea) o Ctrl+Enter, guarda;
 * Esc cancela; tocar fuera guarda. NO cierra al perder el foco: el selector
 * de color y la caja de tamaño de la barra se lo quitan sin querer cerrar.
 */

import { applyRun, effectiveScale, normalizeRuns, runAt, scaleRuns } from '../richText.js';
import { h } from './dom.js';

const NBSP = / |​/g;

/* ---------------------------------------------------------------- DOM <-> modelo */

/** Estilo de un <span> del editor. */
function styleOf(el, inherited) {
  const st = { ...inherited };
  if (el.dataset?.c) st.color = el.dataset.c;
  if (el.dataset?.s) st.scale = Number(el.dataset.s);
  if (el.dataset?.b !== undefined && el.dataset.b !== '') st.bold = el.dataset.b === '1';
  if (el.dataset?.i !== undefined && el.dataset.i !== '') st.italic = el.dataset.i === '1';
  return st;
}

/** Lee `{ text, runs }` de un nodo del editor (o de un fragmento clonado). */
export function readModel(root) {
  let text = '';
  const runs = [];
  const add = (t, st) => {
    if (!t) return;
    const hasSt = st.color || st.scale || st.bold !== undefined || st.italic !== undefined;
    if (hasSt) runs.push({ s: text.length, e: text.length + t.length, ...st });
    text += t;
  };
  const walk = (node, st, top) => {
    for (const c of node.childNodes) {
      if (c.nodeType === 3) add(c.data.replace(NBSP, (m) => (m === '​' ? '' : ' ')), st);
      else if (c.nodeName === 'BR') {
        if (!c.dataset?.x) add('\n', st);
      } else if (c.nodeType === 1) {
        const block = /^(DIV|P)$/.test(c.nodeName);
        if (block && text && !text.endsWith('\n')) add('\n', st);
        walk(c, styleOf(c, st), false);
      }
    }
    void top;
  };
  walk(root, {}, true);
  return { text, runs: normalizeRuns(runs, text.length) };
}

/** Dibuja el modelo en el editor. */
export function renderModel(root, text, runs) {
  root.replaceChildren();
  const cuts = new Set([0, text.length]);
  for (const r of runs) {
    cuts.add(r.s);
    cuts.add(r.e);
  }
  const pts = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    const st = runAt(runs, a);
    const parts = text.slice(a, b).split('\n');
    parts.forEach((part, k) => {
      if (k > 0) root.append(document.createElement('br'));
      if (!part) return;
      const hasSt = st.color || st.scale || st.bold !== undefined || st.italic !== undefined;
      if (!hasSt) return root.append(document.createTextNode(part));
      const span = h('span', {});
      if (st.color) {
        span.dataset.c = st.color;
        span.style.color = st.color;
      }
      if (st.scale) {
        span.dataset.s = String(st.scale);
        span.style.fontSize = `${st.scale}em`;
      }
      if (st.bold !== undefined) {
        span.dataset.b = st.bold ? '1' : '0';
        span.style.fontWeight = st.bold ? '700' : '400';
      }
      if (st.italic !== undefined) {
        span.dataset.i = st.italic ? '1' : '0';
        span.style.fontStyle = st.italic ? 'italic' : 'normal';
      }
      span.textContent = part;
      root.append(span);
    });
  }
  // un salto de línea al final necesita un <br> más para que el cursor tenga dónde ir
  if (text.endsWith('\n') || !text) {
    const br = document.createElement('br');
    br.dataset.x = '1';
    root.append(br);
  }
}

/** Índice de texto de un punto (nodo, desplazamiento) del editor. */
function offsetOf(root, node, off) {
  const r = document.createRange();
  r.selectNodeContents(root);
  r.setEnd(node, off);
  const holder = document.createElement('div');
  holder.append(r.cloneContents());
  return readModel(holder).text.length;
}

/** Punto (nodo, desplazamiento) del editor para un índice de texto. */
function locate(root, target) {
  let remaining = target;
  let result = null;
  const visit = (n) => {
    for (let i = 0; i < n.childNodes.length; i++) {
      if (result) return;
      const c = n.childNodes[i];
      if (c.nodeType === 3) {
        if (remaining <= c.data.length) {
          result = [c, remaining];
          return;
        }
        remaining -= c.data.length;
      } else if (c.nodeName === 'BR') {
        if (c.dataset?.x) continue;
        if (remaining === 0) {
          result = [n, i];
          return;
        }
        remaining -= 1;
      } else if (c.nodeType === 1) visit(c);
    }
  };
  visit(root);
  return result || [root, root.childNodes.length];
}

function selectOffsets(root, a, b) {
  const [n1, o1] = locate(root, a);
  const [n2, o2] = locate(root, b);
  const r = document.createRange();
  r.setStart(n1, o1);
  r.setEnd(n2, o2);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/* --------------------------------------------------------------- el editor */

/**
 * @param {object} o
 * @param {HTMLElement} o.host       contenedor donde se coloca (posición absoluta)
 * @param {{left:number, top:number, width:number}} o.rect  posición en el contenedor (px)
 * @param {object} o.shape           texto: { text, runs, fontFamily, fontWeight, italic, align, lineHeight, letterSpacing, fontSize }
 * @param {number} o.fontPx          tamaño de letra del editor en px
 * @param {string} o.color           color base de la letra
 * @param {boolean} [o.isNew]
 * @param {(res: {text: string, runs: object[]}|null) => void} o.onDone  null = cancelado
 */
export function openRichEditor({ host, rect, shape, fontPx, color, isNew = false, onDone }) {
  let text = String(shape.text ?? '');
  let runs = normalizeRuns(shape.runs || [], text.length);
  const basePt = shape.fontSize || 10;
  let last = { start: text.length, end: text.length };

  const edit = h('div', { class: 'rt-edit', contenteditable: 'true', spellcheck: 'false', role: 'textbox', 'aria-multiline': 'true' });
  Object.assign(edit.style, {
    fontSize: `${fontPx}px`,
    fontFamily: shape.fontFamily,
    fontWeight: shape.fontWeight || 400,
    fontStyle: shape.italic ? 'italic' : 'normal',
    lineHeight: String(shape.lineHeight || 1.2),
    letterSpacing: `${((shape.letterSpacing || 0) / 1000) * fontPx}px`,
    textAlign: shape.align === 'justify' ? 'justify' : shape.align || (shape.anchor === 'middle' ? 'center' : shape.anchor === 'end' ? 'right' : 'left'),
    color,
  });
  renderModel(edit, text, runs);

  /* --- barra de formato --- */
  const colorIn = h('input', { type: 'color', class: 'rt-color', title: 'Color del texto seleccionado', value: /^#[0-9a-f]{6}$/i.test(color) ? color : '#111827' });
  const sizeIn = h('input', { type: 'number', class: 'rt-size', min: 1, step: 0.5, title: 'Tamaño (pt) del texto seleccionado' });
  const btn = (label, title, onclick, cls = '') => {
    const b = h('button', { type: 'button', class: `rt-btn ${cls}`, title }, label);
    b.addEventListener('mousedown', (e) => e.preventDefault()); // no quitar la selección del texto
    b.addEventListener('click', onclick);
    return b;
  };
  const boldB = btn('B', 'Negrita', () => toggle('bold'), 'b');
  const italicB = btn('I', 'Cursiva', () => toggle('italic'), 'i');
  const hint = h('span', { class: 'rt-hint' }, 'Selecciona parte del texto');
  const bar = h(
    'div',
    { class: 'rt-bar' },
    colorIn,
    sizeIn,
    h('span', { class: 'rt-u' }, 'pt'),
    btn('A−', 'Más pequeño', () => scale(0.9)),
    btn('A+', 'Más grande', () => scale(1.1)),
    boldB,
    italicB,
    btn('Aa', 'Quitar el formato de la selección', () => patch({ color: null, scale: null, bold: null, italic: null })),
    hint,
    btn('✓', 'Aceptar (Enter)', () => close(true), 'ok'),
    btn('✕', 'Cancelar (Esc)', () => close(false)),
  );
  const wrap = h('div', { class: 'rt-wrap' }, bar, edit);
  Object.assign(wrap.style, { left: `${rect.left}px`, top: `${Math.max(4, rect.top - 44)}px`, width: `${Math.max(240, rect.width)}px` });
  host.append(wrap);

  /* --- selección y modelo --- */
  const sync = () => {
    ({ text, runs } = readModel(edit));
  };
  const selection = () => {
    const sel = window.getSelection();
    if (sel.rangeCount && edit.contains(sel.anchorNode)) {
      const r = sel.getRangeAt(0);
      last = { start: offsetOf(edit, r.startContainer, r.startOffset), end: offsetOf(edit, r.endContainer, r.endOffset) };
    }
    return last;
  };
  /** Rango al que se aplica un formato: la selección, o todo el texto si no hay selección. */
  const target = () => {
    sync();
    const { start, end } = selection();
    return end > start ? { start, end, all: false } : { start: 0, end: text.length, all: true };
  };
  const refreshBar = () => {
    sync();
    const { start, end } = selection();
    const i = Math.min(Math.max(0, start), Math.max(0, text.length - 1));
    const st = runAt(runs, i);
    colorIn.value = /^#[0-9a-f]{6}$/i.test(st.color || '') ? st.color : /^#[0-9a-f]{6}$/i.test(color) ? color : '#111827';
    if (document.activeElement !== sizeIn) sizeIn.value = String(+(basePt * (st.scale || 1)).toFixed(1));
    boldB.classList.toggle('on', st.bold !== undefined ? st.bold : (shape.fontWeight || 400) >= 600);
    italicB.classList.toggle('on', st.italic !== undefined ? st.italic : !!shape.italic);
    hint.textContent = end > start ? `${end - start} letra(s) seleccionada(s)` : 'Sin selección: afecta a todo el texto';
  };
  const commit = (newRuns, t) => {
    runs = normalizeRuns(newRuns, text.length);
    renderModel(edit, text, runs);
    selectOffsets(edit, t.all ? t.end : t.start, t.end);
    last = { start: t.all ? t.end : t.start, end: t.end };
    edit.focus({ preventScroll: true });
    refreshBar();
  };
  function patch(p) {
    const t = target();
    commit(applyRun(runs, t.start, t.end, p, text.length), t);
  }
  function scale(f) {
    const t = target();
    commit(scaleRuns(runs, t.start, t.end, f, text.length), t);
  }
  function toggle(key) {
    const t = target();
    const base = key === 'bold' ? (shape.fontWeight || 400) >= 600 : !!shape.italic;
    let all = true;
    for (let i = t.start; i < t.end; i++) if ((runAt(runs, i)[key] ?? base) !== true) all = false;
    commit(applyRun(runs, t.start, t.end, { [key]: !all }, text.length), t);
  }

  colorIn.addEventListener('input', () => patch({ color: colorIn.value }));
  sizeIn.addEventListener('change', () => {
    const pt = Number(sizeIn.value);
    if (pt > 0) patch({ scale: Math.round((pt / basePt) * 1000) / 1000 });
  });
  sizeIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      sizeIn.blur();
      sizeIn.dispatchEvent(new Event('change'));
    }
  });
  document.addEventListener('selectionchange', refreshBar);
  edit.addEventListener('input', () => {
    sync();
    refreshBar();
  });
  edit.addEventListener('paste', (e) => {
    e.preventDefault();
    const t = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, t);
  });

  let closed = false;
  function close(save) {
    if (closed) return;
    closed = true;
    document.removeEventListener('selectionchange', refreshBar);
    document.removeEventListener('pointerdown', outside, true);
    sync();
    const res = { text, runs };
    wrap.remove();
    onDone(save ? res : null, isNew);
  }
  const outside = (e) => {
    if (!wrap.contains(e.target)) close(true);
  };
  edit.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) document.execCommand('insertLineBreak');
      else close(true);
    }
  });
  // un instante después de abrir: el clic que lo abrió no debe cerrarlo
  setTimeout(() => document.addEventListener('pointerdown', outside, true), 0);

  edit.focus({ preventScroll: true });
  if (isNew) selectOffsets(edit, 0, text.length);
  else selectOffsets(edit, text.length, text.length);
  refreshBar();
  return { close, edit, wrap, patch, scale, toggle, model: () => ({ ...readModel(edit) }), setSelection: (a, b) => selectOffsets(edit, a, b), refreshBar, effectiveScale };
}
