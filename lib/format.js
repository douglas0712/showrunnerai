export function formatDuration(seconds = 0) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  if (!mm) return `${ss}s`;
  return `${mm}m ${String(ss).padStart(2, '0')}s`;
}

/**
 * Duração de montagem, preservando as frações.
 *
 * `formatDuration` arredonda para segundos inteiros, o que é bom para leitura
 * geral mas engana numa timeline: 11,76 s virava "12s". Aqui a fração é
 * mantida, porque num corte ela é a diferença entre casar e não casar.
 */
export function formatPreciseDuration(seconds = 0) {
  const total = Math.max(0, Number(seconds) || 0);
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  const texto = Number.isInteger(ss) ? String(ss) : ss.toFixed(2).replace('.', ',');
  if (!mm) return `${texto}s`;
  return `${mm}m ${texto}s`;
}

export function formatRelative(timestamp) {
  if (!timestamp) return '';
  const diff = Math.floor((Date.now() - timestamp) / 1000);
  if (diff < 60) return 'agora mesmo';
  if (diff < 3600) return `há ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `há ${Math.floor(diff / 3600)} h`;
  if (diff < 604800) return `há ${Math.floor(diff / 86400)} d`;
  return new Date(timestamp).toLocaleDateString('pt-BR');
}

export function truncate(text = '', max = 90) {
  const value = String(text);
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
