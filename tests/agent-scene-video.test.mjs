// O vídeo de uma cena — project.generate_scene_video.
//
// PASSO 13-C. O que estes testes trancam é uma frase: **o modelo não escolhe a
// imagem**. Ele diz qual cena, e o servidor resolve a origem a partir do estado
// gravado — a seleção de imagem daquela cena, e só ela.
//
// ── Por que isso é o gate deste passo ───────────────────────────────────────
//
// Porque o modo de falha aqui é silencioso. Um `sourceAssetId` vindo do modelo
// erra exatamente depois de uma regeneração que ele não viu; e uma queda para
// texto → vídeo devolve um vídeo bonito, que o usuário aceita, e que não é a
// cena que ele aprovou. As duas coisas produzem um filme errado sem produzir
// nenhum erro.
//
// As invariantes que importam:
//
//   sem sourceAssetId no schema   a decisão foi tirada do modelo, não pedida
//                                 de volta com jeitinho
//   origem = seleção da cena      nunca "a última", nunca outro take, nunca
//                                 outro Asset do projeto
//   sem imagem ⇒ RECUSA           e NUNCA um T2V em silêncio
//   Asset apagado ⇒ RECUSA        `ON DELETE SET NULL` deixa a seleção
//                                 apontando para um take vazio; não há fallback
//   linhagem em dois lugares      generation_jobs.derivedFromAssetId desde o
//                                 início, Asset.derivedFromAssetId ao concluir
//   take e escolha                mecânica do 13-B, reusada sem duplicar nada

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { generateSceneVideoTool } from '../lib/server/agent/tools/handlers/productionSceneVideo.js';
import { generateSceneImageTool } from '../lib/server/agent/tools/handlers/productionSceneMedia.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';
import { hermesAliases, toCanonicalToolName } from '../lib/server/agent/hermes/aliases.js';
import { closeDatabase, openDatabase } from '../lib/server/domain/db.js';
import { JOB_STATES } from '../lib/server/domain/generationJobStates.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset, getAsset, removeAssetRecord } from '../lib/server/domain/assets.js';
import {
  completeGenerationJob, createGenerationJobRecord, getGenerationJobRecord,
  setGenerationJobState,
} from '../lib/server/domain/generationJobs.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import {
  replaceProductionScenes, saveProductionPlan, saveProductionScript,
} from '../lib/server/domain/production.js';
import {
  getSceneSelection, listSceneTakes, selectSceneTake,
} from '../lib/server/domain/sceneMedia.js';
import {
  finalizeGenerationAsset, startVideoGeneration,
} from '../lib/server/generation/facade.js';
import { GENERATION_MODES } from '../lib/server/generation/workflows/minimaxH3.js';
import {
  loadWorkflowTemplate, modeFromGraph, patchWorkflow,
} from '../lib/server/comfy/workflow.js';
import { STATES } from '../lib/server/comfy/status.js';

const CHAVE = Symbol.for('showrunner.domain.db');
const PROJETO = 'proj_cena_video';
const RAIZ = path.join(process.cwd(), 'runtime', 'projects', PROJETO);

/** Um PNG mínimo de verdade — a ponte i2v LÊ os bytes do arquivo. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM'
  + 'IQAAAABJRU5ErkJggg==',
  'base64',
);

test.after(async () => {
  closeDatabase();
  delete globalThis[CHAVE];
  await rm(RAIZ, { recursive: true, force: true });
});

let contador = 0;

/**
 * Um projeto com produção gravada e duas cenas.
 *
 * `comImagem` monta o estado que o 13-B deixaria: um take de imagem concluído,
 * com Asset e arquivo em disco, e escolhido para a cena 1.
 */
async function cenario({ comImagem = true } = {}) {
  closeDatabase();
  const db = openDatabase(':memory:');
  globalThis[CHAVE] = db;

  for (const id of [PROJETO, 'proj_outro']) {
    createProject({ id, name: id }, db);
    saveProductionPlan({ projectId: id, title: 'Plano', targetDurationSeconds: 120 }, db);
    saveProductionScript({ projectId: id, title: 'Roteiro', fullText: 'ABERTURA...' }, db);
    replaceProductionScenes(id, [
      { ordinal: 1, title: 'O Olimpo', durationSeconds: 60, visualDescription: 'Amanhecer.' },
      { ordinal: 2, title: 'O roubo', durationSeconds: 60, visualDescription: 'A brasa.' },
    ], db);
  }

  const thread = createThreadRecord({ projectId: PROJETO, title: 'Conversa' }, db);
  const ctx = { threadId: thread.id, projectId: PROJETO, userMessageId: null, signal: null };

  let imagem = null;
  if (comImagem) imagem = await comImagemEscolhida(db, 1);

  return { db, ctx, imagem };
}

/** O estado que o 13-B deixa: take de imagem concluído e escolhido. */
async function comImagemEscolhida(db, ordinal, projectId = PROJETO) {
  contador += 1;
  const jobId = `job_img_${contador}`;
  const filename = `${jobId}.png`;

  await mkdir(path.join(process.cwd(), 'runtime', 'projects', projectId, 'images'), { recursive: true });
  await writeFile(path.join(process.cwd(), 'runtime', 'projects', projectId, 'images', filename), PNG);

  createGenerationJobRecord({
    jobId, projectId, kind: 'image', workflowId: 'ideogram4_t2i',
  }, db);
  const asset = createAsset({
    projectId, kind: 'image', jobId, filename, mimeType: 'image/png',
    url: `/api/media/image/${projectId}/${filename}`,
  }, db);
  // O caminho real: concluir liga o Asset ao take e faz a primeira escolha.
  const { createSceneTake } = await import('../lib/server/domain/sceneMedia.js');
  createSceneTake(projectId, ordinal, { kind: 'image', generationJobId: jobId }, db);
  completeGenerationJob(jobId, { assetId: asset.id, db });

  return asset;
}

/**
 * Uma geração de vídeo falsa: registra o trabalho, chama o gancho, devolve o
 * que a facade devolveria. Guarda o que recebeu, para que os testes possam
 * perguntar QUAL imagem foi pedida.
 */
function geracaoFalsa(db, { aposOGancho = null } = {}) {
  const chamadas = [];
  const iniciar = async (params, opcoes) => {
    contador += 1;
    const jobId = `job_vid_${contador}`;
    chamadas.push({ ...params, projectId: opcoes.projectId });

    createGenerationJobRecord({
      jobId,
      projectId: opcoes.projectId,
      kind: 'video',
      workflowId: 'minimax_h3_t2v',
      threadId: opcoes.threadId,
      derivedFromAssetId: params.sourceAssetId ?? null,
    }, db);

    await opcoes.aoRegistrar({ jobId, kind: 'video', workflowId: 'minimax_h3_t2v', projectId: opcoes.projectId });
    if (aposOGancho) aposOGancho(jobId);

    return { jobId, kind: 'video', status: 'preparando' };
  };
  return { iniciar, chamadas };
}

function acompanhamentoFalso() {
  const vistos = [];
  return { acompanhar: (e) => vistos.push(e), vistos };
}

/** Conclui a geração pelo caminho durável — o mesmo da reconciliação. */
function concluir(db, projectId, jobId, kind, derivedFromAssetId = null) {
  const asset = createAsset({
    projectId, kind, jobId, filename: `${jobId}.mp4`,
    url: `/api/media/${kind}/${projectId}/${jobId}.mp4`,
    derivedFromAssetId,
  }, db);
  completeGenerationJob(jobId, { assetId: asset.id, db });
  return asset;
}

// ── A · B · C · D · E · F · a origem, resolvida pelo servidor ──────────────

test('A. uma cena que não existe é recusada, e nenhuma geração começa', async () => {
  const { db, ctx } = await cenario();
  const { iniciar, chamadas } = geracaoFalsa(db);

  for (const ordinal of [9, 0, -1, 'duas', null]) {
    await assert.rejects(
      () => generateSceneVideoTool.execute(ctx, { ordinal, prompt: 'a câmera avança' }, { iniciar }),
      (erro) => erro.name === 'ToolExecutionError',
    );
  }

  assert.equal(chamadas.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE kind = 'video'").get().n, 0);
});

test('B. uma cena sem imagem escolhida é recusada — e NUNCA vira texto → vídeo', async () => {
  const { db, ctx } = await cenario();
  const { iniciar, chamadas } = geracaoFalsa(db);

  // A cena 2 não tem imagem nenhuma.
  await assert.rejects(
    () => generateSceneVideoTool.execute(ctx, { ordinal: 2, prompt: 'movimento' }, { iniciar }),
    (erro) => erro.name === 'ToolExecutionError'
      && /não tem uma imagem pronta para animar/.test(erro.message)
      && /Gere a imagem da cena antes/.test(erro.message),
  );

  assert.equal(chamadas.length, 0, 'não pode ter começado geração nenhuma');
  assert.equal(listSceneTakes(PROJETO, 2, null, db).length, 0, 'não pode ter criado take');
});

test('C. uma seleção cujo take ainda não concluiu é recusada', async () => {
  const { db, ctx } = await cenario({ comImagem: false });
  const { iniciar, chamadas } = geracaoFalsa(db);
  const { createSceneTake } = await import('../lib/server/domain/sceneMedia.js');

  // Um take de imagem existe e está escolhido, mas a geração não concluiu:
  // não há Asset para animar.
  createGenerationJobRecord({
    jobId: 'job_em_voo', projectId: PROJETO, kind: 'image', workflowId: 'ideogram4_t2i',
  }, db);
  createSceneTake(PROJETO, 1, { kind: 'image', generationJobId: 'job_em_voo' }, db);
  selectSceneTake(PROJETO, 1, { kind: 'image', takeNumber: 1 }, db);

  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).assetId, null);

  await assert.rejects(
    () => generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'movimento' }, { iniciar }),
    (erro) => erro.name === 'ToolExecutionError' && /imagem pronta para animar/.test(erro.message),
  );
  assert.equal(chamadas.length, 0);
});

test('D. o Asset escolhido apagado é recusado — sem cair para outro take', async () => {
  const { db, ctx, imagem } = await cenario();
  const { iniciar, chamadas } = geracaoFalsa(db);
  const { attachSceneTakeAsset, createSceneTake } = await import('../lib/server/domain/sceneMedia.js');

  // ── por que a origem deste teste NÃO é uma imagem gerada ────────────────
  //
  // Porque o livro-razão não deixa: `generation_jobs.assetId` é NO ACTION, e
  // apagar sozinho o Asset de um trabalho concluído é RECUSADO — a afirmação
  // "este trabalho produziu aquilo" não pode virar mentira. É proteção real, e
  // vale a pena provar aqui.
  assert.throws(() => removeAssetRecord(imagem.id, db), /FOREIGN KEY/);

  // O buraco que sobra é o do Asset SEM trabalho concluído — o que o backfill
  // registra ao varrer o disco. Esse é apagável, e é por ele que uma seleção
  // pode acabar apontando para um take vazio (`ON DELETE SET NULL`, migração
  // 10). É a situação que a ferramenta precisa recusar.
  const doDisco = createAsset({
    projectId: PROJETO, kind: 'image', filename: 'do_disco.png', mimeType: 'image/png',
  }, db);
  const take = createSceneTake(PROJETO, 1, { kind: 'image' }, db);
  attachSceneTakeAsset(PROJETO, 1, {
    kind: 'image', takeNumber: take.takeNumber, assetId: doDisco.id,
  }, db);
  selectSceneTake(PROJETO, 1, { kind: 'image', takeNumber: take.takeNumber }, db);

  // O atalho é tentador justamente aqui: o take 1 tem uma imagem perfeitamente
  // boa ali do lado, e ninguém notaria a troca.
  assert.equal(listSceneTakes(PROJETO, 1, 'image', db).length, 2);
  assert.equal(listSceneTakes(PROJETO, 1, 'image', db)[0].assetId, imagem.id);

  removeAssetRecord(doDisco.id, db);
  const escolhida = getSceneSelection(PROJETO, 1, 'image', db);
  assert.equal(escolhida.takeNumber, take.takeNumber, 'a seleção precisa sobreviver');
  assert.equal(escolhida.assetId, null, 'e ficar apontando para um take vazio');

  await assert.rejects(
    () => generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'movimento' }, { iniciar }),
    (erro) => erro.name === 'ToolExecutionError' && /imagem pronta para animar/.test(erro.message),
  );

  assert.equal(chamadas.length, 0, 'usou outro take como origem');
  assert.equal(listSceneTakes(PROJETO, 1, 'video', db).length, 0);
});

test('E+F. a origem precisa ser imagem, e deste projeto', async () => {
  const { db, ctx } = await cenario({ comImagem: false });
  const { iniciar, chamadas } = geracaoFalsa(db);
  const { createSceneTake } = await import('../lib/server/domain/sceneMedia.js');

  // Um take de imagem cuja coluna aponta, por SQL solto, para um Asset de
  // vídeo — a linha que o domínio recusaria e que o banco não proíbe sozinho.
  createGenerationJobRecord({
    jobId: 'job_i', projectId: PROJETO, kind: 'image', workflowId: 'ideogram4_t2i',
  }, db);
  const take = createSceneTake(PROJETO, 1, { kind: 'image', generationJobId: 'job_i' }, db);
  const video = createAsset({
    projectId: PROJETO, kind: 'video', filename: 'v.mp4',
  }, db);
  db.prepare('UPDATE production_scene_media SET assetId = ? WHERE id = ?').run(video.id, take.id);
  selectSceneTake(PROJETO, 1, { kind: 'image', takeNumber: 1 }, db);

  await assert.rejects(
    () => generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'm' }, { iniciar }),
    (erro) => erro.name === 'ToolExecutionError' && /imagem pronta para animar/.test(erro.message),
  );

  // E o mesmo para um Asset de outro projeto.
  const forasteiro = createAsset({
    projectId: 'proj_outro', kind: 'image', filename: 'x.png',
  }, db);
  db.prepare('UPDATE production_scene_media SET assetId = ? WHERE id = ?').run(forasteiro.id, take.id);

  await assert.rejects(
    () => generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'm' }, { iniciar }),
    (erro) => erro.name === 'ToolExecutionError' && /imagem pronta para animar/.test(erro.message),
  );

  assert.equal(chamadas.length, 0);
});

// ── G · H · I · J · K · os takes ───────────────────────────────────────────

test('G+H. o primeiro vídeo é o take 1; o segundo é o 2, e o primeiro fica', async () => {
  const { db, ctx } = await cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  const um = await generateSceneVideoTool.execute(
    ctx, { ordinal: 1, prompt: 'a câmera avança devagar' }, { iniciar, acompanhar },
  );
  const dois = await generateSceneVideoTool.execute(
    ctx, { ordinal: 1, prompt: 'a câmera recua' }, { iniciar, acompanhar },
  );

  assert.equal(um.takeNumber, 1);
  assert.equal(dois.takeNumber, 2);
  assert.deepEqual(
    listSceneTakes(PROJETO, 1, 'video', db).map((t) => t.takeNumber), [1, 2],
  );

  // E o take de imagem continua sendo o 1: as numerações são independentes.
  assert.deepEqual(listSceneTakes(PROJETO, 1, 'image', db).map((t) => t.takeNumber), [1]);
});

test('I+J. o modelo não escolhe nem o número do take nem a imagem de origem', async () => {
  const { db, ctx, imagem } = await cenario();
  const { iniciar, chamadas } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  // A tentativa mais provável, e a mais perigosa: indicar outra imagem.
  const outra = await comImagemEscolhida(db, 2);
  for (const extra of [{ takeNumber: 5 }, { sourceAssetId: outra.id }, { assetId: outra.id }]) {
    await assert.rejects(
      () => generateSceneVideoTool.execute(
        ctx, { ordinal: 1, prompt: 'm', ...extra }, { iniciar },
      ),
      (erro) => erro.name === 'ToolExecutionError'
        && erro.message.includes(Object.keys(extra)[0]),
      `aceitou ${Object.keys(extra)[0]}`,
    );
  }

  // E, sem tentativa nenhuma, a origem é a escolhida DA CENA 1 — não a da 2,
  // que é mais recente.
  await generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'm' }, { iniciar, acompanhar });
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].sourceAssetId, imagem.id);
  assert.notEqual(chamadas[0].sourceAssetId, outra.id);
});

test('K. o take de vídeo nasce ligado ao job, antes de qualquer submissão', async () => {
  const { db, ctx } = await cenario();
  const { acompanhar } = acompanhamentoFalso();

  // O gancho roda, e a submissão falha logo depois — a janela que a ordem do
  // 13-B existe para tratar, reusada aqui sem segundo mecanismo.
  const { iniciar } = geracaoFalsa(db, {
    aposOGancho: (jobId) => {
      setGenerationJobState(jobId, JOB_STATES.FAILED, { db, error: 'o executor recusou' });
      throw Object.assign(new Error('recusado'), { name: 'GenerationError' });
    },
  });

  await assert.rejects(
    () => generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'm' }, { iniciar, acompanhar }),
    (erro) => erro.name === 'ToolExecutionError',
  );

  const take = listSceneTakes(PROJETO, 1, 'video', db)[0];
  assert.ok(take, 'o take precisa existir');
  assert.ok(take.generationJobId, 'take vazio: sem job e sem Asset');
  assert.equal(take.assetId, null);
  assert.equal(
    getGenerationJobRecord(take.generationJobId, db).state, JOB_STATES.FAILED,
  );

  // Nenhum take sem rastro, de tipo nenhum.
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_media WHERE generationJobId IS NULL AND assetId IS NULL').get().n,
    0,
  );
});

// ── L · M · N · R · a conclusão e a primeira escolha ───────────────────────

test('L+M+N. concluir liga o Asset ao take; o primeiro vira a escolha, o segundo não', async () => {
  const { db, ctx, imagem } = await cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'a' }, { iniciar, acompanhar });
  await generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'b' }, { iniciar, acompanhar });
  const [um, dois] = listSceneTakes(PROJETO, 1, 'video', db);

  assert.equal(getSceneSelection(PROJETO, 1, 'video', db), null);

  const primeiro = concluir(db, PROJETO, um.generationJobId, 'video', imagem.id);
  assert.equal(listSceneTakes(PROJETO, 1, 'video', db)[0].assetId, primeiro.id);
  assert.equal(getSceneSelection(PROJETO, 1, 'video', db).takeNumber, 1);

  concluir(db, PROJETO, dois.generationJobId, 'video', imagem.id);
  assert.equal(getSceneSelection(PROJETO, 1, 'video', db).takeNumber, 1, 'a escolha mudou sozinha');

  // A escolha de imagem não foi tocada por nada disso.
  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).assetId, imagem.id);
});

test('R. um vídeo cuja geração falhou nunca vira a escolha da cena', async () => {
  const { db, ctx } = await cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'a' }, { iniciar, acompanhar });
  const take = listSceneTakes(PROJETO, 1, 'video', db)[0];
  setGenerationJobState(take.generationJobId, JOB_STATES.FAILED, { db, error: 'estourou' });

  assert.equal(getSceneSelection(PROJETO, 1, 'video', db), null);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM production_scene_media_selections WHERE kind = 'video'").get().n,
    0,
  );
});

// ── O · P · Q · a linhagem ─────────────────────────────────────────────────

test('P. o registro da geração guarda a linhagem desde o início', async () => {
  const { db, ctx, imagem } = await cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'm' }, { iniciar, acompanhar });
  const take = listSceneTakes(PROJETO, 1, 'video', db)[0];

  // Antes de concluir, antes de existir Asset de vídeo: a linhagem já está lá.
  const registro = getGenerationJobRecord(take.generationJobId, db);
  assert.equal(registro.derivedFromAssetId, imagem.id);
  assert.equal(registro.assetId, null);
  assert.equal(registro.kind, 'video');
});

test('O. o Asset de vídeo nasce com derivedFromAssetId = a imagem escolhida', async () => {
  const { db, ctx, imagem } = await cenario();
  const { acompanhar } = acompanhamentoFalso();

  // O caminho REAL da facade, com o executor trocado por uma função. É ele que
  // lê o Asset de origem do disco e monta `frames.first`.
  const submissoes = [];
  const iniciar = (params, opcoes) => startVideoGeneration(params, {
    ...opcoes,
    deps: {
      novoJobId: () => 'job_i2v_real',
      submeter: async (completos) => {
        submissoes.push(completos);
        return { promptId: 'p1', state: STATES.QUEUED };
      },
    },
  });

  await generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'a câmera avança' }, { iniciar, acompanhar });

  // A ponte i2v foi montada: os BYTES da imagem escolhida vão como primeiro
  // quadro. É isto que vira LoadImage → first_frame no grafo.
  assert.equal(submissoes.length, 1);
  assert.ok(submissoes[0].frames?.first, 'nenhum primeiro quadro foi submetido — isto é T2V');
  assert.ok(Buffer.isBuffer(submissoes[0].frames.first.bytes));
  assert.equal(submissoes[0].frames.first.declaredName, imagem.filename);
  assert.equal(submissoes[0].workflowId, 'minimax_h3_t2v');

  // E a conclusão pelo caminho real: `finalizeGenerationAsset`, que é quem cria
  // o Asset quando o trabalho termina.
  const { createJob } = await import('../lib/server/comfy/jobs.js');
  const filename = 'job_i2v_real.mp4';
  await mkdir(path.join(RAIZ, 'videos'), { recursive: true });
  await writeFile(path.join(RAIZ, 'videos', filename), Buffer.from('mp4'));
  createJob({
    jobId: 'job_i2v_real', projectId: PROJETO, kind: 'video', state: STATES.DONE,
    promptId: 'p1', result: { url: `/api/media/video/${PROJETO}/${filename}`, filename, bytes: 3 },
  });

  const registro = getGenerationJobRecord('job_i2v_real', db);
  const video = await finalizeGenerationAsset('job_i2v_real', {
    projectId: PROJETO,
    db,
    mediaUrl: `/api/media/video/${PROJETO}/${filename}`,
    // O mesmo argumento que `concluirComAsset` passa: a linhagem do registro.
    derivedFromAssetId: registro.derivedFromAssetId,
  });
  completeGenerationJob('job_i2v_real', { assetId: video.id, db });

  assert.equal(video.kind, 'video');
  assert.equal(video.derivedFromAssetId, imagem.id, 'o Asset de vídeo perdeu a linhagem');
  assert.equal(getAsset(video.id, db).derivedFromAssetId, imagem.id);
  // A imagem de origem continua sem linhagem: ela não derivou de nada.
  assert.equal(getAsset(imagem.id, db).derivedFromAssetId, null);

  // E o take recebeu o Asset, com a escolha de vídeo feita.
  const take = listSceneTakes(PROJETO, 1, 'video', db)[0];
  assert.equal(take.assetId, video.id);
  assert.equal(getSceneSelection(PROJETO, 1, 'video', db).takeNumber, 1);
});

test('O-bis. o grafo submetido é I2V — LoadImage ligado a first_frame', async () => {
  // A prova do MECANISMO, sem ComfyUI: o MESMO workflow, com e sem primeiro
  // quadro. Não existe `minimax_h3_i2v` — o modo é decidido pela presença da
  // imagem, e `modeFromGraph` lê isso de volta do grafo submetido.
  const template = await loadWorkflowTemplate();

  const semImagem = patchWorkflow(template, {
    jobId: 'job_t2v', prompt: 'sem origem', aspect: '16:9', quality: '480p',
    durationSeconds: 6, seed: 1,
  });
  assert.equal(modeFromGraph(semImagem.graph), GENERATION_MODES.T2V);
  assert.equal(
    Object.values(semImagem.graph).filter((n) => n.class_type === 'LoadImage').length, 0,
  );

  const comImagem = patchWorkflow(template, {
    jobId: 'job_i2v', prompt: 'com origem', aspect: '16:9', quality: '480p',
    durationSeconds: 6, seed: 1,
    frames: { first: { name: 'origem.png', subfolder: '' } },
  });
  const carregadores = Object.entries(comImagem.graph)
    .filter(([, n]) => n.class_type === 'LoadImage');

  assert.equal(modeFromGraph(comImagem.graph), GENERATION_MODES.I2V);
  assert.ok(carregadores.length >= 1, 'nenhum LoadImage no grafo — isto seria T2V');

  // E o LoadImage está LIGADO ao nó do modelo, não solto no grafo.
  const noDoModelo = Object.values(comImagem.graph)
    .find((n) => n.class_type === 'MiniMaxH3ImageToVideo');
  assert.ok(noDoModelo, 'o nó do modelo sumiu do grafo');
  const [idDoCarregador] = carregadores[0];
  assert.deepEqual(noDoModelo.inputs.first_frame, [idDoCarregador, 0]);
});

test('Q. a reconciliação depois de um reinício também liga o vídeo ao take', async () => {
  const { db, ctx, imagem } = await cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  await generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'm' }, { iniciar, acompanhar });
  const jobId = listSceneTakes(PROJETO, 1, 'video', db)[0].generationJobId;

  // O reinício: o acompanhamento em memória some.
  delete globalThis[Symbol.for('showrunner.agent.jobWatch')];

  // A reconciliação publica o Asset e fecha o registro. Ela não sabe que existe
  // uma cena — e não precisa saber: o vínculo mora na conclusão.
  const video = concluir(db, PROJETO, jobId, 'video', imagem.id);

  const take = listSceneTakes(PROJETO, 1, 'video', db)[0];
  assert.equal(take.assetId, video.id);
  assert.equal(getSceneSelection(PROJETO, 1, 'video', db).takeNumber, 1);
  assert.equal(getAsset(video.id, db).derivedFromAssetId, imagem.id);
});

// ── S · T · U · V · a fronteira ────────────────────────────────────────────

test('S. o resultado é pequeno e não vaza nada de dentro', async () => {
  const { db, ctx, imagem } = await cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  const saida = await generateSceneVideoTool.execute(
    ctx, { ordinal: 1, prompt: 'a câmera avança' }, { iniciar, acompanhar },
  );

  assert.deepEqual(Object.keys(saida).sort(), ['kind', 'ordinal', 'status', 'takeNumber']);
  assert.equal(saida.ordinal, 1);
  assert.equal(saida.kind, 'video');
  assert.equal(saida.takeNumber, 1);

  const take = listSceneTakes(PROJETO, 1, 'video', db)[0];
  const texto = JSON.stringify(saida);
  for (const interno of [take.id, take.sceneId, take.generationJobId, imagem.id, imagem.filename]) {
    assert.ok(!texto.includes(interno), `vazou "${interno}"`);
  }
  for (const proibido of [/minimax/i, /comfy/i, /workflow/i, /derivedFrom/i, /sourceAsset/i,
    /\/api\//, /hermes/i, /LoadImage/, /first_frame/]) {
    assert.ok(!proibido.test(texto), `o resultado cita ${proibido}`);
  }

  // O schema publicado também não oferece a origem.
  const publicado = publicToolList(toolRegistry())
    .find((t) => t.name === 'project.generate_scene_video');
  assert.deepEqual(Object.keys(publicado.inputSchema.properties).sort(), ['ordinal', 'prompt']);
  assert.ok(!publicado.execute && !publicado.handler);
});

test('T. o alias do Hermes aponta para a ferramenta canônica', () => {
  assert.ok(hermesAliases().includes('project_generate_scene_video'));
  assert.equal(
    toCanonicalToolName('project_generate_scene_video'),
    'project.generate_scene_video',
  );

  const plugin = readFileSync(
    new URL('../integrations/hermes/showrunner-plugin/__init__.py', import.meta.url), 'utf8',
  );
  assert.match(plugin, /"name": "project_generate_scene_video"/);
  assert.match(plugin, /\("project_generate_scene_video", GENERATE_SCENE_VIDEO_SCHEMA\)/);

  // O schema do plugin NÃO oferece a origem — é o ponto do passo.
  // Só o bloco DESTE schema — ver a mesma conferência em agent-scene-image.
  const inicio = plugin.indexOf('GENERATE_SCENE_VIDEO_SCHEMA = {');
  const seguinte = plugin.indexOf('_SCHEMA = {', inicio + 1);
  const bloco = plugin.slice(
    inicio, seguinte === -1 ? plugin.indexOf('# A allowlist do plugin') : seguinte,
  );
  for (const proibido of ['sourceAssetId', 'sceneId', 'mediaId', 'takeNumber', 'assetId',
    'workflowId', 'projectId']) {
    assert.ok(!bloco.includes(`"${proibido}"`), `o schema do plugin oferece ${proibido}`);
  }

  const manifesto = readFileSync(
    new URL('../integrations/hermes/showrunner-plugin/plugin.yaml', import.meta.url), 'utf8',
  );
  assert.match(manifesto, /- project_generate_scene_video/);

  const persona = readFileSync(
    new URL('../integrations/hermes/persona/showrunner.md', import.meta.url), 'utf8',
  );
  assert.match(persona, /## Quando o usuário quer a cena em movimento/);
});

test('U. animar uma cena não gera imagem nenhuma', async () => {
  const { db, ctx } = await cenario();
  const { iniciar } = geracaoFalsa(db);
  const { acompanhar } = acompanhamentoFalso();

  const imagensAntes = db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE kind = 'image'").get().n;
  const takesAntes = listSceneTakes(PROJETO, 1, 'image', db).length;

  await generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'm' }, { iniciar, acompanhar });
  await generateSceneVideoTool.execute(ctx, { ordinal: 1, prompt: 'm2' }, { iniciar, acompanhar });

  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE kind = 'image'").get().n,
    imagensAntes,
    'uma geração de imagem foi iniciada',
  );
  assert.equal(listSceneTakes(PROJETO, 1, 'image', db).length, takesAntes);

  // E a ferramenta de imagem continua sendo outra coisa: ela não sabe animar.
  assert.notEqual(generateSceneImageTool.name, generateSceneVideoTool.name);
});

test('V. não há caminho nenhum de "sem imagem" para texto → vídeo', async () => {
  // A prova por leitura, ao lado da prova por comportamento (teste B): a
  // ferramenta não tem um segundo ramo. `sourceAssetId` é atribuído em UM
  // lugar, e ele vem da seleção — não dos argumentos, e sem alternativa.
  const fonte = readFileSync(
    new URL('../lib/server/agent/tools/handlers/productionSceneVideo.js', import.meta.url),
    'utf8',
  ).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

  const atribuicoes = [...fonte.matchAll(/sourceAssetId\s*:/g)];
  assert.equal(atribuicoes.length, 1, 'sourceAssetId é decidido em mais de um lugar');
  assert.match(fonte, /sourceAssetId: origem\.id/);

  // A origem sai da seleção da cena, e de mais nada.
  assert.match(fonte, /getSceneSelection\(projectId, ordinal, 'image', db\)/);
  for (const proibido of [/listSceneTakes/, /listAssets/, /findAssetByFile/, /\.at\(-1\)/,
    /ultima/i, /última/i, /fallback/i]) {
    assert.ok(!proibido.test(fonte), `a ferramenta usa ${proibido} para achar imagem`);
  }

  // E ela nunca chama a geração sem origem: não existe caminho que omita o campo.
  assert.equal([...fonte.matchAll(/iniciar\(/g)].length, 1);
});
