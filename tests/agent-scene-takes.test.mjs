// Conversar sobre as tentativas de uma cena — get_scene_media · select_scene_take.
//
// PASSO 13-D. O que estes testes trancam: **"use a segunda" é uma operação, e
// "qual imagem está selecionada?" é uma consulta ao banco**.
//
// ── Por que as duas coisas precisam existir juntas ──────────────────────────
//
// Sem a consulta, o agente responderia pela memória — e a memória dele é pior
// do que nenhuma: uma geração que falhou fica lá como imagem pronta, porque ele
// viu a ferramenta responder "aceito", e não viu o resto.
//
// Sem a escolha, "use a segunda" não teria efeito: o usuário diria, o agente
// concordaria, e o vídeo seguinte animaria a primeira. É o pior desfecho
// possível — ninguém percebe até o filme estar montado.
//
// As invariantes que importam:
//
//   estado vem do banco        derivado do livro-razão e do Asset, nunca
//                              guardado e nunca lembrado
//   escolher é mover ponteiro  não apaga take, não move Asset, não gera nada
//   só take PRONTO             gerando ou falho não pode virar a cena
//   image e video separados    trocar um não mexe no outro
//   endereço por posição       cena + tipo + número; nenhum id atravessa
//   a troca REGE o vídeo       animar depois usa a NOVA imagem escolhida

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  getSceneMediaTool, selectSceneTakeTool,
} from '../lib/server/agent/tools/handlers/productionSceneTakes.js';
import { generateSceneImageTool } from '../lib/server/agent/tools/handlers/productionSceneMedia.js';
import { generateSceneVideoTool } from '../lib/server/agent/tools/handlers/productionSceneVideo.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';
import { hermesAliases, toCanonicalToolName } from '../lib/server/agent/hermes/aliases.js';
import { closeDatabase, openDatabase } from '../lib/server/domain/db.js';
import { JOB_STATES } from '../lib/server/domain/generationJobStates.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset, getAsset } from '../lib/server/domain/assets.js';
import {
  completeGenerationJob, createGenerationJobRecord, getGenerationJobRecord,
  setGenerationJobState,
} from '../lib/server/domain/generationJobs.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import {
  replaceProductionScenes, saveProductionPlan, saveProductionScript,
} from '../lib/server/domain/production.js';
import {
  createSceneTake, getSceneSelection, listSceneTakes, MAX_TAKES_POR_CENA,
} from '../lib/server/domain/sceneMedia.js';

const CHAVE = Symbol.for('showrunner.domain.db');
const PROJETO = 'proj_takes';
const RAIZ = path.join(process.cwd(), 'runtime', 'projects', PROJETO);

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

async function cenario() {
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
  const alheio = createThreadRecord({ projectId: 'proj_outro', title: 'Outra' }, db);
  const ctxOutro = {
    threadId: alheio.id, projectId: 'proj_outro', userMessageId: null, signal: null,
  };

  return { db, ctx, ctxOutro };
}

/** Um take concluído, com Asset e arquivo — o que o 13-B/13-C deixa. */
async function takeConcluido(db, ordinal, kind, projectId = PROJETO) {
  contador += 1;
  const jobId = `job_${kind}_${contador}`;
  const ext = kind === 'image' ? 'png' : 'mp4';
  const pasta = kind === 'image' ? 'images' : 'videos';

  await mkdir(path.join(process.cwd(), 'runtime', 'projects', projectId, pasta), { recursive: true });
  await writeFile(
    path.join(process.cwd(), 'runtime', 'projects', projectId, pasta, `${jobId}.${ext}`),
    kind === 'image' ? PNG : Buffer.from('mp4'),
  );

  createGenerationJobRecord({
    jobId, projectId, kind, workflowId: kind === 'image' ? 'ideogram4_t2i' : 'minimax_h3_t2v',
  }, db);
  const asset = createAsset({
    projectId, kind, jobId, filename: `${jobId}.${ext}`,
    mimeType: kind === 'image' ? 'image/png' : 'video/mp4',
    url: `/api/media/${kind}/${projectId}/${jobId}.${ext}`,
  }, db);
  createSceneTake(projectId, ordinal, { kind, generationJobId: jobId }, db);
  completeGenerationJob(jobId, { assetId: asset.id, db });
  return asset;
}

/** Um take que ainda está gerando. */
function takeEmVoo(db, ordinal, kind, estado = JOB_STATES.RUNNING, projectId = PROJETO) {
  contador += 1;
  const jobId = `job_voo_${contador}`;
  createGenerationJobRecord({
    jobId, projectId, kind, workflowId: 'ideogram4_t2i',
  }, db);
  if (estado !== JOB_STATES.PREPARING) {
    setGenerationJobState(jobId, estado, {
      db, error: estado === JOB_STATES.FAILED ? 'estourou' : null,
    });
  }
  return createSceneTake(projectId, ordinal, { kind, generationJobId: jobId }, db);
}

function geracaoFalsa(db, kind) {
  const chamadas = [];
  const iniciar = async (params, opcoes) => {
    contador += 1;
    const jobId = `job_novo_${contador}`;
    chamadas.push({ ...params, projectId: opcoes.projectId });
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

// ── A · B · C · o estado da cena ───────────────────────────────────────────

test('A+B. get_scene_media lista imagens e vídeos, com a situação e a escolha', async () => {
  const { db, ctx } = await cenario();

  await takeConcluido(db, 1, 'image');            // take 1 — vira a escolha
  await takeConcluido(db, 1, 'image');            // take 2 — não troca
  takeEmVoo(db, 1, 'image', JOB_STATES.RUNNING);  // take 3 — gerando
  await takeConcluido(db, 1, 'video');            // vídeo take 1
  takeEmVoo(db, 1, 'video', JOB_STATES.FAILED);   // vídeo take 2 — falhou

  const saida = await getSceneMediaTool.execute(ctx, { ordinal: 1 });

  assert.equal(saida.ordinal, 1);
  assert.equal(saida.title, 'O Olimpo');

  assert.equal(saida.image.total, 3);
  assert.equal(saida.image.selectedTakeNumber, 1);
  assert.deepEqual(saida.image.takes, [
    { takeNumber: 1, state: JOB_STATES.DONE, selected: true },
    { takeNumber: 2, state: JOB_STATES.DONE, selected: false },
    { takeNumber: 3, state: JOB_STATES.RUNNING, selected: false },
  ]);

  assert.equal(saida.video.total, 2);
  assert.equal(saida.video.selectedTakeNumber, 1);
  assert.deepEqual(saida.video.takes, [
    { takeNumber: 1, state: JOB_STATES.DONE, selected: true },
    { takeNumber: 2, state: JOB_STATES.FAILED, selected: false },
  ]);

  // Uma cena sem mídia nenhuma responde vazio, e não erro.
  const vazia = await getSceneMediaTool.execute(ctx, { ordinal: 2 });
  assert.deepEqual(vazia.image, { total: 0, selectedTakeNumber: null, takes: [] });
  assert.deepEqual(vazia.video, { total: 0, selectedTakeNumber: null, takes: [] });

  // E uma cena que não existe é recusada.
  await assert.rejects(
    () => getSceneMediaTool.execute(ctx, { ordinal: 9 }),
    (erro) => erro.name === 'ToolExecutionError' && /não tem uma cena 9/.test(erro.message),
  );
});

test('C. get_scene_media não vaza identidade nossa, arquivo, workflow nem linhagem', async () => {
  const { db, ctx } = await cenario();
  const imagem = await takeConcluido(db, 1, 'image');
  const video = await takeConcluido(db, 1, 'video');
  db.prepare('UPDATE assets SET derivedFromAssetId = ? WHERE id = ?').run(imagem.id, video.id);

  const saida = await getSceneMediaTool.execute(ctx, { ordinal: 1 });
  const texto = JSON.stringify(saida);

  const takes = [
    ...listSceneTakes(PROJETO, 1, 'image', db), ...listSceneTakes(PROJETO, 1, 'video', db),
  ];
  for (const take of takes) {
    for (const interno of [take.id, take.sceneId, take.generationJobId, take.assetId]) {
      assert.ok(!texto.includes(interno), `vazou "${interno}"`);
    }
  }
  for (const interno of [imagem.filename, video.filename, imagem.url]) {
    assert.ok(!texto.includes(interno), `vazou "${interno}"`);
  }
  for (const proibido of [/ideogram/i, /minimax/i, /comfy/i, /workflow/i, /derivedFrom/i,
    /sourceAsset/i, /assetId/i, /mediaId/i, /jobId/i, /\/api\//, /hermes/i]) {
    assert.ok(!proibido.test(texto), `o resultado cita ${proibido}`);
  }

  // A forma é fechada: só estes campos, em cada take.
  for (const take of [...saida.image.takes, ...saida.video.takes]) {
    assert.deepEqual(Object.keys(take).sort(), ['selected', 'state', 'takeNumber']);
  }
  assert.deepEqual(Object.keys(saida).sort(), ['image', 'ordinal', 'title', 'video']);
});

test('C-bis. a resposta é limitada, e o limite é o do domínio', async () => {
  const { db, ctx } = await cenario();

  // Muitos takes, todos baratos: a lista não é livre, e o teto dela vem de
  // MAX_TAKES_POR_CENA — um número só, num lugar só.
  for (let i = 0; i < MAX_TAKES_POR_CENA; i += 1) takeEmVoo(db, 1, 'image');

  const saida = await getSceneMediaTool.execute(ctx, { ordinal: 1 });
  assert.equal(saida.image.total, MAX_TAKES_POR_CENA);
  assert.ok(saida.image.takes.length <= MAX_TAKES_POR_CENA);
  assert.equal(saida.image.takes.length, MAX_TAKES_POR_CENA);

  // E uma cena não consegue passar disso: o domínio recusa antes.
  assert.throws(
    () => createSceneTake(PROJETO, 1, { kind: 'image' }, db),
    (erro) => erro.name === 'DomainError' && /limite/.test(erro.message),
  );
});

// ── D · E · K · L · a escolha ──────────────────────────────────────────────

test('D+K. escolher a segunda imagem funciona, e não apaga a primeira', async () => {
  const { db, ctx } = await cenario();
  const a = await takeConcluido(db, 1, 'image');
  const b = await takeConcluido(db, 1, 'image');

  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).takeNumber, 1);

  const saida = await selectSceneTakeTool.execute(
    ctx, { ordinal: 1, kind: 'image', takeNumber: 2 },
  );
  assert.deepEqual(saida, { ordinal: 1, kind: 'image', selectedTakeNumber: 2 });
  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).assetId, b.id);

  // Os dois takes continuam lá, com as mídias intactas.
  const takes = listSceneTakes(PROJETO, 1, 'image', db);
  assert.deepEqual(takes.map((t) => t.takeNumber), [1, 2]);
  assert.deepEqual(takes.map((t) => t.assetId), [a.id, b.id]);
  assert.ok(getAsset(a.id, db), 'o Asset da primeira foi apagado');

  // E dá para voltar atrás — escolher é só mover o ponteiro.
  await selectSceneTakeTool.execute(ctx, { ordinal: 1, kind: 'image', takeNumber: 1 });
  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).assetId, a.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM production_scene_media_selections WHERE kind = 'image'").get().n,
    1,
    'a escolha acumulou em vez de trocar',
  );
});

test('E+L. vídeo é escolhido à parte, e trocar a imagem não mexe nele', async () => {
  const { db, ctx } = await cenario();
  await takeConcluido(db, 1, 'image');
  await takeConcluido(db, 1, 'image');
  await takeConcluido(db, 1, 'video');
  const segundoVideo = await takeConcluido(db, 1, 'video');

  await selectSceneTakeTool.execute(ctx, { ordinal: 1, kind: 'video', takeNumber: 2 });
  assert.equal(getSceneSelection(PROJETO, 1, 'video', db).assetId, segundoVideo.id);
  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).takeNumber, 1);

  await selectSceneTakeTool.execute(ctx, { ordinal: 1, kind: 'image', takeNumber: 2 });
  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).takeNumber, 2);
  assert.equal(getSceneSelection(PROJETO, 1, 'video', db).takeNumber, 2, 'o vídeo se moveu junto');
});

// ── F · G · H · I · J · o que NÃO pode ser escolhido ───────────────────────

test('F. uma tentativa que não existe é recusada', async () => {
  const { db, ctx } = await cenario();
  await takeConcluido(db, 1, 'image');

  for (const takeNumber of [2, 99, 0, -1, 'duas', null]) {
    await assert.rejects(
      () => selectSceneTakeTool.execute(ctx, { ordinal: 1, kind: 'image', takeNumber }),
      (erro) => erro.name === 'ToolExecutionError',
      `aceitou takeNumber ${JSON.stringify(takeNumber)}`,
    );
  }

  // E um tipo fora do vocabulário também.
  for (const kind of ['audio', 'IMAGE', '', null]) {
    await assert.rejects(
      () => selectSceneTakeTool.execute(ctx, { ordinal: 1, kind, takeNumber: 1 }),
      (erro) => erro.name === 'ToolExecutionError',
    );
  }

  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).takeNumber, 1, 'a escolha mudou');
});

test('G+H+I. gerando, falho ou sem mídia não pode virar a cena', async () => {
  const { db, ctx } = await cenario();
  const pronta = await takeConcluido(db, 1, 'image');

  takeEmVoo(db, 1, 'image', JOB_STATES.RUNNING);    // take 2
  takeEmVoo(db, 1, 'image', JOB_STATES.FAILED);     // take 3
  takeEmVoo(db, 1, 'image', JOB_STATES.PREPARING);  // take 4
  createSceneTake(PROJETO, 1, { kind: 'image' }, db); // take 5 — sem job e sem Asset

  const esperado = {
    2: /ainda está sendo gerada/,
    3: /não ficou pronta/,
    4: /ainda está sendo gerada/,
    5: /ainda está sendo gerada/,
  };

  for (const [takeNumber, frase] of Object.entries(esperado)) {
    await assert.rejects(
      () => selectSceneTakeTool.execute(
        ctx, { ordinal: 1, kind: 'image', takeNumber: Number(takeNumber) },
      ),
      (erro) => erro.name === 'ToolExecutionError' && frase.test(erro.message),
      `aceitou o take ${takeNumber}`,
    );
  }

  // A escolha original ficou de pé o tempo todo.
  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).assetId, pronta.id);
});

test('J. a cena de outro projeto é impronunciável, e os ids internos não entram', async () => {
  const { db, ctx, ctxOutro } = await cenario();
  await takeConcluido(db, 1, 'image');                     // deste projeto
  await takeConcluido(db, 1, 'image', 'proj_outro');       // do outro

  // O número 1 na conversa do outro projeto significa a cena 1 DELE.
  await selectSceneTakeTool.execute(ctxOutro, { ordinal: 1, kind: 'image', takeNumber: 1 });
  assert.equal(getSceneSelection('proj_outro', 1, 'image', db).takeNumber, 1);
  assert.equal(listSceneTakes(PROJETO, 1, 'image', db).length, 1);

  // Q: nenhum schema aceita identidade nossa.
  const take = listSceneTakes(PROJETO, 1, 'image', db)[0];
  for (const extra of [
    { projectId: 'proj_outro' }, { sceneId: take.sceneId }, { mediaId: take.id },
    { assetId: take.assetId }, { jobId: take.generationJobId },
  ]) {
    await assert.rejects(
      () => selectSceneTakeTool.execute(ctx, { ordinal: 1, kind: 'image', takeNumber: 1, ...extra }),
      (erro) => erro.name === 'ToolExecutionError' && erro.message.includes(Object.keys(extra)[0]),
      `select aceitou ${Object.keys(extra)[0]}`,
    );
    await assert.rejects(
      () => getSceneMediaTool.execute(ctx, { ordinal: 1, ...extra }),
      (erro) => erro.name === 'ToolExecutionError' && erro.message.includes(Object.keys(extra)[0]),
      `get aceitou ${Object.keys(extra)[0]}`,
    );
  }
});

// ── M · "faça outra" não troca a escolha ───────────────────────────────────

test('M. gerar outra imagem cria o take seguinte e NÃO troca a escolha', async () => {
  const { db, ctx } = await cenario();
  const primeira = await takeConcluido(db, 1, 'image');
  const { iniciar, acompanhar } = geracaoFalsa(db, 'image');

  const saida = await generateSceneImageTool.execute(
    ctx, { ordinal: 1, prompt: 'a mesma cena, mais sombria' }, { iniciar, acompanhar },
  );
  assert.equal(saida.takeNumber, 2);

  // Enquanto a nova não conclui, a escolhida continua sendo a 1.
  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).assetId, primeira.id);

  // E depois de concluir também: a regra do 13-B não mudou.
  const take = listSceneTakes(PROJETO, 1, 'image', db)[1];
  const nova = createAsset({
    projectId: PROJETO, kind: 'image', jobId: take.generationJobId,
    filename: `${take.generationJobId}.png`,
  }, db);
  completeGenerationJob(take.generationJobId, { assetId: nova.id, db });

  assert.equal(listSceneTakes(PROJETO, 1, 'image', db)[1].assetId, nova.id);
  assert.equal(
    getSceneSelection(PROJETO, 1, 'image', db).assetId, primeira.id,
    'a nova tentativa tomou o lugar da escolhida',
  );

  // E o estado que o agente lê já mostra as duas prontas, com a 1 escolhida.
  const estado = await getSceneMediaTool.execute(ctx, { ordinal: 1 });
  assert.equal(estado.image.total, 2);
  assert.equal(estado.image.selectedTakeNumber, 1);
  assert.ok(estado.image.takes.every((t) => t.state === JOB_STATES.DONE));
});

// ── N · O · a troca rege o vídeo ───────────────────────────────────────────

test('N+O. depois de trocar a imagem, animar usa a NOVA — e a linhagem segue ela', async () => {
  const { db, ctx } = await cenario();
  const a = await takeConcluido(db, 1, 'image');
  const b = await takeConcluido(db, 1, 'image');
  assert.equal(getSceneSelection(PROJETO, 1, 'image', db).assetId, a.id);

  // "Use a segunda."
  await selectSceneTakeTool.execute(ctx, { ordinal: 1, kind: 'image', takeNumber: 2 });

  // "Anime essa versão." — sem sourceAssetId, como sempre.
  const { iniciar, chamadas, acompanhar } = geracaoFalsa(db, 'video');
  await generateSceneVideoTool.execute(
    ctx, { ordinal: 1, prompt: 'a câmera avança' }, { iniciar, acompanhar },
  );

  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].sourceAssetId, b.id, 'animou a imagem antiga');
  assert.notEqual(chamadas[0].sourceAssetId, a.id);

  // E a linhagem, nos dois lugares, aponta para a NOVA escolhida.
  const take = listSceneTakes(PROJETO, 1, 'video', db)[0];
  assert.equal(getGenerationJobRecord(take.generationJobId, db).derivedFromAssetId, b.id);

  const video = createAsset({
    projectId: PROJETO, kind: 'video', jobId: take.generationJobId,
    filename: `${take.generationJobId}.mp4`,
    derivedFromAssetId: getGenerationJobRecord(take.generationJobId, db).derivedFromAssetId,
  }, db);
  completeGenerationJob(take.generationJobId, { assetId: video.id, db });

  assert.equal(getAsset(video.id, db).derivedFromAssetId, b.id);
  assert.equal(getSceneSelection(PROJETO, 1, 'video', db).takeNumber, 1);

  // Voltar para a primeira imagem e animar de novo troca a origem junto.
  await selectSceneTakeTool.execute(ctx, { ordinal: 1, kind: 'image', takeNumber: 1 });
  await generateSceneVideoTool.execute(
    ctx, { ordinal: 1, prompt: 'outro movimento' }, { iniciar, acompanhar },
  );
  assert.equal(chamadas[1].sourceAssetId, a.id);
});

// ── P · R · a superfície e a fonte da verdade ──────────────────────────────

test('P. os aliases do Hermes apontam para as ferramentas canônicas', () => {
  for (const [alias, canonico] of [
    ['project_get_scene_media', 'project.get_scene_media'],
    ['project_select_scene_take', 'project.select_scene_take'],
  ]) {
    assert.ok(hermesAliases().includes(alias), `${alias} não está na tabela`);
    assert.equal(toCanonicalToolName(alias), canonico);
  }

  const plugin = readFileSync(
    new URL('../integrations/hermes/showrunner-plugin/__init__.py', import.meta.url), 'utf8',
  );
  const manifesto = readFileSync(
    new URL('../integrations/hermes/showrunner-plugin/plugin.yaml', import.meta.url), 'utf8',
  );

  for (const nome of ['project_get_scene_media', 'project_select_scene_take']) {
    assert.match(plugin, new RegExp(`"name": "${nome}"`));
    assert.match(manifesto, new RegExp(`- ${nome}`));
  }

  // Q: os schemas do plugin não oferecem identidade nossa.
  const bloco = plugin.slice(
    plugin.indexOf('GET_SCENE_MEDIA_SCHEMA = {'),
    plugin.indexOf('# A allowlist do plugin'),
  );
  for (const proibido of ['projectId', 'sceneId', 'mediaId', 'assetId', 'jobId',
    'sourceAssetId', 'workflowId']) {
    assert.ok(!bloco.includes(`"${proibido}"`), `o plugin oferece ${proibido}`);
  }

  // E as duas ferramentas estão publicadas, com os campos que declararam.
  const publicadas = publicToolList(toolRegistry());
  const media = publicadas.find((t) => t.name === 'project.get_scene_media');
  const escolha = publicadas.find((t) => t.name === 'project.select_scene_take');
  assert.deepEqual(Object.keys(media.inputSchema.properties), ['ordinal']);
  assert.deepEqual(
    Object.keys(escolha.inputSchema.properties).sort(), ['kind', 'ordinal', 'takeNumber'],
  );
  assert.deepEqual(escolha.inputSchema.properties.kind.enum, ['image', 'video']);
  assert.ok(!media.execute && !escolha.execute);

  // E a persona sabe conversar sobre tentativas — inclusive quando perguntar.
  const persona = readFileSync(
    new URL('../integrations/hermes/persona/showrunner.md', import.meta.url), 'utf8',
  );
  assert.match(persona, /## Quando o usuário fala das tentativas de uma cena/);
  assert.match(persona, /Na dúvida, pergunte/);
});

test('R. o estado vem do banco a cada consulta, e não de nada lembrado', async () => {
  const { db, ctx } = await cenario();
  const take = takeEmVoo(db, 1, 'image', JOB_STATES.RUNNING);

  const antes = await getSceneMediaTool.execute(ctx, { ordinal: 1 });
  assert.equal(antes.image.takes[0].state, JOB_STATES.RUNNING);
  assert.equal(antes.image.selectedTakeNumber, null);

  // O mundo muda por fora — foi a reconciliação, não esta ferramenta.
  const asset = createAsset({
    projectId: PROJETO, kind: 'image', jobId: take.generationJobId,
    filename: `${take.generationJobId}.png`,
  }, db);
  completeGenerationJob(take.generationJobId, { assetId: asset.id, db });

  const depois = await getSceneMediaTool.execute(ctx, { ordinal: 1 });
  assert.equal(depois.image.takes[0].state, JOB_STATES.DONE);
  assert.equal(depois.image.selectedTakeNumber, 1);

  // E o contrário: um trabalho que falha depois aparece como falho.
  const outro = takeEmVoo(db, 1, 'image', JOB_STATES.RUNNING);
  assert.equal(
    (await getSceneMediaTool.execute(ctx, { ordinal: 1 })).image.takes[1].state,
    JOB_STATES.RUNNING,
  );
  setGenerationJobState(outro.generationJobId, JOB_STATES.FAILED, { db, error: 'estourou' });
  assert.equal(
    (await getSceneMediaTool.execute(ctx, { ordinal: 1 })).image.takes[1].state,
    JOB_STATES.FAILED,
  );

  // Nenhuma coluna de estado foi criada para isso: a situação é DERIVADA.
  const colunas = db.prepare('PRAGMA table_info(production_scene_media)').all().map((c) => c.name);
  assert.deepEqual(colunas, [
    'id', 'sceneId', 'kind', 'takeNumber', 'generationJobId', 'assetId',
    'createdAt', 'updatedAt',
  ]);
});
