// O adaptador, exercitado inteiro contra um runtime de mentira.
//
// Nenhum destes testes sobe runtime, abre porta ou fala com a rede: o cliente
// HTTP recebe um `fetch` falso. É o que mantém `npm test` determinístico — e é
// a mesma costura que o gateway usa para injetar um runtime nos testes dele.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHermesRuntime } from '../lib/server/agent/adapters/HermesRuntimeAdapter.js';
import {
  assertToolsetsSeguros, createHermesClient, HermesTransportError, TOOLSETS_OBRIGATORIOS,
} from '../lib/server/agent/hermes/httpClient.js';
import { assertRuntimePort } from '../lib/server/agent/AgentRuntimePort.js';
import { AGENT_EVENTS, declaredFieldsFor } from '../lib/server/agent/events.js';
import { openDatabase } from '../lib/server/domain/db.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import { ensureProject } from '../lib/server/domain/projects.js';

const relogio = () => 1000;

/** Um banco novo, em memória, com um projeto e uma thread. */
function bancoComThread() {
  const db = openDatabase(':memory:');
  const { project } = ensureProject('proj_teste', { name: 'Teste' }, db);
  const thread = createThreadRecord({ projectId: project.id }, db);
  return { db, thread, projeto: project };
}

/**
 * Um runtime de mentira que fala o protocolo real.
 *
 * `roteiro` é o texto SSE que o /api/chat/stream devolve.
 */
function fetchFalso({ roteiro = '', sessionToolsets = [...TOOLSETS_OBRIGATORIOS], onCall = () => {} } = {}) {
  const chamadas = [];
  const impl = async (url, opcoes = {}) => {
    const caminho = String(url).replace(/^https?:\/\/[^/]+/, '');
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    chamadas.push({ caminho, method: opcoes.method || 'GET', corpo });
    onCall({ caminho, corpo });

    const json = (dados, status = 200) => ({
      ok: status < 400, status,
      text: async () => JSON.stringify(dados),
    });

    if (caminho === '/health') return json({ status: 'ok' });

    if (caminho === '/api/session/new') {
      return json({ session: { session_id: 'sess_abc123', enabled_toolsets: sessionToolsets } });
    }

    // PASSO 8.2: toda sessão recebe a identidade do Showrunner antes do
    // primeiro turno. Sem isto o adaptador recusa a sessão — de propósito.
    if (caminho === '/api/personality/set') {
      return json({ ok: true, personality: corpo?.name ?? null });
    }

    if (caminho === '/api/chat/start') {
      return json({ stream_id: 'stream_xyz', session_id: corpo?.session_id });
    }

    if (caminho.startsWith('/api/chat/stream')) {
      return {
        ok: true, status: 200,
        body: (async function* () { yield new TextEncoder().encode(roteiro); })(),
      };
    }

    if (caminho === '/api/chat/cancel') return json({ ok: true });

    return json({ error: 'not found' }, 404);
  };
  impl.chamadas = chamadas;
  return impl;
}

function runtimeDeTeste({ db, roteiro, sessionToolsets, turns = null } = {}) {
  const fetchImpl = fetchFalso({ roteiro, sessionToolsets });
  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9', db, clock: relogio, turns, fetchImpl,
  });
  return { runtime, fetchImpl };
}

const ROTEIRO_OK = [
  'event: context_status\ndata: {"session_id":"sess_abc123"}\n\n',
  'event: reasoning\ndata: {"text":"**Planning terminal tooling**"}\n\n',
  'event: token\ndata: {"text":"OK"}\n\n',
  'event: metering\ndata: {"tps":15.6,"usage":{"input_tokens":1372}}\n\n',
  'event: done\ndata: {"session":{"session_id":"sess_abc123","model":"gpt-5.6-terra","messages":[{"role":"user","content":"oi"},{"role":"assistant","content":"OK"}]}}\n\n',
  'event: stream_end\ndata: {}\n\n',
].join('');

// ── contrato ────────────────────────────────────────────────────────────────

test('cumpre o AgentRuntimePort', () => {
  const { runtime } = runtimeDeTeste({ db: openDatabase(':memory:') });
  assert.doesNotThrow(() => assertRuntimePort(runtime));
  assert.equal(runtime.id, 'hermes');
});

test('sem URL configurada, fica indisponível com motivo legível', () => {
  const runtime = createHermesRuntime({ baseUrl: '', db: openDatabase(':memory:') });
  assert.equal(runtime.isAvailable(), false);
  const motivo = runtime.unavailableReason();
  assert.match(motivo, /não está configurado/);
  // O motivo é lido por quem opera — mas ainda assim não nomeia o produto.
  assert.equal(/hermes/i.test(motivo), false);
});

test('testConnection responde ok quando o serviço responde', async () => {
  const { runtime } = runtimeDeTeste({ db: openDatabase(':memory:') });
  const resultado = await runtime.testConnection();
  assert.equal(resultado.ok, true);
  assert.deepEqual(resultado.detail.isolation, [...TOOLSETS_OBRIGATORIOS]);
});

// ── isolamento ──────────────────────────────────────────────────────────────

test('a sessão é criada SEMPRE com os toolsets obrigatórios', async () => {
  const { db, thread } = bancoComThread();
  const { runtime, fetchImpl } = runtimeDeTeste({ db, roteiro: ROTEIRO_OK });

  await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));

  const criacao = fetchImpl.chamadas.find((c) => c.caminho === '/api/session/new');
  assert.deepEqual(criacao.corpo.enabled_toolsets, ['showrunner', 'no_mcp']);
});

test('recusa a sessão se o servidor não aplicou o isolamento', async () => {
  const { db, thread } = bancoComThread();
  // O servidor responde 200 mas sem o toolset: sessão inútil e perigosa.
  const { runtime } = runtimeDeTeste({ db, roteiro: ROTEIRO_OK, sessionToolsets: null });

  await assert.rejects(
    () => drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] })),
    HermesTransportError,
  );
});

test('recusa uma sessão que voltou com acesso total', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = runtimeDeTeste({ db, roteiro: ROTEIRO_OK, sessionToolsets: ['all'] });
  await assert.rejects(
    () => drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] })),
    HermesTransportError,
  );
});

test('os valores que concedem acesso total são recusados na origem', () => {
  for (const perigoso of [null, undefined, [], ['all'], ['*'], ['ALL'], ['no_mcp']]) {
    assert.throws(() => assertToolsetsSeguros(perigoso), HermesTransportError,
      `${JSON.stringify(perigoso)} deveria ser recusado`);
  }
  assert.doesNotThrow(() => assertToolsetsSeguros(['showrunner', 'no_mcp']));
});

test('createSession não aceita parâmetro para afrouxar o isolamento', async () => {
  // Não há como pedir outros toolsets: a assinatura não oferece o campo.
  const fetchImpl = fetchFalso({});
  const client = createHermesClient({ baseUrl: 'http://127.0.0.1:9', fetchImpl });
  await client.createSession({ enabled_toolsets: ['all'], toolsets: ['all'] });
  const criacao = fetchImpl.chamadas.find((c) => c.caminho === '/api/session/new');
  assert.deepEqual(criacao.corpo.enabled_toolsets, ['showrunner', 'no_mcp']);
});

// ── binding ─────────────────────────────────────────────────────────────────

test('a sessão é gravada e reaproveitada entre turnos da mesma conversa', async () => {
  const { db, thread } = bancoComThread();
  const { runtime, fetchImpl } = runtimeDeTeste({ db, roteiro: ROTEIRO_OK });

  await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'um' }] }));
  await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'dois' }] }));

  const criacoes = fetchImpl.chamadas.filter((c) => c.caminho === '/api/session/new');
  assert.equal(criacoes.length, 1, 'a sessão deveria ser criada uma única vez');

  const vinculo = db.prepare('SELECT * FROM runtime_sessions').all();
  assert.equal(vinculo.length, 1);
  assert.equal(vinculo[0].threadId, thread.id);
  assert.equal(vinculo[0].runtimeId, 'hermes');
});

test('duas conversas nunca compartilham a mesma sessão', async () => {
  const { db, thread, projeto } = bancoComThread();
  const outra = createThreadRecord({ projectId: projeto.id }, db);
  const { runtime } = runtimeDeTeste({ db, roteiro: ROTEIRO_OK });

  await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'um' }] }));

  // O servidor falso sempre devolve o MESMO session_id. O banco tem de recusar.
  await assert.rejects(
    () => drenar(runtime.run({ thread: outra, messages: [{ role: 'user', content: 'dois' }] })),
    /já pertence a outra conversa/,
  );
});

// ── eventos ─────────────────────────────────────────────────────────────────

test('um turno produz o vocabulário do Showrunner, em ordem', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = runtimeDeTeste({ db, roteiro: ROTEIRO_OK });

  const eventos = await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));
  const tipos = eventos.map((e) => e.type);

  assert.equal(tipos[0], AGENT_EVENTS.STARTED);
  assert.equal(tipos[1], AGENT_EVENTS.STATUS);
  assert.ok(tipos.includes(AGENT_EVENTS.MESSAGE_DELTA));
  assert.equal(tipos.at(-2), AGENT_EVENTS.MESSAGE_COMPLETED);
  assert.equal(tipos.at(-1), AGENT_EVENTS.COMPLETED);

  const completa = eventos.find((e) => e.type === AGENT_EVENTS.MESSAGE_COMPLETED);
  assert.equal(completa.text, 'OK');
});

test('nenhum evento carrega campo fora do vocabulário', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = runtimeDeTeste({ db, roteiro: ROTEIRO_OK });
  const eventos = await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));

  for (const evento of eventos) {
    const permitidos = declaredFieldsFor(evento.type);
    for (const campo of Object.keys(evento)) {
      assert.ok(permitidos.includes(campo), `"${campo}" não é declarado em ${evento.type}`);
    }
  }
});

test('nada da identidade do runtime atravessa', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = runtimeDeTeste({ db, roteiro: ROTEIRO_OK });
  const eventos = await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));

  const texto = JSON.stringify(eventos);
  for (const proibido of ['hermes', 'sess_abc123', 'stream_xyz', 'gpt-5.6-terra',
    'session_id', 'stream_id', 'enabled_toolsets', 'showrunner_test',
    'no_mcp', 'toolset', 'HERMES_HOME', 'Planning terminal tooling',
    'input_tokens', 'metering']) {
    assert.equal(texto.toLowerCase().includes(proibido.toLowerCase()), false,
      `"${proibido}" vazou para os eventos`);
  }
});

test('o status é texto nosso, não o rótulo do runtime', async () => {
  const { db, thread } = bancoComThread();
  const roteiro = 'event: agent_state_change\ndata: {"state":"generating"}\n\n' + ROTEIRO_OK;
  const { runtime } = runtimeDeTeste({ db, roteiro });
  const eventos = await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));

  const status = eventos.filter((e) => e.type === AGENT_EVENTS.STATUS);
  assert.equal(status.length, 1);
  assert.equal(status[0].status, 'Pensando');
});

test('tool do runtime vira evento com nome canônico', async () => {
  const { db, thread } = bancoComThread();
  const roteiro = [
    'event: tool\ndata: {"name":"og_generate_image","tid":"call_1","args":{"prompt":"dragão"}}\n\n',
    'event: tool_complete\ndata: {"name":"og_generate_image","tid":"call_1"}\n\n',
    'event: token\ndata: {"text":"Pronto"}\n\n',
    'event: stream_end\ndata: {}\n\n',
  ].join('');
  const { runtime } = runtimeDeTeste({ db, roteiro });
  const eventos = await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));

  const iniciada = eventos.find((e) => e.type === AGENT_EVENTS.TOOL_STARTED);
  assert.equal(iniciada.name, 'og.generate_image');
  assert.equal(JSON.stringify(eventos).includes('og_generate_image'), false);
});

test('erro do runtime vira falha traduzida', async () => {
  const { db, thread } = bancoComThread();
  const roteiro = `event: apperror\ndata: ${JSON.stringify({
    message: "HTTP 400: Invalid 'tools[0].name': string does not match pattern.",
  })}\n\n`;
  const { runtime } = runtimeDeTeste({ db, roteiro });
  const eventos = await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));

  const falha = eventos.find((e) => e.type === AGENT_EVENTS.FAILED);
  assert.ok(falha);
  assert.equal(JSON.stringify(eventos).includes('HTTP 400'), false);
});

// ── cancelamento ────────────────────────────────────────────────────────────

test('abortar interrompe o fluxo e pede cancelamento ao runtime', async () => {
  const { db, thread } = bancoComThread();
  const controlador = new AbortController();
  const roteiro = [
    'event: token\ndata: {"text":"a"}\n\n',
    'event: token\ndata: {"text":"b"}\n\n',
    'event: stream_end\ndata: {}\n\n',
  ].join('');
  const { runtime, fetchImpl } = runtimeDeTeste({ db, roteiro });

  const eventos = [];
  for await (const evento of runtime.run({
    thread, messages: [{ role: 'user', content: 'oi' }], signal: controlador.signal,
  })) {
    eventos.push(evento);
    if (evento.type === AGENT_EVENTS.MESSAGE_DELTA) controlador.abort();
  }

  assert.equal(eventos.some((e) => e.type === AGENT_EVENTS.COMPLETED), false,
    'um turno abortado não conclui');
  assert.ok(fetchImpl.chamadas.some((c) => c.caminho === '/api/chat/cancel'),
    'o cancelamento deveria ter sido pedido ao runtime');
});

test('turno sem fala do usuário falha alto', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = runtimeDeTeste({ db, roteiro: ROTEIRO_OK });
  await assert.rejects(() => drenar(runtime.run({ thread, messages: [] })), /mensagem de usuário/);
});

async function drenar(iteravel) {
  const eventos = [];
  for await (const evento of await iteravel) eventos.push(evento);
  return eventos;
}
