'use client';

import { useEffect, useState } from 'react';
import { useStudio } from '../StudioContext';
import {
  Badge, Button, Empty, Field, IconButton, Input, Panel, SectionTitle, Segmented,
  Select, SimulationNote, Textarea,
} from '../ui/primitives';
import { Modal, ConfirmFooter } from '../ui/Modal';
import { ImageFrame } from '../ui/MediaFrame';
import { Icon } from '../ui/icons';
import TimelinePanel from './TimelinePanel';
import {
  SCENE_STATUS, STATUS_TONE, addScene, approveScene, moveScene, removeScene,
  renumber, requestSceneRevision, sceneStats, totalDuration, updateScene,
} from '@/lib/storyboard';

import { modelsByKind, getModel } from '@/lib/models';
import { timelineStats } from '@/lib/timelineAssets';
import { placeholderFrame } from '@/lib/placeholder';
import { formatDuration, formatPreciseDuration, truncate } from '@/lib/format';
import { randomSeed } from '@/lib/rng';

export default function StoryboardScreen({ navigate }) {
  const {
    scenes, setScenes, timeline, setTimeline, generations, resolveProvider,
    addGenerations, toast, handoff, setHandoff,
  } = useStudio();
  const [view, setView] = useState('cenas');
  const [reviseFor, setReviseFor] = useState(null);
  const [note, setNote] = useState('');
  const [dragId, setDragId] = useState(null);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    if (handoff?.target !== 'storyboard') return;
    if (handoff.payload?.view) setView(handoff.payload.view);
    setHandoff(null);
  }, [handoff, setHandoff]);

  const stats = sceneStats(scenes);
  const tlStats = timelineStats(timeline, generations);
  const videoModels = modelsByKind('video');

  const patch = (id, values) => setScenes((list) => updateScene(list, id, values));

  const generateSceneVideo = async (scene) => {
    const { provider, intended, simulated, reason } = resolveProvider(scene.modelId);
    setBusyId(scene.id);
    try {
      const [result] = await provider.generateVideo({
        prompt: scene.description || scene.title,
        aspect: '16:9',
        duration: scene.duration,
        seed: randomSeed(),
        modelId: scene.modelId,
        intendedProviderId: intended.id,
        mode: 'i2v',
      });
      addGenerations([result]);
      patch(scene.id, { status: SCENE_STATUS.RENDERED, videoId: result.id });
      // A cena gerada aqui ainda é simulada: fica na biblioteca, mas não entra
      // na montagem — a timeline do projeto só recebe resultado real aprovado.
      toast(
        simulated
          ? `Cena ${scene.number}: clipe simulado gerado e guardado na biblioteca. ${reason}`
          : `Cena ${scene.number} gerada.`,
        simulated ? 'warn' : 'ok',
      );
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusyId(null);
    }
  };

  const onDrop = (targetId) => {
    if (!dragId || dragId === targetId) return;
    setScenes((list) => {
      const from = list.findIndex((s) => s.id === dragId);
      const to = list.findIndex((s) => s.id === targetId);
      if (from === -1 || to === -1) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return renumber(next);
    });
    setDragId(null);
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented
          options={[
            { value: 'cenas', label: 'Cenas' },
            { value: 'timeline', label: 'Timeline' },
          ]}
          value={view}
          onChange={setView}
        />
        {/* O cabeçalho reflete a visão aberta: antes ele mostrava as cenas do
            storyboard mesmo na timeline, e acusava "0 cenas" com clipes na tela. */}
        {view === 'timeline' ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{tlStats.clipes} {tlStats.clipes === 1 ? 'cena' : 'cenas'}</Badge>
            <Badge tone="ok">{tlStats.aprovados} aprovadas</Badge>
            {tlStats.simulados ? <Badge tone="warn">{tlStats.simulados} simulado(s)</Badge> : null}
            {tlStats.duplicatas ? <Badge tone="alert">{tlStats.duplicatas} duplicata(s)</Badge> : null}
            <Badge tone="gold">{formatPreciseDuration(tlStats.duracaoTotal)}</Badge>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{stats.total} cenas</Badge>
            <Badge tone="ok">{stats.approved} aprovadas</Badge>
            {stats.revision ? <Badge tone="alert">{stats.revision} em alteração</Badge> : null}
            <Badge tone="gold">{formatDuration(totalDuration(scenes))}</Badge>
          </div>
        )}
      </div>

      {view === 'timeline' ? (
        <TimelinePanel navigate={navigate} />
      ) : (
        <>
          <SectionTitle
            title="Storyboard"
            subtitle="Arraste os cards para reordenar. Cada cena carrega seu próprio modelo e status."
            action={
              <Button
                variant="primary"
                icon="plus"
                onClick={() => {
                  setScenes((list) =>
                    addScene(list, {
                      title: `Cena ${list.length + 1}`,
                      description: '',
                      image: placeholderFrame({
                        seed: randomSeed(),
                        prompt: `cena ${list.length + 1}`,
                        aspect: '16:9',
                        kind: 'image',
                        label: `CENA ${list.length + 1}`,
                      }),
                    }),
                  );
                  toast('Cena adicionada ao fim do storyboard.', 'ok');
                }}
              >
                Adicionar cena
              </Button>
            }
          />

          {!scenes.length ? (
            <Empty
              icon="storyboard"
              title="Storyboard vazio"
              hint="Adicione cenas para planejar a produção antes de gerar qualquer vídeo."
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {scenes.map((scene, index) => (
                <Panel
                  key={scene.id}
                  className="fade-up flex flex-col overflow-hidden p-0"
                  draggable
                  onDragStart={() => setDragId(scene.id)}
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => onDrop(scene.id)}
                >
                  <ImageFrame src={scene.image} alt={scene.title} aspect="16:9" scrim className="rounded-none border-0 border-b border-hairline">
                    <span className="absolute left-2 top-2 flex items-center gap-1.5">
                      <span className="flex h-6 min-w-6 items-center justify-center rounded-md bg-black/75 px-1.5 font-mono text-[11px] font-bold text-gold">
                        {String(scene.number).padStart(2, '0')}
                      </span>
                      <Badge tone={STATUS_TONE[scene.status] || 'neutral'}>{scene.status}</Badge>
                    </span>
                    <span className="absolute right-2 top-2 flex gap-1">
                      <IconButton icon="up" label="Mover para cima" onClick={() => setScenes((l) => moveScene(l, scene.id, -1))} disabled={index === 0} className="h-7 w-7 bg-black/60" />
                      <IconButton icon="down" label="Mover para baixo" onClick={() => setScenes((l) => moveScene(l, scene.id, 1))} disabled={index === scenes.length - 1} className="h-7 w-7 bg-black/60" />
                    </span>
                  </ImageFrame>

                  <div className="flex flex-1 flex-col gap-2.5 p-3.5">
                    <Input
                      value={scene.title}
                      onChange={(event) => patch(scene.id, { title: event.target.value })}
                      className="h-8 border-transparent bg-transparent px-0 text-[13.5px] font-medium hover:border-hairline hover:px-2"
                      aria-label={`Título da cena ${scene.number}`}
                    />

                    <Textarea
                      rows={3}
                      value={scene.description}
                      onChange={(event) => patch(scene.id, { description: event.target.value })}
                      placeholder="Descreva o que acontece nesta cena…"
                      className="text-[12px]"
                    />

                    <div className="grid grid-cols-2 gap-2">
                      <Field label="Duração">
                        <Input
                          type="number"
                          min="1"
                          value={scene.duration}
                          onChange={(event) => patch(scene.id, { duration: Math.max(1, Number(event.target.value) || 1) })}
                          className="h-8 text-[12px]"
                        />
                      </Field>
                      <Field label="Modelo">
                        <Select
                          value={scene.modelId}
                          onChange={(event) => patch(scene.id, { modelId: event.target.value })}
                          className="h-8 text-[12px]"
                        >
                          {videoModels.map((model) => (
                            <option key={model.id} value={model.id}>
                              {model.name} · {model.runtime === 'local' ? 'Local' : 'API'}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>

                    {scene.revisionNote ? (
                      <p className="rounded-lg border border-danger/25 bg-danger/[0.07] px-2.5 py-1.5 text-[11.5px] leading-snug text-danger/90">
                        <span className="font-semibold">Alteração: </span>{scene.revisionNote}
                      </p>
                    ) : null}

                    <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-1">
                      <Button
                        size="sm"
                        variant={scene.status === SCENE_STATUS.APPROVED ? 'ok' : 'secondary'}
                        icon="check"
                        onClick={() => {
                          setScenes((l) => approveScene(l, scene.id));
                          toast(`Cena ${scene.number} aprovada.`, 'ok');
                        }}
                      >
                        {scene.status === SCENE_STATUS.APPROVED ? 'Aprovada' : 'Aprovar'}
                      </Button>
                      <Button size="sm" variant="secondary" icon="revise" onClick={() => { setReviseFor(scene); setNote(scene.revisionNote || ''); }}>
                        Pedir alteração
                      </Button>
                      <Button
                        size="sm"
                        variant="primary"
                        icon="video"
                        disabled={busyId === scene.id}
                        onClick={() => generateSceneVideo(scene)}
                      >
                        {busyId === scene.id ? 'Gerando…' : 'Gerar vídeo'}
                      </Button>
                      <IconButton
                        icon="trash"
                        label={`Excluir cena ${scene.number}`}
                        onClick={() => {
                          setScenes((l) => removeScene(l, scene.id));
                          toast('Cena removida.', 'info');
                        }}
                      />
                    </div>
                  </div>
                </Panel>
              ))}
            </div>
          )}

          <SimulationNote>
            “Gerar vídeo” produz um clipe simulado e o envia para a timeline, para exercitar o
            fluxo completo. Nenhum modelo é executado nesta fase.
          </SimulationNote>
        </>
      )}

      <Modal
        open={Boolean(reviseFor)}
        title={reviseFor ? `Pedir alteração — cena ${reviseFor.number}` : ''}
        subtitle="O pedido fica visível no card e orienta a próxima geração."
        onClose={() => setReviseFor(null)}
        footer={
          <ConfirmFooter
            onCancel={() => setReviseFor(null)}
            onConfirm={() => {
              setScenes((l) => requestSceneRevision(l, reviseFor.id, note));
              toast(`Alteração registrada na cena ${reviseFor.number}.`, 'warn');
              setReviseFor(null);
              setNote('');
            }}
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
          placeholder="O que precisa mudar nesta cena?"
        />
      </Modal>
    </div>
  );
}
