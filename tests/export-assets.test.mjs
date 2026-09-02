// Resolução de assets: allowlist, ordem da timeline, deduplicação e
// proteção contra caminhos arbitrários vindos do navegador.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  AssetResolutionError, listRegisteredVideos, resolveFromAllowlist, resolveTimelineAssets,
} from '../lib/server/export/assets.js';
import { findPendingScenes } from '../lib/server/export/runner.js';

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-export-assets-'));
test.after(() => rm(RAIZ, { recursive: true, force: true }));

const JOB_A = 'cinema_aaa111';
const JOB_B = 'cinema_bbb222';

await mkdir(path.join(RAIZ, 'proj_um', 'videos'), { recursive: true });
await mkdir(path.join(RAIZ, 'proj_dois', 'videos'), { recursive: true });
await writeFile(path.join(RAIZ, 'proj_um', 'videos', `${JOB_A}.mp4`), 'conteudo-a');
await writeFile(path.join(RAIZ, 'proj_dois', 'videos', `${JOB_B}.mp4`), 'conteudo-b');
// Ruído que não pode entrar na allowlist:
await writeFile(path.join(RAIZ, 'proj_um', 'videos', 'notas.txt'), 'não é vídeo');
await mkdir(path.join(RAIZ, '..um projeto inválido..'), { recursive: true });

test('a allowlist contém só os MP4 que a aplicação gravou', async () => {
  const lista = await listRegisteredVideos(RAIZ);
  const ids = lista.map((a) => a.jobId).sort();
  assert.deepEqual(ids, [JOB_A, JOB_B].sort());
  assert.ok(lista.every((a) => a.absolutePath.startsWith(path.resolve(RAIZ))));
  assert.ok(!lista.some((a) => a.filename.endsWith('.txt')));
});

test('resolve por jobId e pela URL pública emitida pela aplicação', async () => {
  const lista = await listRegisteredVideos(RAIZ);

  const porJob = resolveFromAllowlist({ jobId: JOB_B }, lista);
  assert.equal(porJob.projectId, 'proj_dois');

  const porUrl = resolveFromAllowlist({ mediaUrl: `/api/media/video/proj_um/${JOB_A}.mp4` }, lista);
  assert.equal(porUrl.jobId, JOB_A);
});

test('SEGURANÇA: caminho enviado pelo navegador nunca é usado', async () => {
  const lista = await listRegisteredVideos(RAIZ);

  // Um "path" no pedido é simplesmente ignorado — só jobId e mediaUrl contam.
  assert.throws(
    () => resolveFromAllowlist({ path: '/etc/passwd' }, lista),
    AssetResolutionError,
  );
  assert.throws(
    () => resolveFromAllowlist({ absolutePath: '/etc/passwd' }, lista),
    AssetResolutionError,
  );
});

test('SEGURANÇA: travessia de caminho é recusada em todas as formas', async () => {
  const lista = await listRegisteredVideos(RAIZ);
  const hostis = [
    { mediaUrl: '/api/media/video/../../../etc/passwd' },
    { mediaUrl: '/api/media/video/proj_um/../../../etc/passwd' },
    { mediaUrl: '/api/media/video/proj_um/..%2f..%2fpasswd.mp4' },
    { mediaUrl: 'file:///etc/passwd' },
    { mediaUrl: 'http://exemplo.com/x.mp4' },
    { jobId: '../fuga' },
    { jobId: 'proj/../../etc' },
  ];
  for (const pedido of hostis) {
    assert.throws(() => resolveFromAllowlist(pedido, lista), AssetResolutionError, JSON.stringify(pedido));
  }
});

test('asset inexistente é recusado, mesmo com jobId bem formado', async () => {
  const lista = await listRegisteredVideos(RAIZ);
  assert.throws(() => resolveFromAllowlist({ jobId: 'cinema_naoexiste' }, lista), AssetResolutionError);
});

test('a ordem da timeline é preservada na resolução', async () => {
  const direta = await resolveTimelineAssets(
    [{ jobId: JOB_A, title: 'Cena 1' }, { jobId: JOB_B, title: 'Cena 2' }],
    { root: RAIZ },
  );
  assert.deepEqual(direta.map((a) => a.jobId), [JOB_A, JOB_B]);
  assert.deepEqual(direta.map((a) => a.order), [0, 1]);

  const invertida = await resolveTimelineAssets(
    [{ jobId: JOB_B }, { jobId: JOB_A }],
    { root: RAIZ },
  );
  assert.deepEqual(invertida.map((a) => a.jobId), [JOB_B, JOB_A]);
});

test('o mesmo arquivo duas vezes na montagem é recusado', async () => {
  await assert.rejects(
    () => resolveTimelineAssets([{ jobId: JOB_A }, { jobId: JOB_A }], { root: RAIZ }),
    (erro) => erro instanceof AssetResolutionError && /repete um arquivo/.test(erro.message),
  );

  // A mesma duplicata expressa de formas diferentes também é pega.
  await assert.rejects(
    () => resolveTimelineAssets(
      [{ jobId: JOB_A }, { mediaUrl: `/api/media/video/proj_um/${JOB_A}.mp4` }],
      { root: RAIZ },
    ),
    AssetResolutionError,
  );
});

test('timeline vazia não gera exportação', async () => {
  await assert.rejects(() => resolveTimelineAssets([], { root: RAIZ }), AssetResolutionError);
  await assert.rejects(() => resolveTimelineAssets(null, { root: RAIZ }), AssetResolutionError);
});

test('a resolução devolve metadados úteis e o caminho contido na raiz', async () => {
  const [asset] = await resolveTimelineAssets([{ jobId: JOB_A, title: 'Cena 1A', resultId: 'vid_x' }], { root: RAIZ });
  assert.equal(asset.title, 'Cena 1A');
  assert.equal(asset.resultId, 'vid_x');
  assert.equal(asset.bytes, 'conteudo-a'.length);
  assert.ok(asset.absolutePath.startsWith(path.resolve(RAIZ)));
});

// ── bloqueio por aprovação ──────────────────────────────────────────────────
test('cenas sem aprovação são listadas com posição e título', () => {
  const pendentes = findPendingScenes([
    { title: 'Cena 1A — Plano geral da estação', approved: true, status: 'aprovado' },
    { title: 'Cena 1B — Helena caminha pela plataforma', approved: false, status: 'pendente' },
  ]);

  assert.equal(pendentes.length, 1);
  assert.equal(pendentes[0].posicao, 2);
  assert.equal(pendentes[0].titulo, 'Cena 1B — Helena caminha pela plataforma');
  assert.equal(pendentes[0].status, 'pendente');
});

test('tudo aprovado libera; nada aprovado bloqueia tudo', () => {
  assert.equal(findPendingScenes([{ approved: true }, { approved: true }]).length, 0);
  assert.equal(findPendingScenes([{ approved: false }, { approved: false }]).length, 2);
  // "approved" precisa ser exatamente true — valores próximos não passam.
  assert.equal(findPendingScenes([{ approved: 'sim' }]).length, 1);
  assert.equal(findPendingScenes([{ status: 'aprovado' }]).length, 1);
});

test('cena pendente sem título recebe rótulo pela posição', () => {
  const [p] = findPendingScenes([{ approved: false }]);
  assert.equal(p.titulo, 'Cena 1');
});

test('REGRESSÃO: pedido com asset inválido é recusado na hora, não em segundo plano', async () => {
  const { startExport } = await import('../lib/server/export/runner.js');

  // Antes, startExport aceitava e o job falhava depois — a resposta dizia 202
  // para um pedido que nunca poderia funcionar.
  await assert.rejects(
    () => startExport({
      projectId: 'proj_um', root: RAIZ,
      clips: [{ mediaUrl: '/api/media/video/../../etc/passwd', approved: true }],
    }),
    AssetResolutionError,
  );

  await assert.rejects(
    () => startExport({
      projectId: 'proj_um', root: RAIZ,
      clips: [{ jobId: 'cinema_naoexiste', approved: true }],
    }),
    AssetResolutionError,
  );

  // Um "path" no corpo continua sendo ignorado por completo.
  await assert.rejects(
    () => startExport({
      projectId: 'proj_um', root: RAIZ,
      clips: [{ path: '/etc/passwd', approved: true }],
    }),
    AssetResolutionError,
  );
});
