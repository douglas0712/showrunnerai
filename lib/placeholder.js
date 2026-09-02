// Geração de quadros de pré-visualização 100% local.
//
// Fase 1 não executa nenhum modelo. Para que a interface possa ser avaliada com
// conteúdo, desenhamos um SVG determinístico a partir da seed + prompt e o
// devolvemos como data: URL. Nenhum byte sai da máquina, nenhum arquivo é baixado.

import { hashString, mulberry32 } from './rng.js';

export const ASPECT_DIMENSIONS = {
  '1:1': [1024, 1024],
  '16:9': [1280, 720],
  '9:16': [720, 1280],
  '4:3': [1024, 768],
  '3:4': [768, 1024],
  '21:9': [1440, 617],
  '2:3': [768, 1152],
  '3:2': [1152, 768],
};

const PALETTES = [
  ['#f7b267', '#f4845f', '#3d1c2e'],
  ['#7c5cff', '#22d3ee', '#0b1024'],
  ['#e8b04b', '#8c3b2f', '#141013'],
  ['#4cc9f0', '#4361ee', '#080d1f'],
  ['#f72585', '#7209b7', '#12021a'],
  ['#95d5b2', '#2d6a4f', '#08160f'],
  ['#ffd166', '#ef476f', '#1a0f16'],
  ['#c1d3fe', '#5a4fcf', '#0a0a14'],
];

export function paletteFor(seedValue) {
  return PALETTES[Math.abs(seedValue) % PALETTES.length];
}

/**
 * Desenha um quadro simulado.
 * @param {object} opts
 * @param {number} opts.seed        seed determinística
 * @param {string} opts.prompt      texto usado para variar a composição
 * @param {string} opts.aspect      proporção ('16:9', '1:1', ...)
 * @param {string} opts.label       etiqueta impressa no canto
 * @param {'image'|'video'} opts.kind
 * @param {number} opts.frame       0..1 — posição temporal (usada pelo player simulado)
 * @returns {string} data: URL de um SVG
 */
export function placeholderFrame({
  seed = 0,
  prompt = '',
  aspect = '16:9',
  label = 'SIMULAÇÃO',
  kind = 'image',
  frame = 0,
} = {}) {
  const [w, h] = ASPECT_DIMENSIONS[aspect] || ASPECT_DIMENSIONS['16:9'];
  const base = (seed ^ hashString(prompt)) >>> 0;
  const rnd = mulberry32(base);
  const [c1, c2, c3] = paletteFor(base);
  const uid = base.toString(36);

  const drift = kind === 'video' ? frame * 90 : 0;
  const blobs = [];
  const blobCount = 3 + Math.floor(rnd() * 3);
  for (let i = 0; i < blobCount; i += 1) {
    const cx = Math.round(rnd() * w);
    const cy = Math.round(rnd() * h);
    const r = Math.round((0.18 + rnd() * 0.3) * Math.min(w, h));
    const fill = [c1, c2, '#ffffff'][Math.floor(rnd() * 3)];
    const op = (0.1 + rnd() * 0.22).toFixed(2);
    blobs.push(
      `<circle cx="${cx + drift * (i % 2 ? 1 : -1)}" cy="${cy}" r="${r}" fill="${fill}" opacity="${op}" filter="url(#b${uid})"/>`,
    );
  }

  const horizon = Math.round(h * (0.55 + rnd() * 0.2));
  const letterbox =
    kind === 'video'
      ? `<rect x="0" y="0" width="${w}" height="${Math.round(h * 0.055)}" fill="#000"/>
         <rect x="0" y="${h - Math.round(h * 0.055)}" width="${w}" height="${Math.round(h * 0.055)}" fill="#000"/>`
      : '';

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="g${uid}" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="55%" stop-color="${c2}"/>
      <stop offset="100%" stop-color="${c3}"/>
    </linearGradient>
    <radialGradient id="v${uid}" cx="50%" cy="45%" r="75%">
      <stop offset="55%" stop-color="#000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000" stop-opacity="0.72"/>
    </radialGradient>
    <filter id="b${uid}" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="${Math.round(Math.min(w, h) * 0.09)}"/>
    </filter>
    <filter id="n${uid}">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3"/>
      <feColorMatrix type="saturate" values="0"/>
    </filter>
  </defs>
  <rect width="${w}" height="${h}" fill="url(#g${uid})"/>
  ${blobs.join('\n  ')}
  <rect x="0" y="${horizon}" width="${w}" height="${h - horizon}" fill="#000" opacity="0.28"/>
  <rect width="${w}" height="${h}" fill="url(#v${uid})"/>
  <rect width="${w}" height="${h}" filter="url(#n${uid})" opacity="0.06"/>
  ${letterbox}
  ${labelMark(w, h, label)}
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.replace(/\s+/g, ' '))}`;
}

/**
 * Etiqueta impressa no canto inferior direito.
 *
 * O tamanho vem de `min(w, h)` — não da altura — para que retratos e paisagens
 * recebam a mesma marca, e a posição é oposta à do selo que a UI desenha por
 * cima, para os dois nunca colidirem.
 */
function labelMark(w, h, label) {
  const text = escapeXml(label);
  const unit = Math.min(w, h);
  const fontSize = Math.max(11, Math.round(unit * 0.028));
  const padX = Math.round(fontSize * 0.7);
  const boxW = Math.round(text.length * fontSize * 0.72 + padX * 2);
  const boxH = Math.round(fontSize * 1.9);
  const x = w - boxW - Math.round(unit * 0.035);
  const y = h - boxH - Math.round(unit * 0.035);

  return `<g font-family="ui-monospace, SFMono-Regular, Menlo, monospace" fill="#ffffff">
    <rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" rx="${Math.round(boxH * 0.28)}" fill="#000" opacity="0.5"/>
    <text x="${x + padX}" y="${y + Math.round(boxH * 0.68)}" font-size="${fontSize}" opacity="0.9" letter-spacing="1.5">${text}</text>
  </g>`;
}

export function escapeXml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
