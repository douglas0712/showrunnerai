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
import { bindGenerationJobMessage } from '../domain/generationJobs.js';
import { getProject, registerProject } from '../domain/projects.js';
import { CHANNELS, STAGES } from '../logs/stages.js';
import { logError, logInfo } from '../logs/logger.js';
import {
  assertRuntimeAvailable, assertRuntimePort, AgentTurnError, describeRuntime,
  RuntimeUnavailableError,
} from './AgentRuntimePort.js';
import {
  AGENT_EVENTS, agentErrorPayload, normalizeAgentEvent, publicAgentEvent,
} from './events.js';
import { createRuntime } from './runtimes.js';
import { bindTurnJobs, publicToolList, threadProduction, toolRegistry } from './tools/index.js';
import {
  appendMessageRecord, attachMessageAssets, createThreadRecord, getThreadRecord,
  listMessageAssets, listMessageRecords, listThreadRecords, MAX_MESSAGE_LENGTH,
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

/**
 * Cria callback seguro de invocação de ferramentas.
 *
 * O runtime chama isso para solicitar execução, passando nome + args.
 * Esta função:
 * - Constrói ToolContext confiável (threadId, projectId, userMessageId, signal)
 * - Invoca via registry (único ponto de execução)
 * - Trata erros de forma apropriada
 *
 * ── Sobre `userMessageId` ───────────────────────────────────────────────────
 *
 * É a âncora DURÁVEL deste turno, e ela já existe: a fala do usuário é gravada
 * no banco antes de o runtime começar a pensar, logo antes de qualquer
 * ferramenta poder rodar. Um turno É a mensagem que o iniciou — não é preciso
 * inventar um identificador de turno quando um já está no banco, com chave
 * primária e ordem única.
 *
 * Ela entra no contexto agora porque quem vai precisar dela é o registro
 * durável de gerações: um trabalho que sobreviva ao reinício do processo
 * precisa saber a que turno pertencia, e "a última mensagem da conversa" não
 * responde isso — o usuário pode ter falado de novo enquanto a imagem
 * renderizava.
 *
 * Como todo o resto do ToolContext, ela vem do servidor. O modelo não a
 * fornece, não a vê e não a nomeia.
 */
function criarInvokeTool(thread, signal, userMessageId = null) {
  return async (toolName, toolArgs = {}) => {
    const context = {
      threadId: thread.id,
      projectId: thread.projectId,
      userMessageId,
      signal,
    };

    try {
      const result = await toolRegistry().invoke(toolName, context, toolArgs);
      return result;
    } catch (error) {
      // Runtime recebe erro tipado, não detalhes internos
      if (error.name === 'ToolExecutionError') {
        throw new Error(error.message);
      }
      throw new Error(`Ferramenta falhou: ${error?.message || 'erro desconhecido'}`);
    }
  };
}

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
function resolverDeps({ db = database(), runtime = null, watchRegistry = null } = {}) {
  return { db, runtime, watchRegistry };
}

/**
 * As opções de acompanhamento de uma chamada.
 *
 * Sem `watchRegistry`, vale o registro da aplicação — que é o caso de todo
 * chamador real. Com ele, um teste exercita o turno inteiro contra um registro
 * próprio, com relógio e espera próprios, sem esperar de verdade e sem tocar no
 * registro global.
 */
function opcoesDeAcompanhamento({ db, watchRegistry }) {
  return watchRegistry ? { db, registro: watchRegistry } : { db };
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
  const { projectId = null, title = null, project = null } = entrada;

  const alvo = projectId ?? project?.id ?? null;

  if (alvo !== null && alvo !== undefined && alvo !== '') {
    const id = String(alvo);

    if (!getProject(id, db)) {
      // ── adoção do projeto do Studio ──────────────────────────────────────
      //
      // O projeto pode existir na tela e ainda não no servidor: o Studio cria
      // projetos localmente, e só quando alguém vai PRODUZIR neles é que eles
      // precisam existir aqui. Registrá-lo agora é reconhecer um projeto que o
      // usuário já tem, com o id que ele já tem — não inventar um.
      //
      // O DESCRITOR é obrigatório, e é ele que faz a diferença. Um `projectId`
      // sozinho é um identificador que chegou de fora; um descritor com nome é
      // a interface declarando em que projeto o usuário está. Sem ele, um id
      // desconhecido é recusado — e é por isso que este caminho não vira uma
      // porta de criação de projeto a partir de qualquer string.
      if (!project || typeof project !== 'object') {
        throw new DomainError(`Projeto desconhecido: "${id}".`, { projectId: id });
      }

      // `registerProject` cria se falta, devolve o existente se há, e nunca
      // sobrescreve o que já está no servidor.
      registerProject({
        id,
        name: typeof project.name === 'string' && project.name.trim() ? project.name : id,
        description: typeof project.description === 'string' ? project.description : '',
        aspect: typeof project.aspect === 'string' ? project.aspect : undefined,
      }, db);

      logInfo(STAGES.AGENT_THREAD_CREATED, 'Projeto do Studio registrado no servidor.', {
        channel: CHANNELS.AGENT,
        detail: { projectId: id },
      });
    }
  }

  const projetoFinal = alvo;

  const thread = createThreadRecord({ projectId: projetoFinal, title: title ?? undefined }, db);

  logInfo(STAGES.AGENT_THREAD_CREATED, 'Conversa criada.', {
    channel: CHANNELS.AGENT,
    detail: { threadId: thread.id, projectId: thread.projectId },
  });

  return thread;
}

/** A conversa e suas mensagens, em ordem. Lança se a thread não existe. */
export function getThread(threadId, deps = {}) {
  const { db, watchRegistry } = resolverDeps(deps);

  const thread = getThreadRecord(threadId, db);
  if (!thread) throw new ThreadNotFoundError(threadId);

  // A mídia entra SÓ aqui, no caminho de leitura da interface. O histórico que
  // vai para o runtime (`listMessageRecords` cru, em `streamMessage`) continua
  // sendo texto: o runtime não tem o que fazer com um Asset, e mandar um
  // aumentaria o prompt sem acrescentar nada.
  const messages = listMessageRecords(threadId, db).map((mensagem) => ({
    ...mensagem,
    assets: listMessageAssets(mensagem.id, db),
  }));

  // O que esta conversa tem EM PRODUÇÃO agora.
  //
  // É a única forma de a tela saber que há trabalho acontecendo depois que o
  // turno acabou — e ela precisa saber, porque o turno acaba muito antes de a
  // mídia existir. Vem em forma pública: tipo e estado, mais nada. Nenhum
  // identificador de job, nenhum vocabulário do gerador.
  //
  // Ler isto NÃO faz o trabalho progredir: quem faz é o acompanhamento do
  // servidor. Uma tela que não perguntasse nunca não atrasaria uma geração em
  // um segundo — só demoraria mais para mostrar que ela terminou.
  const production = threadProduction(
    threadId,
    watchRegistry ? { registro: watchRegistry } : {},
  );

  return { thread, messages, production };
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
  const fluxo = streamMessage(entrada, deps);

  // Dirigido à mão, e não com `for await`, porque o valor de RETORNO do
  // gerador é o resultado do turno — e `for await` descarta esse valor.
  let passo = await fluxo.next();
  while (!passo.done) passo = await fluxo.next();
  return passo.value;
}

/**
 * O mesmo turno, evento a evento.
 *
 * Esta é a única implementação de turno que existe; `sendMessage` a consome
 * inteira e devolve o resultado. Duas implementações — uma para a resposta de
 * uma vez, outra para o streaming — divergiriam no primeiro caso de borda, e o
 * caso de borda de um turno é justamente a falha no meio dele.
 *
 * Rende AgentEvents JÁ normalizados e devolve, ao terminar, o mesmo objeto que
 * `sendMessage` sempre devolveu. A persistência acontece aqui, no fim, pela
 * mesma regra de antes: uma resposta só vira linha no banco quando o runtime
 * diz `agent.message.completed`.
 */
export async function* streamMessage(entrada = {}, deps = {}) {
  const { db, runtime: injetado, watchRegistry } = resolverDeps(deps);
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
      caracteres: texto.length,
      historico: messages.length,
    },
  });

  const contexto = {
    agentName: AGENT_NAME,
    threadId: thread.id,
    projectId: thread.projectId,
    // A âncora durável deste turno — a fala que acabou de ser gravada, acima.
    // Um adaptador que execute ferramentas por outro canal (o do plugin) a
    // repassa ao registro de turnos; nenhum runtime a inventa.
    userMessageId: userMessage.id,
  };

  const eventos = [];
  try {
    const tools = publicToolList(toolRegistry());
    logInfo(STAGES.AGENT_RUNTIME_STARTED, 'Runtime iniciado.', {
      channel: CHANNELS.AGENT,
      detail: { threadId, historico: messages.length, tools: tools.length },
    });

    const fluxo = await runtime.run({
      thread,
      messages,
      context: contexto,
      tools,
      invokeTool: criarInvokeTool(thread, signal, userMessage.id),
      signal,
    });

    if (!fluxo || typeof fluxo[Symbol.asyncIterator] !== 'function') {
      throw new AgentTurnError('O runtime não devolveu um fluxo de eventos.', {});
    }

    for await (const bruto of fluxo) {
      // A normalização é a fronteira: o que passa daqui contém só campos do
      // vocabulário do Showrunner. Um evento fora dele derruba o turno em vez
      // de seguir adiante — é o que impede a tradução de ser esquecida.
      const evento = normalizeAgentEvent(bruto);
      // O evento INTERNO fica guardado inteiro: é dele que saem os Assets e as
      // gerações deste turno, logo abaixo. O que SAI daqui é a versão pública —
      // sem o identificador do trabalho, que é nome de coisa nossa.
      //
      // A ordem é a garantia: o servidor lê primeiro, o navegador recebe
      // depois. Inverter isso faria a autonomia depender do campo que a
      // sanitização existe para remover.
      eventos.push(evento);
      yield publicAgentEvent(evento);

      if (evento.type === AGENT_EVENTS.FAILED) {
        throw new AgentTurnError(evento.error?.message || 'O agente falhou.', {
          code: evento.error?.code || null,
        });
      }
    }
  } catch (erro) {
    return falharTurno(erro, { threadId, thread, userMessage });
  }

  const resposta = respostaDosEventos(eventos);
  if (resposta === null) {
    return falharTurno(
      new AgentTurnError('O agente terminou sem produzir resposta.', { threadId }),
      { threadId, thread, userMessage },
    );
  }

  const assistantMessage = appendMessageRecord({
    threadId, role: 'assistant', content: resposta, status: 'completed',
  }, db);

  // A mídia que o turno produziu fica ligada à mensagem, por REFERÊNCIA. É o
  // que faz a imagem continuar lá depois de um reload — antes, o histórico era
  // só texto, e o resultado do trabalho sumia junto com o estado do navegador.
  //
  // Os ids saem dos eventos do próprio turno, que passaram pela normalização.
  // Nada vem do navegador, e `attachMessageAssets` ainda confere o projeto de
  // cada um antes de aceitar.
  const assetsDoTurno = assetIdsDosEventos(eventos);
  if (assetsDoTurno.length) {
    attachMessageAssets(assistantMessage.id, assetsDoTurno, db);
  }

  // As gerações que ESTE turno começou e que ainda não terminaram.
  //
  // Elas continuam sendo levadas até o fim pelo servidor, fora daqui — o turno
  // não espera por elas, e é essa recusa em esperar que mantém a conversa viva
  // enquanto uma imagem de três minutos renderiza. O que falta é dizer ONDE o
  // resultado vai aparecer quando chegar, e a resposta é: nesta mensagem.
  //
  // A amarração é determinística porque os dois lados vêm deste turno — os
  // jobIds saem dos resultados ESTRUTURADOS das ferramentas que rodaram agora,
  // e a mensagem é a que acabou de ser gravada. "A última mensagem da conversa"
  // seria a resposta errada: o usuário pode falar de novo antes de o trabalho
  // acabar, e aí a última mensagem é de outro assunto.
  const jobsDoTurno = jobIdsDosEventos(eventos);
  if (jobsDoTurno.length) {
    bindTurnJobs(
      threadId, assistantMessage.id, jobsDoTurno,
      opcoesDeAcompanhamento({ db, watchRegistry }),
    );

    // E a MESMA amarração no registro durável, para que ela sobreviva ao
    // processo. O acompanhamento em memória sabe onde a mídia vai aparecer
    // enquanto ele viver; o livro-razão sabe depois disso.
    //
    // A operação é de escrita única: repetir a mesma mensagem não faz nada,
    // apontar para outra é recusado. E é tolerante ao que não conhece — uma
    // geração sem linha no livro-razão simplesmente não tem o que amarrar.
    for (const jobId of jobsDoTurno) {
      try {
        bindGenerationJobMessage(jobId, assistantMessage.id, { db });
      } catch (erro) {
        // Anotar não é conversar: um problema de banco não pode derrubar um
        // turno que já foi respondido e gravado.
        logError(STAGES.AGENT_TURN_COMPLETED, erro, {
          channel: CHANNELS.AGENT,
          detail: { threadId, messageId: assistantMessage.id },
        });
      }
    }
  }

  logInfo(STAGES.AGENT_TURN_COMPLETED, 'Resposta concluída.', {
    channel: CHANNELS.AGENT,
    detail: {
      threadId,
      messageId: assistantMessage.id,
      caracteres: resposta.length,
      eventos: eventos.length,
    },
  });

  return {
    thread: getThreadRecord(threadId, db),
    userMessage,
    assistantMessage,
    // Os mesmos eventos que o streaming entrega, e pela mesma porta: a resposta
    // de uma vez vai para o navegador igual à de pedaço em pedaço. Duas formas
    // do mesmo turno com fronteiras diferentes seria a mais fácil de esquecer.
    events: eventos.map(publicAgentEvent),
  };
}

/**
 * Os Assets que as ferramentas deste turno produziram, na ordem em que
 * apareceram e sem repetir.
 *
 * A mesma imagem costuma ser citada por mais de uma ferramenta — uma que a
 * cria, outra que confirma que ficou pronta. A identidade é o id do Asset.
 */
function assetIdsDosEventos(eventos) {
  const vistos = new Set();
  for (const evento of eventos) {
    if (evento.type !== AGENT_EVENTS.TOOL_COMPLETED) continue;
    const id = evento.result?.asset?.id;
    if (typeof id === 'string' && id && !vistos.has(id)) vistos.add(id);
  }
  return [...vistos];
}

/**
 * As gerações que as ferramentas deste turno começaram, sem repetir.
 *
 * Sai do campo `jobId` do RESULTADO da ferramenta — dado estruturado, produzido
 * pelo servidor. Nunca do texto que o agente escreveu: um identificador
 * garimpado de uma frase é um identificador que o modelo pode inventar, e a
 * partir daí a conversa passaria a poder reivindicar trabalho que não é dela.
 */
function jobIdsDosEventos(eventos) {
  const vistos = new Set();
  for (const evento of eventos) {
    if (evento.type !== AGENT_EVENTS.TOOL_COMPLETED) continue;
    const id = evento.result?.jobId;
    if (typeof id === 'string' && id) vistos.add(id);
  }
  return [...vistos];
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

  // "Não deu para falar com o runtime" e "o runtime falhou no meio da resposta"
  // são coisas diferentes para quem está esperando: a primeira é a instalação,
  // e tentar de novo mais tarde é a ação certa; a segunda é um turno perdido.
  // O runtime declara qual das duas foi — este é o vocabulário do PORT, não o
  // de nenhum adaptador — e o gateway apenas deixa passar.
  if (erro instanceof RuntimeUnavailableError) throw erro;

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
