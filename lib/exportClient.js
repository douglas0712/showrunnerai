// Cliente das rotas de exportação. O navegador só envia identificadores.

async function pedir(url, options) {
  const resposta = await fetch(url, { cache: 'no-store', ...options });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) {
    const erro = new Error(dados.error || `Falha na requisição (${resposta.status}).`);
    erro.status = resposta.status;
    erro.pending = dados.pending || null;
    throw erro;
  }
  return dados;
}

/**
 * Inicia a exportação.
 * @param {{projectId: string, clips: Array, presetId: string}} params
 */
export function startExport({ projectId, clips, presetId }) {
  return pedir('/api/export/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      projectId,
      presetId,
      // Só identidade e estado de aprovação atravessam a fronteira.
      clips: clips.map((clip) => ({
        jobId: clip.jobId || undefined,
        mediaUrl: clip.mediaUrl || undefined,
        resultId: clip.resultId || undefined,
        title: clip.label || clip.title || undefined,
        status: clip.status || undefined,
        approved: clip.approved === true,
      })),
    }),
  });
}

export function pollExport(exportId) {
  return pedir(`/api/export/status?exportId=${encodeURIComponent(exportId)}`);
}

export function cancelExport(exportId) {
  return pedir('/api/export/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ exportId }),
  });
}

export function listExports(projectId) {
  const params = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  return pedir(`/api/export/list${params}`);
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
