// A voz de uma cena — os takes de narração, a seleção, e a proveniência.
//
// PASSO 14-B. Não há áudio aqui, e é metade do que estes testes trancam. O que
// eles afirmam:
//
//   um take é uma LINHA                 regravar acrescenta; nunca sobrescreve
//   o número é do SERVIDOR              e o chamador é RECUSADO se o mandar
//   a impressão é do TEXTO GRAVADO      calculada da cena, nunca de um
//                                       argumento, e imutável depois disso
//   editar a narração não mexe em take  nem apaga, nem reescreve, nem
//                                       reseleciona — o histórico continua
//                                       dizendo a verdade sobre a sua origem
//   selected ≠ current                  a escolha permanece, e o domínio
//                                       consegue dizer que ela ficou para trás
//   narração vazia não vira voz         "não há o que narrar" é a ausência de
//                                       uma impressão, não a impressão de nada
//   cross-project é impossível          não há identificador para carregar
//   replace_scenes recusa               voz gravada também é trabalho feito
//   nada de áudio nasceu                nenhum Asset, nenhum job, nenhum
//                                       `kind` novo, nenhuma ferramenta
//
// A última linha é a que impede o passo de crescer sozinho: preparar o domínio
// para TTS não é começar a fazer TTS.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ASSET_KINDS, AUDIO_ROLES, DomainError, ESQUEMA_ATUAL, openDatabase,
  SCENE_MEDIA_KINDS, schemaVersion,
} from '../lib/server/domain/db.js';
import { createProject, deleteProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import { createSceneRecord, listScenes } from '../lib/server/domain/scenes.js';
import { createProjectDocument } from '../lib/server/domain/documents.js';
import { DOCUMENT_TYPES } from '../lib/server/domain/documentTypes.js';
import { narrationFingerprint, sceneNarration } from '../lib/server/domain/narration.js';
import {
  getProductionScene, listProductionScenes, replaceProductionScenes,
  saveProductionPlan, saveProductionScript, updateProductionScene,
} from '../lib/server/domain/production.js';
import { createSceneTake, listSceneTakes } from '../lib/server/domain/sceneMedia.js';
import {
  createNarrationAudioTake, declaredNarrationAudioTakeFields,
  getNarrationAudioSelection, getNarrationAudioTake, listNarrationAudioTakes,
  MAX_AUDIO_TAKES_POR_CENA, narrationAudioTakeFreshness,
  NARRATION_ROLE, publicNarrationAudioTake, SCENE_AUDIO_ROLES,
  selectNarrationAudioTake,
} from '../lib/server/domain/sceneAudio.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';

const SHA = 'd'.repeat(64);

const TEXTO_1 = 'O trem chega vazio, e ninguém desce.';
const TEXTO_2 = 'O trem chega cheio, e ninguém sobe.';

/** As três cenas de um roteiro de 120 s, cada uma com narração escrita. */
function tresCenas(prefixo = 'Cena') {
  return [1, 2, 3].map((n) => ({
    ordinal: n,
    title: `${prefixo} ${n}`,
    purpose: 'Contar a passagem do tempo.',
    durationSeconds: 40,
    narration: `${TEXTO_1} (${n})`,
    visualDescription: 'Plataforma vazia, luz fria.',
  }));
}

function comCenas(db, projectId, quantas = 3) {
  saveProductionPlan({
    projectId, title: 'Plano', targetDurationSeconds: quantas * 40,
  }, db);
  saveProductionScript({
    projectId, title: 'Roteiro', fullText: 'Texto do roteiro.',
  }, db);
  replaceProductionScenes(projectId, tresCenas().slice(0, quantas), db);
}

/** Um banco com dois projetos, cada um com roteiro de três cenas narradas. */
function banco() {
  const db = openDatabase(':memory:');
  for (const [id, nome] of [['proj_a', 'Produção A'], ['proj_b', 'Produção B']]) {
    createProject({ id, name: nome }, db);
    comCenas(db, id);
  }
  return db;
}

function colunas(db, tabela) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().map((c) => c.name);
}

// ── A · B · C · D · E · F · a migração 10 → 11 ──────────────────────────────

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-scene-audio-'));
test.after(async () => { await rm(RAIZ, { recursive: true, force: true }); });

test('A · B · C · D. a migração 10 → 11 preserva tudo o que já estava no banco', async () => {
  const caminho = path.join(RAIZ, 'migracao.db');

  const primeira = openDatabase(caminho);
  assert.equal(schemaVersion(primeira), ESQUEMA_ATUAL);

  // A. um projeto.
  createProject({ id: 'proj_antigo', name: 'Existia antes' }, primeira);
  const cenaLegada = createSceneRecord({
    projectId: 'proj_antigo', title: 'Cena do storyboard', duration: 6,
  }, primeira);
  createProjectDocument({
    projectId: 'proj_antigo', filename: 'antigo.txt', mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 10, sha256: SHA, chunks: [{ text: 'material antigo' }],
  }, primeira);

  // B. plano, roteiro e cenas de produção.
  comCenas(primeira, 'proj_antigo', 2);

  // D. Assets que já existiam, de imagem e de vídeo.
  const imagem = createAsset({
    projectId: 'proj_antigo', kind: 'image', filename: 'antiga.png',
  }, primeira);
  const video = createAsset({
    projectId: 'proj_antigo', kind: 'video', filename: 'antigo.mp4',
  }, primeira);

  // C. SceneMedia visual, com seleção.
  const takeVisual = createSceneTake(
    'proj_antigo', 1, { kind: 'image', assetId: imagem.id }, primeira,
  );

  // Volta ao 10 à força, como um banco que nunca viu a migração 11.
  primeira.exec('DROP TABLE production_scene_audio_selections');
  primeira.exec('DROP TABLE production_scene_audio_takes');
  primeira.exec('PRAGMA user_version = 10');
  primeira.close();

  // Reabrir aplica só o que falta.
  const segunda = openDatabase(caminho);
  assert.equal(schemaVersion(segunda), ESQUEMA_ATUAL);

  // A. o projeto continua lá.
  assert.equal(
    segunda.prepare('SELECT name FROM projects WHERE id = ?').get('proj_antigo').name,
    'Existia antes',
  );
  assert.deepEqual(listScenes('proj_antigo', segunda).map((c) => c.id), [cenaLegada.id]);
  assert.equal(segunda.prepare('SELECT COUNT(*) AS n FROM project_documents').get().n, 1);

  // B. o planejamento inteiro continua lá, com a narração intacta.
  const cenas = listProductionScenes('proj_antigo', segunda);
  assert.deepEqual(cenas.map((c) => c.ordinal), [1, 2]);
  assert.equal(cenas[0].narration, `${TEXTO_1} (1)`);

  // C. a mídia visual e o take dela continuam lá.
  const visuais = listSceneTakes('proj_antigo', 1, 'image', segunda);
  assert.equal(visuais.length, 1);
  assert.equal(visuais[0].takeNumber, takeVisual.takeNumber);
  assert.equal(visuais[0].assetId, imagem.id);

  // D. os Assets continuam lá, do tipo que eram.
  assert.deepEqual(
    segunda.prepare('SELECT id, kind FROM assets ORDER BY kind').all()
      .map((a) => ({ id: a.id, kind: a.kind })),
    [{ id: imagem.id, kind: 'image' }, { id: video.id, kind: 'video' }],
  );

  // E as tabelas novas existem, vazias.
  for (const tabela of ['production_scene_audio_takes', 'production_scene_audio_selections']) {
    assert.equal(segunda.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0);
  }

  // E o domínio de voz funciona no banco migrado, com o material que já estava lá.
  const voz = createNarrationAudioTake('proj_antigo', 1, {}, segunda);
  assert.equal(voz.takeNumber, 1);
  assert.equal(voz.sourceNarrationFingerprint, narrationFingerprint(`${TEXTO_1} (1)`));

  segunda.close();
});

test('E. a migração 11 não tocou no esquema visual nem na cena do PASSO 12', () => {
  const db = banco();

  // A cena continua sem coluna de mídia e sem coluna de áudio: um take é uma
  // linha à parte justamente para isso.
  assert.deepEqual(colunas(db, 'production_scenes'), [
    'id', 'scriptId', 'ordinal', 'title', 'purpose', 'durationSeconds',
    'narration', 'visualDescription', 'status', 'createdAt', 'updatedAt',
  ]);

  // A mídia visual NÃO ganhou `role`, NÃO ganhou áudio e NÃO ganhou impressão
  // de entrada. Se alguém as acrescentar, este teste cai — e a queda é a
  // conversa. Ver a seção 18 do 14-B: nada de staleness universal.
  assert.deepEqual(colunas(db, 'production_scene_media'), [
    'id', 'sceneId', 'kind', 'takeNumber', 'generationJobId', 'assetId',
    'createdAt', 'updatedAt',
  ]);
  assert.deepEqual(colunas(db, 'production_scene_media_selections'), [
    'sceneId', 'kind', 'mediaId', 'updatedAt',
  ]);

  // E o vocabulário visual continua o que era. Esta linha dizia `ASSET_KINDS`
  // até o PASSO 14-C1 — as duas listas eram a mesma, e a igualdade escondia que
  // a asserção que importa aqui é sobre a PIPELINE, não sobre o tipo físico.
  assert.deepEqual([...SCENE_MEDIA_KINDS], ['image', 'video']);

  db.close();
});

test('F. as tabelas de voz do 14-B continuam exatamente como nasceram', () => {
  const db = banco();

  // O PASSO 14-C1 levou o esquema a 12 SEM tocar nestas duas: a migração 12
  // reconstrói `assets` e `generation_jobs`, e mais nada.
  assert.equal(schemaVersion(db), ESQUEMA_ATUAL);
  assert.ok(ESQUEMA_ATUAL >= 11, 'a migração 11 precisa continuar existindo');

  assert.deepEqual(colunas(db, 'production_scene_audio_takes'), [
    'id', 'sceneId', 'role', 'takeNumber', 'sourceNarrationFingerprint',
    'generationJobId', 'assetId', 'createdAt', 'updatedAt',
  ]);
  assert.deepEqual(colunas(db, 'production_scene_audio_selections'), [
    'sceneId', 'role', 'takeId', 'updatedAt',
  ]);

  // NÃO existe coluna de estado. `stale`/`current` é DERIVADO — ver a seção 7
  // do 14-B, e `narrationAudioTakeFreshness`.
  for (const proibida of ['stale', 'current', 'outdated', 'status']) {
    assert.equal(colunas(db, 'production_scene_audio_takes').includes(proibida), false,
      `a proveniência virou coluna: ${proibida}`);
  }

  // E nada de voz, modelo, provider ou arquivo: isso é do 14-C e do Asset.
  for (const proibida of [
    'voiceId', 'modelId', 'provider', 'prompt', 'language', 'speed', 'pitch',
    'gain', 'duration', 'durationSeconds', 'sampleRate', 'codec', 'path', 'filename',
  ]) {
    assert.equal(colunas(db, 'production_scene_audio_takes').includes(proibida), false,
      `parâmetro de TTS entrou cedo demais: ${proibida}`);
  }

  db.close();
});

// ── G · H · I · J · K · L · M · o take nasce ───────────────────────────────

test('G. a primeira tentativa de voz de uma cena é o take 1', () => {
  const db = banco();

  const take = createNarrationAudioTake('proj_a', 1, {}, db);

  assert.equal(take.takeNumber, 1);
  assert.equal(take.role, NARRATION_ROLE);
  assert.equal(take.generationJobId, null);
  assert.equal(take.assetId, null);
  assert.equal(take.current, true);

  db.close();
});

test('H. a segunda vira o take 2, e a primeira continua onde estava', () => {
  const db = banco();

  const um = createNarrationAudioTake('proj_a', 1, {}, db);
  const dois = createNarrationAudioTake('proj_a', 1, {}, db);

  assert.equal(um.takeNumber, 1);
  assert.equal(dois.takeNumber, 2);
  assert.deepEqual(
    listNarrationAudioTakes('proj_a', 1, NARRATION_ROLE, db).map((t) => t.takeNumber),
    [1, 2],
  );

  // A numeração é por CENA: a cena 2 recomeça no 1.
  assert.equal(createNarrationAudioTake('proj_a', 2, {}, db).takeNumber, 1);

  db.close();
});

test('I · L. o número e a impressão são do servidor — mandá-los é RECUSADO', () => {
  const db = banco();

  assert.throws(
    () => createNarrationAudioTake('proj_a', 1, { takeNumber: 7 }, db),
    (erro) => erro instanceof DomainError && /número do take é do servidor/.test(erro.message),
  );

  assert.throws(
    () => createNarrationAudioTake('proj_a', 1, {
      sourceNarrationFingerprint: 'a'.repeat(64),
    }, db),
    (erro) => erro instanceof DomainError
      && /impressão da narração é do servidor/.test(erro.message),
  );

  // Recusar, e não ignorar: nenhuma das duas tentativas deixou linha nenhuma.
  assert.deepEqual(listNarrationAudioTakes('proj_a', 1, NARRATION_ROLE, db), []);

  db.close();
});

test('J. papel diferente de narration é recusado neste passo', () => {
  const db = banco();

  for (const papel of ['music', 'sfx', 'dialogue', 'voiceover', 'ambient', 'foley']) {
    assert.throws(
      () => createNarrationAudioTake('proj_a', 1, { role: papel }, db),
      (erro) => erro instanceof DomainError && /Papel de áudio inválido/.test(erro.message),
      `o papel ${papel} entrou cedo demais`,
    );
  }

  // O vocabulário tem um valor só, e é ele.
  assert.deepEqual([...AUDIO_ROLES], ['narration']);
  assert.deepEqual([...SCENE_AUDIO_ROLES], ['narration']);

  db.close();
});

test('K. a impressão vem da narração PERSISTIDA, e não do que se passou antes', () => {
  const db = banco();

  updateProductionScene('proj_a', 1, { narration: TEXTO_1 }, db);
  const take = createNarrationAudioTake('proj_a', 1, {}, db);

  assert.equal(take.sourceNarrationFingerprint, narrationFingerprint(TEXTO_1));
  assert.equal(take.sourceNarrationFingerprint, sceneNarration('proj_a', 1, db).fingerprint);

  // E é mesmo o SHA-256 do texto que está no banco — não de uma normalização.
  const gravado = getProductionScene('proj_a', 1, db).narration;
  assert.equal(take.sourceNarrationFingerprint, narrationFingerprint(gravado));

  db.close();
});

test('M. narração vazia é legítima, e não vira voz', () => {
  const db = banco();

  updateProductionScene('proj_a', 1, { narration: '' }, db);

  // A cena continua válida — ela pode ser só imagem, só música ou só silêncio.
  assert.equal(getProductionScene('proj_a', 1, db).narration, '');
  assert.equal(sceneNarration('proj_a', 1, db).hasNarration, false);
  assert.equal(sceneNarration('proj_a', 1, db).fingerprint, null);

  assert.throws(
    () => createNarrationAudioTake('proj_a', 1, {}, db),
    (erro) => erro instanceof DomainError
      && /não tem narração escrita para gravar uma voz/.test(erro.message)
      && /Escreva a narração da cena/.test(erro.message),
  );

  // Nenhuma linha nasceu, e nenhuma impressão artificial da string vazia.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_audio_takes').get().n, 0);

  // Escrevendo a narração, a mesma chamada passa.
  updateProductionScene('proj_a', 1, { narration: TEXTO_1 }, db);
  assert.equal(createNarrationAudioTake('proj_a', 1, {}, db).takeNumber, 1);

  db.close();
});

// ── N · O · P · Q · a narração muda, o histórico não ───────────────────────

test('N · O · P. editar a narração não apaga o take, não reescreve a impressão, e o torna stale', () => {
  const db = banco();

  updateProductionScene('proj_a', 1, { narration: TEXTO_1 }, db);
  const antes = createNarrationAudioTake('proj_a', 1, {}, db);
  assert.equal(antes.current, true);

  updateProductionScene('proj_a', 1, { narration: TEXTO_2 }, db);

  // N. o take continua existindo.
  const takes = listNarrationAudioTakes('proj_a', 1, NARRATION_ROLE, db);
  assert.equal(takes.length, 1);
  assert.equal(takes[0].takeNumber, 1);

  // O. e a impressão dele continua sendo a do texto de que ele nasceu.
  assert.equal(takes[0].sourceNarrationFingerprint, narrationFingerprint(TEXTO_1));
  assert.notEqual(takes[0].sourceNarrationFingerprint, narrationFingerprint(TEXTO_2));

  // P. mas ele passou a ser de uma versão anterior da narração.
  assert.equal(takes[0].current, false);

  const frescor = narrationAudioTakeFreshness('proj_a', 1, { takeNumber: 1 }, db);
  assert.equal(frescor.current, false);
  assert.equal(frescor.stale, true);
  assert.equal(frescor.sourceNarrationFingerprint, narrationFingerprint(TEXTO_1));
  assert.equal(frescor.narrationFingerprint, narrationFingerprint(TEXTO_2));

  // Um take novo, do texto novo, é current — e o antigo continua não sendo.
  const depois = createNarrationAudioTake('proj_a', 1, {}, db);
  assert.equal(depois.takeNumber, 2);
  assert.equal(depois.current, true);
  assert.equal(
    listNarrationAudioTakes('proj_a', 1, NARRATION_ROLE, db).map((t) => t.current).join(),
    'false,true',
  );

  db.close();
});

test('Q. o mesmo texto de volta produz a mesma impressão — e o take antigo volta a ser current', () => {
  const db = banco();

  updateProductionScene('proj_a', 1, { narration: TEXTO_1 }, db);
  const take = createNarrationAudioTake('proj_a', 1, {}, db);

  updateProductionScene('proj_a', 1, { narration: TEXTO_2 }, db);
  assert.equal(getNarrationAudioTake('proj_a', 1, { takeNumber: 1 }, db).current, false);

  // Desfazer a edição não é um caso especial: a impressão é função do texto, e
  // o texto voltou a ser o mesmo. A voz gravada realmente serve de novo.
  updateProductionScene('proj_a', 1, { narration: TEXTO_1 }, db);
  const voltou = getNarrationAudioTake('proj_a', 1, { takeNumber: 1 }, db);
  assert.equal(voltou.current, true);
  assert.equal(voltou.sourceNarrationFingerprint, take.sourceNarrationFingerprint);

  db.close();
});

// ── R · S · T · U · V · a seleção ──────────────────────────────────────────

test('R · S. a escolha permanece depois da edição, e o domínio diz que ela ficou para trás', () => {
  const db = banco();

  updateProductionScene('proj_a', 1, { narration: TEXTO_1 }, db);
  createNarrationAudioTake('proj_a', 1, {}, db);
  const escolhido = selectNarrationAudioTake('proj_a', 1, { takeNumber: 1 }, db);
  assert.equal(escolhido.takeNumber, 1);
  assert.equal(escolhido.current, true);

  updateProductionScene('proj_a', 1, { narration: TEXTO_2 }, db);

  // R. a seleção NÃO foi apagada, e NÃO foi trocada.
  const selecionado = getNarrationAudioSelection('proj_a', 1, NARRATION_ROLE, db);
  assert.notEqual(selecionado, null);
  assert.equal(selecionado.takeNumber, 1);

  // S. selected = true (ele veio da seleção) e current = false, ao mesmo tempo.
  // É esta linha que o 14-C/14-E vai usar para dizer "a narração mudou; a voz
  // escolhida foi gerada do texto anterior".
  assert.equal(selecionado.current, false);
  assert.equal(selecionado.sourceNarrationFingerprint, narrationFingerprint(TEXTO_1));

  // E um take novo nasce current SEM ser selecionado automaticamente: a
  // política de auto-seleção é do 14-C, e inventá-la antes da geração existir
  // seria decidir sem o problema na mão.
  const novo = createNarrationAudioTake('proj_a', 1, {}, db);
  assert.equal(novo.current, true);
  assert.equal(getNarrationAudioSelection('proj_a', 1, NARRATION_ROLE, db).takeNumber, 1);

  db.close();
});

test('T. escolher outro take não apaga o anterior', () => {
  const db = banco();

  createNarrationAudioTake('proj_a', 1, {}, db);
  createNarrationAudioTake('proj_a', 1, {}, db);

  selectNarrationAudioTake('proj_a', 1, { takeNumber: 1 }, db);
  selectNarrationAudioTake('proj_a', 1, { takeNumber: 2 }, db);

  assert.equal(getNarrationAudioSelection('proj_a', 1, NARRATION_ROLE, db).takeNumber, 2);

  // Os dois takes continuam lá: mover o ponteiro não é sobrescrever.
  assert.deepEqual(
    listNarrationAudioTakes('proj_a', 1, NARRATION_ROLE, db).map((t) => t.takeNumber),
    [1, 2],
  );

  // E a seleção continua sendo uma linha só.
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_audio_selections').get().n, 1,
  );

  db.close();
});

test('U. a seleção não aceita o take de outra cena', () => {
  const db = banco();

  createNarrationAudioTake('proj_a', 1, {}, db);
  createNarrationAudioTake('proj_a', 2, {}, db);

  // Pela porta da frente não há como nomear o take de outra cena: o endereço é
  // cena + número, e a cena 3 não tem take 1.
  assert.throws(
    () => selectNarrationAudioTake('proj_a', 3, { takeNumber: 1 }, db),
    (erro) => erro instanceof DomainError && /não tem um take 1 de narration/.test(erro.message),
  );

  // E pela porta dos fundos também não: a chave estrangeira composta recusa a
  // linha mesmo escrita em SQL na mão.
  const daCena1 = db.prepare(
    'SELECT t.id, t.sceneId FROM production_scene_audio_takes t '
    + 'JOIN production_scenes c ON c.id = t.sceneId WHERE c.ordinal = 1',
  ).get();
  const cena2 = db.prepare(
    'SELECT c.id FROM production_scenes c JOIN production_scripts s ON s.id = c.scriptId '
    + 'WHERE s.projectId = ? AND c.ordinal = 2',
  ).get('proj_a');

  assert.throws(() => {
    db.prepare(
      'INSERT INTO production_scene_audio_selections (sceneId, role, takeId, updatedAt) '
      + 'VALUES (?, ?, ?, ?)',
    ).run(cena2.id, 'narration', daCena1.id, Date.now());
  }, /FOREIGN KEY/i);

  db.close();
});

test('V. um projeto não alcança a voz de outro', () => {
  const db = banco();

  createNarrationAudioTake('proj_a', 1, {}, db);
  selectNarrationAudioTake('proj_a', 1, { takeNumber: 1 }, db);

  // O projeto B tem uma cena 1 — e ela não tem take nenhum.
  assert.deepEqual(listNarrationAudioTakes('proj_b', 1, NARRATION_ROLE, db), []);
  assert.equal(getNarrationAudioTake('proj_b', 1, { takeNumber: 1 }, db), null);
  assert.equal(getNarrationAudioSelection('proj_b', 1, NARRATION_ROLE, db), null);
  assert.equal(narrationAudioTakeFreshness('proj_b', 1, { takeNumber: 1 }, db), null);

  // E escolher o take do outro projeto é a mesma recusa de "não existe": a
  // mensagem não conta que ele existe em algum lugar.
  assert.throws(
    () => selectNarrationAudioTake('proj_b', 1, { takeNumber: 1 }, db),
    (erro) => erro instanceof DomainError
      && /A cena 1 não tem um take 1 de narration\./.test(erro.message)
      && !/proj_a/.test(erro.message)
      && !/outro projeto/.test(erro.message),
  );

  // Um projeto que não existe responde igual, e não vaza a diferença.
  assert.deepEqual(listNarrationAudioTakes('proj_inexistente', 1, NARRATION_ROLE, db), []);

  // A voz do projeto A continua intacta depois de tudo isso.
  assert.equal(getNarrationAudioSelection('proj_a', 1, NARRATION_ROLE, db).takeNumber, 1);

  db.close();
});

// ── W · X · apagar ─────────────────────────────────────────────────────────

test('W. apagar o projeto leva roteiro, cenas, takes de voz e seleções', () => {
  const db = banco();

  createNarrationAudioTake('proj_a', 1, {}, db);
  createNarrationAudioTake('proj_a', 2, {}, db);
  selectNarrationAudioTake('proj_a', 1, { takeNumber: 1 }, db);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_audio_takes').get().n, 2);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_audio_selections').get().n, 1,
  );

  deleteProject('proj_a', db);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_audio_takes').get().n, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_audio_selections').get().n, 0,
  );

  // E o projeto B não foi junto.
  assert.equal(listProductionScenes('proj_b', db).length, 3);

  db.close();
});

test('W2. apagar UMA cena leva os takes de voz dela, e só os dela', () => {
  const db = banco();

  createNarrationAudioTake('proj_a', 1, {}, db);
  createNarrationAudioTake('proj_a', 2, {}, db);
  selectNarrationAudioTake('proj_a', 1, { takeNumber: 1 }, db);

  const cena1 = db.prepare(
    'SELECT t.sceneId AS id FROM production_scene_audio_takes t '
    + 'JOIN production_scenes c ON c.id = t.sceneId WHERE c.ordinal = 1',
  ).get();
  db.prepare('DELETE FROM production_scenes WHERE id = ?').run(cena1.id);

  assert.deepEqual(listNarrationAudioTakes('proj_a', 1, NARRATION_ROLE, db), []);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM production_scene_audio_selections').get().n, 0,
  );

  // A cena 2 continua com a voz dela.
  assert.equal(listNarrationAudioTakes('proj_a', 2, NARRATION_ROLE, db).length, 1);

  db.close();
});

test('X. apagar um take leva a seleção, e NÃO leva Asset nenhum', () => {
  const db = banco();

  // Os Assets do projeto — infraestrutura compartilhada, de outra camada.
  const imagem = createAsset({ projectId: 'proj_a', kind: 'image', filename: 'a.png' }, db);

  createNarrationAudioTake('proj_a', 1, {}, db);
  createNarrationAudioTake('proj_a', 1, {}, db);
  selectNarrationAudioTake('proj_a', 1, { takeNumber: 2 }, db);

  const take2 = db.prepare(
    'SELECT t.id FROM production_scene_audio_takes t '
    + 'JOIN production_scenes c ON c.id = t.sceneId '
    + 'WHERE c.ordinal = 1 AND t.takeNumber = 2',
  ).get();
  db.prepare('DELETE FROM production_scene_audio_takes WHERE id = ?').run(take2.id);

  // O ponteiro para o nada não fica de pé.
  assert.equal(getNarrationAudioSelection('proj_a', 1, NARRATION_ROLE, db), null);

  // O take 1 continua lá.
  assert.deepEqual(
    listNarrationAudioTakes('proj_a', 1, NARRATION_ROLE, db).map((t) => t.takeNumber), [1],
  );

  // E o Asset continua sendo do projeto: apagar uma tentativa não é faxina de
  // mídia, e a propriedade do arquivo é de outra camada.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.equal(db.prepare('SELECT kind FROM assets WHERE id = ?').get(imagem.id).kind, 'image');

  db.close();
});

// ── Y · Z · replace_scenes ─────────────────────────────────────────────────

test('Y. com um take de voz e NENHUMA mídia visual, substituir todas as cenas é recusado', () => {
  const db = banco();

  createNarrationAudioTake('proj_a', 2, {}, db);

  // Não há mídia visual nenhuma — a guarda do 13-A, sozinha, deixaria passar.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scene_media').get().n, 0);

  assert.throws(
    () => replaceProductionScenes('proj_a', tresCenas('Reescrita'), db),
    (erro) => erro instanceof DomainError
      && /já tem mídia associada/.test(erro.message)
      && /cena 2/.test(erro.message)
      && /Edite as cenas uma a uma/.test(erro.message),
  );

  db.close();
});

test('Z. a recusa não deixa estado parcial — nada foi apagado nem reescrito', () => {
  const db = banco();

  updateProductionScene('proj_a', 1, { narration: TEXTO_1 }, db);
  createNarrationAudioTake('proj_a', 1, {}, db);
  createNarrationAudioTake('proj_a', 1, {}, db);
  selectNarrationAudioTake('proj_a', 1, { takeNumber: 2 }, db);
  createNarrationAudioTake('proj_a', 3, {}, db);

  const antes = {
    cenas: listProductionScenes('proj_a', db),
    takes: db.prepare(
      'SELECT id, sceneId, role, takeNumber, sourceNarrationFingerprint '
      + 'FROM production_scene_audio_takes ORDER BY id',
    ).all(),
    selecoes: db.prepare(
      'SELECT sceneId, role, takeId FROM production_scene_audio_selections ORDER BY sceneId',
    ).all(),
  };

  assert.throws(
    () => replaceProductionScenes('proj_a', tresCenas('Reescrita'), db),
    (erro) => erro instanceof DomainError && /cenas 1, 3/.test(erro.message),
  );

  // Tudo exatamente como estava: as cenas com os títulos antigos, os takes com
  // os mesmos ids e as mesmas impressões, e a seleção no mesmo lugar.
  assert.deepEqual(listProductionScenes('proj_a', db), antes.cenas);
  assert.deepEqual(
    db.prepare(
      'SELECT id, sceneId, role, takeNumber, sourceNarrationFingerprint '
      + 'FROM production_scene_audio_takes ORDER BY id',
    ).all(),
    antes.takes,
  );
  assert.deepEqual(
    db.prepare(
      'SELECT sceneId, role, takeId FROM production_scene_audio_selections ORDER BY sceneId',
    ).all(),
    antes.selecoes,
  );
  assert.equal(getNarrationAudioSelection('proj_a', 1, NARRATION_ROLE, db).takeNumber, 2);

  db.close();
});

test('Z2. sem voz e sem mídia, substituir todas as cenas continua funcionando', () => {
  const db = banco();

  const depois = replaceProductionScenes('proj_a', tresCenas('Reescrita'), db);
  assert.deepEqual(depois.map((c) => c.title), ['Reescrita 1', 'Reescrita 2', 'Reescrita 3']);

  // E continua funcionando depois de a voz existir e ser APAGADA: a guarda olha
  // o que há agora, não o que já houve.
  createNarrationAudioTake('proj_a', 1, {}, db);
  db.exec('DELETE FROM production_scene_audio_takes');
  assert.equal(replaceProductionScenes('proj_a', tresCenas('De novo'), db).length, 3);

  db.close();
});

// ── ausência ───────────────────────────────────────────────────────────────
//
// O que este passo NÃO fez. Cada uma destas asserções é uma porta que alguém
// pode abrir sem querer no passo seguinte.

test('ausência 1. nenhuma ferramenta de áudio, voz ou TTS foi publicada', () => {
  const publicadas = publicToolList(toolRegistry()).map((t) => t.name);

  // `take` sozinho não entra na varredura: `project.select_scene_take` é do
  // PASSO 13-A e existe de direito. O que não pode ter nascido é ferramenta de
  // SOM.
  for (const nome of publicadas) {
    assert.equal(
      /audio|voice|voz|tts|speech|narration|narracao|music|sfx|dialogue|foley|ambient/i
        .test(nome),
      false,
      `ferramenta de áudio criada cedo demais: ${nome}`,
    );
  }

  // A narração continua se editando pela ferramenta que já existia.
  assert.ok(publicadas.includes('project.update_scene'));
});

test('ausência 2. o domínio de voz não cria Asset, job, nem arquivo', () => {
  const db = banco();

  createNarrationAudioTake('proj_a', 1, {}, db);
  createNarrationAudioTake('proj_a', 1, {}, db);
  selectNarrationAudioTake('proj_a', 1, { takeNumber: 1 }, db);
  updateProductionScene('proj_a', 1, { narration: TEXTO_2 }, db);
  createNarrationAudioTake('proj_a', 1, {}, db);

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);

  // E os dois campos que um dia vão apontar para eles continuam nulos: o 14-B
  // não simula geração para preencher coluna.
  const takes = listNarrationAudioTakes('proj_a', 1, NARRATION_ROLE, db);
  assert.equal(takes.length, 3);
  for (const take of takes) {
    assert.equal(take.generationJobId, null);
    assert.equal(take.assetId, null);
  }

  db.close();
});

test('ausência 3. `audio` é kind de Asset, e continua fora da pipeline visual', () => {
  const db = banco();

  // Este teste afirmava o contrário até o PASSO 14-C1, e previu a própria
  // queda: o 14-C1 acrescentou `audio` ao tipo físico, com a migração 12 que
  // reconstrói `assets` e `generation_jobs`. O que ele tranca agora é a metade
  // que NÃO mudou.
  assert.equal(ASSET_KINDS.includes('audio'), true);
  const voz = createAsset({ projectId: 'proj_a', kind: 'audio', filename: 'voz.opus' }, db);
  assert.equal(voz.kind, 'audio');

  // A pipeline visual continua recusando — no domínio e no banco.
  assert.deepEqual([...SCENE_MEDIA_KINDS], ['image', 'video']);
  assert.throws(
    () => createSceneTake('proj_a', 1, { kind: 'audio' }, db),
    (erro) => erro instanceof DomainError && /Tipo de mídia inválido/.test(erro.message),
  );

  // E o take de voz do 14-B continua sendo o lugar do áudio de uma cena.
  assert.deepEqual([...AUDIO_ROLES], ['narration']);

  db.close();
});

test('ausência 4. a projeção pública não vaza id, e traz a proveniência', () => {
  const db = banco();

  updateProductionScene('proj_a', 1, { narration: TEXTO_1 }, db);
  createNarrationAudioTake('proj_a', 1, {}, db);
  const publico = publicNarrationAudioTake(
    getNarrationAudioTake('proj_a', 1, { takeNumber: 1 }, db),
  );

  assert.deepEqual(Object.keys(publico).sort(), declaredNarrationAudioTakeFields().sort());
  assert.equal('id' in publico, false);
  assert.equal('sceneId' in publico, false);
  assert.equal(publico.sourceNarrationFingerprint, narrationFingerprint(TEXTO_1));
  assert.equal(publico.current, true);

  db.close();
});

test('ausência 5. o teto de takes é o mesmo do take visual, e não um número novo', () => {
  const db = banco();

  assert.equal(MAX_AUDIO_TAKES_POR_CENA, 50);

  const cena = db.prepare(
    'SELECT c.id FROM production_scenes c JOIN production_scripts s ON s.id = c.scriptId '
    + 'WHERE s.projectId = ? AND c.ordinal = 1',
  ).get('proj_a');

  // Enche até o teto por dentro, para não pagar 50 transações.
  const agora = Date.now();
  const impressao = sceneNarration('proj_a', 1, db).fingerprint;
  const insere = db.prepare(
    'INSERT INTO production_scene_audio_takes (id, sceneId, role, takeNumber, '
    + 'sourceNarrationFingerprint, generationJobId, assetId, createdAt, updatedAt) '
    + 'VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)',
  );
  for (let n = 1; n <= MAX_AUDIO_TAKES_POR_CENA; n += 1) {
    insere.run(`audio_teto_${n}`, cena.id, 'narration', n, impressao, agora, agora);
  }

  assert.throws(
    () => createNarrationAudioTake('proj_a', 1, {}, db),
    (erro) => erro instanceof DomainError && /o limite é 50/.test(erro.message),
  );

  db.close();
});
