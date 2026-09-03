// Tool og.get_job
//
// Consulta o estado de uma geração.
//
// Input:
// {
//   jobId: string
// }
//
// Output:
// {
//   jobId: string,
//   kind: "image" | "video",
//   status: string,
//   assetId?: string (se concluído),
//   mediaUrl?: string (se concluído),
//   error?: string (se falhou)
// }

import { defineTool, ToolExecutionError } from '../schema.js';
import { getGenerationJob } from '../../../generation/facade.js';
import { getJob } from '../../../comfy/jobs.js';
import { findAssetsByJob } from '../../../domain/index.js';
import { database } from '../../../domain/db.js';

export const getJobTool = defineTool({
  name: 'og.get_job',
  description: 'Consulta o estado de uma geração (imagem ou vídeo).',
  inputSchema: {
    type: 'object',
    properties: {
      jobId: {
        type: 'string',
        description: 'ID do job de geração.',
      },
    },
    required: ['jobId'],
  },

  async execute(context, args) {
    const { threadId, projectId, signal } = context;

    if (!threadId) {
      throw new ToolExecutionError('Contexto inválido: threadId faltando.', {});
    }

    if (!projectId) {
      throw new ToolExecutionError(
        'A conversa não está ligada a um projeto.',
        { threadId },
      );
    }

    if (!args || typeof args !== 'object') {
      throw new ToolExecutionError('Argumentos inválidos.', {});
    }

    const { jobId } = args;

    const allowedKeys = new Set(['jobId']);
    const unknownKeys = Object.keys(args).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      throw new ToolExecutionError(
        `Propriedades desconhecidas: ${unknownKeys.join(', ')}.`,
        { unknownKeys },
      );
    }

    if (typeof jobId !== 'string' || !jobId.trim()) {
      throw new ToolExecutionError('jobId é obrigatório e não pode estar vazio.', {});
    }

    // Valida que o job pertence ao projeto da thread.
    const db = database();
    const job = getJob(jobId);

    if (!job) {
      throw new ToolExecutionError(`Job não encontrado: "${jobId}".`, { jobId });
    }

    if (job.projectId !== projectId) {
      throw new ToolExecutionError(
        'Job não pertence a este projeto.',
        { jobId, jobProject: job.projectId, threadProject: projectId },
      );
    }

    try {
      const result = await getGenerationJob(jobId, { projectId, db });

      // Preenche metadados de Asset se concluído.
      if (result.status === 'DONE' || result.status === 'COMPLETED') {
        const assets = findAssetsByJob(jobId, db);
        if (assets && assets.length > 0) {
          result.assetId = assets[0].id;
          result.mediaUrl = assets[0].url;
        }
      }

      return result;
    } catch (erro) {
      if (erro.name === 'GenerationError') {
        throw new ToolExecutionError(erro.message, erro.detail || {});
      }
      throw new ToolExecutionError(
        `Falha ao consultar job: ${erro?.message || 'erro desconhecido'}`,
        { jobId },
      );
    }
  },
});
