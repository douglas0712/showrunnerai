// Agent Gateway — o orquestrador de um turno de conversa.
//
// É por aqui que o Showrunner fala com o agente, e é a única porta. O runtime
// fica atrás dele; a UI fica na frente. Nenhum dos dois enxerga o outro.
//
// ── O que ele faz ───────────────────────────────────────────────────────────
//
//   valida a entrada
//   carrega a thread
//   confere que o runtime está utilizável
//   persiste a mensagem do usuário
//   carrega o histórico, em ordem
//   chama AgentRuntimePort.run()
//   normaliza cada evento que sai de lá
//   persiste a resposta do assistente
//   devolve o resultado
//
// ── O que ele NÃO faz, e não deve passar a fazer ────────────────────────────
//
// Não fala com o ComfyUI. Não conhece nó, grafo, workflow, modelo, MiniMax nem
// Ideogram. Não conhece runtime nenhum pelo nome — nem o Echo. Não importa
// React, componente, StudioContext, localStorage nem `next/server`: as rotas
// importam o gateway, jamais o contrário, e é isso que o mantém testável com
// `node:test` como o resto do servidor.
//
// Quando o agente ganhar ferramentas (Passo 6), quem as executa é este arquivo
// — mas chamando a camada de geração, nunca o ComfyUI direto.

import { database, DomainError } from '../domain/db.js';
import { getProject } from '../domain/projects.js';
import { CHANNELS, STAGES } from '../logs/stages.js';
import { logError, logInfo } from '../logs/logger.js';
import {
  assertRuntimeAvailable, assertRuntimePort, AgentTurnError, describeRuntime,
} from './AgentRuntimePort.js';
import { AGENT_EVENTS, agentErrorPayload, normalizeAgentEvent } from './events.js';
import { createRuntime } from './runtimes.js';
import {
  appendMessageRecord, createThreadRecord, getThreadRecord,
  listMessageRecords, listThreadRecords, MAX_MESSAGE_LENGTH,
} from './threads.js';

/**
 * O nome que o usuário vê. Sempre este.
 *
 * O produto é o Showrunner; qual runtime raciocina por trás é detalhe de
 * instalação, e o usuário não tem por que aprender essa palavra. Nenhuma
 * resposta desta camada carrega o id do adaptador — ele só aparece em
 * `runtimeDiagnostics()`, que é diagnóstico e se anuncia como tal.
 */
export const AGENT_NAME = 'Showrunner';

/** A conversa não existe. */
export class ThreadNotFoundError extends Error {
  constructor(threadId) {
    super(`Conversa desconhecida: "${threadId}".`);
    this.name = 'ThreadNotFoundError';
    this.detail = { threadId };
  }
}

export { AgentTurnError, DomainError, MAX_MESSAGE_LENGTH };

/**
 * Dependências de uma chamada.
 *
 * Mesmo padrão do resto do servidor: último parâmetro com padrão. É o que
 * permite um teste abrir um banco em memória e oferecer outro runtime sem
 * mocking — e é a mesma costura por onde o HermesRuntimeAdapter vai entrar.
 */
function resolverDeps({ db = database(), runtime = null } = {}) {
  return { db, runtime };
}

// ── threads ─────────────────────────────────────────────────────────────────

/**
 * Cria uma conversa.
 *
 * `projectId` é opcional. Quando vem, o projeto precisa existir: nenhum
 * projeto é criado como efeito colateral de abrir uma conversa. A verificação
 * é feita aqui, além da chave estrangeira, para que a falha tenha nome.
 */
export function createThread(entrada = {}, deps = {}) {
  const { db } = resolverDeps(deps);
  const { projectId = null, title = null } = entrada;

  if (projectId !== null && projectId !== undefined && projectId !== '') {
    if (!getProject(String(projectId), db)) {
      throw new DomainError(`Projeto desconhecido: "${projectId}".`, { projectId });
    }
  }

  const thread = createThreadRecord({ projectId, title: title ?? undefined }, db);

  logInfo(STAGES.AGENT_THREAD_CREATED, 'Conversa criada.', {
    channel: CHANNELS.AGENT,
    detail: { threadId: thread.id, projectId: thread.projectId },
  });

  return thread;
}

/** A conversa e suas mensagens, em ordem. Lança se a thread não existe. */
export function getThread(threadId, deps = {}) {
  const { db } = resolverDeps(deps);

  const thread = getThreadRecord(threadId, db);
  if (!thread) throw new ThreadNotFoundError(threadId);

  return { thread, messages: listMessageRecords(threadId, db) };
}

/** Conversas conhecidas, mais recentes primeiro. */
export function listThreads(filtro = {}, deps = {}) {
  const { db } = resolverDeps(deps);
  return listThreadRecords(filtro, db);
}

// ── o turno ─────────────────────────────────────────────────────────────────

/**
 * Um turno completo: a fala do usuário entra, a resposta do agente sai.
 *
 * ── Sobre a ordem das operações ─────────────────────────────────────────────
 *
 * A disponibilidade do runtime é conferida ANTES de qualquer escrita. Um
 * agente desligado não é um turno que falhou: é um turno que não começou, e
 * gravar a fala do usuário para depois não ter o que responder deixaria a
 * conversa com uma pergunta pendurada que nada vai concluir.
 *
 * ── Sobre a falha no meio do turno ──────────────────────────────────────────
 *
 * Se o runtime falhar depois de o turno começar, a mensagem do usuário
 * PERMANECE — ela foi realmente dita — e NENHUMA mensagem de assistente é
 * criada. Nem vazia, nem parcial, nem marcada como falha. Deltas já recebidos
 * são descartados. Uma resposta só vira linha no banco quando o runtime diz
 * `agent.message.completed`; qualquer política mais frouxa acabaria escrevendo
 * na conversa palavras que o agente não terminou de dizer.
 */
export async function sendMessage(entrada = {}, deps = {}) {
  const { db, runtime: injetado } = resolverDeps(deps);
  const { threadId, content, signal = null } = entrada;

  const runtime = injetado ? assertRuntimePort(injetado) : createRuntime();

  const thread = getThreadRecord(threadId, db);
  if (!thread) throw new ThreadNotFoundError(threadId);

  const texto = validarConteudo(content, threadId);

  // Antes de escrever qualquer coisa.
  assertRuntimeAvailable(runtime);

  const userMessage = appendMessageRecord({
    threadId, role: 'user', content: texto, status: 'completed',
  }, db);

  const messages = listMessageRecords(threadId, db);

  logInfo(STAGES.AGENT_TURN_STARTED, 'Turno iniciado.', {
    channel: CHANNELS.AGENT,
    detail: {
      threadId,
      projectId: thread.projectId,
      messageId: userMessage.id,
      // O conteúdo não entra inteiro no log: é o que o usuário escreveu, e o
      // diagnóstico precisa do tamanho e do começo, não do texto todo.
      caracteres: texto.length,
      historico: messages.length,
    },
  });

  const contexto = {
    agentName: AGENT_NAME,
    threadId: thread.id,
    projectId: thread.projectId,
  };

  let events;
  try {
    logInfo(STAGES.AGENT_RUNTIME_STARTED, 'Runtime iniciado.', {
      channel: CHANNELS.AGENT,
      detail: { threadId, historico: messages.length, tools: 0 },
    });

    events = await consumirEventos(runtime.run({
      thread,
      messages,
      context: contexto,
      // Vazia nesta etapa, e presente de propósito: o Passo 6 acrescenta
      // conteúdo a este argumento, não um argumento novo.
      tools: [],
      signal,
    }));
  } catch (erro) {
    return falharTurno(erro, { threadId, thread, userMessage });
  }

  const resposta = respostaDosEventos(events);
  if (resposta === null) {
    return falharTurno(
      new AgentTurnError('O agente terminou sem produzir resposta.', { threadId }),
      { threadId, thread, userMessage },
    );
  }

  const assistantMessage = appendMessageRecord({
    threadId, role: 'assistant', content: resposta, status: 'completed',
  }, db);

  logInfo(STAGES.AGENT_TURN_COMPLETED, 'Resposta concluída.', {
    channel: CHANNELS.AGENT,
    detail: {
      threadId,
      messageId: assistantMessage.id,
      caracteres: resposta.length,
      eventos: events.length,
    },
  });

  return {
    thread: getThreadRecord(threadId, db),
    userMessage,
    assistantMessage,
    events,
  };
}

/**
 * Drena o iterador do runtime, normalizando cada evento.
 *
 * A normalização é a fronteira: o que sai daqui contém só campos do vocabulário
 * do Showrunner, então nada de um runtime chega ao banco, à API ou à tela sem
 * ter sido traduzido primeiro. Um evento fora do vocabulário derruba o turno
 * em vez de passar adiante — é o que impede a tradução de ser esquecida.
 *
 * O turno inteiro é drenado antes de responder porque a API desta etapa é
 * síncrona. Quando o SSE existir, é este laço que vira repasse — o contrato do
 * adaptador já é o de um fluxo, e ele não muda.
 */
async function consumirEventos(iteravel) {
  const fluxo = await iteravel;

  if (!fluxo || typeof fluxo[Symbol.asyncIterator] !== 'function') {
    throw new AgentTurnError('O runtime não devolveu um fluxo de eventos.', {});
  }

  const eventos = [];
  for await (const bruto of fluxo) {
    const evento = normalizeAgentEvent(bruto);
    eventos.push(evento);

    if (evento.type === AGENT_EVENTS.FAILED) {
      throw new AgentTurnError(evento.error?.message || 'O agente falhou.', {
        code: evento.error?.code || null,
      });
    }
  }
  return eventos;
}

/** O texto da resposta, ou `null` se o turno não concluiu nenhuma mensagem. */
function respostaDosEventos(eventos) {
  for (let i = eventos.length - 1; i >= 0; i -= 1) {
    if (eventos[i].type === AGENT_EVENTS.MESSAGE_COMPLETED) return eventos[i].text;
  }
  return null;
}

/** Registra a falha e a repropaga já no vocabulário desta camada. */
function falharTurno(erro, { threadId, thread, userMessage }) {
  logError(STAGES.AGENT_TURN_FAILED, erro, {
    channel: CHANNELS.AGENT,
    detail: {
      threadId,
      projectId: thread?.projectId ?? null,
      messageId: userMessage?.id ?? null,
      // Fica registrado que a fala do usuário sobreviveu e que nenhuma
      // resposta foi inventada — é a garantia que este caminho existe para dar.
      assistantMessageCriada: false,
    },
  });

  if (erro instanceof AgentTurnError) throw erro;

  const { message, code } = agentErrorPayload(erro, 'agent_runtime_failed');
  throw new AgentTurnError(message, { threadId, code });
}

function validarConteudo(content, threadId) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new DomainError('A mensagem está vazia.', { threadId });
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new DomainError(
      `A mensagem excede ${MAX_MESSAGE_LENGTH} caracteres.`,
      { threadId, caracteres: content.length, limite: MAX_MESSAGE_LENGTH },
    );
  }
  return content;
}

// ── diagnóstico ─────────────────────────────────────────────────────────────

/**
 * Estado do runtime configurado — para a tela de diagnóstico, não para a
 * conversa.
 *
 * Este é o ÚNICO lugar desta camada que devolve o id do adaptador, e ele se
 * anuncia como diagnóstico no nome. Nenhuma outra função daqui cita runtime.
 */
export async function runtimeDiagnostics(deps = {}) {
  const { runtime: injetado } = resolverDeps(deps);

  let runtime;
  try {
    runtime = injetado ? assertRuntimePort(injetado) : createRuntime();
  } catch (erro) {
    return { agentName: AGENT_NAME, runtime: null, ok: false, error: erro.message };
  }

  const retrato = describeRuntime(runtime);
  const conexao = await runtime.testConnection();

  return {
    agentName: AGENT_NAME,
    runtime: retrato,
    ok: Boolean(retrato.available && conexao?.ok),
    detail: conexao?.detail ?? null,
  };
}
