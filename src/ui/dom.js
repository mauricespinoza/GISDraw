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

/**
 * Campo numérico. Con `slide: [mín, máx]` (o `{ min, max, log }`) lleva un
 * deslizador emergente: `oninput` en vivo (si se da) y `onchange` al soltar.
 */
export function num(value, onchange, { step = 'any', min, max, width, slide, log = false, oninput } = {}) {
  const i = h('input', { type: 'number', step, value: value ?? '', inputmode: 'decimal' });
  if (min != null) i.min = min;
  if (max != null) i.max = max;
  if (width) i.style.flex = `0 0 ${width}px`;
  i.addEventListener('change', () => {
    const v = Number(i.value.replace(',', '.'));
    if (Number.isFinite(v)) onchange(v);
  });
  if (slide) {
    const [lo, hi] = Array.isArray(slide) ? slide : [slide.min, slide.max];
    const d = String(step).includes('.') ? String(step).split('.')[1].length : 0;
    popSlider(i, {
      min: lo,
      max: hi,
      step: typeof step === 'number' ? step : 'any',
      log: log || !!slide.log,
      get: () => Number(String(i.value).replace(',', '.')) || lo,
      fmt: (v) => (step === 'any' ? String(Number(v.toPrecision(4))) : v.toFixed(d)),
      oninput,
      onchange,
    });
  }
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

/**
 * Deslizador emergente bajo un campo numérico (barra de propiedades, zoom):
 * aparece al tocar el campo y se cierra al tocar fuera o con Enter / Esc.
 * `oninput` en vivo, `onchange` al soltar (un solo paso en el historial).
 * `log`: para magnitudes que crecen por factores (grosor, letra, zoom).
 */
const openPops = new Set();

/** Cierra los deslizadores emergentes abiertos (al reconstruir un panel). */
export function closePopSliders() {
  for (const close of [...openPops]) close();
}

export function popSlider(input, { min, max, step = 'any', log = false, get, fmt = (v) => String(v), oninput, onchange, onclose, cls = '' }) {
  let pop = null;
  // min / max pueden ser funciones (el zoom cambia de rango según el modo)
  const lo = () => (typeof min === 'function' ? min() : min);
  const hi = () => (typeof max === 'function' ? max() : max);
  const clamp = (v) => Math.min(hi(), Math.max(lo(), Number.isFinite(v) ? v : lo()));
  const toR = (v) => (log ? Math.log(clamp(v)) : clamp(v));
  const fromR = (r) => {
    let v = log ? Math.exp(r) : r;
    if (typeof step === 'number') v = Math.round(v / step) * step;
    return clamp(Number(v.toPrecision(6)));
  };
  const outside = (e) => {
    if (pop && !pop.contains(e.target) && e.target !== input) close();
  };
  function close() {
    if (!pop) return;
    pop.remove();
    pop = null;
    openPops.delete(close);
    document.removeEventListener('pointerdown', outside, true);
    onclose?.();
  }
  function open() {
    if (pop) return;
    const r = h('input', { type: 'range', min: toR(lo()), max: toR(hi()), step: log ? 'any' : step, value: toR(get()), 'aria-label': input.getAttribute('data-tip') || '' });
    pop = h('div', { class: `pop-slider ${cls}`.trim() }, h('span', {}, fmt(lo())), r, h('span', {}, fmt(hi())));
    r.addEventListener('input', () => {
      const v = fromR(Number(r.value));
      input.value = fmt(v);
      oninput?.(v);
    });
    r.addEventListener('change', () => onchange?.(fromR(Number(r.value))));
    document.body.append(pop);
    const b = input.getBoundingClientRect();
    const w = pop.offsetWidth;
    pop.style.left = `${Math.max(6, Math.min(b.left + b.width / 2 - w / 2, window.innerWidth - w - 6))}px`;
    pop.style.top = `${b.bottom + 6}px`;
    document.addEventListener('pointerdown', outside, true);
    openPops.add(close);
  }
  input.addEventListener('focus', open);
  input.addEventListener('pointerdown', open);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'Escape') close();
  });
  input.addEventListener('input', () => {
    const v = Number(String(input.value).replace(',', '.'));
    const r = pop?.querySelector('input');
    if (r && Number.isFinite(v)) r.value = toR(v);
  });
  return { open, close, get isOpen() { return !!pop; } };
}

/** ¿Hay un deslizador emergente abierto (de la clase `cls`)? Mientras tanto no se reconstruye su barra. */
export const popSliderOpen = (cls = '') => !!document.querySelector(`.pop-slider${cls ? `.${cls}` : ''}`);
