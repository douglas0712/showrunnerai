// Filmstrip: regras puras de amostragem e layout. Sem I/O, sem React —
// as mesmas funções valem no servidor (extração) e no cliente (renderização).

/** Frações da duração amostradas em cada clipe. */
export const FRAME_FRACTIONS = [0.1, 0.35, 0.6, 0.85];

export const MAX_FRAMES = FRAME_FRACTIONS.length;

/**
 * Instantes a extrair, em segundos.
 *
 * Evitamos o primeiro e o último instante de propósito: o começo costuma ser
 * um fade-in e o fim um fade-out, e ambos rendem quadros pretos que não
 * ajudam a reconhecer a cena.
 */
export function frameTimestamps(duration, fractions = FRAME_FRACTIONS) {
  const total = Number(duration);
  if (!Number.isFinite(total) || total <= 0) return [];
  return fractions.map((f) => Number(Math.min(total * f, Math.max(0, total - 0.05)).toFixed(3)));
}

/**
 * Chave de cache: identidade do vídeo + o que foi amostrado.
 *
 * O hash entra na chave para que trocar o MP4 invalide a tira automaticamente;
 * as frações entram para que mudar a amostragem também invalide.
 */
export function cacheKeyFor(jobId, hash, fractions = FRAME_FRACTIONS) {
  const curto = String(hash || '').slice(0, 16);
  const assinatura = fractions.map((f) => String(f).replace('.', '')).join('-');
  return `${jobId}_${curto}_${assinatura}`;
}

/**
 * Quantos quadros cabem legíveis na largura disponível.
 *
 * Um clipe curto ocupa poucos pixels na régua; espremer quatro células ali
 * produz faixas ilegíveis. Abaixo de ~72 px por célula, reduzimos a amostra.
 */
export function responsiveFrameCount(widthPx, maxFrames = MAX_FRAMES, minCellPx = 72) {
  const largura = Number(widthPx);
  if (!Number.isFinite(largura) || largura <= 0) return 1;
  const cabem = Math.floor(largura / minCellPx);
  return Math.min(maxFrames, Math.max(1, cabem));
}

/**
 * Escolhe quais quadros mostrar quando não cabem todos, mantendo os extremos
 * da amostra para que a tira ainda represente o arco do clipe.
 */
export function pickVisibleFrames(frames = [], count = MAX_FRAMES) {
  const total = frames.length;
  if (total === 0) return [];
  const alvo = Math.min(total, Math.max(1, count));
  if (alvo >= total) return frames;
  if (alvo === 1) return [frames[Math.floor((total - 1) / 2)]];

  const passo = (total - 1) / (alvo - 1);
  return Array.from({ length: alvo }, (_, i) => frames[Math.round(i * passo)]);
}

/** Timecode curto para o rodapé do clipe: 00:05,88 */
export function shortTimecode(seconds = 0) {
  const total = Math.max(0, Number(seconds) || 0);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  const inteiro = Math.floor(ss);
  const centesimos = Math.round((ss - inteiro) * 100);
  const fracao = centesimos ? `,${String(centesimos).padStart(2, '0')}` : '';
  return `${String(mm).padStart(2, '0')}:${String(inteiro).padStart(2, '0')}${fracao}`;
}

/** Faixa "00:00–00:05,88" a partir do início e da duração. */
export function clipRangeLabel(start = 0, duration = 0) {
  return `${shortTimecode(start)}–${shortTimecode(Number(start) + Number(duration))}`;
}
