// A geração da trilha de uma peça — a ordem, a proveniência e a seleção.
//
// PASSO 14-D2B. Nenhum teste aqui compõe um segundo de música: o executor é
// injetado, e é isso que permite provar ORDEM e POLÍTICA sem GPU, sem ComfyUI e
// sem os 13,7 GB do ACE-Step.
//
// O que eles trancam, além do de sempre:
//
//   três origens de `kind='audio'`   narração (Piper), efeito e música (ambos
//                                    ComfyUI) convivem sem um roubar o outro
//   a música continua do PROJETO     gerar não muda de quem a peça é, e não
//                                    passa a bloquear o replace de cenas

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, DomainError } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import {
  replaceProductionScenes, saveProductionPlan, saveProductionScript,
} from '../lib/server/domain/production.js';
import {
  createProductionMusicCue, getProductionMusicSelection, listProductionMusicCues,
  listProductionMusicTakes, musicCueFingerprint, updateProductionMusicCue,
} from '../lib/server/domain/music.js';
import {
  completeGenerationJob, getGenerationJobRecord,
} from '../lib/server/domain/generationJobs.js';
import {
  MUSIC_WORKFLOW_ID, startProductionMusicGeneration,
} from '../lib/server/generation/music.js';
import { startSceneSfxGeneration, SFX_WORKFLOW_ID } from '../lib/server/generation/sceneSfx.js';
import { createSceneSfxCue } from '../lib/server/domain/sceneSfx.js';
import {
  NARRATION_WORKFLOW_ID, reconcileNarrationJobs, startNarrationGeneration,
} from '../lib/server/generation/narration.js';
import { getWorkflow, listWorkflows } from '../lib/server/generation/workflows/registry.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';

const EPICA = 'dark cinematic orchestral underscore, slow tension build, instrumental';
const PIANO = 'quiet melancholic piano with sparse strings, instrumental';
const ALEGRE = 'bright hopeful strings, warm and open, instrumental';

function banco() {
  const db = openDatabase(':memory:');
  for (const id of ['proj_a', 'proj_b']) {
    createProject({ id, name: `P ${id}` }, db);
    saveProductionPlan({ projectId: id, title: 'Plano', targetDurationSeconds: 80 }, db);
    saveProductionScript({ projectId: id, title: 'R', fullText: 'Texto.' }, db);
    replaceProductionScenes(id, [1, 2].map((n) => ({
      ordinal: n, title: `Cena ${n}`, durationSeconds: 40, narration: `Narração ${n}.`,
    })), db);
  }
  return db;
}

function executorFake({ falhar = false } = {}) {
  const submissoes = [];
  return {
    submissoes,
    async submeter(params) {
      submissoes.push(params);
      if (falhar) {
        const erro = new Error('o executor recusou o grafo');
        erro.status = 422;
        throw erro;
      }
      return { promptId: `prompt_${submissoes.length}`, state: 'na-fila' };
    },
    async anotarSubmissao() {},
  };
}

function concluirCom(db, projectId, jobId, sufixo) {
  const asset = createAsset({
    projectId, kind: 'audio', jobId, filename: `trilha_${sufixo}.flac`,
    url: `/api/media/audio/${projectId}/trilha_${sufixo}.flac`, durationSeconds: 20,
  }, db);
  completeGenerationJob(jobId, { assetId: asset.id, db });
  return asset;
}

async function gerar(db, projectId, cueNumber, executor = executorFake()) {
  return startProductionMusicGeneration(
    { projectId, cueNumber, seconds: 20 },
    { db, deps: { submeter: executor.submeter, anotarSubmissao: executor.anotarSubmissao } },
  );
}

// ── entrada e ordem ────────────────────────────────────────────────────────

test('cue inexistente recusa antes de criar job', async () => {
  const db = banco();
  const executor = executorFake();
  createProductionMusicCue('proj_a', { description: EPICA }, db);

  await assert.rejects(
    () => gerar(db, 'proj_a', 9, executor),
    (erro) => erro instanceof DomainError && /não tem uma peça musical 9/.test(erro.message),
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_music_takes').get().n, 0);
  assert.equal(executor.submissoes.length, 0);
  db.close();
});

test('a intenção vai ao executor, e o resto é do servidor', async () => {
  const db = banco();
  const executor = executorFake();
  createProductionMusicCue('proj_a', { description: EPICA }, db);

  const r = await gerar(db, 'proj_a', 1, executor);

  assert.equal(executor.submissoes.length, 1);
  assert.equal(executor.submissoes[0].prompt, EPICA);
  assert.equal(executor.submissoes[0].workflowId, MUSIC_WORKFLOW_ID);

  const take = listProductionMusicTakes('proj_a', 1, db)[0];
  assert.equal(take.sourceCueFingerprint, musicCueFingerprint(EPICA));
  assert.equal(r.sourceCueFingerprint, take.sourceCueFingerprint);
  assert.equal(take.takeNumber, 1);

  const job = getGenerationJobRecord(r.jobId, db);
  assert.equal(job.kind, 'audio');
  assert.equal(job.workflowId, 'ace_step_15_music');
  db.close();
});

test('o take existe ANTES do submit, e falhar em registrá-lo impede o executor', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);

  let noSubmit = null;
  const espiao = {
    submissoes: [],
    async submeter(params) {
      espiao.submissoes.push(params);
      noSubmit = listProductionMusicTakes('proj_a', 1, db);
      return { promptId: 'p1', state: 'na-fila' };
    },
    async anotarSubmissao() {},
  };
  const r = await gerar(db, 'proj_a', 1, espiao);
  assert.equal(noSubmit.length, 1);
  assert.equal(noSubmit[0].generationJobId, r.jobId);
  assert.equal(noSubmit[0].assetId, null);

  // Com a peça no teto de takes, o registro falha e nada é submetido.
  const cue = db.prepare('SELECT id FROM production_music_cues').get();
  const impressao = musicCueFingerprint(EPICA);
  const insere = db.prepare(
    'INSERT INTO production_music_takes (id, cueId, takeNumber, sourceCueFingerprint, '
    + 'createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 1)',
  );
  for (let n = 2; n <= 50; n += 1) insere.run(`t_${n}`, cue.id, n, impressao);

  const antes = espiao.submissoes.length;
  await assert.rejects(() => gerar(db, 'proj_a', 1, espiao), DomainError);
  assert.equal(espiao.submissoes.length, antes, 'submeteu sem ter conseguido registrar');
  db.close();
});

// ── o resultado ────────────────────────────────────────────────────────────

test('conclusão cria Asset de áudio ligado ao take, sem linhagem', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  const r = await gerar(db, 'proj_a', 1);

  const asset = concluirCom(db, 'proj_a', r.jobId, 'a');
  const job = getGenerationJobRecord(r.jobId, db);
  const take = listProductionMusicTakes('proj_a', 1, db)[0];

  assert.equal(job.state, 'done');
  assert.equal(asset.kind, 'audio');
  assert.ok(asset.durationSeconds > 0);
  assert.equal(take.assetId, asset.id);
  assert.equal(take.generationJobId, r.jobId);
  assert.equal(asset.derivedFromAssetId, null);
  assert.equal(job.derivedFromAssetId, null);
  db.close();
});

// ── a política, por peça ───────────────────────────────────────────────────

test('CASO A — o primeiro take current da peça é escolhido sozinho', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  const r = await gerar(db, 'proj_a', 1);
  concluirCom(db, 'proj_a', r.jobId, 'a');

  const sel = getProductionMusicSelection('proj_a', 1, db);
  assert.equal(sel.takeNumber, 1);
  assert.equal(sel.current, true);
  db.close();
});

test('CASO B — o segundo take da MESMA intenção não rouba a seleção', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  const um = await gerar(db, 'proj_a', 1);
  concluirCom(db, 'proj_a', um.jobId, 'a');
  const dois = await gerar(db, 'proj_a', 1);
  concluirCom(db, 'proj_a', dois.jobId, 'b');

  assert.deepEqual(listProductionMusicTakes('proj_a', 1, db).map((t) => t.takeNumber), [1, 2]);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).takeNumber, 1);
  db.close();
});

test('CASO C — escolha stale + take novo da intenção atual → o novo assume', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  const um = await gerar(db, 'proj_a', 1);
  concluirCom(db, 'proj_a', um.jobId, 'a');

  updateProductionMusicCue('proj_a', 1, { description: ALEGRE }, db);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).current, false);

  const dois = await gerar(db, 'proj_a', 1);
  concluirCom(db, 'proj_a', dois.jobId, 'b');

  const sel = getProductionMusicSelection('proj_a', 1, db);
  assert.equal(sel.takeNumber, 2);
  assert.equal(sel.current, true);
  db.close();
});

test('CASO D — o take que ficou stale antes de concluir não é escolhido', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  const r = await gerar(db, 'proj_a', 1);

  updateProductionMusicCue('proj_a', 1, { description: ALEGRE }, db);
  concluirCom(db, 'proj_a', r.jobId, 'a');

  const take = listProductionMusicTakes('proj_a', 1, db)[0];
  assert.equal(take.sourceCueFingerprint, musicCueFingerprint(EPICA));
  assert.notEqual(take.assetId, null);
  assert.equal(take.current, false);
  assert.equal(getProductionMusicSelection('proj_a', 1, db), null);
  db.close();
});

test('a corrida da intenção: F1 conclui velho, F2 nasce e assume', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);

  const g1 = await gerar(db, 'proj_a', 1);
  updateProductionMusicCue('proj_a', 1, { description: ALEGRE }, db);
  concluirCom(db, 'proj_a', g1.jobId, 'f1');

  const f1 = listProductionMusicTakes('proj_a', 1, db)[0];
  assert.notEqual(f1.assetId, null);
  assert.equal(f1.sourceCueFingerprint, musicCueFingerprint(EPICA));
  assert.equal(f1.current, false);
  assert.equal(getProductionMusicSelection('proj_a', 1, db), null);

  const g2 = await gerar(db, 'proj_a', 1);
  concluirCom(db, 'proj_a', g2.jobId, 'f2');

  const takes = listProductionMusicTakes('proj_a', 1, db);
  assert.equal(takes.length, 2);
  assert.equal(takes[1].current, true);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).takeNumber, 2);
  assert.equal(takes[0].sourceCueFingerprint, musicCueFingerprint(EPICA));
  db.close();
});

test('duas peças são independentes', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createProductionMusicCue('proj_a', { description: PIANO }, db);

  for (const cue of [1, 2]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await gerar(db, 'proj_a', cue);
    concluirCom(db, 'proj_a', r.jobId, `c${cue}`);
  }

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets WHERE kind='audio'").get().n, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_music_selections').get().n, 2);

  updateProductionMusicCue('proj_a', 1, { description: 'outra coisa' }, db);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).current, false);
  assert.equal(getProductionMusicSelection('proj_a', 2, db).current, true);
  db.close();
});

// ── falha e fronteiras ─────────────────────────────────────────────────────

test('o executor recusa: take sem Asset, sem seleção, sem Asset falso', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);

  await assert.rejects(() => gerar(db, 'proj_a', 1, executorFake({ falhar: true })));

  const takes = listProductionMusicTakes('proj_a', 1, db);
  assert.equal(takes.length, 1);
  assert.notEqual(takes[0].generationJobId, null);
  assert.equal(takes[0].assetId, null);
  assert.equal(getProductionMusicSelection('proj_a', 1, db), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  db.close();
});

test('cross-project bloqueado', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  const r = await gerar(db, 'proj_a', 1);
  concluirCom(db, 'proj_a', r.jobId, 'a');

  await assert.rejects(
    () => gerar(db, 'proj_b', 1),
    (erro) => erro instanceof DomainError
      && /não tem uma peça musical 1/.test(erro.message)
      && !/proj_a/.test(erro.message),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets WHERE projectId='proj_b'").get().n, 0);
  db.close();
});

test('a música continua do PROJETO, e não bloqueia replaceProductionScenes', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  const r = await gerar(db, 'proj_a', 1);
  concluirCom(db, 'proj_a', r.jobId, 'a');

  // Gerar não introduziu vínculo com cena nenhuma.
  const colunas = db.prepare('PRAGMA table_info(production_music_cues)').all()
    .map((c) => String(c.name));
  for (const proibida of ['sceneId', 'sceneOrdinal', 'sequenceId', 'timelineId',
    'startSeconds', 'endSeconds']) {
    assert.equal(colunas.includes(proibida), false, `a cue ganhou ${proibida}`);
  }

  // E o replace continua permitido, com a trilha sobrevivendo a ele.
  const depois = replaceProductionScenes('proj_a', [1, 2].map((n) => ({
    ordinal: n, title: `Reescrita ${n}`, durationSeconds: 40, narration: 'n',
  })), db);
  assert.equal(depois.length, 2);
  assert.equal(listProductionMusicCues('proj_a', db).length, 1);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).takeNumber, 1);
  db.close();
});

// ── §14 · as TRÊS origens de `kind='audio'` ────────────────────────────────

test('§14. três origens de áudio, três roteamentos — e nenhum decide por kind', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  createSceneSfxCue('proj_a', 1, { description: 'porta batendo' }, db);

  const exec = executorFake();
  const musica = await gerar(db, 'proj_a', 1, exec);
  const efeito = await startSceneSfxGeneration(
    { projectId: 'proj_a', ordinal: 1, cueNumber: 1, seconds: 4 },
    { db, deps: { submeter: exec.submeter, anotarSubmissao: exec.anotarSubmissao } },
  );
  const voz = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 },
    {
      db,
      deps: {
        provider: { async available() { return true; }, async synthesize() {} },
        despachar: () => null,
      },
    },
  );

  // Os três são `kind='audio'` — é por isso que `kind` não pode rotear nada.
  for (const j of [musica, efeito, voz]) {
    assert.equal(getGenerationJobRecord(j.jobId, db).kind, 'audio');
  }

  // Quem distingue é o workflow: os dois do ComfyUI resolvem no registry, o do
  // Piper não.
  assert.ok(getWorkflow(MUSIC_WORKFLOW_ID));
  assert.ok(getWorkflow(SFX_WORKFLOW_ID));
  assert.throws(() => getWorkflow(NARRATION_WORKFLOW_ID), /Workflow desconhecido/);
  assert.equal(new Set([MUSIC_WORKFLOW_ID, SFX_WORKFLOW_ID, NARRATION_WORKFLOW_ID]).size, 3);

  // A reconciliação do Piper leva SÓ a voz. Se varresse por `kind`, levaria o
  // efeito e a música vivos junto — e os resultados que a GPU ainda vai
  // entregar chegariam a jobs dados como perdidos.
  const { orfaos } = reconcileNarrationJobs({ db });
  assert.deepEqual(orfaos, [voz.jobId]);
  assert.equal(getGenerationJobRecord(voz.jobId, db).state, 'orphaned');
  assert.notEqual(getGenerationJobRecord(musica.jobId, db).state, 'orphaned');
  assert.notEqual(getGenerationJobRecord(efeito.jobId, db).state, 'orphaned');

  // E os dois takes do ComfyUI continuam de pé, esperando a conclusão.
  assert.equal(listProductionMusicTakes('proj_a', 1, db)[0].assetId, null);
  db.close();
});

test('§15. recuperar não re-submete cegamente nem duplica take', async () => {
  const db = banco();
  createProductionMusicCue('proj_a', { description: EPICA }, db);
  const executor = executorFake();
  await gerar(db, 'proj_a', 1, executor);

  const antes = executor.submissoes.length;
  reconcileNarrationJobs({ db });
  assert.equal(executor.submissoes.length, antes, 'a recuperação gerou de novo');
  assert.equal(listProductionMusicTakes('proj_a', 1, db).length, 1, 'nasceu take a mais');
  db.close();
});

// ── ausências ──────────────────────────────────────────────────────────────

test('o workflow musical é próprio, e não o do efeito', () => {
  const deAudio = listWorkflows().filter((w) => w.kind === 'audio').map((w) => w.id).sort();
  assert.deepEqual(deAudio, ['ace_step_15_music', 'stable_audio_sfx']);
  assert.notEqual(MUSIC_WORKFLOW_ID, SFX_WORKFLOW_ID);

  // O descriptor musical declara os pesos que realmente usa.
  const d = getWorkflow(MUSIC_WORKFLOW_ID);
  assert.deepEqual(d.requiredModels.map((m) => m.file).sort(), [
    'ace_1.5_vae.safetensors', 'acestep_v1.5_turbo.safetensors',
    'qwen_0.6b_ace15.safetensors', 'qwen_4b_ace15.safetensors',
  ]);
});

test('nenhuma Agent Tool de música, e nenhuma Timeline', () => {
  const publicadas = publicToolList(toolRegistry()).map((t) => t.name);
  for (const nome of publicadas) {
    assert.equal(
      /music|musica|trilha|score|soundtrack|timeline|mix|ducking/i.test(nome),
      false,
      `ferramenta criada cedo demais: ${nome}`,
    );
  }
});
