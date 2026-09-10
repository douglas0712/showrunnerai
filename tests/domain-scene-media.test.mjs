// A mídia de uma cena no domínio — takes e seleção.
//
// PASSO 13-A. O que estes testes trancam é uma frase só, dita de várias formas:
// **regenerar acrescenta, e nunca sobrescreve**. Uma cena que guardasse UMA
// imagem numa coluna destruiria a anterior a cada pedido de "gere outra" — e a
// anterior era, metade das vezes, a boa.
//
// As invariantes que importam, e por que cada uma existe:
//
//   take é linha, não coluna    a segunda geração não pode apagar a primeira
//   número por cena E por tipo  a primeira imagem e o primeiro vídeo são o 1
//   número é do servidor        um modelo que chuta o take erra depois de uma
//                               geração que ele não viu acontecer
//   UNIQUE(cena, tipo, número)  a corrida que sobra vira erro, não dois takes 3
//   seleção é ponteiro          escolher outro take não apaga take nenhum
//   uma escolha por tipo        estrutura (PRIMARY KEY), não conferência
//   seleção só da MESMA cena    chave estrangeira composta: impossível, não
//   e só do MESMO tipo          recusado — nem por SQL escrito à mão
//   cross-project impossível    Asset e job são conferidos contra o projeto
//   nada de mídia é copiado     caminho, workflow e provider são do Asset e do
//                               descriptor; o take guarda referências
//   nenhum estado novo          a situação de um take mora no generation_jobs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ASSET_KINDS, DomainError, ESQUEMA_ATUAL, openDatabase, schemaVersion,
} from '../lib/server/domain/db.js';
import { JOB_STATE_VALUES } from '../lib/server/domain/generationJobStates.js';
import { createProject, deleteProject } from '../lib/server/domain/projects.js';
import { createAsset, removeAssetRecord } from '../lib/server/domain/assets.js';
import { createGenerationJobRecord } from '../lib/server/domain/generationJobs.js';
import { createSceneRecord, listScenes } from '../lib/server/domain/scenes.js';
import { createProjectDocument } from '../lib/server/domain/documents.js';
import { DOCUMENT_TYPES } from '../lib/server/domain/documentTypes.js';
import {
  getProductionScene, listProductionScenes, replaceProductionScenes,
  saveProductionPlan, saveProductionScript, updateProductionScene,
} from '../lib/server/domain/production.js';
import {
  attachSceneTakeAsset, attachSceneTakeJob, createSceneTake,
  declaredSceneTakeFields, getSceneSelection, getSceneTake, listSceneTakes,
  MAX_TAKES_POR_CENA, publicSceneTake, SCENE_MEDIA_KINDS, sceneSelections,
  selectSceneTake,
} from '../lib/server/domain/sceneMedia.js';

const SHA = 'd'.repeat(64);

/** Um banco com dois projetos, cada um com roteiro de três cenas de 40 s. */
function banco() {
  const db = openDatabase(':memory:');
  for (const [id, nome] of [['proj_a', 'Produção A'], ['proj_b', 'Produção B']]) {
    createProject({ id, name: nome }, db);
    comCenas(db, id);
  }
  return db;
}

function comCenas(db, projectId, total = 3) {
  saveProductionPlan({
    projectId, title: 'Plano', targetDurationSeconds: total * 40,
  }, db);
  saveProductionScript({ projectId, title: 'Roteiro', fullText: 'Texto do roteiro.' }, db);
  replaceProductionScenes(projectId, Array.from({ length: total }, (_, i) => ({
    ordinal: i + 1,
    title: `Cena ${i + 1}`,
    durationSeconds: 40,
  })), db);
}

let contador = 0;

function umAsset(db, projectId, kind = 'image') {
  contador += 1;
  return createAsset({
    projectId, kind, filename: `arquivo_${contador}.png`,
  }, db);
}

function umJob(db, projectId, kind = 'image') {
  contador += 1;
  return createGenerationJobRecord({
    jobId: `job_${contador}`, projectId, kind, workflowId: 'ideogram4',
  }, db);
}

/** As colunas de uma tabela, pelo que o SQLite diz que elas são. */
function colunas(db, tabela) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
}

// ── C · takes de imagem ─────────────────────────────────────────────────────

test('C. uma cena tem take de imagem 1 e 2, e o segundo não apaga o primeiro', () => {
  const db = banco();

  const primeiro = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  const segundo = createSceneTake('proj_a', 1, { kind: 'image' }, db);

  assert.equal(primeiro.takeNumber, 1);
  assert.equal(segundo.takeNumber, 2);
  assert.notEqual(primeiro.id, segundo.id);

  const takes = listSceneTakes('proj_a', 1, 'image', db);
  assert.deepEqual(takes.map((t) => t.takeNumber), [1, 2]);

  db.close();
});

// ── D · vídeo, contado à parte ──────────────────────────────────────────────

test('D. o vídeo numera do 1 mesmo com imagens já feitas', () => {
  const db = banco();

  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  const video = createSceneTake('proj_a', 1, { kind: 'video' }, db);

  assert.equal(video.takeNumber, 1);
  assert.deepEqual(listSceneTakes('proj_a', 1, 'image', db).map((t) => t.takeNumber), [1, 2]);
  assert.deepEqual(listSceneTakes('proj_a', 1, 'video', db).map((t) => t.takeNumber), [1]);

  db.close();
});

test('D-bis. o exemplo do enunciado: cena 4 com três imagens e dois vídeos', () => {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_a', name: 'A' }, db);
  comCenas(db, 'proj_a', 5);

  for (let i = 0; i < 3; i += 1) createSceneTake('proj_a', 4, { kind: 'image' }, db);
  for (let i = 0; i < 2; i += 1) createSceneTake('proj_a', 4, { kind: 'video' }, db);

  assert.deepEqual(listSceneTakes('proj_a', 4, 'image', db).map((t) => t.takeNumber), [1, 2, 3]);
  assert.deepEqual(listSceneTakes('proj_a', 4, 'video', db).map((t) => t.takeNumber), [1, 2]);

  // E as cenas vizinhas continuam vazias: a numeração é por CENA.
  assert.deepEqual(listSceneTakes('proj_a', 3, null, db), []);
  assert.deepEqual(listSceneTakes('proj_a', 5, null, db), []);

  // A primeira imagem da cena 5 também é o take 1.
  assert.equal(createSceneTake('proj_a', 5, { kind: 'image' }, db).takeNumber, 1);

  db.close();
});

// ── E · UNIQUE(sceneId, kind, takeNumber) ───────────────────────────────────

test('E. o banco recusa dois takes com o mesmo número na mesma cena e tipo', () => {
  const db = banco();

  const take = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  const agora = Date.now();

  assert.throws(() => db.prepare(`
    INSERT INTO production_scene_media
      (id, sceneId, kind, takeNumber, generationJobId, assetId, createdAt, updatedAt)
    VALUES (?, ?, 'image', 1, NULL, NULL, ?, ?)
  `).run('media_duplicado', take.sceneId, agora, agora), /UNIQUE|constraint/i);

  // O mesmo número em OUTRO tipo é legítimo, e entra.
  db.prepare(`
    INSERT INTO production_scene_media
      (id, sceneId, kind, takeNumber, generationJobId, assetId, createdAt, updatedAt)
    VALUES (?, ?, 'video', 1, NULL, NULL, ?, ?)
  `).run('media_video_1', take.sceneId, agora, agora);

  assert.equal(listSceneTakes('proj_a', 1, null, db).length, 2);
  db.close();
});

// ── F · takeNumber > 0 ──────────────────────────────────────────────────────

test('F. o banco recusa um take de número zero ou negativo', () => {
  const db = banco();
  const take = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  const agora = Date.now();

  for (const numero of [0, -1]) {
    assert.throws(() => db.prepare(`
      INSERT INTO production_scene_media
        (id, sceneId, kind, takeNumber, generationJobId, assetId, createdAt, updatedAt)
      VALUES (?, ?, 'video', ?, NULL, NULL, ?, ?)
    `).run(`media_${numero}`, take.sceneId, numero, agora, agora), /CHECK|constraint/i);
  }

  db.close();
});

// ── G · kind fechado ────────────────────────────────────────────────────────

test('G. um tipo que não é image nem video é recusado — no domínio e no banco', () => {
  const db = banco();

  for (const kind of ['audio', 'IMAGE', '', null, undefined, 'imagem']) {
    assert.throws(
      () => createSceneTake('proj_a', 1, { kind }, db),
      (erro) => erro instanceof DomainError && /Tipo de mídia inválido/.test(erro.message),
      `aceitou o tipo ${JSON.stringify(kind)}`,
    );
  }

  const take = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  const agora = Date.now();
  assert.throws(() => db.prepare(`
    INSERT INTO production_scene_media
      (id, sceneId, kind, takeNumber, generationJobId, assetId, createdAt, updatedAt)
    VALUES ('media_audio', ?, 'audio', 1, NULL, NULL, ?, ?)
  `).run(take.sceneId, agora, agora), /CHECK|constraint/i);

  // E o vocabulário desta pipeline NÃO é o do Asset. Era, até o PASSO 14-C1 —
  // e o alias foi exatamente o que teria feito `audio` entrar aqui de graça no
  // dia em que virou tipo físico. A pipeline visual é image|video, e o áudio da
  // cena é um PAPEL, em `production_scene_audio_takes`.
  assert.deepEqual([...SCENE_MEDIA_KINDS], ['image', 'video']);
  assert.equal(ASSET_KINDS.includes('audio'), true, 'o Asset ganhou audio no 14-C1');
  assert.equal(SCENE_MEDIA_KINDS.includes('audio'), false, 'a pipeline visual NÃO ganhou');

  db.close();
});

// ── H · o número é do servidor ──────────────────────────────────────────────

test('H. quem chama não escolhe o número do take — o servidor aloca o próximo', () => {
  const db = banco();

  // Um takeNumber vindo de fora é ignorado: o próximo é sempre o próximo.
  const primeiro = createSceneTake('proj_a', 1, { kind: 'image', takeNumber: 7 }, db);
  assert.equal(primeiro.takeNumber, 1);

  const segundo = createSceneTake('proj_a', 1, { kind: 'image', takeNumber: 1 }, db);
  assert.equal(segundo.takeNumber, 2);

  // E nenhuma API de escrita aceita um takeNumber que ainda não exista: as duas
  // ligações endereçam um take, não criam um.
  assert.throws(
    () => attachSceneTakeJob('proj_a', 1, {
      kind: 'image', takeNumber: 9, generationJobId: umJob(db, 'proj_a').jobId,
    }, db),
    (erro) => erro instanceof DomainError && /não tem um take/.test(erro.message),
  );

  db.close();
});

test('H-bis. o próximo número continua depois do maior, e não conta linhas', () => {
  const db = banco();

  const um = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  createSceneTake('proj_a', 1, { kind: 'image' }, db);

  // Um take some (faxina, ou o Asset dele foi embora com o projeto de origem).
  // O próximo ainda é 4: reaproveitar o 1 faria "o take 1" significar duas
  // mídias diferentes na memória de quem já tinha visto a primeira.
  db.prepare('DELETE FROM production_scene_media WHERE id = ?').run(um.id);

  assert.equal(createSceneTake('proj_a', 1, { kind: 'image' }, db).takeNumber, 4);
  db.close();
});

test('H-ter. uma cena não aceita takes sem fim', () => {
  const db = banco();
  for (let i = 0; i < MAX_TAKES_POR_CENA; i += 1) {
    createSceneTake('proj_a', 1, { kind: 'image' }, db);
  }
  assert.throws(
    () => createSceneTake('proj_a', 1, { kind: 'image' }, db),
    (erro) => erro instanceof DomainError && /limite/.test(erro.message),
  );
  // E o tipo vizinho não foi afetado pelo teto do outro.
  assert.equal(createSceneTake('proj_a', 1, { kind: 'video' }, db).takeNumber, 1);
  db.close();
});

test('H-quater. uma cena que não existe não recebe take', () => {
  const db = banco();
  for (const ordinal of [0, 9, -1, null, 'quatro']) {
    assert.throws(
      () => createSceneTake('proj_a', ordinal, { kind: 'image' }, db),
      (erro) => erro instanceof DomainError && /não tem uma cena/.test(erro.message),
    );
  }
  db.close();
});

// ── I · Asset de outro projeto ──────────────────────────────────────────────

test('I. o Asset de outro projeto não entra num take', () => {
  const db = banco();
  const alheio = umAsset(db, 'proj_b');

  assert.throws(
    () => createSceneTake('proj_a', 1, { kind: 'image', assetId: alheio.id }, db),
    (erro) => erro instanceof DomainError && /de outro projeto/.test(erro.message),
  );

  const take = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  assert.throws(
    () => attachSceneTakeAsset('proj_a', 1, {
      kind: 'image', takeNumber: take.takeNumber, assetId: alheio.id,
    }, db),
    (erro) => erro instanceof DomainError && /de outro projeto/.test(erro.message),
  );

  // Nada foi gravado pela metade.
  assert.equal(getSceneTake('proj_a', 1, { kind: 'image', takeNumber: 1 }, db).assetId, null);

  // O Asset do PRÓPRIO projeto entra.
  const meu = umAsset(db, 'proj_a');
  const ligado = attachSceneTakeAsset('proj_a', 1, {
    kind: 'image', takeNumber: 1, assetId: meu.id,
  }, db);
  assert.equal(ligado.assetId, meu.id);

  db.close();
});

test('I-bis. um Asset de vídeo não vira take de imagem', () => {
  const db = banco();
  const video = umAsset(db, 'proj_a', 'video');

  assert.throws(
    () => createSceneTake('proj_a', 1, { kind: 'image', assetId: video.id }, db),
    (erro) => erro instanceof DomainError && /é de video/.test(erro.message),
  );

  assert.throws(
    () => createSceneTake('proj_a', 1, { kind: 'image', assetId: 'asset_que_nao_existe' }, db),
    (erro) => erro instanceof DomainError && /Asset desconhecido/.test(erro.message),
  );

  db.close();
});

test('I-ter. o Asset de um take é escrito uma vez só', () => {
  const db = banco();
  const a = umAsset(db, 'proj_a');
  const b = umAsset(db, 'proj_a');

  createSceneTake('proj_a', 1, { kind: 'image', assetId: a.id }, db);

  // Regravar o mesmo é aceito e não muda nada — é o retry de quem chama.
  assert.equal(
    attachSceneTakeAsset('proj_a', 1, { kind: 'image', takeNumber: 1, assetId: a.id }, db).assetId,
    a.id,
  );

  assert.throws(
    () => attachSceneTakeAsset('proj_a', 1, { kind: 'image', takeNumber: 1, assetId: b.id }, db),
    (erro) => erro instanceof DomainError && /já tem outra mídia/.test(erro.message),
  );

  db.close();
});

// ── J · job de outro projeto ────────────────────────────────────────────────

test('J. a geração de outro projeto não entra num take', () => {
  const db = banco();
  const alheio = umJob(db, 'proj_b');

  assert.throws(
    () => createSceneTake('proj_a', 1, { kind: 'image', generationJobId: alheio.jobId }, db),
    (erro) => erro instanceof DomainError && /de outro projeto/.test(erro.message),
  );

  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  assert.throws(
    () => attachSceneTakeJob('proj_a', 1, {
      kind: 'image', takeNumber: 1, generationJobId: alheio.jobId,
    }, db),
    (erro) => erro instanceof DomainError && /de outro projeto/.test(erro.message),
  );

  const meu = umJob(db, 'proj_a');
  assert.equal(
    attachSceneTakeJob('proj_a', 1, {
      kind: 'image', takeNumber: 1, generationJobId: meu.jobId,
    }, db).generationJobId,
    meu.jobId,
  );

  db.close();
});

test('J-bis. uma geração de vídeo não vira take de imagem, e um job serve a um take só', () => {
  const db = banco();
  const video = umJob(db, 'proj_a', 'video');

  assert.throws(
    () => createSceneTake('proj_a', 1, { kind: 'image', generationJobId: video.jobId }, db),
    (erro) => erro instanceof DomainError && /produz video/.test(erro.message),
  );
  assert.throws(
    () => createSceneTake('proj_a', 1, { kind: 'image', generationJobId: 'job_fantasma' }, db),
    (erro) => erro instanceof DomainError && /Geração desconhecida/.test(erro.message),
  );

  // O mesmo trabalho não pode ser o take de duas cenas: um trabalho produz uma
  // mídia, e uma mídia ocupa um lugar.
  const imagem = umJob(db, 'proj_a');
  createSceneTake('proj_a', 1, { kind: 'image', generationJobId: imagem.jobId }, db);
  assert.throws(
    () => createSceneTake('proj_a', 2, { kind: 'image', generationJobId: imagem.jobId }, db),
    /UNIQUE|constraint/i,
  );

  // E a cena 2 continua sem take nenhum: a transação inteira voltou atrás.
  assert.deepEqual(listSceneTakes('proj_a', 2, null, db), []);

  db.close();
});

// ── K · L · M · a seleção ───────────────────────────────────────────────────

test('K. selecionar a imagem escolhe o take, e trocar a escolha só move o ponteiro', () => {
  const db = banco();

  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  createSceneTake('proj_a', 1, { kind: 'image' }, db);

  assert.equal(getSceneSelection('proj_a', 1, 'image', db), null);

  const escolhido = selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 2 }, db);
  assert.equal(escolhido.takeNumber, 2);
  assert.equal(getSceneSelection('proj_a', 1, 'image', db).takeNumber, 2);

  // Uma escolha por cena e por tipo: escolher de novo substitui, não acumula.
  selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 1 }, db);
  assert.equal(getSceneSelection('proj_a', 1, 'image', db).takeNumber, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_media_selections').get().n,
    1,
  );

  db.close();
});

test('L. a escolha do vídeo é independente da escolha da imagem', () => {
  const db = banco();

  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  createSceneTake('proj_a', 1, { kind: 'video' }, db);

  selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 2 }, db);
  selectSceneTake('proj_a', 1, { kind: 'video', takeNumber: 1 }, db);

  const escolhas = sceneSelections('proj_a', 1, db);
  assert.equal(escolhas.image.takeNumber, 2);
  assert.equal(escolhas.video.takeNumber, 1);

  // Trocar a imagem não move o vídeo.
  selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 1 }, db);
  assert.equal(sceneSelections('proj_a', 1, db).image.takeNumber, 1);
  assert.equal(sceneSelections('proj_a', 1, db).video.takeNumber, 1);

  // E uma cena sem escolha nenhuma responde nulo nos dois.
  assert.deepEqual(sceneSelections('proj_a', 2, db), { image: null, video: null });

  db.close();
});

test('M. mudar a seleção não apaga take nenhum', () => {
  const db = banco();

  const ids = [1, 2, 3].map(() => createSceneTake('proj_a', 1, { kind: 'image' }, db).id);

  selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 1 }, db);
  selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 3 }, db);
  selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 2 }, db);

  assert.deepEqual(listSceneTakes('proj_a', 1, 'image', db).map((t) => t.id), ids);
  assert.equal(getSceneSelection('proj_a', 1, 'image', db).takeNumber, 2);

  db.close();
});

// ── N · seleção de outra cena ───────────────────────────────────────────────

test('N. a cena 1 não pode escolher o take da cena 2 — nem por SQL escrito à mão', () => {
  const db = banco();

  const daUm = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  const daDois = createSceneTake('proj_a', 2, { kind: 'image' }, db);

  // Pela API não há como sequer tentar: o endereço é sempre relativo à cena de
  // quem pergunta. Selecionar "o take 1" na cena 1 escolhe o take DA CENA 1.
  const escolhido = selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 1 }, db);
  assert.equal(escolhido.id, daUm.id);
  assert.notEqual(escolhido.id, daDois.id);

  // E, no banco, a chave estrangeira composta recusa a linha errada.
  assert.throws(() => db.prepare(`
    INSERT INTO production_scene_media_selections (sceneId, kind, mediaId, updatedAt)
    VALUES (?, 'image', ?, ?)
    ON CONFLICT (sceneId, kind) DO UPDATE SET mediaId = excluded.mediaId
  `).run(daUm.sceneId, daDois.id, Date.now()), /FOREIGN KEY|constraint/i);

  // A escolha legítima continua de pé.
  assert.equal(getSceneSelection('proj_a', 1, 'image', db).id, daUm.id);

  db.close();
});

// ── O · vídeo escolhido como imagem ─────────────────────────────────────────

test('O. um vídeo não é escolhido como imagem, nem uma imagem como vídeo', () => {
  const db = banco();

  const imagem = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  const video = createSceneTake('proj_a', 1, { kind: 'video' }, db);

  // Só existe o take 1 de vídeo; pedir o take 1 de imagem endereça outra linha.
  assert.throws(
    () => selectSceneTake('proj_a', 2, { kind: 'image', takeNumber: 1 }, db),
    (erro) => erro instanceof DomainError && /não tem um take/.test(erro.message),
  );

  // E a chave estrangeira composta recusa a linha cruzada no SQL.
  for (const [kind, media] of [['image', video.id], ['video', imagem.id]]) {
    assert.throws(() => db.prepare(`
      INSERT INTO production_scene_media_selections (sceneId, kind, mediaId, updatedAt)
      VALUES (?, ?, ?, ?)
    `).run(imagem.sceneId, kind, media, Date.now()), /FOREIGN KEY|constraint/i);
  }

  db.close();
});

// ── P · apagar o projeto ────────────────────────────────────────────────────

test('P. apagar o projeto leva takes e seleções, e não toca no projeto vizinho', () => {
  const db = banco();

  for (const projectId of ['proj_a', 'proj_b']) {
    const asset = umAsset(db, projectId);
    const job = umJob(db, projectId);
    createSceneTake(projectId, 1, {
      kind: 'image', assetId: asset.id, generationJobId: job.jobId,
    }, db);
    createSceneTake(projectId, 1, { kind: 'image' }, db);
    createSceneTake(projectId, 1, { kind: 'video' }, db);
    selectSceneTake(projectId, 1, { kind: 'image', takeNumber: 2 }, db);
    selectSceneTake(projectId, 1, { kind: 'video', takeNumber: 1 }, db);
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_media').get().n, 6);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_media_selections').get().n, 4,
  );

  deleteProject('proj_a', db);

  // A cadeia inteira foi embora: Project → Script → Scenes → Media → Selections.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scenes').get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_media').get().n, 3);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_media_selections').get().n, 2,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets WHERE projectId = ?').get('proj_a').n, 0);

  // E o vizinho está inteiro, com a escolha dele de pé.
  assert.equal(getSceneSelection('proj_b', 1, 'image', db).takeNumber, 2);
  assert.equal(listSceneTakes('proj_b', 1, null, db).length, 3);

  db.close();
});

test('P-bis. apagar um take não apaga o Asset, e apagar o Asset não apaga o take', () => {
  const db = banco();

  const asset = umAsset(db, 'proj_a');
  const take = createSceneTake('proj_a', 1, { kind: 'image', assetId: asset.id }, db);
  selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 1 }, db);

  // Um take some: o Asset continua. A mídia é do projeto, não da cena — quem a
  // apagar apaga por decisão de faxina de mídia, e não de planejamento.
  db.prepare('DELETE FROM production_scene_media WHERE id = ?').run(take.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets WHERE id = ?').get(asset.id).n, 1);
  // E a seleção que apontava para ele foi junto: um ponteiro para o nada não é
  // um estado que valha a pena representar.
  assert.equal(getSceneSelection('proj_a', 1, 'image', db), null);

  // O caminho inverso: o Asset some e o take permanece, vazio e honesto.
  const outro = umAsset(db, 'proj_a');
  const segundo = createSceneTake('proj_a', 2, { kind: 'image', assetId: outro.id }, db);
  selectSceneTake('proj_a', 2, { kind: 'image', takeNumber: 1 }, db);
  removeAssetRecord(outro.id, db);

  const sobrevivente = getSceneTake('proj_a', 2, { kind: 'image', takeNumber: 1 }, db);
  assert.equal(sobrevivente.id, segundo.id);
  assert.equal(sobrevivente.assetId, null);
  assert.equal(getSceneSelection('proj_a', 2, 'image', db).takeNumber, 1);

  db.close();
});

// ── Q · nada de mídia é copiado para cá ─────────────────────────────────────

test('Q. o take não guarda caminho, arquivo, workflow nem nada de provider', () => {
  const db = banco();

  const doTake = colunas(db, 'production_scene_media');
  assert.deepEqual(doTake, [
    'id', 'sceneId', 'kind', 'takeNumber', 'generationJobId', 'assetId',
    'createdAt', 'updatedAt',
  ]);

  const daSelecao = colunas(db, 'production_scene_media_selections');
  assert.deepEqual(daSelecao, ['sceneId', 'kind', 'mediaId', 'updatedAt']);

  // O que é do Asset e do descriptor não aparece aqui, com nome nenhum.
  const proibidos = [
    /path/i, /file/i, /url/i, /mime/i, /prompt/i, /seed/i, /model/i,
    /workflow/i, /provider/i, /width/i, /height/i, /duration/i, /bytes/i,
  ];
  for (const coluna of [...doTake, ...daSelecao]) {
    for (const proibido of proibidos) {
      assert.ok(!proibido.test(coluna), `${coluna} duplica algo que já é do Asset`);
    }
  }

  // E a forma pública também não inventa nada.
  assert.deepEqual(declaredSceneTakeFields(), [
    'kind', 'takeNumber', 'generationJobId', 'assetId', 'createdAt', 'updatedAt',
  ]);
  const take = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  assert.deepEqual(Object.keys(publicSceneTake(take)), declaredSceneTakeFields());
  // O `id` da mídia e o da cena NÃO saem do servidor: o endereço de fora é
  // projeto + cena + tipo + número.
  assert.ok(!('id' in publicSceneTake(take)));
  assert.ok(!('sceneId' in publicSceneTake(take)));

  db.close();
});

// ── R · nenhum estado novo foi inventado ────────────────────────────────────

test('R. não há estado de geração nesta camada — nem coluna, nem vocabulário', () => {
  const db = banco();

  for (const tabela of ['production_scene_media', 'production_scene_media_selections']) {
    for (const coluna of colunas(db, tabela)) {
      assert.ok(!/^(status|state)$/i.test(coluna), `${tabela}.${coluna} é um estado novo`);
    }
  }

  // Nenhuma palavra do vocabulário de gerações atravessa para fora daqui: a
  // situação de um take é lida no generation_jobs, pelo generationJobId.
  assert.ok(JOB_STATE_VALUES.length > 0);

  const take = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  const publico = publicSceneTake(take);
  for (const estado of JOB_STATE_VALUES) {
    assert.ok(
      !Object.values(publico).includes(estado),
      `o take publica o estado "${estado}", que é do livro-razão`,
    );
  }

  // O que existe é a REFERÊNCIA: quem quer a situação lê a linha do job.
  const job = umJob(db, 'proj_a');
  const ligado = attachSceneTakeJob('proj_a', 1, {
    kind: 'image', takeNumber: take.takeNumber, generationJobId: job.jobId,
  }, db);
  const doLivroRazao = db
    .prepare('SELECT state FROM generation_jobs WHERE jobId = ?')
    .get(ligado.generationJobId);
  assert.equal(doLivroRazao.state, 'preparing');

  db.close();
});

// ── A · B · a migração 9 → 10 ───────────────────────────────────────────────

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-scene-media-'));
test.after(async () => { await rm(RAIZ, { recursive: true, force: true }); });

test('A. a migração 9 → 10 preserva tudo o que já estava no banco', async () => {
  const caminho = path.join(RAIZ, 'migracao.db');

  const primeira = openDatabase(caminho);
  assert.equal(schemaVersion(primeira), ESQUEMA_ATUAL);

  createProject({ id: 'proj_antigo', name: 'Existia antes' }, primeira);
  const cenaLegada = createSceneRecord({
    projectId: 'proj_antigo', title: 'Cena do storyboard', duration: 6,
  }, primeira);
  createProjectDocument({
    projectId: 'proj_antigo', filename: 'antigo.txt', mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 10, sha256: SHA, chunks: [{ text: 'material antigo' }],
  }, primeira);
  comCenas(primeira, 'proj_antigo', 2);
  const asset = createAsset({
    projectId: 'proj_antigo', kind: 'image', filename: 'antiga.png',
  }, primeira);

  // Volta ao 9 à força, como um banco que nunca viu a migração 10.
  primeira.exec('DROP TABLE production_scene_audio_selections');
  primeira.exec('DROP TABLE production_scene_audio_takes');
  primeira.exec('DROP TABLE production_scene_media_selections');
  primeira.exec('DROP TABLE production_scene_media');
  primeira.exec('PRAGMA user_version = 9');
  primeira.close();

  // Reabrir aplica só o que falta.
  const segunda = openDatabase(caminho);
  assert.equal(schemaVersion(segunda), ESQUEMA_ATUAL);
  assert.ok(ESQUEMA_ATUAL >= 10, 'a migração 10 precisa continuar existindo');

  // Tudo o que existia continua lá.
  assert.equal(
    segunda.prepare('SELECT name FROM projects WHERE id = ?').get('proj_antigo').name,
    'Existia antes',
  );
  assert.deepEqual(listScenes('proj_antigo', segunda).map((c) => c.id), [cenaLegada.id]);
  assert.equal(segunda.prepare('SELECT COUNT(*) AS n FROM project_documents').get().n, 1);
  assert.equal(segunda.prepare('SELECT COUNT(*) AS n FROM document_chunks').get().n, 1);
  assert.equal(segunda.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.deepEqual(
    listProductionScenes('proj_antigo', segunda).map((c) => c.ordinal), [1, 2],
  );

  // E as tabelas novas existem, vazias.
  for (const tabela of ['production_scene_media', 'production_scene_media_selections']) {
    assert.equal(segunda.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0);
  }

  // A mídia de cena funciona no banco migrado, com o material que já estava lá.
  const take = createSceneTake('proj_antigo', 1, { kind: 'image', assetId: asset.id }, segunda);
  selectSceneTake('proj_antigo', 1, { kind: 'image', takeNumber: take.takeNumber }, segunda);
  assert.equal(getSceneSelection('proj_antigo', 1, 'image', segunda).assetId, asset.id);

  segunda.close();
});

test('B. a cena do PASSO 12 continua exatamente como era', () => {
  const db = banco();

  // A migração 10 NÃO evoluiu `production_scenes`: um take é uma linha à parte
  // justamente para que a cena não ganhasse colunas de mídia. Se alguém as
  // acrescentar, este teste cai — e a queda é a conversa.
  assert.deepEqual(colunas(db, 'production_scenes'), [
    'id', 'scriptId', 'ordinal', 'title', 'purpose', 'durationSeconds',
    'narration', 'visualDescription', 'status', 'createdAt', 'updatedAt',
  ]);

  // E a `scenes` da migração 1 também continua intocada.
  assert.deepEqual(colunas(db, 'scenes'), [
    'id', 'projectId', 'number', 'title', 'description', 'duration', 'modelId',
    'status', 'revisionNote', 'image', 'videoId', 'createdAt', 'updatedAt',
  ]);

  // O planejamento inteiro do PASSO 12 continua funcionando, com mídia atrelada.
  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  const cenas = listProductionScenes('proj_a', db);
  assert.deepEqual(cenas.map((c) => c.ordinal), [1, 2, 3]);
  assert.equal(cenas[0].durationSeconds, 40);

  db.close();
});

// ── S · a substituição em bloco não demole mídia (PASSO 13-A.1) ─────────────
//
// `replaceProductionScenes` apaga as cenas e as reinsere com `id` novo. Enquanto
// uma cena era só texto isso era inofensivo. Desde que ela pode ter takes, o
// CASCADE levaria mídia e escolhas junto — em silêncio, e sem nada para
// desfazer. A regra é RECUSAR, e recusar ANTES de qualquer escrita.
//
// Não se preserva por ordinal de propósito: depois de uma reescrita, a cena 4
// pode ser outra cena, e reatar a imagem antiga ao número 4 colaria a mídia da
// cena errada no lugar certo — um defeito que passa despercebido justamente por
// parecer certo.

/** O estado inteiro do planejamento e da mídia, para comparar antes e depois. */
function retrato(db, projectId) {
  return {
    cenas: listProductionScenes(projectId, db),
    takes: db.prepare(`
      SELECT m.* FROM production_scene_media m
        JOIN production_scenes c ON c.id = m.sceneId
        JOIN production_scripts r ON r.id = c.scriptId
       WHERE r.projectId = ?
       ORDER BY c.ordinal ASC, m.kind ASC, m.takeNumber ASC
    `).all(projectId).map((registro) => ({ ...registro })),
    selecoes: db.prepare(`
      SELECT s.* FROM production_scene_media_selections s
        JOIN production_scenes c ON c.id = s.sceneId
        JOIN production_scripts r ON r.id = c.scriptId
       WHERE r.projectId = ?
       ORDER BY c.ordinal ASC, s.kind ASC
    `).all(projectId).map((registro) => ({ ...registro })),
  };
}

/** Três cenas de 40 s — o mesmo conjunto que `comCenas` grava. */
function tresCenas(prefixo = 'Cena') {
  return [1, 2, 3].map((ordinal) => ({
    ordinal, title: `${prefixo} ${ordinal}`, durationSeconds: 40,
  }));
}

test('S1. sem mídia nenhuma, substituir todas as cenas continua funcionando', () => {
  const db = banco();

  const depois = replaceProductionScenes('proj_a', tresCenas('Reescrita'), db);
  assert.deepEqual(depois.map((c) => c.title), ['Reescrita 1', 'Reescrita 2', 'Reescrita 3']);

  // E continua funcionando depois de a mídia existir e ser APAGADA: a guarda
  // olha o que há agora, não o que já houve.
  const take = createSceneTake('proj_a', 1, { kind: 'image' }, db);
  db.prepare('DELETE FROM production_scene_media WHERE id = ?').run(take.id);
  assert.equal(replaceProductionScenes('proj_a', tresCenas('De novo'), db).length, 3);

  db.close();
});

test('S2. com um take de imagem, substituir todas as cenas é recusado', () => {
  const db = banco();
  createSceneTake('proj_a', 2, { kind: 'image' }, db);

  assert.throws(
    () => replaceProductionScenes('proj_a', tresCenas('Reescrita'), db),
    (erro) => erro instanceof DomainError
      && /já tem mídia associada/.test(erro.message)
      && /Edite as cenas uma a uma/.test(erro.message),
  );

  db.close();
});

test('S3. com um take de vídeo, substituir todas as cenas é recusado igualmente', () => {
  const db = banco();
  createSceneTake('proj_a', 3, { kind: 'video' }, db);

  assert.throws(
    () => replaceProductionScenes('proj_a', tresCenas('Reescrita'), db),
    (erro) => erro instanceof DomainError && /já tem mídia associada/.test(erro.message),
  );

  // Um take sem Asset e sem job já basta: a tentativa existe, e é dela que a
  // pessoa se lembra. Esperar o Asset chegar deixaria uma janela em que a
  // reescrita apagaria uma geração em curso.
  assert.equal(listSceneTakes('proj_a', 3, 'video', db)[0].assetId, null);

  db.close();
});

test('S4-S7. a recusa não deixa estado parcial: cenas, takes e escolhas intactos', () => {
  const db = banco();

  const asset = umAsset(db, 'proj_a');
  const job = umJob(db, 'proj_a');
  createSceneTake('proj_a', 1, {
    kind: 'image', assetId: asset.id, generationJobId: job.jobId,
  }, db);
  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  createSceneTake('proj_a', 1, { kind: 'video' }, db);
  createSceneTake('proj_a', 2, { kind: 'image' }, db);
  selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 2 }, db);
  selectSceneTake('proj_a', 1, { kind: 'video', takeNumber: 1 }, db);

  const antes = retrato(db, 'proj_a');

  assert.throws(
    () => replaceProductionScenes('proj_a', tresCenas('Reescrita'), db),
    (erro) => erro instanceof DomainError,
  );

  // S4 · as cenas originais permanecem idênticas — inclusive o `id`, que é o
  // que a mídia pendura.
  // S5 · a mídia permanece, take a take.
  // S6 · as escolhas permanecem, apontando para os mesmos takes.
  assert.deepEqual(retrato(db, 'proj_a'), antes);

  // S7 · nenhum estado parcial, e nenhuma transação deixada aberta: a guarda
  // recusa ANTES do BEGIN. Se ela tivesse aberto uma, esta escrita falharia.
  const escrita = updateProductionScene('proj_a', 1, { title: 'Ainda editável' }, db);
  assert.equal(escrita.title, 'Ainda editável');

  db.close();
});

test('S7-bis. a recusa vem antes até da validação do que veio', () => {
  const db = banco();
  createSceneTake('proj_a', 1, { kind: 'image' }, db);

  // Um conjunto que também seria recusado por soma de duração: a mensagem que
  // sai é a da mídia, porque a guarda roda primeiro. Recusar por duração
  // ensinaria a quem chama que basta acertar os segundos para a mídia sumir.
  assert.throws(
    () => replaceProductionScenes('proj_a', [
      { ordinal: 1, title: 'Curta', durationSeconds: 5 },
    ], db),
    (erro) => erro instanceof DomainError && /já tem mídia associada/.test(erro.message),
  );

  db.close();
});

test('S7-ter. a recusa é acionável e não vaza id nenhum', () => {
  const db = banco();

  const asset = umAsset(db, 'proj_a');
  const take = createSceneTake('proj_a', 2, { kind: 'image', assetId: asset.id }, db);
  const cena = getProductionScene('proj_a', 2, db);

  const erro = (() => {
    try {
      replaceProductionScenes('proj_a', tresCenas(), db);
      return null;
    } catch (capturado) {
      return capturado;
    }
  })();

  assert.ok(erro instanceof DomainError);

  // O que a mensagem diz: o que aconteceu, qual cena, e o que fazer em vez
  // disso. O `ordinal` é público — é o número que a pessoa fala.
  assert.match(erro.message, /cena 2/);
  assert.match(erro.message, /fluxo explícito de replanejamento/);

  // O que ela NÃO diz: identidade nossa. Nem da cena, nem da mídia, nem do
  // Asset, nem do roteiro.
  const tudo = `${erro.message} ${JSON.stringify(erro.detail)}`;
  for (const interno of [cena.id, cena.scriptId, take.id, take.sceneId, asset.id]) {
    assert.ok(!tudo.includes(interno), `a recusa vazou "${interno}"`);
  }

  db.close();
});

test('S8. editar UMA cena continua funcionando normalmente, mesmo com mídia', () => {
  const db = banco();

  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  createSceneTake('proj_a', 1, { kind: 'image' }, db);
  selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: 2 }, db);
  const takesAntes = listSceneTakes('proj_a', 1, null, db);

  // É este o caminho que o erro de S2 aponta, e ele não é bloqueado: editar uma
  // cena não troca o `id` dela, então nada cascateia.
  const editada = updateProductionScene('proj_a', 1, {
    title: 'Mais dramática', visualDescription: 'Contraluz, poeira no ar.',
  }, db);
  assert.equal(editada.title, 'Mais dramática');
  assert.equal(editada.visualDescription, 'Contraluz, poeira no ar.');

  // A mídia e a escolha atravessaram a edição inteiras.
  assert.deepEqual(listSceneTakes('proj_a', 1, null, db), takesAntes);
  assert.equal(getSceneSelection('proj_a', 1, 'image', db).takeNumber, 2);

  // E outra cena, sem mídia, também continua editável.
  assert.equal(
    updateProductionScene('proj_a', 3, { durationSeconds: 30 }, db).durationSeconds, 30,
  );

  db.close();
});

// ── T · a guarda e o DELETE sob o MESMO lock (PASSO 13-A.2) ─────────────────
//
// A guarda de S lê o banco, e o que ela lê tinha de continuar valendo até o
// DELETE. Enquanto ela rodava FORA da transação havia uma janela real:
//
//   1. a guarda encontra zero takes
//   2. outra conexão grava um take
//   3. o replace abre a transação e apaga as cenas
//   4. o CASCADE leva o take recém-criado
//
// A destruição exata que a guarda existe para impedir — e silenciosa, porque
// ninguém viu o take existir. `BEGIN IMMEDIATE` passou a vir antes da guarda:
// o lock de escrita é tomado na hora, e não no primeiro INSERT, então entre
// "não há mídia" e "as cenas foram apagadas" não cabe mais nada.
//
// Os testes abaixo usam DUAS conexões de verdade ao MESMO arquivo — o
// `node:sqlite` permite, e o `openDatabase` já liga WAL. Não há espera nem
// temporizador: o SQLite recusa a segunda escrita na hora ("database is
// locked"), então a prova é determinística.

/** Um banco em arquivo, com projeto e três cenas — para abrir duas conexões. */
function bancoEmArquivo(nome) {
  const caminho = path.join(RAIZ, nome);
  const db = openDatabase(caminho);
  createProject({ id: 'proj_a', name: 'Produção A' }, db);
  comCenas(db, 'proj_a');
  return { db, caminho };
}

/**
 * Roda `intrusao()` no exato momento em que a guarda de mídia consulta o banco
 * — isto é, depois do BEGIN IMMEDIATE e antes do DELETE. É a única janela que
 * o defeito tinha.
 */
function noMeioDaGuarda(db, intrusao) {
  const prepareOriginal = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepareOriginal(sql);
    if (!sql.includes('FROM production_scene_media')) return stmt;
    return { all: (...args) => { intrusao(); return stmt.all(...args); } };
  };
  return () => { db.prepare = prepareOriginal; };
}

test('T1. nenhuma escrita cabe entre a guarda de mídia e o DELETE das cenas', () => {
  const { db, caminho } = bancoEmArquivo('race-guarda.db');
  const outra = openDatabase(caminho);

  const tentativas = [];
  const restaurar = noMeioDaGuarda(db, () => {
    // A guarda está rodando AGORA. Se ela estivesse fora da transação, esta
    // conexão gravaria um take que o DELETE logo em seguida levaria embora.
    tentativas.push({ emTransacao: db.isTransaction });
    try {
      createSceneTake('proj_a', 1, { kind: 'image' }, outra);
      tentativas.push({ resultado: 'gravou' });
    } catch (erro) {
      tentativas.push({ resultado: 'recusado', codigo: erro.code, mensagem: erro.message });
    }
  });

  const depois = replaceProductionScenes('proj_a', tresCenas('Reescrita'), db);
  restaurar();

  // A guarda rodou dentro da transação de escrita.
  assert.equal(tentativas[0].emTransacao, true, 'a guarda rodou fora da transação');

  // E a outra conexão não conseguiu entrar na janela.
  assert.equal(tentativas[1].resultado, 'recusado');
  assert.match(tentativas[1].mensagem, /locked/i);

  // A substituição aconteceu inteira, e não sobrou mídia órfã de ninguém.
  assert.deepEqual(depois.map((c) => c.title), ['Reescrita 1', 'Reescrita 2', 'Reescrita 3']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_media').get().n, 0);

  // A outra conexão volta a funcionar assim que o lock sai: o que ela sofreu
  // foi um "agora não", e não um dano.
  assert.equal(createSceneTake('proj_a', 1, { kind: 'image' }, outra).takeNumber, 1);

  outra.close();
  db.close();
});

test('T2. o lock vale nos dois sentidos: criar um take barra o replace concorrente', () => {
  const { db, caminho } = bancoEmArquivo('race-inverso.db');
  const outra = openDatabase(caminho);

  // A outra conexão está no meio de uma escrita — é o que `createSceneTake`
  // faz enquanto aloca o próximo número.
  outra.exec('BEGIN IMMEDIATE');
  outra.prepare(`
    INSERT INTO production_scene_media
      (id, sceneId, kind, takeNumber, generationJobId, assetId, createdAt, updatedAt)
    VALUES ('media_em_voo', ?, 'image', 1, NULL, NULL, ?, ?)
  `).run(getProductionScene('proj_a', 1, outra).id, Date.now(), Date.now());

  // O replace nem chega à guarda: ele para no próprio BEGIN IMMEDIATE.
  assert.throws(
    () => replaceProductionScenes('proj_a', tresCenas('Reescrita'), db),
    /locked/i,
  );

  // E não ficou transação pendurada na conexão que falhou.
  assert.equal(db.isTransaction, false);

  outra.exec('COMMIT');

  // Agora que o take existe e está visível, a recusa é a de domínio — a
  // mensagem que a pessoa precisa ler, e não um erro de banco.
  assert.throws(
    () => replaceProductionScenes('proj_a', tresCenas('Reescrita'), db),
    (erro) => erro instanceof DomainError && /já tem mídia associada/.test(erro.message),
  );

  outra.close();
  db.close();
});

test('T3. a transação é uma só, e a ordem dentro dela é guarda → validação → escrita', () => {
  const fonte = readFileSync(
    new URL('../lib/server/domain/production.js', import.meta.url), 'utf8',
  );
  const corpo = fonte.slice(
    fonte.indexOf('export function replaceProductionScenes'),
    fonte.indexOf('/** As cenas do projeto, na ordem da produção. */'),
  );
  assert.ok(corpo.length > 0);

  // Uma transação, e uma só: nada de abrir duas nem de aninhar.
  const conta = (agulha) => corpo.split(agulha).length - 1;
  assert.equal(conta("BEGIN IMMEDIATE"), 1);
  assert.equal(conta("db.exec('COMMIT')"), 1);
  assert.equal(conta("db.exec('ROLLBACK')"), 1);

  // A ordem que importa, e que este teste existe para congelar.
  const posicoes = {
    begin: corpo.indexOf('BEGIN IMMEDIATE'),
    guarda: corpo.indexOf('recusarSeJaTemMidia('),
    duracao: corpo.indexOf('DURATION_TOLERANCE_SECONDS'),
    apagar: corpo.indexOf('DELETE FROM production_scenes'),
    commit: corpo.indexOf("db.exec('COMMIT')"),
  };
  for (const [nome, posicao] of Object.entries(posicoes)) {
    assert.ok(posicao > 0, `não achei ${nome}`);
  }

  assert.ok(posicoes.begin < posicoes.guarda, 'a guarda precisa rodar DENTRO da transação');
  assert.ok(posicoes.guarda < posicoes.duracao,
    'a mídia é conferida antes da duração: a proteção vence a reclamação de segundos');
  assert.ok(posicoes.duracao < posicoes.apagar, 'nada é apagado antes de tudo ser conferido');
  assert.ok(posicoes.apagar < posicoes.commit);
});

test('T4. a prioridade da mensagem sobrevive à mudança de transação', () => {
  const db = banco();
  createSceneTake('proj_a', 1, { kind: 'image' }, db);

  // Duração inválida E mídia presente: quem fala é a proteção.
  assert.throws(
    () => replaceProductionScenes('proj_a', [
      { ordinal: 1, title: 'Curta', durationSeconds: 5 },
    ], db),
    (erro) => erro instanceof DomainError && /já tem mídia associada/.test(erro.message),
  );

  // E a recusa não deixou a transação aberta: se tivesse, este BEGIN falharia.
  db.exec('BEGIN');
  db.exec('ROLLBACK');
  assert.equal(db.isTransaction, false);
  assert.equal(listProductionScenes('proj_a', db).length, 3);

  db.close();
});
