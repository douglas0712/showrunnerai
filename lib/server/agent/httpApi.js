// A API do agente, sem HTTP.
//
// Mesmo movimento de generation/mediaServing.js, e pelo mesmo motivo: o que
// mora dentro de uma Route Handler não é alcançável por teste, porque
// `next/server` não resolve fora do build do Next. Então a decisão — o que é
// válido, o que o corpo precisa ter, qual status uma falha vira — fica aqui, e
// a rota fica com o que só ela pode fazer: ler o corpo e montar a resposta.
//
// Cada `handle*` devolve `{ status, body }`. Nenhum objeto de Request, nenhum
// Response, nenhum import do Next.
//
// O último parâmetro `deps` é a costura de sempre: a rota chama sem ele e cai
// no banco e no runtime da aplicação; o teste passa um banco em memória e o
// runtime que quiser exercitar. Nenhum dos dois precisa de mocking.
//
// ── A forma pública ─────────────────────────────────────────────────────────
//
// O que sai daqui fala de Showrunner. `agentName` é sempre "Showrunner", e
// nada na resposta normal nomeia o runtime que produziu o texto — o usuário
// não tem por que aprender qual adaptador está instalado, e uma UI que
// aprendesse esse nome passaria a depender dele.

import {
  AGENT_NAME, AgentTurnError, createThread, DomainError, getThread,
  listThreads, sendMessage, ThreadNotFoundError,
} from './gateway.js';
import { RuntimeContractError, RuntimeUnavailableError } from './AgentRuntimePort.js';
import { AgentEventError } from './events.js';

/** Identidade que acompanha toda resposta de conversa. */
export const agentIdentity = Object.freeze({ agentName: AGENT_NAME });

/** POST /api/agent/threads */
export function handleCreateThread(corpo, deps = {}) {
  if (!ehObjeto(corpo)) return erro(400, 'Corpo inválido.');

  const { projectId = null, title = null } = corpo;

  if (projectId !== null && projectId !== undefined && typeof projectId !== 'string') {
    return erro(400, 'projectId inválido.');
  }
  if (title !== null && title !== undefined && typeof title !== 'string') {
    return erro(400, 'title inválido.');
  }

  return executar(() => {
    const thread = createThread({ projectId, title }, deps);
    return { status: 201, body: { ...agentIdentity, thread, messages: [] } };
  });
}

/** GET /api/agent/threads */
export function handleListThreads(params = {}, deps = {}) {
  return executar(() => {
    const filtro = 'projectId' in params && params.projectId !== undefined
      ? { projectId: params.projectId === null ? null : String(params.projectId) }
      : {};
    return { status: 200, body: { ...agentIdentity, threads: listThreads(filtro, deps) } };
  });
}

/** GET /api/agent/threads/[threadId] */
export function handleGetThread(threadId, deps = {}) {
  if (typeof threadId !== 'string' || !threadId) return erro(400, 'threadId inválido.');

  return executar(() => {
    const { thread, messages } = getThread(threadId, deps);
    return { status: 200, body: { ...agentIdentity, thread, messages } };
  });
}

/**
 * POST /api/agent/messages
 *
 * Uma chamada, uma resposta JSON. Não há SSE nesta etapa — mas os eventos
 * normalizados do turno acompanham a resposta, porque eles já são o formato em
 * que o streaming vai chegar, e uma UI escrita contra eles hoje não precisa
 * ser reescrita depois.
 */
export async function handleSendMessage(corpo, deps = {}) {
  if (!ehObjeto(corpo)) return erro(400, 'Corpo inválido.');

  const { threadId, content } = corpo;

  if (typeof threadId !== 'string' || !threadId) return erro(400, 'threadId inválido.');
  if (typeof content !== 'string') return erro(400, 'content inválido.');

  return executarAsync(async () => {
    const turno = await sendMessage({ threadId, content }, deps);
    return {
      status: 200,
      body: {
        ...agentIdentity,
        thread: turno.thread,
        userMessage: turno.userMessage,
        assistantMessage: turno.assistantMessage,
        events: turno.events,
      },
    };
  });
}

/**
 * Falha → status HTTP.
 *
 * 422 para referência a algo que não existe (o projeto), pelo mesmo critério
 * que já mapeia WorkflowError na geração: o pedido está bem formado, mas não é
 * satisfazível. 404 fica reservado para a própria conversa pedida — se as duas
 * ausências virassem 404, o cliente não saberia qual dos dois identificadores
 * está errado.
 *
 * 503 para runtime indisponível: é configuração da instalação, não do pedido,
 * e tentar de novo mais tarde é a ação certa. 502 para runtime que aceitou o
 * turno e falhou no meio dele.
 */
export function statusForError(falha) {
  if (falha instanceof ThreadNotFoundError) return 404;
  if (falha instanceof RuntimeUnavailableError) return 503;
  if (falha instanceof AgentTurnError) return 502;
  // Evento fora do vocabulário é defeito do adaptador, não do pedido.
  if (falha instanceof AgentEventError) return 502;
  if (falha instanceof RuntimeContractError) return 500;
  if (falha instanceof DomainError) {
    return /desconhecid[oa]/i.test(falha.message) ? 422 : 400;
  }
  return 500;
}

function executar(fn) {
  try {
    return fn();
  } catch (falha) {
    return respostaDeErro(falha);
  }
}

async function executarAsync(fn) {
  try {
    return await fn();
  } catch (falha) {
    return respostaDeErro(falha);
  }
}

/**
 * Corpo de erro.
 *
 * `detail` sai apenas quando o erro o traz como dado estruturado nosso. Pilha,
 * corpo de resposta de terceiro e nome de classe de exceção não saem daqui.
 */
function respostaDeErro(falha) {
  const status = statusForError(falha);
  const body = { error: falha?.message || 'Falha desconhecida.' };
  if (falha?.detail && typeof falha.detail === 'object') body.detail = falha.detail;
  return { status, body };
}

const erro = (status, mensagem) => ({ status, body: { error: mensagem } });

const ehObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
