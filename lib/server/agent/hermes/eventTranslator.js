// Tradução do fluxo do runtime para o vocabulário do Showrunner.
//
// Esta é a fronteira de identidade em movimento. Do lado de dentro chegam
// eventos com nome, forma e conteúdo do runtime; do lado de fora sai só o que
// `events.js` declara. O que não tem tradução não atravessa — não vira evento
// genérico, não vira log na tela, não vira nada.
//
// ── O que é deliberadamente descartado ──────────────────────────────────────
//
//   reasoning       o raciocínio privado do modelo. Foi observado no PASSO 7A.2
//                   carregando texto como "**Planning terminal tooling**", que
//                   é justamente o tipo de coisa que revela o runtime e as
//                   ferramentas que ele imaginou ter.
//   metering        tokens, custo, tps, tamanho de contexto — economia do
//                   runtime, não da conversa.
//   context_status  estado interno de prefill.
//   title/title_status  o runtime batiza a sessão dele; o Showrunner tem o
//                   próprio título de thread e não recebe ordens sobre ele.
//   agent_state_change  nomes de estado do runtime. `agent.status` existe, mas
//                   é alimentado com texto NOSSO, nunca com o rótulo de lá.
//
// ── A duplicação da mensagem final ──────────────────────────────────────────
//
// O runtime emite a resposta duas vezes: em pedaços (`token`) e inteira, dentro
// do `done`. Repassar as duas produziria a resposta em dobro. O tradutor
// acumula os pedaços, e no fim emite UMA `agent.message.completed` — preferindo
// o texto final do runtime quando ele existe, porque é o canônico, e caindo no
// acumulado quando não vem.

import { AGENT_EVENTS, agentErrorPayload, createAgentEvent } from '../events.js';
import { canonicalForDisplay } from './aliases.js';

/** Eventos do runtime que nunca viram AgentEvent. Listados para serem óbvios. */
export const EVENTOS_DESCARTADOS = Object.freeze([
  'reasoning', 'metering', 'context_status', 'title', 'title_status',
  'agent_state_change', 'ping', 'heartbeat',
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

  /** Traduz um evento do runtime. Devolve zero ou mais AgentEvent. */
  function traduzir(bruto) {
    const nome = String(bruto?.event || '');
    const carga = bruto?.payload ?? null;

    if (EVENTOS_DESCARTADOS.includes(nome)) return [];

    switch (nome) {
      case 'token': {
        const texto = typeof carga?.text === 'string' ? carga.text : '';
        if (!texto) return [];
        acumulado += texto;
        return [evento(AGENT_EVENTS.MESSAGE_DELTA, { text: texto })];
      }

      case 'tool': {
        const traduzido = nomeDeTool(carga);
        if (!traduzido) return [];
        const { toolCallId, canonico, argumentos } = traduzido;
        toolsAbertas.set(toolCallId, canonico);
        const payload = { toolCallId, name: canonico };
        if (argumentos) payload.arguments = argumentos;
        return [evento(AGENT_EVENTS.TOOL_STARTED, payload)];
      }

      case 'tool_complete': {
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

      case 'apperror':
      case 'error': {
        falhou = true;
        // A mensagem do runtime NÃO é repassada: ela cita status HTTP, nome de
        // provider e forma de payload. O usuário recebe uma frase nossa.
        return [evento(AGENT_EVENTS.FAILED, {
          error: { message: 'O agente não conseguiu concluir a resposta.', code: 'agent_runtime_failed' },
        })];
      }

      case 'done': {
        const doServidor = textoFinalDoDone(carga);
        if (doServidor !== null) textoFinal = doServidor;
        return [];
      }

      case 'stream_end': {
        return finalizar();
      }

      default:
        // Evento que não conhecemos. Some. É esta linha que garante que um
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
 * Reduz o resultado de uma ferramenta ao que a conversa pode mostrar.
 *
 * Lista fechada. O que a tool devolve já é público por construção, mas passar
 * por uma lista é o que garante que um campo novo — acrescentado a uma tool
 * meses depois, sem ninguém pensar nesta tela — não apareça sozinho na
 * interface. `null` quando não há nada que valha mostrar, e aí o evento sai
 * sem `result`, que é como ele sempre saiu.
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

/**
 * O texto final que o `done` carrega.
 *
 * O runtime devolve a sessão inteira nesse evento; o que interessa é a última
 * fala do assistente. Tudo o mais que vem junto (id de sessão, modelo, uso,
 * caminho de workspace) fica aqui e não é lido.
 */
function textoFinalDoDone(carga) {
  const mensagens = carga?.session?.messages;
  if (!Array.isArray(mensagens)) return null;

  for (let i = mensagens.length - 1; i >= 0; i -= 1) {
    const m = mensagens[i];
    if (m?.role !== 'assistant') continue;
    if (m?._error) return null;
    return typeof m.content === 'string' ? m.content : null;
  }
  return null;
}
