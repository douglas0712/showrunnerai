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

/** O código com que o runtime real diz "não conheço essa sessão" (`_sess_nowait`). */
export const CODIGO_SESSAO_DESCONHECIDA = 4001;

/**
 * O ciclo de vida das sessões do runtime, imitado.
 *
 * ── Por que isto precisa existir ────────────────────────────────────────────
 *
 * O runtime real RECICLA sozinho: uma sessão cujo WebSocket criador se
 * desconectou e que não está executando nada é recolhida depois de uma janela
 * de carência (`ws_orphan_reap`, 20 s por padrão). Como esta integração abre um
 * socket por RPC e o fecha em seguida, toda sessão nossa é órfã desde que nasce.
 *
 * Um socket falso sem memória entre instâncias não consegue representar isso —
 * cada conexão nasceria sabendo de tudo. Este objeto é a memória que falta: ele
 * atravessa as conexões, guarda quais identificadores estão VIVOS, e sabe a
 * diferença entre o identificador vivo (efêmero) e o durável (o que sobrevive
 * à reciclagem e é o que `session.resume` recebe).
 *
 * `reciclar()` é o `ws_orphan_reap`: os vivos somem, o durável fica.
 * `esquecerDuravel()` é o caso mais extremo — nem o registro durável sobrou.
 */
export function criarSessoesFalsas({
  bridgeSessionId = BRIDGE_SESSION_ID_FALSO,
  primeiroVivo = SESSION_ID_FALSO,
} = {}) {
  const vivas = new Set();
  let seq = 0;
  let duravelExiste = true;

  const novoVivo = () => {
    seq += 1;
    return seq === 1 ? primeiroVivo : `${primeiroVivo}_r${seq}`;
  };

  return {
    bridgeSessionId,
    get vivas() { return [...vivas]; },
    /** Quantos identificadores VIVOS já foram entregues neste runtime falso. */
    get emitidas() { return seq; },

    conhece(sessionId) { return vivas.has(String(sessionId)); },

    criar() {
      const sessionId = novoVivo();
      vivas.add(sessionId);
      duravelExiste = true;
      return { session_id: sessionId, stored_session_id: bridgeSessionId, messages: [] };
    },

    /** `session.resume`: o durável continua; o vivo é outro. */
    reabrir(alvo) {
      if (!duravelExiste || String(alvo) !== bridgeSessionId) return null;
      const sessionId = novoVivo();
      vivas.add(sessionId);
      return { session_id: sessionId, session_key: bridgeSessionId, messages: [] };
    },

    /** O `ws_orphan_reap`: some com os vivos, preserva o durável. */
    reciclar() { vivas.clear(); },

    /** O caso extremo: nem o registro durável sobrou. */
    esquecerDuravel() { vivas.clear(); duravelExiste = false; },
  };
}

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
  cairAposRoteiro = false,
  // Quando informado, o ciclo de vida das sessões é o de `criarSessoesFalsas`:
  // identificadores nascem, ficam vivos, e podem ser reciclados entre conexões.
  // Sem ele, vale o comportamento antigo — uma sessão fixa que nunca morre —,
  // que é o que a maioria dos testes quer e não precisa saber que existe
  // reciclagem nenhuma.
  sessoes = null,
  // Uma recusa arbitrária a `prompt.submit`, para exercitar o que NÃO é uma
  // sessão reciclada. `4001` é o "400" deste protocolo e serve a mais de vinte
  // condições distintas — reconhecê-lo sozinho como "sessão sumiu" faria o
  // Showrunner repetir a fala do usuário contra recusas que não são sobre
  // sessão nenhuma.
  recusarSubmissao = null,
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
          result: sessoes
            ? sessoes.criar()
            : { session_id: sessionId, stored_session_id: bridgeSessionId, messages: [] },
        });
        return;
      }

      if (pedido.method === 'session.resume') {
        const reaberta = sessoes?.reabrir(pedido.params?.session_id);
        this._quadro(reaberta
          ? { jsonrpc: '2.0', id: pedido.id, result: reaberta }
          // 4007 é o que o runtime real responde quando nem o registro durável
          // existe mais — distinto do 4001 de "a sessão viva sumiu".
          : { jsonrpc: '2.0', id: pedido.id, error: { code: 4007, message: 'session not found' } });
        return;
      }

      if (pedido.method === 'session.interrupt') {
        this._quadro({ jsonrpc: '2.0', id: pedido.id, result: { ok: true } });
        return;
      }

      if (pedido.method === 'prompt.submit') {
        if (recusarSubmissao) {
          this._quadro({ jsonrpc: '2.0', id: pedido.id, error: { ...recusarSubmissao } });
          return;
        }

        // A sessão foi reciclada entre um turno e outro. É a resposta EXATA do
        // runtime real (`_sess_nowait`), e é o que o adaptador precisa
        // distinguir de "o serviço está fora do ar".
        if (sessoes && !sessoes.conhece(pedido.params?.session_id)) {
          this._quadro({
            jsonrpc: '2.0',
            id: pedido.id,
            error: { code: CODIGO_SESSAO_DESCONHECIDA, message: 'session not found' },
          });
          return;
        }

        this._quadro({ jsonrpc: '2.0', id: pedido.id, result: { status: 'streaming' } });
        if (tools) this._evento('session.info', { tools });
        this._evento('message.start', {});
        for (const passo of roteiro) this._evento(passo.type, passo.payload);

        // O canal caindo DEPOIS de o runtime já ter falado. O disparo é numa
        // macrotarefa de propósito: os quadros acima chegam por microtarefa, e
        // quem consome precisa tê-los recebido de verdade antes da queda — é
        // essa ordem que faz o cenário ser "quebrou no meio" e não "nunca
        // respondeu", que é o outro cenário e tem outro tratamento.
        if (cairAposRoteiro) setTimeout(() => this._disparar('error', {}), 0);
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
