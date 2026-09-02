// Configuração da integração com o ComfyUI (fase 2 — somente aba Cinema).
//
// Este módulo só roda no servidor. O navegador nunca fala com o ComfyUI
// diretamente: ele chama as rotas internas em /api/comfy/*.

import path from 'node:path';

export const COMFY_BASE_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';

/** Workflow API de referência. É lido, nunca escrito. */
export const WORKFLOW_PATH =
  process.env.COMFY_WORKFLOW ||
  '/media/douglas/SSD2/comfyui_data/workflows/minimax_h3_t2v_api.json';

/** Raiz do armazenamento próprio do Showrunner Studio. */
export const RUNTIME_ROOT = path.join(process.cwd(), 'runtime', 'projects');

/**
 * Identificadores dos nós do workflow, confirmados contra
 * `minimax_h3_t2v_api.json` e contra /object_info do servidor.
 */
export const NODE_IDS = {
  save: '92',
  resolution: '115',
  prompt: '105:104',
  seed: '105:15',
  duration: '105:111',
  frames: '105:107',
  createVideo: '105:91',
  unet: '105:6',
  clip: '105:13',
  vaeVideo: '105:11',
  vaeAudio: '105:24',
};

/** class_type esperado em cada nó — se divergir, recusamos submeter. */
export const NODE_CLASSES = {
  [NODE_IDS.save]: 'SaveVideo',
  [NODE_IDS.resolution]: 'ResolutionSelector',
  [NODE_IDS.prompt]: 'MiniMaxH3ImageToVideo',
  [NODE_IDS.seed]: 'RandomNoise',
  [NODE_IDS.duration]: 'PrimitiveFloat',
  [NODE_IDS.frames]: 'ComfyMathExpression',
  [NODE_IDS.createVideo]: 'CreateVideo',
  [NODE_IDS.unet]: 'UNETLoader',
  [NODE_IDS.clip]: 'CLIPLoader',
  [NODE_IDS.vaeVideo]: 'VAELoader',
  [NODE_IDS.vaeAudio]: 'VAELoader',
};

/** Os quatro arquivos que o MiniMax H3 exige no servidor. */
export const REQUIRED_MODEL_FILES = [
  { node: NODE_IDS.unet, field: 'unet_name', file: 'minimax_h3_fl2va_pruned_int8_convrot.safetensors', role: 'Modelo de difusão (UNET)' },
  { node: NODE_IDS.clip, field: 'clip_name', file: 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors', role: 'CLIP / texto' },
  { node: NODE_IDS.vaeVideo, field: 'vae_name', file: 'minimax_h3_video_vae_fp16.safetensors', role: 'VAE de vídeo' },
  { node: NODE_IDS.vaeAudio, field: 'vae_name', file: 'minimax_h3_audio_vae_fp32.safetensors', role: 'VAE de áudio' },
];

/**
 * Grade de frames do modelo: o nó aceita `length` em passos de 17 a partir de 5
 * (17k + 5). O tooltip do /object_info indica faixa treinada de ~124 a ~362
 * frames a 24 fps — ou seja, aproximadamente 5 a 15 segundos.
 */
export const FRAME_GRID = { base: 5, step: 17, min: 5, max: 3600 };
export const TRAINED_FRAME_RANGE = { min: 124, max: 362 };

/** O modelo é nativo de 24 fps; a aba Cinema fixa esse valor na fase 2. */
export const NATIVE_FPS = 24;

/** Proporção do Showrunner → opção do ResolutionSelector. */
export const ASPECT_TO_SELECTOR = {
  '1:1': '1:1 (Square)',
  '2:3': '2:3 (Portrait Photo)',
  '3:2': '3:2 (Photo)',
  '3:4': '3:4 (Portrait Standard)',
  '4:3': '4:3 (Standard)',
  '9:16': '9:16 (Portrait Widescreen)',
  '16:9': '16:9 (Widescreen)',
  '21:9': '21:9 (Ultrawide)',
};

/**
 * Qualidade → megapixels do ResolutionSelector.
 * 0.4 MP é exatamente o valor do workflow testado; é o padrão para que a
 * primeira geração real reproduza o caminho já validado.
 */
export const QUALITY_TO_MEGAPIXELS = {
  '480p': 0.4,
  '720p': 0.9,
  '1080p': 2.1,
};

export const DEFAULT_QUALITY = '480p';
export const DEFAULT_ASPECT = '16:9';
export const DEFAULT_DURATION_SECONDS = 5.2;

/** Prefixo das saídas geradas por esta aplicação dentro do output do ComfyUI. */
export const OUTPUT_PREFIX_DIR = 'video/showrunner';

/**
 * Modos de geração do MiniMax H3.
 *
 * O nó `MiniMaxH3ImageToVideo` declara `first_frame` e `last_frame` como
 * entradas **opcionais** (confirmado em /object_info). Os três modos são o
 * mesmo nó com zero, uma ou duas imagens ligadas — por isso existe um único
 * workflow e um único pipeline, não três.
 */
export const GENERATION_MODES = {
  T2V: 't2v',
  I2V: 'i2v',
  FLF: 'flf',
};

export const MODE_LABELS = {
  [GENERATION_MODES.T2V]: 'Texto → vídeo',
  [GENERATION_MODES.I2V]: 'Imagem → vídeo',
  [GENERATION_MODES.FLF]: 'Primeiro e último quadro → vídeo',
};

/**
 * Identificadores dos nós LoadImage que esta aplicação acrescenta ao grafo.
 *
 * O prefixo `sr:` não colide com nada: o workflow usa números e o padrão
 * `105:N` do subgrafo expandido.
 */
export const FRAME_NODE_IDS = {
  first: 'sr:first_frame',
  last: 'sr:last_frame',
};

/** Subpasta dentro de `input/` do ComfyUI onde os quadros enviados ficam. */
export const UPLOAD_SUBFOLDER = 'showrunner';

/**
 * Formatos aceitos como quadro.
 *
 * `magic` é conferido nos bytes reais do arquivo: o `Content-Type` declarado
 * pelo navegador não é confiável e a extensão do nome, muito menos.
 */
export const ACCEPTED_IMAGE_TYPES = [
  { ext: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { ext: 'webp', mime: 'image/webp', magic: null }, // RIFF....WEBP — conferido à parte
];

/** Teto por quadro enviado. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Piso: abaixo disso não é imagem, é engano. */
export const MIN_UPLOAD_BYTES = 64;
