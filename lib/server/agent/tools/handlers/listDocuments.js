// Tool project.list_documents
//
// Os documentos de referência DESTE projeto.
//
// Input: nenhum. Literalmente nenhum campo.
//
// Output:
// [
//   { documentId, filename, mimeType, pageCount, textLength }
// ]
//
// ── Por que o schema é vazio ────────────────────────────────────────────────
//
// Porque o único parâmetro que esta ferramenta poderia ter é `projectId` — e
// ele é exatamente o campo que o modelo nunca fornece (regra 5). O projeto vem
// do ToolContext, montado pelo servidor a partir da conversa que ele já tem
// gravada.
//
// Um schema com `projectId` opcional seria pior do que inútil: o modelo o
// preencheria de boa-fé com o que achasse, e a partir daí a ferramenta teria de
// decidir entre obedecer (e vazar entre projetos) ou ignorar (e ter um campo
// que mente sobre o que faz).
//
// ── Para que ela serve ──────────────────────────────────────────────────────
//
// Para o turno que NÃO traz anexo. "Abra o PDF do Prometeu que eu mandei" é uma
// pergunta legítima numa conversa nova, porque o documento é do PROJETO e não
// da conversa. É por esta lista que o agente o encontra, pelo nome que o
// usuário deu.
//
// Ela não devolve caminho, não devolve texto e não devolve impressão digital.
// Só o que serve para escolher um documento e depois lê-lo.

import { defineTool, ToolExecutionError } from '../schema.js';
import { database } from '../../../domain/db.js';
import { listProjectDocuments } from '../../../domain/documents.js';

export const listDocumentsTool = defineTool({
  name: 'project.list_documents',
  description: 'Lista os documentos de referência já anexados a este projeto '
    + '(PDF ou TXT), com nome, número de páginas e tamanho do texto. '
    + 'Use quando o usuário citar um documento sem anexá-lo neste turno — por '
    + 'exemplo "o PDF que eu mandei" — para descobrir o documentId. '
    + 'Se dois documentos puderem ser o que ele quis dizer, pergunte qual em '
    + 'vez de escolher por conta própria.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },

  async execute(context, args) {
    const { threadId, projectId } = context;

    if (!threadId) {
      throw new ToolExecutionError('Contexto inválido: threadId faltando.', {});
    }
    if (!projectId) {
      throw new ToolExecutionError('A conversa não está ligada a um projeto.', { threadId });
    }

    // Sem campo nenhum: qualquer coisa que o modelo escreva aqui é ruído, e
    // aceitar ruído em silêncio ensina que o campo existe.
    if (args && typeof args === 'object' && Object.keys(args).length > 0) {
      throw new ToolExecutionError(
        `Esta ferramenta não recebe argumentos. Recebidos: ${Object.keys(args).join(', ')}.`,
        {},
      );
    }

    const db = database();

    return listProjectDocuments(projectId, db).map((documento) => ({
      documentId: documento.id,
      filename: documento.filename,
      mimeType: documento.mimeType,
      pageCount: documento.pageCount ?? null,
      textLength: documento.textLength,
    }));
  },
});
