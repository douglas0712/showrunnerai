'use client';

import { useState } from 'react';
import { useStudio } from '../StudioContext';
import { Button, Field, Input, Panel, SectionTitle, Select, Textarea, Badge } from '../ui/primitives';
import { Icon } from '../ui/icons';
import { makeId } from '@/lib/rng';
import { ALL_MODELS } from '@/lib/models';

const PIPELINES = [
  { id: 't2i', title: 'Texto → Imagem', target: 'imagem', icon: 'imagem', description: 'Fechar o visual antes de mover a câmera.' },
  { id: 'i2v', title: 'Imagem → Vídeo', target: 'video', icon: 'video', description: 'Animar uma imagem-chave já aprovada.' },
  { id: 't2v', title: 'Texto → Vídeo', target: 'video', icon: 'cinema', description: 'Ir direto do roteiro ao plano.' },
  { id: 'agent', title: 'Briefing com o agente', target: 'agente', icon: 'agente', description: 'Deixar o agente entrevistar você primeiro.' },
];

export default function CreateScreen({ navigate }) {
  const { setProjects, setActiveProjectId, toast } = useStudio();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [pipeline, setPipeline] = useState('agent');

  const create = () => {
    const project = {
      id: makeId('proj'),
      name: name.trim() || 'Produção sem título',
      description: description.trim(),
      aspect,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      cover: null,
      scenes: 0,
    };
    setProjects((list) => [project, ...list]);
    setActiveProjectId(project.id);
    toast(`Projeto "${project.name}" criado.`, 'ok');

    const chosen = PIPELINES.find((p) => p.id === pipeline);
    navigate(chosen.target, {
      prompt: description.trim(),
      aspect,
      mode: pipeline === 't2i' ? 't2i' : pipeline,
      idea: description.trim(),
    });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Panel className="space-y-4 p-5">
        <SectionTitle title="Nova produção" subtitle="Um projeto agrupa cenas, gerações e a montagem final." />

        <Field label="Nome do projeto">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Curta neo-noir “Sinal”" />
        </Field>

        <Field label="Descrição / ideia">
          <Textarea
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Conte o que é a peça: formato, tema, tom, público."
          />
        </Field>

        <Field label="Proporção padrão">
          <Select value={aspect} onChange={(e) => setAspect(e.target.value)}>
            {['16:9', '9:16', '21:9', '4:3', '1:1'].map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </Select>
        </Field>
      </Panel>

      <Panel className="space-y-3 p-5">
        <SectionTitle title="Por onde começar" subtitle="Você pode mudar de rota a qualquer momento." />
        <div className="grid gap-3 sm:grid-cols-2">
          {PIPELINES.map((item) => {
            const active = item.id === pipeline;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setPipeline(item.id)}
                className={`pressable focus-ring flex items-start gap-3 rounded-xl border p-3.5 text-left ${
                  active ? 'border-gold/50 bg-gold/[0.07]' : 'border-hairline bg-panel-2 hover:border-white/20'
                }`}
              >
                <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-hairline ${active ? 'text-gold' : 'text-mist'}`}>
                  <Icon name={item.icon} size={17} />
                </span>
                <span>
                  <span className="block text-[13px] font-medium text-chalk">{item.title}</span>
                  <span className="mt-0.5 block text-[11.5px] leading-snug text-mist">{item.description}</span>
                </span>
              </button>
            );
          })}
        </div>

        <div className="flex items-center justify-between gap-3 pt-1">
          <p className="text-[11.5px] text-mist">
            <Badge tone="teal">Local</Badge>{' '}
            {ALL_MODELS.filter((m) => m.status === 'available').length} modelos disponíveis nesta máquina.
          </p>
          <Button variant="primary" size="lg" icon="arrow" onClick={create}>
            Criar e abrir
          </Button>
        </div>
      </Panel>
    </div>
  );
}
