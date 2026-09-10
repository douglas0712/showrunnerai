// Os parâmetros de geração de uma Production Scene — formato e duração.
//
// PASSO 13-E. Duas decisões, e elas puxam para lados opostos:
//
//   aspectRatio  o plano MANDA na geração — e o modelo não opina
//   durationSeconds  a cena NÃO manda na duração do clipe — e ninguém converte
//
// ── Por que o formato vem do plano ──────────────────────────────────────────
//
// Porque um filme tem UM formato. Se `aspect` fosse argumento das ferramentas,
// o modelo escolheria por cena — e escolheria bem, cena a cena: um plano geral
// pede 16:9, um close pede 9:16. O resultado seria uma produção com metade das
// cenas em cada, cada pedaço plausível sozinho e o conjunto impossível de
// montar. O formato é decisão da produção, tomada uma vez, no plano.
//
// ── Por que a duração NÃO vem da cena ───────────────────────────────────────
//
// Porque as duas durações não são a mesma grandeza. `scene.durationSeconds` é
// quanto daquele trecho do filme a cena ocupa — planejamento narrativo. A
// duração de um clipe é quanto o gerador produz de uma vez — execução técnica.
//
// Uma cena de 60 segundos não é "um vídeo de 60 segundos": ela é uma sequência
// de planos. Passar 60 adiante produziria um clipe esticado onde deveria haver
// decupagem; encolher para 6 entregaria 6 segundos afirmando que a cena tem 60.
// Os dois erros são silenciosos, e é por isso que este arquivo trava a ausência
// da conversão em vez de escolher uma delas.
//
// Quem vai reconciliar as duas é o Shot, que NÃO existe neste passo — e há
// teste aqui para isso, porque "não implementamos" é uma afirmação verificável.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { generateSceneImageTool } from '../lib/server/agent/tools/handlers/productionSceneMedia.js';
import { generateSceneVideoTool } from '../lib/server/agent/tools/handlers/productionSceneVideo.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';
import { closeDatabase, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset, getAsset } from '../lib/server/domain/assets.js';
import {
  completeGenerationJob, createGenerationJobRecord, getGenerationJobRecord,
} from '../lib/server/domain/generationJobs.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import {
  getProductionPlan, replaceProductionScenes, saveProductionPlan, saveProductionScript,
} from '../lib/server/domain/production.js';
import { createSceneTake, listSceneTakes } from '../lib/server/domain/sceneMedia.js';
import { startImageGeneration, startVideoGeneration } from '../lib/server/generation/facade.js';
import { getWorkflow } from '../lib/server/generation/workflows/registry.js';
import { ASPECTS_SUPORTADOS } from '../lib/server/generation/workflows/resolutionSelector.js';
import { STATES } from '../lib/server/comfy/status.js';

const CHAVE = Symbol.for('showrunner.domain.db');
const PROJETO = 'proj_parametros';
const RAIZ = path.join(process.cwd(), 'runtime', 'projects', PROJETO);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM'
  + 'IQAAAABJRU5ErkJggg==',
  'base64',
);

/** A duração narrativa das cenas deste cenário. Grande de propósito. */
const DURACAO_DA_CENA = 60;

test.after(async () => {
  closeDatabase();
  delete globalThis[CHAVE];
  await rm(RAIZ, { recursive: true, force: true });
});

let contador = 0;

/**
 * Um projeto com plano no formato pedido e duas cenas longas.
 *
 * `comImagem` monta o estado do 13-B/13-C: uma imagem concluída e escolhida na
 * cena 1, para que o vídeo tenha o que animar.
 */
async function cenario({
  aspectRatio = '16:9', projectId = PROJETO, comImagem = false,
} = {}) {
  closeDatabase();
  const db = openDatabase(':memory:');
  globalThis[CHAVE] = db;

  createProject({ id: projectId, name: projectId }, db);
  saveProductionPlan({
    projectId, title: 'Plano', targetDurationSeconds: DURACAO_DA_CENA * 2, aspectRatio,
  }, db);
  saveProductionScript({ projectId, title: 'Roteiro', fullText: 'ABERTURA...' }, db);
  replaceProductionScenes(projectId, [
    { ordinal: 1, title: 'A', durationSeconds: DURACAO_DA_CENA, visualDescription: 'Amanhecer.' },
    { ordinal: 2, title: 'B', durationSeconds: DURACAO_DA_CENA, visualDescription: 'A brasa.' },
  ], db);

  const thread = createThreadRecord({ projectId, title: 'Conversa' }, db);
  const ctx = { threadId: thread.id, projectId, userMessageId: null, signal: null };

  const imagem = comImagem ? await imagemEscolhida(db, projectId, 1) : null;
  return { db, ctx, imagem };
}

async function imagemEscolhida(db, projectId, ordinal) {
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
  createSceneTake(projectId, ordinal, { kind: 'image', generationJobId: jobId }, db);
  completeGenerationJob(jobId, { assetId: asset.id, db });
  return asset;
}

/**
 * Uma geração falsa que guarda EXATAMENTE os parâmetros recebidos.
 *
 * É por ela que estes testes perguntam "o que chegou à camada de geração?" — a
 * pergunta inteira deste passo.
 */
function geracaoFalsa(db, kind) {
  const chamadas = [];
  const iniciar = async (params, opcoes) => {
    contador += 1;
    const jobId = `job_${kind}_${contador}`;
    chamadas.push({ ...params });
    createGenerationJobRecord({
      jobId,
      projectId: opcoes.projectId,
      kind,
      workflowId: kind === 'image' ? 'ideogram4_t2i' : 'minimax_h3_t2v',
      threadId: opcoes.threadId,
      derivedFromAssetId: params.sourceAssetId ?? null,
    }, db);
    await opcoes.aoRegistrar({ jobId, kind, projectId: opcoes.projectId });
    return { jobId, kind, status: 'preparando' };
  };
  return { iniciar, chamadas, acompanhar: () => {} };
}

// ── A · B · C · F · o formato vem do plano ─────────────────────────────────

test('A+B. a imagem da cena é gerada no formato do plano — 16:9 e 9:16', async () => {
  for (const aspecto of ['16:9', '9:16']) {
    const { db, ctx } = await cenario({ aspectRatio: aspecto });
    const { iniciar, chamadas, acompanhar } = geracaoFalsa(db, 'image');

    await generateSceneImageTool.execute(
      ctx, { ordinal: 1, prompt: 'o vale ao amanhecer' }, { iniciar, acompanhar },
    );

    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].aspect, aspecto, `o plano ${aspecto} não chegou à geração`);
  }
});

test('A-bis. todo formato que o plano aceita atravessa igual', async () => {
  for (const aspecto of ASPECTS_SUPORTADOS) {
    const { db, ctx } = await cenario({ aspectRatio: aspecto });
    const { iniciar, chamadas, acompanhar } = geracaoFalsa(db, 'image');
    await generateSceneImageTool.execute(ctx, { ordinal: 1, prompt: 'p' }, { iniciar, acompanhar });
    assert.equal(chamadas[0].aspect, aspecto);
  }
});

test('C+J+K. o vídeo da cena usa o MESMO formato, sem perder a imagem nem a linhagem', async () => {
  const { db, ctx, imagem } = await cenario({ aspectRatio: '9:16', comImagem: true });
  const { iniciar, chamadas, acompanhar } = geracaoFalsa(db, 'video');

  await generateSceneVideoTool.execute(
    ctx, { ordinal: 1, prompt: 'a câmera avança' }, { iniciar, acompanhar },
  );

  assert.equal(chamadas[0].aspect, '9:16');
  // J: a imagem escolhida continua sendo resolvida pelo servidor.
  assert.equal(chamadas[0].sourceAssetId, imagem.id);

  // K: e a linhagem continua onde estava, no registro da geração.
  const take = listSceneTakes(PROJETO, 1, 'video', db)[0];
  assert.equal(getGenerationJobRecord(take.generationJobId, db).derivedFromAssetId, imagem.id);
});

test('F. o formato vem do plano DESTE projeto, e não de outro', async () => {
  const { db, ctx } = await cenario({ aspectRatio: '9:16' });

  // Um segundo projeto, com outro formato, no MESMO banco.
  createProject({ id: 'proj_outro', name: 'Outro' }, db);
  saveProductionPlan({
    projectId: 'proj_outro', title: 'Outro plano', targetDurationSeconds: 60, aspectRatio: '21:9',
  }, db);
  saveProductionScript({ projectId: 'proj_outro', title: 'R', fullText: 'x' }, db);
  replaceProductionScenes('proj_outro', [
    { ordinal: 1, title: 'A', durationSeconds: 60 },
  ], db);
  const outro = createThreadRecord({ projectId: 'proj_outro', title: 'O' }, db);

  const { iniciar, chamadas, acompanhar } = geracaoFalsa(db, 'image');

  await generateSceneImageTool.execute(ctx, { ordinal: 1, prompt: 'p' }, { iniciar, acompanhar });
  assert.equal(chamadas[0].aspect, '9:16');

  // G: a cena 1 da outra conversa é a cena 1 DAQUELE projeto, com o formato
  // DAQUELE plano. Nada atravessa a fronteira.
  await generateSceneImageTool.execute(
    { threadId: outro.id, projectId: 'proj_outro', userMessageId: null, signal: null },
    { ordinal: 1, prompt: 'p' }, { iniciar, acompanhar },
  );
  assert.equal(chamadas[1].aspect, '21:9');
  assert.equal(listSceneTakes(PROJETO, 1, 'image', db).length, 1);
  assert.equal(listSceneTakes('proj_outro', 1, 'image', db).length, 1);
});

// ── D · E · N · o modelo não escolhe parâmetro nenhum ──────────────────────

test('D+E+N. nenhuma das duas ferramentas aceita formato, duração ou gerador', async () => {
  const { db, ctx } = await cenario({ comImagem: true });
  const daImagem = geracaoFalsa(db, 'image');
  const doVideo = geracaoFalsa(db, 'video');

  const proibidos = [
    { aspect: '1:1' }, { aspectRatio: '1:1' }, { duration: 18 },
    { durationSeconds: 18 }, { resolution: '1080p' }, { quality: '1080p' },
    { model: 'x' }, { modelId: 'x' }, { provider: 'comfy' }, { workflowId: 'x' },
    { fps: 30 }, { seed: 7 },
  ];

  for (const extra of proibidos) {
    const campo = Object.keys(extra)[0];
    await assert.rejects(
      () => generateSceneImageTool.execute(
        ctx, { ordinal: 1, prompt: 'p', ...extra }, daImagem,
      ),
      (erro) => erro.name === 'ToolExecutionError' && erro.message.includes(campo),
      `a imagem aceitou "${campo}"`,
    );
    await assert.rejects(
      () => generateSceneVideoTool.execute(
        ctx, { ordinal: 1, prompt: 'p', ...extra }, doVideo,
      ),
      (erro) => erro.name === 'ToolExecutionError' && erro.message.includes(campo),
      `o vídeo aceitou "${campo}"`,
    );
  }

  assert.equal(daImagem.chamadas.length, 0);
  assert.equal(doVideo.chamadas.length, 0);

  // E os schemas publicados continuam com dois campos, e só dois.
  const publicadas = publicToolList(toolRegistry());
  for (const nome of ['project.generate_scene_image', 'project.generate_scene_video']) {
    const tool = publicadas.find((t) => t.name === nome);
    assert.deepEqual(Object.keys(tool.inputSchema.properties).sort(), ['ordinal', 'prompt']);
  }
});

// ── H · sem plano, nada é gerado ───────────────────────────────────────────

test('H. sem plano de produção a geração é recusada — e NÃO cai para um padrão', async () => {
  const { db, ctx } = await cenario({ aspectRatio: '9:16', comImagem: true });
  const daImagem = geracaoFalsa(db, 'image');
  const doVideo = geracaoFalsa(db, 'video');

  // O plano some por baixo. Não há caminho de produto para isso hoje — as cenas
  // dependem dele —, e é justamente por isso que a recusa precisa existir: se um
  // dia houver, o silêncio seria um filme inteiro no formato errado.
  db.prepare('DELETE FROM production_plans WHERE projectId = ?').run(PROJETO);
  assert.equal(getProductionPlan(PROJETO, db), null);

  for (const [tool, deps] of [[generateSceneImageTool, daImagem], [generateSceneVideoTool, doVideo]]) {
    await assert.rejects(
      () => tool.execute(ctx, { ordinal: 1, prompt: 'p' }, deps),
      (erro) => erro.name === 'ToolExecutionError' && /não tem um plano/.test(erro.message),
    );
  }

  assert.equal(daImagem.chamadas.length, 0, 'gerou sem saber o formato');
  assert.equal(doVideo.chamadas.length, 0, 'gerou sem saber o formato');
});

// ── I · formato não suportado ──────────────────────────────────────────────

test('I. um formato que o gerador não faz é recusado, e NUNCA vira 16:9', async () => {
  const { db } = await cenario();

  // O plano aceita texto livre em `aspectRatio` — é campo de produção, não de
  // gerador. Um valor que o gerador atual não faz precisa parar ANTES de
  // qualquer registro: nada de livro-razão, nada de take, nada de arquivo.
  for (const inicio of [startImageGeneration, startVideoGeneration]) {
    await assert.rejects(
      () => inicio({ prompt: 'p', aspect: '5:4' }, { projectId: PROJETO, db }),
      (erro) => erro.name === 'GenerationError'
        && /formato 5:4 desta produção não é suportado/.test(erro.message),
    );
  }

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_media').get().n, 0);
});

test('I-bis. quem responde "eu faço este formato?" é o descriptor', () => {
  // A recusa não vem de uma tabela que a camada de geração conheça: vem da
  // capacidade DECLARADA do workflow. Trocar o gerador troca a resposta sem
  // tocar em quem pergunta.
  for (const id of ['ideogram4_t2i', 'minimax_h3_t2v']) {
    const descriptor = getWorkflow(id);
    assert.ok(Array.isArray(descriptor.aspects), `${id} não declara os formatos que aceita`);
    assert.deepEqual([...descriptor.aspects].sort(), [...ASPECTS_SUPORTADOS].sort());
    assert.ok(descriptor.aspects.includes('9:16'));
    assert.ok(!descriptor.aspects.includes('5:4'));
  }
});

// ── L · a duração da cena NÃO é a duração do clipe ─────────────────────────

test('L. scene.durationSeconds não atravessa como duração do vídeo', async () => {
  const { db, ctx, imagem } = await cenario({ comImagem: true });
  const { iniciar, chamadas, acompanhar } = geracaoFalsa(db, 'video');

  const cena = db.prepare(
    'SELECT durationSeconds FROM production_scenes WHERE ordinal = 1',
  ).get();
  assert.equal(cena.durationSeconds, DURACAO_DA_CENA);

  await generateSceneVideoTool.execute(
    ctx, { ordinal: 1, prompt: 'movimento' }, { iniciar, acompanhar },
  );

  // O que a ferramenta manda: prompt, origem e formato. Duração NENHUMA.
  assert.deepEqual(
    Object.keys(chamadas[0]).sort(), ['aspect', 'prompt', 'sourceAssetId'],
  );
  assert.equal(chamadas[0].sourceAssetId, imagem.id);
  assert.equal(chamadas[0].duration, undefined);
  assert.equal(chamadas[0].durationSeconds, undefined);

  // E nenhum valor DERIVADO de 60 aparece: nem ele, nem um teto, nem um
  // arredondamento, nem uma divisão em partes.
  for (const derivado of Object.values(chamadas[0])) {
    assert.notEqual(derivado, DURACAO_DA_CENA);
    assert.notEqual(derivado, DURACAO_DA_CENA / 2);
    assert.notEqual(derivado, Math.min(DURACAO_DA_CENA, 6));
  }
});

test('L-bis. a duração do clipe é a do pipeline, e não muda com a cena', async () => {
  // Duas produções com cenas de durações MUITO diferentes chegam à mesma
  // duração de clipe — porque a cena não participa dessa conta.
  const submissoes = [];
  const deps = {
    novoJobId: () => `job_clip_${(contador += 1)}`,
    submeter: async (completos) => {
      submissoes.push(completos);
      return { promptId: `p${submissoes.length}`, state: STATES.QUEUED };
    },
  };

  for (const duracaoDaCena of [6, 60]) {
    closeDatabase();
    const db = openDatabase(':memory:');
    globalThis[CHAVE] = db;
    createProject({ id: PROJETO, name: PROJETO }, db);
    saveProductionPlan({
      projectId: PROJETO, title: 'P', targetDurationSeconds: duracaoDaCena, aspectRatio: '16:9',
    }, db);
    saveProductionScript({ projectId: PROJETO, title: 'R', fullText: 'x' }, db);
    replaceProductionScenes(PROJETO, [
      { ordinal: 1, title: 'A', durationSeconds: duracaoDaCena },
    ], db);
    const thread = createThreadRecord({ projectId: PROJETO, title: 'C' }, db);
    const imagem = await imagemEscolhida(db, PROJETO, 1);

    await generateSceneVideoTool.execute(
      { threadId: thread.id, projectId: PROJETO, userMessageId: null, signal: null },
      { ordinal: 1, prompt: 'm' },
      {
        iniciar: (params, opcoes) => startVideoGeneration(params, { ...opcoes, deps }),
        acompanhar: () => {},
      },
    );
    assert.ok(imagem.id);
  }

  assert.equal(submissoes.length, 2);
  assert.equal(
    submissoes[0].durationSeconds, submissoes[1].durationSeconds,
    'a duração do clipe mudou com a duração narrativa da cena',
  );
  assert.notEqual(submissoes[1].durationSeconds, 60, 'a cena de 60s virou um clipe de 60s');
});

test('L-ter. nenhuma conversão de duração foi escrita', () => {
  // A prova por leitura, ao lado da prova por comportamento. Nenhuma das duas
  // ferramentas cita a duração da cena, e nenhuma delas divide, arredonda,
  // repete ou aproxima nada.
  for (const arquivo of ['productionSceneMedia.js', 'productionSceneVideo.js']) {
    const fonte = readFileSync(
      new URL(`../lib/server/agent/tools/handlers/${arquivo}`, import.meta.url), 'utf8',
    ).replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

    for (const proibido of [
      /durationSeconds/, /\bduration\b/, /Math\.min/, /Math\.max/, /Math\.round/,
      /Math\.ceil/, /Math\.floor/, /\/\s*6\b/, /\bshot\b/i, /\bclips?\b/i,
    ]) {
      assert.ok(!proibido.test(fonte), `${arquivo} faz conta de duração: ${proibido}`);
    }

    // `cena` é lida, mas só para o ordinal e o título — nunca para a duração.
    assert.ok(!/cena\.duration/i.test(fonte), `${arquivo} lê a duração da cena`);
  }
});

// ── M · N · O · o que este passo NÃO criou ─────────────────────────────────

test('M+N+O. nenhuma coluna nova, nenhuma tool nova, nenhum Shot', async () => {
  const { db } = await cenario();

  // M: a mídia de cena continua com as oito colunas da migração 10.
  assert.deepEqual(
    db.prepare('PRAGMA table_info(production_scene_media)').all().map((c) => c.name),
    ['id', 'sceneId', 'kind', 'takeNumber', 'generationJobId', 'assetId',
      'createdAt', 'updatedAt'],
  );
  // E a cena continua guardando a duração NARRATIVA, onde ela sempre esteve.
  assert.ok(
    db.prepare('PRAGMA table_info(production_scenes)').all()
      .some((c) => c.name === 'durationSeconds'),
  );

  // O: nenhuma tabela de Shot foi criada.
  const tabelas = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    .map((t) => t.name);
  for (const tabela of tabelas) {
    assert.ok(!/shot/i.test(tabela), `apareceu uma tabela de Shot: ${tabela}`);
    assert.ok(!/clip/i.test(tabela), `apareceu uma tabela de clipe: ${tabela}`);
  }

  // N: as ferramentas de cena continuam sendo as seis do 13-B/C/D.
  const deCena = publicToolList(toolRegistry())
    .map((t) => t.name).filter((n) => n.includes('scene')).sort();
  assert.deepEqual(deCena, [
    'project.generate_scene_image',
    'project.generate_scene_video',
    'project.get_scene',
    'project.get_scene_media',
    'project.list_scenes',
    'project.replace_scenes',
    'project.select_scene_take',
    'project.update_scene',
  ]);
});

test('M-bis. o resultado público das duas ferramentas não mudou', async () => {
  const { db, ctx, imagem } = await cenario({ aspectRatio: '9:16', comImagem: true });
  const daImagem = geracaoFalsa(db, 'image');
  const doVideo = geracaoFalsa(db, 'video');

  const saidaImagem = await generateSceneImageTool.execute(
    ctx, { ordinal: 2, prompt: 'p' }, daImagem,
  );
  const saidaVideo = await generateSceneVideoTool.execute(
    ctx, { ordinal: 1, prompt: 'm' }, doVideo,
  );

  for (const saida of [saidaImagem, saidaVideo]) {
    assert.deepEqual(Object.keys(saida).sort(), ['kind', 'ordinal', 'status', 'takeNumber']);
    const texto = JSON.stringify(saida);
    // O formato resolvido é decisão interna: ele não sai para o modelo.
    assert.ok(!texto.includes('9:16'), 'o formato vazou no resultado');
    for (const proibido of [/aspect/i, /workflow/i, /provider/i, /resolution/i,
      /ideogram/i, /minimax/i, /\/api\//]) {
      assert.ok(!proibido.test(texto), `o resultado cita ${proibido}`);
    }
  }

  assert.ok(getAsset(imagem.id, db));
});
