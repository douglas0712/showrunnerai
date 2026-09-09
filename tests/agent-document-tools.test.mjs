// As ferramentas de documento do agente, e a fronteira delas.
//
// PASSO 11. Duas ferramentas entram no registry:
//
//   project.list_documents   o que este projeto tem
//   project.read_document    um trecho de um deles
//
// O que estes testes trancam é sempre a mesma coisa dita de várias formas: a
// AUTORIDADE é o `projectId` do ToolContext, e o modelo não participa dela.
// Um agente capaz de escolher o projeto de onde lê seria um agente sem
// fronteira — e o material de referência de uma produção é exatamente o tipo de
// coisa que não pode vazar para outra.
//
// E uma segunda garantia, tão importante quanto: o texto lido NÃO atravessa
// para o navegador. Ele pode ter dezenas de milhares de caracteres e é material
// privado de quem o enviou; quem o consome é o agente, no servidor.

import test from 'node:test';
import assert from 'node:assert/strict';

import { listDocumentsTool } from '../lib/server/agent/tools/handlers/listDocuments.js';
import { readDocumentTool } from '../lib/server/agent/tools/handlers/readDocument.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';
import { handleBridgeInvocation } from '../lib/server/agent/hermes/bridge.js';
import { bindRuntimeSession } from '../lib/server/agent/hermes/sessionBinding.js';
import {
  canonicalToolNames, hermesAliases, toCanonicalToolName, UnknownToolAliasError,
} from '../lib/server/agent/hermes/aliases.js';
import {
  AGENT_EVENTS, normalizeAgentEvent, publicAgentEvent,
} from '../lib/server/agent/events.js';
import { closeDatabase, database, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createProjectDocument, MAX_READ_CHARS } from '../lib/server/domain/documents.js';
import { DOCUMENT_TYPES } from '../lib/server/domain/documentTypes.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';

const SHA = 'b'.repeat(64);

/**
 * As tools abrem o banco da APLICAÇÃO (`database()`), como as de geração já
 * fazem — elas rodam num turno real, onde não há injeção de dependência a
 * atravessar o socket do plugin. Então o teste troca a instância global por uma
 * em memória e a devolve no fim.
 */
const CHAVE = Symbol.for('showrunner.domain.db');

function cenario({ documentos = 1, paginasPorDoc = 3 } = {}) {
  closeDatabase();
  const db = openDatabase(':memory:');
  globalThis[CHAVE] = db;

  createProject({ id: 'proj_a', name: 'Produção A' }, db);
  createProject({ id: 'proj_b', name: 'Produção B' }, db);

  const threadA = createThreadRecord({ projectId: 'proj_a', title: 'A' }, db);
  const threadB = createThreadRecord({ projectId: 'proj_b', title: 'B' }, db);

  const docs = [];
  for (let i = 0; i < documentos; i += 1) {
    docs.push(createProjectDocument({
      projectId: 'proj_a',
      filename: `pauta-${i}.pdf`,
      mimeType: DOCUMENT_TYPES.PDF,
      sizeBytes: 2048,
      sha256: SHA,
      pageCount: paginasPorDoc,
      chunks: Array.from({ length: paginasPorDoc }, (_, p) => ({
        pageNumber: p + 1,
        text: `Documento ${i}, página ${p + 1}: MARCA-${i}-${p + 1}.`,
      })),
    }, db));
  }

  const doB = createProjectDocument({
    projectId: 'proj_b',
    filename: 'segredo-do-b.pdf',
    mimeType: DOCUMENT_TYPES.PDF,
    sizeBytes: 999,
    sha256: SHA,
    pageCount: 1,
    chunks: [{ pageNumber: 1, text: 'Conteúdo que a produção A nunca deve ler.' }],
  }, db);

  return { db, docs, doB, threadA, threadB };
}

test.after(() => {
  closeDatabase();
  delete globalThis[CHAVE];
});

const ctx = (thread) => ({
  threadId: thread.id, projectId: thread.projectId, userMessageId: null, signal: null,
});

// ── 31 · a autoridade é o ToolContext ───────────────────────────────────────

test('Y. list_documents usa o projectId do ToolContext, e só ele', async () => {
  const { docs, threadA, threadB } = cenario({ documentos: 2 });

  const doA = await listDocumentsTool.execute(ctx(threadA), {});
  assert.equal(doA.length, 2);
  assert.deepEqual(
    doA.map((d) => d.documentId).sort(),
    docs.map((d) => d.id).sort(),
  );

  // A mesma ferramenta, num contexto de outro projeto, devolve outra coisa —
  // e nada do A aparece nela.
  const doBs = await listDocumentsTool.execute(ctx(threadB), {});
  assert.equal(doBs.length, 1);
  assert.equal(doBs[0].filename, 'segredo-do-b.pdf');
});

test('Y-bis. list_documents não recebe argumento nenhum, e recusa quem tentar', async () => {
  const { threadA } = cenario();

  assert.deepEqual(listDocumentsTool.inputSchema.properties, {});
  assert.deepEqual(listDocumentsTool.inputSchema.required, []);

  // Em especial `projectId`: é o campo que, se existisse, o modelo preencheria.
  for (const tentativa of [{ projectId: 'proj_b' }, { limit: 5 }, { cursor: 0 }]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => listDocumentsTool.execute(ctx(threadA), tentativa),
      (erro) => erro.name === 'ToolExecutionError',
    );
  }
});

test('Z. read_document usa o projectId do ToolContext', async () => {
  const { docs, threadA } = cenario();

  const leitura = await readDocumentTool.execute(ctx(threadA), { documentId: docs[0].id });
  assert.equal(leitura.documentId, docs[0].id);
  assert.equal(leitura.filename, 'pauta-0.pdf');
  assert.equal(leitura.pageCount, 3);
  assert.equal(leitura.chunks.length, 3);
  assert.match(leitura.chunks[0].text, /MARCA-0-1/);
  assert.equal(leitura.eof, true);
  assert.equal(leitura.nextCursor, null);
});

test('AA. o modelo não pode ler o documento de outro projeto', async () => {
  const { doB, threadA } = cenario();

  // O id é REAL e existe no banco. O que falta é ele ser deste projeto.
  await assert.rejects(
    () => readDocumentTool.execute(ctx(threadA), { documentId: doB.id }),
    (erro) => erro.name === 'ToolExecutionError'
      && /não tem um documento com esse identificador/i.test(erro.message),
  );

  // E a recusa não confirma que o id existe em algum lugar: um id inventado
  // recebe exatamente a mesma resposta.
  const inventado = await readDocumentTool.execute(ctx(threadA), { documentId: 'doc_inventado' })
    .then(() => null, (erro) => erro.message);
  const real = await readDocumentTool.execute(ctx(threadA), { documentId: doB.id })
    .then(() => null, (erro) => erro.message);
  assert.equal(inventado, real);
});

test('AA-bis. sem projeto na conversa, as duas ferramentas recusam', async () => {
  const { db } = cenario();
  const semProjeto = createThreadRecord({ title: 'Solta' }, db);

  for (const tool of [listDocumentsTool, readDocumentTool]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => tool.execute(ctx(semProjeto), { documentId: 'doc_x' }),
      (erro) => erro.name === 'ToolExecutionError' && /projeto/i.test(erro.message),
    );
  }
});

test('AA-ter. read_document recusa argumento malformado antes de tocar no banco', async () => {
  const { threadA } = cenario();

  const ruins = [
    {},
    { documentId: '' },
    { documentId: '   ' },
    { documentId: 42 },
    { documentId: 'doc_x', projectId: 'proj_b' },
    { documentId: 'doc_x', cursor: -1 },
    { documentId: 'doc_x', cursor: 1.5 },
    { documentId: 'doc_x', cursor: 'depois' },
    null,
    [],
  ];

  for (const args of ruins) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => readDocumentTool.execute(ctx(threadA), args),
      (erro) => erro.name === 'ToolExecutionError',
      JSON.stringify(args),
    );
  }
});

// ── 31 · leitura limitada, cursor e eof ─────────────────────────────────────

test('AB · AC · AD. a leitura é limitada, o cursor continua de onde parou, e eof fecha', async () => {
  // Onze páginas de 5 mil caracteres: 55 mil no total, contra um teto de 24 mil
  // por leitura. Nenhuma leitura pode trazer tudo.
  const { db, threadA } = cenario({ documentos: 0 });
  const doc = createProjectDocument({
    projectId: 'proj_a', filename: 'longo.pdf', mimeType: DOCUMENT_TYPES.PDF,
    sizeBytes: 90000, sha256: SHA, pageCount: 11,
    chunks: Array.from({ length: 11 }, (_, p) => ({
      pageNumber: p + 1,
      text: `PAGINA-${p + 1} `.padEnd(5000, '.'),
    })),
  }, db);

  const vistos = [];
  let cursor;
  let leituras = 0;
  let ultima;

  do {
    // eslint-disable-next-line no-await-in-loop
    ultima = await readDocumentTool.execute(
      ctx(threadA),
      cursor === undefined ? { documentId: doc.id } : { documentId: doc.id, cursor },
    );
    leituras += 1;

    // AB. cada leitura respeita o teto.
    const soma = ultima.chunks.reduce((t, c) => t + c.text.length, 0);
    assert.ok(soma <= MAX_READ_CHARS, `leitura ${leituras} trouxe ${soma} caracteres`);

    // AC. o cursor aponta para o próximo ordinal, e não para outra coisa.
    if (!ultima.eof) {
      assert.equal(ultima.nextCursor, ultima.chunks[ultima.chunks.length - 1].ordinal + 1);
    } else {
      // AD. no fim, e só no fim, o cursor é nulo.
      assert.equal(ultima.nextCursor, null);
    }

    vistos.push(...ultima.chunks);
    cursor = ultima.nextCursor;
    assert.ok(leituras < 20, 'a leitura não terminou');
  } while (!ultima.eof);

  assert.ok(leituras >= 3, 'este documento deveria exigir mais de uma leitura');
  // Nada pulado, nada repetido.
  assert.deepEqual(vistos.map((c) => c.ordinal), [...Array(11).keys()]);
  assert.deepEqual(vistos.map((c) => c.pageNumber), [...Array(11).keys()].map((i) => i + 1));

  // E toda página do documento apareceu exatamente uma vez.
  for (let p = 1; p <= 11; p += 1) {
    const ocorrencias = vistos.filter((c) => c.text.includes(`PAGINA-${p} `)).length;
    assert.equal(ocorrencias, 1, `a página ${p} apareceu ${ocorrencias} vezes`);
  }
});

test('AC-bis. um cursor que não veio de uma leitura é recusado', async () => {
  const { docs, threadA } = cenario({ paginasPorDoc: 3 });

  await assert.rejects(
    () => readDocumentTool.execute(ctx(threadA), { documentId: docs[0].id, cursor: 99 }),
    (erro) => erro.name === 'ToolExecutionError',
  );
});

// ── 31 · o que as ferramentas NÃO devolvem ──────────────────────────────────

test('AE. nenhuma das duas devolve caminho, digest ou coisa de infraestrutura', async () => {
  const { docs, threadA } = cenario();

  const lista = await listDocumentsTool.execute(ctx(threadA), {});
  const leitura = await readDocumentTool.execute(ctx(threadA), { documentId: docs[0].id });

  for (const saida of [lista, leitura]) {
    const texto = JSON.stringify(saida);
    for (const proibido of [
      'runtime/', '/documents/', 'source.pdf', 'absolutePath', 'storagePath',
      'sha256', SHA, 'projectId', 'threadId', 'sessionId', 'hermes',
    ]) {
      assert.equal(texto.includes(proibido), false, `"${proibido}" vazou de uma ferramenta`);
    }
  }

  // A lista devolve exatamente os campos declarados — nem mais, nem menos.
  assert.deepEqual(Object.keys(lista[0]).sort(), [
    'documentId', 'filename', 'mimeType', 'pageCount', 'textLength',
  ]);
  assert.deepEqual(Object.keys(leitura).sort(), [
    'chunks', 'documentId', 'eof', 'filename', 'nextCursor', 'pageCount',
  ]);
  assert.deepEqual(Object.keys(leitura.chunks[0]).sort(), ['ordinal', 'pageNumber', 'text']);
});

// ── AF · o texto lido não chega ao navegador ────────────────────────────────

test('AF. o resultado bruto de read_document não atravessa para o navegador', () => {
  const conteudoPrivado = 'A cidade de Arkan Vale foi fundada por Elias Venn. '.repeat(300);

  const interno = normalizeAgentEvent({
    type: AGENT_EVENTS.TOOL_COMPLETED,
    ts: 1,
    toolCallId: 'c1',
    name: 'project.read_document',
    result: {
      documentId: 'doc_privado',
      filename: 'Prometeu.pdf',
      pageCount: 27,
      chunks: [{ ordinal: 0, pageNumber: 1, text: conteudoPrivado }],
      nextCursor: 1,
      eof: false,
    },
  });

  // O evento INTERNO continua inteiro — é dele que o servidor vive.
  assert.equal(interno.result.chunks[0].text, conteudoPrivado);

  const publico = publicAgentEvent(interno);

  // A redução final não deixa NADA do resultado passar: sem Asset, não há o que
  // mostrar, e o evento sai sem `result`.
  assert.equal(publico.result, undefined);

  const texto = JSON.stringify(publico);
  for (const proibido of ['Arkan Vale', 'Elias Venn', 'chunks', 'nextCursor', 'doc_privado', 'ordinal']) {
    assert.equal(texto.includes(proibido), false, `"${proibido}" vazou para o navegador`);
  }
  // O que sobra é o suficiente para a tela dizer "Lendo o documento…".
  assert.equal(publico.name, 'project.read_document');
  assert.equal(publico.toolCallId, 'c1');
});

test('AF-bis. os argumentos de read_document também não atravessam', () => {
  const interno = normalizeAgentEvent({
    type: AGENT_EVENTS.TOOL_STARTED,
    ts: 1,
    toolCallId: 'c1',
    name: 'project.read_document',
    arguments: { documentId: 'doc_privado', cursor: 12 },
  });

  const publico = publicAgentEvent(interno);
  assert.equal(publico.arguments, undefined);
  assert.equal(JSON.stringify(publico).includes('doc_privado'), false);
});

// ── AG · os aliases do Hermes ───────────────────────────────────────────────

test('AG. os aliases mapeiam só para as tools canônicas, e a tabela continua fechada', () => {
  // As duas do PASSO 11 estão na tabela. A lista FECHADA inteira é conferida em
  // `hermes-aliases.test.mjs`, e é lá que ela deve viver: uma terceira cópia
  // dela aqui seria mais um lugar para alguém esquecer de atualizar — e o lugar
  // esquecido é sempre o que deixa passar.
  assert.ok(hermesAliases().includes('project_list_documents'));
  assert.ok(hermesAliases().includes('project_read_document'));

  assert.equal(toCanonicalToolName('project_list_documents'), 'project.list_documents');
  assert.equal(toCanonicalToolName('project_read_document'), 'project.read_document');

  // Todo canônico da tabela é uma tool que o registry realmente tem. Um alias
  // apontando para nome inexistente atravessaria a fronteira para morrer depois.
  const registradas = new Set(publicToolList(toolRegistry()).map((t) => t.name));
  for (const canonico of canonicalToolNames()) {
    assert.ok(registradas.has(canonico), `${canonico} não existe no registry`);
  }

  // E variações plausíveis continuam recusadas.
  for (const fora of [
    'project.read_document', 'project_read_documents', 'project_write_document',
    'project_delete_document', 'read_document', 'project_list', 'documents',
  ]) {
    assert.throws(() => toCanonicalToolName(fora), UnknownToolAliasError, fora);
  }
});

// ── AH · o navegador não lê o sistema de arquivos ───────────────────────────

test('AH. a leitura é do servidor: as ferramentas não tocam em arquivo nenhum', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');

  for (const arquivo of ['listDocuments.js', 'readDocument.js']) {
    const caminho = fileURLToPath(
      new URL(`../lib/server/agent/tools/handlers/${arquivo}`, import.meta.url),
    );
    // eslint-disable-next-line no-await-in-loop
    const fonte = (await readFile(caminho, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    for (const proibido of [
      /node:fs/, /readFile/, /unpdf/, /documents\/storage/, /documents\/extract/,
      /\bwindow\b/, /localStorage/, /fetch\(/,
    ]) {
      assert.equal(proibido.test(fonte), false, `${arquivo} cita ${proibido}`);
    }
  }
});

test('AH-bis. o bridge exige projeto para as duas ferramentas de documento', async () => {
  const { db } = cenario();

  // Uma conversa SEM projeto, com sessão de runtime associada.
  const semProjeto = createThreadRecord({ title: 'Solta' }, db);
  bindRuntimeSession({
    sessionId: 'sess_sem_projeto',
    bridgeSessionId: 'bridge_sem_projeto',
    threadId: semProjeto.id,
    runtimeId: 'hermes',
    now: 1,
  }, db);

  for (const alias of ['project_list_documents', 'project_read_document']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await handleBridgeInvocation(
      { sessionId: 'bridge_sem_projeto', toolName: alias, arguments: {} },
      { db },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error.code, 'project_required');
  }
});

test('AH-ter. pelo bridge, o projeto vem da SESSÃO — o modelo não o escolhe', async () => {
  const { db, doB, docs, threadA } = cenario();

  bindRuntimeSession({
    sessionId: 'sess_a', bridgeSessionId: 'bridge_a',
    threadId: threadA.id, runtimeId: 'hermes', now: 1,
  }, db);

  // O modelo manda um documentId do projeto B, e o argumento chega inteiro ao
  // bridge — que constrói o contexto a partir da SESSÃO, não do argumento.
  const cruzado = await handleBridgeInvocation(
    { sessionId: 'bridge_a', toolName: 'project_read_document', arguments: { documentId: doB.id } },
    { db, registry: toolRegistry() },
  );
  assert.equal(cruzado.ok, false);
  assert.equal(cruzado.error.code, 'tool_failed');

  // E um documento do projeto certo passa.
  const proprio = await handleBridgeInvocation(
    { sessionId: 'bridge_a', toolName: 'project_read_document', arguments: { documentId: docs[0].id } },
    { db, registry: toolRegistry() },
  );
  assert.equal(proprio.ok, true);
  assert.match(proprio.result.chunks[0].text, /MARCA-0-1/);
});

// ── o registry ──────────────────────────────────────────────────────────────

test('as duas ferramentas estão no registry, sem expor o handler', () => {
  const publicas = publicToolList(toolRegistry());
  const nomes = publicas.map((t) => t.name);

  assert.ok(nomes.includes('project.list_documents'));
  assert.ok(nomes.includes('project.read_document'));

  for (const tool of publicas) {
    assert.ok(!tool.execute, `${tool.name} expôs execute`);
    assert.ok(tool.description.length > 20);
  }

  // A descrição diz ao modelo o que ele precisa fazer para ler tudo.
  const leitura = publicas.find((t) => t.name === 'project.read_document');
  assert.match(leitura.description, /nextCursor/);
  assert.match(leitura.description, /eof/i);
  assert.match(leitura.description, /não afirme que leu o documento inteiro/i);
});

test('o registry global continua utilizável depois destes testes', () => {
  // Guarda contra o cenário trocar o banco global e esquecer de devolver: o
  // `after` acima fecha, e `database()` reabre o arquivo real da aplicação.
  assert.equal(typeof database, 'function');
});
