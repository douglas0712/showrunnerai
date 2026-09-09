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
  markGenerationJobSubmitted, setGenerationJobState,
} from '../lib/server/domain/generationJobs.js';
import { JOB_STATES } from '../lib/server/domain/generationJobStates.js';
import {
  janelaDeHistorico, reconcileGenerationJobs, reconcileOnce, resetReconcileOnce,
} from '../lib/server/generation/reconcile.js';
import { getWorkflow } from '../lib/server/generation/workflows/registry.js';

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

/**
 * A fila do executor, vazia.
 *
 * TODO cenário precisa dela: sem injetar, a reconciliação chamaria a fila de
 * verdade pela rede — e um teste que depende de haver um ComfyUI de pé não é
 * determinístico. Foi assim que este arquivo passou a tocar a rede sem ninguém
 * notar quando o PASSO 10.5 acrescentou a segunda leitura.
 */
const filaVazia = async () => ({ queue_running: [], queue_pending: [] });

/** Uma fila com o trabalho dentro, na forma real: [numero, prompt_id, grafo]. */
function filaCom(jobId, { promptId = `prompt-${jobId}`, executando = false, prefixo = 'image/showrunner' } = {}) {
  const item = [1, promptId, itemDeFila(jobId, prefixo)];
  return async () => ({
    queue_running: executando ? [item] : [],
    queue_pending: executando ? [] : [item],
  });
}

/**
 * O grafo que o `/queue` devolve, com o nó de gravação REAL do workflow.
 *
 * O identificador do nó sai do descritor, não de um número escrito à mão: é
 * por ele que a reconciliação acha o trabalho quando o `promptId` se perdeu na
 * queda, e um teste com o nó errado passaria a testar nada.
 */
function itemDeFila(jobId, prefixo = 'image/showrunner') {
  const { nodeIds } = getWorkflow('ideogram4_t2i');
  return { [nodeIds.save]: { inputs: { filename_prefix: `${prefixo}/${jobId}` } } };
}

/** Nenhum acompanhamento de verdade: o do PASSO 9 é exercitado à parte. */
function acompanhamentoFalso() {
  const pedidos = [];
  const acompanhar = async (entrada) => {
    pedidos.push(entrada);
    return { ...entrada, pronto: Promise.resolve() };
  };
  acompanhar.pedidos = pedidos;
  return acompanhar;
}

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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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

test('I. sem evidência completa, o trabalho ausente continua ABERTO', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_i1', providerJobId: 'prompt-i1' });
  abertoNoLedger(db, { jobId: 'cinema_i2' });

  const r = await reconcileGenerationJobs({
    db,
    deps: {
      // O histórico não sabe de nenhum dos dois — mas a FILA não respondeu.
      // Sem as duas respostas, "não encontrei" não significa "não existe": eles
      // podem estar enfileirados ou executando AGORA.
      historico: async () => ({}),
      fila: async () => { throw new Error('fetch failed'); },
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
      acompanhar: acompanhamentoFalso(),
    },
  });

  assert.deepEqual(r.abertos.sort(), ['cinema_i1', 'cinema_i2']);
  assert.deepEqual(r.recuperados, []);
  assert.deepEqual(r.falhados, []);
  assert.deepEqual(r.orfaos, []);

  for (const id of ['cinema_i1', 'cinema_i2']) {
    const linha = getGenerationJobRecord(id, db);
    assert.notEqual(linha.state, JOB_STATES.ORPHANED, 'declarou perdido sem ter perguntado tudo');
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: async () => { throw new Error('fetch failed'); },
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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

test('AA. a reconciliação LÊ a fila, mas nunca a modifica', async () => {
  const codigo = await codigoDe('../lib/server/generation/reconcile.js');

  // Ler é o que permite distinguir "sumiu" de "está esperando a vez". Mexer na
  // fila do executor seria outra coisa inteira: cancelar trabalho alheio.
  assert.match(codigo, /queue_running/);
  assert.match(codigo, /queue_pending/);
  for (const proibido of ['deleteFromQueue', 'interrupt', 'cancelJob']) {
    assert.ok(!codigo.includes(proibido), `a reconciliação cita ${proibido}`);
  }
});

test('Z. a reconciliação usa o acompanhamento existente, não cria um segundo', async () => {
  const codigo = await codigoDe('../lib/server/generation/reconcile.js');

  // O mecanismo do PASSO 9, pelo nome dele. O que não pode existir é uma
  // segunda máquina de acompanhar.
  assert.match(codigo, /watchJob/);
  for (const proibido of ['criarRegistroDeAcompanhamento', 'setInterval', 'setTimeout']) {
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
      fila: filaVazia,
      acompanhar: acompanhamentoFalso(),
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

// ── PASSO 10.5 — o que ainda está em voo ────────────────────────────────────
//
// O 10.4 recupera o que TERMINOU durante a queda. Falta o outro caso, que é o
// mais comum: o processo volta e o trabalho ainda está lá, enfileirado ou
// executando. Sem alguém olhando, a máquina de geração é pull e ele para.
//
// E só agora `orphaned` pode existir — porque só agora as duas perguntas são
// feitas, e "não encontrei" pode significar "não existe".

test('A+D. a fila é lida UMA vez, e o trabalho casa pelo identificador dele', async () => {
  const { db } = cenario();
  abertoNoLedger(db, { jobId: 'cinema_q1', providerJobId: 'prompt-q1' });
  abertoNoLedger(db, { jobId: 'cinema_q2', providerJobId: 'prompt-q2' });

  let leituras = 0;
  const acompanhar = acompanhamentoFalso();
  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({}),
      fila: async () => {
        leituras += 1;
        return {
          queue_running: [[1, 'prompt-q1', {}]],
          queue_pending: [[2, 'prompt-q2', {}]],
        };
      },
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
      acompanhar,
    },
  });

  assert.equal(leituras, 1, 'uma leitura por ciclo, não uma por trabalho');
  assert.deepEqual(r.retomados.sort(), ['cinema_q1', 'cinema_q2']);
  db.close();
});

test('B+C. queue_pending vira queued; queue_running vira running', async () => {
  for (const [executando, esperado] of [[false, JOB_STATES.QUEUED], [true, JOB_STATES.RUNNING]]) {
    const { db } = cenario();
    abertoNoLedger(db, { jobId: 'cinema_bc', providerJobId: 'prompt-bc' });

    await reconcileGenerationJobs({
      db,
      deps: {
        historico: async () => ({}),
        fila: filaCom('cinema_bc', { promptId: 'prompt-bc', executando }),
        concluir: finalizacaoFalsa(),
        localizarArquivo: semArquivoNoDisco,
        acompanhar: acompanhamentoFalso(),
      },
    });

    const linha = getGenerationJobRecord('cinema_bc', db);
    assert.equal(linha.state, esperado);
    // Vivo não tem hora de fim, e o vocabulário é o do domínio.
    assert.equal(linha.finishedAt, null);
    db.close();
  }
});

test('E+F. o identificador perdido na queda é recuperado pelo GRAFO na fila', async () => {
  const { db } = cenario();
  // A janela real: o executor aceitou, o processo caiu antes de anotarmos, e o
  // trabalho continua na fila.
  abertoNoLedger(db, { jobId: 'cinema_e5' });
  assert.equal(getGenerationJobRecord('cinema_e5', db).providerJobId, null);

  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({}),
      fila: filaCom('cinema_e5', { promptId: 'prompt-real-e5', executando: true }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
      acompanhar: acompanhamentoFalso(),
    },
  });

  const linha = getGenerationJobRecord('cinema_e5', db);
  assert.equal(linha.providerJobId, 'prompt-real-e5', 'não recuperou pelo grafo');
  assert.equal(linha.state, JOB_STATES.RUNNING);

  // F. E a escrita única continua valendo: outro identificador é recusado.
  assert.throws(
    () => markGenerationJobSubmitted('cinema_e5', 'prompt-outro', { db }),
    /não pode virar/,
  );

  db.close();
});

test('G+I. o trabalho vivo volta a ser acompanhado, com contexto do LIVRO-RAZÃO', async () => {
  const { db, thread, doUsuario } = cenario();
  abertoNoLedger(db, {
    jobId: 'cinema_g5', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-g5',
  });
  abertoNoLedger(db, {
    jobId: 'cinema_g6', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-g6',
  });

  const acompanhar = acompanhamentoFalso();
  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({}),
      fila: async () => ({
        queue_running: [[1, 'prompt-g5', {}]],
        queue_pending: [[2, 'prompt-g6', {}]],
      }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
      acompanhar,
    },
  });

  // I. Dois trabalhos, dois acompanhamentos independentes.
  assert.equal(acompanhar.pedidos.length, 2);
  for (const pedido of acompanhar.pedidos) {
    // Nada foi perguntado ao executor nem inferido do disco: de quem é o
    // trabalho já estava gravado.
    assert.equal(pedido.projectId, 'proj_a');
    assert.equal(pedido.threadId, thread.id);
    assert.equal(pedido.kind, 'image');
  }
  assert.deepEqual(acompanhar.pedidos.map((p) => p.jobId).sort(), ['cinema_g5', 'cinema_g6']);

  db.close();
});

test('H. um acompanhamento que já existe é REUTILIZADO, não duplicado', async () => {
  const { db, thread, doUsuario } = cenario();
  const { criarRegistroDeAcompanhamento } = await import('../lib/server/agent/tools/jobWatch.js');
  abertoNoLedger(db, {
    jobId: 'cinema_h5', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-h5',
  });

  // O acompanhamento REAL do PASSO 9, com single-flight por jobId.
  const registro = criarRegistroDeAcompanhamento({
    consultar: async () => ({ jobId: 'cinema_h5', status: JOB_STATES.RUNNING }),
    esperar: () => new Promise(() => { /* segura o laço */ }),
  });
  const primeiro = registro.watch(
    { jobId: 'cinema_h5', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  assert.equal(registro.size(), 1);

  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({}),
      fila: filaCom('cinema_h5', { promptId: 'prompt-h5', executando: true }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
      acompanhar: async (entrada, opcoes) => registro.watch(entrada, opcoes),
    },
  });

  assert.equal(registro.size(), 1, 'nasceu um segundo laço sobre o mesmo trabalho');
  assert.equal(registro.get('cinema_h5'), primeiro);

  db.close();
});

test('J+K. o que já acabou NÃO ganha acompanhamento', async () => {
  const { db, thread, doUsuario } = cenario();
  abertoNoLedger(db, {
    jobId: 'cinema_j5', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-j5',
  });
  abertoNoLedger(db, {
    jobId: 'cinema_k5', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-k5',
  });

  const acompanhar = acompanhamentoFalso();
  await reconcileGenerationJobs({
    db,
    deps: {
      // J. O histórico diz que acabou — e o histórico vence a fila.
      historico: async () => ({ 'prompt-j5': concluiuNoExecutor('cinema_j5') }),
      // Ele aparece nos DOIS por uma condição transitória: a evidência terminal
      // é a que vale.
      fila: async () => ({ queue_running: [[1, 'prompt-j5', {}]], queue_pending: [] }),
      concluir: finalizacaoFalsa(),
      // K. E o outro já tem arquivo publicado.
      localizarArquivo: async (kind, jobId) => (jobId === 'cinema_k5'
        ? { projectId: 'proj_a', filename: 'k5.png', url: '/api/media/image/proj_a/k5.png' }
        : null),
      acompanhar,
    },
  });

  assert.deepEqual(acompanhar.pedidos, [], 'acompanhou trabalho que já tinha acabado');
  assert.equal(getGenerationJobRecord('cinema_j5', db).state, JOB_STATES.DONE);
  assert.equal(getGenerationJobRecord('cinema_k5', db).state, JOB_STATES.DONE);

  db.close();
});

// ── O · P · Q · R · o órfão, agora que ele pode existir ────────────────────

test('O+P+Q. sem evidência no executor saudável, o trabalho vira órfão', async () => {
  const { db, thread, doUsuario } = cenario();
  abertoNoLedger(db, {
    jobId: 'cinema_o5', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-o5',
  });

  const acompanhar = acompanhamentoFalso();
  const r = await reconcileGenerationJobs({
    db,
    deps: {
      // O executor RESPONDEU às duas, e não conhece o trabalho. É o caso de um
      // ComfyUI que reiniciou: o histórico dele é memória.
      historico: async () => ({}),
      fila: filaVazia,
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
      acompanhar,
    },
  });

  assert.deepEqual(r.orfaos, ['cinema_o5']);
  const linha = getGenerationJobRecord('cinema_o5', db);

  // P. Terminal, com hora de fim.
  assert.equal(linha.state, JOB_STATES.ORPHANED);
  assert.ok(linha.finishedAt);
  assert.ok(linha.error);
  // Q. E sem Asset: não houve resultado nenhum.
  assert.equal(linha.assetId, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  // Nem acompanhamento, nem conversa falsa.
  assert.deepEqual(acompanhar.pedidos, []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n, 0);

  // P-bis. Terminal é definitivo: não volta a ser aberto.
  assert.throws(
    () => setGenerationJobState('cinema_o5', JOB_STATES.RUNNING, { db }),
    /já terminou como "orphaned"/,
  );

  db.close();
});

test('R. para quem espera, órfão é falhou', async () => {
  const { estadoDeProducao, PRODUCAO } = await import('../lib/server/agent/tools/jobWatch.js');
  const { labelForProduction } = await import('../lib/agentClient.js');

  // A distinção existe para o operador, no log. Na conversa, um trabalho
  // perdido e um que falhou são a mesma coisa: não veio resultado.
  assert.equal(estadoDeProducao(JOB_STATES.ORPHANED), PRODUCAO.FALHOU);
  assert.equal(
    labelForProduction({ id: 'w', kind: 'image', state: PRODUCAO.FALHOU }),
    'Não consegui concluir esta geração.',
  );
});

test('L+M+N. indisponibilidade do executor NUNCA vira órfão', async () => {
  // Três formas de não saber: as duas leituras falham, só o histórico falha, só
  // a fila falha. Em nenhuma delas se declara desfecho.
  const casos = [
    ['as duas', { historico: 'falha', fila: 'falha' }],
    ['só o histórico', { historico: 'falha', fila: 'ok' }],
    ['só a fila', { historico: 'ok', fila: 'falha' }],
  ];

  for (const [rotulo, quais] of casos) {
    const { db } = cenario();
    abertoNoLedger(db, { jobId: 'cinema_lmn', providerJobId: 'prompt-lmn' });

    const r = await reconcileGenerationJobs({
      db,
      deps: {
        historico: quais.historico === 'falha'
          ? async () => { throw new Error('ECONNREFUSED'); }
          : async () => ({}),
        fila: quais.fila === 'falha'
          ? async () => { throw new Error('ECONNREFUSED'); }
          : filaVazia,
        concluir: finalizacaoFalsa(),
        localizarArquivo: semArquivoNoDisco,
        acompanhar: acompanhamentoFalso(),
      },
    });

    assert.deepEqual(r.orfaos, [], `${rotulo}: declarou perdido sem saber`);
    const linha = getGenerationJobRecord('cinema_lmn', db);
    assert.notEqual(linha.state, JOB_STATES.ORPHANED, rotulo);
    assert.notEqual(linha.state, JOB_STATES.FAILED, rotulo);
    assert.notEqual(linha.state, JOB_STATES.CANCELLED, rotulo);
    assert.equal(linha.finishedAt, null, rotulo);
    db.close();
  }
});

// ── U · a regra absoluta ────────────────────────────────────────────────────

test('U. nenhum caminho de recuperação submete — a fila incluída', async () => {
  const codigo = await codigoDe('../lib/server/generation/reconcile.js');
  for (const proibido of [
    'submitGeneration', 'startGeneration', 'startImageGeneration',
    'startVideoGeneration', 'submitPrompt', '/prompt',
  ]) {
    assert.ok(!codigo.includes(proibido), `a reconciliação alcança ${proibido}`);
  }
});

test('AC+AD. a recuperação não fala com o serviço de raciocínio nem com o navegador', async () => {
  const codigo = await codigoDe('../lib/server/generation/reconcile.js');

  // Geração é infraestrutura do Showrunner. O serviço de raciocínio pode nem
  // estar conectado, e o navegador pode estar fechado.
  for (const proibido of [
    'hermes', 'runtimeClient', 'sessionBinding', 'bridge', 'runTurn',
    'sendMessage', 'streamMessage', 'window', 'localStorage', 'fetchThread',
  ]) {
    assert.ok(!new RegExp(proibido, 'i').test(codigo), `a reconciliação cita ${proibido}`);
  }
});

// ── S · T · os dois restarts em voo, de ponta a ponta ──────────────────────

/** Um executor falso que anda: da fila para o histórico, quando o teste manda. */
function executorQueAnda({ jobId, promptId, executando = true }) {
  const estado = { naFila: true };
  const item = [1, promptId, itemDeFila(jobId)];

  return {
    terminar() { estado.naFila = false; },
    acabou: () => !estado.naFila,
    fila: async () => (estado.naFila
      ? {
        queue_running: executando ? [item] : [],
        queue_pending: executando ? [] : [item],
      }
      : { queue_running: [], queue_pending: [] }),
    historico: async () => (estado.naFila ? {} : { [promptId]: concluiuNoExecutor(jobId) }),
  };
}

/**
 * O freio do PASSO 9.
 *
 * Enquanto está puxado, o laço para depois de cada consulta; solto, ele corre
 * cedendo o controle a cada volta. Sem ele, um laço que consulta e espera zero
 * nunca devolve o processo ao teste.
 */
function criarFreio() {
  const pendentes = [];
  let solto = false;
  return {
    esperar: () => (solto
      ? new Promise((resolver) => { setTimeout(resolver, 0); })
      : new Promise((resolver) => { pendentes.push(resolver); })),
    soltar() {
      solto = true;
      while (pendentes.length) pendentes.shift()();
    },
  };
}

/**
 * O restart com o trabalho AINDA EM VOO, de ponta a ponta.
 *
 * É o cenário que o 10.5 existe para cobrir, e o único jeito honesto de
 * afirmá-lo é encenar os dois processos: um que submete e cai, outro que sobe,
 * encontra o trabalho vivo na fila e o leva até a mídia na conversa.
 *
 * O que é falso aqui é o EXECUTOR e a publicação do arquivo. O livro-razão é o
 * de verdade, a reconciliação é a de verdade, e o acompanhamento é o do PASSO 9
 * — inclusive o single-flight e a amarração à mensagem.
 */
async function restartEmVoo({ executando }) {
  const { startGeneration } = await import('../lib/server/generation/facade.js');
  const { createJob, getJob } = await import('../lib/server/comfy/jobs.js');
  const { STATES } = await import('../lib/server/comfy/status.js');
  const { criarRegistroDeAcompanhamento } = await import('../lib/server/agent/tools/jobWatch.js');

  const db = openDatabase(':memory:');
  createProject({ id: 'proj_v', name: 'Em voo' }, db);
  const thread = createThreadRecord({ projectId: 'proj_v' }, db);
  const doUsuario = appendMessageRecord({
    threadId: thread.id, role: 'user', content: 'crie uma imagem',
  }, db);

  const JOB = `cinema_voo_${executando ? 'run' : 'queue'}`;
  const PROMPT = `prompt-${JOB}`;
  let submissoes = 0;

  // ── processo A: submete, e cai ────────────────────────────────────────────
  await startGeneration({ jobId: JOB, prompt: 'x', workflowId: 'ideogram4_t2i' }, {
    projectId: 'proj_v',
    threadId: thread.id,
    userMessageId: doUsuario.id,
    db,
    deps: {
      submeter: async (p) => {
        submissoes += 1;
        createJob({
          jobId: p.jobId,
          projectId: 'proj_v',
          kind: 'image',
          state: STATES.SUBMITTED,
          promptId: PROMPT,
        });
        return { jobId: p.jobId, promptId: PROMPT, state: STATES.SUBMITTED };
      },
    },
  });

  // A resposta daquele turno: é nela que a mídia tem de aparecer no fim. A
  // conversa segue depois dela, para que "a última mensagem" não sirva.
  const daResposta = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);
  appendMessageRecord({ threadId: thread.id, role: 'user', content: 'obrigado' }, db);

  // ── a queda: some tudo o que era memória; o banco fica ───────────────────
  delete globalThis[Symbol.for('showrunner.comfy.jobs')];
  delete globalThis[Symbol.for('showrunner.agent.jobWatch')];
  resetReconcileOnce();
  assert.equal(getJob(JOB), null, 'o registro em memória sobreviveu à queda');

  // ── o executor, com o trabalho ainda em voo ──────────────────────────────
  const executor = executorQueAnda({ jobId: JOB, promptId: PROMPT, executando });
  const concluir = finalizacaoFalsa();
  const freio = criarFreio();

  // A consulta do acompanhamento faz o que a de verdade faz: pergunta ao
  // executor e, quando ele terminou, ATRAVESSA a finalização — que publica o
  // Asset e fecha o livro-razão. É o caminho da facade, sem rede nem disco.
  const registro = criarRegistroDeAcompanhamento({
    esperar: freio.esperar,
    consultar: async () => {
      const linha = getGenerationJobRecord(JOB, db);
      if (linha.state === JOB_STATES.DONE) {
        return { jobId: JOB, kind: 'image', status: JOB_STATES.DONE, assetId: linha.assetId };
      }
      if (!executor.acabou()) {
        return {
          jobId: JOB,
          kind: 'image',
          status: executando ? JOB_STATES.RUNNING : JOB_STATES.QUEUED,
        };
      }
      await concluir(JOB, { db });
      const fim = getGenerationJobRecord(JOB, db);
      return { jobId: JOB, kind: 'image', status: JOB_STATES.DONE, assetId: fim.assetId };
    },
  });

  // ── processo B: sobe e reconcilia ────────────────────────────────────────
  const r = await reconcileOnce({
    db,
    deps: {
      historico: executor.historico,
      fila: executor.fila,
      localizarArquivo: semArquivoNoDisco,
      concluir,
      acompanhar: async (entrada, opcoes) => registro.watch(entrada, opcoes),
    },
  });

  assert.deepEqual(r.retomados, [JOB], 'o trabalho vivo não foi retomado');
  assert.deepEqual(r.orfaos, [], 'declarou perdido um trabalho que está na fila');
  assert.deepEqual(r.recuperados, [], 'concluiu um trabalho que ainda estava em voo');
  assert.equal(
    getGenerationJobRecord(JOB, db).state,
    executando ? JOB_STATES.RUNNING : JOB_STATES.QUEUED,
  );
  assert.equal(registro.size(), 1, 'nasceu mais de um acompanhamento');
  // Ainda não há resultado: o trabalho está vivo, não concluído.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  assert.deepEqual(concluir.chamadas, []);

  // ── o executor termina, e o acompanhamento retomado leva até o fim ───────
  executor.terminar();
  freio.soltar();
  await registro.get(JOB).pronto;

  const depois = getGenerationJobRecord(JOB, db);
  assert.equal(depois.state, JOB_STATES.DONE);
  assert.ok(depois.assetId);
  assert.ok(depois.finishedAt);

  // A mídia voltou para a resposta daquele turno — pela âncora, não pela
  // última mensagem, que aqui é do usuário.
  assert.equal(depois.assistantMessageId, daResposta.id);
  assert.deepEqual(
    listMessageAssets(daResposta.id, db).map((m) => m.assetId),
    [depois.assetId],
  );

  // Uma geração continua sendo uma: nada foi ressubmetido, nada duplicou.
  assert.equal(submissoes, 1, 'o restart transformou uma geração em duas');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n, 1);

  resetReconcileOnce();
  delete globalThis[Symbol.for('showrunner.comfy.jobs')];
  delete globalThis[Symbol.for('showrunner.agent.jobWatch')];
  db.close();
}

test('S+U+V+W+X. restart com o trabalho EXECUTANDO: retoma, conclui, entrega', async () => {
  await restartEmVoo({ executando: true });
});

test('T. restart com o trabalho NA FILA: queued, retoma, conclui', async () => {
  await restartEmVoo({ executando: false });
});

// ── AA · AB · falha do acompanhamento não é falha do trabalho ──────────────

test('AA+AB. teto e erro do acompanhamento retomado não viram desfecho no ledger', async () => {
  const { criarRegistroDeAcompanhamento } = await import('../lib/server/agent/tools/jobWatch.js');
  const { db, thread, doUsuario } = cenario();
  abertoNoLedger(db, {
    jobId: 'cinema_aa5', threadId: thread.id, userMessageId: doUsuario.id, providerJobId: 'prompt-aa5',
  });

  await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({}),
      fila: filaCom('cinema_aa5', { promptId: 'prompt-aa5', executando: true }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
      acompanhar: acompanhamentoFalso(),
    },
  });

  const antes = getGenerationJobRecord('cinema_aa5', db);
  assert.equal(antes.state, JOB_STATES.RUNNING);

  // AA. O acompanhamento retomado estoura o próprio teto.
  const comTeto = criarRegistroDeAcompanhamento({
    consultar: async () => ({ jobId: 'cinema_aa5', status: JOB_STATES.RUNNING }),
    esperar: async () => {},
    agora: (() => { let t = INSTANTE; return () => { t += 10_000; return t; }; })(),
    limiteMs: 30_000,
  });
  await comTeto.watch(
    { jobId: 'cinema_aa5', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  ).pronto;

  // AB. E um erro inesperado dentro dele.
  const comErro = criarRegistroDeAcompanhamento({
    consultar: async () => null,
    esperar: async () => {},
  });
  await comErro.watch(
    { jobId: 'cinema_aa5_b', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  ).pronto;

  // "Parei de vigiar" não é "o executor falhou". O trabalho continua vivo lá, e
  // um reinício futuro o reconcilia de novo.
  assert.deepEqual(getGenerationJobRecord('cinema_aa5', db), antes);
  assert.notEqual(getGenerationJobRecord('cinema_aa5', db).state, JOB_STATES.ORPHANED);

  db.close();
});

// ── AD · o não-Agent: a capacidade real ────────────────────────────────────

test('o trabalho vivo SEM conversa tem o estado reconciliado, mas não é acompanhado', async () => {
  const { db } = cenario();
  // A geração do estúdio nasce sem thread. O acompanhamento é, por construção,
  // ligado a uma conversa — ele existe para levar o resultado até uma resposta.
  // Quem leva o trabalho do estúdio ao fim continua sendo a tela, em laço.
  abertoNoLedger(db, { jobId: 'cinema_studio5', providerJobId: 'prompt-studio5' });

  const acompanhar = acompanhamentoFalso();
  const r = await reconcileGenerationJobs({
    db,
    deps: {
      historico: async () => ({}),
      fila: filaCom('cinema_studio5', { promptId: 'prompt-studio5', executando: true }),
      concluir: finalizacaoFalsa(),
      localizarArquivo: semArquivoNoDisco,
      acompanhar,
    },
  });

  assert.deepEqual(r.retomados, ['cinema_studio5']);
  assert.deepEqual(r.orfaos, [], 'um trabalho vivo não pode ser declarado perdido');
  assert.equal(getGenerationJobRecord('cinema_studio5', db).state, JOB_STATES.RUNNING);
  assert.deepEqual(acompanhar.pedidos, [], 'acompanhou um trabalho sem conversa');

  db.close();
});
