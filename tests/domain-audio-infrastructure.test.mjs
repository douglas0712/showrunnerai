// A infraestrutura de áudio — o tipo físico `audio`, e a migração que o abriu.
//
// PASSO 14-C1. Nada aqui gera som. O que este passo fez foi UMA palavra, em
// duas colunas: `assets.kind` e `generation_jobs.kind` passaram a aceitar
// `audio`. E, para consegui-lo, precisou de uma mudança no runner de migrações.
//
// ── Por que o runner precisou mudar ─────────────────────────────────────────
//
// O SQLite não sabe alterar um CHECK: trocar o vocabulário de uma coluna exige
// reconstruir a tabela. E `DROP TABLE` de uma tabela REFERENCIADA, com a
// checagem de chave estrangeira ligada, executa as ações `ON DELETE` dos
// filhos — `production_scene_media.assetId` vira NULL, `agent_message_assets`
// perde linha, a linhagem de `assets` se desfaz.
//
// Isso não dá erro. A migração termina, as linhas do pai estão todas lá, e cada
// vínculo que apontava para elas virou nulo. E `PRAGMA foreign_key_check` passa
// LIMPO depois, porque nulo satisfaz uma chave estrangeira — a rede de
// segurança óbvia não pega nada.
//
// Desligar a checagem é a única defesa, e ela só funciona FORA de uma
// transação: dentro de uma, `PRAGMA foreign_keys` é silenciosamente ignorado.
// Daí o opt-in `requiresForeignKeysOff` e a ordem que o runner passou a seguir.
//
// Estes testes trancam as duas metades: que o runner desliga e RELIGA a
// checagem, e que a migração 12 não perdeu um único vínculo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ASSET_KINDS, AUDIO_ROLES, DomainError, ESQUEMA_ATUAL, GENERATION_JOB_KINDS,
  migracoesOficiais, openDatabase, SCENE_MEDIA_KINDS, schemaVersion,
} from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import { createGenerationJobRecord } from '../lib/server/domain/generationJobs.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import {
  replaceProductionScenes, saveProductionPlan, saveProductionScript,
} from '../lib/server/domain/production.js';
import {
  createSceneTake, selectSceneTake,
} from '../lib/server/domain/sceneMedia.js';
import {
  createNarrationAudioTake, selectNarrationAudioTake,
} from '../lib/server/domain/sceneAudio.js';
import { listWorkflows } from '../lib/server/generation/workflows/registry.js';
import { validarMidia } from '../lib/server/comfy/provider.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-audio-infra-'));
test.after(async () => { await rm(RAIZ, { recursive: true, force: true }); });

let contador = 0;
function caminhoNovo(rotulo) {
  contador += 1;
  return path.join(RAIZ, `${rotulo}_${contador}.db`);
}

/**
 * O cenário realista: tudo o que pende de `assets` e de `generation_jobs`.
 *
 * É deliberadamente o pior caso — cada uma das oito chaves estrangeiras de
 * entrada mapeadas na investigação tem pelo menos uma linha, para que um
 * `DROP TABLE` descuidado tenha o que destruir.
 */
function cenarioCompleto(db) {
  createProject({ id: 'proj_a', name: 'Produção A' }, db);
  saveProductionPlan({ projectId: 'proj_a', title: 'Plano', targetDurationSeconds: 80 }, db);
  saveProductionScript({ projectId: 'proj_a', title: 'Roteiro', fullText: 'Texto.' }, db);
  replaceProductionScenes('proj_a', [1, 2].map((n) => ({
    ordinal: n,
    title: `Cena ${n}`,
    durationSeconds: 40,
    narration: `Narração da cena ${n}.`,
  })), db);

  // Asset A (imagem) → Asset B (vídeo), com linhagem REAL.
  const imagem = createAsset({
    projectId: 'proj_a', kind: 'image', filename: 'a.png', prompt: 'uma plataforma',
    seed: 42, modelId: 'sdxl', status: 'aprovado',
  }, db);
  const video = createAsset({
    projectId: 'proj_a', kind: 'video', filename: 'a.mp4', derivedFromAssetId: imagem.id,
    durationSeconds: 6, modelId: 'wan',
  }, db);

  // Uma conversa, para o job ter âncora e para `agent_message_assets` existir.
  const thread = createThreadRecord({ projectId: 'proj_a', title: 'Conversa' }, db);

  // Um job concluído (com Asset) e um job aberto — os dois lados dos CHECKs.
  const jobFeito = createGenerationJobRecord({
    jobId: 'job_feito', projectId: 'proj_a', kind: 'image', workflowId: 'txt2img',
    state: 'preparing', threadId: thread.id,
  }, db);
  db.prepare(
    'UPDATE generation_jobs SET state = ?, assetId = ?, finishedAt = ?, updatedAt = ? '
    + 'WHERE jobId = ?',
  ).run('done', imagem.id, 1000, 1000, jobFeito.jobId);

  createGenerationJobRecord({
    jobId: 'job_aberto', projectId: 'proj_a', kind: 'video', workflowId: 'img2vid',
    state: 'running', threadId: thread.id, derivedFromAssetId: imagem.id,
    providerJobId: 'comfy-777',
  }, db);

  // Mídia visual: take de imagem e take de vídeo, ambos com Asset e job.
  const takeImagem = createSceneTake(
    'proj_a', 1, { kind: 'image', assetId: imagem.id, generationJobId: 'job_feito' }, db,
  );
  const takeVideo = createSceneTake(
    'proj_a', 1, { kind: 'video', assetId: video.id, generationJobId: 'job_aberto' }, db,
  );
  selectSceneTake('proj_a', 1, { kind: 'image', takeNumber: takeImagem.takeNumber }, db);
  selectSceneTake('proj_a', 1, { kind: 'video', takeNumber: takeVideo.takeNumber }, db);

  // Voz do 14-B, com seleção. O `assetId` é preenchido por SQL: o domínio não
  // tem primitiva de attach, e o que importa aqui é o VÍNCULO existir.
  createNarrationAudioTake('proj_a', 1, {}, db);
  createNarrationAudioTake('proj_a', 2, {}, db);
  selectNarrationAudioTake('proj_a', 1, { takeNumber: 1 }, db);
  // Só o take da CENA 1: `generationJobId` é único entre takes de voz, e as duas
  // cenas têm um take 1 cada.
  db.prepare(`
    UPDATE production_scene_audio_takes SET assetId = ?, generationJobId = ?
     WHERE sceneId = (SELECT id FROM production_scenes WHERE ordinal = 1 LIMIT 1)
       AND takeNumber = 1
  `).run(imagem.id, 'job_aberto');

  return { imagem, video, thread };
}

/** Tudo o que precisa sobreviver, num objeto comparável. */
function retrato(db) {
  const todas = (sql) => db.prepare(sql).all().map((l) => ({ ...l }));
  return {
    assets: todas('SELECT id, kind, derivedFromAssetId, prompt, seed, modelId, status,'
      + ' filename, durationSeconds, createdAt FROM assets ORDER BY id'),
    jobs: todas('SELECT jobId, kind, state, workflowId, providerJobId, assetId,'
      + ' derivedFromAssetId, threadId, error, createdAt, finishedAt FROM generation_jobs'
      + ' ORDER BY jobId'),
    midia: todas('SELECT id, sceneId, kind, takeNumber, assetId, generationJobId'
      + ' FROM production_scene_media ORDER BY id'),
    midiaSel: todas('SELECT sceneId, kind, mediaId FROM production_scene_media_selections'
      + ' ORDER BY sceneId, kind'),
    voz: todas('SELECT id, sceneId, role, takeNumber, sourceNarrationFingerprint,'
      + ' assetId, generationJobId FROM production_scene_audio_takes ORDER BY id'),
    vozSel: todas('SELECT sceneId, role, takeId FROM production_scene_audio_selections'
      + ' ORDER BY sceneId, role'),
    mensagemAssets: todas('SELECT * FROM agent_message_assets'),
  };
}

/** Um banco no esquema 11: rebobina a 11 derrubando o que a 12 reconstruiu. */
function bancoNoEsquema11(caminho) {
  const db = openDatabase(caminho);
  cenarioCompleto(db);
  const antes = retrato(db);
  db.close();

  // Volta ao 11 à força, devolvendo às duas tabelas o CHECK que elas tinham.
  // Reconstruir com a checagem ligada destruiria os vínculos — é o defeito que
  // este arquivo inteiro existe para provar —, então a rebobinada usa o mesmo
  // procedimento seguro da migração: FK OFF, fora de transação.
  const rebobina = openDatabase(caminho);
  rebobina.exec('PRAGMA foreign_keys = OFF');
  rebobina.exec(`
    BEGIN;
    -- PASSO 14-D1A: o desenho de som nasceu depois do 11 e sai junto, para
    -- que a reexecução das migrações não esbarre numa tabela já existente.
    DROP TABLE production_scene_sfx_selections;
    DROP TABLE production_scene_sfx_takes;
    DROP TABLE production_scene_sfx_cues;
    CREATE TABLE assets_11 (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
      jobId TEXT, filename TEXT, url TEXT, mimeType TEXT, bytes INTEGER,
      width INTEGER, height INTEGER, durationSeconds REAL, prompt TEXT,
      seed INTEGER, modelId TEXT,
      derivedFromAssetId TEXT REFERENCES assets(id) ON DELETE SET NULL,
      status TEXT NOT NULL CHECK (status IN ('pendente', 'aprovado', 'revisão')),
      createdAt INTEGER NOT NULL,
      CHECK (derivedFromAssetId IS NULL OR derivedFromAssetId <> id)
    ) STRICT;
    INSERT INTO assets_11 SELECT id, projectId, kind, jobId, filename, url, mimeType,
      bytes, width, height, durationSeconds, prompt, seed, modelId, derivedFromAssetId,
      status, createdAt FROM assets;
    DROP TABLE assets;
    ALTER TABLE assets_11 RENAME TO assets;
    CREATE UNIQUE INDEX assets_arquivo ON assets (projectId, filename) WHERE filename IS NOT NULL;
    CREATE INDEX assets_por_job ON assets (jobId);
    CREATE INDEX assets_por_origem ON assets (derivedFromAssetId);
    CREATE UNIQUE INDEX assets_idempotencia ON assets (projectId, jobId) WHERE jobId IS NOT NULL;

    CREATE TABLE jobs_11 (
      jobId TEXT PRIMARY KEY,
      projectId TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      threadId TEXT REFERENCES agent_threads(id) ON DELETE SET NULL,
      userMessageId TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
      assistantMessageId TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
      workflowId TEXT NOT NULL, providerJobId TEXT,
      state TEXT NOT NULL CHECK (state IN ('preparing', 'submitted', 'queued', 'running',
        'finalizing', 'done', 'failed', 'cancelled', 'orphaned')),
      assetId TEXT REFERENCES assets(id),
      derivedFromAssetId TEXT REFERENCES assets(id) ON DELETE SET NULL,
      error TEXT, createdAt INTEGER NOT NULL, submittedAt INTEGER,
      finishedAt INTEGER, updatedAt INTEGER NOT NULL,
      CHECK ((state = 'done') = (assetId IS NOT NULL)),
      CHECK ((state IN ('done', 'failed', 'cancelled', 'orphaned')) = (finishedAt IS NOT NULL)),
      CHECK (error IS NULL OR state IN ('failed', 'orphaned'))
    ) STRICT;
    INSERT INTO jobs_11 SELECT jobId, projectId, threadId, userMessageId,
      assistantMessageId, kind, workflowId, providerJobId, state, assetId,
      derivedFromAssetId, error, createdAt, submittedAt, finishedAt, updatedAt
      FROM generation_jobs;
    DROP TABLE generation_jobs;
    ALTER TABLE jobs_11 RENAME TO generation_jobs;
    CREATE UNIQUE INDEX generation_jobs_provider ON generation_jobs (providerJobId)
      WHERE providerJobId IS NOT NULL;
    CREATE INDEX generation_jobs_abertos ON generation_jobs (state, createdAt);
    CREATE INDEX generation_jobs_por_thread ON generation_jobs (threadId, createdAt);

    PRAGMA user_version = 11;
    COMMIT;
  `);
  rebobina.exec('PRAGMA foreign_keys = ON');
  rebobina.close();

  return antes;
}

/** A forma semântica de uma tabela: colunas, tipos, NOT NULL, default, PK. */
function forma(db, tabela) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => ({
    name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value, pk: c.pk,
  }));
}

function fks(db, tabela) {
  return db.prepare(`PRAGMA foreign_key_list(${tabela})`).all()
    .map((f) => `${f.from}→${f.table}.${f.to} del=${f.on_delete} upd=${f.on_update}`)
    .sort();
}

function indices(db, tabela) {
  return db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
  ).all(tabela).map((i) => String(i.sql).replace(/\s+/g, ' ').trim()).sort();
}

/** Os valores que um CHECK de `kind` realmente aceita, medidos por INSERT. */
function kindsAceitos(db, tabela, inserir) {
  const aceitos = [];
  for (const kind of ['image', 'video', 'audio', 'texto', 'narration', '']) {
    db.exec('SAVEPOINT sonda');
    try {
      inserir(db, kind);
      aceitos.push(kind);
    } catch { /* recusado pelo CHECK — é o que queremos medir */ }
    db.exec('ROLLBACK TO sonda');
    db.exec('RELEASE sonda');
  }
  return aceitos;
}

// ── A · B · C · D · E · F · o runner ───────────────────────────────────────

test('A · C. o lote com migração que exige FK OFF religa a checagem no fim', () => {
  const db = openDatabase(caminhoNovo('runner_ok'));

  // A migração 12 é opt-in e roda com a checagem desligada. Quando o banco
  // volta para quem o abriu, ela precisa estar LIGADA de novo — uma conexão
  // devolvida sem checagem aceitaria, em silêncio, os órfãos que o esquema
  // existe para impedir.
  assert.equal(schemaVersion(db), ESQUEMA_ATUAL);
  assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);

  // E a checagem religada é de verdade: um vínculo órfão é recusado.
  assert.throws(() => db.prepare(`
    INSERT INTO assets (id, projectId, kind, status, createdAt)
    VALUES ('a_orfa', 'projeto_que_nao_existe', 'audio', 'pendente', 1)
  `).run(), /FOREIGN KEY/i);

  db.close();
});

test('B. o rebuild não disparou SET NULL nem CASCADE em nenhum filho', () => {
  const caminho = caminhoNovo('rebuild');
  const antes = bancoNoEsquema11(caminho);

  const db = openDatabase(caminho);
  assert.equal(schemaVersion(db), ESQUEMA_ATUAL);
  const depois = retrato(db);

  // É este assert que o defeito original teria quebrado: com a checagem ligada,
  // o DROP TABLE de `assets` teria anulado todo `assetId` e todo
  // `derivedFromAssetId`, e apagado as linhas de `agent_message_assets`.
  assert.deepEqual(depois, antes);

  db.close();
});

test('A2. uma migração comum NÃO desliga a checagem', () => {
  // O opt-in é por migração, e não do runner: só quem reconstrói tabela
  // referenciada paga o custo. Um banco que já está na versão corrente não tem
  // migração pendente nenhuma, e portanto nunca desliga nada.
  const caminho = caminhoNovo('sem_pendentes');
  openDatabase(caminho).close();

  const db = openDatabase(caminho);
  assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);

  // E, com o banco já migrado, a checagem valeu o tempo todo.
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  db.close();
});

test('E · F · G · D. o lote que deixa um órfão é RECUSADO antes do COMMIT', () => {
  const caminho = caminhoNovo('orfa');
  const antes = bancoNoEsquema11(caminho);

  // Uma migração 13 que grava um vínculo para um projeto que não existe. Com a
  // checagem desligada — e ela FICA desligada, porque a 12 está no mesmo lote —
  // o INSERT passa. Quem tem de pegá-lo é o `foreign_key_check` antes do
  // COMMIT, que é o que substitui a rede que o opt-in desligou.
  const comDefeito = [...migracoesOficiais(), {
    requiresForeignKeysOff: true,
    up(db) {
      db.prepare(`
        INSERT INTO assets (id, projectId, kind, status, createdAt)
        VALUES ('a_orfa', 'projeto_fantasma', 'audio', 'pendente', 1)
      `).run();
    },
  }];

  // E. a violação impede o COMMIT.
  assert.throws(
    () => openDatabase(caminho, comDefeito),
    (erro) => erro instanceof DomainError
      && /apontando para o nada/.test(erro.message)
      && /Nada foi gravado/.test(erro.message),
  );

  const db = openDatabase(caminho);

  // F. a versão não avançou: o lote inteiro voltou atrás, e não meia migração.
  assert.equal(schemaVersion(db), ESQUEMA_ATUAL);

  // G. e os dados continuam exatamente como estavam — inclusive sem a órfã.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets WHERE id = 'a_orfa'").get().n, 0);
  assert.deepEqual(retrato(db), antes);

  // D. a checagem voltou a ligar mesmo com o lote tendo falhado. É o `finally`
  // do runner: uma conexão devolvida sem checagem é pior do que a falha que a
  // desligou.
  assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
  assert.throws(() => db.prepare(`
    INSERT INTO assets (id, projectId, kind, status, createdAt)
    VALUES ('a_orfa2', 'projeto_fantasma', 'audio', 'pendente', 1)
  `).run(), /FOREIGN KEY/i);

  db.close();
});

test('D2. a migração que EXPLODE também religa a checagem, sem gravar nada', () => {
  const caminho = caminhoNovo('explode');
  const antes = bancoNoEsquema11(caminho);

  const comDefeito = [...migracoesOficiais(), {
    requiresForeignKeysOff: true,
    up() { throw new Error('migração defeituosa'); },
  }];

  assert.throws(() => openDatabase(caminho, comDefeito), /migração defeituosa/);

  const db = openDatabase(caminho);
  assert.equal(schemaVersion(db), ESQUEMA_ATUAL);
  assert.deepEqual(retrato(db), antes);
  assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
  db.close();
});

// ── G · H · o esquema chega a 12 pelos dois caminhos ───────────────────────

test('G · H. fresh chega a 12, e 11 → 12 também', () => {
  const fresco = openDatabase(caminhoNovo('fresco'));
  assert.equal(schemaVersion(fresco), ESQUEMA_ATUAL);
  assert.ok(ESQUEMA_ATUAL >= 12, 'a migração 12 precisa continuar existindo');
  fresco.close();

  const caminho = caminhoNovo('migrado');
  bancoNoEsquema11(caminho);
  const migrado = openDatabase(caminho);
  assert.equal(schemaVersion(migrado), ESQUEMA_ATUAL);
  migrado.close();
});

// ── I · J · K · L · M · N · O · P · os vocabulários ────────────────────────

test('I · J. Asset aceita image/video/audio, e recusa o resto', () => {
  const db = openDatabase(caminhoNovo('kinds_asset'));
  createProject({ id: 'p', name: 'P' }, db);

  assert.deepEqual([...ASSET_KINDS], ['image', 'video', 'audio']);

  for (const kind of ['image', 'video', 'audio']) {
    assert.equal(createAsset({ projectId: 'p', kind, filename: `f.${kind}` }, db).kind, kind);
  }
  for (const invalido of ['texto', 'narration', 'AUDIO', '', null, undefined]) {
    assert.throws(
      () => createAsset({ projectId: 'p', kind: invalido }, db),
      (erro) => erro instanceof DomainError,
      `kind inválido aceito: ${String(invalido)}`,
    );
  }

  db.close();
});

test('K · L. GenerationJob aceita image/video/audio, e recusa o resto', () => {
  const db = openDatabase(caminhoNovo('kinds_job'));
  createProject({ id: 'p', name: 'P' }, db);

  assert.deepEqual([...GENERATION_JOB_KINDS], ['image', 'video', 'audio']);

  for (const kind of ['image', 'video', 'audio']) {
    const job = createGenerationJobRecord({
      jobId: `j_${kind}`, projectId: 'p', kind, workflowId: 'w', state: 'preparing',
    }, db);
    assert.equal(job.kind, kind);
  }
  for (const invalido of ['texto', 'speech', 'VIDEO', '', null]) {
    assert.throws(() => createGenerationJobRecord({
      jobId: 'j_ruim', projectId: 'p', kind: invalido, workflowId: 'w', state: 'preparing',
    }, db), /Tipo de geração desconhecido/);
  }

  db.close();
});

test('M · N · O. a pipeline visual recusa audio — no domínio e no banco', () => {
  const caminho = caminhoNovo('visual');
  const db = openDatabase(caminho);
  cenarioCompleto(db);

  assert.deepEqual([...SCENE_MEDIA_KINDS], ['image', 'video']);

  // M. o que ela aceita continua sendo o que aceitava.
  for (const kind of ['image', 'video']) {
    assert.equal(createSceneTake('proj_a', 2, { kind }, db).kind, kind);
  }

  // N. e `audio` é recusado pelo domínio…
  assert.throws(
    () => createSceneTake('proj_a', 2, { kind: 'audio' }, db),
    (erro) => erro instanceof DomainError && /Tipo de mídia inválido/.test(erro.message),
  );

  // …e pelo banco, mesmo com SQL escrito na mão.
  const cena = db.prepare(
    'SELECT id FROM production_scenes WHERE ordinal = 1 LIMIT 1',
  ).get();
  assert.throws(() => db.prepare(`
    INSERT INTO production_scene_media
      (id, sceneId, kind, takeNumber, generationJobId, assetId, createdAt, updatedAt)
    VALUES ('m_audio', ?, 'audio', 99, NULL, NULL, 1, 1)
  `).run(cena.id), /CHECK|constraint/i);

  // O. a seleção visual também.
  assert.throws(() => db.prepare(`
    INSERT INTO production_scene_media_selections (sceneId, kind, mediaId, updatedAt)
    VALUES (?, 'audio', 'm_audio', 1)
  `).run(cena.id), /CHECK|constraint/i);

  db.close();
});

test('P. AUDIO_ROLES continua sendo só narration', () => {
  const db = openDatabase(caminhoNovo('roles'));
  cenarioCompleto(db);

  assert.deepEqual([...AUDIO_ROLES], ['narration']);

  const cena = db.prepare('SELECT id FROM production_scenes WHERE ordinal = 1 LIMIT 1').get();
  for (const papel of ['music', 'sfx', 'dialogue', 'voiceover', 'ambient', 'foley']) {
    assert.throws(() => db.prepare(`
      INSERT INTO production_scene_audio_takes
        (id, sceneId, role, takeNumber, sourceNarrationFingerprint, createdAt, updatedAt)
      VALUES ('t_${papel}', ?, '${papel}', 99, ?, 1, 1)
    `).run(cena.id, 'a'.repeat(64)), /CHECK|constraint/i, `papel aceito cedo demais: ${papel}`);
  }

  db.close();
});

// ── Q · R · S · T · U · V · W · a preservação, campo a campo ───────────────

test('Q · U · V. o retrato inteiro sobrevive à migração 12', () => {
  const caminho = caminhoNovo('retrato');
  const antes = bancoNoEsquema11(caminho);

  const db = openDatabase(caminho);
  const depois = retrato(db);

  assert.deepEqual(depois.assets, antes.assets);
  assert.deepEqual(depois.jobs, antes.jobs);
  assert.deepEqual(depois.midia, antes.midia);
  assert.deepEqual(depois.midiaSel, antes.midiaSel, 'U. seleções visuais');
  assert.deepEqual(depois.voz, antes.voz);
  assert.deepEqual(depois.vozSel, antes.vozSel, 'V. seleção de voz');
  assert.deepEqual(depois.mensagemAssets, antes.mensagemAssets);

  // E os counts, ditos separadamente: uma cópia parcial que casasse por acaso
  // no ORDER BY ainda cairia aqui.
  for (const tabela of ['assets', 'generation_jobs', 'production_scene_media',
    'production_scene_media_selections', 'production_scene_audio_takes',
    'production_scene_audio_selections']) {
    assert.ok(
      Number(db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n) > 0,
      `o cenário precisa ter linha em ${tabela} para o teste valer`,
    );
  }

  db.close();
});

test('R · S · T. o defeito que causou a parada: nenhum vínculo virou NULL', () => {
  const caminho = caminhoNovo('vinculos');
  const antes = bancoNoEsquema11(caminho);

  const db = openDatabase(caminho);

  // R. a linhagem imagem → vídeo.
  const video = db.prepare("SELECT id, derivedFromAssetId FROM assets WHERE kind = 'video'").get();
  const imagem = db.prepare("SELECT id FROM assets WHERE kind = 'image'").get();
  assert.equal(video.derivedFromAssetId, imagem.id);
  assert.notEqual(video.derivedFromAssetId, null);

  // S. o `assetId` do take visual.
  for (const take of db.prepare('SELECT kind, assetId, generationJobId FROM production_scene_media').all()) {
    assert.notEqual(take.assetId, null, `SceneMedia ${take.kind} perdeu o Asset`);
    assert.notEqual(take.generationJobId, null, `SceneMedia ${take.kind} perdeu o job`);
  }

  // T. o `assetId` do take de voz do 14-B.
  const voz = db.prepare('SELECT assetId, generationJobId FROM production_scene_audio_takes WHERE takeNumber = 1').get();
  assert.equal(voz.assetId, imagem.id);
  assert.equal(voz.generationJobId, 'job_aberto');

  // E o job concluído continua apontando para o resultado dele.
  assert.equal(
    db.prepare("SELECT assetId FROM generation_jobs WHERE jobId = 'job_feito'").get().assetId,
    imagem.id,
  );

  // Nenhuma coluna de vínculo virou nula em lugar nenhum.
  assert.deepEqual(retrato(db), antes);

  db.close();
});

test('W. foreign_key_check limpo, com a checagem já religada', () => {
  const caminho = caminhoNovo('fkcheck');
  bancoNoEsquema11(caminho);

  const db = openDatabase(caminho);
  assert.equal(Number(db.prepare('PRAGMA foreign_keys').get().foreign_keys), 1);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);

  // O mesmo vale para um banco criado do zero.
  const fresco = openDatabase(caminhoNovo('fkcheck_fresco'));
  assert.deepEqual(fresco.prepare('PRAGMA foreign_key_check').all(), []);

  db.close();
  fresco.close();
});

// ── X · fresh e migrated são o mesmo esquema ───────────────────────────────

test('X. fresh 12 e 11 → 12 são semanticamente equivalentes', () => {
  const fresco = openDatabase(caminhoNovo('eq_fresco'));

  const caminho = caminhoNovo('eq_migrado');
  bancoNoEsquema11(caminho);
  const migrado = openDatabase(caminho);

  assert.equal(schemaVersion(fresco), schemaVersion(migrado));

  const tabelas = [
    'assets', 'generation_jobs', 'production_scene_media',
    'production_scene_media_selections', 'production_scene_audio_takes',
    'production_scene_audio_selections',
  ];

  for (const tabela of tabelas) {
    assert.deepEqual(forma(migrado, tabela), forma(fresco, tabela), `colunas de ${tabela}`);
    assert.deepEqual(fks(migrado, tabela), fks(fresco, tabela), `chaves de ${tabela}`);
    assert.deepEqual(indices(migrado, tabela), indices(fresco, tabela), `índices de ${tabela}`);
  }

  // E a parte que texto de esquema não prova: o que cada CHECK realmente
  // ACEITA, medido por INSERT nos dois bancos.
  for (const db of [fresco, migrado]) {
    createProject({ id: 'sonda', name: 'S' }, db);
    db.prepare(`
      INSERT INTO production_scripts (id, projectId, title, summary, fullText, status, createdAt, updatedAt)
      VALUES ('s_sonda', 'sonda', 'R', '', 'Texto do roteiro.', 'rascunho', 1, 1)
    `).run();
    db.prepare(`
      INSERT INTO production_scenes (id, scriptId, ordinal, title, purpose, durationSeconds,
        narration, visualDescription, status, createdAt, updatedAt)
      VALUES ('c_sonda', 's_sonda', 1, 'C', '', 10, 'n', '', 'rascunho', 1, 1)
    `).run();
  }

  const sondaAsset = (db, kind) => db.prepare(
    'INSERT INTO assets (id, projectId, kind, status, createdAt) VALUES (?, ?, ?, ?, ?)',
  ).run(`a_${kind}`, 'sonda', kind, 'pendente', 1);

  const sondaJob = (db, kind) => db.prepare(
    'INSERT INTO generation_jobs (jobId, projectId, kind, workflowId, state, createdAt, updatedAt)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(`j_${kind}`, 'sonda', kind, 'w', 'preparing', 1, 1);

  const sondaMidia = (db, kind) => db.prepare(
    'INSERT INTO production_scene_media (id, sceneId, kind, takeNumber, createdAt, updatedAt)'
    + ' VALUES (?, ?, ?, ?, ?, ?)',
  ).run(`m_${kind}`, 'c_sonda', kind, 1, 1, 1);

  for (const [rotulo, sonda, esperado] of [
    ['assets', sondaAsset, ['image', 'video', 'audio']],
    ['generation_jobs', sondaJob, ['image', 'video', 'audio']],
    ['production_scene_media', sondaMidia, ['image', 'video']],
  ]) {
    const noFresco = kindsAceitos(fresco, rotulo, sonda);
    const noMigrado = kindsAceitos(migrado, rotulo, sonda);
    assert.deepEqual(noFresco, esperado, `fresh: ${rotulo}`);
    assert.deepEqual(noMigrado, esperado, `migrado: ${rotulo}`);
    assert.deepEqual(noMigrado, noFresco, `mesma versão, CHECK diferente em ${rotulo}`);
  }

  fresco.close();
  migrado.close();
});

// ── Y · Z · ausências ──────────────────────────────────────────────────────

test('Y. `audio` tem executor próprio, e nunca cai no de imagem/vídeo', async () => {
  // Este teste afirmava que NÃO havia executor de áudio, e previa a própria
  // queda: o PASSO 14-D1B trouxe o Stable Audio Open, com descriptor próprio.
  // O que ele tranca agora é a metade que continua valendo — que o áudio tem
  // caminho SEPARADO, e não um desvio dentro do de imagem ou vídeo.
  const porKind = {};
  for (const w of listWorkflows()) porKind[w.kind] = (porKind[w.kind] || 0) + 1;
  assert.equal(porKind.audio, 1, 'exatamente um executor de áudio');
  assert.ok(porKind.image >= 1 && porKind.video >= 1);

  // O executor resolve o tipo pelo DESCRIPTOR, e não pela linha do job: o
  // workflow de áudio declara `audio`, e nenhum de imagem/vídeo o declara.
  const deAudio = listWorkflows().filter((w) => w.kind === 'audio');
  assert.equal(deAudio[0].id, 'stable_audio_sfx');
  assert.equal(listWorkflows().some((w) => w.kind === 'audio' && /image|video/.test(w.id)), false);

  // E a validação de mídia de áudio é a de ÁUDIO — não a de imagem nem a de
  // vídeo. Um arquivo que não existe falha por não abrir, e não por cair no
  // ramo errado.
  const resultado = await validarMidia('audio', '/caminho/que/nao/existe');
  assert.equal(resultado.ok, false);
  assert.match(resultado.motivo, /ffprobe falhou/);

  // Um tipo que a aplicação não conhece continua falhando FECHADO.
  const desconhecido = await validarMidia('texto', '/caminho/que/nao/existe');
  assert.equal(desconhecido.ok, false);
  assert.match(desconhecido.motivo, /sem validação/);
});

test('Z. nenhuma ferramenta, provider ou geração de áudio nasceu', () => {
  const publicadas = publicToolList(toolRegistry()).map((t) => t.name);
  for (const nome of publicadas) {
    assert.equal(
      /audio|voice|voz|tts|speech|narration|narracao|music|sfx|dialogue/i.test(nome),
      false,
      `ferramenta de áudio criada cedo demais: ${nome}`,
    );
  }

  // E o esquema aceitar `audio` não fez nascer job nem Asset de áudio.
  const db = openDatabase(caminhoNovo('sem_geracao'));
  cenarioCompleto(db);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM assets WHERE kind = 'audio'").get().n, 0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE kind = 'audio'").get().n, 0,
  );

  // Nenhuma coluna de voz entrou em lugar nenhum.
  for (const tabela of ['assets', 'generation_jobs', 'production_scene_audio_takes']) {
    const nomes = db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => String(c.name));
    for (const proibida of ['voiceId', 'speaker', 'sampleRate', 'channels', 'codec',
      'lufs', 'durationMs', 'inputDigest']) {
      assert.equal(nomes.includes(proibida), false, `${tabela} ganhou ${proibida}`);
    }
  }

  db.close();
});
