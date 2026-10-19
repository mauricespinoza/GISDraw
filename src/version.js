/**
 * Versión de la app, visible en la ayuda (?) para comprobar qué versión se
 * está usando. Debe coincidir con `VERSION` de sw.js (lo vigila
 * test/sw.test.mjs): subir las dos juntas en cada publicación.
 */
export const APP_VERSION = 'v38';

export const APP_AUTHOR = { name: 'Mauricio Espinoza', email: 'mauricio.e.espinoza@gmail.com' };

/** Últimos cambios (el más reciente primero); se muestran en «Acerca de». */
export const CHANGELOG = [
  ['v38', 'Apartado «Acerca de la app» con autor, contacto y últimos cambios'],
  ['v37', 'Split de líneas y polígonos (toque o arrastre) y herramienta Reshape'],
  ['v36', 'Continuar una línea con Pluma o Lápiz desde su extremo'],
  ['v35', 'Deform con líneas compartidas, guardado rápido y rueda para el radio'],
  ['v34', 'Move Joined en líneas: nodo compartido al dibujar sobre otra línea'],
  ['v33', 'Snap en Drag, Simplificar, Tidy y nodos insertados compartidos'],
  ['v32', 'Herramienta Drag (nodo con arrastre proporcional) y cuentagotas con trazo y grosor'],
  ['v31', 'Deform, ícono de lápiz con mano, proyectos recientes y Drive más rápido'],
];
