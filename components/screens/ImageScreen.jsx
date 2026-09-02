'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../StudioContext';
import {
  Badge, Button, Field, IconButton, Input, Panel, RuntimeBadge, SectionTitle,
  Select, SimulationNote, StatusBadge, Textarea,
} from '../ui/primitives';
import { ImageFrame } from '../ui/MediaFrame';
import { ResultActions, StatusPill } from '../ResultActions';
import { Icon } from '../ui/icons';
import { modelsByKind, getModel, inputEnum, inputDefault } from '@/lib/models';
import { randomSeed } from '@/lib/rng';
import { formatRelative, truncate } from '@/lib/format';

export default function ImageScreen({ navigate }) {
  const { generations, addGenerations, resolveProvider, toast, handoff, setHandoff } = useStudio();

  const models = modelsByKind('image');
  const [modelId, setModelId] = useState('ideogram-4');
  const model = getModel(modelId);

  const [prompt, setPrompt] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [resolution, setResolution] = useState('2K');
  const [count, setCount] = useState(2);
  const [seed, setSeed] = useState(() => randomSeed());
  const [references, setReferences] = useState([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  // Contexto entregue por outra tela (atalho da Início, card de modelo, Cinema).
  useEffect(() => {
    if (handoff?.target !== 'imagem') return;
    const { payload } = handoff;
    if (payload.modelId && models.some((m) => m.id === payload.modelId)) setModelId(payload.modelId);
    if (payload.prompt) setPrompt(payload.prompt);
    if (payload.aspect) setAspect(payload.aspect);
    setHandoff(null);
  }, [handoff, models, setHandoff]);

  // Mantém os parâmetros dentro do que o modelo aceita.
  useEffect(() => {
    if (!model) return;
    const aspects = inputEnum(model, 'aspect_ratio');
    const resolutions = inputEnum(model, 'resolution');
    const counts = inputEnum(model, 'count');
    if (aspects.length && !aspects.includes(aspect)) setAspect(inputDefault(model, 'aspect_ratio', aspects[0]));
    if (resolutions.length && !resolutions.includes(resolution)) setResolution(inputDefault(model, 'resolution', resolutions[0]));
    if (counts.length && !counts.includes(count)) setCount(inputDefault(model, 'count', counts[0]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId]);

  const images = useMemo(() => generations.filter((item) => item.kind === 'image'), [generations]);

  const onFiles = (event) => {
    const files = Array.from(event.target.files || []).slice(0, 8);
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => {
        setReferences((list) => [...list, { id: `${file.name}-${Date.now()}`, name: file.name, url: String(reader.result) }]);
      };
      reader.readAsDataURL(file); // leitura local; o arquivo não sai da máquina
    });
    event.target.value = '';
  };

  const generate = async () => {
    if (!prompt.trim() && !references.length) {
      toast('Escreva um prompt ou envie uma referência antes de gerar.', 'warn');
      return;
    }

    const { provider, intended, simulated, reason } = resolveProvider(modelId);
    setBusy(true);
    try {
      const results = await provider.generateImage({
        prompt: prompt.trim(),
        aspect,
        resolution,
        seed,
        count,
        modelId,
        intendedProviderId: intended.id,
        references: references.map((ref) => ref.url),
      });
      addGenerations(results);
      toast(
        simulated
          ? `Pré-visualização simulada gerada. ${reason} A geração real entra na próxima etapa.`
          : 'Geração concluída.',
        simulated ? 'warn' : 'ok',
      );
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,380px)_minmax(0,1fr)]">
      {/* Painel de composição ------------------------------------------------ */}
      <div className="space-y-4">
        <Panel className="space-y-4 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-[14px] font-semibold text-chalk">Compor imagem</h2>
            <div className="flex items-center gap-1.5">
              <RuntimeBadge model={model} />
              <StatusBadge model={model} />
            </div>
          </div>

          <Field label="Prompt">
            <Textarea
              rows={5}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="Descreva o quadro: sujeito, ambiente, luz, lente, atmosfera…"
            />
          </Field>

          <Field label="Referências" hint="As imagens são lidas localmente e não são enviadas a lugar nenhum.">
            <div className="flex flex-wrap gap-2">
              {references.map((ref) => (
                <span key={ref.id} className="group relative h-16 w-16 overflow-hidden rounded-lg border border-hairline">
                  {/* eslint-disable-next-line @next/next/no-img-element -- data: URL local */}
                  <img src={ref.url} alt={ref.name} className="h-full w-full object-cover" />
                  <button
                    type="button"
                    aria-label={`Remover ${ref.name}`}
                    onClick={() => setReferences((list) => list.filter((r) => r.id !== ref.id))}
                    className="absolute right-0.5 top-0.5 rounded bg-black/70 p-0.5 text-chalk opacity-0 group-hover:opacity-100"
                  >
                    <Icon name="close" size={11} />
                  </button>
                </span>
              ))}
              <button
                type="button"
                onClick={() => fileRef.current?.click()}
                className="focus-ring flex h-16 w-16 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-hairline text-mist hover:border-gold/40 hover:text-chalk"
              >
                <Icon name="upload" size={16} />
                <span className="text-[9.5px]">Enviar</span>
              </button>
              <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={onFiles} />
            </div>
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

          <div className="grid grid-cols-2 gap-3">
            <Field label="Proporção">
              <Select value={aspect} onChange={(event) => setAspect(event.target.value)}>
                {inputEnum(model, 'aspect_ratio').map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </Field>
            <Field label="Resolução">
              <Select value={resolution} onChange={(event) => setResolution(event.target.value)}>
                {inputEnum(model, 'resolution').map((value) => (
                  <option key={value} value={value}>{value}</option>
                ))}
              </Select>
            </Field>
            <Field label="Quantidade">
              <Select value={count} onChange={(event) => setCount(Number(event.target.value))}>
                {inputEnum(model, 'count').map((value) => (
                  <option key={value} value={value}>{value} {value === 1 ? 'resultado' : 'resultados'}</option>
                ))}
              </Select>
            </Field>
            <Field label="Seed">
              <div className="flex gap-1.5">
                <Input
                  type="number"
                  value={seed}
                  onChange={(event) => setSeed(Number(event.target.value))}
                  className="flex-1"
                />
                <IconButton icon="dice" label="Nova seed" onClick={() => setSeed(randomSeed())} className="h-[38px] w-[38px]" />
              </div>
            </Field>
          </div>

          <Button variant="primary" size="lg" icon="spark" className="w-full" onClick={generate} disabled={busy}>
            {busy ? 'Gerando pré-visualização…' : 'Gerar imagem'}
          </Button>

          <SimulationNote>
            Fase 1: o botão produz uma <strong>pré-visualização simulada</strong> desenhada
            localmente, para avaliar o fluxo. A integração com {model?.name} será feita na
            próxima etapa.
          </SimulationNote>
        </Panel>
      </div>

      {/* Galeria -------------------------------------------------------------- */}
      <div>
        <SectionTitle
          title="Resultados"
          subtitle={`${images.length} ${images.length === 1 ? 'imagem' : 'imagens'} nesta máquina`}
          action={
            <Button size="sm" variant="ghost" icon="biblioteca" onClick={() => navigate('biblioteca')}>
              Biblioteca
            </Button>
          }
        />

        {busy ? (
          <div className="mb-4 grid gap-4 sm:grid-cols-2">
            {Array.from({ length: count }).map((_, i) => (
              <div key={i} className="shimmer aspect-video rounded-xl border border-hairline bg-panel/60" />
            ))}
          </div>
        ) : null}

        <div className="grid gap-4 sm:grid-cols-2">
          {images.map((item) => (
            <Panel key={item.id} className="fade-up overflow-hidden p-0">
              <ImageFrame src={item.url} alt={item.prompt} aspect={item.aspect} scrim className="rounded-none border-0 border-b border-hairline">
                <span className="absolute left-2 top-2 flex gap-1.5">
                  <Badge tone="warn">simulado</Badge>
                </span>
                <span className="absolute right-2 top-2">
                  <StatusPill status={item.status} />
                </span>
              </ImageFrame>

              <div className="space-y-2.5 p-3.5">
                <p className="line-clamp-2 text-[12px] leading-snug text-mist">
                  {truncate(item.prompt || 'Sem prompt', 120)}
                </p>
                <p className="flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[10.5px] text-mist/70">
                  <span>{getModel(item.modelId)?.name || item.modelId}</span>
                  <span aria-hidden="true">·</span>
                  <span>{item.aspect}</span>
                  <span aria-hidden="true">·</span>
                  <span>{item.resolution}</span>
                  <span aria-hidden="true">·</span>
                  <span>seed {item.seed}</span>
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
                  actions={['approve', 'revise', 'download', 'useInVideo']}
                  onUseInVideo={(picked) => navigate('video', { mode: 'i2v', image: picked })}
                />
              </div>
            </Panel>
          ))}
        </div>
      </div>
    </div>
  );
}
