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

import { defaultStyle } from '../style.js';

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
    if (st.casing) layers.push(lineLayer(st, { width: st.strokeWidth + 2 * st.casingWidth, color: st.casingColor, opacity: st.strokeOpacity, dash: st.dash }));
    layers.push(lineLayer(st, { width: st.strokeWidth, color: st.stroke, opacity: st.strokeOpacity, dash: st.dash }));
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
  let outline = '';
  if (st.stroke && st.stroke !== 'none' && st.strokeWidth > 0) {
    // QGIS dibuja el contorno centrado; con un offset de medio grosor queda
    // completamente afuera (o adentro), igual que en GISDrawer.
    const off = st.align === 'outside' ? st.strokeWidth / 2 : st.align === 'inside' ? -st.strokeWidth / 2 : 0;
    outline = lineLayer(st, { width: st.strokeWidth, color: st.stroke, opacity: st.strokeOpacity, offset: off, dash: st.dash });
  }
  return `<symbol type="fill" name="${name}" alpha="${st.opacity ?? 1}" clip_to_extent="1" force_rhr="1">${fillLayer}${outline}</symbol>`;
}

/**
 * QML categorizado por el campo `gd_style`: cada estilo distinto del dibujo
 * es una categoría. Así QGIS abre el GeoPackage con el aspecto del dibujo.
 */
export function buildCategorizedQML(styles, kind, labelCfg = null) {
  const cats = styles
    .map((_, i) => `<category render="true" symbol="${i}" value="${i}" label="Estilo ${i + 1}" type="string"/>`)
    .join('');
  const syms = styles.map((st, i) => styleToSymbolXml(st, kind, String(i))).join('');
  let labeling = '';
  if (labelCfg?.enabled && (labelCfg.field || labelCfg.template)) {
    const field = labelCfg.template
      ? labelCfg.template
          .split(/(\{[^}]+\})/)
          .filter(Boolean)
          .map((p) => (/^\{.+\}$/.test(p) ? `"${p.slice(1, -1)}"` : `'${p.replace(/'/g, "''")}'`))
          .join(' || ')
      : labelCfg.field;
    labeling = `<labeling type="simple"><settings calloutType="simple"><text-style fieldName="${xmlEsc(field)}" isExpression="${
      labelCfg.template ? 1 : 0
    }" fontFamily="${xmlEsc(String(labelCfg.fontFamily).split(',')[0].trim())}" fontSize="${labelCfg.fontSize}" fontSizeUnit="Point" fontWeight="${
      labelCfg.fontWeight >= 700 ? 75 : 50
    }" fontItalic="${labelCfg.italic ? 1 : 0}" textColor="${rgba(labelCfg.color)}"><text-buffer bufferDraw="${labelCfg.halo ? 1 : 0}" bufferSize="${
      labelCfg.haloWidth
    }" bufferSizeUnits="MM" bufferColor="${rgba(labelCfg.haloColor)}"/></text-style><placement placement="${
      kind === 'line' ? (labelCfg.placement === 'curved' || labelCfg.placement === 'auto' ? 3 : 2) : kind === 'polygon' ? 1 : 0
    }"/></settings></labeling>`;
  }
  return `<!DOCTYPE qgis PUBLIC 'http://mrcc.com/qgis.dtd' 'SYSTEM'>
<qgis version="3.34.0" styleCategories="Symbology|Labeling" labelsEnabled="${labeling ? 1 : 0}">
<renderer-v2 type="categorizedSymbol" attr="gd_style" symbollevels="0" enableorderby="0" forceraster="0"><categories>${cats}</categories><symbols>${syms}</symbols></renderer-v2>
${labeling}
</qgis>`;
}
