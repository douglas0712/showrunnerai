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
//
// ── E a resposta de ERRO também ─────────────────────────────────────────────
//
// Uma falha do runtime é a resposta que mais tenta contar coisas. A mensagem
// de `unavailableReason()` é escrita para quem OPERA — ela nomeia a variável
// que falta, o adaptador que não subiu — e o `detail` de
// `RuntimeUnavailableError` carrega o id do adaptador. Nada disso é assunto de
// quem está conversando, e tudo isso atravessava até aqui.
//
// Então a camada do runtime tem uma única forma pública: a frase do produto,
// sem `detail`. O diagnóstico continua inteiro onde ele serve — no log do
// servidor, que o gateway já escreve, e em `runtimeDiagnostics()`, que se
// anuncia como diagnóstico. O que o cliente ganha para decidir é o `code`,
// que é estável e não nomeia nada.

import {
  AGENT_NAME, AgentTurnError, createThread, DomainError, getThread,
  listThreads, sendMessage, streamMessage, ThreadNotFoundError,
} from './gateway.js';
import {
  AgentRuntimeError, RuntimeContractError, RuntimeUnavailableError,
} from './AgentRuntimePort.js';
import { AgentEventError } from './events.js';

/** Identidade que acompanha toda resposta de conversa. */
export const agentIdentity = Object.freeze({ agentName: AGENT_NAME });

/** POST /api/agent/threads */
export function handleCreateThread(corpo, deps = {}) {
  if (!ehObjeto(corpo)) return erro(400, 'Corpo inválido.');

  const { projectId = null, title = null, project = null } = corpo;

  if (projectId !== null && projectId !== undefined && typeof projectId !== 'string') {
    return erro(400, 'projectId inválido.');
  }
  if (title !== null && title !== undefined && typeof title !== 'string') {
    return erro(400, 'title inválido.');
  }

  // O descritor do projeto que a interface está mostrando. Só a FORMA é
  // conferida aqui; o que ele significa — registrar um projeto que o usuário já
  // tem na tela — é decisão do gateway, e está explicada lá.
  if (project !== null && project !== undefined) {
    if (!ehObjeto(project) || typeof project.id !== 'string' || !project.id.trim()) {
      return erro(400, 'project inválido.');
    }
    for (const campo of ['name', 'description', 'aspect']) {
      if (project[campo] !== undefined && typeof project[campo] !== 'string') {
        return erro(400, `project.${campo} inválido.`);
      }
    }
  }

  return executar(() => {
    const thread = createThread({ projectId, title, project }, deps);
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
 * POST /api/agent/stream — o mesmo turno, evento a evento.
 *
 * Devolve um AsyncIterable de `{ event, data }`, que a rota serializa como SSE.
 * O vocabulário é o de `events.js` e nada além dele: o navegador nunca vê o
 * protocolo do runtime, nem sabe que existe um.
 *
 * A validação do corpo acontece ANTES de qualquer evento sair, para que um
 * pedido malformado vire status HTTP — e não um fluxo aberto que emite um erro
 * como primeiro evento, que é bem mais difícil de tratar do lado do cliente.
 *
 * Erros DEPOIS do primeiro evento não têm mais status HTTP disponível: o
 * cabeçalho já foi. Viram um `agent.failed` sanitizado no fluxo, que é o que o
 * vocabulário já tem para dizer exatamente isso.
 */
export function handleStreamMessage(corpo, deps = {}) {
  if (!ehObjeto(corpo)) return erro(400, 'Corpo inválido.');

  const { threadId, content } = corpo;
  if (typeof threadId !== 'string' || !threadId) return erro(400, 'threadId inválido.');
  if (typeof content !== 'string') return erro(400, 'content inválido.');

  return {
    status: 200,
    stream: (async function* () {
      try {
        for await (const evento of streamMessage({ threadId, content, ...(deps.signal ? { signal: deps.signal } : {}) }, deps)) {
          yield { event: evento.type, data: evento };
        }
      } catch (falha) {
        // A mensagem do usuário permanece; nenhuma resposta é inventada. O
        // cliente recebe o mesmo tipo de evento que um runtime emitiria ao
        // falhar, com texto já sanitizado por `respostaDeErro`.
        const { body } = respostaDeErro(falha);
        yield {
          event: 'agent.failed',
          data: {
            type: 'agent.failed',
            ts: Date.now(),
            error: { message: body.error, code: codigoDaFalha(falha) },
          },
        };
      }
    }()),
  };
}

/** Um código estável para o cliente decidir o que dizer. Nunca o nome da classe. */
function codigoDaFalha(falha) {
  if (falha instanceof RuntimeUnavailableError) return 'runtime_unavailable';
  if (falha instanceof ThreadNotFoundError) return 'thread_not_found';
  if (falha instanceof AgentTurnError) return 'agent_turn_failed';
  if (falha instanceof DomainError) return 'invalid_request';
  return 'agent_error';
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
 * A frase que o usuário lê quando o agente não pode atender.
 *
 * Ela é deliberadamente igual para "não configurado", "não responde" e "falhou
 * no meio do turno": as três são a mesma coisa do ponto de vista de quem está
 * conversando, e distingui-las na tela só ensinaria ao usuário um vocabulário
 * de infraestrutura que não é dele. Qual das três foi está no log.
 */
export const MENSAGEM_AGENTE_INDISPONIVEL = 'O assistente de criação está temporariamente indisponível.';

/**
 * Corpo de erro.
 *
 * `detail` sai apenas quando o erro o traz como dado estruturado nosso. Pilha,
 * corpo de resposta de terceiro e nome de classe de exceção não saem daqui.
 *
 * Falha da camada de runtime é a exceção: ela sai como a frase do produto e
 * sem `detail` nenhum. É onde moram o id do adaptador e o texto de operador —
 * ver o cabeçalho deste arquivo.
 */
function respostaDeErro(falha) {
  const status = statusForError(falha);

  if (falha instanceof AgentRuntimeError) {
    return { status, body: { error: MENSAGEM_AGENTE_INDISPONIVEL } };
  }

  const body = { error: falha?.message || 'Falha desconhecida.' };
  if (falha?.detail && typeof falha.detail === 'object') body.detail = falha.detail;
  return { status, body };
}

const erro = (status, mensagem) => ({ status, body: { error: mensagem } });

const ehObjeto = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
