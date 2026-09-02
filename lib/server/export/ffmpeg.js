// Invocação do FFmpeg. Sempre com array de argumentos e `shell: false`.

import { spawn } from 'node:child_process';
import { access, constants } from 'node:fs/promises';

const FFMPEG_BIN = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';

export class FfmpegError extends Error {
  constructor(message, { code = null, stderr = null } = {}) {
    super(message);
    this.name = 'FfmpegError';
    this.code = code;
    this.stderr = stderr;
  }
}

export async function ffmpegAvailable() {
  for (const bin of [FFMPEG_BIN, FFPROBE_BIN]) {
    try {
      await access(bin, constants.X_OK);
    } catch {
      return { ok: false, message: `Executável não encontrado: ${bin}` };
    }
  }
  const versao = await ffmpegVersion().catch(() => null);
  return { ok: Boolean(versao), version: versao, ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN };
}

export function ffmpegVersion() {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, ['-hide_banner', '-version'], { shell: false });
    let saida = '';
    proc.stdout.on('data', (c) => { saida += c.toString(); });
    proc.on('error', reject);
    proc.on('close', () => {
      const match = /^ffmpeg version (\S+)/m.exec(saida);
      resolve(match ? match[1] : null);
    });
  });
}

/** Metadados de um arquivo: duração, dimensões, fps e presença de áudio. */
export function probe(absolutePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      absolutePath,
    ];
    const proc = spawn(FFPROBE_BIN, args, { shell: false });

    let saida = '';
    let erro = '';
    proc.stdout.on('data', (c) => { saida += c.toString(); });
    proc.stderr.on('data', (c) => { erro += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new FfmpegError(`ffprobe falhou em ${absolutePath}.`, { code, stderr: erro.slice(0, 500) }));
        return;
      }
      try {
        resolve(normalizeProbe(JSON.parse(saida)));
      } catch (e) {
        reject(new FfmpegError(`Resposta do ffprobe ilegível: ${e.message}`));
      }
    });
  });
}

export function normalizeProbe(bruto) {
  const streams = bruto?.streams || [];
  const video = streams.find((s) => s.codec_type === 'video') || null;
  const audio = streams.find((s) => s.codec_type === 'audio') || null;

  return {
    duration: Number(bruto?.format?.duration) || 0,
    bytes: Number(bruto?.format?.size) || 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video ? Number(video.width) : null,
    height: video ? Number(video.height) : null,
    fps: video ? parseFrameRate(video.r_frame_rate) : null,
    pixelFormat: video?.pix_fmt || null,
    videoCodec: video?.codec_name || null,
    sampleAspectRatio: video?.sample_aspect_ratio || null,
    audioCodec: audio?.codec_name || null,
    sampleRate: audio ? Number(audio.sample_rate) : null,
    channels: audio ? Number(audio.channels) : null,
  };
}

export function parseFrameRate(valor) {
  const match = /^(\d+)\/(\d+)$/.exec(String(valor || ''));
  if (!match) return null;
  const den = Number(match[2]);
  if (!den) return null;
  return Number((Number(match[1]) / den).toFixed(3));
}

/**
 * Executa o FFmpeg com um array de argumentos.
 *
 * @param {string[]} args
 * @param {object} handlers
 * @param {(linha: string) => void} handlers.onProgressLine
 * @param {(proc: import('node:child_process').ChildProcess) => void} handlers.onSpawn
 * @returns {Promise<{code: number, stderr: string}>}
 */
export function runFfmpeg(args, { onProgressLine, onSpawn, cwd } = {}) {
  return new Promise((resolve, reject) => {
    // shell: false é o ponto — nada é interpretado por um shell.
    const proc = spawn(FFMPEG_BIN, args, { shell: false, cwd, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderr = '';
    let restoStdout = '';

    onSpawn?.(proc);

    proc.stdout.on('data', (chunk) => {
      restoStdout += chunk.toString();
      const linhas = restoStdout.split('\n');
      restoStdout = linhas.pop() || '';
      linhas.forEach((linha) => onProgressLine?.(linha));
    });

    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      // O stderr do FFmpeg é verboso; guardamos só a cauda para diagnóstico.
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    proc.on('error', (erro) => {
      reject(new FfmpegError(`Não foi possível iniciar o FFmpeg: ${erro.message}`));
    });

    proc.on('close', (code, signal) => {
      resolve({ code, signal, stderr });
    });
  });
}

/**
 * Extrai a causa provável de um stderr do FFmpeg, para a interface poder dizer
 * algo compreensível em vez de despejar centenas de linhas.
 */
export function explainFfmpegError(stderr = '', code = null) {
  const texto = String(stderr);

  const padroes = [
    [/No such file or directory/i, 'Um dos arquivos de cena não foi encontrado.'],
    [/Invalid data found when processing input/i, 'Um dos arquivos está corrompido ou não é um vídeo válido.'],
    [/Permission denied/i, 'Sem permissão para ler uma das cenas ou gravar a saída.'],
    [/No space left on device/i, 'Sem espaço em disco para gravar a exportação.'],
    [/Unknown encoder/i, 'O FFmpeg desta máquina não tem o codificador necessário (libx264/aac).'],
    [/Filter .* not found|No such filter/i, 'O FFmpeg desta máquina não tem um filtro necessário.'],
    [/does not contain any stream/i, 'Um dos arquivos não tem fluxo de vídeo.'],
    [/Conversion failed/i, 'A conversão falhou durante a codificação.'],
  ];

  for (const [padrao, mensagem] of padroes) {
    if (padrao.test(texto)) return mensagem;
  }

  const ultimaLinha = texto.trim().split('\n').filter(Boolean).pop();
  if (ultimaLinha) return ultimaLinha.slice(0, 200);
  return `O FFmpeg terminou com código ${code}.`;
}

export { FFMPEG_BIN, FFPROBE_BIN };
