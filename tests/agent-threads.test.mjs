// AgentThread e AgentMessage: a conversa do agente como estado de servidor.
//
// O ponto central destes testes é a ordem. Um turno inteiro do Echo cabe
// dentro do mesmo milissegundo, então ordenar por createdAt não ordena nada —
// a pergunta e a resposta empatam. É por isso que existe `seq`, e é isso que o
// teste de ordem exercita: mensagens gravadas no mesmo instante ainda saem na
// ordem em que foram ditas.
//
// O segundo ponto é o projeto. Uma thread pode não ter projeto (a primeira
// conversa acontece antes de o usuário decidir o que produz), mas se tiver, o
// projeto precisa existir — nenhum projeto nasce por causa de uma conversa.

import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import {
  AGENT_ROLES, appendMessageRecord, createThreadRecord, getThreadRecord,
  listMessageRecords, listThreadRecords, MAX_MESSAGE_LENGTH, renameThreadRecord,
} from '../lib/server/agent/threads.js';

const novoBanco = () => openDatabase(':memory:');

// ── 1 · criar ───────────────────────────────────────────────────────────────

test('1. cria uma AgentThread com a forma esperada', () => {
  const db = novoBanco();

  const thread = createThreadRecord({ title: 'Curta neo-noir' }, db);

  assert.deepEqual(Object.keys(thread).sort(), [
    'createdAt', 'id', 'projectId', 'status', 'title', 'updatedAt',
  ]);
  assert.match(thread.id, /^thread_[A-Za-z0-9_-]+$/);
  assert.equal(thread.title, 'Curta neo-noir');
  assert.equal(thread.status, 'active');
  assert.equal(thread.projectId, null);
  assert.equal(thread.createdAt, thread.updatedAt);

  db.close();
});

test('1b. sem título, a conversa nasce com um rótulo, nunca vazia', () => {
  const db = novoBanco();
  assert.equal(createThreadRecord({}, db).title, 'Nova conversa');
  assert.equal(createThreadRecord({ title: '   ' }, db).title, 'Nova conversa');
  db.close();
});

// ── 2 · recuperar ───────────────────────────────────────────────────────────

test('2. recupera a AgentThread criada, idêntica', () => {
  const db = novoBanco();
  const criada = createThreadRecord({ title: 'Recuperável' }, db);

  assert.deepEqual(getThreadRecord(criada.id, db), criada);
  assert.equal(getThreadRecord('thread_inexistente', db), null);
  // Id inválido é "não existe" na leitura, não exceção — quem consulta não
  // precisa envolver toda busca num try/catch.
  assert.equal(getThreadRecord(null, db), null);
  assert.equal(getThreadRecord('', db), null);

  db.close();
});

// ── 3 · thread com projeto válido ───────────────────────────────────────────

test('3. thread com Project existente guarda o vínculo', () => {
  const db = novoBanco();
  createProject({ id: 'proj_sinal', name: 'Sinal' }, db);

  const thread = createThreadRecord({ projectId: 'proj_sinal', title: 'Direção' }, db);
  assert.equal(thread.projectId, 'proj_sinal');

  assert.deepEqual(
    listThreadRecords({ projectId: 'proj_sinal' }, db).map((t) => t.id),
    [thread.id],
  );

  // E a thread sem projeto não aparece no filtro do projeto, nem vice-versa.
  const solta = createThreadRecord({ title: 'Sem projeto' }, db);
  assert.deepEqual(listThreadRecords({ projectId: null }, db).map((t) => t.id), [solta.id]);
  assert.equal(listThreadRecords({}, db).length, 2);

  db.close();
});

// ── 4 · thread com projeto inexistente ──────────────────────────────────────

test('4. thread com Project inexistente é RECUSADA — nada é criado', () => {
  const db = novoBanco();

  assert.throws(
    () => createThreadRecord({ projectId: 'proj_que_nao_existe' }, db),
    (erro) => erro instanceof DomainError && /Projeto desconhecido/.test(erro.message),
  );

  // O ponto que este teste protege: a recusa não pode ter materializado o
  // projeto pelo caminho. `ensureProject` não é importado por esta camada.
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0,
    'um projeto foi criado como efeito colateral',
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_threads').get().n, 0);

  db.close();
});

test('4b. o módulo de threads não importa ensureProject', async () => {
  const { readFile } = await import('node:fs/promises');
  const fonte = await readFile(new URL('../lib/server/agent/threads.js', import.meta.url), 'utf8');
  const semComentarios = tirarComentarios(fonte);
  assert.ok(!/ensureProject/.test(semComentarios), 'threads.js alcançou ensureProject');
});

// ── 5 · criar mensagem ──────────────────────────────────────────────────────

test('5. cria uma AgentMessage na conversa', () => {
  const db = novoBanco();
  const thread = createThreadRecord({}, db);

  const msg = appendMessageRecord({
    threadId: thread.id, role: 'user', content: 'Olá Showrunner',
  }, db);

  assert.deepEqual(Object.keys(msg).sort(), [
    'content', 'createdAt', 'id', 'role', 'seq', 'status', 'threadId',
  ]);
  assert.equal(msg.threadId, thread.id);
  assert.equal(msg.role, 'user');
  assert.equal(msg.content, 'Olá Showrunner');
  assert.equal(msg.status, 'completed');
  assert.equal(msg.seq, 1);

  db.close();
});

test('5b. mensagem vazia ou grande demais é recusada', () => {
  const db = novoBanco();
  const thread = createThreadRecord({}, db);

  for (const vazio of ['', '   ', '\n\t ', null, undefined, 42]) {
    assert.throws(
      () => appendMessageRecord({ threadId: thread.id, role: 'user', content: vazio }, db),
      DomainError,
      `aceitou conteúdo ${JSON.stringify(vazio)}`,
    );
  }

  assert.throws(
    () => appendMessageRecord({
      threadId: thread.id, role: 'user', content: 'x'.repeat(MAX_MESSAGE_LENGTH + 1),
    }, db),
    DomainError,
  );

  assert.equal(listMessageRecords(thread.id, db).length, 0);
  db.close();
});

// ── 6 · ordem ───────────────────────────────────────────────────────────────

test('6. as mensagens voltam na ordem em que foram ditas', () => {
  const db = novoBanco();
  const thread = createThreadRecord({}, db);

  // O relógio congelado é o caso real, não uma armadilha artificial: o Echo
  // responde em microssegundos e o turno inteiro cai no mesmo milissegundo.
  const MESMO_INSTANTE = 1_700_000_000_000;
  const ditas = ['primeira', 'segunda', 'terceira', 'quarta', 'quinta', 'sexta'];

  ditas.forEach((texto, i) => {
    appendMessageRecord({
      threadId: thread.id,
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: texto,
      createdAt: MESMO_INSTANTE,
    }, db);
  });

  const lidas = listMessageRecords(thread.id, db);
  assert.deepEqual(lidas.map((m) => m.content), ditas);
  assert.deepEqual(lidas.map((m) => m.seq), [1, 2, 3, 4, 5, 6]);

  // Todas gravadas no mesmo carimbo — se a ordenação fosse por createdAt, o
  // resultado acima seria indefinido.
  assert.equal(new Set(lidas.map((m) => m.createdAt)).size, 1);

  db.close();
});

test('6b. a ordem é por conversa: threads não se misturam', () => {
  const db = novoBanco();
  const a = createThreadRecord({ title: 'A' }, db);
  const b = createThreadRecord({ title: 'B' }, db);

  appendMessageRecord({ threadId: a.id, role: 'user', content: 'a1' }, db);
  appendMessageRecord({ threadId: b.id, role: 'user', content: 'b1' }, db);
  appendMessageRecord({ threadId: a.id, role: 'assistant', content: 'a2' }, db);

  assert.deepEqual(listMessageRecords(a.id, db).map((m) => m.content), ['a1', 'a2']);
  assert.deepEqual(listMessageRecords(a.id, db).map((m) => m.seq), [1, 2]);
  assert.deepEqual(listMessageRecords(b.id, db).map((m) => m.content), ['b1']);
  assert.deepEqual(listMessageRecords(b.id, db).map((m) => m.seq), [1]);

  db.close();
});

test('6c. cada mensagem move o updatedAt da conversa', () => {
  const db = novoBanco();
  const thread = createThreadRecord({ createdAt: 1000 }, db);

  appendMessageRecord({
    threadId: thread.id, role: 'user', content: 'oi', createdAt: 5000,
  }, db);

  const depois = getThreadRecord(thread.id, db);
  assert.equal(depois.updatedAt, 5000);
  assert.equal(depois.createdAt, 1000, 'createdAt não pode se mexer');

  db.close();
});

// ── 7 · papel inválido ──────────────────────────────────────────────────────

test('7. role inválido é RECUSADO e nada é gravado', () => {
  const db = novoBanco();
  const thread = createThreadRecord({}, db);

  for (const ruim of ['system', 'bot', 'developer', 'USER', '', null, undefined, 1]) {
    assert.throws(
      () => appendMessageRecord({ threadId: thread.id, role: ruim, content: 'x' }, db),
      (erro) => erro instanceof DomainError && /Papel de mensagem desconhecido/.test(erro.message),
      `aceitou role ${JSON.stringify(ruim)}`,
    );
  }

  assert.equal(listMessageRecords(thread.id, db).length, 0);
  db.close();
});

test('7b. os três papéis aceitos são user, assistant e tool', () => {
  assert.deepEqual(AGENT_ROLES, ['user', 'assistant', 'tool']);

  const db = novoBanco();
  const thread = createThreadRecord({}, db);

  // `tool` é aceito pelo esquema porque a execução de ferramenta chega no
  // Passo 6 e não deve exigir migração. Nada nesta etapa grava com esse papel.
  for (const role of AGENT_ROLES) {
    appendMessageRecord({ threadId: thread.id, role, content: `de ${role}` }, db);
  }
  assert.deepEqual(listMessageRecords(thread.id, db).map((m) => m.role), AGENT_ROLES);

  db.close();
});

test('7c. status de mensagem fora do vocabulário é recusado', () => {
  const db = novoBanco();
  const thread = createThreadRecord({}, db);

  assert.throws(
    () => appendMessageRecord({
      threadId: thread.id, role: 'user', content: 'x', status: 'inventado',
    }, db),
    DomainError,
  );

  db.close();
});

// ── 8 · thread inexistente ──────────────────────────────────────────────────

test('8. mensagem em conversa inexistente é RECUSADA', () => {
  const db = novoBanco();

  assert.throws(
    () => appendMessageRecord({
      threadId: 'thread_que_nao_existe', role: 'user', content: 'oi',
    }, db),
    (erro) => erro instanceof DomainError && /Conversa desconhecida/.test(erro.message),
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n, 0);
  assert.equal(listMessageRecords('thread_que_nao_existe', db).length, 0);

  assert.throws(() => renameThreadRecord('thread_que_nao_existe', 'x', db), DomainError);

  db.close();
});

test('8b. apagar o projeto leva a conversa junto', () => {
  const db = novoBanco();
  createProject({ id: 'proj_temporario', name: 'Temporário' }, db);
  const thread = createThreadRecord({ projectId: 'proj_temporario' }, db);
  appendMessageRecord({ threadId: thread.id, role: 'user', content: 'oi' }, db);

  db.prepare('DELETE FROM projects WHERE id = ?').run('proj_temporario');

  // Mesma regra de Scene e Asset: o registro do projeto vai embora com ele.
  assert.equal(getThreadRecord(thread.id, db), null);
  assert.equal(listMessageRecords(thread.id, db).length, 0);

  db.close();
});

function tirarComentarios(fonte) {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
