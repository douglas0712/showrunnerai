import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createRegistry, getProvider, intendedProviderFor, resolveExecutionProvider, API_VENDORS,
} from '../lib/providers/registry.js';
import { NotImplementedError } from '../lib/providers/BaseProvider.js';
import { isValidHttpUrl } from '../lib/providers/ComfyUIProvider.js';

test('o registry expõe os quatro tipos de provider', () => {
  const registry = createRegistry();
  assert.equal(registry.get('local').constructor.name, 'LocalProvider');
  assert.equal(registry.get('comfyui').constructor.name, 'ComfyUIProvider');
  assert.equal(registry.get('api').constructor.name, 'ApiProvider');
  assert.equal(registry.get('mock').constructor.name, 'MockProvider');
});

test('todo provedor por API declarado tem entrada no registry', () => {
  const registry = createRegistry();
  API_VENDORS.forEach((vendor) => {
    assert.ok(registry.get(vendor.id), `faltou o provider ${vendor.id}`);
  });
});

test('cada modelo aponta para o provider que realmente o executa', () => {
  const registry = createRegistry();
  // Fase 2: o MiniMax H3 passou a ser executado de verdade pelo ComfyUI.
  assert.equal(intendedProviderFor(registry, 'minimax-h3').id, 'comfyui');
  // O Ideogram 4 continua declarado como runtime local, ainda sem execução.
  assert.equal(intendedProviderFor(registry, 'ideogram-4').id, 'local');
  assert.equal(intendedProviderFor(registry, 'veo-3.1').id, 'api');
});

test('os estúdios de retorno imediato continuam na simulação, com motivo declarado', () => {
  const registry = createRegistry();
  // resolveExecutionProvider serve os estúdios que esperam o resultado na
  // própria chamada. O ComfyUI é assíncrono, então nem ele é escolhido aqui —
  // a geração real acontece pela aba Cinema, via submitVideo + polling.
  for (const modelId of ['ideogram-4', 'minimax-h3', 'veo-3.1', 'kling', 'seedance']) {
    const resolved = resolveExecutionProvider(registry, modelId);
    assert.equal(resolved.provider.id, 'mock', `${modelId} deveria cair na simulação`);
    assert.equal(resolved.simulated, true);
    assert.ok(resolved.reason.length > 0, `${modelId} deveria explicar o motivo`);
  }
  assert.match(resolveExecutionProvider(registry, 'minimax-h3').reason, /assíncrona|Cinema/);
});

test('providers reais recusam executar em vez de fingir geração', async () => {
  const registry = createRegistry();
  for (const id of ['local', 'api', 'veo']) {
    await assert.rejects(
      () => registry.get(id).generateImage({ modelId: 'x' }),
      NotImplementedError,
    );
    await assert.rejects(
      () => registry.get(id).generateVideo({ modelId: 'x' }),
      NotImplementedError,
    );
  }
});

test('só o ComfyUI faz I/O ao testar conexão; os demais seguem inertes', async () => {
  const registry = createRegistry();
  for (const id of ['local', 'api', 'veo', 'kling', 'seedance', 'muapi', 'mock']) {
    const result = await registry.get(id).testConnection();
    assert.equal(result.performedRequest, false, `${id} não deveria fazer I/O`);
  }

  // O ComfyUI é o único integrado na fase 2 — testar conexão é uma checagem real.
  const comfy = await registry.get('comfyui').testConnection();
  assert.equal(comfy.performedRequest, true);
  assert.ok('checks' in comfy, 'a verificação real precisa devolver a lista de checagens');
});

test('o ComfyUIProvider é assíncrono, guarda a URL e valida formatos de URL', () => {
  const registry = createRegistry({ comfyUrl: 'http://127.0.0.1:8188' });
  const provider = registry.get('comfyui');

  assert.equal(provider.baseUrl, 'http://127.0.0.1:8188');
  assert.equal(provider.isAvailable(), true, 'na fase 2 o ComfyUI está disponível');
  assert.equal(provider.supportsDirectGenerate(), false, 'a geração é por fila, não imediata');
  assert.equal(provider.capabilities.textToVideo, true);
  // first_frame e last_frame são entradas opcionais do MiniMaxH3ImageToVideo:
  // o mesmo grafo cobre os três modos, então as três capacidades andam juntas.
  assert.equal(provider.capabilities.imageToVideo, true);
  assert.equal(provider.capabilities.firstLastFrame, true);
  assert.equal(provider.capabilities.textToImage, false, 'texto → imagem continua fora');
  assert.equal(typeof provider.submitVideoWithFrames, 'function');

  assert.equal(isValidHttpUrl('http://127.0.0.1:8188'), true);
  assert.equal(isValidHttpUrl('https://exemplo.com'), true);
  assert.equal(isValidHttpUrl('ftp://x'), false);
  assert.equal(isValidHttpUrl('nao-e-url'), false);
});

test('o ComfyUIProvider recusa os caminhos que a fase 2 não cobre', async () => {
  const provider = createRegistry().get('comfyui');
  await assert.rejects(() => provider.generateImage({ modelId: 'ideogram-4' }), NotImplementedError);
  await assert.rejects(() => provider.generateVideo({ modelId: 'minimax-h3' }), NotImplementedError);
});

test('provider desconhecido cai na simulação em vez de quebrar', () => {
  const registry = createRegistry();
  assert.equal(getProvider(registry, 'inexistente').id, 'mock');
});
