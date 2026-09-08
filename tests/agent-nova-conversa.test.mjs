// "Nova conversa" — começar outra conversa sem perder a anterior.
//
// O botão que a AgentScreen ganhou é uma operação de UM verbo: criar. Ele não
// apaga mensagem, não deleta thread, não mexe em Asset e não toca no projeto.
// O que ele move é o PONTEIRO do projeto — qual conversa é a atual.
//
// Estes testes exercitam a decisão inteira sem navegador e sem React: o
// `fetch` é ligado aos handlers REAIS da API, sobre um banco em memória. É o
// que permite afirmar, e não supor, que a conversa anterior continua lá depois
// do clique — se a afirmação fosse contra um `fetch` de mentira, ela provaria
// só que o teste foi escrito de acordo com ele.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  agentThreadKey, ensureThread, lembrarThread, startNewThread, threadLembrada,
} from '../lib/agentClient.js';
import {
  handleCreateThread, handleGetThread, handleListThreads,
} from '../lib/server/agent/httpApi.js';
import { openDatabase } from '../lib/server/domain/db.js';
import { createEchoRuntime } from '../lib/server/agent/adapters/EchoRuntimeAdapter.js';
import { appendMessageRecord, attachMessageAssets } from '../lib/server/agent/threads.js';
import { createAsset } from '../lib/server/domain/index.js';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));

/** Um localStorage de mentira, com a superfície que o cliente usa. */
function armazenamentoFalso(inicial = {}) {
  const dados = new Map(Object.entries(inicial));
  return {
    getItem: (k) => (dados.has(k) ? dados.get(k) : null),
    setItem: (k, v) => dados.set(k, String(v)),
    removeItem: (k) => dados.delete(k),
    get tamanho() { return dados.size; },
    tudo: () => Object.fromEntries(dados),
  };
}

/**
 * Um `fetch` ligado aos handlers de verdade.
 *
 * Sem HTTP e sem Next — as rotas são finas de propósito, e a decisão inteira
 * mora em `httpApi.js`. O que atravessa aqui é exatamente o que atravessaria a
 * rede.
 */
function fetchDaApi(deps) {
  const chamadas = [];
  const fetchImpl = async (url, opcoes = {}) => {
    chamadas.push({ url, method: opcoes.method || 'GET' });

    const corpo = opcoes.body ? JSON.parse(opcoes.body) : {};

    if (url === '/api/agent/threads' && opcoes.method === 'POST') {
      return resposta(handleCreateThread(corpo, deps));
    }
    if (url.startsWith('/api/agent/threads/')) {
      const id = decodeURIComponent(url.slice('/api/agent/threads/'.length));
      return resposta(handleGetThread(id, deps));
    }
    throw new Error(`rota não prevista no teste: ${opcoes.method || 'GET'} ${url}`);
  };
  fetchImpl.chamadas = chamadas;
  return fetchImpl;
}

const resposta = ({ status, body }) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

/** Um `fetch` que sempre recusa — a falha de criação. */
const fetchQueRecusa = (status = 503, error = 'indisponível') => async () => ({
  ok: false, status, json: async () => ({ error }),
});

const PROJ_A = { id: 'proj_a', name: 'Curta neo-noir', aspect: '16:9' };
const PROJ_B = { id: 'proj_b', name: 'Documentário', aspect: '21:9' };

/** Uma conversa com histórico e mídia, como a que o usuário deixa para trás. */
function conversaComHistorico(deps, project) {
  const { body } = handleCreateThread({ project }, deps);
  const thread = body.thread;

  appendMessageRecord({
    threadId: thread.id, role: 'user', content: 'crie um dragão', status: 'completed',
  }, deps.db);
  const doAgente = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Pronta.', status: 'completed',
  }, deps.db);

  const asset = createAsset({
    projectId: project.id, kind: 'image', jobId: 'job_1', filename: 'dragao.png',
    url: `/api/media/image/${project.id}/dragao.png`,
    mimeType: 'image/png', status: 'pendente',
  }, deps.db);
  attachMessageAssets(doAgente.id, [asset.id], deps.db);

  return { thread, asset };
}

const ambiente = () => ({ db: openDatabase(':memory:'), runtime: createEchoRuntime() });

// ── 1 a 5 · o que o clique faz ──────────────────────────────────────────────

test('1. Nova conversa cria um threadId NOVO, diferente do atual', async () => {
  const deps = ambiente();
  const fetchImpl = fetchDaApi(deps);
  const { thread: antiga } = conversaComHistorico(deps, PROJ_A);

  const { thread: nova } = await startNewThread({
    project: PROJ_A, fetchImpl, storage: armazenamentoFalso(),
  });

  assert.notEqual(nova.id, antiga.id);
  assert.match(nova.id, /^thread_/);

  // Uma criação, uma chamada. O botão não é um caminho para a thread atual.
  assert.deepEqual(fetchImpl.chamadas.filter((c) => c.method === 'POST').length, 1);

  deps.db.close();
});

test('2. o projectId da conversa nova é o MESMO — e nenhum projeto é criado', async () => {
  const deps = ambiente();
  const fetchImpl = fetchDaApi(deps);
  const { thread: antiga } = conversaComHistorico(deps, PROJ_A);

  const antes = deps.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n;

  const { thread: nova } = await startNewThread({
    project: PROJ_A, fetchImpl, storage: armazenamentoFalso(),
  });

  assert.equal(nova.projectId, PROJ_A.id);
  assert.equal(nova.projectId, antiga.projectId);
  assert.equal(deps.db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, antes,
    'um projeto fantasma foi criado');

  deps.db.close();
});

test('3. a conversa anterior NÃO é deletada — ela continua listada', async () => {
  const deps = ambiente();
  const fetchImpl = fetchDaApi(deps);
  const { thread: antiga } = conversaComHistorico(deps, PROJ_A);

  const { thread: nova } = await startNewThread({
    project: PROJ_A, fetchImpl, storage: armazenamentoFalso(),
  });

  const { body } = handleListThreads({ projectId: PROJ_A.id }, deps);
  const ids = body.threads.map((t) => t.id);

  assert.ok(ids.includes(antiga.id), 'a conversa anterior sumiu');
  assert.ok(ids.includes(nova.id));
  assert.equal(ids.length, 2);

  deps.db.close();
});

test('4. as mensagens antigas ficam na thread antiga e NÃO aparecem na nova', async () => {
  const deps = ambiente();
  const fetchImpl = fetchDaApi(deps);
  const { thread: antiga } = conversaComHistorico(deps, PROJ_A);

  const { thread: nova, messages } = await startNewThread({
    project: PROJ_A, fetchImpl, storage: armazenamentoFalso(),
  });

  // A tela abre vazia.
  assert.deepEqual(messages, []);
  assert.equal(handleGetThread(nova.id, deps).body.messages.length, 0);

  // E o histórico continua inteiro onde sempre esteve.
  const guardadas = handleGetThread(antiga.id, deps).body.messages;
  assert.equal(guardadas.length, 2);
  assert.equal(guardadas[0].content, 'crie um dragão');
  assert.equal(guardadas[1].content, 'Pronta.');

  deps.db.close();
});

test('5. o ponteiro do projeto passa a apontar para a conversa nova', async () => {
  const deps = ambiente();
  const fetchImpl = fetchDaApi(deps);
  const { thread: antiga } = conversaComHistorico(deps, PROJ_A);

  const storage = armazenamentoFalso();
  lembrarThread(PROJ_A.id, antiga.id, storage);
  assert.equal(threadLembrada(PROJ_A.id, storage), antiga.id);

  const { thread: nova } = await startNewThread({ project: PROJ_A, fetchImpl, storage });

  assert.equal(threadLembrada(PROJ_A.id, storage), nova.id);
  // SÓ o ponteiro deste projeto se moveu: nenhuma chave a mais, nenhuma a menos.
  assert.deepEqual(Object.keys(storage.tudo()), [agentThreadKey(PROJ_A.id)]);

  deps.db.close();
});

// ── 6 · a falha ─────────────────────────────────────────────────────────────

test('6. se a criação falhar, a conversa atual e o ponteiro permanecem', async () => {
  const deps = ambiente();
  const { thread: atual } = conversaComHistorico(deps, PROJ_A);

  const storage = armazenamentoFalso();
  lembrarThread(PROJ_A.id, atual.id, storage);

  await assert.rejects(
    () => startNewThread({ project: PROJ_A, fetchImpl: fetchQueRecusa(), storage }),
    (erro) => erro.code === 'thread_create_failed',
  );

  // O ponteiro não se moveu: a escrita acontece DEPOIS da confirmação.
  assert.equal(threadLembrada(PROJ_A.id, storage), atual.id);

  // E a conversa atual está intacta — a tela tem para onde voltar.
  const mensagens = handleGetThread(atual.id, deps).body.messages;
  assert.equal(mensagens.length, 2);
  assert.equal(deps.db.prepare('SELECT COUNT(*) AS n FROM agent_threads').get().n, 1);

  deps.db.close();
});

// ── 7 · projetos continuam isolados ─────────────────────────────────────────

test('7. Nova conversa no projeto A não toca no ponteiro nem nas threads de B', async () => {
  const deps = ambiente();
  const fetchImpl = fetchDaApi(deps);

  const { thread: doA } = conversaComHistorico(deps, PROJ_A);
  const { thread: doB } = conversaComHistorico(deps, PROJ_B);

  const storage = armazenamentoFalso();
  lembrarThread(PROJ_A.id, doA.id, storage);
  lembrarThread(PROJ_B.id, doB.id, storage);

  const { thread: novaDoA } = await startNewThread({ project: PROJ_A, fetchImpl, storage });

  assert.equal(threadLembrada(PROJ_A.id, storage), novaDoA.id);
  assert.equal(threadLembrada(PROJ_B.id, storage), doB.id, 'o ponteiro de B se moveu');

  // O projeto B continua com uma conversa só, e é a dele.
  const deB = handleListThreads({ projectId: PROJ_B.id }, deps).body.threads;
  assert.deepEqual(deB.map((t) => t.id), [doB.id]);
  assert.equal(handleGetThread(doB.id, deps).body.messages.length, 2);

  // E a conversa nova de A não vaza para B.
  assert.equal(novaDoA.projectId, PROJ_A.id);

  deps.db.close();
});

test('7-bis. voltar ao projeto reabre a conversa que o ponteiro guarda', async () => {
  // A lógica existente de threads por projeto continua valendo: com o ponteiro
  // já apontando para a conversa nova, reabrir a tela cai nela — e não em mais
  // uma conversa recém-criada a cada visita.
  const deps = ambiente();
  const fetchImpl = fetchDaApi(deps);
  conversaComHistorico(deps, PROJ_A);

  const storage = armazenamentoFalso();
  const { thread: nova } = await startNewThread({ project: PROJ_A, fetchImpl, storage });

  const reaberta = await ensureThread({
    threadId: threadLembrada(PROJ_A.id, storage), project: PROJ_A, fetchImpl,
  });

  assert.equal(reaberta.thread.id, nova.id);
  assert.equal(reaberta.criada, false);
  assert.deepEqual(reaberta.messages, []);

  deps.db.close();
});

// ── 8 · a mídia antiga sobrevive ────────────────────────────────────────────

test('8. nenhum Asset é excluído, e a mídia antiga continua ligada à mensagem', async () => {
  const deps = ambiente();
  const fetchImpl = fetchDaApi(deps);
  const { thread: antiga, asset } = conversaComHistorico(deps, PROJ_A);

  const assetsAntes = deps.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n;
  const ligacoesAntes = deps.db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n;

  await startNewThread({ project: PROJ_A, fetchImpl, storage: armazenamentoFalso() });

  assert.equal(deps.db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, assetsAntes);
  assert.equal(
    deps.db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n, ligacoesAntes,
  );

  // E ela continua chegando pela leitura da conversa antiga, com a URL do Asset.
  const doAgente = handleGetThread(antiga.id, deps).body.messages
    .find((m) => m.role === 'assistant');
  assert.equal(doAgente.assets.length, 1);
  assert.equal(doAgente.assets[0].assetId, asset.id);
  assert.match(doAgente.assets[0].mediaUrl, /^\/api\/media\//);

  deps.db.close();
});

// ── 9 · o botão fala do produto, não do runtime ─────────────────────────────

test('9. o botão não expõe nenhum conceito de runtime', async () => {
  const fonte = await readFile(path.join(RAIZ, 'components/screens/AgentScreen.jsx'), 'utf8');

  // O usuário está começando outra conversa com o Showrunner. Nada aqui é
  // "sessão", "runtime" ou "reiniciar" — essas palavras descreveriam a
  // implementação, e ainda por cima uma que a tela não deve conhecer.
  assert.match(fonte, /Nova conversa/);
  for (const proibido of [
    /Reset/i, /New Session/i, /Restart/i, /\bsess(ã|a)o\b/i, /hermes/i, /\becho\b/i,
  ]) {
    assert.ok(!proibido.test(fonte), `a AgentScreen mostra "${proibido}"`);
  }

  // E o texto do botão é o que o usuário lê — não um rótulo técnico traduzido.
  assert.ok(!/nova thread/i.test(fonte), 'a tela chama a conversa de "thread"');
});

// ── 10 · dois cliques, uma conversa ─────────────────────────────────────────

test('10. clique repetido durante o carregamento não cria duas conversas', async () => {
  // A guarda da tela é um ref, não estado: o estado do React chega tarde
  // demais para barrar o segundo clique. Aqui a guarda é reproduzida com a
  // mesma forma, sobre a API real, para provar que ela basta.
  const deps = ambiente();
  const fetchImpl = fetchDaApi(deps);

  let ocupado = false;
  const clicar = async () => {
    if (ocupado) return null;
    ocupado = true;
    try {
      return await startNewThread({
        project: PROJ_A, fetchImpl, storage: armazenamentoFalso(),
      });
    } finally {
      ocupado = false;
    }
  };

  const [primeiro, segundo] = await Promise.all([clicar(), clicar()]);

  assert.ok(primeiro?.thread?.id, 'o primeiro clique deveria ter criado a conversa');
  assert.equal(segundo, null, 'o segundo clique passou pela guarda');
  assert.equal(deps.db.prepare('SELECT COUNT(*) AS n FROM agent_threads').get().n, 1);
  assert.equal(fetchImpl.chamadas.filter((c) => c.method === 'POST').length, 1);

  deps.db.close();
});

// ── a tela usa os helpers, e não uma segunda cópia da regra ─────────────────

test('a chave do ponteiro tem UMA definição, e a tela usa a do cliente', async () => {
  assert.equal(agentThreadKey('proj_a'), 'showrunner.agent.threadId.proj_a');
  assert.equal(agentThreadKey(null), 'showrunner.agent.threadId.sem-projeto');

  const fonte = await readFile(path.join(RAIZ, 'components/screens/AgentScreen.jsx'), 'utf8');
  assert.ok(!/showrunner\.agent\.threadId/.test(fonte),
    'a AgentScreen monta a chave do localStorage por conta própria');
  assert.match(fonte, /threadLembrada|lembrarThread/);
});
