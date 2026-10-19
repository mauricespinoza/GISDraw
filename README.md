# GISDrawer — dibujo vectorial georreferenciado

Un programa de dibujo donde **todo está en coordenadas reales**:
el documento vive en **WGS84 / UTM 19S (EPSG:32719)**, las coordenadas se leen
por defecto en **grados sexagesimales**, y lo que se dibuja se exporta como dato
GIS (GeoPackage con simbología QGIS, GeoJSON) o como lámina impresa (PDF, SVG,
PNG) con grilla, norte, escala y leyenda.

Pensado para **tablet con Apple Pencil** y para **PC**. Nace del editor
vectorial de GeoPhoto Studio (nodos Bézier, pluma, lápiz, formas, texto) y de
las herramientas de trace, snapping y topología de FieldDraw.

## Ver en el iPad

1. En GitHub: **Settings → Pages → Build and deployment → Source: «Deploy from a
   branch» → Branch: `main` / `(root)` → Save**.
2. Espera 1–2 minutos: aparece la dirección `https://<usuario>.github.io/GISDraw/`.
3. En el iPad abre esa dirección **en Safari** (con conexión, una vez) →
   botón **Compartir → Añadir a pantalla de inicio**. Desde ahí abre como app y
   queda guardada para usarla **sin señal**.

Si el repositorio es privado, GitHub Pages exige un plan de pago; hazlo público
o usa Netlify / Cloudflare Pages. Al publicar una versión nueva hay que subir
`VERSION` en `sw.js`; en el iPad se actualiza al abrir la app con señal y
cerrarla y abrirla de nuevo.

## Ejecutar

```bash
node serve.mjs 5174
```

Abre `http://localhost:5174`. El servidor imprime la IP de la red local para
probar en el iPad. Para usarla sin señal hay que publicarla con HTTPS (GitHub
Pages, Netlify, Cloudflare Pages): es un sitio estático, sin build y sin
`node_modules`.

**Al publicar una versión nueva, sube `VERSION` en `sw.js` y `APP_VERSION` en
`src/version.js`** (`node test/sw.test.mjs` exige que coincidan). La app pide
primero la red y usa la copia guardada solo sin señal, así que con conexión se
ve siempre lo último; al detectar una versión nueva se recarga sola. La
versión en uso se ve en la ayuda (`?`). Si ves una versión vieja: Ctrl+F5, o
en las herramientas del navegador → Aplicación → Service Workers →
«Unregister» y recargar. En local (`node serve.mjs`) no hay caché; hay que
`git pull` primero.

## Pruebas

```bash
node test/core.test.mjs      # proyección, geometría, estilo, operaciones, etiquetas, relieve, trace
node test/georef.test.mjs    # transformaciones, residuos y remuestreo
node test/ornaments.test.mjs # ornamentos, onda, tramas, halos
node test/richtext.test.mjs # texto con formato por tramos (color/tamaño/negrita/cursiva)
node test/pdf.test.mjs       # Illustrator (.ai) / PDF vectorial: capas, colores, textos
node test/mode.test.mjs      # modos Canvas/GIS, hoja del lienzo y valores por defecto
node test/freehand.test.mjs  # lápiz: suavizado 0–100 % y re-suavizado del trazo
node test/trace.test.mjs     # Trace: grafo nodado, alterno, tolerancia
node test/geomops.test.mjs  # Join, Merge, Split y Hole
node test/smooth.test.mjs   # pincel de Suavizar: solo el sector bajo el pincel
node test/deform.test.mjs     # Deform y Drag: gradiente, alcance, subdivisión y nodos compartidos
node test/smoothtopo.test.mjs # suavizado por arcos: nodos compartidos, sin perder el cierre
node test/project.test.mjs   # proyecto .gisdrawer autocontenido (imágenes incrustadas)
node test/transform.test.mjs # Transformar (mover/rotar/escalar exactos) y lectura de coordenadas
node test/sw.test.mjs        # todo módulo está en el precache offline
```

## Modos Canvas y GIS

El conmutador **Canvas | GIS** (arriba, junto al logo) elige qué se muestra. Se
recuerda en el navegador y **la app abre en Canvas**.

- **Canvas** (por defecto): solo dibujo, sobre fondo blanco. Sin mapa base,
  relieve, coordenadas del cursor, atribuciones, grilla de coordenadas en la
  lámina, ni las pestañas Relieve, Georref. y Atributos, ni los importadores y
  exportadores GIS (GeoPackage, GeoJSON, GeoTIFF, QGIS, FieldDraw). Se conservan
  el dibujo, el estilo, la geología, las etiquetas, el layout, las imágenes
  (PNG/JPG, `.ai`), SVG, PDF e Illustrator.
- **GIS**: todo lo anterior, como era antes de los modos.

**Pestaña Lienzo** (solo Canvas): tamaño de la hoja —Letter, A4, A3, A2, A1,
A0 o personalizado— y orientación. Por defecto **A4 vertical**. La hoja se ve
blanca sobre una mesa de trabajo gris; el dibujo puede salir de ella. Abrir un
`.ai` en Canvas toma el tamaño de su mesa de trabajo y deja el dibujo sobre la
hoja. El zoom se muestra en % (100 % = la hoja a su tamaño real).

Los valores por defecto son los de una **figura de media hoja**: en A4, trazo
de 0,35 mm (1 pt) y letra de 9 pt. En otras hojas crecen con la raíz del área
(A3: 0,5 mm y 12,5 pt; A0: 1,5 mm y 38 pt) y se recalculan al cambiar de hoja;
se pueden ajustar en la misma pestaña. El layout de impresión sigue la hoja
(si es una de las suyas).

El modo no toca el proyecto: las capas de mapa base y relieve de un proyecto se
ocultan en Canvas (y en la lámina) y reaparecen al volver a GIS.

## Entrada: lápiz, dedo y ratón

| | Tablet | PC |
|---|---|---|
| Dibujar / usar la herramienta | **Apple Pencil** | botón izquierdo |
| Desplazar | un dedo | botón central, barra espaciadora + arrastre, trackpad con dos dedos |
| Zoom | pellizco | **rueda del mouse** (con cualquier escalado de pantalla de Windows), pellizco del trackpad, Ctrl + / − |
| Seleccionar sin cambiar de herramienta | toque corto con el dedo | — |
| Terminar línea | doble toque con el lápiz, botón «Terminar» | Enter, doble clic, botón derecho |
| Cerrar polígono | tocar el primer vértice, botón «Cerrar forma» | clic en el primer vértice |
| **Menú contextual** | **mantener el dedo** (o el lápiz con Selección/Nodos) ~0,5 s | **botón derecho** |

El menú contextual ofrece lo que corresponde a lo que hay bajo el puntero:
cortar, copiar, duplicar, eliminar, orden, agrupar, unir o cerrar trazos,
invertir dirección, bloquear, ocultar, seleccionar lo mismo, editar nodos o
texto, abrir Estilo/Geología/Atributos, pegar, mostrar o desbloquear todo,
zoom y copiar las coordenadas del punto.

El clic secundario (y mantener apretado en pantallas táctiles) **solo abre el
menú de la app**, y solo sobre el lienzo: en el resto de la interfaz no sale
el menú del navegador. Se exceptúan los campos de texto y números, donde el
menú del sistema (copiar, pegar) hace falta. Lo único que una página no puede
impedir es Mayús + clic secundario en Firefox, que fuerza el menú del
navegador.

El dedo **nunca dibuja**, así la palma apoyada no deja trazos. En pantallas
táctiles sin lápiz, el botón **Dedo ✍︎** hace que el dedo dibuje. Con el
Pencil flotando (iPad compatibles) ya se ven el snapping y la línea elástica
antes de tocar. La barra contextual inferior trae, según la herramienta, lo
que en un PC iría al teclado: terminar, cerrar, quitar vértice, borrar nodo,
añadir a la selección, duplicar, pegar…

Lo que **no se puede** desde una web: el doble toque del Apple Pencil 2 y el
apretón del Pencil Pro no llegan a Safari. Los reemplazan los botones de la
barra contextual.

### Tablet: gestos de toque

Un toque corto de **dos dedos, dos veces seguidas, deshace**; de **tres dedos,
dos veces, rehace** (si los dedos se mueven es desplazar o hacer zoom). Mantener
el dedo abre el menú contextual (Join, Merge, Split, Hole…). Archivo → Vista
cambia entre dos toques seguidos y un solo toque.

### Cuenta de Google y Drive

El botón **G** de la barra (o Archivo → «Cuenta de Google y Drive…») abre el
cuadro con el botón clásico **Iniciar sesión con Google** (ventana de Google):
muestra la cuenta, permite cambiar de cuenta o cerrar sesión, y guarda el ID de
cliente y la clave de API (ver abajo). Con la sesión iniciada:

- **Archivo → Guardar en Google Drive** guarda el proyecto `.gisdrawer` en «Mi
  unidad» (la primera vez crea el archivo y recuerda su id dentro del
  proyecto; las siguientes lo **actualiza**). **Guardar en Google Drive en otra
  carpeta…** deja elegir la carpeta (selector de Google) y el nombre.
- Un proyecto abierto desde Drive (Archivo → Importar → Desde Google Drive)
  se guarda de vuelta en el mismo archivo.
- El permiso es `drive.file` (más el correo y el nombre para mostrar la
  cuenta): la app solo ve los archivos que ella crea o que eliges.

### Simplificar y Tidy (menú «Geometría ▾» → Limpieza, o clic secundario)

- **Simplificar**: quita los nodos que no hacen falta sin perder la forma
  (Ramer–Douglas–Peucker: ningún punto del trazo se aleja más que la
  **tolerancia**, en mm de papel en Canvas o metros en GIS, con deslizador y
  vista previa en vivo que cuenta los nodos antes y después). La opción
  «Rehacer con curvas suaves» deja nodos de curva para trazos curvos. Los
  bordes que comparten varias formas se simplifican **igual en todas** (por
  arcos), así no se abre el cierre topológico.
- **Tidy**: hace que las líneas y polígonos seleccionados **compartan sus
  nodos** donde están cerca: los nodos de formas distintas a menos del
  **umbral de cercanía** (ajustable, con vista previa) se juntan en uno, y los
  que caen sobre el borde de una vecina se insertan en ese borde. Las curvas
  se conservan y dos nodos del mismo trazo nunca se fusionan entre sí. Deja
  listo el dibujo para Move Joined, Trace, Drag, Deform y el suavizado.

**Insertar nodo compartido**: con la herramienta Nodos y **varias** líneas o
polígonos seleccionados que comparten un borde (Mayús + clic o lazo), Alt +
clic (o «Insertar al tocar») sobre ese borde, o doble clic, agrega el nodo en
todas las formas que tienen ese mismo tramo, en el mismo punto: el nuevo nodo
queda compartido. Con una sola forma seleccionada pasa lo mismo con las
vecinas si Move Joined está activado.

### Join, Merge, Split y Hole (menú «Geometría ▾» y clic secundario / mantener el dedo)

- **Join (Ctrl+J)**: dos o más líneas seleccionadas se encadenan en **una sola**
  por los extremos más cercanos (se invierten las que haga falta; si los
  extremos están a menos de 2 px se funden en un vértice, si no se agrega un
  tramo recto). Con una sola línea la cierra.
- **Merge (Ctrl+J)**: dos o más polígonos seleccionados se funden en uno (la
  unión, con los huecos que resulten; si no se tocan quedan como polígonos
  separados y avisa). Conserva el estilo del de más abajo.
- **Split**: un polígono seleccionado y, con Mayús, una línea existente que lo
  cruza de borde a borde → «Dividir con la línea seleccionada» (la línea se
  conserva); o «Dividir dibujando una línea…»: se dibuja una línea nueva que
  cruza el polígono (con snap y Trace) y no queda en el dibujo. Admite varias
  líneas y polígonos con huecos; cada parte conserva el estilo.
- **Hole**: el polígono de más abajo pierde la zona que cubren los de encima:
  una forma dentro le abre un **hueco**; una que lo traslapa le muerde un
  trozo. «Hueco con la forma de arriba» consume la forma, «Hueco conservando
  la forma» la deja; «Hueco dibujando una forma…» dibuja el contorno del hueco.

Las curvas Bézier se aplanan al operar (la geometría booleana es de
polilíneas). Todo se deshace con Ctrl+Z.

### Deslizadores y diálogos

- **Deslizadores emergentes**: al tocar un número de la barra de propiedades
  (grosor, opacidad, tamaño de letra) o el **zoom / escala** de la barra
  superior aparece un deslizador debajo. El cambio se ve en vivo y al soltar
  queda **un solo paso** de deshacer. Lo mismo en los paneles: grosor y letra
  por defecto (Lienzo), halo, ornamentos, onda (Estilo / Geología), tamaño,
  halo, desplazamiento y repetición de etiquetas, clases de la simbología,
  tolerancias de Trace / topología y margen, escala, rótulos de grilla,
  ancho de leyenda y factor de símbolos del Layout. Grosores, letras y
  escalas usan un deslizador logarítmico (fino en lo chico, rápido en lo
  grande); siempre se puede escribir el valor exacto.
- **Transformar…** (menú Geometría, clic secundario o **Ctrl+Mayús+M**):
  mover (mm de papel en Canvas, metros en GIS), rotar (°) y escalar (%, uniforme
  o no, opcionalmente también los grosores), desde el centro de la selección o
  de cada objeto. Vista previa en vivo con el cuadro a un costado; Aplicar es
  un solo deshacer y Cancelar / Esc no deja rastro.
- **Diálogos propios** en lugar de los del navegador: renombrar capas, campos
  nuevos, borrar capas o estilos, estilo de layout, Ir a coordenadas (muestra
  en vivo cómo entendió lo escrito: grados ↔ UTM), coordenadas de un punto de
  control, enlace y nombre en Google Drive, y el sistema de un GeoTIFF / ASCII
  grid que no lo declara (lista de EPSG habituales en Chile —WGS84, PSAD56,
  SAD69, SIRGAS— o un código validado). Enter acepta, Esc cancela.
- La ayuda (atajos, gestos y versión) también está en **Archivo → Vista**.

### Trazo libre (lápiz, B): suavizado

El control **Suavizado** (0–100 %) aparece en la barra de propiedades al usar el
lápiz y siempre que haya **una línea o polígono seleccionado** (también en el
panel Estilo → «Trazo libre (lápiz)»). Con el lápiz es además el suavizado
**por defecto** de los próximos trazos (50 %, se recuerda). Sobre la selección
**re-suaviza en vivo** (un solo paso de deshacer): un trazo libre, a partir de
sus puntos originales; cualquier otra línea (pluma, importada, ya editada o
movida), a partir de su forma actual, que queda como el 0 %: mover el
deslizador la suaviza y volver a 0 % la deja como estaba. 0 % deja el trazo
casi como se dibujó; 100 % promedia el temblor, simplifica y lo redondea sin
lazos. Los polígonos con huecos o bloqueados no se suavizan con este control
(sí con el pincel de Suavizar, N).

**Nodos compartidos (topología)**: si las líneas o polígonos que se suavizan
comparten nodos con otros —el borde común de dos polígonos, una línea que
termina en el vértice de otra, la isla que rellena el hueco de un polígono—, el
suavizado trabaja por **arcos** (el tramo entre dos nodos de unión): cada arco
compartido se suaviza **una sola vez** y todas las formas que lo usan lo reciben
idéntico, así que **no se abren huecos ni solapes** y los polígonos siguen
cerrados. Los nodos de unión no se mueven. Las formas vecinas que no estaban
seleccionadas se actualizan igual en el borde compartido (eso es lo que
mantiene el cierre); un arco compartido con una forma bloqueada, o en una capa
bloqueada, se deja como estaba. Vale para el control Suavizado y para el
pincel de Suavizar. La coincidencia de nodos usa la misma tolerancia que
Move Joined. El nivel se aplica desde la forma que tenían al seleccionarlas:
con nodos compartidos, volver a 0 % en un segundo movimiento del deslizador ya
no recupera la forma de antes del primero (sí Ctrl+Z). Las líneas con pocos
vértices muy separados se densifican (≈3 px) antes de suavizar, para que el
promedio no encoja un polígono de pocas esquinas.

### Borrar nodos

Con la herramienta Nodos (A), Supr / Retroceso borra el nodo activo y **elige
solo el vecino** (el siguiente; el anterior si no hay nada más allá en un
trazo abierto). Si se borra otra vez sin elegir otro, sigue en la misma
dirección: dos borrados seguidos dejan elegido el tercero, así se limpia un
tramo con Supr, Supr, Supr. Elegir otro nodo reinicia la dirección.

## Herramientas

| Tecla | Herramienta |
|---|---|
| V | Selección (mover, escalar con 8 manejadores, girar; Alt+arrastre duplica; Mayús restringe) |
| A | Nodos (mover nodos y manejadores Bézier, **doble clic en un nodo (PC) o doble toque (lápiz, dedo) cambia esquina ↔ curva**, también Alt+clic; doble clic sobre el trazo inserta un nodo) |
| Q | Lazo |
| P | Pluma / línea (clic = vértice, arrastre = curva; **las manijas Bézier se ven mientras se dibuja** —las del último nodo más vivas— y el tramo elástico ya sale curvo) |
| Y | Polígono |
| B | Lápiz (trazo libre simplificado y suavizado; cerrar cerca del inicio = polígono) |
| N | **Suavizar (pincel local)**, como en Illustrator: se pasa sobre un trazo (seleccionado o el que está bajo el puntero) y solo el sector bajo el pincel se promedia, se simplifica y se rehace con curvas, con transición suave en el borde del pincel; pasar de nuevo suaviza más. Intensidad y radio en la barra de propiedades; los extremos del trazo no se mueven; un solo paso de deshacer por pasada |
| J | **Drag**: como Nodos, pero se toma **un nodo** de una línea o polígono seleccionado y, al arrastrarlo, sus vecinos lo siguen **cada vez menos a lo largo del trazo**. Por defecto (alcance 100 %) el gradiente llega hasta los extremos de la línea, que quedan fijos, o hasta el punto opuesto de un polígono; con menos **alcance** (barra de propiedades, **[** y **]**) el movimiento es más localizado. A diferencia de Deform, que actúa por cercanía en el plano sin elegir nodo, aquí se elige el nodo y la influencia sigue el recorrido. Los nodos que otras formas comparten se arrastran igual: los de las seleccionadas siempre (Mayús + clic suma formas) y, con **Move Joined**, también los de las vecinas, sin abrir el cierre topológico. Con **Snap** activado, el nodo arrastrado se engancha (a menos de 12 px) al vértice más cercano de otra forma o de otra parte del trazo (cuadro rosado). Un solo deshacer por arrastre |
| G | **Deform**: en las líneas o polígonos seleccionados (o el que está bajo el puntero) se toma una zona con el ratón o el lápiz y se arrastra; los nodos se mueven **en gradiente** —todo el arrastre donde se tomó, cada vez menos hacia los vecinos, nada en el borde del círculo—. El **radio** del área de influencia se ajusta en la barra de propiedades o con **[** y **]**. Los tramos largos bajo el círculo se subdividen al empezar, así una línea de pocos nodos también se curva. Mientras se arrastra, flechas violeta muestran cuánto se movió cada nodo desde su posición original. Si varias formas seleccionadas comparten nodos se mueven juntas; con **Move Joined** también las vecinas no seleccionadas mueven (y subdividen) su borde común, sin abrir el cierre topológico. Un solo paso de deshacer por arrastre |
| \\ | Segmento · W Flecha · M Rectángulo · E Elipse (Mayús = proporcional, Alt = desde el centro) |
| T | Texto (el cuadro se abre al soltar; Enter termina, Mayús+Enter salto de línea) · O Punto (símbolo) · I Cuentagotas (toma el estilo completo del elemento tocado —color y **grosor de trazo**, tipo de línea, relleno, opacidad—, también dentro de un grupo, y lo aplica a la selección o, sin selección, a lo próximo que se dibuje) · H Mano |
| C | **Tijera**: corta una línea en dos o abre un polígono en el punto tocado |
| Z | **Zoom**: clic acerca, Alt+clic aleja, arrastre = zoom a un recuadro |
| K | **Trace**: al poner un vértice sobre una línea existente, la nueva sigue la geometría hasta ese punto (camino más corto, como en QGIS). **Inteligente**: reconoce el lado hacia el que se traza (sigue el sentido que llevaba desde el último vértice y solo cambia de lado si el otro cuesta menos de la tercera parte), no vuelve a pasar por un vértice ya puesto (salvo para cerrar el anillo) y recorre todos los nodos del camino. El grafo está **nodado**: se conecta donde los elementos comparten un vértice, donde un vértice cae sobre el borde de otro (un contacto que termina en el borde de un polígono) y donde se cruzan, y funde vértices que distan menos de ~0,4 px. **Alt** al poner el vértice toma el recorrido alterno (por el otro lado de un polígono); si no hay conexión avisa en vez de unir en recta; ⌫ quita de una vez todo un recorrido |
| S | Snapping a vértices y segmentos |
| 📐 | **Guías** (botón de la barra; activo por defecto): snap ligero de alineación, como las guías inteligentes de Illustrator. Al dibujar (pluma, polígono, segmento, rectángulo, elipse) o mover un nodo, el punto se alinea con el **nivel (y)** o la **vertical (x)** de cualquier otro vértice del dibujo —también los lejanos y los del borrador— si queda a menos de 6 px, y se dibuja la guía en magenta. No engancha al vértice: solo al eje; el snap duro a vértices y segmentos manda sobre la guía |
| 🔗 | **Move Joined** (botón de la barra, como Snap y Trace; activo por defecto): con la herramienta Nodos, al mover un vértice se mueven también los vértices coincidentes de otras líneas y polígonos (huecos incluidos) y no se engancha a ellos |

Atajos al estilo de **Illustrator** (la lista completa sale con **?** o F1, o
con el botón ⌨ de la barra superior):

- Ctrl/⌘: Z deshacer, Mayús+Z rehacer, C/X/V copiar/cortar/pegar, **F / B
  pegar en el lugar delante / detrás** (también Mayús+V), D duplicar, A
  seleccionar todo, **Mayús+A deseleccionar**, G agrupar, Mayús+G desagrupar,
  **J unir o cerrar trazos**, **7 máscara de recorte**, Alt+7 liberarla,
  ] adelante, [ atrás (con Mayús: al frente / al fondo), **2 bloquear** (Alt+2
  desbloquear todo), **3 ocultar** (Alt+3 mostrar todo), 0 zoom a todo,
  **1 escala de referencia**, +/− zoom, **L capa nueva**, S guardar, O abrir,
  P layout de impresión, F10 panel Estilo.
- Una tecla: **X** alterna relleno/trazo, **Mayús+X** los intercambia, **D**
  colores predeterminados, **/** ninguno, **Mayús+C** nodo esquina ↔ curva,
  **Tab** muestra u oculta el panel, F7 capas, Espacio = mano temporal,
  Alt+rueda = zoom.

**Barra de propiedades** (arriba del mapa, como el panel de control de
Illustrator): color y grosor del trazo, grosores frecuentes, tipo de línea,
relleno, opacidad y tamaño de letra de lo seleccionado —o de lo próximo que
se dibuje—, siempre a la vista. Los **cuadros de relleno y trazo** de la barra
de herramientas abren el selector de color directamente; debajo, botones de
predeterminado, intercambiar y ninguno.

**Texto legible a cualquier escala**: un texto nuevo nunca nace más chico de
lo que se lee en pantalla (16 px); si la vista está muy alejada de la escala
de referencia, el tamaño en pt sube a un valor redondo.

## Texto

Un texto es «de punto» (el ancla es el inicio, el centro o el final del
renglón) o «de área» (con **ancho de cuadro**: el texto se ajusta de línea al
ancho). Opciones: alineación izquierda, centro, derecha y **justificado**,
**interlineado**, **espaciado de letras** y de **palabras** (milésimas de em,
como el «tracking» de Illustrator), negrita, cursiva, rotación y halo. **Varios
espacios seguidos se respetan**. La caja de selección **sigue la orientación
del texto**: estirar una esquina cambia el tamaño de letra (con la esquina
opuesta fija), estirar el borde izquierdo o derecho cambia el ancho del cuadro
y el asa superior gira.

## Estilo

Grosor del trazo hasta **30 mm** (deslizador de escala cuadrática: fino hasta
1 mm y amplio después; el campo numérico y la barra de propiedades aceptan
cualquier valor).

La pestaña **Estilo** reúne trazo (primero, con colores rápidos), relleno y
degradados, halo de línea, puntas y opacidad. Lo propiamente geológico está
aparte, en la pestaña **Geología**: tipos de línea con certeza, ornamentos de
falla y pliegue, discordancia ondulada y tramas de litología.

- **Relleno** sólido, **degradado lineal o radial** (paradas, ángulo, opacidad por parada).
- **Trazo** continuo, **segmentado, punteado, punto y raya** o patrón propio (en
  múltiplos del grosor), extremos y esquinas, opacidad.
- **El borde crece solo hacia afuera.** En polígonos, el trazo se dibuja al
  doble del ancho y se recorta con una máscara par-impar que deja pasar solo
  lo que está fuera de la forma: engrosar el borde nunca tapa el relleno, ni
  siquiera si el relleno es transparente, y en los huecos crece hacia el hueco.
  También se puede alinear centrado o hacia adentro.
- **Halo del trazo** (casing), en la sección Trazo: en líneas y también en el
  borde de los polígonos (por fuera, por dentro o a cada lado según la
  alineación del borde), y se exporta a QGIS. En líneas abiertas: se agrega a cada lado, por
  debajo; el centro conserva el color del trazo. Si la línea es segmentada,
  cada raya tiene su halo. Ancho, color y opacidad editables.
- **Halo de texto externo**: un texto aparte por debajo con trazo grueso y el
  texto de relleno encima, así el halo solo asoma por fuera de las letras y
  nunca tapa el interior. Está hecho así (y no con `paint-order`) para que el
  PDF lo reproduzca igual. Vale también para las etiquetas de capa.
- **Línea ondulada (discordancia)**: forma «Ondulada» con amplitud y longitud
  de onda en mm; el halo, el trazo y las puntas la siguen.
- **Ornamentos de falla y pliegue**, con la geometría de FieldDraw: dientes
  (falla inversa / cabalgamiento), tic con bolita (normal), pares de medias
  flechas (dextral / sinestral) y flechas divergentes o convergentes
  (antiforme / sinforme). Tamaño, separación, lado (izquierda o derecha del
  sentido de digitalización, con botón «⇄»), distancia de las flechas a la
  traza, color propio y halo blanco por debajo. Botones de **tipos de línea
  geológicos** con los colores de FieldDraw y certeza (observada, inferida,
  cubierta).
- **Tramas de litología**: 35 rellenos clásicos —arenisca, conglomerado,
  brecha, lutita, caliza, dolomía, yeso, sal, carbón, granito, granodiorita,
  gabro, basalto, riolita, toba, gneis, esquisto, filita, cuarcita, mármol,
  aluvial, depósito glacial y rayados generales— agrupados por tipo de roca,
  con selector de miniaturas. El color de la unidad es el relleno y la trama va
  encima, con color, tamaño (mm) y opacidad propios. Salen en el PDF y en la
  leyenda.
- **Puntas de flecha** de inicio y fin (flecha, abierta, aguda, círculo, cuadrado, barra) y su tamaño.
- Opacidad y **modo de fusión** por objeto y por capa. **Tamaño de punto** de
  0,2 hasta 60 mm con deslizador (el campo numérico admite más).
- Grosores en **mm** y textos en **pt**, medidos en el papel a la **escala de
  referencia** del documento: lo que se ve a 1:25 000 es lo que se imprime.

## Capas

Una capa con **candado** está congelada: sus objetos no se pueden seleccionar,
mover, restilar, reordenar, agrupar, cortar, borrar ni clasificar por campo
(ni siquiera con «Seleccionar todo»), y no se les puede mover a otra capa.

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

## Topología

En *Organizar → Topología*, sobre la selección o la capa activa:

- **Confirmar topología** (el algoritmo de FieldDraw): los vértices a menos de
  la tolerancia se fusionan y los que caen sobre el borde de un vecino se
  insertan en él, así los polígonos contiguos comparten borde exacto.
- **Polígonos desde líneas**: dibuja contactos y fallas como líneas y obtén
  las unidades cerradas, sin huecos ni traslapes. Los extremos que casi se
  tocan se cierran con la tolerancia "Cerrar huecos".

Junto con el **trace** y el **snapping**, es el flujo de un mapa geológico:
contactos que se siguen unos a otros y unidades que salen de ellos.

## Simbología por campo de atributos

En *Estilo → Objeto → Simbología por campo*: como el renderizador de QGIS,
pinta cada objeto de la capa según el valor de un campo.

- **Categorizado**: un color por valor distinto (hasta 200), con los vacíos como
  «(vacío)».
- **Graduado**: clases numéricas por cuantiles, intervalos iguales, cortes
  redondos o cortes naturales (Jenks), de 2 a 30 clases.
- 13 rampas (cualitativas: geológica, pareada, categórica, contraste;
  degradadas: viridis, magma, espectral, rojo-amarillo-verde, azules, verdes,
  naranjas, rojos, hipsométrica), invertibles.
- Aplicar a relleno, trazo o ambos (o automático: relleno en polígonos y puntos,
  trazo en líneas). Cada clase se puede recolorear y renombrar en la tabla, que
  muestra cuántos objetos tiene. También sirven `$nombre` y `$tipo` como campo.
- La leyenda del layout usa los rótulos de clase y su orden; al exportar a QGIS
  (GeoPackage, .qlr) sale como un renderizador Categorizado o Graduado
  **sobre el campo**, con el símbolo real de cada clase.

## Etiquetas

Por capa: un **campo**, **varios campos combinados** (se eligen en una lista,
con separador —espacio, guion, coma, barra, paréntesis «a (b, c)»— y los vacíos
se omiten sin dejar separadores sueltos) o una **plantilla**
(`{codigo} ({edad:1} Ma)`: `{campo:2}` fija decimales, `{campo|upper}` /
`lower` / `title` cambia las mayúsculas y `{codigo||nombre}` usa el segundo si
el primero está vacío), con vista previa en vivo; a QGIS pasa como expresión.
Además fuente,
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

Pestaña **Layout**, interactiva: en la vista previa se **arrastra dentro del
marco para mover el mapa**, la **rueda hace zoom** y los **ocho vértices del
marco** cambian su tamaño (el mapa no se desplaza respecto de la hoja: el marco
recorta o descubre más terreno). Título, leyenda, norte, escala y datos se
**mueven arrastrándolos** (flechas: 0,5 mm; con Mayús, 5 mm) y se **eliminan**
con Supr o con la ✕ roja de su selección (se reactivan en el panel). El botón
**Encuadrar capas vectoriales** ajusta centro y escala (redondeada) para que
quepa todo lo dibujado en capas vectoriales visibles —no rasters ni mapas en
línea—. «Marco y elementos automáticos» devuelve todo a su lugar.

**Resolución del relieve en la vista previa**: antes la vista previa se
calculaba fija a 72 dpi —menos que los 96 de la pantalla de trabajo, y la
página se amplía para llenar el área— y se forzaba la resolución de la capa a
×1, de modo que el relieve se veía mucho más borroso que en la vista de capas.
Ahora la vista previa sigue a la pantalla (los píxeles que ocupa la página por
la densidad de píxeles del equipo, entre 96 y 400 dpi; también se fija a mano en
Exportar → Vista previa, hasta 600 dpi; la resolución de la capa de relieve llega a ×4 y la exportación a 800 dpi, con imágenes de hasta 9 000 px por lado) y respeta la resolución de la capa. A escalas
pequeñas el relieve tiene menos detalle por naturaleza: el mismo número de
píxeles cubre más terreno, y Terrarium parte de ~30 m en tierra.

**Mover y escalar en el layout**: en la vista de layout, un clic sobre un objeto vectorial del mapa (Mayús suma más) lo selecciona; arrástralo para moverlo, o arrastra el cuadrito de su esquina inferior derecha para escalarlo (proporcional, con la esquina superior izquierda fija). Las flechas lo desplazan y Supr lo elimina. Esto modifica la geometría real del dibujo (se puede deshacer con Ctrl+Z). Los elementos propios de la lámina (título, leyenda, norte, escalas, datos, cuadros de texto) también se mueven y se escalan con su cuadrito.

**Relieve en caché**: en la vista principal el relieve sombreado se calcula una sola vez y se reutiliza: mover o hacer zoom solo desplaza y escala esa imagen, sin recalcular (así el paneo es fluido). El botón **↻ Redraw** de la barra superior (visible cuando hay un relieve) lo recalcula para la vista actual; se pone ámbar cuando la imagen en caché ya no cubre la vista o está a otra escala. Cambiar los ajustes de la capa también lo recalcula.

**Bloquear elementos del layout**: cada elemento seleccionado tiene un candado en su esquina superior izquierda; bloqueado no se mueve, escala ni borra, y arrastrar sobre él dentro del marco mueve el mapa. «Bloquear posición y tamaño de todos los elementos» (panel Layout) lo aplica a todos.

**Exportación más rápida**: las imágenes raster de la lámina (relieve, mapa base, imágenes) se guardan en caché por marco y resolución, así que mover elementos o exportar otra vez a SVG/PDF/PNG no recalcula nada; se codifican en paralelo y sin bloquear la interfaz, y un mapa base sin transparencia se guarda como JPEG (mucho más liviano y rápido que PNG).

**Imágenes en la vista normal**: con la herramienta Seleccionar, una capa de imagen raster **desbloqueada** (candado en la pestaña Capas; las capas raster nuevas vienen bloqueadas) se selecciona con un clic sobre ella, se arrastra para moverla y el cuadrito de su esquina inferior derecha la reescala (esquina superior izquierda fija). Es la misma posición que se usa en el layout y se deshace con Ctrl+Z. Una imagen que cubre toda la pantalla estorba al rectángulo de selección: vuelve a bloquearla cuando termines de ubicarla.

**Imágenes pegadas en el layout**: un clic sobre una imagen (capa de imagen que no cubra todo el marco) la selecciona; se arrastra para moverla y el cuadrito de su esquina inferior derecha la reescala. La posición se guarda en la capa (se deshace con Ctrl+Z).

**Escalas**: la escala gráfica (barra) y la numérica («Escala 1:25.000») son dos elementos independientes; cada uno puede llevar un fondo sólido del color que elijas (panel Layout → Elementos).

**Varios objetos a la vez**: con varios objetos seleccionados, trazo, grosor, relleno, opacidad, halo y demás del panel Estilo se aplican a todos; si hay textos, aparece además una sección con fuente, tamaño, negrita/cursiva y halo de texto para todos.

**Cuadros de texto del layout**: «T Cuadro de texto» en la barra de la vista
previa, clic en la hoja y se escribe encima (doble clic para volver a editar;
Ctrl+Enter termina). Se mueven y eliminan como los demás elementos y tienen
todas las opciones de texto. «Añadir a una capa del mapa» los pasa a una capa
vectorial desbloqueada en la coordenada del terreno que queda bajo ellos, con
el tamaño que los deja iguales a esa escala (copia, o pasar quitándolo del
layout).

**Estilos de layout**: «Guardar como estilo…» guarda con nombre la página, la
grilla, los elementos y su posición, el marco, el tamaño de símbolos y los
cuadros de texto (no la escala, el centro ni el título, autor, fecha y notas);
«Aplicar» lo pone en otro layout; se exportan e importan como
`.gdlayout.json`. Se guardan en el navegador.

**Tamaño de símbolos y textos** armonizado con la escala
de la lámina (los tamaños del estilo están medidos a la escala de referencia
del dibujo; en «Automático» se escalan por la raíz de la razón de escalas,
acotada a ×0,5–×2, para que pasar a otra escala no los cambie de golpe; hay
también «fijo en papel», «como en pantalla» y factor manual, y un botón para
adoptar la escala de la lámina como escala de referencia). Página A4–A0, carta u oficio, horizontal o vertical,
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
| GeoPackage | todas las tablas de features, cualquier sistema (EPSG o WKT), atributos, **estilo QGIS embebido** | una tabla por capa y tipo de geometría, EPSG:32719, atributos, **QML con la simbología del dibujo** y el estilo completo en `gd_style_json` |
| QML / QLR (QGIS) | símbolo único, categorizado, graduado y por reglas; símbolos de varias capas (relleno + contorno, línea con borde, flechas, degradados, marcadores); etiquetado simple | dentro del GeoPackage; **.qlr + GeoPackage** (Archivo → Exportar → Simbología QGIS); .qml de la capa activa |
| GeoJSON | WGS84 o con `crs` | WGS84 (RFC 7946) o UTM 19S |
| GeoTIFF | elevación (una banda) o imagen RGB(A), en su sistema | relieve calculado, imagen georreferenciada |
| **SVG / Illustrator** | **archivo .ai nativo**, como proyecto nuevo (una capa por capa de Illustrator, imágenes incrustadas como capas de imagen, las ocultas llegan ocultas), **PDF vectorial**, archivo .svg (una capa por capa de primer nivel) y **pegar con Ctrl+V** lo copiado en Illustrator | **lámina con un grupo por capa** (.svg) y **script de Illustrator (.jsx) que crea una capa real por capa**; copiar (Ctrl+C) deja SVG en puntos para pegar en Illustrator |
| **FieldDraw** | proyecto `.fdproj.json`, paquete `.fdproj.zip` o GeoJSON exportado, con simbología y georreferencia | — |
| ASCII grid | elevación | — |
| Proyecto `.gisdrawer` | sí, con sus imágenes y modelos de elevación incrustados | sí, **autocontenido**: lleva incrustados (base64) los archivos raster de sus capas (imágenes pegadas, GeoTIFF, mapas georreferenciados, DEM); además se guarda solo en el navegador |
| **Google Drive** | cualquiera de los anteriores, elegido en Drive (Archivo → Importar → Desde Google Drive) | — |

**Proyectos recientes**: la app guarda sola, en el navegador, la última
versión de los **últimos 10 proyectos** (abiertos, guardados o en los que se
trabajó). **Archivo → Abrir reciente…** los lista (nombre, fecha, origen y
cantidad de objetos) y abre el elegido; la ✕ lo quita de la lista. Al abrir la
app se abre **el último proyecto en el que se trabajó**, con sus imágenes.
«Nuevo» deja el actual en la lista.

**Google Drive**: la primera vez que se guarda un proyecto en Drive (o con
«Guardar en Google Drive en otra carpeta…») se **elige la carpeta** —el
selector se abre en la última usada, con pestañas «Mi unidad» y unidades
compartidas— y el nombre; después «Guardar en Google Drive» actualiza ese
mismo archivo. Para que sea rápido, las imágenes y modelos de elevación **se
suben una sola vez**, como archivos binarios (sin base64) en una carpeta
«… – imágenes (GISDrawer)» junto al proyecto, y cada guardado sube solo el
dibujo con sus referencias (suele ser poco). Al abrir el proyecto desde Drive en
otro equipo, las imágenes que no estén ahí se bajan solas. Guardar en archivo
(.gisdrawer) sigue incrustándolo todo.

**Proyecto autocontenido**: las imágenes y los modelos de elevación viven en el
almacenamiento del navegador donde se importaron, no en el dibujo. Por eso
**Archivo → Guardar proyecto (.gisdrawer)** y **Guardar en Google Drive** los
incrustan dentro del mismo archivo (el peso del archivo crece con ellos; un
mensaje dice cuántos y cuánto pesan). Al abrirlo en otro navegador u otro
computador las imágenes aparecen y quedan guardadas ahí para la próxima vez.
Si algún archivo no se encuentra (p. ej. una capa cuya importación falló), se
avisa al guardar: esa capa quedaría vacía en otro equipo. Los proyectos
guardados antes de la v28 no llevan imágenes: ábrelos en el navegador donde
se hicieron y guárdalos de nuevo.

**Simbología en QGIS (.qlr)**: se descargan `dibujo.qlr` y `dibujo.gpkg`.
Con los dos en la misma carpeta, arrastrar el `.qlr` a QGIS (o Capa → Añadir
desde archivo de definición de capa) carga todas las capas en un grupo, en el
orden del dibujo, en EPSG:32719, con su simbología categorizada por estilo
(con rótulos de leyenda legibles: el nombre de los objetos o el tipo de falla
o trama), sus etiquetas, y los textos del dibujo como etiquetas del campo
`gd_text`.

**Discordancia en el QML**: la línea ondulada sale como un `MarkerLine` que
repite un ciclo de la onda (SVG incrustado, con su halo) cada longitud de
onda, en la misma fase que la dibuja GISDrawer. Al leer un QML, GISDrawer
reconoce sus propias ondas y ornamentos y los recupera como estilo editable.

**Ornamentos y tramas en el QML**: los ornamentos de falla y pliegue salen
como una capa de símbolo `MarkerLine` (se repite a lo largo de la traza, girado
con ella y desde media separación, como en GISDrawer) con un `SvgMarker` que
lleva la misma geometría del dibujo —dientes, tic con bolita, medias flechas,
flechas de pliegue, con su halo y el lado izquierdo/derecho— incrustado en el
propio QML (`base64:`), sin archivos aparte. Las tramas de litología salen
como un `SVGFill` sobre el relleno de color, con su color, opacidad y tamaño
(mm). Todo se puede seguir editando en QGIS.

**Pegar un recorte (Ctrl+V)**: una captura de pantalla o una imagen copiada se
pega como imagen: se ofrece georreferenciarla de inmediato con puntos de
control, o colocarla en la vista como capa de imagen. Un SVG (Illustrator,
Inkscape) se pega como dibujo.

**Illustrator, ida y vuelta**:

- *Abrir un .ai*: Archivo → Importar → «Illustrator (.ai, .svg) / PDF
  vectorial». Un .ai o un PDF **se abre como proyecto nuevo** (Ctrl+Z vuelve
  al anterior), con el mapa base oculto porque la figura no está
  georreferenciada. Se lee la copia PDF que Illustrator guarda dentro del .ai
  (opción «Crear archivo compatible con PDF» del cuadro Guardar como, activada
  por omisión): cada capa de Illustrator es una capa de GISDrawer con su
  nombre, con trazados Bézier, rellenos (también par-impar y con huecos),
  trazos, segmentados, transparencias, máscaras de recorte, degradados,
  colores CMYK y de tinta plana (Pantone) y textos con su fuente, tamaño,
  negrita y acentos. **Las imágenes incrustadas** (relieves, fotos, rásters
  colocados con «Incrustar»; RGB, CMYK, gris, paleta o JPEG, con su
  transparencia, giradas o volteadas como en la página) llegan como capas de
  imagen con su nombre de capa, debajo de las capas vectoriales y en su
  lugar. Las capas ocultas en Illustrator llegan ocultas. Las imágenes
  **vinculadas** que no se incrustaron no viajan dentro del .ai: en
  Illustrator, panel Vínculos → «Incrustar imagen» antes de guardar. No se
  importan las máscaras de opacidad, las imágenes JPEG 2000 ni los .ai
  antiguos (Illustrator 8 o anterior, PostScript); si el .ai se guardó sin la
  opción de compatibilidad con PDF, la app lo avisa. De un PDF de varias
  páginas (o varias mesas de trabajo) se importa la primera.
- *Velocidad*: el .ai / PDF se lee en un hilo aparte (la interfaz no se
  congela) y las formas vuelven empaquetadas; el descompresor, el lector de
  trazados, la búsqueda de objetos y la lectura de imágenes están optimizados.
  En pruebas, un .ai de 11 MB con 3 imágenes pasó de 0,8 s a 0,4 s hasta verse,
  y un PDF vectorial de 13 MB con 41 000 trazos de 5,6 s a 3,9 s, con el
  mayor congelamiento de la interfaz de 9 s a 2 s. Un SVG de 15 MB con 38 000
  trazos, de 2,1 s a 1,6 s. Las imágenes grandes se guardan en segundo plano.
- *Pegar en GISDrawer lo copiado en Illustrator*: en Illustrator,
  Preferencias → Gestión del portapapeles → «Copiar como: código SVG».
  Ctrl+V en GISDrawer lo convierte en dibujo editable con nodos Bézier,
  rellenos y trazos (también por clases CSS), grosores, segmentados, extremos
  y esquinas, opacidades, degradados, polígonos con huecos, grupos, máscaras
  de recorte y textos (fuente, tamaño, negrita, cursiva, rotación, varias
  líneas). Las medidas se conservan en el papel: 1 pt de Illustrator es 1 pt
  a la escala de referencia, y el dibujo cae centrado en la vista.
- *Copiar en GISDrawer y pegar en Illustrator*: Ctrl+C deja en el
  portapapeles un SVG en puntos con la simbología ya dibujada (ornamentos,
  tramas, halos, ondas). Si se vuelve a pegar en GISDrawer, vuelve exacto y
  en su lugar georreferenciado (lleva las formas originales dentro).
- *Exportar con capas*: Layout → «Illustrator con capas (.jsx)». En
  Illustrator, Archivo → Scripts → Otro script… y elegir el archivo: crea un
  documento del tamaño de la lámina con una capa de Illustrator por cada capa
  del mapa (con su nombre, opacidad, modo de fusión y bloqueo) más
  Etiquetas, Grilla y coordenadas, Marco, Título, Leyenda, Norte, Escala y
  Datos. El SVG de la lámina también trae un grupo con `id` y `data-name`
  por capa, como los escribe Illustrator.

**Google Drive**: Archivo → Importar → Desde Google Drive baja un archivo de
Drive y lo importa según su extensión (.ai, .pdf, .svg, .gpkg, .geojson,
.tif, .asc, .jpg/.png para georreferenciar, .qml/.qlr, FieldDraw o
.gisdrawer). Se configura una vez en Archivo → Configurar Google Drive, con
credenciales propias de un proyecto de Google Cloud (la app es estática y no
trae claves):

1. En [console.cloud.google.com](https://console.cloud.google.com), crear un
   proyecto y activar **Google Drive API** y **Google Picker API**.
2. Credenciales → **Clave de API**. Con solo la clave se pueden abrir
   archivos compartidos con «cualquier persona con el enlace»: se pega el
   enlace del archivo.
3. Para elegir archivos de la propia cuenta con el selector de Google:
   Credenciales → **ID de cliente de OAuth**, tipo «Aplicación web», con el
   origen de la app (p. ej. `https://usuario.github.io`) en «Orígenes de
   JavaScript autorizados», y configurar la pantalla de consentimiento. La
   app pide solo el permiso `drive.file`: ve únicamente los archivos que se
   eligen en el selector.

**FieldDraw**: Archivo → Importar → Proyecto FieldDraw. Crea las capas
Unidades, Trazas, Medidas y Puntos de control, en UTM 19S, con los colores y
grosores de FieldDraw (los que el usuario cambió en su módulo de simbología
incluidos), la certeza como segmentado, el halo blanco, los ornamentos con su
tamaño, separación y lado (el «flip» de cada falla), las unidades con su color
y código (etiquetadas por código) y las medidas de rumbo y manteo con su
símbolo orientado al norte verdadero. Todas las propiedades quedan como
atributos.

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
| `src/style.js` | estilo → SVG: borde hacia afuera, halos, segmentados, ondulado, degradados, flechas, tramas |
| `src/ornaments.js` | ornamentos de falla y pliegue (geometría de FieldDraw) |
| `src/patterns.js` | catálogo de tramas de litología |
| `src/doc.js` | documento, capas, historial (deshacer por referencias) |
| `src/editor.js` | herramientas, entrada lápiz/dedo/ratón, snapping, trace |
| `src/snapping.js` | índice espacial y camino más corto (de FieldDraw) |
| `src/topology.js`, `src/topoOps.js` | confirmación topológica (de FieldDraw) y polígonos desde líneas (JSTS) |
| `src/ops.js` | portapapeles, orden, alinear, distribuir, máscara, seleccionar lo mismo |
| `src/labels.js` | etiquetado con colisiones y polo de inaccesibilidad |
| `src/raster/` | mapas base, DEM, relieve sombreado y paletas |
| `src/georef.js` | transformaciones de georreferenciación y remuestreo |
| `src/layout/compose.js` | la lámina en SVG (mm) |
| `src/io/` | GeoPackage, QML, GeoJSON, GeoTIFF, sistemas de coordenadas, almacenamiento |
| `src/ui/` | paneles, georreferenciación, layout, iconos |
| `icons/logo.svg` | logo de la app (curvas de nivel, unidad con trama, falla con dientes y plumilla) |

## Pendiente

- Edición topológica en vivo (mover un vértice compartido y que se muevan
  los dos polígonos); hoy se confirma después con «Confirmar topología».
- No se ha probado la simbología exportada en todas las versiones de QGIS ni
  el script de Illustrator en todas las versiones de Illustrator: si algo no
  aparece, avisar con la versión.
- Pegar desde Illustrator necesita que Illustrator copie como código SVG (ver
  abajo); los rellenos de motivo (pattern) de Illustrator llegan como gris.
- El contorno "hacia afuera" se exporta a QGIS como línea desplazada medio
  grosor; conviene comprobar el sentido del desplazamiento en QGIS con anillos
  de orientación mixta.
- Declinación magnética en el layout (requiere el modelo WMM).

## Texto con formato por tramos

Al editar un texto (doble clic en el mapa o en un cuadro del layout) aparece una barra: selecciona parte de las letras y cambia su **color**, **tamaño (pt)**, **negrita** o **cursiva** sin afectar el resto (`Aa` quita el formato). Sin selección afecta a todo el texto. El formato se guarda en `shape.runs` (`{s,e,color,scale,bold,italic}`), sale como `<tspan>` en SVG/Illustrator y se conserva al pasar un texto del layout a una capa.

## Portapapeles

- **Ctrl+C / Ctrl+X / Ctrl+V** funcionan dentro de la app (conservan formato, tramos de texto y grupos; cada pegado sucesivo se desplaza un poco más) y con el sistema: lo copiado se deja como SVG (Illustrator lo pega editable).
- **Pegar SVG** de Illustrator: un texto con varios estilos (color, tamaño, negrita, cursiva) entra como un solo texto con tramos.
- **Pegar imágenes** (recortes de pantalla, imágenes copiadas de un navegador o documento, `<img>` con datos incrustados): entran como capa de imagen en el centro de la vista, sin diálogos; luego se pueden georreferenciar desde Archivo. Los botones Pegar del menú también leen imágenes del portapapeles.
