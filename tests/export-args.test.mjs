// Construção dos argumentos do FFmpeg: perfis, normalização, concatenação,
// duração prevista, progresso e as garantias de segurança do array.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_PRESET, ExportArgsError, TARGET_PRESETS, audioNormalizeChain,
  buildFfmpegArgs, buildFilterGraph, expectedDuration, parseProgressLine,
  resolvePreset, videoNormalizeChain,
} from '../lib/server/export/args.js';

const target = resolvePreset(DEFAULT_PRESET);
const duasCenas = [
  { path: '/runtime/projects/p/videos/a.mp4', hasAudio: true, duration: 5.875 },
  { path: '/runtime/projects/p/videos/b.mp4', hasAudio: true, duration: 5.875 },
];

test('o perfil padrão reproduz as características dos clipes', () => {
  assert.equal(target.width, 864);
  assert.equal(target.height, 480);
  assert.equal(target.fps, 24);
  assert.equal(target.pixelFormat, 'yuv420p');
  assert.equal(target.sampleRate, 48000);
  assert.equal(target.channels, 2);
});

test('perfil desconhecido é recusado', () => {
  assert.throws(() => resolvePreset('4k-120'), ExportArgsError);
  assert.ok(Object.keys(TARGET_PRESETS).length >= 3);
});

// ── normalização ────────────────────────────────────────────────────────────
test('o vídeo é normalizado em resolução, SAR, fps, pixel format e timestamps', () => {
  const cadeia = videoNormalizeChain(0, target);
  assert.match(cadeia, /scale=864:480/);
  assert.match(cadeia, /pad=864:480/);
  assert.match(cadeia, /setsar=1/, 'sample aspect ratio precisa virar 1');
  assert.match(cadeia, /fps=24/);
  assert.match(cadeia, /format=yuv420p/);
  assert.match(cadeia, /settb=AVTB/, 'timebase precisa ser reiniciada');
  assert.match(cadeia, /setpts=PTS-STARTPTS/, 'timestamps precisam ser reiniciados');
  assert.ok(cadeia.startsWith('[0:v]') && cadeia.endsWith('[v0]'));
});

test('o áudio é normalizado para estéreo 48 kHz com timestamps reiniciados', () => {
  const cadeia = audioNormalizeChain(1, target, { hasAudio: true, duration: 5.875 });
  assert.match(cadeia, /sample_rates=48000/, 'os clipes são 32 kHz e precisam ser reamostrados');
  assert.match(cadeia, /channel_layouts=stereo/);
  assert.match(cadeia, /asetpts=PTS-STARTPTS/);
  assert.ok(cadeia.startsWith('[1:a]') && cadeia.endsWith('[a1]'));
});

test('clipe sem áudio ganha silêncio da mesma duração, sem descartar os demais', () => {
  const cadeia = audioNormalizeChain(0, target, { hasAudio: false, duration: 5.875 });
  assert.match(cadeia, /anullsrc/);
  assert.match(cadeia, /atrim=duration=5\.875/);
  assert.ok(!cadeia.includes('[0:a]'), 'não pode mapear um fluxo de áudio inexistente');
});

// ── concatenação ────────────────────────────────────────────────────────────
test('o grafo concatena vídeo E áudio das duas cenas', () => {
  const grafo = buildFilterGraph(duasCenas, target);
  assert.match(grafo, /\[v0\]\[a0\]\[v1\]\[a1\]concat=n=2:v=1:a=1\[outv\]\[outa\]/);
  assert.ok(grafo.includes('[0:a]') && grafo.includes('[1:a]'), 'o áudio nativo não pode ser descartado');
});

test('o grafo escala com o número de cenas', () => {
  const tres = [...duasCenas, { path: '/x/c.mp4', hasAudio: true, duration: 3 }];
  assert.match(buildFilterGraph(tres, target), /concat=n=3:v=1:a=1/);
  assert.throws(() => buildFilterGraph([], target), ExportArgsError);
});

// ── argumentos ──────────────────────────────────────────────────────────────
test('o comando sai como array, com uma flag -i por arquivo', () => {
  const args = buildFfmpegArgs({ inputs: duasCenas, target, outputPath: '/runtime/out.mp4' });

  assert.ok(Array.isArray(args));
  assert.equal(args.filter((a) => a === '-i').length, 2);
  assert.equal(args[args.indexOf('-i') + 1], duasCenas[0].path);
  assert.equal(args.at(-1), '/runtime/out.mp4');
});

test('os parâmetros exigidos estão no comando', () => {
  const args = buildFfmpegArgs({ inputs: duasCenas, target, outputPath: '/runtime/out.mp4' });
  const par = (flag) => args[args.indexOf(flag) + 1];

  assert.equal(par('-c:v'), 'libx264');
  assert.equal(par('-pix_fmt'), 'yuv420p');
  assert.equal(par('-r'), '24');
  assert.equal(par('-c:a'), 'aac');
  assert.equal(par('-ar'), '48000');
  assert.equal(par('-ac'), '2');
  assert.equal(par('-movflags'), '+faststart');
  assert.ok(args.includes('-map') && args.includes('[outv]') && args.includes('[outa]'));
  assert.equal(par('-progress'), 'pipe:1');
});

test('SEGURANÇA: nenhum argumento é interpretado por shell', () => {
  const args = buildFfmpegArgs({ inputs: duasCenas, target, outputPath: '/runtime/out.mp4' });
  // Cada elemento é um argumento isolado: nada é concatenado numa string, então
  // metacaracteres não podem virar comando.
  assert.ok(args.every((a) => typeof a === 'string'));
  assert.ok(!args.some((a) => a.includes('\n')), 'nenhum argumento com quebra de linha');
});

test('SEGURANÇA: caminhos relativos ou ausentes são recusados', () => {
  assert.throws(
    () => buildFfmpegArgs({ inputs: [{ path: 'relativo.mp4', hasAudio: true, duration: 1 }], target, outputPath: '/o.mp4' }),
    ExportArgsError,
  );
  assert.throws(
    () => buildFfmpegArgs({ inputs: duasCenas, target, outputPath: 'saida.mp4' }),
    ExportArgsError,
  );
  assert.throws(
    () => buildFfmpegArgs({ inputs: [{ hasAudio: true, duration: 1 }], target, outputPath: '/o.mp4' }),
    ExportArgsError,
  );
  assert.throws(() => buildFfmpegArgs({ inputs: [], target, outputPath: '/o.mp4' }), ExportArgsError);
});

test('SEGURANÇA: um caminho hostil continua sendo um único argumento', () => {
  // Mesmo que um nome contivesse metacaracteres, ele é um elemento do array —
  // nunca um pedaço de linha de comando.
  const hostil = '/runtime/projects/p/videos/a.mp4; rm -rf /';
  const args = buildFfmpegArgs({
    inputs: [{ path: hostil, hasAudio: true, duration: 1 }],
    target,
    outputPath: '/runtime/out.mp4',
  });
  assert.equal(args[args.indexOf('-i') + 1], hostil);
  assert.equal(args.filter((a) => a === hostil).length, 1);
});

// ── duração e progresso ─────────────────────────────────────────────────────
test('a duração prevista é a soma das cenas — corte seco', () => {
  assert.equal(expectedDuration(duasCenas), 11.75);
  assert.equal(expectedDuration([]), 0);
  assert.equal(expectedDuration([{ duration: 5.875 }]), 5.875);
});

test('o progresso é lido das linhas de -progress', () => {
  assert.deepEqual(parseProgressLine('out_time_us=5875000', 11.75), { seconds: 5.875, progress: 0.5 });
  assert.equal(parseProgressLine('out_time_us=11750000', 11.75).progress, 1);
  assert.equal(parseProgressLine('out_time_us=99999999', 11.75).progress, 1, 'nunca passa de 100%');
  assert.deepEqual(parseProgressLine('frame=141', 11.75), { frames: 141 });
  assert.deepEqual(parseProgressLine('progress=end', 11.75), { done: true });
  assert.deepEqual(parseProgressLine('progress=continue', 11.75), { done: false });
});

test('linhas irrelevantes ou inválidas não quebram o progresso', () => {
  assert.equal(parseProgressLine('', 11.75), null);
  assert.equal(parseProgressLine('lixo aleatório', 11.75), null);
  assert.equal(parseProgressLine('out_time_us=N/A', 11.75), null);
  assert.equal(parseProgressLine('bitrate=1234kbits/s', 11.75), null);
  assert.equal(parseProgressLine('out_time_us=1000000', 0).progress, null);
});
