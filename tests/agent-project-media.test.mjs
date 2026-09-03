// Projeto real e mídia que sobrevive ao reload.
//
// Dois problemas que o PASSO 8 deixou visíveis, e que estes testes fecham:
//
//   o projeto existia na TELA e não no servidor, então a conversa nascia sem
//   projeto e a geração não tinha onde acontecer;
//
//   o histórico guardava só texto, então a imagem produzida sumia ao recarregar
//   — e a URL que o agente escreveu na resposta reaparecia crua no lugar dela.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createThread, getThread, sendMessage, DomainError,
} from '../lib/server/agent/gateway.js';
import { attachMessageAssets, listMessageAssets } from '../lib/server/agent/threads.js';
import { AGENT_EVENTS } from '../lib/server/agent/events.js';
import { openDatabase } from '../lib/server/domain/db.js';
import { createProject, getProject, createAsset } from '../lib/server/domain/index.js';

const relogio = () => 1000;

/** Um runtime que emite o roteiro dado e nada mais. */
function runtimeDeRoteiro(eventos) {
  return {
    id: 'roteiro',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run() { for (const e of eventos) yield e; },
  };
}

const textoSimples = (texto) => runtimeDeRoteiro([
  { type: AGENT_EVENTS.STARTED, ts: 1 },
  { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: texto },
  { type: AGENT_EVENTS.COMPLETED, ts: 1 },
]);

const comImagem = (texto, asset) => runtimeDeRoteiro([
  { type: AGENT_EVENTS.STARTED, ts: 1 },
  {
    type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1', name: 'og.generate_image',
    result: { jobId: 'job_1', status: 'concluido', asset },
  },
  { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: texto },
  { type: AGENT_EVENTS.COMPLETED, ts: 1 },
]);

function banco() {
  return openDatabase(':memory:');
}

/** Um Asset real do projeto, como a finalização o cria. */
function assetDe(projectId, db, { id = null, kind = 'image', nome = 'x.png' } = {}) {
  const criado = createAsset({
    ...(id ? { id } : {}),
    projectId, kind, jobId: `job_${nome}`, filename: nome,
    url: `/api/media/${kind}/${projectId}/${nome}`,
    mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
    status: 'pendente',
  }, db);
  return {
    id: criado.id, kind: criado.kind, mediaUrl: criado.url,
    mimeType: criado.mimeType, derivedFromAssetId: null,
  };
}

// ── PROJETO ─────────────────────────────────────────────────────────────────

test('1. o projeto do Studio vira Project do servidor, com o MESMO id', () => {
  const db = banco();
  assert.equal(getProject('proj_a', db), null, 'não deveria existir antes');

  const thread = createThread({
    project: { id: 'proj_a', name: 'Curta neo-noir', aspect: '21:9' },
  }, { db });

  assert.equal(thread.projectId, 'proj_a');

  const projeto = getProject('proj_a', db);
  assert.ok(projeto, 'o projeto não foi registrado');
  assert.equal(projeto.name, 'Curta neo-noir');
  assert.equal(projeto.aspect, '21:9');
});

test('1-bis. abrir o Agent duas vezes não cria dois projetos', () => {
  const db = banco();
  const descritor = { id: 'proj_a', name: 'Curta' };

  createThread({ project: descritor }, { db });
  createThread({ project: descritor }, { db });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
});

test('1-ter. um projeto que já existe NÃO é sobrescrito pelo descritor', () => {
  const db = banco();
  createProject({ id: 'proj_a', name: 'Nome de verdade', aspect: '16:9' }, db);

  createThread({ project: { id: 'proj_a', name: 'Nome da tela', aspect: '9:16' } }, { db });

  const projeto = getProject('proj_a', db);
  assert.equal(projeto.name, 'Nome de verdade');
  assert.equal(projeto.aspect, '16:9');
});

test('2. reload devolve a mesma conversa, com o mesmo projeto', () => {
  const db = banco();
  const thread = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });

  const relido = getThread(thread.id, { db });
  assert.equal(relido.thread.id, thread.id);
  assert.equal(relido.thread.projectId, 'proj_a');
});

test('3. o projeto B tem a própria conversa — nada é reaproveitado de A', () => {
  const db = banco();
  const a = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });
  const b = createThread({ project: { id: 'proj_b', name: 'B' } }, { db });

  assert.notEqual(a.id, b.id);
  assert.equal(getThread(a.id, { db }).thread.projectId, 'proj_a');
  assert.equal(getThread(b.id, { db }).thread.projectId, 'proj_b');
});

test('4. sem projeto, a conversa textual funciona', async () => {
  const db = banco();
  const thread = createThread({}, { db });
  assert.equal(thread.projectId, null);

  const turno = await sendMessage(
    { threadId: thread.id, content: 'oi' },
    { db, runtime: textoSimples('Olá.') },
  );
  assert.equal(turno.assistantMessage.content, 'Olá.');
});

test('4-bis. projectId de um projeto desconhecido, SEM descritor, é recusado', () => {
  // É o que impede um projeto fantasma de nascer de um id solto.
  const db = banco();
  assert.throws(
    () => createThread({ projectId: 'proj_que_nao_existe' }, { db }),
    DomainError,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
});

test('5. sem projeto, a ferramenta que exige projeto avisa de forma acionável', async () => {
  const { handleBridgeInvocation } = await import('../lib/server/agent/hermes/bridge.js');
  const { bindRuntimeSession } = await import('../lib/server/agent/hermes/sessionBinding.js');

  const db = banco();
  const thread = createThread({}, { db });
  bindRuntimeSession({ sessionId: 'sess_np', threadId: thread.id, runtimeId: 'hermes', now: 1 }, db);

  const r = await handleBridgeInvocation({
    sessionId: 'sess_np', toolName: 'og_generate_image', arguments: { prompt: 'x' },
  }, { db });

  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'project_required');
  assert.match(r.error.message, /projeto/i);
});

// ── MÍDIA ───────────────────────────────────────────────────────────────────

test('6. o Asset produzido no turno fica ligado à mensagem', async () => {
  const db = banco();
  const thread = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });
  const asset = assetDe('proj_a', db);

  const turno = await sendMessage(
    { threadId: thread.id, content: 'gere' },
    { db, runtime: comImagem('Pronta.', asset) },
  );

  const ligados = listMessageAssets(turno.assistantMessage.id, db);
  assert.equal(ligados.length, 1);
  assert.equal(ligados[0].assetId, asset.id);
  assert.equal(ligados[0].mediaUrl, asset.mediaUrl);
});

test('7. o reload recupera a imagem junto com o texto', async () => {
  const db = banco();
  const thread = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });
  const asset = assetDe('proj_a', db);

  await sendMessage(
    { threadId: thread.id, content: 'gere' },
    { db, runtime: comImagem('Pronta.', asset) },
  );

  // Exatamente o que a tela lê ao abrir de novo.
  const { messages } = getThread(thread.id, { db });
  const doAgente = messages.find((m) => m.role === 'assistant');

  assert.equal(doAgente.content, 'Pronta.');
  assert.equal(doAgente.assets.length, 1);
  assert.equal(doAgente.assets[0].kind, 'image');
  assert.equal(doAgente.assets[0].mimeType, 'image/png');
  assert.match(doAgente.assets[0].mediaUrl, /^\/api\/media\//);
});

test('8. vídeo também volta, com o tipo certo', async () => {
  const db = banco();
  const thread = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });
  const asset = assetDe('proj_a', db, { kind: 'video', nome: 'v.mp4' });

  await sendMessage(
    { threadId: thread.id, content: 'gere' },
    { db, runtime: comImagem('Pronto.', asset) },
  );

  const { messages } = getThread(thread.id, { db });
  const midia = messages.find((m) => m.role === 'assistant').assets[0];
  assert.equal(midia.kind, 'video');
  assert.equal(midia.mimeType, 'video/mp4');
});

test('9. Asset de OUTRO projeto nunca é ligado nem exposto', async () => {
  const db = banco();
  createProject({ id: 'proj_alheio', name: 'Alheio' }, db);
  const doOutro = assetDe('proj_alheio', db, { nome: 'segredo.png' });

  const thread = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });

  const turno = await sendMessage(
    { threadId: thread.id, content: 'gere' },
    { db, runtime: comImagem('Pronta.', doOutro) },
  );

  assert.equal(listMessageAssets(turno.assistantMessage.id, db).length, 0,
    'um Asset de outro projeto entrou na conversa');

  const { messages } = getThread(thread.id, { db });
  const texto = JSON.stringify(messages);
  assert.equal(texto.includes('segredo.png'), false);
});

test('9-bis. um assetId arbitrário não vira mídia da conversa', async () => {
  // A associação nasce do resultado real da ferramenta. Um id solto, ainda que
  // exista, não é autoridade sobre a que conversa pertence.
  const db = banco();
  createProject({ id: 'proj_alheio', name: 'Alheio' }, db);
  const doOutro = assetDe('proj_alheio', db, { nome: 'outro.png' });

  const thread = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });
  const turno = await sendMessage(
    { threadId: thread.id, content: 'oi' },
    { db, runtime: textoSimples('Olá.') },
  );

  const aceitos = attachMessageAssets(
    turno.assistantMessage.id,
    [doOutro.id, 'asset_inventado', ''],
    db,
  );
  assert.deepEqual(aceitos, []);
});

test('10. o mesmo Asset citado por duas ferramentas entra uma vez', async () => {
  const db = banco();
  const thread = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });
  const asset = assetDe('proj_a', db);

  const runtime = runtimeDeRoteiro([
    { type: AGENT_EVENTS.STARTED, ts: 1 },
    {
      type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1',
      name: 'og.generate_image', result: { asset },
    },
    {
      type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c2',
      name: 'og.get_job', result: { asset },
    },
    { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Pronta.' },
    { type: AGENT_EVENTS.COMPLETED, ts: 1 },
  ]);

  const turno = await sendMessage({ threadId: thread.id, content: 'gere' }, { db, runtime });

  assert.equal(listMessageAssets(turno.assistantMessage.id, db).length, 1);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets WHERE messageId = ?')
      .get(turno.assistantMessage.id).n,
    1,
  );
});

test('10-bis. ligar o mesmo Asset duas vezes é inofensivo', async () => {
  const db = banco();
  const thread = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });
  const asset = assetDe('proj_a', db);
  const turno = await sendMessage(
    { threadId: thread.id, content: 'oi' }, { db, runtime: textoSimples('Olá.') },
  );

  attachMessageAssets(turno.assistantMessage.id, [asset.id], db);
  attachMessageAssets(turno.assistantMessage.id, [asset.id], db);

  assert.equal(listMessageAssets(turno.assistantMessage.id, db).length, 1);
});

test('11. a URL crua sai do texto no reload, com a mesma regra do turno vivo', async () => {
  const { semUrlsJaExibidas } = await import('../lib/agentClient.js');

  const db = banco();
  const thread = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });
  const asset = assetDe('proj_a', db);

  await sendMessage(
    { threadId: thread.id, content: 'gere' },
    { db, runtime: comImagem(`Pronta:\n\nMEDIA:${asset.mediaUrl}`, asset) },
  );

  const { messages } = getThread(thread.id, { db });
  const doAgente = messages.find((m) => m.role === 'assistant');

  // O texto GRAVADO preserva o que o agente disse — não reescrevemos a fala
  // dele no banco. Quem limpa é a exibição, e com a mesma função dos dois lados.
  assert.ok(doAgente.content.includes(asset.mediaUrl));
  assert.equal(semUrlsJaExibidas(doAgente.content, doAgente.assets), 'Pronta:');
});

test('11-bis. uma URL que não é da mídia exibida sobrevive ao reload', async () => {
  const { semUrlsJaExibidas } = await import('../lib/agentClient.js');
  const texto = 'Veja a referência em /api/media/image/outro/ref.png';
  assert.equal(semUrlsJaExibidas(texto, []), texto);
});

test('12. nada do runtime é persistido na conversa', async () => {
  const db = banco();
  const thread = createThread({ project: { id: 'proj_a', name: 'A' } }, { db });
  const asset = assetDe('proj_a', db);

  await sendMessage(
    { threadId: thread.id, content: 'gere' },
    { db, runtime: comImagem('Pronta.', asset) },
  );

  // A conversa inteira, como está no banco.
  const tudo = JSON.stringify({
    thread: getThread(thread.id, { db }),
    mensagens: db.prepare('SELECT * FROM agent_messages').all(),
    ligacoes: db.prepare('SELECT * FROM agent_message_assets').all(),
  }).toLowerCase();

  for (const proibido of ['hermes', 'session_id', 'stream_id', 'enabled_toolsets',
    'no_mcp', 'toolset', 'og_generate', 'promptid', 'workflowid', 'comfy',
    'ideogram', 'minimax', '/runtime/projects']) {
    assert.equal(tudo.includes(proibido.toLowerCase()), false, `"${proibido}" foi persistido`);
  }
});
