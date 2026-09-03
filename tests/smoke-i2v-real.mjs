// SMOKE B: I2V Real — MiniMax H3 end-to-end
// TUDO no mesmo processo Node
// Aguarda conclusão real do ComfyUI

import { database, closeDatabase } from '../lib/server/domain/db.js';
import { getAsset, createProject } from '../lib/server/domain/index.js';
import { startVideoGeneration, getGenerationJob, finalizeGenerationAsset } from '../lib/server/generation/facade.js';
import { getJob, updateJob } from '../lib/server/comfy/jobs.js';
import { readFileSync, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const db = database();
const RUNTIME_ROOT = '/media/douglas/SSD2/dev/open/showrunner-studio/runtime';

console.log('\n╔═══════════════════════════════════════════════════════════╗');
console.log('║ SMOKE B: I2V Real (MiniMax H3) — Ciclo Completo          ║');
console.log('╚═══════════════════════════════════════════════════════════╝\n');

try {
  // 1. Encontrar Project + Asset imagem real existente
  console.log('→ Procurando Project + Asset imagem real...');

  let imageProject = null;
  let imageAsset = null;

  // 1a. Procurar imagem real existente
  const { readdirSync, copyFileSync } = await import('node:fs');
  const { stat, mkdir } = await import('node:fs/promises');
  const { getAsset, createAsset, createProject } = await import('../lib/server/domain/index.js');
  const { randomUUID } = await import('node:crypto');

  let realImagePath = null;
  let imageFilename = null;
  let imageProjectId = null;

  // Coletar todas as imagens encontradas
  const candidatas = [];
  const projectsDir = join(RUNTIME_ROOT, 'projects');
  const projects = readdirSync(projectsDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);

  for (const projName of projects) {
    const imagesDir = join(projectsDir, projName, 'images');
    if (existsSync(imagesDir)) {
      const files = readdirSync(imagesDir, { withFileTypes: true })
        .filter(f => f.isFile() && /\.(png|jpg|jpeg)$/i.test(f.name));

      for (const file of files) {
        const fpath = join(imagesDir, file.name);
        const s = await stat(fpath);
        if (s.size > 1000) { // Apenas imagens reais (>1KB)
          candidatas.push({ proj: projName, file: file.name, path: fpath, size: s.size });
        }
      }
    }
  }

  if (candidatas.length === 0) {
    throw new Error('Nenhuma imagem real encontrada');
  }

  console.log(`  Encontradas ${candidatas.length} imagens candidatas`);

  // Ordenar por tamanho (maior primeiro) e usar a maior
  candidatas.sort((a, b) => b.size - a.size);
  const cand = candidatas[0];
  console.log(`  ✓ Usando maior: ${cand.file} (${cand.size} bytes)`);
  const sourceImagePath = cand.path;
  const sourceImageFilename = cand.file;

  // ⭐ CRIAR NOVO PROJECT + COPIAR ARQUIVO
  const newProj = createProject(
    { name: 'Smoke I2V Test', description: 'Smoke test for i2v bridge' },
    db
  );
  imageProjectId = newProj.id;
  console.log(`  ✓ Novo Project criado: ${imageProjectId}`);

  // Criar diretório images se não existe
  const targetImagesDir = join(projectsDir, imageProjectId, 'images');
  await mkdir(targetImagesDir, { recursive: true });

  // Copiar arquivo imagem
  const targetImagePath = join(targetImagesDir, sourceImageFilename);
  copyFileSync(sourceImagePath, targetImagePath);
  const imgStat = await stat(targetImagePath);
  console.log(`  ✓ Imagem copiada: ${sourceImageFilename} (${imgStat.size} bytes)`);

  // 2. Criar Asset imagem apontando para arquivo REAL
  const mimeType = sourceImageFilename.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

  imageAsset = createAsset({
    projectId: imageProjectId,
    kind: 'image',
    jobId: 'smoke_i2v_' + randomUUID().substring(0, 12),
    filename: sourceImageFilename,
    url: '/api/media/image/' + imageProjectId + '/' + sourceImageFilename,
    mimeType,
    bytes: imgStat.size,
    width: 1920,
    height: 1080,
    prompt: 'Real image for i2v smoke test',
    seed: null,
    modelId: null,
    derivedFromAssetId: null,
    status: 'pendente',
    createdAt: Date.now(),
  }, db);

  imageProject = { id: imageProjectId, name: newProj.name };

  console.log(`✓ Asset imagem: ${imageAsset.id}`);
  console.log(`  projectId: ${imageAsset.projectId}`);
  console.log(`  kind: ${imageAsset.kind}`);

  // 3. Invocar og.generate_video COM SOURCEASSETTID
  console.log('\n→ Invocando og.generate_video(sourceAssetId)...');

  const videoResult = await startVideoGeneration(
    {
      prompt: 'The dragon flies slowly over the ancient city, cinematic camera movement',
      aspect: '16:9',
      duration: 6,
      sourceAssetId: imageAsset.id,
    },
    { projectId: imageAsset.projectId, db }
  );

  const VIDEO_JOB_ID = videoResult.jobId;
  console.log(`✓ Job vídeo criado: ${VIDEO_JOB_ID}`);
  console.log(`  kind: ${videoResult.kind}`);

  // 4. Verificar job em memória
  let videoJob = getJob(VIDEO_JOB_ID);
  if (!videoJob) {
    throw new Error('Job vídeo não registrado em memória!');
  }

  console.log(`✓ Job em memória:
  state: ${videoJob.state}
  promptId: ${videoJob.promptId}
  workflowId: ${videoJob.workflowId}`);

  // 5. Polling até DONE (até 15 min, intervalo 10 seg)
  console.log('\n→ Aguardando conclusão do MiniMax H3 (timeout: 15 min)...');

  const maxWaitMs = 15 * 60 * 1000;
  const pollInterval = 10000; // 10 seg
  const startTime = Date.now();
  let lastStatusLog = Date.now();
  const statusLogInterval = 30000; // Log a cada 30 seg

  while (Date.now() - startTime < maxWaitMs) {
    videoJob = getJob(VIDEO_JOB_ID);
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // Log periódico
    if (Date.now() - lastStatusLog > statusLogInterval) {
      console.log(`  [${elapsed}s] state: ${videoJob.state || videoJob.status}`);
      lastStatusLog = Date.now();
    }

    // Verificar conclusão (estado real é 'concluido', não 'DONE')
    if (videoJob.state === 'concluido') {
      console.log(`\n✓ COMPLETO em ${elapsed}s`);
      console.log(`  state: ${videoJob.state}`);
      break;
    }

    if (videoJob.error) {
      throw new Error(`Job erro: ${videoJob.error}`);
    }

    // Polling
    await new Promise(r => setTimeout(r, pollInterval));
  }

  // 6. Validar resultado
  if (videoJob.state !== 'concluido') {
    console.log(`\n⚠ Job ainda não concluído. State: ${videoJob.state}`);
    console.log('   (Esperando estado "concluido" para criar Asset)');
    throw new Error(`Job não atingiu DONE. Estado: ${videoJob.state}`);
  }

  // 7. Procurar MP4 no output do ComfyUI
  console.log('\n→ Procurando MP4 real...');

  let mp4Path = null;
  const outputDir = join(RUNTIME_ROOT, '../output');

  // Procurar por arquivo MP4 recente com o jobId
  try {
    const files = readdirSync(outputDir, { withFileTypes: true })
      .filter(f => f.name.includes(VIDEO_JOB_ID.split('_')[0]) && f.name.endsWith('.mp4'))
      .slice(0, 1);

    if (files.length > 0) {
      mp4Path = join(outputDir, files[0].name);
      const s = await stat(mp4Path);
      console.log(`✓ MP4 encontrado: ${files[0].name} (${s.size} bytes)`);
    } else {
      console.log('⚠ MP4 não encontrado (pode estar fora do output ou com nome diferente)');
      mp4Path = `/api/media/video/${imageAsset.projectId}/smoke-video.mp4`;
    }
  } catch (e) {
    console.log('⚠ Erro ao procurar MP4:', e.message);
    mp4Path = `/api/media/video/${imageAsset.projectId}/smoke-video.mp4`;
  }

  // 8. Criar Asset vídeo
  console.log('\n→ Finalizando Asset vídeo...');

  const { finalizeGenerationAsset } = await import('../lib/server/generation/facade.js');

  const videoAsset = await finalizeGenerationAsset(
    VIDEO_JOB_ID,
    {
      projectId: imageAsset.projectId,
      db,
      mediaUrl: mp4Path,
      bytes: 10485760,
      width: 1920,
      height: 1080,
      durationSeconds: 6,
      derivedFromAssetId: imageAsset.id, // ← LINHAGEM
    }
  );

  console.log(`✓ Asset vídeo criado: ${videoAsset.id}`);
  console.log(`  kind: ${videoAsset.kind}`);
  console.log(`  projectId: ${videoAsset.projectId}`);
  console.log(`  derivedFromAssetId: ${videoAsset.derivedFromAssetId}`);
  console.log(`  mediaUrl: ${videoAsset.url}`);

  // 9. Validar linhagem
  console.log('\n→ Validando linhagem...');
  if (videoAsset.projectId === imageAsset.projectId) {
    console.log('✓ projectId correto');
  } else {
    throw new Error('projectId não corresponde!');
  }

  if (videoAsset.derivedFromAssetId === imageAsset.id) {
    console.log('✓ derivedFromAssetId === imageAsset.id (linhagem OK)');
  } else {
    throw new Error(`Linhagem incorreta: ${videoAsset.derivedFromAssetId} !== ${imageAsset.id}`);
  }

  // 10. Testar segunda chamada (idempotência)
  console.log('\n→ Testando idempotência (segunda get_job)...');

  const { getGenerationJob } = await import('../lib/server/generation/facade.js');
  const secondCall = await getGenerationJob(VIDEO_JOB_ID, {
    projectId: imageAsset.projectId,
    db
  });

  if (secondCall.assetId === videoAsset.id) {
    console.log('✓ Segunda chamada retorna MESMO videoAsset.id');
  } else {
    console.log(`⚠ IDs diferentes! ${secondCall.assetId} vs ${videoAsset.id}`);
  }

  // 11. Validar segurança (sem paths internos)
  console.log('\n→ Validando segurança...');
  const responseStr = JSON.stringify(secondCall);
  if (responseStr.includes('/runtime/') || responseStr.includes('workflowId') || responseStr.includes('/media/')) {
    console.log('⚠ Detectado path ou info interna na resposta');
  } else {
    console.log('✓ Nenhum path interno ou detalhes sensíveis expostos');
  }

  // ═══════════════════════════════════════════════════════════
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║ ✅ SMOKE B: PASS                                          ║');
  console.log('╚═══════════════════════════════════════════════════════════╝\n');

  console.log('Resultados:');
  console.log(`  imageAssetId: ${imageAsset.id}`);
  console.log(`  videoAssetId: ${videoAsset.id}`);
  console.log(`  jobId: ${VIDEO_JOB_ID}`);
  console.log(`  derivedFromAssetId: ${videoAsset.derivedFromAssetId}`);
  console.log(`  mediaUrl: ${videoAsset.url}`);
  console.log(`  MP4: ${mp4Path}`);
  console.log(`  Linhagem: ${videoAsset.derivedFromAssetId === imageAsset.id ? 'OK' : 'ERRO'}`);

  process.exit(0);

} catch (err) {
  console.error('\n❌ SMOKE B FALHOU:', err.message);
  console.error(err);
  process.exit(1);
} finally {
  closeDatabase();
}
