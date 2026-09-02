'use client';

import { useMemo, useState } from 'react';
import { useStudio } from '../StudioContext';
import { Badge, Button, Empty, IconButton, Panel, SectionTitle, Segmented } from '../ui/primitives';
import { ImageFrame, VideoFrame } from '../ui/MediaFrame';
import { ResultActions, StatusPill } from '../ResultActions';
import { getModel } from '@/lib/models';
import { canEnterTimeline, clipFromGeneration } from '@/lib/timelineAssets';
import { formatRelative, truncate } from '@/lib/format';

const KIND_FILTERS = [
  { value: 'todos', label: 'Todos' },
  { value: 'image', label: 'Imagens' },
  { value: 'video', label: 'Vídeos' },
];

const STATUS_FILTERS = [
  { value: 'todos', label: 'Todos' },
  { value: 'pendente', label: 'Pendentes' },
  { value: 'aprovado', label: 'Aprovados' },
  { value: 'revisão', label: 'Em alteração' },
];

export default function LibraryScreen({ navigate }) {
  const { generations, removeGeneration, setTimeline, toast } = useStudio();
  const [kind, setKind] = useState('todos');
  const [status, setStatus] = useState('todos');

  const items = useMemo(
    () =>
      generations.filter(
        (item) =>
          (kind === 'todos' || item.kind === kind) &&
          (status === 'todos' || item.status === status),
      ),
    [generations, kind, status],
  );

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Biblioteca"
        subtitle={`${generations.length} itens armazenados localmente no navegador`}
      />

      <div className="flex flex-wrap items-center gap-3">
        <Segmented options={KIND_FILTERS} value={kind} onChange={setKind} />
        <Segmented options={STATUS_FILTERS} value={status} onChange={setStatus} />
      </div>

      {!items.length ? (
        <Empty
          icon="biblioteca"
          title="Nada por aqui"
          hint="Gere uma imagem ou um vídeo — ou ajuste os filtros acima."
          action={<Button variant="primary" icon="imagem" onClick={() => navigate('imagem')}>Ir para o estúdio</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <Panel key={item.id} className="flex flex-col overflow-hidden p-0">
              {item.kind === 'video' ? (
                <VideoFrame item={item} aspect="16:9" className="rounded-none border-0 border-b border-hairline" compact />
              ) : (
                <ImageFrame src={item.url} alt={item.prompt} aspect="16:9" className="rounded-none border-0 border-b border-hairline" />
              )}

              <div className="flex flex-1 flex-col gap-2 p-3">
                <div className="flex items-start justify-between gap-2">
                  <Badge tone={item.kind === 'video' ? 'accent' : 'neutral'}>
                    {item.kind === 'video' ? 'vídeo' : 'imagem'}
                  </Badge>
                  <StatusPill status={item.status} />
                </div>

                <p className="line-clamp-2 text-[11.5px] leading-snug text-mist">
                  {truncate(item.prompt || 'Sem prompt', 90)}
                </p>

                <p className="font-mono text-[10px] text-mist/60">
                  {getModel(item.modelId)?.name || item.modelId} · {formatRelative(item.createdAt)}
                </p>

                <div className="mt-auto flex items-center justify-between gap-2 pt-1">
                  <ResultActions
                    item={item}
                    actions={item.kind === 'video' ? ['approve', 'addToTimeline'] : ['approve', 'download']}
                    onAddToTimeline={(picked) => {
                      const permissao = canEnterTimeline(picked);
                      if (!permissao.ok) {
                        toast(permissao.reason, 'warn');
                        return;
                      }
                      const clip = clipFromGeneration(picked, { index: 0 });
                      setTimeline((current) => {
                        const jaEsta = (current.video || []).some(
                          (c) => c.resultId === picked.id || (c.jobId && c.jobId === picked.jobId),
                        );
                        if (jaEsta) return current;
                        return { ...current, video: [...current.video, clip] };
                      });
                      toast('Clipe adicionado à timeline.', 'ok');
                    }}
                  />
                  <IconButton
                    icon="trash"
                    label="Remover"
                    onClick={() => {
                      removeGeneration(item.id);
                      toast('Item removido da biblioteca.', 'info');
                    }}
                  />
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
