/**
 * Formato por segmentos dentro de un texto: color, tamaño, negrita y cursiva
 * de una parte de las letras, el resto igual que el texto entero.
 *
 * El texto sigue siendo una cadena (`shape.text`); el formato vive aparte en
 * `shape.runs`: una lista de tramos sobre los índices de esa cadena,
 *
 *   { s, e, color?, scale?, bold?, italic? }
 *
 * `s`..`e` (fin excluido) es el tramo; `scale` es un múltiplo del tamaño del
 * texto (así estirar el texto lo escala todo junto); `color` un `#rrggbb`;
 * `bold` e `italic` booleanos. Una propiedad ausente hereda la del texto.
 * Los tramos no se solapan, están ordenados y sin propiedades repetidas
 * contiguas: `normalizeRuns` lo garantiza.
 *
 * Todo son funciones puras, sin DOM.
 */

const PROPS = ['color', 'scale', 'bold', 'italic'];

const sameStyle = (a, b) => PROPS.every((k) => a[k] === b[k]);
const hasStyle = (r) => PROPS.some((k) => r[k] !== undefined && r[k] !== null);

/** Tramos válidos: dentro del texto, ordenados, sin vacíos ni valores por defecto, con los contiguos iguales fusionados. */
export function normalizeRuns(runs, len = Infinity) {
  const out = [];
  const sorted = (runs || [])
    .map((r) => ({ ...r, s: Math.max(0, Math.round(r.s)), e: Math.min(len, Math.round(r.e)) }))
    .filter((r) => r.e > r.s && hasStyle(r))
    .sort((a, b) => a.s - b.s);
  for (const r of sorted) {
    const clean = { s: r.s, e: r.e };
    for (const k of PROPS) if (r[k] !== undefined && r[k] !== null && !(k === 'scale' && Math.abs(r.scale - 1) < 1e-9)) clean[k] = r[k];
    if (!hasStyle(clean)) continue;
    const last = out[out.length - 1];
    if (last && clean.s < last.e) clean.s = last.e; // por si venían solapados: gana el primero
    if (clean.e <= clean.s) continue;
    if (last && last.e === clean.s && sameStyle(last, clean)) last.e = clean.e;
    else out.push(clean);
  }
  return out;
}

/**
 * Aplica `patch` (p. ej. `{ color: '#ff0000' }`; un valor `null` quita la
 * propiedad) a los caracteres `[start, end)`, partiendo los tramos que cruza.
 */
export function applyRun(runs, start, end, patch, len = Infinity) {
  start = Math.max(0, start);
  end = Math.min(len, end);
  if (end <= start) return normalizeRuns(runs, len);
  const bounds = new Set([0, len === Infinity ? end : len, start, end]);
  for (const r of runs || []) {
    bounds.add(r.s);
    bounds.add(r.e);
  }
  const cuts = [...bounds].filter((x) => x >= 0 && x <= (len === Infinity ? end : len)).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const a = cuts[i];
    const b = cuts[i + 1];
    const base = (runs || []).find((r) => r.s <= a && r.e >= b) || {};
    const seg = { s: a, e: b };
    for (const k of PROPS) if (base[k] !== undefined) seg[k] = base[k];
    if (a >= start && b <= end) {
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined) delete seg[k];
        else seg[k] = v;
      }
    }
    out.push(seg);
  }
  return normalizeRuns(out, len);
}

/** Un `scale` multiplicado (para «más grande / más pequeño» sobre lo que ya tenga cada tramo). */
export function scaleRuns(runs, start, end, factor, len = Infinity) {
  start = Math.max(0, start);
  end = Math.min(len, end);
  if (end <= start) return normalizeRuns(runs, len);
  const cuts = new Set([start, end]);
  for (const r of runs || []) {
    if (r.s > start && r.s < end) cuts.add(r.s);
    if (r.e > start && r.e < end) cuts.add(r.e);
  }
  const pts = [...cuts].sort((a, b) => a - b);
  let out = runs || [];
  for (let i = 0; i < pts.length - 1; i++) {
    const cur = effectiveScale(out, pts[i]);
    out = applyRun(out, pts[i], pts[i + 1], { scale: Math.round(cur * factor * 1000) / 1000 }, len);
  }
  return out;
}

/** Estilo (tramo) que cubre el carácter `i`, o `{}`. */
export function runAt(runs, i) {
  return (runs || []).find((r) => i >= r.s && i < r.e) || {};
}

export const effectiveScale = (runs, i) => runAt(runs, i).scale ?? 1;

/**
 * Un arreglo con el estilo de cada carácter (objetos compartidos entre los de
 * un mismo tramo, para comparar por identidad al agrupar).
 */
export function styleArray(runs, len) {
  const none = {};
  const arr = new Array(len).fill(none);
  for (const r of runs || []) for (let i = Math.max(0, r.s); i < Math.min(len, r.e); i++) arr[i] = r;
  return arr;
}

/** ¿El texto tiene formato por segmentos? */
export const hasRuns = (shape) => Array.isArray(shape?.runs) && shape.runs.length > 0;

/**
 * Ajusta los tramos cuando el texto cambia por otra vía (un cuadro de texto
 * del panel): compara prefijo y sufijo comunes, desplaza lo posterior y deja
 * lo insertado con el formato del carácter anterior.
 */
export function adjustRuns(oldText, newText, runs) {
  if (!runs?.length || oldText === newText) return runs || [];
  let p = 0;
  while (p < oldText.length && p < newText.length && oldText[p] === newText[p]) p++;
  let q = 0;
  while (q < oldText.length - p && q < newText.length - p && oldText[oldText.length - 1 - q] === newText[newText.length - 1 - q]) q++;
  const removedEnd = oldText.length - q; // fin del tramo borrado en el texto viejo
  const delta = newText.length - oldText.length;
  const inserted = newText.length - q - p; // largo de lo escrito
  const out = [];
  for (const r of runs) {
    // parte antes de la edición
    if (r.s < p) out.push({ ...r, e: Math.min(r.e, p) });
    // parte después de la zona borrada
    if (r.e > removedEnd) out.push({ ...r, s: Math.max(r.s, removedEnd) + delta, e: r.e + delta });
  }
  // lo insertado hereda el formato del carácter anterior
  if (inserted > 0 && p > 0) {
    const prev = runAt(runs, p - 1);
    if (hasStyle(prev)) out.push({ ...prev, s: p, e: p + inserted });
  }
  return normalizeRuns(out, newText.length);
}

/** Texto plano: sin formato (utilidad de pruebas y exportación). */
export function stripRuns(shape) {
  const { runs, ...rest } = shape;
  void runs;
  return rest;
}
