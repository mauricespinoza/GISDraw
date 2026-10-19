/**
 * Cuadros de diálogo propios, en lugar de `prompt` / `confirm` del navegador
 * (que en el iPad tapan la app, no validan y no dejan ver el resultado).
 *
 * - `askConfirm(mensaje)` → true / false
 * - `askText(título, valor)` → texto o null
 * - `askForm({ título, campos })` → objeto con los valores o null. Los campos
 *   numéricos con `min` y `max` llevan un deslizador junto al número;
 *   `onchange` recibe los valores en vivo (para previsualizar) y `validate`
 *   puede bloquear «Aceptar» con un mensaje.
 *
 * Enter acepta, Esc cancela, un toque fuera del cuadro cancela.
 */

import { h } from './dom.js';

let open = null;

function shell({ title, body, okLabel = 'Aceptar', cancelLabel = 'Cancelar', danger = false, onOk, onCancel, wide = false, live = false }) {
  open?.cancel();
  const err = h('p', { class: 'dlg-err', hidden: true });
  const ok = h('button', { class: `btn ${danger ? 'danger-fill' : 'primary'}`, type: 'submit' }, okLabel);
  const cancel = h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, cancelLabel);
  const form = h(
    'form',
    { class: `gdlg-card dlg-card${wide ? ' wide' : ''}`, novalidate: true },
    h('button', { class: 'gdlg-x', type: 'button', 'aria-label': 'Cerrar', onclick: () => done(false) }, '×'),
    title ? h('h2', {}, title) : null,
    h('div', { class: 'gdlg-body' }, body),
    err,
    h('div', { class: 'dlg-foot' }, cancelLabel ? cancel : null, ok),
  );
  const root = h('div', { class: `gdlg dlg${live ? ' live' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Diálogo' }, form);
  // con vista previa en vivo el fondo queda libre (se ve el dibujo) y no cierra
  if (!live) root.addEventListener('pointerdown', (e) => e.target === root && done(false));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = onOk?.();
    if (typeof msg === 'string') {
      err.textContent = msg;
      err.hidden = false;
      return;
    }
    done(true);
  });
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      done(false);
    }
    // que los atajos de la app (Supr, Ctrl+Z…) no actúen detrás del cuadro
    e.stopPropagation();
  };
  root.addEventListener('keydown', onKey);
  let closed = false;
  function done(accepted) {
    if (closed) return;
    closed = true;
    root.remove();
    if (open === handle) open = null;
    if (!accepted) onCancel?.();
  }
  const handle = { cancel: () => done(false), setError: (m) => ((err.textContent = m || ''), (err.hidden = !m)), ok };
  open = handle;
  document.body.append(root);
  requestAnimationFrame(() => (form.querySelector('input:not([type=range]):not([type=checkbox]), select, textarea') || ok).focus?.());
  return handle;
}

/** Pregunta sí / no. */
export function askConfirm(message, { title = '', ok = 'Aceptar', cancel = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    shell({ title, body: h('p', { class: 'dlg-msg' }, message), okLabel: ok, cancelLabel: cancel, danger, onOk: () => resolve(true), onCancel: () => resolve(false) });
  });
}

/** Un texto. `validate(v)` devuelve un mensaje de error o nada. */
export function askText(title, value = '', { label = '', placeholder = '', hint = '', ok = 'Aceptar', validate, preview } = {}) {
  return new Promise((resolve) => {
    const i = h('input', { type: 'text', value: value ?? '', placeholder, autocomplete: 'off', spellcheck: false });
    // `preview(v)`: lo que se entendió, en vivo bajo el campo
    const out = preview ? h('p', { class: 'dlg-preview' }) : null;
    const refresh = () => {
      if (out) out.textContent = preview(i.value.trim()) || '';
      handle?.setError('');
    };
    i.addEventListener('input', refresh);
    const body = [label ? h('label', { class: 'dlg-lbl' }, label, i) : i, out, hint ? h('p', { class: 'hint' }, hint) : null];
    requestAnimationFrame(() => i.select());
    let handle = null;
    handle = shell({
      title,
      body,
      okLabel: ok,
      onOk: () => {
        const v = i.value.trim();
        const msg = validate?.(v);
        if (msg) return msg;
        resolve(v);
      },
      onCancel: () => resolve(null),
    });
    refresh();
  });
}

const fmtNum = (v, step) => {
  const d = String(step).includes('.') ? String(step).split('.')[1].length : 0;
  return Number(v).toFixed(Math.min(d, 6));
};

/**
 * Formulario. Campos: `{ key, label, type: 'number'|'text'|'select'|'check',
 * value, min, max, step, unit, options, hint, log, when }` (`when(valores)`:
 * mostrar el campo solo si devuelve true). `live`: sin velo oscuro, para ver
 * la vista previa detrás. Un número con `min` y
 * `max` lleva deslizador (`log: true` para escalas que crecen por factores).
 */
export function askForm({ title, hint = '', fields, ok = 'Aceptar', validate, onchange, wide = false, live = false }) {
  return new Promise((resolve) => {
    const vals = Object.fromEntries(fields.map((f) => [f.key, f.value]));
    const shown = () => fields.forEach((f, i) => f.when && (rows[i].hidden = !f.when(vals)));
    const changed = () => {
      shown();
      const msg = validate?.({ ...vals });
      handle?.setError(msg || '');
      if (handle) handle.ok.disabled = !!msg;
      onchange?.({ ...vals });
    };
    const rows = fields.map((f) => {
      if (f.type === 'check') {
        const c = h('input', { type: 'checkbox', checked: !!f.value, onchange: () => ((vals[f.key] = c.checked), changed()) });
        return h('div', { class: 'dlg-row' }, h('label', { class: 'check' }, c, f.label), f.hint ? h('p', { class: 'hint' }, f.hint) : null);
      }
      if (f.type === 'select') {
        const s = h('select', { onchange: () => ((vals[f.key] = s.value), changed()) });
        for (const [k, label] of Object.entries(f.options)) s.append(h('option', { value: k, selected: String(k) === String(f.value) }, label));
        return h('div', { class: 'dlg-row' }, h('label', {}, f.label), s, f.hint ? h('p', { class: 'hint' }, f.hint) : null);
      }
      if (f.type === 'text') {
        const t = h('input', { type: 'text', value: f.value ?? '', placeholder: f.placeholder || '', autocomplete: 'off', spellcheck: false });
        t.addEventListener('input', () => ((vals[f.key] = t.value), changed()));
        return h('div', { class: 'dlg-row' }, h('label', {}, f.label), t, f.hint ? h('p', { class: 'hint' }, f.hint) : null);
      }
      // número, con deslizador si tiene rango
      const step = f.step ?? 'any';
      const n = h('input', { type: 'number', step, value: f.value ?? '', inputmode: 'decimal' });
      if (f.min != null) n.min = f.min;
      if (f.max != null) n.max = f.max;
      const hasRange = f.min != null && f.max != null;
      const toR = (v) => (f.log ? Math.log(Math.max(v, f.min)) : v);
      const fromR = (r) => (f.log ? Math.exp(r) : r);
      const r = hasRange ? h('input', { type: 'range', min: toR(f.min), max: toR(f.max), step: f.log ? 'any' : step, value: toR(Number(f.value) || f.min) }) : null;
      n.addEventListener('input', () => {
        const v = Number(String(n.value).replace(',', '.'));
        if (!Number.isFinite(v)) return;
        vals[f.key] = v;
        if (r) r.value = toR(v);
        changed();
      });
      r?.addEventListener('input', () => {
        let v = fromR(Number(r.value));
        if (typeof step === 'number') v = Math.round(v / step) * step;
        v = Number(fmtNum(v, step === 'any' ? 0.01 : step));
        n.value = v;
        vals[f.key] = v;
        changed();
      });
      return h(
        'div',
        { class: 'dlg-row' },
        h('label', {}, f.label),
        h('div', { class: 'dlg-num' }, r, n, f.unit ? h('span', { class: 'dlg-unit' }, f.unit) : null),
        f.hint ? h('p', { class: 'hint' }, f.hint) : null,
      );
    });
    shown();
    const body = [hint ? h('p', { class: 'hint' }, hint) : null, ...rows];
    let handle = null;
    handle = shell({
      title,
      body,
      okLabel: ok,
      wide,
      live,
      onOk: () => {
        const msg = validate?.({ ...vals });
        if (msg) return msg;
        resolve({ ...vals });
      },
      onCancel: () => resolve(null),
    });
    const msg = validate?.({ ...vals });
    if (msg) handle.setError(msg), (handle.ok.disabled = true);
  });
}

/** Cierra el diálogo abierto (si hay) como cancelado. */
export function closeDialog() {
  open?.cancel();
}
