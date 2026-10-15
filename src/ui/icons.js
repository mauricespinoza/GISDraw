/** Iconos de herramientas (trazos de 24×24, heredan currentColor). */

const s = (body) => `<svg viewBox="0 0 24 24">${body}</svg>`;

export const ICONS = {
  select: s('<path d="M5 3l14 8-6.5 1.5L9 19z" fill="currentColor" stroke="none"/>'),
  node: s('<path d="M5 3l14 8-6.5 1.5L9 19z"/><rect x="15" y="15" width="5" height="5" fill="currentColor"/>'),
  lasso: s('<path d="M7 17c-3-2-4-6-1-9s10-3 12 0 0 7-5 7c-2 0-4-1-4-2"/><path d="M9 13c-1 2-1 4 1 6"/>'),
  pen: s('<path d="M12 3l6 9-6 9-6-9z"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><path d="M12 3v7"/>'),
  polygon: s('<path d="M4 8l7-5 9 6-3 11H6z"/><circle cx="4" cy="8" r="1.6" fill="currentColor"/><circle cx="20" cy="9" r="1.6" fill="currentColor"/>'),
  pencil: s('<path d="M4 20c4-1 4-6 8-8s5-5 8-8"/>'),
  line: s('<path d="M5 19L19 5"/>'),
  arrow: s('<path d="M5 19L18 6"/><path d="M11 5h8v8" fill="none"/>'),
  rect: s('<rect x="4" y="6" width="16" height="12" rx="1"/>'),
  ellipse: s('<ellipse cx="12" cy="12" rx="8.5" ry="6"/>'),
  text: s('<path d="M5 6V4h14v2M12 4v16M9 20h6"/>'),
  point: s('<circle cx="12" cy="12" r="4.5" fill="currentColor"/><circle cx="12" cy="12" r="8"/>'),
  eyedropper: s('<path d="M14 4l6 6-2 2-6-6zM12 6l-8 8v4h4l8-8"/>'),
  pan: s('<path d="M8 11V5.5a1.5 1.5 0 013 0V11M11 10V4.5a1.5 1.5 0 013 0V11M14 10.5V6a1.5 1.5 0 013 0v8c0 4-3 7-6.5 7S5 18 4 15l-1.5-3.5a1.4 1.4 0 012.4-1.3L8 14"/>'),
};
