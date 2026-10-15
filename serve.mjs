/**
 * Servidor estático sin dependencias.
 *
 *   node serve.mjs [puerto]
 *
 * Escucha en 0.0.0.0 a propósito: así el iPad puede abrir la app desde la red
 * local usando la IP que se imprime al arrancar.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)));
const PORT = Number(process.argv[2] || 5174);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webmanifest': 'application/manifest+json',
  // sql.js instancia el wasm por streaming, y eso exige el tipo exacto.
  '.wasm': 'application/wasm',
  // Glyphs de MapLibre.
  '.pbf': 'application/x-protobuf',
  '.tif': 'image/tiff',
  '.gpkg': 'application/geopackage+sqlite3',
};

const server = createServer(async (req, res) => {
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    res.writeHead(400).end('URL inválida');
    return;
  }
  if (pathname.endsWith('/')) pathname += 'index.html';

  const file = join(ROOT, normalize(pathname));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    res.writeHead(403).end('Prohibido');
    return;
  }

  try {
    const info = await stat(file);
    if (info.isDirectory()) {
      res.writeHead(404).end('No encontrado');
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('No encontrado');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const addrs = ['localhost'];
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) addrs.push(ni.address);
    }
  }
  console.log('FieldDraw sirviendo desde', ROOT);
  for (const a of addrs) console.log(`  http://${a}:${PORT}/`);
});
