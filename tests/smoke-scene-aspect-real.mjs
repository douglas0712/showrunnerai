// SMOKE REAL — o formato da produção chega ao gerador.
//
// PASSO 13-E. NÃO faz parte de `npm test`: depende do ComfyUI e da rede.
//
// O menor smoke que prova o que precisa ser provado: uma produção em 9:16,
// UMA imagem de cena, e a conferência no grafo que o ComfyUI guardou. O
// pipeline inteiro é o de sempre — o que muda é de onde veio o `aspect`.
//
// ── Por que sem runtime de raciocínio ───────────────────────────────────────
//
// Porque o modelo não participa desta decisão. `aspectRatio` sai do plano
// gravado, e o schema da ferramenta não tem onde recebê-lo — fazer um turno de
// conversa aqui provaria a conversa, não o parâmetro. A ferramenta é chamada
// direto, com a facade de verdade.
//
// ── E sem vídeo ─────────────────────────────────────────────────────────────
//
// O caminho do vídeo passa pela MESMA `exigirAspectoSuportado` e pelo mesmo
// `selectorForAspect`, e os testes da facade já mostram o parâmetro chegando.
// Um render de vídeo aqui gastaria minutos de GPU para repetir isso.
//
// Uso:
//   node tests/smoke-scene-aspect-real.mjs [aspectRatio]

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { database } from '../lib/server/domain/db.js';
import { createProject, getProject } from '../lib/server/domain/projects.js';
import {
  getProductionScene, replaceProductionScenes, saveProductionPlan, saveProductionScript,
} from '../lib/server/domain/production.js';
import { getSceneSelection, listSceneTakes } from '../lib/server/domain/sceneMedia.js';
import { getGenerationJobRecord } from '../lib/server/domain/generationJobs.js';
import { getAsset } from '../lib/server/domain/assets.js';
import { generateSceneImageTool } from '../lib/server/agent/tools/handlers/productionSceneMedia.js';
import { getGenerationJob } from '../lib/server/generation/facade.js';
import { getWorkflow } from '../lib/server/generation/workflows/registry.js';
import { aspectFromSelector } from '../lib/server/generation/workflows/resolutionSelector.js';
import { COMFY_BASE_URL } from '../lib/server/comfy/config.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';

const ASPECTO = process.argv[2] || '9:16';
const DURACAO_DA_CENA = 45;

let falhas = 0;
const ok = (cond, texto) => {
  console.log(`${cond ? '  ✔' : '  ✖'} ${texto}`);
  if (!cond) falhas += 1;
};

/** Largura e altura lidas do IHDR — os bytes, não os metadados. */
async function dimensoesDoPng(caminho) {
  const bytes = await readFile(caminho);
  if (bytes.subarray(1, 4).toString() !== 'PNG') return null;
  return { largura: bytes.readUInt32BE(16), altura: bytes.readUInt32BE(20) };
}

const db = database();
const projectId = `smoke_aspecto_${Date.now().toString(36)}`;

console.log(`SMOKE REAL 13-E — produção em ${ASPECTO} (${projectId})\n`);

console.log('1. a produção, gravada como qualquer outra:');
createProject({ id: projectId, name: `Smoke ${ASPECTO}` }, db);
saveProductionPlan({
  projectId,
  title: `Vertical em ${ASPECTO}`,
  logline: 'Uma produção que não é widescreen.',
  targetDurationSeconds: DURACAO_DA_CENA,
  aspectRatio: ASPECTO,
}, db);
saveProductionScript({
  projectId, title: 'Roteiro', fullText: 'ABERTURA. Um farol no alto do penhasco.',
}, db);
replaceProductionScenes(projectId, [{
  ordinal: 1,
  title: 'O farol',
  purpose: 'Abrir o filme com uma imagem que se sustente sozinha',
  durationSeconds: DURACAO_DA_CENA,
  visualDescription: 'Um farol solitário no alto de um penhasco, ao amanhecer.',
}], db);

const cena = getProductionScene(projectId, 1, db);
ok(Boolean(getProject(projectId, db)), 'o projeto existe');
ok(cena?.durationSeconds === DURACAO_DA_CENA,
  `a cena 1 tem duração NARRATIVA de ${DURACAO_DA_CENA}s`);

// ── 2 · a geração ─────────────────────────────────────────────────────────
console.log('\n2. a imagem da cena 1, pela ferramenta de produção:');
const thread = createThreadRecord({ projectId, title: 'Smoke 13-E' }, db);
const saida = await generateSceneImageTool.execute(
  { threadId: thread.id, projectId, userMessageId: null, signal: null },
  {
    ordinal: 1,
    prompt: 'Um farol solitário no alto de um penhasco ao amanhecer, névoa baixa, '
      + 'luz fria, plano geral.',
  },
  // Sem acompanhamento: quem leva a geração ao fim aqui é este script, pelo
  // mesmo caminho que a tela usa.
  { acompanhar: () => {} },
);
console.log(`   resultado público: ${JSON.stringify(saida)}`);
ok(!JSON.stringify(saida).includes(ASPECTO), 'o formato NÃO sai no resultado público');

const take = listSceneTakes(projectId, 1, 'image', db)[0];
ok(Boolean(take?.generationJobId), 'o take nasceu ligado à geração');

console.log('   esperando a imagem...');
const limite = Date.now() + 8 * 60 * 1000;
let estado = null;
while (Date.now() < limite) {
  estado = await getGenerationJob(take.generationJobId, { projectId, db });
  const linha = listSceneTakes(projectId, 1, 'image', db)[0];
  process.stdout.write(`\r   ${String(estado.status).padEnd(14)} · asset: ${linha?.assetId ? 'sim' : 'não '}   `);
  if (linha?.assetId) break;
  if (['failed', 'cancelled', 'orphaned'].includes(estado.status)) break;
  await new Promise((r) => setTimeout(r, 4000));
}
console.log(`\n   estado final: ${estado?.status}`);

const final = listSceneTakes(projectId, 1, 'image', db)[0];
const asset = final?.assetId ? getAsset(final.assetId, db) : null;
ok(Boolean(asset), 'a imagem concluiu e o take recebeu o Asset');
ok(getSceneSelection(projectId, 1, 'image', db)?.id === final?.id,
  'e virou a imagem escolhida da cena');

// ── 3 · o grafo submetido ─────────────────────────────────────────────────
console.log('\n3. o grafo que foi realmente submetido:');
const promptId = getGenerationJobRecord(take.generationJobId, db)?.providerJobId;
console.log(`   promptId: ${promptId}`);

if (promptId) {
  const historico = await (await fetch(`${COMFY_BASE_URL}/history/${promptId}`)).json();
  const grafo = historico?.[promptId]?.prompt?.[2];
  ok(Boolean(grafo), 'o ComfyUI guardou o grafo');

  if (grafo) {
    const { nodeIds } = getWorkflow('ideogram4_t2i');
    const seletor = grafo[nodeIds.resolution]?.inputs?.aspect_ratio;
    console.log(`   ResolutionSelector.aspect_ratio = ${JSON.stringify(seletor)}`);
    console.log(`   traduzido de volta:              ${aspectFromSelector(seletor)}`);

    ok(aspectFromSelector(seletor) === ASPECTO,
      `o grafo pediu ${ASPECTO} — o formato do PLANO`);
    ok(aspectFromSelector(seletor) !== '16:9' || ASPECTO === '16:9',
      'e não caiu para 16:9');
  }
}

// ── 4 · os bytes ──────────────────────────────────────────────────────────
console.log('\n4. o arquivo que saiu:');
if (asset?.filename) {
  const caminho = path.join(
    process.cwd(), 'runtime', 'projects', projectId, 'images', asset.filename,
  );
  const dim = await dimensoesDoPng(caminho);
  console.log(`   ${asset.filename} · ${dim?.largura}×${dim?.altura}`);

  const [w, h] = ASPECTO.split(':').map(Number);
  const proporcaoPedida = w / h;
  const proporcaoReal = dim ? dim.largura / dim.altura : null;
  console.log(`   proporção pedida: ${proporcaoPedida.toFixed(3)} · real: ${proporcaoReal?.toFixed(3)}`);

  ok(Boolean(dim), 'o arquivo é um PNG legível');
  ok(
    dim !== null && Math.abs(proporcaoReal - proporcaoPedida) < 0.05,
    'os pixels do arquivo têm a proporção da produção',
  );
  ok(
    proporcaoPedida < 1 ? dim.altura > dim.largura : true,
    'uma produção vertical produziu um arquivo vertical',
  );
}

// ── 5 · a duração narrativa não virou duração de clipe ────────────────────
console.log('\n5. duração:');
console.log(`   Production Scene.durationSeconds = ${cena.durationSeconds}  (narrativa)`);
const meta = getGenerationJobRecord(take.generationJobId, db);
console.log(`   a geração de IMAGEM não tem duração — kind=${meta.kind}`);
ok(
  db.prepare('SELECT durationSeconds FROM assets WHERE id = ?').get(asset?.id ?? '')
    ?.durationSeconds == null,
  'o Asset de imagem não ganhou duração vinda da cena',
);
ok(cena.durationSeconds === DURACAO_DA_CENA,
  'e a cena continua dizendo o que a cena dura');

console.log(`\n${falhas === 0 ? 'SMOKE OK' : `SMOKE COM ${falhas} FALHA(S)`}`);
console.log(`\nprojeto do smoke: ${projectId}`);
process.exit(falhas === 0 ? 0 : 1);
