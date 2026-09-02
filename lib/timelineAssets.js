// Timeline: identidade dos clipes, deduplicação e reconciliação.
//
// Lógica pura — sem React, sem I/O — para que a regra de "o que entra na
// timeline" seja testável e idêntica em toda a aplicação.

import { makeId } from './rng.js';

/**
 * Nomes humanos das cenas já geradas neste projeto.
 *
 * É dado, não lógica: nomeia assets que já existem e cuja descrição de cena não
 * foi capturada na época. Gerações novas passam a herdar o título da
 * "Descrição da cena" da aba Cinema, e todo clipe pode ser renomeado na própria
 * timeline — então esta lista não precisa crescer.
 */
export const SCENE_REGISTRY = [
  {
    jobId: 'cinema_mt2011bo_uhqqd3',
    order: 1,
    title: 'Cena 1A — Plano geral da estação',
  },
  {
    jobId: 'cinema_mt215gv9_qo2k8h',
    order: 2,
    title: 'Cena 1B — Helena caminha pela plataforma',
  },
];

export function registryEntryFor(jobId, registry = SCENE_REGISTRY) {
  return registry.find((e) => e.jobId === jobId) || null;
}

/** Um clipe é real quando aponta para um arquivo servido pela aplicação. */
export function isRealClip(clip) {
  return Boolean(clip?.real && clip?.mediaUrl);
}

/** Simulado: demonstração, mock ou qualquer clipe sem mídia real. */
export function isSimulatedClip(clip) {
  if (!clip) return false;
  if (isRealClip(clip)) return false;
  return true;
}

/**
 * Chave canônica de identidade, da mais forte para a mais fraca.
 * É o que permite reconhecer o mesmo vídeo entrando duas vezes na timeline.
 */
export function clipIdentity(clip) {
  if (!clip) return null;
  if (clip.jobId) return `job:${clip.jobId}`;
  if (clip.resultId) return `res:${clip.resultId}`;
  if (clip.mediaUrl) return `url:${clip.mediaUrl}`;
  if (clip.contentHash) return `hash:${clip.contentHash}`;
  if (clip.sourceId) return `src:${clip.sourceId}`;
  return `id:${clip.id}`;
}

/**
 * Remove duplicatas mantendo a primeira ocorrência, mas preferindo a entrada
 * mais completa: se a segunda tiver mídia real e a primeira não, a segunda vence.
 */
export function dedupeClips(clips = []) {
  const porIdentidade = new Map();
  const ordem = [];

  for (const clip of clips) {
    const chave = clipIdentity(clip);
    const existente = porIdentidade.get(chave);

    if (!existente) {
      porIdentidade.set(chave, clip);
      ordem.push(chave);
      continue;
    }

    // Mesma identidade: fica a versão com mais informação.
    const melhor = pontuacao(clip) > pontuacao(existente) ? clip : existente;
    porIdentidade.set(chave, melhor);
  }

  return ordem.map((chave) => porIdentidade.get(chave));
}

function pontuacao(clip) {
  let p = 0;
  if (clip?.mediaUrl) p += 4;
  if (clip?.real) p += 3;
  if (clip?.thumbnail) p += 2;
  if (clip?.resultId) p += 1;
  if (clip?.promptId) p += 1;
  return p;
}

export function countDuplicates(clips = []) {
  return clips.length - dedupeClips(clips).length;
}

/** Separa o que é real do que é demonstração. */
export function partitionClips(clips = []) {
  return {
    real: clips.filter(isRealClip),
    simulated: clips.filter(isSimulatedClip),
  };
}

/**
 * Título humano de um clipe.
 *
 * Nunca usa o começo do prompt: um prompt cinematográfico começa com termos
 * técnicos ("Realistic cinematic suspense scene. Start with a wide…") e vira um
 * rótulo ilegível. A ordem é: registro → descrição da cena → título do item →
 * numeração.
 */
export function humanTitleFor({ jobId, scene, title, index = 0 }, registry = SCENE_REGISTRY) {
  const registrado = registryEntryFor(jobId, registry);
  if (registrado) return registrado.title;

  const daCena = String(scene || '').trim();
  if (daCena) return truncarTitulo(daCena);

  const doItem = String(title || '').trim();
  if (doItem) return truncarTitulo(doItem);

  return `Cena ${index + 1}`;
}

function truncarTitulo(texto, max = 60) {
  const limpo = texto.replace(/\s+/g, ' ').trim();
  if (limpo.length <= max) return limpo;
  const corte = limpo.slice(0, max);
  const espaco = corte.lastIndexOf(' ');
  return `${corte.slice(0, espaco > 30 ? espaco : max)}…`;
}

/**
 * A montagem do projeto só aceita resultado real e aprovado.
 *
 * Os dados simulados continuam existindo na biblioteca e no modo demonstração,
 * mas não se misturam à timeline — foi essa mistura que tornou a montagem
 * ilegível.
 */
export function canEnterTimeline(item) {
  if (!item) return { ok: false, reason: 'Nenhum resultado selecionado.' };
  if (!item.real || !item.mediaUrl) {
    return {
      ok: false,
      reason: 'Só resultados reais entram na montagem. Este é uma simulação de demonstração.',
    };
  }
  if (item.status !== 'aprovado') {
    return { ok: false, reason: 'Aprove o vídeo antes de adicioná-lo à timeline.' };
  }
  return { ok: true, reason: '' };
}

/** Constrói um clipe de timeline a partir de um resultado real da biblioteca. */
export function clipFromGeneration(generation, { index = 0, registry = SCENE_REGISTRY } = {}) {
  if (!generation?.mediaUrl) return null;

  return {
    id: makeId('clip'),
    track: 'video',
    label: humanTitleFor(
      { jobId: generation.jobId, scene: generation.scene, title: generation.title, index },
      registry,
    ),
    duration: Number(generation.duration) || 0,
    real: true,
    simulated: false,
    resultId: generation.id,
    jobId: generation.jobId || null,
    promptId: generation.promptId || null,
    mediaUrl: generation.mediaUrl,
    thumbnail: generation.thumbnail || null,
    aspect: generation.aspect || '16:9',
    seed: generation.seed ?? null,
    poster: null,
    sourceId: generation.id,
  };
}

/**
 * Reconcilia a timeline com os resultados reais conhecidos.
 *
 * Corrige de uma vez os três problemas do estado atual: clipes de demonstração
 * misturados com resultados reais, entradas duplicadas e vídeos reais ausentes.
 * É idempotente — rodar de novo não muda nada.
 */
export function reconcileTimeline(timeline = { video: [], audio: [] }, options = {}) {
  const {
    generations = [],
    registry = SCENE_REGISTRY,
    dropSimulated = true,
  } = options;

  const relatorio = { removidosSimulados: [], removidasDuplicatas: 0, adicionados: [], renomeados: [] };

  // 1) Descarta a demonstração das duas trilhas.
  let video = timeline.video || [];
  let audio = timeline.audio || [];

  if (dropSimulated) {
    const { simulated } = partitionClips(video);
    relatorio.removidosSimulados = [
      ...simulated.map((c) => c.label),
      ...audio.map((c) => c.label),
    ];
    video = video.filter(isRealClip);
    audio = audio.filter(isRealClip);
  }

  // 2) Elimina entradas repetidas do mesmo vídeo.
  const antes = video.length;
  video = dedupeClips(video);
  relatorio.removidasDuplicatas = antes - video.length;

  // 3) Garante que todo resultado real da biblioteca esteja na timeline.
  const presentes = new Set(video.map(clipIdentity));
  const reais = generations.filter((g) => g.kind === 'video' && g.real && g.mediaUrl);

  reais.forEach((generation, index) => {
    const provisorio = { jobId: generation.jobId, resultId: generation.id, mediaUrl: generation.mediaUrl };
    if (presentes.has(clipIdentity(provisorio))) return;
    const clip = clipFromGeneration(generation, { index: video.length + index, registry });
    if (clip) {
      video.push(clip);
      relatorio.adicionados.push(clip.label);
    }
  });

  // 4) Aplica os títulos humanos e a ordem do registro.
  video = video.map((clip, index) => {
    const titulo = humanTitleFor(
      { jobId: clip.jobId, scene: clip.scene, title: clip.label, index },
      registry,
    );
    if (titulo !== clip.label) relatorio.renomeados.push({ de: clip.label, para: titulo });
    return { ...clip, label: titulo };
  });

  video = ordenarPorRegistro(video, registry);

  return { video, audio, relatorio };
}

/** Clipes com posição no registro vêm primeiro, na ordem definida. */
export function ordenarPorRegistro(clips = [], registry = SCENE_REGISTRY) {
  return [...clips].sort((a, b) => {
    const ra = registryEntryFor(a.jobId, registry)?.order ?? Number.MAX_SAFE_INTEGER;
    const rb = registryEntryFor(b.jobId, registry)?.order ?? Number.MAX_SAFE_INTEGER;
    return ra - rb;
  });
}

/**
 * Estatísticas do cabeçalho quando a timeline está aberta.
 * A aprovação é lida do item da biblioteca — nunca é presumida.
 */
export function timelineStats(timeline = { video: [], audio: [] }, generations = []) {
  const video = timeline.video || [];
  const porId = new Map(generations.map((g) => [g.id, g]));

  const aprovados = video.filter((clip) => {
    const item = clip.resultId ? porId.get(clip.resultId) : null;
    return item?.status === 'aprovado';
  }).length;

  const { real, simulated } = partitionClips(video);

  return {
    clipes: video.length,
    reais: real.length,
    simulados: simulated.length,
    aprovados,
    duracaoTotal: Number(video.reduce((s, c) => s + (Number(c.duration) || 0), 0).toFixed(2)),
    duplicatas: countDuplicates(video),
  };
}

/**
 * Remove um clipe da timeline. Só mexe na montagem: o MP4 e o item da
 * biblioteca continuam intactos.
 */
export function removeClipFromTimeline(timeline = { video: [], audio: [] }, clipId) {
  return {
    ...timeline,
    video: (timeline.video || []).filter((c) => c.id !== clipId),
    audio: (timeline.audio || []).filter((c) => c.id !== clipId),
  };
}
