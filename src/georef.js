/**
 * Georreferenciación por puntos de control (GCP): imagen (columna, fila) ->
 * UTM 19S (E, N).
 *
 * Transformaciones, de la más rígida a la más flexible:
 *  - helmert   similaridad: traslación + rotación + escala única (≥ 2 puntos).
 *              Para un mapa escaneado sin deformación: no inventa nada.
 *  - affine    afín de 6 parámetros (≥ 3): además escalas distintas y cizalle
 *              (papel que encogió más en un sentido, escáner mal calibrado).
 *  - poly2     polinomial de 2º orden (≥ 6): curvatura suave (fotocopia,
 *              mapa en otra proyección).
 *  - tps       thin-plate spline (≥ 3): pasa EXACTAMENTE por cada punto y
 *              deforma suave entre ellos (fotos oblicuas, croquis). Sin
 *              residuos: cada punto mal puesto deforma la imagen.
 *
 * Se ajusta por mínimos cuadrados en coordenadas centradas y normalizadas,
 * que es lo que hace estable la polinomial con números del orden de 10^6.
 * Para remuestrear hace falta la inversa (mundo -> imagen): en helmert y afín
 * es exacta; en poly2 y tps se ajusta una segunda transformación en sentido
 * contrario con los mismos puntos, como hace GDAL.
 */

export const TRANSFORMS = {
  helmert: { label: 'Helmert (similaridad)', min: 2 },
  affine: { label: 'Afín', min: 3 },
  poly2: { label: 'Polinomial 2º orden', min: 6 },
  tps: { label: 'Thin-plate spline', min: 3 },
};

/* ------------------------------------------------------------ álgebra */

/** Resuelve A x = b (A n×n) por eliminación gaussiana con pivoteo parcial. */
export function solve(A, b) {
  const n = A.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) throw new Error('Puntos insuficientes o alineados para esta transformación');
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / row[i]);
}

/** Mínimos cuadrados: filas de diseño `rows` (m×k), observaciones `obs` (m). */
function leastSquares(rows, obs) {
  const k = rows[0].length;
  const AtA = Array.from({ length: k }, () => new Array(k).fill(0));
  const Atb = new Array(k).fill(0);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    for (let a = 0; a < k; a++) {
      Atb[a] += r[a] * obs[i];
      for (let b = 0; b < k; b++) AtA[a][b] += r[a] * r[b];
    }
  }
  return solve(AtA, Atb);
}

function normalizer(pts) {
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p[0];
    my += p[1];
  }
  mx /= pts.length;
  my /= pts.length;
  let s = 0;
  for (const p of pts) s = Math.max(s, Math.abs(p[0] - mx), Math.abs(p[1] - my));
  s = s || 1;
  return { f: (p) => [(p[0] - mx) / s, (p[1] - my) / s], mx, my, s };
}

/* ------------------------------------------------------------ ajustes */

/**
 * Ajusta `kind` de `src` a `dst` (listas de [x,y]). Devuelve una función
 * p -> [x,y], más los parámetros.
 */
export function fitTransform(kind, src, dst) {
  const min = TRANSFORMS[kind]?.min ?? 3;
  if (src.length < min) throw new Error(`${TRANSFORMS[kind].label} necesita al menos ${min} puntos`);
  const ns = normalizer(src);
  const nd = normalizer(dst);
  const S = src.map(ns.f);
  const D = dst.map(nd.f);
  const out = (x, y) => [x * nd.s + nd.mx, y * nd.s + nd.my];
  let f;

  if (kind === 'helmert') {
    // x' = a x - b y + tx ; y' = b x + a y + ty
    const rows = [];
    const obs = [];
    S.forEach(([x, y], i) => {
      rows.push([x, -y, 1, 0]);
      obs.push(D[i][0]);
      rows.push([y, x, 0, 1]);
      obs.push(D[i][1]);
    });
    const [a, b, tx, ty] = leastSquares(rows, obs);
    f = (p) => {
      const [x, y] = ns.f(p);
      return out(a * x - b * y + tx, b * x + a * y + ty);
    };
  } else if (kind === 'affine' || kind === 'poly2') {
    const terms = kind === 'affine' ? ([x, y]) => [1, x, y] : ([x, y]) => [1, x, y, x * x, x * y, y * y];
    const rows = S.map(terms);
    const cx = leastSquares(rows, D.map((d) => d[0]));
    const cy = leastSquares(rows, D.map((d) => d[1]));
    f = (p) => {
      const t = terms(ns.f(p));
      let x = 0;
      let y = 0;
      for (let i = 0; i < t.length; i++) {
        x += cx[i] * t[i];
        y += cy[i] * t[i];
      }
      return out(x, y);
    };
  } else if (kind === 'tps') {
    const n = S.length;
    const U = (r2) => (r2 === 0 ? 0 : r2 * Math.log(r2));
    const size = n + 3;
    const L = Array.from({ length: size }, () => new Array(size).fill(0));
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const dx = S[i][0] - S[j][0];
        const dy = S[i][1] - S[j][1];
        L[i][j] = U(dx * dx + dy * dy);
      }
      L[i][n] = L[n][i] = 1;
      L[i][n + 1] = L[n + 1][i] = S[i][0];
      L[i][n + 2] = L[n + 2][i] = S[i][1];
    }
    const bx = [...D.map((d) => d[0]), 0, 0, 0];
    const by = [...D.map((d) => d[1]), 0, 0, 0];
    const wx = solve(L, bx);
    const wy = solve(L, by);
    f = (p) => {
      const [x, y] = ns.f(p);
      let X = wx[n] + wx[n + 1] * x + wx[n + 2] * y;
      let Y = wy[n] + wy[n + 1] * x + wy[n + 2] * y;
      for (let i = 0; i < n; i++) {
        const dx = x - S[i][0];
        const dy = y - S[i][1];
        const u = U(dx * dx + dy * dy);
        X += wx[i] * u;
        Y += wy[i] * u;
      }
      return out(X, Y);
    };
  } else {
    throw new Error(`Transformación desconocida: ${kind}`);
  }
  return f;
}

/**
 * Ajuste completo de una sesión: directa, inversa y residuos por punto.
 * gcps: [{ src: [col, fila], dst: [E, N], on: bool }]
 */
export function solveGeoref(gcps, kind) {
  const used = gcps.filter((g) => g.on !== false && g.src && g.dst);
  // Las filas de la imagen crecen hacia abajo y el norte hacia arriba: pasar
  // de una a otro es un REFLEJO, que la similaridad (Helmert) no puede
  // representar. Se ajusta contra (col, -fila) y se deshace afuera.
  const flip = (p) => [p[0], -p[1]];
  const src = used.map((g) => flip(g.src));
  const dst = used.map((g) => g.dst);
  const F = fitTransform(kind, src, dst);
  const I = fitTransform(kind, dst, src);
  const forward = (p) => F(flip(p));
  const inverse = (q) => flip(I(q));
  const residuals = gcps.map((g) => {
    if (!g.src || !g.dst) return null;
    const p = forward(g.src);
    return { dx: p[0] - g.dst[0], dy: p[1] - g.dst[1], d: Math.hypot(p[0] - g.dst[0], p[1] - g.dst[1]) };
  });
  const usedRes = residuals.filter((r, i) => r && gcps[i].on !== false);
  const rms = usedRes.length ? Math.sqrt(usedRes.reduce((s, r) => s + r.d * r.d, 0) / usedRes.length) : 0;
  return { forward, inverse, residuals, rms, n: used.length };
}

/** Afín exacta a partir de la forma general (para la vista previa con canvas). */
export function affineOf(forward, w, h) {
  const o = forward([0, 0]);
  const ex = forward([w, 0]);
  const ey = forward([0, h]);
  return { o, ax: [(ex[0] - o[0]) / w, (ex[1] - o[1]) / w], ay: [(ey[0] - o[0]) / h, (ey[1] - o[1]) / h] };
}

/**
 * Remuestrea la imagen a una grilla UTM. `getPixel(col, fila)` -> [r,g,b,a]
 * o un ImageData fuente. Devuelve { rgba, w, h, x0, y1, cell }.
 */
export function warpToUtm(src, srcW, srcH, sol, { maxSize = 4096, cell = null } = {}) {
  // caja en UTM recorriendo el borde de la imagen
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  const K = 32;
  for (let k = 0; k <= K; k++) {
    const t = k / K;
    for (const p of [[t * srcW, 0], [t * srcW, srcH], [0, t * srcH], [srcW, t * srcH]]) {
      const [x, y] = sol.forward(p);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  // tamaño de celda: el de un píxel de la imagen, en metros
  const a = sol.forward([srcW / 2, srcH / 2]);
  const b = sol.forward([srcW / 2 + 1, srcH / 2]);
  const c = sol.forward([srcW / 2, srcH / 2 + 1]);
  let size = cell || Math.sqrt(Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])));
  size = Math.max(size, (x1 - x0) / maxSize, (y1 - y0) / maxSize);
  const w = Math.max(1, Math.ceil((x1 - x0) / size - 1e-6));
  const h = Math.max(1, Math.ceil((y1 - y0) / size - 1e-6));
  const rgba = new Uint8ClampedArray(w * h * 4);
  const data = src.data;
  const step = 16; // inversa exacta cada 16 celdas, lineal en medio
  for (let j = 0; j < h; j++) {
    const Y = y1 - (j + 0.5) * size;
    for (let i = 0; i < w; i += step) {
      const ib = Math.min(w - 1, i + step);
      const A = sol.inverse([x0 + (i + 0.5) * size, Y]);
      const B = sol.inverse([x0 + (ib + 0.5) * size, Y]);
      for (let ii = i; ii <= ib && ii < w; ii++) {
        const t = ib === i ? 0 : (ii - i) / (ib - i);
        const u = Math.floor(A[0] + t * (B[0] - A[0]));
        const v = Math.floor(A[1] + t * (B[1] - A[1]));
        if (u < 0 || v < 0 || u >= srcW || v >= srcH) continue;
        const s = (v * srcW + u) * 4;
        const o = (j * w + ii) * 4;
        rgba[o] = data[s];
        rgba[o + 1] = data[s + 1];
        rgba[o + 2] = data[s + 2];
        rgba[o + 3] = data[s + 3];
      }
    }
  }
  return { rgba, w, h, x0, y1, cell: size };
}
