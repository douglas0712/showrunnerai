// Documentos de referência do projeto — o domínio.
//
// PASSO 11. Aqui não há arquivo, não há parser e não há PDF: o que estes testes
// exercitam são as REGRAS. Projeto obrigatório, ordem dos pedaços, página
// preservada, leitura limitada e determinística, cursor recusado quando não veio
// de uma leitura, e a fronteira de projeto — que é a única coisa que impede uma
// conversa de ler o material de outra produção.
//
// A migração 8 também é conferida aqui, junto: um esquema que ganha tabela é um
// esquema que pode perder dado, e a prova de que não perdeu vale mais perto da
// tabela nova do que num arquivo separado.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DomainError, ESQUEMA_ATUAL, openDatabase, schemaVersion,
} from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import {
  countDocumentChunks, createProjectDocument, declaredDocumentFields,
  getProjectDocument, getProjectDocumentIn, listProjectDocuments, MAX_READ_CHARS,
  publicProjectDocument, readDocumentChunks, removeProjectDocument,
} from '../lib/server/domain/documents.js';
import {
  DOCUMENT_TYPES, hasPages, isDocumentType, storageExtensionFor,
} from '../lib/server/domain/documentTypes.js';
import {
  appendMessageRecord, attachMessageDocuments, createThreadRecord, listMessageDocuments,
} from '../lib/server/agent/threads.js';

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-documentos-'));
test.after(() => rm(RAIZ, { recursive: true, force: true }));

const SHA = 'a'.repeat(64);

function cenario({ projetos = ['proj_a'] } = {}) {
  const db = openDatabase(':memory:');
  for (const id of projetos) createProject({ id, name: `Projeto ${id}` }, db);
  return db;
}

function documento(db, extra = {}) {
  return createProjectDocument({
    projectId: 'proj_a',
    filename: 'pauta.pdf',
    mimeType: DOCUMENT_TYPES.PDF,
    sizeBytes: 4096,
    sha256: SHA,
    pageCount: 2,
    chunks: [
      { pageNumber: 1, text: 'Primeira página do documento.' },
      { pageNumber: 2, text: 'Segunda página do documento.' },
    ],
    ...extra,
  }, db);
}

// ── vocabulário ─────────────────────────────────────────────────────────────

test('o vocabulário aceita PDF e TXT, e mais nada', () => {
  assert.equal(isDocumentType('application/pdf'), true);
  assert.equal(isDocumentType('text/plain'), true);
  for (const fora of [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'image/png', 'text/html', 'application/octet-stream', '', null, undefined,
  ]) {
    assert.equal(isDocumentType(fora), false, `${fora} não deveria ser aceito`);
  }
});

test('só o PDF tem páginas, e a extensão de armazenamento vem da tabela', () => {
  assert.equal(hasPages(DOCUMENT_TYPES.PDF), true);
  assert.equal(hasPages(DOCUMENT_TYPES.TEXT), false);
  assert.equal(storageExtensionFor(DOCUMENT_TYPES.PDF), '.pdf');
  assert.equal(storageExtensionFor(DOCUMENT_TYPES.TEXT), '.txt');
  assert.throws(() => storageExtensionFor('image/png'));
});

// ── 28 · migração ───────────────────────────────────────────────────────────

test('28a. um banco novo nasce com as três tabelas de documento', () => {
  const db = openDatabase(path.join(RAIZ, 'novo.db'));
  // A versão é a corrente, não um número fixo: migrações novas entram depois
  // desta, e o que este teste protege é a migração 8 — não a contagem delas.
  assert.equal(schemaVersion(db), ESQUEMA_ATUAL);
  assert.ok(ESQUEMA_ATUAL >= 8, 'a migração 8 precisa continuar existindo');

  const tabelas = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all().map((t) => t.name).filter((n) => !n.startsWith('sqlite_'));

  for (const nova of ['project_documents', 'document_chunks', 'agent_message_documents']) {
    assert.ok(tabelas.includes(nova), `${nova} não foi criada`);
  }
  db.close();
});

test('28b. migrar da versão 7 para a 8 preserva tudo o que já existia', () => {
  const caminho = path.join(RAIZ, 'migra7.db');

  // Um arquivo com a FORMA da versão 7: as tabelas da migração 8 não existem, e
  // o user_version diz 7. É o estado de qualquer banco criado antes deste passo.
  const antigo = openDatabase(caminho);
  antigo.exec(
    // PASSO 12: as tabelas do planejamento também não existiam na versão 7, e
    // saem antes das de documento — `production_plan_sources` referencia
    // `project_documents`.
    // PASSO 14-B: a voz da cena sai antes da cena, do Asset e do livro-razão.
    'DROP TABLE production_scene_audio_selections; '
    + 'DROP TABLE production_scene_audio_takes; '
    + 'DROP TABLE production_scene_media_selections; '
    + 'DROP TABLE production_scene_media; '
    + 'DROP TABLE production_scenes; DROP TABLE production_scripts; '
    + 'DROP TABLE production_plan_sources; DROP TABLE production_plans; '
    + 'DROP TABLE agent_message_documents; DROP TABLE document_chunks; '
    + 'DROP TABLE project_documents; PRAGMA user_version = 7',
  );

  // Dado de cada entidade que a versão 7 já tinha.
  createProject({ id: 'proj_velho', name: 'Existia antes dos documentos' }, antigo);
  const asset = createAsset({
    projectId: 'proj_velho', kind: 'image', jobId: 'job_velho',
    filename: 'job_velho.png', url: '/api/media/image/proj_velho/job_velho.png',
  }, antigo);
  const thread = createThreadRecord({ projectId: 'proj_velho', title: 'Conversa antiga' }, antigo);
  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'user', content: 'uma fala anterior à migração',
  }, antigo);
  antigo.prepare(`
    INSERT INTO generation_jobs
      (jobId, projectId, threadId, kind, workflowId, state, createdAt, updatedAt)
    VALUES ('job_velho', 'proj_velho', ?, 'image', 'wf', 'running', 1, 1)
  `).run(thread.id);
  antigo.close();

  const migrado = openDatabase(caminho);
  assert.equal(schemaVersion(migrado), ESQUEMA_ATUAL);

  assert.equal(
    migrado.prepare('SELECT name FROM projects WHERE id = ?').get('proj_velho').name,
    'Existia antes dos documentos',
  );
  assert.equal(migrado.prepare('SELECT id FROM assets WHERE id = ?').get(asset.id).id, asset.id);
  assert.equal(
    migrado.prepare('SELECT content FROM agent_messages WHERE id = ?').get(mensagem.id).content,
    'uma fala anterior à migração',
  );
  assert.equal(
    migrado.prepare('SELECT state FROM generation_jobs WHERE jobId = ?').get('job_velho').state,
    'running',
  );

  // E a tabela nova está utilizável, com a chave estrangeira valendo.
  const doc = createProjectDocument({
    projectId: 'proj_velho',
    filename: 'pauta.txt',
    mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 12,
    sha256: SHA,
    chunks: [{ pageNumber: null, text: 'conteúdo' }],
  }, migrado);
  assert.ok(doc.id);
  assert.throws(() => migrado.prepare(`
    INSERT INTO project_documents
      (id, projectId, filename, mimeType, sizeBytes, sha256, pageCount, textLength, createdAt)
    VALUES ('doc_orfao', 'proj_inexistente', 'x.txt', 'text/plain', 1, ?, NULL, 1, 1)
  `).run(SHA));

  migrado.close();
});

test('28c. reabrir o arquivo não reexecuta a migração 8', () => {
  const caminho = path.join(RAIZ, 'reabre8.db');

  const primeira = openDatabase(caminho);
  createProject({ id: 'proj_p', name: 'Persistente' }, primeira);
  const doc = documento(primeira, { projectId: 'proj_p' });
  primeira.close();

  const segunda = openDatabase(caminho);
  assert.equal(schemaVersion(segunda), ESQUEMA_ATUAL);
  assert.equal(getProjectDocument(doc.id, segunda).filename, 'pauta.pdf');
  assert.equal(countDocumentChunks(doc.id, segunda), 2);
  segunda.close();
});

// ── 29 · o domínio do documento ─────────────────────────────────────────────

test('A. cria um documento com os pedaços dele', () => {
  const db = cenario();
  const doc = documento(db);

  assert.match(doc.id, /^doc_/);
  assert.equal(doc.projectId, 'proj_a');
  assert.equal(doc.filename, 'pauta.pdf');
  assert.equal(doc.mimeType, DOCUMENT_TYPES.PDF);
  assert.equal(doc.pageCount, 2);
  // textLength é a soma real do texto guardado, não um número informado.
  assert.equal(doc.textLength, 'Primeira página do documento.'.length + 'Segunda página do documento.'.length);
  assert.equal(countDocumentChunks(doc.id, db), 2);
});

test('B. um documento sem projeto é recusado', () => {
  const db = cenario();
  for (const semProjeto of [undefined, null, '']) {
    assert.throws(
      () => documento(db, { projectId: semProjeto }),
      (erro) => erro instanceof DomainError && /projeto/i.test(erro.message),
    );
  }
});

test('C. um documento de projeto inexistente é recusado', () => {
  const db = cenario();
  assert.throws(
    () => documento(db, { projectId: 'proj_que_nao_existe' }),
    (erro) => erro instanceof DomainError && /desconhecido/i.test(erro.message),
  );
  // E nada foi gravado: a recusa acontece antes do INSERT.
  assert.equal(listProjectDocuments('proj_que_nao_existe', db).length, 0);
});

test('C-bis. tipo não aceito, tamanho zero e digest inválido são recusados', () => {
  const db = cenario();
  assert.throws(() => documento(db, { mimeType: 'image/png' }), DomainError);
  assert.throws(() => documento(db, { sizeBytes: 0 }), DomainError);
  assert.throws(() => documento(db, { sha256: 'curto' }), DomainError);
  assert.throws(() => documento(db, { chunks: [] }), DomainError);
});

test('D. os pedaços saem na ordem em que entraram, com ordinal contínuo desde 0', () => {
  const db = cenario();
  const doc = documento(db, {
    pageCount: 4,
    chunks: [
      { pageNumber: 1, text: 'um' },
      { pageNumber: 2, text: 'dois' },
      { pageNumber: 3, text: 'três' },
      { pageNumber: 4, text: 'quatro' },
    ],
  });

  const leitura = readDocumentChunks(doc.id, {}, db);
  assert.deepEqual(leitura.chunks.map((c) => c.ordinal), [0, 1, 2, 3]);
  assert.deepEqual(leitura.chunks.map((c) => c.text), ['um', 'dois', 'três', 'quatro']);
});

test('E. a página é preservada quando o formato tem páginas, e nula quando não tem', () => {
  const db = cenario();

  // Uma página grande vira mais de um pedaço, todos com o MESMO número.
  const pdf = documento(db, {
    pageCount: 2,
    chunks: [
      { pageNumber: 1, text: 'começo da página um' },
      { pageNumber: 1, text: 'fim da página um' },
      { pageNumber: 2, text: 'a página dois' },
    ],
  });
  assert.deepEqual(
    readDocumentChunks(pdf.id, {}, db).chunks.map((c) => c.pageNumber),
    [1, 1, 2],
  );

  const txt = createProjectDocument({
    projectId: 'proj_a',
    filename: 'notas.txt',
    mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 30,
    sha256: SHA,
    chunks: [{ pageNumber: null, text: 'texto sem páginas' }],
  }, db);
  assert.equal(txt.pageCount, null);
  assert.equal(readDocumentChunks(txt.id, {}, db).chunks[0].pageNumber, null);
});

test('E-bis. um TXT não pode declarar página, e um pedaço não pode citar página inexistente', () => {
  const db = cenario();
  assert.throws(() => createProjectDocument({
    projectId: 'proj_a', filename: 'x.txt', mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 10, sha256: SHA, pageCount: 3,
    chunks: [{ pageNumber: null, text: 'a' }],
  }, db), DomainError);

  assert.throws(() => documento(db, {
    pageCount: 2, chunks: [{ pageNumber: 9, text: 'a' }],
  }), DomainError);
});

test('F. a leitura paginada é determinística e não pula nem repete nada', () => {
  const db = cenario();

  // Pedaços de 5 mil caracteres: o teto de 24 mil cabe quatro por leitura.
  const pedacos = [];
  for (let i = 0; i < 11; i += 1) {
    pedacos.push({ pageNumber: i + 1, text: `${i}`.padEnd(5000, '.') });
  }
  const doc = documento(db, { pageCount: 11, chunks: pedacos });

  const vistos = [];
  let leituras = 0;
  let cursor = 0;
  let ultima;
  do {
    ultima = readDocumentChunks(doc.id, { cursor }, db);
    leituras += 1;
    vistos.push(...ultima.chunks);
    cursor = ultima.nextCursor;
    assert.ok(leituras < 20, 'a leitura não terminou');
  } while (!ultima.eof);

  assert.ok(leituras >= 3, 'este documento deveria exigir mais de uma leitura');
  // Nenhum pulado, nenhum duplicado: os ordinais são 0..10, uma vez cada.
  assert.deepEqual(vistos.map((c) => c.ordinal), [...Array(11).keys()]);
  // E o texto reconstruído é o original, na ordem.
  assert.equal(vistos.map((c) => c.text).join(''), pedacos.map((c) => c.text).join(''));

  // A leitura respeita o teto — sem nunca cortar um pedaço ao meio.
  const primeira = readDocumentChunks(doc.id, { cursor: 0 }, db);
  const soma = primeira.chunks.reduce((t, c) => t + c.text.length, 0);
  assert.ok(soma <= MAX_READ_CHARS, `${soma} passou do teto`);
  assert.equal(primeira.eof, false);
  assert.equal(primeira.nextCursor, primeira.chunks.length);

  // Duas leituras iguais devolvem exatamente a mesma coisa.
  assert.deepEqual(readDocumentChunks(doc.id, { cursor: 0 }, db), primeira);
});

test('F-bis. um pedaço maior que o teto ainda é lido, sozinho', () => {
  const db = cenario();
  const gigante = 'x'.repeat(MAX_READ_CHARS + 5000);
  const doc = documento(db, {
    pageCount: 2,
    chunks: [{ pageNumber: 1, text: gigante }, { pageNumber: 2, text: 'depois' }],
  });

  const primeira = readDocumentChunks(doc.id, {}, db);
  assert.equal(primeira.chunks.length, 1, 'a leitura deveria devolver o pedaço grande sozinho');
  assert.equal(primeira.chunks[0].text, gigante);
  assert.equal(primeira.eof, false);

  const segunda = readDocumentChunks(doc.id, { cursor: primeira.nextCursor }, db);
  assert.equal(segunda.chunks[0].text, 'depois');
  assert.equal(segunda.eof, true);
  assert.equal(segunda.nextCursor, null);
});

test('G. um cursor que não veio de uma leitura é recusado', () => {
  const db = cenario();
  const doc = documento(db);

  for (const invalido of [-1, 1.5, 'abc', 99, {}, []]) {
    assert.throws(
      () => readDocumentChunks(doc.id, { cursor: invalido }, db),
      (erro) => erro instanceof DomainError && /leitura inválida|Ponto de leitura/i.test(erro.message),
      `cursor ${JSON.stringify(invalido)} deveria ser recusado`,
    );
  }

  // O cursor EXATAMENTE no fim é legítimo: é o que uma leitura devolveria se a
  // última tivesse parado no limite. Ele responde eof, sem trecho nenhum.
  const noFim = readDocumentChunks(doc.id, { cursor: 2 }, db);
  assert.deepEqual(noFim.chunks, []);
  assert.equal(noFim.eof, true);
});

test('G-bis. ler um documento que não existe é recusado', () => {
  const db = cenario();
  assert.throws(() => readDocumentChunks('doc_inexistente', {}, db), DomainError);
});

test('H. um documento de outro projeto não é alcançável pelo projeto de cá', () => {
  const db = cenario({ projetos: ['proj_a', 'proj_b'] });
  const doA = documento(db, { projectId: 'proj_a', filename: 'do-a.pdf' });

  // Existe, e é do A.
  assert.equal(getProjectDocumentIn('proj_a', doA.id, db).id, doA.id);

  // Para o B, ele simplesmente não existe — a mesma resposta de um id
  // inventado. Distinguir os dois confirmaria que o id é válido em algum lugar.
  assert.equal(getProjectDocumentIn('proj_b', doA.id, db), null);
  assert.equal(getProjectDocumentIn('proj_b', 'doc_inventado', db), null);
  assert.equal(getProjectDocumentIn(null, doA.id, db), null);

  // E a listagem do B não o traz.
  assert.deepEqual(listProjectDocuments('proj_b', db), []);
  assert.equal(listProjectDocuments('proj_a', db).length, 1);
});

// ── 29 · o vínculo com a mensagem ───────────────────────────────────────────

test('I. uma mensagem pode carregar um documento do MESMO projeto', () => {
  const db = cenario();
  const doc = documento(db);
  const thread = createThreadRecord({ projectId: 'proj_a', title: 'Conversa' }, db);
  const msg = appendMessageRecord({ threadId: thread.id, role: 'user', content: 'sobre o que é isto?' }, db);

  assert.deepEqual(attachMessageDocuments(msg.id, [doc.id], db), [doc.id]);

  const anexos = listMessageDocuments(msg.id, db);
  assert.equal(anexos.length, 1);
  assert.deepEqual(anexos[0], {
    documentId: doc.id,
    filename: 'pauta.pdf',
    mimeType: DOCUMENT_TYPES.PDF,
    pageCount: 2,
    textLength: doc.textLength,
  });
});

test('J. uma mensagem NÃO pode carregar documento de outro projeto', () => {
  const db = cenario({ projetos: ['proj_a', 'proj_b'] });
  const doA = documento(db, { projectId: 'proj_a' });

  const threadB = createThreadRecord({ projectId: 'proj_b', title: 'Outra produção' }, db);
  const msgB = appendMessageRecord({ threadId: threadB.id, role: 'user', content: 'leia' }, db);

  assert.deepEqual(attachMessageDocuments(msgB.id, [doA.id], db), []);
  assert.deepEqual(listMessageDocuments(msgB.id, db), []);
});

test('J-bis. uma conversa SEM projeto não recebe anexo nenhum', () => {
  const db = cenario();
  const doc = documento(db);
  const semProjeto = createThreadRecord({ title: 'Conversa solta' }, db);
  const msg = appendMessageRecord({ threadId: semProjeto.id, role: 'user', content: 'oi' }, db);

  assert.deepEqual(attachMessageDocuments(msg.id, [doc.id], db), []);
});

test('K. anexar o mesmo documento duas vezes ao mesmo turno é idempotente', () => {
  const db = cenario();
  const doc = documento(db);
  const thread = createThreadRecord({ projectId: 'proj_a', title: 'Conversa' }, db);
  const msg = appendMessageRecord({ threadId: thread.id, role: 'user', content: 'leia' }, db);

  attachMessageDocuments(msg.id, [doc.id], db);
  // Na MESMA chamada e em outra: o mesmo fato dito duas vezes não vira duas
  // linhas, e não é erro.
  attachMessageDocuments(msg.id, [doc.id, doc.id], db);
  attachMessageDocuments(msg.id, [doc.id], db);

  assert.equal(listMessageDocuments(msg.id, db).length, 1);
});

test('K-bis. anexar a uma mensagem inexistente é erro de domínio', () => {
  const db = cenario();
  const doc = documento(db);
  assert.throws(() => attachMessageDocuments('msg_inexistente', [doc.id], db), DomainError);
});

test('L. apagar o Project leva documentos, pedaços e vínculos junto', () => {
  const db = cenario();
  const doc = documento(db);
  const thread = createThreadRecord({ projectId: 'proj_a', title: 'Conversa' }, db);
  const msg = appendMessageRecord({ threadId: thread.id, role: 'user', content: 'leia' }, db);
  attachMessageDocuments(msg.id, [doc.id], db);

  db.prepare('DELETE FROM projects WHERE id = ?').run('proj_a');

  assert.equal(getProjectDocument(doc.id, db), null);
  assert.equal(countDocumentChunks(doc.id, db), 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS t FROM agent_message_documents').get().t,
    0,
  );
});

test('L-bis. apagar o documento leva os pedaços e desfaz o vínculo, sem tocar na conversa', () => {
  const db = cenario();
  const doc = documento(db);
  const thread = createThreadRecord({ projectId: 'proj_a', title: 'Conversa' }, db);
  const msg = appendMessageRecord({ threadId: thread.id, role: 'user', content: 'leia' }, db);
  attachMessageDocuments(msg.id, [doc.id], db);

  assert.equal(removeProjectDocument(doc.id, db), true);
  assert.equal(removeProjectDocument(doc.id, db), false);

  assert.equal(countDocumentChunks(doc.id, db), 0);
  assert.deepEqual(listMessageDocuments(msg.id, db), []);
  // A mensagem permanece: o usuário disse aquilo, e apagar o anexo não apaga a
  // fala.
  assert.ok(db.prepare('SELECT id FROM agent_messages WHERE id = ?').get(msg.id));
});

// ── a forma pública ─────────────────────────────────────────────────────────

test('a forma pública de um documento é uma lista fechada, sem digest nem caminho', () => {
  const db = cenario();
  const doc = documento(db);
  const publico = publicProjectDocument(doc);

  assert.deepEqual(Object.keys(publico).sort(), [...declaredDocumentFields()].sort());
  assert.deepEqual(declaredDocumentFields().sort(), [
    'createdAt', 'filename', 'id', 'mimeType', 'pageCount', 'sizeBytes', 'textLength',
  ]);

  const texto = JSON.stringify(publico);
  for (const proibido of ['sha256', SHA, 'runtime/', 'storagePath', 'absolutePath', '/documents/']) {
    assert.equal(texto.includes(proibido), false, `"${proibido}" vazou na forma pública`);
  }
});
