import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_MODELS, IMAGE_MODELS, VIDEO_MODELS, defaultModel, getModel,
  inputDefault, inputEnum, runtimeLabel, statusLabel, RUNTIME, STATUS,
} from '../lib/models.js';

test('o catálogo exigido da fase 1 está cadastrado', () => {
  const ideogram = getModel('ideogram-4');
  assert.equal(ideogram.runtime, RUNTIME.LOCAL);
  assert.equal(ideogram.status, STATUS.AVAILABLE);

  const h3 = getModel('minimax-h3');
  assert.equal(h3.runtime, RUNTIME.LOCAL);
  assert.equal(h3.status, STATUS.AVAILABLE);

  ['veo-3.1', 'kling', 'seedance'].forEach((id) => {
    const model = getModel(id);
    assert.equal(model.runtime, RUNTIME.API, `${id} deve ser API`);
    assert.equal(model.status, STATUS.NOT_CONFIGURED, `${id} deve estar não configurado`);
  });
});

test('todo modelo declara runtime, status e provider', () => {
  ALL_MODELS.forEach((model) => {
    assert.ok([RUNTIME.LOCAL, RUNTIME.API].includes(model.runtime), model.id);
    assert.ok([STATUS.AVAILABLE, STATUS.NOT_CONFIGURED].includes(model.status), model.id);
    assert.ok(model.providerId, model.id);
    assert.ok(model.name && model.vendor, model.id);
  });
});

test('nenhum modelo está acoplado a um fornecedor obrigatório', () => {
  const serialized = JSON.stringify(ALL_MODELS).toLowerCase();
  assert.ok(!serialized.includes('muapi'), 'o catálogo não pode depender da MuAPI');
  assert.ok(!serialized.includes('api.muapi.ai'));
});

test('os padrões escolhidos são modelos locais disponíveis', () => {
  assert.equal(defaultModel('image').id, 'ideogram-4');
  assert.equal(defaultModel('video').id, 'minimax-h3');
});

test('os helpers de input devolvem enum e padrão coerentes', () => {
  const model = getModel('minimax-h3');
  assert.ok(inputEnum(model, 'duration').includes(inputDefault(model, 'duration')));
  assert.ok(inputEnum(model, 'resolution').includes(inputDefault(model, 'resolution')));
  assert.deepEqual(inputEnum(model, 'inexistente', ['x']), ['x']);
});

test('os rótulos de runtime/status estão em português', () => {
  assert.equal(runtimeLabel(getModel('ideogram-4')), 'Local');
  assert.equal(runtimeLabel(getModel('veo-3.1')), 'API');
  assert.equal(statusLabel(getModel('ideogram-4')), 'Disponível');
  assert.equal(statusLabel(getModel('kling')), 'Não configurado');
});

test('há modelos de imagem e de vídeo', () => {
  assert.ok(IMAGE_MODELS.length >= 4);
  assert.ok(VIDEO_MODELS.length >= 4);
});
