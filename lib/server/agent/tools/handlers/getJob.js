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
//   status: string,            // valor público: "gerando", "concluido", ...
//   assetId: string | null,    // preenchido quando conclui
//   mediaUrl: string | null,
//   error: string | null,
//   asset: {                   // null enquanto não houver Asset
//     id, kind, mediaUrl, mimeType, derivedFromAssetId
//   } | null
// }
//
// Consultar é o que faz a geração PROGREDIR: a máquina do ComfyUI é pull, e
// sem esta consulta o job não sai do lugar. Quem chama isto em laço é o agente.

import { defineTool, ToolExecutionError } from '../schema.js';
import { getGenerationJob } from '../../../generation/facade.js';
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

    const db = database();

    try {
      // A facade é quem avança a geração e cria o Asset quando ela conclui —
      // ver `getGenerationJob`. O handler não repete essa decisão.
      //
      // Aqui existia um enriquecimento condicionado a `result.status === 'DONE'`.
      // Era código morto: `status` é o valor PÚBLICO ('concluido'), nunca a
      // constante interna, então a condição jamais foi verdadeira. Foi removido
      // em vez de corrigido, porque o que ele fazia a facade já faz — e fazer
      // duas vezes é a maneira de as duas discordarem um dia.
      return await getGenerationJob(jobId, { projectId, db });
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
