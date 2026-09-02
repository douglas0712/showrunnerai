// Timeline: identidade dos clipes, deduplicação, separação real/simulado e
// reconciliação do estado atual.
//
// Os identificadores usados aqui são os dois vídeos reais existentes:
//   1A cinema_mt2011bo_uhqqd3  (prompt_id e71e8987-…)  plano geral da estação
//   1B cinema_mt215gv9_qo2k8h  (prompt_id d69387c9-…)  Helena com a lanterna

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_REGISTRY, canEnterTimeline, clipFromGeneration, clipIdentity, countDuplicates,
  dedupeClips, humanTitleFor, isRealClip, isSimulatedClip, ordenarPorRegistro,
  partitionClips, reconcileTimeline, removeClipFromTimeline, timelineStats,
} from '../lib/timelineAssets.js';

const JOB_1A = 'cinema_mt2011bo_uhqqd3';
const JOB_1B = 'cinema_mt215gv9_qo2k8h';
const URL_1A = '/api/media/video/proj_demo_noir/cinema_mt2011bo_uhqqd3.mp4';
const URL_1B = '/api/media/video/avulso/cinema_mt215gv9_qo2k8h.mp4';

const gen1A = () => ({
  id: 'vid_1a', kind: 'video', real: true, mediaUrl: URL_1A, jobId: JOB_1A,
  promptId: 'e71e8987-7a0d-4013-a867-1fef97a19632', duration: 5.88, seed: 123034625602672,
  aspect: '16:9', status: 'pendente',
  prompt: 'Realistic cinematic suspense scene. Start with a wide establishing shot of the abandoned railway station',
});

const gen1B = () => ({
  id: 'vid_1b', kind: 'video', real: true, mediaUrl: URL_1B, jobId: JOB_1B,
  promptId: 'd69387c9-2bee-4f03-ae05-0f9cc3c11f09', duration: 5.88, seed: 13029375820963,
  aspect: '16:9', status: 'pendente',
  prompt: 'Realistic cinematic suspense, continuous single shot. Medium-wide side tracking shot following Detective Helena',
});

const clipeSimulado = (label) => ({
  id: `clip_${label}`, label, duration: 6, track: 'video',
  poster: 'data:image/svg+xml,x', sourceId: 'scene_demo_1',
});

// ── clipe real ligado ao MP4 correto ────────────────────────────────────────
test('o clipe real aponta para o MP4 correto e carrega a identidade completa', () => {
  const clip = clipFromGeneration(gen1B());

  assert.equal(clip.mediaUrl, URL_1B, 'a Cena 1B precisa apontar para o MP4 da Helena');
  assert.equal(clip.jobId, JOB_1B);
  assert.equal(clip.resultId, 'vid_1b');
  assert.equal(clip.promptId, 'd69387c9-2bee-4f03-ae05-0f9cc3c11f09');
  assert.equal(clip.real, true);
  assert.equal(clip.simulated, false);
  assert.equal(clip.duration, 5.88);
  assert.equal(clip.seed, 13029375820963);
});

test('cada cena aponta para o seu próprio arquivo — sem troca entre 1A e 1B', () => {
  const a = clipFromGeneration(gen1A());
  const b = clipFromGeneration(gen1B());
  assert.notEqual(a.mediaUrl, b.mediaUrl);
  assert.match(a.mediaUrl, /cinema_mt2011bo_uhqqd3\.mp4$/);
  assert.match(b.mediaUrl, /cinema_mt215gv9_qo2k8h\.mp4$/);
});

test('resultado sem arquivo não vira clipe', () => {
  assert.equal(clipFromGeneration({ id: 'x', real: true }), null);
  assert.equal(clipFromGeneration(null), null);
});

// ── título humano ───────────────────────────────────────────────────────────
test('os títulos vêm do registro, nunca do começo do prompt', () => {
  assert.equal(clipFromGeneration(gen1A()).label, 'Cena 1A — Plano geral da estação');
  assert.equal(clipFromGeneration(gen1B()).label, 'Cena 1B — Helena caminha pela plataforma');

  // O antigo comportamento — prefixo do prompt — não pode voltar.
  assert.ok(!clipFromGeneration(gen1A()).label.startsWith('Realistic cinematic'));
});

test('sem registro, o título é a descrição da cena; sem ela, numeração', () => {
  assert.equal(humanTitleFor({ scene: 'Helena encontra o bilhete' }), 'Helena encontra o bilhete');
  assert.equal(humanTitleFor({ index: 2 }), 'Cena 3');
  assert.equal(
    humanTitleFor({ scene: 'x'.repeat(90) }).length <= 61,
    true,
    'títulos longos são truncados',
  );
});

// ── deduplicação ────────────────────────────────────────────────────────────
test('identidade prioriza jobId, depois resultId, depois URL', () => {
  assert.equal(clipIdentity({ jobId: JOB_1A, resultId: 'r', mediaUrl: URL_1A }), `job:${JOB_1A}`);
  assert.equal(clipIdentity({ resultId: 'r1', mediaUrl: URL_1A }), 'res:r1');
  assert.equal(clipIdentity({ mediaUrl: URL_1A }), `url:${URL_1A}`);
  assert.equal(clipIdentity({ id: 'só_id' }), 'id:só_id');
});

test('o mesmo vídeo adicionado duas vezes vira um clipe só', () => {
  const a = clipFromGeneration(gen1B());
  const b = clipFromGeneration(gen1B()); // outro id de clipe, mesmo asset
  assert.notEqual(a.id, b.id);

  const dedup = dedupeClips([a, b]);
  assert.equal(dedup.length, 1);
  assert.equal(dedup[0].jobId, JOB_1B);
  assert.equal(countDuplicates([a, b]), 1);
});

test('duplicata por resultId e por URL também é eliminada', () => {
  const porResultId = [
    { id: 'c1', resultId: 'vid_1a', duration: 5.88 },
    { id: 'c2', resultId: 'vid_1a', duration: 5.88 },
  ];
  assert.equal(dedupeClips(porResultId).length, 1);

  const porUrl = [{ id: 'c1', mediaUrl: URL_1A }, { id: 'c2', mediaUrl: URL_1A }];
  assert.equal(dedupeClips(porUrl).length, 1);
});

test('na duplicata, prevalece a entrada com mídia real', () => {
  const pobre = { id: 'c1', jobId: JOB_1A, duration: 5.88 };
  const rico = { id: 'c2', jobId: JOB_1A, duration: 5.88, mediaUrl: URL_1A, real: true, resultId: 'vid_1a' };
  const [vencedor] = dedupeClips([pobre, rico]);
  assert.equal(vencedor.mediaUrl, URL_1A);
  assert.equal(vencedor.real, true);
});

test('clipes distintos não são confundidos', () => {
  const clips = [clipFromGeneration(gen1A()), clipFromGeneration(gen1B())];
  assert.equal(dedupeClips(clips).length, 2);
  assert.equal(countDuplicates(clips), 0);
});

// ── separação mock × real ───────────────────────────────────────────────────
test('real e simulado são separados sem ambiguidade', () => {
  const real = clipFromGeneration(gen1A());
  const fake = clipeSimulado('Encontro no corredor');

  assert.equal(isRealClip(real), true);
  assert.equal(isSimulatedClip(real), false);
  assert.equal(isRealClip(fake), false);
  assert.equal(isSimulatedClip(fake), true);

  const { real: reais, simulated: simulados } = partitionClips([real, fake]);
  assert.equal(reais.length, 1);
  assert.equal(simulados.length, 1);
});

test('a montagem só aceita resultado real e aprovado', () => {
  assert.equal(canEnterTimeline({ ...gen1A(), status: 'aprovado' }).ok, true);

  const pendente = canEnterTimeline(gen1A());
  assert.equal(pendente.ok, false);
  assert.match(pendente.reason, /Aprove o vídeo/);

  const simulado = canEnterTimeline({ id: 's', kind: 'video', simulated: true, poster: 'x', status: 'aprovado' });
  assert.equal(simulado.ok, false);
  assert.match(simulado.reason, /Só resultados reais/);

  assert.equal(canEnterTimeline(null).ok, false);
});

// ── reconciliação do estado atual ───────────────────────────────────────────
test('REGRESSÃO: a reconciliação limpa a demonstração e monta as duas cenas reais', () => {
  const estadoQuebrado = {
    video: [
      clipeSimulado('Abertura — cidade ao amanhecer'),
      clipeSimulado('Encontro no corredor'),
      clipeSimulado('Revelação'),
      clipeSimulado('Perseguição na chuva'),
      // Real adicionado com título vindo do prompt, e duplicado.
      { ...clipFromGeneration(gen1B()), label: 'Realistic cinematic suspense, continuous sing' },
      clipFromGeneration(gen1B()),
    ],
    audio: [
      { id: 'a1', label: 'Trilha — tema principal', duration: 18, track: 'audio' },
      { id: 'a2', label: 'Ambiência — chuva', duration: 10, track: 'audio' },
    ],
  };

  const { video, audio, relatorio } = reconcileTimeline(estadoQuebrado, {
    generations: [gen1A(), gen1B()],
  });

  assert.equal(video.length, 2, 'devem sobrar exatamente as duas cenas reais');
  assert.equal(audio.length, 0, 'trilhas de demonstração saem da montagem');

  assert.equal(video[0].label, 'Cena 1A — Plano geral da estação');
  assert.equal(video[1].label, 'Cena 1B — Helena caminha pela plataforma');
  assert.equal(video[0].mediaUrl, URL_1A);
  assert.equal(video[1].mediaUrl, URL_1B);

  assert.ok(video.every(isRealClip), 'nenhum clipe simulado pode sobrar');
  assert.equal(countDuplicates(video), 0);
  assert.equal(relatorio.removidasDuplicatas, 1);
  assert.ok(relatorio.removidosSimulados.includes('Encontro no corredor'));
  assert.ok(relatorio.removidosSimulados.includes('Revelação'));
  assert.ok(relatorio.removidosSimulados.includes('Perseguição na chuva'));
});

test('a reconciliação é idempotente', () => {
  const primeira = reconcileTimeline({ video: [], audio: [] }, { generations: [gen1A(), gen1B()] });
  const segunda = reconcileTimeline(primeira, { generations: [gen1A(), gen1B()] });

  assert.equal(segunda.video.length, 2);
  assert.deepEqual(segunda.video.map((c) => c.mediaUrl), primeira.video.map((c) => c.mediaUrl));
  assert.deepEqual(segunda.video.map((c) => c.label), primeira.video.map((c) => c.label));
  assert.equal(segunda.relatorio.removidasDuplicatas, 0);
});

test('a ordem do registro é respeitada mesmo se os clipes chegarem invertidos', () => {
  const invertido = [clipFromGeneration(gen1B()), clipFromGeneration(gen1A())];
  const ordenado = ordenarPorRegistro(invertido);
  assert.equal(ordenado[0].jobId, JOB_1A);
  assert.equal(ordenado[1].jobId, JOB_1B);
  assert.equal(SCENE_REGISTRY[0].order < SCENE_REGISTRY[1].order, true);
});

// ── contagem e duração ──────────────────────────────────────────────────────
test('contagem de cenas e duração total batem com os dois vídeos reais', () => {
  const { video } = reconcileTimeline({ video: [], audio: [] }, { generations: [gen1A(), gen1B()] });
  const stats = timelineStats({ video, audio: [] }, [gen1A(), gen1B()]);

  assert.equal(stats.clipes, 2, 'o cabeçalho precisa dizer 2 cenas');
  assert.equal(stats.reais, 2);
  assert.equal(stats.simulados, 0);
  assert.equal(stats.duplicatas, 0);
  assert.equal(stats.duracaoTotal, 11.76, '5,88 + 5,88 = 11,76 s');
});

test('aprovadas só conta o que tem aprovação registrada — nunca presume', () => {
  const { video } = reconcileTimeline({ video: [], audio: [] }, { generations: [gen1A(), gen1B()] });

  const pendentes = timelineStats({ video, audio: [] }, [gen1A(), gen1B()]);
  assert.equal(pendentes.aprovados, 0, 'sem aprovação registrada, zero aprovadas');

  const umAprovado = timelineStats({ video, audio: [] }, [{ ...gen1A(), status: 'aprovado' }, gen1B()]);
  assert.equal(umAprovado.aprovados, 1);

  const doisAprovados = timelineStats(
    { video, audio: [] },
    [{ ...gen1A(), status: 'aprovado' }, { ...gen1B(), status: 'aprovado' }],
  );
  assert.equal(doisAprovados.aprovados, 2);
});

// ── remoção sem apagar arquivo ──────────────────────────────────────────────
test('remover da timeline não toca no asset nem no arquivo', () => {
  const clipA = clipFromGeneration(gen1A());
  const clipB = clipFromGeneration(gen1B());
  const biblioteca = [gen1A(), gen1B()];

  const depois = removeClipFromTimeline({ video: [clipA, clipB], audio: [] }, clipA.id);

  assert.equal(depois.video.length, 1);
  assert.equal(depois.video[0].jobId, JOB_1B);

  // A biblioteca e as URLs continuam intactas — nada foi apagado.
  assert.equal(biblioteca.length, 2);
  assert.equal(biblioteca[0].mediaUrl, URL_1A);
  assert.ok(biblioteca.find((g) => g.jobId === JOB_1A), 'o asset da 1A continua na biblioteca');
});

test('remover clipe inexistente não altera a montagem', () => {
  const clip = clipFromGeneration(gen1A());
  const depois = removeClipFromTimeline({ video: [clip], audio: [] }, 'nao_existe');
  assert.equal(depois.video.length, 1);
});

test('a duração da montagem preserva as frações no cabeçalho', async () => {
  const { formatPreciseDuration } = await import('../lib/format.js');
  // 11,76 s não pode virar "12s" numa timeline.
  assert.equal(formatPreciseDuration(11.76), '11,76s');
  assert.equal(formatPreciseDuration(5.88), '5,88s');
  assert.equal(formatPreciseDuration(12), '12s');
  assert.equal(formatPreciseDuration(65.5), '1m 5,50s');
  assert.equal(formatPreciseDuration(0), '0s');
});
