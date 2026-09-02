import test from 'node:test';
import assert from 'node:assert/strict';
import { MockProvider } from '../lib/providers/MockProvider.js';

const provider = new MockProvider({ latency: 0 });

test('gera a quantidade pedida de imagens, todas marcadas como simuladas', async () => {
  const results = await provider.generateImage({ prompt: 'teste', count: 4, seed: 1234, modelId: 'ideogram-4' });
  assert.equal(results.length, 4);
  results.forEach((item) => {
    assert.equal(item.simulated, true);
    assert.equal(item.kind, 'image');
    assert.equal(item.status, 'pendente');
    assert.ok(item.url.startsWith('data:image/svg+xml'), 'o quadro precisa ser local');
  });
  // seeds distintas por resultado
  assert.deepEqual(results.map((r) => r.seed), [1234, 1235, 1236, 1237]);
});

test('respeita limites de quantidade', async () => {
  assert.equal((await provider.generateImage({ count: 0 })).length, 1);
  assert.equal((await provider.generateImage({ count: 99 })).length, 8);
});

test('o vídeo simulado traz poster e quadros para o player', async () => {
  const [video] = await provider.generateVideo({ prompt: 'plano', seed: 99, duration: 8, modelId: 'minimax-h3' });
  assert.equal(video.kind, 'video');
  assert.equal(video.simulated, true);
  assert.equal(video.duration, 8);
  assert.equal(video.frames.length, 8);
  assert.ok(video.poster.startsWith('data:image/svg+xml'));
});

test('a mesma seed produz o mesmo quadro (determinismo)', async () => {
  const [a] = await provider.generateImage({ prompt: 'igual', seed: 777, count: 1 });
  const [b] = await provider.generateImage({ prompt: 'igual', seed: 777, count: 1 });
  assert.equal(a.url, b.url);

  const [c] = await provider.generateImage({ prompt: 'igual', seed: 778, count: 1 });
  assert.notEqual(a.url, c.url);
});

test('nenhum data URL gerado aponta para host externo', async () => {
  const results = await provider.generateImage({ prompt: 'sem rede', count: 2 });
  const [video] = await provider.generateVideo({ prompt: 'sem rede' });
  [...results.map((r) => r.url), video.poster, ...video.frames].forEach((url) => {
    const decoded = decodeURIComponent(url);
    assert.ok(!/https?:\/\/(?!www\.w3\.org)/.test(decoded), 'nenhuma origem remota é permitida');
  });
});
