'use client';

import { useState } from 'react';
import { Button, Textarea } from './ui/primitives';
import { Modal, ConfirmFooter } from './ui/Modal';
import { useStudio } from './StudioContext';

/**
 * Barra de ações de um resultado.
 *
 * O mesmo componente serve imagem, vídeo, cena do storyboard e entregas dentro
 * da conversa do agente — o fluxo aprovar / pedir alteração é idêntico em toda
 * a plataforma, então vive num lugar só.
 */
export function ResultActions({
  item,
  actions = ['approve', 'revise', 'download'],
  onCompare,
  onAddToTimeline,
  onUseInVideo,
  onApprove,
  onRevise,
  size = 'sm',
  className = '',
}) {
  const { approveGeneration, requestRevision, toast } = useStudio();
  const [reviseOpen, setReviseOpen] = useState(false);
  const [note, setNote] = useState('');

  const has = (name) => actions.includes(name);

  const handleApprove = () => {
    if (onApprove) onApprove(item);
    else approveGeneration(item.id);
  };

  const submitRevision = () => {
    if (onRevise) onRevise(item, note);
    else requestRevision(item.id, note);
    setReviseOpen(false);
    setNote('');
  };

  const handleDownload = () => {
    const source = item.kind === 'video' ? item.poster : item.url;
    if (!source) {
      toast('Nada para baixar neste item.', 'warn');
      return;
    }
    const name = `${item.kind === 'video' ? 'quadro' : 'imagem'}-${item.seed || item.id}.svg`;
    downloadDataUrl(source, name);
    toast(
      item.kind === 'video'
        ? 'Quadro de referência salvo. O arquivo de vídeo virá com a geração real.'
        : 'Arquivo salvo.',
      'ok',
    );
  };

  return (
    <>
      <div className={`flex flex-wrap items-center gap-1.5 ${className}`}>
        {has('approve') ? (
          <Button size={size} variant={item.status === 'aprovado' ? 'ok' : 'secondary'} icon="check" onClick={handleApprove}>
            {item.status === 'aprovado' ? 'Aprovado' : 'Aprovar'}
          </Button>
        ) : null}

        {has('revise') ? (
          <Button size={size} variant="secondary" icon="revise" onClick={() => setReviseOpen(true)}>
            Pedir alteração
          </Button>
        ) : null}

        {has('compare') ? (
          <Button size={size} variant="secondary" icon="compare" onClick={() => onCompare?.(item)}>
            Comparar
          </Button>
        ) : null}

        {has('download') ? (
          <Button size={size} variant="secondary" icon="download" onClick={handleDownload}>
            Baixar
          </Button>
        ) : null}

        {has('useInVideo') ? (
          <Button size={size} variant="secondary" icon="video" onClick={() => onUseInVideo?.(item)}>
            Usar no vídeo
          </Button>
        ) : null}

        {has('addToTimeline') ? (
          <Button size={size} variant="secondary" icon="timeline" onClick={() => onAddToTimeline?.(item)}>
            Adicionar à timeline
          </Button>
        ) : null}
      </div>

      <Modal
        open={reviseOpen}
        title="Pedir alteração"
        subtitle="O pedido fica anexado ao item e orienta a próxima geração."
        onClose={() => setReviseOpen(false)}
        footer={
          <ConfirmFooter
            onCancel={() => setReviseOpen(false)}
            onConfirm={submitRevision}
            confirmLabel="Registrar pedido"
            disabled={!note.trim()}
          />
        }
      >
        <Textarea
          rows={5}
          autoFocus
          value={note}
          onChange={(event) => setNote(event.target.value)}
          placeholder="O que precisa mudar? Ex.: fechar mais o enquadramento, esfriar a temperatura de cor, remover o reflexo na janela…"
        />
        {item.revisionNote ? (
          <p className="mt-3 rounded-lg border border-hairline bg-panel-2 px-3 py-2 text-[12px] text-mist">
            <span className="font-semibold text-chalk">Pedido anterior: </span>
            {item.revisionNote}
          </p>
        ) : null}
      </Modal>
    </>
  );
}

/** Converte o data: URL local em blob e dispara o download. Nada sai da máquina. */
export function downloadDataUrl(dataUrl, filename) {
  try {
    const [meta, encoded] = dataUrl.split(',');
    const isBase64 = meta.includes(';base64');
    const mime = meta.slice(5).split(';')[0] || 'application/octet-stream';
    const content = isBase64 ? atob(encoded) : decodeURIComponent(encoded);
    const bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i += 1) bytes[i] = content.charCodeAt(i);

    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

export function StatusPill({ status }) {
  const tones = {
    aprovado: 'border-ok/30 bg-ok/12 text-ok',
    'revisão': 'border-danger/30 bg-danger/12 text-danger',
    pendente: 'border-warn/30 bg-warn/12 text-warn',
  };
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
        tones[status] || 'border-hairline bg-white/[0.06] text-mist'
      }`}
    >
      {status || 'rascunho'}
    </span>
  );
}
