// A trilha da produção — as peças, os takes e as escolhas.
//
// PASSO 14-D2A. Não há música aqui, e é metade do que estes testes trancam. O
// que eles afirmam:
//
//   a música é do PROJETO            e não de uma cena: uma trilha atravessa
//                                    cenas, e substituir o roteiro não a apaga
//   a cue é intenção autoritativa    é dela que a peça vai nascer, e vazia ela
//                                    não pode existir
//   número é do SERVIDOR             de cue e de take; mandá-lo é RECUSADO
//   a impressão é da DESCRIÇÃO       gravada, e imutável depois disso
//   selected ≠ current               editar a cue não apaga, não reescreve e
//                                    não reseleciona nada
//   narração e efeito intactos       música não entrou em tabela alheia, e
//                                    `AUDIO_ROLES` segue `['narration']`
//   nada de música nasceu            nenhum Asset, nenhum job, nenhum provider
//
// E nada de tempo: a cue diz O QUE a peça é, nunca onde nem quando ela soa.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ASSET_KINDS, AUDIO_ROLES, DomainError, ESQUEMA_ATUAL, GENERATION_JOB_KINDS,
  openDatabase, SCENE_MEDIA_KINDS, schemaVersion,
} from '../lib/server/domain/db.js';
import { createProject, deleteProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import { createGenerationJobRecord } from '../lib/server/domain/generationJobs.js';
import {
  listProductionScenes, replaceProductionScenes, saveProductionPlan,
  saveProductionScript,
} from '../lib/server/domain/production.js';
import { createSceneSfxCue } from '../lib/server/domain/sceneSfx.js';
import {
  createProductionMusicCue, createProductionMusicTake,
  declaredProductionMusicFields, deleteProductionMusicCue,
  getProductionMusicCue, getProductionMusicSelection, getProductionMusicTake,
  listProductionMusicCues, listProductionMusicTakes, MAX_CUES_POR_PRODUCAO,
  musicCueFingerprint, musicTakeFreshness, publicProductionMusicCue,
  publicProductionMusicTake, selectProductionMusicTake, updateProductionMusicCue,
} from '../lib/server/domain/music.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';

const EPICA = 'dark cinematic orchestral underscore with slow tension build';
const PIANO = 'quiet melancholic piano with sparse strings';
const ALEGRE = 'bright hopeful strings, warm and open';

function banco() {
  const db = openDatabase(':memory:');
  for (const id of ['proj_a', 'proj_b']) {
    createProject({ id, name: `P ${id}` }, db);
    saveProductionPlan({ projectId: id, title: 'Plano', targetDurationSeconds: 80 }, db);
    saveProductionScript({ projectId: id, title: 'R', fullText: 'Texto.' }, db);
    replaceProductionScenes(id, [1, 2].map((n) => ({
      ordinal: n, title: `Cena ${n}`, durationSeconds: 40, narration: `Narração ${n}.`,
    })), db);
  }
  return db;
}

function colunas(db, tabela) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => String(c.name));
}

const tresCenas = (prefixo) => [1, 2].map((n) => ({
  ordinal: n, title: `${prefixo} ${n}`, durationSeconds: 40, narration: 'n',
}));

// ── A · B · C · D · E · F · as cues ────────────────────────────────────────

test('A · B · C. a primeira cue é 1, a segunda é 2, e o número é do servidor', () => {
  const db = banco();

  const um = createProductionMusicCue('proj_a', { description: EPICA }, db);
  const dois = createProductionMusicCue('proj_a', { description: PIANO }, db);

  assert.equal(um.cueNumber, 1);
  assert.equal(dois.cueNumber, 2);
  assert.equal(um.description, EPICA);

  // A numeração é por PROJETO — e o outro projeto recomeça no 1.
  assert.equal(createProductionMusicCue('proj_b', { description: EPICA }, db).cueNumber, 1);

  assert.throws(
    () => createProductionMusicCue('proj_a', { description: ALEGRE, cueNumber: 7 }, db),
    (erro) => erro instanceof DomainError && /número é do servidor/.test(erro.message),
  );
  assert.equal(listProductionMusicCues('proj_a', db).length, 2, 'a recusa deixou linha');
  db.close();
});

test('D. uma cue sem descrição não existe — no domínio e no banco', () => {
  const db = banco();

  for (const vazia of ['', '   ', null, undefined]) {
    assert.throws(
      () => createProductionMusicCue('proj_a', { description: vazia }, db),
      (erro) => erro instanceof DomainError && /precisa de uma descrição/.test(erro.message),
      `descrição aceita: ${JSON.stringify(vazia)}`,
    );
  }

  assert.throws(() => db.prepare(
    'INSERT INTO production_music_cues (id, projectId, cueNumber, description, createdAt, updatedAt) '
    + "VALUES ('x', 'proj_a', 99, '', 1, 1)",
  ).run(), /CHECK|constraint/i);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_music_cues').get().n, 0);
  db.close();
});

test('E · F. list/get por Project, e editar preserva a identidade da cue', () => {
  const db = banco();

  createProductionMusicCue('proj_a', { description: EPICA }, db);
  const antes = createProductionMusicCue('proj_a', { description: PIANO }, db);

  assert.deepEqual(listProductionMusicCues('proj_a', db).map((c) => c.cueNumber), [1, 2]);
  assert.equal(getProductionMusicCue('proj_a', 2, db).description, PIANO);
  assert.equal(getProductionMusicCue('proj_a', 9, db), null);

  const depois = updateProductionMusicCue('proj_a', 2, { description: ALEGRE }, db);

  assert.equal(depois.id, antes.id);
  assert.equal(depois.cueNumber, antes.cueNumber);
  assert.equal(depois.projectId, antes.projectId);
  assert.equal(depois.description, ALEGRE);
  assert.equal(listProductionMusicCues('proj_a', db).length, 2);
  db.close();
});

// ── G · H · I · J · K · os takes ───────────────────────────────────────────

test('G · H · I · K. take 1, depois 2, com número e impressão do servidor', () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);

  const um = createProductionMusicTake('proj_a', 1, {}, db);
  const dois = createProductionMusicTake('proj_a', 1, {}, db);

  assert.equal(um.takeNumber, 1);
  assert.equal(dois.takeNumber, 2);
  assert.equal(um.generationJobId, null);
  assert.equal(um.assetId, null);

  assert.throws(
    () => createProductionMusicTake('proj_a', 1, { takeNumber: 9 }, db),
    (erro) => erro instanceof DomainError && /número é do servidor/.test(erro.message),
  );
  assert.throws(
    () => createProductionMusicTake('proj_a', 1, { sourceCueFingerprint: 'a'.repeat(64) }, db),
    (erro) => erro instanceof DomainError && /não é escolhido por quem pede/.test(erro.message),
  );
  assert.equal(listProductionMusicTakes('proj_a', 1, db).length, 2);
  db.close();
});

test('J. a impressão vem da descrição PERSISTIDA da cue', () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  const take = createProductionMusicTake('proj_a', 1, {}, db);

  assert.equal(take.sourceCueFingerprint, musicCueFingerprint(EPICA));
  assert.equal(
    take.sourceCueFingerprint,
    musicCueFingerprint(getProductionMusicCue('proj_a', 1, db).description),
  );
  assert.match(take.sourceCueFingerprint, /^[0-9a-f]{64}$/);

  assert.notEqual(musicCueFingerprint(EPICA), musicCueFingerprint(PIANO));
  assert.equal(musicCueFingerprint(EPICA), musicCueFingerprint(EPICA));
  assert.equal(musicCueFingerprint(''), null);
  db.close();
});

// ── L · M · N · a intenção muda, o histórico não ───────────────────────────

test('L · M · N. editar a cue preserva o take, o torna stale, e voltar o revive', () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicTake('proj_a', 1, {}, db);
  assert.equal(getProductionMusicTake('proj_a', 1, 1, db).current, true);

  updateProductionMusicCue('proj_a', 1, { description: ALEGRE }, db);

  const takes = listProductionMusicTakes('proj_a', 1, db);
  assert.equal(takes.length, 1);
  assert.equal(takes[0].sourceCueFingerprint, musicCueFingerprint(EPICA));
  assert.equal(takes[0].current, false);

  const frescor = musicTakeFreshness('proj_a', 1, 1, db);
  assert.equal(frescor.current, false);
  assert.equal(frescor.stale, true);
  assert.equal(frescor.sourceCueFingerprint, musicCueFingerprint(EPICA));
  assert.equal(frescor.cueFingerprint, musicCueFingerprint(ALEGRE));

  updateProductionMusicCue('proj_a', 1, { description: EPICA }, db);
  assert.equal(getProductionMusicTake('proj_a', 1, 1, db).current, true);
  db.close();
});

// ── O · P · Q · R · a seleção ──────────────────────────────────────────────

test('O · P. seleciona o take, e a seleção aponta para TAKE, não para Asset', () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicTake('proj_a', 1, {}, db);
  createProductionMusicTake('proj_a', 1, {}, db);

  const sel = selectProductionMusicTake('proj_a', 1, 2, {}, db);
  assert.equal(sel.takeNumber, 2);

  assert.deepEqual(colunas(db, 'production_music_selections'), ['cueId', 'takeId', 'updatedAt']);
  const linha = db.prepare('SELECT takeId FROM production_music_selections').get();
  const take2 = db.prepare('SELECT id FROM production_music_takes WHERE takeNumber = 2').get();
  assert.equal(linha.takeId, take2.id);

  selectProductionMusicTake('proj_a', 1, 1, {}, db);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).takeNumber, 1);
  assert.deepEqual(listProductionMusicTakes('proj_a', 1, db).map((t) => t.takeNumber), [1, 2]);
  db.close();
});

test('Q. escolher o take de OUTRA cue é impossível — pela porta e pelos fundos', () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicCue('proj_a', { description: PIANO }, db);
  createProductionMusicTake('proj_a', 2, {}, db);

  assert.throws(
    () => selectProductionMusicTake('proj_a', 1, 1, {}, db),
    (erro) => erro instanceof DomainError && /não tem um take 1/.test(erro.message),
  );

  // A cue 1 não tem seleção nenhuma, então a PRIMARY KEY não mascara a FK.
  const cue1 = db.prepare('SELECT id FROM production_music_cues WHERE cueNumber = 1').get();
  const takeDaCue2 = db.prepare('SELECT id FROM production_music_takes').get();
  assert.throws(() => db.prepare(
    'INSERT INTO production_music_selections (cueId, takeId, updatedAt) VALUES (?, ?, 1)',
  ).run(cue1.id, takeDaCue2.id), /FOREIGN KEY/i);
  db.close();
});

test('R. várias peças coexistem, com escolhas independentes', () => {
  const db = banco();
  for (const d of [EPICA, PIANO, ALEGRE]) {
    createProductionMusicCue('proj_a', { description: d }, db);
  }
  for (const n of [1, 2, 3]) {
    createProductionMusicTake('proj_a', n, {}, db);
    createProductionMusicTake('proj_a', n, {}, db);
    selectProductionMusicTake('proj_a', n, n === 2 ? 2 : 1, {}, db);
  }

  assert.deepEqual([1, 2, 3].map((n) => getProductionMusicSelection('proj_a', n, db).takeNumber),
    [1, 2, 1]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_music_selections').get().n, 3);

  // Editar uma peça não mexe nas escolhas das outras.
  updateProductionMusicCue('proj_a', 1, { description: 'outra coisa' }, db);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).current, false);
  assert.equal(getProductionMusicSelection('proj_a', 2, db).current, true);
  assert.equal(getProductionMusicSelection('proj_a', 3, db).current, true);
  db.close();
});

// ── S · cross-project ──────────────────────────────────────────────────────

test('S. um projeto não alcança a trilha de outro', () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicTake('proj_a', 1, {}, db);
  selectProductionMusicTake('proj_a', 1, 1, {}, db);

  assert.deepEqual(listProductionMusicCues('proj_b', db), []);
  assert.equal(getProductionMusicCue('proj_b', 1, db), null);
  assert.equal(getProductionMusicSelection('proj_b', 1, db), null);
  assert.equal(musicTakeFreshness('proj_b', 1, 1, db), null);

  assert.throws(
    () => createProductionMusicTake('proj_b', 1, {}, db),
    (erro) => erro instanceof DomainError
      && /não tem uma peça musical 1/.test(erro.message)
      && !/proj_a/.test(erro.message),
  );
  assert.deepEqual(listProductionMusicCues('proj_inexistente', db), []);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).takeNumber, 1);
  db.close();
});

// ── T · U · V · W · apagar ─────────────────────────────────────────────────

test('T. apagar um take leva a seleção, e NÃO leva Asset nem job', () => {
  const db = banco();
  const asset = createAsset({ projectId: 'proj_a', kind: 'audio', filename: 'm.flac' }, db);
  createGenerationJobRecord({
    jobId: 'job_m', projectId: 'proj_a', kind: 'audio', workflowId: 'w', state: 'preparing',
  }, db);

  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicTake('proj_a', 1, {}, db);
  createProductionMusicTake('proj_a', 1, {}, db);
  selectProductionMusicTake('proj_a', 1, 2, {}, db);

  const take2 = db.prepare('SELECT id FROM production_music_takes WHERE takeNumber = 2').get();
  db.prepare('DELETE FROM production_music_takes WHERE id = ?').run(take2.id);

  assert.equal(getProductionMusicSelection('proj_a', 1, db), null, 'ponteiro para o nada');
  assert.deepEqual(listProductionMusicTakes('proj_a', 1, db).map((t) => t.takeNumber), [1]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.equal(db.prepare('SELECT kind FROM assets WHERE id = ?').get(asset.id).kind, 'audio');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 1);
  db.close();
});

test('U. apagar a cue leva os takes e as seleções dela, e só as dela', () => {
  const db = banco();
  const asset = createAsset({ projectId: 'proj_a', kind: 'audio', filename: 'n.flac' }, db);
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicCue('proj_a', { description: PIANO }, db);
  for (const n of [1, 2]) {
    createProductionMusicTake('proj_a', n, {}, db);
    selectProductionMusicTake('proj_a', n, 1, {}, db);
  }

  deleteProductionMusicCue('proj_a', 1, db);

  assert.deepEqual(listProductionMusicCues('proj_a', db).map((c) => c.cueNumber), [2]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_music_takes').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_music_selections').get().n, 1);
  assert.equal(getProductionMusicSelection('proj_a', 2, db).takeNumber, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets WHERE id = ?').get(asset.id).n, 1);
  db.close();
});

test('W. apagar a cue é RECUSADO enquanto há geração em voo', () => {
  const db = banco();
  createGenerationJobRecord({
    jobId: 'job_voo', projectId: 'proj_a', kind: 'audio', workflowId: 'w', state: 'preparing',
  }, db);
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicTake('proj_a', 1, {}, db);
  db.prepare('UPDATE production_music_takes SET generationJobId = ?').run('job_voo');

  assert.throws(
    () => deleteProductionMusicCue('proj_a', 1, db),
    (erro) => erro instanceof DomainError && /geração em andamento/.test(erro.message),
  );
  assert.equal(listProductionMusicCues('proj_a', db).length, 1, 'apagou mesmo assim');
  // O job não foi tocado: nenhum cancelamento foi inventado.
  assert.equal(db.prepare("SELECT state FROM generation_jobs WHERE jobId='job_voo'").get().state,
    'preparing');

  db.prepare("UPDATE generation_jobs SET state='orphaned', finishedAt=1 WHERE jobId=?").run('job_voo');
  assert.equal(deleteProductionMusicCue('proj_a', 1, db), true);
  db.close();
});

test('V. apagar o projeto limpa a trilha inteira, e só a dele', () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicCue('proj_b', { description: PIANO }, db);
  for (const p of ['proj_a', 'proj_b']) {
    createProductionMusicTake(p, 1, {}, db);
    selectProductionMusicTake(p, 1, 1, {}, db);
  }

  deleteProject('proj_a', db);

  assert.deepEqual(listProductionMusicCues('proj_a', db), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_music_cues').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_music_takes').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_music_selections').get().n, 1);
  assert.equal(listProductionMusicCues('proj_b', db).length, 1);
  db.close();
});

// ── X · a diferença deliberada frente ao SFX ───────────────────────────────

test('X. a música NÃO bloqueia replaceProductionScenes — e sobrevive a ele', () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicTake('proj_a', 1, {}, db);
  selectProductionMusicTake('proj_a', 1, 1, {}, db);

  // É a diferença que dá razão ao ownership: a trilha é do PROJETO, e não
  // desaparece quando as cenas são substituídas — então também não tem por que
  // impedir a substituição.
  const depois = replaceProductionScenes('proj_a', tresCenas('Reescrita'), db);
  assert.deepEqual(depois.map((c) => c.title), ['Reescrita 1', 'Reescrita 2']);

  // E a trilha continua inteira, com a escolha de pé.
  assert.equal(listProductionMusicCues('proj_a', db).length, 1);
  assert.equal(listProductionMusicTakes('proj_a', 1, db).length, 1);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).takeNumber, 1);

  // O contraste: uma cue de EFEITO continua bloqueando, porque é da cena.
  createSceneSfxCue('proj_a', 1, { description: 'porta batendo' }, db);
  assert.throws(
    () => replaceProductionScenes('proj_a', tresCenas('Outra'), db),
    (erro) => erro instanceof DomainError && /já tem mídia associada/.test(erro.message),
  );
  db.close();
});

// ── a migração ─────────────────────────────────────────────────────────────

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-music-'));
test.after(async () => { await rm(RAIZ, { recursive: true, force: true }); });

test('migração 13 → 14 preserva tudo, e chega ao mesmo esquema de um banco novo', () => {
  const caminho = path.join(RAIZ, 'migracao.db');

  const primeira = openDatabase(caminho);
  createProject({ id: 'antigo', name: 'Existia antes' }, primeira);
  saveProductionPlan({ projectId: 'antigo', title: 'Plano', targetDurationSeconds: 40 }, primeira);
  saveProductionScript({ projectId: 'antigo', title: 'R', fullText: 'Texto.' }, primeira);
  replaceProductionScenes('antigo', [{
    ordinal: 1, title: 'Cena', durationSeconds: 40, narration: 'Narração.',
  }], primeira);
  createSceneSfxCue('antigo', 1, { description: 'trovão' }, primeira);
  const asset = createAsset({ projectId: 'antigo', kind: 'audio', filename: 'v.flac' }, primeira);

  primeira.exec('DROP TABLE production_music_selections');
  primeira.exec('DROP TABLE production_music_takes');
  primeira.exec('DROP TABLE production_music_cues');
  primeira.exec('PRAGMA user_version = 13');
  primeira.close();

  const migrado = openDatabase(caminho);
  assert.equal(schemaVersion(migrado), 14);
  assert.equal(ESQUEMA_ATUAL, 14);

  // O que existia continua lá — inclusive o SFX do 14-D1A.
  assert.equal(listProductionScenes('antigo', migrado).length, 1);
  assert.equal(migrado.prepare('SELECT COUNT(*) AS n FROM production_scene_sfx_cues').get().n, 1);
  assert.equal(migrado.prepare('SELECT kind FROM assets WHERE id = ?').get(asset.id).kind, 'audio');
  assert.deepEqual(migrado.prepare('PRAGMA foreign_key_check').all(), []);

  // E o esquema de música é o mesmo de um banco novo.
  const fresco = openDatabase(path.join(RAIZ, 'fresco.db'));
  const forma = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all()
    .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`);
  const fks = (db, t) => db.prepare(`PRAGMA foreign_key_list(${t})`).all()
    .map((f) => `${f.from}→${f.table}.${f.to}:${f.on_delete}`).sort();
  const idx = (db, t) => db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
  ).all(t).map((i) => String(i.sql).replace(/\s+/g, ' ')).sort();

  for (const t of ['production_music_cues', 'production_music_takes',
    'production_music_selections']) {
    assert.deepEqual(forma(migrado, t), forma(fresco, t), `colunas de ${t}`);
    assert.deepEqual(fks(migrado, t), fks(fresco, t), `chaves de ${t}`);
    assert.deepEqual(idx(migrado, t), idx(fresco, t), `índices de ${t}`);
  }
  assert.deepEqual(fresco.prepare('PRAGMA foreign_key_check').all(), []);

  migrado.close();
  fresco.close();
});

// ── Y · Z · ausências ──────────────────────────────────────────────────────

test('Y. o domínio não cria Asset, job, nem qualquer música', () => {
  const db = banco();

  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicCue('proj_a', { description: PIANO }, db);
  createProductionMusicTake('proj_a', 1, {}, db);
  createProductionMusicTake('proj_a', 2, {}, db);
  updateProductionMusicCue('proj_a', 1, { description: ALEGRE }, db);
  selectProductionMusicTake('proj_a', 1, 1, {}, db);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);
  for (const take of listProductionMusicTakes('proj_a', 1, db)) {
    assert.equal(take.generationJobId, null);
    assert.equal(take.assetId, null);
  }
  db.close();
});

test('Z. nenhum vínculo com Scene, Timeline, ou receita musical', () => {
  const db = banco();

  const proibidas = ['sceneId', 'sceneOrdinal', 'startScene', 'endScene', 'sequenceId',
    'timelineId', 'trackId', 'startSeconds', 'endSeconds', 'offset', 'offsetSeconds',
    'loop', 'fadeIn', 'fadeOut', 'gain', 'pan', 'ducking', 'duration', 'durationSeconds',
    'bpm', 'key', 'scale', 'genre', 'lyrics', 'instrumentation', 'stem', 'status',
    'current', 'stale'];
  for (const t of ['production_music_cues', 'production_music_takes',
    'production_music_selections']) {
    for (const campo of proibidas) {
      assert.equal(colunas(db, t).includes(campo), false, `${t} ganhou ${campo}`);
    }
  }

  // A música pende do PROJETO — é essa a chave estrangeira, e não uma cena.
  const fks = db.prepare('PRAGMA foreign_key_list(production_music_cues)').all();
  assert.deepEqual(fks.map((f) => `${f.from}→${f.table}`), ['projectId→projects']);

  // E a projeção pública não vaza id nenhum.
  const campos = declaredProductionMusicFields();
  assert.equal(campos.cue.includes('id') || campos.cue.includes('projectId'), false);
  assert.equal(campos.take.includes('id') || campos.take.includes('cueId'), false);
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicTake('proj_a', 1, {}, db);
  assert.deepEqual(
    Object.keys(publicProductionMusicCue(getProductionMusicCue('proj_a', 1, db))).sort(),
    [...campos.cue].sort(),
  );
  assert.deepEqual(
    Object.keys(publicProductionMusicTake(getProductionMusicTake('proj_a', 1, 1, db))).sort(),
    [...campos.take].sort(),
  );
  db.close();
});

test('ausência. narração e efeito continuam onde estavam', () => {
  const db = banco();

  // Música não virou papel de áudio nem entrou na tabela de efeito.
  assert.deepEqual([...AUDIO_ROLES], ['narration']);
  assert.deepEqual([...SCENE_MEDIA_KINDS], ['image', 'video']);
  assert.deepEqual([...ASSET_KINDS], ['image', 'video', 'audio']);
  assert.deepEqual([...GENERATION_JOB_KINDS], ['image', 'video', 'audio']);

  assert.deepEqual(colunas(db, 'production_scene_audio_takes'), [
    'id', 'sceneId', 'role', 'takeNumber', 'sourceNarrationFingerprint',
    'generationJobId', 'assetId', 'createdAt', 'updatedAt',
  ]);
  assert.deepEqual(colunas(db, 'production_scene_sfx_cues'), [
    'id', 'sceneId', 'cueNumber', 'description', 'createdAt', 'updatedAt',
  ]);
  assert.deepEqual(colunas(db, 'production_scene_media'), [
    'id', 'sceneId', 'kind', 'takeNumber', 'generationJobId', 'assetId',
    'createdAt', 'updatedAt',
  ]);

  // O SFX continua pendendo da CENA; a música, do PROJETO.
  assert.deepEqual(
    db.prepare('PRAGMA foreign_key_list(production_scene_sfx_cues)').all()
      .map((f) => `${f.from}→${f.table}`),
    ['sceneId→production_scenes'],
  );
  db.close();
});

test('ausência. nenhuma Agent Tool de música, e nenhum provider', () => {
  const publicadas = publicToolList(toolRegistry()).map((t) => t.name);
  for (const nome of publicadas) {
    assert.equal(
      /music|musica|trilha|score|soundtrack|ace.?step|timeline/i.test(nome)
      && !nome.startsWith('project.'),
      false,
      `ferramenta criada cedo demais: ${nome}`,
    );
  }
});

test('ausência. o teto de peças existe e é recusado com mensagem acionável', () => {
  const db = banco();
  for (let n = 1; n <= MAX_CUES_POR_PRODUCAO; n += 1) {
    createProductionMusicCue('proj_a', { description: `peça ${n}` }, db);
  }
  assert.throws(
    () => createProductionMusicCue('proj_a', { description: 'mais uma' }, db),
    (erro) => erro instanceof DomainError && /o limite é 40/.test(erro.message),
  );
  db.close();
});
