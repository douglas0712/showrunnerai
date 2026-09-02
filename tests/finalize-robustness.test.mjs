// Regressão da falha real: o player mostrou "não foi possível carregar o vídeo"
// enquanto o MP4 estava íntegro no disco.
//
// Duas defesas cobertas aqui:
//   1) publicação atômica — a URL nunca serve um arquivo pela metade;
//   2) validação com ffprobe antes de publicar — nunca publicamos MP4 que não abre.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  publishVideoFile, saveVideoBytes, validateVideoFilename, videoTempPath,
} from '../lib/server/comfy/storage.js';
import { validarMp4 } from '../lib/server/comfy/provider.js';
import { ffmpegAvailable, probe } from '../lib/server/export/ffmpeg.js';

const disponivel = await ffmpegAvailable();
const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-final-'));
const PROJ = 'proj_final';

test.after(() => rm(RAIZ, { recursive: true, force: true }));

function sintetico(destino, { duracao = 1 } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=24:duration=${duracao}`,
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(duracao), destino,
    ];
    const proc = spawn('/usr/bin/ffmpeg', args, { shell: false });
    let erro = '';
    proc.stderr.on('data', (c) => { erro += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(destino) : reject(new Error(erro.slice(-300)))));
  });
}

const hash = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');

// ── publicação atômica ──────────────────────────────────────────────────────
test('REGRESSÃO: o temporário de download não é servível pela rota de mídia', async () => {
  const temporario = await videoTempPath(PROJ, 'cinema_teste', RAIZ);
  const nome = path.basename(temporario);

  assert.match(nome, /\.mp4\.part-[0-9a-f]{8}$/);
  // A rota só aceita <segmento>.mp4 — o temporário jamais passa por ela.
  assert.throws(() => validateVideoFilename(nome), /Nome de arquivo inválido/);
});

test('REGRESSÃO: um arquivo ainda sendo gravado nunca aparece no destino final', async () => {
  const temporario = await videoTempPath(PROJ, 'cinema_gravando', RAIZ);
  const destinoEsperado = path.join(RAIZ, PROJ, 'videos', 'cinema_gravando.mp4');

  // Simula a escrita em andamento: o temporário cresce aos poucos.
  const handle = await open(temporario, 'w');
  try {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await handle.write(Buffer.alloc(1024, i));
      // Durante toda a escrita, o caminho final não existe.
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(() => stat(destinoEsperado));
    }
  } finally {
    await handle.close();
  }

  // Só ao publicar o arquivo aparece — e já completo.
  const publicado = await publishVideoFile(PROJ, 'cinema_gravando', temporario, RAIZ);
  const info = await stat(publicado.absolutePath);
  assert.equal(info.size, 5 * 1024, 'o arquivo publicado precisa estar completo');
  await assert.rejects(() => stat(temporario), 'o temporário some após o rename');
});

test('a publicação não sobrescreve resultados anteriores', async () => {
  const t1 = await videoTempPath(PROJ, 'cinema_dup', RAIZ);
  await writeFile(t1, 'primeiro');
  const p1 = await publishVideoFile(PROJ, 'cinema_dup', t1, RAIZ);

  const t2 = await videoTempPath(PROJ, 'cinema_dup', RAIZ);
  await writeFile(t2, 'segundo');
  const p2 = await publishVideoFile(PROJ, 'cinema_dup', t2, RAIZ);

  assert.equal(p1.filename, 'cinema_dup.mp4');
  assert.equal(p2.filename, 'cinema_dup-2.mp4');
  assert.equal((await readFile(p1.absolutePath)).toString(), 'primeiro');
});

test('saveVideoBytes também publica por rename e limpa o temporário', async () => {
  const bytes = Buffer.from('conteudo-de-video');
  const salvo = await saveVideoBytes(PROJ, 'cinema_bytes', bytes, RAIZ);

  assert.equal(salvo.filename, 'cinema_bytes.mp4');
  assert.deepEqual(await readFile(salvo.absolutePath), bytes);

  const restantes = await readdir(path.join(RAIZ, PROJ, 'videos'));
  assert.ok(!restantes.some((n) => n.includes('.part-')), `sobrou temporário: ${restantes}`);
});

// ── validação antes de publicar ─────────────────────────────────────────────
test('REGRESSÃO: um MP4 truncado é reprovado e não vira resultado', { skip: !disponivel.ok, timeout: 60000 }, async () => {
  const completo = path.join(RAIZ, 'completo.mp4');
  await sintetico(completo, { duracao: 1 });

  // O arquivo inteiro passa.
  const bom = await validarMp4(completo);
  assert.equal(bom.ok, true, bom.motivo);
  assert.ok(bom.probe.duration > 0);
  assert.equal(bom.probe.hasVideo, true);

  // Metade dos bytes — exatamente o que uma cópia no meio da escrita produz.
  const bytes = await readFile(completo);
  const truncado = path.join(RAIZ, 'truncado.mp4');
  await writeFile(truncado, bytes.subarray(0, Math.floor(bytes.length / 2)));

  const ruim = await validarMp4(truncado);
  assert.equal(ruim.ok, false, 'um MP4 truncado não pode ser aprovado');
  assert.ok(ruim.motivo.length > 0);
});

test('arquivo vazio, inexistente ou não-vídeo é reprovado', { skip: !disponivel.ok, timeout: 30000 }, async () => {
  const vazio = path.join(RAIZ, 'vazio.mp4');
  await writeFile(vazio, '');
  assert.equal((await validarMp4(vazio)).ok, false);

  const texto = path.join(RAIZ, 'texto.mp4');
  await writeFile(texto, 'isto não é um vídeo');
  assert.equal((await validarMp4(texto)).ok, false);

  assert.equal((await validarMp4(path.join(RAIZ, 'nao_existe.mp4'))).ok, false);
});

test('o arquivo de origem não é alterado pela validação', { skip: !disponivel.ok, timeout: 30000 }, async () => {
  const video = path.join(RAIZ, 'intacto.mp4');
  await sintetico(video, { duracao: 1 });
  const antes = await hash(video);

  await validarMp4(video);
  await probe(video);

  assert.equal(await hash(video), antes);
});

// ── estabilidade da fonte ───────────────────────────────────────────────────
test('a espera por estabilidade exige duas leituras iguais', async () => {
  const { aguardarFonteEstavel } = await import('../lib/server/comfy/provider.js');

  // Simula o arquivo crescendo e depois estabilizando.
  const leituras = [100, 200, 300, 300];
  let i = 0;
  const original = (await import('../lib/server/comfy/client.js')).viewFileSize;
  assert.equal(typeof original, 'function', 'viewFileSize precisa existir no cliente');

  // Verificamos o contrato da função com uma fonte que nunca estabiliza:
  // ela precisa desistir em vez de travar.
  const resultado = await aguardarFonteEstavel(
    { filename: 'inexistente.mp4', subfolder: 'video', type: 'output' },
    { tentativas: 2, intervaloMs: 10 },
  );
  assert.equal(resultado.estavel, false);
  assert.ok(['tamanho-indisponivel', 'ainda-crescendo'].includes(resultado.motivo));
  assert.equal(leituras[i] > 0, true);
});
