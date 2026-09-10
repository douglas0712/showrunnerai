// A geração da voz de uma cena — a ordem, a proveniência e a seleção.
//
// PASSO 14-C2. Nenhum teste aqui sintetiza um segundo de áudio: o provider é
// injetado, como manda o estilo da casa, e é isso que permite provar a ORDEM e
// a POLÍTICA sem depender de binário, de voz instalada ou de máquina.
//
// O que eles trancam:
//
//   registrar ANTES de submeter      o take nasce ligado ao job antes de o
//                                    provider ser chamado; se o registro
//                                    falhar, nada é sintetizado
//   o texto é o PERSISTIDO           o que vai ao provider é o parágrafo do
//                                    banco, e a impressão do take é a dele
//   selected ≠ current               a política de seleção automática tem
//                                    quatro casos, e todos moram num lugar só
//   a corrida do texto               editar a cena no meio da síntese não
//                                    reescreve nem apaga o que já começou
//   falha não inventa nada           sem Asset, sem seleção, sem take apagado
//   nada de segunda máquina          um livro-razão, uma tabela de Asset,
//                                    nenhuma ferramenta, nenhum TTS no teste

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { openDatabase, DomainError, ASSET_KINDS, SCENE_MEDIA_KINDS, AUDIO_ROLES } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import {
  replaceProductionScenes, saveProductionPlan, saveProductionScript,
  updateProductionScene,
} from '../lib/server/domain/production.js';
import { narrationFingerprint } from '../lib/server/domain/narration.js';
import {
  getNarrationAudioSelection, listNarrationAudioTakes,
} from '../lib/server/domain/sceneAudio.js';
import { getGenerationJobRecord } from '../lib/server/domain/generationJobs.js';
import {
  executarNarracao, reconcileNarrationJobs, startNarrationGeneration,
} from '../lib/server/generation/narration.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-narracao-'));
process.env.RUNTIME_ROOT = path.join(RAIZ, 'runtime');
test.after(async () => { await rm(RAIZ, { recursive: true, force: true }); });

const TEXTO_X = 'O trem chega vazio, e ninguém desce.';
const TEXTO_Y = 'O trem chega cheio, e ninguém sobe.';

/** Um WAV de verdade, pequeno, para o ffprobe ter o que abrir. */
const WAV = path.join(RAIZ, 'amostra.wav');
await (async () => {
  // 0,1 s de silêncio PCM 16 bits, 8 kHz, mono — um RIFF válido escrito à mão.
  const amostras = 800;
  const dados = Buffer.alloc(amostras * 2);
  const cab = Buffer.alloc(44);
  cab.write('RIFF', 0); cab.writeUInt32LE(36 + dados.length, 4); cab.write('WAVE', 8);
  cab.write('fmt ', 12); cab.writeUInt32LE(16, 16); cab.writeUInt16LE(1, 20);
  cab.writeUInt16LE(1, 22); cab.writeUInt32LE(8000, 24); cab.writeUInt32LE(16000, 28);
  cab.writeUInt16LE(2, 32); cab.writeUInt16LE(16, 34);
  cab.write('data', 36); cab.writeUInt32LE(dados.length, 40);
  await writeFile(WAV, Buffer.concat([cab, dados]));
})();

let contador = 0;
function banco(narracao = TEXTO_X) {
  contador += 1;
  const db = openDatabase(':memory:');
  for (const id of ['proj_a', 'proj_b']) {
    createProject({ id, name: `P ${id}` }, db);
    saveProductionPlan({ projectId: id, title: 'Plano', targetDurationSeconds: 80 }, db);
    saveProductionScript({ projectId: id, title: 'R', fullText: 'Texto.' }, db);
    replaceProductionScenes(id, [1, 2].map((n) => ({
      ordinal: n, title: `Cena ${n}`, durationSeconds: 40, narration: narracao,
    })), db);
  }
  return db;
}

/** Um provider que escreve um WAV real e registra o que lhe pediram. */
function providerFake({ falhar = false, aoSintetizar = null } = {}) {
  const chamadas = [];
  return {
    chamadas,
    name: 'fake',
    describe: () => ({ provider: 'fake', model: 'nenhum' }),
    async available() { return true; },
    async synthesize({ text, outputPath, language }) {
      chamadas.push({ text, outputPath, language });
      if (aoSintetizar) await aoSintetizar();
      if (falhar) throw new Error('o provider falhou de propósito');
      await copyFile(WAV, outputPath);
      return { path: outputPath, extension: '.wav' };
    },
  };
}

/** Espera o job chegar a um desfecho, sem segurar o turno. */
async function ateConcluir(db, jobId, teto = 5000) {
  for (let esperou = 0; esperou < teto; esperou += 10) {
    const job = getGenerationJobRecord(jobId, db);
    if (job && (job.state === 'done' || job.state === 'failed')) return job;
    await new Promise((r) => { setTimeout(r, 10); });
  }
  throw new Error(`o job ${jobId} não concluiu`);
}

// ── A · B · C · D · E · a entrada ──────────────────────────────────────────

test('A. narração vazia recusa ANTES de criar job, take ou trabalho externo', async () => {
  const db = banco();
  updateProductionScene('proj_a', 1, { narration: '' }, db);
  const provider = providerFake();

  await assert.rejects(
    () => startNarrationGeneration({ projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider } }),
    (erro) => erro instanceof DomainError
      && /não tem narração escrita para gravar uma voz/.test(erro.message),
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_audio_takes').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  assert.equal(provider.chamadas.length, 0, 'o provider foi chamado para texto vazio');
  db.close();
});

test('B · C · D · E. o texto vem do banco, e o chamador não escolhe nada', async () => {
  const db = banco();
  const provider = providerFake();

  // D · E. impressão e número de take vindos de fora são recusados pelo domínio.
  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 },
    { db, deps: { provider } },
  );
  await ateConcluir(db, r.jobId);

  // B. o texto sintetizado é EXATAMENTE o parágrafo persistido.
  assert.equal(provider.chamadas.length, 1);
  assert.equal(provider.chamadas[0].text, TEXTO_X);

  // C. e a impressão do take é a daquele texto.
  const take = listNarrationAudioTakes('proj_a', 1, 'narration', db)[0];
  assert.equal(take.sourceNarrationFingerprint, narrationFingerprint(TEXTO_X));

  // E. o número é do servidor.
  assert.equal(take.takeNumber, 1);
  db.close();
});

// ── F · G · H · a ordem ────────────────────────────────────────────────────

test('F · G. o job é de áudio, e o take existe ANTES de o provider ser chamado', async () => {
  const db = banco();
  const provider = providerFake();

  // `despachar` intercepta o instante entre registrar e submeter.
  let noDespacho = null;
  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 },
    {
      db,
      deps: {
        provider,
        despachar: (args) => {
          noDespacho = {
            takes: listNarrationAudioTakes('proj_a', 1, 'narration', db),
            job: getGenerationJobRecord(args.jobId, db),
          };
          return null;
        },
      },
    },
  );

  // F. kind = audio, e nenhum estado novo foi inventado.
  assert.equal(noDespacho.job.kind, 'audio');
  assert.equal(noDespacho.job.state, 'preparing');

  // G. o take já existe e já aponta para o job — antes de qualquer síntese.
  assert.equal(noDespacho.takes.length, 1);
  assert.equal(noDespacho.takes[0].generationJobId, r.jobId);
  assert.equal(noDespacho.takes[0].assetId, null);
  assert.equal(provider.chamadas.length, 0, 'o provider correu antes do registro');
  db.close();
});

test('H. se o registro do take falhar, nada é sintetizado', async () => {
  const db = banco();
  const provider = providerFake();

  // A cena 1 chega ao teto de takes: o próximo registro é recusado.
  const cena = db.prepare(
    'SELECT c.id FROM production_scenes c JOIN production_scripts s ON s.id = c.scriptId '
    + 'WHERE s.projectId = ? AND c.ordinal = 1',
  ).get('proj_a');
  const impressao = narrationFingerprint(TEXTO_X);
  const insere = db.prepare(
    'INSERT INTO production_scene_audio_takes (id, sceneId, role, takeNumber, '
    + 'sourceNarrationFingerprint, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, 1, 1)',
  );
  for (let n = 1; n <= 50; n += 1) insere.run(`t_${n}`, cena.id, 'narration', n, impressao);

  await assert.rejects(
    () => startNarrationGeneration({ projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider } }),
    (erro) => erro instanceof DomainError && /o limite é 50/.test(erro.message),
  );

  assert.equal(provider.chamadas.length, 0, 'sintetizou sem ter conseguido registrar');
  // E o job registrado antes fica num desfecho honesto, sem estado novo.
  const job = db.prepare('SELECT state FROM generation_jobs').get();
  assert.equal(job.state, 'failed');
  db.close();
});

// ── I · J · K · L · o resultado ────────────────────────────────────────────

test('I · J · K · L. conclusão cria Asset de áudio, ligado ao take, sem linhagem', async () => {
  const db = banco();
  const provider = providerFake();

  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider } },
  );
  const job = await ateConcluir(db, r.jobId);

  // I. Asset kind=audio.
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(job.assetId);
  assert.equal(asset.kind, 'audio');
  assert.ok(asset.durationSeconds > 0, 'a duração medida precisa ser real');

  // J. ligado ao take certo.
  const take = listNarrationAudioTakes('proj_a', 1, 'narration', db)[0];
  assert.equal(take.assetId, asset.id);
  assert.equal(take.generationJobId, r.jobId);

  // K · L. a voz nasce de TEXTO, e não de outro Asset.
  assert.equal(asset.derivedFromAssetId, null);
  assert.equal(job.derivedFromAssetId, null);
  db.close();
});

// ── M · N · O · P · a política de seleção ──────────────────────────────────

test('M. CASO A — o primeiro take current é escolhido sozinho', async () => {
  const db = banco();
  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake() } },
  );
  await ateConcluir(db, r.jobId);

  const sel = getNarrationAudioSelection('proj_a', 1, 'narration', db);
  assert.equal(sel.takeNumber, 1);
  assert.equal(sel.current, true);
  db.close();
});

test('N. CASO B — o segundo take do MESMO texto não rouba a seleção', async () => {
  const db = banco();
  const um = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake() } },
  );
  await ateConcluir(db, um.jobId);

  const dois = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake() } },
  );
  await ateConcluir(db, dois.jobId);

  // Os dois existem, e a escolha continua sendo a primeira.
  assert.deepEqual(
    listNarrationAudioTakes('proj_a', 1, 'narration', db).map((t) => t.takeNumber), [1, 2],
  );
  assert.equal(getNarrationAudioSelection('proj_a', 1, 'narration', db).takeNumber, 1);
  db.close();
});

test('O. CASO C — escolha stale + take novo do texto atual → o novo é escolhido', async () => {
  const db = banco();
  const um = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake() } },
  );
  await ateConcluir(db, um.jobId);
  assert.equal(getNarrationAudioSelection('proj_a', 1, 'narration', db).takeNumber, 1);

  // O texto muda: a escolha continua de pé, e passa a falar um texto antigo.
  updateProductionScene('proj_a', 1, { narration: TEXTO_Y }, db);
  const antes = getNarrationAudioSelection('proj_a', 1, 'narration', db);
  assert.equal(antes.takeNumber, 1);
  assert.equal(antes.current, false);

  const dois = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake() } },
  );
  await ateConcluir(db, dois.jobId);

  const depois = getNarrationAudioSelection('proj_a', 1, 'narration', db);
  assert.equal(depois.takeNumber, 2);
  assert.equal(depois.current, true);

  // E o take 1 continua existindo, histórico, com a impressão dele.
  const take1 = listNarrationAudioTakes('proj_a', 1, 'narration', db)[0];
  assert.equal(take1.sourceNarrationFingerprint, narrationFingerprint(TEXTO_X));
  assert.equal(take1.current, false);
  db.close();
});

test('P · Q. CASO D — o take que ficou stale ANTES de concluir não é escolhido', async () => {
  const db = banco();
  const provider = providerFake();

  // Começa a geração para X e só então intercepta o despacho, para editar a
  // cena com o trabalho já registrado e ainda não concluído.
  let trabalho = null;
  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 },
    { db, deps: { provider, despachar: (args) => { trabalho = args; return null; } } },
  );

  const antesDaEdicao = listNarrationAudioTakes('proj_a', 1, 'narration', db)[0];
  assert.equal(antesDaEdicao.sourceNarrationFingerprint, narrationFingerprint(TEXTO_X));

  // O usuário edita a cena no meio do caminho.
  updateProductionScene('proj_a', 1, { narration: TEXTO_Y }, db);

  // E só agora a síntese termina.
  await executarNarracao(trabalho);
  await ateConcluir(db, r.jobId);

  const take = listNarrationAudioTakes('proj_a', 1, 'narration', db)[0];

  // Q. a impressão do take NÃO foi reescrita.
  assert.equal(take.sourceNarrationFingerprint, narrationFingerprint(TEXTO_X));
  // Tem Asset — é um take legítimo…
  assert.notEqual(take.assetId, null);
  // …mas nasceu velho, e não vira a voz da cena.
  assert.equal(take.current, false);
  assert.equal(getNarrationAudioSelection('proj_a', 1, 'narration', db), null);
  db.close();
});

// ── §29 · a corrida completa X → Y ─────────────────────────────────────────

test('§29. a corrida do texto: F1 conclui velho, F2 nasce e assume', async () => {
  const db = banco();

  // 1. geração para X, interceptada antes de concluir.
  let trabalhoF1 = null;
  const g1 = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 },
    { db, deps: { provider: providerFake(), despachar: (a) => { trabalhoF1 = a; return null; } } },
  );

  // 2. o texto muda ENQUANTO a síntese está em voo.
  updateProductionScene('proj_a', 1, { narration: TEXTO_Y }, db);

  // 3. o trabalho de F1 termina.
  await executarNarracao(trabalhoF1);
  await ateConcluir(db, g1.jobId);

  const f1 = listNarrationAudioTakes('proj_a', 1, 'narration', db)[0];
  assert.notEqual(f1.assetId, null, 'Asset válido');
  assert.equal(f1.sourceNarrationFingerprint, narrationFingerprint(TEXTO_X));
  assert.equal(f1.current, false, 'stale para a narração atual');
  assert.equal(getNarrationAudioSelection('proj_a', 1, 'narration', db), null, 'não selecionado');

  // 4. agora uma geração para Y.
  const g2 = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake() } },
  );
  await ateConcluir(db, g2.jobId);

  const takes = listNarrationAudioTakes('proj_a', 1, 'narration', db);
  assert.equal(takes.length, 2);
  assert.equal(takes[1].current, true);
  assert.equal(getNarrationAudioSelection('proj_a', 1, 'narration', db).takeNumber, 2);

  // F1 continua histórico — nem apagado, nem reescrito.
  assert.equal(takes[0].sourceNarrationFingerprint, narrationFingerprint(TEXTO_X));
  assert.notEqual(takes[0].assetId, null);
  db.close();
});

// ── R · S · a falha ────────────────────────────────────────────────────────

test('R · S. o provider falha: take sem Asset, sem seleção, sem Asset falso', async () => {
  const db = banco();

  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake({ falhar: true }) } },
  );
  const job = await ateConcluir(db, r.jobId);

  assert.equal(job.state, 'failed');
  assert.equal(job.assetId, null);
  // A mensagem pública não cita provider nenhum.
  assert.equal(/fake|piper|de propósito/i.test(String(job.error)), false, job.error);

  // O take permanece como evidência da tentativa.
  const take = listNarrationAudioTakes('proj_a', 1, 'narration', db)[0];
  assert.equal(take.generationJobId, r.jobId);
  assert.equal(take.assetId, null);

  // Nada foi selecionado, e nenhum Asset nasceu.
  assert.equal(getNarrationAudioSelection('proj_a', 1, 'narration', db), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  db.close();
});

test('S2. uma falha depois de uma escolha não muda a escolha', async () => {
  const db = banco();
  const bom = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake() } },
  );
  await ateConcluir(db, bom.jobId);
  assert.equal(getNarrationAudioSelection('proj_a', 1, 'narration', db).takeNumber, 1);

  const ruim = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake({ falhar: true }) } },
  );
  await ateConcluir(db, ruim.jobId);

  assert.equal(getNarrationAudioSelection('proj_a', 1, 'narration', db).takeNumber, 1);
  db.close();
});

// ── T · U · V · W · X · Y · Z · fronteiras e ausências ─────────────────────

test('T. cross-project: a cena de outro projeto não existe daqui', async () => {
  const db = banco();
  const provider = providerFake();

  await assert.rejects(
    () => startNarrationGeneration({ projectId: 'proj_a', ordinal: 99 }, { db, deps: { provider } }),
    (erro) => erro instanceof DomainError && /não tem uma cena 99/.test(erro.message),
  );

  // Gerar no A não deixa nada no B.
  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider } },
  );
  await ateConcluir(db, r.jobId);

  assert.deepEqual(listNarrationAudioTakes('proj_b', 1, 'narration', db), []);
  assert.equal(getNarrationAudioSelection('proj_b', 1, 'narration', db), null);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM assets WHERE projectId = 'proj_b'").get().n, 0,
  );
  db.close();
});

test('U. a superfície de domínio não devolve caminho de arquivo', async () => {
  const db = banco();
  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake() } },
  );
  await ateConcluir(db, r.jobId);

  // O retorno do start não carrega caminho nenhum.
  assert.equal(Object.keys(r).some((k) => /path|caminho|dir|file/i.test(k)), false);

  // E o Asset serve por URL da aplicação, nunca por caminho de disco.
  const asset = db.prepare("SELECT url, filename FROM assets WHERE kind = 'audio'").get();
  assert.match(asset.url, /^\/api\/media\/audio\//);
  assert.equal(/^\//.test(asset.filename), false, 'filename virou caminho');
  assert.equal(asset.url.includes(RAIZ), false, 'a raiz do runtime vazou na URL');
  db.close();
});

test('V · W. nenhuma tabela paralela, e a pipeline visual segue visual', async () => {
  const db = banco();
  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 }, { db, deps: { provider: providerFake() } },
  );
  await ateConcluir(db, r.jobId);

  // V. um livro-razão, uma tabela de Asset.
  const tabelas = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
  ).all().map((t) => String(t.name));
  for (const proibida of ['tts_jobs', 'audio_jobs', 'voice_jobs', 'audio_assets']) {
    assert.equal(tabelas.includes(proibida), false, `tabela paralela criada: ${proibida}`);
  }
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE kind='audio'").get().n, 1);

  // W. `production_scene_media` continua sem áudio.
  assert.deepEqual([...SCENE_MEDIA_KINDS], ['image', 'video']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_media').get().n, 0);
  assert.deepEqual([...AUDIO_ROLES], ['narration']);
  assert.ok(ASSET_KINDS.includes('audio'));
  db.close();
});

test('X. reinício: a narração em voo vira órfã, e NUNCA é regerada sozinha', async () => {
  const db = banco();
  const provider = providerFake();

  // Uma geração registrada e não concluída — o processo "morreu" aqui.
  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 },
    { db, deps: { provider, despachar: () => null } },
  );

  const { orfaos } = reconcileNarrationJobs({ db });
  assert.deepEqual(orfaos, [r.jobId]);

  const job = getGenerationJobRecord(r.jobId, db);
  assert.equal(job.state, 'orphaned');
  assert.equal(job.assetId, null);

  // Nada foi re-submetido: o provider continua sem ter sido chamado.
  assert.equal(provider.chamadas.length, 0, 'o arranque regerou por conta própria');

  // O take permanece, como evidência da tentativa.
  const take = listNarrationAudioTakes('proj_a', 1, 'narration', db)[0];
  assert.equal(take.generationJobId, r.jobId);
  assert.equal(take.assetId, null);
  assert.equal(getNarrationAudioSelection('proj_a', 1, 'narration', db), null);

  // E rodar de novo não muda nada — a reconciliação é idempotente.
  assert.deepEqual(reconcileNarrationJobs({ db }).orfaos, []);
  db.close();
});

test('Y. a conclusão não depende de quem começou estar vivo', async () => {
  const db = banco();

  // Ninguém observa: o despacho é interceptado e o trabalho corre depois,
  // como se outro processo o tivesse retomado.
  let trabalho = null;
  const r = await startNarrationGeneration(
    { projectId: 'proj_a', ordinal: 1 },
    { db, deps: { provider: providerFake(), despachar: (a) => { trabalho = a; return null; } } },
  );

  await executarNarracao(trabalho);

  const job = getGenerationJobRecord(r.jobId, db);
  assert.equal(job.state, 'done');
  const take = listNarrationAudioTakes('proj_a', 1, 'narration', db)[0];
  assert.equal(take.assetId, job.assetId);
  assert.equal(getNarrationAudioSelection('proj_a', 1, 'narration', db).takeNumber, 1);
  db.close();
});

// ── o sintetizador é CONFIGURADO, nunca adivinhado ─────────────────────────

test('config. sem PIPER_HOME o sintetizador recusa cedo, e não procura sozinho', async () => {
  const { piperHome, piperDisponivel, piperProvider } = await import('../lib/server/tts/piper.js');
  const { TtsError } = await import('../lib/server/tts/provider.js');

  const guardado = process.env.PIPER_HOME;
  delete process.env.PIPER_HOME;
  try {
    // Não há palpite: sem configuração, o Showrunner diz que não sabe.
    assert.equal(piperHome(), null);
    assert.equal(await piperDisponivel(), false);

    // E construir o provider não explode — quem responde é `available()`.
    const provider = piperProvider();
    assert.equal(await provider.available(), false);

    // A recusa é acionável e nomeia o que falta, sem citar sintetizador nenhum
    // na mensagem pública.
    await assert.rejects(
      () => provider.synthesize({ text: 'oi', outputPath: path.join(RAIZ, 'x.wav') }),
      (erro) => erro instanceof TtsError
        && /não está configurado/.test(erro.message)
        && erro.detail.variavel === 'PIPER_HOME',
    );
  } finally {
    if (guardado === undefined) delete process.env.PIPER_HOME;
    else process.env.PIPER_HOME = guardado;
  }
});

test('config. nenhum caminho pessoal no código de produção', async () => {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const raizRepo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

  for (const arquivo of [
    'lib/server/tts/piper.js',
    'lib/server/tts/provider.js',
    'lib/server/generation/narration.js',
  ]) {
    const codigo = await readFile(path.join(raizRepo, arquivo), 'utf8');
    // Um caminho absoluto de diretório pessoal é uma dependência invisível de
    // UMA máquina: funciona aqui e falha em toda outra, sem dizer por quê.
    assert.equal(/\/home\/[a-z]/i.test(codigo), false, `${arquivo} tem caminho pessoal`);
    assert.equal(/JARVIS/i.test(codigo), false, `${arquivo} cita uma instalação de fora`);
  }
});

test('Z. nenhuma Agent Tool, nenhum Hermes, nenhum TTS no teste', () => {
  const publicadas = publicToolList(toolRegistry()).map((t) => t.name);
  for (const nome of publicadas) {
    assert.equal(
      /audio|voice|voz|tts|speech|narration|narracao|music|sfx|dialogue/i.test(nome)
      // PASSO 14-E: as tools `project.*` de áudio passaram a existir.
      && !nome.startsWith('project.'),
      false,
      `ferramenta de áudio criada cedo demais: ${nome}`,
    );
  }
  // O PASSO 14-E criou a ferramenta de narração — e este teste previa a própria
  // queda. O que ele tranca agora é que a superfície continua sendo de PRODUÇÃO:
  // uma ferramenta genérica de áudio misturaria as três cardinalidades num
  // parâmetro, que é justamente o que as famílias separadas evitam.
  assert.equal(publicadas.includes('project.generate_scene_narration'), true);
  assert.equal(publicadas.includes('project.generate_scene_audio'), false);
  assert.equal(publicadas.includes('audio.generate'), false);
});
