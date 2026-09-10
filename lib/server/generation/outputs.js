// Descoberta da saída de uma execução do ComfyUI, por tipo de mídia.
//
// O /history do ComfyUI devolve as saídas agrupadas por nó e, dentro de cada
// nó, por chaves cujo nome não é confiável: o `SaveVideo` do MiniMax publica o
// MP4 sob a chave `images`, com `animated: true`. Por isso a decisão é sempre
// pela EXTENSÃO do arquivo produzido, conferida contra o tipo que o descriptor
// declara — nunca pelo nome da chave e nunca pelo nome do modelo.
//
// Funções puras, sem I/O: recebem o payload do /history e devolvem o que
// encontraram.

import {
  extensionOf, isExtensionOfKind, kindOfExtension, mediaKind,
} from './mediaKinds.js';

/** Chaves onde o ComfyUI costuma publicar saídas, em ordem de preferência. */
// As chaves sob as quais o ComfyUI publica saída no /history. `audio` entrou no
// PASSO 14-D1B: é a chave que `SaveAudio` usa, e sem ela a execução de um efeito
// sonoro terminava com sucesso e o arquivo nunca era encontrado.
const CHAVES_DE_SAIDA = ['videos', 'images', 'gifs', 'files', 'audio'];

/**
 * Localiza, nas saídas de uma execução, o arquivo do tipo pedido.
 *
 * @param {object} outputs  `entry.outputs` de /history/{prompt_id}
 * @param {{kind: string, saveNodeId?: string}} opts
 * @returns {{nodeId, filename, subfolder, type, kind, mime}|null}
 */
export function findMediaOutput(outputs, { kind, saveNodeId = null } = {}) {
  const tipo = mediaKind(kind); // kind inválido falha aqui, não silenciosamente
  if (!outputs || typeof outputs !== 'object') return null;

  // O nó de saída declarado pelo descriptor é olhado primeiro; os demais
  // continuam sendo varridos porque um workflow pode ter mais de um SaveX.
  const ordem = saveNodeId && outputs[saveNodeId]
    ? [[saveNodeId, outputs[saveNodeId]], ...Object.entries(outputs).filter(([id]) => id !== saveNodeId)]
    : Object.entries(outputs);

  for (const [nodeId, saida] of ordem) {
    if (!saida || typeof saida !== 'object') continue;
    for (const chave of CHAVES_DE_SAIDA) {
      const lista = saida[chave];
      if (!Array.isArray(lista)) continue;
      for (const item of lista) {
        if (!item?.filename) continue;
        // A extensão precisa pertencer ao tipo pedido. Um PNG numa execução
        // de vídeo, ou um MP4 numa de imagem, não é a saída procurada.
        if (!isExtensionOfKind(kind, item.filename)) continue;
        return {
          nodeId,
          filename: item.filename,
          subfolder: item.subfolder || '',
          type: item.type || 'output',
          kind: tipo.kind,
          mime: tipo.mimeByExtension[extensionOf(item.filename)],
        };
      }
    }
  }
  return null;
}

/**
 * Extrai o jobId do nome que o ComfyUI produziu.
 *
 * O ComfyUI acrescenta um contador ao `filename_prefix`:
 *   video/showrunner/cinema_mt2011bo_uhqqd3  →  cinema_mt2011bo_uhqqd3_00001_.mp4
 *
 * Com `kind`, só aceitamos extensões daquele tipo; sem ele, qualquer extensão
 * conhecida serve. Em ambos os casos o resultado precisa voltar a um
 * identificador de job válido — é ele que vira nome de arquivo no disco.
 */
export function jobIdFromOutputFilename(filename, { kind = null } = {}) {
  const texto = String(filename || '');
  const match = /^(.+?)_(\d+)_(\.[A-Za-z0-9]+)$/.exec(texto);
  if (!match) return null;

  const [, jobId, , extensao] = match;

  if (kind) {
    if (!isExtensionOfKind(kind, `x${extensao}`)) return null;
  } else if (!kindOfExtension(`x${extensao}`)) {
    return null;
  }

  return /^[A-Za-z0-9_-]{1,64}$/.test(jobId) ? jobId : null;
}

/**
 * Varre um mapa de /history e devolve as execuções cujo resultado esta
 * aplicação pode adotar: concluídas com sucesso, com arquivo do tipo esperado
 * sob o prefixo de saída do descriptor, e com nome que volta a um jobId.
 *
 * Função pura — recebe o payload e o leitor de histórico, não faz I/O.
 *
 * @param {object} history
 * @param {{interpret: Function, kind: string, saveNodeId?: string,
 *          prefix?: string, promptNodeId?: string}} opts
 */
export function recoverableOutputs(history, {
  interpret,
  kind,
  saveNodeId = null,
  prefix = '',
  promptNodeId = null,
} = {}) {
  const resultado = [];

  for (const [promptId, entrada] of Object.entries(history || {})) {
    const leitura = interpret(entrada);
    if (!leitura.finished || !leitura.success) continue;

    const output = findMediaOutput(leitura.outputs, { kind, saveNodeId });
    if (!output) continue;

    // Só adotamos o que esta aplicação produziu.
    if (prefix && !String(output.subfolder || '').startsWith(prefix)) continue;

    const jobId = jobIdFromOutputFilename(output.filename, { kind });
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

    resultado.push({
      promptId,
      jobId,
      output,
      graph,
      startedAt: executionTimestamp(entrada),
      reason: null,
    });
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
