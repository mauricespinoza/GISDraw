/**
 * SVG → formas de GISDrawer, con su estilo.
 *
 * Es la puerta de entrada de Illustrator: al copiar, Illustrator deja en el
 * portapapeles el CÓDIGO SVG de lo seleccionado (Preferencias → Gestión del
 * portapapeles → «Copiar como: código SVG»), y aquí se traduce a trazos con
 * nodos Bézier, rellenos, trazos, segmentados, degradados, textos, grupos y
 * máscaras de recorte. También abre archivos .svg (de Illustrator, Inkscape,
 * QGIS…), con una capa por cada capa de primer nivel del archivo.
 *
 * Medidas: un SVG de Illustrator mide en puntos (1 unidad = 1 pt = 0,3528 mm);
 * uno con `width="210mm"` y `viewBox` se mide con esa relación; uno sin
 * unidades de otro programa, a 96 px por pulgada. Las medidas de papel se
 * llevan al terreno con la escala de referencia del documento, así que un
 * trazo de 1 pt en Illustrator es un trazo de 0,35 mm en el mapa impreso a
 * esa escala, y un texto de 9 pt sigue siendo de 9 pt.
 *
 * Funciona sin DOM (pruebas en Node): trae su propio lector de XML mínimo si
 * no hay `DOMParser`.
 */

import { normalizeRuns } from '../richText.js';
import { makeGroup, makePath, makeText } from '../vector.js';
import { defaultStyle } from '../style.js';

export const PT_MM = 25.4 / 72;
export const PX_MM = 25.4 / 96;

/* ================================================================ colores */

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff',
  aqua: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000',
  olive: '#808000', lime: '#00ff00', navy: '#000080', purple: '#800080', teal: '#008080', orange: '#ffa500', brown: '#a52a2a',
  pink: '#ffc0cb', gold: '#ffd700', darkgray: '#a9a9a9', darkgrey: '#a9a9a9', lightgray: '#d3d3d3', lightgrey: '#d3d3d3',
  darkblue: '#00008b', darkgreen: '#006400', darkred: '#8b0000', skyblue: '#87ceeb', beige: '#f5f5dc', tan: '#d2b48c',
  khaki: '#f0e68c', salmon: '#fa8072', violet: '#ee82ee', indigo: '#4b0082', crimson: '#dc143c', coral: '#ff7f50',
};

const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** Color CSS → { color: '#rrggbb', alpha } | 'none' | null (no entendido). */
export function parseColor(v) {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s) return null;
  if (s === 'none' || s === 'transparent') return 'none';
  let m = /^#([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    return { color: `#${h.slice(0, 6)}`, alpha: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
  }
  m = /^rgba?\(([^)]*)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean);
    const ch = (x) => (x.endsWith('%') ? (parseFloat(x) * 255) / 100 : parseFloat(x));
    const a = p[3] == null ? 1 : p[3].endsWith('%') ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
    return { color: `#${hex2(ch(p[0]))}${hex2(ch(p[1]))}${hex2(ch(p[2]))}`, alpha: Number.isFinite(a) ? a : 1 };
  }
  if (NAMED[s]) return { color: NAMED[s], alpha: 1 };
  // cualquier otro color CSS (hsl(), nombres raros): que lo resuelva el navegador
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas').getContext('2d');
    c.fillStyle = '#010203';
    c.fillStyle = s;
    if (c.fillStyle !== '#010203') return parseColor(c.fillStyle);
  }
  return null;
}

/* ============================================================ transformaciones */

const ID = [1, 0, 0, 1, 0, 0];

export function mul(m, n) {
  return [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
}

const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/** `transform="…"` → matriz [a b c d e f]. */
export function parseTransform(s) {
  let m = ID;
  if (!s) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(s))) {
    const a = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let n = ID;
    switch (t[1]) {
      case 'matrix':
        if (a.length === 6) n = a;
        break;
      case 'translate':
        n = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
        break;
      case 'scale':
        n = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const r = ((a[0] || 0) * Math.PI) / 180;
        const c = Math.cos(r);
        const sn = Math.sin(r);
        n = [c, sn, -sn, c, 0, 0];
        if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX':
        n = [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        n = [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
    }
    m = mul(m, n);
  }
  return m;
}

/** Factor de escala medio de una matriz (para grosores y tamaños de letra). */
const scaleOf = (m) => Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;

/* ================================================================ trazados */

/**
 * `d` de un <path> → subtrayectos con nodos Bézier en el espacio del elemento:
 * [{ nodes: [{x, y, hIn, hOut}], closed }]. Las cuadráticas y los arcos se
 * pasan a cúbicas, que es lo que guarda GISDrawer.
 */
export function parsePathD(d) {
  const s = String(d || '');
  let i = 0;
  const skip = () => {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
  };
  const num = () => {
    skip();
    const m = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/.exec(s.slice(i, i + 40));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const flag = () => {
    skip();
    const c = s[i];
    if (c === '0' || c === '1') {
      i++;
      return c === '1';
    }
    return null;
  };
  const subs = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let sx = 0;
  let sy = 0;
  let lastC = null; // último control de cúbica (para S)
  let lastQ = null; // último control de cuadrática (para T)
  let cmd = null;
  const start = (px, py) => {
    cur = { nodes: [{ x: px, y: py, hIn: null, hOut: null }], closed: false };
    subs.push(cur);
  };
  const lineTo = (px, py) => {
    if (!cur) start(x, y);
    cur.nodes.push({ x: px, y: py, hIn: null, hOut: null });
  };
  const cubicTo = (c1x, c1y, c2x, c2y, px, py) => {
    if (!cur) start(x, y);
    cur.nodes[cur.nodes.length - 1].hOut = { x: c1x, y: c1y };
    cur.nodes.push({ x: px, y: py, hIn: { x: c2x, y: c2y }, hOut: null });
  };
  while (i < s.length) {
    skip();
    if (i >= s.length) break;
    if (/[a-zA-Z]/.test(s[i])) cmd = s[i++];
    else if (!cmd) break;
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const ox = rel ? x : 0;
    const oy = rel ? y : 0;
    if (C === 'Z') {
      if (cur) {
        cur.closed = true;
        x = sx;
        y = sy;
        cur = null;
      }
      lastC = lastQ = null;
      cmd = null;
      continue;
    }
    if (C === 'M') {
      const a = num();
      const b = num();
      if (a == null || b == null) break;
      x = ox + a;
      y = oy + b;
      sx = x;
      sy = y;
      start(x, y);
      cmd = rel ? 'l' : 'L'; // pares siguientes = líneas
      lastC = lastQ = null;
      continue;
    }
    if (C === 'L') {
      const a = num();
      const b = num();
      if (a == null || b == null) break;
      x = ox + a;
      y = oy + b;
      lineTo(x, y);
      lastC = lastQ = null;
    } else if (C === 'H') {
      const a = num();
      if (a == null) break;
      x = (rel ? x : 0) + a;
      lineTo(x, y);
      lastC = lastQ = null;
    } else if (C === 'V') {
      const a = num();
      if (a == null) break;
      y = (rel ? y : 0) + a;
      lineTo(x, y);
      lastC = lastQ = null;
    } else if (C === 'C') {
      const v = [num(), num(), num(), num(), num(), num()];
      if (v.some((q) => q == null)) break;
      cubicTo(ox + v[0], oy + v[1], ox + v[2], oy + v[3], ox + v[4], oy + v[5]);
      lastC = [ox + v[2], oy + v[3]];
      x = ox + v[4];
      y = oy + v[5];
      lastQ = null;
    } else if (C === 'S') {
      const v = [num(), num(), num(), num()];
      if (v.some((q) => q == null)) break;
      const c1 = lastC ? [2 * x - lastC[0], 2 * y - lastC[1]] : [x, y];
      cubicTo(c1[0], c1[1], ox + v[0], oy + v[1], ox + v[2], oy + v[3]);
      lastC = [ox + v[0], oy + v[1]];
      x = ox + v[2];
      y = oy + v[3];
      lastQ = null;
    } else if (C === 'Q' || C === 'T') {
      let q;
      let p;
      if (C === 'Q') {
        const v = [num(), num(), num(), num()];
        if (v.some((z) => z == null)) break;
        q = [ox + v[0], oy + v[1]];
        p = [ox + v[2], oy + v[3]];
      } else {
        const v = [num(), num()];
        if (v.some((z) => z == null)) break;
        q = lastQ ? [2 * x - lastQ[0], 2 * y - lastQ[1]] : [x, y];
        p = [ox + v[0], oy + v[1]];
      }
      cubicTo(x + (2 / 3) * (q[0] - x), y + (2 / 3) * (q[1] - y), p[0] + (2 / 3) * (q[0] - p[0]), p[1] + (2 / 3) * (q[1] - p[1]), p[0], p[1]);
      lastQ = q;
      lastC = null;
      x = p[0];
      y = p[1];
    } else if (C === 'A') {
      const rx = num();
      const ry = num();
      const rot = num();
      const large = flag();
      const sweep = flag();
      const ex = num();
      const ey = num();
      if ([rx, ry, rot, large, sweep, ex, ey].some((q) => q == null)) break;
      const px = ox + ex;
      const py = oy + ey;
      for (const c of arcToCubics(x, y, rx, ry, rot, large, sweep, px, py)) cubicTo(...c);
      x = px;
      y = py;
      lastC = lastQ = null;
    } else {
      break;
    }
  }
  return subs.filter((sp) => sp.nodes.length >= 2 || sp.closed);
}

/** Arco elíptico de SVG → cúbicas [c1x, c1y, c2x, c2y, x, y]. */
function arcToCubics(x1, y1, rx, ry, angle, large, sweep, x2, y2) {
  if (x1 === x2 && y1 === y2) return [];
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (!rx || !ry) return [[x1, y1, x2, y2, x2, y2]];
  const phi = (angle * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let co = Math.sqrt(Math.max(0, num / den));
  if (large === sweep) co = -co;
  const cxp = (co * rx * y1p) / ry;
  const cyp = (-co * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const ang = (ux, uy, vx, vy) => {
    const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    return a;
  };
  const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const n = Math.ceil(Math.abs(dt) / (Math.PI / 2));
  const step = dt / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const pt = (t) => {
    const ex = rx * Math.cos(t);
    const ey = ry * Math.sin(t);
    return [cx + cos * ex - sin * ey, cy + sin * ex + cos * ey];
  };
  const der = (t) => {
    const ex = -rx * Math.sin(t);
    const ey = ry * Math.cos(t);
    return [cos * ex - sin * ey, sin * ex + cos * ey];
  };
  const out = [];
  for (let j = 0; j < n; j++) {
    const a = t1 + j * step;
    const b = a + step;
    const p0 = pt(a);
    const p3 = pt(b);
    const d0 = der(a);
    const d3 = der(b);
    out.push([p0[0] + k * d0[0], p0[1] + k * d0[1], p3[0] - k * d3[0], p3[1] - k * d3[1], p3[0], p3[1]]);
  }
  return out;
}

/** Elementos básicos → `d` equivalente. */
function shapeToD(el) {
  const n = (k, def = 0) => {
    const v = parseFloat(el.getAttribute(k));
    return Number.isFinite(v) ? v : def;
  };
  switch (el.tagName.toLowerCase().replace(/^svg:/, '')) {
    case 'path':
      return el.getAttribute('d') || '';
    case 'rect': {
      const x = n('x');
      const y = n('y');
      const w = n('width');
      const h = n('height');
      if (w <= 0 || h <= 0) return '';
      let rx = el.hasAttribute('rx') ? n('rx') : el.hasAttribute('ry') ? n('ry') : 0;
      let ry = el.hasAttribute('ry') ? n('ry') : rx;
      rx = Math.min(rx, w / 2);
      ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${x} ${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx} ${y}H${x + w - rx}A${rx} ${ry} 0 0 1 ${x + w} ${y + ry}V${y + h - ry}A${rx} ${ry} 0 0 1 ${x + w - rx} ${y + h}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + h - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`;
    }
    case 'circle':
    case 'ellipse': {
      const cx = n('cx');
      const cy = n('cy');
      const rx = el.tagName.toLowerCase().endsWith('circle') ? n('r') : n('rx');
      const ry = el.tagName.toLowerCase().endsWith('circle') ? n('r') : n('ry');
      if (rx <= 0 || ry <= 0) return '';
      return `M${cx + rx} ${cy}A${rx} ${ry} 0 0 1 ${cx} ${cy + ry}A${rx} ${ry} 0 0 1 ${cx - rx} ${cy}A${rx} ${ry} 0 0 1 ${cx} ${cy - ry}A${rx} ${ry} 0 0 1 ${cx + rx} ${cy}Z`;
    }
    case 'line':
      return `M${n('x1')} ${n('y1')}L${n('x2')} ${n('y2')}`;
    case 'polyline':
    case 'polygon': {
      const p = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      if (p.length < 4) return '';
      let d = `M${p[0]} ${p[1]}`;
      for (let k = 2; k + 1 < p.length; k += 2) d += `L${p[k]} ${p[k + 1]}`;
      return el.tagName.toLowerCase().endsWith('polygon') ? `${d}Z` : d;
    }
    default:
      return '';
  }
}

/* ================================================================== CSS */

const STYLE_PROPS = [
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin',
  'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'visibility', 'opacity', 'display', 'clip-path', 'mix-blend-mode',
];
const INHERITED = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-dasharray', 'stroke-linecap', 'stroke-linejoin', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'visibility']);

/** Hojas de estilo de Illustrator (`.cls-1{fill:#fff;}`) → reglas simples. */
export function parseCss(text) {
  const rules = [];
  const clean = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '');
  let order = 0;
  for (const block of clean.split('}')) {
    const [sel, body] = block.split('{');
    if (!body) continue;
    const decls = parseDecls(body);
    for (const one of sel.split(',')) {
      const s = one.trim();
      if (!s || /[\s>+~:[]/.test(s)) continue; // solo selectores simples
      const parts = s.match(/[.#]?[^.#]+/g) || [];
      const spec = parts.reduce((a, p) => a + (p[0] === '#' ? 100 : p[0] === '.' ? 10 : 1), 0);
      rules.push({ parts, spec, order: order++, decls });
    }
  }
  return rules.sort((a, b) => a.spec - b.spec || a.order - b.order);
}

function parseDecls(body) {
  const out = {};
  for (const d of String(body).split(';')) {
    const k = d.indexOf(':');
    if (k < 0) continue;
    const name = d.slice(0, k).trim().toLowerCase();
    const val = d.slice(k + 1).replace(/!important/, '').trim();
    if (name) out[name] = val;
  }
  return out;
}

function matches(el, parts) {
  const tag = el.tagName.toLowerCase();
  const cls = new Set((el.getAttribute('class') || '').split(/\s+/).filter(Boolean));
  return parts.every((p) => (p[0] === '.' ? cls.has(p.slice(1)) : p[0] === '#' ? el.getAttribute('id') === p.slice(1) : p === '*' || p.toLowerCase() === tag));
}

/* ================================================================ XML */

/** DOMParser si existe (navegador); si no, un lector mínimo suficiente para SVG. */
export function parseXml(text) {
  if (typeof DOMParser !== 'undefined') {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (!doc.querySelector('parsererror')) return doc.documentElement;
    const doc2 = new DOMParser().parseFromString(text, 'text/html');
    const svg = doc2.querySelector('svg');
    if (svg) return new DOMParser().parseFromString(new XMLSerializer().serializeToString(svg), 'image/svg+xml').documentElement;
    throw new Error('SVG mal formado');
  }
  return miniXml(text);
}

function miniXml(text) {
  const src = String(text).replace(/<!--[\s\S]*?-->/g, '').replace(/<\?[\s\S]*?\?>/g, '').replace(/<!DOCTYPE[\s\S]*?>/i, '');
  const root = { tagName: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const ent = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
  let m;
  while ((m = re.exec(src))) {
    const top = stack[stack.length - 1];
    if (m[1] != null) {
      top.children.push({ tagName: '#text', text: m[1] });
    } else if (m[6] != null) {
      if (m[6].trim()) top.children.push({ tagName: '#text', text: ent(m[6]) });
    } else if (m[2]) {
      if (stack.length > 1) stack.pop();
    } else {
      const attrs = {};
      const ar = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let a;
      while ((a = ar.exec(m[4]))) attrs[a[1]] = ent(a[3] ?? a[4]);
      const el = { tagName: m[3], attrs, children: [], parent: top };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    }
  }
  const wrap = (n) => {
    if (n.tagName === '#text') return { nodeType: 3, textContent: n.text, tagName: '#text' };
    const kids = n.children.map(wrap);
    const el = {
      nodeType: 1,
      tagName: n.tagName,
      childNodes: kids,
      get children() {
        return kids.filter((k) => k.nodeType === 1);
      },
      getAttribute: (k) => (k in n.attrs ? n.attrs[k] : null),
      hasAttribute: (k) => k in n.attrs,
      get textContent() {
        return kids.map((k) => k.textContent).join('');
      },
    };
    for (const k of kids) k.parentNode = el;
    return el;
  };
  const r = wrap(root);
  const svg = r.children.find((c) => c.tagName.replace(/^svg:/, '') === 'svg');
  if (!svg) throw new Error('No hay un elemento <svg>');
  return svg;
}

function* descendants(el) {
  for (const c of el.children || []) {
    yield c;
    yield* descendants(c);
  }
}

/* ============================================================ unidades */

function lengthMm(v) {
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(mm|cm|in|pt|pc|px|)\s*$/i.exec(String(v ?? ''));
  if (!m) return null;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  return { n, unit: u, mm: u === 'mm' ? n : u === 'cm' ? n * 10 : u === 'in' ? n * 25.4 : u === 'pt' ? n * PT_MM : u === 'pc' ? n * 12 * PT_MM : null };
}

/** mm de papel por unidad del SVG. */
export function unitMmOf(svgEl, text, fallback = null) {
  const vb = (svgEl.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const w = lengthMm(svgEl.getAttribute('width'));
  const illustrator = /Adobe Illustrator|data-name=|class="cls-\d/.test(text);
  const base = fallback ?? (illustrator ? PT_MM : PX_MM);
  if (w && w.mm != null) return vb.length === 4 && vb[2] > 0 ? w.mm / vb[2] : w.mm / w.n;
  if (w && vb.length === 4 && vb[2] > 0 && w.n > 0) return (w.n * base) / vb[2];
  return base;
}

/* ============================================================ importación */

const DEFAULT_NAMES = { path: 'Trazado', rect: 'Rectángulo', circle: 'Círculo', ellipse: 'Elipse', line: 'Línea', polyline: 'Polilínea', polygon: 'Polígono' };

/**
 * @param {string} text SVG
 * @param {{refScale: number, center?: [number, number], unitMm?: number}} opts
 * @returns {{ shapes, layers: {name, shapes}[], warnings: string[], gisdrawer: object|null }}
 *   `shapes`: todo lo importado (grupos conservados), en coordenadas de mundo,
 *   centrado en `center`. `layers`: lo mismo repartido por capa de primer
 *   nivel. `gisdrawer`: si el SVG lo copió GISDrawer, sus formas originales.
 */
export function importSvg(text, { refScale = 25000, center = [0, 0], unitMm = null, extraBox = null } = {}) {
  const raw = String(text);
  const at = raw.search(/<svg[\s>]/i);
  if (at < 0) throw new Error('No es SVG');
  // lo que venga antes de <svg (texto suelto del portapapeles) sobra, salvo la cabecera XML
  const root = parseXml(/^\s*<(\?xml|!--|!DOCTYPE)/i.test(raw) ? raw : raw.slice(at));
  const warnings = new Set();

  // ---- copiado por GISDrawer: sus formas exactas
  for (const el of descendants(root)) {
    if (el.tagName.toLowerCase().replace(/^svg:/, '') === 'metadata' && el.getAttribute('id') === 'gisdrawer') {
      try {
        const data = JSON.parse(el.textContent);
        if (data?.app === 'GISDrawer' && Array.isArray(data.shapes)) return { shapes: [], layers: [], warnings: [], gisdrawer: data };
      } catch {
        /* metadatos ilegibles: se importa como SVG común */
      }
    }
  }

  const k = unitMm ?? unitMmOf(root, text);
  const byId = new Map();
  let css = [];
  for (const el of descendants(root)) {
    const id = el.getAttribute('id');
    if (id) byId.set(id, el);
    if (el.tagName.toLowerCase().replace(/^svg:/, '') === 'style') css = css.concat(parseCss(el.textContent));
  }
  css.sort((a, b) => a.spec - b.spec || a.order - b.order);

  // raíz: viewBox desplazado
  const vb = (root.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const rootM = vb.length === 4 ? [1, 0, 0, 1, -vb[0], -vb[1]] : ID;

  const computed = (el, parent) => {
    const own = {};
    for (const p of STYLE_PROPS) if (el.hasAttribute(p)) own[p] = el.getAttribute(p);
    for (const r of css) if (matches(el, r.parts)) Object.assign(own, pick(r.decls));
    if (el.hasAttribute('style')) Object.assign(own, pick(parseDecls(el.getAttribute('style'))));
    const out = {};
    for (const [key, v] of Object.entries(parent || {})) if (INHERITED.has(key)) out[key] = v;
    for (const [key, v] of Object.entries(own)) if (v !== 'inherit') out[key] = v;
    return out;
  };

  const walk = (el, m, parentStyle, opacity) => {
    const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
    if (['defs', 'clippath', 'mask', 'pattern', 'lineargradient', 'radialgradient', 'style', 'title', 'desc', 'metadata', 'symbol', 'marker', 'filter', 'script', 'foreignobject'].includes(tag)) return [];
    const cs = computed(el, parentStyle);
    if (cs.display === 'none' || cs.visibility === 'hidden') return [];
    let M = mul(m, parseTransform(el.getAttribute('transform')));
    const op = opacity * (cs.opacity != null ? clamp01(parseFloat(cs.opacity)) : 1);
    if (cs['mix-blend-mode'] && cs['mix-blend-mode'] !== 'normal') warnings.add(`modo de fusión «${cs['mix-blend-mode']}» aplicado como normal en algunos objetos`);
    let out = [];
    switch (tag) {
      case 'svg':
      case 'g':
      case 'a':
      case 'switch': {
        if (tag === 'svg' && el !== root) {
          const x = parseFloat(el.getAttribute('x')) || 0;
          const y = parseFloat(el.getAttribute('y')) || 0;
          M = mul(M, [1, 0, 0, 1, x, y]);
          const v2 = (el.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
          const w = parseFloat(el.getAttribute('width'));
          const hh = parseFloat(el.getAttribute('height'));
          if (v2.length === 4 && w > 0 && hh > 0) M = mul(M, [w / v2[2], 0, 0, hh / v2[3], -v2[0] * (w / v2[2]), -v2[1] * (hh / v2[3])]);
        }
        for (const c of el.children) out.push(...walk(c, M, cs, op));
        const name = el.getAttribute('data-name') || (el.getAttribute('id') || '').replace(/_/g, ' ') || null;
        out = withClip(el, out, M, cs);
        if (out.length > 1 || (out.length === 1 && name)) {
          const g = makeGroup(out, { name: name || 'Grupo' });
          g._svgName = name;
          return [g];
        }
        return out;
      }
      case 'use': {
        const href = el.getAttribute('href') || el.getAttribute('xlink:href') || '';
        const target = byId.get(href.replace(/^#/, ''));
        if (!target) return [];
        const x = parseFloat(el.getAttribute('x')) || 0;
        const y = parseFloat(el.getAttribute('y')) || 0;
        const tt = target.tagName.toLowerCase().replace(/^svg:/, '');
        const node = tt === 'symbol' ? { ...target, tagName: 'g', getAttribute: (q) => (q === 'transform' ? null : target.getAttribute(q)), hasAttribute: (q) => q !== 'transform' && target.hasAttribute(q), children: target.children } : target;
        out = walk(node, mul(M, [1, 0, 0, 1, x, y]), cs, op);
        return withClip(el, out, M, cs);
      }
      case 'path':
      case 'rect':
      case 'circle':
      case 'ellipse':
      case 'line':
      case 'polyline':
      case 'polygon': {
        const subs = parsePathD(shapeToD(el)).map((sp) => ({ ...sp, nodes: sp.nodes.map((n) => mapNode(n, M)) }));
        if (!subs.length) return [];
        const style = toGdStyle(cs, scaleOf(M) * k, op, byId, warnings);
        const name = el.getAttribute('data-name') || el.getAttribute('id') || DEFAULT_NAMES[tag];
        out = subsToShapes(subs, style, name);
        return withClip(el, out, M, cs);
      }
      case 'text':
        out = textShapes(el, M, cs, op, k, computed);
        return withClip(el, out, M, cs);
      case 'image':
        warnings.add('las imágenes incrustadas no se importan (usa Archivo → GeoTIFF o Georreferenciar)');
        return [];
      default:
        return [];
    }
  };

  /** clip-path de un elemento → grupo de recorte de GISDrawer (máscara primero). */
  const withClip = (el, shapes, M, cs) => {
    const ref = /url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(cs['clip-path'] || '')?.[1];
    if (!ref || !shapes.length) return shapes;
    const cp = byId.get(ref);
    if (!cp) return shapes;
    const cm = mul(M, parseTransform(cp.getAttribute('transform')));
    const geo = [];
    for (const c of cp.children) {
      const d = shapeToD(c);
      if (!d) continue;
      const cmm = mul(cm, parseTransform(c.getAttribute('transform')));
      for (const sp of parsePathD(d)) geo.push({ ...sp, closed: true, nodes: sp.nodes.map((n) => mapNode(n, cmm)) });
    }
    if (!geo.length) return shapes;
    const mask = subsToShapes(geo, { ...defaultStyle(), fill: 'none', stroke: 'none' }, 'Máscara')[0];
    if (!mask || mask.type !== 'path') return shapes;
    return [makeGroup([mask, ...shapes], { clip: true })];
  };

  const shapesMm = [];
  for (const c of root.children) shapesMm.push(...walk(c, rootM, computed(root, null), 1));

  // capas: grupos de primer nivel con nombre (Illustrator: id="Capa_1" data-name="Capa 1")
  const layersMm = [];
  const loose = [];
  for (const s of shapesMm) {
    if (s.type === 'group' && !s.clip && s._svgName) layersMm.push({ name: s._svgName, shapes: s.children });
    else loose.push(s);
  }
  // un SVG de Illustrator con una sola capa la declara en el propio <svg>
  if (loose.length) layersMm.unshift({ name: root.getAttribute('data-name') || (root.getAttribute('id') || '').replace(/_/g, ' ') || 'SVG', shapes: loose });

  // de mm de papel (y hacia abajo) al terreno, centrado
  let box = bboxMm(shapesMm);
  // algo más que debe quedar en su lugar junto a las formas (las imágenes de un PDF)
  if (extraBox) {
    const [a, b, c, d] = extraBox;
    box = box ? { minX: Math.min(box.minX, a), minY: Math.min(box.minY, b), maxX: Math.max(box.maxX, c), maxY: Math.max(box.maxY, d) } : { minX: a, minY: b, maxX: c, maxY: d };
  }
  const mPerMm = refScale / 1000;
  const cx = box ? (box.minX + box.maxX) / 2 : 0;
  const cy = box ? (box.minY + box.maxY) / 2 : 0;
  const toWorld = (x, y) => [center[0] + (x - cx) * k * mPerMm, center[1] - (y - cy) * k * mPerMm];
  const place = (s) => mapShapePoints(s, toWorld);
  const clean = (s) => {
    delete s._svgName;
    if (s.type === 'group') s.children.forEach(clean);
    return s;
  };
  const shapes = shapesMm.map(place).map(clean);
  const layers = layersMm.map((l) => ({ name: l.name, shapes: l.shapes.map(place).map(clean) }));
  return { shapes, layers, warnings: [...warnings], gisdrawer: null, toWorld, sizeMm: box ? [(box.maxX - box.minX) * k, (box.maxY - box.minY) * k] : [0, 0] };
}

const pick = (decls) => Object.fromEntries(Object.entries(decls).filter(([key]) => STYLE_PROPS.includes(key)));
const clamp01 = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1);

function mapNode(n, M) {
  const p = apply(M, n.x, n.y);
  return { x: p[0], y: p[1], hIn: n.hIn ? xy(apply(M, n.hIn.x, n.hIn.y)) : null, hOut: n.hOut ? xy(apply(M, n.hOut.x, n.hOut.y)) : null, smooth: false };
}
const xy = (p) => ({ x: p[0], y: p[1] });

/** Subtrayectos → trazos de GISDrawer. Cerrados con relleno: el primero es el contorno y el resto huecos. */
function subsToShapes(subs, style, name) {
  const close = (sp) => {
    const nodes = sp.nodes.slice();
    if (sp.closed && nodes.length > 2) {
      const a = nodes[0];
      const b = nodes[nodes.length - 1];
      if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) {
        nodes.pop();
        nodes[0] = { ...a, hIn: b.hIn };
      }
    }
    for (const n of nodes) n.smooth = !!(n.hIn && n.hOut && Math.abs((n.hIn.x - n.x) * (n.hOut.y - n.y) - (n.hIn.y - n.y) * (n.hOut.x - n.x)) < 1e-6);
    return nodes;
  };
  const closedAll = subs.every((sp) => sp.closed);
  if (subs.length > 1 && closedAll) {
    const [first, ...rest] = subs;
    const p = makePath(close(first), { closed: true, style, name, holes: rest.map(close) });
    return [p];
  }
  // cerrado con 3 nodos o más, o con 2 si alguno es curvo (una lente)
  const canClose = (sp) => sp.nodes.length > 2 || (sp.nodes.length === 2 && sp.nodes.some((n) => n.hIn || n.hOut));
  const out = subs.map((sp) => makePath(close(sp), { closed: !!sp.closed && canClose(sp), style: { ...style }, name }));
  return out.length > 1 ? [makeGroup(out, { name })] : out;
}

function toGdStyle(cs, kMm, opacity, byId, warnings) {
  const st = { ...defaultStyle(), align: 'center', fill: 'none', stroke: 'none' };
  const fillV = cs.fill ?? '#000000';
  const grad = /url\(\s*['"]?#([^'")]+)['"]?\s*\)/.exec(fillV);
  if (grad) {
    const g = gradientOf(byId, grad[1]);
    if (g) {
      st.fill = g.stops[0]?.[1] || '#888888';
      st.fillType = g.type;
      st.gradient = { angle: g.angle, stops: g.stops };
      st.fillOpacity = clamp01(parseFloat(cs['fill-opacity'] ?? 1));
    } else {
      st.fill = '#cccccc';
      st.fillOpacity = 0.5;
      warnings.add('rellenos de motivo (pattern) de SVG aproximados con gris');
    }
  } else {
    const f = parseColor(fillV);
    if (f && f !== 'none') {
      st.fill = f.color;
      st.fillOpacity = clamp01(parseFloat(cs['fill-opacity'] ?? 1)) * f.alpha;
    }
  }
  const s = parseColor(/url\(/.test(cs.stroke || '') ? '#000000' : cs.stroke);
  if (s && s !== 'none') {
    st.stroke = s.color;
    st.strokeOpacity = clamp01(parseFloat(cs['stroke-opacity'] ?? 1)) * s.alpha;
    const sw = parseFloat(cs['stroke-width'] ?? 1);
    st.strokeWidth = +((Number.isFinite(sw) ? sw : 1) * kMm).toFixed(4);
    st.cap = { butt: 'butt', round: 'round', square: 'square' }[cs['stroke-linecap']] || 'butt';
    st.join = { miter: 'miter', round: 'round', bevel: 'bevel' }[cs['stroke-linejoin']] || 'miter';
    const da = String(cs['stroke-dasharray'] || 'none');
    if (da !== 'none') {
      const parts = da.split(/[\s,]+/).map(parseFloat).filter(Number.isFinite);
      if (parts.length && parts.some((v) => v > 0)) {
        const w = Number.isFinite(sw) && sw > 0 ? sw : 1;
        const seq = parts.length % 2 ? [...parts, ...parts] : parts;
        st.dash = seq.map((v) => +(v / w).toFixed(3)).join(' ');
      }
    }
  } else {
    st.strokeWidth = 0;
  }
  st.opacity = +opacity.toFixed(3);
  return st;
}

function gradientOf(byId, id, depth = 0) {
  const el = byId.get(id);
  if (!el || depth > 5) return null;
  const tag = el.tagName.toLowerCase().replace(/^svg:/, '');
  if (tag !== 'lineargradient' && tag !== 'radialgradient') return null;
  let stops = [...el.children].filter((c) => c.tagName.toLowerCase().replace(/^svg:/, '') === 'stop').map((c) => {
    const st = { ...parseDecls(c.getAttribute('style') || '') };
    const col = parseColor(c.getAttribute('stop-color') ?? st['stop-color'] ?? '#000') || { color: '#000000', alpha: 1 };
    const off = String(c.getAttribute('offset') ?? '0');
    const o = off.endsWith('%') ? parseFloat(off) / 100 : parseFloat(off);
    const a = parseFloat(c.getAttribute('stop-opacity') ?? st['stop-opacity'] ?? 1);
    return [clamp01(o), col === 'none' ? '#ffffff' : col.color, clamp01(a) * (col === 'none' ? 0 : col.alpha)];
  });
  const href = el.getAttribute('href') || el.getAttribute('xlink:href');
  if (!stops.length && href) stops = gradientOf(byId, href.replace(/^#/, ''), depth + 1)?.stops || [];
  if (!stops.length) return null;
  const n = (k2, d) => {
    const v = el.getAttribute(k2);
    if (v == null) return d;
    return String(v).endsWith('%') ? parseFloat(v) / 100 : parseFloat(v);
  };
  const m = parseTransform(el.getAttribute('gradientTransform'));
  const [ax, ay] = apply(m, n('x1', 0), n('y1', 0));
  const [bx, by] = apply(m, n('x2', 1), n('y2', 0));
  return { type: tag === 'radialgradient' ? 'radial' : 'linear', stops, angle: Math.round((-Math.atan2(by - ay, bx - ax) * 180) / Math.PI) };
}

/** <text> con sus <tspan>: una línea por cada cambio de `y`, como en Illustrator. */
function textShapes(el, M, cs, opacity, kMm, computed) {
  const lines = [];
  let line = null;
  let first = null;
  let curY = null;
  const visit = (node, style, inheritedX, inheritedY) => {
    for (const c of node.childNodes || []) {
      if (c.nodeType === 3) {
        const t = c.textContent.replace(/[\r\n\t]+/g, ' ');
        if (!t.trim() && !line) continue;
        if (!line) {
          line = { text: '', style, segs: [] };
          lines.push(line);
        }
        line.text += t;
        line.segs.push({ t, style });
      } else if (c.nodeType === 1 && c.tagName.toLowerCase().replace(/^svg:/, '') === 'tspan') {
        const st = computed(c, style);
        const x = c.hasAttribute('x') ? parseFloat(c.getAttribute('x')) : inheritedX;
        const y = c.hasAttribute('y') ? parseFloat(c.getAttribute('y')) : inheritedY;
        const dy = parseFloat(c.getAttribute('dy')) || 0;
        const yy = (y ?? curY ?? 0) + dy;
        if (curY == null || Math.abs(yy - curY) > 1e-6) {
          line = { text: '', style: st, segs: [] };
          lines.push(line);
          curY = yy;
        }
        if (!first) first = { x: x ?? 0, y: yy };
        visit(c, st, x, yy);
      }
    }
  };
  const x0 = parseFloat(el.getAttribute('x')) || 0;
  const y0 = parseFloat(el.getAttribute('y')) || 0;
  curY = el.hasAttribute('y') ? y0 : null;
  visit(el, cs, x0, el.hasAttribute('y') ? y0 : null);
  // texto y tramos: cada trozo con estilo propio (color, tamaño, negrita, cursiva) distinto del primero
  const keep = lines.filter((l) => l.text.trim());
  if (!keep.length) return [];
  const st0 = keep[0].segs[0]?.style || keep[0].style || cs;
  const baseFs = parseFloat(st0['font-size'] ?? cs['font-size'] ?? 16) || 16;
  const isBold = (st) => {
    const w = String(st['font-weight'] ?? cs['font-weight'] ?? '400');
    return w === 'bold' || Number(w) >= 600 || /bold|black|heavy/i.test(String(st['font-family'] ?? ''));
  };
  const isItalic = (st) => /italic|oblique/i.test(String(st['font-style'] ?? cs['font-style'] ?? '')) || /italic|oblique/i.test(String(st['font-family'] ?? ''));
  const colorOf = (st) => {
    const f = parseColor(st.fill ?? cs.fill ?? '#000000');
    return f && f !== 'none' ? f.color : '#000000';
  };
  const base = { color: colorOf(st0), bold: isBold(st0), italic: isItalic(st0) };
  let text = '';
  const runs = [];
  keep.forEach((l, i) => {
    if (i) text += '\n';
    const lineLen = l.text.replace(/\s+$/, '').length;
    let pos = 0;
    for (const sg of l.segs) {
      const t = sg.t.slice(0, Math.max(0, lineLen - pos));
      pos += sg.t.length;
      if (!t) continue;
      const r = { s: text.length, e: text.length + t.length };
      const sc = (parseFloat(sg.style['font-size'] ?? baseFs) || baseFs) / baseFs;
      if (Math.abs(sc - 1) > 0.02) r.scale = +sc.toFixed(3);
      if (t.trim()) {
        const c = colorOf(sg.style);
        if (c !== base.color) r.color = c;
        if (isBold(sg.style) !== base.bold) r.bold = isBold(sg.style);
        if (isItalic(sg.style) !== base.italic) r.italic = isItalic(sg.style);
      }
      if (r.scale || r.color || r.bold !== undefined || r.italic !== undefined) runs.push(r);
      text += t;
    }
  });
  if (!text.trim()) return [];
  const pos = first || { x: x0, y: y0 };
  const p = apply(M, pos.x, pos.y);
  const fsU = parseFloat(st0['font-size'] ?? cs['font-size'] ?? 16) || 16;
  const fsPt = +((fsU * scaleOf(M) * kMm) / PT_MM).toFixed(2);
  const f = parseColor(st0.fill ?? cs.fill ?? '#000000');
  const fill = f && f !== 'none' ? f.color : '#000000';
  const t = makeText(p[0], p[1], text, { ...defaultStyle(), fill, fillOpacity: f && f !== 'none' ? f.alpha * clamp01(parseFloat(st0['fill-opacity'] ?? 1)) : 1, fillType: 'solid', stroke: 'none', opacity: +opacity.toFixed(3) }, fsPt);
  const fam = String(st0['font-family'] ?? cs['font-family'] ?? 'Helvetica').replace(/['"]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
  const famName = fam[fam.length - 1] || 'Helvetica';
  t.fontFamily = `${/\s/.test(famName) ? `'${famName}'` : famName}, Helvetica, Arial, sans-serif`;
  const fw = String(st0['font-weight'] ?? cs['font-weight'] ?? '400');
  t.fontWeight = fw === 'bold' || Number(fw) >= 600 || /bold|black|heavy/i.test(fam.join(' ')) ? 700 : 400;
  t.italic = /italic|oblique/i.test(String(st0['font-style'] ?? cs['font-style'] ?? '')) || /italic|oblique/i.test(fam.join(' '));
  t.anchor = { start: 'start', middle: 'middle', end: 'end' }[st0['text-anchor'] ?? cs['text-anchor']] || 'start';
  t.rotation = +((Math.atan2(M[1], M[0]) * 180) / Math.PI).toFixed(2);
  const sw = parseColor(st0.stroke ?? cs.stroke);
  if (sw && sw !== 'none') {
    t.halo = true;
    t.haloColor = sw.color;
    t.haloWidth = +(((parseFloat(st0['stroke-width'] ?? cs['stroke-width'] ?? 1) || 1) * scaleOf(M) * kMm) / 2).toFixed(3);
  } else t.halo = false;
  if (runs.length) t.runs = normalizeRuns(runs, text.length);
  t.name = text.split('\n')[0].slice(0, 40);
  return [t];
}

/* ================================================================ util */

/** Aplica `f(x, y) → [x, y]` a todos los puntos de una forma (copia). */
export function mapShapePoints(s, f) {
  const n = (q) => {
    if (!q) return q;
    const [x, y] = f(q.x, q.y);
    return { ...q, x, y };
  };
  const node = (q) => ({ ...n(q), hIn: q.hIn ? n(q.hIn) : null, hOut: q.hOut ? n(q.hOut) : null });
  if (s.type === 'group') return { ...s, children: s.children.map((c) => mapShapePoints(c, f)) };
  if (s.type === 'path') return { ...s, nodes: s.nodes.map(node), holes: s.holes ? s.holes.map((h) => h.map(node)) : null };
  if (s.type === 'text' || s.type === 'point') {
    const [x, y] = f(s.x, s.y);
    return { ...s, x, y };
  }
  return s;
}

function bboxMm(shapes) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const add = (q) => {
    if (!q) return;
    minX = Math.min(minX, q.x);
    maxX = Math.max(maxX, q.x);
    minY = Math.min(minY, q.y);
    maxY = Math.max(maxY, q.y);
  };
  const visit = (s) => {
    if (s.type === 'group') s.children.forEach(visit);
    else if (s.type === 'path') {
      for (const n of s.nodes) add(n);
      for (const h of s.holes || []) for (const n of h) add(n);
    } else add(s);
  };
  shapes.forEach(visit);
  return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
}
