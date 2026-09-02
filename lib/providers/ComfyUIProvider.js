import { BaseProvider, NotImplementedError } from './BaseProvider.js';

/**
 * Ponte para o ComfyUI — lado do navegador.
 *
 * IMPORTANTE: este provider nunca fala com o ComfyUI diretamente. Ele chama as
 * rotas internas em `/api/comfy/*`, que rodam no servidor da aplicação e são as
 * únicas com acesso ao ComfyUI, ao workflow em disco e ao armazenamento.
 *
 * A implementação real vive em `lib/server/comfy/provider.js`.
 */
export class ComfyUIProvider extends BaseProvider {
  constructor(options = {}) {
    super({
      id: 'comfyui',
      label: 'ComfyUI (local)',
      runtime: 'local',
      description: 'Executa o MiniMax H3 numa instância local do ComfyUI.',
      ...options,
    });
    this.baseUrl = options.baseUrl || 'http://127.0.0.1:8188';
    // O nó MiniMaxH3ImageToVideo declara first_frame e last_frame como
    // entradas opcionais, então o mesmo grafo cobre os três modos.
    this.capabilities = {
      textToVideo: true,
      imageToVideo: true,
      firstLastFrame: true,
      textToImage: false,
    };
  }

  isAvailable() {
    return true;
  }

  /** A geração é uma fila: submete, acompanha, finaliza. */
  supportsDirectGenerate() {
    return false;
  }

  unavailableReason() {
    return 'A geração real com o ComfyUI é assíncrona e está na aba Cinema.';
  }

  /** Verificação real, executada pelo servidor. */
  async testConnection() {
    try {
      const resposta = await fetch('/api/comfy/test', { method: 'POST' });
      const dados = await resposta.json();
      return {
        ok: Boolean(dados.ok),
        status: dados.ok ? 'ok' : 'indisponivel',
        message: dados.message || 'Sem resposta.',
        performedRequest: true,
        checks: dados.checks || [],
        baseUrl: dados.baseUrl || this.baseUrl,
      };
    } catch (error) {
      return {
        ok: false,
        status: 'erro',
        message: `Não foi possível consultar o servidor da aplicação: ${error.message}`,
        performedRequest: true,
        checks: [],
      };
    }
  }

  /**
   * Submete uma geração com quadros — imagem → vídeo ou primeiro/último quadro.
   *
   * Vai como multipart para a mesma rota do texto → vídeo: é o mesmo pipeline,
   * a mesma fila e o mesmo acompanhamento por prompt_id. Os arquivos do usuário
   * seguem como estão; o navegador não os reescreve.
   */
  async submitVideoWithFrames(params = {}, frames = {}) {
    const form = new FormData();
    for (const [chave, valor] of Object.entries(params)) {
      if (valor !== null && valor !== undefined) form.append(chave, String(valor));
    }
    if (frames.first) form.append('firstFrame', frames.first, frames.first.name);
    if (frames.last) form.append('lastFrame', frames.last, frames.last.name);

    const resposta = await fetch('/api/comfy/generate', { method: 'POST', body: form });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.error || 'Falha ao submeter a geração.');
    return dados;
  }

  /** Submete uma geração texto → vídeo. Devolve o job; não espera o resultado. */
  async submitVideo(params = {}) {
    const resposta = await fetch('/api/comfy/generate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.error || 'Falha ao submeter a geração.');
    return dados;
  }

  /**
   * Jobs conhecidos pelo servidor. Com `recover`, adota resultados que já
   * existem no ComfyUI mas ainda não chegaram à aplicação — sem regerar nada.
   */
  async listJobs({ projectId = null, recover = false } = {}) {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (recover) params.set('recover', '1');
    const resposta = await fetch(`/api/comfy/jobs?${params.toString()}`, { cache: 'no-store' });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.error || 'Falha ao listar os jobs.');
    return dados;
  }

  async pollJob(jobId) {
    const resposta = await fetch(`/api/comfy/status?jobId=${encodeURIComponent(jobId)}`, {
      cache: 'no-store',
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.error || 'Falha ao consultar o status.');
    return dados;
  }

  async finalizeJob(jobId) {
    const resposta = await fetch('/api/comfy/result', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.error || 'Falha ao obter o resultado.');
    return dados;
  }

  async cancelJob(jobId) {
    const resposta = await fetch('/api/comfy/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jobId }),
    });
    const dados = await resposta.json();
    if (!resposta.ok) throw new Error(dados.error || 'Falha ao cancelar.');
    return dados;
  }

  async generateImage(request) {
    throw new NotImplementedError('A fase 2 cobre apenas texto → vídeo na aba Cinema.', {
      providerId: this.id,
      modelId: request?.modelId,
    });
  }

  /** A aba Cinema usa `submitVideo` + polling; este atalho não se aplica. */
  async generateVideo() {
    throw new NotImplementedError(
      'Use submitVideo()/submitVideoWithFrames() e acompanhe o job — a geração real é assíncrona.',
      { providerId: this.id },
    );
  }
}

export function isValidHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
