/**
 * Lee un .ai / PDF fuera del hilo principal: el archivo puede pesar decenas de
 * MB y tardar segundos en leerse; así la interfaz no se congela.
 *
 *   postMessage({ buf: ArrayBuffer, opts })  →  { ok: true, result } | { ok: false, error }
 *
 * Aquí no hay DOM: el SVG intermedio lo lee el lector XML propio de svgImport.
 */

import { importPdf } from './pdfImport.js';
import { packLayers } from './transport.js';

self.onmessage = (e) => {
  try {
    const { buf, opts } = e.data;
    const result = importPdf(new Uint8Array(buf), opts);
    // las formas viajan empaquetadas y los píxeles sin copiarse; `shapes` repite lo mismo que `layers`
    const packed = packLayers(result.layers);
    const transfer = new Set(packed.transfer);
    for (const im of result.images) if (im.px.rgba) transfer.add(im.px.rgba.buffer);
    self.postMessage({ ok: true, result: { ...result, shapes: [], layers: packed.layers } }, [...transfer]);
  } catch (err) {
    self.postMessage({ ok: false, error: err?.message || String(err) });
  }
};
