// SMOKE REAL — conversar sobre as tentativas de uma cena.
//
// PASSO 13-D. NÃO faz parte de `npm test`: depende do runtime dedicado, do
// ComfyUI e da rede.
//
// A conversa inteira, em quatro turnos, como uma pessoa falaria:
//
//   1. "Faça outra imagem da cena N, mais sombria."   → nasce o take seguinte
//   2. "Use a segunda imagem."                        → a escolha muda
//   3. "Qual imagem está selecionada?"                → lida do BANCO
//   4. "Anime essa versão."                           → I2V a partir da NOVA
//
// O gate está no quarto turno: depois da troca, a linhagem do vídeo precisa
// apontar para a imagem NOVA. Se apontar para a antiga, "use a segunda" foi
// uma frase simpática e o filme sai errado sem ninguém perceber.
//
// Uso:
//   SHOWRUNNER_HERMES_URL=... SHOWRUNNER_HERMES_TOKEN=... \
//   node tests/smoke-scene-takes-real.mjs <projectId> [ordinal]

import path from 'node:path';
import { AGENT_EVENTS } from '../lib/server/agent/events.js';
import { createRuntime } from '../lib/server/agent/runtimes.js';
import { startBridgeServer } from '../lib/server/agent/hermes/bridge.js';
import { createThread, sendMessage } from '../lib/server/agent/gateway.js';
import { database } from '../lib/server/domain/db.js';
import { getProject } from '../lib/server/domain/projects.js';
import { getAsset } from '../lib/server/domain/assets.js';
import { getProductionScene } from '../lib/server/domain/production.js';
import {
  getSceneSelection, listSceneTakes, sceneTakeState,
} from '../lib/server/domain/sceneMedia.js';
import { getGenerationJobRecord } from '../lib/server/domain/generationJobs.js';
import { getGenerationJob } from '../lib/server/generation/facade.js';
import { modeFromGraph } from '../lib/server/comfy/workflow.js';
import { COMFY_BASE_URL } from '../lib/server/comfy/config.js';

const PROJECT_ID = process.argv[2];
const ORDINAL = Number(process.argv[3] || 1);
const SOCKET = process.env.SHOWRUNNER_BRIDGE_SOCKET
  || path.join(process.cwd(), 'runtime', 'hermes', 'bridge.sock');

let falhas = 0;
const ok = (cond, texto) => {
  console.log(`${cond ? '  ✔' : '  ✖'} ${texto}`);
  if (!cond) falhas += 1;
};

const db = database();
const projeto = getProject(PROJECT_ID, db);
if (!projeto) {
  console.error(`Projeto desconhecido: "${PROJECT_ID}".`);
  process.exit(2);
}

const cena = getProductionScene(projeto.id, ORDINAL, db);
if (!cena) {
  console.error(`O projeto não tem uma cena ${ORDINAL}.`);
  process.exit(2);
}

console.log(`SMOKE REAL 13-D — ${projeto.name}, cena ${ORDINAL} (${cena.title})\n`);

const inicial = {
  imagens: listSceneTakes(projeto.id, ORDINAL, 'image', db).length,
  videos: listSceneTakes(projeto.id, ORDINAL, 'video', db).length,
  imagemEscolhida: getSceneSelection(projeto.id, ORDINAL, 'image', db),
};
console.log(`estado inicial: ${inicial.imagens} imagem(ns), ${inicial.videos} vídeo(s)`);
console.log(`  imagem escolhida: take ${inicial.imagemEscolhida?.takeNumber ?? '—'}`);
ok(Boolean(inicial.imagemEscolhida?.assetId), 'a cena já tem imagem escolhida (estado do 13-B)');
if (!inicial.imagemEscolhida?.assetId) {
  console.error('\nRode o smoke do 13-B antes: é preciso uma imagem escolhida.');
  process.exit(2);
}

/** Espera uma geração terminar, pelo mesmo caminho que a tela usa. */
async function esperar(jobId, minutos) {
  const limite = Date.now() + minutos * 60 * 1000;
  let estado = null;
  while (Date.now() < limite) {
    estado = await getGenerationJob(jobId, { projectId: projeto.id, db });
    const registro = getGenerationJobRecord(jobId, db);
    process.stdout.write(`\r   ${String(estado.status).padEnd(14)} · asset: ${registro?.assetId ? 'sim' : 'não '}   `);
    if (registro?.assetId) break;
    if (['failed', 'cancelled', 'orphaned'].includes(estado.status)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log('');
  return estado;
}

const nomes = (turno) => turno.events
  .filter((e) => e.type === AGENT_EVENTS.TOOL_STARTED).map((e) => e.name);

const runtime = createRuntime('hermes');
ok(runtime.isAvailable(), 'o runtime está configurado');
const bridge = await startBridgeServer({ socketPath: SOCKET, db });
console.log(`bridge no ar: ${bridge.socketPath}\n`);

try {
  const thread = createThread({ projectId: projeto.id, title: 'Smoke 13-D' }, { db });
  const conversa = (texto) => sendMessage({ threadId: thread.id, content: texto }, { db, runtime });

  // ── 1 · "faça outra" ────────────────────────────────────────────────────
  console.log('1. "Faça outra imagem da cena, mais sombria."');
  const t1 = await conversa(`Faça outra imagem da cena ${ORDINAL}, mais sombria.`);
  console.log(`   tools: ${JSON.stringify(nomes(t1))}`);
  console.log(`   resposta: ${JSON.stringify(t1.assistantMessage.content.slice(0, 200))}`);

  ok(nomes(t1).includes('project.generate_scene_image'), 'gerou pela ferramenta da cena');
  const depoisDoUm = listSceneTakes(projeto.id, ORDINAL, 'image', db);
  ok(depoisDoUm.length === inicial.imagens + 1, `nasceu UMA tentativa nova (agora ${depoisDoUm.length})`);
  const nova = depoisDoUm[depoisDoUm.length - 1];
  console.log(`   nova tentativa: take ${nova.takeNumber}`);
  ok(
    getSceneSelection(projeto.id, ORDINAL, 'image', db).id === inicial.imagemEscolhida.id,
    'a escolha NÃO mudou sozinha ao gerar outra',
  );

  console.log('   esperando a nova imagem ficar pronta...');
  await esperar(nova.generationJobId, 8);
  const novaPronta = listSceneTakes(projeto.id, ORDINAL, 'image', db)
    .find((t) => t.id === nova.id);
  ok(Boolean(novaPronta?.assetId), 'a nova imagem concluiu e tem Asset');
  ok(
    getSceneSelection(projeto.id, ORDINAL, 'image', db).id === inicial.imagemEscolhida.id,
    'e mesmo depois de pronta ela não tomou o lugar da escolhida',
  );

  // ── 2 · "use a segunda" ─────────────────────────────────────────────────
  console.log(`\n2. "Use a ${nova.takeNumber}ª imagem."`);
  const t2 = await conversa(
    `Use a imagem ${nova.takeNumber} da cena ${ORDINAL}.`,
  );
  console.log(`   tools: ${JSON.stringify(nomes(t2))}`);
  console.log(`   resposta: ${JSON.stringify(t2.assistantMessage.content.slice(0, 200))}`);

  ok(nomes(t2).includes('project.select_scene_take'), 'escolheu pela ferramenta de seleção');
  const escolhidaAgora = getSceneSelection(projeto.id, ORDINAL, 'image', db);
  ok(escolhidaAgora?.takeNumber === nova.takeNumber,
    `a imagem escolhida passou a ser o take ${nova.takeNumber}`);
  ok(
    listSceneTakes(projeto.id, ORDINAL, 'image', db).length === depoisDoUm.length,
    'nenhuma tentativa foi apagada pela troca',
  );
  ok(
    listSceneTakes(projeto.id, ORDINAL, 'image', db).every((t) => t.assetId),
    'todas as tentativas continuam com a mídia delas',
  );

  // ── 3 · "qual está selecionada?" ────────────────────────────────────────
  console.log('\n3. "Qual imagem está selecionada?"');
  const t3 = await conversa(`Qual imagem está selecionada na cena ${ORDINAL}?`);
  console.log(`   tools: ${JSON.stringify(nomes(t3))}`);
  console.log(`   resposta: ${JSON.stringify(t3.assistantMessage.content.slice(0, 240))}`);

  ok(nomes(t3).includes('project.get_scene_media'), 'consultou o estado real, não a memória');
  ok(t3.assistantMessage.content.includes(String(nova.takeNumber)),
    `a resposta cita a tentativa ${nova.takeNumber}`);

  // ── 4 · "anime essa versão" ─────────────────────────────────────────────
  console.log('\n4. "Anime essa versão."');
  const videosAntes = listSceneTakes(projeto.id, ORDINAL, 'video', db).length;
  const t4 = await conversa('Anime essa versão.');
  console.log(`   tools: ${JSON.stringify(nomes(t4))}`);
  console.log(`   resposta: ${JSON.stringify(t4.assistantMessage.content.slice(0, 200))}`);

  ok(nomes(t4).includes('project.generate_scene_video'), 'usou a ferramenta de vídeo da cena');
  ok(!nomes(t4).includes('og.generate_video'), 'e não a geração de vídeo avulsa');
  ok(!JSON.stringify(t4.events).includes('sourceAssetId'),
    'o modelo não indicou imagem de origem');

  const videos = listSceneTakes(projeto.id, ORDINAL, 'video', db);
  const videoNovo = videos[videos.length - 1];
  ok(videos.length === videosAntes + 1, 'nasceu UM take de vídeo novo');

  const registro = getGenerationJobRecord(videoNovo.generationJobId, db);
  console.log(`   linhagem no registro: ${registro?.derivedFromAssetId}`);
  ok(registro?.derivedFromAssetId === escolhidaAgora.assetId,
    'generation_jobs.derivedFromAssetId === a imagem NOVA');
  ok(registro?.derivedFromAssetId !== inicial.imagemEscolhida.assetId,
    'e NÃO a imagem antiga — nenhum fallback para o take 1');

  console.log('   esperando o vídeo...');
  await esperar(videoNovo.generationJobId, 15);

  const videoFinal = listSceneTakes(projeto.id, ORDINAL, 'video', db)
    .find((t) => t.id === videoNovo.id);
  const assetDeVideo = videoFinal?.assetId ? getAsset(videoFinal.assetId, db) : null;

  ok(Boolean(assetDeVideo), 'o vídeo concluiu e o take recebeu o Asset');
  console.log(`   vídeo: ${assetDeVideo?.filename}`);
  console.log(`   C.derivedFromAssetId: ${assetDeVideo?.derivedFromAssetId}`);
  ok(assetDeVideo?.derivedFromAssetId === escolhidaAgora.assetId,
    'Asset de vídeo.derivedFromAssetId === a imagem NOVA (B)');
  ok(assetDeVideo?.derivedFromAssetId !== inicial.imagemEscolhida.assetId,
    'e não a antiga (A)');

  // ── 5 · o grafo real ────────────────────────────────────────────────────
  console.log('\n5. o grafo submetido:');
  const promptId = getGenerationJobRecord(videoNovo.generationJobId, db)?.providerJobId;
  if (promptId) {
    const historico = await (await fetch(`${COMFY_BASE_URL}/history/${promptId}`)).json();
    const grafo = historico?.[promptId]?.prompt?.[2];
    const carregadores = Object.entries(grafo || {})
      .filter(([, n]) => n?.class_type === 'LoadImage');
    const noDoModelo = Object.values(grafo || {})
      .find((n) => n?.class_type === 'MiniMaxH3ImageToVideo');

    console.log(`   LoadImage: ${carregadores.length} · first_frame: ${JSON.stringify(noDoModelo?.inputs?.first_frame)}`);
    console.log(`   modo: ${grafo ? modeFromGraph(grafo) : '—'}`);
    ok(carregadores.length === 1, 'LoadImage = 1');
    ok(Boolean(noDoModelo?.inputs?.first_frame), 'first_frame conectado');
    ok(grafo && modeFromGraph(grafo) === 'i2v', 'o modo do grafo é i2v');
  } else {
    ok(false, 'o executor não devolveu identificador');
  }

  // ── o retrato ───────────────────────────────────────────────────────────
  console.log(`\nretrato da cena ${ORDINAL}:`);
  for (const kind of ['image', 'video']) {
    const escolhido = getSceneSelection(projeto.id, ORDINAL, kind, db);
    for (const t of listSceneTakes(projeto.id, ORDINAL, kind, db)) {
      const asset = t.assetId ? getAsset(t.assetId, db) : null;
      const marca = escolhido?.id === t.id ? ' ← escolhido' : '';
      console.log(`   ${kind} take ${t.takeNumber} · ${sceneTakeState(t, db)}`
        + ` · deriva de ${asset?.derivedFromAssetId ?? '—'}${marca}`);
    }
  }
} finally {
  await bridge.close();
}

console.log(`\n${falhas === 0 ? 'SMOKE OK' : `SMOKE COM ${falhas} FALHA(S)`}`);
process.exit(falhas === 0 ? 0 : 1);
