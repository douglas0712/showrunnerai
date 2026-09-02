'use client';

import { useEffect, useState } from 'react';

/**
 * Extrai um quadro do próprio MP4 para servir de miniatura.
 *
 * Carrega o vídeo com `preload="metadata"`, busca um instante representativo e
 * desenha em canvas. Tudo local: o arquivo já é servido pela aplicação e o
 * quadro nunca sai do navegador.
 *
 * @param {string} url        endereço do vídeo (/api/media/video/...)
 * @param {object} options
 * @param {number} options.at fração da duração usada como quadro (0..1)
 * @param {number} options.width largura da miniatura em pixels
 * @returns {{thumbnail: string|null, loading: boolean, error: string|null}}
 */
export function useVideoThumbnail(url, { at = 0.25, width = 480, enabled = true } = {}) {
  const [thumbnail, setThumbnail] = useState(null);
  const [loading, setLoading] = useState(Boolean(url && enabled));
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!url || !enabled) {
      setThumbnail(null);
      setLoading(false);
      return undefined;
    }

    let cancelado = false;
    setLoading(true);
    setError(null);

    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.src = url;

    const limpar = () => {
      video.removeAttribute('src');
      video.load();
    };

    const desenhar = () => {
      if (cancelado) return;
      try {
        const escala = width / (video.videoWidth || width);
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round((video.videoWidth || width) * escala));
        canvas.height = Math.max(1, Math.round((video.videoHeight || width * 0.5625) * escala));
        const ctx = canvas.getContext('2d');
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        setThumbnail(canvas.toDataURL('image/jpeg', 0.72));
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
        limpar();
      }
    };

    const aoCarregarMetadados = () => {
      if (cancelado) return;
      const alvo = Number.isFinite(video.duration) ? Math.min(video.duration * at, Math.max(0, video.duration - 0.1)) : 0;
      // O quadro só existe depois do seek; 'seeked' é o gatilho para desenhar.
      video.currentTime = alvo;
    };

    const aoErro = () => {
      if (cancelado) return;
      setError('Não foi possível ler o vídeo para gerar a miniatura.');
      setLoading(false);
      limpar();
    };

    video.addEventListener('loadedmetadata', aoCarregarMetadados);
    video.addEventListener('seeked', desenhar);
    video.addEventListener('error', aoErro);

    return () => {
      cancelado = true;
      video.removeEventListener('loadedmetadata', aoCarregarMetadados);
      video.removeEventListener('seeked', desenhar);
      video.removeEventListener('error', aoErro);
      limpar();
    };
  }, [url, at, width, enabled]);

  return { thumbnail, loading, error };
}
