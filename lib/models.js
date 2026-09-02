// Catálogo de modelos.
//
// A forma do registro (id / name / provider / inputs com enums) é derivada do
// padrão de `packages/studio/src/models.js` do Open Generative AI (MIT) —
// ver THIRD_PARTY_NOTICES.md. A diferença central: aqui `providerId` aponta
// para um provider substituível, e não para um endpoint fixo de um único
// fornecedor. Nenhum modelo está acoplado à MuAPI.

export const RUNTIME = {
  LOCAL: 'local',
  API: 'api',
};

export const STATUS = {
  AVAILABLE: 'available',
  NOT_CONFIGURED: 'not-configured',
};

export const IMAGE_MODELS = [
  {
    id: 'ideogram-4',
    name: 'Ideogram 4',
    vendor: 'Ideogram',
    kind: 'image',
    runtime: RUNTIME.LOCAL,
    status: STATUS.AVAILABLE,
    providerId: 'local',
    note: 'Runtime local reconhecido. Integração ainda não feita — fora do escopo desta etapa.',
    inputs: {
      aspect_ratio: { enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'], default: '16:9' },
      resolution: { enum: ['1K', '2K', '4K'], default: '2K' },
      count: { enum: [1, 2, 4], default: 2 },
      seed: { type: 'number' },
    },
  },
  {
    id: 'flux-1.1-pro',
    name: 'Flux 1.1 Pro',
    vendor: 'Black Forest Labs',
    kind: 'image',
    runtime: RUNTIME.API,
    status: STATUS.NOT_CONFIGURED,
    providerId: 'api',
    note: 'Requer um provedor por API configurado.',
    inputs: {
      aspect_ratio: { enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], default: '16:9' },
      resolution: { enum: ['1K', '2K'], default: '1K' },
      count: { enum: [1, 2, 4], default: 1 },
      seed: { type: 'number' },
    },
  },
  {
    id: 'seedream-4',
    name: 'Seedream 4',
    vendor: 'ByteDance',
    kind: 'image',
    runtime: RUNTIME.API,
    status: STATUS.NOT_CONFIGURED,
    providerId: 'api',
    note: 'Requer um provedor por API configurado.',
    inputs: {
      aspect_ratio: { enum: ['1:1', '16:9', '9:16', '4:3', '3:4', '21:9'], default: '16:9' },
      resolution: { enum: ['1K', '2K', '4K'], default: '2K' },
      count: { enum: [1, 2, 4], default: 1 },
      seed: { type: 'number' },
    },
  },
  {
    id: 'imagen-4',
    name: 'Imagen 4',
    vendor: 'Google',
    kind: 'image',
    runtime: RUNTIME.API,
    status: STATUS.NOT_CONFIGURED,
    providerId: 'api',
    note: 'Requer um provedor por API configurado.',
    inputs: {
      aspect_ratio: { enum: ['1:1', '16:9', '9:16', '4:3', '3:4'], default: '16:9' },
      resolution: { enum: ['1K', '2K'], default: '1K' },
      count: { enum: [1, 2, 4], default: 1 },
      seed: { type: 'number' },
    },
  },
];

export const VIDEO_MODELS = [
  {
    id: 'minimax-h3',
    name: 'MiniMax H3',
    vendor: 'MiniMax',
    kind: 'video',
    runtime: RUNTIME.LOCAL,
    status: STATUS.AVAILABLE,
    providerId: 'comfyui',
    note: 'Execução local real via ComfyUI — texto → vídeo (Cinema) e imagem → vídeo (Vídeo).',
    modes: ['t2v', 'i2v', 'r2v'],
    // O nó MiniMaxH3ImageToVideo aceita first_frame e last_frame como entradas
    // opcionais: os três modos são o mesmo grafo com zero, uma ou duas imagens.
    liveCapabilities: { textToVideo: true, imageToVideo: true, firstLastFrame: true },
    inputs: {
      aspect_ratio: { enum: ['16:9', '9:16', '1:1', '21:9'], default: '16:9' },
      resolution: { enum: ['720p', '1080p'], default: '1080p' },
      duration: { enum: [4, 6, 8, 10], default: 6 },
      fps: { enum: [24, 25, 30], default: 24 },
      audio: { type: 'boolean', default: false },
      seed: { type: 'number' },
    },
  },
  {
    id: 'veo-3.1',
    name: 'Veo 3.1',
    vendor: 'Google',
    kind: 'video',
    runtime: RUNTIME.API,
    status: STATUS.NOT_CONFIGURED,
    providerId: 'api',
    note: 'Requer o provedor Veo configurado.',
    modes: ['t2v', 'i2v'],
    inputs: {
      aspect_ratio: { enum: ['16:9', '9:16'], default: '16:9' },
      resolution: { enum: ['720p', '1080p'], default: '1080p' },
      duration: { enum: [4, 6, 8], default: 8 },
      fps: { enum: [24], default: 24 },
      audio: { type: 'boolean', default: true },
      seed: { type: 'number' },
    },
  },
  {
    id: 'kling',
    name: 'Kling',
    vendor: 'Kuaishou',
    kind: 'video',
    runtime: RUNTIME.API,
    status: STATUS.NOT_CONFIGURED,
    providerId: 'api',
    note: 'Requer o provedor Kling configurado.',
    modes: ['t2v', 'i2v', 'r2v'],
    inputs: {
      aspect_ratio: { enum: ['16:9', '9:16', '1:1'], default: '16:9' },
      resolution: { enum: ['720p', '1080p'], default: '720p' },
      duration: { enum: [5, 10], default: 5 },
      fps: { enum: [24, 30], default: 24 },
      audio: { type: 'boolean', default: false },
      seed: { type: 'number' },
    },
  },
  {
    id: 'seedance',
    name: 'Seedance',
    vendor: 'ByteDance',
    kind: 'video',
    runtime: RUNTIME.API,
    status: STATUS.NOT_CONFIGURED,
    providerId: 'api',
    note: 'Requer o provedor Seedance configurado.',
    modes: ['t2v', 'i2v'],
    inputs: {
      aspect_ratio: { enum: ['16:9', '9:16', '4:3', '3:4'], default: '16:9' },
      resolution: { enum: ['720p', '1080p'], default: '1080p' },
      duration: { enum: [5, 10, 15], default: 5 },
      fps: { enum: [24, 30], default: 24 },
      audio: { type: 'boolean', default: false },
      seed: { type: 'number' },
    },
  },
];

export const ALL_MODELS = [...IMAGE_MODELS, ...VIDEO_MODELS];

/**
 * Motores oferecidos na aba Cinema. A escolha é explícita para que nunca haja
 * dúvida se o que apareceu na tela foi gerado de verdade ou simulado.
 */
export const CINEMA_ENGINES = [
  {
    id: 'comfyui',
    label: 'MiniMax H3',
    sublabel: 'Local / ComfyUI',
    kind: 'real',
    kindLabel: 'real',
    modelId: 'minimax-h3',
    description: 'Gera o vídeo de verdade na sua GPU, pelo ComfyUI em 127.0.0.1:8188.',
  },
  {
    id: 'mock',
    label: 'Demonstração',
    sublabel: 'Mock',
    kind: 'simulated',
    kindLabel: 'simulado',
    modelId: 'minimax-h3',
    description: 'Pré-visualização desenhada localmente, sem tocar na GPU. Para desenvolvimento.',
  },
];

export function cinemaEngine(id) {
  return CINEMA_ENGINES.find((e) => e.id === id) || CINEMA_ENGINES[0];
}

export function getModel(id) {
  return ALL_MODELS.find((m) => m.id === id) || null;
}

export function modelsByKind(kind) {
  return ALL_MODELS.filter((m) => m.kind === kind);
}

export function availableModels(kind) {
  return modelsByKind(kind).filter((m) => m.status === STATUS.AVAILABLE);
}

export function defaultModel(kind) {
  return availableModels(kind)[0] || modelsByKind(kind)[0] || null;
}

export function runtimeLabel(model) {
  if (!model) return '—';
  return model.runtime === RUNTIME.LOCAL ? 'Local' : 'API';
}

export function statusLabel(model) {
  if (!model) return '—';
  return model.status === STATUS.AVAILABLE ? 'Disponível' : 'Não configurado';
}

export function inputDefault(model, key, fallback = null) {
  const spec = model?.inputs?.[key];
  if (!spec) return fallback;
  if (spec.default !== undefined) return spec.default;
  if (Array.isArray(spec.enum)) return spec.enum[0];
  return fallback;
}

export function inputEnum(model, key, fallback = []) {
  const spec = model?.inputs?.[key];
  return Array.isArray(spec?.enum) ? spec.enum : fallback;
}
