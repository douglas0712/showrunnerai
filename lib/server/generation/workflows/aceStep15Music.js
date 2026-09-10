// ACE-Step 1.5 turbo — intenção musical → trilha.
//
// PASSO 14-D2B. É o segundo workflow de áudio do Showrunner, e o primeiro que
// produz MÚSICA.
//
// ── Por que não reaproveitar o Stable Audio do SFX ─────────────────────────
//
// Porque são modelos para problemas diferentes, e a diferença é mensurável:
// `EmptyLatentAudio` do Stable Audio Open tem janela treinada de ~47 s, contra
// 120 s de default aqui; e o próprio fornecedor separa "Music" de "SFX" nos
// blueprints da versão 3, que é a que teria trilha. Reusar o que já estava
// instalado seria escolher por conveniência — o efeito de porta batendo e o
// tema que atravessa três cenas não são o mesmo trabalho.
//
// O ACE-Step traz o que a música pede: VAE musical dedicada, codificador de
// letra, e vocabulário de tags/BPM/tonalidade.
//
// ── A terceira origem de `kind='audio'` ────────────────────────────────────
//
//     narração  → Piper,    workflow narration-tts    (não resolve no registry)
//     efeito    → ComfyUI,  workflow stable_audio_sfx
//     música    → ComfyUI,  workflow ace_step_15_music
//
// Nada rotea por `kind`. Quem distingue é o `workflowId`, e é por isso que este
// arquivo entra sem tocar em `reconcile.js`: o descriptor existir no registry
// já é a resposta que a reconciliação do ComfyUI procura.
//
// ── Instrumental ───────────────────────────────────────────────────────────
//
// `lyrics` fica vazio, sempre. Não há domínio de letra no Showrunner e não é
// este passo que o cria — uma trilha de cena é underscore, e o campo existe no
// nó porque o modelo também canta.

import { defineWorkflow, validateGraphAgainst, WorkflowError } from './descriptor.js';

/**
 * Os nós do grafo, por id.
 *
 * A topologia é a do blueprint oficial que o ComfyUI traz nesta instalação —
 * `blueprints/Text to Audio (ACE-Step 1.5).json` —, reproduzida em formato API
 * e validada contra o executor antes de existir integração.
 */
export const NODE_IDS = Object.freeze({
  unet: '1',
  sampling: '2',
  clip: '3',
  vae: '4',
  positive: '5',
  negative: '6',
  latent: '7',
  sampler: '8',
  decode: '9',
  save: '10',
});

export const NODE_CLASSES = Object.freeze({
  [NODE_IDS.unet]: 'UNETLoader',
  [NODE_IDS.sampling]: 'ModelSamplingAuraFlow',
  [NODE_IDS.clip]: 'DualCLIPLoader',
  [NODE_IDS.vae]: 'VAELoader',
  [NODE_IDS.positive]: 'TextEncodeAceStepAudio1.5',
  [NODE_IDS.negative]: 'ConditioningZeroOut',
  [NODE_IDS.latent]: 'EmptyAceStep1.5LatentAudio',
  [NODE_IDS.sampler]: 'KSampler',
  [NODE_IDS.decode]: 'VAEDecodeAudio',
  [NODE_IDS.save]: 'SaveAudio',
});

/** Os arquivos que precisam existir na instalação para este workflow rodar. */
export const REQUIRED_MODEL_FILES = Object.freeze([
  {
    node: NODE_IDS.unet,
    field: 'unet_name',
    file: 'acestep_v1.5_turbo.safetensors',
    role: 'Modelo de difusão musical',
  },
  {
    node: NODE_IDS.clip,
    field: 'clip_name1',
    file: 'qwen_0.6b_ace15.safetensors',
    role: 'Codificador de texto (0.6B)',
  },
  {
    node: NODE_IDS.clip,
    field: 'clip_name2',
    file: 'qwen_4b_ace15.safetensors',
    role: 'Codificador de texto (4B)',
  },
  {
    node: NODE_IDS.vae,
    field: 'vae_name',
    file: 'ace_1.5_vae.safetensors',
    role: 'VAE musical',
  },
]);

/** Prefixo das saídas deste workflow dentro do output do ComfyUI. */
export const OUTPUT_PREFIX_DIR = 'music';

/** Quanto dura uma peça, por padrão. Decisão TÉCNICA, não de domínio. */
export const DEFAULT_SECONDS = 60;

/** O teto do nó. Bem acima do que uma cue precisa. */
export const MAX_SECONDS = 240;

export function validateWorkflow(graph) {
  return validateGraphAgainst(graph, {
    nodeClasses: NODE_CLASSES,
    requiredModels: REQUIRED_MODEL_FILES,
  });
}

/**
 * Escreve o pedido no grafo.
 *
 * `prompt` é a descrição da CUE, resolvida do banco por quem chama — este
 * módulo não sabe o que é um projeto nem uma cue, e nunca recebe texto vindo de
 * fora do servidor. Ver `startProductionMusicGeneration`.
 *
 * `durationSeconds` entra em DOIS lugares que precisam concordar: o latente diz
 * quanto áudio existe, e o codificador de texto diz ao modelo qual duração ele
 * está compondo. Escrever num só produz uma peça com o comprimento certo e a
 * estrutura pensada para outro — tipicamente, um final que não fecha.
 */
export function patchWorkflow(template, opts = {}) {
  const {
    jobId,
    prompt,
    durationSeconds = DEFAULT_SECONDS,
    seed = null,
  } = opts;

  const texto = String(prompt ?? '').trim();
  if (!texto) {
    throw new WorkflowError('A geração musical exige uma descrição.', { campo: 'description' });
  }
  if (!jobId) {
    throw new WorkflowError('A geração musical exige jobId.', { campo: 'jobId' });
  }

  const duracao = Number(durationSeconds ?? DEFAULT_SECONDS);
  if (!Number.isFinite(duracao) || duracao <= 0 || duracao > MAX_SECONDS) {
    throw new WorkflowError(
      `Duração musical inválida: ${durationSeconds}. Use de 1 a ${MAX_SECONDS} segundos.`,
      { durationSeconds, limite: MAX_SECONDS },
    );
  }

  validateWorkflow(template);
  const graph = JSON.parse(JSON.stringify(template));

  graph[NODE_IDS.positive].inputs.tags = texto;
  // Sempre vazio: underscore instrumental, e nenhum domínio de letra.
  graph[NODE_IDS.positive].inputs.lyrics = '';
  graph[NODE_IDS.positive].inputs.duration = duracao;
  graph[NODE_IDS.latent].inputs.seconds = duracao;

  // A seed é do servidor quando não vem: fixa, toda regeneração devolveria a
  // MESMA peça, e "gere outra" deixaria de significar alguma coisa.
  const seedUsada = seed !== null && seed !== undefined && seed !== '' && Number.isFinite(Number(seed))
    ? Number(seed)
    : Math.floor(Math.random() * 2 ** 31);
  graph[NODE_IDS.positive].inputs.seed = seedUsada;
  graph[NODE_IDS.sampler].inputs.seed = seedUsada;

  const filenamePrefix = `${OUTPUT_PREFIX_DIR}/${jobId}`;
  graph[NODE_IDS.save].inputs.filename_prefix = filenamePrefix;

  return {
    graph,
    meta: {
      mode: 't2m',
      modeLabel: 'Intenção → trilha musical',
      jobId,
      prompt: texto,
      seed: seedUsada,
      seedLocked: seed !== null && seed !== undefined && seed !== '',
      durationSeconds: duracao,
      filenamePrefix,
      model: 'ACE-Step 1.5 turbo',
      costUsd: 0,
    },
  };
}

/** O que dá para recuperar de um grafo já submetido, para a tela e o log. */
export function metaFromSubmittedGraph(graph, { jobId } = {}) {
  if (!graph || typeof graph !== 'object') return null;
  return {
    jobId,
    mode: 't2m',
    modeLabel: 'Intenção → trilha musical',
    prompt: graph[NODE_IDS.positive]?.inputs?.tags || null,
    seed: Number(graph[NODE_IDS.sampler]?.inputs?.seed) || null,
    seedLocked: false,
    durationSeconds: Number(graph[NODE_IDS.latent]?.inputs?.seconds) || null,
    filenamePrefix: graph[NODE_IDS.save]?.inputs?.filename_prefix || null,
    model: 'ACE-Step 1.5 turbo',
    costUsd: 0,
    recovered: true,
  };
}

// ── o descriptor ────────────────────────────────────────────────────────────

export const aceStep15Music = defineWorkflow({
  id: 'ace_step_15_music',
  label: 'ACE-Step 1.5 — intenção → trilha musical',
  kind: 'audio',
  file: 'ace_step_15_music_api.json',
  rootName: 'project',
  nodeIds: NODE_IDS,
  nodeClasses: NODE_CLASSES,
  requiredModels: REQUIRED_MODEL_FILES,
  outputPrefix: OUTPUT_PREFIX_DIR,
  modes: ['t2m'],
  validate: validateWorkflow,
  patch: patchWorkflow,
  metaFromGraph: metaFromSubmittedGraph,
});

export { WorkflowError };
