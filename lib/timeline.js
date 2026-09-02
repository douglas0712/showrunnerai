// Timeline — modelo de dados e cálculos de layout.
//
// A fase 1 é visual, mas a estrutura já é a que a montagem real vai consumir:
// clipes com `start` derivado da ordem, trilhas separadas de vídeo e áudio e um
// plano de exportação que descreve, em termos de FFmpeg, o que seria executado.

import { makeId } from './rng.js';

export function createClip(partial = {}) {
  return {
    id: makeId('clip'),
    label: 'Clipe',
    duration: 6,
    sourceId: null,
    poster: null,
    track: 'video',
    ...partial,
  };
}

export function createAudioClip(partial = {}) {
  return createClip({ label: 'Áudio', track: 'audio', ...partial });
}

/** Duração total de uma trilha. */
export function trackDuration(clips = []) {
  return clips.reduce((sum, clip) => sum + (Number(clip.duration) || 0), 0);
}

export function timelineDuration(timeline = { video: [], audio: [] }) {
  return Math.max(trackDuration(timeline.video), trackDuration(timeline.audio));
}

/**
 * Converte uma trilha em segmentos posicionados, com largura percentual
 * relativa à duração total da timeline — é o que a régua desenha.
 */
export function layoutTrack(clips = [], totalDuration = 0) {
  const total = totalDuration > 0 ? totalDuration : trackDuration(clips);
  let cursor = 0;
  return clips.map((clip) => {
    const duration = Number(clip.duration) || 0;
    const segment = {
      ...clip,
      start: cursor,
      end: cursor + duration,
      leftPercent: total ? (cursor / total) * 100 : 0,
      widthPercent: total ? (duration / total) * 100 : 0,
    };
    cursor += duration;
    return segment;
  });
}

export function moveClip(clips = [], id, delta) {
  const index = clips.findIndex((clip) => clip.id === id);
  if (index === -1) return clips;
  const target = index + delta;
  if (target < 0 || target >= clips.length) return clips;
  const next = [...clips];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

export function removeClip(clips = [], id) {
  return clips.filter((clip) => clip.id !== id);
}

export function updateClip(clips = [], id, patch = {}) {
  return clips.map((clip) => (clip.id === id ? { ...clip, ...patch } : clip));
}

export function formatTimecode(seconds = 0, fps = 24) {
  const total = Math.max(0, Number(seconds) || 0);
  const mm = Math.floor(total / 60);
  const ss = Math.floor(total % 60);
  const ff = Math.floor((total % 1) * fps);
  return `${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

/**
 * Descreve a exportação que a fase 2 executará com FFmpeg.
 *
 * Nada é executado aqui: a função só devolve o plano (lista de entradas, filtro
 * de concatenação e argumentos de saída) para que a UI possa mostrar
 * exatamente o que aconteceria — e para que a integração real só precise
 * passar este objeto adiante.
 */
export function buildExportPlan(timeline = { video: [], audio: [] }, options = {}) {
  const { fps = 24, resolution = '1080p', output = 'showrunner-export.mp4' } = options;
  const videoClips = timeline.video || [];
  const audioClips = timeline.audio || [];
  const inputs = [...videoClips, ...audioClips].map((clip, index) => ({
    index,
    id: clip.id,
    label: clip.label,
    duration: clip.duration,
    track: clip.track,
    source: clip.sourceId ? `generation:${clip.sourceId}` : 'simulado (sem arquivo em disco)',
  }));

  const concatFilter = videoClips.length
    ? `${videoClips.map((_, i) => `[${i}:v]`).join('')}concat=n=${videoClips.length}:v=1:a=0[outv]`
    : '';

  return {
    output,
    fps,
    resolution,
    totalDuration: timelineDuration(timeline),
    inputs,
    filterComplex: concatFilter,
    args: [
      ...inputs.flatMap((input) => ['-i', input.source]),
      ...(concatFilter ? ['-filter_complex', concatFilter, '-map', '[outv]'] : []),
      ...(audioClips.length ? ['-map', `${videoClips.length}:a`] : []),
      '-r', String(fps),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      output,
    ],
    executable: false,
    note: 'Plano de exportação. Nenhum processo FFmpeg é iniciado na fase 1.',
  };
}
