import { nearestOnSegment } from './geom.js';
import { geometryFromRings, ringsOfFeature } from './topoRings.js';

/**
 * Confirmación topológica: deja que los elementos contiguos compartan
 * físicamente todos los vértices de su borde común.
 *
 * Son dos pasadas, las mismas que hace "Snap geometries to layer" de QGIS:
 *
 * 1. **Fusión de vértices.** Los vértices que caen a menos de la tolerancia se
 *    agrupan y se llevan todos al centroide del grupo. Con eso, dos polígonos
 *    dibujados a ojo dejan de tener dos vértices casi iguales y pasan a tener
 *    uno solo, repetido en ambas geometrías.
 * 2. **Nodado.** Un vértice que cae SOBRE el segmento del vecino —sin que el
 *    vecino tenga un vértice ahí— se inserta en ese segmento. Es el caso del
 *    polígono que se digitalizó con más detalle que su vecino: sin esta pasada
 *    el borde común coincide visualmente pero no comparte nodos, y cualquier
 *    edición topológica posterior abre un gap.
 *
 * Todo ocurre en un plano local en metros (equirectangular alrededor de la
 * latitud media del dato). A escala de una hoja de terreno el error es
 * despreciable, y a cambio la tolerancia se expresa en metros —que es como el
 * geólogo la piensa— en vez de en grados, que valen distinto en x y en y.
 */

const R = 111320; // metros por grado de latitud

function projector(features) {
  let sum = 0;
  let n = 0;
  for (const f of features) {
    for (const ring of ringsOfFeature(f)?.rings ?? []) {
      for (const c of ring) {
        sum += c[1];
        n++;
      }
    }
  }
  const lat0 = n ? sum / n : 0;
  const kx = Math.cos((lat0 * Math.PI) / 180) * R || R;
  return {
    to: (c) => [c[0] * kx, c[1] * R],
    from: (p) => [p[0] / kx, p[1] / R],
  };
}

/** Grilla uniforme de celda = tolerancia, para buscar vecinos en O(1). */
class Grid {
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }

  key(x, y) {
    return `${Math.floor(x / this.cell)},${Math.floor(y / this.cell)}`;
  }

  add(x, y, value) {
    const k = this.key(x, y);
    let arr = this.map.get(k);
    if (!arr) {
      arr = [];
      this.map.set(k, arr);
    }
    arr.push(value);
  }

  /** Todo lo que haya en el rectángulo dado, expandido por `pad`. */
  around(minX, minY, maxX, maxY, pad = 0) {
    const c = this.cell;
    const x0 = Math.floor((minX - pad) / c);
    const x1 = Math.floor((maxX + pad) / c);
    const y0 = Math.floor((minY - pad) / c);
    const y1 = Math.floor((maxY + pad) / c);
    const out = new Set();
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const arr = this.map.get(`${x},${y}`);
        if (arr) for (const v of arr) out.add(v);
      }
    }
    return out;
  }
}

const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

/** Quita vértices repetidos consecutivos (y el cierre duplicado de un anillo). */
function dedupe(ring, closed, tolSq, xy) {
  const out = [];
  for (const c of ring) {
    if (out.length && dist2(xy(c), xy(out[out.length - 1])) <= tolSq) continue;
    out.push(c);
  }
  while (closed && out.length > 1 && dist2(xy(out[0]), xy(out[out.length - 1])) <= tolSq) {
    out.pop();
  }
  return out;
}

const minVertices = (closed) => (closed ? 3 : 2);

/** Compara coordenadas anidadas (línea o polígono) sin serializar. */
function sameCoords(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (typeof a[i] === 'number') {
      if (a[i] !== b[i]) return false;
    } else if (!sameCoords(a[i], b[i])) return false;
  }
  return true;
}

/**
 * @param {Array} features features GeoJSON (LineString o Polygon)
 * @param {{toleranceMeters?: number}} opts
 * @returns {{features: Array, fusionados: number, insertados: number,
 *            compartidos: number, degenerados: number}}
 */
export function confirmTopology(features, { toleranceMeters = 5 } = {}) {
  const tol = Math.max(0.01, toleranceMeters);
  const tolSq = tol * tol;
  const proj = projector(features);
  const xy = proj.to;

  // Geometrías utilizables; las demás (puntos, multi*) pasan intactas.
  const parsed = features.map((f) => ringsOfFeature(f));

  /* ---------- 1. fusión de vértices coincidentes ---------- */

  const clusters = [];
  const grid = new Grid(tol);
  /** Por feature/anillo, el cluster de cada vértice. */
  const assign = parsed.map((p) => (p ? p.rings.map((r) => new Array(r.length)) : null));

  parsed.forEach((p, fi) => {
    if (!p) return;
    const id = features[fi].properties.id;
    p.rings.forEach((ring, ri) => {
      ring.forEach((c, vi) => {
        const q = xy(c);
        let found = -1;
        for (const ci of grid.around(q[0], q[1], q[0], q[1], tol)) {
          if (dist2(q, clusters[ci].anchor) <= tolSq) {
            found = ci;
            break;
          }
        }
        if (found < 0) {
          found = clusters.length;
          clusters.push({ anchor: q, sum: [q[0], q[1]], n: 1, owners: new Set([id]) });
          grid.add(q[0], q[1], found);
        } else {
          const cl = clusters[found];
          cl.sum[0] += q[0];
          cl.sum[1] += q[1];
          cl.n++;
          cl.owners.add(id);
        }
        assign[fi][ri][vi] = found;
      });
    });
  });

  for (const cl of clusters) {
    cl.point = [cl.sum[0] / cl.n, cl.sum[1] / cl.n];
    cl.lngLat = proj.from(cl.point);
  }

  let fusionados = 0;
  let compartidos = 0;
  for (const cl of clusters) if (cl.owners.size > 1) compartidos++;

  const snapped = parsed.map((p, fi) => {
    if (!p) return null;
    return p.rings.map((ring, ri) =>
      ring.map((c, vi) => {
        const cl = clusters[assign[fi][ri][vi]];
        if (dist2(xy(c), cl.point) > 1e-12) fusionados++;
        return cl.lngLat.slice();
      }),
    );
  });

  /* ---------- 2. nodado: vértices sobre el segmento del vecino ---------- */

  // Índice espacial de los clusters ya fusionados, para preguntarle a cada
  // segmento qué nodos ajenos lo atraviesan.
  const pointGrid = new Grid(tol);
  clusters.forEach((cl, ci) => pointGrid.add(cl.point[0], cl.point[1], ci));

  let insertados = 0;

  const noded = snapped.map((rings, fi) => {
    if (!rings) return null;
    const id = features[fi].properties.id;
    const closed = parsed[fi].closed;

    return rings.map((ring, ri) => {
      const own = new Set(assign[fi][ri]);
      const out = [];
      const n = closed ? ring.length : ring.length - 1;

      for (let i = 0; i < ring.length; i++) {
        out.push(ring[i]);
        if (i >= n) continue;
        const a = xy(ring[i]);
        const b = xy(ring[(i + 1) % ring.length]);

        const hits = [];
        for (const ci of pointGrid.around(
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[0], b[0]),
          Math.max(a[1], b[1]),
          tol,
        )) {
          // Un nodo propio del anillo no se reinserta, y un nodo que solo
          // pertenece a esta misma feature no aporta topología con nadie.
          if (own.has(ci)) continue;
          const cl = clusters[ci];
          if (cl.owners.size === 1 && cl.owners.has(id)) continue;
          const r = nearestOnSegment(cl.point, a, b);
          if (r.distSq > tolSq) continue;
          // Los extremos ya están; solo interesa lo que cae en medio.
          if (r.t <= 0 || r.t >= 1) continue;
          hits.push({ t: r.t, ci });
        }

        hits.sort((p, q) => p.t - q.t);
        let last = null;
        for (const h of hits) {
          const cl = clusters[h.ci];
          if (last && dist2(cl.point, last) <= tolSq) continue;
          out.push(cl.lngLat.slice());
          own.add(h.ci);
          last = cl.point;
          insertados++;
        }
      }
      return out;
    });
  });

  /* ---------- 3. reconstrucción ---------- */

  let degenerados = 0;
  const outFeatures = features.map((f, fi) => {
    const rings = noded[fi];
    if (!rings) return f;
    const closed = parsed[fi].closed;
    const cleaned = rings.map((r) => dedupe(r, closed, tolSq * 1e-6, xy));
    if (cleaned.some((r) => r.length < minVertices(closed))) {
      degenerados++;
      return f;
    }
    const geometry = geometryFromRings(f, cleaned);
    // Si la geometría quedó igual se devuelve la MISMA feature, no una copia:
    // así quien llama puede comparar por identidad para saber si hubo cambio,
    // y no se ensucia el historial de deshacer con pasos que no hacen nada.
    return sameCoords(f.geometry.coordinates, geometry.coordinates)
      ? f
      : { ...f, geometry };
  });

  return { features: outFeatures, fusionados, insertados, compartidos, degenerados };
}

/**
 * Quita vértices colineales de un anillo, en grados. Se usa después de unir
 * polígonos: la unión deja el rastro del borde común como una fila de nodos
 * alineados que no aportan forma.
 *
 * @param {Array} ring anillo abierto o cerrado
 * @param {number} tolerance desviación máxima admitida, en grados
 */
export function removeCollinear(ring, tolerance = 1e-9) {
  if (ring.length < 3) return ring.slice();
  const closed =
    ring.length > 2 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1];
  const pts = closed ? ring.slice(0, -1) : ring.slice();
  if (pts.length < 3) return ring.slice();

  const keep = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const prev = keep.length ? keep[keep.length - 1] : pts[(i - 1 + n) % n];
    const cur = pts[i];
    const next = pts[(i + 1) % n];
    if (!closed && (i === 0 || i === n - 1)) {
      keep.push(cur);
      continue;
    }
    const r = nearestOnSegment(cur, prev, next);
    // Solo se descarta si además queda ENTRE los vecinos: un pico agudo cuyo
    // pie cae fuera del segmento no es un vértice redundante.
    if (r.distSq <= tolerance * tolerance && r.t > 0 && r.t < 1) continue;
    keep.push(cur);
  }
  if (keep.length < (closed ? 3 : 2)) return ring.slice();
  return closed ? [...keep, keep[0]] : keep;
}
