// Vocabulário de eventos do agente do Showrunner.
//
// Este é o formato em que TODO runtime fala com o resto da aplicação. Não é o
// formato de nenhum runtime específico: é o nosso. Um adaptador traduz os
// eventos internos do runtime que ele encapsula para estes, e o que não couber
// aqui não atravessa.
//
// Módulo puro: nenhum I/O, nenhum estado, nenhuma dependência. Ele é o
// contrato, e um contrato que precisa de banco ou de rede para ser lido já
// deixou de ser contrato.
//
// A regra que dá valor a isto está em `normalizeAgentEvent`: o evento
// normalizado contém **apenas** os campos declarados para o seu tipo. Um
// adaptador pode anexar o que quiser ao evento que emite — id de sessão,
// contagem de tokens, nome do modelo, o que for interno dele — e nada disso
// sobrevive à normalização. É esse descarte, e não a boa vontade de quem
// escreve o adaptador, que impede o vocabulário de um runtime de vazar para a
// API pública e para a tela.

/** Evento fora do vocabulário, ou sem os campos que o próprio tipo exige. */
export class AgentEventError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'AgentEventError';
    this.detail = detail;
  }
}

/**
 * Os tipos de evento que existem.
 *
 * Nomes em ponto, do geral para o específico, porque é assim que eles vão
 * virar `event:` de SSE sem tradução quando o streaming chegar.
 */
export const AGENT_EVENTS = Object.freeze({
  STARTED: 'agent.started',
  STATUS: 'agent.status',
  MESSAGE_DELTA: 'agent.message.delta',
  MESSAGE_COMPLETED: 'agent.message.completed',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_FAILED: 'tool.failed',
  COMPLETED: 'agent.completed',
  FAILED: 'agent.failed',
});

export const AGENT_EVENT_TYPES = Object.freeze(Object.values(AGENT_EVENTS));

/**
 * O que cada tipo carrega.
 *
 * `required` é conferido; `optional` é preservado quando vem; qualquer outro
 * campo é descartado. Os três eventos de tool já estão declarados apesar de
 * nenhum runtime emiti-los nesta etapa — declarar não é implementar, e o
 * Passo 6 não deve precisar mexer no vocabulário para acontecer.
 */
const CAMPOS = Object.freeze({
  [AGENT_EVENTS.STARTED]: { required: [], optional: [] },
  [AGENT_EVENTS.STATUS]: { required: ['status'], optional: [] },
  [AGENT_EVENTS.MESSAGE_DELTA]: { required: ['text'], optional: [] },
  [AGENT_EVENTS.MESSAGE_COMPLETED]: { required: ['text'], optional: [] },
  [AGENT_EVENTS.TOOL_STARTED]: { required: ['toolCallId', 'name'], optional: ['arguments'] },
  [AGENT_EVENTS.TOOL_COMPLETED]: { required: ['toolCallId', 'name'], optional: ['result'] },
  [AGENT_EVENTS.TOOL_FAILED]: { required: ['toolCallId', 'name', 'error'], optional: [] },
  [AGENT_EVENTS.COMPLETED]: { required: [], optional: [] },
  [AGENT_EVENTS.FAILED]: { required: ['error'], optional: [] },
});

/** Campos que todo evento tem, independentemente do tipo. */
const CAMPOS_COMUNS = Object.freeze(['type', 'ts']);

export function isAgentEventType(tipo) {
  return Object.prototype.hasOwnProperty.call(CAMPOS, tipo);
}

/**
 * Monta um evento.
 *
 * `clock` é injetável pelo motivo de sempre nesta casa — sem ele um adaptador
 * determinístico deixaria de ser comparável entre execuções, porque o carimbo
 * de tempo mudaria a cada uma.
 */
export function createAgentEvent(type, payload = {}, clock = Date.now) {
  return normalizeAgentEvent({ ...payload, type, ts: clock() });
}

/**
 * Reduz um evento ao vocabulário: valida o tipo, exige os campos obrigatórios
 * e devolve um objeto **novo** contendo só o que foi declarado.
 *
 * Nunca devolve o objeto recebido, nem uma cópia rasa dele. É essa recusa em
 * copiar o resto que faz a fronteira existir.
 */
export function normalizeAgentEvent(evento) {
  if (!evento || typeof evento !== 'object') {
    throw new AgentEventError('Evento de agente inválido.', { recebido: typeof evento });
  }

  const { type } = evento;
  if (!isAgentEventType(type)) {
    throw new AgentEventError(
      `Tipo de evento fora do vocabulário do Showrunner: "${type}".`,
      { type, aceitos: AGENT_EVENT_TYPES },
    );
  }

  const { required, optional } = CAMPOS[type];

  const ausentes = required.filter((campo) => evento[campo] === undefined || evento[campo] === null);
  if (ausentes.length) {
    throw new AgentEventError(
      `O evento "${type}" exige ${ausentes.join(', ')}.`,
      { type, ausentes, exigidos: required },
    );
  }

  const normalizado = {
    type,
    ts: Number.isFinite(Number(evento.ts)) ? Number(evento.ts) : Date.now(),
  };
  for (const campo of required) normalizado[campo] = evento[campo];
  for (const campo of optional) {
    if (evento[campo] !== undefined) normalizado[campo] = evento[campo];
  }

  return normalizado;
}

/** Os campos que sobrevivem à normalização de um tipo — usado nos testes. */
export function declaredFieldsFor(type) {
  if (!isAgentEventType(type)) {
    throw new AgentEventError(`Tipo de evento desconhecido: "${type}".`, { type });
  }
  const { required, optional } = CAMPOS[type];
  return [...CAMPOS_COMUNS, ...required, ...optional];
}

/**
 * Forma de erro que os eventos de falha carregam.
 *
 * Sempre `{ message, code }` e nada mais: a pilha de um runtime, o corpo de uma
 * resposta HTTP dele ou o nome da sua classe de exceção são exatamente o tipo
 * de coisa que não pode chegar à tela do usuário.
 */
export function agentErrorPayload(erro, code = 'agent_error') {
  const message = typeof erro === 'string' ? erro : (erro?.message || 'Falha sem mensagem.');
  return { message, code: erro?.code || code };
}
