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

// ── a borda pública ─────────────────────────────────────────────────────────
//
// A normalização acima garante que só campos DECLARADOS atravessam. Ela não
// garante o que vai DENTRO deles — e `result` é um objeto inteiro vindo de uma
// ferramenta.
//
// Aqui esse objeto é reduzido pela última vez, agora para o navegador. Duas
// reduções, porque são duas fronteiras diferentes e com donos diferentes:
//
//   tradutor → AgentEvent    o que a APLICAÇÃO pode ver de uma ferramenta.
//                            Inclui o `jobId`, e precisa incluir: é dele que o
//                            gateway monta a amarração entre a geração que o
//                            turno começou e a mensagem que o turno gravou.
//
//   AgentEvent → navegador   o que a CONVERSA mostra. O `jobId` é o nome do
//                            trabalho dentro do servidor; a tela não faz nada
//                            com ele, e o que ela não usa não tem por que
//                            atravessar.
//
// Foi por não existir a segunda que um identificador interno aparecia no SSE.
// A ordem importa: o gateway lê o evento INTERNO para saber o que acompanhar, e
// só depois entrega a versão pública. Recuperar o jobId do evento já sanitizado
// seria fazer a autonomia depender da superfície que existe para escondê-lo.

/** Do Asset, o que a conversa mostra. Lista fechada. */
const CAMPOS_PUBLICOS_DE_ASSET = Object.freeze([
  'id', 'kind', 'mediaUrl', 'mimeType', 'derivedFromAssetId',
]);

/**
 * A versão de um evento que pode chegar ao navegador.
 *
 * Devolve o MESMO objeto quando não há nada a tirar — é o que permite a quem
 * chama testar identidade, e evita copiar um fluxo inteiro de deltas à toa.
 *
 * Duas reduções acontecem:
 *
 * `tool.completed` — o `result` vira apenas o Asset, quando existe um. Sai o
 * `jobId` (identificador interno) e sai o `status` (vocabulário do gerador:
 * "na-fila", "decodificando", "salvando"). Nada disso a tela usa: a mídia ela
 * tira do Asset, e o andamento de uma produção ela lê do estado de produção da
 * conversa, que já fala em linguagem de produto.
 *
 * `tool.started` — saem os `arguments`. Eles são o que o modelo escreveu, e
 * numa consulta de andamento o que ele escreve é justamente o `jobId`. A tela
 * nunca os leu.
 */
export function publicAgentEvent(evento) {
  if (!evento || typeof evento !== 'object') return evento;

  if (evento.type === AGENT_EVENTS.TOOL_STARTED) {
    if (evento.arguments === undefined) return evento;
    const { arguments: _internos, ...publico } = evento;
    return publico;
  }

  if (evento.type !== AGENT_EVENTS.TOOL_COMPLETED) return evento;
  if (evento.result === undefined) return evento;

  const { result: _bruto, ...publico } = evento;
  const asset = assetPublico(evento.result?.asset);
  // Sem Asset não sobra nada que valha mostrar, e o evento sai SEM `result` —
  // que é uma forma que o vocabulário já previa e que o cliente já trata.
  if (asset) publico.result = { asset };
  return publico;
}

/** O Asset reduzido aos campos da lista fechada, ou `null`. */
function assetPublico(asset) {
  if (!asset || typeof asset !== 'object' || typeof asset.id !== 'string') return null;

  const saida = {};
  for (const campo of CAMPOS_PUBLICOS_DE_ASSET) {
    saida[campo] = asset[campo] ?? null;
  }
  return saida;
}

/** Os campos do Asset que atravessam para a tela — usado nos testes. */
export function declaredAssetFields() {
  return [...CAMPOS_PUBLICOS_DE_ASSET];
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
