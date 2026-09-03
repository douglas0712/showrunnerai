// Descriptor do MiniMax H3 — a primeira implementação do contrato.
//
// Tudo que é específico deste modelo mora aqui: os identificadores dos nós, as
// classes esperadas, os quatro arquivos de modelo, a grade de frames, a
// tradução de proporção e qualidade, e o patch que aplica os parâmetros no
// grafo. A infraestrutura em descriptor.js e registry.js não conhece nada
// disto — é o que permite acrescentar um segundo workflow sem tocá-la.
//
// Este código veio de comfy/config.js e comfy/workflow.js sem mudança de
// comportamento. Aqueles dois arquivos passaram a reexportar daqui, para que
// nenhum chamador existente precise saber que a mudança aconteceu.

import {
  deepFreeze, defineWorkflow, validateGraphAgainst, WorkflowError,
} from './descriptor.js';

// ── identidade do grafo ─────────────────────────────────────────────────────

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

// ── parâmetros que o modelo aceita ──────────────────────────────────────────

/**
 * Grade de frames do modelo: o nó aceita `length` em passos de 17 a partir de 5
 * (17k + 5). O tooltip do /object_info indica faixa treinada de ~124 a ~362
 * frames a 24 fps — ou seja, aproximadamente 5 a 15 segundos.
 */
export const FRAME_GRID = { base: 5, step: 17, min: 5, max: 3600 };
export const TRAINED_FRAME_RANGE = { min: 124, max: 362 };

/** O modelo é nativo de 24 fps; a aba Cinema fixa esse valor. */
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

// As tabelas acima são lidas a cada geração por `patchWorkflow` e
// `validateWorkflow`. Congelá-las impede que uma alteração em tempo de
// execução — acidental ou não — passe a produzir grafos com nós errados sem
// que nada falhe visivelmente. `defineWorkflow` já congela nodeIds,
// nodeClasses e requiredModels; aqui completamos as que não passam por ele.
deepFreeze(ASPECT_TO_SELECTOR);
deepFreeze(QUALITY_TO_MEGAPIXELS);
deepFreeze(FRAME_GRID);
deepFreeze(TRAINED_FRAME_RANGE);
deepFreeze(GENERATION_MODES);
deepFreeze(MODE_LABELS);
deepFreeze(FRAME_NODE_IDS);

// ── conversões puras ────────────────────────────────────────────────────────

/**
 * Frames na grade do modelo (17k + 5), arredondando para cima.
 *
 * Espelha a expressão do nó ComfyMathExpression do workflow:
 *   max(5, round(a * fps)) + (5 - (max(5, round(a * fps)) % 17)) % 17
 */
export function computeFrames(durationSeconds, fps = 24) {
  const bruto = Math.max(FRAME_GRID.base, Math.round(Number(durationSeconds) * Number(fps)));
  const ajuste = (((FRAME_GRID.base - (bruto % FRAME_GRID.step)) % FRAME_GRID.step) + FRAME_GRID.step) % FRAME_GRID.step;
  const frames = bruto + ajuste;
  return Math.min(FRAME_GRID.max, frames);
}

/** Duração real que os frames produzem — pode diferir da pedida pela grade. */
export function framesToSeconds(frames, fps = 24) {
  return Number((frames / fps).toFixed(2));
}

export function isWithinTrainedRange(frames) {
  return frames >= TRAINED_FRAME_RANGE.min && frames <= TRAINED_FRAME_RANGE.max;
}

export function selectorForAspect(aspect) {
  const opcao = ASPECT_TO_SELECTOR[aspect];
  if (!opcao) {
    throw new WorkflowError(`Proporção não suportada: "${aspect}".`, {
      suportadas: Object.keys(ASPECT_TO_SELECTOR),
    });
  }
  return opcao;
}

export function megapixelsForQuality(quality) {
  const mp = QUALITY_TO_MEGAPIXELS[quality];
  if (!mp) {
    throw new WorkflowError(`Qualidade não suportada: "${quality}".`, {
      suportadas: Object.keys(QUALITY_TO_MEGAPIXELS),
    });
  }
  return mp;
}

/** Opção do ResolutionSelector → proporção do Showrunner. */
export function aspectFromSelector(opcao) {
  const par = Object.entries(ASPECT_TO_SELECTOR).find(([, v]) => v === opcao);
  return par ? par[0] : null;
}

/** Megapixels → rótulo de qualidade (o mais próximo, para tolerar float). */
export function qualityFromMegapixels(mp) {
  const alvo = Number(mp);
  if (!Number.isFinite(alvo)) return null;
  let melhor = null;
  let menorDiferenca = Infinity;
  for (const [rotulo, valor] of Object.entries(QUALITY_TO_MEGAPIXELS)) {
    const diferenca = Math.abs(valor - alvo);
    if (diferenca < menorDiferenca) {
      menorDiferenca = diferenca;
      melhor = rotulo;
    }
  }
  return menorDiferenca <= 0.05 ? melhor : `${alvo} MP`;
}

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 48);
}

// ── grafo ───────────────────────────────────────────────────────────────────

/**
 * Confere que o grafo tem os nós esperados, com os class_type esperados, e que
 * os quatro arquivos do MiniMax H3 continuam referenciados.
 *
 * A checagem em si é o motor genérico de descriptor.js; o que é do MiniMax são
 * as tabelas passadas para ele.
 */
export function validateWorkflow(graph) {
  return validateGraphAgainst(graph, {
    nodeClasses: NODE_CLASSES,
    requiredModels: REQUIRED_MODEL_FILES,
  });
}

/**
 * Referência a um quadro já enviado ao ComfyUI.
 * É o que o `/upload/image` devolve, conferido antes de virar nó.
 */
function assertFrameRef(ref, papel) {
  if (!ref || typeof ref !== 'object') {
    throw new WorkflowError(`Referência do ${papel} ausente.`);
  }
  if (typeof ref.name !== 'string' || !ref.name) {
    throw new WorkflowError(`O ${papel} não tem nome de arquivo no ComfyUI.`);
  }
  // O nome vem do próprio ComfyUI, mas conferimos assim mesmo: é o valor que
  // vai para dentro do grafo submetido.
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(ref.name)) {
    throw new WorkflowError(`Nome de arquivo inesperado para o ${papel}: "${ref.name}".`);
  }
  return ref;
}

/**
 * Valor que o LoadImage espera.
 *
 * Quando a imagem está numa subpasta de `input/`, o ComfyUI identifica o
 * arquivo por `subpasta/nome` — foi assim que o `/upload/image` a devolveu.
 */
function caminhoDeEntrada(ref) {
  return ref.subfolder ? `${ref.subfolder}/${ref.name}` : ref.name;
}

/**
 * Acrescenta os nós LoadImage e liga-os ao MiniMaxH3ImageToVideo.
 *
 * O nó do modelo declara `first_frame` e `last_frame` como entradas
 * **opcionais** — por isso o mesmo grafo serve aos três modos. Em t2v as
 * chaves simplesmente não existem; nada é removido nem substituído.
 *
 * Muta `graph`, que já é a cópia profunda feita por `patchWorkflow`.
 */
export function attachFrames(graph, { first = null, last = null } = {}) {
  const ligados = {};

  if (first) {
    const ref = assertFrameRef(first, 'primeiro quadro');
    graph[FRAME_NODE_IDS.first] = {
      class_type: 'LoadImage',
      _meta: { title: 'Primeiro quadro (Showrunner)' },
      inputs: { image: caminhoDeEntrada(ref) },
    };
    graph[NODE_IDS.prompt].inputs.first_frame = [FRAME_NODE_IDS.first, 0];
    ligados.first = ref;
  }

  if (last) {
    if (!first) {
      throw new WorkflowError('O último quadro exige o primeiro quadro.');
    }
    const ref = assertFrameRef(last, 'último quadro');
    graph[FRAME_NODE_IDS.last] = {
      class_type: 'LoadImage',
      _meta: { title: 'Último quadro (Showrunner)' },
      inputs: { image: caminhoDeEntrada(ref) },
    };
    graph[NODE_IDS.prompt].inputs.last_frame = [FRAME_NODE_IDS.last, 0];
    ligados.last = ref;
  }

  return ligados;
}

/** Modo lido de volta a partir de um grafo já submetido. */
export function modeFromGraph(graph) {
  const entradas = graph?.[NODE_IDS.prompt]?.inputs || {};
  const temPrimeiro = Boolean(entradas.first_frame);
  const temUltimo = Boolean(entradas.last_frame);
  if (temPrimeiro && temUltimo) return GENERATION_MODES.FLF;
  if (temPrimeiro) return GENERATION_MODES.I2V;
  return GENERATION_MODES.T2V;
}

/**
 * Reconstrói os parâmetros de uma geração a partir do grafo que o ComfyUI
 * guardou no histórico. É o que permite recuperar um resultado mesmo depois de
 * o servidor da aplicação ter reiniciado e perdido o registro em memória.
 */
export function metaFromSubmittedGraph(graph, jobId) {
  if (!graph || typeof graph !== 'object') return null;

  const prompt = graph[NODE_IDS.prompt]?.inputs?.prompt;
  const seed = graph[NODE_IDS.seed]?.inputs?.noise_seed;
  const duracao = graph[NODE_IDS.duration]?.inputs?.value;
  const fps = Number(graph[NODE_IDS.createVideo]?.inputs?.fps) || 24;
  const aspecto = aspectFromSelector(graph[NODE_IDS.resolution]?.inputs?.aspect_ratio);
  const megapixels = graph[NODE_IDS.resolution]?.inputs?.megapixels;

  if (typeof prompt !== 'string') return null;

  const frames = Number.isFinite(Number(duracao)) ? computeFrames(Number(duracao), fps) : null;
  const mode = modeFromGraph(graph);

  return {
    jobId,
    mode,
    modeLabel: MODE_LABELS[mode],
    prompt,
    seed: Number.isFinite(Number(seed)) ? Number(seed) : null,
    seedLocked: false,
    durationRequested: Number(duracao) || null,
    frames,
    durationActual: frames ? framesToSeconds(frames, fps) : null,
    withinTrainedRange: frames ? isWithinTrainedRange(frames) : null,
    aspect: aspecto || '16:9',
    quality: qualityFromMegapixels(megapixels) || '480p',
    megapixels: Number(megapixels) || null,
    fps,
    filenamePrefix: graph[NODE_IDS.save]?.inputs?.filename_prefix || null,
    model: `MiniMax H3 (${mode.toUpperCase()})`,
    costUsd: 0,
    recovered: true,
  };
}

/**
 * Devolve uma cópia do template com os parâmetros aplicados.
 *
 * @param {object} template  grafo lido do disco (NUNCA é mutado)
 * @param {object} opts
 * @returns {{graph: object, meta: object}}
 */
export function patchWorkflow(template, opts = {}) {
  const {
    prompt,
    seed = null,
    durationSeconds = 5.2,
    aspect = DEFAULT_ASPECT,
    quality = DEFAULT_QUALITY,
    fps = 24,
    jobId,
    frames: quadros = null,
  } = opts;

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new WorkflowError('O prompt cinematográfico está vazio.');
  }
  if (!jobId || !/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) {
    throw new WorkflowError(`jobId inválido: "${jobId}".`);
  }

  const duracao = Number(durationSeconds);
  if (!Number.isFinite(duracao) || duracao <= 0) {
    throw new WorkflowError(`Duração inválida: "${durationSeconds}".`);
  }

  validateWorkflow(template);

  // Cópia profunda: o template em memória e o arquivo em disco ficam intactos.
  const graph = structuredClone(template);

  const seedUsada = seed === null || seed === undefined || seed === '' ? randomSeed() : Number(seed);
  if (!Number.isInteger(seedUsada) || seedUsada < 0) {
    throw new WorkflowError(`Seed inválida: "${seed}".`);
  }

  const frames = computeFrames(duracao, fps);
  const filenamePrefix = `${OUTPUT_PREFIX_DIR}/${jobId}`;

  graph[NODE_IDS.prompt].inputs.prompt = prompt.trim();
  graph[NODE_IDS.seed].inputs.noise_seed = seedUsada;
  graph[NODE_IDS.duration].inputs.value = duracao;
  graph[NODE_IDS.resolution].inputs.aspect_ratio = selectorForAspect(aspect);
  graph[NODE_IDS.resolution].inputs.megapixels = megapixelsForQuality(quality);
  graph[NODE_IDS.createVideo].inputs.fps = Number(fps);
  graph[NODE_IDS.save].inputs.filename_prefix = filenamePrefix;

  // Os quadros entram por último: em t2v nada é acrescentado e o grafo fica
  // idêntico ao que a aba Cinema já submetia.
  const ligados = attachFrames(graph, quadros || {});
  const mode = modeFromGraph(graph);

  return {
    graph,
    meta: {
      mode,
      modeLabel: MODE_LABELS[mode],
      frameFirst: ligados.first ? caminhoDeEntrada(ligados.first) : null,
      frameLast: ligados.last ? caminhoDeEntrada(ligados.last) : null,
      jobId,
      prompt: prompt.trim(),
      seed: seedUsada,
      seedLocked: seed !== null && seed !== undefined && seed !== '',
      durationRequested: duracao,
      frames,
      durationActual: framesToSeconds(frames, fps),
      withinTrainedRange: isWithinTrainedRange(frames),
      aspect,
      quality,
      megapixels: megapixelsForQuality(quality),
      fps: Number(fps),
      filenamePrefix,
      model: `MiniMax H3 (${mode.toUpperCase()})`,
      costUsd: 0,
    },
  };
}

// ── o descriptor ────────────────────────────────────────────────────────────

export const minimaxH3T2V = defineWorkflow({
  id: 'minimax_h3_t2v',
  label: 'MiniMax H3 — texto, imagem e primeiro/último quadro → vídeo',
  kind: 'video',
  file: 'minimax_h3_t2v_api.json',
  // Compatibilidade: quem já tem COMFY_WORKFLOW apontando para um arquivo
  // completo continua funcionando exatamente como antes desta etapa.
  legacyPathEnv: 'COMFY_WORKFLOW',
  nodeIds: NODE_IDS,
  nodeClasses: NODE_CLASSES,
  requiredModels: REQUIRED_MODEL_FILES,
  outputPrefix: OUTPUT_PREFIX_DIR,
  nativeFps: NATIVE_FPS,
  modes: Object.values(GENERATION_MODES),
  validate: validateWorkflow,
  patch: patchWorkflow,
  metaFromGraph: metaFromSubmittedGraph,
});

/** Caminho do workflow do MiniMax — derivado, não mais uma verdade global. */
export const WORKFLOW_PATH = minimaxH3T2V.resolvePath();

export { WorkflowError };
