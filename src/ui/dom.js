/** Mini-ayudas de DOM para los paneles (sin framework). */

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const sec = (title, ...children) => h('div', { class: 'sec' }, title ? h('h3', {}, title) : null, ...children);

export const row = (label, ...children) => h('div', { class: 'row' }, h('label', {}, label), ...children);

export function select(options, value, onchange) {
  const s = h('select', { onchange: (e) => onchange(e.target.value) });
  for (const [k, label] of Array.isArray(options) ? options.map((o) => [o, o]) : Object.entries(options)) {
    const o = h('option', { value: k }, label);
    if (String(k) === String(value)) o.selected = true;
    s.append(o);
  }
  return s;
}

/** Deslizador + valor. `oninput` en vivo, `onchange` al soltar (para el historial). */
export function slider({ min, max, step = 1, value, fmt = (v) => v, oninput, onchange }) {
  const val = h('span', { class: 'val' }, fmt(value));
  const r = h('input', { type: 'range', min, max, step, value });
  r.addEventListener('input', () => {
    val.textContent = fmt(Number(r.value));
    oninput?.(Number(r.value));
  });
  r.addEventListener('change', () => onchange?.(Number(r.value)));
  return [r, val];
}

export function num(value, onchange, { step = 'any', min, max, width } = {}) {
  const i = h('input', { type: 'number', step, value: value ?? '', inputmode: 'decimal' });
  if (min != null) i.min = min;
  if (max != null) i.max = max;
  if (width) i.style.flex = `0 0 ${width}px`;
  i.addEventListener('change', () => {
    const v = Number(i.value.replace(',', '.'));
    if (Number.isFinite(v)) onchange(v);
  });
  return i;
}

export function text(value, onchange, placeholder = '') {
  const i = h('input', { type: 'text', value: value ?? '', placeholder });
  i.addEventListener('change', () => onchange(i.value));
  return i;
}

export function color(value, oninput, onchange) {
  const i = h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value || '') ? value : '#000000' });
  i.addEventListener('input', () => oninput?.(i.value));
  i.addEventListener('change', () => (onchange || oninput)?.(i.value));
  return i;
}

export function check(label, value, onchange) {
  const i = h('input', { type: 'checkbox', checked: !!value, onchange: (e) => onchange(e.target.checked) });
  return h('label', { class: 'check' }, i, label);
}

export const btn = (label, onclick, cls = '') => h('button', { class: `btn ${cls}`, onclick, type: 'button' }, label);
