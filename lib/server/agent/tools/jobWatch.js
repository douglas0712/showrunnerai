// Job Autonomy — o acompanhamento de uma geração, do lado do servidor.
//
// ── O problema que este arquivo existe para resolver ────────────────────────
//
// A máquina de geração é PULL: ela só avança quando alguém consulta. Enquanto
// esse alguém era o modelo — chamando `og.get_job` de novo e de novo — a
// geração dependia de o modelo LEMBRAR de consultar, e ele legitimamente não
// lembra: o turno dele acaba quando ele termina de falar. O resultado aparecia
// na tela do usuário como um trabalho parado que só andava quando ele
// perguntava "e aí?".
//
// Também não pode ser o navegador. Se a consulta que faz o trabalho progredir
// mora na tela, então fechar a aba, trocar de área ou simplesmente ficar
// parado congela a produção — e um estúdio em que a renderização depende de
// alguém estar olhando não é um estúdio.
//
// Então é o Showrunner. Ele aceitou o trabalho; ele o leva até o fim.
//
//     Hermes reasons. Showrunner executes and owns state.
//
// ── Por que aqui, dentro de tools/ ──────────────────────────────────────────
//
// Este módulo é a CONTINUAÇÃO do que uma ferramenta começou: o mesmo trabalho,
// depois que o turno que o pediu já terminou. E é `tools/` a única parte da
// camada de agente autorizada a alcançar `generation/facade` — que é
// exatamente o que um acompanhamento precisa chamar. Colocá-lo fora daqui
// exigiria afrouxar essa trava, e ela vale mais do que a arrumação.
//
// ── O que ele NÃO faz ───────────────────────────────────────────────────────
//
// Não consulta a fila, não conhece nó, não copia arquivo e não cria Asset. Ele
// chama `getGenerationJob`, que é a MESMA função que a ferramenta de status
// chama, e é ela quem avança a máquina e faz nascer o Asset. Uma segunda
// implementação dessas regras seria uma segunda oportunidade de elas
// discordarem.
//
// Não cancela nada no gerador. Cancelar o TURNO é interromper a fala do
// agente; a geração já aceita continua — e o cancelamento do gerador é global
// nesta instalação, então cancelar uma pediria interromper as outras.
//
// ── O que "teto estourado" significa, e o que NÃO significa ─────────────────
//
// Passar do teto encerra o ACOMPANHAMENTO, e só ele. O job não é cancelado, não
// é marcado como cancelado e não é tocado: ele pode muito bem continuar
// rodando no gerador e terminar depois. O que acaba é a nossa vigília.
//
// Enquanto o processo ainda tiver o job em mãos, uma consulta explícita mais
// tarde — o usuário perguntando pelo andamento, e o modelo chamando a
// ferramenta de status — reencontra esse job e continua a avançá-lo, inclusive
// até o Asset nascer. É a mesma função, e ela é idempotente.
//
// O estado público vira "falhou" porque é o que é verdade para quem espera: o
// Showrunner desistiu de acompanhar. Chamar de "cancelado" seria afirmar algo
// sobre o gerador que não fizemos.
//
// ── Ciclo de vida de um acompanhamento ──────────────────────────────────────
//
//   em curso      fica no registro; é ele que garante o single-flight
//   terminou      qualquer desfecho — concluído, falhou, teto, inesperado —
//                 passa por `assentar`, que AGENDA a saída do registro
//   janela curta  RETENCAO_MS, só para a tela poder mostrar o desfecho
//   depois        sai. O que dura é o Asset, no banco.
//
// Um `watch` atrasado que chegue depois da saída começa outro acompanhamento —
// e isso é inofensivo, porque a idempotência que protege o resultado não é
// deste arquivo: `getGenerationJob` não repolla um job terminal e
// `finalizeGenerationAsset` devolve o Asset que já existe em vez de criar
// outro. O acompanhamento novo apenas reconfirma o mesmo desfecho e sai.
//
// ── O limite que este passo NÃO resolve ─────────────────────────────────────
//
// O registro vive em memória, exatamente como o registro de jobs vive. Se o
// processo do Showrunner reiniciar, os acompanhamentos somem junto com os jobs
// que eles acompanhavam. Isso é deliberado: gravar o acompanhamento num banco
// enquanto o job continua em memória criaria uma linha durável apontando para
// um trabalho que não existe mais — durabilidade de fachada, que é pior do que
// nenhuma. Durabilidade de verdade é um passo próprio.

import {
  getGenerationJob, isTerminalJobState, JOB_STATES,
} from '../../generation/facade.js';
import { database, newId } from '../../domain/db.js';
import { attachMessageAssets } from '../threads.js';
import { CHANNELS, STAGES } from '../../logs/stages.js';
import { logInfo, logWarn } from '../../logs/logger.js';

/**
 * O estado de produção que a interface enxerga.
 *
 * É vocabulário de PRODUÇÃO, não do gerador: quem está conversando não tem por
 * que aprender a diferença entre "na fila" e "decodificando". Quatro estados
 * bastam para a tela dizer a verdade.
 */
export const PRODUCAO = Object.freeze({
  GERANDO: 'gerando',
  FINALIZANDO: 'finalizando',
  CONCLUIDO: 'concluido',
  FALHOU: 'falhou',
});

/** Os dois estados em que ainda há trabalho acontecendo. */
export const PRODUCAO_EM_CURSO = Object.freeze([PRODUCAO.GERANDO, PRODUCAO.FINALIZANDO]);

/** Um estado de produção que já não muda mais. */
export function producaoTerminou(estado) {
  return estado === PRODUCAO.CONCLUIDO || estado === PRODUCAO.FALHOU;
}

/**
 * O estado de produção, a partir do estado de DOMÍNIO que a facade devolve.
 *
 * É a terceira e última tradução da cadeia — provider → domínio → produção. As
 * quatro palavras daqui são as que a conversa mostra; a granularidade do
 * domínio (preparando, enviado, na fila, executando) não interessa a quem está
 * esperando uma imagem, e mostrá-la só ensinaria vocabulário de infraestrutura.
 *
 * Só `finalizing` vira "finalizando": é o momento em que o arquivo já existe e
 * está sendo trazido, a única fase intermediária que o usuário percebe como
 * diferente de "gerando".
 *
 * `orphaned` colapsa em "falhou". Para quem espera, um trabalho que se perdeu e
 * um que falhou são a mesma coisa: não veio resultado. A distinção existe para
 * o operador, no log, e é lá que ela serve.
 */
export function estadoDeProducao(estadoDoJob) {
  if (estadoDoJob === JOB_STATES.DONE) return PRODUCAO.CONCLUIDO;
  if (estadoDoJob === JOB_STATES.FAILED
    || estadoDoJob === JOB_STATES.CANCELLED
    || estadoDoJob === JOB_STATES.ORPHANED) return PRODUCAO.FALHOU;
  if (estadoDoJob === JOB_STATES.FINALIZING) return PRODUCAO.FINALIZANDO;
  return PRODUCAO.GERANDO;
}

/** Primeira espera entre consultas. */
export const INTERVALO_INICIAL_MS = 1500;

/** Teto da espera entre consultas. */
export const INTERVALO_MAXIMO_MS = 5000;

/**
 * Quanto tempo um acompanhamento pode durar.
 *
 * Deliberadamente NÃO é o teto de silêncio de um turno de conversa: são
 * grandezas diferentes. Um turno que fica mudo por três minutos está quebrado;
 * uma geração de vídeo que leva quatorze minutos está apenas trabalhando, e já
 * levou. Matá-la por causa do relógio da conversa jogaria fora trabalho de GPU
 * que estava dando certo.
 *
 * Também não é infinito: um job que nunca termina prenderia um laço para
 * sempre. Meia hora é folgado para o que esta instalação produz hoje, e o
 * operador ajusta pela variável quando o hardware ou o modelo mudarem.
 */
export const LIMITE_PADRAO_MS = 30 * 60 * 1000;

/**
 * Quanto tempo um acompanhamento TERMINADO continua no registro.
 *
 * Ele precisa sobreviver ao fim do trabalho por um instante para a tela poder
 * mostrar o desfecho — sobretudo o desfecho ruim, que é o único aviso que o
 * usuário vai receber. Depois disso vira ruído: a mídia já está na conversa e
 * a falha já foi lida.
 *
 * É uma janela CURTA e fechada, não um cache. O que dura é o Asset, no banco;
 * o acompanhamento é o andaime, e andaime que fica é entulho.
 */
export const RETENCAO_MS = 2 * 60 * 1000;

/** O limite configurado pelo operador, ou o padrão. Nunca vindo do modelo. */
export function limiteConfigurado(ambiente = process.env) {
  const bruto = Number(ambiente.SHOWRUNNER_JOB_WATCH_TIMEOUT_MS);
  if (Number.isFinite(bruto) && bruto > 0) return bruto;
  return LIMITE_PADRAO_MS;
}

/** A espera padrão. `unref` para que um laço pendente não segure o processo. */
function esperarPadrao(ms) {
  return new Promise((resolver) => {
    const relogio = setTimeout(resolver, ms);
    if (typeof relogio?.unref === 'function') relogio.unref();
  });
}

/**
 * O agendamento padrão do descarte.
 *
 * `unref` pelo mesmo motivo da espera: um descarte pendente não pode ser a
 * razão de o processo continuar de pé. Se o processo morrer antes, o registro
 * morre junto — que é exatamente o resultado que o descarte buscava.
 */
function agendarPadrao(fn, ms) {
  const relogio = setTimeout(fn, ms);
  if (typeof relogio?.unref === 'function') relogio.unref();
  return relogio;
}

/**
 * Um registro de acompanhamentos.
 *
 * Fábrica, e não singleton só, pelo motivo de sempre nesta casa: um teste abre
 * o seu, com relógio e espera próprios, e exercita o laço inteiro sem rede,
 * sem GPU e sem esperar de verdade.
 */
export function criarRegistroDeAcompanhamento({
  consultar = getGenerationJob,
  vincular = attachMessageAssets,
  esperar = esperarPadrao,
  agendar = agendarPadrao,
  agora = Date.now,
  intervaloInicialMs = INTERVALO_INICIAL_MS,
  intervaloMaximoMs = INTERVALO_MAXIMO_MS,
  limiteMs = null,
  retencaoMs = RETENCAO_MS,
} = {}) {
  /** jobId → registro. O jobId é a identidade: é ele que não pode ter dois laços. */
  const porJob = new Map();

  const teto = () => (limiteMs === null ? limiteConfigurado() : limiteMs);

  /**
   * Marca um acompanhamento terminado para sair do registro.
   *
   * O descarte é AGENDADO no momento em que o trabalho termina, e não deixado
   * para a próxima vez que alguém passar por aqui. Enquanto ele era preguiçoso,
   * uma instalação que gerasse uma imagem e ficasse quieta guardava aquele
   * registro para sempre — ninguém chamava a varredura, e nada o tirava de lá.
   * Um andaime que só é removido quando alguém volta à obra é um andaime que
   * fica.
   *
   * O que dura é o Asset, no banco. Isto aqui é estado de execução, e sai.
   */
  function programarDescarte(registro) {
    if (registro.descarteProgramado) return;
    registro.descarteProgramado = true;

    agendar(() => {
      // Só descarta se ainda for ESTE registro. Um `watch` posterior sobre o
      // mesmo jobId põe outro objeto no lugar, e apagá-lo aqui mataria um
      // acompanhamento vivo por causa do relógio de um que já morreu.
      if (porJob.get(registro.jobId) === registro) porJob.delete(registro.jobId);
    }, retencaoMs);
  }

  /**
   * Varredura de segurança, na leitura.
   *
   * O descarte agendado é quem faz o trabalho; isto existe para o caso de o
   * agendamento não ter corrido — um processo suspenso, um relógio adiado. Sem
   * exceção nenhuma: terminou e passou da janela, sai.
   */
  function limpar() {
    const instante = agora();
    for (const [jobId, registro] of porJob) {
      if (!producaoTerminou(registro.state)) continue;
      if (instante - registro.updatedAt >= retencaoMs) porJob.delete(jobId);
    }
  }

  /** A forma que sai daqui para a interface. Nada de identificador interno. */
  function publico(registro) {
    return { id: registro.id, kind: registro.kind, state: registro.state };
  }

  /** Liga o Asset à mensagem do turno que pediu a geração, se as duas existem. */
  function ligarAsset(registro, db) {
    if (!registro.assetId || !registro.messageId || registro.ligado) return;
    // `attachMessageAssets` confere o projeto de cada Asset e deduplica pela
    // chave primária. Chamar de novo não duplica nada — e este caminho pode ser
    // alcançado duas vezes: pelo fim do trabalho e pelo fim do turno.
    vincular(registro.messageId, [registro.assetId], db);
    registro.ligado = true;
  }

  async function acompanhar(registro, db) {
    const inicio = agora();
    let intervalo = intervaloInicialMs;

    for (;;) {
      if (agora() - inicio > teto()) {
        assentar(registro, PRODUCAO.FALHOU, db, 'tempo limite de acompanhamento excedido');
        return;
      }

      let resultado;
      try {
        resultado = await consultar(registro.jobId, { projectId: registro.projectId, db });
      } catch (falha) {
        // Consultar já absorve, lá dentro, a falha de rede que é transitória. O
        // que chega aqui é o que não se resolve consultando de novo: job que
        // sumiu, propriedade que não bate, resultado que não pôde ser
        // registrado. Insistir só produziria o mesmo erro em laço.
        assentar(registro, PRODUCAO.FALHOU, db, falha?.message || 'falha ao consultar a produção');
        return;
      }

      // O fim do trabalho é decidido pelo estado de DOMÍNIO, que é quem sabe a
      // diferença entre concluído, falhou, cancelado e órfão. O estado de
      // PRODUÇÃO é o que a tela mostra, e ele colapsa três desses em um só —
      // usá-lo para decidir apagaria justamente a distinção que importa aqui.
      const estadoDoJob = resultado.status;
      const estado = estadoDeProducao(estadoDoJob);

      if (estado !== registro.state) {
        registro.state = estado;
        registro.updatedAt = agora();
        intervalo = intervaloInicialMs;
        logInfo(STAGES.AGENT_JOB_WATCH_PROGRESS, 'A produção mudou de estado.', {
          channel: CHANNELS.AGENT,
          detail: { threadId: registro.threadId, kind: registro.kind, estado },
        });
      } else {
        // Sem novidade: espera um pouco mais da próxima vez. É o que evita
        // consultar cinquenta vezes por minuto um vídeo que vai levar quinze.
        intervalo = Math.min(Math.round(intervalo * 1.5), intervaloMaximoMs);
      }

      if (isTerminalJobState(estadoDoJob)) {
        if (estadoDoJob === JOB_STATES.DONE) {
          registro.assetId = resultado.assetId ?? null;
          assentar(registro, PRODUCAO.CONCLUIDO, db, null);
          return;
        }
        assentar(
          registro, PRODUCAO.FALHOU, db,
          resultado.error || `a geração terminou como "${estadoDoJob}"`,
        );
        return;
      }

      await esperar(intervalo);
    }
  }

  /**
   * Encerra um acompanhamento, deixa registro do desfecho e o marca para sair.
   *
   * Todo caminho terminal passa por aqui — conclusão, falha da geração, falha
   * da consulta, teto estourado e o inesperado. É por isso que o descarte pode
   * ser agendado num lugar só: não há saída do laço que escape desta função.
   */
  function assentar(registro, estado, db, motivo) {
    registro.state = estado;
    registro.updatedAt = agora();
    programarDescarte(registro);

    if (estado === PRODUCAO.CONCLUIDO) {
      ligarAsset(registro, db);
      logInfo(STAGES.AGENT_JOB_WATCH_COMPLETED, 'Produção concluída.', {
        channel: CHANNELS.AGENT,
        detail: {
          threadId: registro.threadId,
          kind: registro.kind,
          assetId: registro.assetId,
          ligadaAMensagem: Boolean(registro.messageId),
        },
      });
      return;
    }

    // O motivo é de operador e fica no log. Para quem conversa, o que sobra é o
    // estado "falhou", que a tela traduz numa frase — sem causa técnica.
    logWarn(STAGES.AGENT_JOB_WATCH_FAILED, 'Produção não concluída.', {
      channel: CHANNELS.AGENT,
      detail: { threadId: registro.threadId, kind: registro.kind, motivo: motivo || null },
    });
  }

  return {
    /**
     * Passa a acompanhar um job. Single-flight: o mesmo jobId nunca ganha dois
     * laços, mesmo que a mesma geração seja observada de novo.
     *
     * Todo o contexto vem do servidor — a thread e o projeto saem do
     * ToolContext, que o gateway montou. O modelo fornece o prompt; ele não
     * fornece de quem é o trabalho.
     */
    watch({ jobId, kind, threadId, projectId }, { db = database() } = {}) {
      limpar();

      const id = String(jobId || '');
      if (!id || !threadId || !projectId) return null;

      const existente = porJob.get(id);
      if (existente) {
        logInfo(STAGES.AGENT_JOB_WATCH_STARTED, 'Acompanhamento já em curso; reaproveitado.', {
          channel: CHANNELS.AGENT,
          detail: { threadId: existente.threadId, kind: existente.kind, duplicado: true },
        });
        return existente;
      }

      const registro = {
        id: newId('watch'),
        jobId: id,
        kind: kind === 'video' ? 'video' : 'image',
        threadId: String(threadId),
        projectId: String(projectId),
        messageId: null,
        state: PRODUCAO.GERANDO,
        assetId: null,
        ligado: false,
        createdAt: agora(),
        updatedAt: agora(),
      };

      porJob.set(id, registro);

      logInfo(STAGES.AGENT_JOB_WATCH_STARTED, 'Acompanhando a produção.', {
        channel: CHANNELS.AGENT,
        detail: { threadId: registro.threadId, projectId: registro.projectId, kind: registro.kind },
      });

      // O laço corre SOLTO, de propósito: segurar a ferramenta até o fim
      // prenderia o turno do agente por toda a geração — que é exatamente o que
      // este passo existe para não fazer. O `pronto` fica guardado para quem
      // precise esperar o desfecho, que na prática é a suíte de testes.
      // O que escapa daqui é o INESPERADO: o laço já trata a consulta que
      // quebra e a geração que falha. Chegar neste `catch` significa defeito
      // nosso — e a resposta não pode ser um registro mudo, parado num estado
      // que não é nem "trabalhando" nem "acabou", ocupando o lugar do jobId
      // para sempre por causa do single-flight.
      registro.pronto = acompanhar(registro, db).catch((falha) => {
        if (!producaoTerminou(registro.state)) {
          assentar(registro, PRODUCAO.FALHOU, db, falha?.message || 'falha inesperada no acompanhamento');
          return;
        }

        // Assentou e quebrou DEPOIS — ligando o Asset, por exemplo. O desfecho
        // que já foi registrado vale; o que pode ter faltado é a saída.
        logWarn(STAGES.AGENT_JOB_WATCH_FAILED, 'Falha depois de a produção terminar.', {
          channel: CHANNELS.AGENT,
          detail: {
            threadId: registro.threadId,
            kind: registro.kind,
            estado: registro.state,
            motivo: falha?.message || 'erro desconhecido',
          },
        });
        programarDescarte(registro);
      });

      return registro;
    },

    /**
     * Amarra os jobs de um turno à mensagem que o turno produziu.
     *
     * A associação é DETERMINÍSTICA: os jobIds vêm dos resultados estruturados
     * das ferramentas DAQUELE turno, e a mensagem é a que aquele turno gravou.
     * Nada de "a última mensagem da conversa" — o usuário pode mandar outra
     * fala enquanto a imagem ainda renderiza, e aí a última mensagem é de outro
     * assunto. Nenhuma conversa rouba o resultado de outra.
     *
     * O trabalho pode terminar ANTES do turno (uma imagem rápida) ou DEPOIS
     * (o caso normal). Os dois caminhos convergem em `ligarAsset`, e ele é
     * idempotente.
     */
    bind(threadId, messageId, jobIds = [], { db = database() } = {}) {
      const ligados = [];
      for (const bruto of jobIds) {
        const registro = porJob.get(String(bruto || ''));
        if (!registro) continue;
        if (registro.threadId !== String(threadId)) continue;
        if (registro.messageId) continue;

        registro.messageId = String(messageId);
        ligarAsset(registro, db);
        ligados.push(registro.id);
      }
      return ligados;
    },

    /**
     * O que esta conversa tem em produção, em forma pública.
     *
     * Só desta conversa: um acompanhamento de outra thread — mesmo do mesmo
     * projeto — não aparece aqui.
     */
    production(threadId) {
      limpar();
      const alvo = String(threadId || '');
      const saida = [];
      for (const registro of porJob.values()) {
        if (registro.threadId !== alvo) continue;
        saida.push(publico(registro));
      }
      return saida;
    },

    /** O registro de um job, para teste e diagnóstico. */
    get(jobId) {
      return porJob.get(String(jobId || '')) || null;
    },

    /** Quantos acompanhamentos existem agora. */
    size() {
      return porJob.size;
    },
  };
}

/**
 * O registro da aplicação.
 *
 * Em `globalThis` pelo mesmo motivo que o registro de jobs está: o Fast Refresh
 * do Next recarrega módulos entre requisições, e um acompanhamento perdido no
 * recarregamento é uma geração que para de andar no meio.
 */
const CHAVE = Symbol.for('showrunner.agent.jobWatch');

export function jobWatchRegistry() {
  if (!globalThis[CHAVE]) globalThis[CHAVE] = criarRegistroDeAcompanhamento();
  return globalThis[CHAVE];
}

/** Passa a acompanhar um job. Ver `watch` acima. */
export function watchJob(entrada, { registro = jobWatchRegistry(), db = undefined } = {}) {
  return registro.watch(entrada, db === undefined ? {} : { db });
}

/** Amarra os jobs de um turno à mensagem daquele turno. Ver `bind` acima. */
export function bindTurnJobs(threadId, messageId, jobIds, { registro = jobWatchRegistry(), db = undefined } = {}) {
  return registro.bind(threadId, messageId, jobIds, db === undefined ? {} : { db });
}

/** O que esta conversa tem em produção. Ver `production` acima. */
export function threadProduction(threadId, { registro = jobWatchRegistry() } = {}) {
  return registro.production(threadId);
}
