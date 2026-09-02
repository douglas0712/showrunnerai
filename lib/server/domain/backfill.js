// Backfill: os vídeos que já existem em disco viram Asset.
//
// Este módulo é deliberadamente somente-leitura sobre a mídia. As duas únicas
// chamadas de sistema de arquivos que ele faz são `readdir` (dentro de
// `listRegisteredVideos`) e `stat`. Nada é movido, renomeado, reescrito,
// duplicado ou apagado — os MP4 em runtime/projects/ são resultado de produção
// do usuário e não são material desta camada.
//
// A allowlist de lib/server/export/assets.js é reaproveitada inteira: ela já
// decide, com validação de segmento e contenção de raiz, quais arquivos a
// aplicação reconhece como seus. Repetir esse critério aqui só criaria uma
// segunda verdade capaz de divergir.

import { stat } from 'node:fs/promises';
import { RUNTIME_ROOT } from '../comfy/config.js';
import { listRegisteredVideos } from '../export/assets.js';
import { APPROVAL } from '../../approval.js';
import { database } from './db.js';
import { ensureProject } from './projects.js';
import { createAsset, findAssetByFile } from './assets.js';

/** Os vídeos publicados pela aplicação são sempre MP4 (validateVideoFilename). */
const MIME_VIDEO = 'video/mp4';

/**
 * Registra como Asset todo vídeo da allowlist que ainda não tem registro.
 *
 * Idempotente por construção: a chave é (projectId, filename), que também é um
 * índice único no esquema. Rodar de novo não cria duplicata e não reescreve o
 * registro existente — apenas relata o que já estava lá.
 *
 * @returns {{registrados: Array, jaRegistrados: Array, projetosCriados: Array,
 *            ignorados: Array, total: number}}
 */
export async function backfillVideoAssets({
  root = RUNTIME_ROOT,
  db = database(),
  status = APPROVAL.PENDING,
} = {}) {
  const encontrados = await listRegisteredVideos(root);

  const registrados = [];
  const jaRegistrados = [];
  const projetosCriados = [];
  const ignorados = [];

  for (const video of encontrados) {
    const { projectId, filename, jobId, absolutePath, url } = video;

    const existente = findAssetByFile(projectId, filename, db);
    if (existente) {
      jaRegistrados.push(existente);
      continue;
    }

    // O projeto pode não estar cadastrado: as pastas em runtime/projects/
    // nasceram antes deste banco existir. O registro alcança o disco, nunca o
    // contrário — e um projeto já cadastrado nunca é sobrescrito.
    const { criado } = ensureProject(projectId, { name: projectId }, db);
    if (criado) projetosCriados.push(projectId);

    // `stat` é leitura pura. É a única informação de arquivo que colhemos:
    // largura, altura e duração exigiriam ffprobe, o que tornaria o backfill
    // lento e dependente de um binário externo. Ficam nulas para uma etapa
    // posterior enriquecer.
    let bytes = null;
    try {
      const info = await stat(absolutePath);
      bytes = info.size;
    } catch (erro) {
      // O arquivo saiu do disco entre a varredura e agora. Não é motivo para
      // abortar o lote inteiro.
      ignorados.push({ projectId, filename, motivo: erro.message });
      continue;
    }

    registrados.push(createAsset({
      projectId,
      kind: 'video',
      jobId,
      filename,
      url,
      mimeType: MIME_VIDEO,
      bytes,
      status,
    }, db));
  }

  return {
    registrados,
    jaRegistrados,
    projetosCriados,
    ignorados,
    total: encontrados.length,
  };
}
