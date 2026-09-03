// Cliente HTTP do runtime externo.
//
// Fala só os endpoints que existem de verdade, verificados contra o servidor
// rodando (PASSO 7A.1–7A.3):
//
//     GET  /health
//     POST /api/session/new
//     POST /api/chat/start
//     GET  /api/chat/stream?stream_id=...
//     POST /api/chat/cancel
//
// Nenhum outro. Um endpoint inventado é um erro que só aparece em produção.
//
// ── O isolamento mora aqui ──────────────────────────────────────────────────
//
// `TOOLSETS_OBRIGATORIOS` é a razão de este arquivo criar sessões em vez de
// deixar o adaptador montar o corpo. No PASSO 7A.2 e 7A.3 foi medido, contra o
// servidor real, o que cada valor produz:
//
//     ["showrunner","no_mcp"]  →  1 ferramenta,  nenhuma perigosa
//     ["all"] / ["*"]          → 36 ferramentas, terminal/read_file/write_file/execute_code
//     null                     → 36 ferramentas, idem
//     []                       → recusado pela API (400); e, internamente, o
//                                servidor trata lista vazia como "não veio",
//                                caindo no padrão de acesso total
//
// Ou seja: a diferença entre isolar e não isolar é este campo. Ele não é
// parâmetro — é constante, e a função confere o que montou antes de enviar.

import { createSseParser, parseEventData } from './sseParser.js';

/** Falha ao falar com o runtime. A mensagem NUNCA chega ao usuário como está. */
export class HermesTransportError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'HermesTransportError';
    this.detail = detail;
  }
}

/**
 * Os toolsets que TODA sessão desta integração usa.
 *
 * `showrunner` é o toolset que o plugin registra. `no_mcp` é a sentinela que
 * desliga todo servidor MCP configurado globalmente — sem ela, os MCP do
 * ambiente entram junto.
 */
export const TOOLSETS_OBRIGATORIOS = Object.freeze(['showrunner', 'no_mcp']);

/** Valores que jamais podem ser enviados como toolsets. */
const TOOLSETS_PROIBIDOS = Object.freeze(['all', '*']);

/**
 * Confere a lista antes de ela virar corpo de requisição.
 *
 * Redundante com a constante logo acima — de propósito. Esta função é o ponto
 * em que um refactor futuro que passe a montar a lista dinamicamente vai
 * esbarrar, e é mais barato esbarrar aqui do que descobrir pela tela do usuário
 * que o agente ganhou um terminal.
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

const TIMEOUT_PADRAO_MS = 20000;

/**
 * Constrói o cliente.
 *
 * `fetchImpl` injetável porque é o que permite testar o adaptador inteiro
 * contra um servidor de mentira sem subir runtime nenhum — e o `npm test`
 * precisa continuar determinístico.
 */
export function createHermesClient({
  baseUrl,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_PADRAO_MS,
} = {}) {
  const raiz = String(baseUrl || '').replace(/\/+$/, '');
  if (!raiz) throw new HermesTransportError('URL do runtime não configurada.', {});
  if (typeof fetchImpl !== 'function') {
    throw new HermesTransportError('fetch indisponível neste ambiente.', {});
  }

  const url = (caminho) => `${raiz}${caminho}`;

  /** Uma requisição JSON. Erros de rede e de status viram HermesTransportError. */
  async function pedir(caminho, { method = 'GET', body = null, signal = null } = {}) {
    const controlador = new AbortController();
    const relogio = setTimeout(() => controlador.abort(), timeoutMs);
    const abortar = () => controlador.abort();
    if (signal) {
      if (signal.aborted) controlador.abort();
      else signal.addEventListener('abort', abortar, { once: true });
    }

    let resposta;
    try {
      resposta = await fetchImpl(url(caminho), {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controlador.signal,
      });
    } catch (erro) {
      throw new HermesTransportError('Não foi possível falar com o runtime.', {
        caminho, causa: erro?.message || String(erro),
      });
    } finally {
      clearTimeout(relogio);
      if (signal) signal.removeEventListener('abort', abortar);
    }

    const texto = await resposta.text();
    let carga = null;
    try { carga = texto ? JSON.parse(texto) : null; } catch { carga = null; }

    if (!resposta.ok) {
      throw new HermesTransportError('O runtime recusou a requisição.', {
        caminho, status: resposta.status, corpo: carga ?? texto?.slice(0, 500) ?? null,
      });
    }
    return carga;
  }

  return {
    baseUrl: raiz,

    /** GET /health */
    async health({ signal = null } = {}) {
      return pedir('/health', { signal });
    },

    /**
     * POST /api/session/new
     *
     * Sempre com os toolsets obrigatórios. Não há parâmetro para afrouxar isso,
     * e é por isso que não existe: um chamador que pudesse escolher acabaria,
     * algum dia, escolhendo errado.
     */
    async createSession({ signal = null } = {}) {
      const toolsets = assertToolsetsSeguros([...TOOLSETS_OBRIGATORIOS]);
      const carga = await pedir('/api/session/new', {
        method: 'POST',
        body: { enabled_toolsets: toolsets },
        signal,
      });

      const sessao = carga?.session ?? carga ?? {};
      const sessionId = sessao.session_id ?? carga?.session_id ?? null;
      if (!sessionId) {
        throw new HermesTransportError('O runtime não devolveu um identificador de sessão.', {});
      }

      // Confere o que o servidor REALMENTE guardou. Se o isolamento não foi
      // aplicado, a sessão não serve — e descobrir isso agora é muito mais
      // barato do que descobrir quando o modelo pedir um shell.
      const aplicado = sessao.enabled_toolsets ?? null;
      if (!Array.isArray(aplicado) || !aplicado.includes('showrunner')) {
        throw new HermesTransportError(
          'O runtime não aplicou o isolamento de ferramentas exigido.',
          { aplicado },
        );
      }
      assertToolsetsSeguros(aplicado);

      return { sessionId: String(sessionId), enabledToolsets: aplicado };
    },

    /** POST /api/chat/start — devolve o stream_id a consumir. */
    async startChat({ sessionId, message, signal = null } = {}) {
      const carga = await pedir('/api/chat/start', {
        method: 'POST',
        body: { session_id: String(sessionId), message: String(message) },
        signal,
      });
      const streamId = carga?.stream_id ?? null;
      if (!streamId) {
        throw new HermesTransportError('O runtime não devolveu um identificador de fluxo.', {});
      }
      return { streamId: String(streamId) };
    },

    /** POST /api/chat/cancel — melhor esforço; nunca lança. */
    async cancelChat({ streamId } = {}) {
      try {
        await pedir('/api/chat/cancel', {
          method: 'POST',
          body: { stream_id: String(streamId) },
        });
        return true;
      } catch {
        // O cancelamento é melhor esforço: se o runtime já terminou, ou não
        // responde, insistir não melhora nada e propagar transformaria um
        // cancelamento bem-sucedido do nosso lado num erro visível.
        return false;
      }
    },

    /**
     * GET /api/chat/stream — eventos SSE, um a um.
     *
     * Gerador assíncrono: quem consome controla o ritmo e pode parar no meio
     * simplesmente saindo do laço, que é o que o cancelamento faz.
     */
    async* streamChat({ streamId, signal = null } = {}) {
      let resposta;
      try {
        resposta = await fetchImpl(url(`/api/chat/stream?stream_id=${encodeURIComponent(streamId)}`), {
          method: 'GET',
          headers: { Accept: 'text/event-stream' },
          signal,
        });
      } catch (erro) {
        if (signal?.aborted) return;
        throw new HermesTransportError('Não foi possível abrir o fluxo do runtime.', {
          causa: erro?.message || String(erro),
        });
      }

      if (!resposta.ok) {
        throw new HermesTransportError('O runtime recusou abrir o fluxo.', {
          status: resposta.status,
        });
      }
      if (!resposta.body) {
        throw new HermesTransportError('O fluxo do runtime veio vazio.', {});
      }

      const parser = createSseParser();
      const decodificador = new TextDecoder();

      try {
        for await (const pedaco of resposta.body) {
          if (signal?.aborted) return;
          const texto = typeof pedaco === 'string'
            ? pedaco
            : decodificador.decode(pedaco, { stream: true });
          for (const evento of parser.push(texto)) {
            yield { ...evento, payload: parseEventData(evento) };
            if (signal?.aborted) return;
          }
        }
        for (const evento of parser.flush()) {
          yield { ...evento, payload: parseEventData(evento) };
        }
      } catch (erro) {
        if (signal?.aborted) return;
        throw new HermesTransportError('O fluxo do runtime foi interrompido.', {
          causa: erro?.message || String(erro),
        });
      }
    },
  };
}
