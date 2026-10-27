/**
 * Versión de la app, visible en la ayuda (?) para comprobar qué versión se
 * está usando. Debe coincidir con `VERSION` de sw.js (lo vigila
 * test/sw.test.mjs): subir las dos juntas en cada publicación.
 */
export const APP_VERSION = 'v61';

export const APP_AUTHOR = { name: 'Mauricio Espinoza', email: 'mauricio.e.espinoza@gmail.com' };

/** Últimos cambios (el más reciente primero); se muestran en «Acerca de». */
export const CHANGELOG = [
  ['v61', 'Reflejar: eje vertical, horizontal, diagonales 45° / −45° (panel Organizar y menú contextual) y con cualquier ángulo (Transformar); los textos siguen legibles y los dientes de las fallas cambian de lado'],
  ['v60', 'Pegar: SVG y PDF de otros programas o del navegador, imágenes copiadas de páginas, GeoJSON/WKT/objetos de QGIS en su lugar; Ctrl+V al centro de la vista, Ctrl+F/Ctrl+B delante o detrás de lo seleccionado. Doble clic en un grupo para editar sus elementos'],
  ['v59', 'Trace: sigue por donde pasa el cursor (al doblar una esquina ya no toma el camino largo) y no salta vértices tras mover o hacer zoom durante el trazado'],
  ['v58', 'Degradado: selector de tipo visible, asas en pantalla para colores y dial de rotación, botón de degradado junto al color; icono de la app corregido para «Añadir a inicio»'],
  ['v57', 'Barra flotante: botón Simplificar al seleccionar líneas o polígonos'],
  ['v56', 'Barra flotante: Freeze node / Unfreeze node al elegir un nodo con la herramienta Nodos'],
  ['v55', 'Exportar imagen y lámina: ornamentos, puntos, tramas y textos chicos ya no desaparecen (los mínimos de tamaño se miden en píxeles de pantalla, no en mm de papel)'],
  ['v54', 'Republicación: fuerza un despliegue nuevo en GitHub Pages (sin cambios funcionales)'],
  ['v53', 'Archivo → Exportar → Imagen: PNG, JPG, TIFF o WebP de la hoja, de todo lo dibujado o de la vista, de 72 a 1200 dpi'],
  ['v52', 'Lienzo: hoja Personalizado con tiradores (vértices y bordes) para cambiar su tamaño arrastrando, y Encajar a objetos'],
  ['v51', 'Cuentagotas de texto (fuente, tamaño, estilo, color, halo); Geometría: Desagrupar todo y Borrar vacíos; alinear y distribuir como iconos en la barra flotante'],
  ['v50', 'Capas: Show all, Hide all, Lock all y Unlock all'],
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
