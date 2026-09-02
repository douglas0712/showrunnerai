// Direção cinematográfica: controles → prompt.
//
// A taxonomia de controles (câmera, lente, distância focal, abertura) segue a
// organização do Cinema Studio do Open Generative AI (MIT). As opções, os
// textos em português e o montador de prompt abaixo são próprios.
// Ver THIRD_PARTY_NOTICES.md.

export const CINEMA_CONTROLS = [
  {
    key: 'camera',
    label: 'Tipo de câmera',
    options: [
      { value: '', label: 'Não especificar', fragment: '' },
      { value: 'digital-8k', label: 'Digital modular 8K', fragment: 'capturado em câmera digital modular 8K' },
      { value: 'fullframe-cine', label: 'Cine digital full-frame', fragment: 'capturado em câmera cine digital full-frame' },
      { value: '70mm', label: 'Película 70mm grande formato', fragment: 'capturado em película 70mm de grande formato' },
      { value: 's35', label: 'Digital Super 35 de estúdio', fragment: 'capturado em digital Super 35 de estúdio' },
      { value: '16mm', label: 'Película 16mm clássica', fragment: 'capturado em película 16mm com grão visível' },
      { value: 'lf-premium', label: 'Digital large format premium', fragment: 'capturado em digital large format de alta gama' },
    ],
  },
  {
    key: 'lens',
    label: 'Lente',
    options: [
      { value: '', label: 'Não especificar', fragment: '' },
      { value: 'anamorphic', label: 'Anamórfica clássica', fragment: 'lente anamórfica clássica com flares horizontais' },
      { value: 'anamorphic-compact', label: 'Anamórfica compacta', fragment: 'lente anamórfica compacta' },
      { value: 'prime-modern', label: 'Prime moderna', fragment: 'lente prime moderna de alta definição' },
      { value: 'prime-vintage', label: 'Prime vintage', fragment: 'lente prime vintage com queda suave nas bordas' },
      { value: 'prime-70s', label: 'Prime anos 70', fragment: 'lente prime dos anos 70 com renderização quente' },
      { value: 'tilt', label: 'Tilt criativa', fragment: 'lente tilt-shift com plano de foco inclinado' },
      { value: 'macro', label: 'Macro extrema', fragment: 'lente macro extrema com detalhe milimétrico' },
      { value: 'bokeh-swirl', label: 'Bokeh giratório', fragment: 'lente de bokeh giratório para retrato' },
      { value: 'halation', label: 'Difusão com halation', fragment: 'lente com filtro de difusão e halation nas altas luzes' },
    ],
  },
  {
    key: 'focal',
    label: 'Distância focal',
    options: [
      { value: '', label: 'Não especificar', fragment: '' },
      { value: '8mm', label: '8mm — ultra-grande-angular', fragment: 'distância focal 8mm ultra-grande-angular' },
      { value: '14mm', label: '14mm — grande-angular', fragment: 'distância focal 14mm grande-angular' },
      { value: '24mm', label: '24mm — ambiente', fragment: 'distância focal 24mm de ambiente' },
      { value: '35mm', label: '35mm — olho humano', fragment: 'distância focal 35mm próxima da visão humana' },
      { value: '50mm', label: '50mm — retrato', fragment: 'distância focal 50mm de retrato' },
      { value: '85mm', label: '85mm — retrato fechado', fragment: 'distância focal 85mm de retrato fechado' },
      { value: '135mm', label: '135mm — teleobjetiva', fragment: 'distância focal 135mm teleobjetiva com compressão' },
    ],
  },
  {
    key: 'aperture',
    label: 'Abertura',
    options: [
      { value: '', label: 'Não especificar', fragment: '' },
      { value: 'f1.4', label: 'f/1.4 — foco raso', fragment: 'abertura f/1.4 com profundidade de campo muito rasa' },
      { value: 'f2.8', label: 'f/2.8 — separação suave', fragment: 'abertura f/2.8 com separação suave do fundo' },
      { value: 'f4', label: 'f/4 — equilibrada', fragment: 'abertura f/4 equilibrada' },
      { value: 'f8', label: 'f/8 — nítida', fragment: 'abertura f/8 com nitidez ampla' },
      { value: 'f11', label: 'f/11 — foco profundo', fragment: 'abertura f/11 com foco profundo' },
    ],
  },
  {
    key: 'movement',
    label: 'Movimento de câmera',
    options: [
      { value: '', label: 'Não especificar', fragment: '' },
      { value: 'static', label: 'Estática', fragment: 'câmera estática em tripé' },
      { value: 'dolly-in', label: 'Dolly in', fragment: 'dolly in lento e contínuo' },
      { value: 'dolly-out', label: 'Dolly out', fragment: 'dolly out revelando o entorno' },
      { value: 'tracking', label: 'Travelling lateral', fragment: 'travelling lateral acompanhando o sujeito' },
      { value: 'crane', label: 'Grua ascendente', fragment: 'movimento de grua ascendente' },
      { value: 'handheld', label: 'Câmera na mão', fragment: 'câmera na mão com microtremores orgânicos' },
      { value: 'orbit', label: 'Órbita', fragment: 'órbita de 180 graus ao redor do sujeito' },
      { value: 'push-pull', label: 'Dolly zoom', fragment: 'dolly zoom com fundo comprimindo' },
      { value: 'drone', label: 'Aérea de drone', fragment: 'plano aéreo de drone em altitude média' },
    ],
  },
  {
    key: 'lighting',
    label: 'Iluminação',
    options: [
      { value: '', label: 'Não especificar', fragment: '' },
      { value: 'golden-hour', label: 'Golden hour', fragment: 'luz natural de golden hour, quente e rasante' },
      { value: 'blue-hour', label: 'Blue hour', fragment: 'luz difusa de blue hour, azulada' },
      { value: 'low-key', label: 'Low key', fragment: 'iluminação low key com sombras densas' },
      { value: 'high-key', label: 'High key', fragment: 'iluminação high key, clara e sem sombras duras' },
      { value: 'rembrandt', label: 'Rembrandt', fragment: 'esquema Rembrandt com triângulo de luz no rosto' },
      { value: 'practical', label: 'Luz prática', fragment: 'iluminada por luzes práticas dentro do quadro' },
      { value: 'neon', label: 'Neon noturno', fragment: 'neon noturno com reflexos coloridos no asfalto molhado' },
      { value: 'overcast', label: 'Céu encoberto', fragment: 'luz suave de céu encoberto' },
      { value: 'backlit', label: 'Contraluz', fragment: 'sujeito em contraluz com recorte luminoso' },
    ],
  },
  {
    key: 'framing',
    label: 'Enquadramento',
    options: [
      { value: '', label: 'Não especificar', fragment: '' },
      { value: 'extreme-wide', label: 'Plano geral extremo', fragment: 'plano geral extremo' },
      { value: 'wide', label: 'Plano geral', fragment: 'plano geral' },
      { value: 'medium', label: 'Plano médio', fragment: 'plano médio' },
      { value: 'medium-close', label: 'Plano americano', fragment: 'plano americano' },
      { value: 'close', label: 'Close', fragment: 'close no rosto' },
      { value: 'extreme-close', label: 'Close extremo', fragment: 'close extremo em detalhe' },
      { value: 'over-shoulder', label: 'Sobre o ombro', fragment: 'plano sobre o ombro' },
      { value: 'low-angle', label: 'Contra-plongée', fragment: 'ângulo baixo em contra-plongée' },
      { value: 'high-angle', label: 'Plongée', fragment: 'ângulo alto em plongée' },
    ],
  },
  {
    key: 'style',
    label: 'Estilo cinematográfico',
    options: [
      { value: '', label: 'Não especificar', fragment: '' },
      { value: 'neo-noir', label: 'Neo-noir', fragment: 'estética neo-noir com alto contraste' },
      { value: 'doc', label: 'Documental', fragment: 'estética documental naturalista' },
      { value: 'scifi', label: 'Ficção científica', fragment: 'estética de ficção científica com paleta fria' },
      { value: 'period', label: 'Época', fragment: 'estética de filme de época com cor dessaturada' },
      { value: 'commercial', label: 'Publicitário', fragment: 'acabamento publicitário, impecável e brilhante' },
      { value: 'gritty', label: 'Cru e granulado', fragment: 'textura crua e granulada' },
      { value: 'dreamlike', label: 'Onírico', fragment: 'atmosfera onírica com névoa e difusão' },
      { value: 'teal-orange', label: 'Teal & orange', fragment: 'correção de cor teal and orange' },
    ],
  },
  {
    key: 'aspect',
    label: 'Proporção',
    options: [
      { value: '', label: 'Não especificar', fragment: '' },
      { value: '16:9', label: '16:9 — widescreen', fragment: 'proporção 16:9' },
      { value: '21:9', label: '21:9 — cinemascope', fragment: 'proporção 21:9 cinemascope' },
      { value: '9:16', label: '9:16 — vertical', fragment: 'proporção 9:16 vertical' },
      { value: '4:3', label: '4:3 — acadêmico', fragment: 'proporção acadêmica 4:3' },
      { value: '1:1', label: '1:1 — quadrado', fragment: 'proporção quadrada 1:1' },
    ],
  },
];

export const CINEMA_DEFAULTS = CINEMA_CONTROLS.reduce((acc, control) => {
  acc[control.key] = '';
  return acc;
}, {});

export function fragmentFor(key, value) {
  const control = CINEMA_CONTROLS.find((c) => c.key === key);
  if (!control) return '';
  return control.options.find((o) => o.value === value)?.fragment || '';
}

/**
 * Monta o prompt de direção a partir da descrição da cena + controles.
 * A ordem dos fragmentos é fixa para que o resultado seja previsível.
 */
export function buildCinematicPrompt(scene = '', controls = {}) {
  const order = ['framing', 'movement', 'camera', 'lens', 'focal', 'aperture', 'lighting', 'style', 'aspect'];
  const fragments = order
    .map((key) => fragmentFor(key, controls[key]))
    .filter(Boolean);

  const description = String(scene).trim().replace(/[.\s]+$/, '');
  if (!description && !fragments.length) return '';
  if (!fragments.length) return `${description}.`;
  if (!description) return `${capitalize(fragments.join(', '))}.`;
  return `${description}. ${capitalize(fragments.join(', '))}.`;
}

function capitalize(text = '') {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
