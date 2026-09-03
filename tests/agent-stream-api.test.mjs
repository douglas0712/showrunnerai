// A boundary de streaming do Showrunner.
//
// O que trafega em /api/agent/stream é o vocabulário de `events.js` e nada
// além dele. O navegador nunca vê protocolo de runtime — e estes testes são o
// que garante isso quando alguém acrescentar um campo "só para depurar".

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleStreamMessage } from '../lib/server/agent/httpApi.js';
import { streamMessage, createThread, sendMessage } from '../lib/server/agent/gateway.js';
import { AGENT_EVENTS, declaredFieldsFor } from '../lib/server/agent/events.js';
import { createEchoRuntime } from '../lib/server/agent/adapters/EchoRuntimeAdapter.js';
import { openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';

const relogio = () => 1000;

function cenario() {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_stream', name: 'Stream' }, db);
  const thread = createThread({ projectId: 'proj_stream' }, { db });
  return { db, thread, runtime: createEchoRuntime({ clock: relogio }) };
}

async function coletar(iteravel) {
  const itens = [];
  for await (const item of iteravel) itens.push(item);
  return itens;
}

/** Um runtime que emite exatamente o roteiro dado. */
function runtimeDeRoteiro(eventos) {
  return {
    id: 'roteiro',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run() { for (const e of eventos) yield e; },
  };
}

test('o fluxo entrega os eventos um a um, no vocabulário do Showrunner', async () => {
  const { db, thread, runtime } = cenario();
  const { status, stream } = handleStreamMessage(
    { threadId: thread.id, content: 'oi' }, { db, runtime },
  );

  assert.equal(status, 200);
  const blocos = await coletar(stream);

  const tipos = blocos.map((b) => b.event);
  assert.equal(tipos[0], AGENT_EVENTS.STARTED);
  assert.ok(tipos.includes(AGENT_EVENTS.MESSAGE_DELTA));
  assert.equal(tipos.at(-1), AGENT_EVENTS.COMPLETED);

  // O nome do evento SSE é o próprio tipo — nenhuma tradução no meio.
  for (const bloco of blocos) assert.equal(bloco.event, bloco.data.type);
});

test('nenhum evento do fluxo carrega campo fora do vocabulário', async () => {
  const { db, thread, runtime } = cenario();
  const { stream } = handleStreamMessage({ threadId: thread.id, content: 'oi' }, { db, runtime });

  for (const { data } of await coletar(stream)) {
    const permitidos = declaredFieldsFor(data.type);
    for (const campo of Object.keys(data)) {
      assert.ok(permitidos.includes(campo), `"${campo}" não é declarado em ${data.type}`);
    }
  }
});

test('corpo inválido vira status, e não um fluxo que falha depois', async () => {
  // Depois do primeiro byte não há mais status disponível — então a validação
  // acontece antes de abrir o fluxo.
  const { db, runtime } = cenario();
  for (const corpo of [null, 'texto', {}, { threadId: 'x' }, { threadId: 1, content: 'a' }]) {
    const r = handleStreamMessage(corpo, { db, runtime });
    assert.equal(r.status, 400, `${JSON.stringify(corpo)} deveria ser 400`);
    assert.equal(r.stream, undefined);
  }
});

test('conversa inexistente vira agent.failed sanitizado dentro do fluxo', async () => {
  const { db, runtime } = cenario();
  const { status, stream } = handleStreamMessage(
    { threadId: 'thread_que_nao_existe', content: 'oi' }, { db, runtime },
  );

  assert.equal(status, 200);
  const blocos = await coletar(stream);
  assert.equal(blocos.length, 1);
  assert.equal(blocos[0].event, AGENT_EVENTS.FAILED);
  assert.equal(blocos[0].data.error.code, 'thread_not_found');
});

test('runtime indisponível vira agent.failed com código próprio', async () => {
  const { db, thread } = cenario();
  const desligado = {
    id: 'desligado',
    isAvailable: () => false,
    unavailableReason: () => 'sem configuração',
    testConnection: async () => ({ ok: false }),
    async* run() { /* nunca chamado */ },
  };

  const { stream } = handleStreamMessage(
    { threadId: thread.id, content: 'oi' }, { db, runtime: desligado },
  );
  const blocos = await coletar(stream);

  assert.equal(blocos.at(-1).event, AGENT_EVENTS.FAILED);
  assert.equal(blocos.at(-1).data.error.code, 'runtime_unavailable');
});

test('o resultado de ferramenta que atravessa é só o público', async () => {
  const { db, thread } = cenario();
  const runtime = runtimeDeRoteiro([
    { type: AGENT_EVENTS.STARTED, ts: 1 },
    {
      type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1', name: 'og.generate_image',
      result: {
        jobId: 'job_1',
        status: 'concluido',
        asset: {
          id: 'asset_1', kind: 'image', mediaUrl: '/api/media/image/p/x.png',
          mimeType: 'image/png', derivedFromAssetId: null,
        },
      },
    },
    { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'pronto' },
    { type: AGENT_EVENTS.COMPLETED, ts: 1 },
  ]);

  const { stream } = handleStreamMessage({ threadId: thread.id, content: 'oi' }, { db, runtime });
  const blocos = await coletar(stream);

  const concluida = blocos.find((b) => b.event === AGENT_EVENTS.TOOL_COMPLETED);
  assert.equal(concluida.data.result.asset.mediaUrl, '/api/media/image/p/x.png');

  // E nada de disco, workflow ou provider no que atravessou.
  const texto = JSON.stringify(blocos).toLowerCase();
  for (const proibido of ['hermes', 'session_id', 'stream_id', 'no_mcp', 'toolset',
    'comfy', 'workflowid', 'promptid', '/runtime/', 'ideogram']) {
    assert.equal(texto.includes(proibido.toLowerCase()), false, `"${proibido}" vazou`);
  }
});

test('o turno do fluxo persiste igual ao turno de uma vez', async () => {
  // sendMessage consome streamMessage: existe UMA implementação de turno. Se
  // divergirem, é porque alguém escreveu a segunda.
  const a = cenario();
  const viaStream = await coletar(handleStreamMessage(
    { threadId: a.thread.id, content: 'oi' }, { db: a.db, runtime: a.runtime },
  ).stream);

  const b = cenario();
  const viaJson = await sendMessage(
    { threadId: b.thread.id, content: 'oi' }, { db: b.db, runtime: b.runtime },
  );

  assert.deepEqual(viaStream.map((x) => x.event), viaJson.events.map((e) => e.type));

  // E os dois gravaram a mesma conversa.
  const msgsA = a.db.prepare('SELECT role, content FROM agent_messages ORDER BY seq').all();
  const msgsB = b.db.prepare('SELECT role, content FROM agent_messages ORDER BY seq').all();
  assert.deepEqual(msgsA, msgsB);
});

test('streamMessage grava a resposta e a devolve ao terminar', async () => {
  const { db, thread, runtime } = cenario();
  const fluxo = streamMessage({ threadId: thread.id, content: 'oi' }, { db, runtime });

  let passo = await fluxo.next();
  while (!passo.done) passo = await fluxo.next();

  assert.ok(passo.value.assistantMessage.id);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM agent_messages WHERE threadId = ?').get(thread.id).n,
    2,
  );
});
