/**
 * Reshape: redibujar un tramo del contorno de un polígono (o de una línea)
 * trazando una línea nueva, como «Reshape Features» de QGIS y la herramienta
 * Reshape de FieldDraw (de donde sale este algoritmo).
 *
 * Geometría pura sobre coordenadas [x, y] en metros UTM, sin JSTS: el
 * algoritmo necesita saber POR DÓNDE del contorno pasa la línea (una posición
 * continua a lo largo de él), que es justo lo que las operaciones booleanas
 * pierden.
 */

const EPS = 1e-12;

/**
 * Intersección de los segmentos p1→p2 y p3→p4.
 *
 * @returns {{t: number, u: number, point: [number, number]}|null} `t` es la
 *   posición sobre el primer segmento y `u` sobre el segundo, ambas en [0,1].
 */
export function segmentIntersection(p1, p2, p3, p4) {
  const d1x = p2[0] - p1[0];
  const d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0];
  const d2y = p4[1] - p3[1];
  const den = d1x * d2y - d1y * d2x;
  if (Math.abs(den) < EPS) return null; // paralelos o degenerados

  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / den;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, point: [p1[0] + t * d1x, p1[1] + t * d1y] };
}

/**
 * Cruces de la polilínea `line` contra `target`, ordenados por su avance a lo
 * largo de `line`.
 *
 * @param {Array} target anillo o polilínea contra la que se cruza
 * @param {Array} line línea trazada por el usuario
 * @param {boolean} closed si `target` cierra (polígono)
 * @returns {Array<{onTarget: number, onLine: number, point: [number, number]}>}
 *   `onTarget` y `onLine` son posiciones continuas (índice de segmento + t),
 *   que es lo que permite ordenarlas y cortar por ellas.
 */
export function crossings(target, line, closed) {
  const out = [];
  const nT = closed ? target.length : target.length - 1;
  for (let i = 0; i < line.length - 1; i++) {
    for (let j = 0; j < nT; j++) {
      const hit = segmentIntersection(
        line[i],
        line[i + 1],
        target[j],
        target[(j + 1) % target.length],
      );
      if (hit) out.push({ onTarget: j + hit.u, onLine: i + hit.t, point: hit.point });
    }
  }
  out.sort((a, b) => a.onLine - b.onLine);

  // Dos segmentos consecutivos comparten su vértice, así que un cruce que caiga
  // justo sobre él se cuenta dos veces: se descarta el duplicado.
  return out.filter((c, i) => i === 0 || Math.abs(c.onLine - out[i - 1].onLine) > 1e-9);
}

/** Punto de una polilínea en una posición continua (índice + fracción). */
function interpolateAt(pts, pos) {
  const n = pts.length;
  const i = Math.floor(pos) % n;
  const t = pos - Math.floor(pos);
  const a = pts[i];
  const b = pts[(i + 1) % n];
  return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
}

/** Trozo de una polilínea entre dos posiciones continuas, extremos incluidos. */
function sliceAt(pts, from, to, closed) {
  const out = [interpolateAt(pts, from)];
  const n = pts.length;
  // En un anillo el trozo puede pasar por el vértice 0; se recorre sumando n
  // y se toma el módulo al indexar.
  const limit = closed && to < from ? to + n : to;
  for (let i = Math.floor(from) + 1; i < limit; i++) out.push(pts[i % n].slice());
  out.push(interpolateAt(pts, to));
  return out;
}

/**
 * Área con signo en un plano local. Solo sirve para comparar dos candidatos
 * entre sí, no como medida: la corrección por latitud es un coseno constante.
 */
function planarArea(ring) {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return Math.abs(sum) / 2;
}

/** Quita vértices repetidos consecutivos, que la interpolación puede generar. */
function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > 1e-12 || Math.abs(last[1] - p[1]) > 1e-12) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Redibuja el contorno de un polígono con la línea trazada.
 *
 * La línea tiene que cruzar el contorno al menos dos veces. Entre el primer y
 * el último cruce quedan dos candidatos: cada uno de los dos arcos del
 * contorno, cerrado con el tramo de la línea. **Se queda el de mayor área.**
 *
 * Con `keep: 'smaller'` (Alt al trazar) se invierte: se queda el menor.
 *
 * Esa regla, que suena arbitraria, es la que hace que la herramienta se
 * comporte como uno espera en los dos usos reales:
 *
 * - Línea que sale del polígono y vuelve a entrar: los candidatos son "el
 *   polígono entero más la panza" y "solo la panza". Gana el primero, o sea el
 *   polígono CRECE.
 * - Línea que lo atraviesa de lado a lado: los candidatos son los dos trozos en
 *   que queda partido. Gana el mayor, o sea se RECORTA el pequeño, que es el
 *   lado que uno acaba de dejar fuera al trazar.
 *
 * @returns {Array<[number,number]>|null} anillo abierto (sin repetir el primer
 *   punto al final), o null si la línea no cruza lo suficiente.
 */
export function reshapeRing(ring, line, { keep = 'larger' } = {}) {
  const cuts = crossings(ring, line, true);
  if (cuts.length < 2) return null;

  const first = cuts[0];
  const last = cuts[cuts.length - 1];
  if (Math.abs(first.onTarget - last.onTarget) < 1e-12) return null;

  // Tramo de la línea entre un cruce y el otro: es el que sustituye al arco.
  const mid = sliceAt(line, first.onLine, last.onLine, false);

  // Los dos arcos del contorno entre ambos cruces. Cada uno se cierra con el
  // tramo en el sentido que le corresponde.
  const arcoA = sliceAt(ring, first.onTarget, last.onTarget, true);
  const arcoB = sliceAt(ring, last.onTarget, first.onTarget, true);

  const candA = dedupe([...arcoA, ...mid.slice().reverse()]);
  const candB = dedupe([...arcoB, ...mid]);

  const validos = [candA, candB].filter((c) => c.length >= 3);
  if (validos.length === 0) return null;

  validos.sort((a, b) => planarArea(b) - planarArea(a));
  return keep === 'smaller' ? validos[validos.length - 1] : validos[0];
}

/**
 * Redibuja una polilínea abierta. Aquí no hay nada que elegir: el tramo entre
 * el primer y el último cruce se reemplaza por la línea trazada, y las dos
 * puntas se conservan.
 */
export function reshapeLine(coords, line) {
  const cuts = crossings(coords, line, false);
  if (cuts.length < 2) return null;

  const first = cuts[0];
  const last = cuts[cuts.length - 1];
  const desde = Math.min(first.onTarget, last.onTarget);
  const hasta = Math.max(first.onTarget, last.onTarget);
  if (hasta - desde < 1e-12) return null;

  const mid = sliceAt(line, first.onLine, last.onLine, false);
  // El tramo dibujado se orienta como la línea original, para no invertirla.
  const midOrientado = first.onTarget <= last.onTarget ? mid : mid.slice().reverse();

  const cabeza = sliceAt(coords, 0, desde, false);
  const cola = sliceAt(coords, hasta, coords.length - 1, false);
  const out = dedupe([...cabeza, ...midOrientado, ...cola]);
  return out.length >= 2 ? out : null;
}
