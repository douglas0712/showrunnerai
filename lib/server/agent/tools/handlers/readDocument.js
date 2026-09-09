// Tool project.read_document
//
// Lê um trecho de um documento do projeto.
//
// Input:
// {
//   documentId: string,
//   cursor?: integer      // de onde continuar; ausente = do começo
// }
//
// Output:
// {
//   documentId, filename, pageCount,
//   chunks: [ { ordinal, pageNumber, text } ],
//   nextCursor: integer | null,
//   eof: boolean
// }
//
// ── Por que a leitura é limitada ────────────────────────────────────────────
//
// Porque o resultado entra no contexto do modelo, e um documento inteiro não
// cabe lá. O teto é `MAX_READ_CHARS`, definido no domínio junto com a leitura
// que o respeita — um teto declarado aqui e outro lá divergiriam, e a
// divergência apareceria como um turno estourado.
//
// A leitura nunca corta um trecho ao meio: ela para quando o próximo não
// caberia inteiro. É o que mantém o cursor sendo UM número — se pudesse parar
// no meio, ele teria de virar um par (trecho, deslocamento).
//
// ── Por que o projeto não é argumento ───────────────────────────────────────
//
// Regra 5: o modelo nunca fornece `projectId`. Ele vem do ToolContext, e a
// conferência é explícita — `getProjectDocumentIn` só devolve o documento se
// ele for DESTE projeto. Um documentId válido de outro projeto responde
// exatamente como um documentId inexistente: distinguir os dois confirmaria,
// para quem perguntou, que o id existe em algum lugar.
//
// ── O que este arquivo NÃO faz ──────────────────────────────────────────────
//
// Não abre arquivo, não conhece caminho, não sabe o que é um PDF e não carrega
// parser nenhum. O texto já está no banco desde a ingestão; ler é uma consulta.
// A camada de agente inteira é proibida de tocar em `node:fs`, e esta
// ferramenta não é exceção — ela não precisa ser.

import { defineTool, ToolExecutionError } from '../schema.js';
import { database, DomainError } from '../../../domain/db.js';
import { getProjectDocumentIn, MAX_READ_CHARS, readDocumentChunks } from '../../../domain/documents.js';

export const readDocumentTool = defineTool({
  name: 'project.read_document',
  description: 'Lê o conteúdo de um documento anexado a este projeto, em partes. '
    + 'Devolve um trecho, um "nextCursor" e um "eof". '
    + 'Se a tarefa exigir o documento INTEIRO — resumir, listar todos os pontos, '
    + 'propor uma estrutura a partir dele —, chame de novo passando o nextCursor '
    + 'recebido, e repita até eof ser true. '
    + 'Não afirme que leu o documento inteiro antes de chegar a eof. '
    + 'Para uma pergunta localizada, ler as primeiras partes costuma bastar. '
    + 'Responda sempre com base no que o documento diz, nunca no nome do arquivo '
    + 'nem em conhecimento prévio sobre o assunto.',
  inputSchema: {
    type: 'object',
    properties: {
      documentId: {
        type: 'string',
        description: 'Id do documento, vindo do anexo deste turno ou de project.list_documents.',
      },
      cursor: {
        type: 'integer',
        description: 'De onde continuar a leitura. Use o nextCursor da chamada anterior. '
          + 'Omita para começar do início.',
      },
    },
    required: ['documentId'],
  },

  async execute(context, args) {
    const { threadId, projectId } = context;

    if (!threadId) {
      throw new ToolExecutionError('Contexto inválido: threadId faltando.', {});
    }
    if (!projectId) {
      throw new ToolExecutionError('A conversa não está ligada a um projeto.', { threadId });
    }
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      throw new ToolExecutionError('Argumentos inválidos.', {});
    }

    const permitidos = new Set(['documentId', 'cursor']);
    const desconhecidos = Object.keys(args).filter((k) => !permitidos.has(k));
    if (desconhecidos.length > 0) {
      throw new ToolExecutionError(
        `Propriedades desconhecidas: ${desconhecidos.join(', ')}.`,
        { desconhecidos },
      );
    }

    const { documentId, cursor } = args;

    if (typeof documentId !== 'string' || !documentId.trim()) {
      throw new ToolExecutionError('documentId é obrigatório e não pode estar vazio.', {});
    }

    if (cursor !== undefined && cursor !== null
        && !(Number.isInteger(cursor) && cursor >= 0)) {
      throw new ToolExecutionError(
        'cursor precisa ser o nextCursor devolvido pela leitura anterior.',
        {},
      );
    }

    const db = database();

    // A fronteira de propriedade, e a única conferência que decide se este
    // documento pode ser lido nesta conversa.
    const alvo = getProjectDocumentIn(projectId, documentId.trim(), db);
    if (!alvo) {
      throw new ToolExecutionError(
        'Este projeto não tem um documento com esse identificador.',
        {},
      );
    }

    try {
      return readDocumentChunks(
        alvo.id,
        { cursor: cursor ?? 0, maxChars: MAX_READ_CHARS },
        db,
      );
    } catch (erro) {
      if (erro instanceof DomainError) {
        throw new ToolExecutionError(erro.message, {});
      }
      throw new ToolExecutionError('Não consegui ler este documento.', {});
    }
  },
});
