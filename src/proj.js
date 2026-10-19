/**
 * Proyección del documento: UTM 19S sobre WGS84 (EPSG:32719).
 *
 * Todo lo que se dibuja vive en metros UTM. Así una línea mide lo que mide, el
 * snapping y la topología trabajan con tolerancias en metros y la exportación
 * no tiene que reproyectar nada.
 *
 * La conversión es la de Krüger con series de orden 6 (la misma que usa
 * GeographicLib): error por debajo del milímetro dentro de la zona, sin
 * dependencias. proj4 queda para lo que llega en otros sistemas (GeoPackage,
 * GeoTIFF), ver `io/crs.js`.
 */

const A = 6378137;
const F = 1 / 298.257223563;
const K0 = 0.9996;
const FALSE_E = 500000;

const n = F / (2 - F);
const n2 = n * n;
const n3 = n2 * n;
const n4 = n3 * n;
const n5 = n4 * n;
const n6 = n5 * n;
const AA = (A / (1 + n)) * (1 + n2 / 4 + n4 / 64 + n6 / 256);

const alpha = [
  n / 2 - (2 / 3) * n2 + (5 / 16) * n3 + (41 / 180) * n4 - (127 / 288) * n5 + (7891 / 37800) * n6,
  (13 / 48) * n2 - (3 / 5) * n3 + (557 / 1440) * n4 + (281 / 630) * n5 - (1983433 / 1935360) * n6,
  (61 / 240) * n3 - (103 / 140) * n4 + (15061 / 26880) * n5 + (167603 / 181440) * n6,
  (49561 / 161280) * n4 - (179 / 168) * n5 + (6601661 / 7257600) * n6,
  (34729 / 80640) * n5 - (3418889 / 1995840) * n6,
  (212378941 / 319334400) * n6,
];
const beta = [
  n / 2 - (2 / 3) * n2 + (37 / 96) * n3 - (1 / 360) * n4 - (81 / 512) * n5 + (96199 / 604800) * n6,
  (1 / 48) * n2 + (1 / 15) * n3 - (437 / 1440) * n4 + (46 / 105) * n5 - (1118711 / 3870720) * n6,
  (17 / 480) * n3 - (37 / 840) * n4 - (209 / 4480) * n5 + (5569 / 90720) * n6,
  (4397 / 161280) * n4 - (11 / 504) * n5 - (830251 / 7257600) * n6,
  (4583 / 161280) * n5 - (108847 / 3991680) * n6,
  (20648693 / 638668800) * n6,
];

const E = Math.sqrt(F * (2 - F));
const RAD = Math.PI / 180;

/** Proyección UTM genérica: zona y hemisferio. Por defecto 19S. */
export function makeUtm(zone = 19, south = true) {
  const lon0 = (zone * 6 - 183) * RAD;
  const falseN = south ? 10000000 : 0;

  function forward(lon, lat) {
    const phi = lat * RAD;
    const lam = lon * RAD - lon0;
    const tau = Math.tan(phi);
    const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
    const taup = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const xip = Math.atan2(taup, Math.cos(lam));
    const etap = Math.asinh(Math.sin(lam) / Math.sqrt(taup * taup + Math.cos(lam) ** 2));
    let xi = xip;
    let eta = etap;
    for (let j = 1; j <= 6; j++) {
      xi += alpha[j - 1] * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap);
      eta += alpha[j - 1] * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap);
    }
    return [FALSE_E + K0 * AA * eta, falseN + K0 * AA * xi];
  }

  function inverse(x, y) {
    const xi = (y - falseN) / (K0 * AA);
    const eta = (x - FALSE_E) / (K0 * AA);
    let xip = xi;
    let etap = eta;
    for (let j = 1; j <= 6; j++) {
      xip -= beta[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
      etap -= beta[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
    }
    const sinhEtap = Math.sinh(etap);
    const sinXip = Math.sin(xip);
    const cosXip = Math.cos(xip);
    const taup = sinXip / Math.sqrt(sinhEtap * sinhEtap + cosXip * cosXip);
    // Newton para tau a partir de tau' (Karney 2011, ec. 19-21)
    let tau = taup;
    for (let i = 0; i < 6; i++) {
      const sigma = Math.sinh(E * Math.atanh((E * tau) / Math.sqrt(1 + tau * tau)));
      const tauI = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
      const dTau =
        ((taup - tauI) / Math.sqrt(1 + tauI * tauI)) *
        ((1 + (1 - E * E) * tau * tau) / ((1 - E * E) * Math.sqrt(1 + tau * tau)));
      tau += dTau;
      if (Math.abs(dTau) < 1e-12) break;
    }
    const lat = Math.atan(tau) / RAD;
    const lon = (lon0 + Math.atan2(sinhEtap, cosXip)) / RAD;
    return [lon, lat];
  }

  return { zone, south, epsg: (south ? 32700 : 32600) + zone, forward, inverse };
}

export const UTM19S = makeUtm(19, true);

export const DOC_EPSG = 32719;

export const DOC_WKT =
  'PROJCS["WGS 84 / UTM zone 19S",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563,AUTHORITY["EPSG","7030"]],AUTHORITY["EPSG","6326"]],PRIMEM["Greenwich",0,AUTHORITY["EPSG","8901"]],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",-69],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",10000000],UNIT["metre",1,AUTHORITY["EPSG","9001"]],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32719"]]';

export const toLonLat = (x, y) => UTM19S.inverse(x, y);
export const fromLonLat = (lon, lat) => UTM19S.forward(lon, lat);

/* ---------------------------------------------------------- formato */

/**
 * Grados sexagesimales: 33°27'12.4"S. `sec` decimales de segundo.
 * Redondea antes de repartir para no producir 60".
 */
export function formatDMS(value, isLat, sec = 1) {
  const hemi = isLat ? (value < 0 ? 'S' : 'N') : value < 0 ? 'W' : 'E';
  const k = 10 ** sec;
  let total = Math.round(Math.abs(value) * 3600 * k);
  const d = Math.floor(total / (3600 * k));
  total -= d * 3600 * k;
  const m = Math.floor(total / (60 * k));
  total -= m * 60 * k;
  const s = (total / k).toFixed(sec);
  return `${d}°${String(m).padStart(2, '0')}'${s.padStart(sec ? 3 + sec : 2, '0')}"${hemi}`;
}

/** Rótulo corto para grillas: 70°30'W, sin segundos si son cero. */
export function formatDMSShort(value, isLat) {
  const hemi = isLat ? (value < 0 ? 'S' : 'N') : value < 0 ? 'W' : 'E';
  let total = Math.round(Math.abs(value) * 3600);
  const d = Math.floor(total / 3600);
  total -= d * 3600;
  const m = Math.floor(total / 60);
  const s = total - m * 60;
  let out = `${d}°`;
  if (m || s) out += `${String(m).padStart(2, '0')}'`;
  if (s) out += `${String(s).padStart(2, '0')}"`;
  return out + hemi;
}

/** Acepta 33°27'12.4"S, -33.4534, 33 27 12.4 S, etc. Devuelve grados con signo. */
export function parseDMS(text) {
  const t = String(text).trim().toUpperCase().replace(',', '.');
  if (/^[-+]?\d+(\.\d+)?$/.test(t)) return Number(t);
  const neg = /[SWO]$/.test(t) || t.startsWith('-');
  const nums = t.match(/\d+(\.\d+)?/g);
  if (!nums) return NaN;
  const [d, m = 0, s = 0] = nums.map(Number);
  const v = d + m / 60 + s / 3600;
  return neg ? -v : v;
}

/**
 * Coordenadas escritas a mano -> [E, N] UTM 19S, o null si no se entienden.
 * Acepta «E N» en metros (UTM 19S) o «lat, lon» en grados decimales o
 * sexagesimales (33°27'12"S, 70°40'W).
 */
export function parseCoordText(text) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  const parts = t.split(/[,;]|\s{2,}/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 1) {
    const m = t.split(/\s+/).map(Number);
    if (m.length === 2 && m.every(Number.isFinite) && Math.abs(m[0]) > 1000) return m;
  }
  if (parts.length < 2) return null;
  const a = parseDMS(parts[0]);
  const b = parseDMS(parts[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) > 1000) return [a, b];
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return fromLonLat(b, a);
}

/** Texto de lo que se entendió de unas coordenadas escritas (para los diálogos). */
export function coordPreview(text) {
  if (!String(text ?? '').trim()) return '';
  const xy = parseCoordText(text);
  if (!xy) return '…';
  const [lon, lat] = toLonLat(xy[0], xy[1]);
  return `→ ${formatDMS(lat, true)} ${formatDMS(lon, false)} · ${formatUTM(xy[0], xy[1])} (UTM 19S)`;
}

export const formatUTM = (x, y) =>
  `${Math.round(x).toLocaleString('es-CL')} E  ${Math.round(y).toLocaleString('es-CL')} N`;
