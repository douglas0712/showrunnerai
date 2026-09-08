// A superfície pública de um evento de ferramenta.
//
// O defeito que estes testes trancam foi encontrado no smoke do PASSO 9: o SSE
// entregava ao navegador o resultado da ferramenta praticamente cru, e dentro
// dele ia o `jobId` — o nome do trabalho DENTRO do servidor:
//
//     event: tool.completed
//     data:  { ..., "result": { "jobId": "cinema_mtt51owr_3hjj7h" } }
//
// A tela nunca usou esse campo. Ela mostra mídia, e mídia vem do Asset.
//
// ── Por que a correção não podia ser apagar o campo no tradutor ─────────────
//
// Porque o `jobId` do evento não estava lá só para a tela: é dele que o gateway
// descobre qual geração ESTE turno começou, para amarrá-la à mensagem que ESTE
// turno gravou. Apagá-lo na origem calaria a autonomia junto com o vazamento.
//
// São duas fronteiras, e agora são duas reduções:
//
//   ferramenta → AgentEvent   o que a aplicação pode ver. Tem o jobId.
//   AgentEvent → navegador    o que a conversa mostra. Não tem.
//
// A ordem é a garantia: o gateway lê o evento interno primeiro; o navegador
// recebe a versão pública depois. Estes testes falham se alguém inverter isso.

import test from 'node:test';
import assert from 'node:assert/strict';

import { handleSendMessage, handleStreamMessage } from '../lib/server/agent/httpApi.js';
import { createThread, sendMessage } from '../lib/server/agent/gateway.js';
import {
  AGENT_EVENTS, declaredAssetFields, normalizeAgentEvent, publicAgentEvent,
} from '../lib/server/agent/events.js';
import { openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import { createToolRegistry, setToolRegistry } from '../lib/server/agent/tools/registry.js';
import { defineTool } from '../lib/server/agent/tools/schema.js';
import { criarRegistroDeAcompanhamento } from '../lib/server/agent/tools/jobWatch.js';
import { comMidia } from '../lib/agentClient.js';

/** O identificador interno que não pode atravessar. */
const JOB_INTERNO = 'cinema_mtt51owr_3hjj7h';

function cenario() {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_evt', name: 'Superfície' }, db);
  const thread = createThread({ projectId: 'proj_evt' }, { db });
  return { db, thread };
}

function assetPronto(db) {
  return createAsset({
    projectId: 'proj_evt',
    kind: 'image',
    jobId: JOB_INTERNO,
    filename: 'x.png',
    url: '/api/media/image/proj_evt/x.png',
    mimeType: 'image/png',
  }, db);
}

/** A forma pública de um Asset, como a facade a devolve. */
const assetDaFerramenta = (id) => ({
  id,
  kind: 'image',
  mediaUrl: '/api/media/image/proj_evt/x.png',
  mimeType: 'image/png',
  derivedFromAssetId: null,
});

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

async function coletar(iteravel) {
  const itens = [];
  for await (const item of iteravel) itens.push(item);
  return itens;
}

// ── a redução, em isolamento ────────────────────────────────────────────────

test('publicAgentEvent tira o jobId e o estado do gerador de tool.completed', () => {
  const interno = normalizeAgentEvent({
    type: AGENT_EVENTS.TOOL_COMPLETED,
    ts: 1,
    toolCallId: 'c1',
    name: 'og.generate_image',
    result: { jobId: JOB_INTERNO, kind: 'image', status: 'na-fila' },
  });

  // O evento INTERNO continua inteiro: é dele que o servidor tira o que
  // acompanhar.
  assert.equal(interno.result.jobId, JOB_INTERNO);

  const publico = publicAgentEvent(interno);

  assert.equal(publico.type, AGENT_EVENTS.TOOL_COMPLETED);
  assert.equal(publico.name, 'og.generate_image');
  assert.equal(publico.toolCallId, 'c1');
  // Sem Asset não sobra nada que valha mostrar — e `result` ausente é uma forma
  // que o vocabulário sempre previu.
  assert.equal(publico.result, undefined);
  assert.ok(!('jobId' in publico));

  // E o interno não foi mutado no caminho.
  assert.equal(interno.result.jobId, JOB_INTERNO);
});

test('publicAgentEvent preserva o Asset, e só os campos declarados', () => {
  const interno = normalizeAgentEvent({
    type: AGENT_EVENTS.TOOL_COMPLETED,
    ts: 1,
    toolCallId: 'c1',
    name: 'og.get_job',
    result: {
      jobId: JOB_INTERNO,
      status: 'concluido',
      assetId: 'asset_1',
      asset: { ...assetDaFerramenta('asset_1'), promptId: 'p-99', filename: 'x.png' },
    },
  });

  const publico = publicAgentEvent(interno);

  assert.deepEqual(Object.keys(publico.result), ['asset']);
  assert.deepEqual(Object.keys(publico.result.asset).sort(), declaredAssetFields().sort());
  assert.equal(publico.result.asset.mediaUrl, '/api/media/image/proj_evt/x.png');
  // Campos que a ferramenta trouxe e a lista fechada não reconhece somem.
  assert.ok(!('promptId' in publico.result.asset));
  assert.ok(!('filename' in publico.result.asset));
});

test('publicAgentEvent tira os arguments de tool.started', () => {
  // Numa consulta de andamento, o que o modelo escreve como argumento É o
  // identificador interno. A tela nunca leu esse campo.
  const interno = normalizeAgentEvent({
    type: AGENT_EVENTS.TOOL_STARTED,
    ts: 1,
    toolCallId: 'c1',
    name: 'og.get_job',
    arguments: { jobId: JOB_INTERNO },
  });

  assert.equal(interno.arguments.jobId, JOB_INTERNO);

  const publico = publicAgentEvent(interno);
  assert.ok(!('arguments' in publico));
  assert.equal(publico.name, 'og.get_job');
});

test('publicAgentEvent devolve o MESMO objeto quando não há o que tirar', () => {
  const delta = normalizeAgentEvent({ type: AGENT_EVENTS.MESSAGE_DELTA, ts: 1, text: 'oi' });
  assert.equal(publicAgentEvent(delta), delta);

  const iniciada = normalizeAgentEvent({
    type: AGENT_EVENTS.TOOL_STARTED, ts: 1, toolCallId: 'c1', name: 'og.generate_image',
  });
  assert.equal(publicAgentEvent(iniciada), iniciada);
});

// ── C + D · o SSE público ───────────────────────────────────────────────────

const roteiroDeGeracao = (nome, kind) => [
  { type: AGENT_EVENTS.STARTED, ts: 1 },
  {
    type: AGENT_EVENTS.TOOL_STARTED, ts: 1, toolCallId: 'c1', name: nome,
    arguments: { prompt: 'um dragão' },
  },
  {
    type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1', name: nome,
    result: { jobId: JOB_INTERNO, kind, status: 'preparando' },
  },
  { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Coloquei para gerar.' },
  { type: AGENT_EVENTS.COMPLETED, ts: 1 },
];

test('C. o SSE de og.generate_image não carrega o jobId', async () => {
  const { db, thread } = cenario();
  const { stream } = handleStreamMessage(
    { threadId: thread.id, content: 'crie uma imagem' },
    { db, runtime: runtimeDeRoteiro(roteiroDeGeracao('og.generate_image', 'image')) },
  );

  const blocos = await coletar(stream);
  const texto = JSON.stringify(blocos);

  assert.ok(!texto.includes(JOB_INTERNO), 'o identificador do trabalho atravessou');
  assert.ok(!texto.includes('jobId'));

  const concluida = blocos.find((b) => b.event === AGENT_EVENTS.TOOL_COMPLETED);
  assert.equal(concluida.data.name, 'og.generate_image');
  assert.equal(concluida.data.result, undefined);
});

test('D. o SSE de og.generate_video segue a mesma regra', async () => {
  const { db, thread } = cenario();
  const { stream } = handleStreamMessage(
    { threadId: thread.id, content: 'anime isso' },
    { db, runtime: runtimeDeRoteiro(roteiroDeGeracao('og.generate_video', 'video')) },
  );

  const blocos = await coletar(stream);
  const texto = JSON.stringify(blocos);

  assert.ok(!texto.includes(JOB_INTERNO));
  assert.ok(!texto.includes('jobId'));
  assert.equal(
    blocos.find((b) => b.event === AGENT_EVENTS.TOOL_COMPLETED).data.name,
    'og.generate_video',
  );
});

test('E. og.get_job não vaza o identificador nem o estado interno', async () => {
  const { db, thread } = cenario();
  const { stream } = handleStreamMessage(
    { threadId: thread.id, content: 'como está?' },
    {
      db,
      runtime: runtimeDeRoteiro([
        { type: AGENT_EVENTS.STARTED, ts: 1 },
        {
          // O argumento do modelo É o identificador interno.
          type: AGENT_EVENTS.TOOL_STARTED, ts: 1, toolCallId: 'c1', name: 'og.get_job',
          arguments: { jobId: JOB_INTERNO },
        },
        {
          type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1', name: 'og.get_job',
          result: {
            jobId: JOB_INTERNO, kind: 'image', status: 'decodificando',
            assetId: null, mediaUrl: null, error: null, asset: null,
          },
        },
        { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Ainda está renderizando.' },
        { type: AGENT_EVENTS.COMPLETED, ts: 1 },
      ]),
    },
  );

  const blocos = await coletar(stream);
  const texto = JSON.stringify(blocos);

  assert.ok(!texto.includes(JOB_INTERNO), 'o identificador atravessou nos argumentos ou no resultado');
  // O vocabulário do gerador não é o da conversa.
  for (const proibido of ['decodificando', 'na-fila', 'salvando', 'assetId', 'mediaUrl']) {
    assert.ok(!texto.includes(proibido), `"${proibido}" atravessou`);
  }

  // A fala do assistente continua inteira: o status em linguagem natural é do
  // agente, e não é isto que estamos cortando.
  const dita = blocos.find((b) => b.event === AGENT_EVENTS.MESSAGE_COMPLETED);
  assert.equal(dita.data.text, 'Ainda está renderizando.');
});

// ── F · a mídia continua chegando ───────────────────────────────────────────

test('F. o Asset atravessa e a tela continua montando a mídia com ele', async () => {
  const { db, thread } = cenario();
  const asset = assetPronto(db);

  const { stream } = handleStreamMessage(
    { threadId: thread.id, content: 'e aí?' },
    {
      db,
      runtime: runtimeDeRoteiro([
        { type: AGENT_EVENTS.STARTED, ts: 1 },
        {
          type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1', name: 'og.get_job',
          result: {
            jobId: JOB_INTERNO, status: 'concluido', assetId: asset.id,
            asset: assetDaFerramenta(asset.id),
          },
        },
        { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Pronto.' },
        { type: AGENT_EVENTS.COMPLETED, ts: 1 },
      ]),
    },
  );

  const blocos = await coletar(stream);
  const concluida = blocos.find((b) => b.event === AGENT_EVENTS.TOOL_COMPLETED);

  assert.equal(concluida.data.result.asset.id, asset.id);
  assert.equal(concluida.data.result.asset.mediaUrl, '/api/media/image/proj_evt/x.png');
  assert.ok(!JSON.stringify(blocos).includes(JOB_INTERNO));

  // E a redução do cliente — a mesma que a tela usa — monta a mídia a partir
  // disso sem precisar de mais nada.
  const midia = comMidia([], concluida.data.result);
  assert.deepEqual(midia, [{
    assetId: asset.id,
    kind: 'image',
    mediaUrl: '/api/media/image/proj_evt/x.png',
    mimeType: 'image/png',
    derivedFromAssetId: null,
  }]);
});

test('F-bis. o Asset ainda é ligado à mensagem, apesar da sanitização', async () => {
  const { db, thread } = cenario();
  const asset = assetPronto(db);

  const turno = await sendMessage({ threadId: thread.id, content: 'e aí?' }, {
    db,
    runtime: runtimeDeRoteiro([
      { type: AGENT_EVENTS.STARTED, ts: 1 },
      {
        type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1', name: 'og.get_job',
        result: { jobId: JOB_INTERNO, status: 'concluido', asset: assetDaFerramenta(asset.id) },
      },
      { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Pronto.' },
      { type: AGENT_EVENTS.COMPLETED, ts: 1 },
    ]),
  });

  // A ligação nasce do evento INTERNO, que o gateway leu antes de sanitizar.
  const ligados = db.prepare(
    'SELECT assetId FROM agent_message_assets WHERE messageId = ?',
  ).all(turno.assistantMessage.id).map((l) => l.assetId);
  assert.deepEqual(ligados, [asset.id]);

  db.close();
});

// ── G + H · o que nunca pode aparecer ───────────────────────────────────────

test('G+H. nenhum detalhe técnico e nenhum alias do runtime atravessam', async () => {
  const { db, thread } = cenario();

  const { stream } = handleStreamMessage(
    { threadId: thread.id, content: 'crie' },
    {
      db,
      runtime: runtimeDeRoteiro([
        { type: AGENT_EVENTS.STARTED, ts: 1 },
        {
          type: AGENT_EVENTS.TOOL_STARTED, ts: 1, toolCallId: 'c1', name: 'og.generate_image',
          arguments: { prompt: 'x', seed: 7 },
        },
        {
          type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1', name: 'og.generate_image',
          result: {
            jobId: JOB_INTERNO,
            status: 'na-fila',
            promptId: 'a1b2c3',
            workflowId: 'ideogram4_t2i',
            provider: 'comfy',
            nodeId: '105:14',
            path: '/media/douglas/runtime/projects/p/x.png',
          },
        },
        { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Coloquei para gerar.' },
        { type: AGENT_EVENTS.COMPLETED, ts: 1 },
      ]),
    },
  );

  const texto = JSON.stringify(await coletar(stream)).toLowerCase();

  for (const proibido of [
    'jobid', JOB_INTERNO.toLowerCase(), 'promptid', 'workflowid', 'workflow',
    'provider', 'nodeid', 'ideogram', 'minimax', 'comfy', '/runtime/', 'na-fila',
    // aliases do runtime: o que a tela vê é o nome canônico do Showrunner
    'og_generate_image', 'og_generate_video', 'og_get_job',
    'hermes', 'session_id', 'toolset',
  ]) {
    assert.equal(texto.includes(proibido), false, `"${proibido}" vazou para o navegador`);
  }

  // E o nome canônico continua chegando, que é o que a tela usa para rotular.
  assert.ok(texto.includes('og.generate_image'));
});

test('a resposta de uma vez é sanitizada igual à do fluxo', async () => {
  const { db, thread } = cenario();

  // /api/agent/messages devolve os eventos do turno no corpo. Era a segunda
  // porta pelo mesmo lugar, e teria continuado aberta se a sanitização
  // morasse só no streaming.
  const r = await handleSendMessage({ threadId: thread.id, content: 'crie' }, {
    db,
    runtime: runtimeDeRoteiro(roteiroDeGeracao('og.generate_image', 'image')),
  });

  assert.equal(r.status, 200);
  const texto = JSON.stringify(r.body.events);
  assert.ok(!texto.includes(JOB_INTERNO));
  assert.ok(!texto.includes('jobId'));

  db.close();
});

// ── I · a autonomia não passa pela superfície pública ───────────────────────

test('I. o acompanhamento é amarrado pelo evento interno, não pelo público', async () => {
  const { db, thread } = cenario();
  const asset = assetPronto(db);

  const registro = criarRegistroDeAcompanhamento({
    consultar: async () => ({ jobId: JOB_INTERNO, status: 'concluido', assetId: asset.id }),
    esperar: async () => {},
  });

  // Uma ferramenta que começa o trabalho e devolve o identificador interno,
  // como a de verdade faz.
  setToolRegistry(createToolRegistry([defineTool({
    name: 'og.generate_image',
    description: 'gera imagem',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    async execute(ctx) {
      registro.watch({
        jobId: JOB_INTERNO, kind: 'image', threadId: ctx.threadId, projectId: ctx.projectId,
      }, { db });
      return { jobId: JOB_INTERNO, kind: 'image', status: 'preparando' };
    },
  })]));

  const runtime = {
    id: 'roteiro',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run({ invokeTool }) {
      yield { type: AGENT_EVENTS.STARTED, ts: 1 };
      const resultado = await invokeTool('og.generate_image', { prompt: 'um dragão' });
      yield {
        type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1',
        name: 'og.generate_image', result: resultado,
      };
      yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Coloquei para gerar.' };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };

  const turno = await sendMessage(
    { threadId: thread.id, content: 'crie' },
    { db, runtime, watchRegistry: registro },
  );

  // O servidor soube exatamente qual trabalho acompanhar e a que mensagem ele
  // pertence — e nada disso apareceu na resposta que vai para o navegador.
  const marca = registro.get(JOB_INTERNO);
  assert.equal(marca.jobId, JOB_INTERNO);
  assert.equal(marca.messageId, turno.assistantMessage.id);

  const texto = JSON.stringify(turno.events);
  assert.ok(!texto.includes(JOB_INTERNO), 'a autonomia funcionou, mas o identificador vazou');

  await marca.pronto;
  assert.equal(marca.assetId, asset.id);

  db.close();
});
