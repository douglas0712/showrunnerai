// Carga e patch do workflow API — tudo em memória.
//
// O arquivo original em WORKFLOW_PATH é aberto somente para leitura e nunca
// reescrito. Cada geração parte de uma cópia profunda do template.

import { readFile } from 'node:fs/promises';
import {
  ASPECT_TO_SELECTOR, DEFAULT_ASPECT, DEFAULT_QUALITY, FRAME_GRID, FRAME_NODE_IDS,
  GENERATION_MODES, MODE_LABELS, NODE_CLASSES, NODE_IDS, OUTPUT_PREFIX_DIR,
  QUALITY_TO_MEGAPIXELS, REQUIRED_MODEL_FILES, TRAINED_FRAME_RANGE, WORKFLOW_PATH,
} from './config.js';

export class WorkflowError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.detail = detail;
  }
}

/** Lê o workflow do disco. Somente leitura. */
export async function loadWorkflowTemplate(filePath = WORKFLOW_PATH) {
  // Só o nome do arquivo entra nas mensagens: elas viram log e interface, e o
  // caminho completo revelaria a estrutura de diretórios da máquina.
  const nome = filePath.split(/[\\/]/).pop() || filePath;

  let raw;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new WorkflowError(`Não foi possível ler o workflow "${nome}".`, { cause: error.code });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WorkflowError(`O workflow "${nome}" não é JSON válido.`);
  }

  validateWorkflow(parsed);
  return parsed;
}

/**
 * Confere que o grafo tem os nós esperados, com os class_type esperados, e que
 * os quatro arquivos do MiniMax H3 continuam referenciados. Divergiu, não
 * submetemos — é melhor falhar aqui do que enfileirar um grafo errado.
 */
export function validateWorkflow(graph) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new WorkflowError('O workflow precisa ser um objeto de nós (formato API).');
  }

  const faltando = [];
  const divergentes = [];

  for (const [nodeId, expectedClass] of Object.entries(NODE_CLASSES)) {
    const node = graph[nodeId];
    if (!node) {
      faltando.push(nodeId);
      continue;
    }
    if (node.class_type !== expectedClass) {
      divergentes.push({ nodeId, esperado: expectedClass, encontrado: node.class_type });
    }
  }

  if (faltando.length) {
    throw new WorkflowError(`O workflow não tem os nós esperados: ${faltando.join(', ')}.`, { faltando });
  }
  if (divergentes.length) {
    throw new WorkflowError('O workflow mudou de estrutura: class_type divergente.', { divergentes });
  }

  const modelosDivergentes = REQUIRED_MODEL_FILES.filter(
    (m) => graph[m.node]?.inputs?.[m.field] !== m.file,
  );
  if (modelosDivergentes.length) {
    throw new WorkflowError('O workflow aponta para arquivos de modelo diferentes dos esperados.', {
      modelosDivergentes: modelosDivergentes.map((m) => ({
        role: m.role,
        esperado: m.file,
        encontrado: graph[m.node]?.inputs?.[m.field] ?? null,
      })),
    });
  }

  return true;
}

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

/** Duração real que os frames produzem — pode diferir da pedida por causa da grade. */
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

/** Seed aleatória dentro da faixa que o ComfyUI aceita. */
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

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 48);
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

/**
 * Valor que o LoadImage espera.
 *
 * Quando a imagem está numa subpasta de `input/`, o ComfyUI identifica o
 * arquivo por `subpasta/nome` — foi assim que o `/upload/image` a devolveu.
 */
function caminhoDeEntrada(ref) {
  return ref.subfolder ? `${ref.subfolder}/${ref.name}` : ref.name;
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
