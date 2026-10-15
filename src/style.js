/**
 * Estilo de las formas y su traducción a SVG.
 *
 * UNIDADES. Los grosores van en milímetros y los tamaños de letra en puntos,
 * los dos medidos SOBRE EL PAPEL a la escala de referencia del documento
 * (`doc.refScale`). Es el comportamiento de un programa de dibujo: al hacer
 * zoom todo crece junto, y lo que se ve a 1:refScale es lo que sale impreso.
 *
 * EL BORDE HACIA AFUERA. Un trazo SVG o PDF está centrado en la geometría:
 * engrosarlo tapa la mitad interior del relleno. Aquí el borde de un polígono
 * se dibuja con el doble del ancho pedido y se recorta con una máscara que
 * deja pasar solo lo que queda FUERA de la forma (regla par-impar sobre un
 * rectángulo enorme más el propio contorno). Resultado: el borde mide lo que
 * se pidió, crece solo hacia afuera y el interior no pierde ni un píxel,
 * incluso con relleno transparente, que es justo donde falla el truco de
 * "trazo detrás del relleno". Los huecos funcionan solos: con par-impar, un
 * hueco vuelve a quedar dentro de la máscara y su borde crece hacia el hueco.
 *
 * En las líneas abiertas no hay "afuera": el equivalente es el BORDE DE LÍNEA
 * (casing), un trazo más ancho por debajo del núcleo. El núcleo conserva su
 * ancho completo y el borde solo añade a cada lado.
 */

export const DASHES = {
  solid: { label: 'Continua', pattern: null },
  dash: { label: 'Segmentada', pattern: [4, 2] },
  longdash: { label: 'Segmentada larga', pattern: [8, 3] },
  dot: { label: 'Punteada', pattern: [0, 2], round: true },
  dashdot: { label: 'Punto y raya', pattern: [5, 2, 0, 2], round: true },
  dashdotdot: { label: 'Raya y dos puntos', pattern: [5, 2, 0, 2, 0, 2], round: true },
  sparse: { label: 'Segmentada espaciada', pattern: [3, 4] },
};

export const MARKERS = {
  none: 'Ninguna',
  arrow: 'Flecha',
  open: 'Flecha abierta',
  stealth: 'Flecha aguda',
  circle: 'Círculo',
  square: 'Cuadrado',
  bar: 'Barra',
};

export const POINT_SHAPES = {
  circle: 'Círculo',
  square: 'Cuadrado',
  triangle: 'Triángulo',
  diamond: 'Rombo',
  star: 'Estrella',
  cross: 'Cruz',
  x: 'Aspa',
};

export function defaultStyle() {
  return {
    fill: 'none',
    fillOpacity: 0.35,
    fillType: 'solid', // solid | linear | radial
    gradient: { angle: 90, stops: [[0, '#ffffff', 1], [1, '#1d4ed8', 1]] },
    stroke: '#c2410c',
    strokeWidth: 0.5, // mm
    strokeOpacity: 1,
    dash: 'solid',
    dashScale: 1,
    cap: 'round',
    join: 'round',
    align: 'outside', // outside | center | inside (formas cerradas)
    casing: false,
    casingColor: '#ffffff',
    casingWidth: 0.4, // mm, a cada lado
    markerStart: 'none',
    markerEnd: 'none',
    markerSize: 1,
    opacity: 1,
    blend: 'normal',
    pointShape: 'circle',
    pointSize: 2.5, // mm
  };
}

export function defaultTextStyle() {
  return { ...defaultStyle(), fill: '#111827', fillOpacity: 1, stroke: 'none', strokeWidth: 0 };
}

/* ------------------------------------------------------------------ util */

export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const r2 = (v) => Math.round(v * 100) / 100;

/** `d` de un anillo de nodos ya proyectados a pantalla. */
export function nodesD(nodes, closed, P) {
  if (!nodes?.length) return '';
  const pt = (p) => {
    const q = P(p.x, p.y);
    return `${r2(q[0])} ${r2(q[1])}`;
  };
  let d = `M${pt(nodes[0])}`;
  const seg = (a, b) => (!a.hOut && !b.hIn ? `L${pt(b)}` : `C${pt(a.hOut || a)} ${pt(b.hIn || b)} ${pt(b)}`);
  for (let i = 1; i < nodes.length; i++) d += seg(nodes[i - 1], nodes[i]);
  if (closed && nodes.length > 2) d += `${seg(nodes[nodes.length - 1], nodes[0])}Z`;
  return d;
}

export function shapeD(shape, P) {
  let d = nodesD(shape.nodes, shape.closed, P);
  if (shape.closed) for (const h of shape.holes || []) d += nodesD(h, true, P);
  return d;
}

export function dashArray(style, wPx) {
  const preset = DASHES[style.dash];
  if (style.dash && !preset && /[\d.]/.test(style.dash)) {
    // patrón libre en múltiplos del grosor: "6 2 1 2"
    return style.dash
      .split(/[ ,]+/)
      .map(Number)
      .filter(Number.isFinite)
      .map((v) => r2(v * wPx * (style.dashScale || 1)))
      .join(' ');
  }
  if (!preset || !preset.pattern) return null;
  const k = Math.max(wPx, 0.5) * (style.dashScale || 1);
  return preset.pattern.map((v) => r2(v * k)).join(' ');
}

const capFor = (style) => (DASHES[style.dash]?.round ? 'round' : style.cap || 'round');

/* -------------------------------------------------------------- definiciones */

function gradientDef(id, style) {
  const g = style.gradient || { angle: 90, stops: [] };
  const stops = (g.stops || [])
    .map(([o, c, a]) => `<stop offset="${o}" stop-color="${esc(c)}" stop-opacity="${a ?? 1}"/>`)
    .join('');
  if (style.fillType === 'radial') {
    return `<radialGradient id="${id}" cx="0.5" cy="0.5" r="0.5">${stops}</radialGradient>`;
  }
  // El ángulo se mide como en Illustrator: 0° = izquierda→derecha, antihorario.
  return `<linearGradient id="${id}" gradientTransform="rotate(${-(g.angle ?? 0)} 0.5 0.5)">${stops}</linearGradient>`;
}

function markerPath(kind) {
  switch (kind) {
    case 'arrow':
      return { d: 'M0 0 L10 5 L0 10 Z', fill: true, ref: 7 };
    case 'stealth':
      return { d: 'M0 0 L10 5 L0 10 L3 5 Z', fill: true, ref: 7 };
    case 'open':
      return { d: 'M1 1 L9 5 L1 9', fill: false, ref: 8 };
    case 'circle':
      return { d: 'M5 1.5 A3.5 3.5 0 1 1 4.99 1.5 Z', fill: true, ref: 5 };
    case 'square':
      return { d: 'M1.5 1.5 H8.5 V8.5 H1.5 Z', fill: true, ref: 5 };
    case 'bar':
      return { d: 'M5 0 V10', fill: false, ref: 5 };
    default:
      return null;
  }
}

function markerDef(id, kind, style, orient) {
  const m = markerPath(kind);
  if (!m) return '';
  const size = 3.2 * (style.markerSize || 1);
  const paint = m.fill
    ? `fill="${esc(style.stroke)}" fill-opacity="${style.strokeOpacity ?? 1}"`
    : `fill="none" stroke="${esc(style.stroke)}" stroke-opacity="${style.strokeOpacity ?? 1}" stroke-width="1.6" stroke-linejoin="round"`;
  return `<marker id="${id}" viewBox="0 0 10 10" refX="${m.ref}" refY="5" markerWidth="${size}" markerHeight="${size}" orient="${orient}" markerUnits="strokeWidth" overflow="visible"><path d="${m.d}" ${paint}/></marker>`;
}

/* ------------------------------------------------------------- símbolos */

export function pointSymbolD(shape, cx, cy, r) {
  const k = (a) => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const poly = (pts) => `M${pts.map((p) => `${r2(p[0])} ${r2(p[1])}`).join('L')}Z`;
  switch (shape) {
    case 'square':
      return poly([[cx - r, cy - r], [cx + r, cy - r], [cx + r, cy + r], [cx - r, cy + r]]);
    case 'triangle':
      return poly([k(-Math.PI / 2), k(Math.PI / 6), k((5 * Math.PI) / 6)].map(([x, y]) => [x, y + r * 0.15]));
    case 'diamond':
      return poly([[cx, cy - r], [cx + r, cy], [cx, cy + r], [cx - r, cy]]);
    case 'star': {
      const pts = [];
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rr = i % 2 ? r * 0.45 : r;
        pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
      }
      return poly(pts);
    }
    case 'cross':
      return `M${r2(cx - r)} ${r2(cy)}H${r2(cx + r)}M${r2(cx)} ${r2(cy - r)}V${r2(cy + r)}`;
    case 'x': {
      const q = r * 0.75;
      return `M${r2(cx - q)} ${r2(cy - q)}L${r2(cx + q)} ${r2(cy + q)}M${r2(cx - q)} ${r2(cy + q)}L${r2(cx + q)} ${r2(cy - q)}`;
    }
    default:
      return `M${r2(cx - r)} ${r2(cy)}a${r2(r)} ${r2(r)} 0 1 0 ${r2(2 * r)} 0a${r2(r)} ${r2(r)} 0 1 0 ${r2(-2 * r)} 0Z`;
  }
}

/* ------------------------------------------------------------- render SVG */

/**
 * Marcado SVG de una forma.
 *
 * @param ctx { P(x,y)->[sx,sy], mmToPx, ptToPx, viewW, viewH, defs: string[], uid }
 *   `defs` acumula gradientes, marcadores y máscaras; `uid` evita colisiones
 *   de ids entre capas.
 */
export function shapeToSvg(shape, ctx, extraAttrs = '') {
  if (shape.visible === false) return '';
  switch (shape.type) {
    case 'group':
      return groupToSvg(shape, ctx, extraAttrs);
    case 'text':
      return textToSvg(shape, ctx, extraAttrs);
    case 'point':
      return pointToSvg(shape, ctx, extraAttrs);
    default:
      return pathToSvg(shape, ctx, extraAttrs);
  }
}

function groupToSvg(g, ctx, extraAttrs) {
  if (!g.clip) {
    return `<g data-id="${g.id}"${extraAttrs}>${g.children.map((c) => shapeToSvg(c, ctx)).join('')}</g>`;
  }
  const [mask, ...rest] = g.children;
  if (!mask) return '';
  const cid = `${ctx.uid}k${g.id}`;
  const geom = mask.type === 'path' ? `<path d="${shapeD(mask, ctx.P)}" clip-rule="evenodd"/>` : '';
  ctx.defs.push(`<clipPath id="${cid}" clipPathUnits="userSpaceOnUse">${geom}</clipPath>`);
  // La máscara se dibuja encima solo si tiene trazo visible (como en Illustrator,
  // donde por defecto pierde el estilo; aquí se respeta si el usuario lo dio).
  const maskVisible =
    mask.type === 'path' && mask.style && mask.style.stroke !== 'none' && mask.style.strokeWidth > 0 && mask.style.keepMaskStroke
      ? pathToSvg({ ...mask, style: { ...mask.style, fill: 'none' } }, ctx)
      : '';
  return `<g data-id="${g.id}"${extraAttrs}><g clip-path="url(#${cid})">${rest
    .map((c) => shapeToSvg(c, ctx))
    .join('')}</g>${maskVisible}</g>`;
}

function fillPaint(shape, ctx) {
  const s = shape.style;
  if (!s.fill || s.fill === 'none') return 'fill="none"';
  if (s.fillType === 'linear' || s.fillType === 'radial') {
    const gid = `${ctx.uid}f${shape.id}`;
    ctx.defs.push(gradientDef(gid, s));
    return `fill="url(#${gid})" fill-opacity="${s.fillOpacity ?? 1}"`;
  }
  return `fill="${esc(s.fill)}" fill-opacity="${s.fillOpacity ?? 1}"`;
}

function strokeAttrs(s, wPx, extraDash = true) {
  const dash = extraDash ? dashArray(s, wPx) : null;
  return `stroke="${esc(s.stroke)}" stroke-opacity="${s.strokeOpacity ?? 1}" stroke-width="${r2(wPx)}" stroke-linecap="${capFor(
    s,
  )}" stroke-linejoin="${s.join || 'round'}"${dash ? ` stroke-dasharray="${dash}"` : ''}`;
}

export function pathToSvg(shape, ctx, extraAttrs = '') {
  const s = shape.style;
  const d = shapeD(shape, ctx.P);
  if (!d) return '';
  const wPx = Math.max(0, (s.strokeWidth || 0) * ctx.mmToPx);
  const hasStroke = s.stroke && s.stroke !== 'none' && wPx > 0;
  const group = [];
  const opacity = s.opacity != null && s.opacity < 1 ? ` opacity="${s.opacity}"` : '';
  const blend = s.blend && s.blend !== 'normal' ? ` style="mix-blend-mode:${s.blend}"` : '';

  if (shape.closed) {
    group.push(`<path d="${d}" ${fillPaint(shape, ctx)} fill-rule="evenodd" stroke="none"/>`);
    if (hasStroke) {
      const align = s.align || 'outside';
      if (align === 'center') {
        group.push(`<path d="${d}" fill="none" ${strokeAttrs(s, wPx)}/>`);
      } else {
        const cid = `${ctx.uid}c${shape.id}`;
        const W = ctx.viewW;
        const H = ctx.viewH;
        const big = `M${-W * 4} ${-H * 4}H${W * 5}V${H * 5}H${-W * 4}Z`;
        ctx.defs.push(
          `<clipPath id="${cid}" clipPathUnits="userSpaceOnUse"><path d="${align === 'outside' ? big : ''}${d}" clip-rule="evenodd"/></clipPath>`,
        );
        group.push(`<path d="${d}" fill="none" ${strokeAttrs(s, 2 * wPx)} clip-path="url(#${cid})"/>`);
      }
    }
  } else {
    if (s.fill && s.fill !== 'none' && s.fillOpen) group.push(`<path d="${d}" ${fillPaint(shape, ctx)} stroke="none"/>`);
    if (s.casing && hasStroke) {
      const cw = wPx + 2 * (s.casingWidth || 0) * ctx.mmToPx;
      // El borde sigue los segmentos del núcleo para que cada raya tenga su
      // propio contorno; con trazo continuo es un único borde.
      const dash = dashArray(s, wPx);
      group.push(
        `<path d="${d}" fill="none" stroke="${esc(s.casingColor)}" stroke-opacity="${s.strokeOpacity ?? 1}" stroke-width="${r2(
          cw,
        )}" stroke-linecap="${capFor(s)}" stroke-linejoin="${s.join || 'round'}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`,
      );
    }
    if (hasStroke) {
      let markers = '';
      if (s.markerEnd && s.markerEnd !== 'none') {
        const mid = `${ctx.uid}me${shape.id}`;
        ctx.defs.push(markerDef(mid, s.markerEnd, s, 'auto'));
        markers += ` marker-end="url(#${mid})"`;
      }
      if (s.markerStart && s.markerStart !== 'none') {
        const mid = `${ctx.uid}ms${shape.id}`;
        ctx.defs.push(markerDef(mid, s.markerStart, s, 'auto-start-reverse'));
        markers += ` marker-start="url(#${mid})"`;
      }
      group.push(`<path d="${d}" fill="none" ${strokeAttrs(s, wPx)}${markers}/>`);
    }
  }
  return `<g data-id="${shape.id}"${opacity}${blend}${extraAttrs}>${group.join('')}</g>`;
}

export function pointToSvg(shape, ctx, extraAttrs = '') {
  const s = shape.style;
  const [cx, cy] = ctx.P(shape.x, shape.y);
  const r = Math.max(1, ((s.pointSize || 2.5) * ctx.mmToPx) / 2);
  const d = pointSymbolD(s.pointShape, cx, cy, r);
  const linear = s.pointShape === 'cross' || s.pointShape === 'x';
  const wPx = Math.max(0, (s.strokeWidth || 0) * ctx.mmToPx);
  const fill = linear ? 'fill="none"' : fillPaint(shape, ctx);
  const stroke =
    linear || (s.stroke && s.stroke !== 'none' && wPx > 0)
      ? `stroke="${esc(linear ? s.fill !== 'none' ? s.fill : s.stroke : s.stroke)}" stroke-width="${r2(linear ? Math.max(wPx, r * 0.3) : wPx)}" stroke-linejoin="round"`
      : 'stroke="none"';
  const opacity = s.opacity != null && s.opacity < 1 ? ` opacity="${s.opacity}"` : '';
  return `<g data-id="${shape.id}"${opacity}${extraAttrs}><path d="${d}" ${fill} ${stroke}/></g>`;
}

export function textToSvg(shape, ctx, extraAttrs = '') {
  const s = shape.style;
  const [x, y] = ctx.P(shape.x, shape.y);
  const fs = shape.fontSize * ctx.ptToPx;
  if (fs < 0.8) return '';
  const lines = String(shape.text || '').split('\n');
  const tspans = lines
    .map((l, i) => `<tspan x="${r2(x)}" dy="${i === 0 ? 0 : r2(fs * 1.2)}">${esc(l) || ' '}</tspan>`)
    .join('');
  const halo = shape.halo
    ? ` stroke="${esc(shape.haloColor || '#fff')}" stroke-width="${r2(2 * (shape.haloWidth ?? 0.5) * ctx.mmToPx)}" stroke-linejoin="round" paint-order="stroke fill"`
    : '';
  const rot = shape.rotation ? ` transform="rotate(${shape.rotation} ${r2(x)} ${r2(y)})"` : '';
  const opacity = s.opacity != null && s.opacity < 1 ? ` opacity="${s.opacity}"` : '';
  return `<g data-id="${shape.id}"${opacity}${extraAttrs}><text x="${r2(x)}" y="${r2(y)}"${rot} font-family="${esc(
    shape.fontFamily,
  )}" font-size="${r2(fs)}" font-weight="${shape.fontWeight || 400}"${shape.italic ? ' font-style="italic"' : ''} text-anchor="${
    shape.anchor || 'start'
  }" ${fillPaint(shape, ctx)}${halo}>${tspans}</text></g>`;
}
