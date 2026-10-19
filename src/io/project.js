/**
 * Proyecto .gisdrawer autocontenido: además del dibujo lleva, incrustados en
 * base64, los archivos raster que usan sus capas (imágenes pegadas, GeoTIFF,
 * mapas georreferenciados, modelos de elevación). Así el proyecto se abre
 * igual en otro navegador u otro computador: esos archivos viven en
 * IndexedDB del navegador donde se importaron y, sin esto, no viajarían.
 *
 * Formato: el JSON de siempre más `files: { <id>: { …registro, buffer64 } }`.
 * Un proyecto sin `files` (versiones anteriores) se abre como siempre.
 */

const CHUNK = 0x8000;

/** ArrayBuffer / vista → base64. */
export function toBase64(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ? buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) : buf);
  let s = '';
  for (let i = 0; i < u8.length; i += CHUNK) s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  return btoa(s);
}

/** base64 → ArrayBuffer. */
export function fromBase64(b64) {
  const s = atob(b64);
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8.buffer;
}

/** Ids de los archivos que usan las capas (una vez cada uno) y la capa que los usa. */
export function referencedFiles(doc) {
  const out = new Map();
  for (const l of doc.layers || []) {
    const id = l.settings?.fileId;
    if (id && !out.has(id)) out.set(id, l.name);
  }
  return out;
}

/**
 * Serializa el proyecto con sus archivos. `getRec(id)` devuelve el registro
 * `{ kind, name, buffer, … }` del archivo (o null si no se encuentra).
 * @returns {Promise<{ blob: Blob, count: number, bytes: number, missing: string[] }>} `missing`: capas cuyo archivo no se pudo incrustar.
 */
export async function packProject(doc, getRec) {
  const head = JSON.stringify({ app: 'GISDrawer', ...doc, driveFileId: undefined, files: undefined });
  const parts = [head.slice(0, -1), ',"files":{'];
  const missing = [];
  let count = 0;
  let bytes = 0;
  for (const [id, layerName] of referencedFiles(doc)) {
    let rec = null;
    try {
      rec = await getRec(id);
    } catch {
      rec = null;
    }
    if (!rec?.buffer) {
      missing.push(layerName);
      continue;
    }
    const { buffer, ...meta } = rec;
    bytes += buffer.byteLength;
    parts.push(`${count ? ',' : ''}${JSON.stringify(id)}:${JSON.stringify({ ...meta, buffer64: toBase64(buffer) })}`);
    count++;
  }
  parts.push('}}');
  return { blob: new Blob(parts, { type: 'application/json' }), count, bytes, missing };
}

/**
 * Saca los archivos incrustados de un proyecto leído (`raw.files`), los
 * devuelve como registros listos para guardar en IndexedDB y deja `raw` sin
 * ellos. @returns {Map<string, object>} id → registro
 */
export function unpackFiles(raw) {
  const out = new Map();
  for (const [id, rec] of Object.entries(raw.files || {})) {
    const { buffer64, ...meta } = rec || {};
    if (typeof buffer64 === 'string') out.set(id, { ...meta, buffer: fromBase64(buffer64) });
  }
  delete raw.files;
  return out;
}
