import test from 'node:test';
import assert from 'node:assert/strict';
import { createLogStore } from '../lib/server/logs/store.js';
import { LEVELS } from '../lib/server/logs/stages.js';

const evento = (level, extras = {}) => ({
  ts: new Date().toISOString(),
  tsMs: Date.now(),
  level,
  channel: 'comfy',
  stage: 'GENERATING',
  jobId: 'cinema_a',
  message: 'evento',
  ...extras,
});

test('cada evento recebe um seq crescente', () => {
  const store = createLogStore();
  const a = store.append(evento(LEVELS.INFO));
  const b = store.append(evento(LEVELS.INFO));
  assert.equal(a.seq, 1);
  assert.equal(b.seq, 2);
});

test('o buffer não passa da capacidade', () => {
  const store = createLogStore({ capacidade: 10, errosRetidos: 0 });
  for (let i = 0; i < 50; i += 1) store.append(evento(LEVELS.INFO));
  assert.equal(store.tamanho, 10);
  assert.equal(store.stats().descartados, 40);
});

test('a rotação descarta os mais antigos primeiro', () => {
  const store = createLogStore({ capacidade: 3, errosRetidos: 0 });
  for (let i = 1; i <= 5; i += 1) store.append(evento(LEVELS.INFO, { message: `n${i}` }));
  const { events } = store.query({});
  assert.deepEqual(events.map((e) => e.message), ['n3', 'n4', 'n5']);
});

test('os erros mais recentes sobrevivem à rotação', () => {
  const store = createLogStore({ capacidade: 5, errosRetidos: 2 });

  store.append(evento(LEVELS.ERROR, { message: 'falha antiga' }));
  for (let i = 0; i < 20; i += 1) store.append(evento(LEVELS.INFO, { message: `ruido${i}` }));

  const { events } = store.query({});
  assert.equal(events.length, 5);
  assert.ok(
    events.some((e) => e.message === 'falha antiga'),
    'o erro deveria ter sido preservado apesar do ruído posterior',
  );
});

test('a proteção guarda no máximo os N erros mais recentes', () => {
  const store = createLogStore({ capacidade: 6, errosRetidos: 2 });

  store.append(evento(LEVELS.ERROR, { message: 'erro1' }));
  store.append(evento(LEVELS.ERROR, { message: 'erro2' }));
  store.append(evento(LEVELS.ERROR, { message: 'erro3' }));
  for (let i = 0; i < 20; i += 1) store.append(evento(LEVELS.INFO));

  const mensagens = store.query({}).events.map((e) => e.message);
  assert.ok(!mensagens.includes('erro1'), 'o erro mais antigo perde a proteção');
  assert.ok(mensagens.includes('erro2'));
  assert.ok(mensagens.includes('erro3'));
});

test('capacidade menor que a política de retenção ainda respeita o teto', () => {
  const store = createLogStore({ capacidade: 2, errosRetidos: 10 });
  for (let i = 0; i < 8; i += 1) store.append(evento(LEVELS.ERROR));
  assert.equal(store.tamanho, 2);
});

test('a leitura por cursor só devolve o que é novo', () => {
  const store = createLogStore();
  store.append(evento(LEVELS.INFO, { message: 'a' }));
  const primeira = store.query({});
  assert.equal(primeira.events.length, 1);

  store.append(evento(LEVELS.INFO, { message: 'b' }));
  const segunda = store.query({ since: primeira.cursor });
  assert.deepEqual(segunda.events.map((e) => e.message), ['b']);
});

test('o cursor não retrocede quando nada aconteceu', () => {
  const store = createLogStore();
  store.append(evento(LEVELS.INFO));
  const primeira = store.query({});
  const segunda = store.query({ since: primeira.cursor });
  assert.equal(segunda.events.length, 0);
  assert.equal(segunda.cursor, primeira.cursor);
});

test('o filtro por job não mistura gerações simultâneas', () => {
  const store = createLogStore();
  store.append(evento(LEVELS.INFO, { jobId: 'cinema_a', message: 'a1' }));
  store.append(evento(LEVELS.INFO, { jobId: 'cinema_b', message: 'b1' }));
  store.append(evento(LEVELS.INFO, { jobId: 'cinema_a', message: 'a2' }));

  const { events } = store.query({ jobId: 'cinema_a' });
  assert.deepEqual(events.map((e) => e.message), ['a1', 'a2']);
});

test('o filtro por nível é exato, não acumulativo', () => {
  const store = createLogStore();
  store.append(evento(LEVELS.INFO));
  store.append(evento(LEVELS.WARN));
  store.append(evento(LEVELS.ERROR));

  assert.equal(store.query({ level: LEVELS.WARN }).events.length, 1);
  assert.equal(store.query({ level: LEVELS.ERROR }).events.length, 1);
  assert.equal(store.query({}).events.length, 3);
});

test('as estatísticas contam por nível', () => {
  const store = createLogStore();
  store.append(evento(LEVELS.INFO));
  store.append(evento(LEVELS.INFO));
  store.append(evento(LEVELS.ERROR));

  const stats = store.stats();
  assert.equal(stats.total, 3);
  assert.equal(stats.porNivel[LEVELS.INFO], 2);
  assert.equal(stats.porNivel[LEVELS.ERROR], 1);
});

test('byJob devolve a linha do tempo completa de um job', () => {
  const store = createLogStore();
  store.append(evento(LEVELS.INFO, { jobId: 'x', stage: 'QUEUED' }));
  store.append(evento(LEVELS.INFO, { jobId: 'y' }));
  store.append(evento(LEVELS.ERROR, { jobId: 'x', stage: 'FAILED' }));

  assert.deepEqual(store.byJob('x').map((e) => e.stage), ['QUEUED', 'FAILED']);
});
