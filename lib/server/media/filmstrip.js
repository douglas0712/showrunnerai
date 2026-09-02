// Extração e cache das filmstrips.
//
// Quatro quadros por clipe, extraídos com FFmpeg e guardados no runtime do
// projeto. A chave inclui o hash do MP4, então o cache se invalida sozinho se
// o arquivo mudar — e nunca reextrai enquanto ele for o mesmo.
//
// O navegador só informa o jobId; o caminho vem da allowlist do servidor.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_ROOT } from '../comfy/config.js';
import { filmstripDirFor, frameUrlFor } from '../comfy/storage.js';
import { listRegisteredVideos, AssetResolutionError } from '../export/assets.js';
import { FFMPEG_BIN, probe } from '../export/ffmpeg.js';
import { FRAME_FRACTIONS, cacheKeyFor, frameTimestamps } from '../../filmstrip.js';

/** Largura de extração. Pequena o bastante para caber no cache, nítida na régua. */
const FRAME_WIDTH = 480;

/**
 * Realce aplicado SOMENTE às miniaturas.
 *
 * As cenas são noturnas e ficavam quase pretas em células de ~100 px. Este
 * ajuste é de apresentação: o MP4 original não é tocado.
 */
const CONTRAST_FILTER = 'eq=brightness=0.06:contrast=1.14:saturation=1.06';

export class FilmstripError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'FilmstripError';
    this.detail = detail;
  }
}

export function hashFile(absolutePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(absolutePath);
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Extrai um quadro no instante pedido. Sempre com array de argumentos. */
function extrairQuadro(input, segundos, destino) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-y',
      // -ss antes de -i faz a busca rápida por keyframe.
      '-ss', String(segundos),
      '-i', input,
      '-frames:v', '1',
      '-vf', `${CONTRAST_FILTER},scale=${FRAME_WIDTH}:-2`,
      '-q:v', '3',
      destino,
    ];
    const proc = spawn(FFMPEG_BIN, args, { shell: false });
    let erro = '';
    proc.stderr.on('data', (c) => { erro += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (
      code === 0 ? resolve(destino) : reject(new FilmstripError(`Falha ao extrair quadro em ${segundos}s.`, { stderr: erro.slice(-300) }))
    ));
  });
}

async function existe(p) {
  try {
    const info = await stat(p);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/**
 * Devolve a filmstrip de um clipe, extraindo apenas se ainda não houver cache.
 *
 * @param {string} jobId  identificador registrado — nunca um caminho
 * @returns {Promise<{jobId, projectId, hash, cacheKey, cached, frames, duration}>}
 */
export async function getFilmstrip(jobId, { root = RUNTIME_ROOT, fractions = FRAME_FRACTIONS } = {}) {
  if (typeof jobId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) {
    throw new AssetResolutionError(`jobId inválido: "${jobId}".`);
  }

  const allowlist = await listRegisteredVideos(root);
  const asset = allowlist.find((a) => a.jobId === jobId);
  if (!asset) {
    throw new AssetResolutionError('Asset não encontrado entre os vídeos registrados.', { jobId });
  }

  const [hash, sonda] = await Promise.all([
    hashFile(asset.absolutePath),
    probe(asset.absolutePath),
  ]);

  const instantes = frameTimestamps(sonda.duration, fractions);
  if (!instantes.length) {
    throw new FilmstripError('Não foi possível determinar a duração do vídeo.', { jobId });
  }

  const cacheKey = cacheKeyFor(jobId, hash, fractions);
  const dir = filmstripDirFor(asset.projectId, root);
  await mkdir(dir, { recursive: true });

  const arquivos = instantes.map((_, i) => `${cacheKey}__${i}.jpg`);
  const caminhos = arquivos.map((nome) => path.join(dir, nome));

  const jaExistem = await Promise.all(caminhos.map(existe));
  const cached = jaExistem.every(Boolean);

  if (!cached) {
    for (const [i, segundos] of instantes.entries()) {
      if (jaExistem[i]) continue;
      // eslint-disable-next-line no-await-in-loop
      await extrairQuadro(asset.absolutePath, segundos, caminhos[i]);
    }
    // Um MP4 novo gera outra chave; as tiras antigas deste job viram lixo.
    await limparAntigos(dir, jobId, cacheKey).catch(() => {});
  }

  return {
    jobId,
    projectId: asset.projectId,
    hash,
    cacheKey,
    cached,
    duration: Number(sonda.duration.toFixed(3)),
    width: sonda.width,
    height: sonda.height,
    frames: instantes.map((segundos, i) => ({
      index: i,
      at: segundos,
      fraction: fractions[i],
      url: frameUrlFor(asset.projectId, arquivos[i]),
    })),
  };
}

/** Remove tiras de versões anteriores do mesmo job. */
async function limparAntigos(dir, jobId, cacheKeyAtual) {
  const arquivos = await readdir(dir).catch(() => []);
  const obsoletos = arquivos.filter(
    (nome) => nome.startsWith(`${jobId}_`) && !nome.startsWith(`${cacheKeyAtual}__`),
  );
  await Promise.all(obsoletos.map((nome) => rm(path.join(dir, nome), { force: true })));
  return obsoletos;
}

export { limparAntigos };
