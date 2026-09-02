import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExportPlan, createAudioClip, createClip, formatTimecode, layoutTrack,
  moveClip, removeClip, timelineDuration, trackDuration, updateClip,
} from '../lib/timeline.js';

const timeline = () => ({
  video: [
    createClip({ id: 'v1', label: 'Cena 1', duration: 8 }),
    createClip({ id: 'v2', label: 'Cena 2', duration: 6 }),
    createClip({ id: 'v3', label: 'Cena 3', duration: 4 }),
  ],
  audio: [createAudioClip({ id: 'a1', label: 'Trilha', duration: 12 })],
});

test('a duração da timeline é a da trilha mais longa', () => {
  assert.equal(trackDuration(timeline().video), 18);
  assert.equal(trackDuration(timeline().audio), 12);
  assert.equal(timelineDuration(timeline()), 18);
});

test('o layout posiciona os clipes em sequência, sem buracos', () => {
  const layout = layoutTrack(timeline().video, 18);
  assert.deepEqual(layout.map((c) => c.start), [0, 8, 14]);
  assert.deepEqual(layout.map((c) => c.end), [8, 14, 18]);
  const soma = layout.reduce((acc, c) => acc + c.widthPercent, 0);
  assert.ok(Math.abs(soma - 100) < 0.001, 'as larguras devem somar 100%');
});

test('o layout de uma trilha mais curta não ocupa a régua inteira', () => {
  const layout = layoutTrack(timeline().audio, 18);
  assert.ok(layout[0].widthPercent < 100);
  assert.ok(Math.abs(layout[0].widthPercent - (12 / 18) * 100) < 0.001);
});

test('trilha vazia não quebra o layout', () => {
  assert.deepEqual(layoutTrack([], 0), []);
  assert.equal(timelineDuration({ video: [], audio: [] }), 0);
});

test('mover, remover e atualizar clipes', () => {
  assert.deepEqual(moveClip(timeline().video, 'v3', -1).map((c) => c.id), ['v1', 'v3', 'v2']);
  assert.deepEqual(moveClip(timeline().video, 'v1', -1).map((c) => c.id), ['v1', 'v2', 'v3']);
  assert.deepEqual(removeClip(timeline().video, 'v2').map((c) => c.id), ['v1', 'v3']);
  assert.equal(updateClip(timeline().video, 'v1', { duration: 20 })[0].duration, 20);
});

test('timecode formatado com frames', () => {
  assert.equal(formatTimecode(0), '00:00:00');
  assert.equal(formatTimecode(65.5, 24), '01:05:12');
});

test('o plano de exportação descreve a montagem sem executá-la', () => {
  const plan = buildExportPlan(timeline(), { fps: 30, output: 'final.mp4' });
  assert.equal(plan.executable, false, 'a fase 1 nunca pode executar');
  assert.equal(plan.totalDuration, 18);
  assert.equal(plan.inputs.length, 4);
  assert.equal(plan.fps, 30);
  assert.ok(plan.filterComplex.includes('concat=n=3'));
  assert.ok(plan.args.includes('-filter_complex'));
  assert.ok(plan.args.includes('final.mp4'));
});

test('o plano lida com timeline vazia', () => {
  const plan = buildExportPlan({ video: [], audio: [] });
  assert.equal(plan.inputs.length, 0);
  assert.equal(plan.filterComplex, '');
  assert.equal(plan.totalDuration, 0);
});
