// Imagem → vídeo e primeiro/último quadro no MiniMax H3.
//
// A premissa que estes testes protegem: `MiniMaxH3ImageToVideo` declara
// `first_frame` e `last_frame` como entradas OPCIONAIS, então os três modos são
// o mesmo grafo com zero, uma ou duas imagens ligadas. Não existe um segundo
// workflow nem um segundo pipeline — e o teste do fluxo do Cinema, no fim deste
// arquivo, é o que garante que continuou assim.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attachFrames, loadWorkflowTemplate, metaFromSubmittedGraph, modeFromGraph,
  patchWorkflow, validateWorkflow, WorkflowError,
} from '../lib/server/comfy/workflow.js';
import {
  detectImageType, modeForFrames, safeFrameName, UploadError, validateFrame,
} from '../lib/server/comfy/images.js';
import { FRAME_NODE_IDS, MAX_UPLOAD_BYTES, NODE_IDS } from '../lib/server/comfy/config.js';
import { uploadImage, imageExists, ComfyError } from '../lib/server/comfy/client.js';

const TEMPLATE = await loadWorkflowTemplate();

const REF_PRIMEIRO = { name: 'job_first.png', subfolder: 'showrunner', type: 'input' };
const REF_ULTIMO = { name: 'job_last.jpg', subfolder: 'showrunner', type: 'input' };

const patch = (frames) => patchWorkflow(TEMPLATE, {
  prompt: 'a câmera avança lentamente',
  durationSeconds: 5.2,
  aspect: '16:9',
  quality: '480p',
  fps: 24,
  jobId: 'job',
  frames,
});

/** Imagens sintéticas com assinatura real de cada formato. */
const png = (extra = 200) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(extra)]);
const jpeg = (extra = 200) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(extra)]);
const webp = (extra = 200) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(extra)]);

// ── 1. primeiro quadro sem último ───────────────────────────────────────────

test('primeiro quadro sem último produz um grafo imagem → vídeo', () => {
  const { graph, meta } = patch({ first: REF_PRIMEIRO });

  assert.equal(meta.mode, 'i2v');
  assert.equal(Object.keys(graph).length, Object.keys(TEMPLATE).length + 1);

  const loadImage = graph[FRAME_NODE_IDS.first];
  assert.equal(loadImage.class_type, 'LoadImage');
  assert.equal(loadImage.inputs.image, 'showrunner/job_first.png');

  assert.deepEqual(graph[NODE_IDS.prompt].inputs.first_frame, [FRAME_NODE_IDS.first, 0]);
  assert.equal(graph[NODE_IDS.prompt].inputs.last_frame, undefined);
  assert.equal(graph[FRAME_NODE_IDS.last], undefined);
});

// ── 2. primeiro e último quadro ─────────────────────────────────────────────

test('primeiro e último quadro produzem um grafo first/last-frame', () => {
  const { graph, meta } = patch({ first: REF_PRIMEIRO, last: REF_ULTIMO });

  assert.equal(meta.mode, 'flf');
  assert.equal(Object.keys(graph).length, Object.keys(TEMPLATE).length + 2);

  assert.deepEqual(graph[NODE_IDS.prompt].inputs.first_frame, [FRAME_NODE_IDS.first, 0]);
  assert.deepEqual(graph[NODE_IDS.prompt].inputs.last_frame, [FRAME_NODE_IDS.last, 0]);
  assert.equal(graph[FRAME_NODE_IDS.last].inputs.image, 'showrunner/job_last.jpg');
});

test('o último quadro sozinho é recusado', () => {
  assert.throws(() => patch({ last: REF_ULTIMO }), WorkflowError);
  assert.throws(() => modeForFrames({ last: {} }), UploadError);
});

test('o modo é derivado dos quadros, nunca escolhido à mão', () => {
  assert.equal(modeForFrames({}), 't2v');
  assert.equal(modeForFrames({ first: {} }), 'i2v');
  assert.equal(modeForFrames({ first: {}, last: {} }), 'flf');
});

test('os parâmetros de tempo e resolução valem igual nos três modos', () => {
  const modos = [null, { first: REF_PRIMEIRO }, { first: REF_PRIMEIRO, last: REF_ULTIMO }];
  const metas = modos.map((frames) => patch(frames).meta);

  for (const meta of metas) {
    assert.equal(meta.frames, 141);
    assert.equal(meta.durationActual, 5.88);
    assert.equal(meta.aspect, '16:9');
    assert.equal(meta.quality, '480p');
    assert.equal(meta.fps, 24);
  }
});

// ── 3. arquivo inválido ─────────────────────────────────────────────────────

test('PNG, JPEG e WebP são reconhecidos pelos bytes', () => {
  assert.equal(detectImageType(png()).mime, 'image/png');
  assert.equal(detectImageType(jpeg()).mime, 'image/jpeg');
  assert.equal(detectImageType(webp()).mime, 'image/webp');
});

test('o tipo vem do conteúdo, não da extensão nem do que o navegador declarou', () => {
  // Um executável renomeado para .png e anunciado como image/png.
  const executavel = Buffer.concat([Buffer.from('MZ\x90\x00'), Buffer.alloc(400)]);

  assert.equal(detectImageType(executavel), null);
  assert.throws(
    () => validateFrame(executavel, { role: 'first', jobId: 'job', declaredType: 'image/png', declaredName: 'foto.png' }),
    UploadError,
  );
});

test('um PNG anunciado como JPEG passa, mas fica marcado como divergente', () => {
  const info = validateFrame(png(), { role: 'first', jobId: 'job', declaredType: 'image/jpeg' });
  assert.equal(info.mime, 'image/png');
  assert.equal(info.mismatch, true);
});

test('arquivo vazio, minúsculo ou grande demais é recusado', () => {
  assert.throws(() => validateFrame(Buffer.alloc(0), { role: 'first', jobId: 'job' }), UploadError);
  assert.throws(() => validateFrame(png(2), { role: 'first', jobId: 'job' }), UploadError);
  assert.throws(
    () => validateFrame(Buffer.alloc(MAX_UPLOAD_BYTES + 1), { role: 'first', jobId: 'job' }),
    UploadError,
  );
});

test('o nome interno vem do jobId, nunca do nome do usuário', () => {
  const info = validateFrame(png(), {
    role: 'first',
    jobId: 'cinema_abc123',
    declaredName: '../../../etc/passwd.png',
  });
  assert.equal(info.filename, 'cinema_abc123_first.png');
  assert.ok(!info.filename.includes('/'));
  assert.ok(!info.filename.includes('..'));
});

test('path traversal não sobrevive a safeFrameName', () => {
  for (const ruim of ['../../etc/passwd', 'a/b', 'x\\y', '..', 'nome com espaço']) {
    assert.throws(() => safeFrameName(ruim, 'first', 'png'), UploadError, `deveria recusar "${ruim}"`);
  }
  assert.throws(() => safeFrameName('job', 'meio', 'png'), UploadError);
  assert.throws(() => safeFrameName('job', 'first', 'svg'), UploadError);
});

test('um nome vindo do ComfyUI com caminho não vira nó', () => {
  assert.throws(
    () => attachFrames(structuredClone(TEMPLATE), { first: { name: '../../../etc/passwd', subfolder: '' } }),
    WorkflowError,
  );
});

// ── 4 e 5. ComfyUI desconectado e falha de upload ───────────────────────────

/** Troca o fetch global por um dublê durante uma asserção. */
async function comFetch(dubles, fn) {
  const original = globalThis.fetch;
  globalThis.fetch = dubles;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('ComfyUI desconectado: o upload falha com mensagem legível', async () => {
  await comFetch(
    async () => { throw new TypeError('fetch failed'); },
    async () => {
      await assert.rejects(
        () => uploadImage({ bytes: png(), filename: 'job_first.png', subfolder: 'showrunner', mime: 'image/png' }),
        (erro) => {
          assert.ok(erro instanceof ComfyError);
          assert.match(erro.message, /não foi possível enviar a imagem/i);
          return true;
        },
      );
    },
  );
});

test('ComfyUI desconectado: a confirmação da imagem devolve falso em vez de estourar', async () => {
  await comFetch(
    async () => { throw new TypeError('fetch failed'); },
    async () => {
      assert.equal(await imageExists({ filename: 'x.png', subfolder: 'showrunner' }), false);
    },
  );
});

test('falha de upload: HTTP 500 vira ComfyError com o status preservado', async () => {
  await comFetch(
    async () => new Response('disco cheio', { status: 500 }),
    async () => {
      await assert.rejects(
        () => uploadImage({ bytes: png(), filename: 'job_first.png', subfolder: 'showrunner', mime: 'image/png' }),
        (erro) => {
          assert.equal(erro.status, 500);
          assert.match(erro.message, /recusou a imagem/i);
          return true;
        },
      );
    },
  );
});

test('upload aceito: a referência devolvida é a que o ComfyUI reportou', async () => {
  await comFetch(
    async () => Response.json({ name: 'job_first.png', subfolder: 'showrunner', type: 'input' }),
    async () => {
      const ref = await uploadImage({ bytes: png(), filename: 'job_first.png', subfolder: 'showrunner', mime: 'image/png' });
      assert.deepEqual(ref, { name: 'job_first.png', subfolder: 'showrunner', type: 'input' });
    },
  );
});

test('a confirmação aceita a referência exatamente como o upload a devolve', async () => {
  // Regressão: `/upload/image` devolve `{name, ...}` e `imageExists` só lia
  // `filename`. O upload funcionava, o arquivo estava no disco, e mesmo assim
  // a geração parava em "o ComfyUI aceitou o primeiro quadro mas não consegue
  // localizá-lo". O teste antigo passava porque chamava com `filename` na mão,
  // e não como o provider chama de verdade.
  const ref = { name: 'job_first.png', subfolder: 'showrunner', type: 'input' };
  const rotasVistas = [];

  await comFetch(
    async (url) => {
      rotasVistas.push(String(url));
      return new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/7855' } });
    },
    async () => {
      // A chamada é literalmente a do provider: imageExists(ref).
      assert.equal(await imageExists(ref), true);
    },
  );

  assert.ok(
    rotasVistas.some((u) => u.includes('filename=job_first.png')),
    `a rota consultada deveria nomear o arquivo; foi ${rotasVistas.join(', ')}`,
  );
  assert.ok(
    !rotasVistas.some((u) => u.includes('undefined')),
    'nenhum parâmetro pode ir como "undefined" para o ComfyUI',
  );
});

test('a confirmação também aceita a forma com filename e recusa referência vazia', async () => {
  await comFetch(
    async () => new Response('x', { status: 206, headers: { 'content-range': 'bytes 0-0/10' } }),
    async () => {
      assert.equal(await imageExists({ filename: 'a.png', subfolder: 'showrunner' }), true);
      assert.equal(await imageExists({}), false);
      assert.equal(await imageExists(), false);
    },
  );
});

test('arquivo ausente no ComfyUI é reportado como não encontrado', async () => {
  await comFetch(
    async () => new Response('not found', { status: 404 }),
    async () => {
      assert.equal(await imageExists({ name: 'sumiu.png', subfolder: 'showrunner' }), false);
    },
  );
});

// ── 6. workflow incompatível ────────────────────────────────────────────────

test('workflow sem os nós esperados é recusado antes de qualquer submissão', () => {
  assert.throws(() => validateWorkflow({ 1: { class_type: 'LoadImage', inputs: {} } }), WorkflowError);
  assert.throws(() => validateWorkflow(null), WorkflowError);
  assert.throws(() => validateWorkflow([]), WorkflowError);
});

test('class_type divergente no nó do modelo é recusado', () => {
  const adulterado = structuredClone(TEMPLATE);
  adulterado[NODE_IDS.prompt].class_type = 'OutroNoQualquer';

  assert.throws(() => validateWorkflow(adulterado), (erro) => {
    assert.match(erro.message, /class_type divergente/i);
    return true;
  });

  // E o patch com quadros também para nele, antes de qualquer upload virar nó.
  assert.throws(
    () => patchWorkflow(adulterado, {
      prompt: 'x', durationSeconds: 5.2, aspect: '16:9', quality: '480p', fps: 24,
      jobId: 'job', frames: { first: REF_PRIMEIRO },
    }),
    WorkflowError,
  );
});

test('workflow apontando para outro modelo é recusado', () => {
  const adulterado = structuredClone(TEMPLATE);
  adulterado[NODE_IDS.unet].inputs.unet_name = 'outro_modelo.safetensors';

  assert.throws(() => validateWorkflow(adulterado), (erro) => {
    assert.match(erro.message, /arquivos de modelo diferentes/i);
    return true;
  });
});

// ── 8. recuperação após reinício ────────────────────────────────────────────

test('o modo é reconstruído do grafo que o ComfyUI guardou', () => {
  const i2v = patch({ first: REF_PRIMEIRO }).graph;
  const flf = patch({ first: REF_PRIMEIRO, last: REF_ULTIMO }).graph;
  const t2v = patch(null).graph;

  assert.equal(modeFromGraph(i2v), 'i2v');
  assert.equal(modeFromGraph(flf), 'flf');
  assert.equal(modeFromGraph(t2v), 't2v');
});

test('a proveniência completa sobrevive ao reinício do servidor', () => {
  const { graph } = patch({ first: REF_PRIMEIRO, last: REF_ULTIMO });

  // É exatamente isto que o /history devolve e que a recuperação relê.
  const meta = metaFromSubmittedGraph(graph, 'cinema_recuperado');

  assert.equal(meta.mode, 'flf');
  assert.equal(meta.jobId, 'cinema_recuperado');
  assert.equal(meta.prompt, 'a câmera avança lentamente');
  assert.equal(meta.frames, 141);
  assert.equal(meta.aspect, '16:9');
  assert.equal(meta.quality, '480p');
  assert.equal(meta.recovered, true);
  assert.match(meta.model, /FLF/);
});

// ── 9. os fluxos já existentes do Cinema seguem intactos ────────────────────

test('sem quadros, o grafo é byte a byte o que a aba Cinema já submetia', () => {
  const { graph, meta } = patch(null);

  assert.equal(meta.mode, 't2v');
  assert.equal(Object.keys(graph).length, 17);
  assert.equal(graph[NODE_IDS.prompt].inputs.first_frame, undefined);
  assert.equal(graph[NODE_IDS.prompt].inputs.last_frame, undefined);
  assert.equal(graph[FRAME_NODE_IDS.first], undefined);
  assert.equal(graph[FRAME_NODE_IDS.last], undefined);
});

test('o template em memória nunca é mutado por nenhum modo', () => {
  const antes = JSON.stringify(TEMPLATE);

  patch(null);
  patch({ first: REF_PRIMEIRO });
  patch({ first: REF_PRIMEIRO, last: REF_ULTIMO });

  assert.equal(JSON.stringify(TEMPLATE), antes);
  assert.equal(TEMPLATE[NODE_IDS.save].inputs.filename_prefix, 'video/MiniMax_H3');
});

test('o prefixo de saída continua sendo o do Showrunner nos três modos', () => {
  for (const frames of [null, { first: REF_PRIMEIRO }, { first: REF_PRIMEIRO, last: REF_ULTIMO }]) {
    const { graph } = patch(frames);
    assert.equal(graph[NODE_IDS.save].inputs.filename_prefix, 'video/showrunner/job');
  }
});
