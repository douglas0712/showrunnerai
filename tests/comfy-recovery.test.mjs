// Regressão da falha real: o vídeo terminou no ComfyUI e nunca chegou à aplicação.
//
// Causa: a cópia do MP4 só era disparada pelo navegador (/api/comfy/result).
// Quando o polling do CinemaScreen parava — troca de aba, recarregamento, erro
// de rede — o job ficava eternamente em "salvando" e o arquivo se perdia.
//
// Estes testes usam o payload REAL capturado do ComfyUI para a geração
// cinema_mt2011bo_uhqqd3 (prompt_id e71e8987-7a0d-4013-a867-1fef97a19632).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  findVideoOutput, interpretHistory, jobIdFromFilename, recoverablesFromHistory,
} from '../lib/server/comfy/status.js';
import { metaFromSubmittedGraph, aspectFromSelector, qualityFromMegapixels } from '../lib/server/comfy/workflow.js';
import { saveVideoBytes } from '../lib/server/comfy/storage.js';
import { NODE_IDS, OUTPUT_PREFIX_DIR } from '../lib/server/comfy/config.js';

const HISTORICO_REAL = JSON.parse(
  await readFile(new URL('./fixtures/history-cinema-real.json', import.meta.url), 'utf8'),
);
const PROMPT_ID = 'e71e8987-7a0d-4013-a867-1fef97a19632';
const JOB_ID = 'cinema_mt2011bo_uhqqd3';
const ARQUIVO = 'cinema_mt2011bo_uhqqd3_00001_.mp4';

test('o histórico real é lido como execução concluída com sucesso', () => {
  const leitura = interpretHistory(HISTORICO_REAL[PROMPT_ID]);
  assert.equal(leitura.finished, true);
  assert.equal(leitura.success, true);
  assert.equal(leitura.error, null);
});

test('o parser acha o MP4 no campo real do nó 92 (images + animated)', () => {
  const leitura = interpretHistory(HISTORICO_REAL[PROMPT_ID]);
  const saida = findVideoOutput(leitura.outputs, NODE_IDS.save);

  assert.deepEqual(saida, {
    nodeId: '92',
    filename: ARQUIVO,
    subfolder: 'video/showrunner',
    type: 'output',
  });
});

test('o sufixo _00001_ e o subdiretório voltam ao jobId original', () => {
  assert.equal(jobIdFromFilename(ARQUIVO), JOB_ID);
  assert.equal(jobIdFromFilename('cinema_abc_00042_.mp4'), 'cinema_abc');
  assert.equal(jobIdFromFilename('cinema_abc_00001_.webm'), 'cinema_abc');
});

test('nomes fora do padrão não viram jobId — inclusive travessia', () => {
  ['../fuga_00001_.mp4', 'a/b_00001_.mp4', 'sem_sufixo.mp4', '_00001_.mp4', '']
    .forEach((n) => assert.equal(jobIdFromFilename(n), null, `aceitou "${n}"`));
});

test('REGRESSÃO: a geração órfã real é identificada como recuperável', () => {
  const candidatos = recoverablesFromHistory(HISTORICO_REAL, {
    saveNodeId: NODE_IDS.save,
    prefix: OUTPUT_PREFIX_DIR,
    promptNodeId: NODE_IDS.prompt,
  });

  assert.equal(candidatos.length, 1, 'a geração existente precisa ser recuperável');
  const [c] = candidatos;
  assert.equal(c.promptId, PROMPT_ID);
  assert.equal(c.jobId, JOB_ID);
  assert.equal(c.reason, null);
  assert.equal(c.output.filename, ARQUIVO);
  assert.ok(c.graph, 'o grafo submetido precisa vir junto para reconstruir a proveniência');
});

test('só adotamos saídas sob o prefixo desta aplicação', () => {
  const deOutroApp = {
    'outro-id': {
      status: { status_str: 'success', completed: true },
      outputs: { 92: { images: [{ filename: 'MiniMax_H3_00001_.mp4', subfolder: 'video', type: 'output' }] } },
    },
  };
  const candidatos = recoverablesFromHistory(deOutroApp, {
    saveNodeId: NODE_IDS.save, prefix: OUTPUT_PREFIX_DIR,
  });
  assert.equal(candidatos.length, 0, 'saída de outra ferramenta não pode ser adotada');
});

test('execuções que falharam ou ainda rodam não são recuperáveis', () => {
  const misto = {
    a: { status: { status_str: 'error', completed: false, messages: [] }, outputs: {} },
    b: { status: { status_str: 'running', completed: false }, outputs: {} },
  };
  assert.equal(recoverablesFromHistory(misto, { saveNodeId: NODE_IDS.save }).length, 0);
  assert.equal(recoverablesFromHistory({}, {}).length, 0);
  assert.equal(recoverablesFromHistory(null, {}).length, 0);
});

test('a proveniência é reconstruída do grafo, sem depender da memória do servidor', () => {
  const [{ graph }] = recoverablesFromHistory(HISTORICO_REAL, {
    saveNodeId: NODE_IDS.save, prefix: OUTPUT_PREFIX_DIR, promptNodeId: NODE_IDS.prompt,
  });
  const meta = metaFromSubmittedGraph(graph, JOB_ID);

  assert.equal(meta.jobId, JOB_ID);
  assert.equal(meta.seed, 123034625602672);
  assert.equal(meta.durationRequested, 5.2);
  assert.equal(meta.frames, 141);
  assert.equal(meta.durationActual, 5.88);
  assert.equal(meta.aspect, '16:9');
  assert.equal(meta.quality, '480p');
  assert.equal(meta.fps, 24);
  assert.equal(meta.costUsd, 0);
  assert.equal(meta.recovered, true);
  assert.equal(meta.filenamePrefix, `${OUTPUT_PREFIX_DIR}/${JOB_ID}`);
  assert.match(meta.prompt, /railway station/i);
});

test('grafo ausente ou incompleto não produz proveniência inventada', () => {
  assert.equal(metaFromSubmittedGraph(null, JOB_ID), null);
  assert.equal(metaFromSubmittedGraph({}, JOB_ID), null);
  assert.equal(metaFromSubmittedGraph({ [NODE_IDS.prompt]: { inputs: {} } }, JOB_ID), null);
});

test('os mapas reversos batem com os valores do workflow real', () => {
  assert.equal(aspectFromSelector('16:9 (Widescreen)'), '16:9');
  assert.equal(aspectFromSelector('21:9 (Ultrawide)'), '21:9');
  assert.equal(aspectFromSelector('inexistente'), null);
  assert.equal(qualityFromMegapixels(0.4), '480p');
  assert.equal(qualityFromMegapixels(0.9), '720p');
  assert.equal(qualityFromMegapixels(2.1), '1080p');
  assert.equal(qualityFromMegapixels(7.5), '7.5 MP');
});

test('recuperar duas vezes não sobrescreve nem duplica o arquivo', async () => {
  const raiz = await mkdtemp(path.join(tmpdir(), 'showrunner-recover-'));
  try {
    const bytes = Buffer.from('mp4-recuperado');
    const primeiro = await saveVideoBytes('proj_demo_noir', JOB_ID, bytes, raiz);
    assert.equal(primeiro.filename, `${JOB_ID}.mp4`);

    // Uma segunda cópia jamais pode apagar a primeira.
    const segundo = await saveVideoBytes('proj_demo_noir', JOB_ID, Buffer.from('outro'), raiz);
    assert.notEqual(segundo.filename, primeiro.filename);
    assert.equal((await readFile(primeiro.absolutePath)).toString(), 'mp4-recuperado');
    assert.ok((await stat(primeiro.absolutePath)).isFile());
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});

test('REGRESSÃO: recuperar após reinício adota o arquivo existente, não duplica', async () => {
  const raiz = await mkdtemp(path.join(tmpdir(), 'showrunner-idem-'));
  try {
    const { findVideoByJobId } = await import('../lib/server/comfy/storage.js');

    // Nada gravado ainda.
    assert.equal(await findVideoByJobId(JOB_ID, raiz), null);

    const salvo = await saveVideoBytes('proj_demo_noir', JOB_ID, Buffer.from('mp4'), raiz);

    // Depois de gravado, é encontrado em qualquer projeto — é isso que evita
    // baixar o mesmo vídeo de novo a cada reinício do servidor.
    const achado = await findVideoByJobId(JOB_ID, raiz);
    assert.ok(achado, 'o vídeo já gravado precisa ser encontrado');
    assert.equal(achado.projectId, 'proj_demo_noir');
    assert.equal(achado.filename, `${JOB_ID}.mp4`);
    assert.equal(achado.url, `/api/media/video/proj_demo_noir/${JOB_ID}.mp4`);
    assert.equal(achado.absolutePath, salvo.absolutePath);

    // Job desconhecido continua sem resultado.
    assert.equal(await findVideoByJobId('cinema_inexistente', raiz), null);
  } finally {
    await rm(raiz, { recursive: true, force: true });
  }
});

test('findVideoByJobId recusa identificador inválido', async () => {
  const { findVideoByJobId, PathValidationError } = await import('../lib/server/comfy/storage.js');
  await assert.rejects(() => findVideoByJobId('../fuga'), PathValidationError);
  await assert.rejects(() => findVideoByJobId('a/b'), PathValidationError);
});

test('REGRESSÃO: a recuperação preserva a cronologia real do ComfyUI', async () => {
  const { executionTimestamp, recoverablesFromHistory } = await import('../lib/server/comfy/status.js');

  // O histórico real traz o instante da execução nas mensagens.
  const instante = executionTimestamp(HISTORICO_REAL[PROMPT_ID]);
  assert.ok(Number.isFinite(instante) && instante > 0, 'o instante da execução precisa ser lido');

  const [candidato] = recoverablesFromHistory(HISTORICO_REAL, {
    saveNodeId: NODE_IDS.save, prefix: OUTPUT_PREFIX_DIR, promptNodeId: NODE_IDS.prompt,
  });
  assert.equal(candidato.startedAt, instante);

  // Sem mensagens, devolve null em vez de inventar um horário.
  assert.equal(executionTimestamp({ status: { messages: [] } }), null);
  assert.equal(executionTimestamp(null), null);
});

test('REGRESSÃO: ordenar por createdAt aponta para a geração mais recente', async () => {
  const { publicJob } = await import('../lib/server/comfy/provider.js');

  // Dois jobs recuperados: quem tem o instante maior precisa vir primeiro.
  const antigo = publicJob({ jobId: 'a', createdAt: 1_000, state: 'concluido', result: { url: '/a' } });
  const novo = publicJob({ jobId: 'b', createdAt: 2_000, state: 'concluido', result: { url: '/b' } });

  const ordenados = [antigo, novo].sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  assert.equal(ordenados[0].jobId, 'b', 'o mais recente precisa vir primeiro');
});
