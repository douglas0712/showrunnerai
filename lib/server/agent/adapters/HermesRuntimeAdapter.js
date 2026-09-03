// HermesRuntimeAdapter — o runtime que raciocina de verdade.
//
// Cumpre o mesmo AgentRuntimePort que o Echo cumpre. O gateway não distingue os
// dois, e essa é a prova de que a fronteira desenhada no PASSO 5 aguentou: o
// adaptador entra sem que gateway, domínio ou API mudem uma linha.
//
// ── O desenho, e por que ele é invertido ────────────────────────────────────
//
//   Showrunner  ──HTTP/SSE──▶  runtime externo   (a conversa)
//   runtime     ──socket───▶   bridge            (a ferramenta)
//
// A ferramenta NÃO é executada dentro deste arquivo. O runtime chama de volta
// pelo bridge, com o id da sessão dele, e o bridge deduz thread e projeto do
// que o servidor gravou. Foi medido no PASSO 7A.2 que nada de identidade
// atravessa o canal do runtime: a chamada carrega nome e argumentos, e o
// `session_id` que o runtime conhece é descartado antes do transporte.
//
// Por isso o `invokeTool` que o contrato entrega a `run` NÃO é usado aqui. Não
// é esquecimento: usá-lo exigiria que a ferramenta voltasse por este fluxo, e
// ela não volta. O comentário existe para que a ausência seja lida como
// decisão, e não como falta.
//
// ── O que este arquivo garante ──────────────────────────────────────────────
//
//   isolamento   toda sessão nasce com os toolsets obrigatórios, conferidos
//                contra o que o servidor respondeu (httpClient.createSession)
//   identidade   nenhum evento sai daqui sem passar pelo tradutor, e o
//                gateway ainda normaliza depois — duas peneiras, não uma
//   binding      a sessão é gravada no banco antes do primeiro turno, porque é
//                o bridge que vai lê-la, possivelmente noutro processo

import { AGENT_EVENTS, createAgentEvent } from '../events.js';
import { createHermesClient, HermesTransportError, TOOLSETS_OBRIGATORIOS } from '../hermes/httpClient.js';
import { createEventTranslator } from '../hermes/eventTranslator.js';
import {
  corrigirAutoidentificacao, inspecionarIdentidade, PERSONA_NAME,
} from '../hermes/identity.js';
import { bindRuntimeSession, findSessionForThread } from '../hermes/sessionBinding.js';
import {
  createActiveTurnRegistry, defaultBridgeSocketPath, startBridgeServer,
} from '../hermes/bridge.js';
import { database } from '../../domain/db.js';
import { CHANNELS, STAGES } from '../../logs/stages.js';
import { logWarn } from '../../logs/logger.js';

export const HERMES_RUNTIME_ID = 'hermes';

/**
 * O bridge, no MESMO processo do adaptador.
 *
 * Não é opção de arranjo: o registro de turnos é memória compartilhada entre os
 * dois. É por ele que o sinal de cancelamento do turno alcança a ferramenta, e
 * é nele que o resultado da ferramenta fica esperando o evento de conclusão que
 * vai levá-lo à tela. Um bridge noutro processo teria o próprio registro, vazio,
 * e as duas metades nunca se encontrariam.
 *
 * Subido uma vez, na primeira conversa, e não na importação do módulo: importar
 * este arquivo não deve abrir socket — o teste que injeta um cliente falso não
 * quer um socket, e um processo que só lista runtimes muito menos.
 */
let bridgeEmPe = null;

async function garantirBridge() {
  if (!bridgeEmPe) {
    const turns = createActiveTurnRegistry();
    bridgeEmPe = startBridgeServer({ socketPath: defaultBridgeSocketPath(), turns })
      .then((servidor) => ({ turns: servidor.turns, servidor }))
      .catch((erro) => {
        // Não derruba a conversa: sem bridge, o texto ainda funciona e a
        // ferramenta falha com mensagem própria. Uma promessa rejeitada
        // guardada aqui faria toda conversa seguinte falhar junto.
        bridgeEmPe = null;
        throw erro;
      });
  }
  return bridgeEmPe;
}

/** A URL configurada para esta instalação, ou vazio. */
export function configuredHermesUrl() {
  return String(process.env.SHOWRUNNER_HERMES_URL || '').trim();
}

/**
 * Constrói o adaptador.
 *
 * Tudo o que fala com o mundo é injetável — cliente, banco, relógio, registro
 * de turnos — porque é isso que permite exercitar o adaptador inteiro contra um
 * servidor de mentira. O `npm test` não sobe runtime nenhum.
 */
export function createHermesRuntime({
  baseUrl = configuredHermesUrl(),
  client = null,
  db = null,
  clock = Date.now,
  turns = null,
  fetchImpl = undefined,
} = {}) {
  // Transporte injetado significa que quem chama está dirigindo o adaptador —
  // um teste, tipicamente. Nesse caso o bridge NÃO sobe sozinho: abrir socket
  // dentro de `npm test` deixaria o processo vivo depois do último teste, e
  // uma suíte que não termina é pior do que uma que falha.
  const transporteInjetado = Boolean(client) || Boolean(fetchImpl);

  const url = String(baseUrl || '').trim();
  const evento = (tipo, carga) => createAgentEvent(tipo, carga, clock);

  // O cliente é construído já, para que uma URL inválida falhe na construção do
  // runtime e não no meio da primeira conversa.
  let http = client;
  let erroDeConstrucao = null;
  if (!http && url) {
    try {
      http = createHermesClient({ baseUrl: url, ...(fetchImpl ? { fetchImpl } : {}) });
    } catch (erro) {
      erroDeConstrucao = erro?.message || 'Configuração inválida.';
    }
  }

  const banco = () => db ?? database();

  return {
    id: HERMES_RUNTIME_ID,

    /**
     * Barato e sem rede, como o contrato exige.
     *
     * "Dá para tentar?" é respondido pela configuração. Sondar aqui tornaria
     * cada verificação uma ida à rede, e o gateway chama isto antes de todo
     * turno.
     */
    isAvailable() {
      return Boolean(http) && !erroDeConstrucao;
    },

    unavailableReason() {
      if (erroDeConstrucao) return `O agente não está configurado corretamente: ${erroDeConstrucao}`;
      if (!http) {
        return 'O agente não está configurado: falta o endereço do serviço de raciocínio.';
      }
      return null;
    },

    /**
     * Diagnóstico ativo. Fala com a rede, e por isso não está no caminho da
     * conversa.
     *
     * O `detail` é lido por quem opera a instalação. Ele não cita o produto por
     * trás nem devolve o corpo do /health cru — só o que é preciso para saber
     * se dá para usar.
     */
    async testConnection() {
      if (!this.isAvailable()) {
        return { ok: false, detail: { configured: false, reason: this.unavailableReason() } };
      }
      try {
        await http.health();
        return {
          ok: true,
          detail: {
            configured: true,
            reachable: true,
            isolation: [...TOOLSETS_OBRIGATORIOS],
          },
        };
      } catch (erro) {
        return {
          ok: false,
          detail: {
            configured: true,
            reachable: false,
            // Sem status HTTP, sem corpo, sem URL: é diagnóstico, mas continua
            // sendo superfície.
            reason: erro instanceof HermesTransportError
              ? 'O serviço de raciocínio não respondeu.'
              : 'Falha ao verificar o serviço de raciocínio.',
          },
        };
      }
    },

    /**
     * Um turno.
     *
     * O fluxo é: garantir sessão isolada → anunciar o turno ao bridge → iniciar
     * a conversa → traduzir o que vier → encerrar. O `finally` desanuncia o
     * turno e cancela o fluxo remoto, aconteça o que acontecer.
     */
    async* run({ thread, messages = [], invokeTool = null, signal = null } = {}) {
      if (!this.isAvailable()) {
        throw new HermesTransportError(this.unavailableReason(), {});
      }
      if (!thread?.id) {
        throw new HermesTransportError('Turno sem conversa.', {});
      }
      // O contrato entrega `invokeTool`; este adaptador não o usa (ver cabeçalho).
      // A conferência de forma continua valendo para quem chamar errado.
      if (invokeTool !== null && typeof invokeTool !== 'function') {
        throw new TypeError('invokeTool precisa ser uma função.');
      }

      const ultima = ultimaDoUsuario(messages);
      if (!ultima) throw new Error('Não há mensagem de usuário para responder.');

      const bd = banco();

      // `turns` injetado tem precedência: é assim que o teste exercita o
      // adaptador sem abrir socket nenhum.
      let registroDeTurnos = turns;
      if (!registroDeTurnos && !transporteInjetado) {
        try {
          ({ turns: registroDeTurnos } = await garantirBridge());
        } catch {
          // Segue sem bridge: a conversa textual continua válida, e uma
          // ferramenta chamada sem bridge falha com mensagem própria.
          registroDeTurnos = null;
        }
      }

      const sessionId = await garantirSessao(thread, { http, db: bd, clock });

      yield evento(AGENT_EVENTS.STARTED, {});

      let streamId = null;
      registroDeTurnos?.begin(sessionId, signal);

      try {
        const inicio = await http.startChat({ sessionId, message: ultima.content, signal });
        streamId = inicio.streamId;

        // Texto nosso, não o rótulo de estado do runtime.
        yield evento(AGENT_EVENTS.STATUS, { status: 'Pensando' });

        // O tradutor busca o resultado da ferramenta em quem a executou: o
        // bridge. O runtime não o carrega inteiro (ver eventTranslator).
        const tradutor = createEventTranslator({
          clock,
          resultFor: (nomeCanonico) => registroDeTurnos?.takeResult(sessionId, nomeCanonico) ?? null,
        });

        for await (const bruto of http.streamChat({ streamId, signal })) {
          if (signal?.aborted) break;
          for (const saida of tradutor.traduzir(bruto)) {
            yield protegerIdentidade(saida);
            if (saida.type === AGENT_EVENTS.FAILED) return;
          }
        }

        if (signal?.aborted) return;

        // O fluxo pode acabar sem `stream_end`. Fechar aqui garante que um turno
        // bem-sucedido sempre termine com resposta e conclusão.
        for (const saida of tradutor.finalizar()) yield protegerIdentidade(saida);
      } finally {
        registroDeTurnos?.end(sessionId);
        // Cancelamento é melhor esforço e nunca lança (ver httpClient).
        if (signal?.aborted && streamId) await http.cancelChat({ streamId });
      }
    },
  };
}

/**
 * A última linha de defesa da identidade.
 *
 * A identidade correta vem da persona, aplicada antes da geração. Isto aqui não
 * a constrói — confere. Se o runtime se apresentou como outra coisa, o defeito
 * é registrado no log do servidor (onde alguém pode agir) e a autoidentificação
 * é corrigida antes de chegar à tela.
 *
 * Só a construção "sou o X" é tocada. Um texto que fale de um personagem, de um
 * mito ou de qualquer assunto que o usuário tenha pedido passa inteiro — a
 * alternativa, trocar toda ocorrência de uma palavra, estragaria a resposta
 * legítima para proteger contra a ilegítima.
 */
function protegerIdentidade(evento) {
  if (evento.type !== AGENT_EVENTS.MESSAGE_COMPLETED
      && evento.type !== AGENT_EVENTS.MESSAGE_DELTA) {
    return evento;
  }

  const { ok, motivos, amostra } = inspecionarIdentidade(evento.text);
  if (ok) return evento;

  logWarn(STAGES.AGENT_TURN_FAILED, 'A resposta do runtime vazou identidade interna.', {
    channel: CHANNELS.AGENT,
    detail: { motivos, evento: evento.type, trecho: amostra },
  });

  return { ...evento, text: corrigirAutoidentificacao(evento.text) };
}

/**
 * A sessão desta conversa, criando-a se ainda não existe.
 *
 * Reaproveitar a sessão entre turnos da MESMA thread é o que dá continuidade à
 * conversa do lado do runtime. Reaproveitar entre threads diferentes seria
 * misturar duas conversas — e o índice único do banco recusa, então o erro
 * apareceria aqui e não como um projeto errado numa geração.
 */
async function garantirSessao(thread, { http, db, clock }) {
  const existente = findSessionForThread(thread.id, HERMES_RUNTIME_ID, db);
  if (existente) return existente.sessionId;

  const { sessionId } = await http.createSession();

  // A identidade é aplicada ANTES do primeiro turno, e o vínculo só é gravado
  // depois: uma sessão que não soube quem é não deve ficar registrada como a
  // conversa desta thread.
  await http.applyPersona({ sessionId, name: PERSONA_NAME });

  bindRuntimeSession({
    sessionId,
    threadId: thread.id,
    runtimeId: HERMES_RUNTIME_ID,
    now: clock(),
  }, db);

  return sessionId;
}

/** A última fala do usuário — a que este turno responde. */
function ultimaDoUsuario(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i];
  }
  return null;
}
