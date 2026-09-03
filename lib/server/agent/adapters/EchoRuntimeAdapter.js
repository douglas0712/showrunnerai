// EchoRuntimeAdapter — a primeira implementação do AgentRuntimePort.
//
// Ele não pensa. Ele existe para provar que o corpo do agente do Showrunner
// funciona inteiro — thread, mensagem, gateway, porta, eventos, persistência,
// API — antes de existir qualquer runtime de raciocínio por trás dela. Se o
// ciclo completo fecha com o Echo, trocar o Echo por outro adaptador é uma
// linha em runtimes.js.
//
// O que ele deliberadamente NÃO é: um diretor de mentira. Nenhuma heurística
// de intenção, nenhum roteiro simulado, nenhuma resposta que finja competência
// que a aplicação ainda não tem. Uma dessas seria a coisa mais fácil de
// escrever hoje e a mais cara de apagar depois.
//
// Garantias, todas verificáveis:
//
//   determinístico   mesma entrada e mesmo relógio → mesma sequência de eventos,
//                    campo a campo. Nada de aleatório, nada de Math.random.
//   sem rede         o módulo importa `./events.js` e mais nada.
//   sem LLM          nenhum modelo, nenhuma chave, nenhuma inferência.
//   sem disco        não lê nem escreve arquivo nenhum.
//   rápido           um turno inteiro custa microssegundos.
//
// Ele emite os eventos de conversa e só eles. Os de tool existem no vocabulário
// mas não são emitidos aqui: não há tool nesta etapa, e emitir um evento de
// ferramenta que ninguém executou seria log simulado.

import {
  AGENT_EVENTS, createAgentEvent,
} from '../events.js';

/** Tamanho dos pedaços em que a resposta é emitida. */
const TAMANHO_DO_DELTA = 24;

/**
 * Constrói o adaptador.
 *
 * `clock` injetável pelo motivo de sempre: sem ele o carimbo de tempo dos
 * eventos mudaria a cada execução e a determinação deixaria de ser
 * demonstrável. O padrão é o relógio de verdade.
 */
export function createEchoRuntime({ clock = Date.now } = {}) {
  const evento = (tipo, carga) => createAgentEvent(tipo, carga, clock);

  return {
    id: 'echo',

    // Sempre disponível: não há nada para estar fora do ar. É justamente por
    // isso que ele serve de piso — qualquer falha num teste é da nossa camada.
    isAvailable: () => true,
    unavailableReason: () => null,

    async testConnection() {
      return { ok: true, detail: { runtime: 'echo', network: false } };
    },

    /**
     * Um turno.
     *
     * Gerador assíncrono, que é a forma mais direta de cumprir "devolve um
     * AsyncIterable de eventos". O gateway drena isto hoje; uma rota SSE
     * repassará evento a evento amanhã, sem tocar aqui.
     */
    async* run({ messages = [], tools = [], invokeTool = null, signal = null } = {}) {
      // O contrato diz que `tools` chega como coleção; PASSO 6 a preenche.
      // A conferência é para que oferecer algo diferente de uma coleção falhe.
      if (!Array.isArray(tools)) {
        throw new TypeError('tools precisa ser uma coleção.');
      }

      // Echo não usa invokeTool (é runtime de teste), mas aceita na assinatura
      // para permanecer compatível com o contrato. Adaptadores reais usariam.
      if (invokeTool !== null && typeof invokeTool !== 'function') {
        throw new TypeError('invokeTool precisa ser uma função.');
      }

      const ultima = ultimaDoUsuario(messages);
      if (!ultima) {
        // Um turno sem fala do usuário é erro de quem chamou, não resposta
        // vazia. O gateway garante que isto não acontece; falhar alto aqui é o
        // que impede um futuro chamador de descobrir tarde.
        throw new Error('Não há mensagem de usuário para responder.');
      }

      yield evento(AGENT_EVENTS.STARTED, {});
      yield evento(AGENT_EVENTS.STATUS, { status: 'Pensando' });

      // Resposta neutra que não revela detalhes da implementação do runtime.
      const resposta = `Recebi: ${ultima.content}`;

      // A resposta sai em pedaços mesmo sem streaming na rota. É o que mantém
      // o caminho de delta exercitado desde já: quando o SSE chegar, ele não
      // vai estrear em produção.
      for (const pedaco of fatiar(resposta, TAMANHO_DO_DELTA)) {
        if (signal?.aborted) return;
        yield evento(AGENT_EVENTS.MESSAGE_DELTA, { text: pedaco });
      }

      yield evento(AGENT_EVENTS.MESSAGE_COMPLETED, { text: resposta });
      yield evento(AGENT_EVENTS.COMPLETED, {});
    },
  };
}

/** A última fala do usuário na lista — a que este turno responde. */
function ultimaDoUsuario(messages) {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') return messages[i];
  }
  return null;
}

/** Fatia preservando o texto: a concatenação dos pedaços é o texto original. */
function fatiar(texto, tamanho) {
  const pedacos = [];
  for (let i = 0; i < texto.length; i += tamanho) {
    pedacos.push(texto.slice(i, i + tamanho));
  }
  return pedacos;
}
