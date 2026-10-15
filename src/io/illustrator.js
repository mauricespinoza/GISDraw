/**
 * Intercambio con Illustrator.
 *
 * - `selectionSvg`: lo seleccionado como SVG en PUNTOS (1 unidad = 1 pt, como
 *   mide Illustrator), con la simbología ya dibujada (ornamentos, tramas,
 *   halos, flechas…) y, en un <metadata>, las formas originales de GISDrawer.
 *   Es lo que va al portapapeles al copiar: Illustrator lo pega como dibujo
 *   editable y GISDrawer lo vuelve a pegar exacto y georreferenciado.
 * - `illustratorJsx`: un script de Illustrator (Archivo → Scripts → Otro
 *   script…) que arma un documento del tamaño de la lámina con UNA CAPA DE
 *   ILLUSTRATOR POR CADA PARTE de la lámina —cada capa del mapa, etiquetas,
 *   grilla, marco, título, leyenda…— con su nombre, opacidad, modo de fusión
 *   y bloqueo. Es la vía robusta para conservar la estructura de capas: abrir
 *   un SVG la deja en manos de cómo Illustrator interprete los grupos.
 */

import { shapeToSvg, esc } from '../style.js';
import { shapeBBox, unionBBox } from '../vector.js';

export const MM_PT = 72 / 25.4;

/**
 * @param shapes formas de primer nivel (en orden de pintado)
 * @param {{refScale: number, est?: object, name?: string}} opts
 */
export function selectionSvg(shapes, { refScale = 25000, est = null, name = 'GISDrawer' } = {}) {
  const box = unionBBox(shapes.map((s) => shapeBBox(s, est)));
  if (!box) return null;
  const mPerPt = (refScale / 1000) / MM_PT; // metros de terreno por punto de papel
  const pad = 4; // pt, para que quepan halos y grosores
  const W = box.w / mPerPt + 2 * pad;
  const H = box.h / mPerPt + 2 * pad;
  const P = (x, y) => [(x - box.x) / mPerPt + pad, (box.y + box.h - y) / mPerPt + pad];
  const ctx = { P, mmToPx: MM_PT, ptToPx: 1, viewW: W * 4, viewH: H * 4, mpp: mPerPt, scale: refScale, defs: [], uid: 'gd_', flatTol: 0.05 };
  const body = shapes.map((s) => shapeToSvg(s, ctx)).join('');
  const meta = JSON.stringify({ app: 'GISDrawer', v: 1, refScale, shapes });
  const r = (v) => Math.round(v * 100) / 100;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${r(W)}pt" height="${r(H)}pt" viewBox="0 0 ${r(W)} ${r(H)}"><metadata id="gisdrawer">${esc(meta)}</metadata><defs>${ctx.defs.join('')}</defs><g id="${xmlId(name)}" data-name="${esc(name)}">${body}</g></svg>`;
}

/** Id XML válido a partir de un nombre (Illustrator usa id = nombre con "_"). */
export function xmlId(name, used = null) {
  let id =
    String(name || 'capa')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_-]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'capa';
  if (!/^[A-Za-z_]/.test(id)) id = `_${id}`;
  if (used) {
    let k = id;
    for (let i = 2; used.has(k); i++) k = `${id}_${i}`;
    used.add(k);
    id = k;
  }
  return id;
}

const BLEND_AI = {
  multiply: 'MULTIPLY', screen: 'SCREEN', overlay: 'OVERLAY', 'soft-light': 'SOFTLIGHT', 'hard-light': 'HARDLIGHT', darken: 'DARKEN', lighten: 'LIGHTEN',
  'color-dodge': 'COLORDODGE', 'color-burn': 'COLORBURN', difference: 'DIFFERENCE', exclusion: 'EXCLUSION', hue: 'HUE', saturation: 'SATURATIONBLEND',
  color: 'COLORBLEND', luminosity: 'LUMINOSITY',
};

/** Cadena JS ASCII (ExtendScript es ES3: sin sorpresas de codificación). */
const jsStr = (s) => JSON.stringify(String(s)).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

/** SVG autónomo de una parte de la lámina, con un marco invisible del tamaño de la página para ubicarla. */
export function partSvg(part, layout) {
  const { W, H } = layout.geometry;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}"><defs>${layout.defs}</defs><rect id="gd_marco" x="0" y="0" width="${W}" height="${H}" fill="none" stroke="none"/>${part.svg}</svg>`;
}

/**
 * Script de Illustrator con las capas de la lámina.
 * @param layout resultado de `composeLayout` (svg, parts, defs, geometry)
 */
export function illustratorJsx(layout, { title = 'Mapa' } = {}) {
  const { W, H } = layout.geometry;
  const parts = layout.parts.map((p) => ({ name: p.name, svg: partSvg(p, layout), opacity: p.opacity ?? 1, blend: BLEND_AI[p.blend] || '', locked: !!p.locked }));
  const list = parts
    .map((p) => `{name:${jsStr(p.name)},opacity:${+p.opacity.toFixed(3)},blend:${jsStr(p.blend)},locked:${p.locked},svg:${jsStr(p.svg)}}`)
    .join(',\n');
  const ascii = (t) => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '?');
  // todo el script en ASCII: ExtendScript no siempre lee bien UTF-8 sin BOM
  return `// GISDrawer -> Illustrator: ${ascii(title)}
// Ejecutar en Illustrator: Archivo > Scripts > Otro script... y elegir este archivo.
// Crea un documento de ${W} x ${H} mm con una capa de Illustrator por cada parte
// de la lamina (capas del mapa, etiquetas, grilla, marco, leyenda...).
#target illustrator
(function () {
  var MM = 72 / 25.4;
  var parts = [
${list}
  ];
  var doc = app.documents.add(DocumentColorSpace.RGB, ${W} * MM, ${H} * MM);
  app.coordinateSystem = CoordinateSystem.ARTBOARDCOORDINATESYSTEM;
  var first = doc.layers[0];
  var errors = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    // layers.add() deja la capa nueva arriba: recorrer de abajo hacia arriba conserva el orden
    var layer = i === 0 ? first : doc.layers.add();
    layer.name = p.name;
    var f = new File(Folder.temp + '/gisdrawer_' + i + '_' + new Date().getTime() + '.svg');
    f.encoding = 'UTF-8';
    f.open('w');
    f.write(p.svg);
    f.close();
    try {
      var g = layer.groupItems.createFromFile(f);
      g.position = [0, 0];
      try { g.pageItems.getByName('gd_marco').remove(); } catch (e1) {}
      if (p.blend) { try { g.blendingMode = BlendModes[p.blend]; } catch (e2) {} }
      g.name = p.name;
    } catch (e) {
      errors.push(p.name + ': ' + e);
    }
    try { f.remove(); } catch (e3) {}
    if (p.opacity < 1) layer.opacity = p.opacity * 100;
    if (p.locked) layer.locked = true;
  }
  if (errors.length) alert('GISDrawer: algunas capas no se pudieron importar\\n' + errors.join('\\n'));
})();
`;
}
