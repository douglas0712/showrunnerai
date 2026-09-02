'use client';

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../StudioContext';
import { Badge, Button, Empty, IconButton, Input, Panel, SectionTitle } from '../ui/primitives';
import ExportModal from './ExportModal';
import { RealVideoPlayer } from '../ui/RealVideoPlayer';
import { useVideoThumbnail } from '../ui/useVideoThumbnail';
import { useFilmstrip } from '../ui/useFilmstrip';
import { clipRangeLabel, pickVisibleFrames, responsiveFrameCount } from '@/lib/filmstrip';
import { Icon } from '../ui/icons';
import {
  createAudioClip, formatTimecode, layoutTrack, moveClip,
  timelineDuration, trackDuration, updateClip,
} from '@/lib/timeline';
import {
  clipIdentity, isRealClip, removeClipFromTimeline, timelineStats,
} from '@/lib/timelineAssets';
import { formatDuration, formatPreciseDuration, truncate } from '@/lib/format';

export default function TimelinePanel({ navigate }) {
  const { timeline, setTimeline, generations, toast, adoptRealAssets } = useStudio();
  const [exportOpen, setExportOpen] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [selecionadoId, setSelecionadoId] = useState(null);

  const stats = useMemo(() => timelineStats(timeline, generations), [timeline, generations]);
  const total = timelineDuration(timeline);
  const videoLayout = useMemo(() => {
    const porResultId = new Map(generations.map((g) => [g.id, g]));
    return layoutTrack(timeline.video, total).map((clip) => {
      const item = clip.resultId ? porResultId.get(clip.resultId) : null;
      const status = item?.status || null;
      return {
        ...clip,
        status,
        statusLabel: status === 'aprovado' ? 'APROVADA'
          : status === 'revisão' ? 'EM ALTERAÇÃO'
            : status ? 'PENDENTE' : null,
      };
    });
  }, [timeline.video, total, generations]);
  const audioLayout = useMemo(() => layoutTrack(timeline.audio, total), [timeline.audio, total]);

  const porId = useMemo(() => new Map(generations.map((g) => [g.id, g])), [generations]);
  const clipeSelecionado = (timeline.video || []).find((c) => c.id === selecionadoId) || null;

  // Seleciona o primeiro clipe real assim que existir um.
  useEffect(() => {
    if (selecionadoId) return;
    const primeiroReal = (timeline.video || []).find(isRealClip);
    if (primeiroReal) setSelecionadoId(primeiroReal.id);
  }, [timeline.video, selecionadoId]);

  const mutate = (track, fn) => setTimeline((current) => ({ ...current, [track]: fn(current[track]) }));

  const onDrop = (track, targetId) => {
    if (!dragging || dragging.track !== track || dragging.id === targetId) return;
    setTimeline((current) => {
      const clips = current[track];
      const from = clips.findIndex((c) => c.id === dragging.id);
      const to = clips.findIndex((c) => c.id === targetId);
      if (from === -1 || to === -1) return current;
      const next = [...clips];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return { ...current, [track]: next };
    });
    setDragging(null);
  };

  /** Tira da montagem — o MP4 e o item da biblioteca continuam intactos. */
  const removerDaTimeline = (clip) => {
    setTimeline((current) => removeClipFromTimeline(current, clip.id));
    if (selecionadoId === clip.id) setSelecionadoId(null);
    toast('Clipe removido da timeline. O arquivo de vídeo foi preservado.', 'info');
  };

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Timeline"
        subtitle="Cada clipe aponta para o arquivo real. Remover daqui não apaga nada."
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="gold">{formatPreciseDuration(total)} total</Badge>
            <Button
              variant="secondary"
              icon="revise"
              onClick={async () => {
                const { adotados, relatorio } = await adoptRealAssets({ force: true });
                const removidos = relatorio?.removidosSimulados?.length || 0;
                toast(
                  `Sincronizado: ${adotados} novo(s) resultado(s), ${removidos} clipe(s) de demonstração removido(s).`,
                  'ok',
                );
              }}
            >
              Sincronizar
            </Button>
            <Button variant="primary" icon="export" onClick={() => setExportOpen(true)}>
              Exportar vídeo final
            </Button>
          </div>
        }
      />

      {/* Régua ---------------------------------------------------------------- */}
      <Panel className="space-y-4 overflow-hidden p-4">
        <Ruler total={total} />

        <Track
          name="Vídeo"
          icon="video"
          clips={videoLayout}
          tone="gold"
          empty="Nenhum clipe de vídeo. Gere um plano na aba Cinema, aprove e adicione aqui."
          selectedId={selecionadoId}
          onSelect={setSelecionadoId}
          onRemove={removerDaTimeline}
          onDragStart={(id) => setDragging({ track: 'video', id })}
          onDrop={(id) => onDrop('video', id)}
        />

        {timeline.audio?.length ? (
          <Track
            name="Áudio"
            icon="agente"
            clips={audioLayout}
            tone="accent"
            empty="Nenhuma trilha de áudio."
            selectedId={null}
            onSelect={() => {}}
            onDragStart={(id) => setDragging({ track: 'audio', id })}
            onDrop={(id) => onDrop('audio', id)}
          />
        ) : null}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-hairline pt-3">
          <p className="font-mono text-[11px] text-mist">
            vídeo {formatTimecode(trackDuration(timeline.video))} · áudio {formatTimecode(trackDuration(timeline.audio))}
          </p>
          <Button
            size="sm"
            variant="ghost"
            icon="plus"
            onClick={() => {
              mutate('audio', (clips) => [...clips, createAudioClip({ label: 'Nova trilha', duration: 8 })]);
              toast('Trilha de áudio adicionada.', 'ok');
            }}
          >
            Adicionar áudio
          </Button>
        </div>
      </Panel>

      {/* Pré-visualização ------------------------------------------------------ */}
      {clipeSelecionado ? (
        <PreviewPanel
          clip={clipeSelecionado}
          generation={clipeSelecionado.resultId ? porId.get(clipeSelecionado.resultId) : null}
        />
      ) : null}

      {/* Clipes ---------------------------------------------------------------- */}
      <div>
        <SectionTitle
          title="Clipes"
          subtitle={`${stats.clipes} na montagem · ${stats.reais} real(is) · ${stats.aprovados} aprovado(s)`}
        />

        {!timeline.video?.length ? (
          <Empty
            icon="timeline"
            title="A montagem está vazia"
            hint="Aprove um plano na aba Cinema e use “Adicionar à timeline”."
          />
        ) : (
          <div className="grid gap-3 lg:grid-cols-2">
            {timeline.video.map((clip, index) => (
              <ClipCard
                key={clip.id}
                clip={clip}
                index={index}
                total={timeline.video.length}
                generation={clip.resultId ? porId.get(clip.resultId) : null}
                selecionado={clip.id === selecionadoId}
                onSelect={() => setSelecionadoId(clip.id)}
                onRename={(label) => mutate('video', (clips) => updateClip(clips, clip.id, { label }))}
                onDuration={(duration) => mutate('video', (clips) => updateClip(clips, clip.id, { duration }))}
                onMove={(delta) => mutate('video', (clips) => moveClip(clips, clip.id, delta))}
                onRemove={() => removerDaTimeline(clip)}
              />
            ))}
          </div>
        )}
      </div>

      {timeline.audio?.length ? (
        <Panel className="p-4">
          <h3 className="mb-3 text-[13px] font-semibold text-chalk">Trilha de áudio</h3>
          <ul className="space-y-2">
            {timeline.audio.map((clip, index) => (
              <li key={clip.id} className="flex items-center gap-2 rounded-lg border border-hairline bg-panel-2 p-2">
                <span className="w-5 shrink-0 text-center font-mono text-[11px] text-mist">{index + 1}</span>
                <div className="min-w-0 flex-1">
                  <Input
                    value={clip.label}
                    onChange={(e) => mutate('audio', (c) => updateClip(c, clip.id, { label: e.target.value }))}
                    className="h-8 text-[12px]"
                    aria-label="Nome da trilha"
                  />
                </div>
                <div className="w-20 shrink-0">
                  <Input
                    type="number"
                    min="1"
                    value={clip.duration}
                    onChange={(e) => mutate('audio', (c) => updateClip(c, clip.id, { duration: Math.max(1, Number(e.target.value) || 1) }))}
                    className="h-8 text-[12px]"
                    aria-label="Duração"
                  />
                </div>
                <IconButton icon="up" label="Subir" onClick={() => mutate('audio', (c) => moveClip(c, clip.id, -1))} disabled={index === 0} />
                <IconButton icon="down" label="Descer" onClick={() => mutate('audio', (c) => moveClip(c, clip.id, 1))} disabled={index === timeline.audio.length - 1} />
                <IconButton icon="trash" label="Remover" onClick={() => removerDaTimeline(clip)} />
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} navigate={navigate} />
    </div>
  );
}

/** Miniatura extraída do próprio MP4. */
function ClipThumb({ clip, className = '', width = 480 }) {
  // Reaproveita a filmstrip já extraída: o quadro de 35% costuma ser o mais
  // representativo da cena. Sem ela, cai no quadro desenhado no navegador.
  const { frames, loading: carregandoTira } = useFilmstrip(isRealClip(clip) ? clip.jobId : null);
  const doStrip = frames[1] || frames[0] || null;

  const { thumbnail, loading, error } = useVideoThumbnail(clip.mediaUrl, {
    width,
    enabled: Boolean(clip.mediaUrl) && !doStrip && !carregandoTira,
  });

  const fonte = doStrip?.url || thumbnail || null;

  if (fonte) {
    // eslint-disable-next-line @next/next/no-img-element -- servido pela própria aplicação
    return <img src={fonte} alt={clip.label} className={`h-full w-full object-cover object-center ${className}`} />;
  }
  if (clip.poster) {
    // eslint-disable-next-line @next/next/no-img-element -- data: URL local
    return <img src={clip.poster} alt={clip.label} className={`h-full w-full object-cover object-center opacity-70 ${className}`} />;
  }
  return (
    <span className={`flex h-full w-full items-center justify-center bg-ink-2 text-mist/50 ${loading || carregandoTira ? 'shimmer' : ''}`}>
      <Icon name={error ? 'close' : 'video'} size={18} />
    </span>
  );
}

function Ruler({ total }) {
  const marks = Math.max(1, Math.ceil(total / 5));
  return (
    <div className="relative h-5 border-b border-hairline">
      {Array.from({ length: marks + 1 }).map((_, i) => {
        const seconds = i * 5;
        const percent = total ? Math.min(100, (seconds / total) * 100) : 0;
        return (
          <span key={i} className="absolute top-0 flex h-full flex-col justify-between" style={{ left: `${percent}%` }}>
            <span className="font-mono text-[9.5px] text-mist/60">{seconds}s</span>
            <span className="h-1.5 w-px bg-hairline" />
          </span>
        );
      })}
    </div>
  );
}

/**
 * Trilha da timeline.
 *
 * Cada clipe é uma filmstrip: quatro quadros lado a lado, cada um recortado
 * dentro da própria célula. Antes uma única imagem 16:9 era esticada por todo
 * o bloco, o que achatava as pessoas e transformava a régua num banner.
 */
function Track({
  name, icon, clips, tone, empty, selectedId, onSelect, onRemove, onDragStart, onDrop,
}) {
  const trilhaRef = useRef(null);
  const [larguraTrilha, setLarguraTrilha] = useState(0);

  // A quantidade de quadros visíveis depende da largura real em pixels, não da
  // porcentagem: um clipe curto ocupa pouco espaço e não comporta quatro células.
  useLayoutEffect(() => {
    const elemento = trilhaRef.current;
    if (!elemento) return undefined;
    const medir = () => setLarguraTrilha(elemento.clientWidth);
    medir();
    const observador = new ResizeObserver(medir);
    observador.observe(elemento);
    return () => observador.disconnect();
  }, []);

  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-mist">
        <Icon name={icon} size={13} /> {name}
      </p>
      <div
        ref={trilhaRef}
        className={`relative overflow-hidden rounded-lg border border-hairline bg-ink-2 ${
          name === 'Vídeo' ? 'h-[124px]' : 'h-[74px]'
        }`}
      >
        {!clips.length ? (
          <p className="flex h-full items-center justify-center px-4 text-center text-[11.5px] text-mist/60">{empty}</p>
        ) : (
          clips.map((clip) => (
            <TrackClip
              key={clip.id}
              clip={clip}
              tone={tone}
              selecionado={clip.id === selectedId}
              larguraPx={(larguraTrilha * clip.widthPercent) / 100}
              onSelect={() => onSelect(clip.id)}
              onRemove={onRemove ? () => onRemove(clip) : null}
              onDragStart={() => onDragStart(clip.id)}
              onDrop={() => onDrop(clip.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function TrackClip({ clip, tone, selecionado, larguraPx, onSelect, onRemove, onDragStart, onDrop }) {
  const real = isRealClip(clip);
  const { frames, loading, error } = useFilmstrip(real ? clip.jobId : null);

  const quantos = responsiveFrameCount(larguraPx);
  const visiveis = pickVisibleFrames(frames, quantos);
  const toneClass = tone === 'gold' ? 'border-gold/40' : 'border-violet/40';

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
      className={`group absolute top-1.5 bottom-1.5 cursor-pointer overflow-hidden rounded-md border transition-all ${
        selecionado ? 'border-gold ring-2 ring-gold/40' : `${toneClass} hover:border-gold/70`
      }`}
      style={{ left: `${clip.leftPercent}%`, width: `calc(${clip.widthPercent}% - 4px)` }}
    >
      <button
        type="button"
        onClick={onSelect}
        title={`${clip.label} — ${clip.duration}s`}
        aria-label={`Selecionar ${clip.label}`}
        className="absolute inset-0 block h-full w-full"
      >
        {/* Filmstrip: cada quadro recortado dentro da sua própria célula. */}
        <span className="absolute inset-0 flex">
          {loading ? (
            Array.from({ length: Math.max(1, quantos) }).map((_, i) => (
              <span key={i} className="shimmer h-full flex-1 border-r border-black/40 bg-panel-2 last:border-r-0" />
            ))
          ) : visiveis.length ? (
            visiveis.map((frame) => (
              <span key={frame.index} className="relative h-full flex-1 overflow-hidden border-r border-black/40 last:border-r-0">
                {/* eslint-disable-next-line @next/next/no-img-element -- servido pela própria aplicação */}
                <img
                  src={frame.url}
                  alt=""
                  loading="lazy"
                  draggable={false}
                  className="h-full w-full object-cover object-center"
                />
              </span>
            ))
          ) : (
            <FallbackThumb clip={clip} />
          )}
        </span>

        {/* Rodapé: gradiente só na base, para não cobrir o centro da imagem. */}
        <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/95 via-black/75 to-transparent px-2 pb-1.5 pt-5 text-left">
          <span className="block truncate text-[11px] font-medium leading-tight text-chalk">{clip.label}</span>
          <span className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-[9.5px] text-mist">
            {clipRangeLabel(clip.start, clip.duration)}
            <span aria-hidden="true">·</span>
            {formatPreciseDuration(clip.duration)}
            <span aria-hidden="true">·</span>
            <span className={real ? 'text-ok' : 'text-warn'}>{real ? 'REAL' : 'SIMULADO'}</span>
            {clip.statusLabel ? (
              <>
                <span aria-hidden="true">·</span>
                <span className={clip.statusLabel === 'APROVADA' ? 'text-ok' : 'text-warn'}>{clip.statusLabel}</span>
              </>
            ) : null}
          </span>
        </span>

        {/* Selos no topo, fora da área central. */}
        <span className="absolute left-1.5 top-1.5 flex items-center gap-1">
          <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider backdrop-blur-sm ${
            real ? 'bg-ok/25 text-ok' : 'bg-warn/25 text-warn'
          }`}
          >
            {real ? 'real' : 'sim.'}
          </span>
          {error ? (
            <span className="rounded bg-black/70 px-1.5 py-0.5 text-[9px] text-warn" title={error}>
              miniatura única
            </span>
          ) : null}
        </span>
      </button>

      {/* Ações no hover — nunca iniciam reprodução sozinhas. */}
      <span className="absolute right-1.5 top-1.5 z-10 flex gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Reproduzir ${clip.label}`}
          title="Reproduzir na pré-visualização"
          className="focus-ring flex h-7 w-7 items-center justify-center rounded-md bg-black/80 text-chalk hover:bg-black"
        >
          <Icon name="play" size={13} />
        </button>
        {onRemove ? (
          <button
            type="button"
            onClick={onRemove}
            aria-label={`Remover ${clip.label} da timeline`}
            title="Remover da timeline (o arquivo é preservado)"
            className="focus-ring flex h-7 w-7 items-center justify-center rounded-md bg-black/80 text-mist hover:bg-danger/80 hover:text-chalk"
          >
            <Icon name="trash" size={13} />
          </button>
        ) : null}
      </span>
    </div>
  );
}

/** Miniatura única quando a filmstrip não pôde ser extraída. */
function FallbackThumb({ clip }) {
  const { thumbnail, loading } = useVideoThumbnail(clip.mediaUrl, { width: 480, enabled: Boolean(clip.mediaUrl) });

  if (thumbnail) {
    return (
      <span className="relative h-full w-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- quadro local */}
        <img src={thumbnail} alt="" className="h-full w-full object-cover object-center" />
      </span>
    );
  }
  if (clip.poster) {
    return (
      <span className="relative h-full w-full overflow-hidden">
        {/* eslint-disable-next-line @next/next/no-img-element -- data: URL local */}
        <img src={clip.poster} alt="" className="h-full w-full object-cover object-center opacity-70" />
      </span>
    );
  }
  return (
    <span className={`flex h-full w-full items-center justify-center bg-panel-2 text-mist/50 ${loading ? 'shimmer' : ''}`}>
      <Icon name="video" size={18} />
    </span>
  );
}

function ClipCard({ clip, index, total, generation, selecionado, onSelect, onRename, onDuration, onMove, onRemove }) {
  const real = isRealClip(clip);
  const status = generation?.status || (real ? 'pendente' : 'demonstração');

  return (
    <Panel className={`overflow-hidden p-0 ${selecionado ? 'border-gold/50' : ''}`}>
      <div className="flex gap-3 p-3">
        <button
          type="button"
          onClick={onSelect}
          aria-label={`Pré-visualizar ${clip.label}`}
          className="focus-ring group relative h-[74px] w-[132px] shrink-0 overflow-hidden rounded-lg border border-hairline bg-ink-2"
        >
          <ClipThumb clip={clip} width={320} />
          <span className="absolute inset-0 flex items-center justify-center bg-black/35 opacity-0 transition-opacity group-hover:opacity-100">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-black/75 text-chalk">
              <Icon name="play" size={14} />
            </span>
          </span>
          <span className="absolute left-1 top-1">
            <Badge tone={real ? 'ok' : 'warn'}>{real ? 'real' : 'simulado'}</Badge>
          </span>
        </button>

        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex items-start gap-2">
            <span className="mt-2 w-5 shrink-0 text-center font-mono text-[11px] text-mist">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <Input
                value={clip.label}
                onChange={(event) => onRename(event.target.value)}
                className="h-8 text-[12.5px]"
                aria-label="Título do clipe"
              />
            </div>
            <div className="w-16 shrink-0">
              <Input
                type="number"
                min="1"
                step="0.01"
                value={clip.duration}
                onChange={(event) => onDuration(Math.max(0.1, Number(event.target.value) || 0.1))}
                className="h-8 text-[12px]"
                aria-label="Duração em segundos"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5 pl-7">
            <Badge tone={status === 'aprovado' ? 'ok' : status === 'revisão' ? 'alert' : 'neutral'}>{status}</Badge>
            <span className="font-mono text-[10px] text-mist/70">{clip.duration}s</span>
            {clip.seed !== null && clip.seed !== undefined ? (
              <span className="font-mono text-[10px] text-mist/60">seed {clip.seed}</span>
            ) : null}
          </div>

          {/* Referência explícita ao asset e ao arquivo real. */}
          <p className="truncate pl-7 font-mono text-[9.5px] text-mist/60" title={clip.mediaUrl || clipIdentity(clip)}>
            {clip.resultId ? `asset ${clip.resultId}` : clipIdentity(clip)}
            {clip.mediaUrl ? ` · ${clip.mediaUrl}` : ' · sem arquivo (demonstração)'}
          </p>

          <div className="flex flex-wrap items-center gap-1.5 pl-7 pt-0.5">
            <Button size="sm" variant="secondary" icon="play" onClick={onSelect} disabled={!real}>
              Reproduzir
            </Button>
            <IconButton icon="up" label="Mover para cima" onClick={() => onMove(-1)} disabled={index === 0} />
            <IconButton icon="down" label="Mover para baixo" onClick={() => onMove(1)} disabled={index === total - 1} />
            <IconButton icon="trash" label="Remover da timeline" onClick={onRemove} />
          </div>
        </div>
      </div>
    </Panel>
  );
}

function PreviewPanel({ clip, generation }) {
  if (!isRealClip(clip)) {
    return (
      <Panel className="p-4">
        <SectionTitle title="Pré-visualização" subtitle="Este clipe é de demonstração e não tem arquivo de vídeo." />
        <Empty icon="video" title="Sem mídia para reproduzir" hint="Clipes simulados existem só para desenhar a montagem." />
      </Panel>
    );
  }

  return (
    <Panel className="space-y-3 p-4">
      <SectionTitle
        title={clip.label}
        subtitle="Reproduzindo o arquivo real dentro da timeline."
        action={<Badge tone="ok">real</Badge>}
      />
      <RealVideoPlayer src={clip.mediaUrl} aspect={clip.aspect || generation?.aspect || '16:9'} />
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[10.5px] sm:grid-cols-4">
        <Info termo="Duração" valor={`${clip.duration}s`} />
        <Info termo="Status" valor={generation?.status || 'pendente'} />
        <Info termo="Seed" valor={String(clip.seed ?? generation?.seed ?? '—')} />
        <Info termo="Custo" valor="US$ 0,00" />
        <Info termo="asset" valor={clip.resultId || '—'} span />
        <Info termo="jobId" valor={clip.jobId || '—'} span />
        <Info termo="prompt_id" valor={clip.promptId || generation?.promptId || '—'} span />
        <Info termo="arquivo" valor={clip.mediaUrl} span />
      </dl>
    </Panel>
  );
}

function Info({ termo, valor, span = false }) {
  return (
    <div className={`min-w-0 ${span ? 'col-span-2' : ''}`} title={String(valor)}>
      <dt className="text-[9.5px] uppercase tracking-wider text-mist/70">{termo}</dt>
      <dd className="truncate text-chalk">{valor}</dd>
    </div>
  );
}
