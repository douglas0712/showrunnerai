// QUALITY GATE — PASSO 13, PRODUCTION EXECUTION.
//
// NÃO faz parte de `npm test`: usa o runtime de raciocínio, o ComfyUI e a GPU.
//
// ── O que este arquivo prova ────────────────────────────────────────────────
//
// Uma frase, do começo ao fim, com tudo real:
//
//   uma cena planejada vira imagem, vira outra imagem, o usuário escolhe entre
//   elas, e o vídeo que sai anima A QUE ELE ESCOLHEU — no formato da produção,
//   com a linhagem gravada, e sobrevivendo a um reinício.
//
// Cada elo dessa frase foi construído num subpasso diferente (13-A a 13-E) e
// testado isoladamente. O que nenhum teste isolado consegue provar é que os
// elos se encontram: que a seleção do 13-D chega à resolução de origem do
// 13-C, que o formato do 13-E acompanha os dois, e que o take do 13-A ainda
// está lá depois de tudo.
//
// ── Por que o projeto é criado aqui ─────────────────────────────────────────
//
// Para o gate ser repetível. Um projeto de smoke antigo carrega mídia de
// execuções passadas, e "o take 2" passa a significar coisas diferentes a cada
// rodada. Aqui a produção nasce vazia, com id derivado do relógio.
//
// ── O que NÃO é prova ───────────────────────────────────────────────────────
//
// O vídeo parecer com a imagem. Um t2v com o mesmo prompt pareceria também. A
// prova do mecanismo é o grafo que o ComfyUI guardou: `LoadImage` ligado a
// `first_frame`, e o modo lido de volta.
//
// Uso:
//   SHOWRUNNER_HERMES_URL=... SHOWRUNNER_HERMES_TOKEN=... \
//   node tests/quality-gate-13.mjs [aspectRatio]

import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { AGENT_EVENTS } from '../lib/server/agent/events.js';
import { createRuntime } from '../lib/server/agent/runtimes.js';
import { startBridgeServer } from '../lib/server/agent/hermes/bridge.js';
import { createThread, sendMessage } from '../lib/server/agent/gateway.js';
import { closeDatabase, database } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { getAsset } from '../lib/server/domain/assets.js';
import { getGenerationJobRecord } from '../lib/server/domain/generationJobs.js';
import {
  getProductionScene, listProductionScenes, replaceProductionScenes,
  saveProductionPlan, saveProductionScript,
} from '../lib/server/domain/production.js';
import { getSceneSelection, listSceneTakes } from '../lib/server/domain/sceneMedia.js';
import { getSceneMediaTool } from '../lib/server/agent/tools/handlers/productionSceneTakes.js';
import { replaceScenesTool } from '../lib/server/agent/tools/handlers/productionScenes.js';
import { getGenerationJob } from '../lib/server/generation/facade.js';
import { modeFromGraph } from '../lib/server/comfy/workflow.js';
import { getWorkflow } from '../lib/server/generation/workflows/registry.js';
import { aspectFromSelector } from '../lib/server/generation/workflows/resolutionSelector.js';
import { COMFY_BASE_URL } from '../lib/server/comfy/config.js';

const ASPECTO = process.argv[2] || '9:16';
const DURACAO_NARRATIVA = 45;
const SOCKET = process.env.SHOWRUNNER_BRIDGE_SOCKET
  || path.join(process.cwd(), 'runtime', 'hermes', 'bridge.sock');

let falhas = 0;
const ok = (cond, texto) => {
  console.log(`${cond ? '  ✔' : '  ✖'} ${texto}`);
  if (!cond) falhas += 1;
};
const secao = (t) => console.log(`\n${'─'.repeat(70)}\n${t}\n`);

async function dimensoesDoPng(caminho) {
  const bytes = await readFile(caminho);
  if (bytes.subarray(1, 4).toString() !== 'PNG') return null;
  return { largura: bytes.readUInt32BE(16), altura: bytes.readUInt32BE(20) };
}

// ── a produção ──────────────────────────────────────────────────────────────

let db = database();
const projectId = `gate13_${Date.now().toString(36)}`;

console.log(`QUALITY GATE — PASSO 13\nprodução: ${projectId} · formato ${ASPECTO}\n`);

createProject({ id: projectId, name: `Quality Gate 13 (${ASPECTO})` }, db);
saveProductionPlan({
  projectId,
  title: 'O farol',
  logline: 'Um farol que resiste à noite.',
  format: 'curta',
  targetDurationSeconds: DURACAO_NARRATIVA * 2,
  aspectRatio: ASPECTO,
  tone: 'contemplativo',
}, db);
saveProductionScript({
  projectId, title: 'O farol', summary: 'Duas cenas.',
  fullText: 'ABERTURA. Um farol no alto do penhasco, ao amanhecer...',
}, db);
replaceProductionScenes(projectId, [
  {
    ordinal: 1, title: 'O farol ao amanhecer',
    purpose: 'Abrir com uma imagem que se sustente sozinha',
    durationSeconds: DURACAO_NARRATIVA,
    narration: 'Todas as noites, a mesma luz.',
    visualDescription: 'Um farol solitário no alto de um penhasco, névoa baixa, luz fria.',
  },
  {
    ordinal: 2, title: 'O mar',
    purpose: 'Mostrar contra o que ele resiste',
    durationSeconds: DURACAO_NARRATIVA,
    visualDescription: 'O mar batendo nas rochas, espuma branca.',
  },
], db);

const cena = getProductionScene(projectId, 1, db);
ok(listProductionScenes(projectId, db).length === 2, 'a produção tem duas cenas');
ok(cena.durationSeconds === DURACAO_NARRATIVA,
  `a cena 1 tem duração NARRATIVA de ${DURACAO_NARRATIVA}s`);
ok(listSceneTakes(projectId, 1, null, db).length === 0, 'e nenhuma mídia — nasce vazia');

const runtime = createRuntime('hermes');
ok(runtime.isAvailable(), 'o runtime de raciocínio está disponível');
const bridge = await startBridgeServer({ socketPath: SOCKET, db });

/** Tudo o que saiu para fora nos cinco turnos — para a varredura final. */
const superficie = [];
const tempos = [];

async function turno(numero, texto, thread) {
  const comecou = Date.now();
  const r = await sendMessage({ threadId: thread, content: texto }, { db, runtime });
  const levou = (Date.now() - comecou) / 1000;
  const tools = r.events
    .filter((e) => e.type === AGENT_EVENTS.TOOL_STARTED).map((e) => e.name);

  superficie.push(JSON.stringify({ eventos: r.events, resposta: r.assistantMessage.content }));
  tempos.push({ turno: numero, segundos: Number(levou.toFixed(1)), tools: tools.join(' → ') });

  console.log(`   tools: ${JSON.stringify(tools)}`);
  console.log(`   resposta: ${JSON.stringify(r.assistantMessage.content.slice(0, 210))}`);
  console.log(`   turno: ${levou.toFixed(1)}s`);
  return { tools, resposta: r.assistantMessage.content };
}

/** Leva uma geração ao fim pelo caminho que a tela usa. Devolve os segundos. */
async function esperar(jobId, minutos) {
  const comecou = Date.now();
  const limite = comecou + minutos * 60 * 1000;
  let estado = null;
  while (Date.now() < limite) {
    estado = await getGenerationJob(jobId, { projectId, db });
    if (getGenerationJobRecord(jobId, db)?.assetId) break;
    if (['failed', 'cancelled', 'orphaned'].includes(estado.status)) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  const levou = (Date.now() - comecou) / 1000;
  console.log(`   geração: ${estado?.status} em ~${levou.toFixed(0)}s`);
  return levou;
}

try {
  const thread = createThread({ projectId, title: 'Quality Gate 13' }, { db });

  // ── turno 1 · a primeira imagem ─────────────────────────────────────────
  secao('TURNO 1 — "Gere uma imagem para a cena 1."');
  const t1 = await turno(1, 'Gere uma imagem para a cena 1.', thread.id);
  ok(t1.tools.includes('project.generate_scene_image'), 'usou project.generate_scene_image');
  ok(!t1.tools.includes('og.generate_image'), 'e não a geração avulsa');

  const take1 = listSceneTakes(projectId, 1, 'image', db)[0];
  ok(take1?.takeNumber === 1, 'nasceu o image take 1');
  ok(Boolean(take1?.generationJobId), 'já ligado à geração');
  ok(take1?.assetId === null, 'e o turno terminou ANTES da GPU (ainda sem Asset)');
  const geracao1 = await esperar(take1.generationJobId, 8);

  const A = getAsset(listSceneTakes(projectId, 1, 'image', db)[0].assetId ?? '', db);
  ok(Boolean(A), 'Asset A existe');
  ok(getSceneSelection(projectId, 1, 'image', db)?.takeNumber === 1,
    'e o primeiro take concluído virou a imagem escolhida');

  // ── turno 2 · "faça outra" ──────────────────────────────────────────────
  secao('TURNO 2 — "Faça outra imagem da cena 1, mais sombria."');
  const t2 = await turno(2, 'Faça outra imagem da cena 1, mais sombria.', thread.id);
  ok(t2.tools.includes('project.generate_scene_image'), 'gerou de novo pela ferramenta da cena');

  const take2 = listSceneTakes(projectId, 1, 'image', db)[1];
  ok(take2?.takeNumber === 2, 'nasceu o image take 2');
  ok(getSceneSelection(projectId, 1, 'image', db)?.takeNumber === 1,
    'a escolha NÃO mudou ao gerar outra');
  await esperar(take2.generationJobId, 8);

  const B = getAsset(listSceneTakes(projectId, 1, 'image', db)[1].assetId ?? '', db);
  ok(Boolean(B), 'Asset B existe');
  ok(getSceneSelection(projectId, 1, 'image', db)?.takeNumber === 1,
    'e mesmo depois de pronta, a nova não tomou o lugar da escolhida');
  ok(getAsset(A.id, db) !== null, 'o take 1 continua com a mídia dele — nada foi sobrescrito');

  // ── turno 3 · "use a segunda" ───────────────────────────────────────────
  secao('TURNO 3 — "Use a segunda imagem."');
  const t3 = await turno(3, 'Use a segunda imagem.', thread.id);
  ok(t3.tools.includes('project.select_scene_take'), 'escolheu pela ferramenta de seleção');

  const escolhida = getSceneSelection(projectId, 1, 'image', db);
  ok(escolhida?.takeNumber === 2, 'a imagem escolhida passou a ser o take 2');
  ok(escolhida?.assetId === B.id, 'apontando para o Asset B');
  ok(listSceneTakes(projectId, 1, 'image', db).length === 2, 'os dois takes continuam lá');

  // ── turno 4 · "qual está selecionada?" ──────────────────────────────────
  secao('TURNO 4 — "Qual imagem está selecionada?"');
  const t4 = await turno(4, 'Qual imagem está selecionada na cena 1?', thread.id);
  ok(t4.tools.includes('project.get_scene_media'), 'consultou o estado real');
  ok(/\b2\b|segunda/i.test(t4.resposta), 'e respondeu a tentativa 2');

  // ── turno 5 · "anime essa versão" ───────────────────────────────────────
  secao('TURNO 5 — "Anime essa versão."');
  const t5 = await turno(5, 'Anime essa versão.', thread.id);
  ok(t5.tools.includes('project.generate_scene_video'), 'usou project.generate_scene_video');
  ok(!t5.tools.includes('og.generate_video'), 'e não a geração de vídeo avulsa');

  const takeVideo = listSceneTakes(projectId, 1, 'video', db)[0];
  ok(takeVideo?.takeNumber === 1, 'nasceu o video take 1');
  ok(takeVideo?.assetId === null, 'e o turno terminou antes da GPU');

  const registroDoVideo = getGenerationJobRecord(takeVideo.generationJobId, db);
  ok(registroDoVideo?.derivedFromAssetId === B.id,
    'o registro da geração já aponta para a imagem ESCOLHIDA (B)');
  ok(registroDoVideo?.derivedFromAssetId !== A.id, 'e não para a antiga (A)');

  const geracaoVideo = await esperar(takeVideo.generationJobId, 20);
  const C = getAsset(
    listSceneTakes(projectId, 1, 'video', db)[0].assetId ?? '', db,
  );
  ok(Boolean(C), 'Asset C existe');
  ok(getSceneSelection(projectId, 1, 'video', db)?.takeNumber === 1,
    'e virou o vídeo escolhido da cena');

  // ── linhagem ────────────────────────────────────────────────────────────
  secao('LINHAGEM');
  console.log(`   A (image take 1): ${A.id}`);
  console.log(`   B (image take 2): ${B.id}   ← escolhida`);
  console.log(`   C (video take 1): ${C.id}`);
  console.log(`   C.derivedFromAssetId          = ${C.derivedFromAssetId}`);
  console.log(`   generation_jobs.derivedFrom.. = ${registroDoVideo.derivedFromAssetId}`);
  ok(C.derivedFromAssetId === B.id, 'Asset: C.derivedFromAssetId === B.id');
  ok(C.derivedFromAssetId !== A.id, 'e NÃO === A.id');
  ok(getGenerationJobRecord(takeVideo.generationJobId, db).derivedFromAssetId === B.id,
    'generation_jobs: derivedFromAssetId === B.id');
  ok(getAsset(A.id, db).derivedFromAssetId === null, 'A não deriva de nada');
  ok(getAsset(B.id, db).derivedFromAssetId === null, 'B não deriva de nada');

  // ── o grafo real ────────────────────────────────────────────────────────
  secao('MECANISMO I2V — o grafo que o ComfyUI guardou');
  const promptIdVideo = registroDoVideo.providerJobId
    ?? getGenerationJobRecord(takeVideo.generationJobId, db).providerJobId;
  console.log(`   promptId: ${promptIdVideo}`);
  const histVideo = await (await fetch(`${COMFY_BASE_URL}/history/${promptIdVideo}`)).json();
  const grafoVideo = histVideo?.[promptIdVideo]?.prompt?.[2];
  ok(Boolean(grafoVideo), 'o grafo do vídeo foi guardado');

  if (grafoVideo) {
    const carregadores = Object.entries(grafoVideo)
      .filter(([, n]) => n?.class_type === 'LoadImage');
    const [idModelo, noModelo] = Object.entries(grafoVideo)
      .find(([, n]) => n?.class_type === 'MiniMaxH3ImageToVideo') || [];

    console.log(`   LoadImage: ${carregadores.length}`);
    for (const [id, n] of carregadores) console.log(`     ${id} → ${JSON.stringify(n.inputs.image)}`);
    console.log(`   ${idModelo}.first_frame = ${JSON.stringify(noModelo?.inputs?.first_frame)}`);
    console.log(`   modo lido do grafo: ${modeFromGraph(grafoVideo)}`);

    ok(carregadores.length >= 1, 'LoadImage >= 1');
    ok(Boolean(noModelo?.inputs?.first_frame), 'first_frame ligado no MiniMaxH3ImageToVideo');
    ok(carregadores.some(([id]) => noModelo?.inputs?.first_frame?.[0] === id),
      'first_frame aponta para um LoadImage deste grafo');
    ok(modeFromGraph(grafoVideo) === 'i2v', 'modo = i2v');
  }

  // ── aspect ratio ────────────────────────────────────────────────────────
  secao(`ASPECT RATIO — o plano diz ${ASPECTO}`);
  const promptIdImagem = getGenerationJobRecord(take2.generationJobId, db)?.providerJobId;
  const histImagem = await (await fetch(`${COMFY_BASE_URL}/history/${promptIdImagem}`)).json();
  const grafoImagem = histImagem?.[promptIdImagem]?.prompt?.[2];
  const nosImagem = getWorkflow('ideogram4_t2i').nodeIds;
  const nosVideo = getWorkflow('minimax_h3_t2v').nodeIds;

  const daImagem = aspectFromSelector(grafoImagem?.[nosImagem.resolution]?.inputs?.aspect_ratio);
  const doVideo = aspectFromSelector(grafoVideo?.[nosVideo.resolution]?.inputs?.aspect_ratio);
  console.log(`   grafo da imagem: ${daImagem}`);
  console.log(`   grafo do vídeo : ${doVideo}`);
  ok(daImagem === ASPECTO, `a geração de imagem recebeu ${ASPECTO}`);
  ok(doVideo === ASPECTO, `a geração de vídeo recebeu ${ASPECTO}`);

  const dim = await dimensoesDoPng(
    path.join(process.cwd(), 'runtime', 'projects', projectId, 'images', B.filename),
  );
  const [w, h] = ASPECTO.split(':').map(Number);
  console.log(`   arquivo de B: ${dim?.largura}×${dim?.altura} (pedido ${(w / h).toFixed(3)}, real ${(dim.largura / dim.altura).toFixed(3)})`);
  ok(Math.abs(dim.largura / dim.altura - w / h) < 0.05, 'os pixels têm a proporção da produção');

  // ── duração ─────────────────────────────────────────────────────────────
  secao('DURAÇÃO — narrativa vs execução');
  const clipe = grafoVideo?.[nosVideo.duration]?.inputs?.value;
  console.log(`   Scene.durationSeconds (narrativa) = ${cena.durationSeconds}`);
  console.log(`   duração submetida ao gerador      = ${clipe}`);
  ok(cena.durationSeconds === DURACAO_NARRATIVA, 'a cena continua dizendo o que a cena dura');
  ok(Number(clipe) !== cena.durationSeconds,
    'a duração narrativa NÃO virou a duração do clipe');
  ok(getAsset(C.id, db).durationSeconds !== DURACAO_NARRATIVA,
    'e o Asset de vídeo não herdou a duração da cena');

  // ── Job Autonomy ────────────────────────────────────────────────────────
  secao('JOB AUTONOMY — o turno acaba antes da GPU');
  console.table(tempos);
  console.log(`   geração da imagem 1: ~${geracao1.toFixed(0)}s · vídeo: ~${geracaoVideo.toFixed(0)}s`);
  ok(tempos[0].segundos < geracao1, 'o turno 1 terminou antes da imagem ficar pronta');
  ok(tempos[4].segundos < geracaoVideo, 'o turno 5 terminou antes do vídeo ficar pronto');
  ok(!superficie.join(' ').includes('e aí'), 'ninguém precisou perguntar "e aí?"');

  // ── replace protection ──────────────────────────────────────────────────
  secao('REPLACE PROTECTION — a produção já tem mídia');
  const ctx = { threadId: thread.id, projectId, userMessageId: null, signal: null };
  const antes = {
    takes: listSceneTakes(projectId, 1, null, db).map((t) => `${t.kind}${t.takeNumber}:${t.assetId}`),
    imagem: getSceneSelection(projectId, 1, 'image', db)?.id,
    video: getSceneSelection(projectId, 1, 'video', db)?.id,
    cenas: listProductionScenes(projectId, db).map((c) => c.id),
  };

  let recusa = null;
  try {
    await replaceScenesTool.execute(ctx, {
      scenes: [{ ordinal: 1, title: 'Outra', durationSeconds: 90 }],
    });
  } catch (erro) { recusa = erro; }

  console.log(`   recusa: ${JSON.stringify(recusa?.message)}`);
  ok(Boolean(recusa), 'substituir todas as cenas foi RECUSADO');
  ok(/já tem mídia associada/.test(recusa?.message ?? ''), 'com a mensagem de proteção');
  ok(!/[a-z]+_[a-z0-9]{8}_/.test(recusa?.message ?? ''), 'e sem vazar identificador nenhum');

  const depois = {
    takes: listSceneTakes(projectId, 1, null, db).map((t) => `${t.kind}${t.takeNumber}:${t.assetId}`),
    imagem: getSceneSelection(projectId, 1, 'image', db)?.id,
    video: getSceneSelection(projectId, 1, 'video', db)?.id,
    cenas: listProductionScenes(projectId, db).map((c) => c.id),
  };
  ok(JSON.stringify(antes) === JSON.stringify(depois),
    'takes, seleções, Assets e cenas ficaram idênticos');

  // ── public surface ──────────────────────────────────────────────────────
  secao('PUBLIC SURFACE — o que atravessou para fora nos cinco turnos');
  const tudo = superficie.join('\n');
  const internos = [
    ['assetId A', A.id], ['assetId B', B.id], ['assetId C', C.id],
    ['mediaId', take1.id], ['mediaId 2', take2.id], ['mediaId vídeo', takeVideo.id],
    ['sceneId', take1.sceneId], ['generationJobId', take1.generationJobId],
    ['generationJobId vídeo', takeVideo.generationJobId],
    ['arquivo de A', A.filename], ['arquivo de C', C.filename],
    ['promptId', promptIdVideo],
  ];
  for (const [rotulo, valor] of internos) {
    ok(!tudo.includes(valor), `${rotulo} não aparece`);
  }
  for (const proibido of [/sourceAssetId/, /derivedFromAssetId/, /workflowId/, /ideogram/i,
    /minimax/i, /comfy/i, /LoadImage/, /first_frame/, /hermes/i, /session_id/,
    /enabled_toolsets/, /runtime\//, /\/api\/media\//]) {
    ok(!proibido.test(tudo), `${proibido} não aparece`);
  }
  // O que PODE aparecer: o nome canônico das ferramentas.
  ok(tudo.includes('project.generate_scene_video'), 'os nomes canônicos das tools aparecem');
  ok(!tudo.includes('project_generate_scene_video'), 'e os aliases do runtime NÃO');

  // ── reload ──────────────────────────────────────────────────────────────
  secao('PERSISTÊNCIA — fechar o banco e voltar do zero');
  const retratoAntes = await getSceneMediaTool.execute(ctx, { ordinal: 1 });
  console.log(`   antes:  ${JSON.stringify(retratoAntes)}`);

  await bridge.close();
  closeDatabase();
  delete globalThis[Symbol.for('showrunner.domain.db')];
  delete globalThis[Symbol.for('showrunner.agent.jobWatch')];
  db = database();

  const retratoDepois = await getSceneMediaTool.execute(ctx, { ordinal: 1 });
  console.log(`   depois: ${JSON.stringify(retratoDepois)}`);

  ok(JSON.stringify(retratoAntes) === JSON.stringify(retratoDepois),
    'o estado da cena atravessou o reinício idêntico');
  ok(getSceneSelection(projectId, 1, 'image', db)?.assetId === B.id,
    'a imagem escolhida continua sendo B');
  ok(getSceneSelection(projectId, 1, 'video', db)?.assetId === C.id,
    'o vídeo escolhido continua sendo C');
  ok(getAsset(C.id, db)?.derivedFromAssetId === B.id, 'e a linhagem sobreviveu');
  ok(listSceneTakes(projectId, 1, null, db).length === 3, 'os três takes continuam lá');

  // ── o retrato final ─────────────────────────────────────────────────────
  secao('RETRATO FINAL');
  for (const kind of ['image', 'video']) {
    const sel = getSceneSelection(projectId, 1, kind, db);
    for (const t of listSceneTakes(projectId, 1, kind, db)) {
      const a = t.assetId ? getAsset(t.assetId, db) : null;
      console.log(`   ${kind} take ${t.takeNumber} · ${a?.filename ?? '—'}`
        + ` · deriva de ${a?.derivedFromAssetId ?? '—'}${sel?.id === t.id ? '  ← escolhido' : ''}`);
    }
  }
} finally {
  try { await bridge.close(); } catch { /* já fechado no bloco de reload */ }
}

console.log(`\n${falhas === 0 ? 'QUALITY GATE 13 — APROVADO' : `QUALITY GATE 13 — ${falhas} FALHA(S)`}`);
console.log(`projeto: ${projectId}`);
process.exit(falhas === 0 ? 0 : 1);
