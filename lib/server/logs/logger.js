// Emissão de eventos de diagnóstico.
//
// Este é o único módulo que o resto do servidor chama. Ele monta o evento,
// sanitiza, correlaciona com o job corrente e entrega ao buffer e ao arquivo.
//
// Nada aqui lança. Um log que quebra a geração que deveria explicar seria pior
// do que log nenhum.

import {
  currentJobContext, lastExchange, lastExchangeMatching,
} from './context.js';
import { persistEvent } from './persist.js';
import { logStore } from './store.js';
import {
  CHANNELS, LEVELS, explainFailure, retryKindForStage, stageLabel,
} from './stages.js';
import {
  nomeDeArquivo, sanitize, sanitizeStack, truncarTexto,
} from './sanitize.js';

/**
 * Registra um evento.
 *
 * `jobId`, `promptId` e `workflow` são herdados do contexto corrente quando não
 * vierem explícitos — é assim que cada linha fica amarrada ao job certo mesmo
 * com gerações simultâneas.
 */
export function logEvent({
  level = LEVELS.INFO,
  stage = null,
  channel = CHANNELS.COMFY,
  message = '',
  userHint = null,
  jobId = null,
  promptId = null,
  workflow = null,
  detail = null,
  http = undefined,
  error = null,
} = {}) {
  try {
    const contexto = currentJobContext();

    const evento = {
      ts: new Date().toISOString(),
      tsMs: Date.now(),
      level,
      channel,
      stage,
      stageLabel: stageLabel(stage),
      jobId: jobId || contexto?.jobId || null,
      promptId: promptId || contexto?.promptId || null,
      workflow: nomeDeArquivo(workflow || contexto?.workflow) || null,
      message: truncarTexto(message, 400),
      userHint: userHint || (level === LEVELS.ERROR ? explainFailure(stage, message) : null),
      retryKind: level === LEVELS.ERROR ? retryKindForStage(stage) : null,
      detail: montarDetalhe({ detail, http, error, contexto }),
    };

    const gravado = logStore().append(evento);
    persistEvent(gravado);
    return gravado;
  } catch {
    return null;
  }
}

/**
 * Monta a seção de detalhes técnicos.
 *
 * `http` explícito vence; `http: null` desliga a anexação; ausente significa
 * "use a última troca HTTP do contexto", que é o caso comum.
 */
function montarDetalhe({ detail, http, error, contexto }) {
  const base = detail ? sanitize(detail) : {};

  const troca = http === undefined ? lastExchange() : http;
  if (troca) base.http = sanitize(troca);

  if (error) {
    const stack = sanitizeStack(error);
    if (stack) base.stack = stack;
    if (error?.status != null) base.httpStatus = error.status;
    if (error?.detail) base.comfyDetail = truncarTexto(error.detail, 800);
  }

  if (contexto?.jobId && base.durationMs === undefined && contexto.iniciadoEm) {
    base.durationMs = Date.now() - contexto.iniciadoEm;
  }

  return Object.keys(base).length ? base : null;
}

export const logInfo = (stage, message, extras = {}) =>
  logEvent({ ...extras, level: LEVELS.INFO, stage, message });

export const logWarn = (stage, message, extras = {}) =>
  logEvent({ ...extras, level: LEVELS.WARN, stage, message });

/**
 * Registra uma falha. Aceita Error ou string; a explicação para o usuário sai
 * de `stages.js` a menos que venha pronta em `extras.userHint`.
 */
export function logError(stage, erro, extras = {}) {
  const mensagem = typeof erro === 'string' ? erro : (erro?.message || 'Falha sem mensagem.');
  return logEvent({
    ...extras,
    level: LEVELS.ERROR,
    stage,
    message: mensagem,
    error: typeof erro === 'string' ? null : erro,
  });
}

/** A última troca HTTP cuja rota casa com o padrão — para citar a certa. */
export const trocaDe = (padrao) => lastExchangeMatching(padrao);

/**
 * Mede uma operação e devolve `{ resultado, durationMs }`.
 * Em caso de erro, anexa a duração ao próprio erro antes de repropagar.
 */
export async function withTiming(fn) {
  const inicio = Date.now();
  try {
    const resultado = await fn();
    return { resultado, durationMs: Date.now() - inicio };
  } catch (erro) {
    if (erro && typeof erro === 'object') erro.durationMs = Date.now() - inicio;
    throw erro;
  }
}

export { LEVELS, CHANNELS };
