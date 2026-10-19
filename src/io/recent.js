/**
 * Proyectos recientes: los últimos 10 proyectos abiertos, guardados o en los
 * que se trabajó, con su última versión, en el almacenamiento del navegador
 * (IndexedDB). Así «Archivo → Abrir reciente» los recupera sin buscar el
 * archivo, y la app abre siempre el último en el que se estaba trabajando.
 *
 * Cada proyecto se reconoce por `doc.projectId`. Las imágenes y modelos de
 * elevación ya están en el almacén de archivos, por su id: no se duplican.
 */

import { deleteDocKey, getDocKey, putDocKey } from './store.js';

export const MAX_RECENT = 10;
const INDEX = 'recent-index';
const keyOf = (id) => `recent:${id}`;

/** ¿Tiene algo que valga la pena recordar? (un dibujo vacío no entra a la lista) */
export function hasContent(doc) {
  return (doc?.layers || []).some((l) => (l.kind === 'vector' ? l.items?.length : l.kind !== 'basemap'));
}

/** Resumen para la lista. */
export function describe(doc) {
  let shapes = 0;
  for (const l of doc.layers || []) if (l.kind === 'vector') shapes += l.items?.length || 0;
  return { shapes, layers: (doc.layers || []).length };
}

/** Lista (la más reciente primero): [{ id, name, savedAt, source, driveFileId, shapes, layers }]. */
export async function listRecent() {
  const list = await getDocKey(INDEX);
  return Array.isArray(list) ? list : [];
}

/**
 * Recuerda (o actualiza) un proyecto y lo pone primero. `meta`: { name, source }.
 * Devuelve la lista nueva. Los que pasan de 10 se olvidan.
 */
export async function rememberProject(doc, meta = {}) {
  if (!doc?.projectId || !hasContent(doc)) return listRecent();
  const list = await listRecent();
  const prev = list.find((x) => x.id === doc.projectId);
  const entry = {
    id: doc.projectId,
    name: meta.name || doc.fileName || prev?.name || doc.title || 'Sin título',
    source: meta.source || prev?.source || 'navegador',
    driveFileId: doc.driveFileId || null,
    savedAt: new Date().toISOString(),
    ...describe(doc),
  };
  const next = [entry, ...list.filter((x) => x.id !== doc.projectId)];
  const drop = next.slice(MAX_RECENT);
  await putDocKey(keyOf(doc.projectId), doc);
  await putDocKey(INDEX, next.slice(0, MAX_RECENT));
  for (const x of drop) await deleteDocKey(keyOf(x.id));
  return next.slice(0, MAX_RECENT);
}

/** Última versión guardada de un proyecto reciente. */
export const loadRecent = (id) => getDocKey(keyOf(id));

/** Lo quita de la lista. */
export async function forgetRecent(id) {
  const list = (await listRecent()).filter((x) => x.id !== id);
  await putDocKey(INDEX, list);
  await deleteDocKey(keyOf(id));
  return list;
}
