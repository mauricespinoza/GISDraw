# GISDrawer — dibujo vectorial georreferenciado

Un programa de dibujo tipo Illustrator donde **todo está en coordenadas reales**:
el documento vive en **WGS84 / UTM 19S (EPSG:32719)**, las coordenadas se leen
por defecto en **grados sexagesimales**, y lo que se dibuja se exporta como dato
GIS (GeoPackage con simbología QGIS, GeoJSON) o como lámina impresa (PDF, SVG,
PNG) con grilla, norte, escala y leyenda.

Pensado para **tablet con Apple Pencil** y para **PC**. Nace del editor
vectorial de GeoPhoto Studio (nodos Bézier, pluma, lápiz, formas, texto) y de
las herramientas de trace, snapping y topología de FieldDraw.

## Ejecutar

```bash
node serve.mjs 5174
```

Abre `http://localhost:5174`. El servidor imprime la IP de la red local para
probar en el iPad. Para usarla sin señal hay que publicarla con HTTPS (GitHub
Pages, Netlify, Cloudflare Pages): es un sitio estático, sin build y sin
`node_modules`.

**Al publicar una versión nueva, sube `VERSION` en `sw.js`.** Es lo único que
hace que los navegadores busquen los archivos nuevos.

## Pruebas

```bash
node test/core.test.mjs      # proyección, geometría, estilo, operaciones, etiquetas, relieve, trace
node test/georef.test.mjs    # transformaciones, residuos y remuestreo
node test/sw.test.mjs        # todo módulo está en el precache offline
```

## Entrada: lápiz, dedo y ratón

| | Tablet | PC |
|---|---|---|
| Dibujar / usar la herramienta | **Apple Pencil** | botón izquierdo |
| Desplazar | un dedo | botón central, barra espaciadora + arrastre, trackpad con dos dedos |
| Zoom | pellizco | rueda, pellizco del trackpad, Ctrl + / − |
| Seleccionar sin cambiar de herramienta | toque corto con el dedo | — |
| Terminar línea | doble toque con el lápiz, botón «Terminar» | Enter, doble clic, botón derecho |
| Cerrar polígono | tocar el primer vértice, botón «Cerrar forma» | clic en el primer vértice |

El dedo **nunca dibuja**, así la palma apoyada no deja trazos. En pantallas
táctiles sin lápiz, el botón **Dedo ✍︎** hace que el dedo dibuje. Con el
Pencil flotando (iPad compatibles) ya se ven el snapping y la línea elástica
antes de tocar. La barra contextual inferior trae, según la herramienta, lo
que en un PC iría al teclado: terminar, cerrar, quitar vértice, borrar nodo,
añadir a la selección, duplicar, pegar…

Lo que **no se puede** desde una web: el doble toque del Apple Pencil 2 y el
apretón del Pencil Pro no llegan a Safari. Los reemplazan los botones de la
barra contextual.

## Herramientas

| Tecla | Herramienta |
|---|---|
| V | Selección (mover, escalar con 8 manejadores, girar; Alt+arrastre duplica; Mayús restringe) |
| A | Nodos (mover nodos y manejadores Bézier, Alt+clic esquina/curva, doble clic o Alt+clic inserta) |
| Q | Lazo |
| P | Pluma / línea (clic = vértice, arrastre = curva) |
| Y | Polígono |
| B | Lápiz (trazo libre simplificado y suavizado; cerrar cerca del inicio = polígono) |
| \\ | Segmento · W Flecha · M Rectángulo · E Elipse (Mayús = proporcional, Alt = desde el centro) |
| T | Texto · O Punto (símbolo) · I Cuentagotas · H Mano |
| K | **Trace**: al poner un vértice sobre una línea existente, la nueva sigue la geometría hasta ese punto (camino más corto, como en QGIS) |
| S | Snapping a vértices y segmentos |

Atajos con Ctrl/⌘: Z deshacer, Mayús+Z rehacer, C/X/V copiar/cortar/pegar,
**Mayús+V pegar en el lugar**, D duplicar, A seleccionar todo, G agrupar,
Mayús+G desagrupar, **7 máscara de recorte**, Alt+7 liberarla, ] adelante,
[ atrás (con Mayús: al frente / al fondo), 0 zoom a todo, S guardar proyecto.

## Estilo

- **Relleno** sólido, **degradado lineal o radial** (paradas, ángulo, opacidad por parada).
- **Trazo** continuo, **segmentado, punteado, punto y raya** o patrón propio (en
  múltiplos del grosor), extremos y esquinas, opacidad.
- **El borde crece solo hacia afuera.** En polígonos, el trazo se dibuja al
  doble del ancho y se recorta con una máscara par-impar que deja pasar solo
  lo que está fuera de la forma: engrosar el borde nunca tapa el relleno, ni
  siquiera si el relleno es transparente, y en los huecos crece hacia el hueco.
  También se puede alinear centrado o hacia adentro.
- **Borde de línea** (casing) en líneas abiertas: se agrega a cada lado, por
  debajo; el núcleo conserva su grosor completo. Si la línea es segmentada,
  cada raya tiene su borde.
- **Puntas de flecha** de inicio y fin (flecha, abierta, aguda, círculo, cuadrado, barra) y su tamaño.
- Opacidad y **modo de fusión** por objeto y por capa.
- Grosores en **mm** y textos en **pt**, medidos en el papel a la **escala de
  referencia** del documento: lo que se ve a 1:25 000 es lo que se imprime.

## Capas

Vectoriales, mapas base (OpenTopoMap, OSM, Esri satélite/topo/océano/relieve,
Carto), relieve sombreado e imágenes. Cada una con visible, **bloqueo**,
**opacidad**, **modo de fusión** (multiplicar, trama, superponer, luz suave…),
orden, duplicar y eliminar.

## Organizar

Traer al frente / adelante / atrás / al fondo, **alinear** (6 modos) y
**distribuir** (centros o espacios), agrupar, **máscara de recorte** (la forma
cerrada superior recorta a las demás), mover a otra capa, copiar, **pegar en el
lugar**.

**Seleccionar lo mismo**: relleno, trazo, relleno y trazo, grosor, tipo de
línea, estilo completo, tipo de objeto, opacidad, valor de un atributo, o todo
en la capa; en todas las capas visibles o solo en la del objeto. Y
**seleccionar por atributo** (=, ≠, <, >, ≤, ≥, contiene, vacío).

## Etiquetas

Por capa: un **campo** o una **plantilla** (`{codigo} ({edad})`), fuente,
tamaño, negrita/cursiva, color, **halo**, placa de fondo, mayúsculas.
Ubicación profesional: puntos arriba a la derecha; **líneas curvadas sobre el
tramo más recto, siempre legibles de izquierda a derecha**, con repetición
opcional; **polígonos en el polo de inaccesibilidad** (cae dentro aunque la
unidad tenga forma de C). Evita superposiciones (la capa superior gana) y puede
ocultarse bajo cierta escala.

## Relieve sombreado

Modelos de elevación gratuitos:

| Fuente | Cobertura | Clave |
|---|---|---|
| **Terrarium (AWS Open Data)** | global, SRTM/GMTED en tierra y **batimetría ETOPO1/GEBCO** en el mar | no |
| **Copernicus GLO-30 / GLO-90**, NASADEM, SRTM GL1/GL3, ALOS AW3D30 | global, 30–90 m | OpenTopography (gratuita) |
| **GEBCO 2023** | topo-batimetría global | OpenTopography (gratuita) |
| GeoTIFF o ASCII grid propio | lo que tengas | no |

Sombreado de Horn calculado **en UTM** (celdas cuadradas en metros, sin la
distorsión de un DEM en grados), con azimut y altura de la luz, exageración,
intensidad y modo **multidireccional**. Encima, una **paleta** (topo-batimetría
ETOPO, batimetría GEBCO, hipsométrica, andina, viridis, magma, espectral, solo
océano) mezclada por **multiplicar**, superponer, luz suave o trama, con su
opacidad, rango automático o manual y opción de mar transparente. Ajustes de
**brillo, contraste, gamma y saturación**. Exportable como GeoTIFF RGBA en
UTM 19S.

## Georreferenciación

Archivo → *Georreferenciar imagen*: un mapa escaneado, una foto o una figura
(JPG, PNG, TIFF) se pone sobre el mapa y se ubica con **puntos de control**:
un toque en la imagen y otro en el mapa (con snapping al dibujo), o
coordenadas escritas en UTM o en grados sexagesimales. Transformaciones
**Helmert**, **afín**, **polinomial de 2º orden** y **thin-plate spline**, con
**residuo por punto** y RMS en metros; los puntos se pueden desactivar.
Lee y escribe el formato `.points` de QGIS. *Aplicar* remuestrea a UTM 19S y
deja la imagen como capa; también se descarga como GeoTIFF.

## Layout de impresión

Pestaña **Layout**: página A4–A0, carta u oficio, horizontal o vertical,
márgenes; escala exacta y centro; **grilla UTM** (cruces, líneas o marcas) y/o
**graticulado geográfico** en grados-minutos con **borde de cebra**; **norte
verdadero** girado por la convergencia de meridianos del centro; **escala
gráfica y numérica**; **leyenda automática** (un símbolo por estilo, rotulado
con el campo de etiqueta); título, subtítulo, autor, fecha, notas, datum y
fuentes. Exporta **PDF**, **SVG** (en mm reales, editable en Illustrator) y
**PNG** a 150–400 dpi. El relieve se recalcula a la resolución de salida, y
las rasters se componen con sus modos de fusión antes de entrar al PDF (que no
entiende `mix-blend-mode`).

## Formatos

| | Importar | Exportar |
|---|---|---|
| GeoPackage | todas las tablas de features, cualquier sistema (EPSG o WKT), atributos, **estilo QGIS embebido** | una tabla por capa y tipo de geometría, EPSG:32719, atributos, **QML con la simbología del dibujo** |
| QML / QLR (QGIS) | símbolo único, categorizado, graduado y por reglas; símbolos de varias capas (relleno + contorno, línea con borde, flechas, degradados, marcadores); etiquetado simple | dentro del GeoPackage |
| GeoJSON | WGS84 o con `crs` | WGS84 (RFC 7946) o UTM 19S |
| GeoTIFF | elevación (una banda) o imagen RGB(A), en su sistema | relieve calculado, imagen georreferenciada |
| ASCII grid | elevación | — |
| Proyecto `.gisdrawer` | sí | sí (además se guarda solo en el navegador) |

Sistemas reconocidos sin pedir nada: WGS84, UTM WGS84 (todas las zonas),
PSAD56 / UTM 17–20S, SAD69 / UTM 18–25S, SIRGAS 2000 / UTM 17–25S, Web
Mercator, y cualquier WKT o proj4 que traiga el archivo.

## Arquitectura

ESM nativo, sin bundler ni dependencias instaladas (como FieldDraw: el
proyecto puede vivir en Google Drive sin que npm falle). Las librerías externas
están en `vendor/`: proj4, sql.js (GeoPackage), geotiff.js, JSTS, jsPDF y
svg2pdf.

| Módulo | Qué hace |
|---|---|
| `src/proj.js` | UTM ↔ geográficas (series de Krüger, < 1 mm), DMS |
| `src/vector.js` | formas inmutables, nodos Bézier, aplanado, medición |
| `src/style.js` | estilo → SVG: borde hacia afuera, borde de línea, segmentados, degradados, flechas |
| `src/doc.js` | documento, capas, historial (deshacer por referencias) |
| `src/editor.js` | herramientas, entrada lápiz/dedo/ratón, snapping, trace |
| `src/snapping.js` | índice espacial y camino más corto (de FieldDraw) |
| `src/ops.js` | portapapeles, orden, alinear, distribuir, máscara, seleccionar lo mismo |
| `src/labels.js` | etiquetado con colisiones y polo de inaccesibilidad |
| `src/raster/` | mapas base, DEM, relieve sombreado y paletas |
| `src/georef.js` | transformaciones de georreferenciación y remuestreo |
| `src/layout/compose.js` | la lámina en SVG (mm) |
| `src/io/` | GeoPackage, QML, GeoJSON, GeoTIFF, sistemas de coordenadas, almacenamiento |
| `src/ui/` | paneles, georreferenciación, layout |

## Pendiente

- **Topología** de FieldDraw (confirmación de vértices compartidos) y
  **construir polígonos desde contactos** (polygonize con JSTS): el trace y el
  snapping ya están; falta la herramienta que cierra unidades desde líneas.
- Simbología QGIS más rica: rellenos de patrón reales (hoy se aproximan con un
  color translúcido), marcadores SVG, ornamentos sobre líneas (dientes de
  falla inversa, barbas).
- El contorno "hacia afuera" se exporta a QGIS como línea desplazada medio
  grosor; conviene comprobar el sentido del desplazamiento en QGIS con anillos
  de orientación mixta.
- Declinación magnética en el layout (requiere el modelo WMM).
