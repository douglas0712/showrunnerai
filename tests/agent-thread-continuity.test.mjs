// A conversa continua quando o runtime recicla a sessão dele.
//
// ── O defeito que estes testes trancam ──────────────────────────────────────
//
// Encontrado no smoke real do PASSO 11. O primeiro turno funcionava; um turno
// SEGUINTE da mesma AgentThread falhava com 503 `runtime_unavailable`, e a
// única saída era o usuário clicar em "Nova conversa".
//
// A causa está no runtime: ele recolhe sozinho ("ws_orphan_reap") a sessão cujo
// WebSocket criador se desconectou e que não está executando nada, depois de
// uma janela de carência de 20 s. Como esta integração abre um socket por RPC e
// o fecha em seguida, TODA sessão nossa é órfã desde que nasce — e meio minuto
// de silêncio entre duas falas do usuário bastava para o identificador guardado
// deixar de existir. O `prompt.submit` seguinte respondia `4001 session not
// found`, e o adaptador traduzia isso como "o serviço não está disponível".
//
// ── A regra que estes testes afirmam ────────────────────────────────────────
//
// A AgentThread do Showrunner é DURÁVEL. Uma conexão WebSocket não é a
// identidade da conversa. Se a sessão do runtime for reciclada, a thread
// continua válida e o turno seguinte a restabelece — sem o usuário precisar
// criar conversa nova, recarregar a página, ou saber que existe um runtime.
//
// ── Por que o duplo, e não um runtime real ──────────────────────────────────
//
// Porque a janela de carência é de 20 segundos de relógio de parede. Um teste
// que a esperasse levaria mais tempo do que a suíte inteira e seria instável.
// `criarSessoesFalsas` imita o ciclo de vida — inclusive a distinção entre o
// identificador VIVO e o DURÁVEL — e `reciclar()` é o reap, sem esperar nada.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createHermesRuntime } from '../lib/server/agent/adapters/HermesRuntimeAdapter.js';
import { createThread, getThread, sendMessage } from '../lib/server/agent/gateway.js';
import { handleSendMessage } from '../lib/server/agent/httpApi.js';
import { AGENT_EVENTS } from '../lib/server/agent/events.js';
import { closeDatabase, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createProjectDocument } from '../lib/server/domain/documents.js';
import { DOCUMENT_TYPES } from '../lib/server/domain/documentTypes.js';
import { findSessionForThread } from '../lib/server/agent/hermes/sessionBinding.js';
import { createActiveTurnRegistry, handleBridgeInvocation } from '../lib/server/agent/hermes/bridge.js';
import { toolRegistry } from '../lib/server/agent/tools/index.js';
import {
  BRIDGE_SESSION_ID_FALSO, criarFetchFalso, criarSessoesFalsas, criarWebSocketFalso,
  roteiroDeTexto, SESSION_ID_FALSO,
} from './helpers/runtimeFalso.mjs';

const relogio = () => 1000;
const CHAVE = Symbol.for('showrunner.domain.db');

test.after(() => {
  closeDatabase();
  delete globalThis[CHAVE];
});

/**
 * Um projeto, uma conversa e o adaptador ligado a um runtime de mentira que
 * sabe reciclar sessões.
 *
 * O banco da aplicação é trocado por um em memória porque as ferramentas de
 * documento abrem `database()` — elas rodam num turno real, onde não há
 * injeção a atravessar o socket do plugin.
 */
function cenario({ resposta = 'Pronto.' } = {}) {
  closeDatabase();
  const db = openDatabase(':memory:');
  globalThis[CHAVE] = db;

  createProject({ id: 'proj_a', name: 'Produção A' }, db);

  const sessoes = criarSessoesFalsas();
  const pedidos = [];
  const turns = createActiveTurnRegistry();

  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9',
    token: 'token-de-teste',
    db,
    clock: relogio,
    turns,
    fetchImpl: criarFetchFalso(),
    webSocketImpl: criarWebSocketFalso({
      sessoes,
      roteiro: roteiroDeTexto([resposta]),
      aoEnviar: (p) => pedidos.push(p),
    }),
  });

  const thread = createThread({ projectId: 'proj_a' }, { db });
  return { db, runtime, sessoes, pedidos, turns, thread };
}

const metodos = (pedidos) => pedidos.map((p) => p.method);

// ── o defeito, reproduzido ──────────────────────────────────────────────────

test('a MESMA thread aguenta três turnos com a sessão reciclada no meio', async () => {
  const { db, runtime, sessoes, pedidos, thread } = cenario();

  // ── turno 1 ──────────────────────────────────────────────────────────────
  const t1 = await sendMessage(
    { threadId: thread.id, content: 'Sobre o que é este documento?' },
    { db, runtime },
  );
  assert.equal(t1.assistantMessage.content, 'Pronto.');

  const vinculoInicial = findSessionForThread(thread.id, 'hermes', db);
  assert.equal(vinculoInicial.sessionId, SESSION_ID_FALSO);
  assert.equal(vinculoInicial.bridgeSessionId, BRIDGE_SESSION_ID_FALSO);

  // ── o runtime recicla a sessão ───────────────────────────────────────────
  //
  // É o `ws_orphan_reap`: o identificador VIVO some, o DURÁVEL fica. Antes da
  // correção, a linha abaixo era suficiente para o turno seguinte falhar com
  // `runtime_unavailable` — e é ela que faz este teste ser a reprodução do
  // defeito, e não uma checagem de caminho feliz.
  sessoes.reciclar();

  // ── turno 2, na MESMA thread ─────────────────────────────────────────────
  const t2 = await sendMessage(
    { threadId: thread.id, content: 'Agora resuma em 10 pontos.' },
    { db, runtime },
  );
  assert.equal(t2.assistantMessage.content, 'Pronto.');
  assert.equal(t2.thread.id, thread.id, 'a conversa mudou de identidade');

  // A sessão foi REABERTA, não recriada: uma criação começaria do zero do lado
  // do runtime, e o histórico dos turnos anteriores mora lá.
  assert.equal(metodos(pedidos).filter((m) => m === 'session.resume').length, 1);
  assert.equal(metodos(pedidos).filter((m) => m === 'session.create').length, 1);

  // O vínculo aponta para o identificador vivo NOVO — e o durável não mudou,
  // que é o que mantém a ponte de ferramentas funcionando.
  const vinculoDepois = findSessionForThread(thread.id, 'hermes', db);
  assert.notEqual(vinculoDepois.sessionId, vinculoInicial.sessionId);
  assert.equal(vinculoDepois.bridgeSessionId, BRIDGE_SESSION_ID_FALSO);
  assert.equal(vinculoDepois.threadId, thread.id);

  // ── turno 3 ──────────────────────────────────────────────────────────────
  const t3 = await sendMessage(
    { threadId: thread.id, content: 'Proponha um documentário de 2 minutos.' },
    { db, runtime },
  );
  assert.equal(t3.assistantMessage.content, 'Pronto.');

  // ── a conversa, inteira e em ordem ───────────────────────────────────────
  const { messages } = getThread(thread.id, { db });
  assert.deepEqual(messages.map((m) => m.role), [
    'user', 'assistant', 'user', 'assistant', 'user', 'assistant',
  ]);
  assert.deepEqual(messages.map((m) => m.seq), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(messages.filter((m) => m.role === 'user').map((m) => m.content), [
    'Sobre o que é este documento?',
    'Agora resuma em 10 pontos.',
    'Proponha um documentário de 2 minutos.',
  ]);

  // Nenhuma duplicata: a retomada repete a FALA para o runtime, nunca a linha
  // no banco. Três turnos, três respostas.
  assert.equal(messages.filter((m) => m.role === 'assistant').length, 3);
  assert.equal(new Set(messages.map((m) => m.id)).size, 6);

  // E uma sessão só por vez: o vínculo é único por thread, sempre.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runtime_sessions').get().n, 1);
});

test('nada de `runtime_unavailable` chega ao usuário, e nada do runtime tampouco', async () => {
  const { db, runtime, sessoes, thread } = cenario({ resposta: 'Segue a proposta.' });

  await sendMessage({ threadId: thread.id, content: 'primeira' }, { db, runtime });
  sessoes.reciclar();

  const r = await handleSendMessage(
    { threadId: thread.id, content: 'segunda' },
    { db, runtime },
  );

  assert.equal(r.status, 200, 'o turno seguinte virou erro HTTP');

  const texto = JSON.stringify(r.body);
  for (const proibido of [
    'runtime_unavailable', 'temporariamente indisponível', 'session not found',
    'ws_orphan_reap', 'session.resume', 'session.create', 'session_id',
    'hermes', 'Hermes', SESSION_ID_FALSO, BRIDGE_SESSION_ID_FALSO,
  ]) {
    assert.equal(texto.includes(proibido), false, `"${proibido}" vazou para o usuário`);
  }

  // O turno saiu completo, com o vocabulário de sempre.
  const tipos = r.body.events.map((e) => e.type);
  assert.ok(tipos.includes(AGENT_EVENTS.STARTED));
  assert.ok(tipos.includes(AGENT_EVENTS.MESSAGE_COMPLETED));
  assert.ok(tipos.includes(AGENT_EVENTS.COMPLETED));
  assert.equal(tipos.includes(AGENT_EVENTS.FAILED), false);

  // E o turno não anuncia duas vezes que começou: a retomada acontece ANTES de
  // qualquer coisa ser dita, e nada é repetido para o navegador.
  assert.equal(tipos.filter((t) => t === AGENT_EVENTS.STARTED).length, 1);
  assert.equal(tipos.filter((t) => t === AGENT_EVENTS.MESSAGE_COMPLETED).length, 1);
});

// ── 7 · o documento continua acessível na mesma thread ──────────────────────

test('a ponte de ferramentas sobrevive à retomada: o documento continua legível', async () => {
  // ── O risco concreto que este teste tranca ────────────────────────────────
  //
  // Restabelecer a sessão troca o identificador VIVO. O plugin, porém, conhece
  // a sessão pelo DURÁVEL — é por ele que a chamada de ferramenta volta pelo
  // socket. Se a retomada trocasse os dois, toda ferramenta passaria a ser
  // recusada com "sessão desconhecida" logo depois de a conversa ser retomada:
  // o turno responderia, mas o agente perderia o acesso ao material.
  const { db, runtime, sessoes, thread } = cenario();

  const documento = createProjectDocument({
    projectId: 'proj_a',
    filename: 'Prometeu.pdf',
    mimeType: DOCUMENT_TYPES.PDF,
    sizeBytes: 4096,
    sha256: 'e'.repeat(64),
    pageCount: 1,
    chunks: [{ pageNumber: 1, text: 'Prometeu roubou o fogo dos deuses.' }],
  }, db);

  await sendMessage({
    threadId: thread.id,
    content: 'Sobre o que é este documento?',
    documentIds: [documento.id],
  }, { db, runtime });

  // A ferramenta funciona ANTES da reciclagem, chamada pelo nome durável — que
  // é o único que o plugin conhece.
  const antes = await handleBridgeInvocation(
    { sessionId: BRIDGE_SESSION_ID_FALSO, toolName: 'project_read_document', arguments: { documentId: documento.id } },
    { db, registry: toolRegistry() },
  );
  assert.equal(antes.ok, true);

  sessoes.reciclar();

  // Turno 2, na mesma thread, sem anexo nenhum.
  const t2 = await sendMessage(
    { threadId: thread.id, content: 'Agora resuma em 10 pontos.' },
    { db, runtime },
  );
  assert.equal(t2.thread.id, thread.id);

  // E a ferramenta continua funcionando pelo MESMO nome durável, resolvendo
  // para o MESMO projeto — apesar de o identificador vivo ter mudado.
  const depois = await handleBridgeInvocation(
    { sessionId: BRIDGE_SESSION_ID_FALSO, toolName: 'project_read_document', arguments: { documentId: documento.id } },
    { db, registry: toolRegistry() },
  );
  assert.equal(depois.ok, true, 'a ponte de ferramentas quebrou depois da retomada');
  assert.match(depois.result.chunks[0].text, /roubou o fogo/);

  const lista = await handleBridgeInvocation(
    { sessionId: BRIDGE_SESSION_ID_FALSO, toolName: 'project_list_documents', arguments: {} },
    { db, registry: toolRegistry() },
  );
  assert.equal(lista.ok, true);
  assert.deepEqual(lista.result.map((d) => d.filename), ['Prometeu.pdf']);

  // A semântica do PASSO 11 não mudou: o anexo é do turno que o recebeu, e o
  // documento é do Project.
  const { messages } = getThread(thread.id, { db });
  const doUsuario = messages.filter((m) => m.role === 'user');
  assert.equal(doUsuario[0].documents.length, 1);
  assert.equal(doUsuario[1].documents.length, 0);
});

test('sem anexo no turno, o agente reencontra o documento pelo Project', async () => {
  const { db, sessoes, thread } = cenario();

  const documento = createProjectDocument({
    projectId: 'proj_a',
    filename: 'Prometeu.pdf',
    mimeType: DOCUMENT_TYPES.PDF,
    sizeBytes: 4096,
    sha256: 'd'.repeat(64),
    pageCount: 2,
    chunks: [
      { pageNumber: 1, text: 'Prometeu roubou o fogo dos deuses.' },
      { pageNumber: 2, text: 'E foi acorrentado ao Cáucaso.' },
    ],
  }, db);

  // Um runtime que LÊ: no primeiro turno usa o anexo; no segundo, que não traz
  // anexo nenhum, encontra o documento pelo Project. É a semântica do PASSO 11
  // — documento é do Project, anexo é do turno — e ela não muda por causa da
  // retomada.
  const lidos = [];
  const runtime = runtimeQueLe(lidos);

  const t1 = await sendMessage({
    threadId: thread.id,
    content: 'Sobre o que é este documento?',
    documentIds: [documento.id],
  }, { db, runtime });
  assert.match(t1.assistantMessage.content, /roubou o fogo/);

  sessoes.reciclar();

  const t2 = await sendMessage(
    { threadId: thread.id, content: 'Agora resuma em 10 pontos.' },
    { db, runtime },
  );

  // O segundo turno funcionou, na mesma thread, e alcançou o MESMO documento —
  // pela lista do projeto, porque anexo ele não tinha.
  assert.equal(t2.thread.id, thread.id);
  assert.match(t2.assistantMessage.content, /roubou o fogo/);
  assert.deepEqual(lidos, [documento.id, documento.id]);

  // O anexo continua sendo do turno que o recebeu, e só dele.
  const { messages } = getThread(thread.id, { db });
  const doUsuario = messages.filter((m) => m.role === 'user');
  assert.equal(doUsuario[0].documents.length, 1);
  assert.equal(doUsuario[1].documents.length, 0);

  /** Um runtime que lê o documento do turno, ou o do projeto quando não há anexo. */
  function runtimeQueLe(registro) {
    return {
      id: 'leitor',
      isAvailable: () => true,
      unavailableReason: () => null,
      testConnection: async () => ({ ok: true }),
      async* run({ context, invokeTool }) {
        yield { type: AGENT_EVENTS.STARTED, ts: 1 };

        let alvo = context.attachments?.[0]?.documentId ?? null;
        if (!alvo) {
          const lista = await invokeTool('project.list_documents', {});
          alvo = lista[0]?.documentId ?? null;
        }
        const leitura = await invokeTool('project.read_document', { documentId: alvo });
        registro.push(leitura.documentId);

        yield {
          type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1,
          text: leitura.chunks.map((c) => c.text).join(' '),
        };
        yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
      },
    };
  }
});

// ── quando nem o registro durável sobrou ────────────────────────────────────

test('sem registro durável, a sessão é recriada — e a thread continua', async () => {
  const { db, runtime, sessoes, pedidos, thread } = cenario();

  await sendMessage({ threadId: thread.id, content: 'primeira' }, { db, runtime });

  // O caso extremo: nem o vivo, nem o durável. Reabrir é impossível; criar é o
  // que resta, e é degradação honesta — o Showrunner continua com mensagens,
  // documentos e Assets, e é ele que importa.
  sessoes.esquecerDuravel();

  const t2 = await sendMessage({ threadId: thread.id, content: 'segunda' }, { db, runtime });
  assert.equal(t2.assistantMessage.content, 'Pronto.');
  assert.equal(t2.thread.id, thread.id);

  // Tentou reabrir ANTES de criar: recriar sem tentar jogaria fora o histórico
  // do runtime todas as vezes, inclusive quando ele estava lá.
  assert.deepEqual(
    metodos(pedidos).filter((m) => m.startsWith('session.')),
    ['session.create', 'session.resume', 'session.create'],
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runtime_sessions').get().n, 1);
});

// ── os limites da retomada ──────────────────────────────────────────────────

test('a retomada acontece UMA vez: um runtime que recusa sempre não vira laço', async () => {
  const { db, runtime, sessoes, pedidos, thread } = cenario();
  await sendMessage({ threadId: thread.id, content: 'primeira' }, { db, runtime });

  // Este runtime falso esquece a sessão a cada `prompt.submit` — inclusive a
  // que acabou de ser reaberta. Sem teto, o adaptador repetiria para sempre.
  const original = sessoes.conhece.bind(sessoes);
  sessoes.conhece = (sid) => { const r = original(sid); sessoes.reciclar(); return r && false; };

  await assert.rejects(
    () => sendMessage({ threadId: thread.id, content: 'segunda' }, { db, runtime }),
  );

  // Duas submissões: a original e a única repetição. Nem uma a mais.
  assert.equal(metodos(pedidos).filter((m) => m === 'prompt.submit').length, 3);
});

test('depois de o modelo começar a falar, a falha NÃO é repetida', async () => {
  // A regra que impede duas respostas para um turno: repetir só é seguro
  // enquanto nada foi dito. Aqui o runtime fala e depois o canal cai — e a
  // resposta certa é a falha do turno, não uma segunda fala.
  closeDatabase();
  const db = openDatabase(':memory:');
  globalThis[CHAVE] = db;
  createProject({ id: 'proj_a', name: 'A' }, db);

  const sessoes = criarSessoesFalsas();
  const pedidos = [];
  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9',
    db,
    clock: relogio,
    turns: createActiveTurnRegistry(),
    fetchImpl: criarFetchFalso(),
    webSocketImpl: criarWebSocketFalso({
      sessoes,
      roteiro: [{ type: 'message.delta', payload: { text: 'comec' } }],
      cairAposRoteiro: true,
      aoEnviar: (p) => pedidos.push(p),
    }),
  });

  const thread = createThread({ projectId: 'proj_a' }, { db });
  await assert.rejects(() => sendMessage({ threadId: thread.id, content: 'oi' }, { db, runtime }));

  // Uma submissão só: a queda aconteceu DEPOIS da primeira palavra.
  assert.equal(metodos(pedidos).filter((m) => m === 'prompt.submit').length, 1);
  assert.equal(metodos(pedidos).filter((m) => m === 'session.resume').length, 0);
});

test('um turno cancelado não é retomado', async () => {
  const { db, runtime, sessoes, pedidos, thread } = cenario();
  await sendMessage({ threadId: thread.id, content: 'primeira' }, { db, runtime });
  sessoes.reciclar();

  const controlador = new AbortController();
  controlador.abort();

  // Cancelar é o usuário mandando parar. Reabrir a conversa do runtime para
  // insistir seria o oposto de obedecer.
  await sendMessage(
    { threadId: thread.id, content: 'segunda', signal: controlador.signal },
    { db, runtime },
  ).catch(() => {});

  assert.equal(metodos(pedidos).filter((m) => m === 'session.resume').length, 0);
});

// ── o registro de turnos não vaza ───────────────────────────────────────────

test('o registro de turnos fica vazio depois de cada turno, com ou sem retomada', async () => {
  const { db, runtime, sessoes, turns, thread } = cenario();

  await sendMessage({ threadId: thread.id, content: 'primeira' }, { db, runtime });
  assert.equal(turns.size(), 0, 'o turno 1 deixou contexto pendurado');

  sessoes.reciclar();

  await sendMessage({ threadId: thread.id, content: 'segunda' }, { db, runtime });
  // A retomada anuncia o turno DUAS vezes (uma por identificador) e desanuncia
  // as duas. Um `end` esquecido deixaria a âncora de um turno viva para a
  // chamada de ferramenta seguinte herdar.
  assert.equal(turns.size(), 0, 'a retomada deixou o registro de turnos sujo');

  await sendMessage({ threadId: thread.id, content: 'terceira' }, { db, runtime });
  assert.equal(turns.size(), 0);
});

// ── a detecção é específica, não é o código sozinho ─────────────────────────

test('`4001` sozinho NÃO é sessão reciclada — o código é genérico neste protocolo', async () => {
  // Auditado no fonte da v0.20.3: `4001` é o "400" deste protocolo e serve a
  // mais de vinte condições sem relação com sessão ("malformed server config",
  // "pcm frame too large", "slug is required"). Reconhecê-lo sozinho faria o
  // Showrunner reabrir a conversa e REPETIR a fala do usuário contra uma recusa
  // que não era sobre sessão nenhuma.
  for (const recusa of [
    { code: 4001, message: 'malformed server config' },
    { code: 4001, message: 'pcm frame too large' },
    { code: 4001, message: 'no session key' },
    { code: 4090, message: 'session not found' },
    { code: 4004, message: 'truncate_before_row_id must be an integer' },
  ]) {
    closeDatabase();
    const db = openDatabase(':memory:');
    globalThis[CHAVE] = db;
    createProject({ id: 'proj_a', name: 'A' }, db);

    const pedidos = [];
    const runtime = createHermesRuntime({
      baseUrl: 'http://127.0.0.1:9',
      db,
      clock: relogio,
      turns: createActiveTurnRegistry(),
      fetchImpl: criarFetchFalso(),
      webSocketImpl: criarWebSocketFalso({
        sessoes: criarSessoesFalsas(),
        recusarSubmissao: recusa,
        aoEnviar: (p) => pedidos.push(p),
      }),
    });

    const thread = createThread({ projectId: 'proj_a' }, { db });
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => sendMessage({ threadId: thread.id, content: 'oi' }, { db, runtime }),
      JSON.stringify(recusa),
    );

    // Uma submissão só: a recusa não foi confundida com sessão reciclada.
    assert.equal(
      metodos(pedidos).filter((m) => m === 'prompt.submit').length, 1,
      `a fala foi repetida para ${JSON.stringify(recusa)}`,
    );
    assert.equal(metodos(pedidos).filter((m) => m === 'session.resume').length, 0);
  }
});

test('e a combinação exata do runtime real É reconhecida', async () => {
  // O contrapositivo do teste acima: a mesma forma que `_sess_nowait` produz,
  // sobre `prompt.submit`, restabelece a sessão. Se este teste cair junto com
  // aquele, a detecção ficou permissiva demais; se cair sozinho, ficou estrita
  // demais — que é o modo de falhar seguro, mas ainda é um defeito.
  const { db, runtime, sessoes, pedidos, thread } = cenario();
  await sendMessage({ threadId: thread.id, content: 'primeira' }, { db, runtime });
  sessoes.reciclar();

  await sendMessage({ threadId: thread.id, content: 'segunda' }, { db, runtime });
  assert.equal(metodos(pedidos).filter((m) => m === 'session.resume').length, 1);
});

test('o registry de tools continua o da aplicação depois destes testes', () => {
  assert.ok(toolRegistry().hasTool('project.read_document'));
});
