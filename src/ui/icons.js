/** Iconos de herramientas (trazos de 24×24, heredan currentColor). */

const s = (body) => `<svg viewBox="0 0 24 24">${body}</svg>`;
// vértice: punto lleno, del mismo color que el trazo
const dot = (x, y, r = 1.5) => `<circle cx="${x}" cy="${y}" r="${r}" fill="currentColor" stroke="none"/>`;
// nodo cuadrado, como los de Illustrator
const node = (x, y, a = 3.4) => `<rect x="${x - a / 2}" y="${y - a / 2}" width="${a}" height="${a}" rx=".4" fill="currentColor" stroke="none"/>`;
const ARROW = 'M5.5 3.5v15.4l4.2-4 2.9 6.4 2.7-1.2-2.9-6.3h6z';

export const ICONS = {
  select: s(`<path d="${ARROW}" fill="currentColor"/>`),
  // selección directa: la flecha hueca
  node: s(`<path d="${ARROW}"/>`),
  // Drag: un nodo tomado y arrastrado; los vecinos lo siguen cada vez menos
  drag: s(`<path d="M2.5 19c3.6 0 5.2-8 9.5-8s5.9 8 9.5 8"/>${node(12, 11)}<path d="M12 7V2.5M10 4.5l2-2 2 2"/>${dot(6.6, 16, 1.1)}${dot(17.4, 16, 1.1)}`),
  // Split: un polígono cortado por una línea auxiliar punteada
  split: s('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M2.5 21.5l19-19" stroke-dasharray="2.6 2.4"/>'),
  // Reshape: parte del contorno de un polígono redibujada
  reshape: s('<path d="M8.5 10H4v10h16V10h-4.5"/><path d="M8.5 10h7" stroke-dasharray="1.6 2" stroke-width="1.2"/><path d="M8.5 10c0-5.5 7-5.5 7 0"/>'),
  lasso: s('<path d="M7.2 16.6C4.6 15.4 3 13.3 3 10.9 3 6.8 7 3.5 12 3.5s9 3.3 9 7.4-4 7.4-9 7.4c-.9 0-1.8-.1-2.6-.3"/><circle cx="8" cy="17.4" r="1.6"/><path d="M8.6 19c.2 1.1-.3 2-1.3 2.6"/>'),
  // pluma Bézier: plumilla con su ranura
  pen: s('<path d="M12 3 6.5 12.5 9 19h6l2.5-6.5z"/><path d="M12 3v7.4"/><circle cx="12" cy="12" r="1.5"/><path d="M9 21.5h6"/>'),
  polygon: s(`<path d="M12 3.5l8.5 6-3.2 10H6.7l-3.2-10z"/>${dot(12, 3.5)}${dot(20.5, 9.5)}${dot(3.5, 9.5)}${dot(17.3, 19.5)}${dot(6.7, 19.5)}`),
  // lápiz de trazo libre
  pencil: s('<path d="M15.3 4.2a2.2 2.2 0 0 1 3.1 0l1.4 1.4a2.2 2.2 0 0 1 0 3.1L8.6 19.9 3.5 20.5l.6-5.1z"/><path d="M13.6 5.9l4.5 4.5"/>'),
  // Deform: un tramo recto (punteado) empujado en arco
  deform: s('<path d="M3 19.5h18" stroke-dasharray="1.2 2.4" stroke-width="1.2"/><path d="M3 19.5C6 8.5 18 8.5 21 19.5"/><path d="M12 18v-5.5M10 14.5l2-2 2 2"/>'),
  smooth: s('<path d="M3 11l3-4 3 5 3-5 3 5 3-4 3 3" stroke-dasharray="1.6 2" stroke-width="1.2"/><path d="M3 17.5c3-4 6-4 9 0s6 4 9 0"/>'),
  line: s(`<path d="M5 19 19 5"/>${dot(5, 19, 1.8)}${dot(19, 5, 1.8)}`),
  arrow: s('<path d="M5 19 19 5"/><path d="M10 5h9v9"/>'),
  rect: s('<rect x="3.5" y="5.5" width="17" height="13" rx="1.5"/>'),
  ellipse: s('<ellipse cx="12" cy="12" rx="9" ry="6.5"/>'),
  text: s('<path d="M5 7.5V5h14v2.5M12 5v14M9.5 19h5"/>'),
  point: s(`<circle cx="12" cy="12" r="7.5"/>${dot(12, 12, 3)}`),
  eyedropper: s('<path d="M13.5 6.5l4 4"/><path d="M14.7 7.7l2.6-2.6a2 2 0 0 1 2.8 2.8l-2.6 2.6"/><path d="M15.5 12.5 7.4 20.6 3.5 20.5l-.1-3.9 8.1-8.1"/>'),
  scissors: s('<circle cx="6" cy="6" r="2.8"/><circle cx="6" cy="18" r="2.8"/><path d="M20 4 8.2 15.8M14.5 14.5 20 20M8.2 8.2 12 12"/>'),
  zoom: s('<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.2 15.2 20.5 20.5M8 10.5h5M10.5 8v5"/>'),
  pan: s('<path d="M7.5 12.5V6a1.6 1.6 0 0 1 3.2 0v5"/><path d="M10.7 11V4.4a1.6 1.6 0 0 1 3.2 0V11"/><path d="M13.9 11V5.8a1.6 1.6 0 0 1 3.2 0V12"/><path d="M17.1 9.5a1.6 1.6 0 0 1 3.2 0v4.3c0 4.2-3 7.2-7.2 7.2h-1.4c-2.2 0-3.6-.7-5-2.1l-3.2-3.4a1.6 1.6 0 0 1 2.3-2.2l1.7 1.7"/>'),
};

/** Iconos de las pestañas del panel. */
export const TAB_ICONS = {
  layers: s('<path d="M12 3 3 7.8l9 4.8 9-4.8z"/><path d="M3 12.2l9 4.8 9-4.8"/><path d="M3 16.6l9 4.8 9-4.8"/>'),
  canvas: s('<rect x="5.5" y="3" width="13" height="18" rx="1.5"/><path d="M8.5 7h7M8.5 10.5h4"/>'),
  style: s('<circle cx="12" cy="12" r="9"/><circle cx="8" cy="9.5" r="1.3"/><circle cx="12" cy="7" r="1.3"/><circle cx="16" cy="9.5" r="1.3"/><path d="M12 21c-1.4 0-2-1-2-2s.8-2 2-2h1.5c2 0 3.5-1.3 3.5-3"/>'),
  geology: s('<path d="M3 5h18M3 19h18"/><path d="M3 10c3-1.4 5.5.9 9 0s6-2.3 9-.9"/><path d="M3 14.5c3-1.4 5.5.9 9 0s6-2.3 9-.9"/><path d="M14.5 3 9.5 21"/>'),
  labels: s('<path d="M3 12V4.5A1.5 1.5 0 0 1 4.5 3H12l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.4"/>'),
  relief: s('<path d="M2.5 20 9 8.5l4 6.5 2.8-4L21.5 20z"/><path d="M7.4 11.3 9 12.4l1.6-1.1"/>'),
  arrange: s('<rect x="3.5" y="3.5" width="11" height="11" rx="1.5"/><rect x="9.5" y="9.5" width="11" height="11" rx="1.5" fill="currentColor" fill-opacity=".22"/>'),
  attrs: s('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 15h18M9.5 4v16"/>'),
  georef: s('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>'),
  layout: s('<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M8 7h8M8 11h8M8 15h4"/>'),
};
