/**
 * Carga de librerías de `vendor/` bajo demanda. Las rutas son relativas a la
 * página, así la app funciona igual en la raíz de un dominio o en un
 * subdirectorio de GitHub Pages, y sin red (las guarda el service worker).
 */

const loading = new Map();

export function vendorUrl(path) {
  return new URL(path, document.baseURI).href;
}

export function loadScript(path) {
  if (!loading.has(path)) {
    loading.set(
      path,
      new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = vendorUrl(path);
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`No se pudo cargar ${path}`));
        document.head.appendChild(s);
      }),
    );
  }
  return loading.get(path);
}

export async function loadSql() {
  await loadScript('vendor/sql-wasm.js');
  if (!globalThis.initSqlJs) throw new Error('sql.js no se cargó');
  return globalThis.initSqlJs({ locateFile: (f) => vendorUrl(`vendor/${f}`) });
}

export async function loadGeoTIFF() {
  await loadScript('vendor/geotiff.js');
  if (!globalThis.GeoTIFF) throw new Error('geotiff.js no se cargó');
  return globalThis.GeoTIFF;
}
