// Resolução de um pedido de mídia: segmentos de URL → arquivo, MIME e política.
//
// Esta lógica morava dentro da rota, onde não podia ser testada: `next/server`
// não resolve fora do build do Next, então nenhum teste alcançava a validação
// de travessia, o MIME nem o parser de Range. Aqui ela é uma função pura sobre
// caminhos, e a rota fica com o que só ela pode fazer — abrir o arquivo e
// montar a resposta HTTP.
//
// Regra que não muda: o cliente informa três segmentos curtos e validados.
// Nunca um caminho, nunca uma extensão arbitrária, nunca um diretório.

import { mimeFor, mediaKind, MediaKindError } from './mediaKinds.js';
import {
  PathValidationError, resolveExportPath, resolveFramePath, resolveMediaPath,
} from '../comfy/storage.js';

export { MediaKindError, PathValidationError };

/**
 * Os quatro tipos servíveis.
 *
 * `video` e `image` derivam MIME e política de Range da tabela de tipos de
 * mídia; `export` e `frame` são arquivos internos da aplicação, com formato
 * fixo por construção.
 */
export const TIPOS_SERVIVEIS = Object.freeze({
  video: Object.freeze({
    resolver: (projectId, filename, root) => resolveMediaPath('video', projectId, filename, root),
    mime: (filename) => mimeFor('video', filename),
    range: mediaKind('video').supportsRange,
    cacheControl: 'private, max-age=3600',
  }),
  image: Object.freeze({
    resolver: (projectId, filename, root) => resolveMediaPath('image', projectId, filename, root),
    mime: (filename) => mimeFor('image', filename),
    // Imagem é entregue inteira: o player de vídeo é quem busca posição.
    range: mediaKind('image').supportsRange,
    cacheControl: 'private, max-age=3600',
  }),
  export: Object.freeze({
    resolver: (projectId, filename, root) => resolveExportPath(projectId, filename, root),
    mime: () => 'video/mp4',
    range: true,
    cacheControl: 'private, max-age=3600',
  }),
  frame: Object.freeze({
    resolver: (projectId, filename, root) => resolveFramePath(projectId, filename, root),
    mime: () => 'image/jpeg',
    range: false,
    // O quadro em cache é imutável para uma dada chave.
    cacheControl: 'private, max-age=86400, immutable',
  }),
});

export const TIPOS_SERVIVEIS_NOMES = Object.freeze(Object.keys(TIPOS_SERVIVEIS));

/** Pedido fora do formato aceito: segmentos, tipo ou nome inválidos. */
export class MediaRequestError extends Error {
  constructor(message, status = 404, detail = {}) {
    super(message);
    this.name = 'MediaRequestError';
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Segmentos da URL → arquivo servível.
 *
 * Exige exatamente três segmentos, um tipo conhecido, e delega a validação de
 * projeto e nome de arquivo aos resolvedores de caminho, que já garantem
 * contenção na raiz do runtime.
 *
 * @param {string[]} segments  [tipo, projectId, filename]
 * @returns {{absolutePath, mime, range, cacheControl, kind, filename, projectId}}
 */
export function resolveMediaRequest(segments, root = undefined) {
  if (!Array.isArray(segments) || segments.length !== 3) {
    throw new MediaRequestError('Recurso não encontrado.', 404, { segmentos: segments?.length ?? 0 });
  }

  const [tipo, projectId, filename] = segments;
  const config = TIPOS_SERVIVEIS[tipo];
  if (!config) {
    throw new MediaRequestError('Recurso não encontrado.', 404, { tipo });
  }

  let absolutePath;
  let mime;
  try {
    absolutePath = config.resolver(projectId, filename, root);
    mime = config.mime(filename);
  } catch (erro) {
    // Travessia, projeto inválido, extensão fora da lista: tudo é "inválido"
    // para quem pede. O motivo detalhado fica no servidor.
    if (erro instanceof PathValidationError || erro instanceof MediaKindError) {
      throw new MediaRequestError('Recurso inválido.', 400, { causa: erro.message });
    }
    throw erro;
  }

  return {
    kind: tipo,
    projectId,
    filename,
    absolutePath,
    mime,
    range: config.range,
    cacheControl: config.cacheControl,
  };
}

/**
 * Interpreta o cabeçalho `Range` de bytes.
 *
 * @returns {{inicio, fim}|null|'invalido'}  `null` quando não há Range válido
 *          a aplicar; `'invalido'` quando o intervalo pedido não cabe (416).
 */
export function parseByteRange(header, total) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;

  let inicio = match[1] === '' ? null : Number(match[1]);
  let fim = match[2] === '' ? null : Number(match[2]);

  if (inicio === null && fim === null) return null;

  if (inicio === null) {
    // "bytes=-N" — os N últimos bytes.
    inicio = Math.max(0, total - fim);
    fim = total - 1;
  } else {
    fim = fim === null ? total - 1 : Math.min(fim, total - 1);
  }

  if (!Number.isFinite(inicio) || !Number.isFinite(fim) || inicio > fim || inicio >= total) {
    return 'invalido';
  }
  return { inicio, fim };
}
