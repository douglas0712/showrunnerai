// O lado do navegador da conversa com o Showrunner.
//
// Duas metades, separadas de propósito:
//
//   a REDUÇÃO   funções puras que transformam AgentEvents em estado de tela.
//               Sem fetch, sem React, sem relógio. É onde mora a decisão, e é
//               por isso que ela é testável com `node:test` como o servidor.
//
//   a REDE      `ensureThread` e `streamTurn`, que são finas de propósito: se
//               houvesse regra dentro delas, a regra só existiria no navegador.
//
// ── O que este arquivo não sabe ─────────────────────────────────────────────
//
// Não sabe que existe um runtime por trás do Showrunner, nem como ele se chama.
// O que chega aqui é o vocabulário de `events.js` e nada mais — o SSE que ele
// consome é o do Showrunner, servido por /api/agent/stream. Se algum dia o
// runtime mudar, este arquivo não fica sabendo.

/** Os tipos que a tela entende. Qualquer outro é ignorado, não exibido. */
export const EVENTOS = Object.freeze({
  STARTED: 'agent.started',
  STATUS: 'agent.status',
  DELTA: 'agent.message.delta',
  COMPLETED_MSG: 'agent.message.completed',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_FAILED: 'tool.failed',
  COMPLETED: 'agent.completed',
  FAILED: 'agent.failed',
});

/**
 * Como cada ferramenta se anuncia na conversa.
 *
 * O usuário está falando com uma equipe de produção, não operando um console.
 * "Executando og_generate_image" descreve a implementação; "Gerando imagem…"
 * descreve o que está acontecendo com o trabalho dele.
 */
const ROTULOS = Object.freeze({
  'og.generate_image': { running: 'Gerando imagem…', done: 'Imagem gerada' },
  'og.generate_video': { running: 'Gerando vídeo…', done: 'Vídeo gerado' },
  'og.get_job': { running: 'Verificando a produção…', done: 'Produção verificada' },
});

const ROTULO_PADRAO = Object.freeze({ running: 'Trabalhando…', done: 'Concluído' });

export function labelForTool(name, estado = 'running') {
  const par = ROTULOS[name] || ROTULO_PADRAO;
  return par[estado] || ROTULO_PADRAO[estado];
}

/**
 * Como uma produção em andamento se anuncia na tela.
 *
 * O turno do Showrunner acaba muito antes de a mídia existir — uma imagem leva
 * minutos, um vídeo já levou catorze. O trabalho continua no servidor, e isto é
 * o que a conversa mostra enquanto ele acontece.
 *
 * O vocabulário é o de produção, e é o mesmo de `ROTULOS` de propósito: para
 * quem está olhando, "Gerando imagem…" antes e depois do fim do turno é a mesma
 * frase porque é a mesma coisa acontecendo.
 */
const ROTULOS_PRODUCAO = Object.freeze({
  image: { gerando: 'Gerando imagem…', finalizando: 'Finalizando a imagem…' },
  video: { gerando: 'Gerando vídeo…', finalizando: 'Finalizando o vídeo…' },
});

/** Estados de produção em que ainda há trabalho acontecendo. */
export const PRODUCAO_EM_CURSO = Object.freeze(['gerando', 'finalizando']);

export function producaoEmCurso(producao = []) {
  return producao.some((item) => PRODUCAO_EM_CURSO.includes(item?.state));
}

/**
 * A frase de uma produção, ou `null` quando não há o que dizer.
 *
 * Uma produção concluída devolve `null`: o resultado dela já está na conversa
 * como imagem ou vídeo, e anunciar "pronto" ao lado da coisa pronta é dizer
 * duas vezes. A falha devolve frase, porque aí não há resultado nenhum para
 * falar por si.
 */
export function labelForProduction(item) {
  if (!item || typeof item !== 'object') return null;
  const porTipo = ROTULOS_PRODUCAO[item.kind === 'video' ? 'video' : 'image'];

  if (item.state === 'falhou') return 'Não consegui concluir esta geração.';
  if (item.state === 'concluido') return null;
  return porTipo[item.state] || porTipo.gerando;
}

/**
 * Falha → frase que o usuário lê.
 *
 * A mensagem técnica fica no servidor. Aqui sai linguagem normal, e sempre uma
 * que diga o que a pessoa pode fazer a seguir.
 */
export function friendlyError(erro) {
  const code = erro?.code || null;

  if (code === 'runtime_unavailable') {
    return 'O assistente de criação está temporariamente indisponível. Tente novamente em instantes.';
  }
  if (code === 'thread_not_found') {
    return 'Esta conversa não está mais disponível. Recarregue a página para começar outra.';
  }
  if (code === 'invalid_request') {
    return 'Não consegui entender esse pedido. Pode reformular?';
  }
  if (code === 'network') {
    return 'A conexão com o Showrunner caiu no meio da resposta. Tente novamente.';
  }
  return 'Algo deu errado ao preparar a resposta. Tente novamente.';
}

/** O estado inicial da resposta que está sendo construída. */
export function novaResposta(id, clock = Date.now) {
  return {
    id,
    role: 'agent',
    text: '',
    createdAt: clock(),
    status: 'streaming',
    statusLabel: null,
    activity: [],
    media: [],
    error: null,
  };
}

/**
 * Aplica um evento à resposta em construção. Puro: devolve estado novo.
 *
 * Evento desconhecido devolve o MESMO objeto, sem cópia — é o que permite a
 * quem chama testar identidade para saber se algo mudou, e é o que garante que
 * um vocabulário novo não apareça na tela por acidente.
 */
export function aplicarEvento(resposta, evento) {
  if (!evento || typeof evento !== 'object') return resposta;

  switch (evento.type) {
    case EVENTOS.STARTED:
      return { ...resposta, status: 'streaming' };

    case EVENTOS.STATUS:
      return { ...resposta, statusLabel: textoOuNulo(evento.status) };

    case EVENTOS.DELTA: {
      const pedaco = typeof evento.text === 'string' ? evento.text : '';
      if (!pedaco) return resposta;
      return { ...resposta, text: resposta.text + pedaco };
    }

    case EVENTOS.COMPLETED_MSG: {
      // O texto final SUBSTITUI o acumulado. Os deltas são uma prévia; o
      // completo é o que o agente de fato disse, e concatenar os dois
      // duplicaria a resposta inteira.
      const texto = typeof evento.text === 'string' ? evento.text : resposta.text;
      return { ...resposta, text: texto };
    }

    case EVENTOS.TOOL_STARTED: {
      const id = String(evento.toolCallId);
      if (resposta.activity.some((a) => a.id === id)) return resposta;
      return {
        ...resposta,
        activity: [...resposta.activity, {
          id,
          name: evento.name,
          label: labelForTool(evento.name, 'running'),
          state: 'running',
        }],
      };
    }

    case EVENTOS.TOOL_COMPLETED: {
      const id = String(evento.toolCallId);
      const activity = marcar(resposta.activity, id, {
        state: 'done',
        label: labelForTool(evento.name, 'done'),
      });
      return { ...resposta, activity, media: comMidia(resposta.media, evento.result) };
    }

    case EVENTOS.TOOL_FAILED: {
      const id = String(evento.toolCallId);
      return {
        ...resposta,
        activity: marcar(resposta.activity, id, {
          state: 'failed',
          label: 'Não consegui concluir esta etapa',
        }),
      };
    }

    case EVENTOS.COMPLETED:
      return {
        ...resposta,
        status: 'completed',
        statusLabel: null,
        text: semUrlsJaExibidas(resposta.text, resposta.media),
      };

    case EVENTOS.FAILED:
      return {
        ...resposta,
        status: 'failed',
        statusLabel: null,
        error: { message: friendlyError(evento.error), code: evento.error?.code || null },
      };

    default:
      return resposta;
  }
}

/**
 * Acrescenta a mídia de um resultado, sem repetir.
 *
 * A identidade é o `asset.id`. A mesma imagem pode ser mencionada por mais de
 * uma ferramenta no mesmo turno — `og.generate_image` a cria, `og.get_job` a
 * confirma — e exibi-la duas vezes faria parecer que houve duas gerações.
 */
export function comMidia(midiaAtual, resultado) {
  const asset = resultado?.asset;
  if (!asset || typeof asset.id !== 'string' || !asset.mediaUrl) return midiaAtual;
  if (midiaAtual.some((m) => m.assetId === asset.id)) return midiaAtual;

  return [...midiaAtual, {
    assetId: asset.id,
    kind: asset.kind === 'video' ? 'video' : 'image',
    mediaUrl: asset.mediaUrl,
    mimeType: asset.mimeType || null,
    derivedFromAssetId: asset.derivedFromAssetId || null,
  }];
}

/**
 * Tira do texto as URLs de mídia que já estão sendo exibidas.
 *
 * O agente às vezes escreve o endereço do arquivo na própria resposta — algo
 * como "Pronta: MEDIA:/api/media/image/...". Como a mídia já aparece como
 * imagem logo abaixo, deixar a URL no texto mostra a mesma coisa duas vezes, e
 * uma delas em forma de endereço, que é justamente o que a conversa não deveria
 * expor.
 *
 * Remove só o que está sendo exibido: uma URL de mídia que a tela NÃO
 * renderizou continua no texto, porque aí ela é a única pista que o usuário tem.
 */
export function semUrlsJaExibidas(texto, midia) {
  if (!texto || !midia?.length) return texto;

  let saida = texto;
  for (const item of midia) {
    if (!item.mediaUrl) continue;
    const alvo = escaparRegex(item.mediaUrl);
    // Come um rótulo em CAIXA ALTA colado à URL, sem espaço — o padrão que o
    // agente de fato produz ("MEDIA:/api/media/..."). Prosa comum fica: em
    // "Veja: /api/media/..." o "Veja:" é frase, não etiqueta, e apagá-lo
    // deixaria a resposta sem sentido.
    saida = saida.replace(new RegExp(`(?:[A-Z]{3,8}:)?${alvo}`, 'g'), '');
  }

  // Sobram linhas vazias onde a URL estava; três quebras viram uma pausa só.
  return saida.replace(/\n{3,}/g, '\n\n').trim();
}

/** Escapa o que é significativo numa expressão regular. */
function escaparRegex(texto) {
  return String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


function marcar(activity, id, patch) {
  return activity.map((a) => (a.id === id ? { ...a, ...patch } : a));
}

const textoOuNulo = (v) => (typeof v === 'string' && v.trim() ? v : null);

// ── rede ────────────────────────────────────────────────────────────────────

/**
 * Onde o ponteiro da conversa mora, POR PROJETO.
 *
 * Uma chave por projeto, e não uma só: cada produção tem a própria conversa, e
 * voltar a um projeto volta à conversa dele. Uma chave única faria a troca de
 * projeto herdar a conversa anterior — que é de outro trabalho.
 *
 * Esta função existe para que a chave tenha UMA definição. Ela era montada na
 * tela, e "Nova conversa" precisaria montá-la de novo: duas cópias da mesma
 * regra divergem na primeira mudança, e a divergência aqui apareceria como uma
 * conversa que some ao recarregar.
 */
export function agentThreadKey(projectId) {
  return `showrunner.agent.threadId.${projectId || 'sem-projeto'}`;
}

/**
 * O armazenamento do navegador, quando há um.
 *
 * Fora do navegador não há nenhum, e numa janela privada o próprio acesso pode
 * lançar. Nos dois casos a resposta é a mesma: seguir sem ponteiro. Perder a
 * memória de qual conversa era não quebra nada — o servidor continua com ela, e
 * a tela abre outra.
 */
function armazenamentoPadrao() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** O id da conversa lembrada deste projeto, ou `null`. */
export function threadLembrada(projectId, storage = armazenamentoPadrao()) {
  try {
    return storage?.getItem(agentThreadKey(projectId)) || null;
  } catch {
    return null;
  }
}

/**
 * Aponta o projeto para esta conversa.
 *
 * Move SÓ o ponteiro deste projeto. A conversa anterior continua inteira no
 * servidor — o ponteiro é a memória de qual era a atual, não a conversa.
 */
export function lembrarThread(projectId, threadId, storage = armazenamentoPadrao()) {
  try {
    if (storage && threadId) storage.setItem(agentThreadKey(projectId), threadId);
  } catch {
    // Sem memória entre recarregamentos; a conversa desta sessão segue igual.
  }
}

/**
 * Abre uma conversa nova no servidor.
 *
 * O id vem SEMPRE de lá. Um id inventado no navegador não existe no banco, e a
 * primeira mensagem descobriria isso da pior forma.
 */
async function criarThread({ project = null, fetchImpl = fetch }) {
  const resposta = await fetchImpl('/api/agent/threads', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(project ? { project } : {}),
  });

  if (!resposta.ok) {
    const corpo = await resposta.json().catch(() => ({}));
    const erro = new Error(corpo.error || 'Não foi possível abrir a conversa.');
    erro.code = 'thread_create_failed';
    throw erro;
  }

  const corpo = await resposta.json();
  return { thread: corpo.thread, messages: corpo.messages || [], production: corpo.production || [] };
}

/**
 * Relê a conversa: mensagens, mídia e o que ainda está em produção.
 *
 * É o que a tela chama enquanto uma geração acontece, DEPOIS de o turno já ter
 * terminado. Perguntar não faz o trabalho andar — quem leva a geração até o fim
 * é o servidor, e ele levaria igual se ninguém perguntasse nunca. Isto só
 * atualiza a tela.
 *
 * Devolve `null` quando a conversa não responde. Uma leitura de atualização que
 * falhou não é motivo para estragar o que já está na frente do usuário: a
 * próxima tentativa resolve.
 */
export async function fetchThread({ threadId, fetchImpl = fetch } = {}) {
  if (!threadId) return null;

  try {
    const resposta = await fetchImpl(`/api/agent/threads/${encodeURIComponent(threadId)}`);
    if (!resposta.ok) return null;
    const corpo = await resposta.json();
    return {
      thread: corpo.thread,
      messages: corpo.messages || [],
      production: corpo.production || [],
    };
  } catch {
    return null;
  }
}

/**
 * Uma conversa NOVA, no mesmo projeto — o "Nova conversa" da tela.
 *
 * Começar outra conversa não apaga a anterior. Nenhuma mensagem é removida,
 * nenhum Asset é excluído, nenhuma thread é deletada: o que muda é qual delas o
 * projeto aponta como atual. O histórico antigo continua no servidor, e é essa
 * a diferença entre "nova conversa" e "recomeçar do zero".
 *
 * Nem se reaproveita a conversa atual quando ela está vazia. Uma thread vazia
 * REUSADA e uma thread NOVA são indistinguíveis na tela e diferentes no banco;
 * fazer a segunda virar a primeira "porque dá no mesmo" transformaria o botão
 * em duas operações, e só uma delas seria testável.
 *
 * O ponteiro só se move DEPOIS de o servidor confirmar. Se a criação falhar, a
 * exceção sobe antes de qualquer escrita, e quem chamou continua exatamente na
 * conversa em que estava.
 */
export async function startNewThread({
  project = null,
  projectId = undefined,
  fetchImpl = fetch,
  storage = undefined,
} = {}) {
  const { thread, messages, production } = await criarThread({ project, fetchImpl });

  const alvo = projectId === undefined ? (project?.id ?? null) : projectId;
  lembrarThread(alvo, thread.id, storage === undefined ? armazenamentoPadrao() : storage);

  return { thread, messages, production, criada: true };
}

/**
 * A conversa desta tela, criando-a se preciso.
 *
 * O id vem SEMPRE do servidor. Um id inventado no navegador não existe no
 * banco, e a primeira mensagem descobriria isso da pior forma.
 *
 * Sobre o projeto: a tela manda o DESCRITOR do projeto em que o usuário está —
 * id, nome, proporção. O servidor registra esse projeto se ainda não o conhece,
 * com o mesmo id, porque é um projeto que o usuário já tem e no qual está
 * prestes a produzir.
 *
 * Sem projeto ativo, a conversa nasce sem projeto. Nenhum projeto é inventado
 * para o pedido passar: a conversa textual funciona, e a geração vai dizer que
 * precisa de um projeto — que é a verdade, e é acionável.
 */
export async function ensureThread({ threadId = null, project = null, fetchImpl = fetch } = {}) {
  const projetoAtual = project?.id ?? null;

  if (threadId) {
    const resposta = await fetchImpl(`/api/agent/threads/${encodeURIComponent(threadId)}`);
    if (resposta.ok) {
      const corpo = await resposta.json();
      const daThread = corpo.thread?.projectId ?? null;

      // A conversa guardada pertence a OUTRO projeto. Reaproveitá-la misturaria
      // duas produções — e a geração seguinte iria parar no projeto errado.
      // Trocar de projeto é trocar de conversa.
      if (daThread === projetoAtual) {
        return {
          thread: corpo.thread,
          messages: corpo.messages || [],
          production: corpo.production || [],
          criada: false,
        };
      }
    }
    // A conversa sumiu, ou é de outro projeto. Segue e cria outra.
  }

  return { ...await criarThread({ project, fetchImpl }), criada: true };
}

/**
 * Um turno, evento a evento.
 *
 * Consome o SSE do Showrunner e chama `onEvent` para cada AgentEvent. O parsing
 * é o mínimo que o formato exige: linhas `event:` e `data:`, blocos separados
 * por linha em branco.
 */
export async function streamTurn({ threadId, content, onEvent, signal = null, fetchImpl = fetch }) {
  const resposta = await fetchImpl('/api/agent/stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, content }),
    signal,
  });

  if (!resposta.ok || !resposta.body) {
    const corpo = await resposta.json?.().catch(() => ({})) ?? {};
    onEvent({
      type: EVENTOS.FAILED,
      ts: Date.now(),
      error: { message: corpo.error || 'Falha ao falar com o Showrunner.', code: 'network' },
    });
    return;
  }

  const leitor = resposta.body.getReader();
  const decodificador = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    buffer += decodificador.decode(value, { stream: true });

    let corte = buffer.indexOf('\n\n');
    while (corte !== -1) {
      const bloco = buffer.slice(0, corte);
      buffer = buffer.slice(corte + 2);
      const evento = blocoParaEvento(bloco);
      if (evento) onEvent(evento);
      corte = buffer.indexOf('\n\n');
    }
  }
}

/** Um bloco SSE vira o AgentEvent que ele carrega, ou `null`. */
export function blocoParaEvento(bloco) {
  const linhas = String(bloco || '').split('\n');
  const dados = [];
  for (const linha of linhas) {
    if (linha.startsWith('data:')) dados.push(linha.slice(5).replace(/^ /, ''));
  }
  if (!dados.length) return null;
  try {
    return JSON.parse(dados.join('\n'));
  } catch {
    return null;
  }
}
