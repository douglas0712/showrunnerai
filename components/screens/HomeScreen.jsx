'use client';

import { useState } from 'react';
import { useStudio } from '../StudioContext';
import { ALL_MODELS, RUNTIME } from '@/lib/models';
import { Badge, Button, Panel, RuntimeBadge, SectionTitle, StatusBadge, Textarea } from '../ui/primitives';
import { ImageFrame } from '../ui/MediaFrame';
import { StatusPill } from '../ResultActions';
import { Icon } from '../ui/icons';
import { formatRelative, truncate } from '@/lib/format';
import { makeId } from '@/lib/rng';

const SHORTCUTS = [
  {
    id: 't2i',
    title: 'Texto → Imagem',
    description: 'Descreva o quadro e gere a imagem-chave.',
    icon: 'imagem',
    target: 'imagem',
    payload: { mode: 't2i' },
  },
  {
    id: 'i2v',
    title: 'Imagem → Vídeo',
    description: 'Anime uma imagem existente com prompt de movimento.',
    icon: 'video',
    target: 'video',
    payload: { mode: 'i2v' },
  },
  {
    id: 't2v',
    title: 'Texto → Vídeo',
    description: 'Vá direto do roteiro ao plano em movimento.',
    icon: 'cinema',
    target: 'video',
    payload: { mode: 't2v' },
  },
];

export default function HomeScreen({ navigate }) {
  const { ready, projects, generations, setProjects, setActiveProjectId, toast } = useStudio();
  const [idea, setIdea] = useState('');

  const startProduction = () => {
    const name = idea.trim() ? truncate(idea.trim(), 48) : 'Produção sem título';
    const project = {
      id: makeId('proj'),
      name,
      description: idea.trim(),
      aspect: '16:9',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cover: null,
      scenes: 0,
    };
    setProjects((list) => [project, ...list]);
    setActiveProjectId(project.id);
    toast('Produção criada. Abrindo o briefing com o agente.', 'ok');
    navigate('agente', { idea: idea.trim() });
    setIdea('');
  };

  const recentProjects = projects.slice(0, 3);
  const recentGenerations = generations.slice(0, 6);

  return (
    <div className="space-y-10">
      {/* Hero ---------------------------------------------------------------- */}
      <section className="fade-up relative overflow-hidden rounded-2xl border border-hairline bg-gradient-to-b from-panel/80 to-ink-2/60 px-5 py-8 sm:px-8 sm:py-10">
        <div className="relative z-10 mx-auto max-w-3xl text-center">
          <Badge tone="gold" className="mb-4">Estúdio local de produção audiovisual</Badge>
          <h2 className="text-balance text-2xl font-semibold leading-tight tracking-tight text-chalk sm:text-[32px]">
            O que você quer criar?
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-[13px] leading-relaxed text-mist">
            Descreva a ideia. O agente conduz o briefing, o storyboard organiza as cenas e a
            timeline monta o corte final.
          </p>

          <div className="mt-6 rounded-xl border border-hairline bg-ink-2/80 p-2 shadow-2xl">
            <Textarea
              rows={3}
              value={idea}
              onChange={(event) => setIdea(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) startProduction();
              }}
              placeholder="Ex.: um curta neo-noir de 3 minutos sobre uma detetive que recebe um sinal de rádio impossível…"
              className="border-transparent bg-transparent text-[14px] focus:border-transparent"
            />
            <div className="flex flex-wrap items-center justify-between gap-3 px-2 pb-1 pt-1">
              <span className="text-[11px] text-mist/70">
                Nenhuma chave, nenhum cadastro. Tudo fica nesta máquina.
              </span>
              <Button variant="primary" size="lg" icon="arrow" onClick={startProduction}>
                Começar produção
              </Button>
            </div>
          </div>
        </div>
      </section>

      {/* Atalhos ------------------------------------------------------------- */}
      <section>
        <SectionTitle title="Atalhos" subtitle="Vá direto para o fluxo que você já conhece." />
        <div className="grid gap-3 sm:grid-cols-3">
          {SHORTCUTS.map((shortcut) => (
            <button
              key={shortcut.id}
              type="button"
              onClick={() => navigate(shortcut.target, shortcut.payload)}
              className="pressable focus-ring group flex items-start gap-3 rounded-xl border border-hairline bg-panel/70 p-4 text-left hover:border-gold/40 hover:bg-panel-2"
            >
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-hairline bg-white/[0.05] text-gold">
                <Icon name={shortcut.icon} size={18} />
              </span>
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 text-[13.5px] font-medium text-chalk">
                  {shortcut.title}
                  <span className="text-mist transition-transform group-hover:translate-x-0.5">
                    <Icon name="arrow" size={13} />
                  </span>
                </span>
                <span className="mt-0.5 block text-[12px] leading-snug text-mist">
                  {shortcut.description}
                </span>
              </span>
            </button>
          ))}
        </div>
      </section>

      {/* Projetos recentes --------------------------------------------------- */}
      <section>
        <SectionTitle
          title="Projetos recentes"
          subtitle="Continue de onde parou."
          action={
            <Button size="sm" variant="ghost" icon="arrow" onClick={() => navigate('projetos')}>
              Ver todos
            </Button>
          }
        />
        {!ready ? (
          <SkeletonRow />
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {recentProjects.map((project) => (
              <button
                key={project.id}
                type="button"
                onClick={() => {
                  setActiveProjectId(project.id);
                  navigate('storyboard');
                }}
                className="pressable focus-ring group overflow-hidden rounded-xl border border-hairline bg-panel/70 text-left hover:border-gold/40"
              >
                <ImageFrame src={project.cover} aspect="16:9" scrim className="rounded-none border-0 border-b border-hairline">
                  <span className="absolute bottom-2 left-2">
                    <Badge tone="neutral">{project.aspect}</Badge>
                  </span>
                </ImageFrame>
                <div className="p-3.5">
                  <p className="truncate text-[13.5px] font-medium text-chalk">{project.name}</p>
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-snug text-mist">
                    {project.description || 'Sem descrição.'}
                  </p>
                  <p className="mt-2.5 flex items-center gap-2 text-[10.5px] text-mist/70">
                    <span>{project.scenes} cenas</span>
                    <span aria-hidden="true">·</span>
                    <span>atualizado {formatRelative(project.updatedAt)}</span>
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Gerações recentes --------------------------------------------------- */}
      <section>
        <SectionTitle
          title="Gerações recentes"
          subtitle="Resultados simulados desta fase — nada foi executado em modelo real."
          action={
            <Button size="sm" variant="ghost" icon="arrow" onClick={() => navigate('biblioteca')}>
              Abrir biblioteca
            </Button>
          }
        />
        {!ready ? (
          <SkeletonRow />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {recentGenerations.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => navigate('biblioteca')}
                className="pressable focus-ring group text-left"
              >
                <ImageFrame
                  src={item.kind === 'video' ? item.poster : item.url}
                  alt={item.prompt}
                  aspect="1:1"
                  scrim
                  className="group-hover:border-gold/40"
                >
                  <span className="absolute left-1.5 top-1.5">
                    <Badge tone={item.kind === 'video' ? 'accent' : 'neutral'}>
                      {item.kind === 'video' ? 'vídeo' : 'imagem'}
                    </Badge>
                  </span>
                  <span className="absolute bottom-1.5 right-1.5">
                    <StatusPill status={item.status} />
                  </span>
                </ImageFrame>
                <p className="mt-1.5 line-clamp-2 text-[11px] leading-snug text-mist">
                  {truncate(item.prompt, 60)}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Modelos ------------------------------------------------------------- */}
      <section>
        <SectionTitle
          title="Modelos disponíveis"
          subtitle="Cada modelo indica se roda local ou por API, e se já está configurado."
          action={
            <Button size="sm" variant="ghost" icon="configuracoes" onClick={() => navigate('configuracoes')}>
              Configurar
            </Button>
          }
        />
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {ALL_MODELS.map((model) => (
            <Panel key={model.id} className="flex flex-col gap-2.5 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-[13.5px] font-medium text-chalk">{model.name}</p>
                  <p className="text-[11px] text-mist">{model.vendor}</p>
                </div>
                <span className="shrink-0 text-mist/60">
                  <Icon name={model.kind === 'video' ? 'video' : 'imagem'} size={16} />
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <RuntimeBadge model={model} />
                <StatusBadge model={model} />
              </div>

              <p className="text-[11px] leading-snug text-mist/80">{model.note}</p>

              <Button
                size="sm"
                variant={model.status === 'available' ? 'secondary' : 'ghost'}
                className="mt-auto w-full"
                icon="arrow"
                onClick={() => navigate(model.kind === 'video' ? 'video' : 'imagem', { modelId: model.id })}
              >
                {model.runtime === RUNTIME.LOCAL ? 'Abrir estúdio' : 'Ver no estúdio'}
              </Button>
            </Panel>
          ))}
        </div>
      </section>
    </div>
  );
}

function SkeletonRow() {
  return (
    <div className="grid gap-4 sm:grid-cols-3">
      {[0, 1, 2].map((i) => (
        <div key={i} className="shimmer h-40 rounded-xl border border-hairline bg-panel/60" />
      ))}
    </div>
  );
}
