/**
 * Qué trae el portapapeles, en texto: SVG suelto o dentro de HTML (copiado de
 * una página), imágenes referidas desde HTML y geometrías GIS en texto
 * (GeoJSON, WKT o la tabla que copia QGIS con «Copiar objetos»).
 * Todo es puro: se prueba sin navegador.
 */

const SVG_RE = /<svg[\s>]/i;

export function hasSvg(text) {
  return SVG_RE.test(text || '');
}

/** Decodifica una URL `data:image/svg+xml,...` (base64 o con escapes %). */
export function svgFromDataUrl(url) {
  const m = /^data:image\/svg\+xml(;[^,]*)?,(.*)$/is.exec(String(url || '').trim());
  if (!m) return '';
  try {
    const body = /;base64/i.test(m[1] || '') ? new TextDecoder().decode(Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0))) : decodeURIComponent(m[2]);
    return hasSvg(body) ? body : '';
  } catch {
    return '';
  }
}

const unescapeHtml = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * SVG dentro de un HTML: uno o varios `<svg>` en línea (se juntan en uno) o
 * un `<img>` / `<object>` con el SVG como data URL.
 */
export function svgFromHtml(html) {
  const h = String(html || '');
  const blocks = [];
  const re = /<svg[\s>][\s\S]*?<\/svg>/gi;
  // los <svg> anidados cierran antes: se busca el cierre que equilibra las aperturas
  let m;
  while ((m = re.exec(h))) {
    let end = m.index + m[0].length;
    let block = m[0];
    while ((block.match(/<svg[\s>]/gi) || []).length > (block.match(/<\/svg>/gi) || []).length) {
      const next = h.indexOf('</svg>', end);
      if (next < 0) break;
      end = next + 6;
      block = h.slice(m.index, end);
    }
    blocks.push(block);
    re.lastIndex = end;
  }
  if (blocks.length === 1) return blocks[0];
  if (blocks.length > 1) return `<svg xmlns="http://www.w3.org/2000/svg">${blocks.map((b) => `<g>${b}</g>`).join('')}</svg>`;
  for (const src of imageSourcesFromHtml(h)) {
    const svg = svgFromDataUrl(src);
    if (svg) return svg;
  }
  return '';
}

/** Fuentes de las imágenes (`<img src>`, `srcset` no) de un HTML, en orden. */
export function imageSourcesFromHtml(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<(?:img|image|object)\b[^>]*?\s(?:src|href|xlink:href|data)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    out.push(unescapeHtml(m[2] ?? m[3] ?? ''));
  }
  return out.filter(Boolean);
}

/* ------------------------------------------------------------------ WKT */

const TYPES = ['POINT', 'LINESTRING', 'POLYGON', 'MULTIPOINT', 'MULTILINESTRING', 'MULTIPOLYGON', 'GEOMETRYCOLLECTION'];

/**
 * WKT de geometría -> geometría GeoJSON. Admite Z/M (se descartan), EMPTY,
 * prefijo `SRID=xxxx;` (EWKT) y los tipos simples, múltiples y colecciones.
 * @returns {{geometry: object, srid: number|null}|null}
 */
export function parseWkt(text) {
  let s = String(text || '').trim();
  let srid = null;
  const sm = /^SRID=(\d+);/i.exec(s);
  if (sm) {
    srid = Number(sm[1]);
    s = s.slice(sm[0].length);
  }
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const word = () => {
    ws();
    const m = /^[A-Za-z]+/.exec(s.slice(i));
    if (!m) return null;
    i += m[0].length;
    return m[0].toUpperCase();
  };
  const peek = (c) => {
    ws();
    return s[i] === c;
  };
  const eat = (c) => {
    ws();
    if (s[i] !== c) throw new Error('WKT');
    i++;
  };
  const coord = () => {
    ws();
    const m = /^([-+]?[\d.]+(?:e[-+]?\d+)?)(?:\s+([-+]?[\d.]+(?:e[-+]?\d+)?))((?:\s+[-+]?[\d.]+(?:e[-+]?\d+)?)*)/i.exec(s.slice(i));
    if (!m) throw new Error('WKT');
    i += m[0].length;
    return [Number(m[1]), Number(m[2])];
  };
  const list = (item) => {
    eat('(');
    const out = [item()];
    while (peek(',')) {
      eat(',');
      out.push(item());
    }
    eat(')');
    return out;
  };
  // MULTIPOINT admite los puntos con y sin paréntesis propios
  const mpoint = () => {
    if (peek('(')) {
      eat('(');
      const c = coord();
      eat(')');
      return c;
    }
    return coord();
  };
  const geom = () => {
    const t = word();
    if (!t) throw new Error('WKT');
    let w = word();
    while (w === 'Z' || w === 'M' || w === 'ZM') w = word();
    if (w === 'EMPTY') return null;
    if (w) throw new Error('WKT');
    const ring = () => list(coord);
    const type = TYPES.includes(t) ? t : TYPES.find((k) => t === `${k}Z` || t === `${k}M` || t === `${k}ZM`);
    switch (type) {
      case 'POINT': {
        eat('(');
        const c = coord();
        eat(')');
        return { type: 'Point', coordinates: c };
      }
      case 'LINESTRING':
        return { type: 'LineString', coordinates: ring() };
      case 'POLYGON':
        return { type: 'Polygon', coordinates: list(ring) };
      case 'MULTIPOINT':
        return { type: 'MultiPoint', coordinates: list(mpoint) };
      case 'MULTILINESTRING':
        return { type: 'MultiLineString', coordinates: list(ring) };
      case 'MULTIPOLYGON':
        return { type: 'MultiPolygon', coordinates: list(() => list(ring)) };
      case 'GEOMETRYCOLLECTION':
        return { type: 'GeometryCollection', geometries: list(geom).filter(Boolean) };
      default:
        throw new Error('WKT');
    }
  };
  try {
    const geometry = geom();
    ws();
    if (i < s.length || !geometry) return null;
    return { geometry, srid };
  } catch {
    return null;
  }
}

const WKT_START = /^\s*(SRID=\d+;)?\s*(MULTI)?(POINT|LINESTRING|POLYGON)|^\s*(SRID=\d+;)?\s*GEOMETRYCOLLECTION/i;

/**
 * Geometrías GIS en un texto del portapapeles:
 * - GeoJSON (FeatureCollection, Feature o geometría);
 * - la tabla de QGIS «Copiar objetos» (columna `wkt_geom` y atributos separados por tabulador);
 * - una o varias líneas de WKT / EWKT.
 * @returns {{features: {geometry, properties}[], crs: string|number|null, coords: number[][]}|null}
 *   `crs`: el declarado (GeoJSON `crs`, EWKT `SRID`); `coords`: todas las coordenadas, para adivinarlo.
 */
export function featuresFromText(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  let features = null;
  let crs = null;
  if (/^[{[]/.test(t)) {
    try {
      const gj = JSON.parse(t);
      const list = Array.isArray(gj) ? gj : gj.type === 'FeatureCollection' ? gj.features : gj.type === 'Feature' ? [gj] : gj.type && (gj.coordinates || gj.geometries) ? [{ geometry: gj }] : null;
      if (list) {
        features = list.map((f) => (f?.type === 'Feature' || f?.geometry ? { geometry: f.geometry, properties: f.properties || {} } : { geometry: f, properties: {} })).filter((f) => f.geometry?.type);
        crs = gj.crs?.properties?.name || null;
      }
    } catch {
      return null;
    }
  } else {
    const lines = t.split(/\r?\n/).filter((l) => l.trim());
    const head = lines[0].split('\t');
    const gi = head.findIndex((h) => /^(wkt_geom|wkt|geom|geometry|the_geom)$/i.test(h.trim()));
    if (gi >= 0 && lines.length > 1) {
      // tabla de QGIS: la primera fila son los nombres de los campos
      features = [];
      for (const line of lines.slice(1)) {
        const cells = line.split('\t');
        const g = parseWkt(cells[gi]);
        if (!g) continue;
        if (g.srid) crs = g.srid;
        const properties = {};
        head.forEach((h, k) => {
          if (k === gi || !h.trim()) return;
          const v = cells[k] ?? '';
          properties[h.trim()] = v === 'NULL' ? null : v !== '' && !Number.isNaN(Number(v)) && /^[-+]?\d/.test(v) ? Number(v) : v;
        });
        features.push({ geometry: g.geometry, properties });
      }
    } else if (lines.every((l) => WKT_START.test(l))) {
      features = [];
      for (const line of lines) {
        const g = parseWkt(line);
        if (!g) return null;
        if (g.srid) crs = g.srid;
        features.push({ geometry: g.geometry, properties: {} });
      }
    }
  }
  if (!features?.length) return null;
  const coords = [];
  const walk = (c) => {
    if (typeof c?.[0] === 'number') coords.push(c);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  const walkGeom = (g) => (g.type === 'GeometryCollection' ? g.geometries.forEach(walkGeom) : walk(g.coordinates));
  features.forEach((f) => walkGeom(f.geometry));
  return { features, crs, coords };
}

/** ¿Coordenadas que solo pueden ser lon/lat en grados? */
export function looksLonLat(coords) {
  return coords.length > 0 && coords.every(([x, y]) => Math.abs(x) <= 180 && Math.abs(y) <= 90);
}
