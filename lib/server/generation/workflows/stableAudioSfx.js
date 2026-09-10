// Stable Audio Open 1.0 — descrição de efeito sonoro → áudio.
//
// PASSO 14-D1B. É o primeiro workflow de ÁUDIO do Showrunner, e o primeiro que
// não produz imagem nem vídeo.
//
// ── Por que ComfyUI aqui, e não um binário como no TTS ─────────────────────
//
// Porque desta vez o executor JÁ ESTAVA instalado. O ComfyUI desta máquina traz
// suporte nativo a Stable Audio — `CLIPLoader` aceita `type: "stable_audio"`,
// e `ConditioningStableAudio` e `VAEDecodeAudio` são nós de base, sem custom
// node nenhum. O que faltava eram os pesos.
//
// É o oposto da narração: lá o ComfyUI só tinha nós de voz `api_node: true`
// (nuvem paga), e o que existia local era um binário — por isso o Piper ganhou
// uma fronteira própria. Aqui o caminho barato é o que já existe, e usá-lo
// significa herdar de graça submissão, `providerJobId`, histórico, fila,
// reconciliação e publicação de Asset.
//
// ── A consequência que isto cria ───────────────────────────────────────────
//
// A partir daqui existem DUAS origens de `generation_jobs.kind = 'audio'`:
//
//     narração  → Piper, processo filho, sem identidade durável
//     efeito    → ComfyUI, com providerJobId, fila e histórico
//
// Nenhum roteamento pode continuar decidindo por `kind`. Quem distingue é o
// `workflowId`: um job cujo workflow resolve NESTE registry é do ComfyUI; um
// que não resolve é da narração. Ver `reconcile.js` e `narration.js`.

import { defineWorkflow, validateGraphAgainst, WorkflowError } from './descriptor.js';

/**
 * Os nós do grafo, por id.
 *
 * O grafo é o exportado em formato API de `workflows/stable_audio_sfx_api.json`,
 * e estes ids são o contrato entre o arquivo e este módulo: mudar um id no
 * arquivo sem mudar aqui faz a validação falhar na carga, e não numa geração.
 */
export const NODE_IDS = Object.freeze({
  checkpoint: '1',
  clip: '2',
  positive: '3',
  negative: '4',
  latent: '5',
  janela: '6',
  sampler: '7',
  decode: '8',
  save: '9',
});

export const NODE_CLASSES = Object.freeze({
  [NODE_IDS.checkpoint]: 'CheckpointLoaderSimple',
  [NODE_IDS.clip]: 'CLIPLoader',
  [NODE_IDS.positive]: 'CLIPTextEncode',
  [NODE_IDS.negative]: 'CLIPTextEncode',
  [NODE_IDS.latent]: 'EmptyLatentAudio',
  [NODE_IDS.janela]: 'ConditioningStableAudio',
  [NODE_IDS.sampler]: 'KSampler',
  [NODE_IDS.decode]: 'VAEDecodeAudio',
  [NODE_IDS.save]: 'SaveAudio',
});

/** Os arquivos que precisam existir na instalação para este workflow rodar. */
export const REQUIRED_MODEL_FILES = Object.freeze([
  {
    node: NODE_IDS.checkpoint,
    field: 'ckpt_name',
    file: 'stable_audio_open_1.0.safetensors',
    role: 'Modelo de difusão de áudio',
  },
  {
    node: NODE_IDS.clip,
    field: 'clip_name',
    file: 't5_base.safetensors',
    role: 'Codificador de texto (T5)',
  },
]);

/** Prefixo das saídas deste workflow dentro do output do ComfyUI. */
export const OUTPUT_PREFIX_DIR = 'sfx';

/**
 * O que NÃO se pede a este workflow.
 *
 * Nada de voz, nada de música, e é o negativo que segura isso. Stable Audio
 * Open faz efeito e gravação de campo, mas um prompt ambíguo pode escorregar
 * para melodia — e uma cue de "porta batendo" com trilha atrás é inútil para
 * quem vai montar o som da cena.
 */
export const NEGATIVE_PADRAO = 'speech, voice, dialogue, music, melody, singing';

/** Quanto dura, no máximo, um efeito. O modelo foi treinado até ~47 s. */
export const MAX_SECONDS = 47;

/** Quanto dura por padrão. Um efeito pontual é curto; o resto é silêncio. */
export const DEFAULT_SECONDS = 6;

export function validateWorkflow(graph) {
  return validateGraphAgainst(graph, {
    nodeClasses: NODE_CLASSES,
    requiredModels: REQUIRED_MODEL_FILES,
  });
}

/**
 * Escreve o pedido no grafo.
 *
 * `description` é o texto da CUE, e chega aqui já resolvido do banco — este
 * módulo não sabe o que é uma cena nem uma cue, e nunca recebe texto de quem
 * chama a API. Ver `startSceneSfxGeneration`.
 *
 * `seconds` entra em DOIS lugares, e os dois precisam concordar: o latente
 * define quanto áudio existe, e `ConditioningStableAudio` diz ao modelo qual
 * janela temporal ele está preenchendo. Escrever num só produziria um trecho
 * com a duração certa e o conteúdo condicionado para outra — tipicamente,
 * silêncio no fim.
 */
export function patchWorkflow(template, opts = {}) {
  const {
    jobId,
    // `prompt` e `durationSeconds` são os nomes que `submitGeneration` já
    // entrega a todo descriptor. Reusá-los é o que faz o efeito sonoro entrar
    // pelo caminho de submissão que já existe, sem um segundo vocabulário de
    // parâmetros para manter em dia.
    prompt,
    durationSeconds = DEFAULT_SECONDS,
    seed = null,
    negative = NEGATIVE_PADRAO,
  } = opts;

  const texto = String(prompt ?? '').trim();
  if (!texto) {
    throw new WorkflowError('A geração de efeito exige uma descrição.', { campo: 'description' });
  }
  if (!jobId) {
    throw new WorkflowError('A geração de efeito exige jobId.', { campo: 'jobId' });
  }

  const duracao = Number(durationSeconds ?? DEFAULT_SECONDS);
  if (!Number.isFinite(duracao) || duracao <= 0 || duracao > MAX_SECONDS) {
    throw new WorkflowError(
      `Duração de efeito inválida: ${durationSeconds}. Use de 1 a ${MAX_SECONDS} segundos.`,
      { durationSeconds, limite: MAX_SECONDS },
    );
  }

  validateWorkflow(template);
  const graph = JSON.parse(JSON.stringify(template));

  graph[NODE_IDS.positive].inputs.text = texto;
  graph[NODE_IDS.negative].inputs.text = String(negative ?? NEGATIVE_PADRAO);
  graph[NODE_IDS.latent].inputs.seconds = duracao;
  graph[NODE_IDS.janela].inputs.seconds_start = 0;
  graph[NODE_IDS.janela].inputs.seconds_total = duracao;

  // A seed é do servidor quando não vem: uma seed fixa faria toda regeneração
  // devolver o MESMO efeito, e "gere outro" deixaria de significar alguma coisa.
  const seedUsada = seed !== null && seed !== undefined && seed !== '' && Number.isFinite(Number(seed))
    ? Number(seed)
    : Math.floor(Math.random() * 2 ** 31);
  graph[NODE_IDS.sampler].inputs.seed = seedUsada;

  // O prefixo carrega o jobId, e é assim que o resultado é reencontrado no
  // /history e no disco — o mesmo mecanismo de imagem e vídeo.
  const filenamePrefix = `${OUTPUT_PREFIX_DIR}/${jobId}`;
  graph[NODE_IDS.save].inputs.filename_prefix = filenamePrefix;

  return {
    graph,
    meta: {
      mode: 't2a',
      modeLabel: 'Descrição → efeito sonoro',
      jobId,
      prompt: texto,
      seed: seedUsada,
      seedLocked: seed !== null && seed !== undefined && seed !== '',
      durationSeconds: duracao,
      filenamePrefix,
      model: 'Stable Audio Open 1.0',
      costUsd: 0,
    },
  };
}

/** O que dá para recuperar de um grafo já submetido, para a tela e o log. */
export function metaFromSubmittedGraph(graph, { jobId } = {}) {
  if (!graph || typeof graph !== 'object') return null;
  return {
    jobId,
    mode: 't2a',
    modeLabel: 'Descrição → efeito sonoro',
    prompt: graph[NODE_IDS.positive]?.inputs?.text || null,
    seed: Number(graph[NODE_IDS.sampler]?.inputs?.seed) || null,
    seedLocked: false,
    seconds: Number(graph[NODE_IDS.latent]?.inputs?.seconds) || null,
    filenamePrefix: graph[NODE_IDS.save]?.inputs?.filename_prefix || null,
    model: 'Stable Audio Open 1.0',
    costUsd: 0,
    recovered: true,
  };
}

// ── o descriptor ────────────────────────────────────────────────────────────

export const stableAudioSfx = defineWorkflow({
  id: 'stable_audio_sfx',
  label: 'Stable Audio Open — descrição → efeito sonoro',
  kind: 'audio',
  file: 'stable_audio_sfx_api.json',
  // Do Showrunner: mora em `workflows/`, versionado junto com o código.
  rootName: 'project',
  nodeIds: NODE_IDS,
  nodeClasses: NODE_CLASSES,
  requiredModels: REQUIRED_MODEL_FILES,
  outputPrefix: OUTPUT_PREFIX_DIR,
  modes: ['t2a'],
  validate: validateWorkflow,
  patch: patchWorkflow,
  metaFromGraph: metaFromSubmittedGraph,
});

export { WorkflowError };
