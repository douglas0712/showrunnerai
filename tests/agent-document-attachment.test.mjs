// O documento anexado a um TURNO.
//
// PASSO 11. Um documento pertence ao PROJETO; o anexo pertence a uma MENSAGEM.
// A diferença entre as duas coisas é o que faz "sobre o que é este documento?"
// ter resposta — e é o que impede uma conversa nova de fingir que o material de
// ontem foi entregue agora.
//
// ── O que estes testes provam, em uma frase cada ────────────────────────────
//
//   o vínculo é gravado ANTES de o agente pensar
//   o texto público da mensagem não é tocado
//   o anexo sobrevive ao reload, porque a verdade é do banco
//   uma fala nova não rouba o anexo da anterior
//   uma conversa nova enxerga o documento do projeto, e não como anexo dela
//   um documento de outro projeto não entra, mesmo pedido pelo navegador
//
// Nada aqui depende de um runtime de raciocínio real: o runtime é um duplo que
// registra o que recebeu. É a mesma técnica do resto da suíte, e é o que
// permite afirmar o que o agente REALMENTE viu.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createThread, getThread, sendMessage } from '../lib/server/agent/gateway.js';
import { handleGetThread, handleSendMessage, handleStreamMessage } from '../lib/server/agent/httpApi.js';
import { attachmentBriefing } from '../lib/server/agent/attachments.js';
import { AGENT_EVENTS } from '../lib/server/agent/events.js';
import { openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createProjectDocument } from '../lib/server/domain/documents.js';
import { DOCUMENT_TYPES } from '../lib/server/domain/documentTypes.js';
import { listMessageRecords } from '../lib/server/agent/threads.js';

const SHA = 'c'.repeat(64);

/**
 * Um runtime que não pensa e registra tudo o que recebeu.
 *
 * É o que torna afirmável a frase "o agente recebeu o contexto certo": sem um
 * duplo, a única forma de saber seria perguntar a um modelo — e a resposta dele
 * não é evidência de nada.
 */
function runtimeEspiao(resposta = 'Li o documento.') {
  const chamadas = [];
  return {
    chamadas,
    id: 'espiao',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run(argumentos) {
      chamadas.push(argumentos);
      yield { type: AGENT_EVENTS.STARTED, ts: 1 };
      yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: resposta };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };
}

function cenario() {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_a', name: 'Produção A' }, db);
  createProject({ id: 'proj_b', name: 'Produção B' }, db);

  const doc = createProjectDocument({
    projectId: 'proj_a',
    filename: 'Prometeu.pdf',
    mimeType: DOCUMENT_TYPES.PDF,
    sizeBytes: 4096,
    sha256: SHA,
    pageCount: 2,
    chunks: [
      { pageNumber: 1, text: 'Prometeu roubou o fogo dos deuses.' },
      { pageNumber: 2, text: 'E foi acorrentado ao Cáucaso.' },
    ],
  }, db);

  const outro = createProjectDocument({
    projectId: 'proj_a',
    filename: 'Notas.txt',
    mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 40,
    sha256: SHA,
    chunks: [{ pageNumber: null, text: 'anotações soltas de produção' }],
  }, db);

  const doB = createProjectDocument({
    projectId: 'proj_b',
    filename: 'Confidencial.pdf',
    mimeType: DOCUMENT_TYPES.PDF,
    sizeBytes: 999,
    sha256: SHA,
    pageCount: 1,
    chunks: [{ pageNumber: 1, text: 'material da outra produção' }],
  }, db);

  const thread = createThread({ projectId: 'proj_a' }, { db });
  return { db, doc, outro, doB, thread };
}

// ── 32 · o vínculo ──────────────────────────────────────────────────────────

test('AI. uma mensagem do usuário pode carregar um documento', async () => {
  const { db, doc, thread } = cenario();
  const runtime = runtimeEspiao();

  await sendMessage({
    threadId: thread.id, content: 'Sobre o que é este documento?', documentIds: [doc.id],
  }, { db, runtime });

  const { messages } = getThread(thread.id, { db });
  const doUsuario = messages.find((m) => m.role === 'user');

  assert.equal(doUsuario.documents.length, 1);
  assert.equal(doUsuario.documents[0].documentId, doc.id);
  assert.equal(doUsuario.documents[0].filename, 'Prometeu.pdf');
  assert.equal(doUsuario.documents[0].pageCount, 2);
});

test('AJ. o vínculo é persistido ANTES de o runtime pensar', async () => {
  const { db, doc, thread } = cenario();

  // Este runtime consulta o banco DE DENTRO do turno, antes de responder. Se o
  // vínculo fosse gravado depois, ele veria uma mensagem sem anexo — que é
  // exatamente o que o agente veria numa implementação errada.
  let visto = null;
  const runtime = {
    id: 'curioso',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run({ context }) {
      visto = db.prepare(
        'SELECT COUNT(*) AS n FROM agent_message_documents WHERE messageId = ?',
      ).get(context.userMessageId).n;
      yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'ok' };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };

  await sendMessage({ threadId: thread.id, content: 'leia', documentIds: [doc.id] }, { db, runtime });

  assert.equal(visto, 1, 'o vínculo não existia quando o runtime começou a pensar');
});

test('AK. o vínculo sobrevive à releitura — a verdade é do banco', async () => {
  const { db, doc, thread } = cenario();
  await sendMessage({
    threadId: thread.id, content: 'leia isto', documentIds: [doc.id],
  }, { db, runtime: runtimeEspiao() });

  // Três leituras seguidas, como um reload faria: o mesmo anexo, sem duplicar.
  for (let i = 0; i < 3; i += 1) {
    const r = handleGetThread(thread.id, { db });
    assert.equal(r.status, 200);
    const doUsuario = r.body.messages.find((m) => m.role === 'user');
    assert.equal(doUsuario.documents.length, 1);
    assert.equal(doUsuario.documents[0].filename, 'Prometeu.pdf');
  }
});

test('AL. o documento do turno chega ao runtime como contexto privado', async () => {
  const { db, doc, thread } = cenario();
  const runtime = runtimeEspiao();

  await sendMessage({
    threadId: thread.id, content: 'Sobre o que é este documento?', documentIds: [doc.id],
  }, { db, runtime });

  const { context } = runtime.chamadas[0];

  assert.equal(context.attachments.length, 1);
  assert.deepEqual(context.attachments[0], {
    documentId: doc.id,
    filename: 'Prometeu.pdf',
    mimeType: DOCUMENT_TYPES.PDF,
    pageCount: 2,
    textLength: doc.textLength,
  });

  // E o CONTEÚDO não vai junto: ele é lido sob demanda, pela ferramenta.
  const texto = JSON.stringify(context);
  assert.equal(texto.includes('roubou o fogo'), false, 'o texto do documento foi empurrado ao runtime');
  assert.equal(texto.includes('Cáucaso'), false);
  for (const proibido of ['sha256', SHA, 'runtime/', 'source.pdf', 'absolutePath']) {
    assert.equal(texto.includes(proibido), false, `"${proibido}" vazou para o runtime`);
  }
});

test('AL-bis. sem anexo no turno, a lista chega vazia — não ausente', async () => {
  const { db, thread } = cenario();
  const runtime = runtimeEspiao();

  await sendMessage({ threadId: thread.id, content: 'oi' }, { db, runtime });

  assert.deepEqual(runtime.chamadas[0].context.attachments, []);
  // E o aviso ao modelo não é montado: sem anexo, não há o que avisar.
  assert.equal(attachmentBriefing([]), '');
  assert.equal(attachmentBriefing(undefined), '');
});

test('AM · AN. o texto público da mensagem é exatamente o que o usuário escreveu', async () => {
  const { db, doc, thread } = cenario();
  const escrito = 'Sobre o que é este documento?';

  await sendMessage({
    threadId: thread.id, content: escrito, documentIds: [doc.id],
  }, { db, runtime: runtimeEspiao() });

  // No banco.
  const gravada = listMessageRecords(thread.id, db).find((m) => m.role === 'user');
  assert.equal(gravada.content, escrito);

  // E na leitura que a tela faz.
  const { body } = handleGetThread(thread.id, { db });
  const doUsuario = body.messages.find((m) => m.role === 'user');
  assert.equal(doUsuario.content, escrito);

  // AN. nem id, nem caminho, nem preâmbulo foram acrescentados ao texto.
  for (const proibido of [doc.id, 'documentId', 'contexto do sistema', 'Prometeu.pdf', 'runtime/']) {
    assert.equal(doUsuario.content.includes(proibido), false, `"${proibido}" entrou no texto público`);
  }
});

test('AN-bis. o aviso privado existe, é separado do texto, e não carrega conteúdo', () => {
  const aviso = attachmentBriefing([{
    documentId: 'doc_x', filename: 'Prometeu.pdf', mimeType: DOCUMENT_TYPES.PDF,
    pageCount: 27, textLength: 41000,
  }]);

  // Diz qual arquivo é, e como pedi-lo.
  assert.match(aviso, /Prometeu\.pdf/);
  assert.match(aviso, /doc_x/);
  assert.match(aviso, /27 páginas/);
  // Ensina a interpretar "este documento".
  assert.match(aviso, /este documento/i);
  // E manda LER antes de afirmar.
  assert.match(aviso, /nunca no nome do arquivo/i);
  // Sem nada de infraestrutura.
  for (const proibido of ['runtime/', 'source.pdf', 'sha256', 'projectId', 'threadId', 'hermes']) {
    assert.equal(aviso.includes(proibido), false, `"${proibido}" entrou no aviso`);
  }
});

test('AO. uma fala nova não rouba o anexo da anterior', async () => {
  const { db, doc, thread } = cenario();
  const runtime = runtimeEspiao();

  await sendMessage({
    threadId: thread.id, content: 'leia este PDF', documentIds: [doc.id],
  }, { db, runtime });
  await sendMessage({ threadId: thread.id, content: 'e agora?' }, { db, runtime });

  const { messages } = getThread(thread.id, { db });
  const doUsuario = messages.filter((m) => m.role === 'user');

  assert.equal(doUsuario.length, 2);
  assert.equal(doUsuario[0].documents.length, 1, 'o primeiro turno perdeu o anexo');
  assert.equal(doUsuario[1].documents.length, 0, 'o segundo turno roubou o anexo do primeiro');

  // E o segundo turno chegou ao runtime SEM anexo: o documento continua no
  // projeto, mas não foi entregue naquela fala.
  assert.deepEqual(runtime.chamadas[1].context.attachments, []);
});

test('AP · AQ. uma conversa nova vê o documento do projeto, mas não como anexo dela', async () => {
  const { db, doc, thread } = cenario();
  const runtime = runtimeEspiao();

  await sendMessage({
    threadId: thread.id, content: 'leia', documentIds: [doc.id],
  }, { db, runtime });

  // Outra conversa, no MESMO projeto.
  const nova = createThread({ projectId: 'proj_a' }, { db });
  await sendMessage({ threadId: nova.id, content: 'me lembre do que falamos' }, { db, runtime });

  // AP. o turno novo não finge que o documento foi anexado a ele.
  assert.deepEqual(runtime.chamadas[1].context.attachments, []);
  const { messages } = getThread(nova.id, { db });
  for (const m of messages) assert.deepEqual(m.documents, []);

  // AQ. e o documento continua sendo do projeto — a conversa antiga o mantém, e
  // a nova pode encontrá-lo pela ferramenta (mesma projectId no ToolContext).
  assert.equal(nova.projectId, 'proj_a');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM project_documents WHERE projectId = ?').get('proj_a').n,
    2,
  );
  const antiga = getThread(thread.id, { db }).messages.find((m) => m.role === 'user');
  assert.equal(antiga.documents.length, 1);
});

// ── 32 · o servidor não confia no navegador ─────────────────────────────────

test('um documento de OUTRO projeto não entra, mesmo pedido pelo navegador', async () => {
  const { db, doB, doc, thread } = cenario();
  const runtime = runtimeEspiao();

  await sendMessage({
    threadId: thread.id,
    content: 'leia estes',
    // O navegador pede os dois. Só um é deste projeto.
    documentIds: [doc.id, doB.id, 'doc_inventado'],
  }, { db, runtime });

  const anexos = runtime.chamadas[0].context.attachments;
  assert.equal(anexos.length, 1);
  assert.equal(anexos[0].documentId, doc.id);

  const { messages } = getThread(thread.id, { db });
  assert.deepEqual(
    messages.find((m) => m.role === 'user').documents.map((d) => d.documentId),
    [doc.id],
  );
});

test('vários documentos do mesmo projeto entram na ordem pedida', async () => {
  const { db, doc, outro, thread } = cenario();
  const runtime = runtimeEspiao();

  await sendMessage({
    threadId: thread.id, content: 'compare os dois', documentIds: [doc.id, outro.id],
  }, { db, runtime });

  assert.deepEqual(
    runtime.chamadas[0].context.attachments.map((a) => a.filename),
    ['Prometeu.pdf', 'Notas.txt'],
  );

  const aviso = attachmentBriefing(runtime.chamadas[0].context.attachments);
  assert.match(aviso, /estes documentos/);
  assert.match(aviso, /Prometeu\.pdf/);
  assert.match(aviso, /Notas\.txt/);
});

// ── 32 · a superfície HTTP ──────────────────────────────────────────────────

test('a API aceita documentIds nas duas portas, e recusa a forma errada', async () => {
  const { db, doc, thread } = cenario();

  const jsonOk = await handleSendMessage(
    { threadId: thread.id, content: 'leia', documentIds: [doc.id] },
    { db, runtime: runtimeEspiao() },
  );
  assert.equal(jsonOk.status, 200);

  const streamOk = handleStreamMessage(
    { threadId: thread.id, content: 'leia', documentIds: [doc.id] },
    { db, runtime: runtimeEspiao() },
  );
  assert.equal(streamOk.status, 200);

  // Forma errada é 400, e antes de qualquer escrita.
  const ruins = [
    'doc_x',
    [42],
    [''],
    [null],
    Array.from({ length: 13 }, (_, i) => `doc_${i}`),
  ];
  for (const documentIds of ruins) {
    // eslint-disable-next-line no-await-in-loop
    const r = await handleSendMessage(
      { threadId: thread.id, content: 'leia', documentIds },
      { db, runtime: runtimeEspiao() },
    );
    assert.equal(r.status, 400, JSON.stringify(documentIds));
    assert.match(r.body.error, /documentIds/);
  }

  // E `documentIds` ausente continua sendo um turno perfeitamente válido.
  const semAnexo = await handleSendMessage(
    { threadId: thread.id, content: 'oi' },
    { db, runtime: runtimeEspiao() },
  );
  assert.equal(semAnexo.status, 200);
});

test('nem a resposta do turno nem a releitura vazam texto ou caminho do documento', async () => {
  const { db, doc, thread } = cenario();

  const r = await handleSendMessage(
    { threadId: thread.id, content: 'leia', documentIds: [doc.id] },
    { db, runtime: runtimeEspiao() },
  );
  const leitura = handleGetThread(thread.id, { db });

  for (const corpo of [r.body, leitura.body]) {
    const texto = JSON.stringify(corpo);
    for (const proibido of [
      'roubou o fogo', 'Cáucaso', 'chunks', 'sha256', SHA,
      'runtime/', 'source.pdf', 'absolutePath', 'storagePath', 'hermes',
    ]) {
      assert.equal(texto.includes(proibido), false, `"${proibido}" vazou para o navegador`);
    }
  }

  // O que a tela precisa continua chegando: o nome do arquivo.
  assert.match(JSON.stringify(leitura.body), /Prometeu\.pdf/);
});
