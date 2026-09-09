// PASSO 10.2 — o livro-razão das gerações.
//
// O buraco que esta tabela fecha: entre submeter uma geração e ela concluir,
// NADA sobre o trabalho chegava ao banco. O Asset só nasce no fim, então um
// reinício do processo apagava de quem era o trabalho, de que conversa, de que
// turno — e o único jeito de reencontrá-lo era adivinhar o projeto pelo
// diretório em que o arquivo caiu.
//
// Esta subetapa cria SÓ o esquema e o repositório. Nada no produto escreve nesta
// tabela ainda, e é isso mesmo: em runtime normal ela fica vazia. Ligar a
// facade e o acompanhamento é o passo seguinte.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  ASSET_KINDS, ESQUEMA_ATUAL, openDatabase, schemaVersion,
} from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import { appendMessageRecord, createThreadRecord } from '../lib/server/agent/threads.js';
import {
  bindGenerationJobMessage, completeGenerationJob, createGenerationJobRecord,
  findGenerationJobByProvider, getGenerationJobRecord, listGenerationJobsByThread,
  listOpenGenerationJobs, markGenerationJobSubmitted, setGenerationJobState,
} from '../lib/server/domain/generationJobs.js';
import {
  JOB_STATES, JOB_STATE_VALUES, TERMINAL_JOB_STATES,
} from '../lib/server/domain/generationJobStates.js';

const INSTANTE = 1_700_000_000_000;

// ── cenário ─────────────────────────────────────────────────────────────────

function cenario() {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_a', name: 'A' }, db);
  createProject({ id: 'proj_b', name: 'B' }, db);
  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const doUsuario = appendMessageRecord({
    threadId: thread.id, role: 'user', content: 'crie uma imagem',
  }, db);
  return { db, thread, doUsuario };
}

const base = (extra = {}) => ({
  jobId: 'cinema_abc_001',
  projectId: 'proj_a',
  kind: 'image',
  workflowId: 'ideogram4_t2i',
  createdAt: INSTANTE,
  ...extra,
});

// ── A · B · a migração ──────────────────────────────────────────────────────

test('B. um banco novo nasce com a tabela do livro-razão e os três índices', () => {
  const db = openDatabase(':memory:');

  // A versão corrente é o que o esquema diz que é; qual número ela tem hoje é
  // pinado em domain-documents.test.mjs, junto da migração mais nova. O que
  // ESTE arquivo garante é que a tabela do livro-razão continua nascendo com
  // ela, migração após migração.
  assert.equal(schemaVersion(db), ESQUEMA_ATUAL);

  const objetos = db.prepare(
    "SELECT name, type FROM sqlite_master WHERE name LIKE 'generation_jobs%'",
  ).all().map((r) => `${r.type}:${r.name}`).sort();

  assert.deepEqual(objetos, [
    'index:generation_jobs_abertos',
    'index:generation_jobs_por_thread',
    'index:generation_jobs_provider',
    'table:generation_jobs',
  ]);

  db.close();
});

test('C. a tabela é STRICT, como todas as outras', () => {
  const db = openDatabase(':memory:');
  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'generation_jobs'").get().sql;
  assert.match(ddl, /STRICT/);
  db.close();
});

test('A. um banco no esquema 6 migra até o corrente sem perder nada, e sem backfill', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'showrunner-mig-'));
  const arquivo = path.join(dir, 'showrunner.db');

  try {
    // Um banco como os que já existem em campo: dados reais, esquema anterior.
    {
      const db = openDatabase(arquivo);
      createProject({ id: 'proj_velho', name: 'Projeto antigo' }, db);
      const thread = createThreadRecord({ projectId: 'proj_velho' }, db);
      appendMessageRecord({ threadId: thread.id, role: 'user', content: 'oi' }, db);
      const asset = createAsset({
        projectId: 'proj_velho', kind: 'image', jobId: 'cinema_velho', filename: 'v.png',
      }, db);
      // Volta o arquivo para o esquema 6, como se o código novo nunca o tivesse
      // aberto. É esta a situação real de quem atualiza a aplicação.
      //
      // Toda tabela criada DEPOIS da 6 precisa sair, e na ordem em que as
      // chaves estrangeiras permitem: quem referencia sai antes do referenciado.
      db.exec('DROP TABLE agent_message_documents');
      db.exec('DROP TABLE document_chunks');
      db.exec('DROP TABLE project_documents');
      db.exec('DROP TABLE generation_jobs');
      db.exec('PRAGMA user_version = 6');
      assert.equal(schemaVersion(db), 6);
      assert.ok(asset.id);
      db.close();
    }

    const db = openDatabase(arquivo);

    assert.equal(schemaVersion(db), ESQUEMA_ATUAL);
    // Tudo o que existia continua existindo.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_threads').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_messages').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
    // Y. E NADA foi inventado: Assets antigos não viram gerações. Não há
    // informação para reconstruí-las corretamente, e ninguém precisa disso.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('X. reabrir um banco já no esquema corrente não recria nada nem perde dados', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'showrunner-mig7-'));
  const arquivo = path.join(dir, 'showrunner.db');

  try {
    {
      const db = openDatabase(arquivo);
      createProject({ id: 'proj_a', name: 'A' }, db);
      createGenerationJobRecord(base(), db);
      db.close();
    }

    const db = openDatabase(arquivo);
    assert.equal(schemaVersion(db), ESQUEMA_ATUAL);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 1);
    assert.ok(getGenerationJobRecord('cinema_abc_001', db));
    // E os índices continuam sendo três — nenhuma duplicata.
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'generation_jobs%'").get().n,
      3,
    );
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D · E · chaves ──────────────────────────────────────────────────────────

test('D. jobId é a chave primária, e é o NOSSO identificador', () => {
  const { db } = cenario();
  const criado = createGenerationJobRecord(base(), db);

  assert.equal(criado.jobId, 'cinema_abc_001');
  // Nenhum id novo nasceu: o registro não tem outra chave.
  assert.ok(!('id' in criado));
  assert.ok(!('generationJobId' in criado));

  const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'generation_jobs'").get().sql;
  assert.match(ddl, /jobId\s+TEXT PRIMARY KEY/);

  db.close();
});

test('E. projectId exige um projeto que existe — no repositório e na FK', () => {
  const { db } = cenario();

  assert.throws(
    () => createGenerationJobRecord(base({ projectId: 'proj_fantasma' }), db),
    /Projeto desconhecido/,
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO generation_jobs (jobId, projectId, kind, workflowId, state, createdAt, updatedAt)
      VALUES ('j', 'proj_fantasma', 'image', 'w', 'preparing', 1, 1)
    `).run(),
    /FOREIGN KEY/i,
  );

  db.close();
});

// ── F · G · H · vocabulários ────────────────────────────────────────────────

test('F. os nove estados do domínio são aceitos pela cláusula CHECK', () => {
  const { db } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'f.png' }, db);

  // Cada estado com as colunas que ele EXIGE: os CHECK do esquema amarram
  // done ↔ assetId e terminal ↔ finishedAt, então um UPDATE solto de estado
  // não é mais uma operação válida — e é bom que não seja.
  for (const estado of JOB_STATE_VALUES) {
    const id = `j_${estado}`;
    const terminal = TERMINAL_JOB_STATES.includes(estado);
    db.prepare(`
      INSERT INTO generation_jobs (
        jobId, projectId, kind, workflowId, state, assetId, error,
        createdAt, finishedAt, updatedAt
      ) VALUES (?, 'proj_a', 'image', 'w', ?, ?, ?, 1, ?, 1)
    `).run(
      id,
      estado,
      estado === JOB_STATES.DONE ? asset.id : null,
      estado === JOB_STATES.FAILED || estado === JOB_STATES.ORPHANED ? 'motivo' : null,
      terminal ? 2 : null,
    );
    assert.equal(getGenerationJobRecord(id, db).state, estado);
  }

  db.close();
});

test('G. estado fora do vocabulário é recusado pelo banco E pelo repositório', () => {
  const { db } = cenario();
  createGenerationJobRecord(base(), db);

  // O CHECK nasce de JOB_STATE_VALUES: o vocabulário do executor não passa.
  for (const invalido of ['gerando', 'na-fila', 'salvando', 'DONE', '']) {
    assert.throws(
      () => db.prepare('UPDATE generation_jobs SET state = ? WHERE jobId = ?').run(invalido, 'cinema_abc_001'),
      /CHECK/i,
      `"${invalido}" deveria ser recusado`,
    );
  }
  assert.throws(
    () => setGenerationJobState('cinema_abc_001', 'gerando', { db }),
    /Estado de geração desconhecido/,
  );

  db.close();
});

test('H. kind sai da constante de domínio que já existia, e o resto é recusado', () => {
  const { db } = cenario();

  assert.deepEqual([...ASSET_KINDS].sort(), ['image', 'video']);
  for (const kind of ASSET_KINDS) {
    assert.equal(createGenerationJobRecord(base({ jobId: `j_${kind}`, kind }), db).kind, kind);
  }
  for (const invalido of ['audio', 'IMAGE', '', null]) {
    assert.throws(
      () => createGenerationJobRecord(base({ jobId: 'j_ruim', kind: invalido }), db),
      /Tipo de geração desconhecido/,
    );
  }

  db.close();
});

// ── I · J · providerJobId ───────────────────────────────────────────────────

test('I. o identificador do executor é único quando existe', () => {
  const { db } = cenario();
  createGenerationJobRecord(base({ jobId: 'j_1' }), db);
  createGenerationJobRecord(base({ jobId: 'j_2' }), db);

  markGenerationJobSubmitted('j_1', 'prompt-uuid-1', { db, at: INSTANTE });
  assert.throws(
    () => markGenerationJobSubmitted('j_2', 'prompt-uuid-1', { db, at: INSTANTE }),
    /UNIQUE/i,
    'dois registros nossos reivindicaram o mesmo trabalho do executor',
  );

  db.close();
});

test('J. mas vários jobs podem estar sem identificador do executor ao mesmo tempo', () => {
  const { db } = cenario();

  // É a janela entre o INSERT e o aceite — e ela pode conter muitos jobs.
  for (const id of ['j_1', 'j_2', 'j_3']) createGenerationJobRecord(base({ jobId: id }), db);

  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM generation_jobs WHERE providerJobId IS NULL').get().n,
    3,
  );

  db.close();
});

// ── K · L · M · criar e buscar ──────────────────────────────────────────────

test('K. criar grava o que foi pedido, e impõe o estado inicial', () => {
  const { db, thread, doUsuario } = cenario();

  const criado = createGenerationJobRecord(base({
    threadId: thread.id,
    userMessageId: doUsuario.id,
  }), db);

  // O estado inicial NÃO é escolhido por quem chama: um caller capaz de criar
  // um job já concluído poderia registrar um resultado que nunca existiu.
  assert.equal(criado.state, JOB_STATES.PREPARING);
  assert.equal(criado.projectId, 'proj_a');
  assert.equal(criado.threadId, thread.id);
  assert.equal(criado.userMessageId, doUsuario.id);
  assert.equal(criado.kind, 'image');
  assert.equal(criado.workflowId, 'ideogram4_t2i');

  // O que só existe depois nasce nulo.
  assert.equal(criado.providerJobId, null);
  assert.equal(criado.assistantMessageId, null);
  assert.equal(criado.assetId, null);
  assert.equal(criado.derivedFromAssetId, null);
  assert.equal(criado.error, null);
  assert.equal(criado.submittedAt, null);
  assert.equal(criado.finishedAt, null);

  assert.equal(criado.createdAt, INSTANTE);
  assert.equal(criado.updatedAt, INSTANTE);

  db.close();
});

test('K-bis. o mesmo jobId duas vezes é ERRO, não idempotência silenciosa', () => {
  const { db } = cenario();
  createGenerationJobRecord(base(), db);

  assert.throws(
    () => createGenerationJobRecord(base(), db),
    /Já existe uma geração com o id/,
  );
  // E nada foi sobrescrito.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 1);

  db.close();
});

test('L+M. busca por jobId e pelo identificador do executor', () => {
  const { db } = cenario();
  createGenerationJobRecord(base(), db);

  assert.equal(getGenerationJobRecord('cinema_abc_001', db).jobId, 'cinema_abc_001');
  assert.equal(getGenerationJobRecord('nao_existe', db), null);
  assert.equal(getGenerationJobRecord('', db), null);
  assert.equal(getGenerationJobRecord(null, db), null);

  assert.equal(findGenerationJobByProvider('prompt-uuid-1', db), null);
  markGenerationJobSubmitted('cinema_abc_001', 'prompt-uuid-1', { db, at: INSTANTE + 10 });

  const achado = findGenerationJobByProvider('prompt-uuid-1', db);
  assert.equal(achado.jobId, 'cinema_abc_001');
  assert.equal(achado.state, JOB_STATES.SUBMITTED);
  assert.equal(achado.submittedAt, INSTANTE + 10);

  // Procurar por nulo não pode trazer os que ainda não foram aceitos.
  assert.equal(findGenerationJobByProvider(null, db), null);
  assert.equal(findGenerationJobByProvider('', db), null);

  db.close();
});

// ── N · O · P · Q · os jobs abertos ─────────────────────────────────────────

test('N+O+P. listOpen exclui os QUATRO terminais, e só eles', () => {
  const { db } = cenario();

  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'n.png' }, db);

  for (const estado of JOB_STATE_VALUES) {
    createGenerationJobRecord(base({ jobId: `j_${estado}`, createdAt: INSTANTE }), db);
    if (estado === JOB_STATES.DONE) {
      // `done` só é alcançável amarrando um Asset real.
      completeGenerationJob(`j_${estado}`, { assetId: asset.id, db, at: INSTANTE });
    } else if (estado !== JOB_STATES.PREPARING) {
      setGenerationJobState(`j_${estado}`, estado, {
        db,
        at: INSTANTE,
        error: [JOB_STATES.FAILED, JOB_STATES.ORPHANED].includes(estado) ? 'motivo' : null,
      });
    }
  }

  const abertos = listOpenGenerationJobs({}, db).map((j) => j.state);

  assert.deepEqual(abertos.sort(), ['finalizing', 'preparing', 'queued', 'running', 'submitted']);
  for (const terminal of TERMINAL_JOB_STATES) {
    assert.ok(!abertos.includes(terminal), `${terminal} apareceu entre os abertos`);
  }
  // Nominalmente: done e orphaned, que são os dois extremos do desfecho.
  assert.ok(!abertos.includes(JOB_STATES.DONE));
  assert.ok(!abertos.includes(JOB_STATES.ORPHANED));

  db.close();
});

test('Q. a ordem de listOpen é determinística mesmo no mesmo milissegundo', () => {
  const { db, thread } = cenario();

  // Três jobs no MESMO instante: sem desempate estável, a varredura de um
  // reinício não daria para testar.
  for (const id of ['j_c', 'j_a', 'j_b']) {
    createGenerationJobRecord(base({ jobId: id, threadId: thread.id, createdAt: INSTANTE }), db);
  }
  createGenerationJobRecord(base({ jobId: 'j_antigo', threadId: thread.id, createdAt: INSTANTE - 1000 }), db);

  assert.deepEqual(
    listOpenGenerationJobs({}, db).map((j) => j.jobId),
    ['j_antigo', 'j_a', 'j_b', 'j_c'],
  );
  // E a mesma ordem, chamada de novo.
  assert.deepEqual(
    listOpenGenerationJobs({}, db).map((j) => j.jobId),
    listOpenGenerationJobs({}, db).map((j) => j.jobId),
  );

  assert.deepEqual(
    listGenerationJobsByThread(thread.id, db).map((j) => j.jobId),
    ['j_antigo', 'j_a', 'j_b', 'j_c'],
  );
  assert.deepEqual(listGenerationJobsByThread('thread_fantasma', db), []);

  db.close();
});

test('Q-bis. listOpen filtra por projeto sem misturar produções', () => {
  const { db } = cenario();
  createGenerationJobRecord(base({ jobId: 'j_a', projectId: 'proj_a' }), db);
  createGenerationJobRecord(base({ jobId: 'j_b', projectId: 'proj_b' }), db);

  assert.deepEqual(listOpenGenerationJobs({ projectId: 'proj_a' }, db).map((j) => j.jobId), ['j_a']);
  assert.deepEqual(listOpenGenerationJobs({ projectId: 'proj_b' }, db).map((j) => j.jobId), ['j_b']);
  assert.equal(listOpenGenerationJobs({}, db).length, 2);

  db.close();
});

// ── R · S · T · coerência de mensagem e conversa ────────────────────────────

test('R. a âncora do turno precisa ser uma mensagem DE USUÁRIO, e da thread certa', () => {
  const { db, thread, doUsuario } = cenario();

  const aceito = createGenerationJobRecord(base({
    threadId: thread.id, userMessageId: doUsuario.id,
  }), db);
  assert.equal(aceito.userMessageId, doUsuario.id);

  // T. Papel errado: a resposta do assistente não é a âncora do turno.
  const doAgente = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'vou criar',
  }, db);
  assert.throws(
    () => createGenerationJobRecord(base({ jobId: 'j_2', threadId: thread.id, userMessageId: doAgente.id }), db),
    /é do papel "assistant", e aqui se espera "user"/,
  );

  // Mensagem que não existe.
  assert.throws(
    () => createGenerationJobRecord(base({ jobId: 'j_3', threadId: thread.id, userMessageId: 'msg_fantasma' }), db),
    /Mensagem desconhecida/,
  );

  db.close();
});

test('S. a âncora de OUTRA conversa é recusada', () => {
  const { db, thread } = cenario();
  const outra = createThreadRecord({ projectId: 'proj_b' }, db);
  const daOutra = appendMessageRecord({ threadId: outra.id, role: 'user', content: 'oi' }, db);

  assert.throws(
    () => createGenerationJobRecord(base({ threadId: thread.id, userMessageId: daOutra.id }), db),
    /é de outra conversa/,
  );

  db.close();
});

test('T. a mensagem do resultado precisa ser do assistente, e da mesma thread', () => {
  const { db, thread, doUsuario } = cenario();
  createGenerationJobRecord(base({ threadId: thread.id, userMessageId: doUsuario.id }), db);

  // Papel errado.
  assert.throws(
    () => bindGenerationJobMessage('cinema_abc_001', doUsuario.id, { db }),
    /é do papel "user", e aqui se espera "assistant"/,
  );

  // Conversa errada.
  const outra = createThreadRecord({ projectId: 'proj_b' }, db);
  const doOutroAgente = appendMessageRecord({ threadId: outra.id, role: 'assistant', content: 'x' }, db);
  assert.throws(
    () => bindGenerationJobMessage('cinema_abc_001', doOutroAgente.id, { db }),
    /é de outra conversa/,
  );

  const daThread = appendMessageRecord({ threadId: thread.id, role: 'assistant', content: 'pronto' }, db);
  const ligado = bindGenerationJobMessage('cinema_abc_001', daThread.id, { db, at: INSTANTE + 5 });
  assert.equal(ligado.assistantMessageId, daThread.id);
  assert.equal(ligado.updatedAt, INSTANTE + 5);
  // Amarrar a mensagem não diz nada sobre o desfecho.
  assert.equal(ligado.state, JOB_STATES.PREPARING);

  db.close();
});

test('R-bis. sem conversa nenhuma o registro é válido — nem toda geração é do Agent', () => {
  const { db } = cenario();

  // As telas do Studio geram com projeto e sem thread. O livro-razão precisa
  // conseguir representar isso, senão ele não é o livro-razão do produto.
  const criado = createGenerationJobRecord(base({ jobId: 'j_studio' }), db);
  assert.equal(criado.threadId, null);
  assert.equal(criado.userMessageId, null);
  assert.ok(listOpenGenerationJobs({}, db).some((j) => j.jobId === 'j_studio'));

  db.close();
});

// ── U · V · W · Assets e políticas de exclusão ──────────────────────────────

test('U+V. assetId e derivedFromAssetId apontam para Assets reais', () => {
  const { db } = cenario();
  const origem = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'a.png' }, db);
  const resultado = createAsset({ projectId: 'proj_a', kind: 'video', filename: 'b.mp4' }, db);

  const criado = createGenerationJobRecord(
    base({ jobId: 'j_i2v', kind: 'video', derivedFromAssetId: origem.id }), db,
  );
  assert.equal(criado.derivedFromAssetId, origem.id);

  const ligado = completeGenerationJob('j_i2v', { assetId: resultado.id, db });
  assert.equal(ligado.assetId, resultado.id);
  assert.equal(ligado.state, JOB_STATES.DONE);

  // Um Asset que não existe é recusado antes de chegar à chave estrangeira.
  assert.throws(
    () => completeGenerationJob('j_i2v', { assetId: 'asset_fantasma', db }),
    /já terminou|Asset desconhecido/,
  );

  db.close();
});

test('W. apagar conversa e mensagem preserva o registro da geração', () => {
  const { db, thread, doUsuario } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'a.png' }, db);
  createGenerationJobRecord(base({ threadId: thread.id, userMessageId: doUsuario.id }), db);
  completeGenerationJob('cinema_abc_001', { assetId: asset.id, db });

  // ON DELETE SET NULL nas três referências de conversa: um Asset sobrevive à
  // conversa que o pediu, e o registro de que ele foi produzido também.
  db.prepare('DELETE FROM agent_threads WHERE id = ?').run(thread.id);

  const depois = getGenerationJobRecord('cinema_abc_001', db);
  assert.ok(depois, 'o registro da geração foi apagado junto com a conversa');
  assert.equal(depois.threadId, null);
  assert.equal(depois.userMessageId, null);
  assert.equal(depois.assetId, asset.id);
  assert.equal(depois.projectId, 'proj_a');

  // O projeto, esse, manda: apagá-lo apaga o que foi produzido nele.
  db.prepare('DELETE FROM projects WHERE id = ?').run('proj_a');
  assert.equal(getGenerationJobRecord('cinema_abc_001', db), null);

  db.close();
});

// ── ciclo de vida ───────────────────────────────────────────────────────────

test('nenhuma operação de ciclo de vida cria registro', () => {
  const { db } = cenario();

  for (const chamar of [
    () => markGenerationJobSubmitted('nao_existe', 'p', { db }),
    () => setGenerationJobState('nao_existe', JOB_STATES.RUNNING, { db }),
    () => completeGenerationJob('nao_existe', { assetId: 'a', db }),
    () => bindGenerationJobMessage('nao_existe', 'msg', { db }),
  ]) {
    assert.throws(chamar, /Geração desconhecida/);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);

  db.close();
});

// ── AA · AB · Z · as fronteiras do arquivo ──────────────────────────────────

async function codigoDe(relativo) {
  const fonte = await readFile(fileURLToPath(new URL(relativo, import.meta.url)), 'utf8');
  // Comentários fora, pela mesma razão de `agent-architecture.test.mjs`: a
  // explicação precisa poder citar o que o código não pode.
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('AA+AB. o repositório não conhece executor, runtime nem agente', async () => {
  const codigo = await codigoDe('../lib/server/domain/generationJobs.js');

  for (const proibido of [
    /comfy/i, /minimax/i, /ideogram/i, /veo/i, /kling/i, /workflow\//,
    /hermes/i, /\bruntime\b/i, /session/i, /bridge/i, /adapters?\//,
    /\bfetch\b/, /node:fs/, /node:net/,
  ]) {
    assert.ok(!proibido.test(codigo), `generationJobs.js cita ${proibido}`);
  }

  // Ele alcança o domínio e o vocabulário de estados, e nada além.
  const importados = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(importados, ['./db.js', './generationJobStates.js', './projects.js']);
});

test('Z. nenhum DADO do livro-razão é servido ao navegador', async () => {
  // O livro-razão é estado de servidor. As rotas de geração o mantêm — desde o
  // PASSO 10.3 elas entram pela camada de geração, que registra e sincroniza —
  // mas nenhuma DEVOLVE linha dele: o que sai continua sendo o recorte que a
  // tela já consumia.
  const { readdir } = await import('node:fs/promises');
  const raiz = fileURLToPath(new URL('../app/api/', import.meta.url));

  async function arquivos(dir) {
    const saida = [];
    for (const entrada of await readdir(dir, { withFileTypes: true })) {
      const caminho = path.join(dir, entrada.name);
      if (entrada.isDirectory()) saida.push(...await arquivos(caminho));
      else if (entrada.name.endsWith('.js')) saida.push(caminho);
    }
    return saida;
  }

  for (const caminho of await arquivos(raiz)) {
    const fonte = await readFile(caminho, 'utf8');
    const rotulo = `${path.basename(path.dirname(caminho))}/${path.basename(caminho)}`;

    // A tabela em si nunca é alcançada por uma rota.
    assert.ok(!/generation_jobs/.test(fonte), `${rotulo} alcança a tabela`);
    // E nenhuma operação do repositório é chamada de dentro de uma rota: o
    // ciclo de vida do registro é da camada de geração.
    for (const operacao of [
      'createGenerationJobRecord', 'getGenerationJobRecord', 'setGenerationJobState',
      'markGenerationJobSubmitted', 'completeGenerationJob', 'bindGenerationJobMessage',
      'listOpenGenerationJobs', 'findGenerationJobByProvider',
    ]) {
      assert.ok(!fonte.includes(operacao), `${rotulo} chama ${operacao}`);
    }
  }

  const cliente = await readFile(
    fileURLToPath(new URL('../lib/agentClient.js', import.meta.url)), 'utf8',
  );
  assert.ok(!/generation_jobs|GenerationJob/.test(cliente));
});

test('o ciclo de geração escreve no livro-razão — e só onde deve', async () => {
  // Este teste era o inverso no PASSO 10.2, quando a tabela existia e nada
  // escrevia nela. O 10.3 é exatamente a mudança que ele vigiava, e agora ele
  // vigia o outro lado: QUEM pode escrever.
  //
  // A camada de geração possui o ciclo de vida do registro. O gateway amarra a
  // mensagem do turno, que é o único fato que ele conhece e a geração não.
  const facade = await codigoDe('../lib/server/generation/facade.js');
  assert.match(facade, /createGenerationJobRecord/);
  assert.match(facade, /markGenerationJobSubmitted/);
  assert.match(facade, /completeGenerationJob/);

  const gateway = await codigoDe('../lib/server/agent/gateway.js');
  assert.match(gateway, /bindGenerationJobMessage/);

  // O acompanhamento do agente NÃO escreve: ele observa pela facade, e é ela
  // que anota. Três implementações da mesma sincronização divergiriam.
  const watcher = await codigoDe('../lib/server/agent/tools/jobWatch.js');
  assert.ok(
    !/generationJobs|GenerationJobRecord|setGenerationJobState|completeGenerationJob/.test(watcher),
    'o acompanhamento virou um segundo escritor do livro-razão',
  );

  // E ninguém escreve nele de dentro do adaptador do executor: o livro-razão é
  // do Showrunner, não do ComfyUI.
  const provider = await codigoDe('../lib/server/comfy/provider.js');
  assert.ok(!/generationJobs|generation_jobs/.test(provider));
});

// ── as invariantes estruturais do livro-razão ───────────────────────────────
//
// Três regras que não podem depender da boa vontade de quem escreve: a direção
// da dependência, a coerência entre conversa e mensagem, e a amarração entre
// concluir e ter resultado. As duas últimas estão no ESQUEMA, não só aqui — um
// CHECK vale para qualquer escritor, inclusive um que ainda não existe.

test('A. a camada de domínio não importa a camada de geração', async () => {
  const { readdir } = await import('node:fs/promises');
  const raiz = fileURLToPath(new URL('../lib/server/domain/', import.meta.url));

  for (const entrada of await readdir(raiz)) {
    if (!entrada.endsWith('.js')) continue;
    const codigo = await codigoDe(`../lib/server/domain/${entrada}`);
    const importados = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

    for (const alvo of importados) {
      assert.ok(
        !alvo.includes('generation/'),
        `domain/${entrada} importa "${alvo}" — o domínio não depende da geração`,
      );
    }
  }
});

test('B. há UMA fonte de JOB_STATES, e a camada de geração a reexporta', async () => {
  const doDominio = await import('../lib/server/domain/generationJobStates.js');
  const daGeracao = await import('../lib/server/generation/jobStates.js');

  // Mesmo objeto, não uma cópia com os mesmos valores.
  assert.equal(daGeracao.JOB_STATES, doDominio.JOB_STATES);
  assert.equal(daGeracao.JOB_STATE_VALUES, doDominio.JOB_STATE_VALUES);
  assert.equal(daGeracao.TERMINAL_JOB_STATES, doDominio.TERMINAL_JOB_STATES);
  assert.equal(daGeracao.GenerationStateError, doDominio.GenerationStateError);

  // E a fonte continua sem importar nada.
  const fonte = await codigoDe('../lib/server/domain/generationJobStates.js');
  assert.deepEqual([...fonte.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]), []);

  // O arquivo da geração é só reexportação — nenhuma constante duplicada.
  const reexport = await codigoDe('../lib/server/generation/jobStates.js');
  assert.ok(!/JOB_STATES\s*=/.test(reexport), 'a camada de geração redeclarou o vocabulário');
});

test('C. userMessageId sem threadId é recusado', () => {
  const { db, doUsuario } = cenario();

  // Conhecer a fala e não conhecer a conversa é uma linha que sabe metade.
  assert.throws(
    () => createGenerationJobRecord(base({ threadId: null, userMessageId: doUsuario.id }), db),
    /userMessageId exige threadId/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);

  db.close();
});

test('D. assistantMessageId sem threadId é recusado', () => {
  const { db, thread } = cenario();
  const doAgente = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'pronto',
  }, db);

  // Um job sem conversa (as telas do Studio) não pode ganhar a mensagem depois.
  createGenerationJobRecord(base({ jobId: 'j_studio' }), db);
  assert.throws(
    () => bindGenerationJobMessage('j_studio', doAgente.id, { db }),
    /assistantMessageId exige threadId/,
  );
  assert.equal(getGenerationJobRecord('j_studio', db).assistantMessageId, null);

  db.close();
});

test('E. conversa e mensagens coerentes continuam sendo aceitas', () => {
  const { db, thread, doUsuario } = cenario();
  const doAgente = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'vou criar',
  }, db);
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'e.png' }, db);

  const criado = createGenerationJobRecord(
    base({ threadId: thread.id, userMessageId: doUsuario.id }), db,
  );
  assert.equal(criado.userMessageId, doUsuario.id);

  const concluido = completeGenerationJob('cinema_abc_001', {
    assetId: asset.id, assistantMessageId: doAgente.id, db, at: INSTANTE + 9,
  });
  assert.equal(concluido.assistantMessageId, doAgente.id);
  assert.equal(concluido.assetId, asset.id);

  db.close();
});

test('F. Asset de outro projeto é recusado como resultado', () => {
  const { db } = cenario();
  const doOutroProjeto = createAsset({ projectId: 'proj_b', kind: 'image', filename: 'b.png' }, db);
  createGenerationJobRecord(base(), db);

  assert.throws(
    () => completeGenerationJob('cinema_abc_001', { assetId: doOutroProjeto.id, db }),
    /é de outro projeto/,
  );
  // E a transação foi desfeita: o job continua aberto e sem Asset.
  const depois = getGenerationJobRecord('cinema_abc_001', db);
  assert.equal(depois.state, JOB_STATES.PREPARING);
  assert.equal(depois.assetId, null);
  assert.equal(depois.finishedAt, null);

  db.close();
});

test('G. derivedFromAssetId de outro projeto é recusado', () => {
  const { db } = cenario();
  const doOutroProjeto = createAsset({ projectId: 'proj_b', kind: 'image', filename: 'b.png' }, db);

  assert.throws(
    () => createGenerationJobRecord(base({ derivedFromAssetId: doOutroProjeto.id }), db),
    /é de outro projeto/,
  );
  assert.throws(
    () => createGenerationJobRecord(base({ derivedFromAssetId: 'asset_fantasma' }), db),
    /Asset desconhecido/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);

  db.close();
});

test('H. setGenerationJobState não pode declarar concluído', () => {
  const { db } = cenario();
  createGenerationJobRecord(base(), db);

  assert.throws(
    () => setGenerationJobState('cinema_abc_001', JOB_STATES.DONE, { db }),
    /Concluir é a operação que amarra o Asset/,
  );
  assert.equal(getGenerationJobRecord('cinema_abc_001', db).state, JOB_STATES.PREPARING);

  // E o esquema recusa mesmo por SQL solto: done sem Asset não existe.
  assert.throws(
    () => db.prepare(`
      UPDATE generation_jobs SET state = 'done', finishedAt = 2 WHERE jobId = 'cinema_abc_001'
    `).run(),
    /CHECK/i,
  );

  db.close();
});

test('I. concluir amarra estado, Asset e hora de fim ATOMICAMENTE', () => {
  const { db } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'i.png' }, db);
  createGenerationJobRecord(base(), db);
  setGenerationJobState('cinema_abc_001', JOB_STATES.RUNNING, { db, at: INSTANTE + 1 });

  const concluido = completeGenerationJob('cinema_abc_001', { assetId: asset.id, db, at: INSTANTE + 2 });

  assert.equal(concluido.state, JOB_STATES.DONE);
  assert.equal(concluido.assetId, asset.id);
  assert.equal(concluido.finishedAt, INSTANTE + 2);
  assert.equal(concluido.updatedAt, INSTANTE + 2);
  assert.equal(concluido.error, null);

  db.close();
});

test('J. um job aberto não pode ter Asset — nem por SQL solto', () => {
  const { db } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'j.png' }, db);
  createGenerationJobRecord(base(), db);

  assert.throws(
    () => db.prepare('UPDATE generation_jobs SET assetId = ? WHERE jobId = ?')
      .run(asset.id, 'cinema_abc_001'),
    /CHECK/i,
    'um trabalho em curso ganhou resultado',
  );

  db.close();
});

test('K. um desfecho é definitivo: terminal não volta a ser aberto', () => {
  const { db } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'k.png' }, db);

  for (const [id, terminar] of [
    ['j_done', () => completeGenerationJob('j_done', { assetId: asset.id, db, at: INSTANTE + 1 })],
    ['j_failed', () => setGenerationJobState('j_failed', JOB_STATES.FAILED, { db, error: 'x', at: INSTANTE + 1 })],
    ['j_cancelled', () => setGenerationJobState('j_cancelled', JOB_STATES.CANCELLED, { db, at: INSTANTE + 1 })],
    ['j_orphaned', () => setGenerationJobState('j_orphaned', JOB_STATES.ORPHANED, { db, error: 'y', at: INSTANTE + 1 })],
  ]) {
    createGenerationJobRecord(base({ jobId: id }), db);
    terminar();

    for (const aberto of [JOB_STATES.PREPARING, JOB_STATES.QUEUED, JOB_STATES.RUNNING]) {
      assert.throws(
        () => setGenerationJobState(id, aberto, { db }),
        /já terminou como/,
        `${id} voltou para ${aberto}`,
      );
    }
    assert.ok(TERMINAL_JOB_STATES.includes(getGenerationJobRecord(id, db).state));
  }

  db.close();
});

test('L+M+N. motivo de falha só existe onde houve falha', () => {
  const { db } = cenario();

  // L. Em curso não carrega motivo.
  createGenerationJobRecord(base({ jobId: 'j_run' }), db);
  assert.throws(
    () => setGenerationJobState('j_run', JOB_STATES.RUNNING, { db, error: 'algo' }),
    /não carrega motivo de falha/,
  );
  // Nem cancelado: parar a pedido do usuário não é erro.
  assert.throws(
    () => setGenerationJobState('j_run', JOB_STATES.CANCELLED, { db, error: 'algo' }),
    /não carrega motivo de falha/,
  );

  // M. E concluído nem chega a ser alcançável por aqui.
  assert.throws(
    () => setGenerationJobState('j_run', JOB_STATES.DONE, { db, error: 'algo' }),
    /Concluir é a operação que amarra o Asset/,
  );

  // N. Falhou e órfão aceitam.
  createGenerationJobRecord(base({ jobId: 'j_fail' }), db);
  createGenerationJobRecord(base({ jobId: 'j_orph' }), db);
  assert.equal(
    setGenerationJobState('j_fail', JOB_STATES.FAILED, { db, error: 'o executor recusou o grafo' }).error,
    'o executor recusou o grafo',
  );
  assert.equal(
    setGenerationJobState('j_orph', JOB_STATES.ORPHANED, { db, error: 'não encontrado na reconciliação' }).error,
    'não encontrado na reconciliação',
  );

  // E o esquema recusa por SQL solto também.
  assert.throws(
    () => db.prepare("UPDATE generation_jobs SET error = 'x' WHERE jobId = 'j_run'").run(),
    /CHECK/i,
  );

  db.close();
});

test('O+P. terminou ⇔ tem hora de fim', () => {
  const { db } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'o.png' }, db);

  // P. Aberto não tem, em nenhuma das transições.
  createGenerationJobRecord(base(), db);
  for (const aberto of [JOB_STATES.SUBMITTED, JOB_STATES.QUEUED, JOB_STATES.RUNNING, JOB_STATES.FINALIZING]) {
    assert.equal(setGenerationJobState('cinema_abc_001', aberto, { db, at: INSTANTE + 1 }).finishedAt, null);
  }

  // O. Terminal tem, sempre.
  assert.equal(
    completeGenerationJob('cinema_abc_001', { assetId: asset.id, db, at: INSTANTE + 3 }).finishedAt,
    INSTANTE + 3,
  );

  createGenerationJobRecord(base({ jobId: 'j_2' }), db);
  assert.equal(
    setGenerationJobState('j_2', JOB_STATES.CANCELLED, { db, at: INSTANTE + 4 }).finishedAt,
    INSTANTE + 4,
  );

  // E um aberto com hora de fim é recusado pelo esquema.
  createGenerationJobRecord(base({ jobId: 'j_3' }), db);
  assert.throws(
    () => db.prepare("UPDATE generation_jobs SET finishedAt = 9 WHERE jobId = 'j_3'").run(),
    /CHECK/i,
  );

  db.close();
});

// ── replay: o mesmo fato duas vezes ─────────────────────────────────────────
//
// O caso real que vem aí: o acompanhamento conclui um trabalho, e a
// reconciliação de um reinício observa o MESMO trabalho — ou roda duas vezes.
// Repetir um fato precisa dar certo, senão a reconciliação vira uma operação
// que só pode rodar uma vez, o que é o contrário do que ela é.
//
// Repetir um fato DIFERENTE é outra coisa: é corrupção, e é recusada.

test('A+C. concluir de novo com o MESMO Asset é replay, e não move o relógio', () => {
  const { db } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'r.png' }, db);
  createGenerationJobRecord(base(), db);

  const primeira = completeGenerationJob('cinema_abc_001', { assetId: asset.id, db, at: INSTANTE + 1 });
  const segunda = completeGenerationJob('cinema_abc_001', { assetId: asset.id, db, at: INSTANTE + 999 });

  assert.equal(segunda.state, JOB_STATES.DONE);
  assert.equal(segunda.assetId, asset.id);
  // C. Nem `finishedAt` nem `updatedAt` se mexem: um replay que deixasse rastro
  // faria duas execuções da reconciliação parecerem coisas diferentes.
  assert.equal(segunda.finishedAt, primeira.finishedAt);
  assert.equal(segunda.updatedAt, primeira.updatedAt);
  assert.deepEqual(segunda, primeira);

  db.close();
});

test('B. concluir com OUTRO Asset é recusado', () => {
  const { db } = cenario();
  const primeiro = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'b1.png' }, db);
  const segundo = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'b2.png' }, db);
  createGenerationJobRecord(base(), db);
  completeGenerationJob('cinema_abc_001', { assetId: primeiro.id, db, at: INSTANTE + 1 });

  assert.throws(
    () => completeGenerationJob('cinema_abc_001', { assetId: segundo.id, db }),
    /assetId já vale .* e não pode virar/,
  );
  // E nada mudou.
  assert.equal(getGenerationJobRecord('cinema_abc_001', db).assetId, primeiro.id);

  db.close();
});

test('D+E+F. providerJobId é escrita única', () => {
  const { db } = cenario();
  createGenerationJobRecord(base(), db);

  // D. Nulo → A.
  const aceito = markGenerationJobSubmitted('cinema_abc_001', 'prompt-123', { db, at: INSTANTE + 1 });
  assert.equal(aceito.providerJobId, 'prompt-123');
  assert.equal(aceito.state, JOB_STATES.SUBMITTED);
  assert.equal(aceito.submittedAt, INSTANTE + 1);

  // E. A → A é replay: nada muda, nem o relógio.
  const replay = markGenerationJobSubmitted('cinema_abc_001', 'prompt-123', { db, at: INSTANTE + 999 });
  assert.deepEqual(replay, aceito);

  // F. A → B é recusado: um trabalho nosso não troca de execução no provider.
  assert.throws(
    () => markGenerationJobSubmitted('cinema_abc_001', 'prompt-999', { db }),
    /providerJobId já vale "prompt-123" .* não pode virar "prompt-999"/,
  );
  assert.equal(getGenerationJobRecord('cinema_abc_001', db).providerJobId, 'prompt-123');

  db.close();
});

test('G+H+I+J. assistantMessageId é escrita única, e funciona com o job aberto', () => {
  const { db, thread, doUsuario } = cenario();
  const primeira = appendMessageRecord({ threadId: thread.id, role: 'assistant', content: 'um' }, db);
  const outra = appendMessageRecord({ threadId: thread.id, role: 'assistant', content: 'dois' }, db);
  createGenerationJobRecord(base({ threadId: thread.id, userMessageId: doUsuario.id }), db);

  // J. Antes de concluir.
  const ligada = bindGenerationJobMessage('cinema_abc_001', primeira.id, { db, at: INSTANTE + 1 });
  assert.equal(ligada.assistantMessageId, primeira.id);
  assert.equal(ligada.state, JOB_STATES.PREPARING);

  // H. A mesma de novo é replay.
  assert.deepEqual(
    bindGenerationJobMessage('cinema_abc_001', primeira.id, { db, at: INSTANTE + 999 }),
    ligada,
  );

  // I. Outra é recusada: a mídia de um trabalho aparece numa resposta, e numa só.
  assert.throws(
    () => bindGenerationJobMessage('cinema_abc_001', outra.id, { db }),
    /assistantMessageId já vale .* e não pode virar/,
  );

  db.close();
});

test('K. e a mensagem também pode ser amarrada DEPOIS de concluído', () => {
  const { db, thread, doUsuario } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'k2.png' }, db);
  createGenerationJobRecord(base({ threadId: thread.id, userMessageId: doUsuario.id }), db);

  // O trabalho conclui antes de o turno gravar a resposta — a ordem real quando
  // a imagem é rápida.
  const concluido = completeGenerationJob('cinema_abc_001', { assetId: asset.id, db, at: INSTANTE + 1 });
  assert.equal(concluido.assistantMessageId, null);

  const doAgente = appendMessageRecord({ threadId: thread.id, role: 'assistant', content: 'pronto' }, db);
  const ligado = bindGenerationJobMessage('cinema_abc_001', doAgente.id, { db, at: INSTANTE + 2 });

  assert.equal(ligado.assistantMessageId, doAgente.id);
  assert.equal(ligado.state, JOB_STATES.DONE);
  // A hora de fim é a do desfecho, não a da amarração.
  assert.equal(ligado.finishedAt, INSTANTE + 1);

  db.close();
});

test('L. concluir com mensagem conflitante é recusado, e o Asset não entra junto', () => {
  const { db, thread, doUsuario } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'l.png' }, db);
  const primeira = appendMessageRecord({ threadId: thread.id, role: 'assistant', content: 'um' }, db);
  const outra = appendMessageRecord({ threadId: thread.id, role: 'assistant', content: 'dois' }, db);
  createGenerationJobRecord(base({ threadId: thread.id, userMessageId: doUsuario.id }), db);
  bindGenerationJobMessage('cinema_abc_001', primeira.id, { db, at: INSTANTE + 1 });

  assert.throws(
    () => completeGenerationJob('cinema_abc_001', {
      assetId: asset.id, assistantMessageId: outra.id, db,
    }),
    /assistantMessageId já vale .* e não pode virar/,
  );

  // A transação foi desfeita inteira: o job continua aberto e sem Asset.
  const depois = getGenerationJobRecord('cinema_abc_001', db);
  assert.equal(depois.state, JOB_STATES.PREPARING);
  assert.equal(depois.assetId, null);
  assert.equal(depois.assistantMessageId, primeira.id);

  db.close();
});

test('L-bis. concluir com a MESMA mensagem já amarrada é replay', () => {
  const { db, thread, doUsuario } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'lb.png' }, db);
  const doAgente = appendMessageRecord({ threadId: thread.id, role: 'assistant', content: 'pronto' }, db);
  createGenerationJobRecord(base({ threadId: thread.id, userMessageId: doUsuario.id }), db);
  bindGenerationJobMessage('cinema_abc_001', doAgente.id, { db, at: INSTANTE + 1 });

  const concluido = completeGenerationJob('cinema_abc_001', {
    assetId: asset.id, assistantMessageId: doAgente.id, db, at: INSTANTE + 2,
  });
  assert.equal(concluido.state, JOB_STATES.DONE);
  assert.equal(concluido.assistantMessageId, doAgente.id);

  // E de novo, com tudo igual: nada se mexe.
  assert.deepEqual(
    completeGenerationJob('cinema_abc_001', {
      assetId: asset.id, assistantMessageId: doAgente.id, db, at: INSTANTE + 999,
    }),
    concluido,
  );

  db.close();
});

test('replay não reabre terminal: falhou continua falhado', () => {
  const { db } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'rt.png' }, db);
  createGenerationJobRecord(base(), db);
  setGenerationJobState('cinema_abc_001', JOB_STATES.FAILED, { db, error: 'x', at: INSTANTE + 1 });

  // Idempotência é repetir o MESMO fato — não é reabrir um desfecho diferente.
  assert.throws(
    () => completeGenerationJob('cinema_abc_001', { assetId: asset.id, db }),
    /já terminou como "failed"/,
  );
  assert.equal(getGenerationJobRecord('cinema_abc_001', db).state, JOB_STATES.FAILED);

  db.close();
});

// ── M · N · a política de exclusão ──────────────────────────────────────────

test('M. o Asset de um trabalho concluído não pode ser apagado sozinho', () => {
  const { db } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'm.png' }, db);
  const origem = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'm0.png' }, db);
  createGenerationJobRecord(base({ derivedFromAssetId: origem.id }), db);
  completeGenerationJob('cinema_abc_001', { assetId: asset.id, db, at: INSTANTE + 1 });

  // O livro-razão AFIRMA que aquele trabalho produziu aquilo. Um resultado que
  // some deixa a afirmação falsa — e a recusa vem pelo motivo certo: a
  // referência, não uma cláusula CHECK que esbarrou por acidente.
  assert.throws(
    () => db.prepare('DELETE FROM assets WHERE id = ?').run(asset.id),
    /FOREIGN KEY/i,
  );
  assert.equal(getGenerationJobRecord('cinema_abc_001', db).assetId, asset.id);

  // A ORIGEM segue política diferente, e de propósito: linhagem é informação
  // sobre de onde veio, não o resultado. Perdê-la não deixa nada falso.
  db.prepare('DELETE FROM assets WHERE id = ?').run(origem.id);
  assert.equal(getGenerationJobRecord('cinema_abc_001', db).derivedFromAssetId, null);

  db.close();
});

test('N. apagar o Projeto leva tudo junto, sem órfão e sem recusa', () => {
  const { db, thread, doUsuario } = cenario();
  const asset = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'n2.png' }, db);
  createGenerationJobRecord(base({ threadId: thread.id, userMessageId: doUsuario.id }), db);
  completeGenerationJob('cinema_abc_001', { assetId: asset.id, db, at: INSTANTE + 1 });

  // A checagem de NO ACTION acontece no fim da instrução: nessa hora o CASCADE
  // do projeto já levou o Asset e o registro juntos. Com RESTRICT isto seria
  // recusado, e apagar um projeto ficaria impossível.
  db.prepare('DELETE FROM projects WHERE id = ?').run('proj_a');

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_threads').get().n, 0);
  assert.equal(db.prepare('PRAGMA foreign_key_check').all().length, 0, 'ficou órfão');

  db.close();
});
