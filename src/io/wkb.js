/**
 * WKB y GeoPackageBinary.
 *
 * Un GeoPackage guarda cada geometría como un blob con cabecera propia:
 *
 *   'G' 'P' | version | flags | srs_id (int32) | [envelope] | WKB
 *
 * `flags` codifica el orden de bytes de la cabecera (bit 0), el tipo de
 * envelope (bits 1-3) y si la geometría es vacía (bit 4).
 */

const WKB_TYPE = {
  Point: 1,
  LineString: 2,
  Polygon: 3,
  MultiPoint: 4,
  MultiLineString: 5,
  MultiPolygon: 6,
};

const ENVELOPE_BYTES = { 0: 0, 1: 32, 2: 48, 3: 48, 4: 64 };

/* ---------------------------------------------------------------- escribir */

function wkbSize(g) {
  switch (g.type) {
    case 'Point':
      return 5 + 16;
    case 'LineString':
      return 5 + 4 + g.coordinates.length * 16;
    case 'Polygon':
      return 5 + 4 + g.coordinates.reduce((s, r) => s + 4 + r.length * 16, 0);
    case 'MultiPoint':
      return 5 + 4 + g.coordinates.length * (5 + 16);
    case 'MultiLineString':
      return 5 + 4 + g.coordinates.reduce((s, l) => s + 5 + 4 + l.length * 16, 0);
    case 'MultiPolygon':
      return (
        5 +
        4 +
        g.coordinates.reduce((s, p) => s + 5 + 4 + p.reduce((t, r) => t + 4 + r.length * 16, 0), 0)
      );
    default:
      throw new Error(`Geometría no soportada para WKB: ${g.type}`);
  }
}

function writeRing(dv, cur, ring) {
  dv.setUint32(cur.o, ring.length, true);
  cur.o += 4;
  for (const c of ring) {
    dv.setFloat64(cur.o, c[0], true);
    dv.setFloat64(cur.o + 8, c[1], true);
    cur.o += 16;
  }
}

function writeGeometry(dv, cur, g) {
  dv.setUint8(cur.o, 1); // little endian
  cur.o += 1;
  dv.setUint32(cur.o, WKB_TYPE[g.type], true);
  cur.o += 4;

  switch (g.type) {
    case 'Point':
      dv.setFloat64(cur.o, g.coordinates[0], true);
      dv.setFloat64(cur.o + 8, g.coordinates[1], true);
      cur.o += 16;
      break;
    case 'LineString':
      writeRing(dv, cur, g.coordinates);
      break;
    case 'Polygon':
      dv.setUint32(cur.o, g.coordinates.length, true);
      cur.o += 4;
      for (const r of g.coordinates) writeRing(dv, cur, r);
      break;
    case 'MultiPoint':
      dv.setUint32(cur.o, g.coordinates.length, true);
      cur.o += 4;
      for (const c of g.coordinates) writeGeometry(dv, cur, { type: 'Point', coordinates: c });
      break;
    case 'MultiLineString':
      dv.setUint32(cur.o, g.coordinates.length, true);
      cur.o += 4;
      for (const l of g.coordinates) writeGeometry(dv, cur, { type: 'LineString', coordinates: l });
      break;
    case 'MultiPolygon':
      dv.setUint32(cur.o, g.coordinates.length, true);
      cur.o += 4;
      for (const p of g.coordinates) writeGeometry(dv, cur, { type: 'Polygon', coordinates: p });
      break;
    default:
      throw new Error(`Geometría no soportada: ${g.type}`);
  }
}

export function encodeWKB(geometry) {
  const buf = new ArrayBuffer(wkbSize(geometry));
  writeGeometry(new DataView(buf), { o: 0 }, geometry);
  return buf;
}

/** [minX, maxX, minY, maxY] — el orden que exige la cabecera GPKG. */
export function envelopeOf(geometry) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  const visit = (c) => {
    if (typeof c[0] === 'number') {
      if (c[0] < minX) minX = c[0];
      if (c[0] > maxX) maxX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[1] > maxY) maxY = c[1];
    } else {
      for (const x of c) visit(x);
    }
  };
  visit(geometry.coordinates);
  return [minX, maxX, minY, maxY];
}

export function encodeGeoPackageBinary(geometry, srsId = 4326) {
  const wkb = encodeWKB(geometry);
  const env = envelopeOf(geometry);
  const headerLen = 8 + 32;
  const out = new Uint8Array(headerLen + wkb.byteLength);
  const dv = new DataView(out.buffer);
  dv.setUint8(0, 0x47); // 'G'
  dv.setUint8(1, 0x50); // 'P'
  dv.setUint8(2, 0); // versión 0
  dv.setUint8(3, 0b0000_0011); // little endian + envelope XY
  dv.setInt32(4, srsId, true);
  dv.setFloat64(8, env[0], true);
  dv.setFloat64(16, env[1], true);
  dv.setFloat64(24, env[2], true);
  dv.setFloat64(32, env[3], true);
  out.set(new Uint8Array(wkb), headerLen);
  return out;
}

/* ------------------------------------------------------------------- leer */

function readGeometry(dv, cur) {
  const le = dv.getUint8(cur.o) === 1;
  cur.o += 1;
  const raw = dv.getUint32(cur.o, le);
  cur.o += 4;

  // EWKB puede traer flags altos (SRID, Z, M); ISO WKB codifica Z/M sumando
  // 1000/2000/3000 al tipo base.
  const hasSrid = (raw & 0x20000000) !== 0;
  let t = raw & 0x0fffffff;
  let dims = 2;
  if (t >= 3000) {
    dims = 4;
    t -= 3000;
  } else if (t >= 2000) {
    dims = 3;
    t -= 2000;
  } else if (t >= 1000) {
    dims = 3;
    t -= 1000;
  }
  if (hasSrid) cur.o += 4;

  const readPoint = () => {
    const x = dv.getFloat64(cur.o, le);
    const y = dv.getFloat64(cur.o + 8, le);
    cur.o += dims * 8;
    return [x, y];
  };
  const readRing = () => {
    const n = dv.getUint32(cur.o, le);
    cur.o += 4;
    const pts = new Array(n);
    for (let i = 0; i < n; i++) pts[i] = readPoint();
    return pts;
  };
  const readCount = () => {
    const n = dv.getUint32(cur.o, le);
    cur.o += 4;
    return n;
  };

  switch (t) {
    case 1:
      return { type: 'Point', coordinates: readPoint() };
    case 2:
      return { type: 'LineString', coordinates: readRing() };
    case 3: {
      const n = readCount();
      const rings = new Array(n);
      for (let i = 0; i < n; i++) rings[i] = readRing();
      return { type: 'Polygon', coordinates: rings };
    }
    case 4: {
      const n = readCount();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readGeometry(dv, cur).coordinates;
      return { type: 'MultiPoint', coordinates: out };
    }
    case 5: {
      const n = readCount();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readGeometry(dv, cur).coordinates;
      return { type: 'MultiLineString', coordinates: out };
    }
    case 6: {
      const n = readCount();
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readGeometry(dv, cur).coordinates;
      return { type: 'MultiPolygon', coordinates: out };
    }
    default:
      throw new Error(`Tipo WKB no soportado: ${t}`);
  }
}

export function decodeGeoPackageBinary(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 8 || u8[0] !== 0x47 || u8[1] !== 0x50) {
    throw new Error('Blob sin cabecera GeoPackage ("GP")');
  }
  const flags = u8[3];
  const envelopeType = (flags >> 1) & 0x07;
  const empty = ((flags >> 4) & 1) === 1;
  const envBytes = ENVELOPE_BYTES[envelopeType];
  if (envBytes === undefined) throw new Error(`Envelope GPKG desconocido: ${envelopeType}`);
  if (empty) return null;

  const offset = 8 + envBytes;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return readGeometry(dv, { o: offset });
}
