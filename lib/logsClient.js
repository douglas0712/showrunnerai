// Cliente do navegador para o diagnóstico. Espelha o padrão de exportClient.js:
// nenhuma regra de negócio aqui, só o transporte.

async function pedir(url, options) {
  const resposta = await fetch(url, { cache: 'no-store', ...options });
  const dados = await resposta.json().catch(() => ({}));
  if (!resposta.ok) throw new Error(dados.error || `Falha em ${url}.`);
  return dados;
}

/**
 * Busca os eventos novos desde o cursor.
 * `level` é o rótulo do próprio evento (INFO, AVISO, ERRO) ou null para todos.
 */
export function fetchLogs({ since = 0, jobId = null, level = null, limit = null } = {}) {
  const params = new URLSearchParams();
  if (since) params.set('since', String(since));
  if (jobId) params.set('jobId', jobId);
  if (level) params.set('level', level);
  if (limit) params.set('limit', String(limit));
  return pedir(`/api/logs?${params.toString()}`);
}

/**
 * Verificação real de conexão com o ComfyUI.
 *
 * Reaproveita /api/comfy/test, que já executa as cinco checagens e devolve os
 * itens aprovados e reprovados — não existe motivo para uma segunda sonda.
 */
export async function checkConnection() {
  const resposta = await fetch('/api/comfy/test', { method: 'POST', cache: 'no-store' });
  const dados = await resposta.json().catch(() => ({}));
  return {
    ok: Boolean(dados.ok),
    message: dados.message || 'Sem resposta do servidor da aplicação.',
    baseUrl: dados.baseUrl || null,
    checks: dados.checks || [],
  };
}

/** Jobs conhecidos pelo servidor — usados para o botão de tentar novamente. */
export function fetchJobs() {
  return pedir('/api/comfy/jobs');
}

/** Copia o vídeo que já existe no ComfyUI, sem regerar. */
export function refinalizarJob(jobId) {
  return pedir('/api/comfy/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jobId }),
  });
}

/** Ressubmete uma geração com os mesmos parâmetros de um job que falhou. */
export function ressubmeterJob(job) {
  return pedir('/api/comfy/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: job.prompt,
      seed: job.seed,
      seedLocked: Boolean(job.seedLocked),
      durationSeconds: job.durationRequested,
      aspect: job.aspect,
      quality: job.quality,
      projectId: job.projectId || 'avulso',
    }),
  });
}

/** Linha única de texto para a área de transferência. */
export function formatarLinha(evento) {
  const partes = [
    new Date(evento.tsMs || evento.ts).toLocaleString('pt-BR'),
    evento.level.padEnd(5),
    evento.stage || '—',
    evento.jobId ? `job=${evento.jobId}` : null,
    evento.promptId ? `prompt_id=${evento.promptId}` : null,
    evento.workflow ? `workflow=${evento.workflow}` : null,
    evento.message,
  ];
  return partes.filter(Boolean).join(' · ');
}

export function formatarTexto(eventos) {
  return eventos.map(formatarLinha).join('\n');
}

/**
 * Copia texto usando a área de transferência do navegador, com queda para o
 * caminho antigo quando a página não está num contexto seguro.
 */
export async function copiarTexto(texto) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(texto);
      return true;
    }
  } catch { /* cai para o método antigo */ }

  try {
    const area = document.createElement('textarea');
    area.value = texto;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Dispara o download de um JSON montado no próprio navegador. */
export function baixarJson(nome, dados) {
  const blob = new Blob([JSON.stringify(dados, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = nome;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revogar na hora cancela o download em alguns navegadores.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
