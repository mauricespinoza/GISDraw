/**
 * Importar desde Google Drive.
 *
 * Dos caminos, según lo configurado (Archivo → Configurar Google Drive):
 * - Selector de Google (Picker) con inicio de sesión: elige cualquier archivo
 *   de «Mi unidad», «Compartidos conmigo» o unidades compartidas. Necesita un
 *   ID de cliente OAuth (tipo «Aplicación web», con el origen de la app entre
 *   los orígenes autorizados) y una clave de API, ambos del mismo proyecto de
 *   Google Cloud con «Google Drive API» y «Google Picker API» activadas. Pide
 *   el permiso `drive.file`: la app solo ve los archivos que elijas.
 * - Enlace compartido («cualquier persona con el enlace»): basta la clave de
 *   API; se pega el enlace del archivo.
 *
 * El archivo bajado se entrega como `File`, y la app lo importa según su
 * extensión, igual que si viniera del disco.
 */

import { loadScript } from './loader.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_DOCS = 'application/vnd.google-apps.';

let token = null; // { value, expires }

/** Id de archivo a partir de un enlace de Drive (o el id tal cual). */
export function parseDriveId(link) {
  const s = String(link || '').trim();
  const m = /\/d\/([\w-]{10,})/.exec(s) || /[?&]id=([\w-]{10,})/.exec(s);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(s) ? s : null;
}

/** Número de proyecto de Google Cloud (el prefijo numérico del ID de cliente). */
export const appIdOf = (clientId) => /^(\d+)-/.exec(clientId || '')?.[1] || null;

async function accessToken(clientId, { prompt = '' } = {}) {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  await loadScript('https://accounts.google.com/gsi/client');
  const oauth = globalThis.google?.accounts?.oauth2;
  if (!oauth) throw new Error('No se pudo cargar el inicio de sesión de Google');
  return new Promise((resolve, reject) => {
    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (r) => {
        if (r.error) return reject(new Error(`Google no dio acceso: ${r.error_description || r.error}`));
        token = { value: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3600) * 1000 };
        resolve(token.value);
      },
      error_callback: (e) => reject(new Error(e?.type === 'popup_closed' ? 'Se cerró la ventana de Google' : `Inicio de sesión de Google: ${e?.message || e?.type || 'error'}`)),
    });
    client.requestAccessToken({ prompt });
  });
}

async function loadPicker() {
  await loadScript('https://apis.google.com/js/api.js');
  if (!globalThis.gapi) throw new Error('No se pudo cargar el selector de Google');
  await new Promise((resolve, reject) => globalThis.gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('No se pudo cargar el selector de Google')) }));
}

/**
 * Abre el selector de Google Drive.
 * @returns {Promise<{id: string, name: string, mimeType: string}[]>} vacío si se cancela.
 */
export async function pickDriveFiles({ clientId, apiKey, multiple = true }) {
  if (!clientId) throw new Error('Falta el ID de cliente de Google (Archivo → Configurar Google Drive)');
  const [tok] = await Promise.all([accessToken(clientId), loadPicker()]);
  const P = globalThis.google.picker;
  return new Promise((resolve) => {
    const view = new P.DocsView(P.ViewId.DOCS).setIncludeFolders(true).setSelectFolderEnabled(false).setMode(P.DocsViewMode.LIST);
    const shared = new P.DocsView(P.ViewId.DOCS).setEnableDrives(true).setIncludeFolders(true).setSelectFolderEnabled(false);
    let b = new P.PickerBuilder()
      .addView(view)
      .addView(shared)
      .setOAuthToken(tok)
      .setLocale('es')
      .setTitle('Importar desde Google Drive')
      .enableFeature(P.Feature.SUPPORT_DRIVES)
      .setCallback((data) => {
        const action = data[P.Response.ACTION];
        if (action === P.Action.PICKED) resolve((data[P.Response.DOCUMENTS] || []).map((d) => ({ id: d[P.Document.ID], name: d[P.Document.NAME], mimeType: d[P.Document.MIME_TYPE] })));
        else if (action === P.Action.CANCEL) resolve([]);
      });
    if (apiKey) b = b.setDeveloperKey(apiKey);
    const appId = appIdOf(clientId);
    if (appId) b = b.setAppId(appId);
    if (multiple) b = b.enableFeature(P.Feature.MULTISELECT_ENABLED);
    b.build().setVisible(true);
  });
}

async function driveFetch(url, { apiKey, useToken }) {
  const headers = {};
  let u = url;
  if (useToken && token) headers.Authorization = `Bearer ${token.value}`;
  else if (apiKey) u += `${u.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;
  else throw new Error('Falta la clave de API de Google (Archivo → Configurar Google Drive)');
  const res = await fetch(u, { headers });
  if (!res.ok) {
    let msg = '';
    try {
      msg = (await res.json())?.error?.message || '';
    } catch {
      /* sin detalle */
    }
    if (res.status === 404) throw new Error('Google Drive: archivo no encontrado (¿está compartido con «cualquier persona con el enlace»?)');
    if (res.status === 403) throw new Error(`Google Drive: sin permiso para leer el archivo${msg ? ` (${msg})` : ''}`);
    throw new Error(`Google Drive: error ${res.status}${msg ? ` (${msg})` : ''}`);
  }
  return res;
}

/**
 * Baja un archivo de Drive como `File`. Con sesión iniciada usa el token;
 * si no, la clave de API (solo archivos compartidos por enlace).
 */
export async function downloadDriveFile({ id, name = null, mimeType = null }, { apiKey = '', onProgress = null } = {}) {
  const useToken = !!(token && token.expires > Date.now());
  if (!name || !mimeType) {
    const meta = await (await driveFetch(`${API}/${encodeURIComponent(id)}?fields=name,mimeType,size&supportsAllDrives=true`, { apiKey, useToken })).json();
    name = meta.name;
    mimeType = meta.mimeType;
  }
  if (mimeType?.startsWith(GOOGLE_DOCS)) throw new Error(`«${name}» es un documento de Google (no un archivo): descárgalo o expórtalo primero a un formato que la app lea`);
  const res = await driveFetch(`${API}/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`, { apiKey, useToken });
  const total = Number(res.headers.get('content-length')) || 0;
  let blob;
  if (onProgress && res.body && total) {
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got / total);
    }
    blob = new Blob(chunks, { type: mimeType || '' });
  } else blob = await res.blob();
  return new File([blob], name || id, { type: mimeType || '' });
}
