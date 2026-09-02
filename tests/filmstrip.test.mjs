// Filmstrip: amostragem, cache por hash, invalidação, responsividade,
// fallback e proteção de caminho.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  FRAME_FRACTIONS, MAX_FRAMES, cacheKeyFor, clipRangeLabel, frameTimestamps,
  pickVisibleFrames, responsiveFrameCount, shortTimecode,
} from '../lib/filmstrip.js';
import { getFilmstrip, hashFile, limparAntigos } from '../lib/server/media/filmstrip.js';
import { AssetResolutionError } from '../lib/server/export/assets.js';
import { PathValidationError, resolveFramePath, validateFrameFilename } from '../lib/server/comfy/storage.js';
import { ffmpegAvailable } from '../lib/server/export/ffmpeg.js';

const disponivel = await ffmpegAvailable();
const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-strip-'));
const PROJ = 'proj_strip';
const VIDEOS = path.join(RAIZ, PROJ, 'videos');
const JOB = 'cinema_strip_a';

test.after(() => rm(RAIZ, { recursive: true, force: true }));

function sintetico(destino, { duracao = 2 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=24:duration=${duracao}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(duracao), destino,
    ];
    const proc = spawn('/usr/bin/ffmpeg', args, { shell: false });
    let erro = '';
    proc.stderr.on('data', (c) => { erro += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(destino) : reject(new Error(erro.slice(-300)))));
  });
}

// ── amostragem ──────────────────────────────────────────────────────────────
test('os quatro instantes são 10%, 35%, 60% e 85% da duração', () => {
  assert.deepEqual(FRAME_FRACTIONS, [0.1, 0.35, 0.6, 0.85]);
  assert.equal(MAX_FRAMES, 4);

  assert.deepEqual(frameTimestamps(10), [1, 3.5, 6, 8.5]);
  assert.deepEqual(frameTimestamps(5.875), [0.588, 2.056, 3.525, 4.994]);
});

test('a amostragem nunca ultrapassa o fim do vídeo', () => {
  const instantes = frameTimestamps(1);
  assert.ok(instantes.every((t) => t <= 0.95), `${instantes}`);
  assert.ok(instantes[0] > 0, 'não amostramos o quadro zero, que costuma ser preto');
});

test('duração inválida não produz amostragem', () => {
  assert.deepEqual(frameTimestamps(0), []);
  assert.deepEqual(frameTimestamps(-3), []);
  assert.deepEqual(frameTimestamps('x'), []);
  assert.deepEqual(frameTimestamps(undefined), []);
});

// ── cache e invalidação ─────────────────────────────────────────────────────
test('a chave de cache combina jobId, hash e frações amostradas', () => {
  const chave = cacheKeyFor('cinema_abc', 'a'.repeat(64));
  assert.ok(chave.startsWith('cinema_abc_'));
  assert.ok(chave.includes('aaaaaaaaaaaaaaaa'));
  assert.ok(chave.endsWith('01-035-06-085'));
});

test('mudar o vídeo muda a chave — o cache se invalida sozinho', () => {
  const hashA = createHash('sha256').update('video-1').digest('hex');
  const hashB = createHash('sha256').update('video-2').digest('hex');
  assert.notEqual(cacheKeyFor('job', hashA), cacheKeyFor('job', hashB));
  // Mesmo vídeo, mesma chave — é o que evita reextrair a cada carregamento.
  assert.equal(cacheKeyFor('job', hashA), cacheKeyFor('job', hashA));
});

test('mudar as frações amostradas também invalida', () => {
  const hash = 'b'.repeat(64);
  assert.notEqual(cacheKeyFor('job', hash), cacheKeyFor('job', hash, [0.2, 0.5, 0.8]));
});

// ── responsividade ──────────────────────────────────────────────────────────
test('clipes estreitos mostram menos quadros, nunca células ilegíveis', () => {
  assert.equal(responsiveFrameCount(600), 4);
  assert.equal(responsiveFrameCount(300), 4);
  assert.equal(responsiveFrameCount(220), 3);
  assert.equal(responsiveFrameCount(150), 2);
  assert.equal(responsiveFrameCount(90), 1);
  assert.equal(responsiveFrameCount(20), 1, 'um clipe minúsculo ainda mostra um quadro');
  assert.equal(responsiveFrameCount(0), 1);
  assert.equal(responsiveFrameCount(NaN), 1);
});

test('nenhuma célula fica abaixo do mínimo legível', () => {
  for (const largura of [80, 150, 220, 300, 600, 1200]) {
    const n = responsiveFrameCount(largura);
    if (n > 1) assert.ok(largura / n >= 72, `${largura}px em ${n} células ficou apertado`);
  }
});

test('ao reduzir, os quadros escolhidos ainda cobrem o arco do clipe', () => {
  const quadros = [0, 1, 2, 3].map((index) => ({ index }));
  assert.deepEqual(pickVisibleFrames(quadros, 4).map((f) => f.index), [0, 1, 2, 3]);
  assert.deepEqual(pickVisibleFrames(quadros, 2).map((f) => f.index), [0, 3]);
  assert.deepEqual(pickVisibleFrames(quadros, 3).map((f) => f.index), [0, 2, 3]);
  assert.equal(pickVisibleFrames(quadros, 1).length, 1);
  assert.deepEqual(pickVisibleFrames([], 4), []);
  assert.equal(pickVisibleFrames(quadros, 99).length, 4, 'nunca inventa quadros');
});

// ── rótulos do rodapé ───────────────────────────────────────────────────────
test('o rodapé mostra a faixa de tempo do clipe', () => {
  assert.equal(shortTimecode(0), '00:00');
  assert.equal(shortTimecode(5.88), '00:05,88');
  assert.equal(shortTimecode(65.5), '01:05,50');
  assert.equal(clipRangeLabel(0, 5.88), '00:00–00:05,88');
  assert.equal(clipRangeLabel(5.88, 5.88), '00:05,88–00:11,76');
});

// ── segurança ───────────────────────────────────────────────────────────────
test('SEGURANÇA: só nomes de quadro no formato esperado são aceitos', () => {
  assert.equal(validateFrameFilename('chave_abc__0.jpg'), 'chave_abc__0.jpg');
  ['../x__0.jpg', 'a/b__0.jpg', 'x__0.png', 'x__0.jpg.exe', 'x.jpg', 'x__a.jpg', '']
    .forEach((n) => assert.throws(() => validateFrameFilename(n), PathValidationError, `aceitou "${n}"`));
});

test('SEGURANÇA: o caminho do quadro fica contido na raiz do runtime', () => {
  const caminho = resolveFramePath('proj1', 'chave__0.jpg', RAIZ);
  assert.ok(caminho.startsWith(path.resolve(RAIZ)));
  assert.ok(caminho.includes(path.join('proj1', 'cache', 'filmstrip')));

  assert.throws(() => resolveFramePath('../fuga', 'c__0.jpg', RAIZ), PathValidationError);
  assert.throws(() => resolveFramePath('proj1', '../../etc/passwd', RAIZ), PathValidationError);
});

test('SEGURANÇA: a filmstrip só aceita jobId registrado — nunca caminho', async () => {
  await assert.rejects(() => getFilmstrip('../fuga', { root: RAIZ }), AssetResolutionError);
  await assert.rejects(() => getFilmstrip('/etc/passwd', { root: RAIZ }), AssetResolutionError);
  await assert.rejects(() => getFilmstrip('cinema_nao_registrado', { root: RAIZ }), AssetResolutionError);
  await assert.rejects(() => getFilmstrip(null, { root: RAIZ }), AssetResolutionError);
});

// ── extração real ───────────────────────────────────────────────────────────
test('extrai quatro quadros, guarda em cache e não reextrai', { skip: !disponivel.ok, timeout: 60000 }, async () => {
  await mkdir(VIDEOS, { recursive: true });
  const video = path.join(VIDEOS, `${JOB}.mp4`);
  await sintetico(video, { duracao: 2 });

  const hashAntes = await hashFile(video);

  const primeira = await getFilmstrip(JOB, { root: RAIZ });
  assert.equal(primeira.cached, false, 'a primeira chamada precisa extrair');
  assert.equal(primeira.frames.length, 4);
  assert.equal(new Set(primeira.frames.map((f) => f.url)).size, 4, 'os quadros precisam ser distintos');
  assert.ok(primeira.frames.every((f) => f.url.startsWith('/api/media/frame/')));

  const dir = path.join(RAIZ, PROJ, 'cache', 'filmstrip');
  const arquivos = await readdir(dir);
  assert.equal(arquivos.filter((n) => n.endsWith('.jpg')).length, 4);

  // Os arquivos têm conteúdo e são JPEG de verdade.
  for (const nome of arquivos) {
    // eslint-disable-next-line no-await-in-loop
    const bytes = await readFile(path.join(dir, nome));
    assert.ok(bytes.length > 500, `${nome} ficou pequeno demais`);
    assert.equal(bytes[0], 0xff, 'assinatura JPEG');
    assert.equal(bytes[1], 0xd8, 'assinatura JPEG');
  }

  // Segunda chamada: cache.
  const segunda = await getFilmstrip(JOB, { root: RAIZ });
  assert.equal(segunda.cached, true, 'a segunda chamada precisa vir do cache');
  assert.equal(segunda.cacheKey, primeira.cacheKey);

  // O MP4 não pode ter sido tocado pela extração.
  assert.equal(await hashFile(video), hashAntes, 'o vídeo foi alterado pela extração');
});

test('trocar o MP4 invalida o cache e descarta os quadros antigos', { skip: !disponivel.ok, timeout: 60000 }, async () => {
  const video = path.join(VIDEOS, `${JOB}.mp4`);
  const antes = await getFilmstrip(JOB, { root: RAIZ });

  // Outro conteúdo, mesmo jobId.
  await sintetico(video, { duracao: 3 });

  const depois = await getFilmstrip(JOB, { root: RAIZ });
  assert.notEqual(depois.hash, antes.hash);
  assert.notEqual(depois.cacheKey, antes.cacheKey, 'a chave precisa mudar com o vídeo');
  assert.equal(depois.cached, false, 'precisa reextrair');

  const dir = path.join(RAIZ, PROJ, 'cache', 'filmstrip');
  const arquivos = await readdir(dir);
  assert.ok(!arquivos.some((n) => n.startsWith(`${antes.cacheKey}__`)), 'quadros obsoletos devem sair');
  assert.equal(arquivos.filter((n) => n.startsWith(`${depois.cacheKey}__`)).length, 4);
});

test('a limpeza de obsoletos não toca em outros jobs', { skip: !disponivel.ok, timeout: 30000 }, async () => {
  const dir = path.join(RAIZ, PROJ, 'cache', 'filmstrip');
  await writeFile(path.join(dir, 'cinema_outro_job_ffff__0.jpg'), 'x');

  const atual = await getFilmstrip(JOB, { root: RAIZ });
  const removidos = await limparAntigos(dir, JOB, atual.cacheKey);

  const arquivos = await readdir(dir);
  assert.ok(arquivos.includes('cinema_outro_job_ffff__0.jpg'), 'quadro de outro job foi apagado');
  assert.ok(!removidos.includes('cinema_outro_job_ffff__0.jpg'));
});

test('vídeo sem duração legível não quebra — quem chama cai no fallback', async () => {
  await mkdir(VIDEOS, { recursive: true });
  const quebrado = path.join(VIDEOS, 'cinema_quebrado.mp4');
  await writeFile(quebrado, 'isto não é um mp4');

  await assert.rejects(() => getFilmstrip('cinema_quebrado', { root: RAIZ }));

  // O arquivo continua lá: falhar na miniatura não apaga nada.
  assert.equal((await readFile(quebrado)).toString(), 'isto não é um mp4');
});
