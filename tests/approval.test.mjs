import test from 'node:test';
import assert from 'node:assert/strict';
import {
  APPROVAL, applyApproval, applyRevisionRequest, canAddToTimeline, timelineBlockReason,
} from '../lib/approval.js';

const videoReal = () => ({
  id: 'vid_1',
  kind: 'video',
  real: true,
  mediaUrl: '/api/media/video/proj/cinema_1.mp4',
  status: APPROVAL.PENDING,
  revisionNote: '',
});

test('vídeo recém-gerado NÃO pode ir para a timeline', () => {
  const item = videoReal();
  assert.equal(canAddToTimeline(item), false);
  assert.match(timelineBlockReason(item), /Aprove o vídeo/);
});

test('só depois de aprovar a timeline é liberada', () => {
  const aprovado = applyApproval(videoReal());
  assert.equal(aprovado.status, APPROVAL.APPROVED);
  assert.equal(canAddToTimeline(aprovado), true);
  assert.equal(timelineBlockReason(aprovado), '');
});

test('pedir alteração bloqueia de novo e preserva o vídeo', () => {
  const aprovado = applyApproval(videoReal());
  const revisado = applyRevisionRequest(aprovado, 'mais movimento de câmera');

  assert.equal(revisado.status, APPROVAL.REVISION);
  assert.equal(canAddToTimeline(revisado), false);
  assert.match(timelineBlockReason(revisado), /alteração pedida/);

  // O arquivo anterior continua acessível — nada é apagado.
  assert.equal(revisado.mediaUrl, aprovado.mediaUrl);
  assert.equal(revisado.preserved, true);
  assert.equal(revisado.revisionNote, 'mais movimento de câmera');
});

test('aprovar depois de uma revisão limpa a nota', () => {
  const revisado = applyRevisionRequest(videoReal(), 'trocar a luz');
  const reaprovado = applyApproval(revisado);
  assert.equal(reaprovado.revisionNote, '');
  assert.equal(canAddToTimeline(reaprovado), true);
});

test('aprovado sem arquivo continua bloqueado', () => {
  const semArquivo = { status: APPROVAL.APPROVED, kind: 'video' };
  assert.equal(canAddToTimeline(semArquivo), false);
  assert.match(timelineBlockReason(semArquivo), /ainda não tem arquivo/);
});

test('item ausente é tratado sem quebrar', () => {
  assert.equal(canAddToTimeline(null), false);
  assert.equal(canAddToTimeline(undefined), false);
  assert.match(timelineBlockReason(null), /Nenhum resultado/);
  assert.equal(applyApproval(null), null);
  assert.equal(applyRevisionRequest(null), null);
});

test('a simulação também respeita o portão de aprovação', () => {
  const simulado = { kind: 'video', simulated: true, poster: 'data:image/svg+xml,x', status: APPROVAL.PENDING };
  assert.equal(canAddToTimeline(simulado), false);
  assert.equal(canAddToTimeline(applyApproval(simulado)), true);
});
