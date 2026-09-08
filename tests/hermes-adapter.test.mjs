// O adaptador, exercitado inteiro contra um runtime de mentira.
//
// Nenhum destes testes sobe runtime, abre porta ou fala com a rede: o cliente
// recebe um `WebSocket` e um `fetch` falsos. É o que mantém `npm test`
// determinístico — e é a mesma costura que o gateway usa para injetar um
// runtime nos testes dele.
//
// O protocolo imitado é o da v0.20.3, medido contra o servidor rodando: aperto
// de mão `gateway.ready`, `session.create` / `prompt.submit` /
// `session.interrupt`, e os quadros `session.info` / `message.delta` /
// `message.complete` / `tool.start` / `tool.complete`.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHermesRuntime } from '../lib/server/agent/adapters/HermesRuntimeAdapter.js';
import {
  assertIsolamentoAnunciado, assertToolsetsSeguros, createHermesClient,
  HermesTransportError, TOOLSETS_OBRIGATORIOS,
} from '../lib/server/agent/hermes/runtimeClient.js';
import { assertRuntimePort } from '../lib/server/agent/AgentRuntimePort.js';
import { AGENT_EVENTS, declaredFieldsFor } from '../lib/server/agent/events.js';
import { openDatabase } from '../lib/server/domain/db.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import { ensureProject } from '../lib/server/domain/projects.js';
import {
  bindRuntimeSession, requireBindingBySession,
} from '../lib/server/agent/hermes/sessionBinding.js';
import {
  BRIDGE_SESSION_ID_FALSO, criarFetchFalso, criarWebSocketFalso, roteiroDeTexto,
  SESSION_ID_FALSO, TOOLS_ISOLADAS,
} from './helpers/runtimeFalso.mjs';

const relogio = () => 1000;

/** Um banco novo, em memória, com um projeto e uma thread. */
function bancoComThread() {
  const db = openDatabase(':memory:');
  const { project } = ensureProject('proj_teste', { name: 'Teste' }, db);
  const thread = createThreadRecord({ projectId: project.id }, db);
  return { db, thread, projeto: project };
}

/** O adaptador ligado a um runtime de mentira. */
function cenario({ roteiro = roteiroDeTexto(['Olá.']), tools = TOOLS_ISOLADAS, db = null } = {}) {
  const pedidos = [];
  const banco = db ?? bancoComThread().db;
  const webSocketImpl = criarWebSocketFalso({
    roteiro, tools, aoEnviar: (p) => pedidos.push(p),
  });
  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9',
    token: 'token-de-teste',
    db: banco,
    clock: relogio,
    fetchImpl: criarFetchFalso(),
    webSocketImpl,
  });
  return { runtime, pedidos, db: banco };
}

async function drenar(iteravel) {
  const saida = [];
  for await (const e of await iteravel) saida.push(e);
  return saida;
}

const falar = (runtime, thread, texto = 'oi') => drenar(
  runtime.run({ thread, messages: [{ role: 'user', content: texto }] }),
);

// ── contrato ────────────────────────────────────────────────────────────────

test('cumpre o AgentRuntimePort', () => {
  assert.doesNotThrow(() => assertRuntimePort(createHermesRuntime({ baseUrl: 'http://127.0.0.1:9' })));
});

test('sem URL configurada, fica indisponível com motivo legível', () => {
  const runtime = createHermesRuntime({ baseUrl: '' });
  assert.equal(runtime.isAvailable(), false);
  assert.match(runtime.unavailableReason(), /não está configurado/i);
  assert.equal(/hermes/i.test(runtime.unavailableReason()), false);
});

test('testConnection responde ok quando o serviço responde', async () => {
  const { runtime } = cenario();
  const resultado = await runtime.testConnection();
  assert.equal(resultado.ok, true);
  assert.deepEqual(resultado.detail.isolation, [...TOOLSETS_OBRIGATORIOS]);
});

test('testConnection não vaza o corpo nem o nome do serviço', async () => {
  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9',
    fetchImpl: async () => { throw new Error('ECONNREFUSED 127.0.0.1:8788'); },
    webSocketImpl: criarWebSocketFalso({}),
  });
  const resultado = await runtime.testConnection();
  assert.equal(resultado.ok, false);
  assert.equal(/hermes|8788|ECONNREFUSED/i.test(JSON.stringify(resultado)), false);
});

// ── autenticação ────────────────────────────────────────────────────────────

test('a credencial vai no socket, e só no socket', async () => {
  // O runtime exige token em toda rota privada. Ele é segredo de servidor: sai
  // daqui para o socket do runtime, e de lugar nenhum para lugar nenhum mais.
  let urlUsada = null;
  const WS = criarWebSocketFalso({ roteiro: roteiroDeTexto(['ok']) });
  class Espiao extends WS {
    constructor(url) { urlUsada = url; super(url); }
  }
  const { db, thread } = bancoComThread();
  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9', token: 'segredo-do-operador',
    db, clock: relogio, fetchImpl: criarFetchFalso(), webSocketImpl: Espiao,
  });
  await falar(runtime, thread);

  assert.match(urlUsada, /^ws:\/\/127\.0\.0\.1:9\/api\/ws\?token=segredo-do-operador$/);
});

test('sem credencial, o socket é aberto sem token — e o runtime é quem recusa', () => {
  // Não inventamos credencial: se o operador não configurou, o pedido vai como
  // está e a recusa vem do runtime. Fabricar um token aqui esconderia a falta.
  const cliente = createHermesClient({
    baseUrl: 'http://127.0.0.1:9', fetchImpl: criarFetchFalso(),
    webSocketImpl: criarWebSocketFalso({}),
  });
  assert.equal(cliente.baseUrl, 'http://127.0.0.1:9');
});

// ── isolamento ──────────────────────────────────────────────────────────────

test('os valores que concedem acesso total são recusados na origem', () => {
  for (const perigoso of [['all'], ['*'], ['showrunner', 'all'], []]) {
    assert.throws(() => assertToolsetsSeguros(perigoso), HermesTransportError);
  }
});

test('o isolamento é conferido contra o que o runtime ANUNCIA ter dado', () => {
  assert.doesNotThrow(() => assertIsolamentoAnunciado(TOOLS_ISOLADAS));
});

test('um toolset a mais é recusado mesmo sendo inofensivo', () => {
  // A regra não é "nada perigoso": é "nada além do combinado". Um toolset
  // inócuo hoje é o precedente que deixa passar o perigoso amanhã.
  assert.throws(() => assertIsolamentoAnunciado({ showrunner: [], todo: ['todo'] }),
    HermesTransportError);
  // E a sentinela que o runtime novo ignora não conta como combinada.
  assert.throws(() => assertIsolamentoAnunciado({ showrunner: [], no_mcp: [] }),
    HermesTransportError);
});

test('um toolset a mais no anúncio derruba o turno', async () => {
  // O corte de isolamento migrou para o ambiente do runtime (HERMES_TUI_TOOLSETS).
  // Se ele falhar, quem percebe é isto: o runtime anuncia o que deu ao modelo, e
  // um terminal no anúncio é motivo para não deixar o turno seguir.
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({
    db,
    tools: { showrunner: ['og_generate_image'], terminal: ['terminal', 'process'] },
  });
  await assert.rejects(() => falar(runtime, thread), /isolamento/i);
});

test('um anúncio sem o toolset do Showrunner também derrubaria o turno', () => {
  assert.throws(() => assertIsolamentoAnunciado({ terminal: ['terminal'] }), HermesTransportError);
  assert.throws(() => assertIsolamentoAnunciado(null), HermesTransportError);
});

// ── sessão ──────────────────────────────────────────────────────────────────

test('a sessão é gravada e reaproveitada entre turnos da mesma conversa', async () => {
  const { db, thread } = bancoComThread();
  const { runtime, pedidos } = cenario({ db, roteiro: roteiroDeTexto(['Olá.']) });

  await falar(runtime, thread, 'um');
  await falar(runtime, thread, 'dois');

  const criacoes = pedidos.filter((p) => p.method === 'session.create');
  assert.equal(criacoes.length, 1, 'criou sessão duas vezes para a mesma conversa');

  const vinculos = db.prepare('SELECT * FROM runtime_sessions').all();
  assert.equal(vinculos.length, 1);
  assert.equal(vinculos[0].sessionId, SESSION_ID_FALSO);
  assert.equal(vinculos[0].threadId, thread.id);
});

test('duas conversas nunca compartilham a mesma sessão', async () => {
  const { db } = bancoComThread();
  const t1 = createThreadRecord({ projectId: 'proj_teste' }, db);
  const t2 = createThreadRecord({ projectId: 'proj_teste' }, db);

  // Cada conversa fala com um socket próprio, que devolve um id próprio.
  for (const [thread, sessionId, bridgeSessionId] of [
    [t1, 'sessao_um_1234', 'durav_um_0001'],
    [t2, 'sessao_dois_123', 'durav_dois_0002'],
  ]) {
    const runtime = createHermesRuntime({
      baseUrl: 'http://127.0.0.1:9', db, clock: relogio,
      fetchImpl: criarFetchFalso(),
      webSocketImpl: criarWebSocketFalso({ roteiro: roteiroDeTexto(['ok']), sessionId, bridgeSessionId }),
    });
    await falar(runtime, thread);
  }

  const vinculos = db.prepare('SELECT * FROM runtime_sessions ORDER BY threadId').all();
  assert.equal(vinculos.length, 2);
  assert.notEqual(vinculos[0].sessionId, vinculos[1].sessionId);
});

test('o turno pergunta pela sessão gravada, e não cria outra', async () => {
  const { db, thread } = bancoComThread();
  const { runtime, pedidos } = cenario({ db });
  await falar(runtime, thread);

  const submissoes = pedidos.filter((p) => p.method === 'prompt.submit');
  assert.equal(submissoes.length, 1);
  assert.equal(submissoes[0].params.session_id, SESSION_ID_FALSO);
  assert.equal(submissoes[0].params.text, 'oi');
});

// ── o turno ─────────────────────────────────────────────────────────────────

test('um turno produz o vocabulário do Showrunner, em ordem', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({ db, roteiro: roteiroDeTexto(['Olá', ', tudo bem?']) });
  const eventos = await falar(runtime, thread);

  const tipos = eventos.map((e) => e.type);
  assert.equal(tipos[0], AGENT_EVENTS.STARTED);
  assert.equal(tipos[1], AGENT_EVENTS.STATUS);
  assert.ok(tipos.includes(AGENT_EVENTS.MESSAGE_DELTA));
  assert.equal(tipos.at(-2), AGENT_EVENTS.MESSAGE_COMPLETED);
  assert.equal(tipos.at(-1), AGENT_EVENTS.COMPLETED);

  const completa = eventos.find((e) => e.type === AGENT_EVENTS.MESSAGE_COMPLETED);
  assert.equal(completa.text, 'Olá, tudo bem?');
});

test('nenhum evento carrega campo fora do vocabulário', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({ db, roteiro: roteiroDeTexto(['Oi.']) });
  const eventos = await falar(runtime, thread);

  for (const evento of eventos) {
    const permitidos = new Set(['type', 'ts', ...declaredFieldsFor(evento.type)]);
    for (const campo of Object.keys(evento)) {
      assert.ok(permitidos.has(campo), `${evento.type} carrega "${campo}"`);
    }
  }
});

test('nada da identidade do runtime atravessa', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({
    db,
    roteiro: [
      { type: 'thinking.delta', payload: { text: 'Planning terminal tooling' } },
      { type: 'session.title', payload: { title: 'Hermes chat' } },
      { type: 'reasoning.available', payload: { ok: true } },
      ...roteiroDeTexto(['Pronto.']),
    ],
  });
  const eventos = await falar(runtime, thread);
  const texto = JSON.stringify(eventos);

  for (const proibido of [/hermes/i, /session_id/, /stream_id/, /enabled_toolsets/,
    /no_mcp/, /gateway/i, /prompt\.submit/, /jsonrpc/i, /Planning terminal/i,
    new RegExp(SESSION_ID_FALSO)]) {
    assert.equal(proibido.test(texto), false, `vazou ${proibido}`);
  }
});

test('o raciocínio privado do modelo nunca vira delta', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({
    db,
    roteiro: [
      { type: 'thinking.delta', payload: { text: 'O usuário quer uma imagem; vou usar o terminal' } },
      { type: 'reasoning.delta', payload: { text: 'segredo' } },
      ...roteiroDeTexto(['Vou gerar a imagem.']),
    ],
  });
  const eventos = await falar(runtime, thread);
  const deltas = eventos.filter((e) => e.type === AGENT_EVENTS.MESSAGE_DELTA).map((e) => e.text);
  assert.deepEqual(deltas, ['Vou gerar a imagem.']);
});

test('o status é texto nosso, não o rótulo do runtime', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({
    db,
    roteiro: [
      { type: 'status.update', payload: { kind: 'tool_running', text: 'executing terminal' } },
      ...roteiroDeTexto(['ok']),
    ],
  });
  const eventos = await falar(runtime, thread);
  const status = eventos.filter((e) => e.type === AGENT_EVENTS.STATUS);
  assert.equal(status.length, 1);
  assert.equal(status[0].status, 'Pensando');
});

test('quadro desconhecido do runtime simplesmente some', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({
    db,
    roteiro: [
      { type: 'algo.que.ainda.nao.existe', payload: { segredo: 'interno' } },
      ...roteiroDeTexto(['ok']),
    ],
  });
  const eventos = await falar(runtime, thread);
  assert.equal(/algo\.que|segredo|interno/.test(JSON.stringify(eventos)), false);
});

// ── ferramentas ─────────────────────────────────────────────────────────────

test('tool do runtime vira evento com nome canônico', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({
    db,
    roteiro: [
      { type: 'tool.start', payload: { tool_id: 'c1', name: 'og_generate_image', args: { prompt: 'x' } } },
      { type: 'tool.complete', payload: { tool_id: 'c1', name: 'og_generate_image' } },
      ...roteiroDeTexto(['Pronto.']),
    ],
  });
  const eventos = await falar(runtime, thread);

  const iniciada = eventos.find((e) => e.type === AGENT_EVENTS.TOOL_STARTED);
  const terminada = eventos.find((e) => e.type === AGENT_EVENTS.TOOL_COMPLETED);
  assert.equal(iniciada.name, 'og.generate_image');
  assert.equal(terminada.name, 'og.generate_image');
  assert.equal(/og_generate/.test(JSON.stringify(eventos)), false);
});

test('tool que o runtime inventou não vira evento', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({
    db,
    roteiro: [
      { type: 'tool.start', payload: { tool_id: 'c1', name: 'terminal', args: { cmd: 'rm -rf /' } } },
      ...roteiroDeTexto(['ok']),
    ],
  });
  const eventos = await falar(runtime, thread);
  assert.equal(eventos.some((e) => e.type === AGENT_EVENTS.TOOL_STARTED), false);
  assert.equal(/terminal|rm -rf/.test(JSON.stringify(eventos)), false);
});

test('o resultado da ferramenta vem do bridge, não do runtime', async () => {
  const { db, thread } = bancoComThread();
  const turns = {
    begin() {}, end() {},
    takeResult: (_sid, nome) => (nome === 'og.generate_image'
      ? { jobId: 'job_1', status: 'completed', asset: { id: 'asset_1', kind: 'image', mediaUrl: '/api/media/x.png' } }
      : null),
  };
  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9', db, clock: relogio, turns,
    fetchImpl: criarFetchFalso(),
    webSocketImpl: criarWebSocketFalso({
      roteiro: [
        { type: 'tool.start', payload: { tool_id: 'c1', name: 'og_generate_image' } },
        { type: 'tool.complete', payload: { tool_id: 'c1', name: 'og_generate_image', result: 'preview truncado…' } },
        ...roteiroDeTexto(['Pronto.']),
      ],
    }),
  });
  const eventos = await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'gera' }] }));

  const terminada = eventos.find((e) => e.type === AGENT_EVENTS.TOOL_COMPLETED);
  assert.equal(terminada.result.asset.id, 'asset_1');
  assert.equal(/preview truncado/.test(JSON.stringify(eventos)), false);
});

// ── falhas e cancelamento ───────────────────────────────────────────────────

test('erro do runtime vira falha traduzida', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({
    db,
    roteiro: [{
      type: 'message.complete',
      payload: { text: 'Error: provider 429 rate_limit from api.openai.com', status: 'error' },
    }],
  });
  const eventos = await falar(runtime, thread);

  const falha = eventos.find((e) => e.type === AGENT_EVENTS.FAILED);
  assert.ok(falha);
  assert.equal(falha.error.code, 'agent_runtime_failed');
  assert.equal(/429|openai|provider|rate_limit/i.test(JSON.stringify(eventos)), false);
});

test('socket recusado vira erro de transporte, sem detalhe de rede', async () => {
  const { db, thread } = bancoComThread();
  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9', db, clock: relogio,
    fetchImpl: criarFetchFalso(),
    webSocketImpl: criarWebSocketFalso({ recusarAbertura: true }),
  });
  await assert.rejects(() => falar(runtime, thread), HermesTransportError);
});

test('abortar interrompe o fluxo e pede cancelamento ao runtime', async () => {
  const { db, thread } = bancoComThread();
  const pedidos = [];
  const controlador = new AbortController();
  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9', db, clock: relogio,
    fetchImpl: criarFetchFalso(),
    webSocketImpl: criarWebSocketFalso({
      roteiro: roteiroDeTexto(['um', 'dois', 'três']),
      aoEnviar: (p) => pedidos.push(p),
    }),
  });

  const fluxo = runtime.run({
    thread, messages: [{ role: 'user', content: 'oi' }], signal: controlador.signal,
  });
  const vistos = [];
  for await (const evento of fluxo) {
    vistos.push(evento.type);
    if (evento.type === AGENT_EVENTS.MESSAGE_DELTA) { controlador.abort(); break; }
  }
  await fluxo.return?.();

  assert.ok(vistos.includes(AGENT_EVENTS.MESSAGE_DELTA));
  assert.ok(pedidos.some((p) => p.method === 'session.interrupt'),
    'o cancelamento não foi pedido ao runtime');
});

test('turno sem fala do usuário falha alto', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({ db });
  await assert.rejects(
    () => drenar(runtime.run({ thread, messages: [{ role: 'assistant', content: 'oi' }] })),
    /mensagem de usuário/i,
  );
});

test('turno sem conversa falha alto', async () => {
  const { db } = bancoComThread();
  const { runtime } = cenario({ db });
  await assert.rejects(() => drenar(runtime.run({ messages: [] })), HermesTransportError);
});


// ── os dois nomes da sessão ─────────────────────────────────────────────────

test('a sessão é gravada com os DOIS nomes que o runtime usa', async () => {
  // Regressão do port para a v0.20.3: o runtime entrega ao adaptador o id do
  // gateway e ao plugin o id durável. Gravando só o primeiro, toda chamada de
  // ferramenta voltava como "sessão desconhecida" — o bridge procurava por um
  // nome que nunca tinha sido gravado.
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({ db });
  await falar(runtime, thread);

  const vinculo = db.prepare('SELECT * FROM runtime_sessions').get();
  assert.equal(vinculo.sessionId, SESSION_ID_FALSO);
  assert.equal(vinculo.bridgeSessionId, BRIDGE_SESSION_ID_FALSO);
});

test('o bridge encontra a sessão por qualquer um dos dois nomes', async () => {
  const { db, thread } = bancoComThread();
  const { runtime } = cenario({ db });
  await falar(runtime, thread);

  // O adaptador consulta pelo id do gateway; o plugin, pelo durável. Os dois
  // precisam chegar na mesma conversa.
  for (const nome of [SESSION_ID_FALSO, BRIDGE_SESSION_ID_FALSO]) {
    const vinculo = requireBindingBySession(nome, db);
    assert.equal(vinculo.threadId, thread.id);
  }
});

test('um runtime com um nome só continua funcionando', () => {
  // O Echo não tem dois identificadores, e a coluna é anulável por isso.
  const { db, thread } = bancoComThread();
  const vinculo = bindRuntimeSession({
    sessionId: 'sessao_simples_1', threadId: thread.id, runtimeId: 'echo', now: 1,
  }, db);
  assert.equal(vinculo.bridgeSessionId, null);
  assert.equal(requireBindingBySession('sessao_simples_1', db).threadId, thread.id);
});
