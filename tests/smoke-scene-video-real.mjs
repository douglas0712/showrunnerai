// SMOKE REAL — a cena em movimento, do pedido ao Asset com linhagem.
//
// PASSO 13-C. NÃO faz parte de `npm test`: depende do runtime dedicado, do
// ComfyUI e da rede.
//
// O que ele exercita, de ponta a ponta:
//
//   "Anime a cena 1."
//     → runtime → plugin → socket → bridge → project.generate_scene_video
//     → o SERVIDOR resolve a imagem escolhida da cena
//     → take de vídeo 1, já ligado ao job, com linhagem no registro
//     → o turno TERMINA (sem esperar a GPU)
//     → Job Autonomy leva até o fim
//     → Asset de vídeo → take.assetId → seleção de vídeo = take 1
//
// E prova o MECANISMO, não a aparência: o grafo que o ComfyUI guardou tem
// LoadImage ligado a `first_frame`. Um vídeo parecido com a imagem não é prova
// de i2v — um T2V com o mesmo prompt também pareceria.
//
// Uso:
//   SHOWRUNNER_HERMES_URL=... SHOWRUNNER_HERMES_TOKEN=... \
//   node tests/smoke-scene-video-real.mjs <projectId> [ordinal]

import path from 'node:path';
import { AGENT_EVENTS } from '../lib/server/agent/events.js';
import { createRuntime } from '../lib/server/agent/runtimes.js';
import { startBridgeServer } from '../lib/server/agent/hermes/bridge.js';
import { createThread, sendMessage } from '../lib/server/agent/gateway.js';
import { database } from '../lib/server/domain/db.js';
import { getProject } from '../lib/server/domain/projects.js';
import { getAsset } from '../lib/server/domain/assets.js';
import { getProductionScene } from '../lib/server/domain/production.js';
import { getSceneSelection, listSceneTakes } from '../lib/server/domain/sceneMedia.js';
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

console.log(`SMOKE REAL 13-C — ${projeto.name} (${projeto.id}), cena ${ORDINAL}\n`);

const cena = getProductionScene(projeto.id, ORDINAL, db);
ok(Boolean(cena), `a cena ${ORDINAL} existe`);
console.log(`  cena: ${JSON.stringify(cena?.title)}`);

// A pré-condição do passo: a cena precisa ter imagem escolhida. É o estado que
// o 13-B deixa.
const imagemEscolhida = getSceneSelection(projeto.id, ORDINAL, 'image', db);
const assetDeOrigem = imagemEscolhida?.assetId ? getAsset(imagemEscolhida.assetId, db) : null;
ok(Boolean(assetDeOrigem), 'a cena tem imagem escolhida, com Asset');
console.log(`  imagem escolhida: take ${imagemEscolhida?.takeNumber} · ${assetDeOrigem?.filename}`);
if (!assetDeOrigem) {
  console.error('\nSem imagem escolhida não há o que animar. Rode o smoke do 13-B antes.');
  process.exit(2);
}

const antes = {
  videos: listSceneTakes(projeto.id, ORDINAL, 'video', db).length,
  imagens: listSceneTakes(projeto.id, ORDINAL, 'image', db).length,
};
console.log(`  takes antes — imagem: ${antes.imagens} · vídeo: ${antes.videos}`);

const runtime = createRuntime('hermes');
ok(runtime.isAvailable(), 'o runtime está configurado');
ok((await runtime.testConnection()).ok, 'o serviço de raciocínio respondeu');

const bridge = await startBridgeServer({ socketPath: SOCKET, db });
console.log(`bridge no ar: ${bridge.socketPath}\n`);

try {
  // ── 1 · o turno ─────────────────────────────────────────────────────────
  console.log('1. o pedido, em português de usuário:');
  const thread = createThread({ projectId: projeto.id, title: 'Smoke 13-C' }, { db });

  const comecou = Date.now();
  const turno = await sendMessage(
    { threadId: thread.id, content: `Anime a cena ${ORDINAL}.` },
    { db, runtime },
  );
  const durou = Date.now() - comecou;

  const iniciadas = turno.events.filter((e) => e.type === AGENT_EVENTS.TOOL_STARTED);
  console.log(`   tools: ${JSON.stringify(iniciadas.map((e) => e.name))}`);
  console.log(`   resposta: ${JSON.stringify(turno.assistantMessage.content.slice(0, 220))}`);
  console.log(`   o turno levou ${(durou / 1000).toFixed(1)}s`);

  ok(iniciadas.some((e) => e.name === 'project.generate_scene_video'),
    'o agente usou project.generate_scene_video');
  ok(!iniciadas.some((e) => e.name === 'og.generate_video'),
    'e NÃO usou a geração de vídeo avulsa');
  ok(!iniciadas.some((e) => e.name === 'project.generate_scene_image'),
    'e não gerou imagem nova para animar');
  ok(!JSON.stringify(turno.events).includes('sourceAssetId'),
    'o modelo não falou de imagem de origem em lugar nenhum');

  // ── 2 · o take, e a linhagem desde o início ─────────────────────────────
  console.log('\n2. o take de vídeo, logo depois do turno:');
  const logoDepois = listSceneTakes(projeto.id, ORDINAL, 'video', db);
  const take = logoDepois[logoDepois.length - 1];
  ok(Boolean(take), 'existe um take de vídeo na cena');
  ok(logoDepois.length === antes.videos + 1, 'exatamente UM take de vídeo novo');
  ok(Boolean(take?.generationJobId), 'o take já nasce ligado à geração');
  console.log(`   take ${take?.takeNumber} · job ${take?.generationJobId}`);

  const registro = getGenerationJobRecord(take.generationJobId, db);
  ok(registro?.kind === 'video', 'o registro é de vídeo');
  ok(registro?.derivedFromAssetId === assetDeOrigem.id,
    'o registro da geração já guarda a linhagem para a imagem escolhida');

  // ── 3 · a Job Autonomy leva até o fim ───────────────────────────────────
  console.log('\n3. a geração, levada pelo estúdio:');
  const jobId = take.generationJobId;
  const limite = Date.now() + 15 * 60 * 1000;
  let estado = null;

  while (Date.now() < limite) {
    estado = await getGenerationJob(jobId, { projectId: projeto.id, db });
    const linha = listSceneTakes(projeto.id, ORDINAL, 'video', db)
      .find((t) => t.generationJobId === jobId);
    process.stdout.write(`\r   ${String(estado.status).padEnd(14)} · asset no take: ${linha?.assetId ? 'sim' : 'não '}   `);
    if (linha?.assetId) break;
    if (['failed', 'cancelled', 'orphaned'].includes(estado.status)) break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(`\n   estado final: ${estado?.status}`);

  // ── 4 · a prova no banco ────────────────────────────────────────────────
  console.log('\n4. a prova, no banco:');
  const final = listSceneTakes(projeto.id, ORDINAL, 'video', db)
    .find((t) => t.generationJobId === jobId);
  const escolhaDeVideo = getSceneSelection(projeto.id, ORDINAL, 'video', db);
  const video = final?.assetId ? getAsset(final.assetId, db) : null;

  ok(Boolean(final?.generationJobId), 'o take tem generationJobId');
  ok(Boolean(final?.assetId), 'o take tem assetId');
  ok(escolhaDeVideo?.id === final?.id, 'a seleção de vídeo aponta para ESTE take');
  ok(escolhaDeVideo?.takeNumber === final?.takeNumber, `a escolha é o take ${final?.takeNumber}`);
  ok(video?.kind === 'video', 'o Asset é de vídeo');
  ok(video?.projectId === projeto.id, 'o Asset é deste projeto');
  console.log(`   asset: ${video?.filename} · ${video?.url}`);

  // ── 5 · a linhagem, o gate do passo ─────────────────────────────────────
  console.log('\n5. linhagem:');
  console.log(`   imagem escolhida (A): ${assetDeOrigem.id}`);
  console.log(`   vídeo          (B): ${video?.id}`);
  console.log(`   B.derivedFromAssetId: ${video?.derivedFromAssetId}`);
  ok(video?.derivedFromAssetId === assetDeOrigem.id,
    'Asset de vídeo.derivedFromAssetId === imagem escolhida');
  ok(getGenerationJobRecord(jobId, db)?.derivedFromAssetId === assetDeOrigem.id,
    'generation_jobs.derivedFromAssetId === imagem escolhida');
  ok(video?.derivedFromAssetId !== null, 'a linhagem NÃO é nula — isto seria T2V');

  // ── 6 · o grafo real, no /history do ComfyUI ────────────────────────────
  console.log('\n6. o grafo que foi realmente submetido:');
  const promptId = getGenerationJobRecord(jobId, db)?.providerJobId;
  console.log(`   promptId: ${promptId}`);
  ok(Boolean(promptId), 'o executor aceitou e devolveu um identificador');

  if (promptId) {
    const resposta = await fetch(`${COMFY_BASE_URL}/history/${promptId}`);
    const historico = await resposta.json();
    const grafo = historico?.[promptId]?.prompt?.[2];
    ok(Boolean(grafo), 'o ComfyUI guardou o grafo submetido');

    if (grafo) {
      const carregadores = Object.entries(grafo)
        .filter(([, n]) => n?.class_type === 'LoadImage');
      const [idDoModelo, noDoModelo] = Object.entries(grafo)
        .find(([, n]) => n?.class_type === 'MiniMaxH3ImageToVideo') || [];

      console.log(`   LoadImage no grafo: ${carregadores.length}`);
      console.log(`   nó do modelo: ${idDoModelo}`);
      console.log(`   first_frame: ${JSON.stringify(noDoModelo?.inputs?.first_frame)}`);
      console.log(`   modo lido do grafo: ${modeFromGraph(grafo)}`);

      ok(carregadores.length >= 1, 'LoadImage >= 1 — sem isto seria T2V');
      ok(Boolean(noDoModelo?.inputs?.first_frame), 'first_frame está ligado no nó do modelo');
      ok(
        carregadores.some(([id]) => noDoModelo?.inputs?.first_frame?.[0] === id),
        'first_frame aponta para um LoadImage do grafo',
      );
      ok(modeFromGraph(grafo) === 'i2v', 'o modo do grafo é i2v');
    }
  }

  // ── 7 · nada além do vídeo pedido ───────────────────────────────────────
  console.log('\n7. nada além:');
  const imagensNovas = Number(
    db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE kind = 'image' AND createdAt >= ?")
      .get(comecou).n,
  );
  ok(imagensNovas === 0, `gerações de imagem iniciadas: ${imagensNovas}`);
  ok(listSceneTakes(projeto.id, ORDINAL, 'image', db).length === antes.imagens,
    'nenhum take de imagem novo');
  ok(getSceneSelection(projeto.id, ORDINAL, 'image', db)?.assetId === assetDeOrigem.id,
    'a imagem escolhida da cena continua a mesma');

  console.log(`\nretrato da cena ${ORDINAL}:`);
  for (const t of listSceneTakes(projeto.id, ORDINAL, null, db)) {
    const escolhido = getSceneSelection(projeto.id, ORDINAL, t.kind, db);
    const marca = escolhido?.id === t.id ? ' ← escolhido' : '';
    const asset = t.assetId ? getAsset(t.assetId, db) : null;
    console.log(`   ${t.kind} take ${t.takeNumber} · asset ${t.assetId ?? '—'}`
      + ` · deriva de ${asset?.derivedFromAssetId ?? '—'}${marca}`);
  }
} finally {
  await bridge.close();
}

console.log(`\n${falhas === 0 ? 'SMOKE OK' : `SMOKE COM ${falhas} FALHA(S)`}`);
process.exit(falhas === 0 ? 0 : 1);
