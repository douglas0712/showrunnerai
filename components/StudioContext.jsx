'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { KEYS, readKey, writeKey, clearAll } from '@/lib/storage';
import {
  demoCharacters,
  demoConversation,
  demoGenerations,
  demoProjects,
  demoSettings,
  demoStoryboard,
  demoTimeline,
} from '@/lib/demoData';
import { CINEMA_DEFAULTS } from '@/lib/cinema';
import { createRegistry, resolveExecutionProvider } from '@/lib/providers/registry';
import { initialAgentState } from '@/lib/agentScript';
import { makeId } from '@/lib/rng';
import { clipFromGeneration, reconcileTimeline } from '@/lib/timelineAssets';

const StudioContext = createContext(null);

/**
 * Revisão da timeline. Ao subir este número, a reconciliação roda de novo uma
 * única vez em cada navegador — é assim que o estado antigo é corrigido sem
 * mexer nos arquivos.
 */
const TIMELINE_REVISION_ATUAL = 1;

/**
 * Estado hidratado do localStorage no cliente.
 *
 * A hidratação acontece depois da montagem (nunca no servidor) para que o HTML
 * renderizado e o primeiro render do cliente sejam idênticos. Enquanto isso,
 * `ready` é false e as telas mostram o esqueleto.
 */
export function StudioProvider({ children }) {
  const [ready, setReady] = useState(false);
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [generations, setGenerations] = useState([]);
  const [scenes, setScenes] = useState([]);
  const [timeline, setTimeline] = useState({ video: [], audio: [] });
  const [characters, setCharacters] = useState([]);
  const [conversation, setConversation] = useState({ messages: [], agent: initialAgentState() });
  const [settings, setSettings] = useState(demoSettings());
  const [cinema, setCinema] = useState({ scene: '', controls: { ...CINEMA_DEFAULTS }, prompt: '', manual: false });
  // Job da aba Cinema em andamento. Fica fora do componente para sobreviver a
  // troca de aba e a recarregamento da página.
  const [cinemaJobId, setCinemaJobId] = useState(null);
  const [timelineRevision, setTimelineRevision] = useState(0);
  // Exportação em andamento: fica fora do componente para o acompanhamento
  // sobreviver a troca de aba e a recarregamento da página.
  const [exportJobId, setExportJobId] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [handoff, setHandoff] = useState(null);

  // ── hidratação + semeadura da demonstração ────────────────────────────────
  useEffect(() => {
    const storedProjects = readKey(KEYS.PROJECTS, null);
    const seeded = storedProjects !== null;

    setProjects(seeded ? storedProjects : demoProjects());
    setActiveProjectId(readKey(KEYS.ACTIVE_PROJECT, seeded ? null : 'proj_demo_noir'));
    setGenerations(readKey(KEYS.GENERATIONS, null) ?? demoGenerations());
    setScenes(readKey(KEYS.STORYBOARD, null) ?? demoStoryboard());
    setTimeline(readKey(KEYS.TIMELINE, null) ?? demoTimeline());
    setCharacters(readKey(KEYS.CHARACTERS, null) ?? demoCharacters());
    setConversation(
      readKey(KEYS.CONVERSATION, null) ?? { messages: demoConversation(), agent: initialAgentState() },
    );
    setSettings({ ...demoSettings(), ...(readKey(KEYS.SETTINGS, null) ?? {}) });
    setCinema(
      readKey(KEYS.CINEMA, null) ?? { scene: '', controls: { ...CINEMA_DEFAULTS }, prompt: '', manual: false },
    );
    setCinemaJobId(readKey(KEYS.CINEMA_JOB, null));
    setTimelineRevision(readKey(KEYS.TIMELINE_REVISION, 0));
    setExportJobId(readKey(KEYS.EXPORT_JOB, null));
    setReady(true);
  }, []);

  // ── persistência ──────────────────────────────────────────────────────────
  usePersist(KEYS.PROJECTS, projects, ready);
  usePersist(KEYS.ACTIVE_PROJECT, activeProjectId, ready);
  usePersist(KEYS.GENERATIONS, generations, ready);
  usePersist(KEYS.STORYBOARD, scenes, ready);
  usePersist(KEYS.TIMELINE, timeline, ready);
  usePersist(KEYS.CHARACTERS, characters, ready);
  usePersist(KEYS.CONVERSATION, conversation, ready);
  usePersist(KEYS.SETTINGS, settings, ready);
  usePersist(KEYS.CINEMA, cinema, ready);
  usePersist(KEYS.CINEMA_JOB, cinemaJobId, ready);
  usePersist(KEYS.TIMELINE_REVISION, timelineRevision, ready);
  usePersist(KEYS.EXPORT_JOB, exportJobId, ready);

  // ── providers ─────────────────────────────────────────────────────────────
  const registry = useMemo(() => createRegistry(settings), [settings]);
  const resolveProvider = useCallback(
    (modelId) => resolveExecutionProvider(registry, modelId),
    [registry],
  );

  // ── avisos ────────────────────────────────────────────────────────────────
  const timers = useRef(new Map());
  const dismissToast = useCallback((id) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (message, tone = 'info', ttl = 5200) => {
      const id = makeId('toast');
      setToasts((list) => [...list.slice(-3), { id, message, tone }]);
      const timer = setTimeout(() => dismissToast(id), ttl);
      timers.current.set(id, timer);
      return id;
    },
    [dismissToast],
  );

  useEffect(() => {
    const map = timers.current;
    return () => {
      map.forEach((timer) => clearTimeout(timer));
      map.clear();
    };
  }, []);

  // ── ações sobre gerações ──────────────────────────────────────────────────
  const addGenerations = useCallback((items = []) => {
    setGenerations((list) => [...items, ...list]);
  }, []);

  const updateGeneration = useCallback((id, patch) => {
    setGenerations((list) => list.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const approveGeneration = useCallback(
    (id) => {
      updateGeneration(id, { status: 'aprovado', revisionNote: '' });
      toast('Item aprovado.', 'ok');
    },
    [updateGeneration, toast],
  );

  const requestRevision = useCallback(
    (id, note) => {
      updateGeneration(id, { status: 'revisão', revisionNote: note });
      toast('Alteração registrada. O pedido fica anexado ao item.', 'warn');
    },
    [updateGeneration, toast],
  );

  const removeGeneration = useCallback((id) => {
    setGenerations((list) => list.filter((item) => item.id !== id));
  }, []);

  /**
   * Traz os resultados reais do servidor para a biblioteca e reconcilia a
   * timeline: descarta a demonstração, elimina duplicatas e garante que cada
   * vídeo real esteja presente uma única vez, com título humano e na ordem certa.
   *
   * Roda uma vez por revisão (`TIMELINE_REVISION`), então é idempotente.
   */
  const adoptRealAssets = useCallback(async ({ force = false } = {}) => {
    const provider = registry.get('comfyui');
    let jobs = [];
    try {
      const resposta = await provider.listJobs({ recover: true });
      jobs = (resposta.jobs || []).filter((j) => j.result?.url);
    } catch {
      return { adotados: 0, relatorio: null };
    }
    if (!jobs.length && !force) return { adotados: 0, relatorio: null };

    let adotados = 0;
    let listaAtualizada = [];

    setGenerations((atual) => {
      const porJob = new Map(atual.filter((g) => g.jobId).map((g) => [g.jobId, g]));
      const novos = [];

      for (const job of jobs) {
        if (porJob.has(job.jobId)) continue;
        novos.push({
          id: makeId('vid'),
          kind: 'video',
          simulated: false,
          real: true,
          providerId: 'comfyui',
          intendedProviderId: 'comfyui',
          modelId: 'minimax-h3',
          prompt: job.prompt,
          aspect: job.aspect,
          resolution: job.quality,
          duration: job.durationActual,
          frames: job.frames,
          fps: job.fps,
          seed: job.seed,
          promptId: job.promptId,
          jobId: job.jobId,
          mediaUrl: job.result.url,
          costUsd: 0,
          mode: 't2v',
          status: 'pendente',
          revisionNote: '',
          createdAt: job.createdAt || Date.now(),
        });
      }

      adotados = novos.length;
      // Resultados reais mais antigos primeiro preserva a ordem de produção.
      listaAtualizada = [...novos, ...atual];
      return listaAtualizada;
    });

    let relatorio = null;
    setTimeline((atual) => {
      const resultado = reconcileTimeline(atual, { generations: listaAtualizada });
      relatorio = resultado.relatorio;
      return { video: resultado.video, audio: resultado.audio };
    });

    setTimelineRevision(TIMELINE_REVISION_ATUAL);
    return { adotados, relatorio };
  }, [registry]);

  // Correção única do estado atual da timeline.
  useEffect(() => {
    if (!ready) return;
    if (timelineRevision >= TIMELINE_REVISION_ATUAL) return;
    adoptRealAssets();
  }, [ready, timelineRevision, adoptRealAssets]);

  const resetAll = useCallback(() => {
    clearAll();
    setProjects(demoProjects());
    setActiveProjectId('proj_demo_noir');
    setGenerations(demoGenerations());
    setScenes(demoStoryboard());
    setTimeline(demoTimeline());
    setCharacters(demoCharacters());
    setConversation({ messages: demoConversation(), agent: initialAgentState() });
    setSettings(demoSettings());
    setCinema({ scene: '', controls: { ...CINEMA_DEFAULTS }, prompt: '', manual: false });
    setCinemaJobId(null);
    setTimelineRevision(0);
    setExportJobId(null);
    toast('Dados locais restaurados para a demonstração.', 'ok');
  }, [toast]);

  const value = useMemo(
    () => ({
      ready,
      projects, setProjects,
      activeProjectId, setActiveProjectId,
      activeProject: projects.find((p) => p.id === activeProjectId) || null,
      generations, setGenerations, addGenerations, updateGeneration,
      approveGeneration, requestRevision, removeGeneration,
      scenes, setScenes,
      timeline, setTimeline,
      characters, setCharacters,
      conversation, setConversation,
      settings, setSettings,
      cinema, setCinema,
      cinemaJobId, setCinemaJobId,
      exportJobId, setExportJobId,
      adoptRealAssets,
      registry, resolveProvider,
      toasts, toast, dismissToast,
      handoff, setHandoff,
      resetAll,
    }),
    [
      ready, projects, activeProjectId, generations, scenes, timeline, characters,
      conversation, settings, cinema, cinemaJobId, registry, resolveProvider, toasts, handoff,
      adoptRealAssets, exportJobId,
      addGenerations, updateGeneration, approveGeneration, requestRevision,
      removeGeneration, toast, dismissToast, resetAll,
    ],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

function usePersist(key, value, ready) {
  useEffect(() => {
    if (!ready) return;
    writeKey(key, value);
  }, [key, value, ready]);
}

export function useStudio() {
  const context = useContext(StudioContext);
  if (!context) throw new Error('useStudio precisa estar dentro de <StudioProvider>.');
  return context;
}
