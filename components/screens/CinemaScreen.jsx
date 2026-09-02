'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../StudioContext';
import {
  Badge, Button, Field, IconButton, Input, Panel, SectionTitle, Select,
  SimulationNote, Textarea, Toggle,
} from '../ui/primitives';
import { Modal, ConfirmFooter } from '../ui/Modal';
import { RealVideoPlayer } from '../ui/RealVideoPlayer';
import { VideoFrame } from '../ui/MediaFrame';
import { Icon } from '../ui/icons';
import { CINEMA_CONTROLS, CINEMA_DEFAULTS, buildCinematicPrompt } from '@/lib/cinema';
import { CINEMA_ENGINES, cinemaEngine } from '@/lib/models';
import { canAddToTimeline, timelineBlockReason } from '@/lib/approval';
import { clipFromGeneration } from '@/lib/timelineAssets';
import { makeId, randomSeed } from '@/lib/rng';
import { truncate } from '@/lib/format';

const QUALIDADES = [
  { value: '480p', label: '480p — rápido (0,4 MP)' },
  { value: '720p', label: '720p (0,9 MP)' },
  { value: '1080p', label: '1080p (2,1 MP)' },
];

const DURACOES = [5.2, 6, 7, 8, 10, 12, 15];
const ASPECTOS = ['16:9', '21:9', '9:16', '1:1', '4:3'];

const ORDEM_ESTADOS = ['preparando', 'enviado', 'na-fila', 'gerando', 'decodificando', 'salvando', 'concluido'];

export default function CinemaScreen({ navigate }) {
  const {
    cinema, setCinema, toast, registry, addGenerations, updateGeneration,
    generations, setTimeline, activeProjectId, ready, cinemaJobId, setCinemaJobId,
  } = useStudio();
  const { scene, controls, prompt, manual } = cinema;

  const [engineId, setEngineId] = useState('comfyui');
  const [aspect, setAspect] = useState('16:9');
  const [quality, setQuality] = useState('480p');
  const [duration, setDuration] = useState(5.2);
  const [seed, setSeed] = useState(() => randomSeed());
  const [seedLocked, setSeedLocked] = useState(false);

  const [job, setJob] = useState(null);
  const [busy, setBusy] = useState(false);
  const [resultId, setResultId] = useState(null);
  const [reviseOpen, setReviseOpen] = useState(false);
  const [note, setNote] = useState('');

  const pollRef = useRef(null);
  // Espelho da lista para consultar dentro do laço sem recriar o callback.
  const generationsRef = useRef(generations);
  generationsRef.current = generations;
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const adotouRef = useRef(false);
  const engine = cinemaEngine(engineId);
  const provider = registry.get('comfyui');
  const projectId = useMemo(() => sanitizeProjectId(activeProjectId), [activeProjectId]);

  const derived = useMemo(() => buildCinematicPrompt(scene, controls), [scene, controls]);
  const resultado = generations.find((g) => g.id === resultId) || null;

  useEffect(() => {
    if (manual) return;
    setCinema((current) => ({ ...current, prompt: derived }));
  }, [derived, manual, setCinema]);

  const setControl = (key, value) => {
    setCinema((current) => ({ ...current, controls: { ...current.controls, [key]: value } }));
  };


  const pararPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  useEffect(() => pararPolling, [pararPolling]);

  /**
   * Guarda o vídeo real na biblioteca, ainda pendente de aprovação.
   * Idempotente: se o job já foi adotado antes, reaproveita o item existente em
   * vez de duplicá-lo (importa ao retomar depois de recarregar a página).
   */
  const registrarResultado = useCallback((jobFinal, listaAtual) => {
    const jaExiste = (listaAtual || []).find((g) => g.jobId === jobFinal.jobId);
    if (jaExiste) {
      setResultId(jaExiste.id);
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
      // Título humano: a descrição da cena, não o começo do prompt técnico.
      scene: sceneRef.current || '',
      mediaUrl: jobFinal.result.url,
      costUsd: 0,
      mode: 't2v',
      status: 'pendente',
      revisionNote: '',
      createdAt: Date.now(),
    };
    addGenerations([item]);
    setResultId(item.id);
    return item;
  }, [addGenerations]);

  /** Ciclo de acompanhamento: status → (quando pronto) resultado. */
  const acompanhar = useCallback(async (jobId, tentativasComErro = 0) => {
    try {
      const atual = await provider.pollJob(jobId);
      setJob(atual);

      // O servidor finaliza sozinho; este ramo é a rede de segurança caso a
      // cópia tenha ficado pendente por um erro transitório.
      const final = atual.readyToFinalize ? await provider.finalizeJob(jobId) : atual;
      if (atual.readyToFinalize) setJob(final);

      if (final.result?.url) {
        registrarResultado(final, generationsRef.current);
        setCinemaJobId(null);
        setBusy(false);
        toast('Vídeo gerado e salvo. Aprove antes de adicionar à timeline.', 'ok');
        return;
      }

      if (final.terminal) {
        setBusy(false);
        setCinemaJobId(null);
        if (final.state === 'falhou') toast(final.error || 'A geração falhou.', 'error');
        if (final.state === 'cancelado') toast('Geração cancelada.', 'warn');
        return;
      }

      pollRef.current = setTimeout(() => acompanhar(jobId, 0), 1500);
    } catch (error) {
      // Uma falha de rede não pode abandonar um job que segue rodando na GPU:
      // insistimos com espera crescente antes de desistir.
      if (tentativasComErro < 5) {
        const espera = 2000 * (tentativasComErro + 1);
        pollRef.current = setTimeout(() => acompanhar(jobId, tentativasComErro + 1), espera);
        return;
      }
      setBusy(false);
      toast(`${error.message} — o job segue no ComfyUI e pode ser recuperado.`, 'error');
    }
  }, [provider, registrarResultado, setCinemaJobId, toast]);

  /**
   * Ao abrir a aba, pergunta ao servidor o que existe.
   *
   * Isso cobre três casos que antes perdiam o vídeo: sair da aba durante a
   * geração, recarregar a página e reiniciar o servidor. Com `recover`, o
   * servidor também adota resultados que ficaram só no ComfyUI — sem regerar.
   */
  useEffect(() => {
    if (!ready || adotouRef.current) return;
    adotouRef.current = true;

    let cancelado = false;
    (async () => {
      try {
        // Sem filtro de projeto: uma geração feita sem projeto ativo fica em
        // "avulso" e, filtrando, sumia da tela — a aba mostrava um resultado
        // antigo em vez do mais recente.
        const { jobs, recovered } = await provider.listJobs({ recover: true });
        if (cancelado) return;

        const concluidos = (jobs || []).filter((j) => j.result?.url);
        if (concluidos.length) {
          const maisRecente = concluidos[0];
          const item = registrarResultado(maisRecente, generationsRef.current);
          setJob(maisRecente);
          if (recovered?.length && item) {
            toast(`Resultado recuperado do ComfyUI: ${recovered.length} vídeo(s).`, 'ok');
          }
        }

        // Job ainda em andamento de uma sessão anterior: retoma o acompanhamento.
        const emAndamento = (jobs || []).find((j) => !j.terminal && !j.result);
        const alvo = emAndamento?.jobId || cinemaJobId;
        if (alvo && !concluidos.some((j) => j.jobId === alvo)) {
          setBusy(true);
          acompanhar(alvo);
        }
      } catch {
        // Servidor fora do ar ou ComfyUI indisponível: a tela abre normalmente.
      }
    })();

    return () => { cancelado = true; };
  }, [ready, provider, projectId, cinemaJobId, registrarResultado, acompanhar, toast]);

  const gerar = async () => {
    if (!prompt.trim()) {
      toast('Monte o prompt de direção antes de gerar.', 'warn');
      return;
    }

    pararPolling();
    setResultId(null);
    setBusy(true);

    // Motor de demonstração: caminho simulado, sem tocar na GPU.
    if (engine.kind === 'simulated') {
      try {
        const mock = registry.get('mock');
        const [item] = await mock.generateVideo({
          prompt: prompt.trim(), aspect, resolution: quality, duration,
          fps: 24, seed: seedLocked ? seed : randomSeed(), mode: 't2v', modelId: 'minimax-h3',
          intendedProviderId: 'mock',
        });
        addGenerations([item]);
        setResultId(item.id);
        setJob(null);
        toast('Pré-visualização simulada gerada (motor de demonstração).', 'warn');
      } catch (error) {
        toast(error.message, 'error');
      } finally {
        setBusy(false);
      }
      return;
    }

    try {
      const inicial = await provider.submitVideo({
        prompt: prompt.trim(),
        seed: seedLocked ? seed : null,
        seedLocked,
        durationSeconds: duration,
        aspect,
        quality,
        projectId,
      });
      setJob(inicial);
      setCinemaJobId(inicial.jobId);
      if (!seedLocked && inicial.seed) setSeed(inicial.seed);
      toast(`Enviado ao ComfyUI — prompt_id ${truncate(inicial.promptId || '', 12)}`, 'ok');
      pollRef.current = setTimeout(() => acompanhar(inicial.jobId), 1200);
    } catch (error) {
      setBusy(false);
      toast(error.message, 'error');
    }
  };

  const cancelar = async () => {
    if (!job?.jobId) return;
    pararPolling();
    try {
      const cancelado = await provider.cancelJob(job.jobId);
      setJob(cancelado);
      setCinemaJobId(null);
      setBusy(false);
      toast('Geração cancelada.', 'warn');
    } catch (error) {
      toast(error.message, 'error');
    }
  };

  const aprovar = () => {
    if (!resultado) return;
    updateGeneration(resultado.id, { status: 'aprovado', revisionNote: '' });
    toast('Aprovado. “Adicionar à timeline” liberado.', 'ok');
  };

  const pedirAlteracao = () => {
    if (!resultado) return;
    // O vídeo anterior é preservado: só muda o estado e anexa a nota.
    updateGeneration(resultado.id, { status: 'revisão', revisionNote: note });
    setReviseOpen(false);
    setNote('');
    toast('Alteração registrada. O vídeo anterior foi preservado na biblioteca.', 'warn');
  };

  const adicionarNaTimeline = () => {
    if (!canAddToTimeline(resultado)) {
      toast(timelineBlockReason(resultado), 'warn');
      return;
    }
    // O clipe carrega a identidade completa do asset: é isso que permite
    // deduplicar, extrair a miniatura e reproduzir o arquivo certo na timeline.
    const clip = clipFromGeneration(resultado, { index: 0 });
    if (!clip) {
      toast('Este resultado não tem arquivo de vídeo para montar.', 'warn');
      return;
    }

    setTimeline((current) => {
      const jaEsta = (current.video || []).some(
        (c) => c.resultId === resultado.id || (c.jobId && c.jobId === resultado.jobId),
      );
      if (jaEsta) return current;
      return { ...current, video: [...current.video, clip] };
    });
    toast('Clipe aprovado adicionado à trilha de vídeo.', 'ok');
  };

  const activeCount = Object.values(controls).filter(Boolean).length;
  const emAndamento = busy || (job && !job.terminal);

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,440px)]">
      {/* Controles ----------------------------------------------------------- */}
      <div className="space-y-6">
        <Panel className="space-y-4 p-4">
          <SectionTitle
            title="Direção de câmera"
            subtitle="Cada escolha entra no prompt como uma instrução de direção."
            action={<Badge tone={activeCount ? 'gold' : 'neutral'}>{activeCount} de {CINEMA_CONTROLS.length}</Badge>}
          />

          <Field label="Descrição da cena">
            <Textarea
              rows={3}
              value={scene}
              onChange={(event) => setCinema((current) => ({ ...current, scene: event.target.value }))}
              placeholder="O que acontece no plano? Ex.: uma detetive atravessa o corredor alagado segurando um rádio…"
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {CINEMA_CONTROLS.map((control) => (
              <Field key={control.key} label={control.label}>
                <Select
                  value={controls[control.key] || ''}
                  onChange={(event) => setControl(control.key, event.target.value)}
                  className={controls[control.key] ? 'border-gold/40' : ''}
                >
                  {control.options.map((option) => (
                    <option key={option.value || 'none'} value={option.value}>{option.label}</option>
                  ))}
                </Select>
              </Field>
            ))}
          </div>

          <Button
            variant="ghost"
            icon="revise"
            onClick={() => setCinema((current) => ({ ...current, controls: { ...CINEMA_DEFAULTS }, manual: false }))}
          >
            Limpar controles
          </Button>
        </Panel>

        {/* Resultado ---------------------------------------------------------- */}
        {resultado ? (
          <Panel className="space-y-3 p-4">
            <SectionTitle
              title="Resultado"
              subtitle={resultado.real ? 'Vídeo real gerado pelo MiniMax H3 nesta máquina.' : 'Pré-visualização simulada.'}
              action={
                <Badge tone={resultado.status === 'aprovado' ? 'ok' : resultado.status === 'revisão' ? 'alert' : 'warn'}>
                  {resultado.status}
                </Badge>
              }
            />

            {resultado.real ? (
              <RealVideoPlayer src={resultado.mediaUrl} aspect={resultado.aspect} />
            ) : (
              <VideoFrame item={resultado} aspect={resultado.aspect} />
            )}

            {/* Proveniência visível: o prompt que produziu este vídeo, mesmo que
                os controles tenham sido limpos ou o resultado recuperado. */}
            {resultado.prompt ? (
              <details className="rounded-lg border border-hairline bg-panel-2 px-3 py-2">
                <summary className="cursor-pointer text-[11.5px] font-medium text-mist hover:text-chalk">
                  Prompt usado nesta geração
                </summary>
                <p className="mt-2 whitespace-pre-wrap font-mono text-[11.5px] leading-relaxed text-mist">
                  {resultado.prompt}
                </p>
                <p className="mt-2 border-t border-hairline pt-2 font-mono text-[10.5px] text-mist/70">
                  seed {resultado.seed} · {resultado.duration}s · {resultado.frames} frames ·{' '}
                  {resultado.resolution} · {resultado.aspect} · {resultado.fps} fps · US$ 0,00
                  {resultado.promptId ? <><br />prompt_id {resultado.promptId}</> : null}
                </p>
              </details>
            ) : null}

            {resultado.revisionNote ? (
              <p className="rounded-lg border border-danger/25 bg-danger/[0.07] px-3 py-2 text-[12px] leading-relaxed text-danger/90">
                <span className="font-semibold">Alteração pedida: </span>{resultado.revisionNote}
                <span className="mt-1 block text-[11px] opacity-80">
                  O vídeo acima continua salvo na biblioteca. Ajuste o prompt ou a seed e gere novamente.
                </span>
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              {resultado.real ? (
                <Button
                  variant="secondary"
                  icon="download"
                  onClick={() => {
                    const a = document.createElement('a');
                    a.href = resultado.mediaUrl;
                    a.download = `${resultado.jobId || resultado.id}.mp4`;
                    document.body.appendChild(a);
                    a.click();
                    a.remove();
                  }}
                >
                  Baixar
                </Button>
              ) : null}

              <Button
                variant={resultado.status === 'aprovado' ? 'ok' : 'primary'}
                icon="check"
                onClick={aprovar}
                disabled={resultado.status === 'aprovado'}
              >
                {resultado.status === 'aprovado' ? 'Aprovado' : 'Aprovar'}
              </Button>

              <Button variant="secondary" icon="revise" onClick={() => { setNote(resultado.revisionNote || ''); setReviseOpen(true); }}>
                Pedir alteração
              </Button>

              <Button variant="secondary" icon="spark" onClick={gerar} disabled={emAndamento}>
                Gerar novamente
              </Button>

              <Button
                variant="secondary"
                icon="timeline"
                onClick={adicionarNaTimeline}
                disabled={!canAddToTimeline(resultado)}
                title={timelineBlockReason(resultado) || 'Adicionar à timeline'}
              >
                Adicionar à timeline
              </Button>
            </div>

            {!canAddToTimeline(resultado) ? (
              <p className="flex items-center gap-1.5 text-[11.5px] text-mist">
                <Icon name="revise" size={12} />
                {timelineBlockReason(resultado)}
              </p>
            ) : (
              <Button size="sm" variant="ghost" icon="arrow" onClick={() => navigate('storyboard', { view: 'timeline' })}>
                Abrir a timeline
              </Button>
            )}
          </Panel>
        ) : null}
      </div>

      {/* Prompt + produção ---------------------------------------------------- */}
      <div className="space-y-4">
        <Panel className="space-y-3 p-4">
          <SectionTitle
            title="Prompt de direção"
            subtitle={manual ? 'Editado à mão — os controles não sobrescrevem mais.' : 'Montado automaticamente pelos controles.'}
          />
          <Textarea
            rows={7}
            value={prompt}
            onChange={(event) => setCinema((current) => ({ ...current, prompt: event.target.value, manual: true }))}
            placeholder="O prompt aparece aqui conforme você escolhe os controles. Você pode editá-lo livremente."
            className="font-mono text-[12.5px] leading-relaxed"
          />
          <div className="flex flex-wrap gap-2">
            {manual ? (
              <Button size="sm" variant="ghost" icon="revise" onClick={() => setCinema((c) => ({ ...c, manual: false, prompt: derived }))}>
                Voltar ao automático
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" icon="imagem" onClick={() => navigate('imagem', { prompt, aspect })}>
              Usar na imagem
            </Button>
          </div>
        </Panel>

        <Panel className="space-y-4 p-4">
          <SectionTitle title="Produção" subtitle="Escolha o motor e os parâmetros do plano." />

          <Field label="Motor">
            <div className="grid gap-2">
              {CINEMA_ENGINES.map((item) => {
                const ativo = item.id === engineId;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setEngineId(item.id)}
                    className={`pressable focus-ring flex items-start gap-2.5 rounded-lg border p-3 text-left ${
                      ativo ? 'border-gold/50 bg-gold/[0.07]' : 'border-hairline bg-panel-2 hover:border-white/20'
                    }`}
                  >
                    <span className={`mt-0.5 ${ativo ? 'text-gold' : 'text-mist'}`}>
                      <Icon name={item.kind === 'real' ? 'video' : 'spark'} size={16} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-medium text-chalk">{item.label}</span>
                        <Badge tone="neutral">{item.sublabel}</Badge>
                        <Badge tone={item.kind === 'real' ? 'ok' : 'warn'}>{item.kindLabel}</Badge>
                      </span>
                      <span className="mt-0.5 block text-[11.5px] leading-snug text-mist">{item.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Proporção">
              <Select value={aspect} onChange={(e) => setAspect(e.target.value)}>
                {ASPECTOS.map((v) => <option key={v} value={v}>{v}</option>)}
              </Select>
            </Field>
            <Field label="Resolução">
              <Select value={quality} onChange={(e) => setQuality(e.target.value)}>
                {QUALIDADES.map((q) => <option key={q.value} value={q.value}>{q.label}</option>)}
              </Select>
            </Field>
            <Field label="Duração" hint="Ajustada para a grade 17k+5 do modelo.">
              <Select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                {DURACOES.map((d) => <option key={d} value={d}>{d}s</option>)}
              </Select>
            </Field>
            <Field label="FPS" hint="O MiniMax H3 é nativo de 24 fps.">
              <Input value="24" disabled readOnly />
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

          {!seedLocked ? (
            <p className="text-[11px] text-mist">Sem travar, cada geração usa uma seed aleatória nova.</p>
          ) : null}

          <div className="flex gap-2">
            <Button variant="primary" size="lg" icon="video" className="flex-1" onClick={gerar} disabled={emAndamento}>
              {emAndamento ? 'Gerando…' : engine.kind === 'real' ? 'Gerar vídeo real' : 'Gerar simulação'}
            </Button>
            {emAndamento && job?.jobId ? (
              <Button variant="danger" icon="close" onClick={cancelar}>Cancelar</Button>
            ) : null}
          </div>

          {engine.kind === 'real' ? (
            <p className="rounded-lg border border-ok/25 bg-ok/[0.06] px-3 py-2 text-[11.5px] leading-relaxed text-ok/90">
              Geração real na sua GPU pelo ComfyUI. Nenhum dado sai da máquina e o custo é US$ 0,00.
            </p>
          ) : (
            <SimulationNote>Motor de demonstração: nada é executado na GPU.</SimulationNote>
          )}
        </Panel>

        {job ? <JobPanel job={job} navigate={navigate} /> : null}
      </div>

      <Modal
        open={reviseOpen}
        title="Pedir alteração"
        subtitle="O vídeo atual é preservado. Ajuste prompt ou seed e gere novamente."
        onClose={() => setReviseOpen(false)}
        footer={
          <ConfirmFooter
            onCancel={() => setReviseOpen(false)}
            onConfirm={pedirAlteracao}
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
          placeholder="O que precisa mudar? Ex.: mais movimento de câmera, luz mais fria, menos névoa…"
        />
      </Modal>
    </div>
  );
}

/** Painel de acompanhamento com os estados reais do ComfyUI. */
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

      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-hairline pt-3 font-mono text-[10.5px]">
        <Info termo="Tempo decorrido" valor={`${Math.round((job.elapsedMs || 0) / 1000)}s`} />
        <Info termo="Modelo" valor={job.model || 'MiniMax H3'} />
        <Info termo="prompt_id" valor={job.promptId ? `${job.promptId.slice(0, 18)}…` : '—'} title={job.promptId} />
        <Info termo="Seed" valor={String(job.seed ?? '—')} />
        <Info termo="Duração" valor={job.durationActual ? `${job.durationActual}s · ${job.frames} frames` : '—'} />
        <Info termo="Resolução" valor={job.quality ? `${job.quality} · ${job.aspect}` : '—'} />
        <Info termo="FPS" valor={String(job.fps ?? 24)} />
        <Info termo="Custo local" valor="US$ 0,00" />
      </dl>

      {job.withinTrainedRange === false ? (
        <p className="text-[11px] leading-snug text-warn/90">
          {job.frames} frames está fora da faixa treinada (124–362). O resultado pode degradar.
        </p>
      ) : null}

      {/* Falha transitória do polling: o job segue vivo no ComfyUI, então é
          aviso, não erro — mas precisa aparecer em algum lugar. */}
      {job.lastPollError && !job.error ? (
        <p className="text-[11px] leading-snug text-warn/90">
          Última consulta ao ComfyUI falhou: {job.lastPollError} A geração continua na GPU.
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

function Info({ termo, valor, title }) {
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

/** O projeto ativo vira um identificador seguro para o caminho de armazenamento. */
function sanitizeProjectId(id) {
  const limpo = String(id || 'avulso').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return limpo || 'avulso';
}
