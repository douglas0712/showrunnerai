'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudio } from '../StudioContext';
import { Badge, Button, Field, Panel, Select } from '../ui/primitives';
import { Modal } from '../ui/Modal';
import { RealVideoPlayer } from '../ui/RealVideoPlayer';
import { Icon } from '../ui/icons';
import {
  cancelExport as apiCancel, formatBytes, listExports, pollExport, startExport,
} from '@/lib/exportClient';
import { formatPreciseDuration } from '@/lib/format';
import { isRealClip } from '@/lib/timelineAssets';

const PRESETS = [
  { id: 'source-864x480-24', label: 'Original — 864×480 · 24 fps' },
  { id: '720p-24', label: '720p — 1280×720 · 24 fps' },
  { id: '1080p-24', label: '1080p — 1920×1080 · 24 fps' },
];

const ORDEM = ['preparando', 'resolvendo-cenas', 'codificando', 'finalizando', 'concluido'];
const ROTULOS = {
  preparando: 'Preparando',
  'resolvendo-cenas': 'Resolvendo cenas',
  codificando: 'Codificando',
  finalizando: 'Finalizando',
  concluido: 'Concluído',
};

/**
 * Exportação real da montagem.
 *
 * O trabalho roda no servidor: trocar de aba ou recarregar a página não
 * interrompe nada, e ao reabrir o modal o acompanhamento é retomado.
 */
export default function ExportModal({ open, onClose, navigate }) {
  const {
    timeline, generations, activeProjectId, toast, addGenerations,
    exportJobId, setExportJobId,
  } = useStudio();

  const [presetId, setPresetId] = useState('source-864x480-24');
  const [job, setJob] = useState(null);
  const [ffmpeg, setFfmpeg] = useState(null);
  const [erro, setErro] = useState(null);
  const [iniciando, setIniciando] = useState(false);
  const pollRef = useRef(null);
  const registradoRef = useRef(new Set());

  const projectId = sanitize(activeProjectId);
  const porId = new Map(generations.map((g) => [g.id, g]));

  // Cenas na ordem da timeline, com o estado de aprovação da biblioteca.
  const cenas = (timeline.video || []).map((clip, indice) => {
    const item = clip.resultId ? porId.get(clip.resultId) : null;
    const status = item?.status || (isRealClip(clip) ? 'pendente' : 'demonstração');
    return {
      ...clip,
      posicao: indice + 1,
      status,
      approved: status === 'aprovado',
      real: isRealClip(clip),
    };
  });

  const pendentes = cenas.filter((c) => !c.approved);
  const naoReais = cenas.filter((c) => !c.real);
  const duracaoPrevista = Number(cenas.reduce((s, c) => s + (Number(c.duration) || 0), 0).toFixed(3));
  const podeExportar = cenas.length > 0 && pendentes.length === 0 && naoReais.length === 0;

  const pararPolling = useCallback(() => {
    if (pollRef.current) {
      clearTimeout(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  /** Registra a montagem final na biblioteca, uma única vez. */
  const registrarNaBiblioteca = useCallback((finalizado) => {
    if (!finalizado?.result?.url) return;
    if (registradoRef.current.has(finalizado.exportId)) return;
    registradoRef.current.add(finalizado.exportId);

    addGenerations([{
      id: `exp_${finalizado.exportId}`,
      kind: 'video',
      real: true,
      isExport: true,
      providerId: 'ffmpeg',
      modelId: null,
      prompt: `Montagem final — ${finalizado.scenes.length} cena(s)`,
      aspect: '16:9',
      resolution: `${finalizado.result.width}×${finalizado.result.height}`,
      duration: finalizado.result.duration,
      fps: finalizado.result.fps,
      mediaUrl: finalizado.result.url,
      sha256: finalizado.result.sha256,
      bytes: finalizado.result.bytes,
      costUsd: 0,
      status: 'aprovado',
      revisionNote: '',
      createdAt: Date.now(),
    }]);
  }, [addGenerations]);

  const acompanhar = useCallback(async (exportId, falhas = 0) => {
    try {
      const atual = await pollExport(exportId);
      setJob(atual);

      if (atual.terminal) {
        setExportJobId(null);
        if (atual.state === 'concluido') {
          registrarNaBiblioteca(atual);
          toast('Exportação concluída.', 'ok');
        }
        if (atual.state === 'falhou') setErro(atual.error);
        if (atual.state === 'cancelado') toast('Exportação cancelada.', 'warn');
        return;
      }

      pollRef.current = setTimeout(() => acompanhar(exportId, 0), 900);
    } catch (e) {
      // Falha de rede não abandona um FFmpeg que segue rodando no servidor.
      if (falhas < 5) {
        pollRef.current = setTimeout(() => acompanhar(exportId, falhas + 1), 1500 * (falhas + 1));
        return;
      }
      setErro(e.message);
    }
  }, [registrarNaBiblioteca, setExportJobId, toast]);

  // Ao abrir: checa o FFmpeg e retoma uma exportação em andamento.
  useEffect(() => {
    if (!open) return undefined;
    let cancelado = false;

    (async () => {
      try {
        const { exports, ffmpeg: info } = await listExports(projectId);
        if (cancelado) return;
        setFfmpeg(info);

        const emAndamento = exports.find((e) => !e.terminal);
        const alvo = emAndamento?.exportId || exportJobId;
        if (alvo) {
          acompanhar(alvo);
          return;
        }
        const ultimaConcluida = exports.find((e) => e.state === 'concluido');
        if (ultimaConcluida) setJob(ultimaConcluida);
      } catch {
        if (!cancelado) setFfmpeg({ ok: false, version: null });
      }
    })();

    return () => { cancelado = true; };
  }, [open, projectId, exportJobId, acompanhar]);

  useEffect(() => pararPolling, [pararPolling]);

  const exportar = async () => {
    setErro(null);
    setIniciando(true);
    try {
      const inicial = await startExport({ projectId, clips: cenas, presetId });
      setJob(inicial);
      setExportJobId(inicial.exportId);
      toast('Exportação iniciada no servidor.', 'ok');
      pollRef.current = setTimeout(() => acompanhar(inicial.exportId), 700);
    } catch (e) {
      setErro(
        e.pending?.length
          ? `${e.message} ${e.pending.map((p) => `#${p.posicao} ${p.titulo}`).join(', ')}`
          : e.message,
      );
    } finally {
      setIniciando(false);
    }
  };

  const cancelar = async () => {
    if (!job?.exportId) return;
    pararPolling();
    try {
      const cancelado = await apiCancel(job.exportId);
      setJob(cancelado);
      setExportJobId(null);
    } catch (e) {
      setErro(e.message);
    }
  };

  const emAndamento = Boolean(job && !job.terminal);
  const concluida = job?.state === 'concluido' && job.result;

  return (
    <Modal
      open={open}
      title="Exportar vídeo final"
      subtitle="Concatena as cenas aprovadas em um único MP4, aqui nesta máquina."
      onClose={onClose}
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Fechar</Button>
          {emAndamento ? (
            <Button variant="danger" icon="close" onClick={cancelar}>Cancelar</Button>
          ) : (
            <Button
              variant="primary"
              icon="export"
              onClick={exportar}
              disabled={!podeExportar || iniciando || ffmpeg?.ok === false}
            >
              {iniciando ? 'Iniciando…' : concluida ? 'Exportar de novo' : 'Exportar agora'}
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        {/* Bloqueios ------------------------------------------------------- */}
        {ffmpeg?.ok === false ? (
          <Aviso tom="alert">
            O FFmpeg não está disponível nesta máquina. A exportação real depende dele.
          </Aviso>
        ) : null}

        {!cenas.length ? (
          <Aviso tom="alert">A timeline está vazia — não há o que exportar.</Aviso>
        ) : null}

        {naoReais.length ? (
          <Aviso tom="alert">
            {naoReais.length} clipe(s) de demonstração na montagem não têm arquivo e impedem a
            exportação: {naoReais.map((c) => `#${c.posicao} ${c.label}`).join(', ')}.
          </Aviso>
        ) : null}

        {pendentes.length ? (
          <Aviso tom="warn">
            <strong>Exportação bloqueada.</strong> Aprove antes:{' '}
            {pendentes.map((c) => `#${c.posicao} ${c.label} (${c.status})`).join(' · ')}
          </Aviso>
        ) : null}

        {/* Resumo ---------------------------------------------------------- */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat label="Cenas" value={cenas.length} />
          <Stat label="Duração prevista" value={formatPreciseDuration(job?.expectedDuration || duracaoPrevista)} />
          <Stat label="Resolução" value={`${job?.width || presetInfo(presetId).w}×${job?.height || presetInfo(presetId).h}`} />
          <Stat label="FPS" value={job?.fps || 24} />
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Perfil de saída">
            <Select value={presetId} onChange={(e) => setPresetId(e.target.value)} disabled={emAndamento}>
              {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
            </Select>
          </Field>
          <Field label="Formato">
            <div className="flex h-[38px] items-center rounded-lg border border-hairline bg-panel-2 px-3 font-mono text-[11.5px] text-mist">
              MP4 · H.264 yuv420p · AAC 48 kHz estéreo · faststart
            </div>
          </Field>
        </div>

        {/* Cenas na ordem --------------------------------------------------- */}
        <div>
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-mist">
            Cenas na ordem da montagem
          </p>
          <ul className="divide-y divide-[color:var(--color-hairline)] overflow-hidden rounded-lg border border-hairline">
            {(job?.scenes?.length ? job.scenes : cenas).map((cena, i) => {
              const titulo = cena.title || cena.label;
              const aprovada = job?.scenes?.length ? true : cena.approved;
              return (
                <li key={cena.jobId || cena.id || i} className="flex items-center justify-between gap-3 bg-panel-2 px-3 py-2 text-[12px]">
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-mist">{i + 1}</span>
                    <span className="truncate text-chalk">{titulo}</span>
                    {!aprovada ? <Badge tone="warn">pendente</Badge> : null}
                  </span>
                  <span className="shrink-0 font-mono text-[10.5px] text-mist">
                    {cena.duration}s
                    {cena.width ? ` · ${cena.width}×${cena.height}` : ''}
                    {cena.hasAudio === false ? ' · sem áudio' : ''}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>

        {/* Progresso -------------------------------------------------------- */}
        {job && !concluida ? (
          <Panel className="space-y-3 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[12.5px] font-medium text-chalk">{job.stateLabel}</span>
              <Badge tone={job.state === 'falhou' ? 'alert' : job.state === 'cancelado' ? 'neutral' : 'gold'}>
                {Math.round((job.progress || 0) * 100)}%
              </Badge>
            </div>

            {!job.terminal ? (
              <ol className="flex flex-wrap gap-x-3 gap-y-1">
                {ORDEM.map((estado, i) => {
                  const atualIdx = ORDEM.indexOf(job.state);
                  const feito = atualIdx > i;
                  const agora = atualIdx === i;
                  return (
                    <li key={estado} className={`flex items-center gap-1 text-[11px] ${feito ? 'text-ok' : agora ? 'text-gold' : 'text-mist/45'}`}>
                      <span className={agora ? 'pulse-soft' : ''}><Icon name={feito ? 'check' : 'arrow'} size={11} /></span>
                      {ROTULOS[estado]}
                    </li>
                  );
                })}
              </ol>
            ) : null}

            <div className="h-1.5 overflow-hidden rounded-full bg-hairline">
              <div className="h-full rounded-full bg-gold transition-all duration-300" style={{ width: `${(job.progress || 0) * 100}%` }} />
            </div>

            <p className="font-mono text-[10.5px] text-mist">
              {job.encodedSeconds?.toFixed(2) || '0.00'}s de {job.expectedDuration}s
              {job.frames ? ` · ${job.frames} frames` : ''}
              {' · '}decorrido {Math.round((job.elapsedMs || 0) / 1000)}s
            </p>
          </Panel>
        ) : null}

        {erro ? <Aviso tom="alert"><strong>Falha:</strong> {erro}</Aviso> : null}

        {/* Resultado -------------------------------------------------------- */}
        {concluida ? (
          <Panel className="space-y-3 p-3.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-chalk">Montagem final</span>
              <Badge tone="ok">concluída</Badge>
            </div>

            <RealVideoPlayer src={job.result.url} aspect="16:9" />

            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 font-mono text-[10.5px] sm:grid-cols-4">
              <Info termo="Duração real" valor={`${job.result.duration}s`} />
              <Info termo="Tamanho" valor={formatBytes(job.result.bytes)} />
              <Info termo="Resolução" valor={`${job.result.width}×${job.result.height}`} />
              <Info termo="Custo local" valor="US$ 0,00" />
              <Info termo="Codecs" valor={`${job.result.videoCodec} / ${job.result.audioCodec} ${job.result.sampleRate}Hz`} span />
              <Info termo="Caminho lógico" valor={job.result.logicalPath} span />
              <Info termo="SHA-256" valor={job.result.sha256} span />
            </dl>

            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                icon="download"
                onClick={() => {
                  const a = document.createElement('a');
                  a.href = job.result.url;
                  a.download = job.result.filename;
                  document.body.appendChild(a);
                  a.click();
                  a.remove();
                }}
              >
                Baixar
              </Button>
              <Button
                variant="secondary"
                icon="biblioteca"
                onClick={() => {
                  onClose();
                  navigate?.('biblioteca');
                }}
              >
                Abrir na biblioteca
              </Button>
            </div>
          </Panel>
        ) : null}

        <p className="text-[11px] leading-relaxed text-mist">
          O FFmpeg roda no servidor da aplicação{ffmpeg?.version ? ` (versão ${ffmpeg.version})` : ''}.
          Trocar de aba ou recarregar a página não interrompe a exportação. Os clipes de origem não
          são alterados.
        </p>
      </div>
    </Modal>
  );
}

function presetInfo(id) {
  return {
    'source-864x480-24': { w: 864, h: 480 },
    '720p-24': { w: 1280, h: 720 },
    '1080p-24': { w: 1920, h: 1080 },
  }[id] || { w: 864, h: 480 };
}

function sanitize(id) {
  const limpo = String(id || 'avulso').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 64);
  return limpo || 'avulso';
}

function Aviso({ tom, children }) {
  const estilos = {
    alert: 'border-danger/30 bg-danger/[0.07] text-danger/90',
    warn: 'border-warn/30 bg-warn/[0.07] text-warn/90',
  };
  return (
    <p className={`rounded-lg border px-3 py-2 text-[11.5px] leading-relaxed ${estilos[tom] || estilos.warn}`}>
      {children}
    </p>
  );
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg border border-hairline bg-panel-2 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-mist">{label}</p>
      <p className="mt-0.5 text-[15px] font-semibold text-chalk">{value}</p>
    </div>
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
