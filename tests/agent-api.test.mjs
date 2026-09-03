// A API do agente.
//
// As Route Handlers não são importáveis num teste de `node:test`: `next/server`
// não resolve fora do build do Next. Então a decisão inteira — validação,
// corpo da resposta, mapeamento de erro para status — mora em
// `lib/server/agent/httpApi.js`, e é ela que estes testes exercitam. Mesmo
// movimento de `generation/mediaServing.js`, e pelo mesmo motivo.
//
// O que sobra na rota é o que só ela pode fazer: ler o corpo e devolver
// `NextResponse.json`. O teste de arquitetura confere que não sobrou mais nada.

import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createEchoRuntime } from '../lib/server/agent/adapters/EchoRuntimeAdapter.js';
import { assertRuntimePort } from '../lib/server/agent/AgentRuntimePort.js';
import {
  handleCreateThread, handleGetThread, handleListThreads, handleSendMessage,
} from '../lib/server/agent/httpApi.js';

const ambiente = () => ({ db: openDatabase(':memory:'), runtime: createEchoRuntime() });

// ── 20 · criar thread ───────────────────────────────────────────────────────

test('20. a API cria uma conversa', () => {
  const deps = ambiente();

  const r = handleCreateThread({ title: 'Curta neo-noir' }, deps);

  assert.equal(r.status, 201);
  assert.equal(r.body.agentName, 'Showrunner');
  assert.equal(r.body.thread.title, 'Curta neo-noir');
  assert.equal(r.body.thread.projectId, null);
  assert.deepEqual(r.body.messages, []);
  assert.match(r.body.thread.id, /^thread_/);

  deps.db.close();
});

test('20b. a API cria conversa ligada a um projeto existente', () => {
  const deps = ambiente();
  createProject({ id: 'proj_sinal', name: 'Sinal' }, deps.db);

  const r = handleCreateThread({ projectId: 'proj_sinal' }, deps);
  assert.equal(r.status, 201);
  assert.equal(r.body.thread.projectId, 'proj_sinal');

  deps.db.close();
});

test('20c. projeto inexistente vira 422, e nenhum projeto é criado', () => {
  const deps = ambiente();

  const r = handleCreateThread({ projectId: 'proj_fantasma' }, deps);
  assert.equal(r.status, 422);
  assert.match(r.body.error, /Projeto desconhecido/);

  assert.equal(deps.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
  assert.equal(deps.db.prepare('SELECT COUNT(*) AS n FROM agent_threads').get().n, 0);

  deps.db.close();
});

test('20d. corpo malformado vira 400 sem tocar no banco', () => {
  const deps = ambiente();

  for (const ruim of [null, undefined, 'texto', 42, []]) {
    assert.equal(handleCreateThread(ruim, deps).status, 400, JSON.stringify(ruim));
  }
  assert.equal(handleCreateThread({ projectId: 42 }, deps).status, 400);
  assert.equal(handleCreateThread({ title: { a: 1 } }, deps).status, 400);

  assert.equal(deps.db.prepare('SELECT COUNT(*) AS n FROM agent_threads').get().n, 0);
  deps.db.close();
});

// ── 21 · enviar mensagem ────────────────────────────────────────────────────

test('21. a API envia uma mensagem e devolve o turno', async () => {
  const deps = ambiente();
  const { body: { thread } } = handleCreateThread({}, deps);

  const r = await handleSendMessage({ threadId: thread.id, content: 'Olá Showrunner' }, deps);

  assert.equal(r.status, 200);
  assert.equal(r.body.agentName, 'Showrunner');
  assert.equal(r.body.userMessage.role, 'user');
  assert.equal(r.body.userMessage.content, 'Olá Showrunner');
  assert.equal(r.body.assistantMessage.role, 'assistant');
  assert.equal(r.body.assistantMessage.content, 'Recebi: Olá Showrunner');
  assert.equal(r.body.userMessage.seq + 1, r.body.assistantMessage.seq);

  // Os eventos normalizados acompanham a resposta: são o mesmo vocabulário em
  // que o streaming vai chegar, então uma UI escrita contra eles hoje continua
  // valendo depois.
  assert.ok(Array.isArray(r.body.events));
  assert.equal(r.body.events[0].type, 'agent.started');
  assert.equal(r.body.events.at(-1).type, 'agent.completed');
  assert.ok(r.body.events.some((e) => e.type === 'agent.message.completed'));

  deps.db.close();
});

test('21b. mensagem em conversa inexistente vira 404', async () => {
  const deps = ambiente();
  const r = await handleSendMessage({ threadId: 'thread_fantasma', content: 'Olá' }, deps);
  assert.equal(r.status, 404);
  assert.match(r.body.error, /Conversa desconhecida/);
  deps.db.close();
});

test('21c. corpo inválido vira 400 sem chegar ao runtime', async () => {
  const deps = ambiente();
  const { body: { thread } } = handleCreateThread({}, deps);

  const ruins = [
    [null, 'corpo nulo'],
    [{ content: 'sem thread' }, 'sem threadId'],
    [{ threadId: thread.id }, 'sem content'],
    [{ threadId: thread.id, content: 42 }, 'content não textual'],
    [{ threadId: 42, content: 'x' }, 'threadId não textual'],
  ];
  for (const [corpo, caso] of ruins) {
    assert.equal((await handleSendMessage(corpo, deps)).status, 400, caso);
  }

  // Conteúdo vazio é regra de domínio, não de forma: também 400.
  assert.equal((await handleSendMessage({ threadId: thread.id, content: '  ' }, deps)).status, 400);

  assert.equal(deps.db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n, 0);
  deps.db.close();
});

test('21d. runtime indisponível vira 503, e o turno não começa', async () => {
  const db = openDatabase(':memory:');
  const desligado = assertRuntimePort({
    id: 'desligado',
    isAvailable: () => false,
    unavailableReason: () => 'O agente não está configurado nesta instalação.',
    testConnection: async () => ({ ok: false }),
    run: async function* () { yield null; },
  });

  const { body: { thread } } = handleCreateThread({}, { db, runtime: desligado });
  const r = await handleSendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime: desligado });

  assert.equal(r.status, 503);
  assert.match(r.body.error, /não está configurado/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n, 0);

  db.close();
});

test('21e. runtime que falha no meio do turno vira 502, e a fala do usuário fica', async () => {
  const db = openDatabase(':memory:');
  const quebra = assertRuntimePort({
    id: 'quebra',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    // eslint-disable-next-line require-yield
    run: async function* () { throw new Error('o runtime caiu'); },
  });

  const { body: { thread } } = handleCreateThread({}, { db, runtime: quebra });
  const r = await handleSendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime: quebra });

  assert.equal(r.status, 502);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n, 1);
  assert.equal(
    db.prepare('SELECT role FROM agent_messages').get().role, 'user',
    'uma resposta de assistente foi inventada',
  );

  db.close();
});

// ── 22 · recuperar a conversa ───────────────────────────────────────────────

test('22. a API recupera a conversa com as mensagens em ordem', async () => {
  const deps = ambiente();
  const { body: { thread } } = handleCreateThread({ title: 'Direção' }, deps);

  await handleSendMessage({ threadId: thread.id, content: 'primeira' }, deps);
  await handleSendMessage({ threadId: thread.id, content: 'segunda' }, deps);

  const r = handleGetThread(thread.id, deps);

  assert.equal(r.status, 200);
  assert.equal(r.body.agentName, 'Showrunner');
  assert.equal(r.body.thread.id, thread.id);
  assert.deepEqual(r.body.messages.map((m) => [m.role, m.content]), [
    ['user', 'primeira'],
    ['assistant', 'Recebi: primeira'],
    ['user', 'segunda'],
    ['assistant', 'Recebi: segunda'],
  ]);
  assert.deepEqual(r.body.messages.map((m) => m.seq), [1, 2, 3, 4]);

  deps.db.close();
});

test('22b. conversa inexistente vira 404; threadId inválido, 400', () => {
  const deps = ambiente();
  assert.equal(handleGetThread('thread_fantasma', deps).status, 404);
  assert.equal(handleGetThread('', deps).status, 400);
  assert.equal(handleGetThread(null, deps).status, 400);
  deps.db.close();
});

test('22c. a listagem traz as conversas, e o filtro por projeto funciona', () => {
  const deps = ambiente();
  createProject({ id: 'proj_sinal', name: 'Sinal' }, deps.db);

  const comProjeto = handleCreateThread({ projectId: 'proj_sinal' }, deps).body.thread;
  const semProjeto = handleCreateThread({}, deps).body.thread;

  assert.equal(handleListThreads({}, deps).body.threads.length, 2);
  assert.deepEqual(
    handleListThreads({ projectId: 'proj_sinal' }, deps).body.threads.map((t) => t.id),
    [comProjeto.id],
  );
  assert.deepEqual(
    handleListThreads({ projectId: null }, deps).body.threads.map((t) => t.id),
    [semProjeto.id],
  );

  deps.db.close();
});

// ── 23 · a resposta pública não expõe o runtime ─────────────────────────────

test('23. nenhuma resposta pública da API nomeia o runtime', async () => {
  const deps = ambiente();

  const criada = handleCreateThread({ title: 'Identidade' }, deps);
  const turno = await handleSendMessage(
    { threadId: criada.body.thread.id, content: 'Quem é você?' }, deps,
  );
  const lida = handleGetThread(criada.body.thread.id, deps);
  const lista = handleListThreads({}, deps);

  for (const [nome, resposta] of [
    ['create', criada], ['send', turno], ['get', lida], ['list', lista],
  ]) {
    // O texto da conversa é conteúdo neutro que não revela o runtime. O que não
    // pode existir é METADADO nomeando o runtime ou seu adaptador.
    const semConteudo = JSON.stringify(resposta.body, (chave, valor) => (
      chave === 'content' || chave === 'text' ? undefined : valor
    ));

    for (const proibido of ['echo', 'runtime', 'adapter', 'model', 'hermes']) {
      assert.ok(
        !new RegExp(proibido, 'i').test(semConteudo),
        `a resposta de ${nome} carrega "${proibido}": ${semConteudo.slice(0, 300)}`,
      );
    }

    // E a identidade que ela declara é sempre a do produto.
    assert.equal(resposta.body.agentName, 'Showrunner');
  }

  deps.db.close();
});
