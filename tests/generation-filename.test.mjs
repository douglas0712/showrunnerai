// O nome do arquivo no Asset finalizado.
//
// ── Por que isto é um contrato, e não um detalhe ────────────────────────────
//
// O Asset é a forma como um arquivo publicado existe para o resto da aplicação.
// Sem `filename` ele é um registro que aponta para lugar nenhum: `mediaUrl`
// serve para exibir, mas quem precisa dos BYTES — a ponte i2v do PASSO 6.1 —
// resolve o caminho a partir de `filename`, não da URL.
//
// E a falha era silenciosa. Em `startVideoGeneration` a ponte inteira está
// dentro de `if (sourceAsset.filename)`: com `null`, ela não dava erro, apenas
// não acontecia — e o vídeo saía como texto→vídeo, sem a imagem de origem, com
// o job relatando sucesso.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { getGenerationJob, finalizeGenerationAsset } from '../lib/server/generation/facade.js';
import { createJob } from '../lib/server/comfy/jobs.js';
import { STATES } from '../lib/server/comfy/status.js';
import { openDatabase, DomainError } from '../lib/server/domain/db.js';
import {
  createProject, createAsset, findAssetByFile, findAssetsByJob, linkAssetToJob,
} from '../lib/server/domain/index.js';
import { resolveMediaPath } from '../lib/server/comfy/storage.js';

let n = 0;
const proximoJob = (p = 'cinema') => `${p}_fn_${Date.now()}_${n += 1}`;

function cenario({ kind = 'image', projectId = 'proj_fn', ext = null, extra = {} } = {}) {
  const db = openDatabase(':memory:');
  createProject({ id: projectId, name: 'Filename' }, db);

  const jobId = proximoJob();
  const extensao = ext ?? (kind === 'image' ? '.png' : '.mp4');
  const filename = `${jobId}${extensao}`;

  createJob({
    jobId,
    projectId,
    kind,
    state: STATES.DONE,
    promptId: null,
    result: {
      url: `/api/media/${kind}/${projectId}/${filename}`,
      filename,
      bytes: 1024,
    },
    ...extra,
  });

  return { db, jobId, projectId, filename };
}

// ── 1 · finalização normal ──────────────────────────────────────────────────

test('1. o Asset finalizado carrega o nome do arquivo publicado', async () => {
  const { db, jobId, projectId, filename } = cenario();
  const r = await getGenerationJob(jobId, { projectId, db });

  const asset = findAssetsByJob(jobId, db)[0];
  assert.ok(asset, 'o Asset deveria existir');
  assert.equal(asset.filename, filename, 'filename ficou nulo — a ponte i2v quebra');
  assert.equal(asset.id, r.assetId);
});

test('1-bis. filename, mediaUrl e mimeType descrevem o MESMO arquivo', async () => {
  for (const [kind, ext, mime] of [
    ['image', '.png', 'image/png'],
    ['image', '.webp', 'image/webp'],
    ['video', '.mp4', 'video/mp4'],
  ]) {
    const { db, jobId, projectId, filename } = cenario({ kind, ext });
    const r = await getGenerationJob(jobId, { projectId, db });
    const asset = findAssetsByJob(jobId, db)[0];

    assert.equal(asset.filename, filename);
    assert.equal(asset.mimeType, mime);
    assert.ok(r.mediaUrl.endsWith(filename), `${r.mediaUrl} não termina em ${filename}`);
    assert.ok(asset.filename.endsWith(ext));
  }
});

// ── 2 · idempotência ────────────────────────────────────────────────────────

test('2. a segunda finalização devolve o mesmo Asset, com o mesmo filename', async () => {
  const { db, jobId, projectId, filename } = cenario();

  const a = await getGenerationJob(jobId, { projectId, db });
  const b = await getGenerationJob(jobId, { projectId, db });

  assert.equal(b.assetId, a.assetId);
  assert.equal(findAssetsByJob(jobId, db).length, 1);
  assert.equal(findAssetByFile(projectId, filename, db).id, a.assetId);
});

// ── 3 · o backfill chegou primeiro ──────────────────────────────────────────

test('3. Asset já registrado pelo backfill é ADOTADO, não duplicado', async () => {
  // O backfill varre o disco e registra por arquivo. Se ele rodou antes, o
  // Asset já existe — e criar outro registraria duas vezes um arquivo que só
  // existe uma vez.
  const { db, jobId, projectId, filename } = cenario({ kind: 'video' });

  const doBackfill = createAsset({
    projectId, kind: 'video', jobId: null, filename,
    url: `/api/media/video/${projectId}/${filename}`,
    mimeType: 'video/mp4', status: 'pendente',
  }, db);
  assert.equal(doBackfill.jobId, null);

  const r = await getGenerationJob(jobId, { projectId, db });

  assert.equal(r.assetId, doBackfill.id, 'deveria ter adotado o Asset do backfill');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets WHERE projectId = ?')
    .get(projectId).n, 1, 'o arquivo foi registrado duas vezes');
  // E agora as duas identidades convergem.
  assert.equal(findAssetsByJob(jobId, db)[0].id, doBackfill.id);
});

test('3-bis. o backfill continua idempotente depois da adoção', async () => {
  const { db, jobId, projectId, filename } = cenario({ kind: 'video' });
  await getGenerationJob(jobId, { projectId, db });

  // É exatamente a checagem que backfillVideoAssets faz antes de criar.
  const existente = findAssetByFile(projectId, filename, db);
  assert.ok(existente, 'o backfill não reconheceria o arquivo e criaria duplicata');
  assert.equal(existente.jobId, jobId);
});

// ── 4 · mesmo nome, outro projeto ───────────────────────────────────────────

test('4. o mesmo nome de arquivo em OUTRO projeto não interfere', async () => {
  const { db, jobId, projectId, filename } = cenario();
  createProject({ id: 'proj_vizinho', name: 'Vizinho' }, db);

  const doVizinho = createAsset({
    projectId: 'proj_vizinho', kind: 'image', jobId: null, filename,
    url: `/api/media/image/proj_vizinho/${filename}`,
    mimeType: 'image/png', status: 'pendente',
  }, db);

  const r = await getGenerationJob(jobId, { projectId, db });

  assert.notEqual(r.assetId, doVizinho.id, 'adotou o Asset de outro projeto');
  assert.equal(findAssetsByJob(jobId, db)[0].projectId, projectId);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 2);
});

// ── 5 · conflito que NÃO é reconciliação ────────────────────────────────────

test('5. arquivo já pertencente a OUTRO job é erro, não sucesso silencioso', async () => {
  const { db, jobId, projectId, filename } = cenario();

  createAsset({
    projectId, kind: 'image', jobId: 'outro_job_qualquer', filename,
    url: `/api/media/image/${projectId}/${filename}`,
    mimeType: 'image/png', status: 'pendente',
  }, db);

  await assert.rejects(
    () => getGenerationJob(jobId, { projectId, db }),
    (erro) => {
      // Chega tipado, e não como sucesso com assetId de outra geração.
      assert.ok(['DomainError', 'GenerationError'].includes(erro.name), erro.name);
      return true;
    },
  );
});

test('5-bis. linkAssetToJob recusa roubar um Asset de outro job', () => {
  const { db, projectId, filename } = cenario();
  const alheio = createAsset({
    projectId, kind: 'image', jobId: 'job_do_outro', filename: `x_${filename}`,
    mimeType: 'image/png', status: 'pendente',
  }, db);

  assert.throws(() => linkAssetToJob(alheio.id, 'job_novo', db), DomainError);
  // E adotar com o MESMO job é inofensivo.
  assert.equal(linkAssetToJob(alheio.id, 'job_do_outro', db).id, alheio.id);
});

// ── 6 · o que realmente importa: o Asset é consumível pela ponte i2v ────────

test('6. o Asset criado por og.get_job é consumível como sourceAssetId (i2v)', async () => {
  // Prova a cadeia que o PASSO 6.1 depende, sem submeter nada ao ComfyUI:
  //
  //   og.get_job → Asset → filename → resolveMediaPath → readFile → firstFrame
  //
  // O arquivo é escrito no runtime real porque `resolveMediaPath` resolve
  // contra a raiz real; escrever noutro lugar provaria o caminho errado.
  const projectId = 'proj_i2v_teste';
  const db = openDatabase(':memory:');
  createProject({ id: projectId, name: 'i2v' }, db);

  const jobId = proximoJob();
  const filename = `${jobId}.png`;
  // PNG mínimo válido — a ponte confere os bytes, não a extensão.
  const PNG = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ]);

  const dir = path.join(process.cwd(), 'runtime', 'projects', projectId, 'images');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, filename), PNG);

  try {
    createJob({
      jobId, projectId, kind: 'image', state: STATES.DONE, promptId: null,
      result: { url: `/api/media/image/${projectId}/${filename}`, filename, bytes: PNG.length },
    });

    // 1 · o caminho de produção cria o Asset
    const r = await getGenerationJob(jobId, { projectId, db });
    const asset = findAssetsByJob(jobId, db)[0];
    assert.ok(r.assetId, 'sem Asset não há sourceAssetId');
    assert.ok(asset.filename, 'sem filename a ponte i2v é PULADA em silêncio');

    // 2 · a mesma resolução que startVideoGeneration faz
    const caminho = resolveMediaPath('image', asset.projectId, asset.filename);
    const bytes = await readFile(caminho);

    // 3 · o firstFrame que iria ao provider
    const firstFrame = {
      bytes,
      declaredType: asset.mimeType,
      declaredName: asset.filename,
    };

    assert.ok(firstFrame.bytes.length > 0, 'os bytes do Asset não foram lidos');
    assert.deepEqual([...firstFrame.bytes.subarray(0, 8)], [...PNG.subarray(0, 8)],
      'os bytes lidos não são os do arquivo publicado');
    assert.equal(firstFrame.declaredType, 'image/png');
    assert.equal(firstFrame.declaredName, filename);
  } finally {
    rmSync(path.join(process.cwd(), 'runtime', 'projects', projectId),
      { recursive: true, force: true });
  }
});

test('6-bis. sem filename a ponte i2v seria pulada — regressão que não pode voltar', async () => {
  // O guarda em startVideoGeneration é `if (sourceAsset.filename)`. Este teste
  // fixa a razão de o campo existir: um Asset sem nome de arquivo não falha,
  // ele degrada — e degradação silenciosa é o modo de falha mais caro aqui.
  const { db, jobId, projectId } = cenario();
  await getGenerationJob(jobId, { projectId, db });
  const asset = findAssetsByJob(jobId, db)[0];

  assert.notEqual(asset.filename, null);
  assert.doesNotThrow(() => resolveMediaPath('image', asset.projectId, asset.filename));
});

// ── 7 · vídeo ───────────────────────────────────────────────────────────────

test('7. vídeo preserva filename e a linhagem ao mesmo tempo', async () => {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_v_fn', name: 'Vídeo' }, db);

  const origem = createAsset({
    projectId: 'proj_v_fn', kind: 'image', jobId: 'job_origem_fn',
    filename: 'origem_fn.png', url: '/api/media/image/proj_v_fn/origem_fn.png',
    mimeType: 'image/png', status: 'pendente',
  }, db);

  const jobId = proximoJob();
  const filename = `${jobId}.mp4`;
  createJob({
    jobId, projectId: 'proj_v_fn', kind: 'video', state: STATES.DONE, promptId: null,
    derivedFromAssetId: origem.id,
    result: { url: `/api/media/video/proj_v_fn/${filename}`, filename, bytes: 4096 },
  });

  const r = await getGenerationJob(jobId, { projectId: 'proj_v_fn', db });
  const asset = findAssetsByJob(jobId, db)[0];

  assert.equal(asset.filename, filename);
  assert.equal(asset.mimeType, 'video/mp4');
  assert.equal(r.asset.derivedFromAssetId, origem.id);
});

// ── 8 · finalizeGenerationAsset direto mantém as mesmas garantias ───────────

test('8. chamar o finalizador direto produz o mesmo Asset, com filename', async () => {
  const { db, jobId, projectId, filename } = cenario();

  const a = await finalizeGenerationAsset(jobId, { projectId, db });
  const b = await finalizeGenerationAsset(jobId, { projectId, db });

  assert.equal(a.filename, filename);
  assert.equal(b.id, a.id);
  assert.equal(findAssetsByJob(jobId, db).length, 1);
});
