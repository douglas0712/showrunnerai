// Sanitização do que entra no log.
//
// Regra da casa: o log é uma superfície de leitura, então tratamos todo valor
// como potencialmente sensível. A redação é por lista de proibidos em cima de
// uma poda agressiva (profundidade, largura e tamanho), e os formatos que já
// conhecemos — cabeçalhos HTTP, grafo do workflow, saída do ffprobe — passam
// por resumos com lista de permitidos, que nunca copiam campo desconhecido.
//
// Módulo puro: nenhum I/O, nenhum estado. É o que o torna testável.

export const REDIGIDO = '[redigido]';

/** Nomes de campo que nunca são copiados, em qualquer profundidade. */
const CHAVE_SECRETA = /(authorization|auth|cookie|set-cookie|token|bearer|api[-_ ]?key|apikey|secret|password|passwd|senha|credential|credentials|private[-_ ]?key|session|x-api-key|access[-_ ]?key)/i;

/** Cabeçalhos que podem ser mostrados. Tudo fora desta lista é descartado. */
const CABECALHOS_PERMITIDOS = new Set([
  'content-type', 'content-length', 'accept', 'range', 'content-range',
  'cache-control', 'content-disposition', 'etag', 'last-modified',
]);

/**
 * Raízes do sistema de arquivos que nunca aparecem no log.
 *
 * Um caminho absoluto sob qualquer uma delas revela a estrutura da máquina —
 * onde ficam os modelos, o nome do usuário, como os discos estão montados. O
 * que diagnostica é o nome do arquivo, e é só ele que sobra.
 *
 * A lista é de prefixos reais de sistema, e não uma varredura de qualquer
 * barra: URLs internas como `/api/media/video/...` precisam sobreviver
 * intactas, porque são justamente o que o usuário clica para ver o resultado.
 */
const RAIZES_DE_SISTEMA = /(?<![\w.\/-])\/(?:home|media|mnt|Users|root|srv|opt|var|tmp|usr|etc)\/(?:[^\s"'`,;:)\]}]*\/)*([^\s"'`,;:)\]}]+)?/g;

/**
 * Substitui caminhos absolutos pelo nome do arquivo.
 *
 *   /media/douglas/SSD2/comfyui_data/workflows/x.json  →  …/x.json
 *   /home/alguem/projeto                               →  …/projeto
 */
export function redigirCaminhos(texto, raiz = process.cwd()) {
  if (typeof texto !== 'string' || !texto) return texto;

  let saida = texto;
  // A raiz do projeto vira um ponto: mantém o stack trace legível sem dizer
  // onde o projeto mora.
  if (raiz && saida.includes(raiz)) saida = saida.split(raiz).join('.');

  return saida.replace(RAIZES_DE_SISTEMA, (_completo, ultimo) => (ultimo ? `…/${ultimo}` : '…/'));
}

const LIMITES = {
  profundidade: 4,
  texto: 600,
  itens: 20,
  chaves: 30,
};

/**
 * Poda e redige um valor arbitrário para caber no log.
 *
 * Nunca lança: qualquer coisa que não dê para representar vira um marcador.
 */
export function sanitize(value, limites = {}) {
  const cfg = { ...LIMITES, ...limites };
  return podar(value, cfg, 0, new WeakSet());
}

function podar(valor, cfg, nivel, vistos) {
  if (valor === null || valor === undefined) return valor ?? null;

  const tipo = typeof valor;

  if (tipo === 'string') return truncarTexto(redigirCaminhos(valor), cfg.texto);
  if (tipo === 'number') return Number.isFinite(valor) ? valor : String(valor);
  if (tipo === 'boolean') return valor;
  if (tipo === 'bigint') return `${valor}n`;
  if (tipo === 'function' || tipo === 'symbol') return `[${tipo}]`;

  if (valor instanceof Error) {
    return { name: valor.name, message: truncarTexto(redigirCaminhos(valor.message), cfg.texto) };
  }
  if (valor instanceof Date) return valor.toISOString();

  // Bytes nunca entram no log — só o tamanho.
  if (ArrayBuffer.isView(valor) || valor instanceof ArrayBuffer) {
    return `[binário ${valor.byteLength} bytes]`;
  }

  if (nivel >= cfg.profundidade) return '[…]';

  if (vistos.has(valor)) return '[circular]';
  vistos.add(valor);

  if (Array.isArray(valor)) {
    const recorte = valor.slice(0, cfg.itens).map((item) => podar(item, cfg, nivel + 1, vistos));
    if (valor.length > cfg.itens) recorte.push(`[+${valor.length - cfg.itens} itens]`);
    return recorte;
  }

  const saida = {};
  let contador = 0;
  for (const [chave, item] of Object.entries(valor)) {
    if (contador >= cfg.chaves) {
      saida['[…]'] = `mais ${Object.keys(valor).length - contador} campos`;
      break;
    }
    saida[chave] = CHAVE_SECRETA.test(chave) ? REDIGIDO : podar(item, cfg, nivel + 1, vistos);
    contador += 1;
  }
  return saida;
}

export function truncarTexto(texto, max = LIMITES.texto) {
  const s = String(texto ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, max)}… [+${s.length - max} caracteres]`;
}

/**
 * Cabeçalhos por lista de permitidos.
 * Aceita Headers, Map ou objeto simples.
 */
export function sanitizeHeaders(headers) {
  if (!headers) return null;

  const entradas = typeof headers.entries === 'function'
    ? [...headers.entries()]
    : Object.entries(headers);

  const saida = {};
  for (const [nome, valor] of entradas) {
    const chave = String(nome).toLowerCase();
    if (!CABECALHOS_PERMITIDOS.has(chave)) continue;
    saida[chave] = truncarTexto(valor, 200);
  }
  return Object.keys(saida).length ? saida : null;
}

/**
 * Caminho de arquivo → só o nome.
 *
 * O workflow mora fora do projeto (`/media/.../comfyui_data/...`); publicar o
 * caminho inteiro exporia a estrutura de diretórios da máquina sem acrescentar
 * nada ao diagnóstico.
 */
export function nomeDeArquivo(caminho) {
  if (!caminho) return null;
  const s = String(caminho);
  const partes = s.split(/[\\/]/);
  return partes[partes.length - 1] || s;
}

/**
 * Encurta caminhos absolutos dentro de um texto livre (mensagens e stack
 * traces), preservando a parte que ajuda a localizar o código.
 */
export function encurtarCaminhos(texto, raiz = process.cwd()) {
  if (!texto) return texto;
  return redigirCaminhos(String(texto), raiz);
}

/** Stack trace pronto para exibição: caminhos encurtados e tamanho limitado. */
export function sanitizeStack(erro, maxLinhas = 12) {
  const stack = typeof erro === 'string' ? erro : erro?.stack;
  if (!stack) return null;
  return encurtarCaminhos(String(stack))
    .split('\n')
    .slice(0, maxLinhas)
    .join('\n');
}

/**
 * Resumo do grafo do workflow submetido.
 *
 * O grafo cru tem ~4,7 KB e carrega caminhos de modelos — 500 cópias disso não
 * cabem no buffer e não ajudam ninguém. O que importa no diagnóstico é quantos
 * nós foram enviados e quais classes estão em jogo.
 */
export function resumirGrafo(grafo) {
  if (!grafo || typeof grafo !== 'object') return null;

  const nos = Object.entries(grafo);
  const classes = {};
  for (const [, no] of nos) {
    const classe = no?.class_type;
    if (!classe) continue;
    classes[classe] = (classes[classe] || 0) + 1;
  }

  return {
    nos: nos.length,
    classes: Object.entries(classes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([classe, quantidade]) => (quantidade > 1 ? `${classe}×${quantidade}` : classe)),
  };
}

/**
 * Corpo de requisição HTTP pronto para o log.
 *
 * O POST /prompt carrega o grafo inteiro: trocamos pelo resumo. O resto passa
 * pela poda genérica.
 */
export function sanitizeRequestBody(body) {
  if (!body || typeof body !== 'object') return sanitize(body);

  if (body.prompt && typeof body.prompt === 'object') {
    const { prompt, client_id: clientId, ...resto } = body;
    return {
      ...sanitize(resto),
      // O client_id identifica esta instância no websocket do ComfyUI. Não é
      // credencial, mas também não acrescenta nada ao diagnóstico.
      client_id: clientId ? REDIGIDO : null,
      grafo: resumirGrafo(prompt),
    };
  }
  return sanitize(body);
}

/**
 * Corpo de resposta HTTP pronto para o log.
 *
 * O /history devolve o grafo submetido inteiro dentro de cada entrada, então
 * respostas volumosas viram um resumo em vez de uma cópia.
 */
export function sanitizeResponseBody(body) {
  if (!body || typeof body !== 'object') return sanitize(body);

  if (Array.isArray(body)) return sanitize(body);

  const chaves = Object.keys(body);

  // Mapa de histórico: { "<prompt_id>": { prompt, outputs, status } }
  const pareceHistorico = chaves.length > 0
    && chaves.every((k) => body[k] && typeof body[k] === 'object' && ('status' in body[k] || 'outputs' in body[k]));

  if (pareceHistorico) {
    return {
      entradas: chaves.length,
      prompt_ids: chaves.slice(0, 5),
      status: chaves.slice(0, 5).reduce((acc, k) => {
        acc[k] = body[k]?.status?.status_str || null;
        return acc;
      }, {}),
    };
  }

  return sanitize(body);
}

/** Resumo da fila do ComfyUI: contagens, nunca os grafos. */
export function resumirFila(fila) {
  if (!fila || typeof fila !== 'object') return null;
  return {
    executando: Array.isArray(fila.queue_running) ? fila.queue_running.length : 0,
    pendentes: Array.isArray(fila.queue_pending) ? fila.queue_pending.length : 0,
  };
}

/**
 * Checagens do teste de conexão.
 *
 * `detalhe` é texto livre — versão do servidor, arquivos de modelo ausentes,
 * caminho do workflow. Passa pela redação de caminhos antes de virar log,
 * tanto para o buffer quanto para o arquivo e o JSON baixado.
 */
export function sanitizeChecks(checks) {
  if (!Array.isArray(checks)) return null;
  return checks.map((check) => ({
    nome: truncarTexto(check?.nome, 120),
    ok: Boolean(check?.ok),
    detalhe: check?.detalhe ? truncarTexto(redigirCaminhos(String(check.detalhe)), 300) : null,
  }));
}

/** Recorte da saída do ffprobe que interessa ao diagnóstico. */
export function resumirProbe(probe) {
  if (!probe || typeof probe !== 'object') return null;
  return {
    duracaoSegundos: probe.duration ?? null,
    bytes: probe.bytes ?? null,
    temVideo: Boolean(probe.hasVideo),
    temAudio: Boolean(probe.hasAudio),
    largura: probe.width ?? null,
    altura: probe.height ?? null,
    fps: probe.fps ?? null,
    codec: probe.videoCodec ?? probe.codec ?? null,
  };
}
