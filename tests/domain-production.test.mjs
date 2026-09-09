// O planejamento de produção no domínio — plano, roteiro e cenas.
//
// PASSO 12. O que estes testes trancam é sempre a mesma frase dita de várias
// formas: **o plano da produção é estado do Project, não memória da conversa**.
// Um plano que só existe no chat não sobrevive ao pedido seguinte, que é "mude
// a cena 4".
//
// As invariantes que importam, e por que cada uma existe:
//
//   projeto obrigatório          um plano sem dono não é de ninguém
//   um plano por projeto         gravar de novo substitui, e é idempotente
//   plano → roteiro → cenas      não há cena sem nada contra o que conferir
//   ordinais 1..n                "a cena 4" precisa significar uma coisa só
//   duração > 0                  uma cena de zero segundo não é uma cena
//   soma perto do alvo           um plano de 2 min cujas cenas somam 40 s é
//                                outro filme, não uma aproximação
//   substituição transacional    falha no meio não deixa meio roteiro
//   cross-project impossível     não por conferência: por construção
//
// E a migração: a tabela `scenes` da migração 1 continua INTACTA. Ela é de
// outra família (o storyboard da tela) e não foi evoluída — ver o cabeçalho da
// migração 9. Há teste aqui para isso, porque "não mexemos" é uma afirmação
// verificável.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DomainError, ESQUEMA_ATUAL, openDatabase, PRODUCTION_STATUS, schemaVersion,
} from '../lib/server/domain/db.js';
import { createProject, deleteProject } from '../lib/server/domain/projects.js';
import { createProjectDocument } from '../lib/server/domain/documents.js';
import { DOCUMENT_TYPES } from '../lib/server/domain/documentTypes.js';
import { createSceneRecord, listScenes } from '../lib/server/domain/scenes.js';
import {
  DURATION_TOLERANCE_SECONDS, declaredPlanFields, declaredSceneFields,
  declaredSceneSummaryFields, getProductionPlan, getProductionScene,
  getProductionScript, listPlanSources, listProductionScenes, MAX_SCENES,
  MAX_SCRIPT_CHARS, productionSummary, publicProductionPlan,
  publicProductionScene, publicProductionSceneSummary, replaceProductionScenes,
  saveProductionPlan, saveProductionScript, updateProductionScene,
} from '../lib/server/domain/production.js';

const SHA = 'c'.repeat(64);

function banco() {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_a', name: 'Produção A' }, db);
  createProject({ id: 'proj_b', name: 'Produção B' }, db);
  return db;
}

/** Um plano de 120 s, que é o exemplo-guia do produto. */
function comPlano(db, projectId = 'proj_a', extra = {}) {
  return saveProductionPlan({
    projectId,
    title: 'Prometeu — o fogo da humanidade',
    logline: 'O titã que roubou o fogo dos deuses e pagou por isso.',
    format: 'minidocumentário',
    targetDurationSeconds: 120,
    tone: 'épico',
    ...extra,
  }, db);
}

function comRoteiro(db, projectId = 'proj_a') {
  return saveProductionScript({
    projectId,
    title: 'Prometeu',
    summary: 'Quatro movimentos: o roubo, o dom, a punição, a libertação.',
    fullText: 'ABERTURA. O Olimpo ao amanhecer...',
  }, db);
}

/** Quatro cenas somando exatamente 120 s. */
function quatroCenas() {
  return [
    {
      ordinal: 1, title: 'O Olimpo', purpose: 'Situar o mundo dos deuses',
      durationSeconds: 30, narration: 'No alto do Olimpo, o fogo era privilégio.',
      visualDescription: 'Plano geral do Monte Olimpo ao amanhecer, nuvens densas.',
    },
    {
      ordinal: 2, title: 'O roubo', purpose: 'O ato que muda tudo',
      durationSeconds: 30, narration: 'Prometeu desceu com a brasa escondida.',
      visualDescription: 'Close na brasa dentro do caule oco, luz laranja no rosto.',
    },
    {
      ordinal: 3, title: 'A punição', purpose: 'O preço',
      durationSeconds: 30, narration: 'Acorrentado ao Cáucaso, dia após dia.',
      visualDescription: 'Plano aberto da rocha, a águia em silhueta.',
    },
    {
      ordinal: 4, title: 'A libertação', purpose: 'Fechar o arco',
      durationSeconds: 30, narration: 'Héracles quebrou as correntes.',
      visualDescription: 'Contra-luz, as correntes caindo em câmera lenta.',
    },
  ];
}

// ── A · o plano existe ──────────────────────────────────────────────────────

test('A. cria o plano de produção de um projeto', () => {
  const db = banco();
  const plano = comPlano(db);

  assert.equal(plano.projectId, 'proj_a');
  assert.equal(plano.title, 'Prometeu — o fogo da humanidade');
  assert.equal(plano.targetDurationSeconds, 120);
  assert.equal(plano.format, 'minidocumentário');
  assert.equal(plano.status, PRODUCTION_STATUS.DRAFT);
  // O id é do servidor, e tem a forma dos identificadores da casa.
  assert.match(plano.id, /^plan_[a-z0-9]+_[a-f0-9]{8}$/);
  assert.deepEqual(getProductionPlan('proj_a', db), plano);

  db.close();
});

test('A-bis. o padrão de aspecto é 16:9 e os campos opcionais nascem vazios', () => {
  const db = banco();
  const plano = saveProductionPlan({
    projectId: 'proj_a', title: 'T', targetDurationSeconds: 60,
  }, db);

  assert.equal(plano.aspectRatio, '16:9');
  for (const campo of ['logline', 'synopsis', 'format', 'genre', 'tone', 'audience', 'language']) {
    assert.equal(plano[campo], '', `${campo} deveria nascer vazio`);
  }
  db.close();
});

// ── B · projeto obrigatório ─────────────────────────────────────────────────

test('B. um plano sem projeto é recusado', () => {
  const db = banco();
  assert.throws(() => saveProductionPlan({ title: 'T', targetDurationSeconds: 60 }, db), DomainError);
  assert.throws(
    () => saveProductionPlan({ projectId: '', title: 'T', targetDurationSeconds: 60 }, db),
    DomainError,
  );
  db.close();
});

test('B-bis. um projeto que não existe é recusado, e nenhum projeto nasce por isso', () => {
  const db = banco();
  assert.throws(
    () => saveProductionPlan({ projectId: 'proj_fantasma', title: 'T', targetDurationSeconds: 60 }, db),
    DomainError,
  );
  // A recusa não pode ter materializado o projeto: essa é a regra 15.
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM projects').get().n,
    2,
  );
  db.close();
});

test('B-ter. título e duração alvo são obrigatórios', () => {
  const db = banco();
  assert.throws(() => saveProductionPlan({ projectId: 'proj_a', targetDurationSeconds: 60 }, db), DomainError);
  assert.throws(() => saveProductionPlan({ projectId: 'proj_a', title: '   ', targetDurationSeconds: 60 }, db), DomainError);
  for (const invalida of [0, -1, null, undefined, 'muito', '']) {
    assert.throws(
      () => saveProductionPlan({ projectId: 'proj_a', title: 'T', targetDurationSeconds: invalida }, db),
      DomainError,
      `duração alvo ${JSON.stringify(invalida)} deveria ser recusada`,
    );
  }
  db.close();
});

// ── C · cross-project ───────────────────────────────────────────────────────

test('C. cada projeto tem o SEU plano, e um não enxerga o do outro', () => {
  const db = banco();
  comPlano(db, 'proj_a', { title: 'A' });
  comPlano(db, 'proj_b', { title: 'B', targetDurationSeconds: 240 });

  assert.equal(getProductionPlan('proj_a', db).title, 'A');
  assert.equal(getProductionPlan('proj_b', db).title, 'B');
  assert.equal(getProductionPlan('proj_a', db).targetDurationSeconds, 120);
  assert.equal(getProductionPlan('proj_b', db).targetDurationSeconds, 240);
  db.close();
});

test('C-bis. um documento de OUTRO projeto não pode ser fonte deste plano', () => {
  const db = banco();
  const doDeB = createProjectDocument({
    projectId: 'proj_b', filename: 'de-b.txt', mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 10, sha256: SHA, chunks: [{ text: 'conteúdo de B' }],
  }, db);

  assert.throws(
    () => comPlano(db, 'proj_a', { sourceDocumentIds: [doDeB.id] }),
    DomainError,
  );
  // E a recusa aconteceu ANTES de qualquer escrita.
  assert.equal(getProductionPlan('proj_a', db), null);
  db.close();
});

test('C-ter. um documento do próprio projeto vira fonte rastreável', () => {
  const db = banco();
  const doc = createProjectDocument({
    projectId: 'proj_a', filename: 'prometeu.pdf', mimeType: DOCUMENT_TYPES.PDF,
    sizeBytes: 2048, sha256: SHA, pageCount: 6,
    chunks: [{ pageNumber: 1, text: 'Prometeu roubou o fogo.' }],
  }, db);

  comPlano(db, 'proj_a', { sourceDocumentIds: [doc.id, doc.id] });

  const fontes = listPlanSources('proj_a', db);
  // Repetido entra uma vez só.
  assert.equal(fontes.length, 1);
  assert.equal(fontes[0].documentId, doc.id);
  assert.equal(fontes[0].filename, 'prometeu.pdf');
  db.close();
});

// ── D · idempotência ────────────────────────────────────────────────────────

test('D. gravar o mesmo plano de novo substitui, mantém o id e não duplica', () => {
  const db = banco();
  const primeiro = comPlano(db);
  const segundo = comPlano(db);

  assert.equal(segundo.id, primeiro.id, 'o plano não é outro, então o id não muda');
  assert.equal(segundo.createdAt, primeiro.createdAt);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_plans').get().n, 1);
  db.close();
});

test('D-bis. gravar com campos diferentes SUBSTITUI o plano', () => {
  const db = banco();
  comPlano(db);
  const atualizado = saveProductionPlan({
    projectId: 'proj_a', title: 'Outro título', targetDurationSeconds: 240,
  }, db);

  assert.equal(atualizado.title, 'Outro título');
  assert.equal(atualizado.targetDurationSeconds, 240);
  // Os campos não informados voltam ao vazio: gravar um plano é gravar o plano
  // inteiro, não remendar o anterior.
  assert.equal(atualizado.tone, '');
  db.close();
});

test('D-ter. as fontes são substituídas junto com o plano', () => {
  const db = banco();
  const doc = createProjectDocument({
    projectId: 'proj_a', filename: 'a.txt', mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 10, sha256: SHA, chunks: [{ text: 'texto' }],
  }, db);

  comPlano(db, 'proj_a', { sourceDocumentIds: [doc.id] });
  assert.equal(listPlanSources('proj_a', db).length, 1);

  comPlano(db, 'proj_a', { sourceDocumentIds: [] });
  assert.equal(listPlanSources('proj_a', db).length, 0,
    'a origem antiga não pode continuar sendo afirmada');
  db.close();
});

// ── E · o roteiro pertence ao projeto ───────────────────────────────────────

test('E. o roteiro pertence ao projeto e exige o plano antes', () => {
  const db = banco();

  assert.throws(() => comRoteiro(db), DomainError, 'roteiro sem plano deveria ser recusado');

  comPlano(db);
  const roteiro = comRoteiro(db);
  assert.equal(roteiro.projectId, 'proj_a');
  assert.equal(roteiro.status, PRODUCTION_STATUS.DRAFT);
  assert.deepEqual(getProductionScript('proj_a', db), roteiro);
  assert.equal(getProductionScript('proj_b', db), null);
  db.close();
});

test('E-bis. um roteiro por projeto; regravar substitui e preserva o id', () => {
  const db = banco();
  comPlano(db);
  const primeiro = comRoteiro(db);
  const segundo = saveProductionScript({
    projectId: 'proj_a', title: 'Prometeu (v2)', fullText: 'OUTRA ABERTURA...',
  }, db);

  assert.equal(segundo.id, primeiro.id);
  assert.equal(segundo.title, 'Prometeu (v2)');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scripts').get().n, 1);
  db.close();
});

test('E-ter. um roteiro vazio, ou grande demais, é recusado', () => {
  const db = banco();
  comPlano(db);

  assert.throws(() => saveProductionScript({ projectId: 'proj_a', title: 'T', fullText: '' }, db), DomainError);
  assert.throws(() => saveProductionScript({ projectId: 'proj_a', title: 'T', fullText: '   ' }, db), DomainError);
  assert.throws(
    () => saveProductionScript({ projectId: 'proj_a', title: 'T', fullText: 'x'.repeat(MAX_SCRIPT_CHARS + 1) }, db),
    DomainError,
  );
  db.close();
});

test('E-quater. reescrever o roteiro NÃO apaga as cenas', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);
  replaceProductionScenes('proj_a', quatroCenas(), db);

  saveProductionScript({ projectId: 'proj_a', title: 'Prometeu', fullText: 'Texto corrigido.' }, db);

  assert.equal(listProductionScenes('proj_a', db).length, 4,
    'corrigir uma frase do roteiro não pode demolir o plano de cenas');
  db.close();
});

// ── F · as cenas são ordenadas ──────────────────────────────────────────────

test('F. as cenas voltam sempre na ordem da produção, não na de gravação', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);

  const embaralhadas = [...quatroCenas()].reverse();
  replaceProductionScenes('proj_a', embaralhadas, db);

  assert.deepEqual(
    listProductionScenes('proj_a', db).map((c) => c.ordinal),
    [1, 2, 3, 4],
  );
  assert.deepEqual(
    listProductionScenes('proj_a', db).map((c) => c.title),
    ['O Olimpo', 'O roubo', 'A punição', 'A libertação'],
  );
  db.close();
});

test('F-bis. as cenas exigem plano E roteiro, nesta ordem', () => {
  const db = banco();

  assert.throws(() => replaceProductionScenes('proj_a', quatroCenas(), db), /plano de produção/);

  comPlano(db);
  assert.throws(() => replaceProductionScenes('proj_a', quatroCenas(), db), /roteiro/);

  comRoteiro(db);
  assert.equal(replaceProductionScenes('proj_a', quatroCenas(), db).length, 4);
  db.close();
});

// ── G · ordinal duplicado ───────────────────────────────────────────────────

test('G. duas cenas com o mesmo número são recusadas', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);

  const cenas = quatroCenas();
  cenas[3].ordinal = 3;

  assert.throws(() => replaceProductionScenes('proj_a', cenas, db), /número 3/);
  assert.equal(listProductionScenes('proj_a', db).length, 0, 'nada foi gravado');
  db.close();
});

test('G-bis. um buraco na sequência é recusado', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);

  const cenas = quatroCenas();
  cenas[3].ordinal = 9;

  assert.throws(() => replaceProductionScenes('proj_a', cenas, db), /fora da sequência/);
  db.close();
});

test('G-ter. o banco recusaria o duplicado mesmo por fora do repositório', () => {
  // A regra mora no esquema, e não só na validação: um segundo caminho de
  // escrita — uma migração, um SQL solto — esbarra nela do mesmo jeito.
  const db = banco();
  comPlano(db);
  const roteiro = comRoteiro(db);
  replaceProductionScenes('proj_a', quatroCenas(), db);

  assert.throws(() => db.prepare(`
    INSERT INTO production_scenes
      (id, scriptId, ordinal, title, purpose, durationSeconds, narration,
       visualDescription, status, createdAt, updatedAt)
    VALUES ('scene_falsa', ?, 2, 'Intrusa', '', 10, '', '', 'rascunho', 1, 1)
  `).run(roteiro.id), /UNIQUE|constraint/i);
  db.close();
});

// ── H · duração ─────────────────────────────────────────────────────────────

test('H. duração menor ou igual a zero é recusada', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);

  for (const invalida of [0, -1, null, undefined, '', 'seis']) {
    const cenas = quatroCenas();
    cenas[1].durationSeconds = invalida;
    assert.throws(
      () => replaceProductionScenes('proj_a', cenas, db),
      DomainError,
      `duração ${JSON.stringify(invalida)} deveria ser recusada`,
    );
  }
  assert.equal(listProductionScenes('proj_a', db).length, 0);
  db.close();
});

test('H-bis. o banco recusa duração zero mesmo por fora do repositório', () => {
  const db = banco();
  comPlano(db);
  const roteiro = comRoteiro(db);

  assert.throws(() => db.prepare(`
    INSERT INTO production_scenes
      (id, scriptId, ordinal, title, purpose, durationSeconds, narration,
       visualDescription, status, createdAt, updatedAt)
    VALUES ('scene_zero', ?, 1, 'Zero', '', 0, '', '', 'rascunho', 1, 1)
  `).run(roteiro.id), /CHECK|constraint/i);
  db.close();
});

test('H-ter. a soma das cenas precisa ficar dentro da tolerância do alvo', () => {
  const db = banco();
  comPlano(db);          // alvo: 120 s
  comRoteiro(db);

  // 4 × 10 = 40 s para um filme de 120 s: isso não é aproximação, é outro filme.
  const curtas = quatroCenas().map((c) => ({ ...c, durationSeconds: 10 }));
  assert.throws(() => replaceProductionScenes('proj_a', curtas, db), /somam 40s/);

  // No limite da tolerância, passa.
  const noLimite = quatroCenas();
  noLimite[0].durationSeconds = 30 + DURATION_TOLERANCE_SECONDS;
  assert.equal(replaceProductionScenes('proj_a', noLimite, db).length, 4);

  // Um segundo além dela, não.
  const alem = quatroCenas();
  alem[0].durationSeconds = 30 + DURATION_TOLERANCE_SECONDS + 1;
  assert.throws(() => replaceProductionScenes('proj_a', alem, db), /diferença aceita/);
  db.close();
});

test('H-quater. a mensagem da recusa diz a soma, o alvo e a tolerância', () => {
  // Uma recusa que não diz o quanto falta obriga o agente a adivinhar, e ele
  // adivinha errado — depois tenta de novo, gastando o turno.
  const db = banco();
  comPlano(db);
  comRoteiro(db);
  const curtas = quatroCenas().map((c) => ({ ...c, durationSeconds: 10 }));

  try {
    replaceProductionScenes('proj_a', curtas, db);
    assert.fail('deveria ter recusado');
  } catch (erro) {
    assert.match(erro.message, /40s/);
    assert.match(erro.message, /120s/);
    assert.match(erro.message, new RegExp(`${DURATION_TOLERANCE_SECONDS}s`));
    assert.equal(erro.detail.soma, 40);
    assert.equal(erro.detail.alvo, 120);
  }
  db.close();
});

// ── I · a cena de outro projeto ─────────────────────────────────────────────

test('I. a cena 2 de um projeto NUNCA é a cena 2 do outro', () => {
  const db = banco();
  comPlano(db, 'proj_a');
  comRoteiro(db, 'proj_a');
  replaceProductionScenes('proj_a', quatroCenas(), db);

  comPlano(db, 'proj_b', { title: 'B' });
  saveProductionScript({ projectId: 'proj_b', title: 'B', fullText: 'Outro roteiro.' }, db);
  replaceProductionScenes('proj_b', [
    { ordinal: 1, title: 'Única de B', durationSeconds: 120 },
  ], db);

  assert.equal(getProductionScene('proj_a', 2, db).title, 'O roubo');
  // O projeto B tem uma cena só: pedir a 2 dele devolve nada — nunca a de A.
  assert.equal(getProductionScene('proj_b', 2, db), null);
  assert.equal(getProductionScene('proj_b', 1, db).title, 'Única de B');
  db.close();
});

test('I-bis. um projeto sem roteiro não tem cena nenhuma, e não erra por isso', () => {
  const db = banco();
  assert.equal(getProductionScene('proj_a', 1, db), null);
  assert.deepEqual(listProductionScenes('proj_a', db), []);
  db.close();
});

test('I-ter. um número de cena inválido devolve nada em vez de adivinhar', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);
  replaceProductionScenes('proj_a', quatroCenas(), db);

  for (const invalido of [0, -1, null, undefined, '', 'quatro', []]) {
    assert.equal(getProductionScene('proj_a', invalido, db), null,
      `${JSON.stringify(invalido)} não pode virar uma cena`);
  }
  db.close();
});

// ── J · a edição pontual ────────────────────────────────────────────────────

test('J. alterar a cena 2 muda a cena 2 e mais nada', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);
  const antes = replaceProductionScenes('proj_a', quatroCenas(), db);

  const alterada = updateProductionScene('proj_a', 2, {
    narration: 'Prometeu desceu com a brasa escondida no caule — e o mundo mudou.',
  }, db);

  assert.equal(alterada.ordinal, 2);
  assert.match(alterada.narration, /o mundo mudou/);

  const depois = listProductionScenes('proj_a', db);

  // As outras três estão idênticas, campo a campo, inclusive updatedAt.
  for (const ordinal of [1, 3, 4]) {
    const a = antes.find((c) => c.ordinal === ordinal);
    const d = depois.find((c) => c.ordinal === ordinal);
    assert.deepEqual(d, a, `a cena ${ordinal} não deveria ter sido tocada`);
  }

  // E na alterada, só o que foi pedido mudou.
  const a2 = antes.find((c) => c.ordinal === 2);
  const d2 = depois.find((c) => c.ordinal === 2);
  assert.equal(d2.id, a2.id);
  assert.equal(d2.title, a2.title);
  assert.equal(d2.purpose, a2.purpose);
  assert.equal(d2.durationSeconds, a2.durationSeconds);
  assert.equal(d2.visualDescription, a2.visualDescription);
  assert.notEqual(d2.narration, a2.narration);
  db.close();
});

test('J-bis. reduzir a duração de uma cena é obedecido, e a nova soma é informada', () => {
  // "Reduza a cena 4 para 10 segundos" é uma ORDEM. Recusá-la porque a soma
  // passou a divergir do alvo seria a ferramenta desobedecendo ao usuário para
  // defender um número que o próprio usuário escolheu.
  const db = banco();
  comPlano(db);
  comRoteiro(db);
  replaceProductionScenes('proj_a', quatroCenas(), db);

  const alterada = updateProductionScene('proj_a', 4, { durationSeconds: 10 }, db);
  assert.equal(alterada.durationSeconds, 10);

  const resumo = productionSummary('proj_a', db);
  assert.equal(resumo.totalDurationSeconds, 100);
  assert.equal(resumo.targetDurationSeconds, 120);
  assert.equal(resumo.driftSeconds, -20, 'o desvio é informado, não escondido');
  db.close();
});

test('J-ter. campos não editáveis, e alteração vazia, são recusados', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);
  replaceProductionScenes('proj_a', quatroCenas(), db);

  for (const patch of [
    { ordinal: 7 }, { id: 'scene_x' }, { scriptId: 's' }, { status: 'aprovado' },
    { createdAt: 1 }, { projectId: 'proj_b' },
  ]) {
    assert.throws(() => updateProductionScene('proj_a', 2, patch, db), DomainError,
      `${JSON.stringify(patch)} deveria ser recusado`);
  }
  assert.throws(() => updateProductionScene('proj_a', 2, {}, db), /Nenhuma alteração/);
  assert.throws(() => updateProductionScene('proj_a', 2, { durationSeconds: 0 }, db), DomainError);

  // Nada disso mudou nada.
  assert.equal(getProductionScene('proj_a', 2, db).ordinal, 2);
  assert.equal(getProductionScene('proj_a', 2, db).durationSeconds, 30);
  db.close();
});

test('J-quater. alterar uma cena que não existe é recusado com o número na mensagem', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);
  replaceProductionScenes('proj_a', quatroCenas(), db);

  assert.throws(() => updateProductionScene('proj_a', 9, { title: 'X' }, db), /cena 9/);
  db.close();
});

// ── K · L · a substituição é transacional ───────────────────────────────────

test('K. replace_scenes substitui o conjunto inteiro, sem sobra do anterior', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);
  replaceProductionScenes('proj_a', quatroCenas(), db);

  const duas = [
    { ordinal: 1, title: 'Nova 1', durationSeconds: 60, narration: 'A' },
    { ordinal: 2, title: 'Nova 2', durationSeconds: 60, narration: 'B' },
  ];
  const depois = replaceProductionScenes('proj_a', duas, db);

  assert.equal(depois.length, 2);
  assert.deepEqual(depois.map((c) => c.title), ['Nova 1', 'Nova 2']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scenes').get().n, 2,
    'as cenas antigas não podem sobrar');
  db.close();
});

test('L. uma falha no meio da gravação não deixa conjunto parcial', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);
  const antes = replaceProductionScenes('proj_a', quatroCenas(), db);

  // Um INSERT que explode na terceira cena. É o mesmo recurso que
  // domain-scenes.test.mjs já usa para provar atomicidade.
  const prepareOriginal = db.prepare.bind(db);
  let inseridas = 0;
  db.prepare = (sql) => {
    const stmt = prepareOriginal(sql);
    if (!sql.includes('INSERT INTO production_scenes')) return stmt;
    return {
      ...stmt,
      run: (...args) => {
        inseridas += 1;
        if (inseridas === 3) throw new Error('falha simulada no meio');
        return stmt.run(...args);
      },
    };
  };

  const novas = quatroCenas().map((c, i) => ({ ...c, title: `Substituta ${i + 1}` }));
  assert.throws(() => replaceProductionScenes('proj_a', novas, db), /falha simulada/);

  db.prepare = prepareOriginal;

  // O conjunto ANTIGO está inteiro: nem meio novo, nem nenhum.
  const depois = listProductionScenes('proj_a', db);
  assert.deepEqual(depois, antes);
  assert.equal(depois.length, 4);
  db.close();
});

test('L-bis. a transação não fica aberta depois da falha', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);
  replaceProductionScenes('proj_a', quatroCenas(), db);

  const prepareOriginal = db.prepare.bind(db);
  db.prepare = (sql) => {
    const stmt = prepareOriginal(sql);
    if (!sql.includes('INSERT INTO production_scenes')) return stmt;
    return { ...stmt, run: () => { throw new Error('falha simulada'); } };
  };
  assert.throws(() => replaceProductionScenes('proj_a', quatroCenas(), db), /falha simulada/);
  db.prepare = prepareOriginal;

  // Se a transação tivesse ficado aberta, este BEGIN falharia.
  db.exec('BEGIN');
  db.exec('ROLLBACK');
  assert.equal(listProductionScenes('proj_a', db).length, 4);
  db.close();
});

test('L-ter. limites: nenhuma cena, e cenas demais, são recusadas', () => {
  const db = banco();
  comPlano(db, 'proj_a', { targetDurationSeconds: MAX_SCENES });
  comRoteiro(db);

  assert.throws(() => replaceProductionScenes('proj_a', [], db), /pelo menos uma cena/);
  assert.throws(() => replaceProductionScenes('proj_a', 'nada', db), /lista/);

  const demais = Array.from({ length: MAX_SCENES + 1 }, (_, i) => ({
    ordinal: i + 1, title: `C${i + 1}`, durationSeconds: 1,
  }));
  assert.throws(() => replaceProductionScenes('proj_a', demais, db), new RegExp(`${MAX_SCENES} cenas`));

  // No limite, passa: o alvo foi escolhido para a conta fechar.
  const noLimite = Array.from({ length: MAX_SCENES }, (_, i) => ({
    ordinal: i + 1, title: `C${i + 1}`, durationSeconds: 1,
  }));
  assert.equal(replaceProductionScenes('proj_a', noLimite, db).length, MAX_SCENES);
  db.close();
});

test('L-quater. um campo desconhecido numa cena é recusado, não ignorado', () => {
  const db = banco();
  comPlano(db);
  comRoteiro(db);

  const cenas = quatroCenas();
  cenas[0].projectId = 'proj_b';
  assert.throws(() => replaceProductionScenes('proj_a', cenas, db), /projectId/);

  const comId = quatroCenas();
  comId[0].id = 'scene_escolhido_por_fora';
  assert.throws(() => replaceProductionScenes('proj_a', comId, db), /id/);
  db.close();
});

// ── M · apagar o projeto ────────────────────────────────────────────────────

test('M. apagar o projeto leva plano, roteiro, cenas e fontes junto', () => {
  const db = banco();
  const doc = createProjectDocument({
    projectId: 'proj_a', filename: 'a.txt', mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 10, sha256: SHA, chunks: [{ text: 'texto' }],
  }, db);
  comPlano(db, 'proj_a', { sourceDocumentIds: [doc.id] });
  comRoteiro(db);
  replaceProductionScenes('proj_a', quatroCenas(), db);

  comPlano(db, 'proj_b', { title: 'B' });
  saveProductionScript({ projectId: 'proj_b', title: 'B', fullText: 'Roteiro de B.' }, db);

  assert.equal(deleteProject('proj_a', db), true);

  assert.equal(getProductionPlan('proj_a', db), null);
  assert.equal(getProductionScript('proj_a', db), null);
  assert.deepEqual(listProductionScenes('proj_a', db), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_scenes').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_plan_sources').get().n, 0);

  // E o outro projeto continua inteiro.
  assert.equal(getProductionPlan('proj_b', db).title, 'B');
  db.close();
});

// ── N · a migração 8 → 9 ────────────────────────────────────────────────────

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-producao-'));
test.after(async () => { await rm(RAIZ, { recursive: true, force: true }); });

test('N. a migração 8 → 9 preserva tudo o que já estava no banco', async () => {
  const caminho = path.join(RAIZ, 'migracao.db');

  // Um banco no estado ANTERIOR: as tabelas de 1 a 8, com dados.
  const primeira = openDatabase(caminho);
  assert.equal(schemaVersion(primeira), ESQUEMA_ATUAL);
  createProject({ id: 'proj_antigo', name: 'Existia antes' }, primeira);
  const cenaLegada = createSceneRecord({
    projectId: 'proj_antigo', title: 'Cena do storyboard', duration: 6,
  }, primeira);
  createProjectDocument({
    projectId: 'proj_antigo', filename: 'antigo.txt', mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 10, sha256: SHA, chunks: [{ text: 'material antigo' }],
  }, primeira);

  // Volta ao 8 à força, como um banco que nunca viu a migração 9.
  primeira.exec('DROP TABLE production_plan_sources');
  primeira.exec('DROP TABLE production_scenes');
  primeira.exec('DROP TABLE production_scripts');
  primeira.exec('DROP TABLE production_plans');
  primeira.exec('PRAGMA user_version = 8');
  primeira.close();

  // Reabrir aplica só o que falta.
  const segunda = openDatabase(caminho);
  assert.equal(schemaVersion(segunda), 9);
  assert.equal(ESQUEMA_ATUAL, 9);

  // Tudo o que existia continua lá, byte a byte.
  assert.equal(segunda.prepare('SELECT name FROM projects WHERE id = ?').get('proj_antigo').name, 'Existia antes');
  assert.deepEqual(listScenes('proj_antigo', segunda).map((c) => c.id), [cenaLegada.id]);
  assert.equal(segunda.prepare('SELECT COUNT(*) AS n FROM project_documents').get().n, 1);
  assert.equal(segunda.prepare('SELECT COUNT(*) AS n FROM document_chunks').get().n, 1);

  // E as tabelas novas existem, vazias.
  for (const tabela of ['production_plans', 'production_plan_sources',
    'production_scripts', 'production_scenes']) {
    assert.equal(segunda.prepare(`SELECT COUNT(*) AS n FROM ${tabela}`).get().n, 0);
  }

  // O planejamento funciona no banco migrado.
  saveProductionPlan({ projectId: 'proj_antigo', title: 'Novo plano', targetDurationSeconds: 60 }, segunda);
  assert.equal(getProductionPlan('proj_antigo', segunda).title, 'Novo plano');
  segunda.close();
});

test('N-bis. a tabela `scenes` da migração 1 continua exatamente como era', () => {
  // O PASSO 12 NÃO evoluiu a tabela antiga: ela é de outra família (o
  // storyboard da tela) e não foi tocada. Se alguém a alterar, este teste cai —
  // e cair é o ponto, porque alterá-la mudaria o significado de uma tabela
  // publicada.
  const db = banco();
  const colunas = db.prepare('PRAGMA table_info(scenes)').all().map((c) => c.name);
  assert.deepEqual(colunas, [
    'id', 'projectId', 'number', 'title', 'description', 'duration', 'modelId',
    'status', 'revisionNote', 'image', 'videoId', 'createdAt', 'updatedAt',
  ]);

  // E ela continua funcionando como sempre funcionou.
  const cena = createSceneRecord({ projectId: 'proj_a', title: 'Legada' }, db);
  assert.equal(cena.number, 1);
  assert.equal(listScenes('proj_a', db).length, 1);
  // As duas famílias não se enxergam.
  assert.deepEqual(listProductionScenes('proj_a', db), []);
  db.close();
});

// ── a forma pública ─────────────────────────────────────────────────────────

test('a forma pública não carrega identidade interna', () => {
  const db = banco();
  const plano = comPlano(db);
  comRoteiro(db);
  const cenas = replaceProductionScenes('proj_a', quatroCenas(), db);

  const proibidos = ['id', 'projectId', 'scriptId'];

  for (const [nome, publico] of [
    ['plano', publicProductionPlan(plano)],
    ['cena', publicProductionScene(cenas[0])],
    ['cena em lista', publicProductionSceneSummary(cenas[0])],
  ]) {
    for (const campo of proibidos) {
      assert.equal(campo in publico, false, `${nome} público não pode carregar ${campo}`);
    }
  }

  assert.deepEqual(Object.keys(publicProductionPlan(plano)), declaredPlanFields());
  assert.deepEqual(Object.keys(publicProductionScene(cenas[0])), declaredSceneFields());
  assert.deepEqual(
    Object.keys(publicProductionSceneSummary(cenas[0])),
    declaredSceneSummaryFields(),
  );

  // Uma cena em LISTA não carrega os textos longos: quarenta delas não caberiam
  // num turno, e quem lista está procurando, não lendo.
  const emLista = publicProductionSceneSummary(cenas[0]);
  assert.equal('narration' in emLista, false);
  assert.equal('visualDescription' in emLista, false);
  // E numa leitura individual, carregam.
  assert.match(publicProductionScene(cenas[0]).visualDescription, /Monte Olimpo/);

  assert.equal(publicProductionPlan(null), null);
  assert.equal(publicProductionScene(null), null);
  db.close();
});

test('um texto comprido demais é cortado, não recusado', () => {
  // Um plano inteiro recusado por causa de uma sinopse comprida faria o agente
  // perder um turno reescrevendo o que já estava certo. Uma DURAÇÃO fora do
  // lugar é outra coisa, e essa continua sendo recusada — ali o número errado
  // muda o filme.
  const db = banco();
  const plano = saveProductionPlan({
    projectId: 'proj_a', title: 'T', targetDurationSeconds: 60,
    synopsis: 'x'.repeat(10000),
  }, db);
  assert.equal(plano.synopsis.length, 4000);
  db.close();
});

test('o resumo da produção responde as três perguntas de uma vez', () => {
  const db = banco();
  assert.deepEqual(productionSummary('proj_a', db), {
    sceneCount: 0, totalDurationSeconds: 0, targetDurationSeconds: null,
    driftSeconds: null, toleranceSeconds: DURATION_TOLERANCE_SECONDS,
  });

  comPlano(db);
  comRoteiro(db);
  replaceProductionScenes('proj_a', quatroCenas(), db);

  assert.deepEqual(productionSummary('proj_a', db), {
    sceneCount: 4, totalDurationSeconds: 120, targetDurationSeconds: 120,
    driftSeconds: 0, toleranceSeconds: DURATION_TOLERANCE_SECONDS,
  });
  db.close();
});
