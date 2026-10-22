/**
 * Versión de la app, visible en la ayuda (?) para comprobar qué versión se
 * está usando. Debe coincidir con `VERSION` de sw.js (lo vigila
 * test/sw.test.mjs): subir las dos juntas en cada publicación.
 */
export const APP_VERSION = 'v49';

export const APP_AUTHOR = { name: 'Mauricio Espinoza', email: 'mauricio.e.espinoza@gmail.com' };

/** Últimos cambios (el más reciente primero); se muestran en «Acerca de». */
export const CHANGELOG = [
  ['v49', 'Pegar desde Illustrator: si solo llega una imagen, se explica y se ofrece importar el .svg/.ai en vez de crear una capa de imagen fija'],
  ['v48', 'Escalar desde los tiradores (y Transformar) escala también grosores, halos, tramas, ornamentos, ondas, puntos y letras, incluso dentro de grupos'],
  ['v47', 'Unfreeze all nodes también dentro de grupos; pegar desde Illustrator busca el SVG en todos los formatos y avisa si solo llega una imagen'],
  ['v46', 'Unfreeze all nodes en el menú Geometría (todo el documento); lo pegado desde Illustrator como código SVG llega a su tamaño real'],
  ['v45', 'Celulares: herramientas y propiedades abajo (solo con selección); el dedo fuera de lo seleccionado vuelve a Selección; desplazar y hacer zoom más fluidos'],
  ['v44', 'Tidy: los bordes comunes comparten también los tiradores de la curva Bézier'],
  ['v43', 'Lápiz: el trazo cae donde se apoya la punta (imán casi nulo y sin guías); Unfreeze nodes en el menú Geometría'],
  ['v42', 'Tablet: el toque del dedo no cambia la selección con herramientas de dibujo'],
  ['v41', 'Freeze node: nodos fijos ante transformaciones que limitan Deform, Drag y Suavizar; Unfreeze nodes los libera'],
  ['v40', 'Nueva paleta ámbar con contraste reforzado e iconos propios en la lista de capas'],
  ['v39', 'Paleta de colores cálida e iconos rediseñados (herramientas, barra superior y logo)'],
  ['v38', 'Apartado «Acerca de la app» con autor, contacto y últimos cambios'],
  ['v37', 'Split de líneas y polígonos (toque o arrastre) y herramienta Reshape'],
  ['v36', 'Continuar una línea con Pluma o Lápiz desde su extremo'],
  ['v35', 'Deform con líneas compartidas, guardado rápido y rueda para el radio'],
  ['v34', 'Move Joined en líneas: nodo compartido al dibujar sobre otra línea'],
  ['v33', 'Snap en Drag, Simplificar, Tidy y nodos insertados compartidos'],
  ['v32', 'Herramienta Drag (nodo con arrastre proporcional) y cuentagotas con trazo y grosor'],
  ['v31', 'Deform, ícono de lápiz con mano, proyectos recientes y Drive más rápido'],
];
