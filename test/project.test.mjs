/**
 * Proyecto .gisdrawer autocontenido: las imágenes y modelos de elevación
 * viajan incrustados y se recuperan idénticos al abrirlo en otro equipo.
 *
 *   node test/project.test.mjs
 */

import { fromBase64, packProject, referencedFiles, toBase64, unpackFiles } from '../src/io/project.js';
import { makeRasterLayer, makeVectorLayer, newDocument, addLayer, normalizeDoc } from '../src/doc.js';

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    console.error('✗', msg);
  }
}
const same = (a, b) => a.byteLength === b.byteLength && new Uint8Array(a).every((v, i) => v === new Uint8Array(b)[i]);

// base64 sin pérdida, también con tamaños que no son múltiplo de 3 ni de los trozos
for (const n of [0, 1, 2, 3, 100, 0x8000, 0x8001, 200003]) {
  const u8 = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
  ok(same(fromBase64(toBase64(u8)), u8.buffer), `base64 de ${n} bytes`);
}

// un «equipo A»: documento con imagen, GeoTIFF y relieve que apuntan a archivos
let doc = newDocument();
doc = addLayer(doc, makeVectorLayer('Geología'), doc.activeLayerId);
const img = makeRasterLayer('image', 'Mapa escaneado', { fileId: 'Fimg' });
const dem = makeRasterLayer('hillshade', 'Relieve', { source: 'file', fileId: 'Fdem', fileName: 'dem.tif' });
const dup = makeRasterLayer('image', 'Mismo archivo', { fileId: 'Fimg' });
const gone = makeRasterLayer('image', 'Perdida', { fileId: 'Fgone' });
doc = { ...doc, layers: [img, dem, dup, gone, ...doc.layers], driveFileId: 'abc' };

const png = new Uint8Array(70000).map((_, i) => (i * 17 + 3) & 255).buffer;
const tif = new Uint8Array(1234).map((_, i) => (i * 5) & 255).buffer;
const store = {
  Fimg: { kind: 'image', name: 'mapa.png', format: 'bitmap', mime: 'image/png', buffer: png, bounds: [1, 2, 3, 4] },
  Fdem: { kind: 'dem', name: 'dem.tif', format: 'tif', epsg: 32719, buffer: tif },
};
ok([...referencedFiles(doc).keys()].join() === 'Fimg,Fdem,Fgone', 'archivos referenciados, sin repetir');

const packed = await packProject(doc, async (id) => store[id] || null);
ok(packed.count === 2 && packed.bytes === png.byteLength + tif.byteLength, 'incrusta los dos archivos (el repetido una vez)');
ok(packed.missing.join() === 'Perdida', 'avisa de la capa cuyo archivo no está');

// «equipo B»: se lee el archivo y se reconstruye todo
const raw = JSON.parse(await packed.blob.text());
ok(raw.app === 'GISDrawer' && raw.driveFileId === undefined, 'cabecera del proyecto, sin el id de Drive');
ok(raw.layers.length === doc.layers.length && raw.files.Fimg.buffer64 && !raw.files.Fimg.buffer, 'el JSON lleva los archivos en base64');
const files = unpackFiles(raw);
ok(raw.files === undefined, 'el documento queda sin los archivos');
ok(files.size === 2 && same(files.get('Fimg').buffer, png) && same(files.get('Fdem').buffer, tif), 'los archivos salen idénticos byte a byte');
ok(files.get('Fimg').mime === 'image/png' && files.get('Fimg').bounds.join() === '1,2,3,4' && files.get('Fdem').epsg === 32719 && files.get('Fdem').format === 'tif', 'conservan sus metadatos (límites, EPSG, formato)');
const reopened = normalizeDoc(raw);
ok(reopened.layers.find((l) => l.name === 'Mapa escaneado').settings.fileId === 'Fimg', 'las capas siguen apuntando a su archivo');

// proyectos anteriores (sin archivos) y sin capas raster
const old = JSON.parse(JSON.stringify({ app: 'GISDrawer', ...newDocument() }));
ok(unpackFiles(old).size === 0, 'un proyecto sin archivos incrustados se abre como siempre');
const empty = await packProject(newDocument(), async () => null);
ok(empty.count === 0 && JSON.parse(await empty.blob.text()).files && Object.keys(JSON.parse(await empty.blob.text()).files).length === 0, 'sin capas raster: files vacío y JSON válido');

// un registro que falla al leerse no rompe el guardado
const bad = await packProject(doc, async () => {
  throw new Error('IndexedDB no disponible');
});
ok(bad.count === 0 && bad.missing.length === 3, 'si el almacén falla, se avisa en vez de romper');

// Google Drive: los archivos ya subidos van solo como referencia (no se leen ni se codifican)
{
  let reads = 0;
  const linked = { Fimg: { kind: 'image', name: 'mapa.png', mime: 'image/png', bounds: [1, 2, 3, 4], driveId: 'drv123' } };
  const r = await packProject(doc, async (id) => (reads++, store[id] || null), { linked });
  const raw2 = JSON.parse(await r.blob.text());
  ok(raw2.files.Fimg.driveId === 'drv123' && !raw2.files.Fimg.buffer64, 'el archivo enlazado va como referencia a Drive');
  ok(raw2.files.Fdem.buffer64 && reads === 2, 'los no enlazados se siguen incrustando (y el enlazado no se lee)');
  ok(r.bytes === tif.byteLength, 'el peso cuenta solo lo incrustado');
  const files2 = unpackFiles(raw2);
  ok(files2.size === 1 && files2.has('Fdem'), 'al abrir, solo el incrustado viene con contenido');
  ok(raw2.driveAssets?.Fimg?.driveId === 'drv123' && raw2.driveAssets.Fimg.bounds.join() === '1,2,3,4', 'el enlazado queda en driveAssets para bajarlo de Drive');
}

console.log(`${pass} comprobaciones OK${fail ? `, ${fail} FALLOS` : ''}`);
if (fail) process.exit(1);
