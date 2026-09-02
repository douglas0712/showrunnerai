import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  computeFrames, framesToSeconds, isWithinTrainedRange, loadWorkflowTemplate,
  megapixelsForQuality, patchWorkflow, selectorForAspect, validateWorkflow, WorkflowError,
} from '../lib/server/comfy/workflow.js';
import { NODE_IDS, WORKFLOW_PATH, REQUIRED_MODEL_FILES, OUTPUT_PREFIX_DIR } from '../lib/server/comfy/config.js';

const template = await loadWorkflowTemplate();

test('o workflow de referência carrega e valida', () => {
  assert.equal(validateWorkflow(template), true);
  assert.equal(template[NODE_IDS.prompt].class_type, 'MiniMaxH3ImageToVideo');
  assert.equal(template[NODE_IDS.seed].class_type, 'RandomNoise');
  assert.equal(template[NODE_IDS.save].class_type, 'SaveVideo');
});

test('os quatro arquivos do MiniMax H3 continuam referenciados', () => {
  for (const modelo of REQUIRED_MODEL_FILES) {
    assert.equal(template[modelo.node].inputs[modelo.field], modelo.file, modelo.role);
  }
});

test('validateWorkflow recusa grafo sem os nós esperados', () => {
  const semPrompt = structuredClone(template);
  delete semPrompt[NODE_IDS.prompt];
  assert.throws(() => validateWorkflow(semPrompt), WorkflowError);

  const classeErrada = structuredClone(template);
  classeErrada[NODE_IDS.seed].class_type = 'OutroNo';
  assert.throws(() => validateWorkflow(classeErrada), WorkflowError);

  const modeloTrocado = structuredClone(template);
  modeloTrocado[NODE_IDS.unet].inputs.unet_name = 'outro_modelo.safetensors';
  assert.throws(() => validateWorkflow(modeloTrocado), WorkflowError);

  assert.throws(() => validateWorkflow(null), WorkflowError);
  assert.throws(() => validateWorkflow([]), WorkflowError);
});

test('o patch aplica todos os parâmetros no nó correto', () => {
  const { graph, meta } = patchWorkflow(template, {
    prompt: 'Plano geral do vale ao amanhecer',
    seed: 4242,
    durationSeconds: 6,
    aspect: '21:9',
    quality: '720p',
    fps: 24,
    jobId: 'cinema_teste_1',
  });

  assert.equal(graph[NODE_IDS.prompt].inputs.prompt, 'Plano geral do vale ao amanhecer');
  assert.equal(graph[NODE_IDS.seed].inputs.noise_seed, 4242);
  assert.equal(graph[NODE_IDS.duration].inputs.value, 6);
  assert.equal(graph[NODE_IDS.resolution].inputs.aspect_ratio, '21:9 (Ultrawide)');
  assert.equal(graph[NODE_IDS.resolution].inputs.megapixels, 0.9);
  assert.equal(graph[NODE_IDS.createVideo].inputs.fps, 24);
  assert.equal(graph[NODE_IDS.save].inputs.filename_prefix, `${OUTPUT_PREFIX_DIR}/cinema_teste_1`);
  assert.equal(meta.seedLocked, true);
  assert.equal(meta.costUsd, 0);
});

test('o patch NÃO altera o template em memória nem o arquivo em disco', async () => {
  const antesArquivo = createHash('sha256').update(await readFile(WORKFLOW_PATH)).digest('hex');
  const antesTemplate = JSON.stringify(template);

  patchWorkflow(template, {
    prompt: 'outro prompt completamente diferente',
    seed: 999, durationSeconds: 15, aspect: '9:16', quality: '1080p', jobId: 'cinema_teste_2',
  });

  assert.equal(JSON.stringify(template), antesTemplate, 'o template em memória foi mutado');

  const depoisArquivo = createHash('sha256').update(await readFile(WORKFLOW_PATH)).digest('hex');
  assert.equal(depoisArquivo, antesArquivo, 'o arquivo original foi alterado');

  // O grafo devolvido é uma cópia independente.
  const { graph } = patchWorkflow(template, {
    prompt: 'x', durationSeconds: 5, aspect: '16:9', quality: '480p', jobId: 'cinema_teste_3',
  });
  graph[NODE_IDS.prompt].inputs.prompt = 'mutação local';
  assert.notEqual(template[NODE_IDS.prompt].inputs.prompt, 'mutação local');
});

test('seed travada é respeitada; sem travar, é aleatória e válida', () => {
  const fixa = patchWorkflow(template, {
    prompt: 'p', seed: 123456, durationSeconds: 5, aspect: '16:9', quality: '480p', jobId: 'j1',
  });
  assert.equal(fixa.meta.seed, 123456);
  assert.equal(fixa.meta.seedLocked, true);

  const outraFixa = patchWorkflow(template, {
    prompt: 'p', seed: 123456, durationSeconds: 5, aspect: '16:9', quality: '480p', jobId: 'j2',
  });
  assert.equal(outraFixa.meta.seed, 123456, 'a mesma seed travada precisa se repetir');

  const seeds = new Set();
  for (let i = 0; i < 12; i += 1) {
    const livre = patchWorkflow(template, {
      prompt: 'p', seed: null, durationSeconds: 5, aspect: '16:9', quality: '480p', jobId: `j${i}`,
    });
    assert.equal(livre.meta.seedLocked, false);
    assert.ok(Number.isInteger(livre.meta.seed) && livre.meta.seed >= 0);
    seeds.add(livre.meta.seed);
  }
  assert.ok(seeds.size > 1, 'seeds livres precisam variar');
});

test('frames caem sempre na grade 17k+5 do modelo', () => {
  for (const duracao of [1, 5, 5.2, 6, 7.5, 10, 12, 15, 20]) {
    const frames = computeFrames(duracao, 24);
    assert.equal((frames - 5) % 17, 0, `duração ${duracao}s produziu ${frames} frames fora da grade`);
    assert.ok(frames >= Math.round(duracao * 24), 'a grade precisa arredondar para cima');
  }
  assert.equal(computeFrames(5.2, 24), 141);
  assert.equal(computeFrames(0.01, 24), 5);
});

test('duração real deriva dos frames e a faixa treinada é sinalizada', () => {
  assert.equal(framesToSeconds(141, 24), 5.88);
  assert.equal(isWithinTrainedRange(141), true);
  assert.equal(isWithinTrainedRange(5), false);
  assert.equal(isWithinTrainedRange(600), false);
});

test('proporção e qualidade fora do suportado são recusadas', () => {
  assert.equal(selectorForAspect('16:9'), '16:9 (Widescreen)');
  assert.equal(megapixelsForQuality('480p'), 0.4);
  assert.throws(() => selectorForAspect('7:3'), WorkflowError);
  assert.throws(() => megapixelsForQuality('8k'), WorkflowError);
});

test('o patch recusa entradas inválidas', () => {
  const base = { prompt: 'p', durationSeconds: 5, aspect: '16:9', quality: '480p' };
  assert.throws(() => patchWorkflow(template, { ...base, prompt: '   ', jobId: 'j' }), WorkflowError);
  assert.throws(() => patchWorkflow(template, { ...base, jobId: '../escapar' }), WorkflowError);
  assert.throws(() => patchWorkflow(template, { ...base, jobId: 'j', durationSeconds: 0 }), WorkflowError);
  assert.throws(() => patchWorkflow(template, { ...base, jobId: 'j', seed: -5 }), WorkflowError);
});

test('cada job recebe um filename_prefix exclusivo', () => {
  const a = patchWorkflow(template, { prompt: 'p', durationSeconds: 5, aspect: '16:9', quality: '480p', jobId: 'job_a' });
  const b = patchWorkflow(template, { prompt: 'p', durationSeconds: 5, aspect: '16:9', quality: '480p', jobId: 'job_b' });
  assert.notEqual(a.meta.filenamePrefix, b.meta.filenamePrefix);
  assert.ok(a.meta.filenamePrefix.startsWith(OUTPUT_PREFIX_DIR));
});
