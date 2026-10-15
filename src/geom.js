/**
 * Geometría 2D en coordenadas de pantalla (px). Todo el snapping, el trace y
 * la detección de "toque afuera" trabajan en píxeles: así las tolerancias se
 * expresan como el usuario las percibe y no dependen del zoom ni de la
 * deformación de Mercator con la latitud.
 */

/** Punto más cercano del segmento a-b respecto de p. */
export function nearestOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lenSq = dx * dx + dy * dy;
  let t = 0;
  if (lenSq > 0) {
    t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lenSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
  }
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  const ex = p[0] - x;
  const ey = p[1] - y;
  return { point: [x, y], t, distSq: ex * ex + ey * ey };
}

export function distPointSegment(p, a, b) {
  return Math.sqrt(nearestOnSegment(p, a, b).distSq);
}

/**
 * Punto más cercano de una polilínea. `index` es el segmento donde cae, lo que
 * permite insertar un vértice ahí sin volver a buscar.
 */
export function nearestOnPolyline(p, pts, closed = false) {
  if (pts.length === 0) return null;
  if (pts.length === 1) {
    const ex = p[0] - pts[0][0];
    const ey = p[1] - pts[0][1];
    return { point: pts[0].slice(), index: 0, t: 0, distSq: ex * ex + ey * ey };
  }
  let best = null;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) {
    const r = nearestOnSegment(p, pts[i], pts[(i + 1) % pts.length]);
    if (!best || r.distSq < best.distSq) best = { ...r, index: i };
  }
  return best;
}

/** Vértice más cercano de una polilínea (para snapping a vértice). */
export function nearestVertex(p, pts) {
  let best = null;
  for (let i = 0; i < pts.length; i++) {
    const ex = p[0] - pts[i][0];
    const ey = p[1] - pts[i][1];
    const distSq = ex * ex + ey * ey;
    if (!best || distSq < best.distSq) best = { point: pts[i].slice(), index: i, distSq };
  }
  return best;
}

export function bboxOf(pts, pad = 0) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of pts) {
    if (p[0] < minX) minX = p[0];
    if (p[0] > maxX) maxX = p[0];
    if (p[1] < minY) minY = p[1];
    if (p[1] > maxY) maxY = p[1];
  }
  return [minX - pad, minY - pad, maxX + pad, maxY + pad];
}

export function bboxIntersects(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

export function pointInBbox(p, b) {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}

/** Ray casting sobre un anillo. Los puntos del borde pueden dar cualquiera. */
export function pointInRing(p, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Primer anillo exterior, el resto huecos, como manda GeoJSON. */
export function pointInPolygon(p, rings) {
  if (rings.length === 0 || !pointInRing(p, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(p, rings[i])) return false;
  return true;
}

/**
 * Elemento bajo el dedo. Prioriza el más cercano al borde; un polígono tocado
 * en su interior cuenta como distancia cero, para que se pueda seleccionar sin
 * tener que apuntar justo al contorno.
 */
export function pickFeature(features, screen, project, tolerance) {
  let best = null;
  for (const f of features) {
    if (!f.geometry) continue;

    // Los puntos —las medidas de rumbo y manteo— no tienen anillos: se
    // resuelven por distancia directa. El símbolo es alto y estrecho, así que
    // se les da algo más de margen que a una línea, o habría que apuntar
    // justo al trazo de rumbo para seleccionarlos.
    if (f.geometry.type === 'Point') {
      const q = project(f.geometry.coordinates);
      const dist = Math.hypot(screen[0] - q.x, screen[1] - q.y);
      if (dist <= tolerance + 6 && (!best || dist < best.dist)) best = { feature: f, dist };
      continue;
    }

    const rings = ringsOf(f.geometry).map((r) => ({
      ...r,
      pts: r.coords.map((c) => {
        const q = project(c);
        return [q.x, q.y];
      }),
    }));
    if (rings.length === 0) continue;

    let dist = Infinity;
    for (const r of rings) {
      const near = nearestOnPolyline(screen, r.pts, r.closed);
      if (near) dist = Math.min(dist, Math.sqrt(near.distSq));
    }
    if (f.geometry.type === 'Polygon' && pointInPolygon(screen, rings.map((r) => r.pts))) {
      dist = 0;
    }
    if (dist <= tolerance && (!best || dist < best.dist)) best = { feature: f, dist };
  }
  return best ? best.feature : null;
}

/**
 * Encadena polilíneas sueltas en una sola, uniéndolas por los extremos más
 * próximos. El salto entre una pieza y la siguiente queda como un segmento
 * recto, que es justo lo que se quiere al unir tramos de un mismo contacto
 * que quedaron separados.
 */
export function chainLines(lines) {
  const remaining = lines.filter((l) => l && l.length >= 2).map((l) => l.slice());
  if (remaining.length === 0) return null;
  let chain = remaining.shift();

  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  while (remaining.length > 0) {
    let best = null;
    for (let i = 0; i < remaining.length; i++) {
      const cand = remaining[i];
      // Se evalúan los cuatro emparejamientos posibles de extremos.
      const options = [
        { dist: d(chain.at(-1), cand[0]), at: 'end', reverse: false },
        { dist: d(chain.at(-1), cand.at(-1)), at: 'end', reverse: true },
        { dist: d(chain[0], cand.at(-1)), at: 'start', reverse: false },
        { dist: d(chain[0], cand[0]), at: 'start', reverse: true },
      ];
      for (const o of options) if (!best || o.dist < best.dist) best = { ...o, index: i };
    }
    const cand = remaining.splice(best.index, 1)[0];
    const piece = best.reverse ? cand.slice().reverse() : cand;
    chain = best.at === 'end' ? [...chain, ...piece] : [...piece, ...chain];
  }
  return chain;
}

/** ¿Se cruzan los segmentos a-b y c-d? Colinealidad aparte, que aquí no decide. */
export function segmentsIntersect(a, b, c, d) {
  const cross = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0) !== (d2 > 0)) && ((d3 > 0) !== (d4 > 0))) return true;
  // Un extremo justo encima del otro segmento también cuenta: el lazo se
  // dibuja a mano y rozar es exactamente lo que se quiere detectar.
  const onSeg = (p, q, r) =>
    Math.abs(cross(p, q, r)) < 1e-9 &&
    Math.min(p[0], q[0]) - 1e-9 <= r[0] && r[0] <= Math.max(p[0], q[0]) + 1e-9 &&
    Math.min(p[1], q[1]) - 1e-9 <= r[1] && r[1] <= Math.max(p[1], q[1]) + 1e-9;
  return onSeg(c, d, a) || onSeg(c, d, b) || onSeg(a, b, c) || onSeg(a, b, d);
}

/** Los cuatro vértices de `[minX, minY, maxX, maxY]`, en orden. */
export function boxRing(box) {
  return [
    [box[0], box[1]],
    [box[2], box[1]],
    [box[2], box[3]],
    [box[0], box[3]],
  ];
}

/**
 * Ids de los elementos que una REGIÓN de pantalla se lleva. La región es un
 * anillo de puntos `[x, y]` —los cuatro de un rectángulo, o el trazo del lazo
 * a mano alzada—, y se cierra sola.
 *
 * Por omisión basta con ROZAR: si el lazo cruza una línea, o encierra un trozo
 * de ella, esa línea entra. Antes había que envolver el elemento entero, que
 * es el criterio de QGIS, y en una tablet resulta impracticable: un contacto
 * de borde a borde de la pantalla no se puede encerrar sin alejar el mapa
 * hasta perder de vista lo que se estaba eligiendo. Con `contain: true` se
 * recupera el criterio estricto.
 *
 * Un polígono cuenta además si la región cae ENTERA dentro de él: arrastrar un
 * lazo chico dentro de una unidad grande es la manera obvia de elegirla, y sin
 * esto no habría forma de hacerlo sin llegar hasta su contorno.
 */
export function featuresInRegion(features, region, project, { contain = false } = {}) {
  const ring = (region || []).filter((p) => Array.isArray(p) && p.length >= 2);
  const out = [];
  if (ring.length < 3) return out;

  const rbox = [
    Math.min(...ring.map((p) => p[0])),
    Math.min(...ring.map((p) => p[1])),
    Math.max(...ring.map((p) => p[0])),
    Math.max(...ring.map((p) => p[1])),
  ];
  const dentro = (p) => pointInBbox(p, rbox) && pointInRing(p, ring);

  for (const f of features || []) {
    if (!f.geometry) continue;

    // Una medida de rumbo y manteo es un punto y no tiene anillos: `ringsOf`
    // devuelve vacío, y sin esta rama el lazo no se llevaba ni una sola.
    if (f.geometry.type === 'Point') {
      const q = project(f.geometry.coordinates);
      if (dentro([q.x, q.y])) out.push(f.properties.id);
      continue;
    }

    const anillos = ringsOf(f.geometry).map((r) => ({
      closed: r.closed,
      pts: r.coords.map((c) => {
        const q = project(c);
        return [q.x, q.y];
      }),
    }));
    if (anillos.length === 0) continue;

    /*
     * Descarte barato por caja. Rozar exige comparar cada segmento del
     * elemento con cada lado de la región, y un lazo a mano alzada tiene
     * decenas de lados: sin este filtro, elegir sobre un mapa levantado
     * entero cuesta el producto de las dos cosas, y casi todo lo que se
     * compara está al otro lado de la pantalla.
     */
    const fbox = bboxOf(anillos.flatMap((r) => r.pts));
    if (!bboxIntersects(fbox, rbox)) continue;

    if (contain) {
      if (anillos.every((r) => r.pts.every(dentro))) out.push(f.properties.id);
      continue;
    }

    if (anillos.some((r) => r.pts.some(dentro)) || crossesAny(anillos, ring)) {
      out.push(f.properties.id);
      continue;
    }
    // La región entera dentro del polígono: ningún vértice suyo está dentro y
    // ningún borde se cruza, pero el lazo sí está sobre el elemento.
    if (
      f.geometry.type === 'Polygon' &&
      pointInPolygon(ring[0], anillos.map((r) => r.pts))
    ) {
      out.push(f.properties.id);
    }
  }
  return out;
}

/** ¿Algún tramo del elemento cruza algún lado de la región? */
function crossesAny(anillos, ring) {
  for (const r of anillos) {
    const n = r.closed ? r.pts.length : r.pts.length - 1;
    for (let i = 0; i < n; i++) {
      const a = r.pts[i];
      const b = r.pts[(i + 1) % r.pts.length];
      for (let j = 0; j < ring.length; j++) {
        if (segmentsIntersect(a, b, ring[j], ring[(j + 1) % ring.length])) return true;
      }
    }
  }
  return false;
}

/**
 * El lazo rectangular, en los mismos términos: `[minX, minY, maxX, maxY]`.
 * Es el mismo criterio de roce que el lazo a mano alzada — lo contrario sería
 * que la misma herramienta eligiera distinto según con qué forma se arrastre.
 */
export function featuresInBox(features, box, project, opts = {}) {
  return featuresInRegion(features, boxRing(box), project, opts);
}

/** Aplana la geometría de una feature GeoJSON a arrays de anillos/líneas. */
export function ringsOf(geometry) {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [{ coords: geometry.coordinates, closed: false }];
  if (geometry.type === 'MultiLineString') {
    return geometry.coordinates.map((c) => ({ coords: c, closed: false }));
  }
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.map((c) => ({ coords: c, closed: true }));
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.flat().map((c) => ({ coords: c, closed: true }));
  }
  return [];
}
