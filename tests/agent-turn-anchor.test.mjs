// PASSO 10.0 — a âncora durável do turno.
//
// Um trabalho de geração que sobreviva ao reinício do processo vai precisar
// saber a que TURNO pertencia. "A última mensagem da conversa" não responde
// isso: o usuário pode ter falado de novo enquanto a imagem renderizava, e aí a
// última mensagem é de outro assunto.
//
// A âncora não precisou ser inventada. O gateway grava a fala do usuário no
// banco ANTES de o runtime começar a pensar — portanto antes de qualquer
// ferramenta poder rodar. Um turno É a mensagem que o iniciou, e essa mensagem
// já tem chave primária e ordem única.
//
// O que esta etapa faz é levar esse identificador até o ToolContext confiável,
// pelos DOIS caminhos de execução:
//
//   A. gateway → criarInvokeTool → registry        (runtime chama invokeTool)
//   B. plugin → socket → bridge → registry         (runtime chama por fora)
//
// O caminho B é o que exige cuidado: pelo socket chegam três campos e o turno
// não é um deles. Quem sabe qual turno está em curso é o registro que o
// adaptador anuncia — e é de lá que a âncora sai.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../lib/server/domain/db.js';
import { createProject, ensureProject } from '../lib/server/domain/projects.js';
import { createThreadRecord, listMessageRecords } from '../lib/server/agent/threads.js';
import { createThread, sendMessage, streamMessage } from '../lib/server/agent/gateway.js';
import { handleStreamMessage } from '../lib/server/agent/httpApi.js';
import { AGENT_EVENTS, publicAgentEvent } from '../lib/server/agent/events.js';
import {
  createActiveTurnRegistry, handleBridgeInvocation,
} from '../lib/server/agent/hermes/bridge.js';
import { bindRuntimeSession } from '../lib/server/agent/hermes/sessionBinding.js';
import { createToolRegistry, publicToolList, setToolRegistry } from '../lib/server/agent/tools/registry.js';
import { defineTool } from '../lib/server/agent/tools/schema.js';
import { generateImageTool } from '../lib/server/agent/tools/handlers/generateImage.js';
import { generateVideoTool } from '../lib/server/agent/tools/handlers/generateVideo.js';
import { getJobTool } from '../lib/server/agent/tools/handlers/getJob.js';
import { createHermesRuntime } from '../lib/server/agent/adapters/HermesRuntimeAdapter.js';
import {
  criarFetchFalso, criarWebSocketFalso, roteiroDeTexto, SESSION_ID_FALSO,
} from './helpers/runtimeFalso.mjs';

const relogio = () => 1000;

// ── cenário ─────────────────────────────────────────────────────────────────

function cenario() {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_ancora', name: 'Âncora' }, db);
  const thread = createThread({ projectId: 'proj_ancora' }, { db });
  return { db, thread };
}

/** Um registry que anota o ToolContext com que cada ferramenta foi chamada. */
function registryEspiao(nome = 'og.get_job') {
  const chamadas = [];
  return {
    chamadas,
    registry: {
      invoke: async (toolName, context, args) => {
        chamadas.push({ toolName, context, args });
        return { ok: true };
      },
      hasTool: (n) => n === nome,
      getTool: () => { throw new Error('não usado'); },
      listTools: () => [],
    },
  };
}

/** Um runtime que chama uma ferramenta pelo `invokeTool` do contrato. */
function runtimeQueChamaTool(nome = 'og.generate_image', args = { prompt: 'x' }) {
  return {
    id: 'roteiro',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run({ invokeTool }) {
      yield { type: AGENT_EVENTS.STARTED, ts: 1 };
      const resultado = await invokeTool(nome, args);
      yield {
        type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1', name: nome, result: resultado,
      };
      yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Feito.' };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };
}

/** Instala um registry de ferramentas só para este processo de teste. */
function instalarFerramenta(execute, nome = 'og.generate_image') {
  setToolRegistry(createToolRegistry([defineTool({
    name: nome,
    description: 'ferramenta de teste',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    execute,
  })]));
}

// ── A · a âncora existe antes de a ferramenta poder rodar ───────────────────

test('A. a fala do usuário está no banco ANTES de o runtime começar', async () => {
  const { db, thread } = cenario();
  let gravadasQuandoOTurnoComecou = null;

  const runtime = {
    id: 'observador',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run() {
      // O runtime olha o banco no instante em que começa a pensar.
      gravadasQuandoOTurnoComecou = listMessageRecords(thread.id, db);
      yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'ok' };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };

  const turno = await sendMessage({ threadId: thread.id, content: 'crie algo' }, { db, runtime });

  assert.equal(gravadasQuandoOTurnoComecou.length, 1);
  assert.equal(gravadasQuandoOTurnoComecou[0].role, 'user');
  assert.equal(gravadasQuandoOTurnoComecou[0].id, turno.userMessage.id);
  // É esta ordem que torna a âncora durável: ela já está gravada quando o
  // primeiro risco aparece.
  assert.match(turno.userMessage.id, /^msg_/);

  db.close();
});

// ── B · caminho direto ──────────────────────────────────────────────────────

test('B. o ToolContext do caminho direto carrega a âncora do turno', async () => {
  const { db, thread } = cenario();
  const contextos = [];

  instalarFerramenta(async (ctx) => {
    contextos.push(ctx);
    return { jobId: 'job_1', kind: 'image', status: 'gerando' };
  });

  const turno = await sendMessage(
    { threadId: thread.id, content: 'crie uma imagem' },
    { db, runtime: runtimeQueChamaTool() },
  );

  assert.equal(contextos.length, 1);
  assert.equal(contextos[0].userMessageId, turno.userMessage.id);
  assert.equal(contextos[0].threadId, thread.id);
  assert.equal(contextos[0].projectId, 'proj_ancora');
  // Nada foi procurado depois: o identificador já estava na mão.
  assert.deepEqual(
    Object.keys(contextos[0]).sort(),
    ['projectId', 'signal', 'threadId', 'userMessageId'],
  );

  db.close();
});

test('B-bis. dois turnos na MESMA conversa recebem âncoras diferentes', async () => {
  const { db, thread } = cenario();
  const contextos = [];

  instalarFerramenta(async (ctx) => {
    contextos.push(ctx.userMessageId);
    return { ok: true };
  });

  const primeiro = await sendMessage({ threadId: thread.id, content: 'um' }, { db, runtime: runtimeQueChamaTool() });
  const segundo = await sendMessage({ threadId: thread.id, content: 'dois' }, { db, runtime: runtimeQueChamaTool() });

  assert.deepEqual(contextos, [primeiro.userMessage.id, segundo.userMessage.id]);
  assert.notEqual(contextos[0], contextos[1]);

  db.close();
});

// ── C · caminho do plugin ───────────────────────────────────────────────────

/** Uma sessão de runtime ligada a uma thread, como o adaptador grava. */
function sessaoLigada(db, threadId, sessionId) {
  bindRuntimeSession({ sessionId, threadId, runtimeId: 'hermes' }, db);
  return sessionId;
}

test('C. o bridge monta o ToolContext com a âncora do turno anunciado', async () => {
  const db = openDatabase(':memory:');
  ensureProject('proj_ancora', { name: 'Âncora' }, db);
  const thread = createThreadRecord({ projectId: 'proj_ancora' }, db);
  const { registry, chamadas } = registryEspiao();
  const turns = createActiveTurnRegistry();
  sessaoLigada(db, thread.id, 'sess_a');

  turns.begin('sess_a', { signal: null, userMessageId: 'msg_do_turno' });

  await handleBridgeInvocation(
    { sessionId: 'sess_a', toolName: 'og_get_job', arguments: { jobId: 'j' } },
    { db, registry, turns },
  );

  assert.equal(chamadas[0].context.userMessageId, 'msg_do_turno');
  assert.equal(chamadas[0].context.threadId, thread.id);
  assert.equal(chamadas[0].context.projectId, 'proj_ancora');

  db.close();
});

test('C-bis. fora de um turno anunciado a âncora é null, nunca inventada', async () => {
  const db = openDatabase(':memory:');
  ensureProject('proj_ancora', { name: 'Âncora' }, db);
  const thread = createThreadRecord({ projectId: 'proj_ancora' }, db);
  const { registry, chamadas } = registryEspiao();
  const turns = createActiveTurnRegistry();
  sessaoLigada(db, thread.id, 'sess_a');

  // Nenhum `begin`: o runtime chamou por fora de um turno nosso.
  await handleBridgeInvocation(
    { sessionId: 'sess_a', toolName: 'og_get_job', arguments: { jobId: 'j' } },
    { db, registry, turns },
  );

  assert.equal(chamadas[0].context.userMessageId, null);
  // E a mensagem mais recente da conversa NÃO foi usada como substituta.
  assert.equal(chamadas[0].context.threadId, thread.id);

  db.close();
});

// ── D · o socket não é fonte da âncora ──────────────────────────────────────

test('D. o bridge ignora userMessageId vindo do payload', async () => {
  const db = openDatabase(':memory:');
  ensureProject('proj_ancora', { name: 'Âncora' }, db);
  const thread = createThreadRecord({ projectId: 'proj_ancora' }, db);
  const { registry, chamadas } = registryEspiao();
  const turns = createActiveTurnRegistry();
  sessaoLigada(db, thread.id, 'sess_a');

  turns.begin('sess_a', { userMessageId: 'msg_verdadeiro' });

  // O chamador tenta injetar outra âncora, no topo do payload.
  await handleBridgeInvocation(
    {
      sessionId: 'sess_a',
      toolName: 'og_get_job',
      userMessageId: 'msg_forjado',
      threadId: 'thread_forjada',
      projectId: 'proj_forjado',
      arguments: { jobId: 'j' },
    },
    { db, registry, turns },
  );

  const { context } = chamadas[0];
  assert.equal(context.userMessageId, 'msg_verdadeiro', 'o payload sobrescreveu a âncora');
  assert.equal(context.threadId, thread.id);
  assert.equal(context.projectId, 'proj_ancora');

  db.close();
});

test('D-bis. e uma âncora forjada nos ARGUMENTOS morre na própria ferramenta', async () => {
  // O outro caminho que um modelo tentaria: mandar o campo como argumento da
  // ferramenta. As tools recusam propriedade desconhecida.
  await assert.rejects(
    () => generateImageTool.execute(
      { threadId: 't', projectId: 'p', userMessageId: 'msg_verdadeiro', signal: null },
      { prompt: 'x', userMessageId: 'msg_forjado' },
      { iniciar: async () => ({ jobId: 'j', kind: 'image', status: 'gerando' }), acompanhar: () => null },
    ),
    (erro) => {
      assert.equal(erro.name, 'ToolExecutionError');
      assert.match(erro.message, /Propriedades desconhecidas/);
      return true;
    },
  );
});

// ── E · concorrência ────────────────────────────────────────────────────────

test('E. duas sessões simultâneas não cruzam a âncora', async () => {
  const db = openDatabase(':memory:');
  ensureProject('proj_a', { name: 'A' }, db);
  ensureProject('proj_b', { name: 'B' }, db);
  const threadA = createThreadRecord({ projectId: 'proj_a' }, db);
  const threadB = createThreadRecord({ projectId: 'proj_b' }, db);
  const { registry, chamadas } = registryEspiao();
  const turns = createActiveTurnRegistry();

  sessaoLigada(db, threadA.id, 'sess_a');
  sessaoLigada(db, threadB.id, 'sess_b');

  // Os dois turnos correm ao mesmo tempo — nada de "turno corrente" global.
  turns.begin('sess_a', { userMessageId: 'msg_A' });
  turns.begin('sess_b', { userMessageId: 'msg_B' });
  assert.equal(turns.size(), 2);

  await Promise.all([
    handleBridgeInvocation({ sessionId: 'sess_a', toolName: 'og_get_job', arguments: { jobId: 'a' } }, { db, registry, turns }),
    handleBridgeInvocation({ sessionId: 'sess_b', toolName: 'og_get_job', arguments: { jobId: 'b' } }, { db, registry, turns }),
  ]);

  const porThread = new Map(chamadas.map((c) => [c.context.threadId, c.context.userMessageId]));
  assert.equal(porThread.get(threadA.id), 'msg_A');
  assert.equal(porThread.get(threadB.id), 'msg_B');

  // E encerrar um turno não toca no outro.
  turns.end('sess_a');
  assert.equal(turns.turnFor('sess_a'), null);
  assert.equal(turns.turnFor('sess_b').userMessageId, 'msg_B');

  db.close();
});

// ── F · G · H · o contexto não sobrevive ao turno ───────────────────────────

/** O adaptador contra um runtime de mentira, com registro de turnos injetado. */
function adaptadorComTurns(turns, { roteiro = roteiroDeTexto(['Olá.']) } = {}) {
  const db = openDatabase(':memory:');
  ensureProject('proj_ancora', { name: 'Âncora' }, db);
  const thread = createThreadRecord({ projectId: 'proj_ancora' }, db);

  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9',
    token: 'token-de-teste',
    db,
    clock: relogio,
    turns,
    fetchImpl: criarFetchFalso(),
    webSocketImpl: criarWebSocketFalso({ roteiro }),
  });

  return { db, thread, runtime };
}

const drenar = async (fluxo) => { for await (const _ of fluxo) { /* consome */ } };

test('F. o turno normal anuncia a âncora e a remove ao terminar', async () => {
  const turns = createActiveTurnRegistry();
  const { db, thread, runtime } = adaptadorComTurns(turns);
  const vistos = [];

  // Espia o registro no meio do turno, sem alterar o comportamento dele.
  const beginOriginal = turns.begin.bind(turns);
  turns.begin = (sid, ctx) => { vistos.push({ sid, ...ctx }); beginOriginal(sid, ctx); };

  await drenar(await runtime.run({
    thread,
    messages: [{ role: 'user', content: 'oi' }],
    context: { threadId: thread.id, projectId: 'proj_ancora', userMessageId: 'msg_do_turno' },
    signal: null,
  }));

  assert.equal(vistos.length, 1);
  assert.equal(vistos[0].userMessageId, 'msg_do_turno');
  assert.equal(vistos[0].sid, SESSION_ID_FALSO);

  // E não sobrou nada: o `finally` do adaptador desanuncia.
  assert.equal(turns.size(), 0);
  assert.equal(turns.turnFor(SESSION_ID_FALSO), null);

  db.close();
});

test('G. o turno que FALHA no meio também remove a âncora', async () => {
  const turns = createActiveTurnRegistry();
  // Um roteiro que termina em erro do runtime.
  const { db, thread, runtime } = adaptadorComTurns(turns, {
    roteiro: [{ type: 'message.complete', payload: { status: 'error' } }],
  });

  await drenar(await runtime.run({
    thread,
    messages: [{ role: 'user', content: 'oi' }],
    context: { userMessageId: 'msg_do_turno' },
    signal: null,
  }));

  assert.equal(turns.size(), 0, 'a âncora ficou presa depois de uma falha');

  db.close();
});

test('H. o turno CANCELADO também remove a âncora', async () => {
  const turns = createActiveTurnRegistry();
  const { db, thread, runtime } = adaptadorComTurns(turns);
  const controlador = new AbortController();
  controlador.abort();

  await drenar(await runtime.run({
    thread,
    messages: [{ role: 'user', content: 'oi' }],
    context: { userMessageId: 'msg_do_turno' },
    signal: controlador.signal,
  }));

  assert.equal(turns.size(), 0, 'a âncora ficou presa depois de um cancelamento');

  db.close();
});

test('F-bis. um turno sem conversa nem chega a anunciar âncora', async () => {
  const turns = createActiveTurnRegistry();
  const { db, runtime } = adaptadorComTurns(turns);

  await assert.rejects(() => drenar(runtime.run({
    thread: null,
    messages: [{ role: 'user', content: 'oi' }],
    context: { userMessageId: 'msg_do_turno' },
  })));

  assert.equal(turns.size(), 0);

  db.close();
});

// ── I · a âncora não é superfície pública ───────────────────────────────────

test('I. userMessageId não aparece no SSE nem em publicAgentEvent', async () => {
  const { db, thread } = cenario();

  instalarFerramenta(async (ctx) => (
    // Uma ferramenta MALDOSA que devolve a âncora no resultado. Nem assim ela
    // chega ao navegador: a redução pública só deixa passar o Asset.
    { jobId: 'job_1', userMessageId: ctx.userMessageId, status: 'gerando' }
  ));

  const { stream } = handleStreamMessage(
    { threadId: thread.id, content: 'crie' },
    { db, runtime: runtimeQueChamaTool() },
  );

  const blocos = [];
  for await (const bloco of stream) blocos.push(bloco);

  const texto = JSON.stringify(blocos);
  assert.ok(!texto.includes('userMessageId'), 'o nome do campo atravessou');

  const daThread = listMessageRecords(thread.id, db);
  const doUsuario = daThread.find((m) => m.role === 'user');
  assert.ok(!texto.includes(doUsuario.id), 'o id da mensagem do usuário atravessou');

  db.close();
});

test('I-bis. publicAgentEvent não deixa passar a âncora nem em tool.started', () => {
  const publico = publicAgentEvent({
    type: AGENT_EVENTS.TOOL_STARTED,
    ts: 1,
    toolCallId: 'c1',
    name: 'og.get_job',
    arguments: { userMessageId: 'msg_secreto' },
  });
  assert.ok(!('arguments' in publico));
  assert.ok(!JSON.stringify(publico).includes('msg_secreto'));
});

// ── J · a âncora não é assunto do modelo ────────────────────────────────────

test('J. nenhuma ferramenta pede userMessageId no schema público', () => {
  const publicas = publicToolList(createToolRegistry([
    generateImageTool, generateVideoTool, getJobTool,
  ]));

  assert.equal(publicas.length, 3);
  for (const tool of publicas) {
    const texto = JSON.stringify(tool);
    assert.ok(!texto.includes('userMessageId'), `${tool.name} pede userMessageId`);
    assert.ok(!texto.includes('threadId'), `${tool.name} pede threadId`);
    assert.ok(!texto.includes('projectId'), `${tool.name} pede projectId`);
    // E o schema continua sem `execute`, como sempre.
    assert.deepEqual(Object.keys(tool).sort(), ['description', 'inputSchema', 'name']);
  }
});

// ── K · L · M · nada regrediu ───────────────────────────────────────────────

test('K. a identidade pública continua sendo Showrunner', async () => {
  const { db, thread } = cenario();
  const r = await sendMessage({ threadId: thread.id, content: 'quem é você?' }, {
    db,
    runtime: {
      id: 'roteiro',
      isAvailable: () => true,
      unavailableReason: () => null,
      testConnection: async () => ({ ok: true }),
      async* run() {
        yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Sou o Showrunner.' };
        yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
      },
    },
  });

  assert.equal(r.assistantMessage.content, 'Sou o Showrunner.');
  assert.ok(!/Recebi:/.test(r.assistantMessage.content));

  db.close();
});

test('L. a amarração do Passo 9 continua funcionando com o contexto novo', async () => {
  const { db, thread } = cenario();
  const contextos = [];

  instalarFerramenta(async (ctx) => {
    contextos.push(ctx);
    return { jobId: 'job_passo9', kind: 'image', status: 'gerando' };
  });

  const turno = await sendMessage(
    { threadId: thread.id, content: 'crie uma imagem' },
    { db, runtime: runtimeQueChamaTool() },
  );

  // A ferramenta recebeu a âncora, e o turno continuou fechando como antes:
  // resposta gravada, jobId disponível ao gateway para a amarração.
  assert.equal(contextos[0].userMessageId, turno.userMessage.id);
  assert.equal(turno.assistantMessage.content, 'Feito.');
  const concluida = turno.events.find((e) => e.type === AGENT_EVENTS.TOOL_COMPLETED);
  assert.ok(concluida, 'o evento de conclusão da ferramenta sumiu');

  db.close();
});

test('M. "Nova conversa" continua criando outra thread, sem herdar turno', async () => {
  const { db, thread } = cenario();
  const contextos = [];

  instalarFerramenta(async (ctx) => { contextos.push(ctx); return { ok: true }; });

  const naAntiga = await sendMessage(
    { threadId: thread.id, content: 'primeira' }, { db, runtime: runtimeQueChamaTool() },
  );

  const nova = createThread({ projectId: 'proj_ancora' }, { db });
  assert.notEqual(nova.id, thread.id);

  const naNova = await sendMessage(
    { threadId: nova.id, content: 'segunda' }, { db, runtime: runtimeQueChamaTool() },
  );

  assert.equal(contextos[0].threadId, thread.id);
  assert.equal(contextos[0].userMessageId, naAntiga.userMessage.id);
  assert.equal(contextos[1].threadId, nova.id);
  assert.equal(contextos[1].userMessageId, naNova.userMessage.id);
  assert.notEqual(contextos[0].userMessageId, contextos[1].userMessageId);

  // E a conversa antiga continua inteira.
  assert.equal(listMessageRecords(thread.id, db).length, 2);

  db.close();
});
