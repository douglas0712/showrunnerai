// Repositório dos documentos de um Project.
//
// Um documento é MATERIAL DE REFERÊNCIA: o PDF que o usuário mandou, o TXT que
// ele colou. Ele pertence ao Project, não à conversa — a mesma pesquisa serve a
// várias conversas, e uma conversa nova não deveria começar sem o material que
// o usuário já entregou.
//
// ── A fronteira deste arquivo ───────────────────────────────────────────────
//
// Aqui só há banco. Ler bytes, farejar assinatura, extrair texto e escrever no
// disco são trabalho de `lib/server/documents/`, que é a camada de ingestão. O
// domínio recebe o resultado já pronto e decide se ele pode virar linha.
//
// A separação não é arrumação: é o que permite testar as REGRAS (projeto
// obrigatório, ordem dos pedaços, leitura limitada, fronteira de projeto) sem
// nenhum arquivo, nenhum parser e nenhum PDF.
//
// ── Por que a criação é uma operação só ─────────────────────────────────────
//
// `createProjectDocument` grava o documento E os pedaços na MESMA transação. Um
// documento sem pedaço nenhum é um documento que o agente encontra na lista,
// abre, e descobre vazio — pior do que não existir, porque ele então responde
// "este documento está em branco" sobre um PDF que tem 40 páginas.
//
// Não existe estado de ingestão nesta tabela, e é a mesma razão: a ingestão é
// síncrona, então ou o documento existe pronto, ou não existe.

import {
  database, DomainError, inteiroOuNulo, linha, linhas, newId, textoOuNulo,
} from './db.js';
import { DOCUMENT_TYPE_VALUES, hasPages, isDocumentType } from './documentTypes.js';
import { getProject } from './projects.js';

export { DOCUMENT_TYPES, DOCUMENT_TYPE_VALUES, hasPages, isDocumentType, storageExtensionFor } from './documentTypes.js';

/** Teto do nome que o usuário deu. Rótulo, não caminho. */
export const MAX_FILENAME_LENGTH = 255;

/**
 * Teto de caracteres que uma leitura devolve.
 *
 * Existe porque o resultado de uma ferramenta entra no contexto de um modelo, e
 * um contexto tem fim. 24 mil caracteres são cerca de seis mil tokens — grande
 * o bastante para uma resposta útil sobre um trecho longo, pequeno o bastante
 * para caber várias vezes num turno que também precisa pensar.
 *
 * É um TETO, não uma cota: uma leitura para quando o próximo pedaço não caberia
 * inteiro, e nunca corta um pedaço ao meio. Cortar geraria uma continuação que
 * começa no meio de uma frase, e o cursor teria de virar um par
 * (pedaço, deslocamento) — dois números para dizer o que um já diz.
 */
export const MAX_READ_CHARS = 24000;

/** Sempre pelo menos um pedaço por leitura, mesmo se ele sozinho passar do teto. */
const MINIMO_POR_LEITURA = 1;

// ── documentos ──────────────────────────────────────────────────────────────

/**
 * Cria um documento com o texto já extraído, em pedaços ordenados.
 *
 * `chunks` é a lista de unidades de leitura, na ordem. O `ordinal` é atribuído
 * AQUI e não por quem chama — a posição no documento é do servidor, pela mesma
 * razão que `seq` de uma mensagem é.
 */
export function createProjectDocument(entrada = {}, db = database()) {
  const {
    id = newId('doc'),
    projectId,
    filename,
    mimeType,
    sizeBytes,
    sha256,
    pageCount = null,
    chunks = [],
    createdAt = Date.now(),
  } = entrada;

  const projeto = textoOuNulo(projectId);
  if (!projeto) {
    throw new DomainError('Um documento precisa de um projeto.', { projectId: projeto });
  }
  // Conferido antes do INSERT para que a falha tenha nome; a chave estrangeira
  // continua no esquema como rede. `ensureProject` não é importado aqui e não
  // deve ser: nenhum projeto nasce porque alguém mandou um arquivo.
  if (!getProject(projeto, db)) {
    throw new DomainError(`Projeto desconhecido: "${projeto}".`, { projectId: projeto });
  }

  if (!isDocumentType(mimeType)) {
    throw new DomainError(
      `Tipo de documento não aceito: "${mimeType}".`,
      { mimeType, aceitos: [...DOCUMENT_TYPE_VALUES] },
    );
  }

  const nome = nomeValido(filename);

  const bytes = inteiroOuNulo(sizeBytes);
  if (!bytes || bytes <= 0) {
    throw new DomainError('O documento não tem tamanho.', { sizeBytes });
  }

  const digest = textoOuNulo(sha256);
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new DomainError('Impressão digital do documento inválida.', {});
  }

  const paginas = inteiroOuNulo(pageCount);
  if (!hasPages(mimeType) && paginas !== null) {
    throw new DomainError(
      'Este formato não tem páginas; informar uma seria inventar uma divisão.',
      { mimeType, pageCount: paginas },
    );
  }
  if (paginas !== null && paginas <= 0) {
    throw new DomainError('Contagem de páginas inválida.', { pageCount: paginas });
  }

  const pedacos = pedacosValidos(chunks, { mimeType, pageCount: paginas });
  const textLength = pedacos.reduce((total, p) => total + p.text.length, 0);
  if (textLength <= 0) {
    throw new DomainError('O documento não tem texto para ler.', { filename: nome });
  }

  if (getProjectDocument(id, db)) {
    throw new DomainError(`Já existe um documento com o id "${id}".`, { id });
  }

  const agora = Number(createdAt) || Date.now();

  // Documento e pedaços na mesma transação — ver o cabeçalho.
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO project_documents
        (id, projectId, filename, mimeType, sizeBytes, sha256, pageCount, textLength, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projeto, nome, mimeType, bytes, digest, paginas, textLength, agora);

    const inserir = db.prepare(
      'INSERT INTO document_chunks (documentId, ordinal, pageNumber, text) VALUES (?, ?, ?, ?)',
    );
    for (let i = 0; i < pedacos.length; i += 1) {
      inserir.run(id, i, pedacos[i].pageNumber, pedacos[i].text);
    }

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return getProjectDocument(id, db);
}

export function getProjectDocument(id, db = database()) {
  if (typeof id !== 'string' || !id) return null;
  return linha(db.prepare('SELECT * FROM project_documents WHERE id = ?').get(id));
}

/**
 * O documento, exigindo que ele seja DESTE projeto.
 *
 * É a fronteira de propriedade, e ela mora aqui para ter uma implementação só:
 * a tool, a API e a associação com a mensagem fazem a mesma pergunta, e três
 * versões dela discordariam na primeira mudança.
 *
 * "Existe mas é de outro projeto" e "não existe" devolvem a MESMA coisa de
 * propósito. Distingui-las diria, a quem perguntou, que um id que ele não pode
 * ver é válido — que é a informação que ele não deveria ter.
 */
export function getProjectDocumentIn(projectId, documentId, db = database()) {
  const alvo = getProjectDocument(documentId, db);
  if (!alvo) return null;
  if (!projectId || alvo.projectId !== String(projectId)) return null;
  return alvo;
}

/** Os documentos do projeto, mais recentes primeiro. */
export function listProjectDocuments(projectId, db = database()) {
  const projeto = textoOuNulo(projectId);
  if (!projeto) return [];
  return linhas(db.prepare(
    'SELECT * FROM project_documents WHERE projectId = ? ORDER BY createdAt DESC, id ASC',
  ).all(projeto));
}

/** Apaga o documento e, por cascata, os pedaços dele. */
export function removeProjectDocument(id, db = database()) {
  const alvo = getProjectDocument(id, db);
  if (!alvo) return false;
  db.prepare('DELETE FROM project_documents WHERE id = ?').run(alvo.id);
  return true;
}

export function countDocumentChunks(documentId, db = database()) {
  const total = db.prepare(
    'SELECT COUNT(*) AS total FROM document_chunks WHERE documentId = ?',
  ).get(String(documentId));
  return Number(total?.total) || 0;
}

// ── leitura paginada ────────────────────────────────────────────────────────

/**
 * Um trecho do documento, a partir de um cursor.
 *
 * O cursor É o ordinal do próximo pedaço — não um token opaco, não um
 * deslocamento em caracteres. Um cursor que carregasse deslocamento permitiria
 * retomar no meio de um pedaço, e aí a mesma frase apareceria no fim de uma
 * leitura e no começo da seguinte.
 *
 * `eof` é afirmado, não deduzido de `nextCursor === null`. Quem consome precisa
 * saber que chegou ao fim sem ter de conhecer a convenção do cursor — e quem
 * pediu um resumo do documento inteiro precisa dessa resposta explícita para
 * saber que pode parar.
 */
export function readDocumentChunks(documentId, opcoes = {}, db = database()) {
  const { cursor = 0, maxChars = MAX_READ_CHARS } = opcoes;

  const alvo = getProjectDocument(documentId, db);
  if (!alvo) {
    throw new DomainError(`Documento desconhecido: "${documentId}".`, { documentId });
  }

  const total = countDocumentChunks(alvo.id, db);
  const inicio = cursorValido(cursor, total, alvo.id);
  const teto = Math.max(1, Number(maxChars) || MAX_READ_CHARS);

  const disponiveis = linhas(db.prepare(`
    SELECT ordinal, pageNumber, text FROM document_chunks
     WHERE documentId = ? AND ordinal >= ?
     ORDER BY ordinal ASC
  `).all(alvo.id, inicio));

  const saida = [];
  let acumulado = 0;
  for (const pedaco of disponiveis) {
    // Sempre pelo menos um: um pedaço maior que o teto ainda precisa poder ser
    // lido, senão a leitura pararia para sempre naquele ponto.
    if (saida.length >= MINIMO_POR_LEITURA && acumulado + pedaco.text.length > teto) break;
    saida.push({
      ordinal: pedaco.ordinal,
      pageNumber: pedaco.pageNumber ?? null,
      text: pedaco.text,
    });
    acumulado += pedaco.text.length;
  }

  const proximo = inicio + saida.length;
  const eof = proximo >= total;

  return {
    documentId: alvo.id,
    filename: alvo.filename,
    pageCount: alvo.pageCount ?? null,
    chunks: saida,
    nextCursor: eof ? null : proximo,
    eof,
  };
}

// ── a forma pública ─────────────────────────────────────────────────────────

/**
 * O que pode sair do servidor sobre um documento.
 *
 * Lista fechada, e ela não inclui `sha256` nem nada que diga onde os bytes
 * estão. O caminho no disco não está sequer guardado (ver a migração 8), então
 * não há o que vazar — mas a lista é fechada de qualquer modo, para que um
 * campo novo na tabela não apareça na API por acidente.
 */
const CAMPOS_PUBLICOS = Object.freeze([
  'id', 'filename', 'mimeType', 'sizeBytes', 'pageCount', 'textLength', 'createdAt',
]);

export function publicProjectDocument(registro) {
  if (!registro) return null;
  const saida = {};
  for (const campo of CAMPOS_PUBLICOS) saida[campo] = registro[campo] ?? null;
  return saida;
}

/** Os campos que atravessam para fora — usado nos testes. */
export function declaredDocumentFields() {
  return [...CAMPOS_PUBLICOS];
}

// ── validação interna ───────────────────────────────────────────────────────

function nomeValido(filename) {
  const texto = String(filename ?? '').trim();
  if (!texto) throw new DomainError('O documento precisa de um nome.', {});
  return texto.slice(0, MAX_FILENAME_LENGTH);
}

function cursorValido(cursor, total, documentId) {
  if (cursor === null || cursor === undefined || cursor === '') return 0;

  // Aceita o que o cursor É: um inteiro, ou os dígitos dele. Nada de coerção
  // solta — `Number([])` é 0, e um array vazio recebido como cursor viraria
  // "leia do começo" em silêncio, que é o pior desfecho possível: quem chamou
  // errado receberia uma resposta plausível em vez de um erro.
  const ehInteiro = typeof cursor === 'number' && Number.isInteger(cursor);
  const ehDigitos = typeof cursor === 'string' && /^\d+$/.test(cursor);
  if (!ehInteiro && !ehDigitos) {
    throw new DomainError('Ponto de leitura inválido.', {});
  }

  const n = Number(cursor);
  if (n < 0) {
    throw new DomainError('Ponto de leitura inválido.', {});
  }
  // Um cursor além do fim não é "acabou": é um cursor que não veio da leitura
  // anterior. Aceitá-lo em silêncio devolveria "documento vazio, eof" para um
  // documento que tem conteúdo, e quem chamou concluiria a coisa errada.
  if (n > total) {
    throw new DomainError('Ponto de leitura inválido.', { cursor: n, documentId });
  }
  return n;
}

function pedacosValidos(chunks, { mimeType, pageCount }) {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    throw new DomainError('O documento não tem texto para ler.', {});
  }

  const saida = [];
  for (const bruto of chunks) {
    const texto = typeof bruto?.text === 'string' ? bruto.text : '';
    if (!texto) {
      throw new DomainError('Um trecho do documento veio vazio.', {});
    }

    const pagina = inteiroOuNulo(bruto?.pageNumber);
    if (pagina !== null && !hasPages(mimeType)) {
      throw new DomainError(
        'Este formato não tem páginas; um trecho não pode declarar uma.',
        { mimeType },
      );
    }
    if (pagina !== null && (pagina <= 0 || (pageCount !== null && pagina > pageCount))) {
      throw new DomainError(
        'Um trecho aponta para uma página que o documento não tem.',
        { pageNumber: pagina, pageCount },
      );
    }

    saida.push({ pageNumber: pagina, text: texto });
  }
  return saida;
}
