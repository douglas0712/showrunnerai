// Contexto do job em execução, propagado sem passar parâmetro.
//
// O cliente HTTP do ComfyUI (`comfy/client.js`) é o único ponto por onde passa
// todo o tráfego com o servidor — mas ele não conhece job nenhum. Em vez de
// costurar um parâmetro `jobId` por dez funções, o provider abre um contexto e
// o cliente lê o que estiver corrente.
//
// AsyncLocalStorage é o que torna isso correto com gerações simultâneas: cada
// cadeia assíncrona enxerga o próprio contexto, então o HTTP de um job nunca é
// atribuído a outro.

import { AsyncLocalStorage } from 'node:async_hooks';

const armazenamento = new AsyncLocalStorage();

/** Quantas trocas HTTP guardamos por contexto antes de descartar as antigas. */
const MAX_TROCAS = 5;

/**
 * Executa `fn` dentro de um contexto de job.
 * Contextos aninhados herdam o que não for sobrescrito.
 */
export function runInJobContext(contexto, fn) {
  const atual = currentJobContext();
  return armazenamento.run({ ...(atual || {}), ...contexto, trocas: [] }, fn);
}

export function currentJobContext() {
  return armazenamento.getStore() || null;
}

/** Atualiza o contexto corrente — usado quando o prompt_id só chega depois. */
export function updateJobContext(patch = {}) {
  const contexto = currentJobContext();
  if (contexto) Object.assign(contexto, patch);
  return contexto;
}

/**
 * Registra uma troca HTTP no contexto corrente. Sem contexto, não faz nada —
 * é o que mantém o cliente utilizável fora de um job (teste de conexão, por
 * exemplo) sem acumular lixo.
 */
export function recordExchange(troca) {
  const contexto = currentJobContext();
  if (!contexto) return null;
  contexto.trocas.push(troca);
  if (contexto.trocas.length > MAX_TROCAS) contexto.trocas.shift();
  return troca;
}

/** A troca HTTP mais recente do contexto — a que costuma explicar o evento. */
export function lastExchange() {
  const contexto = currentJobContext();
  if (!contexto?.trocas?.length) return null;
  return contexto.trocas[contexto.trocas.length - 1];
}

/**
 * A troca mais recente cuja rota casa com `padrao`.
 * Serve para o evento de fila citar o `/queue` e não o `/history` que veio depois.
 */
export function lastExchangeMatching(padrao) {
  const contexto = currentJobContext();
  if (!contexto?.trocas?.length) return null;
  for (let i = contexto.trocas.length - 1; i >= 0; i -= 1) {
    if (padrao.test(contexto.trocas[i].path || '')) return contexto.trocas[i];
  }
  return null;
}
