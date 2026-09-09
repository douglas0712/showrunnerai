// Agent Gateway: o turno completo, e o que ele garante quando dá errado.
//
// O runtime usado na maior parte destes testes não é um mock frágil: é uma
// segunda implementação legítima do AgentRuntimePort, conferida pelo mesmo
// `assertRuntimePort` de produção. Ela existe para registrar o que o gateway
// entrega ao runtime e para falhar sob comando — duas coisas que o Echo, por
// ser determinístico e infalível, não pode demonstrar.
//
// A garantia mais importante daqui é a do turno que falha: a fala do usuário
// permanece, porque foi realmente dita, e nenhuma mensagem de assistente é
// criada. Nem vazia, nem parcial. Uma resposta só vira linha no banco quando o
// runtime disse que a terminou.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { assertRuntimePort } from '../lib/server/agent/AgentRuntimePort.js';
import { AGENT_EVENTS, createAgentEvent } from '../lib/server/agent/events.js';
import { createEchoRuntime } from '../lib/server/agent/adapters/EchoRuntimeAdapter.js';
import { listMessageRecords } from '../lib/server/agent/threads.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';
import {
  AGENT_NAME, AgentTurnError, createThread, getThread, listThreads,
  runtimeDiagnostics, sendMessage, ThreadNotFoundError,
} from '../lib/server/agent/gateway.js';

const novoBanco = () => openDatabase(':memory:');

/**
 * Runtime de teste: registra o que recebeu e responde o que lhe mandarem
 * responder. Cumpre o contrato inteiro, e o construtor confere isso.
 */
function runtimeDeTeste({ resposta = 'resposta do runtime', roteiro = null, disponivel = true } = {}) {
  const chamadas = [];

  const runtime = assertRuntimePort({
    id: 'teste',
    chamadas,
    isAvailable: () => disponivel,
    unavailableReason: () => (disponivel ? null : 'runtime de teste desligado'),
    testConnection: async () => ({ ok: disponivel }),
    async* run(argumentos) {
      chamadas.push(argumentos);
      if (roteiro) {
        yield* roteiro(argumentos);
        return;
      }
      yield createAgentEvent(AGENT_EVENTS.STARTED, {});
      yield createAgentEvent(AGENT_EVENTS.MESSAGE_COMPLETED, { text: resposta });
      yield createAgentEvent(AGENT_EVENTS.COMPLETED, {});
    },
  });

  return runtime;
}

const comThread = (db, entrada = {}) => createThread(entrada, { db });

// ── 12 · a mensagem do usuário é persistida ─────────────────────────────────

test('12. o gateway persiste a mensagem do usuário', async () => {
  const db = novoBanco();
  const runtime = runtimeDeTeste();
  const thread = comThread(db);

  const turno = await sendMessage(
    { threadId: thread.id, content: 'Olá Showrunner' },
    { db, runtime },
  );

  assert.equal(turno.userMessage.role, 'user');
  assert.equal(turno.userMessage.content, 'Olá Showrunner');
  assert.equal(turno.userMessage.status, 'completed');

  // No banco, não só no retorno.
  const gravadas = listMessageRecords(thread.id, db);
  assert.equal(gravadas[0].id, turno.userMessage.id);
  assert.equal(gravadas[0].content, 'Olá Showrunner');

  db.close();
});

test('12b. mensagem vazia é recusada e nada é gravado', async () => {
  const db = novoBanco();
  const runtime = runtimeDeTeste();
  const thread = comThread(db);

  for (const vazio of ['', '   ', '\n']) {
    await assert.rejects(
      () => sendMessage({ threadId: thread.id, content: vazio }, { db, runtime }),
      DomainError,
    );
  }

  assert.equal(listMessageRecords(thread.id, db).length, 0);
  assert.equal(runtime.chamadas.length, 0, 'o runtime foi chamado com mensagem vazia');

  db.close();
});

// ── 13 · o gateway chama o runtime ──────────────────────────────────────────

test('13. o gateway chama o runtime, com o contrato completo', async () => {
  const db = novoBanco();
  createProject({ id: 'proj_sinal', name: 'Sinal' }, db);
  const runtime = runtimeDeTeste();
  const thread = comThread(db, { projectId: 'proj_sinal', title: 'Direção' });

  const turno = await sendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime });

  assert.equal(runtime.chamadas.length, 1);
  const argumentos = runtime.chamadas[0];

  assert.deepEqual(
    Object.keys(argumentos).sort(),
    ['context', 'invokeTool', 'messages', 'signal', 'thread', 'tools'],
  );
  assert.equal(argumentos.thread.id, thread.id);
  assert.equal(argumentos.thread.projectId, 'proj_sinal');

  // O contexto é vocabulário do Showrunner e nada mais: nada de nó, caminho,
  // workflow ou modelo atravessa para o runtime.
  //
  // PASSO 10.0: `userMessageId` entrou. É a âncora durável DESTE turno — a fala
  // que o gateway acabou de gravar, antes de o runtime começar a pensar. Um
  // adaptador que execute ferramentas por outro canal a repassa ao registro de
  // turnos; nenhum runtime a inventa.
  //
  // PASSO 11: `attachments` entrou. São os documentos que o usuário anexou A
  // ESTE turno, em metadata segura — nome, tipo, páginas, tamanho e o
  // identificador. Nunca caminho, nunca impressão digital e nunca o texto: o
  // conteúdo é lido sob demanda pela ferramenta, não empurrado para dentro de
  // todo turno. Sem anexo, a lista é vazia — e vazia é o caso normal.
  //
  // E `images`: as imagens que ESTA conversa já produziu, para o modelo poder
  // referenciá-las. Sem isso "anime essa imagem" não tem como virar
  // image-to-video — a ferramenta de geração devolve `{ jobId, kind, status }`,
  // e o Asset só nasce depois, com o turno do modelo já encerrado. Ele nunca
  // chegava a ver um identificador para passar em `sourceAssetId`.
  assert.deepEqual(argumentos.context, {
    agentName: 'Showrunner',
    threadId: thread.id,
    projectId: 'proj_sinal',
    userMessageId: turno.userMessage.id,
    attachments: [],
    images: [],
  });

  // 24 · a coleção de tools chega vazia, provando que o argumento já existe.
  // PASSO 6: tools agora é preenchido com publicToolList()
  assert.ok(Array.isArray(argumentos.tools), 'tools deve ser um array');
  // O gateway entrega ao runtime EXATAMENTE o que o registry tem — não uma
  // seleção própria. Contar contra o registry, e não contra um número escrito
  // aqui, é o que mantém isto verdadeiro quando uma ferramenta entra: o que
  // este teste protege é a igualdade, não a quantidade.
  assert.deepEqual(
    argumentos.tools.map((t) => t.name).sort(),
    publicToolList(toolRegistry()).map((t) => t.name).sort(),
  );
  // Verifica que cada tool tem os campos corretos (sem execute)
  for (const tool of argumentos.tools) {
    assert.ok(tool.name, `tool deve ter name: ${JSON.stringify(tool)}`);
    assert.ok(tool.description, `tool deve ter description`);
    assert.ok(tool.inputSchema, `tool deve ter inputSchema`);
    assert.ok(!tool.execute, `tool não deve expor execute`);
  }
  assert.equal(argumentos.signal, null);

  db.close();
});

test('13b. o AbortSignal do chamador chega ao runtime', async () => {
  const db = novoBanco();
  const runtime = runtimeDeTeste();
  const thread = comThread(db);
  const controle = new AbortController();

  await sendMessage(
    { threadId: thread.id, content: 'Olá', signal: controle.signal },
    { db, runtime },
  );

  assert.equal(runtime.chamadas[0].signal, controle.signal);
  db.close();
});

// ── 14 · a resposta é persistida ────────────────────────────────────────────

test('14. o gateway persiste a resposta do assistente', async () => {
  const db = novoBanco();
  const runtime = runtimeDeTeste({ resposta: 'Entendi. Vamos começar pela cena 1.' });
  const thread = comThread(db);

  const turno = await sendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime });

  assert.equal(turno.assistantMessage.role, 'assistant');
  assert.equal(turno.assistantMessage.content, 'Entendi. Vamos começar pela cena 1.');
  assert.equal(turno.assistantMessage.status, 'completed');

  const gravadas = listMessageRecords(thread.id, db);
  assert.deepEqual(gravadas.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(gravadas.map((m) => m.seq), [1, 2]);
  assert.equal(gravadas[1].content, 'Entendi. Vamos começar pela cena 1.');

  db.close();
});

test('14b. o ciclo completo fecha com o Echo — thread, turno, conversa', async () => {
  const db = novoBanco();
  const runtime = createEchoRuntime();

  const thread = comThread(db, { title: 'Primeira conversa' });
  const turno = await sendMessage(
    { threadId: thread.id, content: 'Olá Showrunner' },
    { db, runtime },
  );

  assert.equal(turno.assistantMessage.content, 'Recebi: Olá Showrunner');

  const { thread: recuperada, messages } = getThread(thread.id, { db });
  assert.equal(recuperada.id, thread.id);
  assert.deepEqual(
    messages.map((m) => [m.role, m.content]),
    [['user', 'Olá Showrunner'], ['assistant', 'Recebi: Olá Showrunner']],
  );

  // A conversa avançou o relógio da thread.
  assert.ok(recuperada.updatedAt >= recuperada.createdAt);

  db.close();
});

// ── 15 · o histórico chega em ordem ─────────────────────────────────────────

test('15. o histórico chega ao runtime na ordem certa, com a fala nova por último', async () => {
  const db = novoBanco();
  const runtime = runtimeDeTeste({ resposta: 'ok' });
  const thread = comThread(db);

  await sendMessage({ threadId: thread.id, content: 'primeira' }, { db, runtime });
  await sendMessage({ threadId: thread.id, content: 'segunda' }, { db, runtime });
  await sendMessage({ threadId: thread.id, content: 'terceira' }, { db, runtime });

  assert.deepEqual(
    runtime.chamadas.map((c) => c.messages.map((m) => `${m.role}:${m.content}`)),
    [
      ['user:primeira'],
      ['user:primeira', 'assistant:ok', 'user:segunda'],
      ['user:primeira', 'assistant:ok', 'user:segunda', 'assistant:ok', 'user:terceira'],
    ],
  );

  // A mensagem deste turno é sempre a última da lista — é o que o contrato
  // promete ao adaptador, e é dela que o Echo tira a resposta.
  for (const chamada of runtime.chamadas) {
    assert.equal(chamada.messages.at(-1).role, 'user');
  }

  // E a ordem é a do servidor: `seq` crescente, sem buraco.
  const seqs = runtime.chamadas.at(-1).messages.map((m) => m.seq);
  assert.deepEqual(seqs, [1, 2, 3, 4, 5]);

  db.close();
});

// ── 16 · falha do runtime ───────────────────────────────────────────────────

test('16. runtime que explode não deixa mensagem de assistente falsa', async () => {
  const db = novoBanco();
  const thread = comThread(db);

  const explode = runtimeDeTeste({
    // eslint-disable-next-line require-yield
    roteiro: async function* () {
      throw new Error('o runtime caiu no meio do turno');
    },
  });

  await assert.rejects(
    () => sendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime: explode }),
    (erro) => erro instanceof AgentTurnError && /caiu no meio do turno/.test(erro.message),
  );

  const gravadas = listMessageRecords(thread.id, db);
  // A fala do usuário sobrevive: ela foi realmente dita.
  assert.deepEqual(gravadas.map((m) => m.role), ['user']);
  assert.equal(gravadas[0].content, 'Olá');
  db.close();
});

test('16b. deltas já recebidos são descartados se o turno não concluir', async () => {
  const db = novoBanco();
  const thread = comThread(db);

  const parcial = runtimeDeTeste({
    roteiro: async function* () {
      yield createAgentEvent(AGENT_EVENTS.STARTED, {});
      yield createAgentEvent(AGENT_EVENTS.MESSAGE_DELTA, { text: 'Metade da resp' });
      throw new Error('conexão perdida');
    },
  });

  await assert.rejects(
    () => sendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime: parcial }),
    AgentTurnError,
  );

  const gravadas = listMessageRecords(thread.id, db);
  assert.equal(gravadas.length, 1, 'uma resposta pela metade foi gravada');
  assert.ok(!gravadas.some((m) => m.content.includes('Metade da resp')));
  db.close();
});

test('16c. agent.failed derruba o turno, sem gravar resposta', async () => {
  const db = novoBanco();
  const thread = comThread(db);

  const falha = runtimeDeTeste({
    roteiro: async function* () {
      yield createAgentEvent(AGENT_EVENTS.STARTED, {});
      yield createAgentEvent(AGENT_EVENTS.FAILED, {
        error: { message: 'o agente desistiu', code: 'desistiu' },
      });
      // Mesmo que o runtime insista depois do fracasso, isto não chega ao banco.
      yield createAgentEvent(AGENT_EVENTS.MESSAGE_COMPLETED, { text: 'resposta tardia' });
    },
  });

  await assert.rejects(
    () => sendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime: falha }),
    (erro) => erro instanceof AgentTurnError && /o agente desistiu/.test(erro.message),
  );

  assert.deepEqual(listMessageRecords(thread.id, db).map((m) => m.role), ['user']);
  db.close();
});

test('16d. turno que termina sem mensagem completa é falha, não resposta vazia', async () => {
  const db = novoBanco();
  const thread = comThread(db);

  const mudo = runtimeDeTeste({
    roteiro: async function* () {
      yield createAgentEvent(AGENT_EVENTS.STARTED, {});
      yield createAgentEvent(AGENT_EVENTS.COMPLETED, {});
    },
  });

  await assert.rejects(
    () => sendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime: mudo }),
    (erro) => erro instanceof AgentTurnError && /sem produzir resposta/.test(erro.message),
  );

  assert.deepEqual(listMessageRecords(thread.id, db).map((m) => m.role), ['user']);
  db.close();
});

test('16e. evento fora do vocabulário derruba o turno em vez de atravessar', async () => {
  const db = novoBanco();
  const thread = comThread(db);

  const alheio = runtimeDeTeste({
    roteiro: async function* () {
      // O formato interno de um runtime qualquer, sem tradução.
      yield { type: 'content_block_delta', delta: { text: 'oi' }, session: 'abc' };
    },
  });

  await assert.rejects(
    () => sendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime: alheio }),
    /fora do vocabulário do Showrunner/,
  );

  assert.deepEqual(listMessageRecords(thread.id, db).map((m) => m.role), ['user']);
  db.close();
});

test('16f. runtime que não devolve um fluxo é recusado', async () => {
  const db = novoBanco();
  const thread = comThread(db);

  const errado = assertRuntimePort({
    id: 'errado',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    run: () => ({ text: 'resposta pronta, sem fluxo' }),
  });

  await assert.rejects(
    () => sendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime: errado }),
    /não devolveu um fluxo de eventos/,
  );
  db.close();
});

// ── 17 · runtime indisponível ───────────────────────────────────────────────

test('17. runtime indisponível falha ANTES de gravar qualquer coisa', async () => {
  const db = novoBanco();
  const thread = comThread(db);
  const desligado = runtimeDeTeste({ disponivel: false });

  await assert.rejects(
    () => sendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime: desligado }),
    (erro) => erro.name === 'RuntimeUnavailableError' && /desligado/.test(erro.message),
  );

  // Nem a fala do usuário: um turno que não pode começar não deixa a conversa
  // com uma pergunta pendurada que nada vai concluir.
  assert.equal(listMessageRecords(thread.id, db).length, 0);
  assert.equal(desligado.chamadas.length, 0);

  db.close();
});

test('17c. objeto que não cumpre o contrato é recusado antes do turno', async () => {
  const db = novoBanco();
  const thread = comThread(db);

  await assert.rejects(
    () => sendMessage({ threadId: thread.id, content: 'Olá' }, { db, runtime: { id: 'meio' } }),
    (erro) => erro.name === 'RuntimeContractError',
  );

  assert.equal(listMessageRecords(thread.id, db).length, 0);
  db.close();
});

// ── thread inexistente e projeto ────────────────────────────────────────────

test('conversa inexistente é recusada, sem chamar o runtime', async () => {
  const db = novoBanco();
  const runtime = runtimeDeTeste();

  await assert.rejects(
    () => sendMessage({ threadId: 'thread_fantasma', content: 'Olá' }, { db, runtime }),
    ThreadNotFoundError,
  );
  assert.throws(() => getThread('thread_fantasma', { db }), ThreadNotFoundError);
  assert.equal(runtime.chamadas.length, 0);

  db.close();
});

test('createThread recusa projeto inexistente e não o materializa', () => {
  const db = novoBanco();

  assert.throws(
    () => createThread({ projectId: 'proj_fantasma' }, { db }),
    (erro) => erro instanceof DomainError && /Projeto desconhecido/.test(erro.message),
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
  assert.deepEqual(listThreads({}, { db }), []);

  db.close();
});

test('uma conversa sem projeto é permitida — a primeira frase vem antes', async () => {
  const db = novoBanco();
  const runtime = createEchoRuntime();

  const thread = createThread({}, { db });
  assert.equal(thread.projectId, null);

  const turno = await sendMessage(
    { threadId: thread.id, content: 'Quero fazer um curta neo-noir' },
    { db, runtime },
  );
  assert.equal(turno.assistantMessage.content, 'Recebi: Quero fazer um curta neo-noir');
  // E continua sem projeto: conversar não cria projeto.
  assert.equal(turno.thread.projectId, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);

  db.close();
});

// ── 23 · identidade ─────────────────────────────────────────────────────────

test('23. o retorno do gateway não nomeia o runtime em lugar nenhum', async () => {
  const db = novoBanco();
  const thread = comThread(db);

  const turno = await sendMessage(
    { threadId: thread.id, content: 'Olá Showrunner' },
    { db, runtime: createEchoRuntime() },
  );

  const serializado = JSON.stringify(turno);
  for (const vazamento of ['echo', 'Echo:', 'runtime', 'adapter']) {
    // O texto da resposta do Echo é conteúdo da conversa; o que não pode
    // existir é METADADO nomeando o runtime. Por isso a busca é nas chaves.
    assert.ok(
      !chavesDe(turno).some((k) => k.toLowerCase().includes(vazamento.toLowerCase())),
      `a resposta carrega uma chave "${vazamento}"`,
    );
  }
  assert.ok(!/"runtime"/.test(serializado));
  assert.ok(!/"adapter"/.test(serializado));
  assert.ok(!/"model"/.test(serializado));

  db.close();
});

test('23b. o nome público do agente é Showrunner, e o id do adaptador só sai no diagnóstico', async () => {
  assert.equal(AGENT_NAME, 'Showrunner');

  const diagnostico = await runtimeDiagnostics({ runtime: createEchoRuntime() });
  assert.equal(diagnostico.agentName, 'Showrunner');
  assert.equal(diagnostico.ok, true);
  // Aqui — e só aqui — o id do adaptador aparece. A função se anuncia como
  // diagnóstico no próprio nome.
  assert.equal(diagnostico.runtime.id, 'echo');
});

function chavesDe(valor, encontradas = []) {
  if (!valor || typeof valor !== 'object') return encontradas;
  if (Array.isArray(valor)) {
    for (const item of valor) chavesDe(item, encontradas);
    return encontradas;
  }
  for (const [k, v] of Object.entries(valor)) {
    encontradas.push(k);
    chavesDe(v, encontradas);
  }
  return encontradas;
}
