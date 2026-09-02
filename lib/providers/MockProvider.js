import { BaseProvider } from './BaseProvider.js';
import { placeholderFrame } from '../placeholder.js';
import { makeId, randomSeed } from '../rng.js';

/**
 * Provider de demonstração da fase 1.
 *
 * Produz resultados simulados desenhados localmente (SVG determinístico), com
 * uma latência artificial para exercitar os estados de carregamento da UI.
 * Não executa modelo algum e não acessa a rede — todo resultado vem marcado
 * com `simulated: true` para que nenhuma tela possa apresentá-lo como real.
 */
export class MockProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      id: 'mock',
      label: 'Simulação local',
      runtime: 'mock',
      description: 'Gera pré-visualizações simuladas para avaliar a interface.',
      ...options,
    });
    this.latency = options.latency ?? 900;
  }

  isAvailable() {
    return true;
  }

  unavailableReason() {
    return '';
  }

  async testConnection() {
    return {
      ok: true,
      status: 'ok',
      message: 'Simulação local ativa. Nenhuma conexão externa é usada.',
      performedRequest: false,
    };
  }

  async generateImage(request = {}) {
    const {
      prompt = '',
      aspect = '16:9',
      resolution = '2K',
      seed = randomSeed(),
      count = 1,
      modelId = null,
      intendedProviderId = null,
    } = request;

    await delay(this.latency);

    return Array.from({ length: clamp(count, 1, 8) }, (_, i) => ({
      id: makeId('img'),
      kind: 'image',
      simulated: true,
      modelId,
      intendedProviderId,
      providerId: this.id,
      prompt,
      aspect,
      resolution,
      seed: seed + i,
      status: 'pendente',
      revisionNote: '',
      createdAt: Date.now(),
      url: placeholderFrame({
        seed: seed + i,
        prompt,
        aspect,
        kind: 'image',
        label: 'SIMULAÇÃO',
      }),
    }));
  }

  async generateVideo(request = {}) {
    const {
      prompt = '',
      aspect = '16:9',
      resolution = '1080p',
      duration = 6,
      fps = 24,
      audio = false,
      seed = randomSeed(),
      mode = 't2v',
      modelId = null,
      intendedProviderId = null,
    } = request;

    await delay(this.latency * 1.4);

    const poster = placeholderFrame({
      seed,
      prompt,
      aspect,
      kind: 'video',
      label: 'SIMULAÇÃO',
    });

    return [
      {
        id: makeId('vid'),
        kind: 'video',
        simulated: true,
        modelId,
        intendedProviderId,
        providerId: this.id,
        prompt,
        aspect,
        resolution,
        duration,
        fps,
        audio,
        mode,
        seed,
        status: 'pendente',
        revisionNote: '',
        createdAt: Date.now(),
        poster,
        // Quadros pré-desenhados: o player simulado percorre esta lista.
        frames: Array.from({ length: 8 }, (_, i) =>
          placeholderFrame({
            seed,
            prompt,
            aspect,
            kind: 'video',
            label: 'SIMULAÇÃO',
            frame: i / 7,
          }),
        ),
      },
    ];
  }
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || min));
}
