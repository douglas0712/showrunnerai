// Scene no servidor: associação ao projeto, ordem de produção e preservação
// da forma e dos estados que lib/storyboard.js já define.

import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_STATUS, createScene } from '../lib/storyboard.js';
import { DomainError, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import {
  createSceneRecord, getScene, listScenes, removeSceneRecord, renumberScenes,
  updateSceneRecord,
} from '../lib/server/domain/scenes.js';

function bancoComProjeto(id = 'p1') {
  const db = openDatabase(':memory:');
  createProject({ id, name: 'Produção' }, db);
  return db;
}

test('a cena persistida preserva a forma de createScene()', () => {
  const db = bancoComProjeto();

  const persistida = createSceneRecord({
    projectId: 'p1',
    title: 'Abertura — cidade ao amanhecer',
    description: 'Plano aéreo lento sobre a cidade.',
    duration: 8,
    modelId: 'minimax-h3',
    status: SCENE_STATUS.APPROVED,
  }, db);

  // Todo campo que createScene() produz precisa existir no registro.
  const daFuncaoPura = createScene({});
  for (const campo of Object.keys(daFuncaoPura)) {
    assert.ok(campo in persistida, `campo perdido na persistência: ${campo}`);
  }

  assert.equal(persistida.projectId, 'p1');
  assert.equal(persistida.title, 'Abertura — cidade ao amanhecer');
  assert.equal(persistida.duration, 8);
  assert.equal(persistida.status, SCENE_STATUS.APPROVED);
  assert.deepEqual(getScene(persistida.id, db), persistida);
  db.close();
});

test('sem status, herda o padrão de createScene()', () => {
  const db = bancoComProjeto();
  const cena = createSceneRecord({ projectId: 'p1', title: 'T' }, db);
  assert.equal(cena.status, createScene({}).status);
  assert.equal(cena.status, SCENE_STATUS.DRAFT);
  db.close();
});

test('cena sem projeto existente é recusada', () => {
  const db = bancoComProjeto();
  assert.throws(
    () => createSceneRecord({ projectId: 'nao_existe', title: 'T' }, db),
    DomainError,
  );
  assert.throws(
    () => createSceneRecord({ projectId: '../escapa', title: 'T' }, db),
    DomainError,
  );
  db.close();
});

test('status fora do vocabulário de storyboard.js é recusado', () => {
  const db = bancoComProjeto();
  assert.throws(
    () => createSceneRecord({ projectId: 'p1', title: 'T', status: 'inventado' }, db),
    DomainError,
  );
  const cena = createSceneRecord({ projectId: 'p1', title: 'T' }, db);
  assert.throws(() => updateSceneRecord(cena.id, { status: 'inventado' }, db), DomainError);
  db.close();
});

test('sem número, cada cena entra no fim da fila do projeto', () => {
  const db = bancoComProjeto();
  const a = createSceneRecord({ projectId: 'p1', title: 'A' }, db);
  const b = createSceneRecord({ projectId: 'p1', title: 'B' }, db);
  const c = createSceneRecord({ projectId: 'p1', title: 'C' }, db);

  assert.deepEqual([a.number, b.number, c.number], [1, 2, 3]);
  assert.deepEqual(listScenes('p1', db).map((s) => s.title), ['A', 'B', 'C']);
  db.close();
});

test('a numeração é por projeto, não global', () => {
  const db = bancoComProjeto('p1');
  createProject({ id: 'p2', name: 'Outra' }, db);

  createSceneRecord({ projectId: 'p1', title: 'A1' }, db);
  createSceneRecord({ projectId: 'p1', title: 'A2' }, db);
  const primeiraDoP2 = createSceneRecord({ projectId: 'p2', title: 'B1' }, db);

  assert.equal(primeiraDoP2.number, 1);
  assert.deepEqual(listScenes('p1', db).map((s) => s.title), ['A1', 'A2']);
  assert.deepEqual(listScenes('p2', db).map((s) => s.title), ['B1']);
  db.close();
});

test('listar devolve na ordem de produção mesmo com inserção fora de ordem', () => {
  const db = bancoComProjeto();
  createSceneRecord({ projectId: 'p1', title: 'Terceira', number: 3 }, db);
  createSceneRecord({ projectId: 'p1', title: 'Primeira', number: 1 }, db);
  createSceneRecord({ projectId: 'p1', title: 'Segunda', number: 2 }, db);

  assert.deepEqual(
    listScenes('p1', db).map((s) => s.title),
    ['Primeira', 'Segunda', 'Terceira'],
  );
  db.close();
});

test('atualizar altera só o que foi pedido e avança updatedAt', async () => {
  const db = bancoComProjeto();
  const cena = createSceneRecord({ projectId: 'p1', title: 'Antes', duration: 6 }, db);

  await new Promise((r) => { setTimeout(r, 2); });
  const alterada = updateSceneRecord(cena.id, {
    title: 'Depois',
    status: SCENE_STATUS.REVISION,
    revisionNote: 'Segurar mais tempo no olhar antes do corte.',
  }, db);

  assert.equal(alterada.title, 'Depois');
  assert.equal(alterada.status, SCENE_STATUS.REVISION);
  assert.equal(alterada.revisionNote, 'Segurar mais tempo no olhar antes do corte.');
  assert.equal(alterada.duration, 6);
  assert.equal(alterada.projectId, 'p1');
  assert.equal(alterada.createdAt, cena.createdAt);
  assert.ok(alterada.updatedAt > cena.updatedAt);
  db.close();
});

test('atualizar recusa mexer em id ou projectId', () => {
  const db = bancoComProjeto();
  const cena = createSceneRecord({ projectId: 'p1', title: 'T' }, db);
  for (const patch of [{ id: 'outro' }, { projectId: 'p2' }, { createdAt: 0 }]) {
    assert.throws(() => updateSceneRecord(cena.id, patch, db), DomainError);
  }
  db.close();
});

test('renumberScenes reaplica a regra pura de storyboard.js', () => {
  const db = bancoComProjeto();
  createSceneRecord({ projectId: 'p1', title: 'A' }, db);
  const b = createSceneRecord({ projectId: 'p1', title: 'B' }, db);
  createSceneRecord({ projectId: 'p1', title: 'C' }, db);

  removeSceneRecord(b.id, db);
  assert.deepEqual(listScenes('p1', db).map((s) => s.number), [1, 3]);

  const renumeradas = renumberScenes('p1', db);
  assert.deepEqual(renumeradas.map((s) => s.number), [1, 2]);
  assert.deepEqual(renumeradas.map((s) => s.title), ['A', 'C']);
  db.close();
});

test('apagar o projeto leva as cenas junto', () => {
  const db = bancoComProjeto();
  createSceneRecord({ projectId: 'p1', title: 'A' }, db);
  createSceneRecord({ projectId: 'p1', title: 'B' }, db);

  db.prepare('DELETE FROM projects WHERE id = ?').run('p1');
  assert.deepEqual(listScenes('p1', db), []);
  db.close();
});

test('remover cena devolve false na segunda vez', () => {
  const db = bancoComProjeto();
  const cena = createSceneRecord({ projectId: 'p1', title: 'A' }, db);
  assert.equal(removeSceneRecord(cena.id, db), true);
  assert.equal(removeSceneRecord(cena.id, db), false);
  assert.equal(getScene(cena.id, db), null);
  db.close();
});

// ── transacionalidade ───────────────────────────────────────────────────────

test('renumberScenes é atômico: falha no meio não deixa numeração parcial', () => {
  const db = bancoComProjeto();
  const a = createSceneRecord({ projectId: 'p1', title: 'A', number: 10 }, db);
  const b = createSceneRecord({ projectId: 'p1', title: 'B', number: 20 }, db);
  const c = createSceneRecord({ projectId: 'p1', title: 'C', number: 30 }, db);

  const antes = listScenes('p1', db).map((s) => ({ id: s.id, number: s.number }));
  assert.deepEqual(antes.map((s) => s.number), [10, 20, 30]);

  // Aborta a escrita da ÚLTIMA cena. Sem transação, A e B já teriam sido
  // renumeradas para 1 e 2 e o projeto ficaria em [1, 2, 30].
  db.exec(`
    CREATE TRIGGER falha_no_meio BEFORE UPDATE ON scenes
    WHEN NEW.id = '${c.id}'
    BEGIN SELECT RAISE(ABORT, 'falha simulada'); END
  `);

  assert.throws(() => renumberScenes('p1', db), /falha simulada/);

  const depois = listScenes('p1', db).map((s) => ({ id: s.id, number: s.number }));
  assert.deepEqual(depois, antes, 'o ROLLBACK devolveu a numeração ao estado anterior');

  // Removido o obstáculo, a mesma chamada conclui — a operação é repetível.
  db.exec('DROP TRIGGER falha_no_meio');
  const final = renumberScenes('p1', db);
  assert.deepEqual(final.map((s) => s.number), [1, 2, 3]);
  assert.deepEqual(final.map((s) => s.id), [a.id, b.id, c.id], 'a ordem foi preservada');
  db.close();
});

test('renumberScenes não deixa transação aberta após a falha', () => {
  const db = bancoComProjeto();
  const cena = createSceneRecord({ projectId: 'p1', title: 'A', number: 7 }, db);

  db.exec(`
    CREATE TRIGGER falha_total BEFORE UPDATE ON scenes
    BEGIN SELECT RAISE(ABORT, 'falha simulada'); END
  `);
  assert.throws(() => renumberScenes('p1', db), /falha simulada/);
  db.exec('DROP TRIGGER falha_total');

  // Se a transação tivesse ficado aberta, este BEGIN lançaria
  // "cannot start a transaction within a transaction".
  db.exec('BEGIN');
  db.exec('COMMIT');

  assert.equal(getScene(cena.id, db).number, 7);
  db.close();
});
