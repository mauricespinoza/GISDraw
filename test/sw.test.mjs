/**
 * Todo módulo de src/ y todo archivo de vendor/ debe estar en el precache del
 * service worker: si falta uno, la app abre sin señal y se rompe al primer
 * import. node test/sw.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const sw = readFileSync(join(root, 'sw.js'), 'utf8');
const walk = (d) => readdirSync(join(root, d)).flatMap((f) => (statSync(join(root, d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const need = [...walk('src').filter((f) => f.endsWith('.js')), ...walk('vendor').filter((f) => !f.endsWith('LICENSE'))];
const missing = need.filter((f) => !sw.includes(`'./${f}'`));
if (missing.length) {
  console.error('✗ faltan en sw.js:', missing.join(', '));
  process.exit(1);
}
const ver = /VERSION = '([^']+)'/.exec(sw)?.[1];
const appVer = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'src/version.js'), 'utf8'))?.[1];
if (!ver || ver !== appVer) {
  console.error(`✗ VERSION de sw.js (${ver}) y APP_VERSION de src/version.js (${appVer}) deben coincidir`);
  process.exit(1);
}
console.log(`${need.length} archivos en el precache OK`);
