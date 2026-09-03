// AgentRuntimePort — o contrato que todo runtime de agente precisa cumprir.
//
// O Showrunner é o produto; o runtime que raciocina é peça trocável. Este
// arquivo é o único lugar onde essa troca está descrita, e o gateway conhece
// apenas o que está aqui.
//
// O projeto é JavaScript e continua sendo: o contrato é documentado neste
// cabeçalho e conferido em tempo de execução por `assertRuntimePort`, na
// fronteira onde um runtime entra na aplicação. Não há tipo estático a
// introduzir por causa de quatro métodos.
//
// ── O contrato ──────────────────────────────────────────────────────────────
//
//   id                  string  — identificador INTERNO do adaptador ('echo').
//                                 Serve a diagnóstico. Nunca sai numa resposta
//                                 normal da API: o usuário enxerga Showrunner.
//
//   isAvailable()       → boolean
//                         Barato e síncrono. Responde "dá para tentar?" sem
//                         tocar na rede. Um adaptador remoto responde com base
//                         na configuração que tem, não numa sondagem.
//
//   unavailableReason() → string | null
//                         Por que não dá. `null` quando está disponível. É o
//                         texto que explica a falha a quem operou.
//
//   testConnection()    → Promise<{ ok: boolean, detail?: object }>
//                         Diagnóstico ativo, sob demanda. Pode falar com a
//                         rede. NÃO é chamado no caminho de uma conversa.
//
//   run({ thread, messages, context, tools, invokeTool, signal })
//                       → AsyncIterable<AgentEvent> (ou Promise dela)
//
// ── Por que `run` devolve um AsyncIterable ──────────────────────────────────
//
// Não há SSE nesta etapa, e a rota devolve JSON de uma vez. Mesmo assim o
// contrato é o de um fluxo, porque a alternativa — devolver a resposta pronta —
// é justamente o desenho que obrigaria a reescrever todo adaptador no dia em
// que a primeira palavra precisar chegar à tela antes da última.
//
// Hoje o gateway drena o iterador inteiro e grava o resultado. Amanhã uma rota
// SSE consome o MESMO iterador repassando cada evento. O adaptador não muda.
//
// ── Os argumentos de `run` ──────────────────────────────────────────────────
//
//   thread    { id, projectId, title, status, ... } — a conversa.
//   messages  AgentMessage[] em ordem cronológica, JÁ incluindo a mensagem do
//             usuário deste turno. É a última da lista.
//   context   dados do Showrunner que o runtime pode usar (projectId, nome do
//             agente). Nunca nós de workflow, nunca caminho de arquivo.
//   tools     coleção de ferramentas oferecidas. Nesta etapa sempre `[]`. O
//             parâmetro existe para que o Passo 6 seja uma mudança de conteúdo,
//             não de contrato. PASSO 6: lista de { name, description, inputSchema }
//             SEM execute — apenas definições públicas.
//   invokeTool função async para o runtime solicitar execução de ferramenta.
//             Assinatura: async (name: string, args: object) → result
//             O runtime nunca vê o execute(); essa função é o único ponto de
//             invocação. PASSO 6: presente e operacional.
//   signal    AbortSignal | null — cancelamento. Nenhuma infraestrutura nova de
//             cancelamento foi criada aqui; o que existe é o lugar por onde ela
//             passará, e um adaptador que o ignore continua correto hoje.

import { AGENT_EVENT_TYPES } from './events.js';

/** Base das falhas desta camada. */
export class AgentRuntimeError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'AgentRuntimeError';
    this.detail = detail;
  }
}

/**
 * O runtime existe mas não pode ser usado agora — ou o id pedido não
 * corresponde a runtime nenhum. É uma falha de configuração, não da conversa:
 * mapeia para 503, e o turno não chega a começar.
 */
export class RuntimeUnavailableError extends AgentRuntimeError {
  constructor(message, detail = {}) {
    super(message, detail);
    this.name = 'RuntimeUnavailableError';
  }
}

/** O objeto oferecido como runtime não cumpre o contrato. */
export class RuntimeContractError extends AgentRuntimeError {
  constructor(message, detail = {}) {
    super(message, detail);
    this.name = 'RuntimeContractError';
  }
}

/** O runtime falhou durante o turno. */
export class AgentTurnError extends AgentRuntimeError {
  constructor(message, detail = {}) {
    super(message, detail);
    this.name = 'AgentTurnError';
  }
}

/** Os métodos exigidos, na ordem em que o contrato acima os descreve. */
export const RUNTIME_METHODS = Object.freeze([
  'isAvailable', 'unavailableReason', 'testConnection', 'run',
]);

/** Vocabulário que um runtime pode emitir — o mesmo para todos, por definição. */
export { AGENT_EVENT_TYPES };

/**
 * Confere o contrato e devolve o próprio runtime.
 *
 * Chamado na fronteira: quando um runtime é construído e quando o gateway
 * recebe um. Um objeto quase-certo que falha só no meio de um turno já custou
 * a mensagem do usuário; falhar aqui custa nada.
 */
export function assertRuntimePort(runtime, rotulo = 'runtime') {
  if (!runtime || typeof runtime !== 'object') {
    throw new RuntimeContractError(
      `O ${rotulo} de agente precisa ser um objeto.`,
      { recebido: typeof runtime },
    );
  }

  if (typeof runtime.id !== 'string' || !runtime.id.trim()) {
    throw new RuntimeContractError(`O ${rotulo} de agente precisa declarar um id.`, {});
  }

  const faltando = RUNTIME_METHODS.filter((m) => typeof runtime[m] !== 'function');
  if (faltando.length) {
    throw new RuntimeContractError(
      `O ${rotulo} "${runtime.id}" não implementa: ${faltando.join(', ')}.`,
      { id: runtime.id, faltando, exigidos: [...RUNTIME_METHODS] },
    );
  }

  return runtime;
}

/**
 * Retrato do runtime para DIAGNÓSTICO.
 *
 * O `id` do adaptador aparece aqui e em lugar nenhum mais. Quem chama isto é
 * quem está depurando a instalação — não a conversa.
 */
export function describeRuntime(runtime) {
  assertRuntimePort(runtime);
  const disponivel = Boolean(runtime.isAvailable());
  return {
    id: runtime.id,
    available: disponivel,
    unavailableReason: disponivel ? null : (runtime.unavailableReason() || null),
  };
}

/**
 * Garante que o runtime está utilizável, ou lança com o motivo.
 *
 * Deliberadamente separado de `run`: a checagem acontece ANTES de qualquer
 * escrita no banco, para que um runtime desligado não deixe metade de um turno
 * gravado.
 */
export function assertRuntimeAvailable(runtime) {
  assertRuntimePort(runtime);
  if (runtime.isAvailable()) return runtime;

  throw new RuntimeUnavailableError(
    runtime.unavailableReason() || 'O agente não está disponível no momento.',
    { runtimeId: runtime.id },
  );
}
