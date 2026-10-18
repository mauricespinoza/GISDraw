/**
 * Service worker de GISDrawer: la app abre sin señal.
 *
 * - App shell (PRECACHE): HTML, módulos, CSS, iconos y vendor/. RED PRIMERO
 *   (revalidando, con 3 s de espera) y caché como respaldo sin señal: con
 *   conexión siempre se ve la última versión publicada; sin ella, la guardada.
 *   (Antes era caché primero: tras publicar había que abrir dos veces la app
 *   para ver los cambios.) Subir `VERSION` (y src/version.js) al publicar.
 * - Teselas (TILES): mapas base y DEM Terrarium ya vistos, con tope.
 */

const VERSION = 'v19';
const PRECACHE = `gisdrawer-shell-${VERSION}`;
const TILES = 'gisdrawer-tiles';
const TILE_LIMIT = 5000;

const SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/favicon.svg',
  './icons/logo.svg',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './src/doc.js',
  './src/editor.js',
  './src/geom.js',
  './src/georef.js',
  './src/hit.js',
  './src/io/crs.js',
  './src/io/fielddraw.js',
  './src/io/illustrator.js',
  './src/io/svgImport.js',
  './src/io/features.js',
  './src/io/geojson.js',
  './src/io/gdrive.js',
  './src/io/geotiff.js',
  './src/io/gpkg.js',
  './src/io/loader.js',
  './src/io/pdfImport.js',
  './src/io/qml.js',
  './src/io/store.js',
  './src/io/wkb.js',
  './src/labels.js',
  './src/layout/compose.js',
  './src/layout/styles.js',
  './src/main.js',
  './src/ops.js',
  './src/ornaments.js',
  './src/patterns.js',
  './src/proj.js',
  './src/raster/basemap.js',
  './src/raster/dem.js',
  './src/raster/hillshade.js',
  './src/raster/rasterView.js',
  './src/render.js',
  './src/snapping.js',
  './src/symbology.js',
  './src/textLayout.js',
  './src/richText.js',
  './src/ui/richEditor.js',
  './src/style.js',
  './src/topoOps.js',
  './src/topoRings.js',
  './src/topology.js',
  './src/ui/dom.js',
  './src/ui/georefSession.js',
  './src/ui/icons.js',
  './src/ui/layoutEditor.js',
  './src/ui/panels.js',
  './src/vector.js',
  './src/version.js',
  './src/view.js',
  './vendor/geotiff.js',
  './vendor/jspdf.umd.min.js',
  './vendor/jsts.min.js',
  './vendor/proj4.js',
  './vendor/sql-wasm.js',
  './vendor/sql-wasm.wasm',
  './vendor/svg2pdf.umd.min.js',
];

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
  'server.arcgisonline.com',
  'basemaps.cartocdn.com',
  's3.amazonaws.com',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(PRECACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('gisdrawer-shell-') && k !== PRECACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const isTile = (url) => TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith(`.${h}`));

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  for (const k of keys.slice(0, Math.max(0, keys.length - TILE_LIMIT))) await cache.delete(k);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match('./index.html')) || Response.error()));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(PRECACHE);
        const net = fetch(request, { cache: 'no-cache' })
          .then((res) => {
            if (res.ok) cache.put(request, res.clone());
            return res;
          })
          .catch(() => null);
        event.waitUntil(net);
        const hit = await cache.match(request, { ignoreSearch: true });
        // con una copia guardada, no esperar más de 3 s a una red lenta
        const res = hit ? await Promise.race([net, new Promise((r) => setTimeout(() => r(null), 3000))]) : await net;
        return res || hit || new Response('Sin conexión', { status: 504 });
      })(),
    );
    return;
  }

  if (isTile(url)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(TILES);
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        if (res.ok || res.type === 'opaque') {
          await cache.put(request, res.clone());
          event.waitUntil(trimTiles());
        }
        return res;
      })(),
    );
  }
});
