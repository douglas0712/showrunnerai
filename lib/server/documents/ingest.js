// Ingestão de um documento: bytes chegam, documento pronto sai.
//
// ── Por que é síncrona ──────────────────────────────────────────────────────
//
// Nenhum Job, nenhuma fila, nenhum worker, nenhum estado de "processando". Não
// por preguiça: extrair texto de um PDF de 30 páginas custa dezenas de
// milissegundos, e uma fila para isso seria mais máquina do que trabalho —
// mais um lugar para um documento ficar preso, mais um estado para a tela
// mostrar, mais uma coisa para reconciliar num reinício.
//
// Quando a extração deixar de caber numa requisição — OCR, transcrição de
// áudio, documento de mil páginas — o livro-razão de trabalhos duráveis já
// existe e o desenho dele já foi resolvido. Copiá-lo agora, para um trabalho
// que termina antes da resposta HTTP, seria pagar o custo sem o problema.
//
// ── A ordem, e por que ela é esta ───────────────────────────────────────────
//
//   valida a forma          antes de tocar em disco: um pedido malformado não
//                           deve deixar rastro nenhum
//   fareja os bytes REAIS   o Content-Type do navegador e a extensão do nome
//                           são declarações de quem envia, não fatos
//   gera o id               é ele, e não o nome do usuário, que forma o caminho
//   grava o original        atômico (temp + rename)
//   extrai                  o passo que mais falha, e o único que abre parser
//   persiste                documento + pedaços na mesma transação
//
// A extração vem DEPOIS da gravação de propósito: o original é a única coisa
// que não dá para refazer. Se a extração falhar, o arquivo órfão é apagado logo
// em seguida — mas se a ORDEM fosse a inversa e a gravação falhasse, teríamos
// um documento no banco apontando para bytes que não existem.
//
// ── Nada fica pela metade ───────────────────────────────────────────────────
//
// Falha depois da gravação → o diretório do documento é removido. Falha na
// persistência → idem, e a transação do domínio já garante que não existe
// documento sem pedaços. O que NUNCA acontece é um registro parcial que finge
// sucesso: um documento na lista que o agente abre e encontra vazio.

import { createHash } from 'node:crypto';

import { createProjectDocument, publicProjectDocument } from '../domain/documents.js';
import { DOCUMENT_TYPES, DOCUMENT_TYPE_VALUES, isDocumentType } from '../domain/documentTypes.js';
import { database, DomainError, newId } from '../domain/db.js';
import { getProject } from '../domain/projects.js';
import { CHANNELS, STAGES } from '../logs/stages.js';
import { logError, logInfo } from '../logs/logger.js';
import { MIN_DOCUMENT_BYTES, maxDocumentBytes } from './config.js';
import { DocumentExtractionError, extractDocument, pareceBinario } from './extract.js';
import { discardDocumentSource, DOCUMENTS_ROOT, storeDocumentSource } from './storage.js';

export { DocumentExtractionError } from './extract.js';

/**
 * Recusa de ingestão.
 *
 * `code` é estável e é o que a rota traduz em status HTTP. A `message` é do
 * produto: ela é escrita para quem mandou o arquivo, e nenhuma delas cita
 * caminho, parser, offset de byte ou nome de biblioteca.
 */
export class DocumentIngestionError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'DocumentIngestionError';
    this.code = code;
    this.detail = detail;
  }
}

/** A assinatura real de um PDF. Cinco bytes, no começo do arquivo. */
const ASSINATURA_PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // %PDF-

/**
 * Ingere um documento.
 *
 * `projectId` vem do SERVIDOR em toda chamada real — da rota, que o validou, ou
 * do ToolContext. Ele é conferido aqui de qualquer modo: o projeto precisa
 * existir, e nenhum é criado. Um upload que materializasse projetos seria a
 * porta de criação a partir de string que `registerProject` existe para fechar.
 */
export async function ingestDocument({
  projectId,
  filename,
  declaredMimeType = null,
  bytes,
} = {}, deps = {}) {
  const { db = database(), root = DOCUMENTS_ROOT, clock = Date.now } = deps;

  const projeto = String(projectId ?? '').trim();
  if (!projeto) {
    throw new DocumentIngestionError('project_required', 'Escolha um projeto antes de anexar um documento.');
  }
  if (!getProject(projeto, db)) {
    throw new DocumentIngestionError(
      'unknown_project',
      'Este projeto ainda não existe no servidor.',
      { projectId: projeto },
    );
  }

  const nome = String(filename ?? '').trim();
  if (!nome) {
    throw new DocumentIngestionError('invalid_filename', 'O arquivo precisa de um nome.');
  }

  const vista = paraBytes(bytes);

  const teto = maxDocumentBytes();
  if (vista.length > teto) {
    throw new DocumentIngestionError(
      'too_large',
      `Este arquivo passa do limite de ${Math.round(teto / (1024 * 1024))} MB.`,
      { sizeBytes: vista.length, limite: teto },
    );
  }
  if (vista.length < MIN_DOCUMENT_BYTES) {
    throw new DocumentIngestionError('empty_file', 'Este arquivo está vazio.');
  }

  // O tipo REAL, farejado dos bytes. O que o navegador declarou é usado só como
  // desempate entre os formatos que os bytes não distinguem sozinhos.
  const mimeType = detectDocumentType(vista, { declaredMimeType, filename: nome });

  // O id nasce agora porque é ELE que forma o caminho no disco — o nome que o
  // usuário deu não participa disso em momento nenhum (ver storage.js).
  const documentId = newId('doc');

  let gravado = false;
  try {
    await storeDocumentSource({ projectId: projeto, documentId, mimeType, bytes: vista }, root);
    gravado = true;

    const { pageCount, chunks } = await extractDocument(vista, mimeType);

    const registro = createProjectDocument({
      id: documentId,
      projectId: projeto,
      filename: nome,
      mimeType,
      sizeBytes: vista.length,
      sha256: createHash('sha256').update(vista).digest('hex'),
      pageCount,
      chunks,
      createdAt: clock(),
    }, db);

    logInfo(STAGES.DOCUMENT_INGESTED, 'Documento anexado ao projeto.', {
      channel: CHANNELS.AGENT,
      detail: {
        projectId: projeto,
        documentId,
        mimeType,
        sizeBytes: vista.length,
        pageCount: pageCount ?? null,
        trechos: chunks.length,
      },
    });

    return publicProjectDocument(registro);
  } catch (erro) {
    // Os bytes existem e a linha não. Sem esta limpeza, o arquivo seria
    // invisível para o produto inteiro — e portanto para sempre.
    if (gravado) await discardDocumentSource(projeto, documentId, root);

    logError(STAGES.DOCUMENT_INGESTED, erro, {
      channel: CHANNELS.AGENT,
      detail: { projectId: projeto, documentId, mimeType },
    });

    if (erro instanceof DocumentIngestionError) throw erro;
    if (erro instanceof DocumentExtractionError) {
      throw new DocumentIngestionError('unreadable', erro.message, {});
    }
    if (erro instanceof DomainError) {
      throw new DocumentIngestionError('invalid_document', erro.message, {});
    }
    throw new DocumentIngestionError(
      'ingest_failed',
      'Não consegui processar este arquivo.',
      {},
    );
  }
}

/**
 * O tipo REAL do arquivo, a partir dos bytes.
 *
 * ── Por que não basta o que o navegador mandou ──────────────────────────────
 *
 * O `Content-Type` de um `<input type=file>` vem do sistema operacional, que o
 * deriva da EXTENSÃO. Renomear `payload.exe` para `nota.pdf` faz o navegador
 * anunciar `application/pdf` de boa-fé. É declaração, não fato — a mesma razão
 * pela qual o quadro enviado ao ComfyUI é conferido por número mágico.
 *
 * ── PDF ─────────────────────────────────────────────────────────────────────
 *
 * A assinatura `%PDF-` no começo do arquivo. Exigida no OFFSET ZERO, e não
 * "nos primeiros N bytes": a especificação põe o cabeçalho no início, os
 * geradores reais o põem lá, e uma tolerância de N bytes é exatamente o espaço
 * onde alguém encaixa outro formato para ser lido por outro programa.
 *
 * ── TXT ─────────────────────────────────────────────────────────────────────
 *
 * Texto não tem assinatura — é definido pelo que ele NÃO é. Então a pergunta se
 * inverte: o arquivo é binário? Se for, recusa. Ver `pareceBinario`.
 */
export function detectDocumentType(bytes, { declaredMimeType = null, filename = '' } = {}) {
  const vista = paraBytes(bytes);

  if (comecaCom(vista, ASSINATURA_PDF)) return DOCUMENT_TYPES.PDF;

  const declarado = String(declaredMimeType ?? '').split(';')[0].trim().toLowerCase();

  // Declarou PDF e os bytes não são PDF. É o caso do MIME falso, e ele merece
  // uma frase própria: "não é um PDF" é acionável; "tipo não aceito" não é.
  if (declarado === DOCUMENT_TYPES.PDF || /\.pdf$/i.test(filename)) {
    throw new DocumentIngestionError(
      'not_a_pdf',
      'Este arquivo se apresenta como PDF, mas o conteúdo não é um PDF.',
      {},
    );
  }

  if (pareceBinario(vista)) {
    throw new DocumentIngestionError(
      'unsupported_type',
      'Por enquanto aceito apenas PDF com texto e arquivos .txt em UTF-8.',
      { aceitos: [...DOCUMENT_TYPE_VALUES] },
    );
  }

  // Sobrou texto. O tipo declarado só é honrado quando é um dos que aceitamos —
  // um `text/html` ou `text/csv` cai fora aqui, e cair fora é o certo: eles têm
  // estrutura própria, e tratá-los como texto puro perderia essa estrutura em
  // silêncio.
  if (declarado && !isDocumentType(declarado)) {
    throw new DocumentIngestionError(
      'unsupported_type',
      'Por enquanto aceito apenas PDF com texto e arquivos .txt em UTF-8.',
      { declarado, aceitos: [...DOCUMENT_TYPE_VALUES] },
    );
  }

  return DOCUMENT_TYPES.TEXT;
}

function comecaCom(vista, assinatura) {
  if (vista.length < assinatura.length) return false;
  for (let i = 0; i < assinatura.length; i += 1) {
    if (vista[i] !== assinatura[i]) return false;
  }
  return true;
}

function paraBytes(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  if (ArrayBuffer.isView(bytes)) return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  throw new DocumentIngestionError('invalid_body', 'Não recebi o conteúdo do arquivo.');
}
