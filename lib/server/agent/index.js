// Ponto de entrada da camada de agente.
//
// Quem consome o agente importa daqui. As rotas usam `httpApi.js`; qualquer
// outro consumidor de servidor usa o gateway.
//
// O que este barril NÃO exporta é tão intencional quanto o que ele exporta:
// `createRuntime` e a tabela de runtimes ficam fora. Quem chama o gateway não
// escolhe runtime — a escolha é de operador, por variável de ambiente, e o
// único caminho legítimo para injetar outro é o parâmetro `deps` do gateway,
// que existe para teste e para composição interna. É a mesma razão pela qual
// `ensureProject` está deliberadamente fora do barril do domínio.

export {
  AGENT_NAME,
  AgentTurnError,
  createThread,
  getThread,
  listThreads,
  runtimeDiagnostics,
  sendMessage,
  ThreadNotFoundError,
} from './gateway.js';

export {
  AGENT_EVENTS,
  AGENT_EVENT_TYPES,
  AgentEventError,
  normalizeAgentEvent,
} from './events.js';

export {
  AgentRuntimeError,
  assertRuntimePort,
  RuntimeContractError,
  RuntimeUnavailableError,
} from './AgentRuntimePort.js';

export {
  AGENT_MESSAGE_STATUS,
  AGENT_ROLES,
  AGENT_THREAD_STATUS,
  MAX_MESSAGE_LENGTH,
} from './threads.js';
