'use client';

import { useState } from 'react';
import { useStudio } from '../StudioContext';
import { Badge, Button, Panel, SectionTitle, SimulationNote } from '../ui/primitives';
import { Modal } from '../ui/Modal';
import { Icon } from '../ui/icons';
import { demoWorkflows } from '@/lib/demoData';

export default function WorkflowsScreen() {
  const { toast } = useStudio();
  const [running, setRunning] = useState(null);
  const [step, setStep] = useState(0);
  const workflows = demoWorkflows();

  const run = (workflow) => {
    setRunning(workflow);
    setStep(0);
    // Percorre as etapas com atraso artificial: o objetivo é validar a leitura
    // do progresso, não executar nada.
    workflow.steps.forEach((_, index) => {
      setTimeout(() => setStep(index + 1), (index + 1) * 650);
    });
    setTimeout(() => {
      toast(`"${workflow.name}" percorreu todas as etapas em modo simulado.`, 'warn');
    }, workflow.steps.length * 650 + 200);
  };

  return (
    <div className="space-y-5">
      <SectionTitle
        title="Workflows"
        subtitle="Pipelines de várias etapas que encadeiam os estúdios."
      />

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {workflows.map((workflow) => (
          <Panel key={workflow.id} className="flex flex-col gap-3 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[13.5px] font-medium text-chalk">{workflow.name}</p>
                <p className="mt-0.5 text-[11.5px] leading-snug text-mist">{workflow.description}</p>
              </div>
              <span className="shrink-0 text-mist/60"><Icon name="workflows" size={17} /></span>
            </div>

            <ol className="space-y-1.5">
              {workflow.steps.map((label, index) => (
                <li key={label} className="flex items-center gap-2 text-[11.5px] text-mist">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md border border-hairline bg-panel-2 font-mono text-[10px]">
                    {index + 1}
                  </span>
                  {label}
                </li>
              ))}
            </ol>

            <div className="mt-auto flex items-center justify-between gap-2 pt-1">
              <Badge tone="teal">Local</Badge>
              <Button size="sm" variant="primary" icon="play" onClick={() => run(workflow)}>
                Executar
              </Button>
            </div>
          </Panel>
        ))}
      </div>

      <SimulationNote>
        A execução percorre as etapas em modo simulado. Nenhum modelo, serviço ou grafo externo é
        acionado nesta fase.
      </SimulationNote>

      <Modal
        open={Boolean(running)}
        title={running?.name || ''}
        subtitle="Execução simulada — acompanhe as etapas."
        onClose={() => setRunning(null)}
        footer={<Button variant="secondary" onClick={() => setRunning(null)}>Fechar</Button>}
      >
        <ol className="space-y-2">
          {running?.steps.map((label, index) => {
            const done = index < step;
            const active = index === step;
            return (
              <li
                key={label}
                className={`flex items-center gap-2.5 rounded-lg border px-3 py-2 text-[12.5px] ${
                  done
                    ? 'border-ok/30 bg-ok/[0.07] text-ok'
                    : active
                      ? 'border-gold/35 bg-gold/[0.07] text-gold'
                      : 'border-hairline bg-panel-2 text-mist'
                }`}
              >
                <span className={active ? 'pulse-soft' : ''}>
                  <Icon name={done ? 'check' : 'arrow'} size={14} />
                </span>
                {label}
              </li>
            );
          })}
        </ol>
      </Modal>
    </div>
  );
}
