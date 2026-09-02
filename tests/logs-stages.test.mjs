import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEVELS, STAGES, STAGE_LABELS, STAGE_ORDER, explainFailure, retryKindForStage, stageLabel,
} from '../lib/server/logs/stages.js';

test('as quinze etapas pedidas existem no vocabulário', () => {
  const esperadas = [
    'VALIDATING_INPUTS', 'PREPARING_WORKFLOW', 'UPLOADING_START_FRAME', 'UPLOADING_END_FRAME',
    'SUBMITTING_TO_COMFYUI', 'QUEUED', 'GENERATING', 'READING_HISTORY', 'LOCATING_OUTPUT',
    'FINALIZING_FILE', 'VALIDATING_WITH_FFPROBE', 'PUBLISHING_RESULT', 'COMPLETED',
    'FAILED', 'CANCELLED',
  ];
  for (const etapa of esperadas) {
    assert.equal(STAGES[etapa], etapa, `${etapa} deveria estar declarada`);
  }
});

test('toda etapa tem rótulo em português', () => {
  for (const etapa of Object.values(STAGES)) {
    assert.ok(STAGE_LABELS[etapa], `${etapa} está sem rótulo`);
    assert.notEqual(stageLabel(etapa), etapa, `${etapa} deveria ter tradução`);
  }
});

test('a ordem cronológica cobre o caminho feliz completo', () => {
  assert.equal(STAGE_ORDER[0], STAGES.VALIDATING_INPUTS);
  assert.equal(STAGE_ORDER[STAGE_ORDER.length - 1], STAGES.COMPLETED);
  assert.ok(STAGE_ORDER.includes(STAGES.VALIDATING_WITH_FFPROBE));
});

test('falha depois da geração pede cópia, não nova geração', () => {
  for (const etapa of [
    STAGES.LOCATING_OUTPUT, STAGES.FINALIZING_FILE,
    STAGES.VALIDATING_WITH_FFPROBE, STAGES.PUBLISHING_RESULT,
  ]) {
    assert.equal(retryKindForStage(etapa), 'refinalizar', `${etapa} não deveria ocupar a GPU de novo`);
  }
});

test('falha antes da geração pede nova submissão', () => {
  for (const etapa of [STAGES.VALIDATING_INPUTS, STAGES.PREPARING_WORKFLOW, STAGES.SUBMITTING_TO_COMFYUI, STAGES.GENERATING]) {
    assert.equal(retryKindForStage(etapa), 'ressubmeter');
  }
});

test('etapas fora do fluxo do job não oferecem retentativa', () => {
  assert.equal(retryKindForStage(STAGES.CONNECTION_CHECK), null);
  assert.equal(retryKindForStage(null), null);
  assert.equal(retryKindForStage('INVENTADA'), null);
});

test('toda falha tem explicação legível, mesmo sem etapa conhecida', () => {
  assert.ok(explainFailure(null, '').length > 10);
  assert.ok(explainFailure('INVENTADA', 'algo').length > 10);
});

test('a causa vence a etapa quando a mensagem a identifica', () => {
  const semResposta = explainFailure(STAGES.QUEUED, 'Não foi possível falar com o ComfyUI em http://127.0.0.1:8188: fetch failed');
  assert.match(semResposta, /não respondeu|rodando/i);

  const semMemoria = explainFailure(STAGES.GENERATING, 'CUDA out of memory');
  assert.match(semMemoria, /mem[óo]ria/i);
});

test('cada etapa do fluxo tem explicação própria', () => {
  const genérica = explainFailure('INVENTADA', 'x');
  for (const etapa of [
    STAGES.VALIDATING_INPUTS, STAGES.PREPARING_WORKFLOW, STAGES.SUBMITTING_TO_COMFYUI,
    STAGES.LOCATING_OUTPUT, STAGES.FINALIZING_FILE, STAGES.VALIDATING_WITH_FFPROBE,
    STAGES.PUBLISHING_RESULT,
  ]) {
    assert.notEqual(explainFailure(etapa, 'erro qualquer'), genérica, `${etapa} deveria ter texto próprio`);
  }
});

test('os três níveis são os que a tela filtra', () => {
  assert.deepEqual(Object.values(LEVELS), ['INFO', 'AVISO', 'ERRO']);
});
