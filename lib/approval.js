// Regra de aprovação da fase 2.
//
// Um resultado real só entra na timeline depois de o usuário aprová-lo
// explicitamente. A regra vive aqui, isolada da interface, para ser testável e
// para que todas as telas façam a mesma checagem.

export const APPROVAL = {
  PENDING: 'pendente',
  APPROVED: 'aprovado',
  REVISION: 'revisão',
};

/** Só entra na timeline o que estiver aprovado e tiver mídia utilizável. */
export function canAddToTimeline(item) {
  if (!item) return false;
  if (item.status !== APPROVAL.APPROVED) return false;
  return Boolean(item.url || item.poster || item.mediaUrl);
}

export function timelineBlockReason(item) {
  if (!item) return 'Nenhum resultado selecionado.';
  if (item.status === APPROVAL.REVISION) {
    return 'Este resultado tem uma alteração pedida. Gere novamente e aprove antes de montar.';
  }
  if (item.status !== APPROVAL.APPROVED) {
    return 'Aprove o vídeo antes de adicioná-lo à timeline.';
  }
  if (!(item.url || item.poster || item.mediaUrl)) {
    return 'O resultado ainda não tem arquivo de vídeo.';
  }
  return '';
}

/**
 * Pedir alteração preserva o vídeo anterior: o item continua na biblioteca com
 * a nota anexada, e apenas deixa de estar aprovado.
 */
export function applyRevisionRequest(item, note = '') {
  if (!item) return item;
  return { ...item, status: APPROVAL.REVISION, revisionNote: String(note), preserved: true };
}

export function applyApproval(item) {
  if (!item) return item;
  return { ...item, status: APPROVAL.APPROVED, revisionNote: '' };
}
