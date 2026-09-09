// A API de documentos, sem HTTP.
//
// Mesmo movimento de `agent/httpApi.js` e `generation/mediaServing.js`, e pelo
// mesmo motivo: o que mora dentro de uma Route Handler não é alcançável por
// teste, porque `next/server` não resolve fora do build do Next. A decisão fica
// aqui; a rota fica com o que só ela pode fazer — ler o corpo e montar a
// resposta.
//
// ── A forma pública de um documento ─────────────────────────────────────────
//
// `publicProjectDocument`, e nada além dela. Não sai `sha256` (é impressão
// digital interna e o navegador não a usa para nada), não sai caminho — ele
// nem está guardado —, e em especial não sai o TEXTO. O conteúdo de um
// documento não tem endpoint público: quem o lê é o agente, server-side, pela
// ferramenta, e o resultado dessa leitura também não atravessa para a tela.
//
// Publicar o texto por HTTP seria criar um segundo caminho para o mesmo dado,
// com a fronteira feita de novo — e a segunda cópia de uma fronteira é a que
// alguém esquece de fechar.

import { database } from '../domain/db.js';
import { listProjectDocuments, publicProjectDocument } from '../domain/documents.js';
import { isValidProjectId } from '../domain/projects.js';
import { DocumentIngestionError, ingestDocument } from './ingest.js';

/** Recusa → status HTTP. Tabela fechada; um código novo cai no 400. */
const STATUS_POR_CODIGO = Object.freeze({
  project_required: 400,
  invalid_filename: 400,
  invalid_body: 400,
  empty_file: 400,
  unsupported_type: 415,
  not_a_pdf: 415,
  too_large: 413,
  unknown_project: 422,
  unreadable: 422,
  invalid_document: 422,
  ingest_failed: 500,
});

export function statusForIngestionError(erro) {
  return STATUS_POR_CODIGO[erro?.code] ?? 400;
}

/**
 * POST /api/documents — anexa um documento a um projeto.
 *
 * Recebe o que a rota já extraiu do multipart: o projeto, o nome, o tipo
 * declarado e os bytes. Ler o `FormData` é trabalho da rota porque depende da
 * `Request` do Next; decidir se aquilo pode virar documento é trabalho daqui.
 */
export async function handleUploadDocument(entrada = {}, deps = {}) {
  const { projectId, filename, declaredMimeType = null, bytes } = entrada;

  if (typeof projectId !== 'string' || !isValidProjectId(projectId)) {
    return { status: 400, body: { error: 'projectId inválido.' } };
  }

  try {
    const documento = await ingestDocument({
      projectId, filename, declaredMimeType, bytes,
    }, deps);
    return { status: 201, body: { document: documento } };
  } catch (erro) {
    if (erro instanceof DocumentIngestionError) {
      return { status: statusForIngestionError(erro), body: { error: erro.message } };
    }
    // Nada de mensagem de exceção não tipada na superfície: ela carrega nome de
    // classe, caminho e, às vezes, o conteúdo que falhou.
    return { status: 500, body: { error: 'Não consegui processar este arquivo.' } };
  }
}

/** GET /api/documents?projectId=… — os documentos do projeto. */
export function handleListDocuments(params = {}, deps = {}) {
  const { db = database() } = deps;
  const { projectId } = params;

  if (typeof projectId !== 'string' || !isValidProjectId(projectId)) {
    return { status: 400, body: { error: 'projectId inválido.' } };
  }

  const documentos = listProjectDocuments(projectId, db).map(publicProjectDocument);
  return { status: 200, body: { documents: documentos } };
}
