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

/** Erro de geração (não de submissão). */
export class GenerationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'GenerationError';
    this.detail = detail;
  }
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
    quality: '480p', // padrão interno para agent
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
    // Se há sourceAsset, submissão torna-se i2v em vez de t2v.
    // Essa lógica fica internamente no provider; facades apenas passa.
    sourceAssetId: sourceAsset ? sourceAssetId : null,
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

  // Validação de propriedade: o job precisa ser do projeto da thread.
  // Isso fica na responsabilidade de quem chama a facade (a tool get_job).
  // A facade apenas prepara a resposta.

  // Procura asset associado.
  let asset = null;
  if (job.status === 'DONE' && db) {
    const assets = findAssetsByJob(jobId, db);
    if (assets && assets.length > 0) {
      asset = assets[0];
    }
  }

  return {
    jobId: job.jobId,
    kind: job.kind || 'unknown',
    status: job.status,
    assetId: asset?.id || null,
    mediaUrl: asset?.url || null,
    error: job.error || null,
  };
}
