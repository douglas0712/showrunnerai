// Revisão de pre-commit do Passo 3: integridade do que é publicado.
//
// O caso concreto que originou este arquivo: bytes WebM copiados com o nome
// `.mp4` passavam em toda a validação e eram servidos como `video/mp4`. Não há
// transcodificação em lugar nenhum do pipeline — o arquivo é copiado do
// ComfyUI e renomeado —, então a única defesa possível é recusar publicar o
// que não pode ser servido honestamente.
//
// O princípio que estes testes protegem: extensão e MIME publicados precisam
// corresponder aos bytes reais.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { descriptorForJob, isLegacyJob, validarImagem, validarMidia, validarMp4 } from '../lib/server/comfy/provider.js';
import { UnknownWorkflowError } from '../lib/server/generation/workflows/registry.js';
import { minimaxH3T2V } from '../lib/server/generation/workflows/minimaxH3.js';
import { extensionsFor, isStorableExtension } from '../lib/server/generation/mediaKinds.js';
import { ffmpegAvailable } from '../lib/server/export/ffmpeg.js';

const execFileAsync = promisify(execFile);
const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-integridade-'));
test.after(() => rm(RAIZ, { recursive: true, force: true }));

const ffmpeg = await ffmpegAvailable();

async function gerarVideo(nome, args) {
  const destino = path.join(RAIZ, nome);
  await execFileAsync('/usr/bin/ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=10:duration=1',
    ...args, '-y', destino,
  ]);
  return destino;
}

// ── 1. contêiner de vídeo × extensão publicada ──────────────────────────────

test('não existe transcodificação: a extensão precisa bater com os bytes', { skip: !ffmpeg.ok }, async () => {
  const mp4 = await gerarVideo('real.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const webm = await gerarVideo('real.webm', ['-c:v', 'libvpx']);

  // Um MP4 de verdade passa.
  const bom = await validarMp4(mp4);
  assert.equal(bom.ok, true, bom.motivo);
  assert.match(bom.probe.formatName, /mp4/);

  // Os MESMOS bytes WebM, com o nome .mp4, são recusados — este é o caso que
  // antes passava e produzia um arquivo mentindo sobre o próprio conteúdo.
  const mentiroso = path.join(RAIZ, 'mentiroso.mp4');
  await writeFile(mentiroso, await readFile(webm));

  const ruim = await validarMp4(mentiroso);
  assert.equal(ruim.ok, false, 'WebM renomeado para .mp4 foi aceito');
  assert.match(ruim.motivo, /contêiner/i);
  assert.match(ruim.probe.formatName, /webm|matroska/);
});

test('o contêiner real chega ao probe', { skip: !ffmpeg.ok }, async () => {
  const mp4 = await gerarVideo('probe.mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  const { probe } = await validarMp4(mp4);
  assert.equal(typeof probe.formatName, 'string');
  assert.ok(probe.formatName.length > 0, 'formatName precisa vir preenchido');
});

test('só extensões servíveis podem ser publicadas', () => {
  // Vídeo é descoberto em vários contêineres, mas só um é publicável.
  assert.deepEqual(extensionsFor('video'), ['.mp4']);
  for (const ext of ['.webm', '.mkv', '.mov', '.m4v']) {
    assert.equal(isStorableExtension('video', `x${ext}`), false, `${ext} virou publicável`);
  }
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    assert.equal(isStorableExtension('image', `x${ext}`), true);
  }
  assert.equal(isStorableExtension('image', 'x.gif'), false);
});

test('o código de publicação recusa contêiner alheio em vez de renomear', async () => {
  const fonte = await readFile(new URL('../lib/server/comfy/provider.js', import.meta.url), 'utf8');

  // A regressão que este teste impede: voltar a cair na extensão padrão do
  // tipo quando a origem não é publicável.
  assert.ok(
    !/:\s*mediaKind\(kind\)\.defaultExtension/.test(fonte),
    'a extensão de destino voltou a ter fallback silencioso',
  );
  assert.match(fonte, /if \(!isStorableExtension\(kind, `x\$\{extensaoOrigem\}`\)\) \{/);
  assert.match(fonte, /CONTAINERS_MP4/);
});

// ── 2. jobs novos × jobs legados ────────────────────────────────────────────

test('job novo resolve pelo próprio workflowId, sem fallback', () => {
  const novo = { jobId: 'j1', workflowId: 'minimax_h3_t2v', kind: 'video' };
  assert.equal(descriptorForJob(novo), minimaxH3T2V);
  assert.equal(isLegacyJob(novo), false);
});

test('workflowId desconhecido é erro — nunca cai no padrão', () => {
  assert.throws(
    () => descriptorForJob({ jobId: 'j2', workflowId: 'nao_existe', kind: 'image' }),
    UnknownWorkflowError,
    'um id desconhecido caiu silenciosamente no workflow de vídeo',
  );
});

test('job legado, sem os campos, ainda resolve para o único workflow que existia', () => {
  const legado = { jobId: 'j3', promptId: 'p3' };
  assert.equal(descriptorForJob(legado), minimaxH3T2V);
  assert.equal(descriptorForJob(legado).kind, 'video');
  assert.equal(isLegacyJob(legado), true);
  // Meio legado — um campo só — também conta como legado.
  assert.equal(isLegacyJob({ workflowId: 'minimax_h3_t2v' }), true);
  assert.equal(isLegacyJob({ kind: 'video' }), true);
});

test('a API normal nunca produz job sem workflowId e kind', async () => {
  // submitGeneration cria o job ANTES de falar com o ComfyUI. Apontando o
  // COMFY_URL para uma porta morta, a submissão falha mas o job já nasceu —
  // é o caminho real do código, não uma simulação.
  const script = `
    import { submitGeneration, newJobId } from './lib/server/comfy/provider.js';
    import { getJob } from './lib/server/comfy/jobs.js';

    const jobId = newJobId();
    try {
      await submitGeneration({
        jobId, prompt: 'teste', durationSeconds: 5.2, aspect: '16:9',
        quality: '480p', fps: 24, projectId: 'proj_teste',
      });
    } catch { /* a submissão falha: não há ComfyUI nesta porta */ }

    const job = getJob(jobId);
    process.stdout.write(JSON.stringify({
      existe: Boolean(job),
      workflowId: job?.workflowId ?? null,
      kind: job?.kind ?? null,
    }));
  `;

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, COMFY_URL: 'http://127.0.0.1:9' },
    cwd: process.cwd(),
  });

  const job = JSON.parse(stdout);
  assert.equal(job.existe, true, 'o job precisa ter sido criado antes da submissão');
  assert.equal(job.workflowId, 'minimax_h3_t2v', 'workflowId veio do descriptor');
  assert.equal(job.kind, 'video', 'kind veio do descriptor');
});

// ── 3. validação de imagem pelos bytes ──────────────────────────────────────

/** PNG mínimo válido: assinatura + IHDR. */
const PNG_REAL = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
]);
/** JPEG: SOI + marcador APP0. */
const JPEG_REAL = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46,
  0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
]);
/** WebP: contêiner RIFF com a marca WEBP nos bytes 8–11. */
const WEBP_REAL = Buffer.concat([
  Buffer.from('RIFF'), Buffer.from([0x1a, 0x00, 0x00, 0x00]),
  Buffer.from('WEBPVP8 '), Buffer.alloc(8),
]);

async function arquivo(nome, conteudo) {
  const destino = path.join(RAIZ, nome);
  await writeFile(destino, conteudo);
  return destino;
}

test('PNG real é aceito', async () => {
  const r = await validarImagem(await arquivo('ok.png', PNG_REAL));
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.probe.mime, 'image/png');
});

test('JPEG real é aceito', async () => {
  const r = await validarImagem(await arquivo('ok.jpg', JPEG_REAL));
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.probe.mime, 'image/jpeg');
});

test('WEBP real é aceito — o contêiner RIFF é conferido nos bytes', async () => {
  const r = await validarImagem(await arquivo('ok.webp', WEBP_REAL));
  assert.equal(r.ok, true, r.motivo);
  assert.equal(r.probe.mime, 'image/webp');
});

test('arquivo inválido com extensão .png é RECUSADO', async () => {
  const impostores = [
    ['texto.png', Buffer.from('isto é um arquivo de texto, não uma imagem')],
    ['html.png', Buffer.from('<!doctype html><html><body>oi</body></html>')],
    ['vazio.png', Buffer.alloc(0)],
    ['curto.png', Buffer.from([0x89, 0x50])],
    ['quase.png', Buffer.from([0x89, 0x50, 0x4e, 0x46, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])],
    ['riff-nao-webp.webp', Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('AVI '), Buffer.alloc(8)])],
  ];

  for (const [nome, bytes] of impostores) {
    const r = await validarImagem(await arquivo(nome, bytes));
    assert.equal(r.ok, false, `aceitou impostor: ${nome}`);
    assert.ok(r.motivo.length > 0);
  }
});

test('a extensão do NOME não influencia a validação — só os bytes', async () => {
  // PNG de verdade com nome .jpg continua sendo reconhecido como PNG.
  const r = await validarImagem(await arquivo('mentira.jpg', PNG_REAL));
  assert.equal(r.ok, true);
  assert.equal(r.probe.mime, 'image/png', 'a decisão veio dos bytes, não do nome');
});

test('validarMidia despacha por kind e recusa kind desconhecido', async () => {
  const png = await arquivo('despacho.png', PNG_REAL);
  assert.equal((await validarMidia('image', png)).ok, true);
  // Um PNG submetido como vídeo não passa: o ffprobe não acha fluxo de vídeo.
  assert.equal((await validarMidia('video', png)).ok, false);
  assert.equal((await validarMidia('audio', png)).ok, false);
  assert.equal((await validarMidia('', png)).ok, false);
});

test('arquivo inexistente não derruba a validação', async () => {
  const r = await validarImagem(path.join(RAIZ, 'nao_existe.png'));
  assert.equal(r.ok, false);
  assert.match(r.motivo, /não foi possível ler/i);
});

// ── 4. recuperação ──────────────────────────────────────────────────────────

test('a recuperação é dirigida por descriptor, não pelo nome do modelo', async () => {
  const fonte = await readFile(new URL('../lib/server/comfy/provider.js', import.meta.url), 'utf8');
  const corpo = fonte.slice(fonte.indexOf('export async function recoverFromHistory'));
  const recuperacao = corpo.slice(0, corpo.indexOf('\nfunction projectIdFromExisting'));

  // Tudo que a recuperação usa vem do descriptor resolvido pelo workflowId.
  assert.match(recuperacao, /const descriptor = getWorkflow\(workflowId\)/);
  assert.match(recuperacao, /kind: descriptor\.kind/);
  assert.match(recuperacao, /saveNodeId: descriptor\.nodeIds\.save/);
  assert.match(recuperacao, /prefix: descriptor\.outputPrefix/);
  assert.match(recuperacao, /workflowId: descriptor\.id/);
  assert.match(recuperacao, /descriptor\.metaFromGraph/);

  // E nada nela decide por nome de modelo.
  const semComentarios = recuperacao
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/minimax|ideogram/i.test(semComentarios), 'a recuperação cita um modelo');
});

test('o job adotado pela recuperação nasce com workflowId e kind', async () => {
  const fonte = await readFile(new URL('../lib/server/comfy/provider.js', import.meta.url), 'utf8');
  const criacao = fonte.slice(fonte.indexOf('      createJob({\n        ...meta,'));
  assert.match(criacao.slice(0, 400), /workflowId: descriptor\.id/);
  assert.match(criacao.slice(0, 400), /kind: descriptor\.kind/);
});

// ── 5. bytes ↔ extensão final ↔ MIME servido ────────────────────────────────
//
// O caso que originou esta seção: o ComfyUI devolveu `resultado.jpg` com bytes
// PNG. A validação reconhecia PNG e aprovava, mas a publicação usava a
// extensão DECLARADA — o arquivo saía como `.jpg` e era servido como
// `image/jpeg` sobre bytes PNG.
//
// A política agora é declarada por tipo em mediaKinds.js: imagem publica pelo
// formato detectado nos bytes; vídeo publica pela extensão declarada, já
// restrita a MP4, porque normalizar contêiner exigiria transcodificar.

import { extensaoParaPublicar } from '../lib/server/comfy/provider.js';
import {
  canonicalExtensionFor, extensionSourceFor, mimeFor as mimeDe, MediaKindError as ErroDeTipo,
} from '../lib/server/generation/mediaKinds.js';
import { mediaTempPath as tempDe, publishMediaFile as publicar } from '../lib/server/comfy/storage.js';

/** Percorre o caminho real: grava o temporário, valida, decide extensão, publica. */
async function publicarComoOPipelineFaz(bytes, extensaoDeclarada, jobId) {
  const temp = await tempDe('image', 'proj_pub', jobId, extensaoDeclarada, RAIZ);
  await writeFile(temp, bytes);

  const validacao = await validarMidia('image', temp);
  if (!validacao.ok) {
    // O pipeline real descarta o temporário quando a validação recusa.
    const { rm: remover } = await import('node:fs/promises');
    await remover(temp, { force: true });
    return { recusado: true, motivo: validacao.motivo };
  }

  const extensaoFinal = extensaoParaPublicar('image', extensaoDeclarada, validacao);
  const publicado = await publicar('image', 'proj_pub', jobId, temp, extensaoFinal, RAIZ);

  return {
    recusado: false,
    mimeDosBytes: validacao.probe.mime,
    filename: publicado.filename,
    url: publicado.url,
    mimeServido: mimeDe('image', publicado.filename),
  };
}

test('5.1 PNG chamado .jpg é publicado como .png e servido como image/png', async () => {
  const r = await publicarComoOPipelineFaz(PNG_REAL, '.jpg', 'p_png');
  assert.equal(r.recusado, false);
  assert.equal(r.mimeDosBytes, 'image/png');
  assert.equal(r.filename, 'p_png.png');
  assert.equal(r.mimeServido, 'image/png');
  assert.equal(r.url, '/api/media/image/proj_pub/p_png.png');
});

test('5.2 JPEG chamado .png é publicado como .jpg e servido como image/jpeg', async () => {
  const r = await publicarComoOPipelineFaz(JPEG_REAL, '.png', 'p_jpg');
  assert.equal(r.recusado, false);
  assert.equal(r.mimeDosBytes, 'image/jpeg');
  assert.equal(r.filename, 'p_jpg.jpg');
  assert.equal(r.mimeServido, 'image/jpeg');
});

test('5.3 WEBP chamado .png é publicado como .webp e servido como image/webp', async () => {
  const r = await publicarComoOPipelineFaz(WEBP_REAL, '.png', 'p_webp');
  assert.equal(r.recusado, false);
  assert.equal(r.mimeDosBytes, 'image/webp');
  assert.equal(r.filename, 'p_webp.webp');
  assert.equal(r.mimeServido, 'image/webp');
});

test('5.4 arquivo inválido chamado .png continua recusado, sem publicar nada', async () => {
  const r = await publicarComoOPipelineFaz(Buffer.from('isto é texto puro'), '.png', 'p_ruim');
  assert.equal(r.recusado, true);
  assert.ok(r.motivo.length > 0);

  const { readdir } = await import('node:fs/promises');
  const gravados = await readdir(path.join(RAIZ, 'proj_pub', 'images'));
  // Nem publicado, nem temporário deixado para trás.
  assert.ok(!gravados.includes('p_ruim.png'), 'um arquivo inválido foi publicado');
  assert.ok(!gravados.some((f) => f.startsWith('p_ruim')), `sobrou lixo: ${gravados.filter((f) => f.startsWith('p_ruim'))}`);
});

test('5.5 extensão final e MIME servido sempre correspondem aos bytes', async () => {
  const casos = [
    [PNG_REAL, 'image/png', '.png'],
    [JPEG_REAL, 'image/jpeg', '.jpg'],
    [WEBP_REAL, 'image/webp', '.webp'],
  ];

  // Toda combinação de bytes × extensão declarada precisa convergir.
  let n = 0;
  for (const [bytes, mimeEsperado, extEsperada] of casos) {
    for (const declarada of ['.png', '.jpg', '.jpeg', '.webp']) {
      n += 1;
      const r = await publicarComoOPipelineFaz(bytes, declarada, `matriz_${n}`);
      assert.equal(r.recusado, false);
      assert.equal(r.mimeDosBytes, mimeEsperado);
      assert.ok(r.filename.endsWith(extEsperada), `${declarada} → ${r.filename}, esperado ${extEsperada}`);
      assert.equal(r.mimeServido, mimeEsperado,
        `bytes ${mimeEsperado} declarados ${declarada} foram servidos como ${r.mimeServido}`);
    }
  }
  assert.equal(n, 12, 'a matriz precisa cobrir 3 formatos × 4 extensões declaradas');
});

test('5.6 a política de extensão é do tipo, e o vídeo não normaliza', () => {
  assert.equal(extensionSourceFor('image'), 'bytes');
  assert.equal(extensionSourceFor('video'), 'declared');

  // Vídeo mantém a declarada mesmo com um probe presente — não transcodificamos.
  assert.equal(
    extensaoParaPublicar('video', '.mp4', { ok: true, probe: { formatName: 'mov,mp4' } }),
    '.mp4',
  );

  // Imagem sempre converge para a extensão canônica do formato detectado.
  for (const [detectado, esperada] of [['png', '.png'], ['jpg', '.jpg'], ['webp', '.webp']]) {
    assert.equal(extensaoParaPublicar('image', '.png', { ok: true, probe: { ext: detectado } }), esperada);
    assert.equal(canonicalExtensionFor('image', detectado), esperada);
  }

  // Um formato sem extensão publicável falha alto em vez de virar padrão.
  assert.throws(() => canonicalExtensionFor('image', 'gif'), ErroDeTipo);
  assert.throws(() => canonicalExtensionFor('image', 'bmp'), ErroDeTipo);
});

test('6. nenhum caller escolhe extensão final arbitrariamente', async () => {
  // Camada 1 — o armazenamento recusa qualquer extensão não servível, venha
  // de onde vier.
  const temp = await tempDe('image', 'proj_pub', 'guarda', '.png', RAIZ);
  await writeFile(temp, PNG_REAL);
  for (const ruim of ['.exe', '.txt', '.gif', '.mp4', '.svg']) {
    await assert.rejects(
      () => publicar('image', 'proj_pub', 'guarda', temp, ruim, RAIZ),
      { name: 'PathValidationError' },
      `publicou com extensão ${ruim}`,
    );
  }

  // E omitir a extensão não cai num padrão silencioso — foi assim que bytes
  // PNG acabaram sob `.jpg`. Agora é erro.
  for (const ausente of ['', null, undefined]) {
    await assert.rejects(
      () => publicar('image', 'proj_pub', 'guarda', temp, ausente, RAIZ),
      { name: 'PathValidationError' },
      `publicou sem extensão (${JSON.stringify(ausente)})`,
    );
  }

  // Camada 2 — no caminho de produção a extensão nunca vem de um parâmetro:
  // é derivada da validação, dentro do próprio módulo.
  const fonte = await readFile(new URL('../lib/server/comfy/provider.js', import.meta.url), 'utf8');
  assert.match(fonte, /const extensaoFinal = extensaoParaPublicar\(kind, extensao, validacao\);/);
  assert.match(fonte, /publishMediaFile\(kind, projectId, jobId, temporario, extensaoFinal\)/);
  assert.ok(
    !/publishMediaFile\([^)]*,\s*extensao\s*\)/.test(fonte),
    'a publicação voltou a usar a extensão declarada',
  );

  // Camada 3 — nenhuma rota DECIDE extensão de mídia. A rota de geração cita
  // "extensão" apenas numa mensagem que diz não confiar nela para os quadros
  // de entrada; o que não pode existir é a rota escolhendo o nome do arquivo
  // de saída ou chamando o armazenamento.
  const rota = await readFile(
    new URL('../app/api/comfy/generate/route.js', import.meta.url), 'utf8',
  );
  assert.ok(!/publishMediaFile|mediaTempPath|publishVideoFile|videoTempPath/.test(rota),
    'a rota chama o armazenamento diretamente');
  assert.ok(!/extensa[oã]|extension\s*[:=]/i.test(rota), 'a rota decide uma extensão');
  assert.ok(!/storage/.test(rota), 'a rota importa o armazenamento');
});
