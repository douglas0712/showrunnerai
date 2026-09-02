'use client';

import { useEffect, useState } from 'react';
import { useStudio } from '../StudioContext';
import {
  Badge, Button, Field, Input, Panel, SectionTitle, SimulationNote, Toggle,
} from '../ui/primitives';
import { Icon } from '../ui/icons';
import { API_VENDORS } from '@/lib/providers/registry';
import { ALL_MODELS } from '@/lib/models';
import { storageReport, KEYS } from '@/lib/storage';

const LOCAL_MODEL_IDS = ['ideogram-4', 'minimax-h3'];

export default function SettingsScreen() {
  const { settings, setSettings, registry, toast, resetAll, ready } = useStudio();
  const [results, setResults] = useState({});
  const [testing, setTesting] = useState(null);
  // O relatório lê o localStorage, que não existe no servidor: calcular durante
  // o render faria o HTML do servidor divergir do primeiro render do cliente.
  const [report, setReport] = useState([]);

  useEffect(() => {
    setReport(storageReport());
  }, [ready, settings]);

  const test = async (providerId) => {
    setTesting(providerId);
    const provider = registry.get(providerId);
    const result = await provider.testConnection();
    setResults((current) => ({ ...current, [providerId]: result }));
    setTesting(null);
    toast(result.message, result.ok ? 'ok' : 'warn');
  };

  const setLocalModel = (id, patch) => {
    setSettings((current) => ({
      ...current,
      localModels: { ...current.localModels, [id]: { ...current.localModels?.[id], ...patch } },
    }));
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      {/* Modelos locais -------------------------------------------------------- */}
      <Panel className="space-y-4 p-5">
        <SectionTitle
          title="Modelos locais"
          subtitle="Execução na sua máquina. Nada é enviado para fora."
          action={<Badge tone="teal">Local</Badge>}
        />

        <Field
          label="ComfyUI — URL"
          hint="Endereço da instância. “Testar conexão” consulta o servidor de verdade: versão, fila, nó do MiniMax H3, os quatro arquivos de modelo e o workflow. Nenhum workflow existente é alterado."
        >
          <div className="flex gap-2">
            <Input
              value={settings.comfyUrl || ''}
              onChange={(event) => setSettings((c) => ({ ...c, comfyUrl: event.target.value }))}
              placeholder="http://127.0.0.1:8188"
              className="flex-1 font-mono"
            />
            <Button
              variant="secondary"
              icon="revise"
              onClick={() => test('comfyui')}
              disabled={testing === 'comfyui'}
            >
              {testing === 'comfyui' ? 'Verificando…' : 'Testar conexão'}
            </Button>
          </div>
        </Field>

        <TestResult result={results.comfyui} />

        <div className="space-y-2.5 pt-1">
          {LOCAL_MODEL_IDS.map((id) => {
            const model = ALL_MODELS.find((m) => m.id === id);
            const config = settings.localModels?.[id] || {};
            return (
              <div key={id} className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline bg-panel-2 p-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-hairline text-teal">
                  <Icon name={model.kind === 'video' ? 'video' : 'imagem'} size={17} />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[13px] font-medium text-chalk">
                    {model.name}
                    <Badge tone="teal">Local</Badge>
                    <Badge tone="ok">Disponível</Badge>
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-mist">{model.note}</p>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-[11.5px] text-mist">Habilitado</span>
                  <Toggle
                    checked={config.enabled !== false}
                    onChange={(value) => setLocalModel(id, { enabled: value })}
                    label={`Habilitar ${model.name}`}
                  />
                  <Button size="sm" variant="secondary" onClick={() => test('local')} disabled={testing === 'local'}>
                    Testar
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        <TestResult result={results.local} />

        <SimulationNote>
          Nenhum modelo é baixado ou instalado por esta tela. O MiniMax H3 já gera de verdade pela
          aba Cinema (texto → vídeo); o Ideogram 4 continua aguardando integração.
        </SimulationNote>
      </Panel>

      {/* Provedores por API ----------------------------------------------------- */}
      <Panel className="space-y-4 p-5">
        <SectionTitle
          title="Provedores por API"
          subtitle="Opcionais. A plataforma abre, navega e funciona sem nenhum deles."
          action={<Badge tone="gold">API</Badge>}
        />

        <div className="space-y-2.5">
          {API_VENDORS.map((vendor) => {
            const config = settings.apiProviders?.[vendor.id] || {};
            return (
              <div key={vendor.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-hairline bg-panel-2 p-3.5">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-hairline text-gold">
                  <Icon name="spark" size={17} />
                </span>

                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-[13px] font-medium text-chalk">
                    {vendor.label}
                    <Badge tone="gold">API</Badge>
                    {vendor.optional ? <Badge tone="neutral">opcional</Badge> : null}
                    {config.configured ? <Badge tone="ok">Configurado</Badge> : <Badge tone="neutral">Não configurado</Badge>}
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-mist">{vendor.vendor}</p>
                </div>

                <div className="flex items-center gap-2">
                  <div className="w-[230px] shrink-0">
                    <Input
                      disabled
                      value=""
                      placeholder="Credencial desabilitada nesta fase"
                      className="font-mono text-[11.5px]"
                      aria-label={`Credencial ${vendor.label}`}
                    />
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => test(vendor.id)} disabled={testing === vendor.id}>
                    Testar
                  </Button>
                </div>

                {results[vendor.id] ? (
                  <div className="w-full"><TestResult result={results[vendor.id]} /></div>
                ) : null}
              </div>
            );
          })}
        </div>

        <SimulationNote>
          Os campos de credencial estão desabilitados de propósito: esta fase não pede, não guarda
          e não usa chave nenhuma — inclusive a MuAPI, que é apenas opcional no futuro.
        </SimulationNote>
      </Panel>

      {/* Dados locais ----------------------------------------------------------- */}
      <Panel className="space-y-4 p-5">
        <SectionTitle title="Dados locais" subtitle="Tudo vive no localStorage deste navegador." />

        <ul className="grid gap-2 sm:grid-cols-2">
          {report.map((entry) => (
            <li key={entry.key} className="flex items-center justify-between gap-3 rounded-lg border border-hairline bg-panel-2 px-3 py-2">
              <span className="font-mono text-[11px] text-mist">{entry.key.replace('showrunner.', '')}</span>
              <span className={`text-[11px] ${entry.present ? 'text-chalk' : 'text-mist/50'}`}>
                {entry.present ? `${(entry.bytes / 1024).toFixed(1)} KB` : 'vazio'}
              </span>
            </li>
          ))}
          {!report.length ? (
            <li className="text-[12px] text-mist">Lendo o armazenamento local…</li>
          ) : null}
        </ul>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-4">
          <p className="text-[11.5px] text-mist">
            {Object.keys(KEYS).length} chaves usadas. Nenhum dado sai desta máquina.
          </p>
          <Button variant="danger" icon="revise" onClick={resetAll}>
            Restaurar dados de demonstração
          </Button>
        </div>
      </Panel>
    </div>
  );
}

function TestResult({ result }) {
  if (!result) return null;
  const tone = result.ok
    ? 'border-ok/30 bg-ok/[0.07] text-ok'
    : 'border-warn/30 bg-warn/[0.07] text-warn';

  return (
    <div className={`rounded-lg border px-3 py-2.5 text-[11.5px] leading-relaxed ${tone}`}>
      <span className="font-semibold uppercase tracking-wider">{result.status}</span> — {result.message}

      {/* Verificações item a item, quando o provider as devolve (ComfyUI). */}
      {Array.isArray(result.checks) && result.checks.length ? (
        <ul className="mt-2 space-y-1 border-t border-current/15 pt-2">
          {result.checks.map((check) => (
            <li key={check.nome} className="flex items-start gap-1.5">
              <span className="mt-[1px] shrink-0 opacity-90">
                <Icon name={check.ok ? 'check' : 'close'} size={11} />
              </span>
              <span className="min-w-0">
                <span className="font-medium">{check.nome}</span>
                {check.detalhe ? <span className="opacity-80"> — {check.detalhe}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <span className="mt-1.5 block text-[10.5px] opacity-80">
        {result.baseUrl ? `Servidor: ${result.baseUrl} · ` : ''}
        Requisição de rede executada: {result.performedRequest ? 'sim' : 'não'}.
      </span>
    </div>
  );
}
