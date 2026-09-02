'use client';

import { useState } from 'react';
import { useStudio } from '../StudioContext';
import { Button, Empty, Field, IconButton, Input, Panel, SectionTitle, Textarea, Toggle, Badge } from '../ui/primitives';
import { Modal, ConfirmFooter } from '../ui/Modal';
import { ImageFrame } from '../ui/MediaFrame';
import { placeholderFrame } from '@/lib/placeholder';
import { makeId, randomSeed } from '@/lib/rng';

const EMPTY = { name: '', role: '', description: '', seed: 0, lockSeed: true };

export default function CharactersScreen({ navigate }) {
  const { characters, setCharacters, toast } = useStudio();
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);

  const openNew = () => {
    setForm({ ...EMPTY, seed: randomSeed() });
    setEditing('new');
  };

  const openEdit = (character) => {
    setForm(character);
    setEditing(character.id);
  };

  const save = () => {
    const reference = placeholderFrame({
      seed: form.seed,
      prompt: `${form.name} ${form.description}`,
      aspect: '3:4',
      kind: 'image',
      label: 'PERSONAGEM',
    });

    if (editing === 'new') {
      setCharacters((list) => [{ ...form, id: makeId('char'), reference }, ...list]);
      toast(`Personagem "${form.name || 'sem nome'}" criado.`, 'ok');
    } else {
      setCharacters((list) => list.map((c) => (c.id === editing ? { ...c, ...form, reference } : c)));
      toast('Personagem atualizado.', 'ok');
    }
    setEditing(null);
  };

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Elenco e consistência"
        subtitle="Travar a seed mantém o mesmo rosto entre cenas diferentes."
        action={<Button variant="primary" icon="plus" onClick={openNew}>Novo personagem</Button>}
      />

      {!characters.length ? (
        <Empty
          icon="personagens"
          title="Nenhum personagem ainda"
          hint="Crie personagens para reaproveitar rosto, figurino e seed nas cenas do storyboard."
          action={<Button variant="primary" icon="plus" onClick={openNew}>Criar o primeiro</Button>}
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {characters.map((character) => (
            <Panel key={character.id} className="overflow-hidden p-0">
              <ImageFrame src={character.reference} alt={character.name} aspect="3:4" scrim className="rounded-none border-0 border-b border-hairline">
                <span className="absolute left-2 top-2">
                  <Badge tone={character.lockSeed ? 'teal' : 'neutral'}>
                    {character.lockSeed ? 'seed travada' : 'seed livre'}
                  </Badge>
                </span>
              </ImageFrame>
              <div className="space-y-2 p-3.5">
                <div>
                  <p className="truncate text-[13.5px] font-medium text-chalk">{character.name}</p>
                  <p className="text-[11px] text-mist">{character.role}</p>
                </div>
                <p className="line-clamp-3 text-[11.5px] leading-snug text-mist/85">{character.description}</p>
                <p className="font-mono text-[10.5px] text-mist/60">seed {character.seed}</p>
                <div className="flex items-center gap-1.5 pt-1">
                  <Button size="sm" variant="secondary" icon="revise" onClick={() => openEdit(character)}>
                    Editar
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon="imagem"
                    onClick={() => navigate('imagem', { prompt: `${character.name}: ${character.description}` })}
                  >
                    Gerar
                  </Button>
                  <IconButton
                    icon="trash"
                    label="Excluir"
                    onClick={() => {
                      setCharacters((list) => list.filter((c) => c.id !== character.id));
                      toast('Personagem removido.', 'info');
                    }}
                  />
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}

      <Modal
        open={Boolean(editing)}
        title={editing === 'new' ? 'Novo personagem' : 'Editar personagem'}
        subtitle="A referência visual é desenhada localmente a partir da seed."
        onClose={() => setEditing(null)}
        footer={
          <ConfirmFooter
            onCancel={() => setEditing(null)}
            onConfirm={save}
            confirmLabel="Salvar"
            disabled={!form.name.trim()}
          />
        }
      >
        <div className="space-y-3">
          <Field label="Nome">
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
          </Field>
          <Field label="Papel">
            <Input
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
              placeholder="Protagonista, antagonista, ambiente recorrente…"
            />
          </Field>
          <Field label="Descrição visual" hint="Idade, figurino, traços marcantes, paleta.">
            <Textarea rows={4} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </Field>
          <div className="grid grid-cols-2 items-end gap-3">
            <Field label="Seed">
              <div className="flex gap-1.5">
                <Input type="number" value={form.seed} onChange={(e) => setForm({ ...form, seed: Number(e.target.value) })} />
                <IconButton icon="dice" label="Nova seed" onClick={() => setForm({ ...form, seed: randomSeed() })} className="h-[38px] w-[38px]" />
              </div>
            </Field>
            <div className="flex h-[38px] items-center justify-between rounded-lg border border-hairline bg-panel-2 px-3">
              <span className="text-[12px] text-chalk">Travar seed</span>
              <Toggle checked={form.lockSeed} onChange={(v) => setForm({ ...form, lockSeed: v })} label="Travar seed" />
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
