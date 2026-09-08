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
//   isolamento   a cada turno, os toolsets que o runtime diz ter dado ao
//                modelo são conferidos contra o combinado (eventTranslator,
//                `session.info`) — e um toolset a mais derruba o turno
//   identidade   nenhum evento sai daqui sem passar pelo tradutor E pelo guard
//                de identidade, e o gateway ainda normaliza depois
//   binding      a sessão é gravada no banco antes do primeiro turno, porque é
//                o bridge que vai lê-la, possivelmente noutro processo
//
// ── A fronteira entre privado e público ─────────────────────────────────────
//
// É o `yield` de `run`. Antes dele, o texto está em memória deste processo e não
// existe para ninguém; depois dele o gateway o normaliza, guarda no turno e o
// entrega a `/api/agent/stream`, que o serializa como SSE para o navegador. Não
// há ponto de retratação depois do `yield`: um delta entregue foi lido.
//
// Por isso o guard roda ANTES do `yield`, dentro de `criarGuarda`, e por isso
// ele tem estado. Um delta conferido isoladamente deixa passar "Sou o Her"
// seguido de "mes Agent"; o guard segura a cauda ambígua e só libera o que já
// não pode mudar de sentido. Ver `createIdentityGuard`.

import { AGENT_EVENTS, createAgentEvent } from '../events.js';
import { createHermesClient, HermesTransportError, TOOLSETS_OBRIGATORIOS } from '../hermes/runtimeClient.js';
import { createEventTranslator } from '../hermes/eventTranslator.js';
import { createIdentityGuard } from '../hermes/identity.js';
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
 * A credencial do runtime dedicado.
 *
 * O runtime passou a exigir autenticação em toda rota privada. Em loopback ele
 * aceita um token de processo, que o operador fixa nos DOIS lados: no ambiente
 * do runtime (`HERMES_DASHBOARD_SESSION_TOKEN`) e aqui. É segredo de servidor —
 * mora no ambiente, nunca no Git, e nunca atravessa para o navegador.
 */
export function configuredHermesToken() {
  return String(process.env.SHOWRUNNER_HERMES_TOKEN || '').trim();
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
  token = configuredHermesToken(),
  client = null,
  db = null,
  clock = Date.now,
  turns = null,
  fetchImpl = undefined,
  webSocketImpl = undefined,
} = {}) {
  // Transporte injetado significa que quem chama está dirigindo o adaptador —
  // um teste, tipicamente. Nesse caso o bridge NÃO sobe sozinho: abrir socket
  // dentro de `npm test` deixaria o processo vivo depois do último teste, e
  // uma suíte que não termina é pior do que uma que falha.
  const transporteInjetado = Boolean(client) || Boolean(fetchImpl) || Boolean(webSocketImpl);

  const url = String(baseUrl || '').trim();
  const evento = (tipo, carga) => createAgentEvent(tipo, carga, clock);

  // O cliente é construído já, para que uma URL inválida falhe na construção do
  // runtime e não no meio da primeira conversa.
  let http = client;
  let erroDeConstrucao = null;
  if (!http && url) {
    try {
      http = createHermesClient({
        baseUrl: url,
        token,
        ...(fetchImpl ? { fetchImpl } : {}),
        ...(webSocketImpl ? { webSocketImpl } : {}),
      });
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

      registroDeTurnos?.begin(sessionId, signal);

      try {
        // Texto nosso, não o rótulo de estado do runtime.
        yield evento(AGENT_EVENTS.STATUS, { status: 'Pensando' });

        // O tradutor busca o resultado da ferramenta em quem a executou: o
        // bridge. O runtime não o carrega inteiro (ver eventTranslator).
        const tradutor = createEventTranslator({
          clock,
          resultFor: (nomeCanonico) => registroDeTurnos?.takeResult(sessionId, nomeCanonico) ?? null,
        });

        // O guard nasce por TURNO e conhece os valores privados dele. Com o
        // transporte novo há um id a menos: o `stream_id` do protocolo antigo
        // não existe mais, e o do turno é a própria sessão.
        const guarda = criarGuarda({ sessionId, evento });

        for await (const bruto of http.runTurn({ sessionId, message: ultima.content, signal })) {
          if (signal?.aborted) break;
          for (const saida of tradutor.traduzir(bruto)) {
            yield* guarda.publicar(saida);
            if (saida.type === AGENT_EVENTS.FAILED) return;
          }
        }

        if (signal?.aborted) return;

        // O fluxo pode acabar sem `message.complete` — o socket cai, o runtime
        // reinicia. Fechar aqui garante que um turno bem-sucedido sempre
        // termine com resposta e conclusão.
        for (const saida of tradutor.finalizar()) yield* guarda.publicar(saida);
      } finally {
        registroDeTurnos?.end(sessionId);
        // Cancelamento é melhor esforço e nunca lança (ver runtimeClient).
        if (signal?.aborted) await http.interrupt({ sessionId });
      }
    },
  };
}

/**
 * A última linha de defesa da identidade, no ritmo do fluxo.
 *
 * A identidade correta vem da persona, aplicada antes da geração. Isto aqui não
 * a constrói — confere. Se o runtime se apresentou como outra coisa, o defeito é
 * registrado no log do servidor (onde alguém pode agir) e a autoidentificação é
 * corrigida ANTES de o texto virar evento público.
 *
 * Só a construção "sou o X" é tocada. Um texto que fale de um personagem, de um
 * mito ou de qualquer assunto que o usuário tenha pedido passa inteiro — a
 * alternativa, trocar toda ocorrência de uma palavra, estragaria a resposta
 * legítima para proteger contra a ilegítima.
 *
 * `publicar` devolve de zero a dois eventos:
 *
 *   delta      um `agent.message.delta` com o texto já liberado, ou NENHUM
 *              evento quando ainda não há nada seguro a liberar. Um delta vazio
 *              seria ruído: a tela não tem o que fazer com ele.
 *   completed  a cauda retida sai antes, como último delta, para que o fluxo
 *              chegue inteiro à tela; e a mensagem final vai sanitizada por
 *              completo — é ela que o gateway grava no banco.
 */
function criarGuarda({ sessionId, evento }) {
  const guarda = createIdentityGuard({
    segredos: [sessionId],
    aoVazar: (motivos, amostra, ponto) => {
      // Diagnóstico suficiente para agir: a categoria, onde no fluxo aconteceu,
      // e um trecho curto que já vem sem o identificador. O valor do segredo
      // NUNCA entra no log — registrá-lo só mudaria o vazamento de lugar.
      logWarn(STAGES.AGENT_TURN_FAILED, 'A resposta do runtime vazou identidade interna.', {
        channel: CHANNELS.AGENT,
        detail: { motivos, ponto, trecho: amostra },
      });
    },
  });

  return {
    * publicar(saida) {
      if (saida.type === AGENT_EVENTS.MESSAGE_DELTA) {
        const seguro = guarda.delta(saida.text);
        if (seguro) yield { ...saida, text: seguro };
        return;
      }

      if (saida.type === AGENT_EVENTS.MESSAGE_COMPLETED) {
        const resto = guarda.fim();
        if (resto) yield evento(AGENT_EVENTS.MESSAGE_DELTA, { text: resto });
        yield { ...saida, text: guarda.completo(saida.text) };
        return;
      }

      yield saida;
    },
  };
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

  const { sessionId, bridgeSessionId } = await http.createSession();

  // A identidade NÃO é aplicada aqui, e a ausência é decisão.
  //
  // Ela já está aplicada: a persona é configuração do HERMES_HOME dedicado
  // (`display.personality`), lida quando o runtime constrói o agente e entregue
  // como instrução de sistema antes da primeira geração. Não há RPC a chamar —
  // o endpoint que existia para isso foi removido na v0.20.3 — e chamar um
  // seria fingir controle que este processo não tem. O que este processo pode
  // fazer é CONFERIR, e é o que o guard de identidade faz a cada delta.
  bindRuntimeSession({
    sessionId,
    // O nome pelo qual o BRIDGE vai reconhecer esta sessão. É outro: o runtime
    // entrega ao plugin o identificador durável, não o do gateway. Gravar só um
    // deles fazia toda chamada de ferramenta ser recusada.
    bridgeSessionId,
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
