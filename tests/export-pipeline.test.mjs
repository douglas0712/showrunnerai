// Integração do pipeline de exportação.
//
// Usa vídeos SINTÉTICOS gerados na hora dentro de um diretório temporário —
// os clipes reais do projeto nunca são lidos nem tocados por estes testes.

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  cancelExport, getExportJob, limpar, listExportJobs, startExport,
} from '../lib/server/export/runner.js';
import { ffmpegAvailable, probe } from '../lib/server/export/ffmpeg.js';

const disponivel = await ffmpegAvailable();
const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-export-pipe-'));
const PROJ = 'proj_teste';
const VIDEOS = path.join(RAIZ, PROJ, 'videos');

test.after(() => rm(RAIZ, { recursive: true, force: true }));

/** Cria um MP4 sintético com vídeo e áudio. */
function sintetico(destino, { duracao = 1, cor = 'blue', hz = 440, comAudio = true } = {}) {
  return new Promise((resolve, reject) => {
    const args = [
      '-hide_banner', '-nostdin', '-y',
      '-f', 'lavfi', '-i', `color=c=${cor}:size=320x240:rate=24:duration=${duracao}`,
    ];
    if (comAudio) {
      args.push('-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=${duracao}:sample_rate=32000`);
    }
    args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(duracao));
    if (comAudio) args.push('-c:a', 'aac', '-ac', '2');
    args.push(destino);

    const proc = spawn('/usr/bin/ffmpeg', args, { shell: false });
    let erro = '';
    proc.stderr.on('data', (c) => { erro += c.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve(destino) : reject(new Error(erro.slice(-400)))));
  });
}

async function hash(p) {
  return createHash('sha256').update(await readFile(p)).digest('hex');
}

async function aguardar(exportId, { timeoutMs = 90000 } = {}) {
  const limite = Date.now() + timeoutMs;
  while (Date.now() < limite) {
    const job = getExportJob(exportId);
    if (job && [ 'concluido', 'falhou', 'cancelado' ].includes(job.state)) return job;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Exportação ${exportId} não terminou no tempo previsto.`);
}

await mkdir(VIDEOS, { recursive: true });

test('pipeline real: concatena duas cenas com áudio e preserva os originais', { skip: !disponivel.ok, timeout: 120000 }, async () => {
  const a = path.join(VIDEOS, 'cinema_teste_a.mp4');
  const b = path.join(VIDEOS, 'cinema_teste_b.mp4');
  await sintetico(a, { duracao: 1, cor: 'blue', hz: 440 });
  await sintetico(b, { duracao: 1, cor: 'red', hz: 880 });

  const hashAntesA = await hash(a);
  const hashAntesB = await hash(b);
  const sondaA = await probe(a);

  const inicial = await startExport({
    projectId: PROJ,
    presetId: 'source-864x480-24',
    root: RAIZ,
    clips: [
      { jobId: 'cinema_teste_a', title: 'Cena A', approved: true },
      { jobId: 'cinema_teste_b', title: 'Cena B', approved: true },
    ],
  });

  // O trabalho já começou em segundo plano quando startExport retorna — o que
  // importa é que ele não nasce terminal.
  assert.equal(inicial.terminal, false);
  assert.ok(['preparando', 'resolvendo-cenas', 'codificando'].includes(inicial.state), inicial.state);
  assert.ok(inicial.exportId.startsWith('export_'));
  const final = await aguardar(inicial.exportId);

  assert.equal(final.state, 'concluido', final.error || '');
  assert.ok(final.result?.filename, 'a exportação precisa produzir um arquivo');

  // ── o arquivo final tem vídeo E áudio, na duração somada ────────────────
  const saida = path.join(RAIZ, PROJ, 'exports', final.result.filename);
  const sonda = await probe(saida);

  assert.equal(sonda.hasVideo, true);
  assert.equal(sonda.hasAudio, true, 'o áudio nativo não pode ser descartado');
  assert.equal(sonda.videoCodec, 'h264');
  assert.equal(sonda.audioCodec, 'aac');
  assert.equal(sonda.pixelFormat, 'yuv420p');
  assert.equal(sonda.width, 864);
  assert.equal(sonda.height, 480);
  assert.equal(sonda.fps, 24);
  assert.equal(sonda.sampleRate, 48000, 'o áudio de 32 kHz precisa ter sido reamostrado');

  const previsto = sondaA.duration * 2;
  assert.ok(
    Math.abs(sonda.duration - previsto) < 0.35,
    `duração ${sonda.duration}s deveria ficar perto de ${previsto}s`,
  );

  // ── proveniência do resultado ───────────────────────────────────────────
  assert.equal(final.result.sha256, await hash(saida));
  assert.ok(final.result.bytes > 0);
  assert.equal(final.result.costUsd, 0);
  assert.equal(final.result.logicalPath, `runtime/projects/${PROJ}/exports/${final.result.filename}`);

  // ── os originais continuam intactos ────────────────────────────────────
  assert.equal(await hash(a), hashAntesA, 'a cena A foi alterada');
  assert.equal(await hash(b), hashAntesB, 'a cena B foi alterada');

  // ── temporários limpos ─────────────────────────────────────────────────
  const conteudo = await readdir(path.join(RAIZ, PROJ, 'exports'));
  assert.ok(!conteudo.some((n) => n.startsWith('tmp-')), `sobraram temporários: ${conteudo}`);

  // ── progresso avançou ──────────────────────────────────────────────────
  assert.equal(final.progress, 1);
  assert.ok(final.frames > 0, 'o progresso precisa ter contado frames');
});

test('a ordem da timeline determina a ordem da montagem', { skip: !disponivel.ok, timeout: 120000 }, async () => {
  const primeira = await startExport({
    projectId: PROJ, presetId: 'source-864x480-24', root: RAIZ,
    clips: [
      { jobId: 'cinema_teste_b', title: 'B primeiro', approved: true },
      { jobId: 'cinema_teste_a', title: 'A depois', approved: true },
    ],
  });
  const final = await aguardar(primeira.exportId);
  assert.equal(final.state, 'concluido', final.error || '');
  assert.deepEqual(final.scenes.map((c) => c.jobId), ['cinema_teste_b', 'cinema_teste_a']);
  assert.deepEqual(final.scenes.map((c) => c.title), ['B primeiro', 'A depois']);
});

test('exportações anteriores nunca são sobrescritas', { skip: !disponivel.ok, timeout: 60000 }, async () => {
  const arquivos = await readdir(path.join(RAIZ, PROJ, 'exports'));
  const mp4s = arquivos.filter((n) => n.endsWith('.mp4'));
  assert.ok(mp4s.length >= 2, 'cada exportação precisa gerar um arquivo próprio');
  assert.equal(new Set(mp4s).size, mp4s.length, 'nomes de exportação precisam ser únicos');
});

test('clipe sem aprovação bloqueia a exportação antes de tocar no FFmpeg', async () => {
  await assert.rejects(
    () => startExport({
      projectId: PROJ, root: RAIZ,
      clips: [
        { jobId: 'cinema_teste_a', title: 'Cena A', approved: true },
        { jobId: 'cinema_teste_b', title: 'Cena B', approved: false },
      ],
    }),
    (erro) => {
      assert.match(erro.message, /sem aprovação/);
      assert.equal(erro.pending.length, 1);
      assert.equal(erro.pending[0].posicao, 2);
      assert.equal(erro.pending[0].titulo, 'Cena B');
      return true;
    },
  );
});

test('cancelamento encerra o processo e não deixa arquivo final', { skip: !disponivel.ok, timeout: 120000 }, async () => {
  const longo = path.join(VIDEOS, 'cinema_teste_longo.mp4');
  await sintetico(longo, { duracao: 6, cor: 'green', hz: 220 });

  const inicial = await startExport({
    projectId: PROJ, presetId: '1080p-24', root: RAIZ,
    clips: [
      { jobId: 'cinema_teste_longo', title: 'Longo', approved: true },
      { jobId: 'cinema_teste_a', title: 'Cena A', approved: true },
    ],
  });

  // Espera a codificação começar de fato antes de cancelar.
  const limite = Date.now() + 20000;
  while (Date.now() < limite) {
    const job = getExportJob(inicial.exportId);
    if (job?.state === 'codificando' || job?.terminal) break;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 100));
  }

  await cancelExport(inicial.exportId);
  const final = await aguardar(inicial.exportId, { timeoutMs: 30000 });

  assert.equal(final.state, 'cancelado');
  assert.equal(final.result, null, 'cancelado não pode produzir arquivo final');

  const arquivos = await readdir(path.join(RAIZ, PROJ, 'exports'));
  assert.ok(!arquivos.includes(`${inicial.exportId}.mp4`), 'o arquivo do job cancelado não pode existir');
  assert.ok(!arquivos.some((n) => n.startsWith(`tmp-${inicial.exportId}`)), 'temporário do cancelado deve ser limpo');
});

test('cancelar um job desconhecido não quebra nem afeta outros', async () => {
  assert.equal(await cancelExport('export_inexistente'), null);
});

test('recuperação após reload: os jobs seguem listados pelo servidor', { skip: !disponivel.ok }, async () => {
  const lista = listExportJobs({ projectId: PROJ });
  assert.ok(lista.length >= 3, 'o servidor precisa manter o histórico das exportações');

  const concluidas = lista.filter((j) => j.state === 'concluido');
  assert.ok(concluidas.length >= 2);
  // O que a interface usa para retomar depois de recarregar:
  assert.ok(concluidas[0].exportId && concluidas[0].result?.url);
  assert.ok(concluidas[0].scenes.length > 0);

  // Filtro por projeto isola o que não é do projeto.
  assert.equal(listExportJobs({ projectId: 'projeto_que_nao_existe' }).length, 0);
});

test('o recorte público não vaza processo nem caminho absoluto', { skip: !disponivel.ok }, async () => {
  const [job] = listExportJobs({ projectId: PROJ });
  assert.equal(job.proc, undefined, 'o ChildProcess não pode ir ao navegador');
  assert.equal(job.args, undefined, 'os argumentos crus não vão ao navegador');
  const serializado = JSON.stringify(job);
  assert.ok(!serializado.includes(RAIZ), 'nenhum caminho absoluto pode vazar');
});

test('SEGURANÇA: a limpeza só apaga diretórios tmp- dentro da raiz', async () => {
  const foraDaRaiz = await mkdtemp(path.join(tmpdir(), 'showrunner-fora-'));
  try {
    // Fora da raiz: recusado.
    assert.equal(await limpar(foraDaRaiz, RAIZ), false);
    // Dentro da raiz mas sem o prefixo tmp-: recusado.
    const semPrefixo = path.join(RAIZ, PROJ, 'videos');
    assert.equal(await limpar(semPrefixo, RAIZ), false);
    // Os vídeos continuam lá.
    assert.ok((await readdir(semPrefixo)).length > 0);
    // Caminho vazio: recusado.
    assert.equal(await limpar('', RAIZ), false);
  } finally {
    await rm(foraDaRaiz, { recursive: true, force: true });
  }
});
