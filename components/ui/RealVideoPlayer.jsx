'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { Badge } from './primitives';

const ASPECT_CLASS = {
  '16:9': 'aspect-video',
  '21:9': 'aspect-[21/9]',
  '9:16': 'aspect-[9/16]',
  '1:1': 'aspect-square',
  '4:3': 'aspect-[4/3]',
  '3:4': 'aspect-[3/4]',
  '2:3': 'aspect-[2/3]',
  '3:2': 'aspect-[3/2]',
};

const MEDIA_ERROS = {
  1: 'A carga do vídeo foi interrompida.',
  2: 'Falha de rede ao ler o arquivo.',
  3: 'O vídeo não pôde ser decodificado.',
  4: 'O formato do arquivo não é suportado pelo navegador.',
};

const MAX_TENTATIVAS = 3;

/**
 * Player de um MP4 real servido por /api/media/...
 *
 * Tolera falha transitória. A primeira requisição a uma rota ainda não
 * compilada pelo servidor de desenvolvimento pode voltar 500; antes, esse único
 * tropeço deixava o player travado numa mensagem de erro para sempre, mesmo com
 * o arquivo intacto no disco. Agora ele confere o que aconteceu e tenta de novo.
 */
export function RealVideoPlayer({ src, poster = null, aspect = '16:9', className = '', onError }) {
  const ref = useRef(null);
  const [tentativa, setTentativa] = useState(0);
  const [erro, setErro] = useState(null);
  const [reavaliando, setReavaliando] = useState(false);

  const aspectClass = ASPECT_CLASS[aspect] || 'aspect-video';

  // `cacheBust` muda a cada tentativa: garante que uma resposta ruim guardada
  // no cache do navegador não seja reaproveitada.
  const fonte = tentativa === 0 ? src : `${src}${src.includes('?') ? '&' : '?'}r=${tentativa}`;

  const tentarNovamente = useCallback(() => {
    setErro(null);
    setTentativa((n) => n + 1);
  }, []);

  useEffect(() => {
    setTentativa(0);
    setErro(null);
  }, [src]);

  const aoErro = useCallback(async () => {
    const elemento = ref.current;
    const codigo = elemento?.error?.code ?? null;

    // Descobre se o problema é do arquivo ou da resposta HTTP, para a mensagem
    // ser útil em vez de genérica.
    let diagnostico = MEDIA_ERROS[codigo] || 'O arquivo não pôde ser lido pelo player.';
    setReavaliando(true);
    let status = null;
    try {
      const resposta = await fetch(fonte, { method: 'HEAD', cache: 'no-store' });
      status = resposta.status;
      if (!resposta.ok) diagnostico = `O servidor respondeu ${resposta.status} para este arquivo.`;
    } catch (e) {
      diagnostico = `Não foi possível alcançar o servidor: ${e.message}`;
    }
    setReavaliando(false);

    // Falha transitória (servidor respondeu, ou erro de rede): tenta de novo.
    const podeTentar = tentativa < MAX_TENTATIVAS && (status === null || status >= 500 || status === 200);
    if (podeTentar) {
      setTimeout(tentarNovamente, 400 * (tentativa + 1));
      return;
    }

    setErro({ mensagem: diagnostico, codigo, status });
    onError?.(diagnostico);
  }, [fonte, tentativa, tentarNovamente, onError]);

  if (erro) {
    return (
      <div className={`flex ${aspectClass} flex-col items-center justify-center gap-3 rounded-xl border border-danger/30 bg-danger/[0.06] p-6 text-center ${className}`}>
        <p className="text-[12.5px] leading-relaxed text-danger/90">
          Não foi possível carregar o vídeo.
          <span className="mt-1 block text-[11px] opacity-85">{erro.mensagem}</span>
          {erro.codigo ? (
            <span className="mt-1 block font-mono text-[10px] opacity-70">
              código {erro.codigo}{erro.status ? ` · HTTP ${erro.status}` : ''}
            </span>
          ) : null}
        </p>
        <button
          type="button"
          onClick={tentarNovamente}
          className="pressable focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg border border-hairline bg-white/[0.06] px-3 text-[12px] text-chalk hover:bg-white/[0.12]"
        >
          <Icon name="revise" size={13} />
          Tentar de novo
        </button>
      </div>
    );
  }

  return (
    <div className={`relative overflow-hidden rounded-xl border border-hairline bg-black ${className}`}>
      <video
        key={fonte}
        ref={ref}
        src={fonte}
        poster={poster || undefined}
        controls
        playsInline
        preload="metadata"
        className={`w-full ${aspectClass} bg-black`}
        onError={aoErro}
      />
      <span className="absolute right-2.5 top-2.5">
        <Badge tone="ok">vídeo real</Badge>
      </span>
      {tentativa > 0 || reavaliando ? (
        <span className="absolute left-2.5 top-2.5">
          <Badge tone="warn">reconectando…</Badge>
        </span>
      ) : null}
    </div>
  );
}

export function PlayButton({ onClick, label = 'Reproduzir' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="pressable focus-ring inline-flex h-[38px] items-center gap-2 rounded-lg border border-hairline bg-white/[0.06] px-4 text-[13px] text-chalk hover:bg-white/[0.11]"
    >
      <Icon name="play" size={15} />
      {label}
    </button>
  );
}
