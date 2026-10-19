/**
 * Persistencia local: el documento se guarda solo (IndexedDB) y los archivos
 * importados pesados —GeoTIFF de elevación o imágenes— se guardan aparte, por
 * id, para no reescribir megas en cada guardado del dibujo.
 */

const DB = 'gisdrawer';
const VERSION = 1;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs');
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(store, mode, f) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = f(s);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const saveDoc = (doc) => tx('docs', 'readwrite', (s) => s.put(doc, 'current')).catch(() => null);
export const loadDoc = () => tx('docs', 'readonly', (s) => s.get('current')).catch(() => null);
export const saveFile = (id, rec) => tx('files', 'readwrite', (s) => s.put(rec, id)).catch(() => null);
export const loadFile = (id) => tx('files', 'readonly', (s) => s.get(id)).catch(() => null);
export const deleteFile = (id) => tx('files', 'readwrite', (s) => s.delete(id)).catch(() => null);
/** Otros registros del almacén de documentos (proyectos recientes). */
export const putDocKey = (key, value) => tx('docs', 'readwrite', (s) => s.put(value, key)).catch(() => null);
export const getDocKey = (key) => tx('docs', 'readonly', (s) => s.get(key)).catch(() => null);
export const deleteDocKey = (key) => tx('docs', 'readwrite', (s) => s.delete(key)).catch(() => null);

/** Descarga un Blob o texto como archivo. */
export function download(data, filename, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** Abre el selector de archivos y devuelve los File elegidos. */
export function pickFiles(accept, multiple = false) {
  return new Promise((resolve) => {
    const input = document.getElementById('file-input');
    input.accept = accept;
    input.multiple = multiple;
    input.value = '';
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}
