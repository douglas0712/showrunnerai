// Validação dos quadros enviados pelo usuário.
//
// Três garantias, todas exigidas antes de qualquer byte sair desta máquina
// para o ComfyUI:
//
//   1. O tipo vem dos bytes, não do que o navegador declarou nem da extensão
//      do nome — um .png renomeado a partir de um executável não passa.
//   2. O nome que vai para o disco é construído por nós a partir do jobId, e
//      nunca derivado do nome original. Não existe caminho a atravessar porque
//      não existe caminho vindo do usuário.
//   3. Os bytes do usuário nunca são reescritos: o arquivo original não é
//      tocado, só lido.
//
// Módulo puro — sem I/O, sem rede. É o que o torna testável.

import {
  ACCEPTED_IMAGE_TYPES, MAX_UPLOAD_BYTES, MIN_UPLOAD_BYTES, UPLOAD_SUBFOLDER,
} from './config.js';

export class UploadError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'UploadError';
    this.detail = detail;
  }
}

/** Papéis possíveis de um quadro. Restringe o nome do arquivo por construção. */
export const FRAME_ROLES = { FIRST: 'first', LAST: 'last' };

const ROLE_LABELS = {
  [FRAME_ROLES.FIRST]: 'primeiro quadro',
  [FRAME_ROLES.LAST]: 'último quadro',
};

export function roleLabel(role) {
  return ROLE_LABELS[role] || role;
}

/**
 * Detecta o formato pelos bytes iniciais.
 * @returns {{ext: string, mime: string}|null}
 */
export function detectImageType(bytes) {
  if (!bytes || bytes.length < 12) return null;

  for (const tipo of ACCEPTED_IMAGE_TYPES) {
    if (!tipo.magic) continue;
    if (tipo.magic.every((byte, i) => bytes[i] === byte)) {
      return { ext: tipo.ext, mime: tipo.mime };
    }
  }

  // WebP é um contêiner RIFF: "RIFF" nos bytes 0-3 e "WEBP" nos 8-11.
  const riff = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46;
  const webp = bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  if (riff && webp) return { ext: 'webp', mime: 'image/webp' };

  return null;
}

/**
 * Nome interno do quadro dentro do ComfyUI.
 *
 * Só jobId (já validado contra `^[A-Za-z0-9_-]{1,64}$`), papel e extensão de
 * uma lista fechada entram aqui. Nada do usuário atravessa.
 */
export function safeFrameName(jobId, role, ext) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(jobId || ''))) {
    throw new UploadError(`jobId inválido para nomear o quadro: "${jobId}".`);
  }
  if (!Object.values(FRAME_ROLES).includes(role)) {
    throw new UploadError(`Papel de quadro desconhecido: "${role}".`);
  }
  if (!ACCEPTED_IMAGE_TYPES.some((t) => t.ext === ext)) {
    throw new UploadError(`Extensão não aceita: "${ext}".`);
  }
  return `${jobId}_${role}.${ext}`;
}

/**
 * Valida um quadro recebido.
 *
 * @param {Buffer|Uint8Array} bytes
 * @param {object} opts  `declaredType` e `declaredName` entram apenas no
 *                       relatório; nenhuma decisão depende deles.
 * @returns {{role, mime, ext, bytes: number, filename, subfolder, declaredType, declaredName, mismatch}}
 */
export function validateFrame(bytes, { role, jobId, declaredType = null, declaredName = null } = {}) {
  if (!bytes || !bytes.length) {
    throw new UploadError(`O ${roleLabel(role)} chegou vazio.`, { role });
  }
  if (bytes.length < MIN_UPLOAD_BYTES) {
    throw new UploadError(`O ${roleLabel(role)} é pequeno demais para ser uma imagem (${bytes.length} bytes).`, { role, bytes: bytes.length });
  }
  if (bytes.length > MAX_UPLOAD_BYTES) {
    const limiteMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
    throw new UploadError(`O ${roleLabel(role)} passa de ${limiteMb} MB.`, { role, bytes: bytes.length, limite: MAX_UPLOAD_BYTES });
  }

  const tipo = detectImageType(bytes);
  if (!tipo) {
    throw new UploadError(
      `O ${roleLabel(role)} não é PNG, JPEG nem WebP. O conteúdo do arquivo foi conferido, não a extensão.`,
      { role, bytes: bytes.length, declaredType },
    );
  }

  return {
    role,
    mime: tipo.mime,
    ext: tipo.ext,
    bytes: bytes.length,
    filename: safeFrameName(jobId, role, tipo.ext),
    subfolder: UPLOAD_SUBFOLDER,
    declaredType,
    // O nome original serve para o usuário se reconhecer no log. Nunca vira
    // caminho: só o comprimento e um recorte curto são registrados.
    declaredName: declaredName ? String(declaredName).slice(0, 80) : null,
    // Navegador mentiu sobre o tipo? Não é motivo para recusar — o que vale é
    // o conteúdo —, mas é sinal que vale registrar.
    mismatch: Boolean(declaredType && declaredType !== tipo.mime),
  };
}

/**
 * Decide o modo a partir dos quadros presentes.
 * É a única regra que traduz "o que o usuário enviou" em "o que o grafo vira".
 */
export function modeForFrames({ first = null, last = null } = {}) {
  if (first && last) return 'flf';
  if (first) return 'i2v';
  if (last) {
    throw new UploadError('O último quadro só pode ser usado junto com o primeiro.');
  }
  return 't2v';
}

/** Metadados sanitizados de um quadro, prontos para o log. */
export function frameLogInfo(info) {
  if (!info) return null;
  return {
    papel: info.role,
    mime: info.mime,
    bytes: info.bytes,
    arquivoInterno: info.filename,
    subpasta: info.subfolder,
    tipoDeclarado: info.declaredType,
    nomeOriginalCaracteres: info.declaredName ? info.declaredName.length : 0,
    tipoDivergente: info.mismatch,
  };
}
