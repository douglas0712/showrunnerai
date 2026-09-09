// Onde o arquivo original de um documento fica.
//
// Privado, dentro do runtime da aplicação, e fora do Git — `runtime/` inteiro já
// está no `.gitignore`, e isto entra debaixo dele:
//
//     runtime/documents/<projectId>/<documentId>/source.<ext>
//
// ── A regra que este arquivo existe para cumprir ────────────────────────────
//
// O nome que o usuário deu ao arquivo NUNCA participa do caminho. Nem
// sanitizado, nem escapado, nem "quase sempre seguro": ele não entra. O arquivo
// se chama sempre `source`, e a extensão vem da tabela de tipos do domínio.
//
// Sanitizar um nome é uma corrida que se perde devagar — `../`, `..%2f`,
// separador do Windows, NUL no meio, normalização Unicode que só acontece no
// sistema de arquivos. Não participar da decisão é a única versão que não tem
// caso de borda. O nome continua existindo, como RÓTULO, na coluna `filename`.
//
// Os dois segmentos que formam o caminho são identificadores nossos, e ainda
// assim passam por `validateSegment` (a mesma regex que a mídia usa) e por
// `assertInside`. Defesa em profundidade: a validação é barata e a regressão
// que ela pega é cara.
//
// ── O que NUNCA sai daqui ───────────────────────────────────────────────────
//
// O caminho absoluto. Ele não é gravado no banco (ver a migração 8), não entra
// em DTO, não entra em AgentEvent e não é entregue ao runtime de raciocínio.
// Quem precisa dos bytes chama uma função daqui com os dois ids; quem só
// precisa do TEXTO lê os pedaços no banco e nunca toca no disco.

import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { appPath } from '../appRoot.js';
import { assertInside, validateSegment } from '../comfy/storage.js';
import { storageExtensionFor } from '../domain/documentTypes.js';

/**
 * A raiz dos documentos.
 *
 * Ancorada na raiz da APLICAÇÃO, e não em `process.cwd()`, pelo mesmo motivo
 * que `RUNTIME_ROOT`: um script rodado de outro diretório precisa enxergar o
 * mesmo armazenamento, senão passa a escrever num lugar paralelo sem ninguém
 * perceber.
 *
 * Não há variável de ambiente para movê-la. `runtime/` nunca teve uma, e uma
 * raiz configurável seria mais um lugar onde um caminho pode apontar para fora.
 */
export const DOCUMENTS_ROOT = appPath('runtime', 'documents');

/** O diretório de um documento, garantidamente dentro da raiz. */
export function documentDirFor(projectId, documentId, root = DOCUMENTS_ROOT) {
  validateSegment(projectId, 'projectId');
  validateSegment(documentId, 'documentId');
  const raiz = path.resolve(root);
  const dir = path.resolve(raiz, projectId, documentId);
  assertInside(raiz, dir);
  return dir;
}

/**
 * O caminho do arquivo original.
 *
 * Interno. Nenhuma superfície pública o devolve — ver o cabeçalho.
 */
export function documentSourcePath(projectId, documentId, mimeType, root = DOCUMENTS_ROOT) {
  const dir = documentDirFor(projectId, documentId, root);
  const destino = path.join(dir, `source${storageExtensionFor(mimeType)}`);
  assertInside(path.resolve(root), destino);
  return destino;
}

/**
 * Grava os bytes originais.
 *
 * Escreve num temporário e publica com `rename`, pelo mesmo motivo que a mídia:
 * o rename é atômico dentro do mesmo sistema de arquivos, então o caminho final
 * ou não existe ou já é o arquivo inteiro — nunca um arquivo pela metade que
 * uma leitura concorrente veria como truncado.
 *
 * `wx` no temporário: se ele já existir, a escrita falha em vez de sobrescrever.
 */
export async function storeDocumentSource(
  { projectId, documentId, mimeType, bytes },
  root = DOCUMENTS_ROOT,
) {
  const dir = documentDirFor(projectId, documentId, root);
  const destino = documentSourcePath(projectId, documentId, mimeType, root);

  await mkdir(dir, { recursive: true });

  const temporario = `${destino}.part-${randomUUID().slice(0, 8)}`;
  assertInside(path.resolve(root), temporario);

  try {
    await writeFile(temporario, bytes, { flag: 'wx' });
    await rename(temporario, destino);
  } catch (erro) {
    await rm(temporario, { force: true }).catch(() => {});
    throw erro;
  }

  return { absolutePath: destino };
}

/**
 * Remove o diretório do documento.
 *
 * Chamado quando a persistência falha DEPOIS de os bytes já terem sido
 * gravados: um arquivo sem linha no banco é invisível para o produto inteiro e
 * ninguém jamais o apagaria. Nunca lança — a limpeza é o melhor esforço de um
 * caminho que já está tratando outra falha, e deixar a exceção da limpeza
 * substituir a original esconderia o problema de verdade.
 */
export async function discardDocumentSource(projectId, documentId, root = DOCUMENTS_ROOT) {
  try {
    const dir = documentDirFor(projectId, documentId, root);
    await rm(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
