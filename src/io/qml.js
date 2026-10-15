/**
 * Simbología de QGIS: lectura de estilos .qml, definiciones de capa .qlr y del
 * estilo guardado DENTRO de un GeoPackage (tabla `layer_styles`), y escritura
 * de un QML al exportar.
 *
 * Basado en el lector de FieldDraw (`src/gpkg/qml.js`), ampliado a lo que un
 * dibujo necesita: símbolos con VARIAS capas (relleno + contorno + línea de
 * borde), formas de marcador, rellenos de patrón aproximados, y el etiquetado
 * simple (`<labeling type="simple">`), que pasa a la configuración de
 * etiquetas de la capa.
 *
 * Lo que QGIS puede y aquí no: expresiones arbitrarias en filtros (se aceptan
 * comparaciones de campo unidas por AND/OR), geometry generators, marcadores
 * SVG y fuentes de símbolos. Lo que no se entiende se avisa y la regla se
 * aplica con el símbolo base, en vez de romper la importación.
 */

import { DASHES, defaultStyle } from '../style.js';
import { ORNAMENTS, ornamentSymbolSvg } from '../ornaments.js';
import { PATTERNS, patternTileSvg } from '../patterns.js';
import { DOC_EPSG, DOC_WKT } from '../proj.js';

/** QGIS mide en milímetros por defecto. */
const MM_TO_PX = 96 / 25.4;

/**
 * QGIS escribe el color como "r,g,b,a" y, desde 3.30, a veces añade una cola
 * "rgb:0.82,0.18,..." con más precisión. Nos quedamos con los 4 primeros
 * enteros. También acepta "#rrggbb".
 */
export function parseQgisColor(value) {
  if (!value) return null;
  const v = String(value).trim();
  const hex = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(v);
  if (hex) {
    return {
      color: `#${hex[1].toLowerCase()}`,
      opacity: hex[2] ? parseInt(hex[2], 16) / 255 : 1,
    };
  }
  const nums = v.split(',').map((s) => Number.parseInt(s, 10));
  if (nums.length < 3 || nums.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  const [r, g, b] = nums;
  const a = Number.isFinite(nums[3]) ? nums[3] : 255;
  const hexOf = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return { color: `#${hexOf(r)}${hexOf(g)}${hexOf(b)}`, opacity: a / 255 };
}

const QGIS_DASH = {
  solid: null,
  no: null,
  dash: [4, 2],
  dot: [1, 2],
  'dash dot': [4, 2, 1, 2],
  'dash dot dot': [4, 2, 1, 2, 1, 2],
};

/** Lee las propiedades de un `<layer>`, en formato `<Option>` o `<prop>`. */
function layerProps(layerEl) {
  const props = {};
  for (const p of layerEl.querySelectorAll(':scope > prop')) {
    props[p.getAttribute('k')] = p.getAttribute('v');
  }
  for (const map of layerEl.querySelectorAll(':scope > Option[type="Map"]')) {
    for (const o of map.querySelectorAll(':scope > Option')) {
      const name = o.getAttribute('name');
      if (name) props[name] = o.getAttribute('value');
    }
  }
  return props;
}

function widthToPx(value, unit) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return 1;
  // Pixel y "RenderMetresInMapUnits" no se convierten; el resto se asume MM.
  if (unit === 'Pixel') return Math.max(0.4, n);
  return Math.max(0.4, n * MM_TO_PX);
}



/**
 * Traduce una expresión de filtro de QGIS a un filtro de MapLibre.
 * Soporta el subconjunto habitual — `"campo" = 'valor'` unido por AND/OR y
 * comparaciones numéricas — y devuelve `undefined` si no lo entiende, para
 * que la regla se aplique sin filtro en vez de romper la carga.
 */
export function parseQgisFilter(expr) {
  if (!expr || !expr.trim() || expr.trim().toUpperCase() === 'ELSE') return null;
  const text = expr.trim();

  const splitTop = (s, op) => {
    const parts = [];
    let depth = 0;
    let quote = null;
    let last = 0;
    const re = new RegExp(`\\s${op}\\s`, 'gi');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if (depth === 0) {
        re.lastIndex = i;
        const m = re.exec(s);
        if (m && m.index === i) {
          parts.push(s.slice(last, i));
          i += m[0].length - 1;
          last = i + 1;
        }
      }
    }
    parts.push(s.slice(last));
    return parts.length > 1 ? parts : null;
  };

  const ands = splitTop(text, 'AND');
  if (ands) {
    const subs = ands.map((s) => parseQgisFilter(s));
    return subs.some((s) => s === undefined) ? undefined : ['all', ...subs.filter(Boolean)];
  }
  const ors = splitTop(text, 'OR');
  if (ors) {
    const subs = ors.map((s) => parseQgisFilter(s));
    return subs.some((s) => s === undefined || s === null) ? undefined : ['any', ...subs];
  }

  const inner = /^\((.*)\)$/s.exec(text);
  if (inner) return parseQgisFilter(inner[1]);

  const cmp = /^\s*"([^"]+)"\s*(<=|>=|<>|!=|=|<|>)\s*(.+?)\s*$/s.exec(text);
  if (!cmp) return undefined;
  const [, field, op, rawValue] = cmp;
  let value;
  const str = /^'(.*)'$/s.exec(rawValue);
  if (str) value = str[1].replace(/''/g, "'");
  else if (/^-?\d+(\.\d+)?$/.test(rawValue)) value = Number(rawValue);
  else return undefined;

  // QGIS usa `=` y `<>`; MapLibre exige `==` y `!=`.
  const mlOp = op === '=' ? '==' : op === '<>' || op === '!=' ? '!=' : op;
  return [mlOp, ['get', field], value];
}

/* ===================================================== símbolo -> estilo */

/** Medida de QGIS -> milímetros de papel. `refScale` convierte unidades de mapa. */
function toMm(value, unit, refScale) {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return null;
  if (unit === 'Pixel') return n / MM_TO_PX;
  if (unit === 'MapUnit' || unit === 'RenderMetersInMapUnits') return (n * 1000) / refScale;
  if (unit === 'Point') return n * 0.352778;
  if (unit === 'Inch') return n * 25.4;
  return n;
}

const DASH_FROM_QGIS = { solid: 'solid', dash: 'dash', dot: 'dot', 'dash dot': 'dashdot', 'dash dot dot': 'dashdotdot' };

const MARKER_FROM_QGIS = {
  circle: 'circle',
  square: 'square',
  rectangle: 'square',
  triangle: 'triangle',
  equilateral_triangle: 'triangle',
  diamond: 'diamond',
  star: 'star',
  regular_star: 'star',
  cross: 'cross',
  cross2: 'x',
  cross_fill: 'cross',
  pentagon: 'circle',
  hexagon: 'circle',
};

/**
 * Símbolo QGIS (con todas sus capas) -> estilo de GISDrawer.
 * Devuelve null si el símbolo no dibuja nada.
 */
export function symbolToStyle(symbolEl, refScale = 25000) {
  if (!symbolEl) return null;
  const type = symbolEl.getAttribute('type');
  const alpha = Number(symbolEl.getAttribute('alpha') ?? 1);
  const layers = Array.from(symbolEl.querySelectorAll(':scope > layer')).filter((l) => l.getAttribute('enabled') !== '0');
  // QGIS pinta de la primera capa (abajo) a la última (arriba)
  const st = { ...defaultStyle(), opacity: Number.isFinite(alpha) ? alpha : 1 };
  st.fill = 'none';
  st.stroke = 'none';
  st.strokeWidth = 0;

  if (type === 'line') {
    const lines = layers.filter((l) => l.getAttribute('class') === 'SimpleLine').map((l) => layerProps(l));
    const arrows = layers.filter((l) => l.getAttribute('class') === 'ArrowLine');
    if (lines.length) {
      const top = lines[lines.length - 1];
      const c = parseQgisColor(top.line_color) || { color: '#333333', opacity: 1 };
      st.stroke = c.color;
      st.strokeOpacity = c.opacity;
      st.strokeWidth = toMm(top.line_width ?? 0.26, top.line_width_unit, refScale) ?? 0.26;
      st.dash = DASH_FROM_QGIS[top.line_style] || 'solid';
      if (top.use_custom_dash === '1' && top.customdash) {
        const parts = top.customdash.split(';').map(Number).filter(Number.isFinite);
        if (parts.length >= 2) st.dash = parts.map((d) => +(d / Math.max(0.05, st.strokeWidth)).toFixed(2)).join(' ');
      }
      st.cap = { flat: 'butt', square: 'square', round: 'round' }[top.capstyle] || 'round';
      st.join = { miter: 'miter', bevel: 'bevel', round: 'round' }[top.joinstyle] || 'round';
      if (top.line_style === 'no') st.stroke = 'none';
      // dos líneas superpuestas, la de abajo más ancha = borde de línea (casing)
      if (lines.length >= 2) {
        const under = lines[lines.length - 2];
        const uw = toMm(under.line_width ?? 0.26, under.line_width_unit, refScale) ?? 0;
        if (uw > st.strokeWidth) {
          st.casing = true;
          st.casingColor = (parseQgisColor(under.line_color) || { color: '#ffffff' }).color;
          st.casingWidth = (uw - st.strokeWidth) / 2;
        }
      }
    }
    for (const ml of layers.filter((l) => l.getAttribute('class') === 'MarkerLine')) {
      const inner = ml.querySelector('symbol > layer[class="SvgMarker"]');
      const svg = inner ? decodeSvgRef(layerProps(inner).name) : null;
      const gd = svg ? Object.fromEntries([...svg.matchAll(/data-gd(-[\w-]+)?="([^"]*)"/g)].map((m) => [m[1] ? m[1].slice(1) : 'kind', m[2]])) : null;
      if (gd?.kind === 'wave') {
        st.wavy = true;
        st.waveAmp = Number(gd.amp) || st.waveAmp;
        st.waveLen = Number(gd.len) || st.waveLen;
        st.stroke = gd.stroke || '#000000';
        st.strokeWidth = Number(gd.width) || 0.35;
        st.strokeOpacity = Number(gd.opacity ?? 1);
        st.casing = gd.casing === '1';
        if (st.casing) {
          st.casingColor = gd['casing-color'] || '#ffffff';
          st.casingWidth = Number(gd['casing-width']) || st.casingWidth;
        }
      } else if (gd?.kind === 'orn' && ORNAMENTS[gd.type]) {
        st.ornament = gd.type;
        st.ornamentSide = gd.side === 'right' ? 'right' : 'left';
        st.ornamentSize = Number(gd.size) || 1;
        st.ornamentSpacing = Number(gd.spacing) || ORNAMENTS[gd.type].spacing;
        st.ornamentGap = Number(gd.gap) || 0.8;
        st.ornamentHalo = gd.halo !== '0';
        st.ornamentColor = gd.color || '';
      }
    }
    if (arrows.length) {
      const p = layerProps(arrows[0]);
      const c = parseQgisColor(p.color) || null;
      if (c && st.stroke === 'none') {
        st.stroke = c.color;
        st.strokeWidth = toMm(p.arrow_width ?? 1, p.arrow_width_unit, refScale) ?? 1;
      }
      st.markerEnd = 'arrow';
      if (p.is_double_headed === '1' || p.arrow_type === '1') st.markerStart = 'arrow';
    }
    return st.stroke === 'none' ? null : st;
  }

  if (type === 'fill') {
    for (const el of layers) {
      const cls = el.getAttribute('class');
      const p = layerProps(el);
      if (cls === 'SimpleFill') {
        const f = parseQgisColor(p.color);
        if (f && p.style !== 'no') {
          st.fill = f.color;
          st.fillOpacity = f.opacity;
          st.fillType = 'solid';
        }
        const o = parseQgisColor(p.outline_color);
        if (o && p.outline_style !== 'no') {
          st.stroke = o.color;
          st.strokeOpacity = o.opacity;
          st.strokeWidth = toMm(p.outline_width ?? 0.26, p.outline_width_unit, refScale) ?? 0.26;
          st.dash = DASH_FROM_QGIS[p.outline_style] || 'solid';
          st.align = 'center';
        }
      } else if (cls === 'GradientFill') {
        const c1 = parseQgisColor(p.color) || { color: '#ffffff', opacity: 1 };
        const c2 = parseQgisColor(p.gradient_color2) || { color: '#000000', opacity: 1 };
        st.fill = c1.color;
        st.fillOpacity = 1;
        st.fillType = p.gradient_type === '1' ? 'radial' : 'linear';
        st.gradient = { angle: Number(p.angle || 0), stops: [[0, c1.color, c1.opacity], [1, c2.color, c2.opacity]] };
      } else if (cls === 'LinePatternFill' || cls === 'PointPatternFill' || cls === 'SVGFill') {
        // patrón: se aproxima con el color de la línea del patrón, translúcido
        const sub = el.querySelector('symbol');
        const sym = sub ? symbolToStyle(sub, refScale) : null;
        const col = sym ? (sym.stroke !== 'none' ? sym.stroke : sym.fill) : null;
        if (col && st.fill === 'none') {
          st.fill = col;
          st.fillOpacity = 0.25;
          st.patternApprox = cls;
        }
      } else if (cls === 'SimpleLine') {
        // contorno como capa de línea: manda sobre el de SimpleFill
        const c = parseQgisColor(p.line_color);
        if (c && p.line_style !== 'no') {
          st.stroke = c.color;
          st.strokeOpacity = c.opacity;
          st.strokeWidth = toMm(p.line_width ?? 0.26, p.line_width_unit, refScale) ?? 0.26;
          st.dash = DASH_FROM_QGIS[p.line_style] || 'solid';
          const off = Number(p.offset || 0);
          // QGIS dibuja centrado; un offset positivo igual a medio grosor es "hacia afuera"
          st.align = Math.abs(off) > 1e-6 ? (off > 0 ? 'outside' : 'inside') : 'center';
          if (p.draw_inside_polygon === '1') st.align = 'inside';
        }
      }
    }
    if (st.fill === 'none' && st.stroke === 'none') return null;
    return st;
  }

  // marker
  const el = layers.find((l) => ['SimpleMarker', 'FontMarker', 'SvgMarker', 'EllipseMarker'].includes(l.getAttribute('class'))) || layers[0];
  if (!el) return null;
  const p = layerProps(el);
  const f = parseQgisColor(p.color) || { color: '#cc3333', opacity: 1 };
  const o = parseQgisColor(p.outline_color) || { color: '#ffffff', opacity: 1 };
  st.fill = f.color;
  st.fillOpacity = f.opacity;
  st.stroke = p.outline_style === 'no' ? 'none' : o.color;
  st.strokeOpacity = o.opacity;
  st.strokeWidth = toMm(p.outline_width ?? 0, p.outline_width_unit, refScale) ?? 0.2;
  st.pointShape = MARKER_FROM_QGIS[p.name] || 'circle';
  st.pointSize = toMm(p.size ?? 2, p.size_unit, refScale) ?? 2;
  return st;
}

/* ============================================================ QML -> reglas */

function rendererOf(doc) {
  return doc.querySelector('renderer-v2');
}

/**
 * QML (o QLR, o el XML de `layer_styles`) -> { rules, labels, warnings, rendererType }.
 * `rules`: [{ filter, style, label }] — la primera que coincide manda.
 */
export function parseQML(xmlText, { refScale = 25000, layerName = null } = {}) {
  const doc = new DOMParser().parseFromString(xmlText, 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('XML de estilo mal formado');
  let scope = doc;
  // QLR: puede traer varias capas; se usa la que se llama igual, o la primera
  const maplayers = [...doc.querySelectorAll('maplayer')];
  if (maplayers.length) {
    const named = layerName && maplayers.find((m) => m.querySelector(':scope > layername')?.textContent === layerName);
    scope = named || maplayers.find((m) => m.querySelector('renderer-v2')) || maplayers[0];
  }
  const renderer = scope.querySelector('renderer-v2');
  if (!renderer) throw new Error('El estilo no trae renderer-v2');
  const kind = renderer.getAttribute('type');
  const symbolsById = new Map();
  for (const s of renderer.querySelectorAll(':scope > symbols > symbol')) {
    symbolsById.set(s.getAttribute('name'), symbolToStyle(s, refScale));
  }
  const warnings = [];
  const rules = [];

  if (kind === 'singleSymbol') {
    const st = symbolsById.get('0') || symbolsById.values().next().value;
    if (st) rules.push({ filter: null, style: st, label: '' });
  } else if (kind === 'categorizedSymbol') {
    const attr = renderer.getAttribute('attr');
    for (const c of renderer.querySelectorAll(':scope > categories > category')) {
      if (c.getAttribute('render') === 'false') continue;
      const st = symbolsById.get(c.getAttribute('symbol'));
      if (!st) continue;
      const raw = c.getAttribute('value');
      const filter = raw === '' || raw === null ? null : ['==', ['get', attr], coerce(raw)];
      rules.push({ filter, style: st, label: c.getAttribute('label') || raw || '' });
    }
    rules.sort((a, b) => (a.filter === null ? 1 : 0) - (b.filter === null ? 1 : 0));
    if (/[()+|]/.test(attr || '')) warnings.push(`Categorías por expresión (${attr}): solo se evalúan nombres de campo`);
  } else if (kind === 'graduatedSymbol') {
    const attr = renderer.getAttribute('attr');
    for (const r of renderer.querySelectorAll(':scope > ranges > range')) {
      if (r.getAttribute('render') === 'false') continue;
      const st = symbolsById.get(r.getAttribute('symbol'));
      if (!st) continue;
      rules.push({
        filter: ['all', ['>=', ['get', attr], Number(r.getAttribute('lower'))], ['<=', ['get', attr], Number(r.getAttribute('upper'))]],
        style: st,
        label: r.getAttribute('label') || '',
      });
    }
  } else if (kind === 'RuleRenderer') {
    // reglas anidadas: el filtro de la hija se suma al del padre
    const walk = (el, parentFilter) => {
      for (const r of el.querySelectorAll(':scope > rule')) {
        if (r.getAttribute('active') === '0') continue;
        const raw = r.getAttribute('filter');
        let f = parseQgisFilter(raw);
        if (f === undefined) {
          warnings.push(`Filtro no interpretado: ${raw}`);
          f = null;
        }
        const filter = parentFilter && f ? ['all', parentFilter, f] : parentFilter || f;
        const st = r.getAttribute('symbol') != null ? symbolsById.get(r.getAttribute('symbol')) : null;
        if (st) rules.push({ filter, style: st, label: r.getAttribute('label') || '', elseRule: raw?.trim().toUpperCase() === 'ELSE' });
        walk(r, filter);
      }
    };
    const root = renderer.querySelector(':scope > rules');
    if (root) walk(root, null);
    // ELSE al final
    rules.sort((a, b) => (a.elseRule ? 1 : 0) - (b.elseRule ? 1 : 0));
  } else {
    warnings.push(`Renderer no soportado (${kind}); se usa el estilo por defecto`);
  }

  const labels = parseLabeling(scope, refScale);
  return { rules, labels, warnings, rendererType: kind };
}

/** `<labeling type="simple">` -> configuración de etiquetas de la capa. */
export function parseLabeling(scope, refScale = 25000) {
  const lab = scope.querySelector('labeling');
  if (!lab || lab.getAttribute('type') !== 'simple') return null;
  const ts = lab.querySelector('settings > text-style');
  if (!ts) return null;
  const field = ts.getAttribute('fieldName') || '';
  const isExpr = ts.getAttribute('isExpression') === '1';
  const unit = ts.getAttribute('fontSizeUnit') || 'Point';
  const size = Number(ts.getAttribute('fontSize') || 8);
  const buf = ts.querySelector('text-buffer');
  const color = parseQgisColor(ts.getAttribute('textColor'));
  const placement = lab.querySelector('settings > placement');
  const pl = Number(placement?.getAttribute('placement') ?? 0);
  return {
    enabled: scope.querySelector('labeling') !== null && (scope.querySelector('maplayer')?.getAttribute('labelsEnabled') ?? '1') !== '0',
    field: isExpr ? '' : field,
    template: isExpr ? qgisExprToTemplate(field) : '',
    fontFamily: `${ts.getAttribute('fontFamily') || 'Helvetica'}, Arial, sans-serif`,
    fontSize: unit === 'MM' ? size / 0.352778 : unit === 'MapUnit' ? (size * 1000) / refScale / 0.352778 : size,
    fontWeight: Number(ts.getAttribute('fontWeight') || 50) >= 63 ? 700 : 400,
    italic: ts.getAttribute('fontItalic') === '1',
    color: color?.color || '#111827',
    halo: buf?.getAttribute('bufferDraw') === '1',
    haloColor: parseQgisColor(buf?.getAttribute('bufferColor'))?.color || '#ffffff',
    haloWidth: Number(buf?.getAttribute('bufferSize') || 0.5),
    placement: pl === 2 || pl === 3 ? 'curved' : pl === 0 ? 'horizontal' : 'auto',
  };
}

/** `"codigo" || ' ' || "edad"` -> `{codigo} {edad}` (lo simple; el resto se avisa). */
export function qgisExprToTemplate(expr) {
  const parts = String(expr)
    .split('||')
    .map((p) => p.trim());
  return parts
    .map((p) => {
      const f = /^"([^"]+)"$/.exec(p);
      if (f) return `{${f[1]}}`;
      const s = /^'(.*)'$/s.exec(p);
      if (s) return s[1].replace(/''/g, "'");
      return `{${p.replace(/"/g, '')}}`;
    })
    .join('');
}

function coerce(v) {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/* ============================================================ evaluación */

/** Evalúa un filtro tipo MapLibre (['==', ['get', f], v], 'all', 'any'…) sobre atributos. */
export function evalFilter(f, attrs) {
  if (!f) return true;
  const [op, ...args] = f;
  if (op === 'all') return args.every((a) => evalFilter(a, attrs));
  if (op === 'any') return args.some((a) => evalFilter(a, attrs));
  const val = (x) => (Array.isArray(x) && x[0] === 'get' ? attrs?.[x[1]] : x);
  const a = val(args[0]);
  const b = val(args[1]);
  // los números llegan a veces como texto desde SQLite
  const na = typeof b === 'number' && a !== null && a !== '' && Number.isFinite(Number(a)) ? Number(a) : a;
  switch (op) {
    case '==':
      return na == b; // eslint-disable-line eqeqeq
    case '!=':
      return na != b; // eslint-disable-line eqeqeq
    case '<':
      return na < b;
    case '>':
      return na > b;
    case '<=':
      return na <= b;
    case '>=':
      return na >= b;
    default:
      return true;
  }
}

/** Estilo de un elemento según las reglas (null si ninguna aplica). */
export function styleFor(rules, attrs) {
  for (const r of rules) if (evalFilter(r.filter, attrs)) return r.style;
  return null;
}

/* ============================================================ estilo -> QML */

const xmlEsc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function rgba(hex, opacity = 1) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return '0,0,0,0';
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${Math.round(255 * (opacity ?? 1))}`;
}

const QGIS_DASH_NAME = { solid: 'solid', dash: 'dash', longdash: 'dash', sparse: 'dash', dot: 'dot', dashdot: 'dash dot', dashdotdot: 'dash dot dot' };

function opts(map) {
  return `<Option type="Map">${Object.entries(map)
    .map(([k, v]) => `<Option type="QString" name="${k}" value="${xmlEsc(v)}"/>`)
    .join('')}</Option>`;
}

/** Inverso de `svgRef`: el SVG de una ruta `base64:…` (o null). */
function decodeSvgRef(ref) {
  if (!ref || !String(ref).startsWith('base64:')) return null;
  try {
    const bin = atob(String(ref).slice(7));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** SVG como ruta incrustada de QGIS (`base64:…`): no depende de archivos aparte. */
function svgRef(svg) {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `base64:${btoa(bin)}`;
}

/**
 * Ornamento de falla o pliegue: un `MarkerLine` que repite el símbolo (SVG con
 * la misma geometría que el dibujo, halo incluido) a lo largo de la traza,
 * girado con ella, empezando a media separación como GISDrawer.
 */
function ornamentLayer(st) {
  const o = ornamentSymbolSvg(st);
  return o ? markerLineXml(o.svg, o.sizeMm, o.spacingMm, st.ornamentColor || st.stroke) : '';
}

/**
 * Línea ondulada (discordancia): un ciclo de la onda como SVG repetido cada
 * longitud de onda con un `MarkerLine` girado con la traza, empezando a media
 * longitud: los ciclos se encadenan en la misma fase que dibuja GISDrawer. El
 * halo de línea, si lo hay, va dentro del SVG, también ondulado.
 */
export function waveSvg(st) {
  const L = st.waveLen;
  const A = st.waveAmp;
  const w = st.strokeWidth || 0.1;
  const cw = st.casing ? w + 2 * (st.casingWidth || 0) : 0;
  const S = Math.round((Math.max(L / 2, A + Math.max(w, cw) / 2) + 0.05) * 1000) / 1000;
  const pts = [];
  for (let i = 0; i <= 32; i++) {
    const x = -L / 2 + (L * i) / 32;
    // GISDrawer desplaza a la derecha del avance A·sen(2πd/L); el ciclo n va centrado en d = L/2 + nL
    pts.push(`${x.toFixed(4)} ${(-A * Math.sin((2 * Math.PI * x) / L)).toFixed(4)}`);
  }
  const d = `M${pts.join('L')}`;
  const casing = cw
    ? `<path d="${d}" fill="none" stroke="${st.casingColor || '#ffffff'}" stroke-opacity="${st.casingOpacity ?? 1}" stroke-width="${cw}" stroke-linecap="round" stroke-linejoin="round"/>`
    : '';
  const W = (2 * S).toFixed(3);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${W}" viewBox="${-S} ${-S} ${W} ${W}" data-gd="wave" data-gd-amp="${A}" data-gd-len="${L}" data-gd-stroke="${st.stroke}" data-gd-width="${w}" data-gd-opacity="${st.strokeOpacity ?? 1}" data-gd-casing="${st.casing ? 1 : 0}" data-gd-casing-color="${st.casingColor || ''}" data-gd-casing-width="${st.casingWidth || 0}">${casing}<path d="${d}" fill="none" stroke="${st.stroke}" stroke-opacity="${st.strokeOpacity ?? 1}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function waveLayer(st) {
  const svg = waveSvg(st);
  const size = Number(/width="([\d.]+)"/.exec(svg)[1]);
  return markerLineXml(svg, size, st.waveLen, st.stroke);
}

/** `MarkerLine` que repite un SVG cada `interval` mm desde media separación, girado con la línea. */
function markerLineXml(svg, sizeMm, interval, color) {
  const marker = `<symbol type="marker" name="@m" alpha="1" clip_to_extent="1" force_rhr="0"><layer class="SvgMarker" enabled="1" locked="0" pass="0">${opts({
    name: svgRef(svg),
    size: sizeMm.toFixed(3),
    size_unit: 'MM',
    angle: '0',
    color: rgba(color, 1),
    outline_color: '0,0,0,0',
    outline_width: '0',
    outline_width_unit: 'MM',
    offset: '0,0',
    offset_unit: 'MM',
    horizontal_anchor_point: '1',
    vertical_anchor_point: '1',
    fixedAspectRatio: '0',
    scale_method: 'diameter',
  })}</layer></symbol>`;
  return `<layer class="MarkerLine" enabled="1" locked="0" pass="0">${opts({
    rotate: '1',
    placement: 'interval',
    placements: 'Interval',
    interval: interval.toFixed(3),
    interval_unit: 'MM',
    offset: '0',
    offset_unit: 'MM',
    offset_along_line: (interval / 2).toFixed(3),
    offset_along_line_unit: 'MM',
    place_on_every_part: 'true',
    average_angle_length: '4',
    average_angle_unit: 'MM',
  })}${marker}</layer>`;
}

/** Trama de litología: un `SVGFill` sobre el relleno de color (el SVG lleva su color y opacidad). */
function patternLayer(st) {
  const svg = patternTileSvg(st.pattern, st.patternColor || '#1f2937', st.patternOpacity ?? 1);
  if (!svg) return '';
  const noOutline = `<symbol type="line" name="@pat" alpha="1" clip_to_extent="1" force_rhr="0">${lineLayer({}, { width: 0, color: '#000000', opacity: 0, dash: 'no' })}</symbol>`;
  const body = opts({
    svgFile: svgRef(svg),
    patternWidth: Number(st.patternSize || 5).toFixed(3),
    patternWidth_unit: 'MM',
    angle: '0',
    color: rgba(st.patternColor || '#1f2937', 1),
    svgFillColor: rgba(st.patternColor || '#1f2937', 1),
    outline_color: '0,0,0,0',
    svgOutlineColor: '0,0,0,0',
    outline_width: '0',
    svgOutlineWidth: '0',
  });
  return `<layer class="SVGFill" enabled="1" locked="0" pass="0">${body}${noOutline}</layer>`;
}

function lineLayer(st, { width, color, opacity, offset = 0, dash }) {
  return `<layer class="SimpleLine" enabled="1" locked="0" pass="0">${opts({
    line_color: rgba(color, opacity),
    line_width: width.toFixed(3),
    line_width_unit: 'MM',
    line_style: QGIS_DASH_NAME[dash] || 'solid',
    capstyle: st.cap === 'butt' ? 'flat' : st.cap || 'round',
    joinstyle: st.join || 'round',
    offset: offset.toFixed(3),
    offset_unit: 'MM',
  })}</layer>`;
}

/** Símbolo QGIS para un estilo, según el tipo de geometría. */
export function styleToSymbolXml(st, kind, name) {
  if (kind === 'point') {
    const shape = Object.entries(MARKER_FROM_QGIS).find(([, v]) => v === st.pointShape)?.[0] || 'circle';
    return `<symbol type="marker" name="${name}" alpha="${st.opacity ?? 1}" clip_to_extent="1" force_rhr="0"><layer class="SimpleMarker" enabled="1" locked="0" pass="0">${opts({
      name: shape,
      color: rgba(st.fill !== 'none' ? st.fill : st.stroke, st.fillOpacity ?? 1),
      outline_color: rgba(st.stroke !== 'none' ? st.stroke : '#000000', st.stroke !== 'none' ? 1 : 0),
      outline_width: (st.strokeWidth || 0).toFixed(3),
      outline_width_unit: 'MM',
      size: (st.pointSize || 2.5).toFixed(3),
      size_unit: 'MM',
    })}</layer></symbol>`;
  }
  if (kind === 'line') {
    const layers = [];
    if (st.wavy && st.waveAmp > 0 && st.waveLen > 0) layers.push(waveLayer(st));
    else {
      if (st.casing) layers.push(lineLayer(st, { width: st.strokeWidth + 2 * st.casingWidth, color: st.casingColor, opacity: st.strokeOpacity, dash: st.dash }));
      layers.push(lineLayer(st, { width: st.strokeWidth, color: st.stroke, opacity: st.strokeOpacity, dash: st.dash }));
    }
    if (st.ornament && st.ornament !== 'none') layers.push(ornamentLayer(st));
    return `<symbol type="line" name="${name}" alpha="${st.opacity ?? 1}" clip_to_extent="1" force_rhr="0">${layers.join('')}</symbol>`;
  }
  const fill = st.fill && st.fill !== 'none';
  const fillLayer = `<layer class="SimpleFill" enabled="1" locked="0" pass="0">${opts({
    color: rgba(fill ? st.fill : '#000000', fill ? st.fillOpacity : 0),
    style: fill ? 'solid' : 'no',
    outline_style: 'no',
    outline_color: '0,0,0,0',
    outline_width: '0',
  })}</layer>`;
  const pattern = st.pattern && st.pattern !== 'none' ? patternLayer(st) : '';
  let outline = '';
  if (st.stroke && st.stroke !== 'none' && st.strokeWidth > 0) {
    // QGIS dibuja el contorno centrado; con un offset de medio grosor queda
    // completamente afuera (o adentro), igual que en GISDrawer.
    const off = st.align === 'outside' ? st.strokeWidth / 2 : st.align === 'inside' ? -st.strokeWidth / 2 : 0;
    outline = lineLayer(st, { width: st.strokeWidth, color: st.stroke, opacity: st.strokeOpacity, offset: off, dash: st.dash });
    // halo del trazo: una banda del color del halo por fuera (o a cada lado si el borde es centrado), por debajo
    if (st.casing && st.casingWidth > 0) {
      const cw = st.casingWidth;
      const cas =
        st.align === 'center'
          ? lineLayer(st, { width: st.strokeWidth + 2 * cw, color: st.casingColor, opacity: (st.casingOpacity ?? 1) * (st.strokeOpacity ?? 1), dash: st.dash })
          : lineLayer(st, { width: cw, color: st.casingColor, opacity: (st.casingOpacity ?? 1) * (st.strokeOpacity ?? 1), offset: (st.align === 'inside' ? -1 : 1) * (st.strokeWidth + cw / 2), dash: st.dash });
      outline = cas + outline;
    }
  }
  return `<symbol type="fill" name="${name}" alpha="${st.opacity ?? 1}" clip_to_extent="1" force_rhr="1">${fillLayer}${pattern}${outline}</symbol>`;
}

/** Nombre legible de un estilo para la leyenda de QGIS. */
export function describeStyle(st, kind) {
  const parts = [];
  if (st.ornament && st.ornament !== 'none') parts.push(String(ORNAMENTS[st.ornament]?.label || st.ornament).split(' (')[0]);
  if (st.pattern && st.pattern !== 'none') parts.push(PATTERNS[st.pattern]?.label || st.pattern);
  if (st.wavy) parts.push('Ondulada');
  if (!parts.length) {
    if (kind === 'polygon' && st.fill && st.fill !== 'none') parts.push(`Relleno ${st.fill}`);
    if (st.stroke && st.stroke !== 'none') parts.push(`${kind === 'polygon' ? 'borde' : 'línea'} ${st.stroke} ${Number(st.strokeWidth || 0).toFixed(2)} mm`);
    if (kind === 'point') parts.splice(0, parts.length, `Punto ${st.fill !== 'none' ? st.fill : st.stroke}`);
  }
  if (st.dash && st.dash !== 'solid' && DASHES[st.dash]) parts.push(DASHES[st.dash].label.toLowerCase());
  const s = parts.join(', ') || 'Sin estilo';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Renderizador de QGIS sobre un campo de atributos (Categorizado o Graduado),
 * con un símbolo por clase. `spec`:
 *   { mode: 'categorized'|'graduated', attr, numeric, classes: [{ key | lower+upper, label, style }],
 *     other: { label, style } | null }
 */
export function fieldRendererXml(spec, kind) {
  const attr = /^\w+$/.test(spec.attr) ? spec.attr : `&quot;${xmlEsc(spec.attr).replace(/&quot;/g, '')}&quot;`;
  const all = [...spec.classes, ...(spec.other ? [spec.other] : [])];
  const syms = all.map((c, i) => styleToSymbolXml(c.style, kind, String(i))).join('');
  const source = `<source-symbol>${styleToSymbolXml(all[0].style, kind, '0')}</source-symbol>`;
  if (spec.mode === 'graduated') {
    const ranges = spec.classes
      .map((c, i) => `<range render="true" symbol="${i}" lower="${c.lower}" upper="${c.upper}" label="${xmlEsc(c.label)}"/>`)
      .join('');
    return `<renderer-v2 type="graduatedSymbol" attr="${attr}" graduatedMethod="GraduatedColor" symbollevels="0" enableorderby="0" forceraster="0"><ranges>${ranges}</ranges><symbols>${syms}</symbols>${source}</renderer-v2>`;
  }
  const type = spec.numeric ? 'double' : 'string';
  const cats = all
    .map((c, i) => `<category render="true" symbol="${i}" value="${xmlEsc(c === spec.other ? '' : c.key)}" label="${xmlEsc(c.label)}" type="${c === spec.other ? 'string' : type}"/>`)
    .join('');
  return `<renderer-v2 type="categorizedSymbol" attr="${attr}" symbollevels="0" enableorderby="0" forceraster="0"><categories>${cats}</categories><symbols>${syms}</symbols>${source}</renderer-v2>`;
}

/** `<renderer-v2>` categorizado por `gd_style`: un símbolo por estilo del dibujo. */
export function rendererXml(styles, kind, labels = []) {
  const cats = styles
    .map((st, i) => `<category render="true" symbol="${i}" value="${i}" label="${xmlEsc(labels[i] || describeStyle(st, kind))}" type="string"/>`)
    .join('');
  const syms = styles.map((st, i) => styleToSymbolXml(st, kind, String(i))).join('');
  return `<renderer-v2 type="categorizedSymbol" attr="gd_style" symbollevels="0" enableorderby="0" forceraster="0"><categories>${cats}</categories><symbols>${syms}</symbols></renderer-v2>`;
}

const SEP_QGIS = { space: ' ', dash: ' – ', comma: ', ', slash: ' / ', pipe: ' | ', none: '' };

/** Referencia a un campo de GISDrawer en una expresión de QGIS. */
function qgisField(f) {
  if (f === '$nombre') return '"gd_name"';
  if (f === '$tipo') return 'geometry_type($geometry)';
  if (f === '$area_ha') return '($area / 10000)';
  return `"${String(f).replace(/"/g, '')}"`;
}

/**
 * Expresión de QGIS equivalente a la configuración de etiquetas de GISDrawer,
 * o `{ field }` si basta un campo.
 */
export function labelExpression(cfg) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const text = (f) => `coalesce(to_string(${qgisField(f)}), '')`;
  const wrap = (e) => (cfg.upper ? `upper(${e})` : e);
  if (cfg.template && cfg.template.trim()) {
    const parts = cfg.template
      .split(/(\{[^}]+\})/)
      .filter(Boolean)
      .map((p) => {
        const m = /^\{(.+)\}$/.exec(p);
        if (!m) return q(p);
        const alts = m[1].split('||').map((alt) => {
          const [head, ...filters] = alt.split('|').map((x) => x.trim());
          const mm = /^(.*?)(?::(\d+))?$/.exec(head);
          let e = mm[2] != null ? `format_number(${qgisField(mm[1].trim())}, ${mm[2]})` : text(mm[1].trim());
          for (const fl of filters) if (['upper', 'lower', 'title'].includes(fl)) e = `${fl}(${e})`;
          return `nullif(${e}, '')`;
        });
        return alts.length > 1 ? `coalesce(${alts.join(', ')}, '')` : `coalesce(${alts[0]}, '')`;
      });
    return { expr: wrap(parts.join(' || ')) };
  }
  if (cfg.fields?.length) {
    const sep = cfg.sep === 'paren' ? null : SEP_QGIS[cfg.sep] ?? ' ';
    const list = `array_filter(array(${cfg.fields.map(text).join(', ')}), length(@element) > 0)`;
    const e =
      sep != null
        ? `array_to_string(${list}, ${q(sep)})`
        : `if(array_length(${list}) > 1, array_get(${list}, 0) || ' (' || array_to_string(array_slice(${list}, 1, -1), ', ') || ')', array_to_string(${list}, ''))`;
    return { expr: wrap(e) };
  }
  if (cfg.field) return cfg.upper ? { expr: wrap(text(cfg.field)) } : { field: cfg.field === '$nombre' ? 'gd_name' : cfg.field };
  return null;
}

/** `<labeling>` simple de QGIS para la configuración de etiquetas de una capa. */
export function labelingXml(labelCfg, kind) {
  if (!labelCfg?.enabled) return '';
  const le = labelExpression(labelCfg);
  if (!le) return '';
  const field = le.expr ?? le.field;
  return `<labeling type="simple"><settings calloutType="simple"><text-style fieldName="${xmlEsc(field)}" isExpression="${
    le.expr ? 1 : 0
  }" fontFamily="${xmlEsc(String(labelCfg.fontFamily).split(',')[0].trim().replace(/'/g, ''))}" fontSize="${labelCfg.fontSize}" fontSizeUnit="Point" fontWeight="${
    labelCfg.fontWeight >= 700 ? 75 : 50
  }" fontItalic="${labelCfg.italic ? 1 : 0}" textColor="${rgba(labelCfg.color)}"><text-buffer bufferDraw="${labelCfg.halo ? 1 : 0}" bufferSize="${
    labelCfg.haloWidth
  }" bufferSizeUnits="MM" bufferColor="${rgba(labelCfg.haloColor)}"/></text-style><placement placement="${
    kind === 'line' ? (labelCfg.placement === 'curved' || labelCfg.placement === 'auto' ? 3 : 2) : kind === 'polygon' ? 1 : labelCfg.placement === 'over' ? 1 : 0
  }"/></settings></labeling>`;
}

/**
 * QML categorizado por el campo `gd_style`: cada estilo distinto del dibujo
 * es una categoría. Así QGIS abre el GeoPackage con el aspecto del dibujo.
 */
export function buildCategorizedQML(styles, kind, labelCfg = null, labels = [], fieldSpec = null) {
  const labeling = labelingXml(labelCfg, kind);
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34.0" styleCategories="Symbology|Labeling" labelsEnabled="${labeling ? 1 : 0}">
${fieldSpec ? fieldRendererXml(fieldSpec, kind) : rendererXml(styles, kind, labels)}
${labeling}
</qgis>`;
}

const QGIS_GEOM = { point: ['Point', 'Point'], line: ['Line', 'LineString'], polygon: ['Polygon', 'Polygon'] };

/**
 * Definición de capas de QGIS (.qlr): árbol de capas + una `<maplayer>` por
 * tabla del GeoPackage, con su simbología y etiquetas. La fuente es relativa
 * (`./archivo.gpkg|layername=tabla`): QGIS la resuelve junto al .qlr, así que
 * basta con dejar los dos archivos en la misma carpeta y arrastrar el .qlr.
 *
 * `tables`: [{ table, name, kind, styles, labels, labelCfg }] en orden de
 * pintado (de abajo hacia arriba, como `doc.layers`).
 */
export function buildQLR(tables, { gpkgName, title = 'GISDrawer' } = {}) {
  // `fieldSpec` (simbología por campo) manda sobre los estilos sueltos
  const ids = tables.map((t, i) => `${t.table}_${Date.now().toString(36)}${i}`);
  const src = (t) => `./${gpkgName}|layername=${t.table}`;
  // en QGIS el árbol va de arriba hacia abajo
  const order = tables.map((t, i) => i).reverse();
  const tree = order
    .map((i) => `<layer-tree-layer id="${ids[i]}" name="${xmlEsc(tables[i].name)}" source="${xmlEsc(src(tables[i]))}" providerKey="ogr" checked="Qt::Checked" expanded="1" legend_exp=""><customproperties><Option/></customproperties></layer-tree-layer>`)
    .join('\n      ');
  const srs = `<srs><spatialrefsys nativeFormat="Wkt"><wkt>${xmlEsc(DOC_WKT)}</wkt><proj4>+proj=utm +zone=19 +south +datum=WGS84 +units=m +no_defs</proj4><srsid>3112</srsid><srid>${DOC_EPSG}</srid><authid>EPSG:${DOC_EPSG}</authid><description>WGS 84 / UTM zone 19S</description><projectionacronym>utm</projectionacronym><ellipsoidacronym>EPSG:7030</ellipsoidacronym><geographicflag>false</geographicflag></spatialrefsys></srs>`;
  const layers = order
    .map((i) => {
      const t = tables[i];
      const labeling = labelingXml(t.labelCfg, t.kind);
      const [geometry, wkb] = QGIS_GEOM[t.kind];
      return `<maplayer type="vector" geometry="${geometry}" wkbType="${wkb}" autoRefreshTime="0" autoRefreshEnabled="0" hasScaleBasedVisibilityFlag="0" minScale="100000000" maxScale="0" readOnly="0" refreshOnNotifyEnabled="0" styleCategories="AllStyleCategories" simplifyAlgorithm="0" simplifyDrawingHints="0" simplifyDrawingTol="1" simplifyLocal="1" simplifyMaxScale="1" symbologyReferenceScale="-1" labelsEnabled="${labeling ? 1 : 0}">
      <id>${ids[i]}</id>
      <datasource>${xmlEsc(src(t))}</datasource>
      <keywordList><value></value></keywordList>
      <layername>${xmlEsc(t.name)}</layername>
      ${srs}
      <provider encoding="UTF-8">ogr</provider>
      <flags><Identifiable>1</Identifiable><Removable>1</Removable><Searchable>1</Searchable><Private>0</Private></flags>
      ${t.fieldSpec ? fieldRendererXml(t.fieldSpec, t.kind) : rendererXml(t.styles, t.kind, t.labels)}
      ${labeling}
      <blendMode>0</blendMode>
      <featureBlendMode>0</featureBlendMode>
      <layerOpacity>${t.opacity ?? 1}</layerOpacity>
    </maplayer>`;
    })
    .join('\n    ');
  return `<!DOCTYPE qgis-layer-definition>
<qlr>
  <layer-tree-group expanded="1" checked="Qt::Checked" name="" groupLayer="">
    <customproperties><Option/></customproperties>
    <layer-tree-group expanded="1" checked="Qt::Checked" name="${xmlEsc(title)}" groupLayer="">
      <customproperties><Option/></customproperties>
      ${tree}
    </layer-tree-group>
  </layer-tree-group>
  <maplayers>
    ${layers}
  </maplayers>
</qlr>
`;
}
