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
//
// ── Por que o padrão deixou de ser o Echo ───────────────────────────────────
//
// Era. E o preço apareceu na tela: uma instalação sem variável nenhuma subia
// inteira, respondia a toda pergunta com "Recebi: …" e não dizia a ninguém que
// o agente de verdade não estava ali. O usuário via um assistente burro; o
// operador via um sistema saudável. Um piso de teste que se apresenta como o
// produto é pior do que um produto que se recusa a atender.
//
// O padrão agora é o runtime de raciocínio. Quando ele não está configurado ou
// não responde, o turno não começa e a superfície pública devolve indisponível
// — o comportamento fail-closed que `httpApi.js` traduz numa frase do produto.
//
// O Echo continua aqui e continua construível: `createRuntime('echo')` é o que
// a suíte usa para exercitar gateway, eventos e persistência sem rede. O que
// ele não pode voltar a ser é o destino de quem não escolheu nada.

import { assertRuntimePort, RuntimeUnavailableError } from './AgentRuntimePort.js';
import { createEchoRuntime } from './adapters/EchoRuntimeAdapter.js';
import { createHermesRuntime } from './adapters/HermesRuntimeAdapter.js';
import { CHANNELS, STAGES } from '../logs/stages.js';
import { logWarn } from '../logs/logger.js';

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

/**
 * Os runtimes que NÃO são o produto.
 *
 * Eles existem para teste determinístico e continuam selecionáveis — mas de
 * forma nomeada, nunca por omissão. Selecionar um deles para o processo
 * inteiro é uma decisão legítima de quem está desenvolvendo a interface sem
 * runtime por perto; o que ela não pode ser é silenciosa, e por isso ela é
 * registrada como aviso.
 */
export const TEST_RUNTIME_IDS = Object.freeze(['echo']);

/**
 * O padrão: o runtime de raciocínio.
 *
 * Uma instalação que não configurou nada não ganha um agente de mentira. Ela
 * ganha um agente indisponível, que é a verdade e é acionável.
 */
export const DEFAULT_RUNTIME_ID = 'hermes';

/** Os ids selecionáveis. Usado no diagnóstico e na mensagem de erro. */
export function availableRuntimeIds() {
  return Object.keys(FABRICAS);
}

/** O id é de um runtime de teste? */
export function isTestRuntimeId(id) {
  return TEST_RUNTIME_IDS.includes(id);
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
 *
 * Sem argumento, o id vem do ambiente. Com argumento, quem chama está pedindo
 * aquele runtime pelo nome — é como a suíte constrói o Echo. A distinção entre
 * os dois casos é o que permite avisar quando um runtime de teste virou o
 * runtime do processo: pedido explícito não gera ruído, omissão gera.
 */
export function createRuntime(id = undefined, options = {}) {
  const doAmbiente = id === undefined;
  const escolhido = doAmbiente ? configuredRuntimeId() : id;

  const fabrica = FABRICAS[escolhido];
  if (!fabrica) {
    throw new RuntimeUnavailableError(
      `Runtime de agente desconhecido: "${escolhido}".`,
      { id: escolhido, disponiveis: availableRuntimeIds() },
    );
  }

  if (doAmbiente && isTestRuntimeId(escolhido)) {
    // Não é erro: alguém escreveu isso no ambiente de propósito. Mas é o tipo
    // de decisão que, esquecida, faz a superfície real responder como um eco —
    // então ela fica no log de quem opera, em toda construção.
    logWarn(
      STAGES.AGENT_RUNTIME_STARTED,
      'A superfície do agente está usando um runtime de TESTE, por configuração explícita do ambiente.',
      { channel: CHANNELS.AGENT, detail: { runtimeId: escolhido, variavel: 'SHOWRUNNER_AGENT_RUNTIME' } },
    );
  }

  return assertRuntimePort(fabrica(options), `runtime "${escolhido}"`);
}
