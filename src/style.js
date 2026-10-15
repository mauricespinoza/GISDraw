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

import { ornamentsSvg } from './ornaments.js';
import { patternDef } from './patterns.js';
import { flattenNodes } from './vector.js';
import { anchorOf, hardSpaces, layoutText, measureText } from './textLayout.js';

export const DASHES = {
  solid: { label: 'Continua', pattern: null },
  dash: { label: 'Segmentada', pattern: [4, 2] },
  longdash: { label: 'Segmentada larga', pattern: [8, 3] },
  dot: { label: 'Punteada', pattern: [0, 2], round: true },
  dashdot: { label: 'Punto y raya', pattern: [5, 2, 0, 2], round: true },
  dashdotdot: { label: 'Raya y dos puntos', pattern: [5, 2, 0, 2, 0, 2], round: true },
  sparse: { label: 'Segmentada espaciada', pattern: [3, 4] },
  inferred: { label: 'Inferida (geología)', pattern: [2.6, 1.7] },
  covered: { label: 'Cubierta (geología)', pattern: [0.1, 1.9], round: true },
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
    casing: false, // halo de línea: se agrega a cada lado, el centro conserva el color
    casingColor: '#ffffff',
    casingWidth: 0.4, // mm, a cada lado
    casingOpacity: 1,
    wavy: false, // línea ondulada (discordancia)
    waveAmp: 0.7, // mm
    waveLen: 3.6, // mm por ciclo
    ornament: 'none', // ver ornaments.js
    ornamentSize: 1,
    ornamentSpacing: 6.9, // mm
    ornamentSide: 'left',
    ornamentGap: 0.8, // mm (medias flechas)
    ornamentColor: '',
    ornamentHalo: true,
    pattern: 'none', // trama de litología (patterns.js), encima del relleno
    patternColor: '#1f2937',
    patternSize: 5, // mm por mosaico
    patternOpacity: 1,
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


/* ----------------------------------------------------- línea en pantalla / ondulada */

/** Polilínea [[x,y]…] en coordenadas de salida, con las curvas aplanadas a `tol`. */
export function screenLine(shape, P, tol = 0.3) {
  const map = (n) => {
    const q = P(n.x, n.y);
    const hi = n.hIn ? P(n.hIn.x, n.hIn.y) : null;
    const ho = n.hOut ? P(n.hOut.x, n.hOut.y) : null;
    return { x: q[0], y: q[1], hIn: hi && { x: hi[0], y: hi[1] }, hOut: ho && { x: ho[0], y: ho[1] }, smooth: n.smooth };
  };
  return flattenNodes(shape.nodes.map(map), shape.closed, tol);
}

/**
 * Línea ondulada (discordancia): la trayectoria desplazada perpendicularmente
 * por una sinusoide de amplitud `amp` y longitud de onda `len`. Se muestrea a
 * len/20 para que la curva salga suave sin necesitar Béziers. La fase arranca
 * en cero en el primer vértice, así dos tramos digitalizados seguidos no
 * quedan en contrafase al unirse en el vértice compartido.
 */
export function wavyPoints(pts, amp, len) {
  if (pts.length < 2 || amp <= 0 || len <= 0) return pts;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = cum[cum.length - 1];
  if (total <= 0) return pts;
  const step = len / 20;
  const n = Math.max(2, Math.ceil(total / step));
  const out = [];
  let seg = 1;
  for (let k = 0; k <= n; k++) {
    const d = (k / n) * total;
    while (seg < cum.length - 1 && cum[seg] < d) seg++;
    const a = pts[seg - 1];
    const b = pts[seg];
    const L = Math.max(1e-9, cum[seg] - cum[seg - 1]);
    const t = (d - cum[seg - 1]) / L;
    const x = a[0] + t * (b[0] - a[0]);
    const y = a[1] + t * (b[1] - a[1]);
    // normal del tramo (a la izquierda del sentido de avance en pantalla)
    const nx = (a[1] - b[1]) / L;
    const ny = (b[0] - a[0]) / L;
    const off = amp * Math.sin((2 * Math.PI * d) / len);
    out.push([x + nx * off, y + ny * off]);
  }
  return out;
}

const ptsD = (pts) => `M${pts.map((p) => `${r2(p[0])} ${r2(p[1])}`).join('L')}`;

export function pathToSvg(shape, ctx, extraAttrs = '') {
  const s = shape.style;
  let d = shapeD(shape, ctx.P);
  if (!d) return '';
  const wPx = Math.max(0, (s.strokeWidth || 0) * ctx.mmToPx);
  const hasStroke = s.stroke && s.stroke !== 'none' && wPx > 0;
  const group = [];
  const opacity = s.opacity != null && s.opacity < 1 ? ` opacity="${s.opacity}"` : '';
  const blend = s.blend && s.blend !== 'normal' ? ` style="mix-blend-mode:${s.blend}"` : '';
  const tol = ctx.flatTol ?? 0.3;

  if (shape.closed) {
    group.push(`<path d="${d}" ${fillPaint(shape, ctx)} fill-rule="evenodd" stroke="none"/>`);
    // trama de litología: encima del color de la unidad, debajo del contorno
    if (s.pattern && s.pattern !== 'none') {
      const tile = Math.max(2, (s.patternSize || 5) * ctx.mmToPx);
      const key = `pat|${s.pattern}|${s.patternColor}|${r2(tile)}|${s.patternOpacity ?? 1}`;
      ctx.defSet = ctx.defSet || new Set();
      const pid = `${ctx.uid}p${hashKey(key)}`;
      if (!ctx.defSet.has(pid)) {
        ctx.defSet.add(pid);
        ctx.defs.push(patternDef(pid, s.pattern, s.patternColor || '#1f2937', r2(tile), s.patternOpacity ?? 1));
      }
      group.push(`<path d="${d}" fill="url(#${pid})" fill-rule="evenodd" stroke="none"/>`);
    }
    if (hasStroke) {
      const align = s.align || 'outside';
      // halo del trazo (como el de una línea): una banda a cada lado, por debajo, que deja el centro con el color del trazo
      const cw = s.casing ? (s.casingWidth || 0) * ctx.mmToPx : 0;
      const casing = (wide) => {
        const dash = dashArray(s, wPx);
        return `<path d="${d}" fill="none" stroke="${esc(s.casingColor || '#ffffff')}" stroke-opacity="${(s.casingOpacity ?? 1) * (s.strokeOpacity ?? 1)}" stroke-width="${r2(wide)}" stroke-linecap="${capFor(s)}" stroke-linejoin="${s.join || 'round'}"${dash ? ` stroke-dasharray="${dash}"` : ''}`;
      };
      if (align === 'center') {
        if (cw > 0) group.push(`${casing(wPx + 2 * cw)}/>`);
        group.push(`<path d="${d}" fill="none" ${strokeAttrs(s, wPx)}/>`);
      } else {
        const cid = `${ctx.uid}c${shape.id}`;
        const W = ctx.viewW;
        const H = ctx.viewH;
        const big = `M${-W * 4} ${-H * 4}H${W * 5}V${H * 5}H${-W * 4}Z`;
        ctx.defs.push(
          `<clipPath id="${cid}" clipPathUnits="userSpaceOnUse"><path d="${align === 'outside' ? big : ''}${d}" clip-rule="evenodd"/></clipPath>`,
        );
        if (cw > 0) group.push(`${casing(2 * (wPx + cw))} clip-path="url(#${cid})"/>`);
        group.push(`<path d="${d}" fill="none" ${strokeAttrs(s, 2 * wPx)} clip-path="url(#${cid})"/>`);
      }
    }
  } else {
    if (s.fill && s.fill !== 'none' && s.fillOpen) group.push(`<path d="${d}" ${fillPaint(shape, ctx)} stroke="none"/>`);
    const base = s.ornament && s.ornament !== 'none' || s.wavy ? screenLine(shape, ctx.P, tol) : null;
    // discordancia: la misma línea, ondulada; halo, trazo y puntas la siguen
    if (s.wavy && base) d = ptsD(wavyPoints(base, (s.waveAmp ?? 0.7) * ctx.mmToPx, (s.waveLen ?? 3.6) * ctx.mmToPx));
    // ornamentos (dientes, tics, flechas): el halo va POR DEBAJO de la traza
    let orn = { halo: '', symbols: '' };
    if (base && s.ornament && s.ornament !== 'none' && hasStroke && 9 * (25.4 / 96) * ctx.mmToPx * (s.ornamentSize || 1) >= 1.5) {
      orn = ornamentsSvg(base, s, ctx.mmToPx, s.stroke);
    }
    group.push(orn.halo);
    // halo de línea (casing): cubre a ambos lados y deja el centro con el color del trazo
    if (s.casing && hasStroke) {
      const cw = wPx + 2 * (s.casingWidth || 0) * ctx.mmToPx;
      const dash = dashArray(s, wPx);
      const co = (s.casingOpacity ?? 1) * (s.strokeOpacity ?? 1);
      group.push(
        `<path d="${d}" fill="none" stroke="${esc(s.casingColor)}" stroke-opacity="${co}" stroke-width="${r2(
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
    group.push(orn.symbols);
  }
  return `<g data-id="${shape.id}"${opacity}${blend}${extraAttrs}>${group.join('')}</g>`;
}

/** Hash corto y estable de un texto, para ids de definiciones compartidas. */
export function hashKey(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
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
  const m = layoutText(shape, fs, ctx.mmToPx, (t, size) => measureText(t, size, shape.fontFamily, shape.fontWeight || 400, !!shape.italic));
  const boxed = m.boxed;
  const anchor = anchorOf(shape);
  // x de cada renglón: en un cuadro, el borde izquierdo / centro / borde derecho; sin cuadro, el ancla
  const lineX = boxed ? (m.align === 'center' ? m.boxW / 2 : m.align === 'right' ? m.boxW : 0) : 0;
  const tspans = m.lines
    .map((l, i) => {
      const dy = i === 0 ? 0 : r2(m.lh);
      if (l.words) {
        return l.words.map((w, k) => `<tspan x="${r2(x + w.x)}" ${k === 0 ? `dy="${dy}" ` : 'dy="0" '}text-anchor="start">${esc(hardSpaces(w.t))}</tspan>`).join('');
      }
      return `<tspan x="${r2(x + lineX)}" dy="${dy}">${esc(hardSpaces(l.t)) || ' '}</tspan>`;
    })
    .join('');
  const rot = shape.rotation ? ` transform="rotate(${shape.rotation} ${r2(x)} ${r2(y)})"` : '';
  const opacity = s.opacity != null && s.opacity < 1 ? ` opacity="${s.opacity}"` : '';
  const spacing =
    (m.track ? ` letter-spacing="${r2(m.track)}"` : '') + (m.wordGap ? ` word-spacing="${r2(m.wordGap)}"` : '');
  const common = `x="${r2(x + lineX)}" y="${r2(y)}"${rot} font-family="${esc(shape.fontFamily)}" font-size="${r2(fs)}" font-weight="${shape.fontWeight || 400}"${
    shape.italic ? ' font-style="italic"' : ''
  } text-anchor="${boxed && m.align === 'justify' ? 'start' : anchor}"${spacing} xml:space="preserve"`;
  // El halo es un texto APARTE por debajo, con el trazo del grosor del halo; el
  // texto de relleno va encima y lo tapa por dentro. Así el halo solo se ve por
  // fuera de las letras sin depender de `paint-order`, que el PDF no respeta.
  const halo = shape.halo
    ? `<text ${common} fill="${esc(shape.haloColor || '#fff')}" stroke="${esc(shape.haloColor || '#fff')}" stroke-width="${r2(
        2 * (shape.haloWidth ?? 0.5) * ctx.mmToPx,
      )}" stroke-linejoin="round" stroke-linecap="round"${shape.haloOpacity != null && shape.haloOpacity < 1 ? ` opacity="${shape.haloOpacity}"` : ''}>${tspans}</text>`
    : '';
  return `<g data-id="${shape.id}"${opacity}${extraAttrs}>${halo}<text ${common} ${fillPaint(shape, ctx)}>${tspans}</text></g>`;
}
