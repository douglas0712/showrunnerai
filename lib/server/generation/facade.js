// Generation Facade — abstração de alto nível sobre o provider ComfyUI.
//
// As tools do agente NÃO falam diretamente com o ComfyUI provider.
// Essa facade encapsula a lógica de submissão, capacidade padrão, integração
// com Asset, e garante que o agente continua agnóstico de ComfyUI/workflow/nó.
//
// O Agent conhece apenas:
// - startImageGeneration(prompt, aspect, seed)
// - startVideoGeneration(prompt, aspect, duration, seed, sourceAssetId)
// - getGenerationJob(jobId)
//
// A facade conhece:
// - qual capacity usar (Ideogram 4 para imagem, MiniMax para vídeo)
// - workflow interna
// - submissão ao ComfyUI
// - finalização + Asset

import { submitGeneration } from '../comfy/provider.js';
import { getJob } from '../comfy/jobs.js';
import { getAsset, findAssetsByJob } from '../domain/index.js';
import { DomainError } from '../domain/db.js';
import { STATES } from '../comfy/status.js';

/** Erro de geração (não de submissão). */
export class GenerationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'GenerationError';
    this.detail = detail;
  }
}

/**
 * Normaliza o estado de um job para um valor público.
 *
 * Job interno usa 'state' (fonte de verdade).
 * Campo legado 'status' nunca é usado; ignorado se presente.
 * Retorna o estado normalizando apenas valores conhecidos.
 */
function normalizeJobState(job) {
  const internalState = job.state || 'unknown';

  // Estados válidos conhecidos do STATES mapping
  if (internalState === STATES.PREPARING) return 'preparando';
  if (internalState === STATES.SUBMITTED) return 'enviado';
  if (internalState === STATES.QUEUED) return 'na-fila';
  if (internalState === STATES.GENERATING) return 'gerando';
  if (internalState === STATES.DECODING) return 'decodificando';
  if (internalState === STATES.SAVING) return 'salvando';
  if (internalState === STATES.DONE) return 'concluido';
  if (internalState === STATES.FAILED) return 'falhou';
  if (internalState === STATES.CANCELLED) return 'cancelado';

  return internalState;
}

/** Capacidade padrão para imagem neste release. */
const IMAGEM_WORKFLOW = 'ideogram4_t2i';

/** Capacidade padrão para vídeo neste release. */
const VÍDEO_WORKFLOW = 'minimax_h3_t2v';

/**
 * Inicia uma geração de imagem.
 *
 * Args:
 * - prompt        string requerido
 * - aspect        "16:9" | "21:9" | etc., opcional, padrão interno
 * - seed          integer opcional
 *
 * Resultado:
 * - jobId
 * - kind: "image"
 * - status
 */
export async function startImageGeneration(
  { prompt, aspect = '16:9', seed = null },
  { projectId, db = null } = {},
) {
  if (!projectId) {
    throw new GenerationError('Geração de imagem exige projectId.', {});
  }

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new GenerationError('Prompt é obrigatório e não pode estar vazio.');
  }

  const params = {
    jobId: undefined, // será gerado pelo provider
    prompt: prompt.trim(),
    aspect,
    quality: '1K', // padrão interno para agent
    durationSeconds: undefined, // imagem não tem duração
    seed: seed !== null && seed !== undefined ? Number(seed) : null,
    seedLocked: seed !== null && seed !== undefined,
    projectId,
    workflowId: IMAGEM_WORKFLOW,
  };

  try {
    const job = await submitGeneration(params);
    return { jobId: job.jobId, kind: 'image', status: job.status };
  } catch (erro) {
    throw new GenerationError(
      `Não foi possível iniciar geração de imagem: ${erro?.message || 'erro'}`,
      { originalError: erro?.message, projectId },
    );
  }
}

/**
 * Inicia uma geração de vídeo.
 *
 * Args:
 * - prompt           string requerido
 * - aspect           opcional
 * - duration         segundos, opcional, padrão interno
 * - seed             opcional
 * - sourceAssetId    Asset imagem para animar, opcional
 *
 * Resultado:
 * - jobId
 * - kind: "video"
 * - status
 */
export async function startVideoGeneration(
  { prompt, aspect = '16:9', duration = 6, seed = null, sourceAssetId = null },
  { projectId, db = null } = {},
) {
  if (!projectId) {
    throw new GenerationError('Geração de vídeo exige projectId.', {});
  }

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new GenerationError('Prompt é obrigatório e não pode estar vazio.');
  }

  // Se há sourceAsset, valida que pertence ao mesmo projeto.
  let sourceAsset = null;
  let framesToSubmit = null;
  if (sourceAssetId) {
    if (!db) {
      throw new GenerationError(
        'sourceAssetId requer db para validação.',
        { sourceAssetId },
      );
    }

    sourceAsset = getAsset(sourceAssetId, db);

    if (!sourceAsset) {
      throw new GenerationError(
        `Asset não encontrado: "${sourceAssetId}".`,
        { sourceAssetId },
      );
    }

    if (sourceAsset.projectId !== projectId) {
      throw new GenerationError(
        `Asset pertence a projeto diferente.`,
        { sourceAssetId, assetProject: sourceAsset.projectId, threadProject: projectId },
      );
    }

    if (sourceAsset.kind !== 'image') {
      throw new GenerationError(
        `Asset deve ser imagem para animar.`,
        { sourceAssetId, actualKind: sourceAsset.kind },
      );
    }

    // PASSO 6.1: Ponte Asset → i2v real
    // Lê o arquivo do Asset de forma segura e passa como firstFrame
    if (sourceAsset.filename) {
      try {
        const { readFile } = await import('node:fs/promises');
        const { resolveMediaPath } = await import('../comfy/storage.js');

        const caminhoSeguro = resolveMediaPath('image', sourceAsset.projectId, sourceAsset.filename);
        const bytesImagem = await readFile(caminhoSeguro);

        framesToSubmit = {
          first: {
            bytes: bytesImagem,
            declaredType: sourceAsset.mimeType || 'image/jpeg',
            declaredName: sourceAsset.filename,
          },
        };
      } catch (erro) {
        throw new GenerationError(
          `Não foi possível ler o Asset de origem para i2v: ${erro?.message || 'erro desconhecido'}.`,
          { sourceAssetId, originalError: erro?.message },
        );
      }
    }
  }

  const params = {
    jobId: undefined,
    prompt: prompt.trim(),
    aspect,
    quality: '480p',
    durationSeconds: Number(duration),
    seed: seed !== null && seed !== undefined ? Number(seed) : null,
    seedLocked: seed !== null && seed !== undefined,
    projectId,
    workflowId: VÍDEO_WORKFLOW,
    frames: framesToSubmit,
    // Guardar no context do job para later retrieval
    _sourceAssetId: sourceAssetId || null,
  };

  try {
    const job = await submitGeneration(params);
    return { jobId: job.jobId, kind: 'video', status: job.status };
  } catch (erro) {
    throw new GenerationError(
      `Não foi possível iniciar geração de vídeo: ${erro?.message || 'erro'}`,
      { originalError: erro?.message, projectId },
    );
  }
}

/**
 * Consulta o estado de um job.
 *
 * Resultado:
 * - jobId
 * - kind
 * - status
 * - assetId (se concluído)
 * - mediaUrl (se concluído)
 * - error (se falhou)
 */
export async function getGenerationJob(jobId, { projectId, db = null } = {}) {
  if (typeof jobId !== 'string' || !jobId) {
    throw new GenerationError('jobId é obrigatório.', {});
  }

  if (!projectId) {
    throw new GenerationError('getGenerationJob exige projectId.', {});
  }

  const job = getJob(jobId);

  if (!job) {
    throw new GenerationError(`Job não encontrado: "${jobId}".`, { jobId });
  }

  // Jobs legados sem projectId não são aceitos no Agent (security boundary).
  // O Agent sempre requer propriedade server-side clara.
  // Compatibilidade legada continua nas telas antigas/provider, não aqui.
  if (!job.projectId) {
    throw new GenerationError(
      'Job não tem propriedade server-side (projectId). Não pode ser consultado pelo Agent.',
      { jobId, detail: 'legacy_job_without_ownership' },
    );
  }

  // Validação de propriedade: o job precisa ser do projeto da thread.
  // A facade valida aqui para evitar vazamento de informações entre projetos.
  if (job.projectId !== projectId) {
    throw new GenerationError(
      'Job não pertence a este projeto.',
      { jobId, jobProject: job.projectId, threadProject: projectId },
    );
  }

  // Procura asset associado.
  // Assets só existem para jobs REALMENTE concluídos (state === DONE),
  // após publicação de arquivo validado.
  let asset = null;
  const publicStatus = normalizeJobState(job);
  if (job.state === STATES.DONE && db) {
    const assets = findAssetsByJob(jobId, db);
    if (assets && assets.length > 0) {
      asset = assets[0];
    }
  }

  return {
    jobId: job.jobId,
    kind: job.kind || 'unknown',
    status: publicStatus,
    assetId: asset?.id || null,
    mediaUrl: asset?.url || null,
    error: job.error || null,
  };
}

/**
 * Finaliza uma geração completada criando um Asset.
 *
 * Idempotente: se Asset já existe para esse job, retorna o existente.
 * Se não existe, cria novo.
 *
 * Proteção de corrida: se UNIQUE constraint viola (outro caller criou
 * simultaneamente), recarrega e retorna o Asset já criado.
 * Toda outra violação de constraint é propagada como erro real.
 */
export async function finalizeGenerationAsset(
  jobId,
  { projectId, db = null, mediaUrl = null, bytes = null, width = null, height = null, durationSeconds = null, derivedFromAssetId = null } = {},
) {
  if (!jobId || typeof jobId !== 'string') {
    throw new GenerationError('jobId é obrigatório.', {});
  }
  if (!projectId || typeof projectId !== 'string') {
    throw new GenerationError('projectId é obrigatório.', {});
  }

  const job = getJob(jobId);
  if (!job) {
    throw new GenerationError(`Job não encontrado: "${jobId}".`, { jobId });
  }

  if (job.projectId !== projectId) {
    throw new GenerationError(
      'Job não pertence a este projeto.',
      { jobId, jobProject: job.projectId, threadProject: projectId },
    );
  }

  // Job deve estar em estado DONE (concluído, arquivo publicado e validado).
  // STATES.SAVING é apenas intermediário; Asset só é criado APÓS publicação.
  if (job.state !== STATES.DONE) {
    throw new GenerationError(
      `Job não está concluído: estado=${job.state}.`,
      { jobId, state: job.state },
    );
  }

  const database_ = db || (await import('../domain/db.js')).database;
  const { createAsset, findAssetsByJob } = await import('../domain/index.js');

  // Verifica se Asset já existe para esse job (idempotência normal)
  const existing = findAssetsByJob(jobId, database_);
  if (existing && existing.length > 0) {
    return existing[0];
  }

  // Tenta criar novo Asset com metadata do job
  try {
    const asset = createAsset({
      projectId,
      kind: job.kind,
      jobId,
      filename: null, // Preenchido quando media é publicada
      url: mediaUrl || null,
      mimeType: job.kind === 'image' ? 'image/jpeg' : 'video/mp4',
      bytes,
      width,
      height,
      durationSeconds,
      prompt: job.prompt || null,
      seed: job.seed || null,
      modelId: job.workflowId || null,
      derivedFromAssetId: derivedFromAssetId || null,
      status: 'pendente',
      createdAt: Date.now(),
    }, database_);

    return asset;
  } catch (err) {
    // Se é violação UNIQUE(projectId, jobId), outro caller ganhou a corrida.
    // Recarregamos o Asset que foi criado e retornamos idempotentemente.
    if (err.code === 'ERR_SQLITE_ERROR' && err.message?.includes('UNIQUE')) {
      const alreadyCreated = findAssetsByJob(jobId, database_);
      if (alreadyCreated && alreadyCreated.length > 0) {
        return alreadyCreated[0];
      }
    }
    // Se não é a violação de corrida que esperávamos, propaga o erro.
    throw err;
  }
}
