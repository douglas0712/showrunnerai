// Cliente do runtime externo.
//
// Fala só o que existe de verdade na v0.20.3, verificado contra o servidor
// rodando (PASSO 8.2B) — pelo `openapi.json` dele e pelo fonte instalado:
//
//     GET  /api/health                       diagnóstico, sem autenticação
//     WS   /api/ws?token=…                   a conversa, JSON-RPC 2.0
//
// E, dentro do WebSocket, três métodos:
//
//     session.create      abre a conversa do lado do runtime
//     prompt.submit       entrega a fala do usuário e começa o turno
//     session.interrupt   cancela o turno em andamento
//
// Nenhum outro. Um endpoint inventado é um erro que só aparece em produção.
//
// ── O que mudou, e por que este arquivo foi reescrito ───────────────────────
//
// Até a v0.19 a conversa era HTTP + SSE: `/api/session/new`, `/api/chat/start`,
// `/api/chat/stream`, `/api/chat/cancel`, `/api/personality/set`. NENHUM desses
// existe hoje — não foram renomeados, foram removidos, e o servidor responde
// 404. O turno virou JSON-RPC sobre WebSocket, que é o mesmo transporte que o
// aplicativo de desktop usa.
//
// ── Onde foi parar o isolamento ─────────────────────────────────────────────
//
// Era um campo do corpo de `session.new`. Hoje é `HERMES_TUI_TOOLSETS` no
// processo do runtime dedicado, lido por `_load_enabled_toolsets` como pino
// explícito — ele vence a postura automática e a configuração do ambiente.
//
// Isso move a decisão do adaptador para quem sobe o processo, então a
// conferência também mudou de lugar: o runtime anuncia, a cada turno, as
// ferramentas que a sessão realmente recebeu (evento `session.info`), e é ESSE
// anúncio que o adaptador confere. É uma garantia mais forte do que a antiga —
// antes conferíamos o que pedimos, agora conferimos o que o modelo tem na mão.
//
// ── Onde foi parar a persona ────────────────────────────────────────────────
//
// Era `POST /api/personality/set`, por sessão. Hoje são duas chaves do
// config.yaml do HERMES_HOME dedicado: `agent.personalities.showrunner` define
// e `display.personality` escolhe. Não há RPC — e não precisa haver, porque o
// home é dedicado. Ver `integrations/hermes/prepare.mjs`.

/** Falha ao falar com o runtime. A mensagem NUNCA chega ao usuário como está. */
export class HermesTransportError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'HermesTransportError';
    this.detail = detail;
  }
}

/**
 * Os toolsets que TODA sessão desta integração pode ter. Um só.
 *
 * `showrunner` é o toolset que o plugin registra.
 *
 * ── Onde foi parar o `no_mcp` ───────────────────────────────────────────────
 *
 * Era obrigatório: a sentinela que desligava todo servidor MCP do ambiente.
 * No pino explícito da v0.20.3 ela é IGNORADA — o runtime imprime
 * "ignoring unknown HERMES_TUI_TOOLSETS entries: no_mcp" e segue. Deixá-la na
 * lista seria carregar uma proteção que não protege.
 *
 * E não é preciso: nesse caminho o runtime devolve exatamente os toolsets
 * nomeados, e só dobra um servidor MCP se ele estiver nomeado junto. A exclusão
 * deixou de ser uma sentinela para ser estrutural — o que não se pede, não vem.
 *
 * Medido contra o servidor rodando: uma sessão nasce com `{showrunner: [...]}`
 * e nada mais. É contra esta lista que o anúncio é conferido a cada turno.
 */
export const TOOLSETS_OBRIGATORIOS = Object.freeze(['showrunner']);

/** Valores que jamais podem ser aceitos como toolsets. */
const TOOLSETS_PROIBIDOS = Object.freeze(['all', '*']);

/**
 * Confere a lista de toolsets que o runtime diz ter aplicado.
 *
 * Redundante com a constante logo acima — de propósito. É mais barato esbarrar
 * aqui do que descobrir pela tela do usuário que o agente ganhou um terminal.
 */
export function assertToolsetsSeguros(toolsets) {
  if (!Array.isArray(toolsets) || toolsets.length === 0) {
    throw new HermesTransportError(
      'Configuração de isolamento inválida: a lista de toolsets precisa ser não vazia.',
      { toolsets },
    );
  }
  for (const nome of toolsets) {
    if (typeof nome !== 'string' || !nome.trim()) {
      throw new HermesTransportError('Configuração de isolamento inválida: toolset vazio.', {});
    }
    if (TOOLSETS_PROIBIDOS.includes(nome.trim().toLowerCase())) {
      throw new HermesTransportError(
        `Configuração de isolamento inválida: "${nome}" concede acesso total.`,
        { toolset: nome },
      );
    }
  }
  if (!toolsets.includes('showrunner')) {
    throw new HermesTransportError(
      'Configuração de isolamento inválida: o toolset do Showrunner está ausente.',
      { toolsets },
    );
  }
  return toolsets;
}

/**
 * Os toolsets que a sessão REALMENTE recebeu, conferidos.
 *
 * `session.info` traz um mapa `{ toolset: [ferramentas] }`. Qualquer toolset
 * fora do combinado — `terminal`, `file`, `browser`, `code_execution` — derruba
 * o turno aqui, antes de o modelo poder usá-lo.
 */
export function assertIsolamentoAnunciado(tools) {
  if (!tools || typeof tools !== 'object') {
    throw new HermesTransportError('O runtime não anunciou as ferramentas da sessão.', {});
  }
  const anunciados = Object.keys(tools);
  assertToolsetsSeguros(anunciados);

  const extras = anunciados.filter((nome) => !TOOLSETS_OBRIGATORIOS.includes(nome));
  if (extras.length) {
    throw new HermesTransportError(
      'O runtime não aplicou o isolamento de ferramentas exigido.',
      { extras },
    );
  }
  return anunciados;
}

const TIMEOUT_PADRAO_MS = 20000;
/** Quanto o turno pode ficar em silêncio antes de ser dado por perdido. */
const SILENCIO_MAXIMO_MS = 180000;

/**
 * Constrói o cliente.
 *
 * `fetchImpl` e `webSocketImpl` injetáveis porque é o que permite testar o
 * adaptador inteiro contra um servidor de mentira sem subir runtime nenhum — e
 * o `npm test` precisa continuar determinístico.
 */
export function createHermesClient({
  baseUrl,
  token = '',
  fetchImpl = globalThis.fetch,
  webSocketImpl = globalThis.WebSocket,
  timeoutMs = TIMEOUT_PADRAO_MS,
  idleMs = SILENCIO_MAXIMO_MS,
} = {}) {
  const raiz = String(baseUrl || '').replace(/\/+$/, '');
  if (!raiz) throw new HermesTransportError('URL do runtime não configurada.', {});
  if (typeof fetchImpl !== 'function') {
    throw new HermesTransportError('fetch indisponível neste ambiente.', {});
  }
  if (typeof webSocketImpl !== 'function') {
    throw new HermesTransportError('WebSocket indisponível neste ambiente.', {});
  }

  const credencial = String(token || '');
  const urlDoSocket = () => {
    const base = `${raiz.replace(/^http/, 'ws')}/api/ws`;
    return credencial ? `${base}?token=${encodeURIComponent(credencial)}` : base;
  };

  /**
   * Uma conversa com o socket, do `gateway.ready` até o fim do turno.
   *
   * Gerador assíncrono: quem consome controla o ritmo e pode parar no meio
   * simplesmente saindo do laço, que é o que o cancelamento faz. O socket é
   * fechado no `finally`, sempre.
   */
  async function* falar({ aoAbrir, terminou, signal = null, rotulo }) {
    const socket = new webSocketImpl(urlDoSocket());

    // Fila entre o callback do socket e o gerador: o socket empurra, o
    // gerador puxa. Sem ela, um quadro que chegasse enquanto quem consome
    // ainda processa o anterior seria perdido.
    const fila = [];
    let acordar = null;
    let encerrado = false;
    let falha = null;

    const empurrar = (item) => {
      fila.push(item);
      acordar?.();
      acordar = null;
    };

    socket.onmessage = (evento) => {
      for (const linha of String(evento.data ?? '').split('\n')) {
        if (!linha.trim()) continue;
        let quadro;
        try { quadro = JSON.parse(linha); } catch { continue; }
        empurrar(quadro);
      }
    };
    socket.onerror = () => {
      falha = new HermesTransportError('O fluxo do runtime foi interrompido.', { rotulo });
      encerrado = true;
      acordar?.(); acordar = null;
    };
    socket.onclose = () => { encerrado = true; acordar?.(); acordar = null; };

    const abortar = () => { encerrado = true; acordar?.(); acordar = null; };
    if (signal) {
      if (signal.aborted) abortar();
      else signal.addEventListener('abort', abortar, { once: true });
    }

    const enviar = (metodo, params, id) => {
      socket.send(JSON.stringify({ jsonrpc: '2.0', id: String(id), method: metodo, params }));
    };

    try {
      await esperarAbertura(socket, timeoutMs, rotulo);

      let abriu = false;
      while (!encerrado) {
        if (!fila.length) {
          const esperou = await Promise.race([
            new Promise((resolve) => { acordar = () => resolve(true); }),
            adormecer(idleMs).then(() => false),
          ]);
          if (!esperou && !fila.length) {
            throw new HermesTransportError('O runtime parou de responder.', { rotulo });
          }
          continue;
        }

        const quadro = fila.shift();
        if (falha) throw falha;

        // `gateway.ready` é o aperto de mão: só depois dele o servidor aceita
        // RPC. Mandar antes é mandar para o vazio.
        if (!abriu && quadro?.params?.type === 'gateway.ready') {
          abriu = true;
          aoAbrir(enviar);
          continue;
        }

        const erro = quadro?.error;
        if (erro) {
          throw new HermesTransportError('O runtime recusou a requisição.', {
            rotulo, codigo: erro.code ?? null,
          });
        }

        yield quadro;
        if (terminou(quadro)) return;
      }

      if (falha) throw falha;
      if (signal?.aborted) return;
      throw new HermesTransportError('O runtime encerrou o fluxo antes da resposta.', { rotulo });
    } finally {
      if (signal) signal.removeEventListener('abort', abortar);
      try { socket.close(); } catch { /* já fechado */ }
    }
  }

  return {
    baseUrl: raiz,

    /**
     * GET /api/health — a única rota HTTP que esta integração usa.
     *
     * Pública por decisão do runtime: ela não exige credencial, e por isso
     * responder não prova que a credencial está certa. Quem prova isso é o
     * primeiro turno.
     */
    async health({ signal = null } = {}) {
      const controlador = new AbortController();
      const relogio = setTimeout(() => controlador.abort(), timeoutMs);
      const abortar = () => controlador.abort();
      if (signal) {
        if (signal.aborted) controlador.abort();
        else signal.addEventListener('abort', abortar, { once: true });
      }

      let resposta;
      try {
        resposta = await fetchImpl(`${raiz}/api/health`, { signal: controlador.signal });
      } catch (erro) {
        throw new HermesTransportError('Não foi possível falar com o runtime.', {
          causa: erro?.message || String(erro),
        });
      } finally {
        clearTimeout(relogio);
        if (signal) signal.removeEventListener('abort', abortar);
      }

      if (!resposta.ok) {
        throw new HermesTransportError('O runtime recusou a requisição.', {
          status: resposta.status,
        });
      }
      const texto = await resposta.text();
      let carga = null;
      try { carga = texto ? JSON.parse(texto) : null; } catch { carga = null; }
      if (!carga?.ok) {
        throw new HermesTransportError('O runtime respondeu, mas não está pronto.', {});
      }
      return carga;
    },

    /**
     * Abre uma conversa do lado do runtime e devolve o id dela.
     *
     * Socket próprio, curto: a sessão sobrevive à desconexão — foi medido — e
     * é reencontrada pelo id nos turnos seguintes. Gastar uma conexão só para
     * criar é o preço de manter `garantirSessao` fora do caminho do turno, e é
     * o que permite gravar o vínculo no banco antes de a primeira palavra ser
     * gerada.
     */
    async createSession({ signal = null } = {}) {
      let sessionId = null;
      let bridgeSessionId = null;
      for await (const quadro of falar({
        rotulo: 'session.create',
        signal,
        aoAbrir: (enviar) => enviar('session.create', { source: 'desktop' }, 1),
        terminou: (quadro) => quadro?.id === '1',
      })) {
        if (quadro?.id !== '1') continue;
        sessionId = quadro?.result?.session_id ?? null;
        bridgeSessionId = quadro?.result?.stored_session_id ?? null;
      }
      if (!sessionId) {
        throw new HermesTransportError('O runtime não devolveu um identificador de sessão.', {});
      }
      // Os DOIS nomes da mesma sessão. O segundo é o que o runtime entrega ao
      // plugin quando o modelo chama uma ferramenta, e sem ele o bridge não
      // reconhece a chamada. Ver `sessionBinding`.
      return {
        sessionId: String(sessionId),
        bridgeSessionId: bridgeSessionId ? String(bridgeSessionId) : null,
      };
    },

    /**
     * O turno: entrega a fala do usuário e rende os quadros do runtime.
     *
     * Termina no `message.complete`, que o servidor emite UMA vez por turno,
     * depois de o laço de ferramentas ter acabado. Fechar no primeiro texto
     * cortaria um turno que ainda ia chamar uma ferramenta.
     */
    async* runTurn({ sessionId, message, signal = null } = {}) {
      yield* falar({
        rotulo: 'prompt.submit',
        signal,
        aoAbrir: (enviar) => enviar(
          'prompt.submit',
          { session_id: String(sessionId), text: String(message) },
          1,
        ),
        terminou: (quadro) => quadro?.params?.type === 'message.complete',
      });
    },

    /**
     * Cancela o turno em andamento — melhor esforço; nunca lança.
     *
     * Se o runtime já terminou, ou não responde, insistir não melhora nada, e
     * propagar transformaria um cancelamento bem-sucedido do nosso lado num
     * erro visível.
     */
    async interrupt({ sessionId } = {}) {
      try {
        for await (const quadro of falar({
          rotulo: 'session.interrupt',
          aoAbrir: (enviar) => enviar('session.interrupt', { session_id: String(sessionId) }, 1),
          terminou: (quadro) => quadro?.id === '1',
        })) {
          if (quadro?.id === '1') return true;
        }
        return false;
      } catch {
        return false;
      }
    },
  };
}

function adormecer(ms) {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function esperarAbertura(socket, timeoutMs, rotulo) {
  if (socket.readyState === 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const relogio = setTimeout(() => {
      reject(new HermesTransportError('Não foi possível abrir o fluxo do runtime.', { rotulo }));
    }, timeoutMs);
    socket.addEventListener('open', () => { clearTimeout(relogio); resolve(); }, { once: true });
    socket.addEventListener('error', () => {
      clearTimeout(relogio);
      reject(new HermesTransportError('Não foi possível abrir o fluxo do runtime.', { rotulo }));
    }, { once: true });
    socket.addEventListener('close', () => {
      clearTimeout(relogio);
      reject(new HermesTransportError('O runtime recusou abrir o fluxo.', { rotulo }));
    }, { once: true });
  });
}
