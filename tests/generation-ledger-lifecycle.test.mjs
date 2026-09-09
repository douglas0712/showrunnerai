// PASSO 10.3 — o livro-razão ligado ao ciclo real de geração.
//
// Até aqui a tabela existia e ficava vazia. O buraco que este passo fecha é a
// janela entre submeter e concluir: nada sobre o trabalho chegava ao banco
// antes do Asset, e o Asset só nasce no fim. Um reinício no meio apagava de
// quem era o trabalho, de que conversa e de que turno.
//
// ── A ordem é o passo inteiro ───────────────────────────────────────────────
//
//   1. registra `preparing`   ANTES de o executor ser chamado
//   2. submete
//   3. anota o identificador que o executor devolveu
//
// Invertida, ela deixa aberta exatamente a janela que existe para ser fechada.
//
// Tudo aqui é determinístico: o executor é falso, o relógio é injetado, e o
// banco é em memória. Sem rede, sem GPU, sem runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import { appendMessageRecord, createThreadRecord } from '../lib/server/agent/threads.js';
import {
  getGenerationJobRecord, listOpenGenerationJobs,
} from '../lib/server/domain/generationJobs.js';
import { JOB_STATES } from '../lib/server/domain/generationJobStates.js';
import { STATES } from '../lib/server/comfy/status.js';

const INSTANTE = 1_700_000_000_000;

function cenario() {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_a', name: 'A' }, db);
  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const doUsuario = appendMessageRecord({
    threadId: thread.id, role: 'user', content: 'crie uma imagem',
  }, db);
  return { db, thread, doUsuario };
}

// ── A · B · a ordem, que é o passo inteiro ──────────────────────────────────

test('A. o registro existe ANTES de o executor ser chamado', async () => {
  const { db } = cenario();
  const { startImageGeneration } = await import('../lib/server/generation/facade.js');

  let estadoNoMomentoDaSubmissao = null;

  await startImageGeneration({ prompt: 'x' }, {
    projectId: 'proj_a',
    db,
    deps: {
      novoJobId: () => 'cinema_ordem_1',
      submeter: async (params) => {
        // Durante a submissão, o livro-razão JÁ conhece o trabalho. É esta
        // linha que fecha a janela do reinício.
        estadoNoMomentoDaSubmissao = getGenerationJobRecord(params.jobId, db);
        return {
          jobId: params.jobId, promptId: 'prompt-1', state: STATES.SUBMITTED,
        };
      },
    },
  });

  assert.ok(estadoNoMomentoDaSubmissao, 'o executor foi chamado antes de o registro existir');
  assert.equal(estadoNoMomentoDaSubmissao.state, JOB_STATES.PREPARING);
  assert.equal(estadoNoMomentoDaSubmissao.providerJobId, null);
  assert.equal(estadoNoMomentoDaSubmissao.projectId, 'proj_a');

  db.close();
});

test('B. se o registro não pode ser criado, o executor NÃO é chamado', async () => {
  const { db } = cenario();
  const { startImageGeneration } = await import('../lib/server/generation/facade.js');
  let chamou = false;

  await assert.rejects(
    () => startImageGeneration({ prompt: 'x' }, {
      // Projeto que não existe: o repositório recusa antes de qualquer coisa.
      projectId: 'proj_fantasma',
      db,
      deps: {
        novoJobId: () => 'cinema_b_1',
        submeter: async () => { chamou = true; return {}; },
      },
    }),
    /Projeto desconhecido/,
  );

  assert.equal(chamou, false, 'submeteu mesmo sem conseguir registrar');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);

  db.close();
});

// ── C · D · E · F · G · o que é gravado ─────────────────────────────────────

test('C+E+F. a geração do Agent grava projeto, conversa, turno, tipo e workflow', async () => {
  const { db, thread, doUsuario } = cenario();
  const { startImageGeneration } = await import('../lib/server/generation/facade.js');

  await startImageGeneration({ prompt: 'x' }, {
    projectId: 'proj_a',
    threadId: thread.id,
    userMessageId: doUsuario.id,
    db,
    deps: {
      novoJobId: () => 'cinema_c_1',
      submeter: async (p) => ({ jobId: p.jobId, promptId: 'prompt-c', state: STATES.SUBMITTED }),
    },
  });

  const linha = getGenerationJobRecord('cinema_c_1', db);
  assert.equal(linha.projectId, 'proj_a');
  assert.equal(linha.threadId, thread.id);
  assert.equal(linha.userMessageId, doUsuario.id);
  assert.equal(linha.kind, 'image');
  assert.equal(linha.workflowId, 'ideogram4_t2i');
  assert.equal(linha.assistantMessageId, null);
  assert.equal(linha.assetId, null);

  db.close();
});

test('D. a geração fora do Agent grava sem conversa e sem turno', async () => {
  const { db } = cenario();
  const { startImageGeneration } = await import('../lib/server/generation/facade.js');

  // Nem toda geração do Showrunner nasce num chat. O livro-razão precisa
  // conseguir representar isso, senão ele não é o livro-razão do produto.
  await startImageGeneration({ prompt: 'x' }, {
    projectId: 'proj_a',
    db,
    deps: {
      novoJobId: () => 'cinema_d_1',
      submeter: async (p) => ({ jobId: p.jobId, promptId: 'prompt-d', state: STATES.SUBMITTED }),
    },
  });

  const linha = getGenerationJobRecord('cinema_d_1', db);
  assert.equal(linha.threadId, null);
  assert.equal(linha.userMessageId, null);
  assert.equal(linha.projectId, 'proj_a');
  assert.ok(listOpenGenerationJobs({}, db).some((j) => j.jobId === 'cinema_d_1'));

  db.close();
});

test('G. a linhagem de i2v é gravada desde o INÍCIO, não só ao concluir', async () => {
  const { db } = cenario();
  // Sem `filename`: a ponte i2v só lê bytes do disco quando há arquivo, e aqui
  // o que se testa é a LINHAGEM, não a leitura.
  const origem = createAsset({ projectId: 'proj_a', kind: 'image' }, db);
  const { startVideoGeneration } = await import('../lib/server/generation/facade.js');

  await startVideoGeneration({ prompt: 'x', sourceAssetId: origem.id }, {
    projectId: 'proj_a',
    db,
    deps: {
      novoJobId: () => 'cinema_g_1',
      submeter: async (p) => ({ jobId: p.jobId, promptId: 'prompt-g', state: STATES.SUBMITTED }),
    },
  });

  const linha = getGenerationJobRecord('cinema_g_1', db);
  assert.equal(linha.derivedFromAssetId, origem.id);
  assert.equal(linha.kind, 'video');
  // Hoje a linhagem só existia na memória do processo e sumia com ele.
  assert.equal(linha.state, JOB_STATES.SUBMITTED);

  db.close();
});

// ── H · I · o identificador do executor ─────────────────────────────────────

test('H+I. o identificador do executor é anotado, e é escrita única', async () => {
  const { db } = cenario();
  const { startImageGeneration } = await import('../lib/server/generation/facade.js');

  await startImageGeneration({ prompt: 'x' }, {
    projectId: 'proj_a',
    db,
    deps: {
      novoJobId: () => 'cinema_h_1',
      submeter: async (p) => ({ jobId: p.jobId, promptId: 'prompt-h', state: STATES.SUBMITTED }),
    },
  });

  const linha = getGenerationJobRecord('cinema_h_1', db);
  assert.equal(linha.providerJobId, 'prompt-h');
  assert.equal(linha.state, JOB_STATES.SUBMITTED);
  assert.ok(linha.submittedAt);

  // A escrita única vem do repositório (PASSO 10.2) e continua valendo por
  // baixo desta camada.
  const { markGenerationJobSubmitted } = await import('../lib/server/domain/generationJobs.js');
  assert.deepEqual(markGenerationJobSubmitted('cinema_h_1', 'prompt-h', { db }), linha);
  assert.throws(
    () => markGenerationJobSubmitted('cinema_h_1', 'prompt-outro', { db }),
    /não pode virar/,
  );

  db.close();
});

// ── falha de submissão: não inventar certeza ────────────────────────────────

test('a recusa PROVADA do executor vira failed', async () => {
  const { db } = cenario();
  const { startImageGeneration } = await import('../lib/server/generation/facade.js');

  const recusa = new Error('O ComfyUI respondeu 400 em /prompt.');
  recusa.name = 'ComfyError';
  recusa.status = 400;

  await assert.rejects(() => startImageGeneration({ prompt: 'x' }, {
    projectId: 'proj_a',
    db,
    deps: { novoJobId: () => 'cinema_r_1', submeter: async () => { throw recusa; } },
  }));

  const linha = getGenerationJobRecord('cinema_r_1', db);
  assert.equal(linha.state, JOB_STATES.FAILED);
  assert.ok(linha.finishedAt);
  assert.match(linha.error, /respondeu 400/);

  db.close();
});

test('a falha AMBÍGUA preserva preparing — não se inventa um desfecho', async () => {
  const { db } = cenario();
  const { startImageGeneration } = await import('../lib/server/generation/facade.js');

  // Tempo esgotado depois de enviar: não sabemos se o executor aceitou. Gravar
  // `failed` aqui seria afirmar uma coisa que não sabemos, num registro que
  // existe justamente para ser confiável depois de um reinício.
  const ambigua = new Error('O ComfyUI não respondeu em 30s (/prompt).');
  ambigua.name = 'ComfyError';
  ambigua.status = null;

  await assert.rejects(() => startImageGeneration({ prompt: 'x' }, {
    projectId: 'proj_a',
    db,
    deps: { novoJobId: () => 'cinema_amb_1', submeter: async () => { throw ambigua; } },
  }));

  const linha = getGenerationJobRecord('cinema_amb_1', db);
  assert.equal(linha.state, JOB_STATES.PREPARING);
  assert.equal(linha.providerJobId, null);
  assert.equal(linha.finishedAt, null);
  assert.equal(linha.error, null);
  // E ele continua aberto, para a reconciliação futura encontrá-lo.
  assert.ok(listOpenGenerationJobs({}, db).some((j) => j.jobId === 'cinema_amb_1'));

  db.close();
});

test('AE+AF. falhar ao anotar a submissão NÃO submete de novo', async () => {
  const { db } = cenario();
  const { startImageGeneration } = await import('../lib/server/generation/facade.js');
  let submissoes = 0;

  const resultado = await startImageGeneration({ prompt: 'x' }, {
    projectId: 'proj_a',
    db,
    deps: {
      novoJobId: () => 'cinema_af_1',
      submeter: async (p) => { submissoes += 1; return { jobId: p.jobId, promptId: 'prompt-af', state: STATES.SUBMITTED }; },
      // O banco quebra DEPOIS de o executor aceitar.
      anotarSubmissao: () => { throw new Error('disco cheio'); },
    },
  });

  assert.equal(submissoes, 1, 'submeteu de novo por causa de uma falha de banco');
  assert.equal(resultado.jobId, 'cinema_af_1');
  // A linha fica em `preparing` — fato honesto, e reconciliável pelo nome do
  // arquivo que o executor vai produzir.
  const linha = getGenerationJobRecord('cinema_af_1', db);
  assert.equal(linha.state, JOB_STATES.PREPARING);
  assert.equal(linha.providerJobId, null);

  db.close();
});

// ── observação: o livro-razão acompanha o que a facade vê ───────────────────
//
// Determinismo pelo mesmo caminho de `generation-finalize.test.mjs`: o job é
// montado direto no registro em memória, SEM `promptId`. `pollJob` devolve cedo
// quando não há promptId, então nada aqui toca a rede — e o que se exercita é a
// decisão da facade.

/** Um job em memória e a linha correspondente no livro-razão. */
async function comLedger({ state = STATES.SUBMITTED, kind = 'image', resultado = null } = {}) {
  const { db, thread, doUsuario } = cenario();
  const { createJob } = await import('../lib/server/comfy/jobs.js');
  const { createGenerationJobRecord, markGenerationJobSubmitted } =
    await import('../lib/server/domain/generationJobs.js');

  const jobId = `cinema_obs_${Math.random().toString(36).slice(2, 10)}`;

  createJob({
    jobId, projectId: 'proj_a', kind, state, promptId: null, prompt: 'x', seed: 1, result: resultado,
  });
  createGenerationJobRecord({
    jobId, projectId: 'proj_a', kind, workflowId: 'w',
    threadId: thread.id, userMessageId: doUsuario.id,
  }, db);
  markGenerationJobSubmitted(jobId, `prompt-${jobId}`, { db, at: INSTANTE });

  return { db, thread, doUsuario, jobId };
}

test('J+K+L. as transições observadas são anotadas', async () => {
  const { getGenerationJob } = await import('../lib/server/generation/facade.js');
  const { updateJob } = await import('../lib/server/comfy/jobs.js');

  const { db, jobId } = await comLedger({ state: STATES.QUEUED });

  await getGenerationJob(jobId, { projectId: 'proj_a', db });
  assert.equal(getGenerationJobRecord(jobId, db).state, JOB_STATES.QUEUED);

  updateJob(jobId, { state: STATES.GENERATING });
  await getGenerationJob(jobId, { projectId: 'proj_a', db });
  assert.equal(getGenerationJobRecord(jobId, db).state, JOB_STATES.RUNNING);

  updateJob(jobId, { state: STATES.SAVING });
  await getGenerationJob(jobId, { projectId: 'proj_a', db });
  assert.equal(getGenerationJobRecord(jobId, db).state, JOB_STATES.FINALIZING);

  db.close();
});

test('M. consultar no MESMO estado não escreve de novo', async () => {
  const { getGenerationJob } = await import('../lib/server/generation/facade.js');
  const { db, jobId } = await comLedger({ state: STATES.GENERATING });

  const primeira = await getGenerationJob(jobId, { projectId: 'proj_a', db });
  const depoisDaPrimeira = getGenerationJobRecord(jobId, db);
  assert.equal(primeira.status, JOB_STATES.RUNNING);

  // O acompanhamento consulta de segundo em segundo. Uma escrita por consulta
  // encheria o banco de linhas idênticas para dizer que nada aconteceu.
  for (let i = 0; i < 5; i += 1) {
    await getGenerationJob(jobId, { projectId: 'proj_a', db });
  }

  assert.deepEqual(getGenerationJobRecord(jobId, db), depoisDaPrimeira);
  db.close();
});

test('N+O. falha e cancelamento do executor viram desfecho, com hora de fim', async () => {
  const { getGenerationJob } = await import('../lib/server/generation/facade.js');

  for (const [doExecutor, doDominio] of [
    [STATES.FAILED, JOB_STATES.FAILED],
    [STATES.CANCELLED, JOB_STATES.CANCELLED],
  ]) {
    const { db, jobId } = await comLedger({ state: doExecutor });
    await getGenerationJob(jobId, { projectId: 'proj_a', db });

    const linha = getGenerationJobRecord(jobId, db);
    assert.equal(linha.state, doDominio);
    assert.ok(linha.finishedAt, `${doDominio} ficou sem hora de fim`);
    db.close();
  }
});

test('P+Q. done no executor sem Asset NÃO conclui; com Asset, conclui', async () => {
  const { getGenerationJob } = await import('../lib/server/generation/facade.js');
  const { db, jobId } = await comLedger({
    state: STATES.DONE,
    resultado: { url: '/api/media/image/p.png', filename: 'p.png', bytes: 10 },
  });

  // P. Sem `db` a facade não finaliza — e sem Asset o livro-razão NÃO pode
  // dizer `done`. Ele fica no último estado aberto observado.
  await getGenerationJob(jobId, { projectId: 'proj_a' });
  assert.notEqual(getGenerationJobRecord(jobId, db).state, JOB_STATES.DONE);

  // Q. Com banco, o Asset nasce e só então a conclusão é anotada.
  const resultado = await getGenerationJob(jobId, { projectId: 'proj_a', db });
  assert.ok(resultado.assetId);

  const linha = getGenerationJobRecord(jobId, db);
  assert.equal(linha.state, JOB_STATES.DONE);
  assert.equal(linha.assetId, resultado.assetId);
  assert.ok(linha.finishedAt);

  db.close();
});

test('R. concluir de novo continua idempotente', async () => {
  const { getGenerationJob } = await import('../lib/server/generation/facade.js');
  const { db, jobId } = await comLedger({
    state: STATES.DONE,
    resultado: { url: '/api/media/image/r.png', filename: 'r.png', bytes: 10 },
  });

  await getGenerationJob(jobId, { projectId: 'proj_a', db });
  const primeira = getGenerationJobRecord(jobId, db);

  for (let i = 0; i < 3; i += 1) {
    await getGenerationJob(jobId, { projectId: 'proj_a', db });
  }

  assert.deepEqual(getGenerationJobRecord(jobId, db), primeira);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  db.close();
});

test('U. a consulta explícita sincroniza o livro-razão pelo mesmo caminho', async () => {
  // `og.get_job` chama `getGenerationJob`. Não há uma segunda sincronização
  // para a pergunta do modelo: é a mesma função, e por isso é a mesma verdade.
  const { getJobTool } = await import('../lib/server/agent/tools/handlers/getJob.js');
  const { db, jobId, thread } = await comLedger({ state: STATES.GENERATING });

  const fonte = await readFile(
    fileURLToPath(new URL('../lib/server/agent/tools/handlers/getJob.js', import.meta.url)),
    'utf8',
  );
  assert.match(fonte, /getGenerationJob/);
  assert.equal(getJobTool.name, 'og.get_job');

  const { getGenerationJob } = await import('../lib/server/generation/facade.js');
  await getGenerationJob(jobId, { projectId: 'proj_a', db });
  assert.equal(getGenerationJobRecord(jobId, db).state, JOB_STATES.RUNNING);
  assert.equal(getGenerationJobRecord(jobId, db).threadId, thread.id);

  db.close();
});

test('V. uma geração sem linha no livro-razão continua consultável', async () => {
  // As gerações anteriores a este passo, e as de superfícies que ainda não
  // escrevem no livro-razão, não têm linha. Consultá-las não pode quebrar.
  const { getGenerationJob } = await import('../lib/server/generation/facade.js');
  const { createJob } = await import('../lib/server/comfy/jobs.js');
  const { db } = cenario();

  const jobId = 'cinema_sem_linha';
  createJob({ jobId, projectId: 'proj_a', kind: 'image', state: STATES.GENERATING, promptId: null });

  const resultado = await getGenerationJob(jobId, { projectId: 'proj_a', db });
  assert.equal(resultado.status, JOB_STATES.RUNNING);
  assert.equal(getGenerationJobRecord(jobId, db), null);

  db.close();
});

// ── S · T · falha do acompanhamento ≠ falha do trabalho ─────────────────────

test('S+T. o teto e o erro do acompanhamento NÃO marcam o trabalho como falho', async () => {
  const { criarRegistroDeAcompanhamento } = await import('../lib/server/agent/tools/jobWatch.js');
  const { db, jobId } = await comLedger({ state: STATES.GENERATING });

  const antes = getGenerationJobRecord(jobId, db);

  // S. Teto estourado: o acompanhamento desiste de vigiar.
  const comTeto = criarRegistroDeAcompanhamento({
    consultar: async () => ({ jobId, status: JOB_STATES.RUNNING }),
    esperar: async () => {},
    agora: (() => { let t = INSTANTE; return () => { t += 10_000; return t; }; })(),
    limiteMs: 30_000,
  });
  const marca = comTeto.watch(
    { jobId, kind: 'image', threadId: 'x', projectId: 'proj_a' }, { db },
  );
  await marca.pronto;
  assert.equal(marca.state, 'falhou', 'o acompanhamento deveria ter desistido');

  // T. E um erro inesperado dentro do acompanhamento.
  const comErro = criarRegistroDeAcompanhamento({
    consultar: async () => null,
    esperar: async () => {},
  });
  const outra = comErro.watch(
    { jobId: `${jobId}_b`, kind: 'image', threadId: 'x', projectId: 'proj_a' }, { db },
  );
  await outra.pronto;
  assert.equal(outra.state, 'falhou');

  // O LIVRO-RAZÃO não se mexeu. "Parei de vigiar" não é "o executor falhou" —
  // o trabalho pode muito bem estar rodando, e uma consulta futura continua de
  // onde parou.
  assert.deepEqual(getGenerationJobRecord(jobId, db), antes);
  // Continua no ÚLTIMO estado que a camada de geração observou — aberto, sem
  // hora de fim. O acompanhamento não escreve no livro-razão, e é por isso que
  // desistir de vigiar não vira desfecho.
  assert.equal(getGenerationJobRecord(jobId, db).state, JOB_STATES.SUBMITTED);
  assert.equal(getGenerationJobRecord(jobId, db).finishedAt, null);
  assert.equal(getGenerationJobRecord(jobId, db).error, null);

  db.close();
});

// ── AB · AC · AD · nada disto chega ao navegador ────────────────────────────

test('AB+AC+AD. nenhum campo do livro-razão atravessa para a interface', async () => {
  const { publicAgentEvent, AGENT_EVENTS } = await import('../lib/server/agent/events.js');

  // Mesmo que uma ferramenta devolvesse tudo, a redução pública corta.
  const publico = publicAgentEvent({
    type: AGENT_EVENTS.TOOL_COMPLETED,
    ts: 1,
    toolCallId: 'c1',
    name: 'og.get_job',
    result: {
      jobId: 'cinema_1',
      providerJobId: 'prompt-abc',
      userMessageId: 'msg_1',
      assistantMessageId: 'msg_2',
      workflowId: 'ideogram4_t2i',
      state: 'running',
      error: 'motivo de operador',
    },
  });

  const texto = JSON.stringify(publico);
  for (const privado of [
    'providerJobId', 'prompt-abc', 'userMessageId', 'assistantMessageId',
    'workflowId', 'ideogram4_t2i', 'motivo de operador', 'cinema_1',
  ]) {
    assert.ok(!texto.includes(privado), `"${privado}" atravessou`);
  }

  // E a superfície de produção da conversa continua com três campos.
  const { threadProduction } = await import('../lib/server/agent/tools/jobWatch.js');
  assert.deepEqual(threadProduction('thread_qualquer'), []);
});

test('AD-bis. a rota da conversa não devolve nada do livro-razão', async () => {
  const { handleGetThread } = await import('../lib/server/agent/httpApi.js');
  const { db, thread, jobId } = await comLedger({ state: STATES.GENERATING });

  const corpo = handleGetThread(thread.id, { db }).body;
  const texto = JSON.stringify(corpo);

  for (const privado of ['providerJobId', 'workflowId', 'generation_jobs', jobId]) {
    assert.ok(!texto.includes(privado), `"${privado}" chegou à rota da conversa`);
  }
  assert.deepEqual(Object.keys(corpo).sort(), ['agentName', 'messages', 'production', 'thread']);

  db.close();
});

// ── o caminho do Studio: a segunda porta, agora unificada ───────────────────
//
// As rotas /api/comfy/{generate,status,result} chamavam o executor direto. A
// mesma geração, vista pelo agente, atualizava o registro durável; vista pela
// tela antiga, não atualizava nada. Duas portas com semânticas diferentes.
//
// As Route Handlers não são importáveis num teste de `node:test` (`next/server`
// não resolve fora do build), então o que se exercita aqui é o que elas
// chamam — as operações públicas da camada de geração — mais uma varredura do
// fonte das três rotas provando que o executor não é mais alcançado por elas.

async function codigoDaRota(nome) {
  const fonte = await readFile(
    fileURLToPath(new URL(`../app/api/comfy/${nome}/route.js`, import.meta.url)),
    'utf8',
  );
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('H. nenhuma das três rotas alcança o executor', async () => {
  for (const nome of ['generate', 'status', 'result']) {
    const codigo = await codigoDaRota(nome);

    for (const proibido of ['comfy/provider', 'pollJob', 'finalizeJob', 'submitGeneration']) {
      assert.ok(!codigo.includes(proibido), `/api/comfy/${nome} chama ${proibido}`);
    }
  }
});

test('A+D+F. as três rotas entram pela camada de geração', async () => {
  const porRota = {
    generate: ['startGeneration', 'newGenerationJobId'],
    status: ['observeGeneration'],
    result: ['finalizeGeneration'],
  };

  for (const [nome, esperados] of Object.entries(porRota)) {
    const codigo = await codigoDaRota(nome);
    assert.match(codigo, /generation\/facade/, `/api/comfy/${nome} não importa a facade`);
    for (const operacao of esperados) {
      assert.ok(codigo.includes(operacao), `/api/comfy/${nome} não usa ${operacao}`);
    }
  }
});

test('B+C+K. a submissão do Studio registra antes, e sem conversa', async () => {
  const { db } = cenario();
  const { startGeneration } = await import('../lib/server/generation/facade.js');
  let noMomentoDaSubmissao = null;

  // Os mesmos parâmetros que a rota monta: vídeo, com qualidade e fps, sem
  // thread e sem turno.
  const { providerJob } = await startGeneration({
    jobId: 'cinema_studio_1',
    prompt: 'um farol na tempestade',
    seed: null,
    seedLocked: false,
    durationSeconds: 6,
    aspect: '16:9',
    quality: '480p',
    fps: 24,
  }, {
    projectId: 'proj_a',
    db,
    deps: {
      submeter: async (p) => {
        noMomentoDaSubmissao = getGenerationJobRecord(p.jobId, db);
        return { jobId: p.jobId, promptId: 'prompt-studio', state: STATES.SUBMITTED };
      },
    },
  });

  // B. O registro já existia quando o executor foi chamado.
  assert.ok(noMomentoDaSubmissao, 'a rota do Studio submeteu antes de registrar');
  assert.equal(noMomentoDaSubmissao.state, JOB_STATES.PREPARING);

  // C. Sem conversa e sem turno — e é a verdade, não uma lacuna.
  const linha = getGenerationJobRecord('cinema_studio_1', db);
  assert.equal(linha.threadId, null);
  assert.equal(linha.userMessageId, null);
  assert.equal(linha.assistantMessageId, null);
  assert.equal(linha.projectId, 'proj_a');
  assert.equal(linha.kind, 'video');
  assert.equal(linha.workflowId, 'minimax_h3_t2v');
  assert.equal(linha.providerJobId, 'prompt-studio');
  assert.equal(linha.state, JOB_STATES.SUBMITTED);

  // I. E a resposta HTTP continua sendo a forma que a tela já consumia.
  assert.ok(providerJob, 'a rota perdeu o corpo que a tela antiga espera');

  db.close();
});

test('K-bis. falhar ao registrar impede a submissão do Studio', async () => {
  const { db } = cenario();
  const { startGeneration } = await import('../lib/server/generation/facade.js');
  let chamou = false;

  await assert.rejects(
    () => startGeneration({ jobId: 'cinema_studio_2', prompt: 'x' }, {
      projectId: 'proj_fantasma',
      db,
      deps: { submeter: async () => { chamou = true; return {}; } },
    }),
    /Projeto desconhecido/,
  );

  assert.equal(chamou, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);

  db.close();
});

test('L. o erro sobe COM A CLASSE, para a rota mapear o status certo', async () => {
  // A tela antiga mapeia upload para 400, workflow para 422 e falha do executor
  // para 502. Embrulhar tudo numa mensagem de produto apagaria essa distinção e
  // transformaria um parâmetro inválido em erro interno.
  const { startGeneration, startImageGeneration } = await import('../lib/server/generation/facade.js');
  const { db } = cenario();

  const doWorkflow = new Error('nó ausente no grafo');
  doWorkflow.name = 'WorkflowError';

  await assert.rejects(
    () => startGeneration({ jobId: 'cinema_cls_1', prompt: 'x' }, {
      projectId: 'proj_a', db, deps: { submeter: async () => { throw doWorkflow; } },
    }),
    (erro) => {
      assert.equal(erro.name, 'WorkflowError', 'a classe do erro foi perdida');
      return true;
    },
  );

  // Já o atalho do agente embrulha, porque quem lê é o modelo e depois o
  // usuário — ali a classe não ajuda ninguém.
  await assert.rejects(
    () => startImageGeneration({ prompt: 'x' }, {
      projectId: 'proj_a', db,
      deps: { novoJobId: () => 'cinema_cls_2', submeter: async () => { throw doWorkflow; } },
    }),
    (erro) => {
      assert.equal(erro.name, 'GenerationError');
      assert.match(erro.message, /Não foi possível iniciar geração de imagem/);
      return true;
    },
  );

  db.close();
});

test('E. a observação do Studio sincroniza o livro-razão', async () => {
  const { observeGeneration } = await import('../lib/server/generation/facade.js');
  const { updateJob } = await import('../lib/server/comfy/jobs.js');
  const { db, jobId } = await comLedger({ state: STATES.QUEUED, kind: 'video' });

  const primeira = await observeGeneration(jobId, { db });
  // A forma que a tela antiga consome continua inteira.
  assert.equal(primeira.jobId, jobId);
  assert.ok('stateLabel' in primeira);
  assert.ok('progress' in primeira);
  assert.ok('queuePosition' in primeira);
  assert.equal(getGenerationJobRecord(jobId, db).state, JOB_STATES.QUEUED);

  updateJob(jobId, { state: STATES.GENERATING });
  await observeGeneration(jobId, { db });
  assert.equal(getGenerationJobRecord(jobId, db).state, JOB_STATES.RUNNING);

  // Trabalho que não existe devolve nulo — a rota vira 404, como antes.
  assert.equal(await observeGeneration('cinema_inexistente', { db }), null);

  db.close();
});

test('G. concluir pela rota do Studio produz Asset e fecha o registro', async () => {
  const { finalizeGeneration } = await import('../lib/server/generation/facade.js');
  const { db, jobId } = await comLedger({
    state: STATES.DONE,
    kind: 'video',
    resultado: { url: `/api/media/video/g.mp4`, filename: 'g.mp4', bytes: 99 },
  });

  const resposta = await finalizeGeneration(jobId, {
    db,
    // A publicação continua sendo a do executor; o que passou a acontecer junto
    // é o Asset e o registro.
    deps: { publicar: async () => ({ jobId }) },
  });

  assert.equal(resposta.jobId, jobId);

  const linha = getGenerationJobRecord(jobId, db);
  assert.equal(linha.state, JOB_STATES.DONE);
  assert.ok(linha.assetId);
  assert.ok(linha.finishedAt);

  const asset = db.prepare('SELECT id, kind, jobId FROM assets WHERE id = ?').get(linha.assetId);
  assert.equal(asset.jobId, jobId);
  assert.equal(asset.kind, 'video');

  // E de novo: idempotente, sem segundo Asset.
  await finalizeGeneration(jobId, { db, deps: { publicar: async () => ({ jobId }) } });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.deepEqual(getGenerationJobRecord(jobId, db), linha);

  db.close();
});

test('J. a resposta das rotas não ganhou campo do livro-razão', async () => {
  const { observeGeneration } = await import('../lib/server/generation/facade.js');
  const { db, jobId } = await comLedger({ state: STATES.GENERATING, kind: 'video' });

  const resposta = await observeGeneration(jobId, { db });
  const texto = JSON.stringify(resposta);

  for (const privado of [
    'providerJobId', 'userMessageId', 'assistantMessageId', 'threadId',
    'generation_jobs', 'assetId',
  ]) {
    assert.ok(!texto.includes(privado), `"${privado}" entrou na resposta da rota`);
  }
  // `promptId` já fazia parte do contrato legado desta superfície — preservá-lo
  // é o combinado deste passo; resolver essa dívida é outro assunto.
  assert.ok('promptId' in resposta);

  db.close();
});
