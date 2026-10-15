/**
 * Relieve sombreado, paletas hipsométricas/batimétricas y ajustes de imagen.
 *
 * Todo aquí es aritmética sobre arreglos: no sabe de dónde vino el modelo de
 * elevación ni dónde se va a pintar. Eso lo deja comprobable sin navegador y
 * reutilizable para la exportación del layout.
 *
 * La grilla llega YA en UTM, con celdas cuadradas de `cell` metros. Por eso la
 * pendiente sale bien sin la corrección por latitud que necesita un DEM en
 * grados: una celda de 1" mide 30 m en norte-sur pero 26 m en este-oeste a
 * 33°S, y calcular el sombreado sobre la grilla geográfica tuerce la luz.
 */

const DEG = Math.PI / 180;

/**
 * Sombreado de Horn (el de GDAL y ArcGIS).
 *
 * @param z      Float32Array w*h, filas de norte a sur; NaN = sin dato
 * @param opts   azimuth (° desde el norte, horario), altitude (°), zFactor,
 *               multidirectional (combina 4 luces: 225, 270, 315 y 360°)
 * @returns Float32Array con el sombreado en [0,1] (NaN donde no hay dato)
 */
export function hillshade(z, w, h, cell, opts = {}) {
  const { azimuth = 315, altitude = 45, zFactor = 1, multidirectional = false } = opts;
  const out = new Float32Array(w * h);
  const zen = (90 - altitude) * DEG;
  const cosZ = Math.cos(zen);
  const sinZ = Math.sin(zen);
  const azimuths = multidirectional ? [225, 270, 315, 360] : [azimuth];
  const weights = multidirectional ? [0.25, 0.25, 0.25, 0.25] : [1];
  const azRad = azimuths.map((a) => (((360 - a + 90) % 360) * DEG));
  const k = zFactor / (8 * cell);

  const at = (x, y) => {
    const xx = x < 0 ? 0 : x >= w ? w - 1 : x;
    const yy = y < 0 ? 0 : y >= h ? h - 1 : y;
    return z[yy * w + xx];
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const e = z[y * w + x];
      if (Number.isNaN(e)) {
        out[y * w + x] = NaN;
        continue;
      }
      let a = at(x - 1, y - 1);
      let b = at(x, y - 1);
      let c = at(x + 1, y - 1);
      let d = at(x - 1, y);
      let f = at(x + 1, y);
      let g = at(x - 1, y + 1);
      let hh = at(x, y + 1);
      let i = at(x + 1, y + 1);
      // vecinos sin dato: se reemplazan por el centro (borde plano)
      if (a !== a) a = e;
      if (b !== b) b = e;
      if (c !== c) c = e;
      if (d !== d) d = e;
      if (f !== f) f = e;
      if (g !== g) g = e;
      if (hh !== hh) hh = e;
      if (i !== i) i = e;
      const dzdx = (c + 2 * f + i - (a + 2 * d + g)) * k;
      const dzdy = (g + 2 * hh + i - (a + 2 * b + c)) * k;
      const slope = Math.atan(Math.sqrt(dzdx * dzdx + dzdy * dzdy));
      let aspect;
      if (dzdx !== 0) {
        aspect = Math.atan2(dzdy, -dzdx);
        if (aspect < 0) aspect += 2 * Math.PI;
      } else {
        aspect = dzdy > 0 ? Math.PI / 2 : dzdy < 0 ? 1.5 * Math.PI : 0;
      }
      const cs = Math.cos(slope);
      const ss = Math.sin(slope);
      let s = 0;
      for (let j = 0; j < azRad.length; j++) {
        s += weights[j] * (cosZ * cs + sinZ * ss * Math.cos(azRad[j] - aspect));
      }
      out[y * w + x] = s < 0 ? 0 : s > 1 ? 1 : s;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- paletas */

/**
 * Paletas. `abs: true` = las paradas están en metros (el cero es la línea de
 * costa, así que tierra y mar no se mezclan aunque el rango cambie);
 * `abs: false` = fracciones del rango [min, max] de lo visible.
 */
export const PALETTES = {
  none: { label: 'Sin paleta (gris)', abs: false, stops: [] },
  etopo: {
    label: 'Topo-batimetría (ETOPO)',
    abs: true,
    stops: [
      [-10000, 8, 22, 64],
      [-6000, 20, 52, 120],
      [-3500, 35, 96, 168],
      [-1000, 70, 145, 205],
      [-200, 130, 190, 230],
      [-1, 185, 225, 245],
      [0, 76, 140, 76],
      [300, 128, 175, 100],
      [1000, 205, 200, 128],
      [2000, 190, 150, 95],
      [3500, 150, 110, 80],
      [4800, 225, 220, 215],
      [6500, 255, 255, 255],
    ],
  },
  gebco: {
    label: 'Batimetría (azules) + tierra gris',
    abs: true,
    stops: [
      [-10000, 10, 25, 70],
      [-5000, 30, 75, 150],
      [-2000, 70, 135, 200],
      [-500, 140, 190, 230],
      [-1, 205, 235, 250],
      [0, 225, 225, 220],
      [6500, 250, 250, 248],
    ],
  },
  hypso: {
    label: 'Hipsométrica (verde-café-blanco)',
    abs: false,
    stops: [
      [0, 50, 120, 70],
      [0.2, 130, 180, 100],
      [0.4, 225, 215, 140],
      [0.6, 200, 150, 90],
      [0.8, 150, 105, 75],
      [1, 250, 250, 250],
    ],
  },
  andes: {
    label: 'Andina (árida)',
    abs: false,
    stops: [
      [0, 120, 150, 110],
      [0.25, 215, 200, 160],
      [0.5, 205, 160, 115],
      [0.75, 165, 115, 90],
      [0.92, 220, 215, 210],
      [1, 255, 255, 255],
    ],
  },
  viridis: {
    label: 'Viridis',
    abs: false,
    stops: [
      [0, 68, 1, 84],
      [0.25, 59, 82, 139],
      [0.5, 33, 145, 140],
      [0.75, 94, 201, 98],
      [1, 253, 231, 37],
    ],
  },
  magma: {
    label: 'Magma',
    abs: false,
    stops: [
      [0, 0, 0, 4],
      [0.25, 80, 18, 123],
      [0.5, 182, 54, 121],
      [0.75, 251, 136, 97],
      [1, 252, 253, 191],
    ],
  },
  spectral: {
    label: 'Espectral',
    abs: false,
    stops: [
      [0, 94, 79, 162],
      [0.25, 102, 194, 165],
      [0.5, 255, 255, 191],
      [0.75, 244, 109, 67],
      [1, 158, 1, 66],
    ],
  },
  ocean: {
    label: 'Solo océano (azules)',
    abs: true,
    stops: [
      [-10000, 5, 15, 50],
      [-4000, 25, 70, 140],
      [-1000, 80, 150, 210],
      [-1, 190, 225, 245],
      [0, 255, 255, 255],
      [9000, 255, 255, 255],
    ],
  },
};

/** Tabla de 1024 colores [r,g,b] para un rango [min, max]. */
export function paletteLUT(name, min, max, reverse = false) {
  const pal = PALETTES[name] || PALETTES.none;
  const N = 1024;
  const lut = new Uint8ClampedArray(N * 3);
  if (!pal.stops.length) {
    lut.fill(255);
    return { lut, min, max, N };
  }
  let stops = pal.stops;
  if (!pal.abs) stops = stops.map(([f, r, g, b]) => [min + f * (max - min), r, g, b]);
  if (reverse) {
    const vals = stops.map((s) => s[0]);
    stops = stops.map((s, i) => [vals[i], ...stops[stops.length - 1 - i].slice(1)]);
  }
  for (let i = 0; i < N; i++) {
    const v = min + ((max - min) * i) / (N - 1);
    let j = 0;
    while (j < stops.length - 1 && stops[j + 1][0] < v) j++;
    let rgb;
    if (v <= stops[0][0]) rgb = stops[0].slice(1);
    else if (j >= stops.length - 1) rgb = stops[stops.length - 1].slice(1);
    else {
      const [v0, ...c0] = stops[j];
      const [v1, ...c1] = stops[j + 1];
      const t = (v - v0) / Math.max(1e-9, v1 - v0);
      rgb = c0.map((c, k) => c + (c1[k] - c) * t);
    }
    lut[i * 3] = rgb[0];
    lut[i * 3 + 1] = rgb[1];
    lut[i * 3 + 2] = rgb[2];
  }
  return { lut, min, max, N };
}

/* ---------------------------------------------------------- composición */

export function defaultHillshadeSettings() {
  return {
    source: 'terrarium', // terrarium | opentopo | file
    demtype: 'COP30',
    fileId: null,
    azimuth: 315,
    altitude: 45,
    zFactor: 1.5,
    multidirectional: false,
    shadeStrength: 1, // 0 = sin sombra (solo paleta), 1 = sombra completa
    palette: 'etopo',
    paletteReverse: false,
    paletteOpacity: 0.85,
    paletteBlend: 'multiply', // multiply | overlay | soft-light | screen | normal
    rangeMode: 'auto', // auto (lo visible) | manual
    min: 0,
    max: 4000,
    brightness: 0, // -1..1
    contrast: 0, // -1..1
    gamma: 1, // 0.2..3
    saturation: 1, // 0..2
    seaTransparent: false,
    resolution: 1, // fracción de los píxeles de pantalla (rendimiento)
  };
}

function blendChannel(mode, c, s) {
  // c = color de la paleta (0..1), s = sombra en gris (0..1)
  switch (mode) {
    case 'overlay':
      return s < 0.5 ? 2 * c * s : 1 - 2 * (1 - c) * (1 - s);
    case 'soft-light':
      return s < 0.5 ? c - (1 - 2 * s) * c * (1 - c) : c + (2 * s - 1) * ((c <= 0.25 ? ((16 * c - 12) * c + 4) * c : Math.sqrt(c)) - c);
    case 'screen':
      return 1 - (1 - c) * (1 - s);
    case 'normal':
      return c;
    default:
      return c * s; // multiplicar
  }
}

/**
 * Sombreado + paleta + ajustes -> RGBA.
 * @returns {Uint8ClampedArray} w*h*4
 */
export function compose(elev, shade, w, h, settings, range) {
  const st = { ...defaultHillshadeSettings(), ...settings };
  const out = new Uint8ClampedArray(w * h * 4);
  const pal = PALETTES[st.palette] || PALETTES.none;
  const usePalette = pal.stops.length > 0 && st.paletteOpacity > 0;
  const { lut, min, max, N } = paletteLUT(st.palette, range.min, range.max, st.paletteReverse);
  const span = Math.max(1e-9, max - min);
  const strength = st.shadeStrength;
  const alpha = st.paletteOpacity;

  // ajustes como tabla de 256 entradas: brillo, contraste y gamma
  const adj = new Uint8ClampedArray(256);
  const cf = st.contrast >= 1 ? 1e6 : (1 + st.contrast) / Math.max(1e-6, 1 - st.contrast);
  for (let i = 0; i < 256; i++) {
    let v = i / 255;
    v = Math.pow(Math.max(0, v), 1 / Math.max(0.05, st.gamma));
    v = (v - 0.5) * cf + 0.5;
    v += st.brightness;
    adj[i] = Math.round(Math.max(0, Math.min(1, v)) * 255);
  }
  const sat = st.saturation;

  for (let p = 0; p < w * h; p++) {
    const e = elev[p];
    const o = p * 4;
    if (Number.isNaN(e) || (st.seaTransparent && e < 0)) {
      out[o + 3] = 0;
      continue;
    }
    let s = shade ? shade[p] : 1;
    if (s !== s) s = 1;
    s = 1 - strength * (1 - s);
    let r = s;
    let g = s;
    let b = s;
    if (usePalette) {
      let idx = Math.round(((e - min) / span) * (N - 1));
      idx = idx < 0 ? 0 : idx >= N ? N - 1 : idx;
      const cr = lut[idx * 3] / 255;
      const cg = lut[idx * 3 + 1] / 255;
      const cb = lut[idx * 3 + 2] / 255;
      r = s + (blendChannel(st.paletteBlend, cr, s) - s) * alpha;
      g = s + (blendChannel(st.paletteBlend, cg, s) - s) * alpha;
      b = s + (blendChannel(st.paletteBlend, cb, s) - s) * alpha;
    }
    if (sat !== 1) {
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      r = l + (r - l) * sat;
      g = l + (g - l) * sat;
      b = l + (b - l) * sat;
    }
    out[o] = adj[Math.max(0, Math.min(255, Math.round(r * 255)))];
    out[o + 1] = adj[Math.max(0, Math.min(255, Math.round(g * 255)))];
    out[o + 2] = adj[Math.max(0, Math.min(255, Math.round(b * 255)))];
    out[o + 3] = 255;
  }
  return out;
}

/** Rango de elevaciones de una grilla (percentiles 1–99 para que un pixel raro no aplaste la paleta). */
export function elevationRange(elev) {
  const vals = [];
  const step = Math.max(1, Math.floor(elev.length / 20000));
  for (let i = 0; i < elev.length; i += step) if (!Number.isNaN(elev[i])) vals.push(elev[i]);
  if (!vals.length) return { min: 0, max: 1 };
  vals.sort((a, b) => a - b);
  const q = (f) => vals[Math.min(vals.length - 1, Math.max(0, Math.round(f * (vals.length - 1))))];
  const min = q(0.01);
  const max = q(0.99);
  return { min, max: max > min ? max : min + 1 };
}
