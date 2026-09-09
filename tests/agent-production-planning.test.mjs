// O PASSO 12 de ponta a ponta, sem runtime de raciocínio real.
//
//     documento do projeto
//       → o agente lê até o fim
//       → grava o plano de produção
//       → grava o roteiro
//       → grava as cenas
//       → responde
//
//     turno seguinte, MESMA conversa
//       → "deixe a cena 2 mais dramática"
//       → só a cena 2 muda
//
//     turno seguinte
//       → "reduza a cena 4 para 10 segundos"
//       → só a cena 4 muda
//
// O runtime é um DUPLO roteirizado, pelo mesmo motivo de
// `agent-document-reading.test.mjs`: um teste que dependesse de um modelo real
// provaria que aquele modelo, naquele dia, se comportou. O que precisa ser
// determinístico é o CAMINHO — se o agente pedir, o Showrunner grava no projeto
// certo, e o que ele gravou continua lá no turno seguinte.
//
// Duas coisas que este arquivo prova e que nenhum outro prova:
//
//   1. **a edição é localizada de verdade.** As cenas não alteradas são
//      comparadas campo a campo, `updatedAt` incluído. Um agente que
//      "reconstruísse" o filme para mudar uma cena passaria em qualquer teste
//      que só olhasse a cena alterada.
//
//   2. **planejar não gera mídia.** Ao fim dos três turnos, `generation_jobs` e
//      `assets` continuam VAZIAS. Este é o critério do passo, e ele é medido no
//      banco, não deduzido de o duplo não ter chamado a ferramenta.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createThread, getThread, sendMessage } from '../lib/server/agent/gateway.js';
import { AGENT_EVENTS, publicAgentEvent } from '../lib/server/agent/events.js';
import { closeDatabase, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { ingestDocument } from '../lib/server/documents/ingest.js';
import {
  getProductionPlan, getProductionScript, listPlanSources, listProductionScenes,
} from '../lib/server/domain/production.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/documents/', import.meta.url));
const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-planejamento-'));
const CHAVE = Symbol.for('showrunner.domain.db');

let contador = 0;

test.after(async () => {
  closeDatabase();
  delete globalThis[CHAVE];
  await rm(RAIZ, { recursive: true, force: true });
});

/**
 * Um projeto com um documento REAL já ingerido, e uma conversa aberta nele.
 *
 * `arquivoDeBanco` faz o banco viver em disco — é o que permite fechá-lo e
 * reabri-lo para provar que o plano sobrevive ao processo.
 */
async function cenario({ emDisco = false } = {}) {
  contador += 1;
  closeDatabase();

  const caminhoDb = emDisco ? path.join(RAIZ, `banco-${contador}.db`) : ':memory:';
  const db = openDatabase(caminhoDb);
  globalThis[CHAVE] = db;

  createProject({ id: 'proj_a', name: 'Produção A' }, db);
  createProject({ id: 'proj_b', name: 'Produção B' }, db);

  const root = path.join(RAIZ, `arquivos-${contador}`);
  const documento = await ingestDocument({
    projectId: 'proj_a',
    filename: 'caderno-de-campo.pdf',
    declaredMimeType: 'application/pdf',
    bytes: await readFile(path.join(FIXTURES, 'multipagina.pdf')),
  }, { db, root });

  const thread = createThread({ projectId: 'proj_a' }, { db });

  return { db, caminhoDb, documento, thread };
}

/**
 * Um runtime que executa um roteiro de chamadas de ferramenta.
 *
 * Ele usa o `invokeTool` que o gateway entrega — o mesmo caminho do adaptador
 * real. O ToolContext, portanto, é o de verdade: montado pelo servidor, com o
 * projeto da conversa e a âncora do turno.
 *
 * O plano é uma FUNÇÃO do contexto e dos resultados já obtidos: é assim que o
 * duplo consegue ler um documento até `eof` seguindo o `nextCursor`, e depois
 * construir o roteiro a partir do que leu — sem que o teste precise saber de
 * antemão quantas chamadas serão.
 */
function runtimeRoteirizado(proximoPasso) {
  const resultados = [];
  const chamadas = [];
  const contextos = [];

  return {
    resultados,
    chamadas,
    contextos,
    id: 'planejador',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run({ context, invokeTool }) {
      contextos.push(context);
      yield { type: AGENT_EVENTS.STARTED, ts: 1 };

      let i = 0;
      let passo = proximoPasso(context, resultados);
      while (passo) {
        i += 1;
        chamadas.push(passo.name);
        yield {
          type: AGENT_EVENTS.TOOL_STARTED, ts: 1, toolCallId: `c${i}`,
          name: passo.name, arguments: passo.args,
        };

        // eslint-disable-next-line no-await-in-loop
        const resultado = await invokeTool(passo.name, passo.args).then(
          (r) => ({ ok: true, r }),
          (erro) => ({ ok: false, erro: erro.message }),
        );
        resultados.push({ name: passo.name, ...resultado });

        yield resultado.ok
          ? {
            type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: `c${i}`,
            name: passo.name, result: resultado.r,
          }
          : {
            type: AGENT_EVENTS.TOOL_FAILED, ts: 1, toolCallId: `c${i}`,
            name: passo.name, error: { message: resultado.erro, code: 'tool_failed' },
          };

        passo = proximoPasso(context, resultados);
      }

      yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: resumo(resultados) };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };
}

/** A "resposta" do duplo: o que ele efetivamente gravou, e nada mais. */
function resumo(resultados) {
  const ultimo = resultados[resultados.length - 1];
  if (!ultimo) return 'Não fiz nada.';
  if (!ultimo.ok) return `Não consegui: ${ultimo.erro}`;

  if (ultimo.name === 'project.replace_scenes') {
    return `Plano gravado: ${ultimo.r.sceneCount} cenas, `
      + `${ultimo.r.totalDurationSeconds}s no total.`;
  }
  if (ultimo.name === 'project.update_scene') {
    return `Cena ${ultimo.r.scene.ordinal} alterada. `
      + `A produção está com ${ultimo.r.totalDurationSeconds}s.`;
  }
  return 'Pronto.';
}

/** O texto lido do documento até aqui, na ordem. */
function textoLido(resultados) {
  return resultados
    .filter((r) => r.ok && r.name === 'project.read_document')
    .flatMap((r) => r.r.chunks.map((c) => c.text))
    .join('\n');
}

function leituraTerminou(resultados) {
  const leituras = resultados.filter((r) => r.ok && r.name === 'project.read_document');
  return leituras.length > 0 && leituras[leituras.length - 1].r.eof === true;
}

function jaChamou(resultados, nome) {
  return resultados.some((r) => r.name === nome);
}

/**
 * O plano do TURNO 1: ler o documento inteiro e transformá-lo numa produção de
 * 60 segundos, em quatro cenas.
 *
 * As narrações saem das FRASES DO DOCUMENTO, não de conhecimento prévio: os
 * fatos do fixture são inventados (Meridian, Elias Venn, o sino Verena), e uma
 * narração que os contenha só pode ter vindo da leitura.
 */
function planoDoPrimeiroTurno(context, resultados) {
  if (!leituraTerminou(resultados)) {
    const leituras = resultados.filter((r) => r.ok && r.name === 'project.read_document');
    const cursor = leituras.length ? leituras[leituras.length - 1].r.nextCursor : undefined;
    return {
      name: 'project.read_document',
      args: {
        documentId: context.attachments[0].documentId,
        ...(cursor === null || cursor === undefined ? {} : { cursor }),
      },
    };
  }

  if (!jaChamou(resultados, 'project.save_production_plan')) {
    return {
      name: 'project.save_production_plan',
      args: {
        title: 'Arkan Vale — caderno de campo',
        logline: 'O que um caderno de campo guarda sobre uma cidade improvável.',
        format: 'minidocumentário',
        targetDurationSeconds: 60,
        tone: 'contemplativo',
        language: 'português',
        sourceDocumentIds: [context.attachments[0].documentId],
      },
    };
  }

  if (!jaChamou(resultados, 'project.save_script')) {
    return {
      name: 'project.save_script',
      args: {
        title: 'Arkan Vale — caderno de campo',
        summary: 'Quatro movimentos, a partir do caderno.',
        fullText: textoLido(resultados),
      },
    };
  }

  if (!jaChamou(resultados, 'project.replace_scenes')) {
    const frases = textoLido(resultados)
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 20);

    return {
      name: 'project.replace_scenes',
      args: {
        scenes: [
          {
            ordinal: 1, title: 'O caderno', purpose: 'Apresentar a fonte',
            durationSeconds: 15, narration: frases[0],
            visualDescription: 'Close no caderno aberto, luz lateral baixa.',
          },
          {
            ordinal: 2, title: 'O rio subterrâneo', purpose: 'A cidade sob a cidade',
            durationSeconds: 15, narration: frases.find((f) => f.includes('Meridian')),
            visualDescription: 'Travelling lento por um túnel úmido, lanterna à frente.',
          },
          {
            ordinal: 3, title: 'A bomba', purpose: 'O gesto fundador',
            durationSeconds: 15, narration: frases.find((f) => f.includes('Elias Venn')),
            visualDescription: 'Plano fechado nas engrenagens, vapor e ferrugem.',
          },
          {
            ordinal: 4, title: 'A torre', purpose: 'Fechar com o som da cidade',
            durationSeconds: 15, narration: frases.find((f) => f.includes('Verena')),
            visualDescription: 'Contra-plongée da torre ao amanhecer, o sino em silhueta.',
          },
        ],
      },
    };
  }

  return null;
}

/** O plano de uma EDIÇÃO: consultar o estado real e mudar uma cena só. */
function planoDeEdicao(ordinal, patch) {
  return (context, resultados) => {
    if (!jaChamou(resultados, 'project.list_scenes')) {
      return { name: 'project.list_scenes', args: {} };
    }
    if (!jaChamou(resultados, 'project.get_scene')) {
      return { name: 'project.get_scene', args: { ordinal } };
    }
    if (!jaChamou(resultados, 'project.update_scene')) {
      return { name: 'project.update_scene', args: { ordinal, ...patch } };
    }
    return null;
  };
}

// ── 31 · os três turnos, na mesma conversa ──────────────────────────────────

test('os três turnos: cria o plano, edita a cena 2, encurta a cena 4', async () => {
  const { db, documento, thread } = await cenario();

  // ── TURNO 1 ───────────────────────────────────────────────────────────────
  const turno1 = await sendMessage({
    threadId: thread.id,
    content: 'Transforme este material num documentário de 60 segundos. '
      + 'Crie o plano, o roteiro e as cenas, mas ainda não gere imagens ou vídeos.',
    documentIds: [documento.id],
  }, { db, runtime: runtimeRoteirizado(planoDoPrimeiroTurno) });

  const plano = getProductionPlan('proj_a', db);
  assert.ok(plano, 'o plano precisa existir no BANCO, não só na resposta');
  assert.equal(plano.targetDurationSeconds, 60);
  assert.equal(plano.format, 'minidocumentário');

  const roteiro = getProductionScript('proj_a', db);
  assert.ok(roteiro, 'o roteiro precisa existir');

  const cenas1 = listProductionScenes('proj_a', db);
  assert.equal(cenas1.length, 4);
  assert.deepEqual(cenas1.map((c) => c.ordinal), [1, 2, 3, 4]);
  assert.equal(cenas1.reduce((s, c) => s + c.durationSeconds, 0), 60);
  assert.match(turno1.assistantMessage.content, /4 cenas, 60s/);

  // ── TURNO 2 — MESMA thread ────────────────────────────────────────────────
  const runtime2 = runtimeRoteirizado(planoDeEdicao(2, {
    narration: 'O rio Meridian corre a 240 metros abaixo da praca central — '
      + 'e ninguem, la em cima, escuta.',
    purpose: 'A cidade sob a cidade, e o que ela esconde',
  }));

  const turno2 = await sendMessage({
    threadId: thread.id,
    content: 'Deixe a cena 2 mais dramática.',
  }, { db, runtime: runtime2 });

  assert.equal(turno2.thread.id, thread.id, 'é a MESMA conversa');
  assert.equal(runtime2.contextos[0].projectId, 'proj_a');
  // O agente consultou o estado real antes de mexer.
  assert.deepEqual(runtime2.chamadas, [
    'project.list_scenes', 'project.get_scene', 'project.update_scene',
  ]);

  const cenas2 = listProductionScenes('proj_a', db);
  assert.equal(cenas2.length, 4, 'editar uma cena não pode mudar a quantidade');
  assert.match(cenas2[1].narration, /ninguem, la em cima, escuta/);

  // As outras três estão IDÊNTICAS — campo a campo, `updatedAt` incluído.
  for (const i of [0, 2, 3]) {
    assert.deepEqual(cenas2[i], cenas1[i],
      `a cena ${i + 1} não deveria ter sido tocada`);
  }
  // E o roteiro e o plano também não foram reescritos.
  assert.deepEqual(getProductionScript('proj_a', db), roteiro);
  assert.deepEqual(getProductionPlan('proj_a', db), plano);

  // ── TURNO 3 — MESMA thread ────────────────────────────────────────────────
  const runtime3 = runtimeRoteirizado(planoDeEdicao(4, { durationSeconds: 10 }));

  const turno3 = await sendMessage({
    threadId: thread.id,
    content: 'Reduza a cena 4 para 10 segundos.',
  }, { db, runtime: runtime3 });

  assert.equal(turno3.thread.id, thread.id);

  const cenas3 = listProductionScenes('proj_a', db);
  assert.equal(cenas3[3].durationSeconds, 10);
  // Uma ordem do usuário é obedecida mesmo quando afasta a soma do alvo, e o
  // agente é informado do novo total para poder avisar.
  assert.equal(cenas3.reduce((s, c) => s + c.durationSeconds, 0), 55);
  assert.match(turno3.assistantMessage.content, /55s/);

  for (const i of [0, 1, 2]) {
    assert.deepEqual(cenas3[i], cenas2[i], `a cena ${i + 1} não deveria ter sido tocada`);
  }
  // Só a duração da cena 4 mudou; o resto dela continua igual.
  assert.equal(cenas3[3].id, cenas2[3].id);
  assert.equal(cenas3[3].title, cenas2[3].title);
  assert.equal(cenas3[3].narration, cenas2[3].narration);
  assert.equal(cenas3[3].visualDescription, cenas2[3].visualDescription);

  // ── a conversa inteira, numa thread só ────────────────────────────────────
  const { messages } = getThread(thread.id, { db });
  assert.equal(messages.length, 6, 'três turnos, seis mensagens, uma conversa');
  assert.deepEqual(messages.map((m) => m.role),
    ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
});

// ── 32 · o plano sai do DOCUMENTO, não de conhecimento prévio ───────────────

test('o plano, o roteiro e as cenas trazem fatos que só existem no documento', async () => {
  const { db, documento, thread } = await cenario();

  const runtime = runtimeRoteirizado(planoDoPrimeiroTurno);
  await sendMessage({
    threadId: thread.id,
    content: 'Transforme este material num documentário de 60 segundos.',
    documentIds: [documento.id],
  }, { db, runtime });

  // O agente leu o documento inteiro antes de propor qualquer coisa, e a ordem
  // das chamadas é a do produto: ler → plano → roteiro → cenas.
  const leituras = runtime.chamadas.filter((c) => c === 'project.read_document').length;
  assert.ok(leituras >= 1);
  assert.deepEqual(runtime.chamadas.slice(-3), [
    'project.save_production_plan', 'project.save_script', 'project.replace_scenes',
  ]);

  const cenas = listProductionScenes('proj_a', db);
  const narrações = cenas.map((c) => c.narration).join(' ');

  // Fatos INVENTADOS: nenhum modelo os sabe de cor, e nenhum leitor deste teste
  // também. Se estão aqui, vieram da leitura.
  assert.match(narrações, /Meridian/);
  assert.match(narrações, /Elias Venn/);
  assert.match(narrações, /Verena/);
  assert.match(narrações, /240 metros/);

  // O roteiro também.
  assert.match(getProductionScript('proj_a', db).fullText, /QV-7731/);

  // E a origem ficou RASTREÁVEL: o plano aponta para o documento, sem copiar o
  // texto dele.
  assert.deepEqual(listPlanSources('proj_a', db), [
    { documentId: documento.id, filename: 'caderno-de-campo.pdf' },
  ]);
  const plano = getProductionPlan('proj_a', db);
  assert.equal(JSON.stringify(plano).includes('Meridian'), false,
    'o plano guarda a referência ao documento, não uma cópia do conteúdo dele');
});

// ── 33 · o plano sobrevive ao processo ──────────────────────────────────────

test('fechar e reabrir o banco preserva plano, roteiro, cenas e a ordem delas', async () => {
  const { db, caminhoDb, documento, thread } = await cenario({ emDisco: true });

  await sendMessage({
    threadId: thread.id,
    content: 'Transforme este material num documentário de 60 segundos.',
    documentIds: [documento.id],
  }, { db, runtime: runtimeRoteirizado(planoDoPrimeiroTurno) });

  await sendMessage({
    threadId: thread.id,
    content: 'Deixe a cena 2 mais dramática.',
  }, { db, runtime: runtimeRoteirizado(planoDeEdicao(2, { narration: 'Narração dramática.' })) });

  const antes = {
    plano: getProductionPlan('proj_a', db),
    roteiro: getProductionScript('proj_a', db),
    cenas: listProductionScenes('proj_a', db),
  };

  // O processo "morre": a conexão fecha e a memória some. O que sobrar está no
  // arquivo. (`closeDatabase` já fecha ESTA conexão — ela é a instância da
  // aplicação, trocada pelo cenário.)
  closeDatabase();

  const reaberto = openDatabase(caminhoDb);
  globalThis[CHAVE] = reaberto;

  assert.deepEqual(getProductionPlan('proj_a', reaberto), antes.plano);
  assert.deepEqual(getProductionScript('proj_a', reaberto), antes.roteiro);
  assert.deepEqual(listProductionScenes('proj_a', reaberto), antes.cenas);
  assert.deepEqual(
    listProductionScenes('proj_a', reaberto).map((c) => c.ordinal),
    [1, 2, 3, 4],
    'a ordem é do banco, não da memória',
  );
  assert.match(listProductionScenes('proj_a', reaberto)[1].narration, /dramática/);

  // A conversa também continua lá, com as duas idas e vindas.
  assert.equal(getThread(thread.id, { db: reaberto }).messages.length, 4);
  // Fechado pela mesma porta por onde foi adotado, para o próximo cenário não
  // encontrar uma conexão morta no lugar da instância da aplicação.
  closeDatabase();
});

// ── 39 · planejar não é gerar ───────────────────────────────────────────────

test('o planejamento inteiro não cria uma única geração nem um único Asset', async () => {
  // Este é o critério obrigatório do passo, e ele é medido NO BANCO. Provar
  // apenas que o duplo não chamou a ferramenta de geração seria provar algo
  // sobre o duplo; o que interessa é que o caminho do planejamento não tem por
  // onde criar mídia.
  const { db, documento, thread } = await cenario();

  await sendMessage({
    threadId: thread.id,
    content: 'Transforme este material num documentário de 60 segundos.',
    documentIds: [documento.id],
  }, { db, runtime: runtimeRoteirizado(planoDoPrimeiroTurno) });

  await sendMessage({
    threadId: thread.id,
    content: 'Deixe a cena 2 mais dramática.',
  }, { db, runtime: runtimeRoteirizado(planoDeEdicao(2, { narration: 'Outra narração.' })) });

  await sendMessage({
    threadId: thread.id,
    content: 'Reduza a cena 4 para 10 segundos.',
  }, { db, runtime: runtimeRoteirizado(planoDeEdicao(4, { durationSeconds: 10 })) });

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n, 0);

  // E a produção está inteira, mesmo assim.
  assert.equal(listProductionScenes('proj_a', db).length, 4);
});

test('nenhum evento público do planejamento carrega conteúdo ou identidade interna', async () => {
  const { db, documento, thread } = await cenario();

  const turno = await sendMessage({
    threadId: thread.id,
    content: 'Transforme este material num documentário de 60 segundos.',
    documentIds: [documento.id],
  }, { db, runtime: runtimeRoteirizado(planoDoPrimeiroTurno) });

  const publicos = JSON.stringify(turno.events.map(publicAgentEvent));

  for (const proibido of ['Meridian', 'Verena', 'QV-7731', 'proj_a', documento.id,
    'plan_', 'script_', 'scene_', 'thread_', 'runtime/', 'nextCursor', 'ordinal']) {
    assert.equal(publicos.includes(proibido), false,
      `o SSE carregaria "${proibido}"`);
  }

  // O que ele mostra é o nome CANÔNICO da ferramenta, nunca o alias do runtime.
  assert.ok(publicos.includes('project.replace_scenes'));
  assert.equal(publicos.includes('project_replace_scenes'), false);
});
