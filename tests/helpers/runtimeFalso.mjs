// Um runtime de mentira que fala o protocolo REAL da v0.20.3.
//
// Existe para que `npm test` exercite o adaptador inteiro — transporte,
// tradução, isolamento, guard de identidade — sem subir runtime nenhum, sem
// rede e sem credencial. A suíte precisa continuar determinística.
//
// O que ele imita é o que foi MEDIDO contra o servidor rodando: o aperto de
// mão `gateway.ready`, os métodos `session.create` / `prompt.submit` /
// `session.interrupt`, e os quadros `session.info`, `message.delta`,
// `message.complete`, `tool.start`, `tool.complete`.

export const SESSION_ID_FALSO = 'a1b2c3d4e5f60718';
/** O segundo nome da mesma sessão: o que o runtime entrega ao plugin. */
export const BRIDGE_SESSION_ID_FALSO = '20260908_120000_abcdef';

/** As ferramentas que o runtime dedicado anuncia quando está isolado direito. */
export const TOOLS_ISOLADAS = Object.freeze({
  showrunner: ['og_generate_image', 'og_generate_video', 'og_get_job'],
});

/**
 * Um WebSocket falso, com a mesma superfície que o cliente usa.
 *
 * Entrega os quadros de forma assíncrona, como o de verdade, porque um socket
 * que respondesse de forma síncrona esconderia exatamente os defeitos de ordem
 * que este transporte pode ter.
 */
export function criarWebSocketFalso({
  roteiro = [],
  tools = TOOLS_ISOLADAS,
  sessionId = SESSION_ID_FALSO,
  bridgeSessionId = BRIDGE_SESSION_ID_FALSO,
  aoEnviar = null,
  recusarAbertura = false,
} = {}) {
  return class WebSocketFalso {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.enviados = [];
      this._ouvintes = new Map();
      queueMicrotask(() => {
        if (recusarAbertura) {
          this.readyState = 3;
          this._disparar('close', {});
          return;
        }
        this.readyState = 1;
        this._disparar('open', {});
        this._quadro({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } });
      });
    }

    addEventListener(nome, fn, opcoes = {}) {
      const lista = this._ouvintes.get(nome) ?? [];
      lista.push({ fn, once: Boolean(opcoes.once) });
      this._ouvintes.set(nome, lista);
    }

    removeEventListener(nome, fn) {
      this._ouvintes.set(nome, (this._ouvintes.get(nome) ?? []).filter((o) => o.fn !== fn));
    }

    _disparar(nome, evento) {
      for (const { fn, once } of [...(this._ouvintes.get(nome) ?? [])]) {
        fn(evento);
        if (once) this.removeEventListener(nome, fn);
      }
      const direto = this[`on${nome}`];
      if (typeof direto === 'function') direto.call(this, evento);
    }

    _quadro(objeto) {
      queueMicrotask(() => this._disparar('message', { data: JSON.stringify(objeto) }));
    }

    /** Um evento do runtime, na forma exata que o servidor real emite. */
    _evento(type, payload) {
      this._quadro({ jsonrpc: '2.0', method: 'event', params: { type, session_id: sessionId, payload } });
    }

    send(bruto) {
      const pedido = JSON.parse(bruto);
      this.enviados.push(pedido);
      aoEnviar?.(pedido);

      if (pedido.method === 'session.create') {
        this._quadro({
          jsonrpc: '2.0',
          id: pedido.id,
          result: { session_id: sessionId, stored_session_id: bridgeSessionId, messages: [] },
        });
        return;
      }

      if (pedido.method === 'session.interrupt') {
        this._quadro({ jsonrpc: '2.0', id: pedido.id, result: { ok: true } });
        return;
      }

      if (pedido.method === 'prompt.submit') {
        this._quadro({ jsonrpc: '2.0', id: pedido.id, result: { status: 'streaming' } });
        if (tools) this._evento('session.info', { tools });
        this._evento('message.start', {});
        for (const passo of roteiro) this._evento(passo.type, passo.payload);
        return;
      }

      this._quadro({ jsonrpc: '2.0', id: pedido.id, error: { code: -32601, message: 'unknown method' } });
    }

    close() { this.readyState = 3; this._disparar('close', {}); }
  };
}

/** Um roteiro de texto entregue nos pedaços que o teste escolher. */
export function roteiroDeTexto(pedacos, { textoFinal = null, status = 'complete' } = {}) {
  const lista = pedacos.map((text) => ({ type: 'message.delta', payload: { text } }));
  lista.push({
    type: 'message.complete',
    payload: { text: textoFinal ?? pedacos.join(''), status },
  });
  return lista;
}

/** Um `fetch` falso para `/api/health`, a única rota HTTP que a integração usa. */
export function criarFetchFalso({ saudavel = true } = {}) {
  return async (url) => {
    if (String(url).endsWith('/api/health')) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: saudavel, version: '0.20.3', auth_required: false }),
      };
    }
    return { ok: false, status: 404, text: async () => '{}' };
  };
}
