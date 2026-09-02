// Interpretação do estado do ComfyUI — funções puras, sem I/O.
//
// A fonte de verdade do estado é o polling HTTP (/queue e /history). Os eventos
// de websocket só enriquecem o progresso; se o socket cair, a máquina de
// estados continua correta.

export const STATES = {
  PREPARING: 'preparando',
  SUBMITTED: 'enviado',
  QUEUED: 'na-fila',
  GENERATING: 'gerando',
  DECODING: 'decodificando',
  SAVING: 'salvando',
  DONE: 'concluido',
  FAILED: 'falhou',
  CANCELLED: 'cancelado',
};

export const STATE_LABELS = {
  [STATES.PREPARING]: 'Preparando',
  [STATES.SUBMITTED]: 'Enviado ao ComfyUI',
  [STATES.QUEUED]: 'Na fila',
  [STATES.GENERATING]: 'Gerando',
  [STATES.DECODING]: 'Decodificando',
  [STATES.SAVING]: 'Finalizando arquivo',
  [STATES.DONE]: 'Concluído',
  [STATES.FAILED]: 'Falhou',
  [STATES.CANCELLED]: 'Cancelado',
};

export const TERMINAL_STATES = [STATES.DONE, STATES.FAILED, STATES.CANCELLED];

export function isTerminal(state) {
  return TERMINAL_STATES.includes(state);
}

/**
 * Onde o prompt está na fila do ComfyUI.
 * As entradas da fila têm o formato [numero, prompt_id, grafo, extras...].
 */
export function findInQueue(queue, promptId) {
  const running = (queue?.queue_running || []).some((item) => item?.[1] === promptId);
  if (running) return { running: true, pending: false, position: 0 };

  const index = (queue?.queue_pending || []).findIndex((item) => item?.[1] === promptId);
  if (index >= 0) {
    return { running: false, pending: true, position: index + 1 };
  }
  return { running: false, pending: false, position: null };
}

/**
 * Mapeia o nó em execução para uma fase legível.
 * Os identificadores vêm do workflow do MiniMax H3.
 */
export function phaseForNode(nodeId, nodeIds) {
  if (!nodeId) return null;
  if (nodeId === nodeIds.save) return STATES.SAVING;
  if (nodeId === nodeIds.createVideo) return STATES.SAVING;
  if (nodeId === '105:10' || nodeId === '105:23') return STATES.DECODING;
  if (nodeId === '105:14') return STATES.GENERATING;
  return STATES.GENERATING;
}

/**
 * Lê a entrada de /history/{prompt_id}.
 * @returns {{finished: boolean, success: boolean, error: string|null, outputs: object|null}}
 */
export function interpretHistory(entry) {
  if (!entry) return { finished: false, success: false, error: null, outputs: null };

  const status = entry.status || {};
  const completed = Boolean(status.completed);
  const str = status.status_str || null;

  if (str === 'error') {
    return { finished: true, success: false, error: extractError(status), outputs: entry.outputs || null };
  }
  if (completed && str === 'success') {
    return { finished: true, success: true, error: null, outputs: entry.outputs || null };
  }
  // Presente no histórico mas sem sucesso declarado: tratamos como em andamento.
  return { finished: false, success: false, error: null, outputs: entry.outputs || null };
}

function extractError(status) {
  const mensagens = status.messages || [];
  for (const [tipo, dados] of mensagens) {
    if (tipo === 'execution_error') {
      const partes = [dados?.node_type, dados?.exception_type, dados?.exception_message]
        .filter(Boolean);
      if (partes.length) return partes.join(' — ');
    }
  }
  return 'A execução falhou no ComfyUI.';
}

/**
 * Localiza o MP4 produzido nas saídas do histórico.
 *
 * O SaveVideo publica o arquivo sob a chave `images` com `animated: true`, por
 * isso procuramos por extensão de vídeo em vez de confiar no nome da chave.
 */
export function findVideoOutput(outputs, saveNodeId = null) {
  if (!outputs || typeof outputs !== 'object') return null;

  const ordem = saveNodeId && outputs[saveNodeId]
    ? [[saveNodeId, outputs[saveNodeId]], ...Object.entries(outputs).filter(([id]) => id !== saveNodeId)]
    : Object.entries(outputs);

  for (const [nodeId, saida] of ordem) {
    if (!saida || typeof saida !== 'object') continue;
    for (const chave of ['videos', 'images', 'gifs', 'files']) {
      const lista = saida[chave];
      if (!Array.isArray(lista)) continue;
      for (const item of lista) {
        if (!item?.filename) continue;
        if (!isVideoFile(item.filename)) continue;
        return {
          nodeId,
          filename: item.filename,
          subfolder: item.subfolder || '',
          type: item.type || 'output',
        };
      }
    }
  }
  return null;
}

/**
 * Extrai o jobId do nome produzido pelo SaveVideo.
 *
 * O ComfyUI acrescenta um contador ao `filename_prefix`:
 *   video/showrunner/cinema_mt2011bo_uhqqd3  →  cinema_mt2011bo_uhqqd3_00001_.mp4
 * Só aceitamos nomes que voltem a um identificador válido de job.
 */
export function jobIdFromFilename(filename) {
  const match = /^(.+?)_(\d+)_\.(?:mp4|webm|mkv|mov|m4v)$/i.exec(String(filename || ''));
  if (!match) return null;
  const jobId = match[1];
  return /^[A-Za-z0-9_-]{1,64}$/.test(jobId) ? jobId : null;
}

export function isVideoFile(filename) {
  return /\.(mp4|webm|mkv|mov|m4v)$/i.test(String(filename));
}

/**
 * Varre um mapa de histórico e devolve os resultados que esta aplicação pode
 * adotar: execuções bem-sucedidas cujo arquivo está sob o prefixo de saída do
 * Showrunner e cujo nome volta a um jobId válido.
 *
 * Função pura — recebe o payload do /history e não faz I/O.
 *
 * @returns {Array<{promptId, jobId, output, graph, reason}>} `reason` preenchido
 *          quando o candidato foi descartado.
 */
export function recoverablesFromHistory(history, { saveNodeId = null, prefix = '', promptNodeId = null } = {}) {
  const resultado = [];

  for (const [promptId, entrada] of Object.entries(history || {})) {
    const leitura = interpretHistory(entrada);
    if (!leitura.finished || !leitura.success) continue;

    const output = findVideoOutput(leitura.outputs, saveNodeId);
    if (!output) continue;

    // Só adotamos o que esta aplicação produziu.
    if (prefix && !String(output.subfolder || '').startsWith(prefix)) continue;

    const jobId = jobIdFromFilename(output.filename);
    if (!jobId) {
      resultado.push({ promptId, jobId: null, output, graph: null, startedAt: null, reason: 'nome fora do padrão' });
      continue;
    }

    // O ComfyUI guarda o grafo submetido em prompt[2] — é dele que a
    // proveniência é reconstruída quando o servidor perdeu o registro.
    const graph = Array.isArray(entrada?.prompt)
      ? entrada.prompt.find(
          (parte) => parte && typeof parte === 'object' && !Array.isArray(parte)
            && (!promptNodeId || parte[promptNodeId]),
        ) || null
      : null;

    resultado.push({ promptId, jobId, output, graph, startedAt: executionTimestamp(entrada), reason: null });
  }

  return resultado;
}

/**
 * Instante real da execução, tirado das mensagens do histórico.
 *
 * Sem isto, um job recuperado recebia o horário da recuperação como data de
 * criação — e a ordenação por "mais recente" apontava para o job errado.
 */
export function executionTimestamp(entrada) {
  const mensagens = entrada?.status?.messages || [];
  for (const [tipo, dados] of mensagens) {
    if (tipo === 'execution_start' && Number.isFinite(Number(dados?.timestamp))) {
      return Number(dados.timestamp);
    }
  }
  for (const [, dados] of mensagens) {
    if (Number.isFinite(Number(dados?.timestamp))) return Number(dados.timestamp);
  }
  return null;
}

/** Progresso 0..1 a partir dos eventos de passo do sampler. */
export function normalizeProgress(value, max) {
  const v = Number(value);
  const m = Number(max);
  if (!Number.isFinite(v) || !Number.isFinite(m) || m <= 0) return null;
  return Math.min(1, Math.max(0, v / m));
}
