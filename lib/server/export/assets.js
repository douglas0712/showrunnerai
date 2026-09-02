// Resolução de assets: identificador → caminho absoluto real.
//
// Regra central de segurança: o navegador só manda identificadores curtos
// (resultId, jobId) ou a URL pública que a própria aplicação emitiu. Nenhum
// caminho vindo do cliente é usado. O caminho final vem de uma allowlist — os
// arquivos que a própria aplicação gravou sob runtime/projects/*/videos/ — e é
// conferido contra a raiz do runtime antes de qualquer leitura.

import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_ROOT } from '../comfy/config.js';
import { PathValidationError, assertInside, validateSegment, validateVideoFilename } from '../comfy/storage.js';

export class AssetResolutionError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'AssetResolutionError';
    this.detail = detail;
  }
}

/** URL pública emitida por esta aplicação para um vídeo de projeto. */
const MEDIA_URL_RE = /^\/api\/media\/video\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64}\.mp4)$/;

/**
 * Todos os vídeos que a aplicação gravou — a allowlist.
 * Qualquer coisa fora desta lista é recusada, independentemente do que o
 * cliente tenha pedido.
 */
export async function listRegisteredVideos(root = RUNTIME_ROOT) {
  const raiz = path.resolve(root);
  let projetos;
  try {
    projetos = await readdir(raiz, { withFileTypes: true });
  } catch {
    return [];
  }

  const encontrados = [];
  for (const projeto of projetos) {
    if (!projeto.isDirectory()) continue;
    try {
      validateSegment(projeto.name, 'projectId');
    } catch {
      continue; // pasta com nome fora do padrão não entra na allowlist
    }

    const dir = path.resolve(raiz, projeto.name, 'videos');
    let arquivos;
    try {
      // eslint-disable-next-line no-await-in-loop
      arquivos = await readdir(dir);
    } catch {
      continue;
    }

    for (const arquivo of arquivos) {
      if (!arquivo.endsWith('.mp4')) continue;
      let absoluto;
      try {
        validateVideoFilename(arquivo);
        absoluto = path.resolve(dir, arquivo);
        assertInside(raiz, absoluto);
      } catch {
        continue;
      }
      encontrados.push({
        projectId: projeto.name,
        filename: arquivo,
        jobId: arquivo.replace(/\.mp4$/, ''),
        absolutePath: absoluto,
        url: `/api/media/video/${projeto.name}/${arquivo}`,
      });
    }
  }
  return encontrados;
}

/**
 * Resolve um pedido do cliente para um arquivo da allowlist.
 *
 * @param {{jobId?: string, mediaUrl?: string}} pedido
 * @param {Array} allowlist  resultado de `listRegisteredVideos`
 */
export function resolveFromAllowlist(pedido, allowlist = []) {
  if (!pedido || typeof pedido !== 'object') {
    throw new AssetResolutionError('Pedido de asset inválido.');
  }

  // 1) Por jobId — o nome do arquivo é o próprio jobId.
  if (pedido.jobId) {
    // Identificador fora do padrão (travessia, barra, ponto) é recusado aqui.
    // Convertemos para AssetResolutionError para que quem chama lide com um
    // único tipo de erro.
    try {
      validateSegment(pedido.jobId, 'jobId');
    } catch (erro) {
      throw new AssetResolutionError(`jobId inválido: "${pedido.jobId}".`, { causa: erro.message });
    }
    const achado = allowlist.find((a) => a.jobId === pedido.jobId);
    if (achado) return achado;
  }

  // 2) Pela URL pública que a aplicação emitiu — nunca por caminho.
  if (pedido.mediaUrl) {
    const match = MEDIA_URL_RE.exec(String(pedido.mediaUrl));
    if (!match) {
      throw new AssetResolutionError('URL de mídia fora do formato aceito.', { mediaUrl: pedido.mediaUrl });
    }
    const [, projectId, filename] = match;
    const achado = allowlist.find((a) => a.projectId === projectId && a.filename === filename);
    if (achado) return achado;
  }

  throw new AssetResolutionError(
    'Asset não encontrado entre os arquivos registrados do projeto.',
    { jobId: pedido.jobId || null, mediaUrl: pedido.mediaUrl || null },
  );
}

/**
 * Resolve a lista de cenas pedida, preservando a ordem da timeline e
 * recusando duplicatas — o mesmo arquivo duas vezes seria emenda repetida.
 */
export async function resolveTimelineAssets(clips = [], { root = RUNTIME_ROOT } = {}) {
  if (!Array.isArray(clips) || clips.length === 0) {
    throw new AssetResolutionError('A timeline não tem cenas para exportar.');
  }

  const allowlist = await listRegisteredVideos(root);
  const resolvidos = [];
  const vistos = new Set();

  for (const [indice, clip] of clips.entries()) {
    const asset = resolveFromAllowlist(clip, allowlist);

    if (vistos.has(asset.absolutePath)) {
      throw new AssetResolutionError(
        `A cena ${indice + 1} repete um arquivo já presente na montagem.`,
        { filename: asset.filename },
      );
    }
    vistos.add(asset.absolutePath);

    // Confirma que o arquivo existe agora, não só no índice.
    // eslint-disable-next-line no-await-in-loop
    const info = await stat(asset.absolutePath).catch(() => null);
    if (!info?.isFile() || info.size === 0) {
      throw new AssetResolutionError(`O arquivo da cena ${indice + 1} não está disponível.`, {
        filename: asset.filename,
      });
    }

    resolvidos.push({
      ...asset,
      order: indice,
      title: typeof clip.title === 'string' ? clip.title.slice(0, 120) : asset.jobId,
      resultId: typeof clip.resultId === 'string' ? clip.resultId.slice(0, 64) : null,
      bytes: info.size,
    });
  }

  return resolvidos;
}

export { PathValidationError };
