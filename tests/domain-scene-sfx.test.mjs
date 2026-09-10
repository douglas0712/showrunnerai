// O desenho de som de uma cena — as cues, os takes e as escolhas.
//
// PASSO 14-D1A. Não há som aqui, e é metade do que estes testes trancam. O que
// eles afirmam:
//
//   uma cena tem N EFEITOS               e não um único `role='sfx'`: o trovão,
//                                        a porta e os passos coexistem, cada um
//                                        com a sua escolha
//   a cue é texto autoritativo           é dela que o som vai nascer, e vazia
//                                        ela não pode existir
//   número é do SERVIDOR                 de cue e de take; mandá-lo é RECUSADO
//   a impressão é da DESCRIÇÃO gravada   e é imutável depois disso
//   selected ≠ current                   editar a cue não apaga, não reescreve
//                                        e não reseleciona nada
//   a narração continua intacta          `AUDIO_ROLES` segue `['narration']`,
//                                        e a tabela da voz não ganhou efeito
//   nada de som nasceu                   nenhum Asset, nenhum job, nenhuma
//                                        ferramenta, nenhum provider
//
// E nada de tempo: uma cue diz O QUE deve existir, nunca QUANDO toca.

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
import {
  createSceneSfxCue, createSceneSfxTake, declaredSceneSfxFields,
  deleteSceneSfxCue, getSceneSfxCue, getSceneSfxSelection, getSceneSfxTake,
  listSceneSfxCues, listSceneSfxTakes, MAX_CUES_POR_CENA,
  publicSceneSfxCue, publicSceneSfxTake, selectSceneSfxTake, sfxCueFingerprint,
  sfxTakeFreshness, updateSceneSfxCue,
} from '../lib/server/domain/sceneSfx.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';

const PORTA = 'porta metálica fechando com impacto';
const PASSOS = 'passos rápidos sobre pedra';
const TROVAO = 'um trovão forte explode ao longe';

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

// ── A · B · C · D · E · F · as cues ────────────────────────────────────────

test('A · B · C. a primeira cue é 1, a segunda é 2, e o número é do servidor', () => {
  const db = banco();

  const um = createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const dois = createSceneSfxCue('proj_a', 1, { description: PASSOS }, db);

  assert.equal(um.cueNumber, 1);
  assert.equal(dois.cueNumber, 2);
  assert.equal(um.description, PORTA);

  // A numeração é por CENA: a cena 2 recomeça no 1.
  assert.equal(createSceneSfxCue('proj_a', 2, { description: TROVAO }, db).cueNumber, 1);

  // C. mandar o número é recusado, não ignorado.
  assert.throws(
    () => createSceneSfxCue('proj_a', 1, { description: TROVAO, cueNumber: 7 }, db),
    (erro) => erro instanceof DomainError && /número é do servidor/.test(erro.message),
  );
  assert.equal(listSceneSfxCues('proj_a', 1, db).length, 2, 'a recusa deixou linha');
  db.close();
});

test('D. uma cue sem descrição não existe — no domínio e no banco', () => {
  const db = banco();

  for (const vazia of ['', '   ', null, undefined]) {
    assert.throws(
      () => createSceneSfxCue('proj_a', 1, { description: vazia }, db),
      (erro) => erro instanceof DomainError && /precisa de uma descrição/.test(erro.message),
      `descrição aceita: ${JSON.stringify(vazia)}`,
    );
  }

  // E o CHECK recusa mesmo com SQL escrito na mão.
  const cena = db.prepare(
    'SELECT c.id FROM production_scenes c JOIN production_scripts s ON s.id = c.scriptId '
    + 'WHERE s.projectId = ? AND c.ordinal = 1',
  ).get('proj_a');
  assert.throws(() => db.prepare(
    'INSERT INTO production_scene_sfx_cues (id, sceneId, cueNumber, description, createdAt, updatedAt) '
    + "VALUES ('x', ?, 99, '', 1, 1)",
  ).run(cena.id), /CHECK|constraint/i);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_sfx_cues').get().n, 0);
  db.close();
});

test('E · F. list/get por projeto + ordinal, e editar preserva a identidade da cue', () => {
  const db = banco();

  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const antes = createSceneSfxCue('proj_a', 1, { description: PASSOS }, db);

  assert.deepEqual(listSceneSfxCues('proj_a', 1, db).map((c) => c.cueNumber), [1, 2]);
  assert.equal(getSceneSfxCue('proj_a', 1, 2, db).description, PASSOS);
  assert.equal(getSceneSfxCue('proj_a', 1, 9, db), null);

  const depois = updateSceneSfxCue('proj_a', 1, 2, { description: TROVAO }, db);

  // F. mesma cue: mesmo id, mesma posição, mesma cena. Só o texto mudou.
  assert.equal(depois.id, antes.id);
  assert.equal(depois.cueNumber, antes.cueNumber);
  assert.equal(depois.sceneId, antes.sceneId);
  assert.equal(depois.description, TROVAO);
  assert.equal(listSceneSfxCues('proj_a', 1, db).length, 2);
  db.close();
});

// ── G · H · I · J · K · os takes ───────────────────────────────────────────

test('G · H · I · K. take 1, depois 2, com número e impressão do servidor', () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);

  const um = createSceneSfxTake('proj_a', 1, 1, {}, db);
  const dois = createSceneSfxTake('proj_a', 1, 1, {}, db);

  assert.equal(um.takeNumber, 1);
  assert.equal(dois.takeNumber, 2);
  assert.equal(um.generationJobId, null);
  assert.equal(um.assetId, null);

  // I · K. número e impressão vindos de fora são RECUSADOS.
  assert.throws(
    () => createSceneSfxTake('proj_a', 1, 1, { takeNumber: 9 }, db),
    (erro) => erro instanceof DomainError && /número é do servidor/.test(erro.message),
  );
  assert.throws(
    () => createSceneSfxTake('proj_a', 1, 1, { sourceCueFingerprint: 'a'.repeat(64) }, db),
    (erro) => erro instanceof DomainError && /não é escolhido por quem pede/.test(erro.message),
  );
  assert.equal(listSceneSfxTakes('proj_a', 1, 1, db).length, 2);
  db.close();
});

test('J. a impressão vem da descrição PERSISTIDA da cue', () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const take = createSceneSfxTake('proj_a', 1, 1, {}, db);

  assert.equal(take.sourceCueFingerprint, sfxCueFingerprint(PORTA));
  assert.equal(
    take.sourceCueFingerprint,
    sfxCueFingerprint(getSceneSfxCue('proj_a', 1, 1, db).description),
  );
  assert.match(take.sourceCueFingerprint, /^[0-9a-f]{64}$/);

  // A impressão é só do texto: nada de provider, modelo, seed ou take.
  assert.notEqual(sfxCueFingerprint(PORTA), sfxCueFingerprint(PASSOS));
  assert.equal(sfxCueFingerprint(PORTA), sfxCueFingerprint(PORTA));
  assert.equal(sfxCueFingerprint(''), null);
  db.close();
});

// ── L · M · N · a descrição muda, o histórico não ──────────────────────────

test('L · M · N. editar a cue preserva o take, o torna stale, e voltar o revive', () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxTake('proj_a', 1, 1, {}, db);
  assert.equal(getSceneSfxTake('proj_a', 1, 1, 1, db).current, true);

  updateSceneSfxCue('proj_a', 1, 1, { description: TROVAO }, db);

  // L. o take continua, e a impressão dele continua sendo a do texto de origem.
  const takes = listSceneSfxTakes('proj_a', 1, 1, db);
  assert.equal(takes.length, 1);
  assert.equal(takes[0].sourceCueFingerprint, sfxCueFingerprint(PORTA));

  // M. e ele passou a ser de uma versão anterior da descrição.
  assert.equal(takes[0].current, false);

  const frescor = sfxTakeFreshness('proj_a', 1, 1, 1, db);
  assert.equal(frescor.current, false);
  assert.equal(frescor.stale, true);
  assert.equal(frescor.sourceCueFingerprint, sfxCueFingerprint(PORTA));
  assert.equal(frescor.cueFingerprint, sfxCueFingerprint(TROVAO));

  // N. desfazer a edição não é caso especial: a impressão é função do texto.
  updateSceneSfxCue('proj_a', 1, 1, { description: PORTA }, db);
  assert.equal(getSceneSfxTake('proj_a', 1, 1, 1, db).current, true);
  db.close();
});

// ── O · P · Q · R · S · a seleção ──────────────────────────────────────────

test('O · P. seleciona o take, e a seleção aponta para TAKE, não para Asset', () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxTake('proj_a', 1, 1, {}, db);
  createSceneSfxTake('proj_a', 1, 1, {}, db);

  const sel = selectSceneSfxTake('proj_a', 1, 1, 2, {}, db);
  assert.equal(sel.takeNumber, 2);

  // P. a linha guarda takeId — e não há coluna de Asset nenhuma.
  assert.deepEqual(colunas(db, 'production_scene_sfx_selections'),
    ['cueId', 'takeId', 'updatedAt']);
  const linha = db.prepare('SELECT takeId FROM production_scene_sfx_selections').get();
  const take2 = db.prepare(
    'SELECT id FROM production_scene_sfx_takes WHERE takeNumber = 2',
  ).get();
  assert.equal(linha.takeId, take2.id);

  // Trocar a escolha não apaga o take anterior.
  selectSceneSfxTake('proj_a', 1, 1, 1, {}, db);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).takeNumber, 1);
  assert.deepEqual(listSceneSfxTakes('proj_a', 1, 1, db).map((t) => t.takeNumber), [1, 2]);
  db.close();
});

test('Q. escolher o take de OUTRA cue é impossível — pela porta e pelos fundos', () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxCue('proj_a', 1, { description: PASSOS }, db);
  createSceneSfxTake('proj_a', 1, 2, {}, db);

  // Pela porta da frente não há como nomeá-lo: a cue 1 não tem take 1.
  assert.throws(
    () => selectSceneSfxTake('proj_a', 1, 1, 1, {}, db),
    (erro) => erro instanceof DomainError && /não tem um take 1/.test(erro.message),
  );

  // Pelos fundos, a chave estrangeira composta recusa. A cue 1 não tem seleção
  // nenhuma, então não há PRIMARY KEY para mascarar o que está sendo provado.
  const cue1 = db.prepare('SELECT id FROM production_scene_sfx_cues WHERE cueNumber = 1').get();
  const takeDaCue2 = db.prepare('SELECT id FROM production_scene_sfx_takes').get();
  assert.throws(() => db.prepare(
    'INSERT INTO production_scene_sfx_selections (cueId, takeId, updatedAt) VALUES (?, ?, 1)',
  ).run(cue1.id, takeDaCue2.id), /FOREIGN KEY/i);
  db.close();
});

test('§27 · R · S. três efeitos coexistem, com três escolhas independentes', () => {
  const db = banco();

  // É este teste que prova que não recriamos o erro de "um `role=sfx` por cena".
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxCue('proj_a', 1, { description: PASSOS }, db);
  createSceneSfxCue('proj_a', 1, { description: TROVAO }, db);

  for (const n of [1, 2, 3]) {
    createSceneSfxTake('proj_a', 1, n, {}, db);
    createSceneSfxTake('proj_a', 1, n, {}, db);
    selectSceneSfxTake('proj_a', 1, n, n === 2 ? 2 : 1, {}, db);
  }

  assert.deepEqual(listSceneSfxCues('proj_a', 1, db).map((c) => c.description),
    [PORTA, PASSOS, TROVAO]);

  // Três escolhas, ao mesmo tempo, e cada uma a sua.
  assert.deepEqual([1, 2, 3].map((n) => getSceneSfxSelection('proj_a', 1, n, db).takeNumber),
    [1, 2, 1]);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_sfx_selections').get().n, 3,
  );

  // E são independentes: editar uma cue não mexe nas escolhas das outras.
  updateSceneSfxCue('proj_a', 1, 1, { description: 'outra porta' }, db);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).current, false);
  assert.equal(getSceneSfxSelection('proj_a', 1, 2, db).current, true);
  assert.equal(getSceneSfxSelection('proj_a', 1, 3, db).current, true);
  db.close();
});

// ── T · cross-project ──────────────────────────────────────────────────────

test('T. um projeto não alcança o desenho de som de outro', () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxTake('proj_a', 1, 1, {}, db);
  selectSceneSfxTake('proj_a', 1, 1, 1, {}, db);

  assert.deepEqual(listSceneSfxCues('proj_b', 1, db), []);
  assert.equal(getSceneSfxCue('proj_b', 1, 1, db), null);
  assert.equal(getSceneSfxSelection('proj_b', 1, 1, db), null);
  assert.equal(sfxTakeFreshness('proj_b', 1, 1, 1, db), null);

  // A recusa não conta que aquilo existe em outro lugar.
  assert.throws(
    () => createSceneSfxTake('proj_b', 1, 1, {}, db),
    (erro) => erro instanceof DomainError
      && /A cena 1 não tem um efeito 1\./.test(erro.message)
      && !/proj_a/.test(erro.message)
      && !/outro projeto/.test(erro.message),
  );
  assert.deepEqual(listSceneSfxCues('proj_inexistente', 1, db), []);

  // E o projeto A continua intacto.
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).takeNumber, 1);
  db.close();
});

// ── U · V · W · apagar ─────────────────────────────────────────────────────

test('U. apagar um take leva a seleção, e NÃO leva Asset nem job', () => {
  const db = banco();
  const asset = createAsset({ projectId: 'proj_a', kind: 'audio', filename: 'x.wav' }, db);
  createGenerationJobRecord({
    jobId: 'job_x', projectId: 'proj_a', kind: 'audio', workflowId: 'w', state: 'preparing',
  }, db);

  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxTake('proj_a', 1, 1, {}, db);
  createSceneSfxTake('proj_a', 1, 1, {}, db);
  selectSceneSfxTake('proj_a', 1, 1, 2, {}, db);

  const take2 = db.prepare(
    'SELECT id FROM production_scene_sfx_takes WHERE takeNumber = 2',
  ).get();
  db.prepare('DELETE FROM production_scene_sfx_takes WHERE id = ?').run(take2.id);

  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db), null, 'ponteiro para o nada');
  assert.deepEqual(listSceneSfxTakes('proj_a', 1, 1, db).map((t) => t.takeNumber), [1]);

  // Infraestrutura compartilhada não é faxinada por causa de um take.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.equal(db.prepare('SELECT kind FROM assets WHERE id = ?').get(asset.id).kind, 'audio');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 1);
  db.close();
});

test('V. apagar a cue leva os takes e as seleções dela, e só as dela', () => {
  const db = banco();
  const asset = createAsset({ projectId: 'proj_a', kind: 'audio', filename: 'y.wav' }, db);

  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxCue('proj_a', 1, { description: PASSOS }, db);
  for (const n of [1, 2]) {
    createSceneSfxTake('proj_a', 1, n, {}, db);
    selectSceneSfxTake('proj_a', 1, n, 1, {}, db);
  }

  deleteSceneSfxCue('proj_a', 1, 1, db);

  assert.deepEqual(listSceneSfxCues('proj_a', 1, db).map((c) => c.cueNumber), [2]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_sfx_takes').get().n, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_sfx_selections').get().n, 1,
  );
  // A cue 2 continua com a escolha dela.
  assert.equal(getSceneSfxSelection('proj_a', 1, 2, db).takeNumber, 1);
  // E nenhum Asset foi junto.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets WHERE id = ?').get(asset.id).n, 1);
  db.close();
});

test('V2. apagar a cue é RECUSADO enquanto há geração em voo', () => {
  const db = banco();
  createGenerationJobRecord({
    jobId: 'job_voo', projectId: 'proj_a', kind: 'audio', workflowId: 'w', state: 'running',
  }, db);
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxTake('proj_a', 1, 1, {}, db);
  db.prepare('UPDATE production_scene_sfx_takes SET generationJobId = ?').run('job_voo');

  assert.throws(
    () => deleteSceneSfxCue('proj_a', 1, 1, db),
    (erro) => erro instanceof DomainError && /geração em andamento/.test(erro.message),
  );
  assert.equal(listSceneSfxCues('proj_a', 1, db).length, 1, 'apagou mesmo assim');

  // Terminado o trabalho, apagar volta a ser possível.
  db.prepare("UPDATE generation_jobs SET state = 'orphaned', finishedAt = 1 WHERE jobId = ?")
    .run('job_voo');
  assert.equal(deleteSceneSfxCue('proj_a', 1, 1, db), true);
  assert.deepEqual(listSceneSfxCues('proj_a', 1, db), []);
  db.close();
});

test('W. apagar a cena — e o projeto — limpa cues, takes e seleções', () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxCue('proj_a', 2, { description: PASSOS }, db);
  for (const o of [1, 2]) {
    createSceneSfxTake('proj_a', o, 1, {}, db);
    selectSceneSfxTake('proj_a', o, 1, 1, {}, db);
  }

  // Uma cena de cada vez.
  const cena1 = db.prepare(
    'SELECT c.id FROM production_scenes c JOIN production_scripts s ON s.id = c.scriptId '
    + 'WHERE s.projectId = ? AND c.ordinal = 1',
  ).get('proj_a');
  db.prepare('DELETE FROM production_scenes WHERE id = ?').run(cena1.id);
  assert.deepEqual(listSceneSfxCues('proj_a', 1, db), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_sfx_cues').get().n, 1);

  // E o projeto inteiro.
  deleteProject('proj_a', db);
  for (const t of ['production_scene_sfx_cues', 'production_scene_sfx_takes',
    'production_scene_sfx_selections']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 0, t);
  }
  assert.equal(listProductionScenes('proj_b', db).length, 2, 'o outro projeto foi junto');
  db.close();
});

// ── X · Y · replace_scenes ─────────────────────────────────────────────────

test('X. replaceProductionScenes é recusado com uma cue, MESMO SEM take', () => {
  const db = banco();
  createSceneSfxCue('proj_a', 2, { description: TROVAO }, db);

  // Nem mídia visual, nem voz, nem take de efeito: só a decisão escrita.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_media').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_audio_takes').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_sfx_takes').get().n, 0);

  assert.throws(
    () => replaceProductionScenes('proj_a', [1, 2].map((n) => ({
      ordinal: n, title: `X${n}`, durationSeconds: 40, narration: 'n',
    })), db),
    (erro) => erro instanceof DomainError
      && /já tem mídia associada/.test(erro.message)
      && /cena 2/.test(erro.message),
  );
  db.close();
});

test('Y. a recusa não deixa estado parcial', () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxCue('proj_a', 1, { description: PASSOS }, db);
  createSceneSfxTake('proj_a', 1, 1, {}, db);
  selectSceneSfxTake('proj_a', 1, 1, 1, {}, db);

  const antes = {
    cenas: listProductionScenes('proj_a', db),
    cues: db.prepare('SELECT id, sceneId, cueNumber, description FROM production_scene_sfx_cues ORDER BY id').all().map((l) => ({ ...l })),
    takes: db.prepare('SELECT id, cueId, takeNumber, sourceCueFingerprint FROM production_scene_sfx_takes ORDER BY id').all().map((l) => ({ ...l })),
    sel: db.prepare('SELECT cueId, takeId FROM production_scene_sfx_selections ORDER BY cueId').all().map((l) => ({ ...l })),
  };

  assert.throws(() => replaceProductionScenes('proj_a', [1, 2].map((n) => ({
    ordinal: n, title: `X${n}`, durationSeconds: 40, narration: 'n',
  })), db), DomainError);

  assert.deepEqual(listProductionScenes('proj_a', db), antes.cenas);
  assert.deepEqual(
    db.prepare('SELECT id, sceneId, cueNumber, description FROM production_scene_sfx_cues ORDER BY id').all().map((l) => ({ ...l })),
    antes.cues,
  );
  assert.deepEqual(
    db.prepare('SELECT id, cueId, takeNumber, sourceCueFingerprint FROM production_scene_sfx_takes ORDER BY id').all().map((l) => ({ ...l })),
    antes.takes,
  );
  assert.deepEqual(
    db.prepare('SELECT cueId, takeId FROM production_scene_sfx_selections ORDER BY cueId').all().map((l) => ({ ...l })),
    antes.sel,
  );

  // E sem cue nenhuma, substituir continua funcionando.
  const db2 = banco();
  assert.equal(replaceProductionScenes('proj_a', [1, 2].map((n) => ({
    ordinal: n, title: `X${n}`, durationSeconds: 40, narration: 'n',
  })), db2).length, 2);
  db.close();
  db2.close();
});

// ── a migração ─────────────────────────────────────────────────────────────

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-sfx-'));
test.after(async () => { await rm(RAIZ, { recursive: true, force: true }); });

test('migração 12 → 13 preserva tudo, e chega ao mesmo esquema de um banco novo', () => {
  const caminho = path.join(RAIZ, 'migracao.db');

  const primeira = openDatabase(caminho);
  createProject({ id: 'antigo', name: 'Existia antes' }, primeira);
  saveProductionPlan({ projectId: 'antigo', title: 'Plano', targetDurationSeconds: 40 }, primeira);
  saveProductionScript({ projectId: 'antigo', title: 'R', fullText: 'Texto.' }, primeira);
  replaceProductionScenes('antigo', [{
    ordinal: 1, title: 'Cena', durationSeconds: 40, narration: 'Narração.',
  }], primeira);
  const asset = createAsset({ projectId: 'antigo', kind: 'audio', filename: 'v.wav' }, primeira);

  // Volta ao 12 derrubando só o que a 13 criou.
  primeira.exec('DROP TABLE production_scene_sfx_selections');
  primeira.exec('DROP TABLE production_scene_sfx_takes');
  primeira.exec('DROP TABLE production_scene_sfx_cues');
  primeira.exec('PRAGMA user_version = 12');
  primeira.close();

  const migrado = openDatabase(caminho);
  assert.equal(schemaVersion(migrado), 13);
  assert.equal(ESQUEMA_ATUAL, 13);

  // O que existia continua lá.
  assert.equal(listProductionScenes('antigo', migrado).length, 1);
  assert.equal(migrado.prepare('SELECT kind FROM assets WHERE id = ?').get(asset.id).kind, 'audio');
  assert.deepEqual(migrado.prepare('PRAGMA foreign_key_check').all(), []);

  // E o esquema SFX é o mesmo de um banco novo — colunas, chaves e índices.
  const fresco = openDatabase(path.join(RAIZ, 'fresco.db'));
  const forma = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all()
    .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.dflt_value}:${c.pk}`);
  const fks = (db, t) => db.prepare(`PRAGMA foreign_key_list(${t})`).all()
    .map((f) => `${f.from}→${f.table}.${f.to}:${f.on_delete}`).sort();
  const idx = (db, t) => db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL",
  ).all(t).map((i) => String(i.sql).replace(/\s+/g, ' ')).sort();

  for (const t of ['production_scene_sfx_cues', 'production_scene_sfx_takes',
    'production_scene_sfx_selections']) {
    assert.deepEqual(forma(migrado, t), forma(fresco, t), `colunas de ${t}`);
    assert.deepEqual(fks(migrado, t), fks(fresco, t), `chaves de ${t}`);
    assert.deepEqual(idx(migrado, t), idx(fresco, t), `índices de ${t}`);
  }

  // E o CHECK vale nos dois: descrição vazia é recusada em qualquer um deles.
  for (const db of [migrado, fresco]) {
    assert.throws(() => db.prepare(
      'INSERT INTO production_scene_sfx_cues (id, sceneId, cueNumber, description, createdAt, updatedAt) '
      + "VALUES ('x', 'y', 1, '', 1, 1)",
    ).run(), /CHECK|FOREIGN KEY|constraint/i);
  }

  migrado.close();
  fresco.close();
});

// ── Z · ausências ──────────────────────────────────────────────────────────

test('Z. o domínio não cria Asset, job, nem qualquer som', () => {
  const db = banco();

  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxCue('proj_a', 1, { description: PASSOS }, db);
  createSceneSfxTake('proj_a', 1, 1, {}, db);
  createSceneSfxTake('proj_a', 1, 2, {}, db);
  updateSceneSfxCue('proj_a', 1, 1, { description: TROVAO }, db);
  selectSceneSfxTake('proj_a', 1, 1, 1, {}, db);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);

  // Os dois campos que um dia apontam para eles continuam nulos.
  for (const take of listSceneSfxTakes('proj_a', 1, 1, db)) {
    assert.equal(take.generationJobId, null);
    assert.equal(take.assetId, null);
  }
  db.close();
});

test('ausência. a narração e a pipeline visual continuam intactas', () => {
  const db = banco();

  // O SFX não virou papel de áudio.
  assert.deepEqual([...AUDIO_ROLES], ['narration']);
  assert.deepEqual([...SCENE_MEDIA_KINDS], ['image', 'video']);
  assert.deepEqual([...ASSET_KINDS], ['image', 'video', 'audio']);
  assert.deepEqual([...GENERATION_JOB_KINDS], ['image', 'video', 'audio']);

  // A tabela da voz continua sendo da voz — e recusa `sfx`.
  const cena = db.prepare(
    'SELECT c.id FROM production_scenes c JOIN production_scripts s ON s.id = c.scriptId '
    + 'WHERE s.projectId = ? AND c.ordinal = 1',
  ).get('proj_a');
  assert.throws(() => db.prepare(
    'INSERT INTO production_scene_audio_takes (id, sceneId, role, takeNumber, '
    + "sourceCueFingerprint, createdAt, updatedAt) VALUES ('x', ?, 'sfx', 1, ?, 1, 1)",
  ).run(cena.id, 'a'.repeat(64)), /no column|CHECK|constraint/i);

  // E `production_scene_media` continua sem áudio e sem efeito.
  assert.deepEqual(colunas(db, 'production_scene_media'), [
    'id', 'sceneId', 'kind', 'takeNumber', 'generationJobId', 'assetId',
    'createdAt', 'updatedAt',
  ]);
  db.close();
});

test('ausência. nada de tempo, de mixagem, nem de ferramenta', () => {
  const db = banco();

  // Uma cue diz O QUE existe, nunca QUANDO toca.
  const proibidas = ['startOffset', 'endOffset', 'startSeconds', 'endSeconds',
    'offsetSeconds', 'timelinePosition', 'timelineId', 'trackId', 'track',
    'stem', 'channel', 'gain', 'pan', 'fade', 'duration', 'durationSeconds'];
  for (const t of ['production_scene_sfx_cues', 'production_scene_sfx_takes',
    'production_scene_sfx_selections']) {
    for (const campo of proibidas) {
      assert.equal(colunas(db, t).includes(campo), false, `${t} ganhou ${campo}`);
    }
  }

  // Nem receita técnica de provider no take.
  for (const campo of ['provider', 'model', 'modelId', 'prompt', 'seed', 'path',
    'filename', 'status']) {
    assert.equal(colunas(db, 'production_scene_sfx_takes').includes(campo), false, campo);
  }

  // E a projeção pública não vaza id nenhum.
  const campos = declaredSceneSfxFields();
  assert.equal(campos.cue.includes('id') || campos.cue.includes('sceneId'), false);
  assert.equal(campos.take.includes('id') || campos.take.includes('cueId'), false);
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  createSceneSfxTake('proj_a', 1, 1, {}, db);
  assert.deepEqual(
    Object.keys(publicSceneSfxCue(getSceneSfxCue('proj_a', 1, 1, db))).sort(),
    [...campos.cue].sort(),
  );
  assert.deepEqual(
    Object.keys(publicSceneSfxTake(getSceneSfxTake('proj_a', 1, 1, 1, db))).sort(),
    [...campos.take].sort(),
  );
  db.close();
});

test('ausência. nenhuma Agent Tool de efeito, música ou diálogo', () => {
  const publicadas = publicToolList(toolRegistry()).map((t) => t.name);
  for (const nome of publicadas) {
    assert.equal(
      /sfx|efeito|sound|music|musica|dialogue|dialogo|foley|ambient|timeline|mix/i.test(nome),
      false,
      `ferramenta criada cedo demais: ${nome}`,
    );
  }
});

test('ausência. o teto de cues existe e é recusado com mensagem acionável', () => {
  const db = banco();
  for (let n = 1; n <= MAX_CUES_POR_CENA; n += 1) {
    createSceneSfxCue('proj_a', 1, { description: `efeito ${n}` }, db);
  }
  assert.throws(
    () => createSceneSfxCue('proj_a', 1, { description: 'mais um' }, db),
    (erro) => erro instanceof DomainError && /o limite é 40/.test(erro.message),
  );
  db.close();
});
