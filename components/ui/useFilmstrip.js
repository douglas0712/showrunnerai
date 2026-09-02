'use client';

import { useEffect, useState } from 'react';

/**
 * Filmstrip de um clipe, servida pelo backend.
 *
 * O resultado é memorizado em módulo: trocar de aba e voltar não dispara nova
 * requisição, e o servidor já responde do cache em disco de qualquer forma.
 */
const memoria = new Map();
const emVoo = new Map();

function buscar(jobId) {
  if (memoria.has(jobId)) return Promise.resolve(memoria.get(jobId));
  if (emVoo.has(jobId)) return emVoo.get(jobId);

  const promessa = fetch(`/api/filmstrip?jobId=${encodeURIComponent(jobId)}`, { cache: 'no-store' })
    .then(async (resposta) => {
      const dados = await resposta.json().catch(() => ({}));
      if (!resposta.ok) throw new Error(dados.error || 'Falha ao gerar a filmstrip.');
      memoria.set(jobId, dados);
      return dados;
    })
    .finally(() => emVoo.delete(jobId));

  emVoo.set(jobId, promessa);
  return promessa;
}

/**
 * @param {string|null} jobId
 * @returns {{frames: Array, loading: boolean, error: string|null, duration: number|null}}
 */
export function useFilmstrip(jobId) {
  const [estado, setEstado] = useState(() => {
    const cacheado = jobId ? memoria.get(jobId) : null;
    return {
      frames: cacheado?.frames || [],
      duration: cacheado?.duration ?? null,
      loading: Boolean(jobId) && !cacheado,
      error: null,
    };
  });

  useEffect(() => {
    if (!jobId) {
      setEstado({ frames: [], duration: null, loading: false, error: null });
      return undefined;
    }

    const cacheado = memoria.get(jobId);
    if (cacheado) {
      setEstado({ frames: cacheado.frames, duration: cacheado.duration, loading: false, error: null });
      return undefined;
    }

    let cancelado = false;
    setEstado((atual) => ({ ...atual, loading: true, error: null }));

    buscar(jobId)
      .then((dados) => {
        if (cancelado) return;
        setEstado({ frames: dados.frames || [], duration: dados.duration ?? null, loading: false, error: null });
      })
      .catch((erro) => {
        if (cancelado) return;
        // Falhar aqui não pode quebrar a timeline: quem chama cai na miniatura única.
        setEstado({ frames: [], duration: null, loading: false, error: erro.message });
      });

    return () => { cancelado = true; };
  }, [jobId]);

  return estado;
}

/** Limpa a memória local — usado quando o vídeo de um job muda. */
export function invalidateFilmstrip(jobId) {
  if (jobId) memoria.delete(jobId);
  else memoria.clear();
}
