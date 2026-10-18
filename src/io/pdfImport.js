/**
 * Illustrator (.ai) y PDF vectorial → SVG → formas de GISDrawer.
 *
 * Un .ai de Illustrator CS o posterior es, por dentro, un PDF: guarda una
 * copia «compatible con PDF» del dibujo (la opción «Crear archivo compatible
 * con PDF», activada por omisión) junto a los datos privados de Illustrator.
 * Aquí se lee esa copia: trazados con sus curvas Bézier, rellenos, trazos,
 * segmentados, transparencias, máscaras de recorte, degradados, colores de
 * tinta plana (Separation / DeviceN) y textos. Cada capa de Illustrator llega
 * al PDF como un «contenido opcional» (OCG): se convierte en un grupo con
 * nombre de primer nivel, y `importSvg` lo vuelve una capa de GISDrawer.
 * También sirve para PDF vectoriales de QGIS, ArcGIS, Inkscape, etc.
 *
 * Medidas: el PDF mide en puntos (1 unidad = 1 pt), igual que el SVG de
 * Illustrator; las medidas de papel se llevan al terreno con la escala de
 * referencia, como en el SVG.
 *
 * Sin dependencias ni DOM (pruebas en Node): trae su propio descompresor
 * Flate y lector de objetos PDF. No lee PDF cifrados ni los .ai antiguos
 * (Illustrator 8 o anterior, PostScript).
 */

import { importSvg, PT_MM } from './svgImport.js';

/* ============================================================== inflate */

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function huffman(lengths) {
  const count = new Uint16Array(16);
  for (const l of lengths) count[l]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let i = 1; i < 16; i++) offs[i] = offs[i - 1] + count[i - 1];
  const symbol = new Uint16Array(lengths.length);
  lengths.forEach((l, s) => {
    if (l) symbol[offs[l]++] = s;
  });
  return { count, symbol };
}

let FIXED = null;

/**
 * Descomprime zlib / deflate (RFC 1950 / 1951). Tolera datos truncados o con
 * basura al final, como los que se ven en PDF reales: devuelve lo que alcanzó.
 */
export function inflate(data) {
  let pos = (data[0] & 0x0f) === 8 && ((data[0] << 8) | data[1]) % 31 === 0 ? 2 : 0;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, data.length * 4));
  let n = 0;
  const need = (k) => {
    if (n + k <= out.length) return;
    const o2 = new Uint8Array(Math.max(out.length * 2, n + k));
    o2.set(out.subarray(0, n));
    out = o2;
  };
  const bits = (k) => {
    while (bitCnt < k) {
      if (pos >= data.length) throw new Error('eof');
      bitBuf |= data[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << k) - 1);
    bitBuf >>>= k;
    bitCnt -= k;
    return v;
  };
  const decode = (h) => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c;
      first = (first + c) << 1;
      code <<= 1;
    }
    throw new Error('código Huffman inválido');
  };
  try {
    let last = 0;
    while (!last) {
      last = bits(1);
      const type = bits(2);
      if (type === 0) {
        bitBuf = 0;
        bitCnt = 0;
        const len = data[pos] | (data[pos + 1] << 8);
        pos += 4;
        need(len);
        out.set(data.subarray(pos, pos + len), n);
        n += Math.min(len, data.length - pos);
        pos += len;
        continue;
      }
      let lit;
      let dist;
      if (type === 1) {
        if (!FIXED) {
          const l = new Array(288).fill(8, 0, 144).fill(9, 144, 256).fill(7, 256, 280).fill(8, 280, 288);
          FIXED = [huffman(l), huffman(new Array(30).fill(5))];
        }
        [lit, dist] = FIXED;
      } else if (type === 2) {
        const hlit = bits(5) + 257;
        const hdist = bits(5) + 1;
        const hclen = bits(4) + 4;
        const cl = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) cl[CLORDER[i]] = bits(3);
        const ch = huffman(cl);
        const lens = [];
        while (lens.length < hlit + hdist) {
          const sym = decode(ch);
          if (sym < 16) lens.push(sym);
          else if (sym === 16) lens.push(...new Array(3 + bits(2)).fill(lens[lens.length - 1]));
          else if (sym === 17) lens.push(...new Array(3 + bits(3)).fill(0));
          else lens.push(...new Array(11 + bits(7)).fill(0));
        }
        lit = huffman(lens.slice(0, hlit));
        dist = huffman(lens.slice(hlit, hlit + hdist));
      } else throw new Error('bloque deflate inválido');
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          need(1);
          out[n++] = sym;
        } else if (sym === 256) break;
        else {
          const s = sym - 257;
          const len = LBASE[s] + bits(LEXT[s]);
          const ds = decode(dist);
          const d = DBASE[ds] + bits(DEXT[ds]);
          need(len);
          for (let i = 0; i < len; i++, n++) out[n] = out[n - d];
        }
      }
    }
  } catch {
    /* truncado: se devuelve lo descomprimido hasta aquí */
  }
  return out.subarray(0, n);
}

/* ========================================================= objetos PDF */

class Name {
  constructor(v) {
    this.name = v;
  }
}
class Ref {
  constructor(num, gen) {
    this.num = num;
    this.gen = gen;
  }
}
class Op {
  constructor(v) {
    this.op = v;
  }
}
/** Cadena PDF: bytes como texto latin1 (un carácter por byte). */
class PStr {
  constructor(v) {
    this.s = v;
  }
}
class Stream {
  constructor(dict, bytes) {
    this.dict = dict;
    this.bytes = bytes;
  }
}

const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9 || c === 12 || c === 0;
const isDelim = (c) => c === 40 || c === 41 || c === 60 || c === 62 || c === 91 || c === 93 || c === 123 || c === 125 || c === 47 || c === 37;
const nameOf = (v) => (v instanceof Name ? v.name : null);

class Lexer {
  constructor(buf, pos = 0, end = buf.length) {
    this.b = buf;
    this.p = pos;
    this.end = end;
    this.peeked = [];
  }

  skip() {
    const b = this.b;
    while (this.p < this.end) {
      const c = b[this.p];
      if (isWs(c)) this.p++;
      else if (c === 37) {
        while (this.p < this.end && b[this.p] !== 10 && b[this.p] !== 13) this.p++;
      } else break;
    }
  }

  /** Siguiente token: número, Name, PStr, Op (palabra clave) o un delimitador '[', ']', '<<', '>>', '{', '}'. null al final. */
  raw() {
    this.skip();
    const b = this.b;
    if (this.p >= this.end) return null;
    const c = b[this.p];
    if (c === 47) {
      let s = '';
      this.p++;
      while (this.p < this.end && !isWs(b[this.p]) && !isDelim(b[this.p])) {
        if (b[this.p] === 35 && this.p + 2 < this.end) {
          s += String.fromCharCode(parseInt(String.fromCharCode(b[this.p + 1], b[this.p + 2]), 16));
          this.p += 3;
        } else s += String.fromCharCode(b[this.p++]);
      }
      return new Name(s);
    }
    if (c === 40) return new PStr(this.literal());
    if (c === 60) {
      if (b[this.p + 1] === 60) {
        this.p += 2;
        return '<<';
      }
      this.p++;
      let hex = '';
      while (this.p < this.end && b[this.p] !== 62) {
        if (!isWs(b[this.p])) hex += String.fromCharCode(b[this.p]);
        this.p++;
      }
      this.p++;
      if (hex.length % 2) hex += '0';
      let s = '';
      for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) || 0);
      return new PStr(s);
    }
    if (c === 62 && b[this.p + 1] === 62) {
      this.p += 2;
      return '>>';
    }
    if (c === 91 || c === 93 || c === 123 || c === 125) {
      this.p++;
      return String.fromCharCode(c);
    }
    let s = '';
    while (this.p < this.end && !isWs(b[this.p]) && !isDelim(b[this.p])) s += String.fromCharCode(b[this.p++]);
    if (!s) {
      this.p++; // delimitador suelto (")" o ">"): se ignora
      return this.raw();
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) return Number(s);
    if (/^[+-]?[\d.]+[-+][\d.]*$/.test(s)) return Number(s.replace(/(.)[-+].*$/, '$1')) || 0; // números mal escritos como "0.5-0.2"
    return new Op(s);
  }

  literal() {
    const b = this.b;
    this.p++;
    let depth = 1;
    let s = '';
    while (this.p < this.end) {
      const c = b[this.p++];
      if (c === 92) {
        const e = b[this.p++];
        if (e === 110) s += '\n';
        else if (e === 114) s += '\r';
        else if (e === 116) s += '\t';
        else if (e === 98) s += '\b';
        else if (e === 102) s += '\f';
        else if (e === 13) {
          if (b[this.p] === 10) this.p++;
        } else if (e === 10) {
          /* continuación de línea */
        } else if (e >= 48 && e <= 55) {
          let o = e - 48;
          for (let k = 0; k < 2 && b[this.p] >= 48 && b[this.p] <= 55; k++) o = o * 8 + (b[this.p++] - 48);
          s += String.fromCharCode(o & 255);
        } else s += String.fromCharCode(e);
      } else if (c === 40) {
        depth++;
        s += '(';
      } else if (c === 41) {
        if (--depth === 0) break;
        s += ')';
      } else s += String.fromCharCode(c);
    }
    return s;
  }

  token() {
    return this.peeked.length ? this.peeked.shift() : this.raw();
  }

  peek(i = 0) {
    while (this.peeked.length <= i) this.peeked.push(this.raw());
    return this.peeked[i];
  }

  /** Un objeto completo (con referencias "n g R"). */
  object(tok = this.token()) {
    if (tok === '[') {
      const arr = [];
      for (;;) {
        const t = this.token();
        if (t === ']' || t === null) return arr;
        arr.push(this.object(t));
      }
    }
    if (tok === '<<') {
      const d = {};
      for (;;) {
        const t = this.token();
        if (t === '>>' || t === null) return d;
        if (t instanceof Name) d[t.name] = this.object();
      }
    }
    if (typeof tok === 'number' && Number.isInteger(tok)) {
      const a = this.peek(0);
      const r = this.peek(1);
      if (typeof a === 'number' && r instanceof Op && r.op === 'R') {
        this.peeked.splice(0, 2);
        return new Ref(tok, a);
      }
    }
    if (tok instanceof Op) {
      if (tok.op === 'true') return true;
      if (tok.op === 'false') return false;
      if (tok.op === 'null') return null;
    }
    return tok;
  }
}

/* ============================================================== filtros */

function ascii85(b) {
  const out = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 126) break; // ~>
    if (isWs(c)) continue;
    if (c === 122 && count === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    tuple = tuple * 85 + (c - 33);
    if (++count === 5) {
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 1) {
    for (let k = count; k < 5; k++) tuple = tuple * 85 + 84;
    const bytes = [(tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255];
    out.push(...bytes.slice(0, count - 1));
  }
  return Uint8Array.from(out);
}

function asciiHex(b) {
  const out = [];
  let hi = -1;
  for (const c of b) {
    if (c === 62) break;
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v < 0) continue;
    if (hi < 0) hi = v;
    else {
      out.push(hi * 16 + v);
      hi = -1;
    }
  }
  if (hi >= 0) out.push(hi * 16);
  return Uint8Array.from(out);
}

function lzw(b, early = 1) {
  const out = [];
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push(null, null);
  };
  reset();
  let width = 9;
  let buf = 0;
  let cnt = 0;
  let prev = null;
  for (let i = 0; i < b.length; i++) {
    buf = (buf << 8) | b[i];
    cnt += 8;
    while (cnt >= width) {
      const code = (buf >>> (cnt - width)) & ((1 << width) - 1);
      cnt -= width;
      if (code === 256) {
        reset();
        width = 9;
        prev = null;
        continue;
      }
      if (code === 257) return Uint8Array.from(out);
      let entry = dict[code];
      if (!entry && prev) entry = [...prev, prev[0]];
      if (!entry) return Uint8Array.from(out);
      out.push(...entry);
      if (prev) dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + early >= 1 << width && width < 12) width++;
    }
  }
  return Uint8Array.from(out);
}

/** Predictores PNG / TIFF de Flate y LZW. */
function unpredict(b, parms) {
  const pred = parms?.Predictor || 1;
  if (pred < 2) return b;
  const colors = parms.Colors || 1;
  const bpc = parms.BitsPerComponent || 8;
  const cols = parms.Columns || 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const row = Math.ceil((colors * bpc * cols) / 8);
  if (pred === 2) {
    const out = b.slice();
    for (let r = 0; r < out.length; r += row) for (let i = bpp; i < row && r + i < out.length; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(b.length / (row + 1));
  const out = new Uint8Array(rows * row);
  for (let r = 0; r < rows; r++) {
    const f = b[r * (row + 1)];
    const src = r * (row + 1) + 1;
    const dst = r * row;
    for (let i = 0; i < row; i++) {
      const x = b[src + i];
      const a = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r ? out[dst - row + i] : 0;
      const c = r && i >= bpp ? out[dst - row + i - bpp] : 0;
      let v;
      if (f === 1) v = x + a;
      else if (f === 2) v = x + up;
      else if (f === 3) v = x + ((a + up) >> 1);
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      } else v = x;
      out[dst + i] = v & 255;
    }
  }
  return out;
}

/* ============================================================ documento */

/** Bytes → texto latin1 para buscar con expresiones regulares (mismo índice por byte). */
function latin1(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return s;
}

class PdfDoc {
  constructor(bytes) {
    this.b = bytes;
    this.text = latin1(bytes);
    this.where = new Map(); // num → posición de "obj" | { stm, index }
    this.cache = new Map();
    this.scan();
  }

  scan() {
    const re = /(\d+)\s+(\d+)\s+obj\b/g;
    let m;
    const stms = [];
    while ((m = re.exec(this.text))) {
      const prev = this.text.charCodeAt(m.index - 1);
      if (m.index > 0 && !isWs(prev) && !isDelim(prev) && prev !== 62) continue;
      this.where.set(Number(m[1]), m.index + m[0].length);
      if (/\/Type\s*\/ObjStm/.test(this.text.slice(re.lastIndex, re.lastIndex + 300))) stms.push(Number(m[1]));
    }
    // objetos comprimidos en flujos de objetos (PDF 1.5+): solo los que no están sueltos
    for (const sn of stms) {
      const st = this.get(sn);
      if (!(st instanceof Stream)) continue;
      const data = this.decode(st);
      const lx = new Lexer(data);
      const N = st.dict.N || 0;
      for (let i = 0; i < N; i++) {
        const num = lx.token();
        lx.token();
        if (typeof num === 'number' && !this.where.has(num)) this.where.set(num, { stm: sn, index: i });
      }
    }
  }

  get(num) {
    if (this.cache.has(num)) return this.cache.get(num);
    this.cache.set(num, null); // ciclos
    const w = this.where.get(num);
    let v = null;
    if (typeof w === 'number') v = this.parseAt(w);
    else if (w) v = this.fromStm(w.stm, w.index);
    this.cache.set(num, v);
    return v;
  }

  fromStm(sn, index) {
    const st = this.get(sn);
    if (!(st instanceof Stream)) return null;
    if (!st._data) st._data = this.decode(st);
    const lx = new Lexer(st._data);
    const N = st.dict.N || 0;
    const offs = [];
    for (let i = 0; i < N; i++) {
      lx.token();
      offs.push(lx.token());
    }
    const first = this.res(st.dict.First) || 0;
    return new Lexer(st._data, first + offs[index]).object();
  }

  parseAt(pos) {
    const lx = new Lexer(this.b, pos);
    const v = lx.object();
    const t = lx.token();
    if (!(t instanceof Op && t.op === 'stream') || typeof v !== 'object' || v === null) return v;
    // datos del flujo: tras "stream" y su fin de línea
    let start = lx.p;
    if (this.b[start] === 13) start++;
    if (this.b[start] === 10) start++;
    let len = this.res(v.Length);
    let end = typeof len === 'number' ? start + len : -1;
    if (end < 0 || !/^\s*endstream/.test(this.text.slice(end, end + 20))) {
      end = this.text.indexOf('endstream', start);
      if (end < 0) end = this.b.length;
      if (this.b[end - 1] === 10) end--;
      if (this.b[end - 1] === 13) end--;
    }
    return new Stream(v, this.b.subarray(start, end));
  }

  res(v) {
    let guard = 0;
    while (v instanceof Ref && guard++ < 20) v = this.get(v.num);
    return v;
  }

  decode(st) {
    if (!(st instanceof Stream)) return new Uint8Array(0);
    let data = st.bytes;
    let filters = this.res(st.dict.Filter);
    let parms = this.res(st.dict.DecodeParms);
    if (!filters) return data;
    if (!Array.isArray(filters)) {
      filters = [filters];
      parms = [parms];
    }
    filters.forEach((f, i) => {
      const n = nameOf(this.res(f));
      const p = this.res(Array.isArray(parms) ? parms[i] : null);
      if (n === 'FlateDecode' || n === 'Fl') data = unpredict(inflate(data), p);
      else if (n === 'ASCII85Decode' || n === 'A85') data = ascii85(data);
      else if (n === 'ASCIIHexDecode' || n === 'AHx') data = asciiHex(data);
      else if (n === 'LZWDecode' || n === 'LZW') data = unpredict(lzw(data, p?.EarlyChange ?? 1), p);
      else throw new Error(`filtro ${n} no soportado`);
    });
    return data;
  }

  /**
   * Datos de una imagen: aplica los filtros hasta uno de imagen (JPEG, JPEG
   * 2000, fax, JBIG2), que queda sin aplicar y se informa en `filter`.
   */
  decodeImage(st) {
    let filters = this.res(st.dict.Filter);
    let parms = this.res(st.dict.DecodeParms);
    if (!Array.isArray(filters)) {
      filters = filters ? [filters] : [];
      parms = [parms];
    }
    const names = filters.map((f) => nameOf(this.res(f)));
    const at = names.findIndex((n) => ['DCTDecode', 'DCT', 'JPXDecode', 'CCITTFaxDecode', 'CCF', 'JBIG2Decode'].includes(n));
    if (at < 0) return { data: this.decode(st), filter: null };
    const pre = new Stream({ ...st.dict, Filter: filters.slice(0, at), DecodeParms: Array.isArray(parms) ? parms.slice(0, at) : null }, st.bytes);
    const n = names[at];
    return { data: at ? this.decode(pre) : st.bytes, filter: n === 'DCT' ? 'DCTDecode' : n === 'CCF' ? 'CCITTFaxDecode' : n };
  }

  trailer() {
    let root = null;
    let encrypt = null;
    const re = /trailer\s*<</g;
    let m;
    while ((m = re.exec(this.text))) {
      const d = new Lexer(this.b, m.index + m[0].length - 2).object();
      if (d?.Root) root = d.Root;
      if (d?.Encrypt) encrypt = d.Encrypt;
    }
    if (!root) {
      for (const num of this.where.keys()) {
        if (!/\/XRef/.test(this.text.slice(this.where.get(num), this.where.get(num) + 400))) continue;
        const st = this.get(num);
        if (st instanceof Stream && nameOf(st.dict.Type) === 'XRef' && st.dict.Root) {
          root = st.dict.Root;
          encrypt = st.dict.Encrypt || encrypt;
        }
      }
    }
    if (!root) {
      for (const num of this.where.keys()) {
        const o = this.get(num);
        if (o && nameOf(o.Type) === 'Catalog') root = o;
      }
    }
    return { root: this.res(root), encrypt };
  }

  /** Páginas en orden, con lo heredado (Resources, MediaBox, CropBox). */
  pages(root) {
    const out = [];
    const walk = (node, inh, depth) => {
      node = this.res(node);
      if (!node || depth > 30) return;
      const here = { ...inh };
      for (const k of ['Resources', 'MediaBox', 'CropBox', 'Rotate']) if (node[k] != null) here[k] = this.res(node[k]);
      const kids = this.res(node.Kids);
      if (Array.isArray(kids)) for (const k of kids) walk(k, here, depth + 1);
      else if (nameOf(node.Type) !== 'Pages') out.push({ ...here, node });
    };
    walk(root?.Pages, {}, 0);
    return out;
  }
}

/* ========================================================= texto (PDF) */

const ASCII_NAMES = 'space exclam quotedbl numbersign dollar percent ampersand quotesingle parenleft parenright asterisk plus comma hyphen period slash zero one two three four five six seven eight nine colon semicolon less equal greater question at A B C D E F G H I J K L M N O P Q R S T U V W X Y Z bracketleft backslash bracketright asciicircum underscore grave a b c d e f g h i j k l m n o p q r s t u v w x y z braceleft bar braceright asciitilde'.split(' ');
const LATIN1_NAMES = 'nbspace exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot softhyphen registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis'.split(' ');
const WIN_HIGH = [0x20ac, 0, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0, 0x17d, 0, 0, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0, 0x17e, 0x178];
const MAC_HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
const GLYPHS = new Map([
  ...ASCII_NAMES.map((n, i) => [n, 0x20 + i]),
  ...LATIN1_NAMES.map((n, i) => [n, 0xa0 + i]),
  ['quoteleft', 0x2018], ['quoteright', 0x2019], ['quotedblleft', 0x201c], ['quotedblright', 0x201d], ['quotesinglbase', 0x201a],
  ['quotedblbase', 0x201e], ['endash', 0x2013], ['emdash', 0x2014], ['bullet', 0x2022], ['ellipsis', 0x2026], ['minus', 0x2212],
  ['fi', 0xfb01], ['fl', 0xfb02], ['dagger', 0x2020], ['daggerdbl', 0x2021], ['perthousand', 0x2030], ['trademark', 0x2122],
  ['Euro', 0x20ac], ['florin', 0x192], ['circumflex', 0x2c6], ['tilde', 0x2dc], ['OE', 0x152], ['oe', 0x153], ['Scaron', 0x160],
  ['scaron', 0x161], ['Zcaron', 0x17d], ['zcaron', 0x17e], ['Ydieresis', 0x178], ['dotlessi', 0x131], ['guilsinglleft', 0x2039],
  ['guilsinglright', 0x203a], ['degree', 0xb0], ['mu', 0xb5], ['uni00B5', 0xb5], ['periodcentered', 0xb7], ['middot', 0xb7],
]);

function glyphUnicode(name) {
  if (GLYPHS.has(name)) return String.fromCodePoint(GLYPHS.get(name));
  const base = name.split('.')[0];
  if (GLYPHS.has(base)) return String.fromCodePoint(GLYPHS.get(base));
  let m = /^uni([0-9A-F]{4,})$/i.exec(base);
  if (m) return m[1].match(/.{4}/g).map((h) => String.fromCharCode(parseInt(h, 16))).join('');
  m = /^u([0-9A-F]{4,6})$/i.exec(base);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  return null;
}

function baseEncoding(name) {
  const t = new Array(256).fill(null);
  for (let c = 32; c < 127; c++) t[c] = String.fromCharCode(c);
  for (let c = 160; c < 256; c++) t[c] = String.fromCharCode(c);
  if (name === 'MacRomanEncoding') for (let c = 128; c < 256; c++) t[c] = MAC_HIGH[c - 128];
  else for (let c = 128; c < 160; c++) t[c] = WIN_HIGH[c - 128] ? String.fromCharCode(WIN_HIGH[c - 128]) : null;
  if (name === 'StandardEncoding') {
    t[0x27] = '’';
    t[0x60] = '‘';
  }
  return t;
}

/** UTF-16BE (de un CMap o una cadena de texto PDF) → texto. */
function utf16be(s) {
  let out = '';
  for (let i = 0; i + 1 < s.length; i += 2) out += String.fromCharCode((s.charCodeAt(i) << 8) | s.charCodeAt(i + 1));
  return out;
}

/** Cadena de texto PDF (nombres de capa…): UTF-16 con BOM o PDFDocEncoding (≈ latin1). */
function textString(v) {
  const s = v instanceof PStr ? v.s : String(v ?? '');
  if (s.charCodeAt(0) === 0xfe && s.charCodeAt(1) === 0xff) return utf16be(s.slice(2));
  if (s.startsWith('\xef\xbb\xbf')) return decodeURIComponent(escape(s.slice(3)));
  return s;
}

/** CMap ToUnicode → Map(código → texto) y la longitud en bytes de los códigos. */
function parseToUnicode(data) {
  const map = new Map();
  const lx = new Lexer(data);
  let bytes = 0;
  const hexCode = (s) => {
    let v = 0;
    for (let i = 0; i < s.length; i++) v = v * 256 + s.charCodeAt(i);
    return v;
  };
  for (;;) {
    const t = lx.token();
    if (t === null) break;
    if (!(t instanceof Op)) continue;
    if (t.op === 'begincodespacerange') {
      for (;;) {
        const a = lx.token();
        if (!(a instanceof PStr)) break;
        lx.token();
        bytes = Math.max(bytes, a.s.length);
      }
    } else if (t.op === 'beginbfchar') {
      for (;;) {
        const a = lx.token();
        if (!(a instanceof PStr)) break;
        const d = lx.token();
        if (d instanceof PStr) map.set(hexCode(a.s), utf16be(d.s));
        else if (d instanceof Name) map.set(hexCode(a.s), glyphUnicode(d.name) || '');
      }
    } else if (t.op === 'beginbfrange') {
      for (;;) {
        const a = lx.token();
        if (!(a instanceof PStr)) break;
        const b = lx.token();
        const d = lx.object();
        const lo = hexCode(a.s);
        const hi = hexCode(b.s);
        if (hi - lo > 65535) continue;
        if (Array.isArray(d)) d.forEach((x, i) => x instanceof PStr && map.set(lo + i, utf16be(x.s)));
        else if (d instanceof PStr) {
          const u = utf16be(d.s);
          const head = u.slice(0, -1);
          const last = u.charCodeAt(u.length - 1);
          for (let c = lo; c <= hi; c++) map.set(c, head + String.fromCharCode(last + c - lo));
        }
      }
    }
  }
  return { map, bytes };
}

/** Fuente PDF → decodificador de códigos (texto Unicode y avance de cada glifo). */
function loadFont(pdf, dict) {
  dict = pdf.res(dict) || {};
  const sub = nameOf(dict.Subtype);
  let base = nameOf(dict.BaseFont) || '';
  const type0 = sub === 'Type0';
  const desc = type0 ? pdf.res(pdf.res(dict.DescendantFonts)?.[0]) || {} : dict;
  if (type0 && !base) base = nameOf(desc.BaseFont) || '';
  const fd = pdf.res(desc.FontDescriptor) || {};
  let tu = null;
  if (dict.ToUnicode) {
    const st = pdf.res(dict.ToUnicode);
    if (st instanceof Stream) tu = parseToUnicode(pdf.decode(st));
  }
  const fm = pdf.res(dict.FontMatrix);
  const wScale = sub === 'Type3' && Array.isArray(fm) ? fm[0] : 0.001;
  // anchos
  const widths = new Map();
  let dw = 0;
  if (type0) {
    dw = pdf.res(desc.DW) ?? 1000;
    const W = pdf.res(desc.W) || [];
    for (let i = 0; i < W.length; ) {
      const first = pdf.res(W[i]);
      const next = pdf.res(W[i + 1]);
      if (Array.isArray(next)) {
        next.forEach((w, k) => widths.set(first + k, pdf.res(w)));
        i += 2;
      } else {
        const w = pdf.res(W[i + 2]);
        for (let c = first; c <= next && c - first < 65536; c++) widths.set(c, w);
        i += 3;
      }
    }
  } else {
    const fc = pdf.res(dict.FirstChar) || 0;
    (pdf.res(dict.Widths) || []).forEach((w, i) => widths.set(fc + i, pdf.res(w)));
    dw = pdf.res(fd.MissingWidth) || (widths.size ? 0 : 550);
  }
  // codificación de las fuentes simples
  let table = null;
  if (!type0) {
    const enc = pdf.res(dict.Encoding);
    table = baseEncoding(nameOf(enc) || nameOf(pdf.res(enc?.BaseEncoding)) || 'WinAnsiEncoding');
    const diffs = pdf.res(enc?.Differences);
    if (Array.isArray(diffs)) {
      let code = 0;
      for (const d of diffs) {
        const v = pdf.res(d);
        if (typeof v === 'number') code = v;
        else if (v instanceof Name) table[code++ & 255] = glyphUnicode(v.name);
      }
    }
  }
  const nbytes = type0 ? tu?.bytes || 2 : 1;
  const clean = base.replace(/^[A-Z]{6}\+/, '');
  const [fam, style = ''] = clean.split(/[-,]/);
  const family = fam.replace(/(PS)?MT$|PS$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim() || 'Helvetica';
  const flags = pdf.res(fd.Flags) || 0;
  return {
    family,
    bold: /bold|black|heavy|semibold|demi/i.test(style || clean) || (pdf.res(fd.FontWeight) || 0) >= 600,
    italic: /italic|oblique|^it$/i.test(style) || (flags & 64) !== 0,
    /** bytes de una cadena → [{ u: texto, w: avance en unidades de texto (× tamaño), space }] */
    glyphs(s) {
      const out = [];
      for (let i = 0; i + nbytes <= s.length; i += nbytes) {
        let code = 0;
        for (let k = 0; k < nbytes; k++) code = code * 256 + s.charCodeAt(i + k);
        let u = tu?.map.get(code);
        if (u == null) u = type0 ? (code >= 32 ? String.fromCharCode(code) : '') : table[code] ?? '';
        const w = (widths.get(code) ?? dw) * wScale;
        out.push({ u, w, space: nbytes === 1 && code === 32 });
      }
      return out;
    },
  };
}

/* ======================================================= colores y funciones */

const clamp = (v, a = 0, b = 1) => (Number.isFinite(v) ? Math.max(a, Math.min(b, v)) : a);
const hex = (rgb) => `#${rgb.map((v) => Math.round(clamp(v) * 255).toString(16).padStart(2, '0')).join('')}`;
const cmyk = ([c, m, y, k]) => [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];

function labToRgb([L, a, b]) {
  const f = (t) => (t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29));
  const fy = (L + 16) / 116;
  const X = 0.9505 * f(fy + a / 500);
  const Y = f(fy);
  const Z = 1.089 * f(fy - b / 200);
  const g = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  return [g(3.2406 * X - 1.5372 * Y - 0.4986 * Z), g(-0.9689 * X + 1.8758 * Y + 0.0415 * Z), g(0.0557 * X - 0.204 * Y + 1.057 * Z)];
}

/** Calculadora PostScript (funciones de tipo 4). */
function psFunction(src) {
  const lx = new Lexer(src);
  const parse = () => {
    const prog = [];
    for (;;) {
      const t = lx.token();
      if (t === null || t === '}') return prog;
      if (t === '{') prog.push(parse());
      else prog.push(t instanceof Op ? t.op : t);
    }
  };
  lx.token(); // {
  const prog = parse();
  const run = (p, st) => {
    for (let i = 0; i < p.length; i++) {
      const t = p[i];
      if (typeof t === 'number' || Array.isArray(t)) {
        st.push(t);
        continue;
      }
      const b = typeof t === 'string' ? t : '';
      const pop = () => st.pop();
      switch (b) {
        case 'add': st.push(pop() + pop()); break;
        case 'sub': { const y = pop(); st.push(pop() - y); break; }
        case 'mul': st.push(pop() * pop()); break;
        case 'div': { const y = pop(); st.push(pop() / y); break; }
        case 'idiv': { const y = pop(); st.push(Math.trunc(pop() / y)); break; }
        case 'mod': { const y = pop(); st.push(pop() % y); break; }
        case 'neg': st.push(-pop()); break;
        case 'abs': st.push(Math.abs(pop())); break;
        case 'ceiling': st.push(Math.ceil(pop())); break;
        case 'floor': st.push(Math.floor(pop())); break;
        case 'round': st.push(Math.round(pop())); break;
        case 'truncate': st.push(Math.trunc(pop())); break;
        case 'sqrt': st.push(Math.sqrt(pop())); break;
        case 'exp': { const e = pop(); st.push(pop() ** e); break; }
        case 'ln': st.push(Math.log(pop())); break;
        case 'log': st.push(Math.log10(pop())); break;
        case 'sin': st.push(Math.sin((pop() * Math.PI) / 180)); break;
        case 'cos': st.push(Math.cos((pop() * Math.PI) / 180)); break;
        case 'atan': { const d = pop(); st.push(((Math.atan2(pop(), d) * 180) / Math.PI + 360) % 360); break; }
        case 'cvi': st.push(Math.trunc(pop())); break;
        case 'cvr': break;
        case 'dup': st.push(st[st.length - 1]); break;
        case 'pop': pop(); break;
        case 'exch': { const y = pop(); const x = pop(); st.push(y, x); break; }
        case 'copy': { const n = pop(); st.push(...st.slice(st.length - n)); break; }
        case 'index': { const n = pop(); st.push(st[st.length - 1 - n]); break; }
        case 'roll': {
          const j = pop();
          const n = pop();
          if (n > 0) {
            const part = st.splice(st.length - n, n);
            const s = ((j % n) + n) % n;
            st.push(...part.slice(n - s), ...part.slice(0, n - s));
          }
          break;
        }
        case 'eq': st.push(pop() === pop()); break;
        case 'ne': st.push(pop() !== pop()); break;
        case 'gt': { const y = pop(); st.push(pop() > y); break; }
        case 'ge': { const y = pop(); st.push(pop() >= y); break; }
        case 'lt': { const y = pop(); st.push(pop() < y); break; }
        case 'le': { const y = pop(); st.push(pop() <= y); break; }
        case 'and': { const y = pop(); const x = pop(); st.push(typeof x === 'boolean' ? x && y : x & y); break; }
        case 'or': { const y = pop(); const x = pop(); st.push(typeof x === 'boolean' ? x || y : x | y); break; }
        case 'xor': { const y = pop(); const x = pop(); st.push(typeof x === 'boolean' ? x !== y : x ^ y); break; }
        case 'not': { const x = pop(); st.push(typeof x === 'boolean' ? !x : ~x); break; }
        case 'true': st.push(true); break;
        case 'false': st.push(false); break;
        case 'if': { const p1 = pop(); if (pop()) run(p1, st); break; }
        case 'ifelse': { const p2 = pop(); const p1 = pop(); run(pop() ? p1 : p2, st); break; }
        default: break;
      }
    }
  };
  return (inp) => {
    const st = [...inp];
    try {
      run(prog, st);
    } catch {
      /* programa raro: lo que haya quedado */
    }
    return st.map(Number);
  };
}

function makeFunction(pdf, obj, depth = 0) {
  obj = pdf.res(obj);
  if (Array.isArray(obj)) {
    const fs = obj.map((f) => makeFunction(pdf, f, depth + 1));
    return (x) => fs.flatMap((f) => f(x));
  }
  const d = obj instanceof Stream ? obj.dict : obj;
  if (!d || depth > 8) return (x) => x;
  const type = pdf.res(d.FunctionType);
  const domain = pdf.res(d.Domain) || [0, 1];
  const range = pdf.res(d.Range);
  const clip = (out) => (range ? out.map((v, i) => clamp(v, range[2 * i], range[2 * i + 1])) : out);
  if (type === 2) {
    const c0 = pdf.res(d.C0) || [0];
    const c1 = pdf.res(d.C1) || [1];
    const n = pdf.res(d.N) ?? 1;
    return ([x]) => {
      const t = clamp(x, domain[0], domain[1]) ** n;
      return clip(c0.map((v, i) => v + t * (c1[i] - v)));
    };
  }
  if (type === 3) {
    const fs = (pdf.res(d.Functions) || []).map((f) => makeFunction(pdf, f, depth + 1));
    const bounds = pdf.res(d.Bounds) || [];
    const enc = pdf.res(d.Encode) || [];
    return ([x]) => {
      x = clamp(x, domain[0], domain[1]);
      let i = 0;
      while (i < bounds.length && x >= bounds[i]) i++;
      const lo = i ? bounds[i - 1] : domain[0];
      const hi = i < bounds.length ? bounds[i] : domain[1];
      const e0 = enc[2 * i] ?? 0;
      const e1 = enc[2 * i + 1] ?? 1;
      const t = hi > lo ? e0 + ((x - lo) * (e1 - e0)) / (hi - lo) : e0;
      return clip(fs[i] ? fs[i]([t]) : [t]);
    };
  }
  if (type === 4 && obj instanceof Stream) {
    const f = psFunction(pdf.decode(obj));
    return (x) => clip(f(x));
  }
  if (type === 0 && obj instanceof Stream) {
    const size = pdf.res(d.Size) || [2];
    const bps = pdf.res(d.BitsPerSample) || 8;
    const data = pdf.decode(obj);
    const nOut = range ? range.length / 2 : 1;
    const enc = pdf.res(d.Encode) || size.flatMap((s) => [0, s - 1]);
    const dec = pdf.res(d.Decode) || range || [0, 1];
    const max = 2 ** bps - 1;
    const sample = (idx) => {
      const out = [];
      for (let j = 0; j < nOut; j++) {
        const bit = (idx * nOut + j) * bps;
        let v = 0;
        for (let k = 0; k < bps; k++) v = v * 2 + ((data[(bit + k) >> 3] >> (7 - ((bit + k) & 7))) & 1);
        out.push(dec[2 * j] + (v / max) * (dec[2 * j + 1] - dec[2 * j]));
      }
      return out;
    };
    return (x) => {
      // interpolación lineal en la primera entrada, la más cercana en las demás
      let idx = 0;
      let mulSz = 1;
      let frac = 0;
      let step = 1;
      x.forEach((v, i) => {
        const e = enc[2 * i] + ((clamp(v, domain[2 * i], domain[2 * i + 1]) - domain[2 * i]) * (enc[2 * i + 1] - enc[2 * i])) / (domain[2 * i + 1] - domain[2 * i] || 1);
        const ei = clamp(e, 0, size[i] - 1);
        const fl = i === 0 ? Math.floor(ei) : Math.round(ei);
        if (i === 0) {
          frac = ei - fl;
          step = fl < size[0] - 1 ? 1 : 0;
        }
        idx += fl * mulSz;
        mulSz *= size[i];
      });
      const a = sample(idx);
      if (!frac || !step) return clip(a);
      const b = sample(idx + step);
      return clip(a.map((v, i) => v + frac * (b[i] - v)));
    };
  }
  return (x) => x;
}

/** Espacio de color PDF → { n, rgb(comps) → [r,g,b] 0..1, pattern? }. */
function makeColorSpace(pdf, cs, resources, depth = 0) {
  cs = pdf.res(cs);
  const nm = nameOf(cs);
  if (nm) {
    if (nm === 'DeviceGray' || nm === 'G' || nm === 'CalGray') return { n: 1, kind: 'gray', rgb: ([g]) => [g, g, g] };
    if (nm === 'DeviceRGB' || nm === 'RGB' || nm === 'CalRGB') return { n: 3, kind: 'rgb', rgb: (c) => c };
    if (nm === 'DeviceCMYK' || nm === 'CMYK') return { n: 4, kind: 'cmyk', rgb: cmyk };
    if (nm === 'Pattern') return { n: 0, pattern: true, rgb: () => [0.5, 0.5, 0.5] };
    const named = pdf.res(pdf.res(resources?.ColorSpace)?.[nm]);
    if (named && depth < 6) return makeColorSpace(pdf, named, resources, depth + 1);
    return { n: 1, rgb: ([g]) => [g, g, g] };
  }
  if (!Array.isArray(cs) || depth > 6) return { n: 1, rgb: ([g]) => [g, g, g] };
  const kind = nameOf(cs[0]);
  switch (kind) {
    case 'ICCBased': {
      const st = pdf.res(cs[1]);
      const n = pdf.res(st?.dict?.N) || 3;
      if (st?.dict?.Alternate) return makeColorSpace(pdf, st.dict.Alternate, resources, depth + 1);
      return makeColorSpace(pdf, new Name(n === 1 ? 'DeviceGray' : n === 4 ? 'DeviceCMYK' : 'DeviceRGB'), resources, depth + 1);
    }
    case 'CalRGB':
      return { n: 3, kind: 'rgb', rgb: (c) => c };
    case 'CalGray':
      return { n: 1, kind: 'gray', rgb: ([g]) => [g, g, g] };
    case 'Lab':
      return { n: 3, rgb: labToRgb };
    case 'Indexed':
    case 'I': {
      const base = makeColorSpace(pdf, cs[1], resources, depth + 1);
      const look = pdf.res(cs[3]);
      const bytes = look instanceof Stream ? pdf.decode(look) : Uint8Array.from((look?.s || '').split('').map((c) => c.charCodeAt(0)));
      return {
        n: 1,
        indexed: true,
        rgb: ([i]) => {
          const at = Math.round(i) * base.n;
          return base.rgb([...bytes.subarray(at, at + base.n)].map((v) => v / 255));
        },
      };
    }
    case 'Separation':
    case 'DeviceN': {
      const names = kind === 'Separation' ? [cs[1]] : pdf.res(cs[1]) || [];
      const alt = makeColorSpace(pdf, cs[2], resources, depth + 1);
      const tint = makeFunction(pdf, cs[3]);
      const n = names.length || 1;
      if (nameOf(pdf.res(names[0])) === 'All' && kind === 'Separation') return { n, tint: true, rgb: ([t]) => [1 - t, 1 - t, 1 - t] };
      return { n, tint: true, rgb: (c) => alt.rgb(tint(c)) };
    }
    case 'Pattern':
      return { n: 0, pattern: true, rgb: () => [0.5, 0.5, 0.5] };
    default:
      return makeColorSpace(pdf, cs[0], resources, depth + 1);
  }
}

/* ================================================== matrices (estilo PDF) */

/** [a b c d e f] como en PDF: p' = p × M. mul(A, B) = primero A, después B. */
const mul = (A, B) => [
  A[0] * B[0] + A[1] * B[2],
  A[0] * B[1] + A[1] * B[3],
  A[2] * B[0] + A[3] * B[2],
  A[2] * B[1] + A[3] * B[3],
  A[4] * B[0] + A[5] * B[2] + B[4],
  A[4] * B[1] + A[5] * B[3] + B[5],
];
const apply = (M, x, y) => [x * M[0] + y * M[2] + M[4], x * M[1] + y * M[3] + M[5]];
const ID = [1, 0, 0, 1, 0, 0];
const f3 = (v) => +(+v).toFixed(3);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// caracteres no válidos en XML 1.0 (códigos de control de fuentes sin ToUnicode)
const xmlText = (s) => esc(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, ''));

/* ========================================================== intérprete */

class Converter {
  constructor(pdf, page, warnings) {
    this.pdf = pdf;
    this.warnings = warnings;
    const box = (page.CropBox || page.MediaBox || [0, 0, 612, 792]).map((v) => pdf.res(v));
    const [x0, y0, x1, y1] = [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])];
    this.W = x1 - x0;
    this.H = y1 - y0;
    // espacio de la página (y hacia arriba) → SVG (y hacia abajo, origen arriba a la izquierda)
    this.F = [1, 0, 0, -1, -x0, y1];
    this.defs = [];
    this.buckets = new Map(); // nombre de capa (o '') → [{ svg, clips }]
    this.order = [];
    this.nextId = 0;
    this.texts = [];
    this.fonts = new Map();
    this.ocNames = new Map();
    this.depth = 0;
    this.images = [];
    this.pixels = new Map(); // XObject de imagen → píxeles (una imagen colocada varias veces se lee una vez)
  }

  /**
   * Imagen colocada: sus píxeles y la matriz del cuadrado unidad de la imagen
   * a la página (SVG). Se devuelve aparte del SVG: GISDrawer la vuelve una
   * capa de imagen.
   */
  addImage(xo, gs, resources) {
    const M = mul(gs.ctm, this.F);
    const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([u, v]) => apply(M, u, v));
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (box[2] - box[0] < 0.5 || box[3] - box[1] < 0.5) return;
    if (!this.pixels.has(xo)) {
      let px = null;
      try {
        px = imagePixels(this.pdf, xo, resources, gs.fill?.css || '#000000', (w) => this.warn(w));
      } catch {
        this.warn('una imagen no se pudo leer');
      }
      this.pixels.set(xo, px);
    }
    const px = this.pixels.get(xo);
    if (!px) return;
    const layer = this.ocName(xo.dict.OC) ?? this.mc.find((m) => m.layer != null)?.layer ?? '';
    // de píxel de la imagen (fila 0 arriba) al recuadro de la imagen en la página
    const T = mul(mul([1 / px.w, 0, 0, -1 / px.h, 0, 1], M), [1, 0, 0, 1, -box[0], -box[1]]);
    this.images.push({ layer, px, box, T, area: Math.abs(M[0] * M[3] - M[1] * M[2]), opacity: gs.fa < 1 ? gs.fa : 1 });
  }

  uid(p) {
    return `${p}${this.nextId++}`;
  }

  warn(s) {
    this.warnings.add(s);
  }

  initialState() {
    const black = { css: '#000000' };
    return {
      ctm: ID, fill: black, stroke: black, fcs: { n: 1, rgb: ([g]) => [g, g, g] }, scs: { n: 1, rgb: ([g]) => [g, g, g] },
      lw: 1, cap: 0, join: 0, miter: 10, dash: [[], 0], fa: 1, sa: 1, clips: [],
      font: null, fs: 12, tc: 0, tw: 0, th: 1, tl: 0, ts: 0, tr: 0,
    };
  }

  emit(svg, clips) {
    const layer = this.mc.find((m) => m.layer != null)?.layer ?? '';
    if (!this.buckets.has(layer)) {
      this.buckets.set(layer, []);
      this.order.push(layer);
    }
    this.buckets.get(layer).push({ svg, clips: clips.slice() });
  }

  run(content, resources) {
    this.mc = [];
    this.exec(content, resources, this.initialState(), 0);
    this.flushText();
  }

  /** Ejecuta un flujo de contenido. */
  exec(data, resources, gs, depth) {
    const pdf = this.pdf;
    const lx = new Lexer(data);
    const stack = [];
    const gstack = [];
    let path = []; // subtrayectos: [{ d: string, pts: [[x,y]...] }]
    let cur = null;
    let pendingClip = null;
    let start = null;
    let tm = ID;
    let tlm = ID;
    let inText = false;
    const full = () => mul(gs.ctm, this.F);
    const pt = (x, y) => apply(full(), x, y);
    const moveTo = (x, y) => {
      const p = pt(x, y);
      cur = { d: `M${f3(p[0])} ${f3(p[1])}`, pts: [p] };
      path.push(cur);
      start = [x, y];
      return p;
    };
    let last = [0, 0];
    const lineTo = (x, y) => {
      if (!cur) moveTo(last[0], last[1]);
      const p = pt(x, y);
      cur.d += `L${f3(p[0])} ${f3(p[1])}`;
      cur.pts.push(p);
    };
    const curveTo = (x1, y1, x2, y2, x3, y3) => {
      if (!cur) moveTo(last[0], last[1]);
      const a = pt(x1, y1);
      const b = pt(x2, y2);
      const c = pt(x3, y3);
      cur.d += `C${f3(a[0])} ${f3(a[1])} ${f3(b[0])} ${f3(b[1])} ${f3(c[0])} ${f3(c[1])}`;
      cur.pts.push(a, b, c);
    };
    const closePath = () => {
      if (cur) {
        cur.d += 'Z';
        cur.closed = true;
        if (start) last = start;
      }
      cur = null;
    };
    const color = (cs, comps) => {
      if (cs.pattern) return null;
      return { css: hex(cs.rgb(comps.slice(0, cs.n || comps.length))) };
    };
    const scaleOf = () => Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) || 1;
    const paint = (fill, stroke, evenOdd) => {
      // el PDF rellena los subtrayectos abiertos como si estuvieran cerrados
      const d = path.map((s) => (fill && !stroke && !s.closed && s.pts.length > 2 ? `${s.d}Z` : s.d)).join('');
      if (d && (fill || stroke)) {
        const at = [`d="${d}"`];
        if (fill) {
          at.push(`fill="${this.paintRef(gs.fill, gs, resources)}"`);
          if (gs.fa < 1) at.push(`fill-opacity="${f3(gs.fa)}"`);
          if (evenOdd) at.push('fill-rule="evenodd"');
        } else at.push('fill="none"');
        if (stroke) {
          const k = scaleOf();
          at.push(`stroke="${this.paintRef(gs.stroke, gs, resources)}"`, `stroke-width="${f3(Math.max(gs.lw * k, 0.1))}"`);
          if (gs.sa < 1) at.push(`stroke-opacity="${f3(gs.sa)}"`);
          if (gs.cap) at.push(`stroke-linecap="${gs.cap === 1 ? 'round' : 'square'}"`);
          if (gs.join) at.push(`stroke-linejoin="${gs.join === 1 ? 'round' : 'bevel'}"`);
          else if (gs.miter !== 10 && gs.miter !== 4) at.push(`stroke-miterlimit="${f3(gs.miter)}"`);
          const dash = (gs.dash[0] || []).map((v) => f3(v * k));
          if (dash.length && dash.some((v) => v > 0)) at.push(`stroke-dasharray="${dash.join(' ')}"`);
        } else at.push('stroke="none"');
        this.emit(`<path ${at.join(' ')}/>`, gs.clips);
      }
      endPath();
    };
    const endPath = () => {
      if (pendingClip && path.length) {
        const d = path.map((s) => s.d).join('');
        const pts = path.flatMap((s) => s.pts);
        const xs = pts.map((p) => p[0]);
        const ys = pts.map((p) => p[1]);
        const covers = Math.min(...xs) <= 0.5 && Math.min(...ys) <= 0.5 && Math.max(...xs) >= this.W - 0.5 && Math.max(...ys) >= this.H - 0.5;
        // un recorte que cubre toda la página (el de la mesa de trabajo) no recorta nada: se omite
        if (!covers) {
          const id = this.uid('c');
          this.defs.push(`<clipPath id="${id}"><path d="${d}"${pendingClip === 'evenodd' ? ' clip-rule="evenodd"' : ''}/></clipPath>`);
          gs.clips = [...gs.clips, id];
          this.clipD.set(id, d);
        }
      }
      pendingClip = null;
      path = [];
      cur = null;
    };
    if (!this.clipD) this.clipD = new Map();

    const showText = (str) => {
      if (!gs.font) return;
      const glyphs = gs.font.glyphs(str);
      if (!glyphs.length) return;
      const visible = gs.tr !== 3 && gs.tr !== 7;
      // matriz del texto: espacio del glifo (tamaño 1, y hacia abajo) → SVG
      const M = mul(mul([1, 0, 0, -1, 0, 0], [gs.th, 0, 0, 1, 0, gs.ts]), mul(tm, full()));
      let text = '';
      let adv = 0;
      for (const g of glyphs) {
        text += g.u;
        const tx = (g.w * gs.fs + gs.tc + (g.space ? gs.tw : 0)) * gs.th;
        adv += tx;
        tm = mul([1, 0, 0, 1, tx, 0], tm);
      }
      if (visible && this.texts.length < 20000) this.texts.push({ M, end: apply(mul(tm, full()), 0, gs.ts), text, fs: gs.fs, font: gs.font, fill: gs.fill, fa: gs.fa, clips: gs.clips.slice(), layer: this.mc.find((m) => m.layer != null)?.layer ?? '', adv });
    };

    for (;;) {
      const t = lx.token();
      if (t === null) break;
      if (!(t instanceof Op)) {
        stack.push(t === '[' || t === '<<' ? lx.object(t) : t);
        continue;
      }
      const a = stack;
      const num = (i) => Number(a[i]) || 0;
      try {
        switch (t.op) {
          // ---- estado gráfico
          case 'q':
            gstack.push({ ...gs });
            break;
          case 'Q':
            if (gstack.length) gs = gstack.pop();
            break;
          case 'cm':
            if (a.length >= 6) gs.ctm = mul(a.slice(-6).map(Number), gs.ctm);
            break;
          case 'w': gs.lw = Number(a[a.length - 1]) || 0; break;
          case 'J': gs.cap = Number(a[a.length - 1]) || 0; break;
          case 'j': gs.join = Number(a[a.length - 1]) || 0; break;
          case 'M': gs.miter = Number(a[a.length - 1]) || 10; break;
          case 'd': gs.dash = [(pdf.res(a[a.length - 2]) || []).map(Number), Number(a[a.length - 1]) || 0]; break;
          case 'ri': case 'i': break;
          case 'gs': {
            const eg = pdf.res(pdf.res(resources?.ExtGState)?.[nameOf(a[a.length - 1])]);
            if (eg) {
              if (eg.CA != null) gs.sa = Number(pdf.res(eg.CA));
              if (eg.ca != null) gs.fa = Number(pdf.res(eg.ca));
              if (eg.LW != null) gs.lw = Number(pdf.res(eg.LW));
              if (eg.LC != null) gs.cap = Number(pdf.res(eg.LC));
              if (eg.LJ != null) gs.join = Number(pdf.res(eg.LJ));
              if (eg.ML != null) gs.miter = Number(pdf.res(eg.ML));
              const D = pdf.res(eg.D);
              if (Array.isArray(D)) gs.dash = [(pdf.res(D[0]) || []).map(Number), Number(D[1]) || 0];
              const sm = pdf.res(eg.SMask);
              if (sm && nameOf(sm) !== 'None') this.warn('las máscaras de opacidad no se importan');
              const bm = nameOf(pdf.res(Array.isArray(eg.BM) ? eg.BM[0] : eg.BM));
              if (bm && bm !== 'Normal' && bm !== 'Compatible') this.warn(`modo de fusión «${bm}» aplicado como normal`);
              if (Array.isArray(pdf.res(eg.Font))) {
                const [fr, sz] = pdf.res(eg.Font);
                gs.font = this.font(fr);
                gs.fs = Number(sz) || gs.fs;
              }
            }
            break;
          }
          // ---- trayectos
          case 'm': last = [num(a.length - 2), num(a.length - 1)]; moveTo(...last); break;
          case 'l': lineTo(num(a.length - 2), num(a.length - 1)); last = [num(a.length - 2), num(a.length - 1)]; break;
          case 'c': {
            const v = a.slice(-6).map(Number);
            curveTo(...v);
            last = [v[4], v[5]];
            break;
          }
          case 'v': {
            const v = a.slice(-4).map(Number);
            curveTo(last[0], last[1], ...v);
            last = [v[2], v[3]];
            break;
          }
          case 'y': {
            const v = a.slice(-4).map(Number);
            curveTo(v[0], v[1], v[2], v[3], v[2], v[3]);
            last = [v[2], v[3]];
            break;
          }
          case 'h': closePath(); break;
          case 're': {
            const [x, y, w, hh] = a.slice(-4).map(Number);
            moveTo(x, y);
            lineTo(x + w, y);
            lineTo(x + w, y + hh);
            lineTo(x, y + hh);
            closePath();
            last = [x, y];
            break;
          }
          case 'S': paint(false, true, false); break;
          case 's': closePath(); paint(false, true, false); break;
          case 'f': case 'F': paint(true, false, false); break;
          case 'f*': paint(true, false, true); break;
          case 'B': paint(true, true, false); break;
          case 'B*': paint(true, true, true); break;
          case 'b': closePath(); paint(true, true, false); break;
          case 'b*': closePath(); paint(true, true, true); break;
          case 'n': endPath(); break;
          case 'W': pendingClip = 'nonzero'; break;
          case 'W*': pendingClip = 'evenodd'; break;
          // ---- color
          case 'g': gs.fcs = makeColorSpace(pdf, new Name('DeviceGray')); gs.fill = color(gs.fcs, [num(a.length - 1)]); break;
          case 'G': gs.scs = makeColorSpace(pdf, new Name('DeviceGray')); gs.stroke = color(gs.scs, [num(a.length - 1)]); break;
          case 'rg': gs.fcs = makeColorSpace(pdf, new Name('DeviceRGB')); gs.fill = color(gs.fcs, a.slice(-3).map(Number)); break;
          case 'RG': gs.scs = makeColorSpace(pdf, new Name('DeviceRGB')); gs.stroke = color(gs.scs, a.slice(-3).map(Number)); break;
          case 'k': gs.fcs = makeColorSpace(pdf, new Name('DeviceCMYK')); gs.fill = color(gs.fcs, a.slice(-4).map(Number)); break;
          case 'K': gs.scs = makeColorSpace(pdf, new Name('DeviceCMYK')); gs.stroke = color(gs.scs, a.slice(-4).map(Number)); break;
          case 'cs':
          case 'CS': {
            const cs = makeColorSpace(pdf, a[a.length - 1], resources);
            // color inicial: negro (tinta plana al 100 %)
            const initial = cs.pattern ? null : { css: hex(cs.rgb(cs.n === 4 && !cs.tint ? [0, 0, 0, 1] : new Array(cs.n).fill(cs.tint ? 1 : 0))) };
            if (t.op === 'cs') {
              gs.fcs = cs;
              gs.fill = initial || { css: '#000000' };
            } else {
              gs.scs = cs;
              gs.stroke = initial || { css: '#000000' };
            }
            break;
          }
          case 'sc': case 'scn': case 'SC': case 'SCN': {
            const fillOp = t.op[0] === 's';
            const cs = fillOp ? gs.fcs : gs.scs;
            const last1 = a[a.length - 1];
            let c;
            if (last1 instanceof Name) {
              const pat = pdf.res(pdf.res(resources?.Pattern)?.[last1.name]);
              c = { css: '#808080', pattern: pat };
            } else c = color(cs, a.filter((v) => typeof v === 'number')) || { css: '#808080' };
            if (fillOp) gs.fill = c;
            else gs.stroke = c;
            break;
          }
          case 'sh': {
            const sh = pdf.res(pdf.res(resources?.Shading)?.[nameOf(a[a.length - 1])]);
            const grad = this.gradient(sh, gs.ctm, resources);
            const clips = gs.clips.slice();
            const id = clips.pop();
            const d = id ? this.clipD.get(id) : `M0 0H${f3(this.W)}V${f3(this.H)}H0Z`;
            if (d) this.emit(`<path d="${d}" fill="${grad || '#808080'}" stroke="none"${gs.fa < 1 ? ` fill-opacity="${f3(gs.fa)}"` : ''}/>`, clips);
            break;
          }
          // ---- objetos externos
          case 'Do': {
            const xo = pdf.res(pdf.res(resources?.XObject)?.[nameOf(a[a.length - 1])]);
            if (!(xo instanceof Stream)) break;
            const st = nameOf(xo.dict.Subtype);
            if (st === 'Form' && depth < 12) {
              const saved = { ...gs };
              const m = pdf.res(xo.dict.Matrix);
              if (Array.isArray(m)) gs.ctm = mul(m.map((v) => Number(pdf.res(v))), gs.ctm);
              const oc = this.ocName(xo.dict.OC);
              if (oc != null) this.mc.push({ layer: oc });
              this.exec(pdf.decode(xo), pdf.res(xo.dict.Resources) || resources, gs, depth + 1);
              if (oc != null) this.mc.pop();
              gs = saved;
            } else if (st === 'Image') this.addImage(xo, gs, resources);
            break;
          }
          case 'BI': {
            // imagen en línea: se salta hasta EI
            const s = latin1(data.subarray(lx.p, Math.min(data.length, lx.p + 4_000_000)));
            const m = /\sID[\s\S]*?\sEI(?=[\s]|$)/.exec(s);
            lx.p += m ? m.index + m[0].length : s.length;
            lx.peeked = [];
            this.warn('las imágenes en línea (pequeñas, dentro del contenido) no se importan');
            break;
          }
          // ---- contenido marcado (capas de Illustrator)
          case 'BDC': {
            const tag = nameOf(a[a.length - 2]);
            let props = a[a.length - 1];
            if (props instanceof Name) props = pdf.res(pdf.res(resources?.Properties)?.[props.name]);
            this.mc.push({ layer: tag === 'OC' ? this.ocName(props) : null });
            break;
          }
          case 'BMC': this.mc.push({ layer: null }); break;
          case 'EMC': this.mc.pop(); break;
          // ---- texto
          case 'BT': tm = ID; tlm = ID; inText = true; break;
          case 'ET': inText = false; this.flushText(); break;
          case 'Tf':
            gs.font = this.font(pdf.res(pdf.res(resources?.Font)?.[nameOf(a[a.length - 2])]));
            gs.fs = Number(a[a.length - 1]) || 0;
            break;
          case 'Tc': gs.tc = num(a.length - 1); break;
          case 'Tw': gs.tw = num(a.length - 1); break;
          case 'Tz': gs.th = num(a.length - 1) / 100; break;
          case 'TL': gs.tl = num(a.length - 1); break;
          case 'Ts': gs.ts = num(a.length - 1); break;
          case 'Tr': gs.tr = num(a.length - 1); break;
          case 'Td': tlm = mul([1, 0, 0, 1, num(a.length - 2), num(a.length - 1)], tlm); tm = tlm; break;
          case 'TD': gs.tl = -num(a.length - 1); tlm = mul([1, 0, 0, 1, num(a.length - 2), num(a.length - 1)], tlm); tm = tlm; break;
          case 'Tm': tlm = a.slice(-6).map(Number); tm = tlm; break;
          case 'T*': tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm); tm = tlm; break;
          case 'Tj': if (a[a.length - 1] instanceof PStr) showText(a[a.length - 1].s); break;
          case "'":
            tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
            tm = tlm;
            if (a[a.length - 1] instanceof PStr) showText(a[a.length - 1].s);
            break;
          case '"':
            gs.tw = num(a.length - 3);
            gs.tc = num(a.length - 2);
            tlm = mul([1, 0, 0, 1, 0, -gs.tl], tlm);
            tm = tlm;
            if (a[a.length - 1] instanceof PStr) showText(a[a.length - 1].s);
            break;
          case 'TJ': {
            const arr = a[a.length - 1];
            if (!Array.isArray(arr)) break;
            for (const it of arr) {
              if (it instanceof PStr) showText(it.s);
              else if (typeof it === 'number') {
                const tx = (-it / 1000) * gs.fs * gs.th;
                tm = mul([1, 0, 0, 1, tx, 0], tm);
                // un salto grande dentro del arreglo es un espacio entre palabras
                if (-it > 250 && this.texts.length) this.texts[this.texts.length - 1].gapAfter = true;
              }
            }
            break;
          }
          case 'd0': case 'd1': case 'BX': case 'EX': case 'MP': case 'DP': break;
          default: break;
        }
      } catch {
        this.warn('algunas instrucciones del PDF no se pudieron leer');
      }
      stack.length = 0;
    }
    if (inText) this.flushText();
  }

  font(ref) {
    const d = this.pdf.res(ref);
    if (!d) return null;
    if (!this.fonts.has(d)) this.fonts.set(d, loadFont(this.pdf, d));
    return this.fonts.get(d);
  }

  ocName(props) {
    const pdf = this.pdf;
    let p = pdf.res(props);
    if (!p || typeof p !== 'object') return null;
    if (nameOf(p.Type) === 'OCMD') {
      const ocgs = pdf.res(p.OCGs);
      p = pdf.res(Array.isArray(ocgs) ? ocgs[0] : ocgs);
    }
    if (!p?.Name) return null;
    return textString(pdf.res(p.Name)).trim() || 'Capa';
  }

  /** Relleno: color, o un degradado (patrón de sombreado) definido en <defs>. */
  paintRef(c, gs, resources) {
    if (!c?.pattern) return c?.css || '#000000';
    const pat = c.pattern;
    const d = pat instanceof Stream ? pat.dict : pat;
    if (pdfType(this.pdf, d) === 1) {
      this.warn('los rellenos de motivo (pattern) llegan como gris');
      return '#808080';
    }
    const m = this.pdf.res(d.Matrix);
    const g = this.gradient(this.pdf.res(d.Shading), Array.isArray(m) ? m.map((v) => Number(this.pdf.res(v))) : ID, resources);
    return g || '#808080';
  }

  /** Sombreado axial / radial → <linearGradient> / <radialGradient>; devuelve url(#id). */
  gradient(sh, matrix, resources) {
    const pdf = this.pdf;
    sh = pdf.res(sh);
    const d = sh instanceof Stream ? sh.dict : sh;
    if (!d) return null;
    const type = pdf.res(d.ShadingType);
    if (type !== 2 && type !== 3) {
      this.warn('los degradados de malla llegan como color plano');
      return null;
    }
    if (!d.Function) return null;
    const cs = makeColorSpace(pdf, d.ColorSpace, resources);
    const fn = makeFunction(pdf, d.Function);
    const dom = pdf.res(d.Domain) || [0, 1];
    const fd = pdf.res(d.Function);
    const fdict = fd instanceof Stream ? fd.dict : fd;
    let ts = [0, 0.25, 0.5, 0.75, 1];
    if (!Array.isArray(fdict) && pdf.res(fdict?.FunctionType) === 3) {
      const b = pdf.res(fdict.Bounds) || [];
      const fdom = pdf.res(fdict.Domain) || [0, 1];
      ts = [fdom[0], ...b, fdom[1]].map((v) => (v - fdom[0]) / (fdom[1] - fdom[0] || 1));
      ts = [...new Set(ts.flatMap((v, i) => (i ? [(ts[i - 1] + v) / 2, v] : [v])))];
    } else if (!Array.isArray(fdict) && pdf.res(fdict?.FunctionType) === 2 && (pdf.res(fdict.N) ?? 1) === 1) ts = [0, 1];
    if (ts.length > 11) ts = Array.from({ length: 11 }, (_, i) => i / 10);
    const stops = ts.map((t) => {
      const rgb = cs.rgb(fn([dom[0] + t * (dom[1] - dom[0])]));
      return `<stop offset="${f3(t)}" stop-color="${hex(rgb)}"/>`;
    });
    const coords = (pdf.res(d.Coords) || []).map(Number);
    const M = mul(matrix, this.F);
    const id = this.uid('g');
    if (type === 2) {
      const [x1, y1] = apply(M, coords[0], coords[1]);
      const [x2, y2] = apply(M, coords[2], coords[3]);
      this.defs.push(`<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f3(x1)}" y1="${f3(y1)}" x2="${f3(x2)}" y2="${f3(y2)}">${stops.join('')}</linearGradient>`);
    } else {
      const [cx, cy] = apply(M, coords[3], coords[4]);
      const r = coords[5] * Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
      this.defs.push(`<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f3(cx)}" cy="${f3(cy)}" r="${f3(r)}">${stops.join('')}</radialGradient>`);
    }
    return `url(#${id})`;
  }

  /**
   * Los trozos de texto (Illustrator escribe cada palabra o letra con
   * kerning como un trozo aparte) se juntan en un texto por línea de base y
   * orientación; las líneas seguidas del mismo bloque, en un texto de varias
   * líneas.
   */
  flushText() {
    const pieces = this.texts;
    this.texts = [];
    let group = null;
    const same = (A, B) => Math.abs(A[0] - B[0]) + Math.abs(A[1] - B[1]) + Math.abs(A[2] - B[2]) + Math.abs(A[3] - B[3]) < 1e-3 * (Math.abs(A[0]) + Math.abs(A[3]) + 1e-9);
    const groups = [];
    for (const p of pieces) {
      if (!p.text) continue;
      if (group && same(group.M, p.M) && group.layer === p.layer && group.clips.join() === p.clips.join()) {
        // posición local, en unidades del texto
        const inv = invert(group.M);
        const [lx, ly] = apply(inv, p.M[4], p.M[5]);
        const prev = group.lines[group.lines.length - 1];
        const lastPiece = prev.pieces[prev.pieces.length - 1];
        const [ex] = apply(inv, lastPiece.end[0], lastPiece.end[1]);
        const fs = p.fs || 1;
        if (Math.abs(ly - prev.y) < 0.2 * fs && lx > ex - 0.5 * fs && lx - ex < 3 * fs) {
          if ((lx - ex > 0.2 * fs || lastPiece.gapAfter) && !/\s$/.test(lastPiece.text) && !/^\s/.test(p.text)) p.text = ` ${p.text}`;
          prev.pieces.push(p);
          continue;
        }
        if (ly > prev.y && ly - prev.y < 3 * fs) {
          group.lines.push({ x: lx, y: ly, pieces: [p] });
          continue;
        }
      }
      group = { M: p.M, layer: p.layer, clips: p.clips, lines: [] };
      group.lines.push({ x: 0, y: 0, pieces: [p] });
      groups.push(group);
    }
    for (const g of groups) {
      const p0 = g.lines[0].pieces[0];
      const attrs = (p) => {
        const out = [`fill="${p.fill?.pattern ? '#808080' : p.fill?.css || '#000000'}"`, `font-size="${f3(p.fs)}"`, `font-family="${esc(p.font.family)}"`];
        out.push(`font-weight="${p.font.bold ? 700 : 400}"`, `font-style="${p.font.italic ? 'italic' : 'normal'}"`);
        if (p.fa < 1) out.push(`fill-opacity="${f3(p.fa)}"`);
        return out.join(' ');
      };
      let body = '';
      for (const ln of g.lines) {
        ln.pieces.forEach((p, i) => {
          body += `<tspan${i ? '' : ` x="${f3(ln.x)}" y="${f3(ln.y)}"`} ${attrs(p)}>${xmlText(p.text)}</tspan>`;
        });
      }
      const M = g.M;
      const svg = `<text transform="matrix(${M.map(f3).join(' ')})" ${attrs(p0)} xml:space="preserve">${body}</text>`;
      const saved = this.mc;
      this.mc = [{ layer: g.layer }];
      this.emit(svg, g.clips);
      this.mc = saved;
    }
  }

  svg(title) {
    const nest = (items, depth) => {
      let out = '';
      for (let i = 0; i < items.length; ) {
        const id = items[i].clips[depth];
        if (id == null) {
          out += items[i++].svg;
          continue;
        }
        let j = i;
        while (j < items.length && items[j].clips[depth] === id) j++;
        out += `<g clip-path="url(#${id})">${nest(items.slice(i, j), depth + 1)}</g>`;
        i = j;
      }
      return out;
    };
    let body = '';
    const used = new Map();
    for (const name of this.order) {
      const inner = nest(this.buckets.get(name), 0);
      if (!name) body += inner;
      else {
        // nombre repetido: el SVG necesita ids únicos
        const n = (used.get(name) || 0) + 1;
        used.set(name, n);
        const id = `${name.replace(/[^\w-]+/g, '_').replace(/^(?=[\d-])/, '_')}${n > 1 ? `_${n}` : ''}`;
        body += `<g id="${esc(id)}" data-name="${esc(name)}">${inner}</g>`;
      }
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" id="${esc(title.replace(/\s+/g, '_'))}" data-name="${esc(title)}" width="${f3(this.W)}pt" height="${f3(this.H)}pt" viewBox="0 0 ${f3(this.W)} ${f3(this.H)}"><defs>${this.defs.join('')}</defs>${body}</svg>`;
  }
}

function pdfType(pdf, d) {
  return pdf.res(d?.PatternType);
}

function invert(M) {
  const det = M[0] * M[3] - M[1] * M[2] || 1e-12;
  const a = M[3] / det;
  const b = -M[1] / det;
  const c = -M[2] / det;
  const d = M[0] / det;
  return [a, b, c, d, -(M[4] * a + M[5] * c), -(M[4] * b + M[5] * d)];
}

/* ============================================================= imágenes */

/** Lector de muestras de 1, 2, 4, 8 o 16 bits (de 16 se toma el byte alto). */
function sampler(data, w, ncomp, bpc) {
  const rowBytes = Math.ceil((w * ncomp * bpc) / 8);
  if (bpc === 8) return (row, i) => data[row * rowBytes + i] ?? 0;
  if (bpc === 16) return (row, i) => data[row * rowBytes + i * 2] ?? 0;
  const max = (1 << bpc) - 1;
  return (row, i) => {
    const bit = i * bpc;
    const byte = data[row * rowBytes + (bit >> 3)] ?? 0;
    return (byte >> (8 - bpc - (bit & 7))) & max;
  };
}

/** Máscara suave (SMask) o explícita (Mask) → alfa por píxel (0..255) del tamaño de la imagen. */
function maskAlpha(pdf, st, w, h, soft) {
  const d = st.dict;
  const mw = pdf.res(d.Width) | 0;
  const mh = pdf.res(d.Height) | 0;
  if (!mw || !mh) return null;
  const { data, filter } = pdf.decodeImage(st);
  if (filter) return null;
  const bpc = soft ? pdf.res(d.BitsPerComponent) || 8 : 1;
  const max = bpc === 16 ? 255 : (1 << bpc) - 1;
  const dec = pdf.res(d.Decode);
  const get = sampler(data, mw, 1, bpc);
  const lut = new Uint8Array(max + 1);
  for (let s = 0; s <= max; s++) {
    let v = s / max;
    if (Array.isArray(dec)) v = dec[0] + v * (dec[1] - dec[0]);
    // máscara explícita: 0 se pinta, 1 se tapa (como una máscara de esténcil)
    lut[s] = Math.round(clamp(soft ? v : 1 - v) * 255);
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const my = Math.min(mh - 1, Math.floor(((y + 0.5) * mh) / h));
    for (let x = 0; x < w; x++) out[y * w + x] = lut[get(my, Math.min(mw - 1, Math.floor(((x + 0.5) * mw) / w)))];
  }
  return out;
}

/**
 * XObject de imagen → { w, h, rgba } (píxeles con alfa) o { w, h, jpeg, alpha? }
 * (bytes JPEG tal cual, para que los decodifique el navegador). null si no se lee.
 */
export function imagePixels(pdf, xo, resources, fillCss = '#000000', warn = () => {}) {
  const d = xo.dict;
  const R = (k) => pdf.res(d[k]);
  const w = R('Width') | 0;
  const h = R('Height') | 0;
  if (!w || !h) return null;
  if (w * h > 80e6) {
    warn(`una imagen de ${w}×${h} px es demasiado grande para importarla`);
    return null;
  }
  const { data, filter } = pdf.decodeImage(xo);
  const isMask = R('ImageMask') === true;
  const out = { w, h };
  let rgba = null;
  if (filter === 'DCTDecode') out.jpeg = data;
  else if (filter) {
    warn(`las imágenes ${filter === 'JPXDecode' ? 'JPEG 2000' : filter} no se importan`);
    return null;
  } else if (isMask) {
    // máscara de esténcil: pinta con el color de relleno donde la muestra es 0
    const inv = (R('Decode') || [0, 1])[0] === 1;
    const c = [1, 3, 5].map((i) => parseInt(fillCss.slice(i, i + 2), 16));
    const get = sampler(data, w, 1, 1);
    rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0, k = 0; y < h; y++) {
      for (let x = 0; x < w; x++, k += 4) {
        rgba[k] = c[0];
        rgba[k + 1] = c[1];
        rgba[k + 2] = c[2];
        rgba[k + 3] = (get(y, x) === 1) !== inv ? 0 : 255;
      }
    }
  } else {
    const cs = makeColorSpace(pdf, d.ColorSpace, resources);
    const n = cs.n || 1;
    const bpc = R('BitsPerComponent') || 8;
    const max = bpc === 16 ? 255 : (1 << bpc) - 1;
    const dec = R('Decode') || (cs.indexed ? [0, max] : new Array(n).fill([0, 1]).flat());
    const val = (c, s) => dec[2 * c] + (s * (dec[2 * c + 1] - dec[2 * c])) / max;
    const get = sampler(data, w, n, bpc);
    rgba = new Uint8ClampedArray(w * h * 4);
    if (n === 1) {
      // una componente (gris, paleta, tinta plana): tabla por valor de muestra
      const lut = new Uint8Array((max + 1) * 3);
      for (let s = 0; s <= max; s++) {
        const rgb = cs.rgb([val(0, s)]);
        for (let c = 0; c < 3; c++) lut[s * 3 + c] = Math.round(clamp(rgb[c]) * 255);
      }
      for (let y = 0, k = 0; y < h; y++) {
        for (let x = 0; x < w; x++, k += 4) {
          const s = get(y, x) * 3;
          rgba[k] = lut[s];
          rgba[k + 1] = lut[s + 1];
          rgba[k + 2] = lut[s + 2];
          rgba[k + 3] = 255;
        }
      }
    } else {
      const fast = cs.kind === 'rgb' || cs.kind === 'cmyk';
      const cache = new Map();
      const comps = new Array(n);
      for (let y = 0, k = 0; y < h; y++) {
        for (let x = 0; x < w; x++, k += 4) {
          for (let c = 0; c < n; c++) comps[c] = val(c, get(y, x * n + c));
          let rgb;
          if (cs.kind === 'rgb') rgb = comps;
          else if (cs.kind === 'cmyk') rgb = cmyk(comps);
          else {
            const key = comps.join();
            rgb = cache.get(key);
            if (!rgb) {
              rgb = cs.rgb(comps.slice());
              if (cache.size < 65536) cache.set(key, rgb);
            }
          }
          rgba[k] = clamp(rgb[0]) * 255;
          rgba[k + 1] = clamp(rgb[1]) * 255;
          rgba[k + 2] = clamp(rgb[2]) * 255;
          rgba[k + 3] = 255;
        }
        if (!fast && cache.size >= 65536) cache.clear();
      }
    }
    // máscara por rango de color: [min max …] por componente, en valores de muestra
    const ck = R('Mask');
    if (Array.isArray(ck)) {
      const rng = ck.map((v) => Number(pdf.res(v)));
      for (let y = 0, k = 3; y < h; y++) {
        for (let x = 0; x < w; x++, k += 4) {
          let inside = true;
          for (let c = 0; c < n && inside; c++) {
            const s = get(y, x * n + c);
            inside = s >= rng[2 * c] && s <= rng[2 * c + 1];
          }
          if (inside) rgba[k] = 0;
        }
      }
    }
  }
  // transparencia: máscara suave (Illustrator, Photoshop) o explícita
  const sm = R('SMask');
  const mk = R('Mask');
  const alpha = sm instanceof Stream ? maskAlpha(pdf, sm, w, h, true) : mk instanceof Stream ? maskAlpha(pdf, mk, w, h, false) : null;
  if (alpha) {
    if (rgba) for (let i = 0, k = 3; i < alpha.length; i++, k += 4) rgba[k] = (rgba[k] * alpha[i]) / 255;
    else out.alpha = alpha;
  }
  if (rgba) out.rgba = rgba;
  return out;
}

/* ============================================================== entrada */

/**
 * Bytes de un .ai o .pdf → SVG (en puntos) con una capa (grupo con nombre)
 * por cada capa de Illustrator / contenido opcional.
 * @returns {{ svg: string, warnings: string[], hiddenLayers: string[], pages: number, layers: string[] }}
 */
export function pdfToSvg(bytes, { name = 'PDF', page = 0 } = {}) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = latin1(u8.subarray(0, 1024));
  if (!head.includes('%PDF-')) {
    if (/%!PS-Adobe/.test(head)) throw new Error('Este .ai es del formato antiguo de Illustrator (PostScript, versión 8 o anterior). Ábrelo en Illustrator y guárdalo de nuevo como .ai (CS o posterior) con «Crear archivo compatible con PDF», o expórtalo como SVG o PDF.');
    throw new Error('No es un archivo de Illustrator (.ai) ni un PDF');
  }
  const pdf = new PdfDoc(u8);
  const { root, encrypt } = pdf.trailer();
  if (encrypt) throw new Error('El PDF está protegido (cifrado): guárdalo sin contraseña y sin restricciones');
  const pages = pdf.pages(root);
  if (!pages.length) throw new Error('El archivo no tiene páginas legibles');
  const pg = pages[Math.min(page, pages.length - 1)];
  const warnings = new Set();
  if (pages.length > 1) warnings.add(`se importó la primera de ${pages.length} páginas / mesas de trabajo`);
  let contents = pdf.res(pg.node.Contents);
  if (!Array.isArray(contents)) contents = contents ? [contents] : [];
  const parts = contents.map((c) => pdf.decode(pdf.res(c)));
  const total = parts.reduce((s, p) => s + p.length + 1, 0);
  const data = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    data.set(p, at);
    at += p.length;
    data[at++] = 10;
  }
  const conv = new Converter(pdf, pg, warnings);
  conv.run(data, pg.Resources || {});
  // capas ocultas en Illustrator
  const hidden = new Set();
  const ocp = pdf.res(root?.OCProperties);
  const off = pdf.res(pdf.res(ocp?.D)?.OFF);
  if (Array.isArray(off)) for (const r of off) {
    const n = conv.ocName(r);
    if (n) hidden.add(n);
  }
  const allText = [...conv.buckets.values()].flat().map((x) => x.svg).join(' ');
  if (/saved without PDF Content|sin contenido PDF|ohne PDF-Inhalt/i.test(allText.replace(/<[^>]+>/g, '')) || (/\/AIPrivateData/.test(pdf.text) && /without PDF Content/i.test(pdf.text))) {
    throw new Error('El .ai se guardó sin «Crear archivo compatible con PDF». En Illustrator: Archivo → Guardar como… → Illustrator (.ai) y marca esa opción, o exporta como SVG o PDF.');
  }
  const layers = conv.order.filter(Boolean);
  for (const im of conv.images) if (im.layer && !layers.includes(im.layer)) layers.push(im.layer);
  return { svg: conv.svg(name), warnings: [...warnings], hiddenLayers: [...hidden], pages: pages.length, layers, images: conv.images };
}

/**
 * .ai / .pdf → lo mismo que `importSvg` (capas, formas, avisos), más
 * `hiddenLayers`: nombres de las capas que están ocultas en Illustrator.
 */
export function importPdf(bytes, opts = {}) {
  const r = pdfToSvg(bytes, { name: opts.name || 'PDF' });
  let extraBox = null;
  for (const im of r.images) extraBox = extraBox ? [Math.min(extraBox[0], im.box[0]), Math.min(extraBox[1], im.box[1]), Math.max(extraBox[2], im.box[2]), Math.max(extraBox[3], im.box[3])] : im.box.slice();
  const res = importSvg(r.svg, { ...opts, unitMm: PT_MM, extraBox });
  // imágenes en el terreno: [x0, y0, x1, y1] (y hacia arriba), en el mismo lugar que las formas
  const images = r.images.map((im) => {
    const a = res.toWorld(im.box[0], im.box[3]);
    const b = res.toWorld(im.box[2], im.box[1]);
    return { ...im, bounds: [a[0], a[1], b[0], b[1]] };
  });
  return { ...res, images, warnings: [...new Set([...r.warnings, ...res.warnings])], hiddenLayers: r.hiddenLayers };
}

/** ¿Los bytes son un PDF (o un .ai moderno, que lo es)? */
export function isPdfBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return latin1(u8.subarray(0, 1024)).includes('%PDF-');
}
