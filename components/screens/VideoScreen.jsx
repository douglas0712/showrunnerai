'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../StudioContext';
import {
  Badge, Button, Field, IconButton, Input, Panel, RuntimeBadge, SectionTitle,
  Segmented, Select, SimulationNote, StatusBadge, Textarea, Toggle,
} from '../ui/primitives';
import { ImageFrame, VideoFrame } from '../ui/MediaFrame';
import { Modal } from '../ui/Modal';
import { ResultActions, StatusPill } from '../ResultActions';
import { Icon } from '../ui/icons';
import { RealVideoPlayer } from '../ui/RealVideoPlayer';
import { modelsByKind, getModel, inputEnum, inputDefault } from '@/lib/models';
import { canEnterTimeline, clipFromGeneration } from '@/lib/timelineAssets';
import { makeId, randomSeed } from '@/lib/rng';
import { formatRelative, truncate } from '@/lib/format';

const MODES = [
  { value: 't2v', label: 'Texto para vídeo' },
  { value: 'i2v', label: 'Imagem para vídeo' },
  { value: 'r2v', label: 'Referência para vídeo' },
];

/* ---------------------------------------------------------------------------
   Parâmetros que o workflow do MiniMax H3 realmente aceita.

   Nada aqui é decorativo: cada opção corresponde a uma entrada do grafo que é
   submetido. O FPS é nativo de 24 e o áudio sai sempre do VAEDecodeAudio, então
   nenhum dos dois vira controle no modo real — oferecer a escolha seria mentir
   sobre o que o modelo faz.
   --------------------------------------------------------------------------- */
const REAL_ASPECTOS = ['16:9', '21:9', '9:16', '1:1', '4:3', '3:4', '2:3', '3:2'];
const REAL_QUALIDADES = [
  { value: '480p', label: '480p — rápido (0,4 MP)' },
  { value: '720p', label: '720p (0,9 MP)' },
  { value: '1080p', label: '1080p (2,1 MP)' },
];
const REAL_DURACOES = [5.2, 6, 7, 8, 10, 12, 15];
const REAL_FPS = 24;
const REAL_TIPOS_ACEITOS = 'image/png,image/jpeg,image/webp';

const ORDEM_ESTADOS = ['preparando', 'enviado', 'na-fila', 'gerando', 'decodificando', 'salvando', 'concluido'];

/** O projeto ativo vira um identificador seguro para o caminho de armazenamento. */
function sanitizeProjectId(id) {
  const limpo = String(id || 'avulso').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return limpo || 'avulso';
}

export default function VideoScreen({ navigate }) {
  const {
    generations, addGenerations, updateGeneration, resolveProvider, registry, toast,
    handoff, setHandoff, setTimeline, activeProjectId, ready,
  } = useStudio();

  const models = modelsByKind('video');
  const [modelId, setModelId] = useState('minimax-h3');
  const model = getModel(modelId);

  // ── modo real ─────────────────────────────────────────────────────────────
  // Padrão da tela: o MiniMax H3 gera de verdade. O motor de demonstração
  // continua disponível, mas deixou de ser o comportamento normal — e é
  // desligado sozinho para modelos sem execução conectada.
  const [realMode, setRealMode] = useState(true);
  const [firstFrame, setFirstFrame] = useState(null);
  const [lastFrame, setLastFrame] = useState(null);
  const [realAspect, setRealAspect] = useState('16:9');
  const [realQuality, setRealQuality] = useState('480p');
  const [realDuration, setRealDuration] = useState(5.2);
  const [seedLocked, setSeedLocked] = useState(false);
  const [job, setJob] = useState(null);
  const [realResultId, setRealResultId] = useState(null);

  const firstRef = useRef(null);
  const lastRef = useRef(null);
  const pollRef = useRef(null);
  const generationsRef = useRef(generations);
  generationsRef.current = generations;
  const adotouRef = useRef(false);

  const comfy = registry.get('comfyui');
  const projectId = useMemo(() => sanitizeProjectId(activeProjectId), [activeProjectId]);
  const suportaReal = Boolean(model?.liveCapabilities?.imageToVideo);

  // O modo é derivado do que o usuário enviou, nunca escolhido à mão.
  const realKind = firstFrame && lastFrame ? 'flf' : firstFrame ? 'i2v' : null;
  const realKindLabel = realKind === 'flf'
    ? 'Primeiro e último quadro → vídeo'
    : realKind === 'i2v' ? 'Imagem → vídeo' : null;

  const [mode, setMode] = useState('t2v');
  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [resolution, setResolution] = useState('1080p');
  const [duration, setDuration] = useState(6);
  const [fps, setFps] = useState(24);
  const [audio, setAudio] = useState(false);
  const [seed, setSeed] = useState(() => randomSeed());
  const [sourceImage, setSourceImage] = useState(null);
  const [references, setReferences] = useState([]);
  const [busy, setBusy] = useState(false);
  const [compareWith, setCompareWith] = useState(null);
  const imageRef = useRef(null);
  const refRef = useRef(null);

  useEffect(() => {
    if (handoff?.target !== 'video') return;
    const { payload } = handoff;
    if (payload.mode) setMode(payload.mode);
    if (payload.modelId && models.some((m) => m.id === payload.modelId)) setModelId(payload.modelId);
    if (payload.prompt) setPrompt(payload.prompt);
    if (payload.aspect) setAspect(payload.aspect);
    if (payload.image) {
      setSourceImage({ id: payload.image.id, name: 'Imagem do estúdio', url: payload.image.url });
      setMode('i2v');
      toast('Imagem carregada do estúdio de imagem.', 'ok');
    }
    setHandoff(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff]);

  useEffect(() => {
    if (!model) return;
    const sync = (list, value, key, setter) => {
      if (list.length && !list.includes(value)) setter(inputDefault(model, key, list[0]));
    };
    sync(inputEnum(model, 'aspect_ratio'), aspect, 'aspect_ratio', setAspect);
    sync(inputEnum(model, 'resolution'), resolution, 'resolution', setResolution);
    sync(inputEnum(model, 'duration'), duration, 'duration', setDuration);
    sync(inputEnum(model, 'fps'), fps, 'fps', setFps);
    if (model.modes && !model.modes.includes(mode)) setMode(model.modes[0]);
    // Modelo sem execução real conectada não pode ficar no motor real.
    if (!model.liveCapabilities?.imageToVideo) setRealMode(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  const videos = useMemo(() => generations.filter((item) => item.kind === 'video'), [generations]);

  const readFile = (file, setter) => {
    const reader = new FileReader();
    reader.onload = () => setter({ id: `${file.name}-${Date.now()}`, name: file.name, url: String(reader.result) });
    reader.readAsDataURL(file);
  };

  // ── acompanhamento do job real ────────────────────────────────────────────
  const pararPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => pararPolling, [pararPolling]);

  /**
   * Guarda o vídeo real na biblioteca, pendente de aprovação.
   * Idempotente: um job já adotado reaproveita o item em vez de duplicá-lo.
   */
  const registrarResultadoReal = useCallback((jobFinal, listaAtual) => {
    const jaExiste = (listaAtual || []).find((g) => g.jobId === jobFinal.jobId);
    if (jaExiste) {
      setRealResultId(jaExiste.id);
      return jaExiste;
    }

    const item = {
      id: makeId('vid'),
      kind: 'video',
      simulated: false,
      real: true,
      providerId: 'comfyui',
      intendedProviderId: 'comfyui',
      modelId: 'minimax-h3',
      prompt: jobFinal.prompt,
      aspect: jobFinal.aspect,
      resolution: jobFinal.quality,
      duration: jobFinal.durationActual,
      frames: jobFinal.frames,
      fps: jobFinal.fps,
      seed: jobFinal.seed,
      promptId: jobFinal.promptId,
      jobId: jobFinal.jobId,
      mediaUrl: jobFinal.result.url,
      costUsd: 0,
      mode: jobFinal.mode || 'i2v',
      modeLabel: jobFinal.modeLabel || null,
      status: 'pendente',
      revisionNote: '',
      createdAt: Date.now(),
    };
    addGenerations([item]);
    setRealResultId(item.id);
    return item;
  }, [addGenerations]);

  /** Ciclo de acompanhamento: status → (quando pronto) resultado. */
  const acompanhar = useCallback(async (jobId, tentativasComErro = 0) => {
    try {
      const atual = await comfy.pollJob(jobId);
      setJob(atual);

      // O servidor finaliza sozinho; este ramo é a rede de segurança.
      const final = atual.readyToFinalize ? await comfy.finalizeJob(jobId) : atual;
      if (atual.readyToFinalize) setJob(final);

      if (final.result?.url) {
        registrarResultadoReal(final, generationsRef.current);
        setBusy(false);
        toast('Vídeo gerado e salvo. Aprove antes de adicionar à timeline.', 'ok');
        return;
      }

      if (final.terminal) {
        setBusy(false);
        if (final.state === 'falhou') toast(final.error || 'A geração falhou.', 'error');
        if (final.state === 'cancelado') toast('Geração cancelada.', 'warn');
        return;
      }

      pollRef.current = setTimeout(() => acompanhar(jobId, 0), 1500);
    } catch (error) {
      // Uma falha de rede não pode abandonar um job que segue rodando na GPU.
      if (tentativasComErro < 5) {
        const espera = 2000 * (tentativasComErro + 1);
        pollRef.current = setTimeout(() => acompanhar(jobId, tentativasComErro + 1), espera);
        return;
      }
      setBusy(false);
      toast(`${error.message} — o job segue no ComfyUI e pode ser recuperado.`, 'error');
    }
  }, [comfy, registrarResultadoReal, toast]);

  /**
   * Ao abrir a aba, retoma o que existe no servidor.
   *
   * Cobre sair da aba durante a geração, recarregar a página e reiniciar o
   * servidor. Só adota jobs de imagem → vídeo: os de texto → vídeo são da aba
   * Cinema e apareceriam aqui fora de contexto.
   */
  useEffect(() => {
    if (!ready || adotouRef.current) return;
    adotouRef.current = true;

    let cancelado = false;
    (async () => {
      try {
        const { jobs } = await comfy.listJobs({ recover: true });
        if (cancelado) return;

        const comQuadro = (jobs || []).filter((j) => j.mode === 'i2v' || j.mode === 'flf');

        const emAndamento = comQuadro.find((j) => !j.terminal && !j.result);
        if (emAndamento) {
          setRealMode(true);
          setBusy(true);
          setJob(emAndamento);
          acompanhar(emAndamento.jobId);
          return;
        }

        const concluido = comQuadro.find((j) => j.result?.url);
        if (concluido) {
          setRealMode(true);
          setJob(concluido);
          registrarResultadoReal(concluido, generationsRef.current);
        }
      } catch {
        // Servidor fora do ar ou ComfyUI indisponível: a tela abre normalmente.
      }
    })();

    return () => { cancelado = true; };
  }, [ready, comfy, acompanhar, registrarResultadoReal]);

  /** Geração real: envia os quadros e o prompt, e acompanha o job. */
  const gerarReal = async () => {
    if (!firstFrame) {
      toast('Envie o primeiro quadro — ele é obrigatório na geração real.', 'warn');
      return;
    }
    if (!prompt.trim()) {
      toast('Escreva o prompt de movimento.', 'warn');
      return;
    }

    pararPolling();
    setRealResultId(null);
    setBusy(true);

    try {
      const inicial = await comfy.submitVideoWithFrames(
        {
          prompt: prompt.trim(),
          projectId,
          aspect: realAspect,
          quality: realQuality,
          durationSeconds: realDuration,
          seed: seedLocked ? seed : '',
          seedLocked,
        },
        { first: firstFrame.file, last: lastFrame?.file || null },
      );
      setJob(inicial);
      if (!seedLocked && inicial.seed) setSeed(inicial.seed);
      toast(`Enviado ao ComfyUI — ${inicial.modeLabel || realKindLabel}.`, 'ok');
      pollRef.current = setTimeout(() => acompanhar(inicial.jobId), 1200);
    } catch (error) {
      setBusy(false);
      toast(error.message, 'error');
    }
  };

  const cancelarReal = async () => {
    if (!job?.jobId) return;
    pararPolling();
    try {
      const cancelado = await comfy.cancelJob(job.jobId);
      setJob(cancelado);
      setBusy(false);
      toast('Geração cancelada.', 'warn');
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  /** Lê o arquivo para pré-visualização, preservando o File original para o envio. */
  const receberQuadro = (file, setter) => {
    if (!file) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
      toast(`"${file.name}" não é PNG, JPEG nem WebP.`, 'warn');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setter({
      id: `${file.name}-${Date.now()}`,
      name: file.name,
      url: String(reader.result),
      file,
      bytes: file.size,
    });
    reader.readAsDataURL(file);
  };

  const resultadoReal = generations.find((g) => g.id === realResultId) || null;

  const aprovarReal = () => {
    if (!resultadoReal) return;
    updateGeneration(resultadoReal.id, { status: 'aprovado', revisionNote: '' });
    toast('Aprovado. “Adicionar à timeline” liberado.', 'ok');
  };

  const rejeitarReal = () => {
    if (!resultadoReal) return;
    updateGeneration(resultadoReal.id, { status: 'revisão' });
    toast('Marcado para revisão. O vídeo continua salvo na biblioteca.', 'warn');
  };

  const generate = async () => {
    if (mode === 'i2v' && !sourceImage) {
      toast('Envie a imagem inicial para o modo imagem → vídeo.', 'warn');
      return;
    }
    if (mode === 'r2v' && !references.length) {
      toast('Envie ao menos uma referência para o modo referência → vídeo.', 'warn');
      return;
    }
    if (mode === 't2v' && !prompt.trim()) {
      toast('Escreva o prompt de movimento.', 'warn');
      return;
    }

    const { provider, intended, simulated, reason } = resolveProvider(modelId);
    setBusy(true);
    try {
      const results = await provider.generateVideo({
        prompt: prompt.trim(), aspect, resolution, duration, fps, audio, seed, mode, modelId,
        intendedProviderId: intended.id,
        image: sourceImage?.url || null,
        references: references.map((r) => r.url),
      });
      addGenerations(results);
      toast(
        simulated
          ? `Pré-visualização simulada gerada. ${reason} Nenhum modelo foi executado.`
          : 'Geração concluída.',
        simulated ? 'warn' : 'ok',
      );
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const addToTimeline = (item) => {
    const permissao = canEnterTimeline(item);
    if (!permissao.ok) {
      toast(permissao.reason, 'warn');
      return;
    }
    const clip = clipFromGeneration(item, { index: 0 });
    setTimeline((current) => {
      const jaEsta = (current.video || []).some(
        (c) => c.resultId === item.id || (c.jobId && c.jobId === item.jobId),
      );
      if (jaEsta) return current;
      return { ...current, video: [...current.video, clip] };
    });
    toast('Clipe adicionado à trilha de vídeo da timeline.', 'ok');
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Panel className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold text-chalk">Compor vídeo</h2>
            <div className="flex items-center gap-1.5">
              <RuntimeBadge model={model} />
              <StatusBadge model={model} />
            </div>
          </div>

          {/* Motor: o real só aparece para modelos com execução conectada. */}
          {suportaReal ? (
            <Field label="Motor">
              <div className="grid gap-2">
                {[
                  {
                    id: 'real',
                    ativo: realMode,
                    titulo: 'MiniMax H3 no ComfyUI',
                    selo: 'real',
                    tom: 'ok',
                    icone: 'video',
                    texto: 'Gera o vídeo de verdade na sua GPU a partir de um quadro inicial. Custo US$ 0,00.',
                  },
                  {
                    id: 'simulado',
                    ativo: !realMode,
                    titulo: 'Demonstração',
                    selo: 'simulado',
                    tom: 'warn',
                    icone: 'spark',
                    texto: 'Pré-visualização desenhada localmente, sem tocar na GPU.',
                  },
                ].map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setRealMode(item.id === 'real')}
                    className={`pressable focus-ring flex items-start gap-2.5 rounded-lg border p-3 text-left ${
                      item.ativo ? 'border-gold/50 bg-gold/[0.07]' : 'border-hairline bg-panel-2 hover:border-white/20'
                    }`}
                  >
                    <span className={`mt-0.5 ${item.ativo ? 'text-gold' : 'text-mist'}`}>
                      <Icon name={item.icone} size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium text-chalk">{item.titulo}</span>
                        <Badge tone={item.tom}>{item.selo}</Badge>
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-mist">{item.texto}</span>
                    </span>
                  </button>
                ))}
              </div>
            </Field>
          ) : null}

          {!realMode ? (
            <Segmented
              className="w-full [&>button]:flex-1"
              options={MODES.filter((m) => !model?.modes || model.modes.includes(m.value))}
              value={mode}
              onChange={setMode}
            />
          ) : null}

          {/* Quadros da geração real ---------------------------------------- */}
          {realMode ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2">
                <QuadroField
                  label="Primeiro quadro"
                  obrigatorio
                  hint="PNG, JPEG ou WebP. É o quadro de onde o movimento parte."
                  valor={firstFrame}
                  inputRef={firstRef}
                  onEscolher={(file) => receberQuadro(file, setFirstFrame)}
                  onRemover={() => setFirstFrame(null)}
                />
                <QuadroField
                  label="Último quadro"
                  hint="Opcional. Com ele, o modelo interpola do primeiro até este."
                  valor={lastFrame}
                  inputRef={lastRef}
                  desabilitado={!firstFrame}
                  desabilitadoMotivo="Envie o primeiro quadro antes."
                  onEscolher={(file) => receberQuadro(file, setLastFrame)}
                  onRemover={() => setLastFrame(null)}
                />
              </div>

              <div
                className={`rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed ${
                  realKind ? 'border-ok/25 bg-ok/[0.06] text-ok/90' : 'border-hairline bg-panel-2 text-mist'
                }`}
              >
                {realKind ? (
                  <>
                    <span className="font-semibold">Modo: {realKindLabel}</span>
                    {realKind === 'i2v'
                      ? ' — o primeiro quadro define o ponto de partida e o prompt descreve o movimento.'
                      : ' — o modelo gera a transição entre os dois quadros seguindo o prompt.'}
                  </>
                ) : (
                  'Envie o primeiro quadro para definir o modo. Com um quadro: imagem → vídeo. Com dois: primeiro e último quadro.'
                )}
              </div>
            </>
          ) : null}

          {!realMode && mode === 'i2v' ? (
            <Field label="Imagem inicial">
              {sourceImage ? (
                <div className="relative overflow-hidden rounded-lg border border-hairline">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data: URL local */}
                  <img src={sourceImage.url} alt={sourceImage.name} className="h-32 w-full object-cover" />
                  <button
                    type="button"
                    aria-label="Remover imagem"
                    onClick={() => setSourceImage(null)}
                    className="absolute right-1.5 top-1.5 rounded bg-black/70 p-1 text-chalk"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => imageRef.current?.click()}
                  className="focus-ring flex h-24 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-hairline text-mist hover:border-gold/40 hover:text-chalk"
                >
                  <Icon name="upload" size={18} />
                  <span className="text-[11.5px]">Enviar imagem inicial</span>
                </button>
              )}
              <input
                ref={imageRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) readFile(file, setSourceImage);
                  e.target.value = '';
                }}
              />
            </Field>
          ) : null}

          {!realMode && mode === 'r2v' ? (
            <Field label="Referências visuais" hint="Personagem, cenário ou estilo a preservar.">
              <div className="flex flex-wrap gap-2">
                {references.map((ref) => (
                  <span key={ref.id} className="group relative h-16 w-16 overflow-hidden rounded-lg border border-hairline">
                    {/* eslint-disable-next-line @next/next/no-img-element -- data: URL local */}
                    <img src={ref.url} alt={ref.name} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      aria-label={`Remover ${ref.name}`}
                      onClick={() => setReferences((l) => l.filter((r) => r.id !== ref.id))}
                      className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 opacity-0 group-hover:opacity-100"
                    >
                      <Icon name="close" size={11} />
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => refRef.current?.click()}
                  className="focus-ring flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-hairline text-mist hover:border-gold/40 hover:text-chalk"
                >
                  <Icon name="upload" size={16} />
                  <span className="text-[9.5px]">Enviar</span>
                </button>
                <input
                  ref={refRef}
                  type="file"
                  accept="image/*"
                  multiple
                  hidden
                  onChange={(e) => {
                    Array.from(e.target.files || []).slice(0, 6).forEach((file) =>
                      readFile(file, (item) => setReferences((l) => [...l, item])),
                    );
                    e.target.value = '';
                  }}
                />
              </div>
            </Field>
          ) : null}

          <Field label="Prompt de movimento">
            <Textarea
              rows={4}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Como a câmera e o sujeito se movem? Ex.: travelling lateral lento, o sujeito atravessa o quadro da direita para a esquerda…"
            />
          </Field>

          <Field label="Modelo">
            <Select value={modelId} onChange={(event) => setModelId(event.target.value)}>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} — {item.runtime === 'local' ? 'Local' : 'API'}
                  {item.status === 'available' ? '' : ' (não configurado)'}
                </option>
              ))}
            </Select>
          </Field>

          {realMode ? (
            <>
              {/* Só o que o grafo aceita: FPS é fixo em 24 e o áudio sai sempre
                  do VAEDecodeAudio, então nenhum dos dois é oferecido. */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Duração" hint="Ajustada para a grade 17k+5 do modelo.">
                  <Select value={realDuration} onChange={(e) => setRealDuration(Number(e.target.value))}>
                    {REAL_DURACOES.map((d) => <option key={d} value={d}>{d}s</option>)}
                  </Select>
                </Field>
                <Field label="Resolução">
                  <Select value={realQuality} onChange={(e) => setRealQuality(e.target.value)}>
                    {REAL_QUALIDADES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
                  </Select>
                </Field>
                <Field label="Proporção">
                  <Select value={realAspect} onChange={(e) => setRealAspect(e.target.value)}>
                    {REAL_ASPECTOS.map((v) => <option key={v} value={v}>{v}</option>)}
                  </Select>
                </Field>
                <Field label="FPS" hint="O MiniMax H3 é nativo de 24 fps.">
                  <Input value={String(REAL_FPS)} disabled readOnly />
                </Field>
              </div>

              <div className="grid grid-cols-2 items-end gap-3">
                <Field label="Seed">
                  <div className="flex gap-1.5">
                    <Input
                      type="number"
                      value={seed}
                      onChange={(e) => setSeed(Number(e.target.value))}
                      disabled={!seedLocked}
                      className="flex-1"
                    />
                    <IconButton icon="dice" label="Nova seed" onClick={() => setSeed(randomSeed())} className="h-[38px] w-[38px]" />
                  </div>
                </Field>
                <div className="flex h-[38px] items-center justify-between rounded-lg border border-hairline bg-panel-2 px-3">
                  <span className="text-[12px] text-chalk">Travar seed</span>
                  <Toggle checked={seedLocked} onChange={setSeedLocked} label="Travar seed" />
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  variant="primary"
                  size="lg"
                  icon="video"
                  className="flex-1"
                  onClick={gerarReal}
                  disabled={busy || !firstFrame || !prompt.trim()}
                  title={!firstFrame ? 'Envie o primeiro quadro' : undefined}
                >
                  {busy ? 'Gerando…' : 'Gerar vídeo real'}
                </Button>
                {busy && job?.jobId ? (
                  <Button variant="danger" icon="close" onClick={cancelarReal}>Cancelar</Button>
                ) : null}
              </div>

              <p className="rounded-lg border border-ok/25 bg-ok/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-ok/90">
                Geração real na sua GPU pelo ComfyUI. As imagens são enviadas para a instância
                local, nenhum dado sai da máquina e o custo é US$ 0,00.
              </p>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Duração">
                  <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                    {inputEnum(model, 'duration').map((value) => (
                      <option key={value} value={value}>{value}s</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Resolução">
                  <Select value={resolution} onChange={(e) => setResolution(e.target.value)}>
                    {inputEnum(model, 'resolution').map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="FPS">
                  <Select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                    {inputEnum(model, 'fps').map((value) => (
                      <option key={value} value={value}>{value} fps</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Proporção">
                  <Select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                    {inputEnum(model, 'aspect_ratio').map((value) => (
                      <option key={value} value={value}>{value}</option>
                    ))}
                  </Select>
                </Field>
              </div>

              <div className="grid grid-cols-2 items-end gap-3">
                <Field label="Seed">
                  <div className="flex gap-1.5">
                    <Input type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} className="flex-1" />
                    <IconButton icon="dice" label="Nova seed" onClick={() => setSeed(randomSeed())} className="h-[38px] w-[38px]" />
                  </div>
                </Field>
                <div className="flex h-[38px] items-center justify-between rounded-lg border border-hairline bg-panel-2 px-3">
                  <span className="text-[12px] text-chalk">Áudio</span>
                  <Toggle checked={audio} onChange={setAudio} label="Gerar áudio" />
                </div>
              </div>

              <Button variant="primary" size="lg" icon="spark" className="w-full" onClick={generate} disabled={busy}>
                {busy ? 'Gerando pré-visualização…' : 'Gerar vídeo'}
              </Button>

              <SimulationNote>
                Motor de demonstração: nenhum modelo é executado e o ComfyUI não é acionado.
                O resultado é um <strong>clipe simulado</strong> para avaliar player, aprovação
                e timeline.
              </SimulationNote>
            </>
          )}
        </Panel>

        {/* Acompanhamento do job real ---------------------------------------- */}
        {realMode && job ? <JobPanel job={job} navigate={navigate} /> : null}
      </div>

      <div>
        {/* Resultado real: player do arquivo, aprovação e timeline ---------- */}
        {realMode && resultadoReal ? (
          <Panel className="mb-6 space-y-3 p-4">
            <SectionTitle
              title="Vídeo gerado"
              subtitle={`Arquivo real do MiniMax H3 nesta máquina · ${resultadoReal.modeLabel || 'imagem → vídeo'}.`}
              action={
                <Badge tone={resultadoReal.status === 'aprovado' ? 'ok' : resultadoReal.status === 'revisão' ? 'alert' : 'warn'}>
                  {resultadoReal.status}
                </Badge>
              }
            />

            <RealVideoPlayer src={resultadoReal.mediaUrl} aspect={resultadoReal.aspect} />

            <p className="font-mono text-[10.5px] leading-relaxed text-mist/70">
              seed {resultadoReal.seed} · {resultadoReal.duration}s · {resultadoReal.frames} frames ·{' '}
              {resultadoReal.resolution} · {resultadoReal.aspect} · {resultadoReal.fps} fps · US$ 0,00
              {resultadoReal.promptId ? <><br />prompt_id {resultadoReal.promptId}</> : null}
            </p>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                icon="download"
                onClick={() => {
                  const a = document.createElement('a');
                  a.href = resultadoReal.mediaUrl;
                  a.download = `${resultadoReal.jobId || resultadoReal.id}.mp4`;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                }}
              >
                Baixar
              </Button>
              <Button
                variant={resultadoReal.status === 'aprovado' ? 'ok' : 'primary'}
                icon="check"
                onClick={aprovarReal}
                disabled={resultadoReal.status === 'aprovado'}
              >
                {resultadoReal.status === 'aprovado' ? 'Aprovado' : 'Aprovar'}
              </Button>
              <Button variant="danger" icon="revise" onClick={rejeitarReal}>
                Rejeitar
              </Button>
              <Button
                variant="secondary"
                icon="timeline"
                onClick={() => addToTimeline(resultadoReal)}
                disabled={!canEnterTimeline(resultadoReal).ok}
                title={canEnterTimeline(resultadoReal).reason || 'Adicionar à timeline'}
              >
                Adicionar à timeline
              </Button>
            </div>

            {!canEnterTimeline(resultadoReal).ok ? (
              <p className="flex items-center gap-1.5 text-[11.5px] text-mist">
                <Icon name="revise" size={12} />
                {canEnterTimeline(resultadoReal).reason}
              </p>
            ) : null}
          </Panel>
        ) : null}

        <SectionTitle
          title="Resultados"
          subtitle={`${videos.length} ${videos.length === 1 ? 'clipe' : 'clipes'} nesta máquina`}
          action={
            <Button size="sm" variant="ghost" icon="timeline" onClick={() => navigate('storyboard', { view: 'timeline' })}>
              Abrir timeline
            </Button>
          }
        />

        {busy ? <div className="shimmer mb-4 aspect-video rounded-xl border border-hairline bg-panel/60" /> : null}

        <div className="grid gap-4 lg:grid-cols-2">
          {videos.map((item) => (
            <Panel key={item.id} className="fade-up overflow-hidden p-0">
              <VideoFrame item={item} aspect={item.aspect} className="rounded-none border-0 border-b border-hairline" />
              <div className="space-y-2.5 p-3.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="line-clamp-2 flex-1 text-[12px] leading-snug text-mist">
                    {truncate(item.prompt || 'Sem prompt', 110)}
                  </p>
                  <StatusPill status={item.status} />
                </div>
                <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10.5px] text-mist/70">
                  <span>{getModel(item.modelId)?.name || item.modelId}</span>
                  <span aria-hidden="true">·</span>
                  <span>{item.duration}s</span>
                  <span aria-hidden="true">·</span>
                  <span>{item.resolution}</span>
                  <span aria-hidden="true">·</span>
                  <span>{item.fps} fps</span>
                  <span aria-hidden="true">·</span>
                  <span>{item.audio ? 'com áudio' : 'sem áudio'}</span>
                  <span aria-hidden="true">·</span>
                  <span>{formatRelative(item.createdAt)}</span>
                </p>

                {item.revisionNote ? (
                  <p className="rounded-lg border border-danger/25 bg-danger/[0.07] px-2.5 py-1.5 text-[11.5px] leading-snug text-danger/90">
                    <span className="font-semibold">Alteração pedida: </span>
                    {item.revisionNote}
                  </p>
                ) : null}

                <ResultActions
                  item={item}
                  actions={['approve', 'revise', 'compare', 'addToTimeline']}
                  onCompare={setCompareWith}
                  onAddToTimeline={addToTimeline}
                />
              </div>
            </Panel>
          ))}
        </div>
      </div>

      <CompareModal base={compareWith} candidates={videos} onClose={() => setCompareWith(null)} />
    </div>
  );
}

/** Campo de envio de um quadro, com pré-visualização local. */
function QuadroField({
  label, hint, obrigatorio = false, valor, inputRef, onEscolher, onRemover,
  desabilitado = false, desabilitadoMotivo = '',
}) {
  return (
    <Field
      label={
        <>
          {label}
          {obrigatorio ? <span className="ml-1 text-danger">*</span> : <span className="ml-1 text-mist/60">(opcional)</span>}
        </>
      }
      hint={desabilitado ? desabilitadoMotivo : hint}
    >
      {valor ? (
        <div className="relative overflow-hidden rounded-lg border border-hairline">
          {/* eslint-disable-next-line @next/next/no-img-element -- data: URL local */}
          <img src={valor.url} alt={valor.name} className="h-28 w-full object-cover" />
          <button
            type="button"
            aria-label={`Remover ${label}`}
            onClick={onRemover}
            className="absolute right-1.5 top-1.5 rounded bg-black/70 p-1 text-chalk"
          >
            <Icon name="close" size={12} />
          </button>
          <p className="truncate border-t border-hairline bg-panel-2 px-2 py-1 font-mono text-[10px] text-mist">
            {valor.name} · {Math.round(valor.bytes / 1024)} KB
          </p>
        </div>
      ) : (
        <button
          type="button"
          disabled={desabilitado}
          onClick={() => inputRef.current?.click()}
          className="focus-ring flex h-28 w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-hairline text-mist hover:border-gold/40 hover:text-chalk disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-hairline"
        >
          <Icon name="upload" size={18} />
          <span className="text-[11.5px]">Enviar {label.toLowerCase()}</span>
          <span className="text-[10px] text-mist/60">PNG · JPEG · WebP</span>
        </button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={REAL_TIPOS_ACEITOS}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onEscolher(file);
          e.target.value = '';
        }}
      />
    </Field>
  );
}

/** Acompanhamento com os estados reais do ComfyUI. */
function JobPanel({ job, navigate }) {
  const indice = ORDEM_ESTADOS.indexOf(job.state);
  const falhou = job.state === 'falhou';
  const cancelado = job.state === 'cancelado';

  return (
    <Panel className="space-y-3 p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-[13px] font-semibold text-chalk">Acompanhamento</h3>
        <Badge tone={falhou ? 'alert' : cancelado ? 'neutral' : job.state === 'concluido' ? 'ok' : 'gold'}>
          {job.stateLabel}
        </Badge>
      </div>

      {job.modeLabel ? (
        <p className="text-[11.5px] text-mist">{job.modeLabel}</p>
      ) : null}

      {!falhou && !cancelado ? (
        <ol className="space-y-1">
          {ORDEM_ESTADOS.map((estado, i) => {
            const feito = indice > i;
            const atual = indice === i;
            return (
              <li
                key={estado}
                className={`flex items-center gap-2 text-[11.5px] ${
                  feito ? 'text-ok' : atual ? 'text-gold' : 'text-mist/45'
                }`}
              >
                <span className={atual ? 'pulse-soft' : ''}>
                  <Icon name={feito ? 'check' : 'arrow'} size={12} />
                </span>
                {rotuloEstado(estado)}
                {atual && job.queuePosition > 0 ? <span className="opacity-75">· posição {job.queuePosition}</span> : null}
              </li>
            );
          })}
        </ol>
      ) : null}

      {job.progress !== null && job.progress !== undefined && !falhou ? (
        <div>
          <div className="mb-1 flex justify-between text-[10.5px] text-mist">
            <span>Progresso</span>
            <span>{Math.round(job.progress * 100)}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-hairline">
            <div className="h-full rounded-full bg-gold transition-all duration-500" style={{ width: `${job.progress * 100}%` }} />
          </div>
        </div>
      ) : null}

      {job.error ? (
        <p className="rounded-lg border border-danger/30 bg-danger/[0.07] px-3 py-2 text-[11.5px] leading-relaxed text-danger/90">
          {job.error}
        </p>
      ) : null}

      {job.lastPollError && !job.error ? (
        <p className="text-[11px] leading-snug text-warn/90">
          Última consulta ao ComfyUI falhou: {job.lastPollError} A geração continua na GPU.
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-hairline pt-3 font-mono text-[10.5px]">
        <InfoJob termo="Tempo decorrido" valor={`${Math.round((job.elapsedMs || 0) / 1000)}s`} />
        <InfoJob termo="Modelo" valor={job.model || 'MiniMax H3'} />
        <InfoJob termo="prompt_id" valor={job.promptId ? `${job.promptId.slice(0, 18)}…` : '—'} title={job.promptId} />
        <InfoJob termo="Seed" valor={String(job.seed ?? '—')} />
        <InfoJob termo="Duração" valor={job.durationActual ? `${job.durationActual}s · ${job.frames} frames` : '—'} />
        <InfoJob termo="Resolução" valor={job.quality ? `${job.quality} · ${job.aspect}` : '—'} />
        <InfoJob termo="Primeiro quadro" valor={job.frameFirst || '—'} title={job.frameFirst} />
        <InfoJob termo="Último quadro" valor={job.frameLast || '—'} title={job.frameLast} />
      </dl>

      {job.withinTrainedRange === false ? (
        <p className="text-[11px] leading-snug text-warn/90">
          {job.frames} frames está fora da faixa treinada (124–362). O resultado pode degradar.
        </p>
      ) : null}

      <Button
        size="sm"
        variant="ghost"
        icon="logs"
        className="w-full"
        onClick={() => navigate('logs', { jobId: job.jobId })}
      >
        Ver logs desta geração
      </Button>
    </Panel>
  );
}

function InfoJob({ termo, valor, title }) {
  return (
    <div className="min-w-0" title={title}>
      <dt className="text-[9.5px] uppercase tracking-wider text-mist/70">{termo}</dt>
      <dd className="truncate text-chalk">{valor}</dd>
    </div>
  );
}

function rotuloEstado(estado) {
  return {
    preparando: 'Preparando',
    enviado: 'Enviado ao ComfyUI',
    'na-fila': 'Na fila',
    gerando: 'Gerando',
    decodificando: 'Decodificando',
    salvando: 'Salvando',
    concluido: 'Concluído',
  }[estado] || estado;
}

function CompareModal({ base, candidates, onClose }) {
  const others = candidates.filter((item) => item.id !== base?.id);
  const [otherId, setOtherId] = useState(null);
  const other = others.find((item) => item.id === otherId) || others[0] || null;

  return (
    <Modal
      open={Boolean(base)}
      title="Comparar clipes"
      subtitle="Reproduza os dois lado a lado antes de aprovar."
      onClose={onClose}
      wide
    >
      {base ? (
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <p className="mb-2 flex items-center gap-2 text-[12px] font-medium text-chalk">
                <Badge tone="gold">A</Badge> {truncate(base.prompt, 44)}
              </p>
              <VideoFrame item={base} aspect={base.aspect} compact />
            </div>
            <div>
              <p className="mb-2 flex items-center gap-2 text-[12px] font-medium text-chalk">
                <Badge tone="accent">B</Badge>
                {other ? truncate(other.prompt, 44) : 'Nenhum outro clipe ainda'}
              </p>
              {other ? (
                <VideoFrame item={other} aspect={other.aspect} compact />
              ) : (
                <ImageFrame aspect="16:9" />
              )}
            </div>
          </div>

          {others.length > 1 ? (
            <Field label="Comparar com">
              <Select value={other?.id || ''} onChange={(event) => setOtherId(event.target.value)}>
                {others.map((item) => (
                  <option key={item.id} value={item.id}>{truncate(item.prompt, 60)}</option>
                ))}
              </Select>
            </Field>
          ) : null}
        </div>
      ) : null}
    </Modal>
  );
}
