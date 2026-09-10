// O PASSO 14 inteiro, num projeto só.
//
// PASSO 14-F. Cada família de áudio já tem o seu arquivo de teste, e cada um
// prova a sua família em isolamento. O que faltava era a prova de CONVIVÊNCIA:
// narração, efeito e música existindo ao mesmo tempo, no mesmo Project, sem
// que um pise no outro.
//
// A convivência não é consequência automática das três provas separadas. As
// três famílias compartilham o livro-razão (`generation_jobs`), a estante de
// mídia (`assets`) e — duas delas — a mesma cena. O que este arquivo tranca é
// exatamente o que só aparece quando as três estão juntas:
//
//   ownership        a música pende do PROJETO, a narração e o efeito da CENA
//   routing          o executor sai do `workflowId`, e os três `kind` são
//                    'audio' — se `kind` decidisse, os três iriam para o mesmo
//                    lugar
//   selection        três seleções vizinhas, e concluir uma não move as outras
//   replaceScenes    a narração e o efeito BLOQUEIAM, a música SOBREVIVE
//   cross-project    nada disso atravessa a fronteira do projeto
//
// Não há geração aqui: os jobs e os Assets são registros, como nos outros
// testes de domínio. O que se prova é a costura, e não o provider.

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase } from '../lib/server/domain/db.js';
import { createProject, deleteProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import { createGenerationJobRecord } from '../lib/server/domain/generationJobs.js';
import {
  replaceProductionScenes, saveProductionPlan, saveProductionScript,
} from '../lib/server/domain/production.js';
import {
  createNarrationAudioTake, getNarrationAudioSelection,
  linkCompletedJobToNarrationAudioTake,
} from '../lib/server/domain/sceneAudio.js';
import {
  createSceneSfxCue, createSceneSfxTake, getSceneSfxSelection,
  linkCompletedJobToSfxTake, updateSceneSfxCue,
} from '../lib/server/domain/sceneSfx.js';
import {
  createProductionMusicCue, createProductionMusicTake,
  getProductionMusicSelection, linkCompletedJobToMusicTake,
  listProductionMusicCues,
} from '../lib/server/domain/music.js';
import { NARRATION_WORKFLOW_ID } from '../lib/server/generation/narration.js';
import { SFX_WORKFLOW_ID } from '../lib/server/generation/sceneSfx.js';
import { MUSIC_WORKFLOW_ID } from '../lib/server/generation/music.js';

const TROVAO = 'distant rolling thunder over rain';
const TEMA = 'dark cinematic orchestral underscore';

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

/** Um trabalho concluído e a mídia que ele produziu, no livro-razão comum. */
function trabalhoPronto(db, { jobId, workflowId, projectId = 'proj_a', filename }) {
  createGenerationJobRecord({
    jobId, projectId, kind: 'audio', workflowId, state: 'preparing',
  }, db);
  const asset = createAsset({ projectId, kind: 'audio', filename }, db);
  return asset.id;
}

/** Liga o take recém-criado ao trabalho, como a geração faz ao registrar. */
function ligarAoTrabalho(db, tabela, takeId, jobId) {
  db.prepare(
    `UPDATE ${tabela} SET generationJobId = ?, updatedAt = ? WHERE id = ?`,
  ).run(jobId, Date.now(), takeId);
}

/** As três famílias, no mesmo projeto, cada uma com um take em aberto. */
function producaoComOsTres(db) {
  const narracaoAsset = trabalhoPronto(db, {
    jobId: 'job_voz', workflowId: NARRATION_WORKFLOW_ID, filename: 'voz.wav',
  });
  const sfxAsset = trabalhoPronto(db, {
    jobId: 'job_sfx', workflowId: SFX_WORKFLOW_ID, filename: 'trovao.flac',
  });
  const musicaAsset = trabalhoPronto(db, {
    jobId: 'job_mus', workflowId: MUSIC_WORKFLOW_ID, filename: 'tema.flac',
  });

  const voz = createNarrationAudioTake('proj_a', 1, {}, db);
  ligarAoTrabalho(db, 'production_scene_audio_takes', voz.id, 'job_voz');

  createSceneSfxCue('proj_a', 1, { description: TROVAO }, db);
  const efeito = createSceneSfxTake('proj_a', 1, 1, {}, db);
  ligarAoTrabalho(db, 'production_scene_sfx_takes', efeito.id, 'job_sfx');

  createProductionMusicCue('proj_a', { description: TEMA }, db);
  const musica = createProductionMusicTake('proj_a', 1, {}, db);
  ligarAoTrabalho(db, 'production_music_takes', musica.id, 'job_mus');

  return { narracaoAsset, sfxAsset, musicaAsset };
}

// ── 1 ── ownership ──────────────────────────────────────────────────────────

test('1. os três convivem: a cena tem voz e efeito, a PRODUÇÃO tem música', () => {
  const db = banco();
  producaoComOsTres(db);

  // Narração e efeito pendem da CENA — as duas tabelas guardam `sceneId`.
  const cena = db.prepare(
    'SELECT id FROM production_scenes WHERE ordinal = 1 AND scriptId IN '
    + "(SELECT id FROM production_scripts WHERE projectId = 'proj_a')",
  ).get();
  assert.equal(
    db.prepare('SELECT sceneId FROM production_scene_audio_takes').get().sceneId,
    cena.id,
    'a voz é da cena',
  );
  assert.equal(
    db.prepare('SELECT sceneId FROM production_scene_sfx_cues').get().sceneId,
    cena.id,
    'o efeito é da cena',
  );

  // A música pende do PROJETO. Não há `sceneId` na tabela para ela pender de
  // uma cena — é a garantia estrutural, e não uma convenção de chamada.
  const colunasDaMusica = db.prepare('PRAGMA table_info(production_music_cues)')
    .all().map((c) => String(c.name));
  assert.ok(colunasDaMusica.includes('projectId'), 'a música tem projectId');
  assert.equal(colunasDaMusica.includes('sceneId'), false, 'a música NÃO tem sceneId');
});

// ── 2 ── routing ────────────────────────────────────────────────────────────

test('2. os três são kind=audio, e mesmo assim vão para executores diferentes', () => {
  const db = banco();
  producaoComOsTres(db);

  const jobs = db.prepare(
    'SELECT jobId, kind, workflowId FROM generation_jobs ORDER BY jobId',
  ).all();

  // O `kind` é o MESMO nos três. É por isso que ele não pode decidir executor:
  // se decidisse, a voz, o trovão e o tema iriam todos para o mesmo lugar.
  assert.deepEqual([...new Set(jobs.map((j) => j.kind))], ['audio']);

  // Quem distingue é o workflow, e os três são distintos.
  const porJob = Object.fromEntries(jobs.map((j) => [j.jobId, j.workflowId]));
  assert.equal(porJob.job_voz, NARRATION_WORKFLOW_ID);
  assert.equal(porJob.job_sfx, SFX_WORKFLOW_ID);
  assert.equal(porJob.job_mus, MUSIC_WORKFLOW_ID);
  assert.equal(new Set(Object.values(porJob)).size, 3, 'três workflows distintos');
});

// ── 3 ── seleção ────────────────────────────────────────────────────────────

test('3. concluir uma família não move a seleção das outras duas', () => {
  const db = banco();
  const { narracaoAsset, sfxAsset, musicaAsset } = producaoComOsTres(db);

  // Nada escolhido ainda, em lugar nenhum.
  assert.equal(getNarrationAudioSelection('proj_a', 1, undefined, db), null);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db), null);
  assert.equal(getProductionMusicSelection('proj_a', 1, db), null);

  // O efeito conclui PRIMEIRO. Ele escolhe a si mesmo — política A — e não
  // encosta na voz nem no tema.
  linkCompletedJobToSfxTake('job_sfx', sfxAsset, db);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).takeNumber, 1);
  assert.equal(getNarrationAudioSelection('proj_a', 1, undefined, db), null, 'voz intocada');
  assert.equal(getProductionMusicSelection('proj_a', 1, db), null, 'música intocada');

  // A voz conclui em seguida. Mesma coisa, na direção oposta.
  linkCompletedJobToNarrationAudioTake('job_voz', narracaoAsset, db);
  assert.equal(getNarrationAudioSelection('proj_a', 1, undefined, db).takeNumber, 1);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).takeNumber, 1, 'efeito mantido');

  // E a música por último.
  linkCompletedJobToMusicTake('job_mus', musicaAsset, db);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).takeNumber, 1);
  assert.equal(getNarrationAudioSelection('proj_a', 1, undefined, db).takeNumber, 1);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).takeNumber, 1);

  // Cada Asset foi para o seu take, e nenhum foi parar em tabela alheia.
  assert.equal(db.prepare('SELECT assetId FROM production_scene_audio_takes').get().assetId,
    narracaoAsset);
  assert.equal(db.prepare('SELECT assetId FROM production_scene_sfx_takes').get().assetId,
    sfxAsset);
  assert.equal(db.prepare('SELECT assetId FROM production_music_takes').get().assetId,
    musicaAsset);
});

// ── 4 ── corrida, com os três no ar ─────────────────────────────────────────

test('4. o efeito fica stale no meio do caminho, e só ele sente', () => {
  const db = banco();
  const { narracaoAsset, sfxAsset, musicaAsset } = producaoComOsTres(db);

  // A descrição do efeito muda enquanto o trabalho dele está no ar.
  updateSceneSfxCue('proj_a', 1, 1, { description: 'soft rain on a window' }, db);

  linkCompletedJobToSfxTake('job_sfx', sfxAsset, db);

  // A mídia NÃO é descartada — ela é válida, e custou GPU.
  assert.equal(db.prepare('SELECT assetId FROM production_scene_sfx_takes').get().assetId,
    sfxAsset, 'a mídia válida foi guardada');
  // Mas ela não rouba a seleção: nasceu de um texto que não vale mais.
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db), null, 'stale não seleciona');

  // As outras duas famílias concluem normalmente — o stale de uma não
  // contamina as vizinhas.
  linkCompletedJobToNarrationAudioTake('job_voz', narracaoAsset, db);
  linkCompletedJobToMusicTake('job_mus', musicaAsset, db);
  assert.equal(getNarrationAudioSelection('proj_a', 1, undefined, db).takeNumber, 1);
  assert.equal(getProductionMusicSelection('proj_a', 1, db).takeNumber, 1);
});

// ── 5 ── replaceProductionScenes ────────────────────────────────────────────

test('5. voz e efeito BLOQUEIAM a substituição; a música sobrevive a ela', () => {
  const db = banco();
  const novas = [1, 2].map((n) => ({
    ordinal: n, title: `Reescrita ${n}`, durationSeconds: 40, narration: 'n',
  }));

  // Só música: substituir é permitido, porque nada dela pende da cena.
  createProductionMusicCue('proj_a', { description: TEMA }, db);
  createProductionMusicTake('proj_a', 1, {}, db);
  assert.equal(replaceProductionScenes('proj_a', novas, db).length, 2);

  // E ela continua lá, intacta, com o take e tudo.
  assert.deepEqual(listProductionMusicCues('proj_a', db).map((c) => c.description), [TEMA]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_music_takes').get().n, 1);

  // Agora a cena ganha voz. A substituição passa a ser destruição, e é recusada.
  createNarrationAudioTake('proj_a', 1, {}, db);
  assert.throws(() => replaceProductionScenes('proj_a', novas, db), /já tem mídia/);

  // O mesmo vale para o efeito sozinho, num projeto que só tem ele.
  createSceneSfxCue('proj_b', 1, { description: TROVAO }, db);
  assert.throws(() => replaceProductionScenes('proj_b', novas, db), /já tem mídia/);
});

// ── 6 ── fronteira do projeto ───────────────────────────────────────────────

test('6. nada disso atravessa a fronteira do projeto', () => {
  const db = banco();
  producaoComOsTres(db);

  // O projeto vizinho não enxerga nada do primeiro.
  assert.deepEqual(listProductionMusicCues('proj_b', db), []);
  assert.equal(getProductionMusicSelection('proj_b', 1, db), null);
  assert.equal(getSceneSfxSelection('proj_b', 1, 1, db), null);
  assert.equal(getNarrationAudioSelection('proj_b', 1, undefined, db), null);

  // Apagar o projeto leva as três famílias junto, e só as dele.
  createProductionMusicCue('proj_b', { description: TEMA }, db);
  deleteProject('proj_a', db);

  for (const tabela of [
    'production_scene_audio_takes', 'production_scene_audio_selections',
    'production_scene_sfx_cues', 'production_scene_sfx_takes',
    'production_scene_sfx_selections',
  ]) {
    assert.equal(
      db.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0,
      `${tabela} deveria ter ido junto`,
    );
  }
  // A música do vizinho ficou — o CASCADE é por projeto, e não por tabela.
  assert.deepEqual(listProductionMusicCues('proj_b', db).map((c) => c.cueNumber), [1]);

  // E o banco continua íntegro depois de tudo isso.
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
});
