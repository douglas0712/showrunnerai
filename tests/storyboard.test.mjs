import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SCENE_STATUS, addScene, approveScene, createScene, moveScene, removeScene,
  renumber, requestSceneRevision, sceneStats, totalDuration, updateScene,
} from '../lib/storyboard.js';

const base = () =>
  renumber([
    createScene({ id: 'a', title: 'A', duration: 4 }),
    createScene({ id: 'b', title: 'B', duration: 6 }),
    createScene({ id: 'c', title: 'C', duration: 5 }),
  ]);

test('as cenas são numeradas em sequência a partir de 1', () => {
  assert.deepEqual(base().map((s) => s.number), [1, 2, 3]);
});

test('adicionar cena renumera e mantém a ordem', () => {
  const scenes = addScene(base(), { title: 'D' });
  assert.equal(scenes.length, 4);
  assert.equal(scenes[3].title, 'D');
  assert.deepEqual(scenes.map((s) => s.number), [1, 2, 3, 4]);
});

test('excluir cena renumera as restantes', () => {
  const scenes = removeScene(base(), 'b');
  assert.deepEqual(scenes.map((s) => s.id), ['a', 'c']);
  assert.deepEqual(scenes.map((s) => s.number), [1, 2]);
});

test('reordenar move a cena e renumera', () => {
  assert.deepEqual(moveScene(base(), 'c', -1).map((s) => s.id), ['a', 'c', 'b']);
  assert.deepEqual(moveScene(base(), 'a', 1).map((s) => s.id), ['b', 'a', 'c']);
});

test('reordenar nas bordas não altera nada', () => {
  assert.deepEqual(moveScene(base(), 'a', -1).map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(moveScene(base(), 'c', 1).map((s) => s.id), ['a', 'b', 'c']);
  assert.deepEqual(moveScene(base(), 'inexistente', 1).map((s) => s.id), ['a', 'b', 'c']);
});

test('aprovar limpa o pedido de alteração anterior', () => {
  const comPedido = requestSceneRevision(base(), 'a', 'fechar o plano');
  assert.equal(comPedido[0].status, SCENE_STATUS.REVISION);
  assert.equal(comPedido[0].revisionNote, 'fechar o plano');

  const aprovada = approveScene(comPedido, 'a');
  assert.equal(aprovada[0].status, SCENE_STATUS.APPROVED);
  assert.equal(aprovada[0].revisionNote, '');
});

test('updateScene só altera a cena indicada', () => {
  const scenes = updateScene(base(), 'b', { duration: 12 });
  assert.equal(scenes[1].duration, 12);
  assert.equal(scenes[0].duration, 4);
});

test('duração total e estatísticas', () => {
  assert.equal(totalDuration(base()), 15);
  const scenes = approveScene(requestSceneRevision(base(), 'c', 'x'), 'a');
  const stats = sceneStats(scenes);
  assert.equal(stats.total, 3);
  assert.equal(stats.approved, 1);
  assert.equal(stats.revision, 1);
});
