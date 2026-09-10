// Asset no servidor: metadata, estado de aprovação e — o que motiva a
// entidade — a linhagem explícita entre a imagem e o vídeo gerado a partir
// dela.

import test from 'node:test';
import assert from 'node:assert/strict';
import { APPROVAL } from '../lib/approval.js';
import { DomainError, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import {
  assetDerivatives, assetLineage, createAsset, findAssetByFile, findAssetsByJob,
  getAsset, listAssets, removeAssetRecord, setAssetStatus,
} from '../lib/server/domain/assets.js';

function bancoComProjeto(id = 'p1') {
  const db = openDatabase(':memory:');
  createProject({ id, name: 'Produção' }, db);
  return db;
}

test('cria um asset de vídeo com a metadata completa', () => {
  const db = bancoComProjeto();

  const asset = createAsset({
    projectId: 'p1',
    kind: 'video',
    jobId: 'cinema_mt2011bo_uhqqd3',
    filename: 'cinema_mt2011bo_uhqqd3.mp4',
    url: '/api/media/video/p1/cinema_mt2011bo_uhqqd3.mp4',
    mimeType: 'video/mp4',
    bytes: 524288,
    width: 848,
    height: 480,
    durationSeconds: 5.2,
    prompt: 'Plano geral da estação',
    seed: 281474976710655,
    modelId: 'minimax-h3',
  }, db);

  assert.equal(asset.kind, 'video');
  assert.equal(asset.projectId, 'p1');
  assert.equal(asset.bytes, 524288);
  assert.equal(asset.durationSeconds, 5.2);
  assert.equal(asset.seed, 281474976710655);
  assert.equal(asset.derivedFromAssetId, null);
  assert.equal(asset.status, APPROVAL.PENDING, 'nasce pendente de aprovação');
  assert.match(asset.id, /^asset_[A-Za-z0-9_-]+$/);
  assert.deepEqual(getAsset(asset.id, db), asset);
  db.close();
});

test('campos opcionais ausentes viram NULL, não a string "null"', () => {
  const db = bancoComProjeto();
  const asset = createAsset({ projectId: 'p1', kind: 'image' }, db);

  for (const campo of ['jobId', 'filename', 'url', 'mimeType', 'bytes', 'width',
    'height', 'durationSeconds', 'prompt', 'seed', 'modelId', 'derivedFromAssetId']) {
    assert.equal(asset[campo], null, `${campo} deveria ser null`);
  }
  db.close();
});

test('projeto inexistente e kind desconhecido são recusados', () => {
  const db = bancoComProjeto();
  assert.throws(() => createAsset({ projectId: 'fantasma', kind: 'video' }, db), DomainError);
  // `audio` virou tipo VÁLIDO no PASSO 14-C1 e saiu daqui. O que continua sendo
  // recusado é uma palavra que não está no vocabulário.
  assert.throws(() => createAsset({ projectId: 'p1', kind: 'texto' }, db), DomainError);
  assert.throws(() => createAsset({ projectId: 'p1', kind: 'narration' }, db), DomainError);
  assert.throws(() => createAsset({ projectId: 'p1', kind: undefined }, db), DomainError);
  assert.throws(
    () => createAsset({ projectId: 'p1', kind: 'video', status: 'inventado' }, db),
    DomainError,
  );
  assert.equal(listAssets({}, db).length, 0);
  db.close();
});

// ── linhagem ────────────────────────────────────────────────────────────────

test('imagem A → vídeo B mantém a linhagem explícita', () => {
  const db = bancoComProjeto();

  const imagem = createAsset({
    projectId: 'p1', kind: 'image', filename: 'dragao.png',
    prompt: 'um dragão', modelId: 'sdxl',
  }, db);

  const video = createAsset({
    projectId: 'p1', kind: 'video', filename: 'dragao_animado.mp4',
    prompt: 'anime essa imagem', modelId: 'minimax-h3',
    derivedFromAssetId: imagem.id,
  }, db);

  assert.equal(video.derivedFromAssetId, imagem.id);
  assert.deepEqual(assetLineage(video.id, db).map((a) => a.id), [video.id, imagem.id]);
  assert.deepEqual(assetLineage(imagem.id, db).map((a) => a.id), [imagem.id]);
  assert.deepEqual(assetDerivatives(imagem.id, db).map((a) => a.id), [video.id]);
  assert.deepEqual(assetDerivatives(video.id, db), []);
  db.close();
});

test('a linhagem acompanha uma cadeia de mais de dois níveis', () => {
  const db = bancoComProjeto();
  const a = createAsset({ projectId: 'p1', kind: 'image', filename: 'a.png' }, db);
  const b = createAsset({ projectId: 'p1', kind: 'video', filename: 'b.mp4', derivedFromAssetId: a.id }, db);
  const c = createAsset({ projectId: 'p1', kind: 'video', filename: 'c.mp4', derivedFromAssetId: b.id }, db);

  assert.deepEqual(assetLineage(c.id, db).map((x) => x.id), [c.id, b.id, a.id]);
  db.close();
});

test('derivar de um asset inexistente é recusado', () => {
  const db = bancoComProjeto();
  assert.throws(
    () => createAsset({ projectId: 'p1', kind: 'video', derivedFromAssetId: 'asset_fantasma' }, db),
    DomainError,
  );
  assert.equal(listAssets({}, db).length, 0);
  db.close();
});

test('um asset não pode derivar de si mesmo', () => {
  const db = bancoComProjeto();
  assert.throws(
    () => createAsset({ projectId: 'p1', kind: 'video', id: 'asset_x', derivedFromAssetId: 'asset_x' }, db),
    DomainError,
  );
  db.close();
});

test('a linhagem não é editável depois da criação — não há como formar ciclo', async () => {
  const db = bancoComProjeto();
  const a = createAsset({ projectId: 'p1', kind: 'image', filename: 'a.png' }, db);
  const b = createAsset({ projectId: 'p1', kind: 'video', filename: 'b.mp4', derivedFromAssetId: a.id }, db);

  // A superfície de mutação é deliberadamente mínima: só o estado de aprovação.
  // Como `derivedFromAssetId` só pode apontar para um asset que já existe, e
  // nunca é reapontado, um ciclo não tem como se formar por esta camada.
  const modulo = await import('../lib/server/domain/assets.js');
  const mutadores = Object.keys(modulo).filter((n) => /^(set|update)/.test(n));
  assert.deepEqual(mutadores, ['setAssetStatus']);

  assert.deepEqual(assetLineage(b.id, db).map((x) => x.id), [b.id, a.id]);
  db.close();
});

// ── consultas e estado ──────────────────────────────────────────────────────

test('o mesmo arquivo não entra duas vezes no mesmo projeto', () => {
  const db = bancoComProjeto();
  createAsset({ projectId: 'p1', kind: 'video', filename: 'mesmo.mp4' }, db);
  assert.throws(
    () => createAsset({ projectId: 'p1', kind: 'video', filename: 'mesmo.mp4' }, db),
    DomainError,
  );
  assert.equal(listAssets({ projectId: 'p1' }, db).length, 1);
  db.close();
});

test('o mesmo nome de arquivo em projetos distintos é permitido', () => {
  const db = bancoComProjeto('p1');
  createProject({ id: 'p2', name: 'Outra' }, db);

  createAsset({ projectId: 'p1', kind: 'video', filename: 'clipe.mp4' }, db);
  createAsset({ projectId: 'p2', kind: 'video', filename: 'clipe.mp4' }, db);

  assert.equal(findAssetByFile('p1', 'clipe.mp4', db).projectId, 'p1');
  assert.equal(findAssetByFile('p2', 'clipe.mp4', db).projectId, 'p2');
  assert.equal(findAssetByFile('p1', 'inexistente.mp4', db), null);
  db.close();
});

test('filtra por projeto e por tipo', () => {
  const db = bancoComProjeto('p1');
  createProject({ id: 'p2', name: 'Outra' }, db);

  createAsset({ projectId: 'p1', kind: 'image', filename: 'i1.png' }, db);
  createAsset({ projectId: 'p1', kind: 'video', filename: 'v1.mp4' }, db);
  createAsset({ projectId: 'p2', kind: 'video', filename: 'v2.mp4' }, db);

  assert.equal(listAssets({ projectId: 'p1' }, db).length, 2);
  assert.equal(listAssets({ projectId: 'p1', kind: 'video' }, db).length, 1);
  assert.equal(listAssets({ kind: 'video' }, db).length, 2);
  assert.equal(listAssets({}, db).length, 3);
  db.close();
});

test('encontra os assets de um job', () => {
  const db = bancoComProjeto();
  createAsset({ projectId: 'p1', kind: 'video', jobId: 'cinema_abc', filename: 'v.mp4' }, db);
  assert.deepEqual(findAssetsByJob('cinema_abc', db).map((a) => a.filename), ['v.mp4']);
  assert.deepEqual(findAssetsByJob('cinema_zzz', db), []);
  assert.deepEqual(findAssetsByJob(null, db), []);
  db.close();
});

test('o estado de aprovação usa o vocabulário de lib/approval.js', () => {
  const db = bancoComProjeto();
  const asset = createAsset({ projectId: 'p1', kind: 'video', filename: 'v.mp4' }, db);

  assert.equal(setAssetStatus(asset.id, APPROVAL.APPROVED, db).status, 'aprovado');
  assert.equal(setAssetStatus(asset.id, APPROVAL.REVISION, db).status, 'revisão');
  assert.throws(() => setAssetStatus(asset.id, 'quase', db), DomainError);
  assert.throws(() => setAssetStatus('fantasma', APPROVAL.APPROVED, db), DomainError);
  db.close();
});

test('apagar o projeto leva os assets junto — o arquivo em disco não é assunto daqui', () => {
  const db = bancoComProjeto();
  createAsset({ projectId: 'p1', kind: 'video', filename: 'v.mp4' }, db);
  db.prepare('DELETE FROM projects WHERE id = ?').run('p1');
  assert.deepEqual(listAssets({ projectId: 'p1' }, db), []);
  db.close();
});

test('remover o registro do asset de origem preserva o derivado', () => {
  const db = bancoComProjeto();
  const imagem = createAsset({ projectId: 'p1', kind: 'image', filename: 'a.png' }, db);
  const video = createAsset({ projectId: 'p1', kind: 'video', filename: 'b.mp4', derivedFromAssetId: imagem.id }, db);

  assert.equal(removeAssetRecord(imagem.id, db), true);

  // ON DELETE SET NULL: o vídeo continua existindo, apenas sem origem conhecida.
  assert.equal(getAsset(video.id, db).derivedFromAssetId, null);
  assert.equal(removeAssetRecord(imagem.id, db), false);
  db.close();
});
