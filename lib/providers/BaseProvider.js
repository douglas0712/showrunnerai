// Contrato comum a todos os providers.
//
// A ideia é que a UI nunca saiba *quem* executa: ela pede `generateImage` /
// `generateVideo` ao registry e recebe sempre o mesmo formato de resultado.
// Trocar Local por ComfyUI ou por uma API é trocar o provider, não a tela.

export class NotImplementedError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'NotImplementedError';
    this.meta = meta;
  }
}

export class BaseProvider {
  constructor({ id, label, runtime, description = '' }) {
    this.id = id;
    this.label = label;
    this.runtime = runtime;
    this.description = description;
  }

  /** O provider pode executar agora? */
  isAvailable() {
    return false;
  }

  /**
   * O provider entrega o resultado na própria chamada (`generateImage` /
   * `generateVideo`)? Providers baseados em fila — como o ComfyUI — respondem
   * `false`: eles submetem um job e são acompanhados por polling, então os
   * estúdios que esperam retorno imediato não podem usá-los.
   */
  supportsDirectGenerate() {
    return true;
  }

  /** Por que não está disponível (texto para a UI). */
  unavailableReason() {
    return 'Provider indisponível nesta fase.';
  }

  /**
   * Verificação de conexão. Na fase 1 nenhum provider faz I/O de rede:
   * todos devolvem um diagnóstico declarativo.
   */
  async testConnection() {
    return {
      ok: false,
      status: 'not-implemented',
      message: 'Verificação real de conexão será implementada na fase 2.',
      performedRequest: false,
    };
  }

  async generateImage() {
    throw new NotImplementedError(
      `O provider "${this.label}" ainda não executa geração de imagem.`,
      { providerId: this.id, phase: 1 },
    );
  }

  async generateVideo() {
    throw new NotImplementedError(
      `O provider "${this.label}" ainda não executa geração de vídeo.`,
      { providerId: this.id, phase: 1 },
    );
  }
}
