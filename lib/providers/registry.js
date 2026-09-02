// Registry de providers.
//
// Ponto único onde a UI resolve "quem executa isto". Trocar de backend é
// registrar outro provider aqui — nenhuma tela referencia um fornecedor
// específico.

import { LocalProvider } from './LocalProvider.js';
import { ComfyUIProvider } from './ComfyUIProvider.js';
import { ApiProvider } from './ApiProvider.js';
import { MockProvider } from './MockProvider.js';
import { getModel } from '../models.js';

export const API_VENDORS = [
  { id: 'veo', label: 'Veo', vendor: 'Google', optional: false },
  { id: 'kling', label: 'Kling', vendor: 'Kuaishou', optional: false },
  { id: 'seedance', label: 'Seedance', vendor: 'ByteDance', optional: false },
  { id: 'muapi', label: 'MuAPI', vendor: 'MuAPI', optional: true },
];

/**
 * Monta o conjunto de providers a partir das configurações do usuário.
 * @param {object} settings
 */
export function createRegistry(settings = {}) {
  const providers = new Map();

  providers.set(
    'local',
    new LocalProvider({ enabledModels: settings.localModels || [] }),
  );

  providers.set(
    'comfyui',
    new ComfyUIProvider({ baseUrl: settings.comfyUrl || 'http://127.0.0.1:8188' }),
  );

  API_VENDORS.forEach((vendor) => {
    providers.set(
      vendor.id,
      new ApiProvider({
        id: vendor.id,
        label: vendor.label,
        vendor: vendor.vendor,
        optional: vendor.optional,
        configured: Boolean(settings.apiProviders?.[vendor.id]?.configured),
      }),
    );
  });

  // `api` é o alias genérico usado pelo catálogo enquanto o modelo não aponta
  // para um fornecedor específico.
  providers.set('api', new ApiProvider({ id: 'api', label: 'Provedor por API' }));
  providers.set('mock', new MockProvider());

  return providers;
}

export function getProvider(registry, providerId) {
  return registry.get(providerId) || registry.get('mock');
}

/** Provider que o modelo usaria numa instalação completa. */
export function intendedProviderFor(registry, modelId) {
  const model = getModel(modelId);
  if (!model) return getProvider(registry, 'mock');
  return getProvider(registry, model.providerId);
}

/**
 * Provider que realmente executa agora.
 *
 * Fase 1: se o provider pretendido não pode executar, caímos na simulação —
 * de forma explícita, devolvendo também o motivo, para que a UI possa dizer ao
 * usuário o que aconteceu em vez de fingir uma geração real.
 */
export function resolveExecutionProvider(registry, modelId) {
  const intended = intendedProviderFor(registry, modelId);
  if (intended.isAvailable() && intended.supportsDirectGenerate()) {
    return { provider: intended, intended, simulated: false, reason: '' };
  }
  return {
    provider: getProvider(registry, 'mock'),
    intended,
    simulated: true,
    reason: intended.unavailableReason(),
  };
}

export { LocalProvider, ComfyUIProvider, ApiProvider, MockProvider };
