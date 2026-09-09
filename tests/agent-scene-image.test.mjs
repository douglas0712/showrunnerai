// A imagem de uma cena — project.generate_scene_image.
//
// PASSO 13-B. O que estes testes trancam é a frase que separa esta ferramenta
// da geração avulsa: **o resultado ocupa um lugar**. `og.generate_image` produz
// uma imagem para a CONVERSA, e ninguém nunca saberá de qual cena ela era.
// Aqui a imagem é o take de imagem de uma cena, com número, e a cena passa a
// ter uma imagem escolhida.
//
// As invariantes que importam, e por que cada uma existe:
//
//   só ordinal e prompt        identidade do projeto e número do take são do
//                              estúdio; um campo desses no schema é um campo
//                              que o modelo aprende a preencher
//   take nasce ANTES da        entre o registro durável e a submissão: depois
//   submissão                  seria um trabalho real sem lugar; antes de
//                              registrar seria um take vazio
//   nunca take vazio           uma falha de submissão deixa o take LIGADO ao
//                              job, e o desfecho mora no generation_jobs
//   o vínculo é no livro-razão o acompanhamento vivo, a tela e a reconciliação
//                              depois de um reinício passam todos por lá
//   primeira escolha           o primeiro take que CONCLUIR vira a imagem da
//                              cena; o segundo não toma o lugar dela
//   take falho nunca escolhe   só há escolha onde há Asset
//   nada de vídeo              este passo é imagem, e só

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { generateSceneImageTool } from '../lib/server/agent/tools/handlers/productionSceneMedia.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';
import { hermesAliases, toCanonicalToolName } from '../lib/server/agent/hermes/aliases.js';
import { closeDatabase, openDatabase } from '../lib/server/domain/db.js';
import { JOB_STATE_VALUES, JOB_STATES } from '../lib/server/domain/generationJobStates.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import {
  completeGenerationJob, createGenerationJobRecord, setGenerationJobState,
} from '../lib/server/domain/generationJobs.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import {
  replaceProductionScenes, saveProductionPlan, saveProductionScript,
} from '../lib/server/domain/production.js';
import {
  getSceneSelection, linkCompletedJobToSceneTake, listSceneTakes,
} from '../lib/server/domain/sceneMedia.js';
import { startImageGeneration } from '../lib/server/generation/facade.js';

const CHAVE = Symbol.for('showrunner.domain.db');

test.after(() => {
  closeDatabase();
  delete globalThis[CHAVE];
});

/**
 * Dois projetos com produção gravada, duas conversas.
 *
 * As tools abrem o banco da APLICAÇÃO — elas rodam num turno real, onde não há
 * injeção de dependência a atravessar o socket do plugin —, então a instância
 * global é trocada por uma em memória. Mesmo recurso de
 * `agent-production-tools.test.mjs`.
 */
function cenario() {
  closeDatabase();
  const db = openDatabase(':memory:');
  globalThis[CHAVE] = db;

  const contextos = {};
  for (const [id, nome] of [['proj_a', 'Produção A'], ['proj_b', 'Produção B']]) {
    createProject({ id, name: nome }, db);
    saveProductionPlan({ projectId: id, title: 'Plano', targetDurationSeconds: 120 }, db);
    saveProductionScript({ projectId: id, title: 'Roteiro', fullText: 'ABERTURA...' }, db);
    replaceProductionScenes(id, [
      {
        ordinal: 1, title: 'O Olimpo', purpose: 'Situar o mundo dos deuses',
        durationSeconds: 60, visualDescription: 'Plano geral do Olimpo ao amanhecer.',
      },
      {
        ordinal: 2, title: 'O roubo', purpose: 'O ato que muda tudo',
        durationSeconds: 60, visualDescription: 'Close na brasa dentro do caule oco.',
      },
    ], db);
    const thread = createThreadRecord({ projectId: id, title: nome }, db);
    contextos[id] = {
      threadId: thread.id, projectId: id, userMessageId: null, signal: null,
    };
  }

  return { db, ctxA: contextos.proj_a, ctxB: contextos.proj_b };
}

let contador = 0;

/**
 * Uma geração falsa que se comporta como a de verdade: registra o trabalho no
 * livro-razão, chama o gancho, e devolve o que a facade devolveria.
 *
 * O que ela NÃO faz é falar com executor nenhum — é o ponto: a ferramenta é
 * exercitada inteira sem ComfyUI, sem rede e sem GPU.
 */
function geracaoFalsa(db, { antesDoGancho = null, aposOGancho = null } = {}) {
  const chamadas = [];
  const iniciar = async ({ prompt }, opcoes) => {
    contador += 1;
    const jobId = `job_cena_${contador}`;
    chamadas.push({ prompt, projectId: opcoes.projectId, threadId: opcoes.threadId });

    createGenerationJobRecord({
      jobId,
      projectId: opcoes.projectId,
      kind: 'image',
      workflowId: 'ideogram4_t2i',
      threadId: opcoes.threadId,
    }, db);

    if (antesDoGancho) antesDoGancho(jobId);
    await opcoes.aoRegistrar({ jobId, kind: 'image', workflowId: 'ideogram4_t2i', projectId: opcoes.projectId });
    if (aposOGancho) aposOGancho(jobId);

    return { jobId, kind: 'image', status: 'preparando' };
  };
  return { iniciar, chamadas };
}

/** Um acompanhamento falso, para provar que a Job Autonomy continua sendo usada. */
function acompanhamentoFalso() {
  const vistos = [];
  return { acompanhar: (entrada) => { vistos.push(entrada); }, vistos };
}

/** O Asset que a geração publicaria. */
function assetPublicado(db, projectId, jobId, kind = 'image') {
  return createAsset({
    projectId, kind, jobId, filename: `${jobId}.png`,
    url: `/api/media/${kind}/${projectId}/${jobId}.png`,
  }, db);
}

/** Conclui a geração pelo caminho durável — o mesmo da reconciliação. */
function concluir(db, projectId, jobId, kind = 'image') {
  const asset = assetPublicado(db, projectId, jobId, kind);
  completeGenerationJob(jobId, { assetId: asset.id, db });
  return asset;
}

function colunas(db, tabela) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
}

// ── A · B · a cena precisa existir, e ser desta produção ────────────────────

test('A. uma cena que não existe é recusada, e nenhuma geração começa', async () => {
  const { db, ctxA } = cenario();
  const { iniciar, chamadas } = geracaoFalsa(db);

  for (const ordinal of [9, 0, -1, 'quatro', null]) {
    await assert.rejects(
      () => generateSceneImageTool.execute(ctxA, { ordinal, prompt: 'luz' }, { iniciar }),
      (erro) => erro.name === 'ToolExecutionError',
    );
  }

  assert.equal(chamadas.length, 0, 'não pode ter começado geração nenhuma');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_media').get().n, 0);
});

test('B. a cena 1 é sempre a do projeto do contexto — a de outro é impronunciável', async () => {
  const { db, ctxA, ctxB } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneImageTool.execute(
    ctxB, { ordinal: 1, prompt: 'brasa' }, { iniciar, acompanhar },
  );

  // O take foi para a cena 1 DE B. A cena 1 de A não foi tocada — e não havia
  // como pedir por ela: o número 1 significa "a primeira cena deste roteiro".
  assert.equal(listSceneTakes('proj_b', 1, 'image', db).length, 1);
  assert.equal(listSceneTakes('proj_a', 1, 'image', db).length, 0);

  // E a geração nasceu no projeto certo.
  const job = db.prepare('SELECT projectId FROM generation_jobs').get();
  assert.equal(job.projectId, 'proj_b');
});

// ── C · D · E · F · os takes ───────────────────────────────────────────────

test('C+D. a primeira geração cria o take 1; a segunda cria o 2, sem apagar', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  const primeira = await generateSceneImageTool.execute(
    ctxA, { ordinal: 1, prompt: 'Olimpo ao amanhecer, contraluz' }, { iniciar, acompanhar },
  );
  const segunda = await generateSceneImageTool.execute(
    ctxA, { ordinal: 1, prompt: 'Olimpo ao amanhecer, mais fechado' }, { iniciar, acompanhar },
  );

  assert.equal(primeira.takeNumber, 1);
  assert.equal(segunda.takeNumber, 2);

  const takes = listSceneTakes('proj_a', 1, 'image', db);
  assert.deepEqual(takes.map((t) => t.takeNumber), [1, 2]);
  assert.notEqual(takes[0].generationJobId, takes[1].generationJobId);

  // A cena 2 continua vazia: o take é por CENA.
  assert.equal(listSceneTakes('proj_a', 2, null, db).length, 0);

  // E a cena 2 começa do 1 também.
  const outra = await generateSceneImageTool.execute(
    ctxA, { ordinal: 2, prompt: 'close na brasa' }, { iniciar, acompanhar },
  );
  assert.equal(outra.takeNumber, 1);
});

test('E. o modelo não escolhe o número do take — nem pedindo', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await assert.rejects(
    () => generateSceneImageTool.execute(
      ctxA, { ordinal: 1, prompt: 'luz', takeNumber: 7 }, { iniciar, acompanhar },
    ),
    (erro) => erro.name === 'ToolExecutionError' && /takeNumber/.test(erro.message),
  );

  // E quando ele nem tenta, o número continua sendo o do servidor.
  const saida = await generateSceneImageTool.execute(
    ctxA, { ordinal: 1, prompt: 'luz' }, { iniciar, acompanhar },
  );
  assert.equal(saida.takeNumber, 1);
});

test('F. o take nasce ligado ao job da geração que o criou', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneImageTool.execute(
    ctxA, { ordinal: 1, prompt: 'luz' }, { iniciar, acompanhar },
  );

  const take = listSceneTakes('proj_a', 1, 'image', db)[0];
  assert.ok(take.generationJobId, 'o take precisa apontar para a geração');
  assert.equal(take.assetId, null, 'ainda não há mídia: a geração acabou de começar');

  const job = db.prepare('SELECT * FROM generation_jobs WHERE jobId = ?').get(take.generationJobId);
  assert.equal(job.projectId, 'proj_a');
  assert.equal(job.kind, 'image');
  assert.equal(job.threadId, ctxA.threadId);
});

// ── G · H · I · o Asset encontra o take ────────────────────────────────────

test('G. concluir a geração associa o Asset ao take que a pediu', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneImageTool.execute(
    ctxA, { ordinal: 1, prompt: 'luz' }, { iniciar, acompanhar },
  );
  const antes = listSceneTakes('proj_a', 1, 'image', db)[0];

  const asset = concluir(db, 'proj_a', antes.generationJobId);

  const depois = listSceneTakes('proj_a', 1, 'image', db)[0];
  assert.equal(depois.id, antes.id, 'é o MESMO take, não outro');
  assert.equal(depois.assetId, asset.id);

  // Concluir de novo é replay e não muda nada.
  completeGenerationJob(antes.generationJobId, { assetId: asset.id, db });
  assert.equal(listSceneTakes('proj_a', 1, 'image', db)[0].assetId, asset.id);
});

test('H. um Asset de outro projeto nunca entra no take', () => {
  const { db } = cenario();

  createGenerationJobRecord({
    jobId: 'job_a', projectId: 'proj_a', kind: 'image', workflowId: 'ideogram4_t2i',
  }, db);
  // O take é criado direto para chegar ao vínculo com um Asset forasteiro.
  const scriptA = db.prepare('SELECT id FROM production_scripts WHERE projectId = ?').get('proj_a');
  const cena = db.prepare('SELECT id FROM production_scenes WHERE scriptId = ? AND ordinal = 1').get(scriptA.id);
  db.prepare(`
    INSERT INTO production_scene_media
      (id, sceneId, kind, takeNumber, generationJobId, assetId, createdAt, updatedAt)
    VALUES ('media_a', ?, 'image', 1, 'job_a', NULL, ?, ?)
  `).run(cena.id, Date.now(), Date.now());

  const alheio = assetPublicado(db, 'proj_b', 'job_alheio');
  assert.throws(
    () => linkCompletedJobToSceneTake('job_a', alheio.id, db),
    (erro) => erro.name === 'DomainError' && /de outro projeto/.test(erro.message),
  );

  // E o livro-razão recusa antes mesmo de chegar lá.
  assert.throws(
    () => completeGenerationJob('job_a', { assetId: alheio.id, db }),
    (erro) => erro.name === 'DomainError' && /de outro projeto/.test(erro.message),
  );

  assert.equal(db.prepare("SELECT assetId FROM production_scene_media WHERE id = 'media_a'").get().assetId, null);
});

test('I. um Asset de vídeo nunca entra num take de imagem', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneImageTool.execute(
    ctxA, { ordinal: 1, prompt: 'luz' }, { iniciar, acompanhar },
  );
  const take = listSceneTakes('proj_a', 1, 'image', db)[0];
  const video = assetPublicado(db, 'proj_a', 'job_video', 'video');

  assert.throws(
    () => linkCompletedJobToSceneTake(take.generationJobId, video.id, db),
    (erro) => erro.name === 'DomainError' && /é de video/.test(erro.message),
  );
  assert.equal(listSceneTakes('proj_a', 1, 'image', db)[0].assetId, null);
});

// ── J · a falha não deixa take vazio ───────────────────────────────────────

test('J. a submissão que falha deixa o take LIGADO ao job, nunca vazio', async () => {
  const { db, ctxA } = cenario();

  // Uma geração que registra, cria o take pelo gancho, e então falha ao
  // submeter — a janela exata que a ordem existe para tratar.
  const { iniciar } = geracaoFalsa(db, {
    aposOGancho: (jobId) => {
      setGenerationJobState(jobId, JOB_STATES.FAILED, {
        db, error: 'o executor recusou o trabalho',
      });
      throw Object.assign(new Error('o executor recusou'), { name: 'GenerationError' });
    },
  });

  await assert.rejects(
    () => generateSceneImageTool.execute(ctxA, { ordinal: 1, prompt: 'luz' }, { iniciar }),
    (erro) => erro.name === 'ToolExecutionError',
  );

  // O take existe, e é RASTREÁVEL: ele sabe de qual geração era.
  const takes = listSceneTakes('proj_a', 1, 'image', db);
  assert.equal(takes.length, 1);
  assert.ok(takes[0].generationJobId, 'take vazio: sem job e sem Asset');
  assert.equal(takes[0].assetId, null);

  // E o desfecho está onde ele sempre esteve: no livro-razão. Nenhum estado
  // novo foi inventado para dizer "este take falhou".
  const job = db.prepare('SELECT state, error FROM generation_jobs WHERE jobId = ?')
    .get(takes[0].generationJobId);
  assert.equal(job.state, JOB_STATES.FAILED);
  assert.ok(job.error);

  // Nenhum take sem rastro em lugar nenhum do banco.
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_media WHERE generationJobId IS NULL AND assetId IS NULL').get().n,
    0,
  );
});

test('J-bis. a facade chama o gancho ANTES de submeter — e não submete se ele falhar', async () => {
  const { db } = cenario();
  const ordem = [];

  // O gancho explode: nada pode ter sido submetido.
  await assert.rejects(
    () => startImageGeneration({ prompt: 'luz' }, {
      projectId: 'proj_a',
      db,
      aoRegistrar: () => { ordem.push('gancho'); throw new Error('take recusado'); },
      deps: {
        novoJobId: () => 'job_gancho',
        submeter: async () => { ordem.push('submeteu'); return { promptId: 'p1', state: 'na-fila' }; },
      },
    }),
    /take recusado/,
  );
  assert.deepEqual(ordem, ['gancho'], 'submeteu apesar de o gancho ter falhado');

  // O registro existe e nunca foi submetido — a situação que a reconciliação
  // já sabe tratar, sem estado novo.
  const job = db.prepare('SELECT state, providerJobId FROM generation_jobs WHERE jobId = ?').get('job_gancho');
  assert.equal(job.state, JOB_STATES.PREPARING);
  assert.equal(job.providerJobId, null);

  // E, no caminho normal, o gancho vem depois do registro e antes da submissão.
  ordem.length = 0;
  let viuORegistro = null;
  await startImageGeneration({ prompt: 'luz' }, {
    projectId: 'proj_a',
    db,
    aoRegistrar: ({ jobId }) => {
      ordem.push('gancho');
      viuORegistro = db.prepare('SELECT jobId FROM generation_jobs WHERE jobId = ?').get(jobId);
    },
    deps: {
      novoJobId: () => 'job_ordem',
      submeter: async () => { ordem.push('submeteu'); return { promptId: 'p2', state: 'na-fila' }; },
    },
  });
  assert.deepEqual(ordem, ['gancho', 'submeteu']);
  assert.ok(viuORegistro, 'o gancho precisa enxergar o trabalho já registrado');
});

// ── K · L · M · a primeira escolha ─────────────────────────────────────────

test('K+L. o primeiro take que conclui vira a imagem da cena; o segundo não toma o lugar', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneImageTool.execute(ctxA, { ordinal: 1, prompt: 'a' }, { iniciar, acompanhar });
  await generateSceneImageTool.execute(ctxA, { ordinal: 1, prompt: 'b' }, { iniciar, acompanhar });
  const [take1, take2] = listSceneTakes('proj_a', 1, 'image', db);

  assert.equal(getSceneSelection('proj_a', 1, 'image', db), null, 'nada foi escolhido ainda');

  concluir(db, 'proj_a', take1.generationJobId);
  assert.equal(getSceneSelection('proj_a', 1, 'image', db).takeNumber, 1);

  // O segundo conclui: a escolha NÃO muda sozinha. Regenerar oferece uma
  // alternativa; trocar por baixo seria perder a que o usuário já aprovou.
  concluir(db, 'proj_a', take2.generationJobId);
  assert.equal(getSceneSelection('proj_a', 1, 'image', db).takeNumber, 1);

  // E os dois takes continuam lá, cada um com a sua mídia.
  const takes = listSceneTakes('proj_a', 1, 'image', db);
  assert.equal(takes.length, 2);
  assert.ok(takes[0].assetId && takes[1].assetId);
  assert.notEqual(takes[0].assetId, takes[1].assetId);

  // A escolha de vídeo continua vazia: gerar imagem não escolhe vídeo.
  assert.equal(getSceneSelection('proj_a', 1, 'video', db), null);
});

test('M. um take cuja geração falhou nunca vira a imagem da cena', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneImageTool.execute(ctxA, { ordinal: 1, prompt: 'a' }, { iniciar, acompanhar });
  const take = listSceneTakes('proj_a', 1, 'image', db)[0];

  setGenerationJobState(take.generationJobId, JOB_STATES.FAILED, { db, error: 'estourou' });

  assert.equal(getSceneSelection('proj_a', 1, 'image', db), null);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_media_selections').get().n, 0,
  );

  // Só há escolha onde há Asset — e um trabalho falho não produz Asset. A
  // geração seguinte, essa sim, é escolhida ao concluir.
  await generateSceneImageTool.execute(ctxA, { ordinal: 1, prompt: 'b' }, { iniciar, acompanhar });
  const segundo = listSceneTakes('proj_a', 1, 'image', db)[1];
  concluir(db, 'proj_a', segundo.generationJobId);
  assert.equal(getSceneSelection('proj_a', 1, 'image', db).takeNumber, 2);
});

// ── N · a conclusão depois de um reinício ──────────────────────────────────

test('N. a reconciliação depois de um reinício também liga o Asset ao take', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneImageTool.execute(ctxA, { ordinal: 1, prompt: 'luz' }, { iniciar, acompanhar });
  const take = listSceneTakes('proj_a', 1, 'image', db)[0];
  const jobId = take.generationJobId;

  // O reinício: o acompanhamento em memória some, e ninguém mais está olhando
  // para este trabalho. É a situação real de um processo que caiu no meio.
  delete globalThis[Symbol.for('showrunner.agent.jobWatch')];

  // O que a reconciliação faz é exatamente isto: publica o Asset e fecha o
  // registro. Ela não sabe que existe uma cena — e não precisa saber.
  const asset = concluir(db, 'proj_a', jobId);

  const depois = listSceneTakes('proj_a', 1, 'image', db)[0];
  assert.equal(depois.assetId, asset.id);
  assert.equal(getSceneSelection('proj_a', 1, 'image', db).takeNumber, 1);
});

test('N-bis. um take que ficou sem Asset é reparado na passagem seguinte', () => {
  const { db } = cenario();

  createGenerationJobRecord({
    jobId: 'job_meio', projectId: 'proj_a', kind: 'image', workflowId: 'ideogram4_t2i',
  }, db);
  const scriptA = db.prepare('SELECT id FROM production_scripts WHERE projectId = ?').get('proj_a');
  const cena = db.prepare('SELECT id FROM production_scenes WHERE scriptId = ? AND ordinal = 1').get(scriptA.id);
  db.prepare(`
    INSERT INTO production_scene_media
      (id, sceneId, kind, takeNumber, generationJobId, assetId, createdAt, updatedAt)
    VALUES ('media_meio', ?, 'image', 1, 'job_meio', NULL, ?, ?)
  `).run(cena.id, Date.now(), Date.now());

  // O livro-razão já diz `done`, e o take ficou sem Asset — o processo caiu
  // entre uma coisa e outra, antes de esta etapa existir.
  const asset = assetPublicado(db, 'proj_a', 'job_meio');
  db.prepare('UPDATE generation_jobs SET state = ?, assetId = ?, finishedAt = ?, updatedAt = ? WHERE jobId = ?')
    .run(JOB_STATES.DONE, asset.id, Date.now(), Date.now(), 'job_meio');

  // A passagem seguinte da reconciliação é um replay: nada muda no job, e o
  // take é reparado assim mesmo.
  completeGenerationJob('job_meio', { assetId: asset.id, db });

  const take = db.prepare("SELECT * FROM production_scene_media WHERE id = 'media_meio'").get();
  assert.equal(take.assetId, asset.id);
  assert.equal(getSceneSelection('proj_a', 1, 'image', db).takeNumber, 1);
});

// ── O · nada novo no esquema ───────────────────────────────────────────────

test('O. nenhuma coluna e nenhum estado novo foram criados neste passo', () => {
  const { db } = cenario();

  assert.deepEqual(colunas(db, 'production_scene_media'), [
    'id', 'sceneId', 'kind', 'takeNumber', 'generationJobId', 'assetId',
    'createdAt', 'updatedAt',
  ]);
  assert.deepEqual(colunas(db, 'production_scene_media_selections'), [
    'sceneId', 'kind', 'mediaId', 'updatedAt',
  ]);
  assert.deepEqual(colunas(db, 'production_scenes'), [
    'id', 'scriptId', 'ordinal', 'title', 'purpose', 'durationSeconds',
    'narration', 'visualDescription', 'status', 'createdAt', 'updatedAt',
  ]);

  // O vocabulário de estados de geração continua sendo o mesmo, e continua
  // sendo o ÚNICO lugar onde o andamento de um take mora.
  assert.deepEqual([...JOB_STATE_VALUES].sort(), [
    'cancelled', 'done', 'failed', 'finalizing', 'orphaned', 'preparing',
    'queued', 'running', 'submitted',
  ]);

  // E o prompt não foi parar na cena: quem guarda o que foi pedido é o Asset.
  const fonte = readFileSync(
    new URL('../lib/server/domain/sceneMedia.js', import.meta.url), 'utf8',
  );
  assert.ok(!/INSERT INTO production_scene_media[^)]*prompt/i.test(fonte));
});

// ── P · Q · a fronteira da ferramenta ──────────────────────────────────────

test('P. a ferramenta não aceita identidade nossa, modelo nem provider', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);

  const proibidos = [
    'projectId', 'sceneId', 'mediaId', 'takeNumber', 'assetId', 'jobId',
    'workflowId', 'modelId', 'provider', 'path', 'kind', 'aspect', 'seed',
  ];

  for (const campo of proibidos) {
    await assert.rejects(
      () => generateSceneImageTool.execute(
        ctxA, { ordinal: 1, prompt: 'luz', [campo]: 'x' }, { iniciar },
      ),
      (erro) => erro.name === 'ToolExecutionError' && erro.message.includes(campo),
      `aceitou "${campo}"`,
    );
  }

  // O schema publicado também não os oferece.
  const publicado = publicToolList(toolRegistry())
    .find((t) => t.name === 'project.generate_scene_image');
  assert.deepEqual(Object.keys(publicado.inputSchema.properties).sort(), ['ordinal', 'prompt']);
  assert.deepEqual([...publicado.inputSchema.required].sort(), ['ordinal', 'prompt']);
  assert.ok(!publicado.execute && !publicado.handler);

  // E um prompt vazio não vira uma imagem qualquer.
  await assert.rejects(
    () => generateSceneImageTool.execute(ctxA, { ordinal: 1, prompt: '   ' }, { iniciar }),
    (erro) => erro.name === 'ToolExecutionError',
  );
});

test('Q. o resultado é pequeno e não vaza nada de dentro', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  const saida = await generateSceneImageTool.execute(
    ctxA, { ordinal: 2, prompt: 'close na brasa' }, { iniciar, acompanhar },
  );

  assert.deepEqual(Object.keys(saida).sort(), ['kind', 'ordinal', 'status', 'takeNumber']);
  assert.equal(saida.ordinal, 2);
  assert.equal(saida.kind, 'image');
  assert.equal(saida.takeNumber, 1);
  assert.ok(saida.status);

  // Nada de identidade nossa, caminho, workflow ou provider — nem por valor.
  const take = listSceneTakes('proj_a', 2, 'image', db)[0];
  const texto = JSON.stringify(saida);
  for (const interno of [take.id, take.sceneId, take.generationJobId]) {
    assert.ok(!texto.includes(interno), `vazou "${interno}"`);
  }
  for (const proibido of [/ideogram/i, /comfy/i, /workflow/i, /\/api\//, /jobId/i, /mediaId/i]) {
    assert.ok(!proibido.test(texto), `o resultado cita ${proibido}`);
  }
});

// ── R · S · o caminho até aqui ─────────────────────────────────────────────

test('R. o alias do Hermes aponta para a ferramenta canônica', () => {
  assert.ok(hermesAliases().includes('project_generate_scene_image'));
  assert.equal(
    toCanonicalToolName('project_generate_scene_image'),
    'project.generate_scene_image',
  );

  // E o plugin do runtime a declara, com os mesmos dois campos e mais nenhum.
  const plugin = readFileSync(
    new URL('../integrations/hermes/showrunner-plugin/__init__.py', import.meta.url), 'utf8',
  );
  assert.match(plugin, /"name": "project_generate_scene_image"/);
  assert.match(plugin, /\("project_generate_scene_image", GENERATE_SCENE_IMAGE_SCHEMA\)/);
  const bloco = plugin.slice(
    plugin.indexOf('GENERATE_SCENE_IMAGE_SCHEMA = {'),
    plugin.indexOf('# A allowlist do plugin'),
  );
  for (const proibido of ['sceneId', 'mediaId', 'takeNumber', 'assetId', 'workflowId', 'projectId']) {
    assert.ok(!bloco.includes(`"${proibido}"`), `o schema do plugin oferece ${proibido}`);
  }

  // E a persona sabe qual das duas usar.
  const persona = readFileSync(
    new URL('../integrations/hermes/persona/showrunner.md', import.meta.url), 'utf8',
  );
  assert.match(persona, /## Quando o usuário quer ver uma cena/);
});

test('S. a geração continua sendo levada pela Job Autonomy', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar, vistos } = acompanhamentoFalso();

  await generateSceneImageTool.execute(
    ctxA, { ordinal: 1, prompt: 'luz' }, { iniciar, acompanhar },
  );

  assert.equal(vistos.length, 1);
  const take = listSceneTakes('proj_a', 1, 'image', db)[0];
  assert.deepEqual(vistos[0], {
    jobId: take.generationJobId,
    kind: 'image',
    threadId: ctxA.threadId,
    projectId: 'proj_a',
  });

  // A ferramenta responde sem esperar: o take ainda não tem mídia quando ela
  // devolve, e é isso que impede o turno de ficar preso a uma GPU.
  assert.equal(take.assetId, null);
});

// ── T · nada de vídeo neste passo ──────────────────────────────────────────

test('T. nenhuma geração de vídeo acontece, e o passo não conhece I2V', async () => {
  const { db, ctxA } = cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneImageTool.execute(ctxA, { ordinal: 1, prompt: 'a' }, { iniciar, acompanhar });
  await generateSceneImageTool.execute(ctxA, { ordinal: 2, prompt: 'b' }, { iniciar, acompanhar });

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM production_scene_media WHERE kind = 'video'").get().n, 0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE kind = 'video'").get().n, 0,
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM production_scene_media_selections WHERE kind = 'video'").get().n, 0,
  );

  // E o arquivo da ferramenta não cita vídeo, animação nem linhagem: isso é do
  // 13-C, e uma menção agora seria uma promessa que o código não cumpre.
  const fonte = readFileSync(
    new URL('../lib/server/agent/tools/handlers/productionSceneMedia.js', import.meta.url),
    'utf8',
  ).replace(/^\s*\/\/.*$/gm, '');
  for (const proibido of [/video/i, /vídeo/i, /i2v/i, /sourceAssetId/, /derivedFrom/]) {
    assert.ok(!proibido.test(fonte), `a ferramenta cita ${proibido}`);
  }

  // A ferramenta de vídeo avulsa continua existindo, e não foi tocada por este
  // passo: ela não sabe o que é uma cena.
  const doVideo = publicToolList(toolRegistry()).find((t) => t.name === 'og.generate_video');
  assert.ok(doVideo);
  assert.ok(!('ordinal' in doVideo.inputSchema.properties));
});
