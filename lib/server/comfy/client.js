// Cliente HTTP do ComfyUI. Só o servidor da aplicação usa este módulo.

import { COMFY_BASE_URL } from './config.js';
import { recordExchange } from '../logs/context.js';
import { sanitizeRequestBody, sanitizeResponseBody, truncarTexto } from '../logs/sanitize.js';

export class ComfyError extends Error {
  constructor(message, { status = null, detail = null } = {}) {
    super(message);
    this.name = 'ComfyError';
    this.status = status;
    this.detail = detail;
  }
}

async function request(caminho, { method = 'GET', body = null, timeoutMs = 15000, raw = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const inicio = Date.now();

  // Toda troca é registrada no contexto do job corrente (quando há um). Fora de
  // um job — teste de conexão, por exemplo — `recordExchange` não faz nada.
  // Registrar aqui, e não em cada chamador, é o que garante que método, rota,
  // status e duração existam para qualquer requisição sem exceção.
  const registrar = (extra) => recordExchange({
    method,
    path: caminho,
    durationMs: Date.now() - inicio,
    request: body ? sanitizeRequestBody(body) : null,
    ...extra,
  });

  let resposta;
  try {
    resposta = await fetch(`${COMFY_BASE_URL}${caminho}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      cache: 'no-store',
    });
  } catch (error) {
    clearTimeout(timer);
    const abortado = error.name === 'AbortError';
    const mensagem = abortado
      ? `O ComfyUI não respondeu em ${timeoutMs / 1000}s (${caminho}).`
      : `Não foi possível falar com o ComfyUI em ${COMFY_BASE_URL}: ${error.message}`;
    registrar({ status: null, error: mensagem });
    throw new ComfyError(mensagem);
  }
  clearTimeout(timer);

  if (!resposta.ok) {
    let detalhe = null;
    try {
      detalhe = await resposta.text();
    } catch { /* sem corpo */ }
    registrar({ status: resposta.status, error: truncarTexto(detalhe || '', 400) || null });
    throw new ComfyError(`O ComfyUI respondeu ${resposta.status} em ${caminho}.`, {
      status: resposta.status,
      detail: detalhe?.slice(0, 800) || null,
    });
  }

  if (raw) {
    registrar({ status: resposta.status, response: '[fluxo — corpo não lido]' });
    return resposta;
  }

  const dados = await resposta.json();
  registrar({ status: resposta.status, response: sanitizeResponseBody(dados) });
  return dados;
}

export function systemStats() {
  return request('/system_stats', { timeoutMs: 8000 });
}

export function queue() {
  return request('/queue', { timeoutMs: 8000 });
}

export function objectInfo(nodeClass) {
  return request(`/object_info/${encodeURIComponent(nodeClass)}`, { timeoutMs: 10000 });
}

export function history(promptId) {
  return request(`/history/${encodeURIComponent(promptId)}`, { timeoutMs: 10000 });
}

/** Histórico recente inteiro — usado para recuperar resultados órfãos. */
export function historyList(maxItems = 50) {
  return request(`/history?max_items=${Number(maxItems) || 50}`, { timeoutMs: 15000 });
}

/** Enfileira o grafo. Devolve { prompt_id, number, node_errors }. */
export function submitPrompt(graph, clientIdValue) {
  return request('/prompt', {
    method: 'POST',
    timeoutMs: 30000,
    body: { prompt: graph, client_id: clientIdValue },
  });
}

/** Interrompe o job em execução (o ComfyUI não aceita alvo específico). */
export function interrupt() {
  return request('/interrupt', { method: 'POST', timeoutMs: 8000, raw: true }).then(() => true);
}

/** Remove um job ainda pendente da fila. */
export function deleteFromQueue(promptId) {
  return request('/queue', {
    method: 'POST',
    timeoutMs: 8000,
    raw: true,
    body: { delete: [promptId] },
  }).then(() => true);
}

/**
 * Tamanho do arquivo no ComfyUI, sem baixá-lo.
 *
 * Pede um único byte e lê o total do content-range. É o que permite esperar o
 * arquivo parar de crescer antes de copiar.
 */
export async function viewFileSize({ filename, subfolder = '', type = 'output' }) {
  const params = new URLSearchParams({ filename, subfolder, type });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  const inicio = Date.now();
  try {
    const resposta = await fetch(`${COMFY_BASE_URL}/view?${params.toString()}`, {
      headers: { range: 'bytes=0-0' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!resposta.ok) {
      recordExchange({
        method: 'GET',
        path: '/view',
        status: resposta.status,
        durationMs: Date.now() - inicio,
        error: 'tamanho indisponível',
      });
      return null;
    }
    const contentRange = resposta.headers.get('content-range');
    const match = /\/(\d+)$/.exec(contentRange || '');
    const total = match ? Number(match[1]) : Number(resposta.headers.get('content-length')) || null;
    recordExchange({
      method: 'GET',
      path: `/view (${filename})`,
      status: resposta.status,
      durationMs: Date.now() - inicio,
      response: { bytes: total },
    });
    return total;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envia uma imagem para o `input/` do ComfyUI.
 *
 * O ComfyUI espera multipart no campo `image`. Devolve `{name, subfolder,
 * type}` — é esse `name` que o nó LoadImage consome depois.
 *
 * `overwrite` é ligado de propósito: o nome é derivado do jobId, então
 * reenviar o mesmo quadro do mesmo job deve substituir, não acumular cópias
 * numeradas no disco do ComfyUI.
 */
export async function uploadImage({ bytes, filename, subfolder = '', mime = 'application/octet-stream', overwrite = true }) {
  const inicio = Date.now();
  const caminho = '/upload/image';

  const form = new FormData();
  form.append('image', new Blob([bytes], { type: mime }), filename);
  form.append('type', 'input');
  if (subfolder) form.append('subfolder', subfolder);
  if (overwrite) form.append('overwrite', 'true');

  // O corpo é binário: o que entra no log é o descritivo, nunca os bytes.
  const descricao = { filename, subfolder, mime, bytes: bytes?.length ?? 0 };

  let resposta;
  try {
    resposta = await fetch(`${COMFY_BASE_URL}${caminho}`, {
      method: 'POST',
      body: form,
      cache: 'no-store',
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    const mensagem = `Não foi possível enviar a imagem ao ComfyUI: ${error.message}`;
    recordExchange({
      method: 'POST', path: caminho, status: null, durationMs: Date.now() - inicio, request: descricao, error: mensagem,
    });
    throw new ComfyError(mensagem);
  }

  if (!resposta.ok) {
    let detalhe = null;
    try { detalhe = await resposta.text(); } catch { /* sem corpo */ }
    recordExchange({
      method: 'POST',
      path: caminho,
      status: resposta.status,
      durationMs: Date.now() - inicio,
      request: descricao,
      error: truncarTexto(detalhe || '', 400) || null,
    });
    throw new ComfyError(`O ComfyUI recusou a imagem (HTTP ${resposta.status}).`, {
      status: resposta.status,
      detail: detalhe?.slice(0, 800) || null,
    });
  }

  const dados = await resposta.json();
  recordExchange({
    method: 'POST',
    path: caminho,
    status: resposta.status,
    durationMs: Date.now() - inicio,
    request: descricao,
    response: sanitizeResponseBody(dados),
  });
  return dados;
}

/**
 * Confere que o ComfyUI enxerga a imagem recém-enviada.
 *
 * Sem isto, um upload aceito mas gravado em outro lugar só apareceria como
 * "arquivo não encontrado" lá na execução do grafo, minutos depois.
 *
 * Aceita as duas formas de nomear o arquivo porque as duas circulam por aqui:
 * `/upload/image` devolve `{name, subfolder, type}`, enquanto `viewFile` e
 * `viewFileSize` falam `filename`. Receber só uma delas silenciosamente — foi
 * o que aconteceu — transforma um upload perfeito num "não consigo localizar".
 */
export async function imageExists({ name = null, filename = null, subfolder = '', type = 'input' } = {}) {
  const alvo = filename || name;
  if (!alvo) return false;
  const tamanho = await viewFileSize({ filename: alvo, subfolder, type });
  return Number.isFinite(Number(tamanho)) && Number(tamanho) > 0;
}

/** Baixa o arquivo produzido. Devolve os bytes. */
export async function viewFile({ filename, subfolder = '', type = 'output' }) {
  const params = new URLSearchParams({ filename, subfolder, type });
  const resposta = await request(`/view?${params.toString()}`, { timeoutMs: 120000, raw: true });
  const buffer = await resposta.arrayBuffer();
  return Buffer.from(buffer);
}

export { COMFY_BASE_URL };
