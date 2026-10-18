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

// drive.file: solo los archivos que la app crea o que se eligen en el selector; el resto, para saber quién inició sesión
const SCOPE = 'https://www.googleapis.com/auth/drive.file openid email profile';
const USER_KEY = 'gd.googleUser';
const API = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_DOCS = 'application/vnd.google-apps.';

let token = null; // { value, expires }
let user = null; // { name, email, picture }

/** Id de archivo a partir de un enlace de Drive (o el id tal cual). */
export function parseDriveId(link) {
  const s = String(link || '').trim();
  const m = /\/d\/([\w-]{10,})/.exec(s) || /[?&]id=([\w-]{10,})/.exec(s);
  if (m) return m[1];
  return /^[\w-]{10,}$/.test(s) ? s : null;
}

/** Número de proyecto de Google Cloud (el prefijo numérico del ID de cliente). */
export const appIdOf = (clientId) => /^(\d+)-/.exec(clientId || '')?.[1] || null;

async function accessToken(clientId, { prompt = '', hint = '' } = {}) {
  if (token && token.expires > Date.now() + 60_000) return token.value;
  await loadScript('https://accounts.google.com/gsi/client');
  const oauth = globalThis.google?.accounts?.oauth2;
  if (!oauth) throw new Error('No se pudo cargar el inicio de sesión de Google');
  return new Promise((resolve, reject) => {
    const client = oauth.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      hint: hint || undefined,
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

/** Usuario que inició sesión (o el último que lo hizo en este navegador, aunque el permiso haya vencido). */
export function googleUser() {
  if (user) return user;
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || 'null');
  } catch {
    return null;
  }
}

/** ¿Hay un permiso vigente para usar Drive? */
export const isSignedIn = () => !!(token && token.expires > Date.now() + 60_000);

/**
 * Inicio de sesión de Google (ventana emergente de Google): pide el permiso
 * para Drive y trae el nombre, correo y foto de la cuenta.
 * @returns {Promise<{name: string, email: string, picture: string}>}
 */
export async function signIn(clientId, { account = false } = {}) {
  if (!clientId) throw new Error('Falta el ID de cliente de Google (Cuenta de Google → Configuración)');
  const last = googleUser();
  // «account»: dejar elegir otra cuenta; si no, se reutiliza la última sin volver a preguntar
  const tok = await accessToken(clientId, account ? { prompt: 'select_account' } : { hint: last?.email || '' });
  const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${tok}` } });
  const info = res.ok ? await res.json() : {};
  user = { name: info.name || info.email || 'Cuenta de Google', email: info.email || '', picture: info.picture || '' };
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    /* sin almacenamiento */
  }
  return user;
}

/** Cierra la sesión: revoca el permiso de esta sesión y olvida la cuenta. */
export function signOut() {
  const t = token?.value;
  token = null;
  user = null;
  try {
    localStorage.removeItem(USER_KEY);
  } catch {
    /* sin almacenamiento */
  }
  if (t) globalThis.google?.accounts?.oauth2?.revoke?.(t, () => null);
}

/** Token vigente, iniciando sesión si hace falta (hay que llamarlo desde un gesto del usuario). */
export async function ensureSignedIn(clientId) {
  if (!isSignedIn()) await signIn(clientId);
  return token.value;
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
  const file = new File([blob], name || id, { type: mimeType || '' });
  file.driveId = id; // para guardar de vuelta en el mismo archivo
  return file;
}

/**
 * Sube un archivo a Drive (crea uno nuevo o, con `fileId`, reemplaza el contenido de ese).
 * @returns {Promise<{id: string, name: string, webViewLink: string}>}
 */
export async function uploadDriveFile({ name, mimeType = 'application/octet-stream', data, fileId = null, parentId = null }) {
  if (!isSignedIn()) throw new Error('Inicia sesión con Google primero');
  const boundary = `gd${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const meta = { name, mimeType };
  if (parentId && !fileId) meta.parents = [parentId];
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
    `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    data,
    `\r\n--${boundary}--`,
  ]);
  const base = 'https://www.googleapis.com/upload/drive/v3/files';
  const q = 'uploadType=multipart&supportsAllDrives=true&fields=id,name,webViewLink';
  const res = await fetch(fileId ? `${base}/${encodeURIComponent(fileId)}?${q}` : `${base}?${q}`, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    let msg = '';
    try {
      msg = (await res.json())?.error?.message || '';
    } catch {
      /* sin detalle */
    }
    const err = new Error(res.status === 404 ? 'Google Drive: el archivo ya no existe o esta app no tiene acceso a él' : `Google Drive: error ${res.status}${msg ? ` (${msg})` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/** Selector de Google para elegir una carpeta de Drive. @returns {Promise<{id: string, name: string}|null>} */
export async function pickDriveFolder({ clientId, apiKey }) {
  if (!clientId) throw new Error('Falta el ID de cliente de Google (Cuenta de Google → Configuración)');
  const tok = await ensureSignedIn(clientId);
  await loadPicker();
  const P = globalThis.google.picker;
  return new Promise((resolve) => {
    const view = new P.DocsView(P.ViewId.FOLDERS).setIncludeFolders(true).setSelectFolderEnabled(true).setMimeTypes('application/vnd.google-apps.folder');
    let b = new P.PickerBuilder()
      .addView(view)
      .setOAuthToken(tok)
      .setLocale('es')
      .setTitle('Elige la carpeta de Drive donde guardar')
      .setCallback((data) => {
        const action = data[P.Response.ACTION];
        if (action === P.Action.PICKED) {
          const d = (data[P.Response.DOCUMENTS] || [])[0];
          resolve(d ? { id: d[P.Document.ID], name: d[P.Document.NAME] } : null);
        } else if (action === P.Action.CANCEL) resolve(null);
      });
    if (apiKey) b = b.setDeveloperKey(apiKey);
    const appId = appIdOf(clientId);
    if (appId) b = b.setAppId(appId);
    b.build().setVisible(true);
  });
}
