// Descriptor do Ideogram 4 — o segundo workflow nativo, e o primeiro de imagem.
//
// Todo conhecimento deste modelo mora aqui: identificadores de nó, classes
// esperadas, arquivos de modelo, tabela de qualidade e o patch. A
// infraestrutura em descriptor.js, registry.js e provider.js continua sem
// saber que o Ideogram existe — o que o pipeline consulta é `kind`.
//
// ── Procedência do grafo ────────────────────────────────────────────────────
//
// O template em `workflows/ideogram4_t2i_api.json` é uma cópia controlada do
// pipeline validado à mão fora do projeto. A cópia removeu 10 nós que NÃO são
// alcançáveis a partir do SaveImage — uma cadeia de "magic prompt"
// (PrimitiveStringMultiline → StringReplace) que alimentava apenas nós
// PreviewAny. Eles não podiam influenciar a imagem, mas o PreviewAny é um nó de
// saída no ComfyUI: mantê-los faria o servidor executar a cadeia inteira a cada
// geração, sem efeito, e acrescentaria uma superfície de falha. O subgrafo que
// produz a imagem ficou byte a byte idêntico ao validado.
//
// O prompt real é o `text` LITERAL do nó 98:24 (CLIPTextEncode) — confirmado
// no JSON: ele não recebe link daquela cadeia removida.

import { defineWorkflow, validateGraphAgainst, WorkflowError } from './descriptor.js';
import {
  aspectFromSelector, ASPECT_TO_SELECTOR, megapixelsForQuality, qualityFromMegapixels,
  selectorForAspect,
} from './resolutionSelector.js';

// ── identidade do grafo ─────────────────────────────────────────────────────

/** Nós lidos do workflow real; nenhum inferido. */
export const NODE_IDS = {
  prompt: '98:24',
  seed: '98:18',
  resolution: '37',
  save: '158',
  clip: '98:14',
  vae: '98:9',
  unet: '98:23',
  unetNegative: '98:154',
  sampler: '98:16',
  scheduler: '98:17',
  guider: '98:155',
};

export const NODE_CLASSES = {
  [NODE_IDS.prompt]: 'CLIPTextEncode',
  [NODE_IDS.seed]: 'RandomNoise',
  [NODE_IDS.resolution]: 'ResolutionSelector',
  [NODE_IDS.save]: 'SaveImage',
  [NODE_IDS.clip]: 'CLIPLoader',
  [NODE_IDS.vae]: 'VAELoader',
  [NODE_IDS.unet]: 'UNETLoader',
  [NODE_IDS.unetNegative]: 'UNETLoader',
  [NODE_IDS.sampler]: 'KSamplerSelect',
  [NODE_IDS.scheduler]: 'Ideogram4Scheduler',
  [NODE_IDS.guider]: 'DualModelGuider',
};

/**
 * Os arquivos que o Ideogram 4 exige no servidor.
 *
 * O grafo usa DOIS UNETLoader — o `DualModelGuider` recebe um modelo positivo
 * e um negativo — e ambos apontam para o mesmo arquivo. Os dois entram na
 * lista: se um for trocado, o grafo mudou de estrutura.
 */
export const REQUIRED_MODEL_FILES = [
  { node: NODE_IDS.unet, field: 'unet_name', file: 'ideogram4_nvfp4_mixed.safetensors', role: 'Modelo de difusão (UNET)' },
  { node: NODE_IDS.unetNegative, field: 'unet_name', file: 'ideogram4_nvfp4_mixed.safetensors', role: 'Modelo de difusão (UNET negativo)' },
  { node: NODE_IDS.clip, field: 'clip_name', file: 'qwen3vl_8b_nvfp4.safetensors', role: 'CLIP / texto' },
  { node: NODE_IDS.vae, field: 'vae_name', file: 'flux2-vae.safetensors', role: 'VAE' },
];

// ── parâmetros aceitos ──────────────────────────────────────────────────────

/**
 * Qualidade → megapixels do ResolutionSelector.
 *
 * 1.0 MP é exatamente o valor do workflow validado; é o padrão para que a
 * primeira geração real reproduza o caminho já testado à mão.
 */
export const QUALITY_TO_MEGAPIXELS = {
  '1K': 1.0,
  '2K': 2.0,
  '4K': 4.0,
};

export const DEFAULT_QUALITY = '1K';
export const DEFAULT_ASPECT = '16:9';

/** Prefixo das saídas deste workflow dentro do output do ComfyUI. */
export const OUTPUT_PREFIX_DIR = 'image/showrunner';

/** Teto do prompt. O nó aceita texto livre; o limite é nosso, não dele. */
const MAX_PROMPT = 4000;

export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 48);
}

// ── validação ───────────────────────────────────────────────────────────────

export function validateWorkflow(graph) {
  return validateGraphAgainst(graph, {
    nodeClasses: NODE_CLASSES,
    requiredModels: REQUIRED_MODEL_FILES,
  });
}

// ── grafo ───────────────────────────────────────────────────────────────────

/**
 * Devolve uma cópia do template com os parâmetros aplicados.
 *
 * Cinco entradas são tocadas, todas de nós que este descriptor declara:
 * o texto do prompt, a seed, a proporção, os megapixels e o prefixo do arquivo
 * de saída. Nada mais do grafo é alterado — sampler, scheduler, CFG e o
 * DualModelGuider ficam como foram validados.
 *
 * @param {object} template  grafo lido do disco (NUNCA é mutado)
 * @returns {{graph: object, meta: object}}
 */
export function patchWorkflow(template, opts = {}) {
  const {
    prompt,
    seed = null,
    aspect = DEFAULT_ASPECT,
    quality = DEFAULT_QUALITY,
    jobId,
  } = opts;

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new WorkflowError('O prompt da imagem está vazio.');
  }
  if (prompt.length > MAX_PROMPT) {
    throw new WorkflowError(`O prompt excede ${MAX_PROMPT} caracteres.`);
  }
  if (!jobId || !/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) {
    throw new WorkflowError(`jobId inválido: "${jobId}".`);
  }

  validateWorkflow(template);

  // Cópia profunda: o template em memória e o arquivo em disco ficam intactos.
  const graph = structuredClone(template);

  const seedUsada = seed === null || seed === undefined || seed === '' ? randomSeed() : Number(seed);
  if (!Number.isInteger(seedUsada) || seedUsada < 0) {
    throw new WorkflowError(`Seed inválida: "${seed}".`);
  }

  // A proporção passa pela allowlist do nó; o caller informa "16:9", nunca o
  // rótulo interno que o ResolutionSelector espera.
  const seletor = selectorForAspect(aspect);
  const megapixels = megapixelsForQuality(quality, QUALITY_TO_MEGAPIXELS);
  const filenamePrefix = `${OUTPUT_PREFIX_DIR}/${jobId}`;

  graph[NODE_IDS.prompt].inputs.text = prompt.trim();
  graph[NODE_IDS.seed].inputs.noise_seed = seedUsada;
  graph[NODE_IDS.resolution].inputs.aspect_ratio = seletor;
  graph[NODE_IDS.resolution].inputs.megapixels = megapixels;
  graph[NODE_IDS.save].inputs.filename_prefix = filenamePrefix;

  return {
    graph,
    meta: {
      mode: 't2i',
      modeLabel: 'Texto → imagem',
      jobId,
      prompt: prompt.trim(),
      seed: seedUsada,
      seedLocked: seed !== null && seed !== undefined && seed !== '',
      aspect,
      quality,
      megapixels,
      filenamePrefix,
      model: 'Ideogram 4',
      costUsd: 0,
    },
  };
}

/**
 * Reconstrói os parâmetros a partir do grafo que o ComfyUI guardou no
 * histórico — é o que permite adotar um resultado depois de o servidor ter
 * reiniciado e perdido o registro em memória.
 */
export function metaFromSubmittedGraph(graph, jobId) {
  if (!graph || typeof graph !== 'object') return null;

  const prompt = graph[NODE_IDS.prompt]?.inputs?.text;
  if (typeof prompt !== 'string') return null;

  const seed = graph[NODE_IDS.seed]?.inputs?.noise_seed;
  const megapixels = graph[NODE_IDS.resolution]?.inputs?.megapixels;
  const aspecto = aspectFromSelector(graph[NODE_IDS.resolution]?.inputs?.aspect_ratio);

  return {
    jobId,
    mode: 't2i',
    modeLabel: 'Texto → imagem',
    prompt,
    seed: Number.isFinite(Number(seed)) ? Number(seed) : null,
    seedLocked: false,
    aspect: aspecto || DEFAULT_ASPECT,
    quality: qualityFromMegapixels(megapixels, QUALITY_TO_MEGAPIXELS) || DEFAULT_QUALITY,
    megapixels: Number(megapixels) || null,
    filenamePrefix: graph[NODE_IDS.save]?.inputs?.filename_prefix || null,
    model: 'Ideogram 4',
    costUsd: 0,
    recovered: true,
  };
}

// ── o descriptor ────────────────────────────────────────────────────────────

export const ideogram4T2I = defineWorkflow({
  id: 'ideogram4_t2i',
  label: 'Ideogram 4 — texto → imagem',
  kind: 'image',
  file: 'ideogram4_t2i_api.json',
  // Este workflow é do Showrunner: mora em `workflows/`, versionado com o
  // código, e não depende do diretório externo onde foi validado.
  rootName: 'project',
  nodeIds: NODE_IDS,
  nodeClasses: NODE_CLASSES,
  requiredModels: REQUIRED_MODEL_FILES,
  outputPrefix: OUTPUT_PREFIX_DIR,
  modes: ['t2i'],
  aspects: Object.keys(ASPECT_TO_SELECTOR),
  qualities: Object.keys(QUALITY_TO_MEGAPIXELS),
  validate: validateWorkflow,
  patch: patchWorkflow,
  metaFromGraph: metaFromSubmittedGraph,
});

export { WorkflowError };
