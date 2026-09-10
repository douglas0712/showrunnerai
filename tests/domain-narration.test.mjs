// O contrato da narração — o texto narrado de uma cena, e a impressão dele.
//
// PASSO 14-A. Não há áudio aqui, e é metade do que estes testes trancam. O que
// eles afirmam:
//
//   a narração É estado do Project      `production_scenes.narration`, e não
//                                       uma segunda entidade que repetiria o
//                                       mesmo parágrafo
//   ela sobrevive ao processo           reabrir o banco devolve o mesmo texto
//   ela se edita por update_scene       a forma canônica continua sendo essa;
//                                       nenhuma ferramenta nova foi criada
//   vazia é legítima                    uma cena pode ser só imagem, música ou
//                                       silêncio
//   a impressão é do TEXTO GRAVADO      mesmo texto, mesma impressão; texto
//                                       outro, impressão outra — e ela sai do
//                                       banco, nunca de um argumento
//   nada de áudio nasceu                nenhum Asset, nenhum job, nenhum
//                                       `kind` novo, nenhuma migração
//
// A última linha é a que impede o passo de crescer sozinho: preparar o domínio
// para TTS não é começar a fazer TTS.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ASSET_KINDS, ESQUEMA_ATUAL, closeDatabase, openDatabase, schemaVersion,
} from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import {
  getProductionScene, listProductionScenes, replaceProductionScenes,
  saveProductionPlan, saveProductionScript, updateProductionScene,
} from '../lib/server/domain/production.js';
import {
  narrationFingerprint, sceneNarration,
} from '../lib/server/domain/narration.js';
import { listAssets } from '../lib/server/domain/assets.js';
import { updateSceneTool } from '../lib/server/agent/tools/handlers/productionScenes.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';

const CHAVE = Symbol.for('showrunner.domain.db');

/** Quatro cenas somando 120 s — a terceira, de propósito, sem narração. */
function quatroCenas() {
  return [
    {
      ordinal: 1, title: 'O Olimpo', purpose: 'Situar o mundo dos deuses',
      durationSeconds: 30, narration: 'No alto do Olimpo, o fogo era privilégio.',
      visualDescription: 'Plano geral do Monte Olimpo ao amanhecer.',
    },
    {
      ordinal: 2, title: 'O roubo', purpose: 'O ato que muda tudo',
      durationSeconds: 30, narration: 'Prometeu desceu com a brasa escondida.',
      visualDescription: 'Close na brasa dentro do caule oco.',
    },
    {
      // Sem narração: a cena é só imagem e música. Ver o teste D.
      ordinal: 3, title: 'A punição', purpose: 'O preço, em silêncio',
      durationSeconds: 30,
      visualDescription: 'Plano aberto da rocha, a águia em silhueta.',
    },
    {
      ordinal: 4, title: 'A libertação', purpose: 'Fechar o arco',
      durationSeconds: 30, narration: 'Héracles quebrou as correntes.',
      visualDescription: 'Contra-luz, as correntes caindo em câmera lenta.',
    },
  ];
}

function comProducao(db, projectId = 'proj_a') {
  saveProductionPlan({
    projectId,
    title: 'Prometeu — o fogo da humanidade',
    logline: 'O titã que roubou o fogo dos deuses e pagou por isso.',
    format: 'minidocumentário',
    targetDurationSeconds: 120,
  }, db);
  saveProductionScript({
    projectId, title: 'Prometeu', summary: 'Quatro movimentos.',
    fullText: 'ABERTURA. O Olimpo ao amanhecer...',
  }, db);
  return replaceProductionScenes(projectId, quatroCenas(), db);
}

function banco() {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_a', name: 'Produção A' }, db);
  createProject({ id: 'proj_b', name: 'Produção B' }, db);
  return db;
}

// ── A · a narração é estado do Project ──────────────────────────────────────

test('A. a narração da cena é gravada, e é ela que sceneNarration devolve', () => {
  const db = banco();
  comProducao(db);

  const narracao = sceneNarration('proj_a', 2, db);
  assert.equal(narracao.ordinal, 2);
  assert.equal(narracao.text, 'Prometeu desceu com a brasa escondida.');
  assert.equal(narracao.hasNarration, true);

  // A fonte da verdade é a COLUNA da cena: o que o helper devolve é o que está
  // gravado, e não uma segunda cópia que pudesse discordar.
  assert.equal(narracao.text, getProductionScene('proj_a', 2, db).narration);
});

// ── B · ela sobrevive ao processo ───────────────────────────────────────────

test('B. reabrir o banco preserva a narração e a impressão dela', async () => {
  const pasta = await mkdtemp(path.join(tmpdir(), 'narracao-'));
  const arquivo = path.join(pasta, 'showrunner.db');

  try {
    const db = openDatabase(arquivo);
    createProject({ id: 'proj_a', name: 'Produção A' }, db);
    comProducao(db);
    const antes = sceneNarration('proj_a', 2, db);
    db.close();

    // Outro processo, outra conexão: nada da conversa anterior sobrevive além
    // do que está no arquivo. É o teste de "durável" que importa.
    const db2 = openDatabase(arquivo);
    const depois = sceneNarration('proj_a', 2, db2);
    assert.equal(depois.text, antes.text);
    assert.equal(depois.fingerprint, antes.fingerprint);
    db2.close();
  } finally {
    await rm(pasta, { recursive: true, force: true });
  }
});

// ── C · a edição continua sendo update_scene ────────────────────────────────

test('C. update_scene altera a narração de uma cena e não toca nas outras', async () => {
  closeDatabase();
  const db = openDatabase(':memory:');
  globalThis[CHAVE] = db;

  try {
    createProject({ id: 'proj_a', name: 'Produção A' }, db);
    comProducao(db);
    const thread = createThreadRecord({ projectId: 'proj_a', title: 'A' }, db);
    const ctx = {
      threadId: thread.id, projectId: 'proj_a', userMessageId: null, signal: null,
    };
    const antes = listProductionScenes('proj_a', db);

    await updateSceneTool.execute(ctx, {
      ordinal: 2,
      narration: 'Prometeu desceu com a brasa escondida no caule — e o mundo mudou.',
    });

    const depois = listProductionScenes('proj_a', db);
    assert.match(depois[1].narration, /o mundo mudou/);

    // As outras cenas não foram reescritas: nem o texto, nem a identidade —
    // "mude a cena 2" não pode significar "regrave o roteiro".
    for (const i of [0, 2, 3]) {
      assert.equal(depois[i].narration, antes[i].narration);
      assert.equal(depois[i].id, antes[i].id);
      assert.equal(depois[i].updatedAt, antes[i].updatedAt);
    }

    // E a impressão acompanha a edição, porque ela é lida do que ficou gravado.
    assert.notEqual(
      sceneNarration('proj_a', 2, db).fingerprint,
      narrationFingerprint(antes[1].narration),
    );
  } finally {
    closeDatabase();
    delete globalThis[CHAVE];
  }
});

// ── D · vazia é legítima ────────────────────────────────────────────────────

test('D. uma cena pode não ter narração — e isso não é erro', () => {
  const db = banco();
  comProducao(db);

  const muda = sceneNarration('proj_a', 3, db);
  assert.equal(muda.text, '');
  assert.equal(muda.hasNarration, false);

  // Sem texto não há impressão. O hash da string vazia seria estável e inútil:
  // um áudio futuro poderia alegar ter saído de um texto que nunca existiu.
  assert.equal(muda.fingerprint, null);

  // E esvaziar uma narração existente continua sendo uma edição válida.
  updateProductionScene('proj_a', 2, { narration: '' }, db);
  const esvaziada = sceneNarration('proj_a', 2, db);
  assert.equal(esvaziada.hasNarration, false);
  assert.equal(esvaziada.fingerprint, null);
});

// ── E · F · G · a impressão ─────────────────────────────────────────────────

test('E. a impressão é determinística e provider-neutral', () => {
  const texto = 'Prometeu observava a humanidade.';
  const impressao = narrationFingerprint(texto);

  assert.match(impressao, /^[0-9a-f]{64}$/);
  assert.equal(impressao, narrationFingerprint(texto));
  assert.equal(impressao, createHash('sha256').update(texto, 'utf8').digest('hex'));

  // Duas leituras do mesmo estado dão a mesma resposta.
  const db = banco();
  comProducao(db);
  assert.equal(
    sceneNarration('proj_a', 1, db).fingerprint,
    sceneNarration('proj_a', 1, db).fingerprint,
  );
});

test('F. mudar a narração muda a impressão', () => {
  const db = banco();
  comProducao(db);

  const antes = sceneNarration('proj_a', 1, db).fingerprint;
  updateProductionScene('proj_a', 1, {
    narration: 'No alto do Olimpo, o fogo era privilégio dos deuses.',
  }, db);
  const depois = sceneNarration('proj_a', 1, db).fingerprint;

  assert.notEqual(depois, antes);

  // E mudar OUTRO campo não mexe na impressão: ela é do texto narrado, e de
  // mais nada. É o que permitirá perguntar "a voz está velha?" sem que uma
  // troca de título responda que sim.
  updateProductionScene('proj_a', 1, { title: 'O Olimpo, ao amanhecer' }, db);
  assert.equal(sceneNarration('proj_a', 1, db).fingerprint, depois);
});

test('G. a impressão sai do texto PERSISTIDO, não do que o chamador tinha na mão', () => {
  const db = banco();
  comProducao(db);

  // A gravação normaliza o texto (aqui, aparando o entorno). A impressão é do
  // que FICOU no banco — se ela fosse calculada sobre o argumento cru, um
  // áudio gerado depois nunca casaria com a cena de onde saiu.
  const cru = '   Prometeu observava a humanidade.   ';
  updateProductionScene('proj_a', 4, { narration: cru }, db);

  const gravado = getProductionScene('proj_a', 4, db).narration;
  assert.equal(gravado, 'Prometeu observava a humanidade.');

  const narracao = sceneNarration('proj_a', 4, db);
  assert.equal(narracao.fingerprint, narrationFingerprint(gravado));
  assert.notEqual(narracao.fingerprint, narrationFingerprint(cru));

  // E não há por onde injetar um hash: depois do endereço só vem a conexão.
  // Um valor a mais é ignorado — o servidor calcula, ninguém informa.
  const forjado = 'f'.repeat(64);
  assert.equal(
    sceneNarration('proj_a', 4, db, forjado).fingerprint,
    narracao.fingerprint,
  );
});

// ── H · cross-project ───────────────────────────────────────────────────────

test('H. a narração de um projeto não é alcançável a partir de outro', () => {
  const db = banco();
  comProducao(db, 'proj_a');

  // O projeto B não tem cena 2 — nem cena nenhuma. A resposta é a mesma que
  // para uma posição inexistente: `null`, sem contar nada sobre o projeto A.
  assert.equal(sceneNarration('proj_b', 2, db), null);
  assert.equal(sceneNarration('proj_a', 99, db), null);

  // E o endereço é projeto + posição: não existe argumento por onde passar o
  // `id` de uma cena de outro projeto.
  const cenaDoA = getProductionScene('proj_a', 2, db);
  assert.equal(sceneNarration('proj_b', cenaDoA.ordinal, db), null);
});

// ── I · J · K · L · o que este passo NÃO fez ────────────────────────────────

test('I. ler e editar narração não cria Asset nenhum', () => {
  const db = banco();
  comProducao(db);

  sceneNarration('proj_a', 1, db);
  updateProductionScene('proj_a', 1, { narration: 'Outro texto.' }, db);
  sceneNarration('proj_a', 1, db);

  assert.equal(listAssets({ projectId: 'proj_a' }, db).length, 0);

  // E o vocabulário de mídia continua o que era: áudio não é um `kind` ainda,
  // e decidir se será é do 14-B.
  assert.deepEqual([...ASSET_KINDS], ['image', 'video']);
});

test('J. ler e editar narração não cria geração nenhuma', () => {
  const db = banco();
  comProducao(db);

  sceneNarration('proj_a', 2, db);
  updateProductionScene('proj_a', 2, { narration: 'Outro texto ainda.' }, db);

  const jobs = db.prepare('SELECT COUNT(*) AS total FROM generation_jobs').get();
  assert.equal(Number(jobs.total), 0);

  const takes = db.prepare('SELECT COUNT(*) AS total FROM production_scene_media').get();
  assert.equal(Number(takes.total), 0);
});

test('K. nenhuma ferramenta nova — a narração se edita por update_scene', () => {
  const publicadas = publicToolList(toolRegistry()).map((t) => t.name);

  for (const nome of publicadas) {
    assert.equal(/narration|narracao|audio|voice|tts|speech/i.test(nome), false,
      `ferramenta de áudio/narração criada cedo demais: ${nome}`);
  }

  // A forma canônica de mudar a narração continua sendo a que já existia.
  assert.ok(publicadas.includes('project.update_scene'));
  const edicao = publicadas.filter((n) => n === 'project.update_narration');
  assert.deepEqual(edicao, []);

  assert.ok(
    Object.keys(updateSceneTool.inputSchema.properties).includes('narration'),
    'update_scene precisa continuar aceitando narration',
  );
});

test('L. nenhuma migração nova: a narração já tinha onde morar', () => {
  const db = banco();

  assert.equal(schemaVersion(db), ESQUEMA_ATUAL);
  assert.equal(ESQUEMA_ATUAL, 10);

  // A coluna é a do PASSO 12, na tabela da cena. Se um dia alguém criar uma
  // tabela de narração, este teste é o que pergunta por quê.
  const tabelas = db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  ).all().map((l) => String(l.name));
  assert.equal(tabelas.some((n) => /narration|narracao|audio/i.test(n)), false);

  const colunas = db.prepare('PRAGMA table_info(production_scenes)')
    .all().map((l) => String(l.name));
  assert.ok(colunas.includes('narration'));
});
