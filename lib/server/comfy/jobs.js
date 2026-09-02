// Registro de jobs em memória.
//
// Guardado em globalThis porque o Fast Refresh do Next recarrega módulos entre
// requisições em desenvolvimento — sem isso, um job submetido some no recarregamento.

import { STATES } from './status.js';

const CHAVE = Symbol.for('showrunner.comfy.jobs');

function store() {
  if (!globalThis[CHAVE]) {
    globalThis[CHAVE] = { jobs: new Map(), clientId: null };
  }
  return globalThis[CHAVE];
}

export function clientId() {
  const s = store();
  if (!s.clientId) s.clientId = `showrunner-${crypto.randomUUID()}`;
  return s.clientId;
}

export function createJob(job) {
  const registro = {
    state: STATES.PREPARING,
    progress: null,
    node: null,
    error: null,
    promptId: null,
    queuePosition: null,
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    cancelRequested: false,
    ...job,
  };
  store().jobs.set(registro.jobId, registro);
  pruneOld();
  return registro;
}

export function getJob(jobId) {
  return store().jobs.get(jobId) || null;
}

export function getJobByPromptId(promptId) {
  for (const job of store().jobs.values()) {
    if (job.promptId === promptId) return job;
  }
  return null;
}

export function updateJob(jobId, patch = {}) {
  const job = getJob(jobId);
  if (!job) return null;
  Object.assign(job, patch);
  return job;
}

export function allJobs() {
  return [...store().jobs.values()];
}

/** Mantém o registro pequeno: descarta jobs terminais com mais de 6 horas. */
function pruneOld(maxAgeMs = 6 * 3600 * 1000) {
  const agora = Date.now();
  for (const [id, job] of store().jobs) {
    const fim = job.finishedAt || job.createdAt;
    if (job.finishedAt && agora - fim > maxAgeMs) store().jobs.delete(id);
    else if (!job.finishedAt && agora - job.createdAt > 24 * 3600 * 1000) store().jobs.delete(id);
  }
}
