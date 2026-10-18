/**
 * Modos de la app.
 *
 * - Canvas (por defecto): solo dibujo. Sin mapa base, relieve, coordenadas,
 *   georreferenciación, atributos ni formatos GIS.
 * - GIS: todo lo anterior, como era antes de que existieran los modos.
 *
 * El modo es un ajuste de la app, no del proyecto: las capas de mapa base y
 * relieve de un proyecto siguen en él y solo se ocultan en Canvas, así que al
 * volver a GIS se ven igual.
 */

export const MODES = { canvas: 'Canvas', gis: 'GIS' };

/** Capas que solo existen en modo GIS (el resto, incluidas las imágenes, se ve en ambos). */
export const isGisLayer = (l) => l.kind === 'basemap' || l.kind === 'hillshade';

/** Pestañas del panel que solo existen en modo GIS. */
export const GIS_TABS = ['relief', 'georef', 'attrs'];

export const modeOf = (settings) => (settings?.mode === 'gis' ? 'gis' : 'canvas');
