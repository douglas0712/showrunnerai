// SMOKE REAL — a imagem de uma cena, do pedido ao Asset.
//
// PASSO 13-B. NÃO faz parte de `npm test`: o nome termina em `.mjs` e não em
// `.test.mjs` porque depende do runtime dedicado, do ComfyUI e da rede.
//
// O que ele exercita, de ponta a ponta:
//
//   "Gere uma imagem para a cena 1"
//     → runtime → plugin → socket → bridge → project.generate_scene_image
//     → take de imagem 1, já ligado ao job
//     → o turno TERMINA (sem esperar a GPU)
//     → Job Autonomy leva até o fim
//     → Asset publicado → take.assetId → seleção de imagem = take 1
//
// Uso:
//   SHOWRUNNER_HERMES_URL=... SHOWRUNNER_HERMES_TOKEN=... \
//   node tests/smoke-scene-image-real.mjs <projectId>

import path from 'node:path';
import { AGENT_EVENTS } from '../lib/server/agent/events.js';
import { createRuntime } from '../lib/server/agent/runtimes.js';
import { startBridgeServer } from '../lib/server/agent/hermes/bridge.js';
import { createThread, sendMessage } from '../lib/server/agent/gateway.js';
import { database } from '../lib/server/domain/db.js';
import { getProject } from '../lib/server/domain/projects.js';
import { listProductionScenes } from '../lib/server/domain/production.js';
import { getSceneSelection, listSceneTakes } from '../lib/server/domain/sceneMedia.js';
import { getGenerationJob } from '../lib/server/generation/facade.js';

const PROJECT_ID = process.argv[2];
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

console.log(`SMOKE REAL 13-B — ${projeto.name} (${projeto.id})\n`);

const cenas = listProductionScenes(projeto.id, db);
console.log(`cenas gravadas: ${cenas.length}`);
ok(cenas.length > 0, 'a produção tem cenas');
console.log(`  cena 1: ${JSON.stringify(cenas[0]?.title)}`);

// O ponto de partida, para que o "depois" signifique alguma coisa.
const antes = {
  imagens: listSceneTakes(projeto.id, 1, 'image', db).length,
  videos: Number(db.prepare("SELECT COUNT(*) AS n FROM production_scene_media WHERE kind = 'video'").get().n),
};
console.log(`  takes de imagem antes: ${antes.imagens} · vídeos no banco inteiro: ${antes.videos}`);

const runtime = createRuntime('hermes');
ok(runtime.isAvailable(), 'o runtime está configurado');
const conexao = await runtime.testConnection();
ok(conexao.ok, 'o serviço de raciocínio respondeu');

const bridge = await startBridgeServer({ socketPath: SOCKET, db });
console.log(`bridge no ar: ${bridge.socketPath}\n`);

try {
  // ── 1 · o turno ─────────────────────────────────────────────────────────
  console.log('1. o pedido, em português de usuário:');
  const thread = createThread({ projectId: projeto.id, title: 'Smoke 13-B' }, { db });

  const comecou = Date.now();
  const turno = await sendMessage(
    { threadId: thread.id, content: 'Gere uma imagem para a cena 1.' },
    { db, runtime },
  );
  const durou = Date.now() - comecou;

  const iniciadas = turno.events.filter((e) => e.type === AGENT_EVENTS.TOOL_STARTED);
  const concluidas = turno.events.filter((e) => e.type === AGENT_EVENTS.TOOL_COMPLETED);
  console.log(`   tools: ${JSON.stringify(iniciadas.map((e) => e.name))}`);
  console.log(`   resposta: ${JSON.stringify(turno.assistantMessage.content.slice(0, 220))}`);
  console.log(`   o turno levou ${(durou / 1000).toFixed(1)}s`);

  ok(
    iniciadas.some((e) => e.name === 'project.generate_scene_image'),
    'o agente usou project.generate_scene_image',
  );
  ok(
    !iniciadas.some((e) => e.name === 'og.generate_image'),
    'e NÃO usou a geração avulsa para a mídia de uma cena',
  );
  ok(concluidas.length > 0, 'a ferramenta concluiu');
  ok(!JSON.stringify(turno.events).includes('project_generate_scene_image'),
    'o alias do runtime não aparece nos eventos — só o nome canônico');

  // ── 2 · o take nasceu, e o turno não esperou ────────────────────────────
  console.log('\n2. o take, logo depois do turno:');
  const logoDepois = listSceneTakes(projeto.id, 1, 'image', db);
  const take = logoDepois[logoDepois.length - 1];
  ok(Boolean(take), 'existe um take de imagem na cena 1');
  console.log(`   take ${take?.takeNumber} · job ${take?.generationJobId ? 'presente' : 'AUSENTE'}`
    + ` · asset ${take?.assetId ? 'presente' : 'ainda não'}`);
  ok(logoDepois.length === antes.imagens + 1, 'exatamente UM take novo');
  ok(Boolean(take?.generationJobId), 'o take já nasce ligado à geração');

  // ── 3 · a Job Autonomy leva até o fim ───────────────────────────────────
  console.log('\n3. a geração, levada pelo estúdio (sem ninguém perguntar):');
  const jobId = take.generationJobId;
  const limite = Date.now() + 8 * 60 * 1000;
  let estado = null;

  while (Date.now() < limite) {
    // A leitura NÃO conclui nada por fora: `getGenerationJob` é o mesmo caminho
    // que a tela usa, e é ele que faz a máquina de estados andar. Quem fecha o
    // registro é a camada de geração, como faria sem este script.
    estado = await getGenerationJob(jobId, { projectId: projeto.id, db });
    const linha = listSceneTakes(projeto.id, 1, 'image', db)
      .find((t) => t.generationJobId === jobId);
    process.stdout.write(`\r   ${estado.status.padEnd(14)} · asset no take: ${linha?.assetId ? 'sim' : 'não '}   `);
    if (linha?.assetId) break;
    if (['failed', 'cancelled', 'orphaned'].includes(estado.status)) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  console.log('');
  console.log(`   estado final da geração: ${estado?.status}`);

  // ── 4 · a prova, lida do banco ──────────────────────────────────────────
  console.log('\n4. a prova, no banco:');
  const final = listSceneTakes(projeto.id, 1, 'image', db)
    .find((t) => t.generationJobId === jobId);
  const escolha = getSceneSelection(projeto.id, 1, 'image', db);

  ok(Boolean(final?.generationJobId), 'o take tem generationJobId');
  ok(Boolean(final?.assetId), 'o take tem assetId');
  ok(Boolean(escolha), 'a cena 1 tem imagem escolhida');
  ok(escolha?.id === final?.id, 'a escolha aponta para ESTE take');
  ok(escolha?.takeNumber === final?.takeNumber,
    `a escolha é o take ${final?.takeNumber}`);

  const asset = db.prepare('SELECT id, projectId, kind, filename, url FROM assets WHERE id = ?')
    .get(final?.assetId ?? '');
  ok(asset?.projectId === projeto.id, 'o Asset é deste projeto');
  ok(asset?.kind === 'image', 'o Asset é de imagem');
  console.log(`   asset: ${asset?.filename} · ${asset?.url}`);

  // ── 5 · zero vídeo ──────────────────────────────────────────────────────
  console.log('\n5. nenhum vídeo foi gerado:');
  const videosAgora = Number(
    db.prepare("SELECT COUNT(*) AS n FROM production_scene_media WHERE kind = 'video'").get().n,
  );
  const jobsDeVideo = Number(
    db.prepare("SELECT COUNT(*) AS n FROM generation_jobs WHERE kind = 'video' AND createdAt >= ?")
      .get(comecou).n,
  );
  ok(videosAgora === antes.videos, `takes de vídeo novos: ${videosAgora - antes.videos}`);
  ok(jobsDeVideo === 0, `gerações de vídeo iniciadas: ${jobsDeVideo}`);

  // ── o retrato final ─────────────────────────────────────────────────────
  console.log('\nretrato da cena 1:');
  for (const t of listSceneTakes(projeto.id, 1, null, db)) {
    const marca = escolha?.id === t.id ? ' ← escolhido' : '';
    console.log(`   ${t.kind} take ${t.takeNumber} · job ${t.generationJobId ?? '—'} · asset ${t.assetId ?? '—'}${marca}`);
  }
} finally {
  await bridge.close();
}

console.log(`\n${falhas === 0 ? 'SMOKE OK' : `SMOKE COM ${falhas} FALHA(S)`}`);
process.exit(falhas === 0 ? 0 : 1);
