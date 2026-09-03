// Generalização da camada de geração para imagem e vídeo.
//
// O que estes testes protegem: a decisão de tipo vem sempre de
// `descriptor.kind`, nunca do nome do modelo; um tipo não aceita a saída do
// outro; e o caminho do vídeo continua exatamente onde sempre esteve.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  discoveryExtensionsFor, extensionOf, extensionsFor, isExtensionOfKind,
  isStorableExtension, kindOfExtension, mediaKind, MediaKindError, mimeFor,
} from '../lib/server/generation/mediaKinds.js';
import { findMediaOutput, jobIdFromOutputFilename } from '../lib/server/generation/outputs.js';
import {
  MediaRequestError, parseByteRange, resolveMediaRequest, TIPOS_SERVIVEIS,
} from '../lib/server/generation/mediaServing.js';
import {
  findMediaByJobId, mediaDirFor, mediaTempPath, mediaUrlForKind, publishMediaFile,
  PathValidationError, resolveMediaPath, resolveVideoPath, validateMediaFilename,
  videoDirFor, mediaUrlFor,
} from '../lib/server/comfy/storage.js';
import { minimaxH3T2V } from '../lib/server/generation/workflows/minimaxH3.js';
import { findVideoOutput, isVideoFile, jobIdFromFilename } from '../lib/server/comfy/status.js';

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-media-'));
test.after(() => rm(RAIZ, { recursive: true, force: true }));

/** Uma saída de /history como o ComfyUI a publica. */
const saidaCom = (filename, chave = 'images', nodeId = '92') => ({
  [nodeId]: { [chave]: [{ filename, subfolder: 'video/showrunner', type: 'output' }] },
});

// ── 1–4. descoberta por tipo ────────────────────────────────────────────────

test('1. descoberta de MP4 continua funcionando, inclusive sob a chave "images"', () => {
  const achado = findMediaOutput(saidaCom('cinema_abc_00001_.mp4'), { kind: 'video', saveNodeId: '92' });
  assert.equal(achado.filename, 'cinema_abc_00001_.mp4');
  assert.equal(achado.kind, 'video');
  assert.equal(achado.mime, 'video/mp4');
  assert.equal(achado.nodeId, '92');

  // E os outros contêineres que o ComfyUI pode produzir continuam reconhecidos.
  for (const ext of ['.webm', '.mkv', '.mov', '.m4v']) {
    assert.ok(findMediaOutput(saidaCom(`x_00001_${ext}`), { kind: 'video' }), `perdeu ${ext}`);
  }
});

test('2. descoberta de output PNG', () => {
  const achado = findMediaOutput(saidaCom('dragao_00001_.png'), { kind: 'image', saveNodeId: '92' });
  assert.equal(achado.filename, 'dragao_00001_.png');
  assert.equal(achado.kind, 'image');
  assert.equal(achado.mime, 'image/png');
});

test('3. descoberta de JPG e JPEG', () => {
  assert.equal(findMediaOutput(saidaCom('a_00001_.jpg'), { kind: 'image' }).mime, 'image/jpeg');
  assert.equal(findMediaOutput(saidaCom('a_00001_.jpeg'), { kind: 'image' }).mime, 'image/jpeg');
  // Maiúsculas não escapam da tabela.
  assert.equal(findMediaOutput(saidaCom('a_00001_.JPG'), { kind: 'image' }).mime, 'image/jpeg');
});

test('4. WEBP é suportado — confirmável pelos bytes, não pela extensão', () => {
  assert.equal(findMediaOutput(saidaCom('a_00001_.webp'), { kind: 'image' }).mime, 'image/webp');
  assert.ok(extensionsFor('image').includes('.webp'));
});

// ── 5–7. um tipo não aceita a saída do outro ────────────────────────────────

test('5. extensão inválida é rejeitada na descoberta e no MIME', () => {
  for (const nome of ['x_00001_.txt', 'x_00001_.exe', 'x_00001_.svg', 'x_00001_', 'x_00001_.']) {
    assert.equal(findMediaOutput(saidaCom(nome), { kind: 'image' }), null, `aceitou ${nome}`);
    assert.equal(findMediaOutput(saidaCom(nome), { kind: 'video' }), null, `aceitou ${nome}`);
  }
  assert.throws(() => mimeFor('image', 'x.txt'), MediaKindError);
  assert.throws(() => mimeFor('video', 'x.png'), MediaKindError);
  assert.throws(() => mediaKind('audio'), MediaKindError);
});

test('6. kind=image não aceita MP4 como output', () => {
  assert.equal(findMediaOutput(saidaCom('cinema_abc_00001_.mp4'), { kind: 'image' }), null);
  assert.equal(isExtensionOfKind('image', 'x.mp4'), false);
  assert.equal(jobIdFromOutputFilename('cinema_abc_00001_.mp4', { kind: 'image' }), null);
});

test('7. kind=video não aceita PNG como output', () => {
  assert.equal(findMediaOutput(saidaCom('dragao_00001_.png'), { kind: 'video' }), null);
  assert.equal(isExtensionOfKind('video', 'x.png'), false);
  assert.equal(jobIdFromOutputFilename('dragao_00001_.png', { kind: 'video' }), null);
});

test('a saída certa é encontrada mesmo quando a errada vem primeiro', () => {
  const misturado = {
    50: { images: [{ filename: 'preview_00001_.png', subfolder: '', type: 'output' }] },
    92: { images: [{ filename: 'cinema_abc_00001_.mp4', subfolder: 'video/showrunner', type: 'output' }] },
  };
  assert.equal(findMediaOutput(misturado, { kind: 'video' }).filename, 'cinema_abc_00001_.mp4');
  assert.equal(findMediaOutput(misturado, { kind: 'image' }).filename, 'preview_00001_.png');
});

test('o jobId volta do nome produzido, por tipo', () => {
  assert.equal(jobIdFromOutputFilename('cinema_abc-1_00001_.mp4', { kind: 'video' }), 'cinema_abc-1');
  assert.equal(jobIdFromOutputFilename('img_xyz_00042_.png', { kind: 'image' }), 'img_xyz');
  // Nome que não volta a um identificador seguro é recusado.
  assert.equal(jobIdFromOutputFilename('../escapa_00001_.png', { kind: 'image' }), null);
});

// ── 8–10. armazenamento ─────────────────────────────────────────────────────

test('8. imagem é armazenada em diretório seguro do projeto', async () => {
  const dir = mediaDirFor('image', 'proj_img', RAIZ);
  assert.equal(dir, path.join(path.resolve(RAIZ), 'proj_img', 'images'));
  assert.ok(dir.startsWith(path.resolve(RAIZ)));

  await mkdir(dir, { recursive: true });
  const temp = await mediaTempPath('image', 'proj_img', 'job_img', '.png', RAIZ);
  await writeFile(temp, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]));

  const publicado = await publishMediaFile('image', 'proj_img', 'job_img', temp, '.png', RAIZ);
  assert.equal(publicado.filename, 'job_img.png');
  assert.equal(publicado.url, '/api/media/image/proj_img/job_img.png');
  assert.ok((await stat(publicado.absolutePath)).isFile());

  // Nunca sobrescreve: a segunda publicação ganha sufixo.
  const temp2 = await mediaTempPath('image', 'proj_img', 'job_img', '.png', RAIZ);
  await writeFile(temp2, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1, 1]));
  const segundo = await publishMediaFile('image', 'proj_img', 'job_img', temp2, '.png', RAIZ);
  assert.equal(segundo.filename, 'job_img-2.png');

  assert.equal((await findMediaByJobId('image', 'job_img', RAIZ)).filename, 'job_img.png');
});

test('9. o vídeo continua no caminho e na URL exatamente como antes', () => {
  // Caminho: runtime/projects/<id>/videos/<jobId>.mp4
  const antigo = path.join(path.resolve(RAIZ), 'p1', 'videos', 'cinema_x.mp4');
  assert.equal(resolveVideoPath('p1', 'cinema_x.mp4', RAIZ), antigo);
  assert.equal(resolveMediaPath('video', 'p1', 'cinema_x.mp4', RAIZ), antigo);
  assert.equal(videoDirFor('p1', RAIZ), mediaDirFor('video', 'p1', RAIZ));
  assert.ok(videoDirFor('p1', RAIZ).endsWith(path.join('p1', 'videos')));

  // URL: /api/media/video/<id>/<arquivo>.mp4
  assert.equal(mediaUrlFor('p1', 'cinema_x.mp4'), '/api/media/video/p1/cinema_x.mp4');
  assert.equal(mediaUrlForKind('video', 'p1', 'cinema_x.mp4'), '/api/media/video/p1/cinema_x.mp4');
});

test('10. travessia é rejeitada em todos os caminhos de mídia', () => {
  const maliciosos = ['../fora.png', '../../etc/passwd', 'a/b.png', 'a\\b.png', '/abs/x.png',
    '.png', '', 'x'.repeat(70) + '.png', 'x.png.exe', 'sub/../../x.png'];

  for (const nome of maliciosos) {
    assert.throws(() => validateMediaFilename('image', nome), PathValidationError, `nome: "${nome}"`);
    assert.throws(() => resolveMediaPath('image', 'p1', nome, RAIZ), PathValidationError, `path: "${nome}"`);
    assert.throws(() => mediaUrlForKind('image', 'p1', nome), PathValidationError, `url: "${nome}"`);
  }
  for (const projeto of ['..', '../x', 'a/b', '']) {
    assert.throws(() => resolveMediaPath('image', projeto, 'ok.png', RAIZ), PathValidationError);
    assert.throws(() => mediaDirFor('image', projeto, RAIZ), PathValidationError);
  }
});

test('a extensão de armazenamento é mais estrita que a de descoberta', () => {
  // Reconhecemos .webm como vídeo no /history, mas só gravamos .mp4.
  assert.ok(discoveryExtensionsFor('video').includes('.webm'));
  assert.equal(isStorableExtension('video', 'x.webm'), false);
  assert.throws(() => validateMediaFilename('video', 'x.webm'), PathValidationError);
  assert.deepEqual(extensionsFor('video'), ['.mp4']);
});

// ── 11–15. servir mídia ─────────────────────────────────────────────────────

test('11. MIME de PNG está correto', () => {
  assert.equal(mimeFor('image', 'a.png'), 'image/png');
  assert.equal(resolveMediaRequest(['image', 'p1', 'a.png'], RAIZ).mime, 'image/png');
});

test('12. MIME de JPEG está correto para .jpg e .jpeg', () => {
  assert.equal(mimeFor('image', 'a.jpg'), 'image/jpeg');
  assert.equal(mimeFor('image', 'a.jpeg'), 'image/jpeg');
  assert.equal(resolveMediaRequest(['image', 'p1', 'a.jpg'], RAIZ).mime, 'image/jpeg');
  assert.equal(mimeFor('image', 'a.webp'), 'image/webp');
});

test('13. MIME de MP4 está correto', () => {
  assert.equal(mimeFor('video', 'a.mp4'), 'video/mp4');
  assert.equal(resolveMediaRequest(['video', 'p1', 'a.mp4'], RAIZ).mime, 'video/mp4');
  assert.equal(resolveMediaRequest(['export', 'p1', 'a.mp4'], RAIZ).mime, 'video/mp4');
});

test('14. Range de vídeo continua funcionando', () => {
  assert.equal(resolveMediaRequest(['video', 'p1', 'a.mp4'], RAIZ).range, true);
  assert.equal(resolveMediaRequest(['export', 'p1', 'a.mp4'], RAIZ).range, true);

  assert.deepEqual(parseByteRange('bytes=0-99', 1000), { inicio: 0, fim: 99 });
  assert.deepEqual(parseByteRange('bytes=500-', 1000), { inicio: 500, fim: 999 });
  assert.deepEqual(parseByteRange('bytes=-100', 1000), { inicio: 900, fim: 999 });
  assert.deepEqual(parseByteRange('bytes=0-9999', 1000), { inicio: 0, fim: 999 }, 'fim é limitado ao total');

  assert.equal(parseByteRange('bytes=2000-', 1000), 'invalido');
  assert.equal(parseByteRange('bytes=500-100', 1000), 'invalido');
  assert.equal(parseByteRange(null, 1000), null);
  assert.equal(parseByteRange('items=0-9', 1000), null);
  assert.equal(parseByteRange('bytes=-', 1000), null);
});

test('15. imagem é servida sem depender da lógica de vídeo', () => {
  const img = resolveMediaRequest(['image', 'p1', 'a.png'], RAIZ);
  assert.equal(img.range, false, 'imagem não anuncia Range');
  assert.equal(img.kind, 'image');
  assert.ok(img.absolutePath.includes(path.join('p1', 'images')));
  assert.ok(!img.absolutePath.includes('videos'));

  // E o frame da filmstrip, que já era imagem, seguiu intocado.
  const frame = resolveMediaRequest(['frame', 'p1', 'chave__0.jpg'], RAIZ);
  assert.equal(frame.mime, 'image/jpeg');
  assert.equal(frame.range, false);
  assert.match(frame.cacheControl, /immutable/);
});

test('a rota recusa segmentos e tipos fora do formato', () => {
  const ruins = [
    [], ['video'], ['video', 'p1'], ['video', 'p1', 'a.mp4', 'extra'],
    ['audio', 'p1', 'a.mp3'], ['', 'p1', 'a.mp4'], null, 'video/p1/a.mp4',
  ];
  for (const segmentos of ruins) {
    assert.throws(() => resolveMediaRequest(segmentos, RAIZ), MediaRequestError, `aceitou ${JSON.stringify(segmentos)}`);
  }

  // Travessia e extensão inválida viram 400; tipo desconhecido, 404.
  try { resolveMediaRequest(['image', 'p1', '../x.png'], RAIZ); } catch (e) { assert.equal(e.status, 400); }
  try { resolveMediaRequest(['image', 'p1', 'x.exe'], RAIZ); } catch (e) { assert.equal(e.status, 400); }
  try { resolveMediaRequest(['audio', 'p1', 'x.mp3'], RAIZ); } catch (e) { assert.equal(e.status, 404); }

  assert.deepEqual(Object.keys(TIPOS_SERVIVEIS).sort(), ['export', 'frame', 'image', 'video']);
});

// ── 16–17. o descriptor é quem decide ───────────────────────────────────────

test('16. descriptor.kind controla o caminho image/video', () => {
  // Um descriptor de vídeo faz a infraestrutura procurar e guardar vídeo…
  assert.equal(minimaxH3T2V.kind, 'video');
  assert.equal(
    findMediaOutput(saidaCom('x_00001_.mp4'), { kind: minimaxH3T2V.kind }).kind,
    'video',
  );
  assert.equal(mediaKind(minimaxH3T2V.kind).dir, 'videos');
  assert.equal(mediaKind(minimaxH3T2V.kind).urlSegment, 'video');

  // …e um descriptor de imagem, imagem — sem que nada consulte o nome do modelo.
  const comoSeFosseImagem = { ...minimaxH3T2V, kind: 'image' };
  assert.equal(
    findMediaOutput(saidaCom('x_00001_.png'), { kind: comoSeFosseImagem.kind }).kind,
    'image',
  );
  assert.equal(mediaKind(comoSeFosseImagem.kind).dir, 'images');
  assert.equal(mediaKind(comoSeFosseImagem.kind).urlSegment, 'image');
});

test('o CÓDIGO da infraestrutura de mídia não ramifica por modelo', async () => {
  const { readFile } = await import('node:fs/promises');

  for (const arquivo of ['mediaKinds.js', 'outputs.js', 'mediaServing.js']) {
    const fonte = await readFile(
      new URL(`../lib/server/generation/${arquivo}`, import.meta.url), 'utf8',
    );

    // Comentários podem — e devem — explicar de onde veio uma decisão, como o
    // fato de o SaveVideo do MiniMax publicar MP4 sob a chave `images`. O que
    // não pode existir é código que decida pelo nome do modelo.
    const codigo = fonte
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .map((linha) => linha.replace(/\/\/.*$/, ''))
      .join('\n');

    assert.ok(
      !/minimax|ideogram/i.test(codigo),
      `${arquivo} ramifica por nome de modelo`,
    );
    assert.ok(!/workflowId\s*===/.test(codigo), `${arquivo} compara workflowId`);
  }
});

test('17. o MiniMax continua se comportando exatamente como antes', () => {
  // A superfície antiga de status.js devolve a mesma forma de sempre.
  const saida = findVideoOutput(saidaCom('cinema_abc_00001_.mp4'), '92');
  assert.deepEqual(saida, {
    nodeId: '92',
    filename: 'cinema_abc_00001_.mp4',
    subfolder: 'video/showrunner',
    type: 'output',
  });
  assert.equal(isVideoFile('a.mp4'), true);
  assert.equal(isVideoFile('a.webm'), true);
  assert.equal(isVideoFile('a.png'), false);
  assert.equal(jobIdFromFilename('cinema_abc_00001_.mp4'), 'cinema_abc');

  // O descriptor segue apontando para o mesmo nó de saída e prefixo.
  assert.equal(minimaxH3T2V.nodeIds.save, '92');
  assert.equal(minimaxH3T2V.outputPrefix, 'video/showrunner');
});

test('extensionOf normaliza e recusa nome com caminho', () => {
  assert.equal(extensionOf('a.PNG'), '.png');
  assert.equal(extensionOf('a.tar.gz'), '.gz');
  assert.equal(extensionOf('a/b.png'), '');
  assert.equal(extensionOf('a\\b.png'), '');
  assert.equal(extensionOf('.oculto'), '');
  assert.equal(extensionOf('semponto'), '');
  assert.equal(kindOfExtension('x.mp4'), 'video');
  assert.equal(kindOfExtension('x.png'), 'image');
  assert.equal(kindOfExtension('x.txt'), null);
});
