// "Anime essa imagem" precisa virar image-to-video de verdade.
//
// ── O defeito que estes testes trancam ──────────────────────────────────────
//
// Medido na auditoria do Quality Gate, no banco:
//
//     image  asset_mtu6vqxg_d7ad3d33   derivedFrom: —
//     video  asset_mtu76i49_63170f64   derivedFrom: —      ← NULO
//     generation_jobs do vídeo: workflowId = minimax_h3_t2v, sem quadro
//
// O agente ENTENDEU "anime essa imagem" e o vídeo correspondeu ao pedido. Mas
// ele chamou `og.generate_video` SEM `sourceAssetId`: houve um text-to-video
// cujo prompt descrevia a imagem, e por isso não havia linhagem para gravar.
//
// ── A causa, que não era do modelo ──────────────────────────────────────────
//
// Ele não TINHA o identificador. `og.generate_image` devolve
// `{ jobId, kind, status }`, e o Asset nasce depois — no acompanhamento do
// servidor, com o turno do modelo já encerrado. Descrever a imagem num prompt
// era a única coisa que ele podia fazer.
//
// A correção é dar-lhe o que faltava: o SERVIDOR informa, no contexto privado
// do turno, quais Assets desta conversa podem ser referenciados. O modelo
// escolhe dentro dessa lista; ele nunca inventa nem lembra um id.
//
// ── A regra de produto ──────────────────────────────────────────────────────
//
//   sourceAssetId AUSENTE  → text-to-video
//   sourceAssetId PRESENTE → image-to-video, e o vídeo fica LIGADO à imagem
//
// A execução é decidida pelo ARGUMENTO ESTRUTURADO, nunca pela palavra "anime"
// no prompt. A intenção linguística é resolvida pelo agente; a execução, pelo
// dado.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { createThread, getThread, sendMessage } from '../lib/server/agent/gateway.js';
import { imageReferenceBriefing } from '../lib/server/agent/attachments.js';
import { AGENT_EVENTS, publicAgentEvent } from '../lib/server/agent/events.js';
import { closeDatabase, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset, getAsset } from '../lib/server/domain/assets.js';
import {
  appendMessageRecord, attachMessageAssets, listThreadAssets,
} from '../lib/server/agent/threads.js';
import { generateVideoTool } from '../lib/server/agent/tools/handlers/generateVideo.js';
import { startVideoGeneration } from '../lib/server/generation/facade.js';
import { getGenerationJobRecord } from '../lib/server/domain/generationJobs.js';
import { workflowRegistry } from '../lib/server/generation/workflows/registry.js';
import { GENERATION_MODES } from '../lib/server/generation/workflows/minimaxH3.js';
import { STATES } from '../lib/server/comfy/status.js';

const CHAVE = Symbol.for('showrunner.domain.db');

/**
 * O projeto de teste vive no runtime REAL, e isso é deliberado.
 *
 * `resolveMediaPath` resolve contra a raiz real — é ela que a facade usa para
 * achar os bytes da imagem de origem. Escrever noutro lugar provaria o caminho
 * errado. É o mesmo motivo, e o mesmo padrão, de `generation-filename.test.mjs`.
 */
const PROJETO = 'proj_i2v_agente_teste';
const DIR_IMAGENS = path.join(process.cwd(), 'runtime', 'projects', PROJETO, 'images');

test.after(async () => {
  closeDatabase();
  delete globalThis[CHAVE];
  await rm(path.join(process.cwd(), 'runtime', 'projects', PROJETO), {
    recursive: true, force: true,
  });
});

/** Um PNG mínimo de verdade — o provider precisa receber BYTES, não um nome. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let contador = 0;

/**
 * Um projeto com uma imagem REAL em disco, já ligada a uma mensagem da conversa.
 *
 * O arquivo precisa existir porque a facade lê os bytes dele para montar o
 * quadro inicial — um Asset que só existe no banco não prova image-to-video.
 */
async function cenario({ imagens = 1 } = {}) {
  contador += 1;
  closeDatabase();
  const db = openDatabase(':memory:');
  globalThis[CHAVE] = db;

  createProject({ id: PROJETO, name: 'Produção A' }, db);
  createProject({ id: 'proj_b', name: 'Produção B' }, db);

  await mkdir(DIR_IMAGENS, { recursive: true });

  const thread = createThread({ projectId: PROJETO }, { db });
  const criadas = [];

  for (let i = 0; i < imagens; i += 1) {
    const filename = `caso${contador}_img${i}.png`;
    // eslint-disable-next-line no-await-in-loop
    await writeFile(path.join(DIR_IMAGENS, filename), PNG);

    const asset = createAsset({
      projectId: PROJETO,
      kind: 'image',
      jobId: `cinema_origem_${contador}_${i}`,
      filename,
      url: `/api/media/image/${PROJETO}/${filename}`,
      mimeType: 'image/png',
      prompt: i === 0 ? 'um astronauta numa floresta alienígena' : 'um dragão vermelho',
    }, db);

    // A mídia pertence a uma mensagem da conversa — é assim que ela existe de
    // verdade, e é por aí que o servidor a encontra para oferecer ao modelo.
    const doUsuario = appendMessageRecord({
      threadId: thread.id, role: 'user', content: `crie a imagem ${i}`,
    }, db);
    const doAgente = appendMessageRecord({
      threadId: thread.id, role: 'assistant', content: `imagem ${i} pronta`,
    }, db);
    attachMessageAssets(doAgente.id, [asset.id], db);
    criadas.push({ asset, doUsuario, doAgente });
  }

  return { db, thread, criadas, imagens: criadas.map((c) => c.asset) };
}

/**
 * As dependências que substituem o executor.
 *
 * `submeter` é a costura que a camada de geração já oferece — a mesma que
 * `generation-ledger-lifecycle` usa. Nada de ComfyUI, e o que ELE receberia
 * fica registrado para o teste inspecionar.
 */
function executorFalso(registro) {
  let n = 0;
  return {
    novoJobId: () => { n += 1; return `cinema_i2v_${contador}_${n}`; },
    submeter: async (params) => {
      registro.push(params);
      // O estado é o VOCABULÁRIO DO EXECUTOR — a camada de geração o traduz
      // para o do domínio, e um valor inventado é recusado lá (tabela fechada,
      // PASSO 10.1). Usar o real é o que faz este duplo exercitar o caminho.
      return { jobId: params.jobId, promptId: `prompt_${n}`, state: STATES.SUBMITTED };
    },
  };
}

// ── A · a infraestrutura que torna a imagem referenciável ───────────────────

test('A. o servidor sabe quais imagens ESTA conversa produziu', async () => {
  const { db, thread, imagens } = await cenario({ imagens: 2 });

  const oferecidas = listThreadAssets(thread.id, { kind: 'image' }, db);

  // Mais recente primeiro — a ordem da CONVERSA, não a do relógio.
  assert.deepEqual(oferecidas.map((a) => a.assetId), [imagens[1].id, imagens[0].id]);
  // E o prompt vem junto: é ele que torna duas imagens distinguíveis.
  assert.equal(oferecidas[0].prompt, 'um dragão vermelho');
  assert.equal(oferecidas[1].prompt, 'um astronauta numa floresta alienígena');

  // Nada de infraestrutura.
  const texto = JSON.stringify(oferecidas);
  for (const proibido of ['jobId', 'workflow', 'filename', '/api/media', 'runtime/', 'projectId']) {
    assert.equal(texto.includes(proibido), false, `"${proibido}" vazou`);
  }
});

test('A-bis. a lista é da THREAD, não do Project', async () => {
  const { db, thread } = await cenario({ imagens: 1 });

  // Outra conversa no MESMO projeto não herda o referente: "essa imagem" é
  // dêitico, e aponta para o que está à vista — esta conversa.
  const outra = createThread({ projectId: PROJETO }, { db });
  assert.deepEqual(listThreadAssets(outra.id, { kind: 'image' }, db), []);
  assert.equal(listThreadAssets(thread.id, { kind: 'image' }, db).length, 1);
});

test('A-ter. o contexto do turno leva as imagens ao runtime', async () => {
  const { db, thread, imagens } = await cenario({ imagens: 1 });

  const visto = [];
  const runtime = {
    id: 'espiao',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run({ context }) {
      visto.push(context);
      yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'ok' };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };

  await sendMessage({ threadId: thread.id, content: 'Anime essa imagem.' }, { db, runtime });

  assert.equal(visto[0].images.length, 1);
  assert.equal(visto[0].images[0].assetId, imagens[0].id);

  // E o aviso privado diz ao modelo o que fazer com isso.
  const aviso = imageReferenceBriefing(visto[0].images);
  assert.match(aviso, new RegExp(imagens[0].id));
  assert.match(aviso, /sourceAssetId/);
  assert.match(aviso, /nunca invente/i);
});

// ── 9 · o teste determinístico principal ────────────────────────────────────

test('B. "anime essa imagem" → sourceAssetId → I2V real → linhagem real', async () => {
  const { db, thread, imagens } = await cenario({ imagens: 1 });
  const origem = imagens[0];

  const submissoes = [];
  const executor = executorFalso(submissoes);

  // O runtime lê o id da imagem NO CONTEXTO e o passa à ferramenta — que é
  // exatamente o que o modelo real faz depois da correção.
  const runtime = {
    id: 'animador',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run({ context, invokeTool }) {
      const alvo = context.images[0].assetId;
      const r = await invokeTool('og.generate_video', {
        prompt: 'a câmera avança lentamente',
        duration: 5,
        sourceAssetId: alvo,
      });
      yield {
        type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1',
        name: 'og.generate_video', result: r,
      };
      yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Coloquei para animar.' };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };

  // A ferramenta usa a facade de verdade, com um provider falso e o
  // armazenamento do teste. Nada de ComfyUI.
  let recebidoPelaTool = null;
  await sendMessage(
    { threadId: thread.id, content: 'Anime essa imagem.' },
    {
      db,
      runtime: {
        ...runtime,
        async* run(argumentos) {
          const invoke = async (nome, args) => {
            assert.equal(nome, 'og.generate_video');
            recebidoPelaTool = args;
            return generateVideoTool.execute(argumentos.context, args, {
              abrirBanco: () => db,
              acompanhar: () => {},
              iniciar: (entrada, opcoes) => startVideoGeneration(entrada, {
                ...opcoes, db, deps: executor,
              }),
            });
          };
          yield* runtime.run({ ...argumentos, invokeTool: invoke });
        },
      },
    },
  );

  // 1. `sourceAssetId` CHEGA ao handler, e é o da imagem que o servidor ofereceu.
  assert.equal(recebidoPelaTool.sourceAssetId, origem.id, 'o sourceAssetId não chegou');

  // 2. o Project foi validado — Asset de outro projeto é recusado (teste D).
  // 3. o executor recebeu um QUADRO INICIAL: é isso que faz o grafo virar i2v.
  assert.equal(submissoes.length, 1);
  const submetida = submissoes[0];
  const quadro = submetida.frames?.first;
  assert.ok(quadro, 'o quadro inicial não foi submetido — isto é um t2v disfarçado');

  // 4. e o quadro são os BYTES REAIS da imagem, lidos do Asset — não um nome.
  assert.ok(Buffer.isBuffer(quadro.bytes) || quadro.bytes instanceof Uint8Array,
    'o quadro inicial não veio como bytes');
  assert.deepEqual(Buffer.from(quadro.bytes), PNG, 'os bytes não são os da imagem de origem');
  assert.equal(quadro.declaredName, origem.filename);

  // 5. o livro-razão registra a linhagem DESDE O INÍCIO, e o workflow é o do
  //    registry — nunca um caminho ou um id escolhido pelo modelo.
  const ledger = getGenerationJobRecord(submetida.jobId, db);
  assert.equal(ledger.derivedFromAssetId, origem.id, 'o livro-razão não gravou a linhagem');
  assert.equal(ledger.kind, 'video');
  assert.ok(workflowRegistry.has(ledger.workflowId), 'workflowId fora do registry');
  assert.equal(workflowRegistry.get(ledger.workflowId).kind, 'video');
});

test('B-bis. o Asset de vídeo nasce com derivedFromAssetId apontando para a imagem', async () => {
  // A linhagem que importa é a do ASSET — é ela que faz "refaça a cena 4" e
  // qualquer encadeamento futuro serem possíveis. O caminho é o real:
  // `finalizeGenerationAsset`, que a facade usa quando o trabalho conclui.
  const { db, imagens } = await cenario({ imagens: 1 });
  const origem = imagens[0];

  const { finalizeGenerationAsset } = await import('../lib/server/generation/facade.js');
  const { createJob } = await import('../lib/server/comfy/jobs.js');
  const { STATES: ESTADOS } = await import('../lib/server/comfy/status.js');

  const jobId = `cinema_fim_${contador}`;
  const filename = `${jobId}.mp4`;
  await mkdir(path.join(process.cwd(), 'runtime', 'projects', PROJETO, 'videos'), { recursive: true });
  await writeFile(
    path.join(process.cwd(), 'runtime', 'projects', PROJETO, 'videos', filename),
    Buffer.from('mp4'),
  );

  createJob({
    jobId, projectId: PROJETO, kind: 'video', state: ESTADOS.DONE, promptId: null,
    result: { url: `/api/media/video/${PROJETO}/${filename}`, filename, bytes: 3 },
  });

  const video = await finalizeGenerationAsset(jobId, {
    projectId: PROJETO,
    db,
    mediaUrl: `/api/media/video/${PROJETO}/${filename}`,
    derivedFromAssetId: origem.id,
  });

  assert.equal(video.kind, 'video');
  assert.equal(video.derivedFromAssetId, origem.id);
  assert.equal(getAsset(video.id, db).derivedFromAssetId, origem.id);
  // E a imagem de origem continua sem linhagem: ela não derivou de nada.
  assert.equal(getAsset(origem.id, db).derivedFromAssetId, null);
});

// ── 10 · T2V e I2V não se contaminam ────────────────────────────────────────

test('C. sem sourceAssetId é T2V: sem quadro, sem linhagem', async () => {
  const { db, thread } = await cenario({ imagens: 1 });

  const submissoes = [];
  const contexto = { threadId: thread.id, projectId: PROJETO, userMessageId: null, signal: null };

  await generateVideoTool.execute(contexto, {
    // O prompt fala em animar — e isso NÃO pode decidir nada. A execução é
    // determinada pelo argumento estruturado, não pela palavra no texto.
    prompt: 'anime um dragão vermelho voando sobre uma cidade',
  }, {
    abrirBanco: () => db,
    acompanhar: () => {},
    iniciar: (entrada, opcoes) => startVideoGeneration(entrada, {
      ...opcoes, db, deps: executorFalso(submissoes),
    }),
  });

  assert.equal(submissoes.length, 1);
  assert.equal(submissoes[0].frames ?? null, null, 'um T2V submeteu quadro');

  const ledger = getGenerationJobRecord(submissoes[0].jobId, db);
  assert.equal(ledger.derivedFromAssetId, null, 'um T2V ganhou linhagem inventada');
});

test('C-bis. os dois caminhos convivem na mesma conversa sem se contaminar', async () => {
  const { db, thread, imagens } = await cenario({ imagens: 1 });
  const submissoes = [];
  // UM executor para as três chamadas: cada instância numera os jobs a partir
  // do zero, e três instâncias produziriam o mesmo identificador três vezes.
  const executor = executorFalso(submissoes);
  const contexto = { threadId: thread.id, projectId: PROJETO, userMessageId: null, signal: null };
  const deps = {
    abrirBanco: () => db,
    acompanhar: () => {},
    iniciar: (entrada, opcoes) => startVideoGeneration(entrada, { ...opcoes, db, deps: executor }),
  };

  await generateVideoTool.execute(contexto, { prompt: 'um dragão voando' }, deps);
  await generateVideoTool.execute(contexto, {
    prompt: 'a câmera avança', sourceAssetId: imagens[0].id,
  }, deps);
  await generateVideoTool.execute(contexto, { prompt: 'uma cidade à noite' }, deps);

  assert.equal(submissoes.length, 3);
  assert.deepEqual(
    submissoes.map((s) => Boolean(s.frames?.first)),
    [false, true, false],
  );
  assert.deepEqual(
    submissoes.map((s) => getGenerationJobRecord(s.jobId, db).derivedFromAssetId),
    [null, imagens[0].id, null],
  );
});

// ── 8 · cross-project ───────────────────────────────────────────────────────

test('D. um sourceAssetId de OUTRO projeto é recusado, mesmo existindo', async () => {
  const { db, thread } = await cenario({ imagens: 1 });

  const doB = createAsset({
    projectId: 'proj_b', kind: 'image', jobId: 'cinema_b', filename: 'b.png',
    url: '/api/media/image/proj_b/b.png',
  }, db);

  const submissoes = [];
  const contexto = { threadId: thread.id, projectId: PROJETO, userMessageId: null, signal: null };

  await assert.rejects(
    () => generateVideoTool.execute(contexto, {
      prompt: 'anime', sourceAssetId: doB.id,
    }, {
      abrirBanco: () => db,
      acompanhar: () => {},
      iniciar: (entrada, opcoes) => startVideoGeneration(entrada, {
        ...opcoes, db, deps: executorFalso(submissoes),
      }),
    }),
    (erro) => erro.name === 'ToolExecutionError',
  );

  assert.equal(submissoes.length, 0, 'submeteu mesmo com o Asset de outro projeto');
});

test('D-bis. um vídeo não serve como fonte, e um id inexistente também não', async () => {
  const { db, thread } = await cenario({ imagens: 1 });

  const video = createAsset({
    projectId: PROJETO, kind: 'video', jobId: 'cinema_vv', filename: 'v.mp4',
    url: `/api/media/video/${PROJETO}/v.mp4`,
  }, db);

  const submissoes = [];
  const contexto = { threadId: thread.id, projectId: PROJETO, userMessageId: null, signal: null };
  const deps = {
    abrirBanco: () => db,
    acompanhar: () => {},
    iniciar: (entrada, opcoes) => startVideoGeneration(entrada, {
      ...opcoes, db, deps: executorFalso(submissoes),
    }),
  };

  for (const alvo of [video.id, 'asset_inexistente']) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => generateVideoTool.execute(contexto, { prompt: 'x', sourceAssetId: alvo }, deps),
      (erro) => erro.name === 'ToolExecutionError',
      alvo,
    );
  }
  assert.equal(submissoes.length, 0);
});

// ── 11 · ambiguidade ────────────────────────────────────────────────────────

test('E. com duas imagens, o sistema oferece as duas e manda perguntar', async () => {
  const { db, thread, imagens } = await cenario({ imagens: 2 });

  const oferecidas = listThreadAssets(thread.id, { kind: 'image' }, db);
  assert.equal(oferecidas.length, 2);

  const aviso = imageReferenceBriefing(oferecidas);

  // As duas aparecem, com o que as distingue.
  assert.match(aviso, new RegExp(imagens[0].id));
  assert.match(aviso, new RegExp(imagens[1].id));
  assert.match(aviso, /astronauta/);
  assert.match(aviso, /dragão/);

  // E a instrução é PERGUNTAR — nunca escolher.
  assert.match(aviso, /pergunte antes de gerar/i);
  assert.match(aviso, /não escolha por conta própria/i);

  // O sistema não elege nenhuma: não há "a última", não há MAX(createdAt).
  assert.equal(/mais recente é a correta|use a última|escolha a primeira/i.test(aviso), false);
});

test('E-bis. com uma imagem só, não há o que perguntar', async () => {
  const { db, thread } = await cenario({ imagens: 1 });
  const aviso = imageReferenceBriefing(listThreadAssets(thread.id, { kind: 'image' }, db));

  assert.match(aviso, /esta imagem/i);
  assert.equal(/pergunte antes de gerar/i.test(aviso), false);
});

test('E-ter. sem imagem nenhuma, o aviso não existe', async () => {
  const { db } = await cenario({ imagens: 0 });
  const vazia = createThread({ projectId: PROJETO }, { db });

  assert.deepEqual(listThreadAssets(vazia.id, { kind: 'image' }, db), []);
  assert.equal(imageReferenceBriefing([]), '');
});

// ── 17 · a superfície pública ───────────────────────────────────────────────

test('F. nada de workflow, nó, caminho ou runtime chega ao navegador', async () => {
  const { db, thread, imagens } = await cenario({ imagens: 1 });

  const runtime = {
    id: 'animador',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run() {
      yield {
        type: AGENT_EVENTS.TOOL_STARTED, ts: 1, toolCallId: 'c1',
        name: 'og.generate_video',
        arguments: { prompt: 'anime', sourceAssetId: imagens[0].id },
      };
      yield {
        type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: 'c1',
        name: 'og.generate_video',
        result: { jobId: 'cinema_x', kind: 'video', status: 'na-fila' },
      };
      yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'Animando.' };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };

  const turno = await sendMessage(
    { threadId: thread.id, content: 'Anime essa imagem.' },
    { db, runtime },
  );

  const publico = JSON.stringify(turno.events);
  for (const proibido of [
    'minimax', 'workflowId', 'workflow', 'sourceAssetId', 'cinema_x',
    'firstFrame', 'LoadImage', 'nodeId', 'runtime/', 'hermes', 'session',
    'na-fila',
  ]) {
    assert.equal(publico.toLowerCase().includes(proibido.toLowerCase()), false,
      `"${proibido}" vazou para o navegador`);
  }

  // E a redução é estável.
  for (const evento of turno.events) assert.deepEqual(publicAgentEvent(evento), evento);

  // O aviso privado também não vira texto da conversa.
  const { messages } = getThread(thread.id, { db });
  for (const m of messages) {
    assert.equal(m.content.includes('contexto do sistema'), false);
    assert.equal(m.content.includes(imagens[0].id), false);
  }
  const falasDoUsuario = messages.filter((m) => m.role === 'user');
  assert.equal(falasDoUsuario[falasDoUsuario.length - 1].content, 'Anime essa imagem.');
});

// ── o registry de vídeo ─────────────────────────────────────────────────────

test('G. o workflow de vídeo do projeto cobre os três modos, e o modo vem dos quadros', () => {
  const deVideo = workflowRegistry.list().filter((w) => w.kind === 'video');
  assert.equal(deVideo.length, 1, 'passou a haver mais de um workflow de vídeo');

  const descriptor = workflowRegistry.get(deVideo[0].id);
  // I2V não é outro workflow: é o MESMO grafo recebendo um quadro inicial.
  // É por isso que não havia workflow faltando — o que faltava era o argumento.
  assert.ok(descriptor.modes.includes(GENERATION_MODES.T2V));
  assert.ok(descriptor.modes.includes(GENERATION_MODES.I2V));
});
