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
//
// ── O que acontece DEPOIS de esta ferramenta responder ──────────────────────
//
// Ela devolve assim que o trabalho foi aceito, e não espera a imagem ficar
// pronta: uma imagem pode levar minutos, e segurar a chamada por todo esse
// tempo prenderia o turno da conversa junto com ela.
//
// O trabalho não fica parado por causa disso. Aqui mesmo, com o contexto
// confiável do turno, o Showrunner registra o acompanhamento — e é ele quem
// leva a geração até o fim, publica o Asset e o liga à conversa. O modelo não
// precisa consultar em laço, e o usuário não precisa perguntar "e aí?".

import { defineTool, ToolExecutionError } from '../schema.js';
import { startImageGeneration } from '../../../generation/facade.js';
import { watchJob } from '../jobWatch.js';

export const generateImageTool = defineTool({
  name: 'og.generate_image',
  description: 'Gera uma imagem a partir de um prompt textual. '
    + 'A geração é acompanhada automaticamente pelo sistema até ficar pronta, '
    + 'e o resultado aparece sozinho na conversa. Não peça ao usuário para '
    + 'perguntar de novo, não diga para ele voltar depois e não fique '
    + 'consultando o andamento em laço.',
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

  async execute(context, args, deps = {}) {
    const { threadId, projectId, signal } = context;
    const { iniciar = startImageGeneration, acompanhar = watchJob } = deps;

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
      const result = await iniciar(
        { prompt, aspect, seed },
        { projectId },
      );

      // O acompanhamento nasce do RESULTADO ESTRUTURADO, não de nada que o
      // modelo tenha escrito, e com o contexto que o servidor montou. Um agente
      // que dissesse a qual conversa o resultado pertence seria um agente sem
      // fronteira.
      //
      // O `signal` do turno NÃO entra aqui de propósito: parar a conversa
      // interrompe a fala do agente, não o trabalho que já foi aceito.
      acompanhar({
        jobId: result.jobId,
        kind: result.kind,
        threadId,
        projectId,
      });

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
