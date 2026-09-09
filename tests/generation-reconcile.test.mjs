// PASSO 10.4 — reconciliar o que terminou enquanto estávamos fora.
//
// Desde o 10.3 uma geração vira linha no banco antes de sair para o executor.
// A linha sozinha não fazia nada: se o processo caísse no meio, o trabalho
// continuava do lado de lá, terminava, e o resultado ficava órfão — sem Asset,
// sem chegar à conversa, com a linha parada num estado aberto para sempre.
//
// ── O que estes testes trancam ──────────────────────────────────────────────
//
// Que o arranque encontra esses trabalhos; que ele NUNCA ressubmete; que a
// propriedade vem do livro-razão e não do disco; e que a mídia volta para a
// resposta CERTA — pela âncora do turno, nunca pela última mensagem.
//
// Tudo determinístico: o histórico do executor é um objeto, a finalização é
// injetada, e o banco é em memória.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import {
  appendMessageRecord, createThreadRecord, listMessageAssets,
} from '../lib/server/agent/threads.js';
import {
  completeGenerationJob, createGenerationJobRecord, getGenerationJobRecord,
  markGenerationJobSubmitted,
} from '../lib/server/domain/generationJobs.js';
import { JOB_STATES } from '../lib/server/domain/generationJobStates.js';
import {
  janelaDeHistorico, reconcileGenerationJobs, reconcileOnce, resetReconcileOnce,
} from '../lib/server/generation/reconcile.js';

const INSTANTE = 1_700_000_000_000;

// ── o executor falso ────────────────────────────────────────────────────────
//
// O formato é o do `/history` real, medido: um mapa `promptId → entrada`, com
// `status.completed`, `status.status_str` e `outputs` por nó.

const NO_DE_SAIDA_IMAGEM = '92';

/** Uma entrada de histórico concluída com sucesso, com o arquivo produzido. */
function concluiuNoExecutor(jobId, { kind = 'image' } = {}) {
  const extensao = kind === 'video' ? '.mp4' : '.png';
  return {
    status: { completed: true, status_str: 'success', messages: [] },
    outputs: {
      [NO_DE_SAIDA_IMAGEM]: {
        images: [{
          filename: `${jobId}_00001_${extensao}`,
          subfolder: `${kind}/showrunner`,
          type: 'output',
        }],
      },
    },
  };
}

/** Uma entrada de histórico que falhou de verdade. */
function falhouNoExecutor(mensagem = 'CUDA out of memory') {
  return {
    status: {
      completed: false,
      status_str: 'error',
      messages: [['execution_error', { node_type: 'KSampler', exception_message: mensagem }]],
    },
    outputs: {},
  };
}

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

/** Um trabalho aberto no livro-razão, como o 10.3 o deixa. */
function abertoNoLedger(db, {
  jobId, projectId = 'proj_a', threadId = null, userMessageId = null,
  providerJobId = null, kind = 'image', workflowId = 'ideogram4_t2i',
  derivedFromAssetId = null,
} = {}) {
  createGenerationJobRecord({
    jobId, projectId, kind, workflowId, threadId, userMessageId,
    derivedFromAssetId, createdAt: INSTANTE,
  }, db);
  if (providerJobId) markGenerationJobSubmitted(jobId, providerJobId, { db, at: INSTANTE });
  return getGenerationJobRecord(jobId, db);
}

/**
 * Uma finalização falsa que faz o que a de verdade faz: cria o Asset e fecha o
 * registro. O pipeline de mídia real é exercitado noutro arquivo; aqui o que
 * se testa é a RECONCILIAÇÃO.
 */
function finalizacaoFalsa({ falhar = false } = {}) {
  const chamadas = [];
  const concluir = async (jobId, { db }) => {
    chamadas.push(jobId);
    if (falhar) throw new Error('o arquivo não pôde ser copiado');

    const registro = getGenerationJobRecord(jobId, db);
    const jaExiste = db.prepare('SELECT id FROM assets WHERE projectId = ? AND jobId = ?')
      .get(registro.projectId, jobId);

    const asset = jaExiste || createAsset({
      projectId: registro.projectId,
      kind: registro.kind,
      jobId,
      filename: `${jobId}.png`,
      url: `/api/media/image/${registro.projectId}/${jobId}.png`,
      mimeType: 'image/png',
    }, db);

    completeGenerationJob(jobId, { assetId: asset.id, db });
    return { jobId };
  };
  concluir.chamadas = chamadas;
  return concluir;
}

const semArquivoNoDisco = async () => null;

// ── E · o caminho normal: identificador conhecido, histórico diz concluído ──

test('E. trabalho com identificador do executor e histórico concluído é recuperado', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_e1', providerJobId: 'prompt-e1' });
  const concluir = finalizacaoFalsa();

  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-e1': concluiuNoExecutor('cinema_e1') }),
      concluir,
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.deepEqual(r.recuperados, ['cinema_e1']);
  const linha = getGenerationJobRecord('cinema_e1', db);
  assert.equal(linha.state, JOB_STATES.DONE);
  assert.ok(linha.assetId);
  assert.ok(linha.finishedAt);

  db.close();
});

// ── F + G · a janela de queda entre o /prompt e a anotação ──────────────────

test('F+G. sem identificador do executor, ele é reconstruído pelo nome do arquivo', async () => {
  const { db } = cenario();
  // A janela real: o executor aceitou, o processo caiu antes de anotarmos.
  abertoNoLedger(db, { jobId: 'cinema_f1' });
  assert.equal(getGenerationJobRecord('cinema_f1', db).providerJobId, null);
  assert.equal(getGenerationJobRecord('cinema_f1', db).state, JOB_STATES.PREPARING);

  const concluir = finalizacaoFalsa();
  const r = await reconcileGenerationJobs({
    db,
    deps: {
      // O nosso jobId está DENTRO do executor, no nome do arquivo de saída.
      historico: async () => ({ 'prompt-desconhecido': concluiuNoExecutor('cinema_f1') }),
      concluir,
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.deepEqual(r.recuperados, ['cinema_f1']);
  const linha = getGenerationJobRecord('cinema_f1', db);
  assert.equal(linha.providerJobId, 'prompt-desconhecido', 'o identificador não foi recuperado');
  assert.equal(linha.state, JOB_STATES.DONE);

  db.close();
});

test('G-bis. a recuperação do identificador respeita a escrita única', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_g1', providerJobId: 'prompt-verdadeiro' });

  // O histórico traz o MESMO arquivo sob outro identificador. O livro-razão
  // recusa trocar, e o trabalho segue com o que já tinha.
  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-outro': concluiuNoExecutor('cinema_g1') }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.equal(getGenerationJobRecord('cinema_g1', db).providerJobId, 'prompt-verdadeiro');
  assert.deepEqual(r.recuperados, []);

  db.close();
});

// ── H · falha provada ───────────────────────────────────────────────────────

test('H. histórico com falha real vira desfecho, com motivo de operador', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_h1', providerJobId: 'prompt-h1' });

  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-h1': falhouNoExecutor() }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.deepEqual(r.falhados, ['cinema_h1']);
  const linha = getGenerationJobRecord('cinema_h1', db);
  assert.equal(linha.state, JOB_STATES.FAILED);
  assert.ok(linha.finishedAt);
  assert.match(linha.error, /CUDA out of memory/);
  assert.equal(linha.assetId, null);

  db.close();
});

// ── I + J + AB · o que NÃO se sabe não vira desfecho ────────────────────────

test('I+J+AB. trabalho ausente do histórico continua ABERTO — nunca órfão', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_i1', providerJobId: 'prompt-i1' });
  abertoNoLedger(db, { jobId: 'cinema_i2' });

  const r = await reconcileGenerationJobs({
    db,
    deps: {
      // O histórico não sabe de nenhum dos dois. Eles podem estar na fila ou
      // executando AGORA — chamá-los de perdidos seria transformar
      // desconhecimento em desfecho.
      historico: async () => ({}),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.deepEqual(r.abertos.sort(), ['cinema_i1', 'cinema_i2']);
  assert.deepEqual(r.recuperados, []);
  assert.deepEqual(r.falhados, []);

  for (const id of ['cinema_i1', 'cinema_i2']) {
    const linha = getGenerationJobRecord(id, db);
    assert.notEqual(linha.state, JOB_STATES.ORPHANED, 'esta etapa não declara órfão');
    assert.notEqual(linha.state, JOB_STATES.FAILED);
    assert.equal(linha.finishedAt, null);
  }

  db.close();
});

// ── K + L + W · o arquivo já publicado ──────────────────────────────────────

test('K+W. resultado já publicado é adotado, e o projeto vem do LIVRO-RAZÃO', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_k1', projectId: 'proj_a', providerJobId: 'prompt-k1' });
  const concluir = finalizacaoFalsa();

  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({}),
      concluir,
      // A varredura do disco diz ONDE o arquivo está. Ela devolve um projeto —
      // e ele é ignorado: quem decide propriedade é o registro.
      localizarArquivo: async () => ({
        projectId: 'proj_b',
        filename: 'cinema_k1.png',
        url: '/api/media/image/proj_b/cinema_k1.png',
      }),
    },
  });

  assert.deepEqual(r.recuperados, ['cinema_k1']);
  const linha = getGenerationJobRecord('cinema_k1', db);
  assert.equal(linha.projectId, 'proj_a', 'a propriedade veio do disco em vez do registro');
  assert.equal(linha.state, JOB_STATES.DONE);

  const asset = db.prepare('SELECT projectId FROM assets WHERE id = ?').get(linha.assetId);
  assert.equal(asset.projectId, 'proj_a');

  db.close();
});

test('L+M. Asset existente é reutilizado; reconciliar de novo não duplica', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_l1', providerJobId: 'prompt-l1' });
  const concluir = finalizacaoFalsa();

  const deps = {
    historico: async () => ({ 'prompt-l1': concluiuNoExecutor('cinema_l1') }),
    concluir,
    localizarArquivo: semArquivoNoDisco,
  };

  await reconcileGenerationJobs({ db, deps });
  const primeira = getGenerationJobRecord('cinema_l1', db);

  // Reconciliar de novo: o trabalho já não está aberto, então nem é visitado.
  const segunda = await reconcileGenerationJobs({ db, deps });
  assert.deepEqual(segunda.recuperados, []);
  assert.deepEqual(getGenerationJobRecord('cinema_l1', db), primeira);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);

  db.close();
});

test('N. reconciliar um trabalho que o acompanhamento já concluiu não duplica Asset', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_n1', providerJobId: 'prompt-n1' });

  // O acompanhamento vivo chegou primeiro e fechou o registro.
  const asset = createAsset({
    projectId: 'proj_a', kind: 'image', jobId: 'cinema_n1', filename: 'n1.png',
  }, db);
  completeGenerationJob('cinema_n1', { assetId: asset.id, db, at: INSTANTE + 1 });

  const concluir = finalizacaoFalsa();
  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-n1': concluiuNoExecutor('cinema_n1') }),
      concluir,
      localizarArquivo: semArquivoNoDisco,
    },
  });

  // Já não estava aberto: a reconciliação nem o vê.
  assert.deepEqual(r.recuperados, []);
  assert.deepEqual(concluir.chamadas, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.equal(getGenerationJobRecord('cinema_n1', db).assetId, asset.id);

  db.close();
});

// ── O + Q + R + S + T + U + V · a mídia volta para a resposta certa ─────────

test('Q. quando a resposta já está amarrada, a mídia vai para ela', async () => {
  const { db, thread, doUsuario } = cenario();
  const daResposta = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'vou criar',
  }, db);

  abertoNoLedger(db, {
    jobId: 'cinema_q1', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-q1',
  });
  const { bindGenerationJobMessage } = await import('../lib/server/domain/generationJobs.js');
  bindGenerationJobMessage('cinema_q1', daResposta.id, { db });

  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-q1': concluiuNoExecutor('cinema_q1') }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  const linha = getGenerationJobRecord('cinema_q1', db);
  assert.deepEqual(
    listMessageAssets(daResposta.id, db).map((m) => m.assetId),
    [linha.assetId],
  );

  db.close();
});

test('R. sem resposta amarrada, a âncora do turno resolve por seq + 1', async () => {
  const { db, thread, doUsuario } = cenario();
  // O turno morreu depois de gravar a resposta e antes de amarrá-la.
  const daResposta = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'vou criar',
  }, db);

  abertoNoLedger(db, {
    jobId: 'cinema_r1', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-r1',
  });
  assert.equal(getGenerationJobRecord('cinema_r1', db).assistantMessageId, null);

  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-r1': concluiuNoExecutor('cinema_r1') }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  const linha = getGenerationJobRecord('cinema_r1', db);
  assert.equal(linha.assistantMessageId, daResposta.id, 'a resposta do turno não foi reencontrada');
  assert.deepEqual(
    listMessageAssets(daResposta.id, db).map((m) => m.assetId),
    [linha.assetId],
  );

  db.close();
});

test('S+V. se seq + 1 for outra fala do usuário, NADA é anexado', async () => {
  const { db, thread, doUsuario } = cenario();
  abertoNoLedger(db, {
    jobId: 'cinema_s1', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-s1',
  });

  // O turno morreu sem responder; o usuário recarregou e falou de novo. E
  // DEPOIS o Showrunner respondeu — a essa segunda fala, não à primeira.
  appendMessageRecord({ threadId: thread.id, role: 'user', content: 'oi?' }, db);
  const respostaDoOutroTurno = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'oi!',
  }, db);

  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-s1': concluiuNoExecutor('cinema_s1') }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  const linha = getGenerationJobRecord('cinema_s1', db);
  // O Asset existe e é do projeto — mas não entra numa fala onde ninguém o pediu.
  assert.equal(linha.state, JOB_STATES.DONE);
  assert.ok(linha.assetId);
  assert.equal(linha.assistantMessageId, null);
  assert.deepEqual(listMessageAssets(respostaDoOutroTurno.id, db), []);
  // V. E a "última mensagem" — que é justamente essa — não foi usada.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n, 0);

  db.close();
});

test('T. se o turno não chegou a responder, nada é anexado', async () => {
  const { db, thread, doUsuario } = cenario();
  abertoNoLedger(db, {
    jobId: 'cinema_t1', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-t1',
  });

  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-t1': concluiuNoExecutor('cinema_t1') }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  const linha = getGenerationJobRecord('cinema_t1', db);
  assert.equal(linha.state, JOB_STATES.DONE, 'o resultado existe mesmo sem conversa');
  assert.ok(linha.assetId);
  assert.equal(linha.assistantMessageId, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n, 0);

  db.close();
});

test('U. a resposta de OUTRA conversa nunca é usada', async () => {
  const { db, thread, doUsuario } = cenario();
  const outra = createThreadRecord({ projectId: 'proj_a' }, db);
  appendMessageRecord({ threadId: outra.id, role: 'user', content: 'x' }, db);
  const daOutra = appendMessageRecord({ threadId: outra.id, role: 'assistant', content: 'y' }, db);

  abertoNoLedger(db, {
    jobId: 'cinema_u1', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-u1',
  });

  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-u1': concluiuNoExecutor('cinema_u1') }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.equal(getGenerationJobRecord('cinema_u1', db).assistantMessageId, null);
  assert.deepEqual(listMessageAssets(daOutra.id, db), []);

  db.close();
});

// ── P · geração fora da conversa ────────────────────────────────────────────

test('P. trabalho sem conversa conclui e isso é sucesso completo', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_p1', providerJobId: 'prompt-p1' });

  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-p1': concluiuNoExecutor('cinema_p1') }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.deepEqual(r.recuperados, ['cinema_p1']);
  const linha = getGenerationJobRecord('cinema_p1', db);
  assert.equal(linha.threadId, null);
  assert.equal(linha.assistantMessageId, null);
  assert.equal(linha.state, JOB_STATES.DONE);
  assert.ok(linha.assetId);

  db.close();
});

// ── X · linhagem ────────────────────────────────────────────────────────────

test('X. a linhagem gravada no início sobrevive à reconciliação', async () => {
  const { db } = cenario();
  const origem = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'orig.png' }, db);
  abertoNoLedger(db, {
    jobId: 'cinema_x1', kind: 'video', workflowId: 'minimax_h3_t2v',
    providerJobId: 'prompt-x1', derivedFromAssetId: origem.id,
  });

  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-x1': concluiuNoExecutor('cinema_x1', { kind: 'video' }) }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.equal(getGenerationJobRecord('cinema_x1', db).derivedFromAssetId, origem.id);

  db.close();
});

// ── Y · o executor fora do ar não derruba nada ─────────────────────────────

test('Y. executor indisponível no arranque não quebra a aplicação', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_y1', providerJobId: 'prompt-y1' });

  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => { throw new Error('fetch failed'); },
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.equal(r.indisponivel, true);
  assert.deepEqual(r.abertos, ['cinema_y1']);
  // O trabalho continua exatamente como estava: nada foi inventado.
  assert.equal(getGenerationJobRecord('cinema_y1', db).state, JOB_STATES.SUBMITTED);

  db.close();
});

test('Y-bis. nada em aberto nem chega a acordar o executor', async () => {
  const { db } = cenario();
  let perguntou = false;

  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => { perguntou = true; return {}; },
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.equal(perguntou, false, 'perguntou ao executor sem ter o que reconciliar');
  assert.deepEqual(r, { recuperados: [], falhados: [], abertos: [], indisponivel: false });

  db.close();
});

test('a finalização que falha deixa o trabalho aberto, sem desfecho inventado', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_ff', providerJobId: 'prompt-ff' });

  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({ 'prompt-ff': concluiuNoExecutor('cinema_ff') }),
      concluir: finalizacaoFalsa({ falhar: true }),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.deepEqual(r.abertos, ['cinema_ff']);
  const linha = getGenerationJobRecord('cinema_ff', db);
  assert.notEqual(linha.state, JOB_STATES.FAILED);
  assert.equal(linha.assetId, null);

  db.close();
});

// ── a janela do histórico ───────────────────────────────────────────────────

test('a janela do histórico cresce com o que há em aberto, e tem piso', () => {
  assert.equal(janelaDeHistorico(0), 50);
  assert.equal(janelaDeHistorico(1), 50);
  assert.equal(janelaDeHistorico(12), 50);
  assert.equal(janelaDeHistorico(13), 52);
  assert.equal(janelaDeHistorico(100), 400);
});

test('a janela pedida é proporcional aos jobs abertos', async () => {
  const { db } = cenario();
  for (let i = 0; i < 20; i += 1) abertoNoLedger(db, { jobId: `cinema_w${i}` });

  let pedida = null;
  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async (n) => { pedida = n; return {}; },
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
    },
  });

  assert.equal(pedida, 80);

  db.close();
});

// ── C · uma vez por processo ────────────────────────────────────────────────

test('C. duas chamadas no mesmo processo não executam duas reconciliações', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_c1', providerJobId: 'prompt-c1' });
  resetReconcileOnce();

  let perguntas = 0;
  const deps = {
    historico: async () => { perguntas += 1; return {}; },
    concluir: finalizacaoFalsa(),
    localizarArquivo: semArquivoNoDisco,
  };

  const [a, b] = await Promise.all([
    reconcileOnce({ db, deps }),
    reconcileOnce({ db, deps }),
  ]);

  assert.equal(perguntas, 1, 'reconciliou duas vezes no mesmo processo');
  assert.equal(a, b, 'a segunda chamada não reaproveitou a primeira');

  // E chamada de novo depois de terminar: continua sendo uma só.
  await reconcileOnce({ db, deps });
  assert.equal(perguntas, 1);

  resetReconcileOnce();
  db.close();
});

test('a reconciliação que falha por inteiro não derruba quem a chamou', async () => {
  resetReconcileOnce();
  const r = await reconcileOnce({
    db: null,
    deps: { historico: async () => ({}) },
  });
  assert.equal(r.indisponivel, true);
  resetReconcileOnce();
});

// ── D · AA · Z · as travas de fonte ─────────────────────────────────────────

async function codigoDe(relativo) {
  const fonte = await readFile(fileURLToPath(new URL(relativo, import.meta.url)), 'utf8');
  // Comentários fora: a explicação PRECISA poder dizer o que não fazemos.
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}

test('D. a reconciliação NUNCA submete — nem por engano', async () => {
  const codigo = await codigoDe('../lib/server/generation/reconcile.js');

  // Um reinício que regerasse trabalho gastaria GPU sem ninguém pedir e
  // produziria uma segunda imagem para o mesmo pedido.
  for (const proibido of [
    'submitGeneration', 'startGeneration', 'startImageGeneration',
    'startVideoGeneration', 'submitPrompt', '/prompt',
  ]) {
    assert.ok(!codigo.includes(proibido), `a reconciliação alcança ${proibido}`);
  }
});

test('AA. a reconciliação NÃO consulta a fila do executor', async () => {
  const codigo = await codigoDe('../lib/server/generation/reconcile.js');

  // Fila é o passo seguinte. Sem ela, não há como distinguir "sumiu" de "está
  // esperando a vez" — e por isso esta etapa não declara nada como perdido.
  for (const proibido of ['queue', 'findInQueue', 'deleteFromQueue', 'interrupt']) {
    assert.ok(!new RegExp(proibido, 'i').test(codigo), `a reconciliação cita ${proibido}`);
  }
});

test('AB+Z. a reconciliação não produz órfão e não recria acompanhamento', async () => {
  const codigo = await codigoDe('../lib/server/generation/reconcile.js');

  assert.ok(!codigo.includes('ORPHANED'), 'esta etapa não declara órfão');
  for (const proibido of ['jobWatch', 'watchJob', 'criarRegistroDeAcompanhamento']) {
    assert.ok(!codigo.includes(proibido), `a reconciliação cita ${proibido}`);
  }
});

// ── A · B · o gancho de arranque ────────────────────────────────────────────

test('A+B. o gancho dispara em segundo plano, e não durante o build', async () => {
  const codigo = await codigoDe('../instrumentation.js');

  // Ele existe e é fino: a lógica mora no módulo testável.
  assert.match(codigo, /export async function register/);
  assert.match(codigo, /reconcileOnce/);
  assert.ok(!codigo.includes('await reconcileOnce'), 'o arranque espera a reconciliação');

  // B. Build não toca em serviço externo.
  assert.match(codigo, /NEXT_PHASE/);
  assert.match(codigo, /phase-production-build/);
  // E o runtime que não consegue (edge, sem sqlite) também não tenta.
  assert.match(codigo, /NEXT_RUNTIME/);
  assert.match(codigo, /nodejs/);

  // A reconciliação real não é importada no topo: um build não deve nem
  // carregar o módulo que abre o banco.
  assert.ok(!/^import .*reconcile/m.test(codigo), 'o módulo é carregado fora do guard');
});

test('B-bis. os guards do gancho recusam build e runtime incompatível', async () => {
  const { register } = await import('../instrumentation.js');
  resetReconcileOnce();

  const original = { fase: process.env.NEXT_PHASE, runtime: process.env.NEXT_RUNTIME };
  const chave = Symbol.for('showrunner.generation.reconcile');

  try {
    process.env.NEXT_PHASE = 'phase-production-build';
    process.env.NEXT_RUNTIME = 'nodejs';
    await register();
    assert.equal(globalThis[chave], undefined, 'reconciliou durante o build');

    delete process.env.NEXT_PHASE;
    process.env.NEXT_RUNTIME = 'edge';
    await register();
    assert.equal(globalThis[chave], undefined, 'reconciliou no runtime errado');
  } finally {
    if (original.fase === undefined) delete process.env.NEXT_PHASE;
    else process.env.NEXT_PHASE = original.fase;
    if (original.runtime === undefined) delete process.env.NEXT_RUNTIME;
    else process.env.NEXT_RUNTIME = original.runtime;
    resetReconcileOnce();
  }
});

// ── AC · nada disso chega ao navegador ─────────────────────────────────────

test('AC. a reconciliação não tem superfície pública', async () => {
  const { readdir } = await import('node:fs/promises');
  const path = await import('node:path');
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
    assert.ok(
      !/reconcile|reconcileGenerationJobs/i.test(fonte),
      `${path.basename(path.dirname(caminho))} expõe a reconciliação`,
    );
  }
});

// ── o restart, de ponta a ponta ─────────────────────────────────────────────
//
// Os testes acima exercitam as decisões da reconciliação com uma finalização
// injetada. Este exercita o CENÁRIO: um processo submete, cai, o trabalho
// termina do lado do executor durante a queda, e o processo novo encontra tudo.
//
// O que sobrevive à "queda" é só o SQLite — que é exatamente o que sobrevive de
// verdade. Os registros em memória (jobs e acompanhamentos) morrem, como
// morrem num reinício.

test('restart integrado: submeteu, caiu, terminou lá fora, e o novo processo achou', async () => {
  const { startGeneration, finalizeGeneration } = await import('../lib/server/generation/facade.js');
  const { createJob, updateJob, getJob } = await import('../lib/server/comfy/jobs.js');
  const { STATES } = await import('../lib/server/comfy/status.js');

  const db = openDatabase(':memory:');
  createProject({ id: 'proj_r', name: 'Restart' }, db);
  const thread = createThreadRecord({ projectId: 'proj_r' }, db);
  const doUsuario = appendMessageRecord({
    threadId: thread.id, role: 'user', content: 'crie uma imagem',
  }, db);

  // ── processo A ────────────────────────────────────────────────────────────
  //
  // O turno roda: a geração é registrada e submetida, e o Showrunner responde.
  const JOB = 'cinema_restart_1';
  const PROMPT = 'prompt-restart-1';

  await startGeneration({ jobId: JOB, prompt: 'um castelo', workflowId: 'ideogram4_t2i' }, {
    projectId: 'proj_r',
    threadId: thread.id,
    userMessageId: doUsuario.id,
    db,
    deps: {
      submeter: async (p) => {
        createJob({ jobId: p.jobId, projectId: 'proj_r', kind: 'image', state: STATES.SUBMITTED, promptId: PROMPT });
        return { jobId: p.jobId, promptId: PROMPT, state: STATES.SUBMITTED };
      },
    },
  });

  const daResposta = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);

  // O turno morreu ANTES de amarrar a resposta — a janela que a âncora resolve.
  const antesDaQueda = getGenerationJobRecord(JOB, db);
  assert.equal(antesDaQueda.state, JOB_STATES.SUBMITTED);
  assert.equal(antesDaQueda.providerJobId, PROMPT);
  assert.equal(antesDaQueda.assistantMessageId, null);
  assert.equal(antesDaQueda.assetId, null);

  // ── a queda ───────────────────────────────────────────────────────────────
  //
  // Some tudo o que era memória. O banco fica, porque o banco é o que fica.
  delete globalThis[Symbol.for('showrunner.comfy.jobs')];
  delete globalThis[Symbol.for('showrunner.agent.jobWatch')];
  resetReconcileOnce();
  assert.equal(getJob(JOB), null, 'o registro em memória sobreviveu à queda');

  // ── durante a queda, o executor terminou ─────────────────────────────────
  const historicoDepoisDaQueda = { [PROMPT]: concluiuNoExecutor(JOB) };

  // ── processo B ────────────────────────────────────────────────────────────
  const resultado = await reconcileOnce({
    db,
    deps: {
      historico: async () => historicoDepoisDaQueda,
      localizarArquivo: semArquivoNoDisco,
      // A publicação do arquivo é do pipeline de mídia, exercitado noutro
      // arquivo; o que atravessa aqui é a finalização de verdade da facade —
      // Asset real, livro-razão real, associação real.
      concluir: async (jobId, opcoes) => {
        updateJob(jobId, {
          state: STATES.DONE,
          result: {
            url: `/api/media/image/proj_r/${jobId}.png`,
            filename: `${jobId}.png`,
            bytes: 4096,
          },
        });
        return finalizeGeneration(jobId, { ...opcoes, deps: { publicar: async () => ({ jobId }) } });
      },
    },
  });

  assert.deepEqual(resultado.recuperados, [JOB]);
  assert.equal(resultado.indisponivel, false);

  // O livro-razão fechou, com Asset real.
  const depois = getGenerationJobRecord(JOB, db);
  assert.equal(depois.state, JOB_STATES.DONE);
  assert.ok(depois.assetId);
  assert.ok(depois.finishedAt);
  assert.equal(depois.projectId, 'proj_r');
  assert.equal(depois.threadId, thread.id);
  assert.equal(depois.userMessageId, doUsuario.id);

  // O Asset é real e é do projeto do REGISTRO.
  const asset = db.prepare('SELECT id, projectId, kind, jobId FROM assets WHERE id = ?')
    .get(depois.assetId);
  assert.equal(asset.projectId, 'proj_r');
  assert.equal(asset.jobId, JOB);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);

  // E a mídia voltou para a resposta daquele turno — reencontrada pela âncora,
  // não pela última mensagem.
  assert.equal(depois.assistantMessageId, daResposta.id);
  assert.deepEqual(
    listMessageAssets(daResposta.id, db).map((m) => m.assetId),
    [depois.assetId],
  );

  // Reconciliar de novo, no mesmo processo, não faz nada.
  const denovo = await reconcileOnce({ db, deps: { historico: async () => historicoDepoisDaQueda } });
  assert.equal(denovo, resultado);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n, 1);

  resetReconcileOnce();
  delete globalThis[Symbol.for('showrunner.comfy.jobs')];
  db.close();
});
