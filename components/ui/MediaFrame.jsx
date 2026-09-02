'use client';

import { useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { Badge } from './primitives';
import { RealVideoPlayer } from './RealVideoPlayer';

const ASPECT_CLASS = {
  '1:1': 'aspect-square',
  '16:9': 'aspect-video',
  '9:16': 'aspect-[9/16]',
  '4:3': 'aspect-[4/3]',
  '3:4': 'aspect-[3/4]',
  '21:9': 'aspect-[21/9]',
  '3:2': 'aspect-[3/2]',
  '2:3': 'aspect-[2/3]',
};

export function aspectClass(aspect) {
  return ASPECT_CLASS[aspect] || 'aspect-video';
}

/**
 * Quadro estático (imagem). O src é sempre um data: URL desenhado localmente.
 *
 * `scrim` liga um degradê escuro no topo: os quadros gerados costumam ser
 * claros, e sem ele os selos sobrepostos ficam ilegíveis.
 */
export function ImageFrame({ src, alt = '', aspect = '16:9', className = '', scrim = false, children }) {
  return (
    <div
      className={`relative overflow-hidden rounded-xl border border-hairline bg-ink-2 ${aspectClass(aspect)} ${className}`}
    >
      {src ? (
        // eslint-disable-next-line @next/next/no-img-element -- data: URL local, sem otimização remota
        <img src={src} alt={alt} className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center text-mist/50">
          <Icon name="imagem" size={26} />
        </div>
      )}
      {scrim ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/70 to-transparent"
        />
      ) : null}
      {children}
    </div>
  );
}

/**
 * Player simulado.
 *
 * Não existe arquivo de vídeo na fase 1 — percorremos os quadros pré-desenhados
 * no ritmo da duração declarada. A superfície de controle (play/pause, scrub,
 * timecode) já é a que o player real vai expor.
 */
export function VideoFrame({ item, aspect = '16:9', className = '', compact = false }) {
  // Resultado real do ComfyUI: existe um arquivo, então usamos o player nativo
  // em vez de percorrer quadros simulados.
  const frames = item?.frames?.length ? item.frames : [item?.poster].filter(Boolean);
  const duration = Number(item?.duration) || 6;
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const rafRef = useRef(null);
  const startRef = useRef(0);

  useEffect(() => {
    if (!playing) return undefined;
    startRef.current = performance.now() - progress * duration * 1000;

    const tick = (now) => {
      const elapsed = (now - startRef.current) / 1000;
      const next = elapsed / duration;
      if (next >= 1) {
        setProgress(1);
        setPlaying(false);
        return;
      }
      setProgress(next);
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration]);

  const frameIndex = Math.min(frames.length - 1, Math.floor(progress * frames.length));
  const current = frames[Math.max(0, frameIndex)] || item?.poster;
  const currentTime = progress * duration;

  const toggle = () => {
    if (progress >= 1) setProgress(0);
    setPlaying((p) => !p);
  };

  if (item?.real && item?.mediaUrl) {
    return <RealVideoPlayer src={item.mediaUrl} aspect={aspect || item.aspect} className={className} />;
  }

  return (
    <div className={`overflow-hidden rounded-xl border border-hairline bg-ink-2 ${className}`}>
      <button
        type="button"
        onClick={toggle}
        className={`group relative block w-full ${aspectClass(aspect)}`}
        aria-label={playing ? 'Pausar' : 'Reproduzir'}
      >
        {current ? (
          // eslint-disable-next-line @next/next/no-img-element -- data: URL local
          <img src={current} alt={item?.prompt || ''} className="h-full w-full object-cover" />
        ) : null}
        <span className="absolute inset-0 flex items-center justify-center bg-black/25 opacity-0 transition-opacity group-hover:opacity-100">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-black/70 text-chalk">
            <Icon name={playing ? 'pause' : 'play'} size={20} />
          </span>
        </span>
        {!compact ? (
          <span className="absolute right-2.5 top-2.5">
            <Badge tone="warn">player simulado</Badge>
          </span>
        ) : null}
      </button>

      <div className="flex items-center gap-3 border-t border-hairline px-3 py-2">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? 'Pausar' : 'Reproduzir'}
          className="focus-ring flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-white/[0.08] text-chalk hover:bg-white/[0.16]"
        >
          <Icon name={playing ? 'pause' : 'play'} size={13} />
        </button>
        <input
          type="range"
          min="0"
          max="1000"
          value={Math.round(progress * 1000)}
          onChange={(event) => {
            setPlaying(false);
            setProgress(Number(event.target.value) / 1000);
          }}
          aria-label="Posição"
          className="h-1 flex-1 cursor-pointer appearance-none rounded-full bg-hairline accent-gold"
        />
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-mist">
          {currentTime.toFixed(1)}s / {duration}s
        </span>
      </div>
    </div>
  );
}

/** Escolhe o quadro certo para qualquer item da biblioteca. */
export function MediaPreview({ item, aspect, className = '' }) {
  if (!item) return null;
  if (item.kind === 'video') {
    return <VideoFrame item={item} aspect={aspect || item.aspect} className={className} />;
  }
  return <ImageFrame src={item.url} alt={item.prompt} aspect={aspect || item.aspect} className={className} />;
}
