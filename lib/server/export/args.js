// Construção dos argumentos do FFmpeg — função pura, sem I/O e sem shell.
//
// O comando nunca é montado como string: `buildFfmpegArgs` devolve um array que
// vai direto para `spawn()`. Nada vindo do navegador entra aqui sem passar
// pelas validações de `TARGET_PRESETS` e pela resolução de caminhos do servidor.

/** Perfis de saída aceitos. O navegador escolhe um id, nunca valores soltos. */
export const TARGET_PRESETS = {
  'source-864x480-24': {
    id: 'source-864x480-24',
    label: 'Original — 864×480 · 24 fps',
    width: 864,
    height: 480,
    fps: 24,
    crf: 18,
    preset: 'medium',
    pixelFormat: 'yuv420p',
    audioBitrate: '192k',
    sampleRate: 48000,
    channels: 2,
  },
  '720p-24': {
    id: '720p-24',
    label: '720p — 1280×720 · 24 fps',
    width: 1280,
    height: 720,
    fps: 24,
    crf: 18,
    preset: 'medium',
    pixelFormat: 'yuv420p',
    audioBitrate: '192k',
    sampleRate: 48000,
    channels: 2,
  },
  '1080p-24': {
    id: '1080p-24',
    label: '1080p — 1920×1080 · 24 fps',
    width: 1920,
    height: 1080,
    fps: 24,
    crf: 18,
    preset: 'medium',
    pixelFormat: 'yuv420p',
    audioBitrate: '192k',
    sampleRate: 48000,
    channels: 2,
  },
};

export const DEFAULT_PRESET = 'source-864x480-24';

export class ExportArgsError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ExportArgsError';
  }
}

export function resolvePreset(id = DEFAULT_PRESET) {
  const preset = TARGET_PRESETS[id];
  if (!preset) {
    throw new ExportArgsError(`Perfil de exportação desconhecido: "${id}".`);
  }
  return preset;
}

/**
 * Cadeia de normalização de um vídeo de entrada.
 *
 * Sem isto a concatenação falha ou produz saída corrompida quando os clipes
 * divergem em qualquer detalhe. A ordem importa: escala e preenchimento antes
 * de fixar SAR, e o reset de timebase/PTS por último, para que cada trecho
 * comece do zero na emenda.
 */
export function videoNormalizeChain(index, target) {
  const { width, height, fps, pixelFormat } = target;
  return [
    `[${index}:v]`,
    `scale=${width}:${height}:force_original_aspect_ratio=decrease`,
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black`,
    'setsar=1',
    `fps=${fps}`,
    `format=${pixelFormat}`,
    'settb=AVTB',
    'setpts=PTS-STARTPTS',
  ].join(',').replace(`[${index}:v],`, `[${index}:v]`) + `[v${index}]`;
}

/**
 * Cadeia de normalização do áudio.
 *
 * Quando o clipe não tem trilha, geramos silêncio com a mesma duração — assim o
 * `concat` recebe o mesmo número de fluxos em todos os segmentos e o áudio dos
 * clipes que têm som não é descartado.
 */
export function audioNormalizeChain(index, target, { hasAudio, duration }) {
  const { sampleRate, channels } = target;
  const layout = channels === 1 ? 'mono' : 'stereo';
  const formato = `aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=${layout}`;

  if (hasAudio) {
    return `[${index}:a]${formato},asettb=AVTB,asetpts=PTS-STARTPTS[a${index}]`;
  }

  const segundos = Number(duration) > 0 ? Number(duration).toFixed(3) : '1.000';
  return [
    `anullsrc=channel_layout=${layout}:sample_rate=${sampleRate}`,
    `atrim=duration=${segundos}`,
    formato,
    'asettb=AVTB',
    'asetpts=PTS-STARTPTS',
  ].join(',') + `[a${index}]`;
}

/** Grafo completo: normaliza cada entrada e concatena vídeo + áudio. */
export function buildFilterGraph(inputs, target) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new ExportArgsError('Nenhuma cena para exportar.');
  }

  const cadeias = [];
  inputs.forEach((input, index) => {
    cadeias.push(videoNormalizeChain(index, target));
    cadeias.push(audioNormalizeChain(index, target, input));
  });

  const rotulos = inputs.map((_, i) => `[v${i}][a${i}]`).join('');
  cadeias.push(`${rotulos}concat=n=${inputs.length}:v=1:a=1[outv][outa]`);

  return cadeias.join(';');
}

/**
 * Array de argumentos do FFmpeg.
 *
 * @param {object} opts
 * @param {Array<{path: string, hasAudio: boolean, duration: number}>} opts.inputs
 * @param {object} opts.target  perfil resolvido por `resolvePreset`
 * @param {string} opts.outputPath caminho absoluto já validado pelo servidor
 * @returns {string[]}
 */
export function buildFfmpegArgs({ inputs, target, outputPath }) {
  if (!Array.isArray(inputs) || inputs.length === 0) {
    throw new ExportArgsError('Nenhuma cena para exportar.');
  }
  if (typeof outputPath !== 'string' || !outputPath.startsWith('/')) {
    throw new ExportArgsError('Caminho de saída inválido.');
  }
  inputs.forEach((input, i) => {
    if (typeof input?.path !== 'string' || !input.path.startsWith('/')) {
      throw new ExportArgsError(`Entrada ${i} sem caminho absoluto resolvido pelo servidor.`);
    }
  });

  const args = ['-hide_banner', '-nostdin', '-y'];

  // Entradas: uma flag -i por arquivo, sempre como argumento separado.
  inputs.forEach((input) => {
    args.push('-i', input.path);
  });

  args.push('-filter_complex', buildFilterGraph(inputs, target));
  args.push('-map', '[outv]', '-map', '[outa]');

  // Vídeo
  args.push(
    '-c:v', 'libx264',
    '-preset', target.preset,
    '-crf', String(target.crf),
    '-pix_fmt', target.pixelFormat,
    '-r', String(target.fps),
  );

  // Áudio
  args.push(
    '-c:a', 'aac',
    '-b:a', target.audioBitrate,
    '-ar', String(target.sampleRate),
    '-ac', String(target.channels),
  );

  // Reprodução imediata no player da aplicação.
  args.push('-movflags', '+faststart');

  // Progresso legível por máquina no stdout.
  args.push('-progress', 'pipe:1', '-nostats');

  args.push(outputPath);
  return args;
}

/** Duração prevista da montagem — soma simples, porque o corte é seco. */
export function expectedDuration(inputs = []) {
  return Number(inputs.reduce((soma, i) => soma + (Number(i.duration) || 0), 0).toFixed(3));
}

/**
 * Interpreta uma linha de `-progress pipe:1`.
 * O FFmpeg emite pares chave=valor; `out_time_us` é o relógio da saída.
 */
export function parseProgressLine(linha, totalDuration) {
  const match = /^([a-z_]+)=(.*)$/.exec(String(linha).trim());
  if (!match) return null;
  const [, chave, valor] = match;

  if (chave === 'out_time_us' || chave === 'out_time_ms') {
    const microssegundos = Number(valor);
    if (!Number.isFinite(microssegundos) || microssegundos < 0) return null;
    const segundos = microssegundos / 1_000_000;
    const total = Number(totalDuration) || 0;
    return {
      seconds: Number(segundos.toFixed(3)),
      progress: total > 0 ? Math.min(1, Math.max(0, segundos / total)) : null,
    };
  }

  if (chave === 'progress') {
    return { done: valor === 'end' };
  }

  if (chave === 'frame') {
    const frames = Number(valor);
    return Number.isFinite(frames) ? { frames } : null;
  }

  return null;
}
