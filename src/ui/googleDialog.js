/**
 * Cuenta de Google y Drive: inicio de sesión (el botón clásico de Google),
 * configuración de las credenciales (ID de cliente OAuth y clave de API) y
 * atajos para guardar y abrir proyectos en Drive.
 */

import { h } from './dom.js';
import { googleUser, isSignedIn, signIn, signOut } from '../io/gdrive.js';

const G_LOGO = `<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.6 17.7 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z"/><path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.3.8-4.7l-7.9-6.1C.9 16.4 0 20.1 0 24s.9 7.6 2.6 10.8l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.3 0-11.6-4.1-13.5-9.8l-7.9 6.1C6.5 42.6 14.6 48 24 48z"/></svg>`;

/** Abre el cuadro. `app`: la aplicación (ajustes, mensajes, acciones de Drive). */
export function openGoogleDialog(app) {
  document.getElementById('google-dialog')?.remove();
  const close = () => dlg.remove();
  const body = h('div', { class: 'gdlg-body' });
  const dlg = h(
    'div',
    { id: 'google-dialog', class: 'gdlg', role: 'dialog', 'aria-label': 'Cuenta de Google', onclick: (e) => e.target === dlg && close() },
    h('div', { class: 'gdlg-card' }, h('button', { class: 'gdlg-x', 'aria-label': 'Cerrar', onclick: close }, '×'), h('h2', {}, 'Cuenta de Google y Drive'), body),
  );
  document.body.append(dlg);

  const render = () => {
    const s = app.settings;
    const user = googleUser();
    const signed = isSignedIn();
    const gbtn = (label, onclick) => h('button', { class: 'gbtn', type: 'button', onclick }, h('span', { class: 'gbtn-logo', html: G_LOGO }), h('span', {}, label));
    const run = (f) => async () => {
      try {
        await f();
      } catch (err) {
        app.message(`Error: ${err.message}`, 7000);
      }
      render();
      app.updateGoogleButton?.();
    };
    const account = [];
    if (signed && user) {
      account.push(
        h(
          'div',
          { class: 'gacct' },
          user.picture ? h('img', { src: user.picture, alt: '', referrerpolicy: 'no-referrer' }) : h('span', { class: 'gacct-ini' }, (user.name || '?')[0].toUpperCase()),
          h('div', {}, h('b', {}, user.name), h('div', { class: 'hint' }, `${user.email} · sesión iniciada`)),
        ),
        h('div', { class: 'grow-btns' }, h('button', { class: 'btn', onclick: run(() => signIn(s.googleClientId, { account: true })) }, 'Cambiar de cuenta'), h('button', { class: 'btn', onclick: run(() => signOut()) }, 'Cerrar sesión')),
        h(
          'div',
          { class: 'grow-btns' },
          h('button', { class: 'btn primary', onclick: () => (close(), app.saveToDrive()) }, 'Guardar el proyecto en Drive'),
          h('button', { class: 'btn', onclick: () => (close(), app.saveToDrive({ choose: true })) }, 'Guardar en otra carpeta…'),
          h('button', { class: 'btn', onclick: () => (close(), app.importFromDrive()) }, 'Abrir desde Drive…'),
        ),
      );
    } else if (user) {
      account.push(
        h('p', { class: 'hint' }, 'El permiso de esta sesión venció (Google lo renueva cada hora).'),
        gbtn(`Continuar como ${user.name}`, run(() => signIn(s.googleClientId))),
        h('button', { class: 'btn', onclick: run(() => signIn(s.googleClientId, { account: true })) }, 'Usar otra cuenta'),
      );
    } else {
      account.push(
        h('p', { class: 'hint' }, 'Inicia sesión para abrir y guardar proyectos en tu Google Drive. La app solo ve los archivos que ella crea o que eliges en el selector.'),
        gbtn('Iniciar sesión con Google', run(() => signIn(s.googleClientId))),
      );
    }

    const field = (label, key, placeholder) => {
      const i = h('input', { type: 'text', value: s[key] || '', placeholder, autocomplete: 'off', spellcheck: false });
      i.addEventListener('change', () => {
        app.saveSettings({ [key]: i.value.trim() });
        render();
      });
      return h('label', { class: 'gfield' }, h('span', {}, label), i);
    };
    const configured = !!s.googleClientId;
    body.replaceChildren(
      ...account,
      h(
        'details',
        { class: 'gcfg', open: !configured },
        h('summary', {}, configured ? 'Configuración de Google' : 'Configuración (hace falta una vez)'),
        h(
          'p',
          { class: 'hint' },
          'La app no trae claves propias: usa las de tu proyecto de Google Cloud (gratis). En console.cloud.google.com crea un proyecto, activa «Google Drive API» y «Google Picker API», y en Credenciales crea un «ID de cliente de OAuth» de tipo «Aplicación web» con este origen autorizado: ',
          h('code', {}, location.origin),
          '. La clave de API (opcional) sirve para abrir archivos compartidos por enlace.',
        ),
        field('ID de cliente OAuth', 'googleClientId', '123456789-abc….apps.googleusercontent.com'),
        field('Clave de API (opcional)', 'googleApiKey', 'AIza…'),
      ),
    );
  };
  render();
  return dlg;
}
