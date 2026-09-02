// Armazenamento próprio do Showrunner Studio + validação de caminhos.
//
// Regra: nenhuma rota lê arquivo por caminho vindo do navegador. O cliente
// informa apenas identificadores curtos (projeto e arquivo), validados contra
// uma lista de caracteres estrita, e o caminho final é resolvido e conferido
// contra a raiz do runtime antes de qualquer leitura.

import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { RUNTIME_ROOT } from './config.js';

export class PathValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PathValidationError';
  }
}

/** Só letras, números, hífen e sublinhado. Sem ponto, sem barra, sem espaço. */
const SEGMENT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function validateSegment(value, campo = 'segmento') {
  if (typeof value !== 'string' || !SEGMENT_RE.test(value)) {
    throw new PathValidationError(`${campo} inválido.`);
  }
  return value;
}

/** Nome de arquivo aceito: <segmento>.mp4 */
export function validateVideoFilename(value) {
  if (typeof value !== 'string') throw new PathValidationError('Nome de arquivo inválido.');
  const match = /^([A-Za-z0-9_-]{1,64})\.mp4$/.exec(value);
  if (!match) throw new PathValidationError('Nome de arquivo inválido.');
  return value;
}

/**
 * Caminho absoluto de um vídeo do projeto, garantidamente dentro do runtime.
 * Faz a checagem de contenção mesmo com os segmentos já validados — defesa em
 * profundidade contra qualquer regressão na regex.
 */
export function resolveVideoPath(projectId, filename, root = RUNTIME_ROOT) {
  validateSegment(projectId, 'projectId');
  validateVideoFilename(filename);

  const raiz = path.resolve(root);
  const destino = path.resolve(raiz, projectId, 'videos', filename);
  assertInside(raiz, destino);
  return destino;
}

export function videoDirFor(projectId, root = RUNTIME_ROOT) {
  validateSegment(projectId, 'projectId');
  const raiz = path.resolve(root);
  const dir = path.resolve(raiz, projectId, 'videos');
  assertInside(raiz, dir);
  return dir;
}

/** Garante que `alvo` está dentro de `raiz`. */
export function assertInside(raiz, alvo) {
  const base = path.resolve(raiz);
  const destino = path.resolve(alvo);
  const relativo = path.relative(base, destino);
  if (relativo === '' || relativo.startsWith('..') || path.isAbsolute(relativo)) {
    throw new PathValidationError('Caminho fora do armazenamento permitido.');
  }
  return destino;
}

/** Nome de quadro em cache: <chave>__<indice>.jpg */
const FRAME_FILE_RE = /^([A-Za-z0-9_-]{1,120})__(\d{1,2})\.jpg$/;

export function validateFrameFilename(value) {
  if (typeof value !== 'string' || !FRAME_FILE_RE.test(value)) {
    throw new PathValidationError('Nome de quadro inválido.');
  }
  return value;
}

/** Diretório de cache das filmstrips do projeto. */
export function filmstripDirFor(projectId, root = RUNTIME_ROOT) {
  validateSegment(projectId, 'projectId');
  const raiz = path.resolve(root);
  const dir = path.resolve(raiz, projectId, 'cache', 'filmstrip');
  assertInside(raiz, dir);
  return dir;
}

export function resolveFramePath(projectId, filename, root = RUNTIME_ROOT) {
  validateSegment(projectId, 'projectId');
  validateFrameFilename(filename);
  const raiz = path.resolve(root);
  const destino = path.resolve(raiz, projectId, 'cache', 'filmstrip', filename);
  assertInside(raiz, destino);
  return destino;
}

export function frameUrlFor(projectId, filename) {
  validateSegment(projectId, 'projectId');
  validateFrameFilename(filename);
  return `/api/media/frame/${projectId}/${filename}`;
}

/** Diretório de exportações finais do projeto. */
export function exportDirFor(projectId, root = RUNTIME_ROOT) {
  validateSegment(projectId, 'projectId');
  const raiz = path.resolve(root);
  const dir = path.resolve(raiz, projectId, 'exports');
  assertInside(raiz, dir);
  return dir;
}

/** Temporários da exportação — sempre dentro do runtime do projeto. */
export function exportTempDirFor(projectId, exportId, root = RUNTIME_ROOT) {
  validateSegment(projectId, 'projectId');
  validateSegment(exportId, 'exportId');
  const raiz = path.resolve(root);
  const dir = path.resolve(raiz, projectId, 'exports', `tmp-${exportId}`);
  assertInside(raiz, dir);
  return dir;
}

export function resolveExportPath(projectId, filename, root = RUNTIME_ROOT) {
  validateSegment(projectId, 'projectId');
  validateVideoFilename(filename);
  const raiz = path.resolve(root);
  const destino = path.resolve(raiz, projectId, 'exports', filename);
  assertInside(raiz, destino);
  return destino;
}

export function exportUrlFor(projectId, filename) {
  validateSegment(projectId, 'projectId');
  validateVideoFilename(filename);
  return `/api/media/export/${projectId}/${filename}`;
}

/** URL pública servida pela própria aplicação. */
export function mediaUrlFor(projectId, filename) {
  validateSegment(projectId, 'projectId');
  validateVideoFilename(filename);
  return `/api/media/video/${projectId}/${filename}`;
}

/**
 * Grava os bytes num temporário e só então publica com rename atômico.
 *
 * Escrever direto no caminho final abria uma janela real: um GET que chegasse
 * no meio da escrita via um arquivo truncado, com content-length menor que o
 * total, e o player recusava o MP4. Com o rename, a URL ou não existe (404) ou
 * já é o arquivo completo — nunca um meio-termo.
 *
 * Também nunca sobrescreve um resultado anterior.
 */
export async function saveVideoBytes(projectId, baseName, bytes, root = RUNTIME_ROOT) {
  validateSegment(projectId, 'projectId');
  validateSegment(baseName, 'nome do arquivo');

  const dir = videoDirFor(projectId, root);
  await mkdir(dir, { recursive: true });

  let nome = `${baseName}.mp4`;
  let contador = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await exists(path.join(dir, nome))) {
    contador += 1;
    nome = `${baseName}-${contador}.mp4`;
    if (contador > 999) throw new PathValidationError('Não foi possível gerar um nome livre.');
  }

  const destino = path.join(dir, nome);
  assertInside(path.resolve(root), destino);

  // O sufixo .part não casa com validateVideoFilename, então a rota de mídia
  // não serve o temporário nem por acidente.
  const temporario = `${destino}.part-${randomUUID().slice(0, 8)}`;
  assertInside(path.resolve(root), temporario);

  try {
    await writeFile(temporario, bytes, { flag: 'wx' });
    await rename(temporario, destino);
  } catch (erro) {
    await rm(temporario, { force: true }).catch(() => {});
    throw erro;
  }

  return { filename: nome, absolutePath: destino, url: mediaUrlFor(projectId, nome) };
}

/** Publica um arquivo já validado, com rename atômico. */
export async function publishVideoFile(projectId, baseName, tempPath, root = RUNTIME_ROOT) {
  validateSegment(projectId, 'projectId');
  validateSegment(baseName, 'nome do arquivo');

  const dir = videoDirFor(projectId, root);
  await mkdir(dir, { recursive: true });

  let nome = `${baseName}.mp4`;
  let contador = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await exists(path.join(dir, nome))) {
    contador += 1;
    nome = `${baseName}-${contador}.mp4`;
    if (contador > 999) throw new PathValidationError('Não foi possível gerar um nome livre.');
  }

  const destino = path.join(dir, nome);
  assertInside(path.resolve(root), destino);
  await rename(tempPath, destino);
  return { filename: nome, absolutePath: destino, url: mediaUrlFor(projectId, nome) };
}

/** Caminho temporário de download, dentro do próprio diretório do projeto. */
export async function videoTempPath(projectId, baseName, root = RUNTIME_ROOT) {
  validateSegment(projectId, 'projectId');
  validateSegment(baseName, 'nome do arquivo');
  const dir = videoDirFor(projectId, root);
  await mkdir(dir, { recursive: true });
  const temporario = path.join(dir, `${baseName}.mp4.part-${randomUUID().slice(0, 8)}`);
  assertInside(path.resolve(root), temporario);
  return temporario;
}

export async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Procura, em todos os projetos, um vídeo já gravado para este job.
 *
 * É o que torna a recuperação idempotente entre reinícios do servidor: sem
 * isso, cada restart baixaria o mesmo MP4 de novo e criaria uma cópia extra.
 */
export async function findVideoByJobId(jobId, root = RUNTIME_ROOT) {
  validateSegment(jobId, 'jobId');
  const raiz = path.resolve(root);

  let projetos;
  try {
    projetos = await readdir(raiz, { withFileTypes: true });
  } catch {
    return null;
  }

  const alvo = `${jobId}.mp4`;
  for (const entrada of projetos) {
    if (!entrada.isDirectory()) continue;
    // Ignora nomes de pasta que não passariam na validação de segmento.
    let dir;
    try {
      dir = videoDirFor(entrada.name, root);
    } catch {
      continue;
    }

    const caminho = path.join(dir, alvo);
    // eslint-disable-next-line no-await-in-loop
    if (await exists(caminho)) {
      return {
        projectId: entrada.name,
        filename: alvo,
        absolutePath: caminho,
        url: mediaUrlFor(entrada.name, alvo),
      };
    }
  }
  return null;
}

export async function listProjectVideos(projectId, root = RUNTIME_ROOT) {
  const dir = videoDirFor(projectId, root);
  try {
    const arquivos = await readdir(dir);
    return arquivos.filter((f) => f.endsWith('.mp4')).sort();
  } catch {
    return [];
  }
}
