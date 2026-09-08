// Tradução do fluxo do runtime para o vocabulário do Showrunner.
//
// Esta é a fronteira de identidade em movimento. Do lado de dentro chegam
// quadros com nome, forma e conteúdo do runtime; do lado de fora sai só o que
// `events.js` declara. O que não tem tradução não atravessa — não vira evento
// genérico, não vira log na tela, não vira nada.
//
// ── O vocabulário de hoje ───────────────────────────────────────────────────
//
// O runtime fala JSON-RPC sobre WebSocket. Os quadros de evento têm a forma
// `{ method: "event", params: { type, session_id, payload } }`, e os que
// interessam são cinco:
//
//   message.delta     um pedaço do texto        → agent.message.delta
//   message.complete  o texto inteiro, uma vez  → agent.message.completed
//   tool.start        ferramenta chamada        → agent.tool.started
//   tool.complete     ferramenta terminada      → agent.tool.completed
//   session.info      as ferramentas da sessão  → NÃO vira evento: é conferido
//
// ── O que é deliberadamente descartado ──────────────────────────────────────
//
//   thinking.delta / reasoning.delta / reasoning.available
//                   o raciocínio privado do modelo. Foi observado no PASSO 7A.2
//                   carregando texto como "**Planning terminal tooling**", que
//                   é justamente o tipo de coisa que revela o runtime e as
//                   ferramentas que ele imaginou ter.
//   session.title / sessions.changed
//                   o runtime batiza e lista as sessões dele; o Showrunner tem
//                   o próprio título de thread e não recebe ordens sobre ele.
//   message.start / message.interim / status.update / tool.generating
//                   rótulos de estado do runtime. `agent.status` existe, mas é
//                   alimentado com texto NOSSO, nunca com o rótulo de lá.
//   gateway.ready   aperto de mão do transporte.
//
// E o `default` do switch: qualquer quadro desconhecido some. É essa linha que
// garante que uma versão nova do runtime não empurre vocabulário novo para
// dentro da aplicação sem alguém decidir traduzi-lo.
//
// ── Por que não há mais acumulação de texto ─────────────────────────────────
//
// O protocolo antigo mandava a resposta duas vezes — em pedaços e inteira — e o
// tradutor precisava escolher uma. Hoje `message.complete` traz o texto
// canônico do turno e é emitido UMA vez, depois de o laço de ferramentas
// terminar. O acumulado continua existindo só como rede: se `message.complete`
// vier sem texto, é ele que vira a resposta.

import { AGENT_EVENTS, agentErrorPayload, createAgentEvent } from '../events.js';
import { canonicalForDisplay } from './aliases.js';
import { assertIsolamentoAnunciado } from './runtimeClient.js';

/** Quadros do runtime que nunca viram AgentEvent. Listados para serem óbvios. */
export const EVENTOS_DESCARTADOS = Object.freeze([
  'gateway.ready', 'message.start', 'message.interim',
  'thinking.delta', 'reasoning.delta', 'reasoning.available',
  'session.title', 'sessions.changed', 'status.update',
  'tool.generating', 'tool.output_risk',
]);

/**
 * Constrói o tradutor.
 *
 * É uma máquina de estado pequena: acumula texto, lembra que tools abriu, e
 * decide o que emitir. `clock` injetável pelo motivo de sempre.
 */
export function createEventTranslator({ clock = Date.now, resultFor = null } = {}) {
  const evento = (tipo, carga) => createAgentEvent(tipo, carga, clock);

  let acumulado = '';
  let textoFinal = null;
  let concluido = false;
  let falhou = false;
  // toolCallId → nome canônico, para o `tool.completed` saber o que fechar.
  const toolsAbertas = new Map();

  /**
   * Traduz um quadro do runtime. Devolve zero ou mais AgentEvent.
   *
   * `session.info` é o caso que não devolve evento nenhum e ainda assim é o
   * mais importante: é por ele que o isolamento de ferramentas é conferido, a
   * cada turno, contra o que o runtime REALMENTE deu ao modelo. Um toolset a
   * mais derruba o turno aqui — antes de o modelo poder usá-lo.
   */
  function traduzir(quadro) {
    const params = quadro?.params ?? null;
    const nome = String(params?.type || '');
    const carga = params?.payload ?? null;

    if (EVENTOS_DESCARTADOS.includes(nome)) return [];

    switch (nome) {
      case 'session.info': {
        // Ausente em quadros parciais; só confere quando o runtime anuncia.
        const tools = carga?.tools ?? null;
        if (tools && typeof tools === 'object') assertIsolamentoAnunciado(tools);
        return [];
      }

      case 'message.delta': {
        const texto = typeof carga?.text === 'string' ? carga.text : '';
        if (!texto) return [];
        acumulado += texto;
        return [evento(AGENT_EVENTS.MESSAGE_DELTA, { text: texto })];
      }

      case 'tool.start': {
        const traduzido = nomeDeTool(carga);
        if (!traduzido) return [];
        const { toolCallId, canonico, argumentos } = traduzido;
        toolsAbertas.set(toolCallId, canonico);
        const payload = { toolCallId, name: canonico };
        if (argumentos) payload.arguments = argumentos;
        return [evento(AGENT_EVENTS.TOOL_STARTED, payload)];
      }

      case 'tool.complete': {
        const traduzido = nomeDeTool(carga);
        if (!traduzido) return [];
        const { toolCallId } = traduzido;
        const canonico = toolsAbertas.get(toolCallId) ?? traduzido.canonico;
        if (!canonico) return [];
        toolsAbertas.delete(toolCallId);

        const erro = carga?.error ?? null;
        if (erro) {
          return [evento(AGENT_EVENTS.TOOL_FAILED, {
            toolCallId, name: canonico,
            error: agentErrorPayload(typeof erro === 'string' ? erro : 'A ferramenta falhou.', 'tool_failed'),
          })];
        }

        // O resultado NÃO vem do runtime: o que ele anuncia junto é um preview
        // truncado, que não volta a ser objeto. Vem de quem executou a
        // ferramenta, do nosso lado — ver `recordResult` no bridge.
        const carga2 = { toolCallId, name: canonico };
        const resultado = resultFor ? resultFor(canonico) : null;
        const publico = resultadoPublico(resultado);
        if (publico) carga2.result = publico;

        return [evento(AGENT_EVENTS.TOOL_COMPLETED, carga2)];
      }

      case 'message.complete': {
        // O turno pode terminar em erro, e aí o texto do runtime é uma
        // mensagem de erro dele — que cita provider, status e forma de payload.
        // O usuário recebe uma frase nossa.
        if (carga?.status === 'error') {
          falhou = true;
          return [evento(AGENT_EVENTS.FAILED, {
            error: { message: 'O agente não conseguiu concluir a resposta.', code: 'agent_runtime_failed' },
          })];
        }
        const texto = typeof carga?.text === 'string' ? carga.text : '';
        if (texto) textoFinal = texto;
        return finalizar();
      }

      default:
        // Quadro que não conhecemos. Some. É esta linha que garante que um
        // runtime novo, ou uma versão nova deste, não empurre vocabulário
        // desconhecido para dentro da aplicação.
        return [];
    }
  }

  /**
   * Fecha o turno.
   *
   * Idempotente: `stream_end` e o fim do fluxo podem ambos chamar, e a resposta
   * só é emitida uma vez.
   */
  function finalizar() {
    if (concluido || falhou) return [];
    concluido = true;

    const texto = textoFinal !== null && textoFinal !== '' ? textoFinal : acumulado;
    const saida = [];
    if (texto) saida.push(evento(AGENT_EVENTS.MESSAGE_COMPLETED, { text: texto }));
    saida.push(evento(AGENT_EVENTS.COMPLETED, {}));
    return saida;
  }

  return {
    traduzir,
    finalizar,
    /** Só para teste e diagnóstico: o que foi acumulado até agora. */
    estado: () => ({ acumulado, textoFinal, concluido, falhou }),
  };
}

/**
 * Reduz o resultado de uma ferramenta ao que a APLICAÇÃO pode ver.
 *
 * Lista fechada, e é a PRIMEIRA de duas. Esta guarda a aplicação: um campo novo
 * acrescentado a uma tool meses depois não atravessa sozinho só porque a tool
 * passou a devolvê-lo.
 *
 * O `jobId` sai daqui de propósito — o gateway precisa dele para saber qual
 * geração este turno começou e a que mensagem o resultado pertence. Ele NÃO
 * chega ao navegador: a segunda redução, em `events.js` → `publicAgentEvent`,
 * é a que corta a borda pública, e ela roda depois de o servidor já ter lido o
 * que precisava.
 *
 * `null` quando não há nada que valha passar, e aí o evento sai sem `result`,
 * que é como ele sempre saiu.
 */
function resultadoPublico(resultado) {
  if (!resultado || typeof resultado !== 'object') return null;

  const saida = {};
  if (typeof resultado.jobId === 'string') saida.jobId = resultado.jobId;
  if (typeof resultado.status === 'string') saida.status = resultado.status;

  const asset = resultado.asset && typeof resultado.asset === 'object' ? resultado.asset : null;
  if (asset && typeof asset.id === 'string') {
    saida.asset = {
      id: asset.id,
      kind: typeof asset.kind === 'string' ? asset.kind : null,
      mediaUrl: typeof asset.mediaUrl === 'string' ? asset.mediaUrl : null,
      mimeType: typeof asset.mimeType === 'string' ? asset.mimeType : null,
      derivedFromAssetId: typeof asset.derivedFromAssetId === 'string'
        ? asset.derivedFromAssetId
        : null,
    };
  }

  return Object.keys(saida).length ? saida : null;
}

/**
 * Extrai o nome canônico de um evento de tool.
 *
 * O runtime cita o ALIAS (`og_generate_image`). Se o nome não estiver na tabela
 * — porque o runtime chamou outra coisa, ou porque a forma do evento mudou —
 * devolve `null` e o evento é omitido. Omitir é o certo: um `tool.started` com
 * nome que não sabemos traduzir mostraria vocabulário do runtime na tela.
 */
function nomeDeTool(carga) {
  if (!carga || typeof carga !== 'object') return null;

  const alias = carga.name ?? carga.tool ?? carga.tool_name ?? null;
  const canonico = canonicalForDisplay(alias);
  if (!canonico) return null;

  const toolCallId = String(carga.tid ?? carga.id ?? carga.tool_call_id ?? canonico);
  const argumentos = carga.args && typeof carga.args === 'object' && !Array.isArray(carga.args)
    ? carga.args
    : null;

  return { toolCallId, canonico, argumentos };
}
