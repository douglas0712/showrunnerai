// Enriquecimento de progresso via websocket do ComfyUI.
//
// É deliberadamente "melhor esforço": o estado do job é decidido pelo polling
// HTTP em provider.js. Se o socket não conectar, cair ou for removido em uma
// versão futura do ComfyUI, a geração continua funcionando — apenas sem a
// barra de progresso fina por passo do sampler.

import { COMFY_BASE_URL } from './config.js';
import { NODE_IDS } from './config.js';
import { clientId, getJobByPromptId, updateJob } from './jobs.js';
import { STATES, STATE_LABELS, normalizeProgress, phaseForNode } from './status.js';
import { logError, logInfo, logWarn } from '../logs/logger.js';
import { STAGES } from '../logs/stages.js';

/**
 * O sampler emite progresso a cada passo. Registrar todos afogaria o buffer,
 * então só marcamos os quartos — o suficiente para ver que avançou e quando.
 */
const PASSO_DO_PROGRESSO = 0.25;

const CHAVE = Symbol.for('showrunner.comfy.socket');

function slot() {
  if (!globalThis[CHAVE]) globalThis[CHAVE] = { socket: null, connecting: false, lastError: null };
  return globalThis[CHAVE];
}

/** Abre a conexão se ainda não houver uma. Nunca lança. */
export function ensureEventStream() {
  const s = slot();
  if (s.socket || s.connecting) return;
  if (typeof WebSocket === 'undefined') {
    s.lastError = 'WebSocket indisponível neste runtime.';
    return;
  }

  s.connecting = true;
  try {
    const url = `${COMFY_BASE_URL.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId())}`;
    const socket = new WebSocket(url);

    socket.onopen = () => {
      s.socket = socket;
      s.connecting = false;
      s.lastError = null;
    };

    socket.onmessage = (evento) => {
      if (typeof evento.data !== 'string') return; // binário = preview, ignoramos
      try {
        handleEvent(JSON.parse(evento.data));
      } catch { /* mensagem inesperada: ignoramos */ }
    };

    socket.onerror = () => {
      s.lastError = 'Falha no websocket do ComfyUI.';
    };

    socket.onclose = () => {
      s.socket = null;
      s.connecting = false;
    };
  } catch (error) {
    s.connecting = false;
    s.lastError = error.message;
  }
}

export function eventStreamStatus() {
  const s = slot();
  return { connected: Boolean(s.socket), lastError: s.lastError };
}

function handleEvent(mensagem) {
  const { type, data } = mensagem || {};
  if (!type || !data) return;

  const promptId = data.prompt_id;
  if (!promptId) return;

  const job = getJobByPromptId(promptId);
  if (!job || job.finishedAt) return;

  switch (type) {
    case 'execution_start':
      updateJob(job.jobId, { state: STATES.GENERATING, startedAt: job.startedAt || Date.now() });
      logInfo(STAGES.GENERATING, 'O ComfyUI começou a executar o grafo.', {
        jobId: job.jobId,
        promptId,
        http: null,
      });
      break;

    case 'executing':
      if (data.node) {
        const fase = phaseForNode(data.node, NODE_IDS);
        if (fase !== job.state) {
          logInfo(STAGES.GENERATING, `Fase: ${STATE_LABELS[fase] || fase} (nó ${data.node}).`, {
            jobId: job.jobId,
            promptId,
            http: null,
            detail: { nodeId: data.node, fase },
          });
        }
        updateJob(job.jobId, { node: data.node, state: fase });
      }
      break;

    case 'progress': {
      const progresso = normalizeProgress(data.value, data.max);
      if (progresso === null) break;

      const ultimoMarco = job.progressoRegistrado ?? 0;
      const marco = Math.floor(progresso / PASSO_DO_PROGRESSO) * PASSO_DO_PROGRESSO;
      if (marco > ultimoMarco) {
        logInfo(STAGES.GENERATING, `Progresso: ${Math.round(progresso * 100)}%.`, {
          jobId: job.jobId,
          promptId,
          http: null,
          detail: { progresso, passo: data.value, passos: data.max, nodeId: job.node },
        });
        updateJob(job.jobId, { progressoRegistrado: marco });
      }
      updateJob(job.jobId, { progress: progresso });
      break;
    }

    case 'execution_error': {
      const mensagem = [data.node_type, data.exception_message].filter(Boolean).join(' — ') || 'Falha na execução.';
      updateJob(job.jobId, { state: STATES.FAILED, error: mensagem });
      logError(STAGES.GENERATING, mensagem, {
        jobId: job.jobId,
        promptId,
        http: null,
        detail: {
          nodeId: data.node_id ?? null,
          nodeType: data.node_type ?? null,
          excecao: data.exception_type ?? null,
          traceback: Array.isArray(data.traceback) ? data.traceback.join('') : data.traceback ?? null,
        },
      });
      break;
    }

    case 'execution_interrupted':
      updateJob(job.jobId, { state: STATES.CANCELLED });
      logWarn(STAGES.CANCELLED, 'A execução foi interrompida no ComfyUI.', {
        jobId: job.jobId,
        promptId,
        http: null,
      });
      break;

    default:
      break;
  }
}
