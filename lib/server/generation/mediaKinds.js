// Vocabulário de mídia da camada de geração.
//
// Um único lugar decide, por tipo de mídia: em que diretório o arquivo mora,
// que segmento de URL o serve, que extensões são aceitas e qual o MIME de cada
// uma. Antes essas quatro decisões estavam espalhadas e todas presumiam MP4.
//
// Este módulo não importa nada de comfy/ nem de generation/workflows/: ele é
// consultado por comfy/storage.js e pela rota de mídia, que estão abaixo dele
// na ordem de dependência.

/** Falha de tipo de mídia: extensão fora da lista, kind desconhecido. */
export class MediaKindError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'MediaKindError';
    this.detail = detail;
  }
}

/**
 * Os tipos de mídia que a aplicação sabe produzir e servir.
 *
 * `dir` e `urlSegment` do vídeo são exatamente os que já estavam em uso —
 * runtime/projects/<id>/videos/ e /api/media/video/... — porque mudá-los
 * quebraria as URLs dos vídeos que já existem em disco.
 */
export const MEDIA_KINDS = Object.freeze({
  video: Object.freeze({
    kind: 'video',
    dir: 'videos',
    urlSegment: 'video',
    defaultExtension: '.mp4',
    supportsRange: true,
    // O que a aplicação ARMAZENA e SERVE. O SaveVideo produz MP4 e é como o
    // arquivo é publicado — qualquer contêiner que chegue é copiado com este
    // nome, exatamente como antes desta etapa.
    mimeByExtension: Object.freeze({ '.mp4': 'video/mp4' }),
    // O que a aplicação RECONHECE como saída de vídeo no /history. É um
    // superconjunto: o ComfyUI pode publicar em outros contêineres, e recusar
    // a descoberta por causa disso perderia o resultado.
    discoveryExtensions: Object.freeze(['.mp4', '.webm', '.mkv', '.mov', '.m4v']),
    // 'declared': a extensão publicada é a que o ComfyUI produziu, e só pode
    // ser uma das servíveis. Não normalizamos contêiner de vídeo porque isso
    // exigiria transcodificar — renomear um WebM para .mp4 seria mentir.
    extensionSource: 'declared',
  }),
  image: Object.freeze({
    kind: 'image',
    dir: 'images',
    urlSegment: 'image',
    defaultExtension: '.png',
    supportsRange: false,
    mimeByExtension: Object.freeze({
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      // WebP entra porque já temos como confirmá-lo pelos bytes: o contêiner
      // RIFF é conferido por detectImageType() em comfy/images.js, o mesmo
      // caminho que valida os quadros que o usuário envia. Não é palpite de
      // extensão.
      '.webp': 'image/webp',
    }),
    // Para imagem as duas listas coincidem: só reconhecemos o que sabemos
    // servir com o MIME certo.
    discoveryExtensions: Object.freeze(['.png', '.jpg', '.jpeg', '.webp']),
    // 'bytes': a extensão publicada vem do formato DETECTADO no arquivo, não
    // do nome que o nó devolveu. Um nó que chama de .jpg um PNG é comum, e o
    // número mágico nos diz o formato real com segurança — então normalizamos
    // em vez de perder uma geração válida.
    extensionSource: 'bytes',
  }),
});

export const MEDIA_KIND_NAMES = Object.freeze(Object.keys(MEDIA_KINDS));

/** Descrição de um tipo de mídia. Kind desconhecido falha alto. */
export function mediaKind(kind) {
  const encontrado = MEDIA_KINDS[kind];
  if (!encontrado) {
    throw new MediaKindError(`Tipo de mídia desconhecido: "${kind}".`, {
      kind,
      aceitos: MEDIA_KIND_NAMES,
    });
  }
  return encontrado;
}

export function isMediaKind(kind) {
  return Object.prototype.hasOwnProperty.call(MEDIA_KINDS, kind);
}

/** Extensões que a aplicação armazena e serve para este tipo. */
export function extensionsFor(kind) {
  return Object.keys(mediaKind(kind).mimeByExtension);
}

/** Extensões que a aplicação reconhece como saída deste tipo no /history. */
export function discoveryExtensionsFor(kind) {
  return [...mediaKind(kind).discoveryExtensions];
}

/**
 * Quem decide a extensão final publicada: 'bytes' (o formato detectado no
 * arquivo) ou 'declared' (o nome que o produtor devolveu).
 */
export function extensionSourceFor(kind) {
  return mediaKind(kind).extensionSource;
}

/**
 * Extensão canônica de um formato detectado.
 *
 * `detectImageType` devolve 'png' | 'jpg' | 'webp'; aqui isso vira a extensão
 * que a aplicação grava e sabe servir com o MIME correspondente.
 */
export function canonicalExtensionFor(kind, formatoDetectado) {
  const candidata = `.${String(formatoDetectado || '').replace(/^\./, '').toLowerCase()}`;
  if (!isStorableExtension(kind, `x${candidata}`)) {
    throw new MediaKindError(
      `Formato detectado sem extensão publicável em ${kind}: "${formatoDetectado}".`,
      { kind, formatoDetectado, aceitas: extensionsFor(kind) },
    );
  }
  return candidata;
}

/**
 * Extensão de um nome de arquivo, normalizada.
 *
 * Só o último ponto conta, e nada de barra: um "arquivo" com caminho dentro
 * não é nome de arquivo e não passa daqui.
 */
export function extensionOf(filename) {
  const texto = String(filename ?? '');
  if (!texto || texto.includes('/') || texto.includes('\\')) return '';
  const ponto = texto.lastIndexOf('.');
  if (ponto <= 0) return '';
  return texto.slice(ponto).toLowerCase();
}

/**
 * A extensão pertence a este tipo de mídia?
 *
 * Usa a lista de DESCOBERTA — é a pergunta que a leitura do /history faz.
 * Para decidir se um arquivo pode ser gravado e servido, use `mimeFor`, que
 * consulta a lista mais estrita.
 */
export function isExtensionOfKind(kind, filename) {
  const ext = extensionOf(filename);
  return Boolean(ext) && mediaKind(kind).discoveryExtensions.includes(ext);
}

/** A extensão pode ser gravada e servida para este tipo? */
export function isStorableExtension(kind, filename) {
  const ext = extensionOf(filename);
  return Boolean(ext) && ext in mediaKind(kind).mimeByExtension;
}

/**
 * MIME de um arquivo dentro de um tipo. Extensão fora da lista é erro — nunca
 * caímos num `application/octet-stream` genérico, porque servir bytes com o
 * tipo errado é justamente o que `nosniff` existe para impedir.
 */
export function mimeFor(kind, filename) {
  const ext = extensionOf(filename);
  const mime = mediaKind(kind).mimeByExtension[ext];
  if (!mime) {
    throw new MediaKindError(
      `Extensão não aceita para ${kind}: "${ext || filename}".`,
      { kind, extensao: ext, aceitas: extensionsFor(kind) },
    );
  }
  return mime;
}

/**
 * Qual tipo de mídia esta extensão representa, se alguma.
 * Devolve `null` em vez de lançar: é usado para classificar, não para validar.
 */
export function kindOfExtension(filename) {
  const ext = extensionOf(filename);
  if (!ext) return null;
  for (const nome of MEDIA_KIND_NAMES) {
    if (MEDIA_KINDS[nome].discoveryExtensions.includes(ext)) return nome;
  }
  return null;
}
