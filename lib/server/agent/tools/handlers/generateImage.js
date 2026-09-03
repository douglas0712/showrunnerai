// Tool og.generate_image
//
// Inicia uma geração de imagem.
//
// Input:
// {
//   prompt: string,
//   aspect?: string ("16:9", "21:9", etc.),
//   seed?: integer
// }
//
// Output:
// {
//   jobId: string,
//   kind: "image",
//   status: string
// }

import { defineTool, ToolExecutionError } from '../schema.js';
import { startImageGeneration } from '../../../generation/facade.js';

export const generateImageTool = defineTool({
  name: 'og.generate_image',
  description: 'Gera uma imagem a partir de um prompt textual.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Descrição da imagem desejada.',
      },
      aspect: {
        type: 'string',
        description: 'Proporção: "16:9", "21:9", "1:1", etc. Padrão: "16:9".',
      },
      seed: {
        type: 'integer',
        description: 'Seed para reprodução. Opcional.',
      },
    },
    required: ['prompt'],
  },

  async execute(context, args) {
    const { threadId, projectId, signal } = context;

    if (!threadId) {
      throw new ToolExecutionError('Contexto inválido: threadId faltando.', {});
    }

    if (!projectId) {
      throw new ToolExecutionError(
        'A conversa não está ligada a um projeto. ' +
        'Crie ou escolha um projeto primeiro.',
        { threadId },
      );
    }

    if (!args || typeof args !== 'object') {
      throw new ToolExecutionError('Argumentos inválidos.', {});
    }

    const { prompt, aspect, seed } = args;

    const allowedKeys = new Set(['prompt', 'aspect', 'seed']);
    const unknownKeys = Object.keys(args).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      throw new ToolExecutionError(
        `Propriedades desconhecidas: ${unknownKeys.join(', ')}.`,
        { unknownKeys },
      );
    }

    // Validação mínima do lado da tool.
    if (typeof prompt !== 'string' || !prompt.trim()) {
      throw new ToolExecutionError('prompt é obrigatório e não pode estar vazio.', {});
    }

    if (prompt.length > 4000) {
      throw new ToolExecutionError('prompt muito longo (máximo 4000 caracteres).', {
        promptLength: prompt.length,
      });
    }

    if (aspect && typeof aspect !== 'string') {
      throw new ToolExecutionError('aspect deve ser string.', {});
    }

    if (seed !== undefined && seed !== null) {
      const seedNum = Number(seed);
      if (!Number.isInteger(seedNum) || seedNum < 0) {
        throw new ToolExecutionError('seed deve ser um inteiro não-negativo.', {});
      }
    }

    try {
      const result = await startImageGeneration(
        { prompt, aspect, seed },
        { projectId },
      );

      return {
        jobId: result.jobId,
        kind: result.kind,
        status: result.status,
      };
    } catch (erro) {
      if (erro.name === 'GenerationError') {
        throw new ToolExecutionError(erro.message, erro.detail || {});
      }
      throw new ToolExecutionError(
        `Falha ao gerar imagem: ${erro?.message || 'erro desconhecido'}`,
        {},
      );
    }
  },
});
