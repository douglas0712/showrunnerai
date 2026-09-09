// Tool og.generate_video
//
// Inicia uma geração de vídeo.
//
// Input:
// {
//   prompt: string,
//   aspect?: string,
//   duration?: number (segundos, 1-20),
//   seed?: integer,
//   sourceAssetId?: string (asset imagem para animar)
// }
//
// Output:
// {
//   jobId: string,
//   kind: "video",
//   status: string
// }
//
// ── O que acontece DEPOIS de esta ferramenta responder ──────────────────────
//
// Vale aqui o mesmo que em `generateImage.js`, e vale ainda mais: um vídeo já
// levou catorze minutos nesta instalação. Segurar a chamada até o fim
// prenderia o turno da conversa por todo esse tempo.
//
// A ferramenta devolve quando o trabalho é aceito; o Showrunner acompanha o
// resto e entrega o resultado sozinho.

import { defineTool, ToolExecutionError } from '../schema.js';
import { startVideoGeneration } from '../../../generation/facade.js';
import { getAsset } from '../../../domain/index.js';
import { database } from '../../../domain/db.js';
import { watchJob } from '../jobWatch.js';

export const generateVideoTool = defineTool({
  name: 'og.generate_video',
  description: 'Gera um vídeo a partir de um prompt textual, opcionalmente animando uma imagem. '
    + 'A geração é acompanhada automaticamente pelo sistema até ficar pronta, '
    + 'e o resultado aparece sozinho na conversa. Não peça ao usuário para '
    + 'perguntar de novo, não diga para ele voltar depois e não fique '
    + 'consultando o andamento em laço.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Descrição do vídeo desejado.',
      },
      aspect: {
        type: 'string',
        description: 'Proporção: "16:9", "21:9", etc. Padrão: "16:9".',
      },
      duration: {
        type: 'number',
        description: 'Duração em segundos (1-20). Padrão: 6.',
      },
      seed: {
        type: 'integer',
        description: 'Seed para reprodução. Opcional.',
      },
      sourceAssetId: {
        type: 'string',
        description: 'ID de uma imagem Asset para animar. Opcional.',
      },
    },
    required: ['prompt'],
  },

  async execute(context, args, deps = {}) {
    const { threadId, projectId, signal } = context;
    // `abrirBanco` é a costura de sempre: um teste passa o banco em memória e
    // esta ferramenta deixa de tocar no banco da aplicação.
    const { iniciar = startVideoGeneration, acompanhar = watchJob, abrirBanco = database } = deps;

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

    const { prompt, aspect, duration, seed, sourceAssetId } = args;

    const allowedKeys = new Set(['prompt', 'aspect', 'duration', 'seed', 'sourceAssetId']);
    const unknownKeys = Object.keys(args).filter((k) => !allowedKeys.has(k));
    if (unknownKeys.length > 0) {
      throw new ToolExecutionError(
        `Propriedades desconhecidas: ${unknownKeys.join(', ')}.`,
        { unknownKeys },
      );
    }

    // Validação mínima.
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

    if (duration !== undefined && duration !== null) {
      const dur = Number(duration);
      if (!Number.isFinite(dur) || dur < 1 || dur > 20) {
        throw new ToolExecutionError('duration deve estar entre 1 e 20 segundos.', {});
      }
    }

    if (seed !== undefined && seed !== null) {
      const seedNum = Number(seed);
      if (!Number.isInteger(seedNum) || seedNum < 0) {
        throw new ToolExecutionError('seed deve ser um inteiro não-negativo.', {});
      }
    }

    // Se sourceAssetId foi fornecido, valida aqui (para falhas explícitas).
    if (sourceAssetId) {
      if (typeof sourceAssetId !== 'string') {
        throw new ToolExecutionError('sourceAssetId deve ser string.', {});
      }

      const db = abrirBanco();
      const sourceAsset = getAsset(sourceAssetId, db);

      if (!sourceAsset) {
        throw new ToolExecutionError(
          `Asset não encontrado: "${sourceAssetId}".`,
          { sourceAssetId },
        );
      }

      if (sourceAsset.projectId !== projectId) {
        throw new ToolExecutionError(
          'Asset deve pertencer ao mesmo projeto.',
          { sourceAssetId, assetProject: sourceAsset.projectId, threadProject: projectId },
        );
      }

      if (sourceAsset.kind !== 'image') {
        throw new ToolExecutionError(
          'sourceAssetId deve ser uma imagem.',
          { sourceAssetId, actualKind: sourceAsset.kind },
        );
      }
    }

    try {
      const result = await iniciar(
        { prompt, aspect, duration, seed, sourceAssetId },
        // O contexto de propriedade vai para o registro durável. Nenhum destes
        // campos é argumento do modelo: eles vêm do ToolContext que o servidor
        // montou — ver PASSO 10.0.
        { projectId, threadId, userMessageId: context.userMessageId ?? null, db: abrirBanco() },
      );

      // Mesma regra da imagem: contexto do servidor, resultado estruturado, e
      // o `signal` do turno fora disso. Ver o cabeçalho de `generateImage.js`.
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
        `Falha ao gerar vídeo: ${erro?.message || 'erro desconhecido'}`,
        {},
      );
    }
  },
});
