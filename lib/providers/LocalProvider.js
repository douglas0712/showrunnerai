import { BaseProvider, NotImplementedError } from './BaseProvider.js';

/**
 * Modelos que rodam na própria máquina por um runtime dedicado
 * (Ideogram 4, MiniMax H3). O runtime existe, mas o acoplamento é fase 2 —
 * aqui apenas declaramos a capacidade e recusamos executar.
 */
export class LocalProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      id: 'local',
      label: 'Runtime local',
      runtime: 'local',
      description: 'Executa modelos instalados nesta máquina, sem enviar dados para fora.',
      ...options,
    });
    this.enabledModels = options.enabledModels || [];
  }

  isAvailable() {
    return false; // fase 1: capacidade declarada, execução ainda não conectada
  }

  unavailableReason() {
    return 'Runtime local reconhecido, mas a execução será conectada na fase 2.';
  }

  async testConnection() {
    return {
      ok: false,
      status: 'not-implemented',
      message: 'O runtime local será verificado na fase 2. Nenhuma checagem foi executada.',
      performedRequest: false,
    };
  }

  async generateImage(request) {
    throw new NotImplementedError(
      'Geração local de imagem entra na fase 2.',
      { providerId: this.id, modelId: request?.modelId },
    );
  }

  async generateVideo(request) {
    throw new NotImplementedError(
      'Geração local de vídeo entra na fase 2.',
      { providerId: this.id, modelId: request?.modelId },
    );
  }
}
