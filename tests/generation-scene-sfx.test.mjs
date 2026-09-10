// A geração do efeito sonoro de uma cue — a ordem, a proveniência e a seleção.
//
// PASSO 14-D1B. Nenhum teste aqui gera um segundo de áudio: o executor é
// injetado, e é isso que permite provar ORDEM e POLÍTICA sem GPU, sem ComfyUI e
// sem os 5 GB de pesos do Stable Audio.
//
// O que eles trancam:
//
//   registrar ANTES de submeter    o take nasce ligado ao job antes de o
//                                  executor ver qualquer coisa
//   o texto é o PERSISTIDO         o que vai ao provider é a descrição da cue,
//                                  e a impressão do take é a dela
//   seleção POR CUE                quatro casos, e cue nenhuma mexe na outra
//   a corrida da descrição         editar a cue no meio da geração não
//                                  reescreve nem apaga o que já começou
//   duas origens de `audio`        narração (Piper) e efeito (ComfyUI) convivem
//                                  no mesmo `kind` sem um roubar o outro
//   nada de segunda máquina        um livro-razão, uma tabela de Asset

import test from 'node:test';
import assert from 'node:assert/strict';

import { openDatabase, DomainError } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import {
  replaceProductionScenes, saveProductionPlan, saveProductionScript,
} from '../lib/server/domain/production.js';
import {
  createSceneSfxCue, getSceneSfxSelection, listSceneSfxTakes, sfxCueFingerprint,
  updateSceneSfxCue,
} from '../lib/server/domain/sceneSfx.js';
import {
  completeGenerationJob, getGenerationJobRecord,
} from '../lib/server/domain/generationJobs.js';
import { startSceneSfxGeneration, SFX_WORKFLOW_ID } from '../lib/server/generation/sceneSfx.js';
import { NARRATION_WORKFLOW_ID, reconcileNarrationJobs } from '../lib/server/generation/narration.js';
import { getWorkflow } from '../lib/server/generation/workflows/registry.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';

const PORTA = 'heavy metal door slamming shut, single impact, no speech, no music';
const PASSOS = 'fast footsteps on stone floor, no speech, no music';
const TROVAO = 'distant thunder rumbling during a storm, no speech, no music';

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

/** Um executor de mentira: registra o que lhe pediram e aceita o trabalho. */
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
    async anotarSubmissao() { /* o livro-razão já foi exercitado no 10.2 */ },
  };
}

/** Conclui um job como o caminho central faria, com um Asset de áudio real. */
function concluirCom(db, projectId, jobId, sufixo) {
  const asset = createAsset({
    projectId, kind: 'audio', jobId, filename: `efeito_${sufixo}.flac`,
    url: `/api/media/audio/${projectId}/efeito_${sufixo}.flac`, durationSeconds: 4,
  }, db);
  completeGenerationJob(jobId, { assetId: asset.id, db });
  return asset;
}

async function gerar(db, projectId, ordinal, cueNumber, executor = executorFake()) {
  return startSceneSfxGeneration(
    { projectId, ordinal, cueNumber, seconds: 4 },
    { db, deps: { submeter: executor.submeter, anotarSubmissao: executor.anotarSubmissao } },
  );
}

// ── A · B · C · D · E · F · G · a entrada e a ordem ────────────────────────

test('A. cue inexistente recusa antes de criar job', async () => {
  const db = banco();
  const executor = executorFake();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);

  await assert.rejects(
    () => gerar(db, 'proj_a', 1, 9, executor),
    (erro) => erro instanceof DomainError && /não tem um efeito 9/.test(erro.message),
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_sfx_takes').get().n, 0);
  assert.equal(executor.submissoes.length, 0);
  db.close();
});

test('B · C · D · E · F. a descrição vai ao executor, e o resto é do servidor', async () => {
  const db = banco();
  const executor = executorFake();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);

  const r = await gerar(db, 'proj_a', 1, 1, executor);

  // B. o texto submetido é EXATAMENTE a descrição persistida.
  assert.equal(executor.submissoes.length, 1);
  assert.equal(executor.submissoes[0].prompt, PORTA);
  assert.equal(executor.submissoes[0].workflowId, SFX_WORKFLOW_ID);

  // C · D. a impressão do take é a daquele texto, e não veio de fora.
  const take = listSceneSfxTakes('proj_a', 1, 1, db)[0];
  assert.equal(take.sourceCueFingerprint, sfxCueFingerprint(PORTA));
  assert.equal(r.sourceCueFingerprint, take.sourceCueFingerprint);

  // E. o número é do servidor.
  assert.equal(take.takeNumber, 1);

  // F. o job é de áudio.
  const job = getGenerationJobRecord(r.jobId, db);
  assert.equal(job.kind, 'audio');
  assert.equal(job.workflowId, SFX_WORKFLOW_ID);
  db.close();
});

test('G · H. o take existe ANTES do submit, e falhar em registrá-lo impede o executor', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);

  // G. no instante da submissão o take já existe e já aponta para o job.
  let noSubmit = null;
  const espiao = {
    submissoes: [],
    async submeter(params) {
      espiao.submissoes.push(params);
      noSubmit = listSceneSfxTakes('proj_a', 1, 1, db);
      return { promptId: 'p1', state: 'na-fila' };
    },
    async anotarSubmissao() {},
  };
  const r = await gerar(db, 'proj_a', 1, 1, espiao);
  assert.equal(noSubmit.length, 1);
  assert.equal(noSubmit[0].generationJobId, r.jobId);
  assert.equal(noSubmit[0].assetId, null);

  // H. com a cue no teto de takes, o registro falha e nada é submetido.
  const cue = db.prepare('SELECT id FROM production_scene_sfx_cues').get();
  const impressao = sfxCueFingerprint(PORTA);
  const insere = db.prepare(
    'INSERT INTO production_scene_sfx_takes (id, cueId, takeNumber, sourceCueFingerprint, '
    + 'createdAt, updatedAt) VALUES (?, ?, ?, ?, 1, 1)',
  );
  for (let n = 2; n <= 50; n += 1) insere.run(`t_${n}`, cue.id, n, impressao);

  const antes = espiao.submissoes.length;
  await assert.rejects(() => gerar(db, 'proj_a', 1, 1, espiao), DomainError);
  assert.equal(espiao.submissoes.length, antes, 'submeteu sem ter conseguido registrar');
  db.close();
});

// ── I · J · K · L · o resultado ────────────────────────────────────────────

test('I · J · K · L. conclusão cria Asset de áudio ligado ao take, sem linhagem', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const r = await gerar(db, 'proj_a', 1, 1);

  const asset = concluirCom(db, 'proj_a', r.jobId, 'a');
  const job = getGenerationJobRecord(r.jobId, db);
  const take = listSceneSfxTakes('proj_a', 1, 1, db)[0];

  assert.equal(job.state, 'done');
  assert.equal(asset.kind, 'audio');
  assert.equal(take.assetId, asset.id);
  assert.equal(take.generationJobId, r.jobId);
  assert.equal(asset.derivedFromAssetId, null);
  assert.equal(job.derivedFromAssetId, null);
  db.close();
});

// ── M · N · O · P · Q · a política, por cue ────────────────────────────────

test('M. CASO A — o primeiro take current da cue é escolhido sozinho', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const r = await gerar(db, 'proj_a', 1, 1);
  concluirCom(db, 'proj_a', r.jobId, 'a');

  const sel = getSceneSfxSelection('proj_a', 1, 1, db);
  assert.equal(sel.takeNumber, 1);
  assert.equal(sel.current, true);
  db.close();
});

test('N. CASO B — o segundo take da MESMA descrição não rouba a seleção', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const um = await gerar(db, 'proj_a', 1, 1);
  concluirCom(db, 'proj_a', um.jobId, 'a');
  const dois = await gerar(db, 'proj_a', 1, 1);
  concluirCom(db, 'proj_a', dois.jobId, 'b');

  assert.deepEqual(listSceneSfxTakes('proj_a', 1, 1, db).map((t) => t.takeNumber), [1, 2]);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).takeNumber, 1);
  db.close();
});

test('O. CASO C — escolha stale + take novo da descrição atual → o novo assume', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const um = await gerar(db, 'proj_a', 1, 1);
  concluirCom(db, 'proj_a', um.jobId, 'a');
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).takeNumber, 1);

  updateSceneSfxCue('proj_a', 1, 1, { description: TROVAO }, db);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).current, false);

  const dois = await gerar(db, 'proj_a', 1, 1);
  concluirCom(db, 'proj_a', dois.jobId, 'b');

  const sel = getSceneSfxSelection('proj_a', 1, 1, db);
  assert.equal(sel.takeNumber, 2);
  assert.equal(sel.current, true);
  db.close();
});

test('P · Q. CASO D — o take que ficou stale antes de concluir não é escolhido', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const r = await gerar(db, 'proj_a', 1, 1);

  // A descrição muda com o trabalho já submetido e ainda não concluído.
  updateSceneSfxCue('proj_a', 1, 1, { description: TROVAO }, db);
  concluirCom(db, 'proj_a', r.jobId, 'a');

  const take = listSceneSfxTakes('proj_a', 1, 1, db)[0];
  // Q. a impressão NÃO foi reescrita.
  assert.equal(take.sourceCueFingerprint, sfxCueFingerprint(PORTA));
  assert.notEqual(take.assetId, null, 'o Asset é válido');
  assert.equal(take.current, false);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db), null);
  db.close();
});

// ── §26 · a corrida completa ───────────────────────────────────────────────

test('§26. a corrida da descrição: F1 conclui velho, F2 nasce e assume', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);

  const g1 = await gerar(db, 'proj_a', 1, 1);
  updateSceneSfxCue('proj_a', 1, 1, { description: TROVAO }, db);
  concluirCom(db, 'proj_a', g1.jobId, 'f1');

  const f1 = listSceneSfxTakes('proj_a', 1, 1, db)[0];
  assert.notEqual(f1.assetId, null);
  assert.equal(f1.sourceCueFingerprint, sfxCueFingerprint(PORTA));
  assert.equal(f1.current, false);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db), null);

  const g2 = await gerar(db, 'proj_a', 1, 1);
  concluirCom(db, 'proj_a', g2.jobId, 'f2');

  const takes = listSceneSfxTakes('proj_a', 1, 1, db);
  assert.equal(takes.length, 2);
  assert.equal(takes[1].current, true);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).takeNumber, 2);
  // F1 permanece histórico, nem apagado nem reescrito.
  assert.equal(takes[0].sourceCueFingerprint, sfxCueFingerprint(PORTA));
  assert.notEqual(takes[0].assetId, null);
  db.close();
});

// ── R · S · a falha ────────────────────────────────────────────────────────

test('R · S. o executor recusa: take sem Asset, sem seleção, sem Asset falso', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);

  await assert.rejects(() => gerar(db, 'proj_a', 1, 1, executorFake({ falhar: true })));

  // O take permanece como evidência da tentativa, ligado ao job.
  const takes = listSceneSfxTakes('proj_a', 1, 1, db);
  assert.equal(takes.length, 1);
  assert.notEqual(takes[0].generationJobId, null);
  assert.equal(takes[0].assetId, null);

  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  db.close();
});

test('S2. uma falha depois de uma escolha não muda a escolha', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const bom = await gerar(db, 'proj_a', 1, 1);
  concluirCom(db, 'proj_a', bom.jobId, 'a');
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).takeNumber, 1);

  await assert.rejects(() => gerar(db, 'proj_a', 1, 1, executorFake({ falhar: true })));
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).takeNumber, 1);
  db.close();
});

// ── T · §20 · as cues são independentes ────────────────────────────────────

test('T · §20. três cues, três jobs, três Assets, três escolhas — sem interferência', async () => {
  const db = banco();
  for (const d of [PORTA, PASSOS, TROVAO]) {
    createSceneSfxCue('proj_a', 1, { description: d }, db);
  }

  const jobs = [];
  for (const cue of [1, 2, 3]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await gerar(db, 'proj_a', 1, cue);
    concluirCom(db, 'proj_a', r.jobId, `c${cue}`);
    jobs.push(r.jobId);
  }

  assert.equal(new Set(jobs).size, 3, 'jobs distintos');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets WHERE kind='audio'").get().n, 3);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_sfx_selections').get().n, 3);
  for (const cue of [1, 2, 3]) {
    assert.equal(getSceneSfxSelection('proj_a', 1, cue, db).takeNumber, 1);
  }

  // Editar a cue 1 não toca nas escolhas das outras duas.
  updateSceneSfxCue('proj_a', 1, 1, { description: 'outra porta' }, db);
  assert.equal(getSceneSfxSelection('proj_a', 1, 1, db).current, false);
  assert.equal(getSceneSfxSelection('proj_a', 1, 2, db).current, true);
  assert.equal(getSceneSfxSelection('proj_a', 1, 3, db).current, true);
  db.close();
});

// ── U · V · W · X · fronteiras ─────────────────────────────────────────────

test('U. cross-project bloqueado', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const r = await gerar(db, 'proj_a', 1, 1);
  concluirCom(db, 'proj_a', r.jobId, 'a');

  await assert.rejects(
    () => gerar(db, 'proj_b', 1, 1),
    (erro) => erro instanceof DomainError
      && /A cena 1 não tem um efeito 1\./.test(erro.message)
      && !/proj_a/.test(erro.message),
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM assets WHERE projectId='proj_b'").get().n, 0);
  db.close();
});

test('V. a superfície de domínio não devolve caminho de arquivo', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const r = await gerar(db, 'proj_a', 1, 1);
  concluirCom(db, 'proj_a', r.jobId, 'a');

  assert.equal(Object.keys(r).some((k) => /path|caminho|dir|file/i.test(k)), false);
  const asset = db.prepare("SELECT url, filename FROM assets WHERE kind='audio'").get();
  assert.match(asset.url, /^\/api\/media\/audio\//);
  assert.equal(/^\//.test(asset.filename), false);
  db.close();
});

test('W · X. nenhuma tabela paralela, e a pipeline visual segue visual', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const r = await gerar(db, 'proj_a', 1, 1);
  concluirCom(db, 'proj_a', r.jobId, 'a');

  const tabelas = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((t) => String(t.name));
  for (const proibida of ['sfx_jobs', 'sound_jobs', 'audio_jobs', 'sfx_assets', 'audio_assets']) {
    assert.equal(tabelas.includes(proibida), false, `tabela paralela: ${proibida}`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_media').get().n, 0);
  db.close();
});

// ── §30 · §31 · duas origens de `kind='audio'` ─────────────────────────────

test('§30. o roteamento distingue por WORKFLOW, não por kind', async () => {
  // O efeito resolve no registry do ComfyUI; a narração não resolve, porque
  // `narration-tts` não é grafo nenhum. É essa diferença que roteia.
  assert.equal(getWorkflow(SFX_WORKFLOW_ID).kind, 'audio');
  assert.throws(() => getWorkflow(NARRATION_WORKFLOW_ID), /Workflow desconhecido/);
  assert.notEqual(SFX_WORKFLOW_ID, NARRATION_WORKFLOW_ID);
});

test('§31. a reconciliação da narração NÃO marca um efeito vivo como órfão', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);

  // Um efeito submetido e ainda em voo — o ComfyUI está trabalhando nele.
  const sfx = await gerar(db, 'proj_a', 1, 1);
  assert.equal(getGenerationJobRecord(sfx.jobId, db).kind, 'audio');

  // E uma narração igualmente em voo, do Piper.
  const { startNarrationGeneration } = await import('../lib/server/generation/narration.js');
  const voz = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 },
    { db, deps: { provider: { async available() { return true; }, async synthesize() {} }, despachar: () => null } },
  );

  // O arranque do Piper varre o que é DELE. Se varresse por `kind='audio'`,
  // levaria o efeito junto — e o resultado que a GPU ainda vai entregar
  // chegaria a um job dado como perdido.
  const { orfaos } = reconcileNarrationJobs({ db });

  assert.deepEqual(orfaos, [voz.jobId], 'a reconciliação da voz pegou o que não era dela');
  assert.equal(getGenerationJobRecord(voz.jobId, db).state, 'orphaned');
  assert.notEqual(getGenerationJobRecord(sfx.jobId, db).state, 'orphaned');

  // E o take do efeito continua de pé, esperando a conclusão.
  const take = listSceneSfxTakes('proj_a', 1, 1, db)[0];
  assert.equal(take.generationJobId, sfx.jobId);
  assert.equal(take.assetId, null);
  db.close();
});

test('Y. recuperar não re-submete cegamente', async () => {
  const db = banco();
  createSceneSfxCue('proj_a', 1, { description: PORTA }, db);
  const executor = executorFake();
  await gerar(db, 'proj_a', 1, 1, executor);

  const antes = executor.submissoes.length;
  reconcileNarrationJobs({ db });
  assert.equal(executor.submissoes.length, antes, 'a recuperação gerou de novo por conta própria');
  assert.equal(listSceneSfxTakes('proj_a', 1, 1, db).length, 1, 'nasceu um take a mais');
  db.close();
});

test('Z. nenhuma Agent Tool de efeito, e Hermes intocado', () => {
  const publicadas = publicToolList(toolRegistry()).map((t) => t.name);
  for (const nome of publicadas) {
    assert.equal(
      /sfx|efeito|sound|music|musica|dialogue|foley|ambient|timeline|mix|audio|voice/i.test(nome)
      // PASSO 14-E: as tools `project.*` de áudio passaram a existir.
      && !nome.startsWith('project.'),
      false,
      `ferramenta criada cedo demais: ${nome}`,
    );
  }
});
