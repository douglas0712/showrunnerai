import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATES, findInQueue, findVideoOutput, interpretHistory, isTerminal,
  isVideoFile, normalizeProgress, phaseForNode,
} from '../lib/server/comfy/status.js';
import { NODE_IDS } from '../lib/server/comfy/config.js';

const PID = 'd534b1a3-9c1e-4aef-9fc4-5bb0344a956b';

test('localiza o prompt na fila do ComfyUI', () => {
  const rodando = { queue_running: [[1, PID, {}]], queue_pending: [] };
  assert.deepEqual(findInQueue(rodando, PID), { running: true, pending: false, position: 0 });

  const pendente = { queue_running: [], queue_pending: [[1, 'outro', {}], [2, PID, {}]] };
  assert.deepEqual(findInQueue(pendente, PID), { running: false, pending: true, position: 2 });

  const ausente = { queue_running: [], queue_pending: [] };
  assert.deepEqual(findInQueue(ausente, PID), { running: false, pending: false, position: null });

  assert.deepEqual(findInQueue(null, PID), { running: false, pending: false, position: null });
});

test('interpreta sucesso, erro e execução em andamento no histórico', () => {
  const sucesso = interpretHistory({
    status: { status_str: 'success', completed: true },
    outputs: { 92: { images: [{ filename: 'a.mp4', subfolder: 'video', type: 'output' }] } },
  });
  assert.equal(sucesso.finished, true);
  assert.equal(sucesso.success, true);
  assert.equal(sucesso.error, null);

  const erro = interpretHistory({
    status: {
      status_str: 'error',
      completed: false,
      messages: [['execution_error', { node_type: 'UNETLoader', exception_type: 'OOM', exception_message: 'sem VRAM' }]],
    },
  });
  assert.equal(erro.finished, true);
  assert.equal(erro.success, false);
  assert.match(erro.error, /UNETLoader/);
  assert.match(erro.error, /sem VRAM/);

  const andamento = interpretHistory({ status: { status_str: 'running', completed: false } });
  assert.equal(andamento.finished, false);

  const ausente = interpretHistory(undefined);
  assert.equal(ausente.finished, false);
});

test('erro sem mensagem detalhada ainda produz texto útil', () => {
  const erro = interpretHistory({ status: { status_str: 'error', completed: true, messages: [] } });
  assert.equal(erro.finished, true);
  assert.ok(erro.error.length > 0);
});

test('descobre o MP4 nas saídas mesmo publicado sob a chave "images"', () => {
  // Formato real observado no ComfyUI: SaveVideo publica em `images` com animated:true
  const outputs = {
    92: { images: [{ filename: 'showrunner_00001_.mp4', subfolder: 'video/showrunner', type: 'output' }], animated: [true] },
  };
  const achado = findVideoOutput(outputs, NODE_IDS.save);
  assert.deepEqual(achado, {
    nodeId: '92',
    filename: 'showrunner_00001_.mp4',
    subfolder: 'video/showrunner',
    type: 'output',
  });
});

test('ignora imagens e acha o vídeo em outro nó quando preciso', () => {
  const outputs = {
    50: { images: [{ filename: 'preview.png', subfolder: '', type: 'temp' }] },
    77: { videos: [{ filename: 'saida.webm', subfolder: 'video', type: 'output' }] },
  };
  const achado = findVideoOutput(outputs, NODE_IDS.save);
  assert.equal(achado.filename, 'saida.webm');
  assert.equal(achado.nodeId, '77');
});

test('sem vídeo nas saídas, devolve null', () => {
  assert.equal(findVideoOutput({ 92: { images: [{ filename: 'a.png' }] } }, NODE_IDS.save), null);
  assert.equal(findVideoOutput({}, NODE_IDS.save), null);
  assert.equal(findVideoOutput(null), null);
});

test('o nó do save tem prioridade sobre os demais', () => {
  const outputs = {
    77: { videos: [{ filename: 'outro.mp4', subfolder: '', type: 'output' }] },
    92: { images: [{ filename: 'oficial.mp4', subfolder: 'video', type: 'output' }] },
  };
  assert.equal(findVideoOutput(outputs, NODE_IDS.save).filename, 'oficial.mp4');
});

test('reconhece extensões de vídeo', () => {
  ['a.mp4', 'b.MP4', 'c.webm', 'd.mkv', 'e.mov'].forEach((f) => assert.ok(isVideoFile(f), f));
  ['a.png', 'b.jpg', 'c.txt', 'd.mp4.txt'].forEach((f) => assert.ok(!isVideoFile(f), f));
});

test('mapeia o nó em execução para a fase legível', () => {
  assert.equal(phaseForNode(NODE_IDS.save, NODE_IDS), STATES.SAVING);
  assert.equal(phaseForNode(NODE_IDS.createVideo, NODE_IDS), STATES.SAVING);
  assert.equal(phaseForNode('105:10', NODE_IDS), STATES.DECODING);
  assert.equal(phaseForNode('105:23', NODE_IDS), STATES.DECODING);
  assert.equal(phaseForNode('105:14', NODE_IDS), STATES.GENERATING);
  assert.equal(phaseForNode(null, NODE_IDS), null);
});

test('progresso normalizado fica entre 0 e 1', () => {
  assert.equal(normalizeProgress(5, 20), 0.25);
  assert.equal(normalizeProgress(0, 20), 0);
  assert.equal(normalizeProgress(25, 20), 1);
  assert.equal(normalizeProgress(1, 0), null);
  assert.equal(normalizeProgress('x', 20), null);
});

test('estados terminais são reconhecidos', () => {
  assert.ok(isTerminal(STATES.DONE) && isTerminal(STATES.FAILED) && isTerminal(STATES.CANCELLED));
  assert.ok(!isTerminal(STATES.QUEUED) && !isTerminal(STATES.GENERATING) && !isTerminal(STATES.SAVING));
});
