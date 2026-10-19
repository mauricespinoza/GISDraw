/** Iconos de herramientas (trazos de 24×24, heredan currentColor). */

const s = (body) => `<svg viewBox="0 0 24 24">${body}</svg>`;

export const ICONS = {
  select: s('<path d="M5 3l14 8-6.5 1.5L9 19z" fill="currentColor" stroke="none"/>'),
  node: s('<path d="M5 3l14 8-6.5 1.5L9 19z"/><rect x="15" y="15" width="5" height="5" fill="currentColor"/>'),
  lasso: s('<path d="M7 17c-3-2-4-6-1-9s10-3 12 0 0 7-5 7c-2 0-4-1-4-2"/><path d="M9 13c-1 2-1 4 1 6"/>'),
  pen: s('<path d="M12 3l6 9-6 9-6-9z"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 3v7"/>'),
  polygon: s('<path d="M4 8l7-5 9 6-3 11H6z"/><circle cx="4" cy="8" r="1.6" fill="currentColor"/><circle cx="20" cy="9" r="1.6" fill="currentColor"/>'),
  pencil: s('<path d="M4 20c4-1 4-6 8-8s5-5 8-8"/>'),
  smooth: s('<path d="M3 15c2-6 4-6 6-2s4 4 6-2 4-4 6 0" stroke-dasharray="2 2.2"/><path d="M3 18c3-3 5-3 9 0s6 1 9-2"/>'),
  line: s('<path d="M5 19L19 5"/>'),
  arrow: s('<path d="M5 19L18 6"/><path d="M11 5h8v8" fill="none"/>'),
  rect: s('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  ellipse: s('<ellipse cx="12" cy="12" rx="8.5" ry="6"/>'),
  text: s('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  point: s('<circle cx="12" cy="12" r="4.5" fill="currentColor"/><circle cx="12" cy="12" r="8"/>'),
  eyedropper: s('<path d="M14 4l6 6-2 2-6-6zM12 6l-8 8v4h4l8-8"/>'),
  scissors: s('<circle cx="6.5" cy="17.5" r="2.8"/><circle cx="17.5" cy="17.5" r="2.8"/><path d="M8.6 15.6 18 4M15.4 15.6 6 4"/>'),
  zoom: s('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5.5 5.5M8 10.5h5M10.5 8v5"/>'),
  pan: s('<path d="M8 11V5.5a1.5 1.5 0 013 0V11M11 10V4.5a1.5 1.5 0 013 0V11M14 10.5V6a1.5 1.5 0 013 0v8c0 4-3 7-6.5 7S5 18 4 15l-1.5-3.5a1.4 1.4 0 012.4-1.3L8 14"/>'),
};

/** Iconos de las pestañas del panel. */
export const TAB_ICONS = {
  layers: s('<path d="M12 3 3 8l9 5 9-5z"/><path d="m3 12.5 9 5 9-5"/><path d="m3 17 9 5 9-5"/>'),
  canvas: s('<rect x="6" y="3" width="12" height="18" rx="1"/><path d="M3 9V6M3 6h3M21 15v3M21 18h-3"/>'),
  style: s('<path d="M19.5 3.5c-3 1.2-7.5 5.8-9 8.6l1.9 1.9c2.8-1.5 7.4-6 8.6-9z"/><path d="M10 13.5c-2.2 0-4 1.6-4 4 0 1.2-.8 2.2-2 2.5 3.8 1.2 8-.2 8-4.5"/>'),
  geology: s('<path d="M2.5 9.5c3-1.5 5.5 1 9 0s6-2.5 10-1"/><path d="M2.5 14.5c3-1.5 5.5 1 9 0s6-2.5 10-1"/><path d="M14 3 9 21"/><path d="M2.5 19.5h19M2.5 4.5h19"/>'),
  labels: s('<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.4" fill="currentColor"/>'),
  relief: s('<path d="M2 20 9 8l4 6 3-4 6 10z"/><path d="m7.5 10.5 1.5 1 1.5-1"/>'),
  arrange: s('<rect x="4" y="4" width="10" height="10" rx="1.5"/><rect x="10" y="10" width="10" height="10" rx="1.5" fill="currentColor" fill-opacity=".25"/>'),
  attrs: s('<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 15h18M9.5 4v16"/>'),
  georef: s('<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.4"/>'),
  layout: s('<rect x="5" y="3" width="14" height="18" rx="1.5"/><path d="M8 7h8M8 11h8M8 15h4"/>'),
};
