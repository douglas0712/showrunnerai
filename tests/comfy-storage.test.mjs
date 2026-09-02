import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  PathValidationError, assertInside, mediaUrlFor, resolveVideoPath,
  saveVideoBytes, validateSegment, validateVideoFilename, videoDirFor,
} from '../lib/server/comfy/storage.js';

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-store-'));
test.after(() => rm(RAIZ, { recursive: true, force: true }));

test('segmentos válidos passam', () => {
  ['proj_demo_noir', 'abc-123', 'A_b-9', 'x'].forEach((v) => assert.equal(validateSegment(v), v));
});

test('travessia de caminho é recusada em todas as formas', () => {
  const maliciosos = [
    '..', '../', '../../etc', 'a/b', 'a\\b', '.', 'a.b', '%2e%2e', 'a b',
    '../../../../etc/passwd', '/etc/passwd', 'a\0b', '', 'x'.repeat(65),
  ];
  for (const valor of maliciosos) {
    assert.throws(() => validateSegment(valor), PathValidationError, `aceitou "${valor}"`);
  }
  assert.throws(() => validateSegment(null), PathValidationError);
  assert.throws(() => validateSegment(123), PathValidationError);
});

test('nome de arquivo aceita apenas <segmento>.mp4', () => {
  assert.equal(validateVideoFilename('cinema_abc-1.mp4'), 'cinema_abc-1.mp4');
  ['../x.mp4', 'a/b.mp4', 'x.mp4.exe', 'x.png', 'x', '.mp4', 'x..mp4']
    .forEach((v) => assert.throws(() => validateVideoFilename(v), PathValidationError, `aceitou "${v}"`));
});

test('resolveVideoPath fica dentro da raiz e recusa escapes', () => {
  const caminho = resolveVideoPath('proj1', 'video1.mp4', RAIZ);
  assert.ok(caminho.startsWith(path.resolve(RAIZ)));
  assert.equal(path.basename(caminho), 'video1.mp4');
  assert.ok(caminho.includes(path.join('proj1', 'videos')));

  assert.throws(() => resolveVideoPath('../fora', 'v.mp4', RAIZ), PathValidationError);
  assert.throws(() => resolveVideoPath('proj1', '../../v.mp4', RAIZ), PathValidationError);
  assert.throws(() => resolveVideoPath('proj1', '/etc/passwd', RAIZ), PathValidationError);
});

test('assertInside bloqueia irmãos e a própria raiz', () => {
  assert.throws(() => assertInside('/a/b', '/a/bc/d'), PathValidationError);
  assert.throws(() => assertInside('/a/b', '/a/b'), PathValidationError);
  assert.throws(() => assertInside('/a/b', '/a'), PathValidationError);
  assert.equal(assertInside('/a/b', '/a/b/c'), path.resolve('/a/b/c'));
});

test('grava o vídeo e devolve a URL servida pela aplicação', async () => {
  const bytes = Buffer.from('conteudo-de-video-1');
  const salvo = await saveVideoBytes('projX', 'cinema_abc', bytes, RAIZ);

  assert.equal(salvo.filename, 'cinema_abc.mp4');
  assert.equal(salvo.url, '/api/media/video/projX/cinema_abc.mp4');
  assert.deepEqual(await readFile(salvo.absolutePath), bytes);
  assert.ok(salvo.absolutePath.startsWith(path.resolve(RAIZ)));
});

test('nunca sobrescreve um resultado anterior', async () => {
  const primeiro = await saveVideoBytes('projY', 'mesmo_nome', Buffer.from('primeiro'), RAIZ);
  const segundo = await saveVideoBytes('projY', 'mesmo_nome', Buffer.from('segundo'), RAIZ);
  const terceiro = await saveVideoBytes('projY', 'mesmo_nome', Buffer.from('terceiro'), RAIZ);

  assert.equal(primeiro.filename, 'mesmo_nome.mp4');
  assert.equal(segundo.filename, 'mesmo_nome-2.mp4');
  assert.equal(terceiro.filename, 'mesmo_nome-3.mp4');

  // O primeiro arquivo continua íntegro.
  assert.equal((await readFile(primeiro.absolutePath)).toString(), 'primeiro');
  assert.equal((await readFile(segundo.absolutePath)).toString(), 'segundo');
});

test('gravação recusa identificadores inválidos', async () => {
  await assert.rejects(() => saveVideoBytes('../fuga', 'v', Buffer.from('x'), RAIZ), PathValidationError);
  await assert.rejects(() => saveVideoBytes('proj', '../v', Buffer.from('x'), RAIZ), PathValidationError);
});

test('videoDirFor e mediaUrlFor validam os identificadores', () => {
  assert.ok(videoDirFor('proj1', RAIZ).endsWith(path.join('proj1', 'videos')));
  assert.throws(() => videoDirFor('../x', RAIZ), PathValidationError);
  assert.equal(mediaUrlFor('p', 'a.mp4'), '/api/media/video/p/a.mp4');
  assert.throws(() => mediaUrlFor('p', 'a.png'), PathValidationError);
});
