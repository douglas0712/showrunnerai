// Seleção do runtime de agente.
//
// Este arquivo é o único ponto do servidor que sabe QUAIS runtimes existem. O
// gateway não sabe: ele recebe um objeto que cumpre o AgentRuntimePort e não
// pergunta de onde veio. A API não sabe: ela chama o gateway.
//
// Acrescentar um runtime é acrescentar uma linha na tabela abaixo e um arquivo
// em adapters/. Nem o gateway, nem o domínio, nem a API mudam — e é exatamente
// essa a promessa que esta etapa existe para provar.
//
// Não há registry dinâmico, nem `registerRuntime()`, nem plugin: uma tabela
// literal resolve o problema inteiro, e um registry vazio seria abstração sem
// habitante.
//
// Qual runtime vale é decisão de OPERADOR, via variável de ambiente — a mesma
// precedência que governa as raízes de workflow. Corpo de requisição e
// argumento de tool são entrada de usuário e nunca escolhem runtime: um agente
// capaz de trocar o próprio runtime a pedido de quem conversa com ele é um
// agente sem fronteira.

import { assertRuntimePort, RuntimeUnavailableError } from './AgentRuntimePort.js';
import { createEchoRuntime } from './adapters/EchoRuntimeAdapter.js';
import { createHermesRuntime } from './adapters/HermesRuntimeAdapter.js';

/**
 * Os runtimes que existem.
 *
 * O `hermes` entrou no PASSO 7B exatamente como este comentário previa: uma
 * linha aqui e um arquivo em adapters/. Gateway, domínio e API não mudaram.
 */
const FABRICAS = Object.freeze({
  echo: createEchoRuntime,
  hermes: createHermesRuntime,
});

export const DEFAULT_RUNTIME_ID = 'echo';

/** Os ids selecionáveis. Usado no diagnóstico e na mensagem de erro. */
export function availableRuntimeIds() {
  return Object.keys(FABRICAS);
}

/** O id configurado para esta instalação. */
export function configuredRuntimeId() {
  const escolhido = String(process.env.SHOWRUNNER_AGENT_RUNTIME || '').trim();
  return escolhido || DEFAULT_RUNTIME_ID;
}

/**
 * Constrói o runtime.
 *
 * Id desconhecido falha alto, com o nome pedido e a lista do que existe.
 * Nunca cai num runtime alternativo — pela mesma razão que um `workflowId`
 * desconhecido nunca cai noutro workflow: um agente respondendo por um runtime
 * que ninguém pediu é pior do que um agente que não responde.
 */
export function createRuntime(id = configuredRuntimeId(), options = {}) {
  const fabrica = FABRICAS[id];
  if (!fabrica) {
    throw new RuntimeUnavailableError(
      `Runtime de agente desconhecido: "${id}".`,
      { id, disponiveis: availableRuntimeIds() },
    );
  }
  return assertRuntimePort(fabrica(options), `runtime "${id}"`);
}
