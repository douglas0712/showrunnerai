import { BaseProvider, NotImplementedError } from './BaseProvider.js';

/**
 * Provedores remotos (Veo, Kling, Seedance e, opcionalmente, agregadores).
 *
 * Nenhuma credencial é exigida para abrir ou navegar na plataforma: sem
 * credencial o provider apenas se declara "não configurado". Na fase 1 ele
 * nunca faz I/O — o padrão submeter → consultar fica documentado abaixo para a
 * fase 2.
 */
export class ApiProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      id: options.id || 'api',
      label: options.label || 'Provedor por API',
      runtime: 'api',
      description: 'Encaminha a geração para um serviço remoto.',
      ...options,
    });
    this.vendor = options.vendor || null;
    this.configured = Boolean(options.configured);
    this.optional = Boolean(options.optional);
  }

  isAvailable() {
    return false; // nunca executa na fase 1, mesmo se configurado
  }

  unavailableReason() {
    return this.configured
      ? 'Provedor configurado, mas a execução remota entra na fase 2.'
      : 'Provedor não configurado. Nenhuma credencial é necessária nesta fase.';
  }

  async testConnection() {
    return {
      ok: false,
      status: this.configured ? 'not-implemented' : 'not-configured',
      message: this.configured
        ? 'Credencial presente. A checagem remota será feita na fase 2 — nenhuma requisição foi enviada.'
        : 'Sem credencial. Nada foi enviado para nenhum serviço externo.',
      performedRequest: false,
    };
  }

  async generateImage(request) {
    throw new NotImplementedError('Geração remota entra na fase 2.', {
      providerId: this.id,
      modelId: request?.modelId,
    });
  }

  async generateVideo(request) {
    throw new NotImplementedError('Geração remota entra na fase 2.', {
      providerId: this.id,
      modelId: request?.modelId,
    });
  }
}
