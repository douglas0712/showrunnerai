// As ferramentas de planejamento de produção, e a fronteira delas.
//
// PASSO 12. Oito ferramentas entram no registry:
//
//   project.get_production_plan    o que esta produção vai ser
//   project.save_production_plan
//   project.get_script             o roteiro
//   project.save_script
//   project.list_scenes            a estrutura
//   project.get_scene              uma cena inteira
//   project.replace_scenes         a criação do conjunto
//   project.update_scene           a edição de uma
//
// O que estes testes trancam é sempre a mesma coisa: **a AUTORIDADE é o
// `projectId` do ToolContext, e o modelo não participa dela**. Um agente que
// pudesse dizer em qual projeto gravar um plano seria um agente sem fronteira —
// e o plano de uma produção é exatamente o tipo de coisa que não pode vazar
// para outra.
//
// E há uma segunda garantia, que é a forma desta família: **uma cena é
// endereçada pela POSIÇÃO, nunca por um identificador**. O `id` de uma cena não
// aparece em nenhum resultado, e não existe argumento por onde ele entre. Com
// isso, cross-project deixa de ser recusado e passa a ser impronunciável: não
// há um número que signifique "a cena de outro projeto".

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getProductionPlanTool, saveProductionPlanTool,
} from '../lib/server/agent/tools/handlers/productionPlan.js';
import { getScriptTool, saveScriptTool } from '../lib/server/agent/tools/handlers/productionScript.js';
import {
  getSceneTool, listScenesTool, replaceScenesTool, updateSceneTool,
} from '../lib/server/agent/tools/handlers/productionScenes.js';
import { publicToolList, toolRegistry } from '../lib/server/agent/tools/index.js';
import { handleBridgeInvocation } from '../lib/server/agent/hermes/bridge.js';
import { bindRuntimeSession } from '../lib/server/agent/hermes/sessionBinding.js';
import {
  canonicalToolNames, hermesAliases, toCanonicalToolName, UnknownToolAliasError,
} from '../lib/server/agent/hermes/aliases.js';
import { AGENT_EVENTS, normalizeAgentEvent, publicAgentEvent } from '../lib/server/agent/events.js';
import { closeDatabase, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createProjectDocument } from '../lib/server/domain/documents.js';
import { DOCUMENT_TYPES } from '../lib/server/domain/documentTypes.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import {
  DURATION_TOLERANCE_SECONDS, getProductionPlan, listProductionScenes,
} from '../lib/server/domain/production.js';

const SHA = 'd'.repeat(64);
const CHAVE = Symbol.for('showrunner.domain.db');

const AS_OITO = [
  'project.get_production_plan',
  'project.save_production_plan',
  'project.get_script',
  'project.save_script',
  'project.list_scenes',
  'project.get_scene',
  'project.replace_scenes',
  'project.update_scene',
];

test.after(() => {
  closeDatabase();
  delete globalThis[CHAVE];
});

/**
 * Dois projetos, duas conversas, um documento em cada.
 *
 * As tools abrem o banco da APLICAÇÃO (elas rodam num turno real, onde não há
 * injeção de dependência a atravessar o socket do plugin), então a instância
 * global é trocada por uma em memória — mesmo recurso de
 * `agent-document-tools.test.mjs`.
 */
function cenario() {
  closeDatabase();
  const db = openDatabase(':memory:');
  globalThis[CHAVE] = db;

  createProject({ id: 'proj_a', name: 'Produção A' }, db);
  createProject({ id: 'proj_b', name: 'Produção B' }, db);

  const threadA = createThreadRecord({ projectId: 'proj_a', title: 'A' }, db);
  const threadB = createThreadRecord({ projectId: 'proj_b', title: 'B' }, db);

  const docA = createProjectDocument({
    projectId: 'proj_a', filename: 'prometeu.pdf', mimeType: DOCUMENT_TYPES.PDF,
    sizeBytes: 4096, sha256: SHA, pageCount: 6,
    chunks: [{ pageNumber: 1, text: 'Prometeu roubou o fogo dos deuses.' }],
  }, db);
  const docB = createProjectDocument({
    projectId: 'proj_b', filename: 'outro.txt', mimeType: DOCUMENT_TYPES.TEXT,
    sizeBytes: 32, sha256: SHA, chunks: [{ text: 'Material do projeto B.' }],
  }, db);

  return {
    db,
    docA,
    docB,
    ctxA: { threadId: threadA.id, projectId: 'proj_a', userMessageId: null, signal: null },
    ctxB: { threadId: threadB.id, projectId: 'proj_b', userMessageId: null, signal: null },
  };
}

const PLANO = {
  title: 'Prometeu — o fogo da humanidade',
  logline: 'O titã que roubou o fogo dos deuses e pagou por isso.',
  format: 'minidocumentário',
  targetDurationSeconds: 120,
  tone: 'épico',
};

const ROTEIRO = {
  title: 'Prometeu',
  summary: 'Quatro movimentos.',
  fullText: 'ABERTURA. O Olimpo ao amanhecer. NARRAÇÃO: no alto, o fogo era privilégio...',
};

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
      ordinal: 3, title: 'A punição', purpose: 'O preço',
      durationSeconds: 30, narration: 'Acorrentado ao Cáucaso.',
      visualDescription: 'Plano aberto da rocha, a águia em silhueta.',
    },
    {
      ordinal: 4, title: 'A libertação', purpose: 'Fechar o arco',
      durationSeconds: 30, narration: 'Héracles quebrou as correntes.',
      visualDescription: 'Contra-luz, as correntes caindo.',
    },
  ];
}

/** Plano + roteiro + cenas, pelas ferramentas — nunca pelo domínio direto. */
async function produçãoCompleta(ctx, extraPlano = {}) {
  await saveProductionPlanTool.execute(ctx, { ...PLANO, ...extraPlano });
  await saveScriptTool.execute(ctx, ROTEIRO);
  await replaceScenesTool.execute(ctx, { scenes: quatroCenas() });
}

// ── O · P · o projeto nunca vem do modelo ───────────────────────────────────

test('O. nenhum schema tem projectId — nem opcional', () => {
  const tools = publicToolList(toolRegistry()).filter((t) => AS_OITO.includes(t.name));
  assert.equal(tools.length, 8, 'as oito ferramentas precisam estar no registry');

  // Um `projectId` opcional seria pior do que inútil: o modelo o preencheria de
  // boa-fé, e a ferramenta teria de escolher entre obedecer (e vazar entre
  // projetos) ou ignorar (e ter um campo que mente sobre o que faz).
  const proibidos = ['projectId', 'threadId', 'sessionId', 'workflowId',
    'nodeId', 'path', 'filename', 'assetId', 'jobId'];

  for (const tool of tools) {
    const texto = JSON.stringify(tool.inputSchema);
    for (const campo of proibidos) {
      assert.equal(texto.includes(campo), false,
        `${tool.name} expõe "${campo}" ao modelo`);
    }
  }
});

test('O-bis. as três ferramentas de leitura não recebem argumento nenhum', () => {
  for (const tool of [getProductionPlanTool, getScriptTool, listScenesTool]) {
    assert.deepEqual(tool.inputSchema.properties, {},
      `${tool.name} deveria ter schema vazio`);
    assert.deepEqual(tool.inputSchema.required, []);
  }
});

test('O-ter. um projectId enfiado nos argumentos é RECUSADO, não ignorado', async () => {
  const { ctxA, db } = cenario();

  // Aceitar em silêncio ensinaria ao modelo que o campo existe e que ele foi
  // obedecido — e a próxima chamada viria com o projeto do vizinho.
  await assert.rejects(
    () => saveProductionPlanTool.execute(ctxA, { ...PLANO, projectId: 'proj_b' }),
    /projectId/,
  );
  await assert.rejects(
    () => getProductionPlanTool.execute(ctxA, { projectId: 'proj_b' }),
    /não recebe argumentos/,
  );
  await assert.rejects(
    () => listScenesTool.execute(ctxA, { projectId: 'proj_b' }),
    /não recebe argumentos/,
  );

  // E nada foi gravado em lugar nenhum.
  assert.equal(getProductionPlan('proj_a', db), null);
  assert.equal(getProductionPlan('proj_b', db), null);
});

test('P. o ToolContext manda: a mesma chamada grava em projetos diferentes', async () => {
  const { ctxA, ctxB, db } = cenario();

  await saveProductionPlanTool.execute(ctxA, { ...PLANO, title: 'Plano de A' });
  await saveProductionPlanTool.execute(ctxB, { ...PLANO, title: 'Plano de B' });

  assert.equal(getProductionPlan('proj_a', db).title, 'Plano de A');
  assert.equal(getProductionPlan('proj_b', db).title, 'Plano de B');
});

test('P-bis. sem projeto na conversa, toda ferramenta desta família recusa', async () => {
  cenario();
  const semProjeto = { threadId: 'thread_x', projectId: null };

  const chamadas = [
    [getProductionPlanTool, {}],
    [saveProductionPlanTool, PLANO],
    [getScriptTool, {}],
    [saveScriptTool, ROTEIRO],
    [listScenesTool, {}],
    [getSceneTool, { ordinal: 1 }],
    [replaceScenesTool, { scenes: quatroCenas() }],
    [updateSceneTool, { ordinal: 1, title: 'X' }],
  ];

  for (const [tool, args] of chamadas) {
    await assert.rejects(() => tool.execute(semProjeto, args), /não está ligada a um projeto/,
      `${tool.name} deveria recusar`);
  }

  // E sem thread também — não há turno.
  for (const [tool, args] of chamadas) {
    await assert.rejects(() => tool.execute({ projectId: 'proj_a' }, args), /threadId/,
      `${tool.name} deveria exigir a conversa`);
  }
});

// ── Q · R · o plano ─────────────────────────────────────────────────────────

test('Q. get_production_plan devolve nulo honesto quando não há plano', async () => {
  const { ctxA } = cenario();
  const r = await getProductionPlanTool.execute(ctxA, {});

  assert.deepEqual(r, {
    plan: null, sources: [], hasScript: false, sceneCount: 0, totalDurationSeconds: 0,
  });
});

test('Q-bis. get_production_plan é o retrato do estado real da produção', async () => {
  const { ctxA, docA } = cenario();
  await saveProductionPlanTool.execute(ctxA, { ...PLANO, sourceDocumentIds: [docA.id] });
  await saveScriptTool.execute(ctxA, ROTEIRO);
  await replaceScenesTool.execute(ctxA, { scenes: quatroCenas() });

  const r = await getProductionPlanTool.execute(ctxA, {});
  assert.equal(r.plan.title, PLANO.title);
  assert.equal(r.plan.targetDurationSeconds, 120);
  assert.equal(r.plan.status, 'rascunho');
  assert.deepEqual(r.sources, [{ documentId: docA.id, filename: 'prometeu.pdf' }]);
  assert.equal(r.hasScript, true);
  assert.equal(r.sceneCount, 4);
  assert.equal(r.totalDurationSeconds, 120);
});

test('R. save_production_plan grava, substitui e devolve o que gravou', async () => {
  const { ctxA, db } = cenario();

  const primeiro = await saveProductionPlanTool.execute(ctxA, PLANO);
  assert.equal(primeiro.plan.title, PLANO.title);
  assert.equal(primeiro.plan.format, 'minidocumentário');

  const segundo = await saveProductionPlanTool.execute(ctxA, {
    ...PLANO, title: 'Outro', targetDurationSeconds: 240,
  });
  assert.equal(segundo.plan.title, 'Outro');
  assert.equal(segundo.plan.targetDurationSeconds, 240);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM production_plans').get().n, 1);
});

test('R-bis. um documento de OUTRO projeto não pode ser fonte', async () => {
  const { ctxA, docB, db } = cenario();

  await assert.rejects(
    () => saveProductionPlanTool.execute(ctxA, { ...PLANO, sourceDocumentIds: [docB.id] }),
    /não tem um documento com esse identificador/,
  );
  assert.equal(getProductionPlan('proj_a', db), null);
});

test('R-ter. campos internos nos argumentos são recusados com o nome deles', async () => {
  const { ctxA } = cenario();

  for (const campo of ['id', 'status', 'createdAt', 'updatedAt', 'projectId']) {
    await assert.rejects(
      () => saveProductionPlanTool.execute(ctxA, { ...PLANO, [campo]: 'x' }),
      new RegExp(campo),
      `${campo} deveria ser recusado`,
    );
  }
});

// ── S · T · o roteiro ───────────────────────────────────────────────────────

test('S. get_script devolve nulo honesto, e depois o roteiro inteiro', async () => {
  const { ctxA } = cenario();

  assert.deepEqual(await getScriptTool.execute(ctxA, {}), {
    script: null, sceneCount: 0, totalDurationSeconds: 0,
  });

  await saveProductionPlanTool.execute(ctxA, PLANO);
  await saveScriptTool.execute(ctxA, ROTEIRO);

  const r = await getScriptTool.execute(ctxA, {});
  assert.equal(r.script.title, 'Prometeu');
  assert.match(r.script.fullText, /O Olimpo ao amanhecer/);
  assert.equal(r.sceneCount, 0);
});

test('T. save_script exige o plano antes, e a mensagem diz isso', async () => {
  const { ctxA } = cenario();

  await assert.rejects(
    () => saveScriptTool.execute(ctxA, ROTEIRO),
    /grave o plano antes do roteiro/,
  );

  await saveProductionPlanTool.execute(ctxA, PLANO);
  const r = await saveScriptTool.execute(ctxA, ROTEIRO);
  assert.equal(r.script.title, 'Prometeu');
});

test('T-bis. o roteiro é do projeto do contexto, e um não vê o do outro', async () => {
  const { ctxA, ctxB } = cenario();

  await saveProductionPlanTool.execute(ctxA, PLANO);
  await saveScriptTool.execute(ctxA, { ...ROTEIRO, title: 'Roteiro de A' });

  assert.equal((await getScriptTool.execute(ctxB, {})).script, null);
  assert.equal((await getScriptTool.execute(ctxA, {})).script.title, 'Roteiro de A');
});

// ── U · V · a leitura das cenas ─────────────────────────────────────────────

test('U. list_scenes vem ordenada, com o alvo e a soma, e SEM os textos longos', async () => {
  const { ctxA } = cenario();
  await produçãoCompleta(ctxA);

  const r = await listScenesTool.execute(ctxA, {});

  assert.equal(r.sceneCount, 4);
  assert.equal(r.totalDurationSeconds, 120);
  assert.equal(r.targetDurationSeconds, 120);
  assert.deepEqual(r.scenes.map((c) => c.ordinal), [1, 2, 3, 4]);
  assert.deepEqual(r.scenes.map((c) => c.title),
    ['O Olimpo', 'O roubo', 'A punição', 'A libertação']);

  // O bastante para ESCOLHER qual editar…
  for (const cena of r.scenes) {
    assert.ok(cena.purpose, 'o propósito é o que distingue uma cena da outra numa lista');
    assert.ok(cena.durationSeconds > 0);
    // …e não o bastante para estourar o turno.
    assert.equal('narration' in cena, false);
    assert.equal('visualDescription' in cena, false);
    assert.equal('id' in cena, false);
  }
});

test('V. get_scene devolve a cena inteira, pelo número dela', async () => {
  const { ctxA } = cenario();
  await produçãoCompleta(ctxA);

  const r = await getSceneTool.execute(ctxA, { ordinal: 2 });
  assert.equal(r.scene.ordinal, 2);
  assert.equal(r.scene.title, 'O roubo');
  assert.match(r.scene.narration, /brasa escondida/);
  assert.match(r.scene.visualDescription, /caule oco/);
  assert.equal('id' in r.scene, false, 'o id da cena não sai do servidor');
});

test('V-bis. get_scene com número que não existe recusa com o número na frase', async () => {
  const { ctxA } = cenario();
  await produçãoCompleta(ctxA);

  await assert.rejects(() => getSceneTool.execute(ctxA, { ordinal: 9 }), /cena 9/);
});

test('V-ter. um número inválido é recusado, nunca coagido em silêncio', async () => {
  const { ctxA } = cenario();
  await produçãoCompleta(ctxA);

  // `Number("")` é 0 e `Number([])` também: um ordinal que vira 0 sem reclamar
  // transformaria um pedido noutro.
  for (const invalido of ['', [], {}, null, 1.5, 'quatro', true]) {
    await assert.rejects(() => getSceneTool.execute(ctxA, { ordinal: invalido }),
      /número da cena|cenas começam/,
      `${JSON.stringify(invalido)} deveria ser recusado`);
  }
  await assert.rejects(() => getSceneTool.execute(ctxA, { ordinal: 0 }), /começam na número 1/);

  // Os dígitos de um inteiro continuam valendo — é o que um runtime pode mandar.
  assert.equal((await getSceneTool.execute(ctxA, { ordinal: '3' })).scene.ordinal, 3);
});

test('V-quater. a cena 2 de um projeto nunca é alcançada pelo contexto do outro', async () => {
  const { ctxA, ctxB } = cenario();
  await produçãoCompleta(ctxA);

  // Não há argumento por onde pedir a cena de outro projeto. O melhor que se
  // pode fazer é pedir a mesma POSIÇÃO no projeto errado — e ela não existe lá.
  await assert.rejects(() => getSceneTool.execute(ctxB, { ordinal: 2 }), /cena 2/);
  assert.equal((await listScenesTool.execute(ctxB, {})).sceneCount, 0);
});

// ── W · a criação do conjunto ───────────────────────────────────────────────

test('W. replace_scenes grava o conjunto e devolve a estrutura resultante', async () => {
  const { ctxA, db } = cenario();
  await saveProductionPlanTool.execute(ctxA, PLANO);
  await saveScriptTool.execute(ctxA, ROTEIRO);

  const r = await replaceScenesTool.execute(ctxA, { scenes: quatroCenas() });

  assert.equal(r.sceneCount, 4);
  assert.equal(r.totalDurationSeconds, 120);
  assert.equal(r.targetDurationSeconds, 120);
  assert.deepEqual(r.scenes.map((c) => c.ordinal), [1, 2, 3, 4]);
  assert.equal(listProductionScenes('proj_a', db).length, 4);
});

test('W-bis. replace_scenes exige plano e roteiro, e diz qual falta', async () => {
  const { ctxA } = cenario();

  await assert.rejects(
    () => replaceScenesTool.execute(ctxA, { scenes: quatroCenas() }),
    /grave o plano antes das cenas/,
  );

  await saveProductionPlanTool.execute(ctxA, PLANO);
  await assert.rejects(
    () => replaceScenesTool.execute(ctxA, { scenes: quatroCenas() }),
    /grave o roteiro antes das cenas/,
  );
});

test('W-ter. ordinal duplicado, duração inválida e soma fora do alvo são recusados', async () => {
  const { ctxA, db } = cenario();
  await saveProductionPlanTool.execute(ctxA, PLANO);
  await saveScriptTool.execute(ctxA, ROTEIRO);

  const duplicado = quatroCenas();
  duplicado[3].ordinal = 2;
  await assert.rejects(() => replaceScenesTool.execute(ctxA, { scenes: duplicado }), /número 2/);

  const semDuração = quatroCenas();
  semDuração[1].durationSeconds = 0;
  await assert.rejects(() => replaceScenesTool.execute(ctxA, { scenes: semDuração }), /maior que zero/);

  const curtas = quatroCenas().map((c) => ({ ...c, durationSeconds: 5 }));
  await assert.rejects(
    () => replaceScenesTool.execute(ctxA, { scenes: curtas }),
    new RegExp(`diferença aceita é de até ${DURATION_TOLERANCE_SECONDS}s`),
  );

  assert.equal(listProductionScenes('proj_a', db).length, 0, 'nenhuma recusa deixou sobra');
});

test('W-quater. a recusa de soma é ACIONÁVEL: diz a soma, o alvo e a tolerância', async () => {
  // Uma mensagem que só diz "não" obriga o agente a adivinhar quanto mudar, e
  // ele gasta o turno tentando. Esta diz tudo o que falta para acertar de
  // primeira.
  const { ctxA } = cenario();
  await saveProductionPlanTool.execute(ctxA, PLANO);
  await saveScriptTool.execute(ctxA, ROTEIRO);

  try {
    await replaceScenesTool.execute(ctxA, {
      scenes: quatroCenas().map((c) => ({ ...c, durationSeconds: 5 })),
    });
    assert.fail('deveria ter recusado');
  } catch (erro) {
    assert.equal(erro.name, 'ToolExecutionError');
    assert.match(erro.message, /20s/);
    assert.match(erro.message, /120s/);
    assert.match(erro.message, /ajuste as durações e grave de novo/);
  }
});

// ── X · a edição de uma cena ────────────────────────────────────────────────

test('X. update_scene muda a cena pedida e mais nenhuma', async () => {
  const { ctxA, db } = cenario();
  await produçãoCompleta(ctxA);
  const antes = listProductionScenes('proj_a', db);

  const r = await updateSceneTool.execute(ctxA, {
    ordinal: 2,
    narration: 'Prometeu desceu com a brasa escondida — e o mundo mudou para sempre.',
  });

  assert.equal(r.scene.ordinal, 2);
  assert.match(r.scene.narration, /para sempre/);
  assert.equal(r.totalDurationSeconds, 120);
  assert.equal(r.targetDurationSeconds, 120);

  const depois = listProductionScenes('proj_a', db);
  for (const ordinal of [1, 3, 4]) {
    assert.deepEqual(
      depois.find((c) => c.ordinal === ordinal),
      antes.find((c) => c.ordinal === ordinal),
      `a cena ${ordinal} não deveria ter sido tocada`,
    );
  }
  // Na alterada, só a narração mudou.
  const a2 = antes.find((c) => c.ordinal === 2);
  const d2 = depois.find((c) => c.ordinal === 2);
  assert.equal(d2.title, a2.title);
  assert.equal(d2.durationSeconds, a2.durationSeconds);
  assert.equal(d2.visualDescription, a2.visualDescription);
});

test('X-bis. reduzir a duração de uma cena é obedecido, e a nova soma é informada', async () => {
  // "Reduza a cena 4 para 10 segundos" é uma ordem. Recusá-la porque a soma
  // passou a divergir do alvo seria a ferramenta desobedecendo ao usuário para
  // defender um número que ele mesmo escolheu — e acabou de mudar.
  const { ctxA } = cenario();
  await produçãoCompleta(ctxA);

  const r = await updateSceneTool.execute(ctxA, { ordinal: 4, durationSeconds: 10 });
  assert.equal(r.scene.durationSeconds, 10);
  assert.equal(r.totalDurationSeconds, 100);
  assert.equal(r.targetDurationSeconds, 120, 'o alvo é informado para o agente poder avisar');
});

test('X-ter. update_scene sem nada a mudar, ou com campo interno, é recusado', async () => {
  const { ctxA } = cenario();
  await produçãoCompleta(ctxA);

  await assert.rejects(() => updateSceneTool.execute(ctxA, { ordinal: 2 }), /Diga o que muda/);

  for (const campo of ['id', 'scriptId', 'projectId', 'status', 'createdAt']) {
    await assert.rejects(
      () => updateSceneTool.execute(ctxA, { ordinal: 2, [campo]: 'x' }),
      new RegExp(campo),
      `${campo} deveria ser recusado`,
    );
  }
});

test('X-quater. mudar o número de uma cena por update_scene é recusado', async () => {
  // Renumerar é reordenar o filme, e reordenar não é uma edição pontual: ela
  // mexe em todas as posições. Quem faz isso é replace_scenes.
  const { ctxA, db } = cenario();
  await produçãoCompleta(ctxA);

  // `ordinal` é o ENDEREÇO, não um campo editável: mandá-lo duas vezes não é
  // possível, então o que se prova é que ele não é aplicado como alteração.
  const r = await updateSceneTool.execute(ctxA, { ordinal: 2, title: 'Novo título' });
  assert.equal(r.scene.ordinal, 2);
  assert.deepEqual(listProductionScenes('proj_a', db).map((c) => c.ordinal), [1, 2, 3, 4]);
});

test('X-quinquies. update_scene numa cena inexistente não cria nada', async () => {
  const { ctxA, db } = cenario();
  await produçãoCompleta(ctxA);

  await assert.rejects(() => updateSceneTool.execute(ctxA, { ordinal: 9, title: 'X' }), /cena 9/);
  assert.equal(listProductionScenes('proj_a', db).length, 4);
});

// ── Y · o que NÃO atravessa para o navegador ────────────────────────────────

test('Y. nenhum resultado destas ferramentas carrega identidade interna', async () => {
  const { ctxA, docA } = cenario();
  await saveProductionPlanTool.execute(ctxA, { ...PLANO, sourceDocumentIds: [docA.id] });
  await saveScriptTool.execute(ctxA, ROTEIRO);
  await replaceScenesTool.execute(ctxA, { scenes: quatroCenas() });

  const resultados = [
    await getProductionPlanTool.execute(ctxA, {}),
    await getScriptTool.execute(ctxA, {}),
    await listScenesTool.execute(ctxA, {}),
    await getSceneTool.execute(ctxA, { ordinal: 1 }),
    await updateSceneTool.execute(ctxA, { ordinal: 1, title: 'O Olimpo, ao amanhecer' }),
  ];

  for (const r of resultados) {
    const texto = JSON.stringify(r);
    for (const proibido of ['proj_a', 'proj_b', 'plan_', 'script_', 'scene_',
      'thread_', 'runtime/', 'jobId', 'workflowId', SHA]) {
      assert.equal(texto.includes(proibido), false,
        `um resultado carrega "${proibido}": ${texto.slice(0, 200)}`);
    }
  }
});

test('Y-bis. o evento público de uma ferramenta de planejamento sai SEM result', async () => {
  // A redução final descarta o resultado de qualquer ferramenta que não produza
  // Asset — e nenhuma destas produz: o PASSO 12 não gera mídia. Então o roteiro
  // inteiro, que pode ter dezenas de milhares de caracteres, não atravessa para
  // o navegador.
  const { ctxA } = cenario();
  await produçãoCompleta(ctxA);
  const resultado = await getScriptTool.execute(ctxA, {});

  const evento = normalizeAgentEvent({
    type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1',
    name: 'project.get_script', result: resultado,
  });
  const publico = publicAgentEvent(evento);

  assert.equal('result' in publico, false);
  assert.equal(publico.name, 'project.get_script');
  assert.equal(JSON.stringify(publico).includes('Olimpo'), false);
});

test('Y-ter. os argumentos de uma chamada não atravessam para o navegador', async () => {
  // Em `replace_scenes` os argumentos SÃO o roteiro inteiro em cenas.
  const evento = normalizeAgentEvent({
    type: AGENT_EVENTS.TOOL_STARTED, ts: 1, toolCallId: 'c1',
    name: 'project.replace_scenes', arguments: { scenes: quatroCenas() },
  });
  const publico = publicAgentEvent(evento);

  assert.equal('arguments' in publico, false);
  assert.equal(JSON.stringify(publico).includes('Olimpo'), false);
});

// ── Z · os aliases do runtime ───────────────────────────────────────────────

test('Z. cada ferramenta nova tem UM alias, e ele aponta para o nome canônico', () => {
  for (const canonico of AS_OITO) {
    const alias = canonico.replace('.', '_');
    assert.equal(toCanonicalToolName(alias), canonico);
  }

  // A tabela cobre exatamente o registry: nem alias órfão, nem ferramenta muda.
  const doRegistry = publicToolList(toolRegistry()).map((t) => t.name).sort();
  assert.deepEqual(canonicalToolNames().sort(), doRegistry);
  assert.equal(hermesAliases().length, doRegistry.length);
});

test('Z-bis. um alias inventado com o prefixo certo continua sendo recusado', () => {
  // O prefixo `project_` não é senha: a tabela é fechada, não um padrão.
  for (const inventado of ['project_delete_scenes', 'project_save_scenes',
    'project_get_production', 'project_update_plan', 'project_replace_script']) {
    assert.throws(() => toCanonicalToolName(inventado), UnknownToolAliasError);
  }
});

test('Z-ter. o bridge executa a ferramenta pelo alias, com o projeto da SESSÃO', async () => {
  // O caminho inteiro que uma chamada do runtime percorre: alias → canônico →
  // sessão → thread → projeto → registry. Em nenhum ponto dele o modelo diz em
  // qual projeto está.
  const { db, ctxA, ctxB } = cenario();

  bindRuntimeSession({
    threadId: ctxA.threadId, runtimeId: 'falso', sessionId: 'sess_a',
    bridgeSessionId: 'bridge_a',
  }, db);
  bindRuntimeSession({
    threadId: ctxB.threadId, runtimeId: 'falso', sessionId: 'sess_b',
    bridgeSessionId: 'bridge_b',
  }, db);

  const gravar = await handleBridgeInvocation({
    sessionId: 'bridge_a',
    toolName: 'project_save_production_plan',
    arguments: { ...PLANO, title: 'Gravado pela ponte' },
  }, { db });
  assert.equal(gravar.ok, true);

  // Foi para o projeto da sessão A, e a sessão B não o enxerga.
  assert.equal(getProductionPlan('proj_a', db).title, 'Gravado pela ponte');
  assert.equal(getProductionPlan('proj_b', db), null);

  const lerDeB = await handleBridgeInvocation({
    sessionId: 'bridge_b',
    toolName: 'project_get_production_plan',
    arguments: {},
  }, { db });
  assert.equal(lerDeB.ok, true);
  assert.equal(lerDeB.result.plan, null);

  // E o nome canônico NÃO vale como alias na fronteira.
  const comPonto = await handleBridgeInvocation({
    sessionId: 'bridge_a',
    toolName: 'project.save_production_plan',
    arguments: PLANO,
  }, { db });
  assert.equal(comPonto.ok, false);
});
