// Orquestração da exportação real.
//
// Fluxo: validar → resolver assets pela allowlist → sondar → montar argumentos
// → executar o FFmpeg num temporário dentro do runtime → mover para o destino
// final → limpar. O job vive no servidor, então trocar de aba ou recarregar a
// página não interrompe nada.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  exportDirFor, exportTempDirFor, exportUrlFor, exists,
} from '../comfy/storage.js';
import { RUNTIME_ROOT } from '../comfy/config.js';
import { resolveTimelineAssets, AssetResolutionError } from './assets.js';
import {
  buildFfmpegArgs, expectedDuration, parseProgressLine, resolvePreset, ExportArgsError,
} from './args.js';
import { explainFfmpegError, probe, runFfmpeg } from './ffmpeg.js';

export const EXPORT_STATES = {
  PREPARING: 'preparando',
  RESOLVING: 'resolvendo-cenas',
  ENCODING: 'codificando',
  FINALIZING: 'finalizando',
  DONE: 'concluido',
  FAILED: 'falhou',
  CANCELLED: 'cancelado',
};

export const EXPORT_STATE_LABELS = {
  [EXPORT_STATES.PREPARING]: 'Preparando',
  [EXPORT_STATES.RESOLVING]: 'Resolvendo cenas',
  [EXPORT_STATES.ENCODING]: 'Codificando',
  [EXPORT_STATES.FINALIZING]: 'Finalizando',
  [EXPORT_STATES.DONE]: 'Concluído',
  [EXPORT_STATES.FAILED]: 'Falhou',
  [EXPORT_STATES.CANCELLED]: 'Cancelado',
};

const TERMINAIS = [EXPORT_STATES.DONE, EXPORT_STATES.FAILED, EXPORT_STATES.CANCELLED];
export const isExportTerminal = (estado) => TERMINAIS.includes(estado);

// Registro em globalThis: sobrevive ao recarregamento de módulos do Next em dev.
const CHAVE = Symbol.for('showrunner.export.jobs');
function store() {
  if (!globalThis[CHAVE]) globalThis[CHAVE] = { jobs: new Map() };
  return globalThis[CHAVE];
}

export function getExportJob(exportId) {
  return store().jobs.get(exportId) || null;
}

export function listExportJobs({ projectId = null } = {}) {
  return [...store().jobs.values()]
    .filter((j) => !projectId || j.projectId === projectId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicExportJob);
}

function updateJob(exportId, patch) {
  const job = getExportJob(exportId);
  if (!job) return null;
  Object.assign(job, patch);
  return job;
}

export function newExportId() {
  return `export_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Bloqueio de aprovação.
 *
 * É um portão de fluxo de trabalho, não uma fronteira de segurança: o estado de
 * aprovação vive no navegador. A fronteira real é a allowlist de caminhos.
 */
export function findPendingScenes(clips = []) {
  return clips
    .map((clip, indice) => ({ indice, clip }))
    .filter(({ clip }) => clip?.approved !== true)
    .map(({ indice, clip }) => ({
      posicao: indice + 1,
      titulo: typeof clip?.title === 'string' && clip.title ? clip.title : `Cena ${indice + 1}`,
      status: clip?.status || 'pendente',
    }));
}

/**
 * Inicia a exportação. Devolve o job imediatamente; a codificação segue em
 * segundo plano no servidor.
 */
export async function startExport({ projectId, clips, presetId, root = RUNTIME_ROOT }) {
  const pendentes = findPendingScenes(clips);
  if (pendentes.length) {
    const erro = new ExportArgsError(
      `Há ${pendentes.length} cena(s) sem aprovação: ${pendentes.map((p) => `#${p.posicao} ${p.titulo}`).join(', ')}.`,
    );
    erro.pending = pendentes;
    throw erro;
  }

  const target = resolvePreset(presetId);

  // Resolver e sondar ANTES de aceitar o pedido: assim uma cena inexistente ou
  // uma URL fora do padrão viram erro imediato na resposta, em vez de um job
  // que nasce aceito e falha em segundo plano.
  const assets = await resolveTimelineAssets(clips, { root });
  const entradas = [];
  for (const asset of assets) {
    // eslint-disable-next-line no-await-in-loop
    const info = await probe(asset.absolutePath);
    if (!info.hasVideo) {
      throw new AssetResolutionError(`A cena "${asset.title}" não tem fluxo de vídeo.`);
    }
    entradas.push({ path: asset.absolutePath, hasAudio: info.hasAudio, duration: info.duration, probe: info, asset });
  }

  const exportId = newExportId();

  const job = {
    exportId,
    projectId,
    state: EXPORT_STATES.PREPARING,
    progress: 0,
    encodedSeconds: 0,
    frames: 0,
    error: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    presetId: target.id,
    presetLabel: target.label,
    width: target.width,
    height: target.height,
    fps: target.fps,
    scenes: [],
    expectedDuration: 0,
    result: null,
    args: null,
    proc: null,
    cancelRequested: false,
    costUsd: 0,
  };
  job.root = root;
  store().jobs.set(exportId, job);

  // A codificação segue fora do ciclo da requisição.
  executar(job, entradas, target, root).catch((erro) => {
    updateJob(exportId, {
      state: EXPORT_STATES.FAILED,
      error: erro.message,
      finishedAt: Date.now(),
      proc: null,
    });
  });

  return publicExportJob(job);
}

async function executar(job, entradas, target, root) {
  const { exportId, projectId } = job;

  updateJob(exportId, { state: EXPORT_STATES.RESOLVING });
  const duracaoPrevista = expectedDuration(entradas);

  updateJob(exportId, {
    expectedDuration: duracaoPrevista,
    scenes: entradas.map((e, i) => ({
      order: i,
      title: e.asset.title,
      jobId: e.asset.jobId,
      resultId: e.asset.resultId,
      filename: e.asset.filename,
      url: e.asset.url,
      duration: Number(e.duration.toFixed(3)),
      width: e.probe.width,
      height: e.probe.height,
      fps: e.probe.fps,
      videoCodec: e.probe.videoCodec,
      audioCodec: e.probe.audioCodec,
      sampleRate: e.probe.sampleRate,
      hasAudio: e.probe.hasAudio,
    })),
  });

  if (job.cancelRequested) {
    updateJob(exportId, { state: EXPORT_STATES.CANCELLED, finishedAt: Date.now() });
    return;
  }

  // ── 3. Caminhos: temporário dentro do runtime do projeto ─────────────────
  const destinoDir = exportDirFor(projectId, root);
  const tempDir = exportTempDirFor(projectId, exportId, root);
  await mkdir(destinoDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });

  const tempOut = path.join(tempDir, `${exportId}.mp4`);
  const nomeFinal = await nomeLivre(destinoDir, exportId);
  const destinoFinal = path.join(destinoDir, nomeFinal);

  // ── 4. Argumentos e execução ────────────────────────────────────────────
  const args = buildFfmpegArgs({ inputs: entradas, target, outputPath: tempOut });
  updateJob(exportId, {
    state: EXPORT_STATES.ENCODING,
    startedAt: Date.now(),
    args,
    tempDir,
  });

  const resultado = await runFfmpeg(args, {
    cwd: tempDir,
    onSpawn: (proc) => updateJob(exportId, { proc, pid: proc.pid }),
    onProgressLine: (linha) => {
      const evento = parseProgressLine(linha, duracaoPrevista);
      if (!evento) return;
      const patch = {};
      if (evento.progress !== null && evento.progress !== undefined) patch.progress = evento.progress;
      if (evento.seconds !== undefined) patch.encodedSeconds = evento.seconds;
      if (evento.frames !== undefined) patch.frames = evento.frames;
      if (Object.keys(patch).length) updateJob(exportId, patch);
    },
  });

  updateJob(exportId, { proc: null });

  const atual = getExportJob(exportId);
  if (atual?.cancelRequested) {
    await limpar(tempDir, root);
    updateJob(exportId, { state: EXPORT_STATES.CANCELLED, finishedAt: Date.now(), progress: 0 });
    return;
  }

  if (resultado.code !== 0) {
    await limpar(tempDir, root);
    throw new Error(explainFfmpegError(resultado.stderr, resultado.code));
  }

  // ── 5. Finalizar: mover do temporário para o destino ────────────────────
  updateJob(exportId, { state: EXPORT_STATES.FINALIZING, progress: 1 });

  const info = await stat(tempOut).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    await limpar(tempDir, root);
    throw new Error('O FFmpeg terminou sem produzir o arquivo de saída.');
  }

  // rename dentro do mesmo sistema de arquivos é atômico: o destino nunca
  // existe pela metade.
  await rename(tempOut, destinoFinal);
  await limpar(tempDir, root);

  const [hash, sonda] = await Promise.all([
    hashFile(destinoFinal),
    probe(destinoFinal).catch(() => null),
  ]);

  updateJob(exportId, {
    state: EXPORT_STATES.DONE,
    finishedAt: Date.now(),
    progress: 1,
    result: {
      filename: nomeFinal,
      url: exportUrlFor(projectId, nomeFinal),
      logicalPath: `runtime/projects/${projectId}/exports/${nomeFinal}`,
      bytes: info.size,
      sha256: hash,
      duration: sonda ? Number(sonda.duration.toFixed(3)) : duracaoPrevista,
      width: sonda?.width ?? target.width,
      height: sonda?.height ?? target.height,
      fps: sonda?.fps ?? target.fps,
      videoCodec: sonda?.videoCodec ?? 'h264',
      audioCodec: sonda?.audioCodec ?? 'aac',
      sampleRate: sonda?.sampleRate ?? target.sampleRate,
      costUsd: 0,
    },
  });
}

/** Nome livre: nunca sobrescreve uma exportação anterior. */
async function nomeLivre(dir, base) {
  let nome = `${base}.mp4`;
  let n = 1;
  // eslint-disable-next-line no-await-in-loop
  while (await exists(path.join(dir, nome))) {
    n += 1;
    nome = `${base}-${n}.mp4`;
    if (n > 999) throw new Error('Não foi possível gerar um nome de exportação livre.');
  }
  return nome;
}

/**
 * Remove o diretório temporário — só ele.
 *
 * Duas condições antes de apagar qualquer coisa: estar dentro da raiz do
 * runtime e ter o prefixo `tmp-`. Sem as duas, não removemos nada.
 */
export async function limpar(tempDir, root = RUNTIME_ROOT) {
  if (!tempDir) return false;
  const raiz = path.resolve(root);
  const alvo = path.resolve(tempDir);
  if (!alvo.startsWith(`${raiz}${path.sep}`)) return false;
  if (!path.basename(alvo).startsWith('tmp-')) return false;
  await rm(alvo, { recursive: true, force: true }).catch(() => {});
  return true;
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

/** Cancela — apenas o processo deste job. */
export async function cancelExport(exportId) {
  const job = getExportJob(exportId);
  if (!job) return null;
  if (isExportTerminal(job.state)) return publicExportJob(job);

  updateJob(exportId, { cancelRequested: true });

  const proc = job.proc;
  if (proc && !proc.killed) {
    proc.kill('SIGTERM');
    // Se não encerrar em 3s, encerra à força — sempre este PID, nunca outro.
    setTimeout(() => {
      const atual = getExportJob(exportId);
      if (atual?.proc && !atual.proc.killed) atual.proc.kill('SIGKILL');
    }, 3000);
  } else {
    updateJob(exportId, { state: EXPORT_STATES.CANCELLED, finishedAt: Date.now() });
    await limpar(job.tempDir, job.root);
  }

  return publicExportJob(getExportJob(exportId));
}

/** Recorte seguro: o ChildProcess e os caminhos absolutos nunca vão ao cliente. */
export function publicExportJob(job) {
  if (!job) return null;
  const agora = Date.now();
  return {
    exportId: job.exportId,
    projectId: job.projectId,
    state: job.state,
    stateLabel: EXPORT_STATE_LABELS[job.state] || job.state,
    terminal: isExportTerminal(job.state),
    progress: job.progress,
    encodedSeconds: job.encodedSeconds,
    frames: job.frames,
    elapsedMs: (job.finishedAt || agora) - (job.startedAt || job.createdAt),
    error: job.error,
    presetId: job.presetId,
    presetLabel: job.presetLabel,
    width: job.width,
    height: job.height,
    fps: job.fps,
    expectedDuration: job.expectedDuration,
    scenes: job.scenes,
    result: job.result,
    costUsd: 0,
    createdAt: job.createdAt,
  };
}

export { ExportArgsError, AssetResolutionError };
