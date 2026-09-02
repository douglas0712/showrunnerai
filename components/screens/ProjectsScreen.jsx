'use client';

import { useState } from 'react';
import { useStudio } from '../StudioContext';
import { Badge, Button, Empty, Field, IconButton, Input, Panel, SectionTitle, Select, Textarea } from '../ui/primitives';
import { Modal, ConfirmFooter } from '../ui/Modal';
import { ImageFrame } from '../ui/MediaFrame';
import { formatRelative } from '@/lib/format';

export default function ProjectsScreen({ navigate }) {
  const { projects, setProjects, activeProjectId, setActiveProjectId, toast } = useStudio();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ name: '', description: '', aspect: '16:9' });
  const [confirmDelete, setConfirmDelete] = useState(null);

  const openEdit = (project) => {
    setForm({ name: project.name, description: project.description, aspect: project.aspect });
    setEditing(project.id);
  };

  const save = () => {
    setProjects((list) =>
      list.map((p) => (p.id === editing ? { ...p, ...form, updatedAt: Date.now() } : p)),
    );
    setEditing(null);
    toast('Projeto atualizado.', 'ok');
  };

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Projetos"
        subtitle="Cada projeto guarda cenas, gerações e a montagem — tudo nesta máquina."
        action={<Button variant="primary" icon="plus" onClick={() => navigate('criar')}>Nova produção</Button>}
      />

      {!projects.length ? (
        <Empty
          icon="projetos"
          title="Nenhum projeto ainda"
          hint="Crie uma produção para começar a organizar cenas e gerações."
          action={<Button variant="primary" icon="plus" onClick={() => navigate('criar')}>Criar produção</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {projects.map((project) => {
            const active = project.id === activeProjectId;
            return (
              <Panel key={project.id} className={`overflow-hidden p-0 ${active ? 'border-gold/45' : ''}`}>
                <ImageFrame src={project.cover} aspect="16:9" scrim className="rounded-none border-0 border-b border-hairline">
                  <span className="absolute left-2 top-2 flex gap-1.5">
                    <Badge tone="neutral">{project.aspect}</Badge>
                    {active ? <Badge tone="gold">ativo</Badge> : null}
                  </span>
                </ImageFrame>

                <div className="space-y-2.5 p-3.5">
                  <div>
                    <p className="truncate text-[13.5px] font-medium text-chalk">{project.name}</p>
                    <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-mist">
                      {project.description || 'Sem descrição.'}
                    </p>
                  </div>

                  <p className="flex items-center gap-2 text-[10.5px] text-mist/70">
                    <span>{project.scenes} cenas</span>
                    <span aria-hidden="true">·</span>
                    <span>criado {formatRelative(project.createdAt)}</span>
                  </p>

                  <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                    <Button
                      size="sm"
                      variant={active ? 'ok' : 'primary'}
                      icon={active ? 'check' : 'arrow'}
                      onClick={() => {
                        setActiveProjectId(project.id);
                        navigate('storyboard');
                      }}
                    >
                      {active ? 'Abrir' : 'Tornar ativo'}
                    </Button>
                    <Button size="sm" variant="secondary" icon="revise" onClick={() => openEdit(project)}>
                      Renomear
                    </Button>
                    <IconButton icon="trash" label="Excluir projeto" onClick={() => setConfirmDelete(project)} />
                  </div>
                </div>
              </Panel>
            );
          })}
        </div>
      )}

      <Modal
        open={Boolean(editing)}
        title="Editar projeto"
        onClose={() => setEditing(null)}
        footer={<ConfirmFooter onCancel={() => setEditing(null)} onConfirm={save} confirmLabel="Salvar" disabled={!form.name.trim()} />}
      >
        <div className="space-y-3">
          <Field label="Nome">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Descrição">
            <Textarea rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <Field label="Proporção">
            <Select value={form.aspect} onChange={(e) => setForm({ ...form, aspect: e.target.value })}>
              {['16:9', '9:16', '21:9', '4:3', '1:1'].map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
          </Field>
        </div>
      </Modal>

      <Modal
        open={Boolean(confirmDelete)}
        title="Excluir projeto"
        subtitle="Esta ação remove o projeto do armazenamento local."
        onClose={() => setConfirmDelete(null)}
        footer={
          <ConfirmFooter
            onCancel={() => setConfirmDelete(null)}
            variant="danger"
            confirmLabel="Excluir"
            onConfirm={() => {
              setProjects((list) => list.filter((p) => p.id !== confirmDelete.id));
              if (activeProjectId === confirmDelete.id) setActiveProjectId(null);
              toast('Projeto excluído.', 'info');
              setConfirmDelete(null);
            }}
          />
        }
      >
        <p className="text-[13px] leading-relaxed text-mist">
          Excluir <span className="font-medium text-chalk">{confirmDelete?.name}</span>? As
          gerações permanecem na biblioteca.
        </p>
      </Modal>
    </div>
  );
}
