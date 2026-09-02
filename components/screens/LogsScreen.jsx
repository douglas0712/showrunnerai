'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStudio } from '../StudioContext';
import { Badge, Button, Empty, Panel, SectionTitle, Select } from '../ui/primitives';
import { Icon } from '../ui/icons';
import {
  baixarJson, checkConnection, copiarTexto, fetchJobs, fetchLogs, formatarTexto,
  refinalizarJob, ressubmeterJob,
} from '@/lib/logsClient';

/** Os quatro filtros pedidos. `nivel: null` significa "todos". */
const FILTROS = [
  { id: 'todos', label: 'Todos', nivel: null },
  { id: 'info', label: 'Informações', nivel: 'INFO' },
  { id: 'avisos', label: 'Avisos', nivel: 'AVISO' },
  { id: 'erros', label: 'Erros', nivel: 'ERRO' },
];

const TOM_POR_NIVEL = { INFO: 'neutral', AVISO: 'warn', ERRO: 'alert' };

/** Intervalo do polling. O buffer é lido por cursor, então isto é barato. */
const INTERVALO_MS = 2500;

export default function LogsScreen({ navigate }) {
  const { toast, handoff, setHandoff } = useStudio();

  const [eventos, setEventos] = useState([]);
  const [cursor, setCursor] = useState(0);
  const [stats, setStats] = useState(null);
  const [filtro, setFiltro] = useState('todos');
  const [jobSelecionado, setJobSelecionado] = useState('');
  const [conexao, setConexao] = useState({ estado: 'verificando', message: '', checks: [] });
  const [jobs, setJobs] = useState([]);
  const [carregando, setCarregando] = useState(false);
  const [tentando, setTentando] = useState(false);
  const [erroDeLeitura, setErroDeLeitura] = useState(null);

  // "Limpar visualização" é só da tela: esconde o que veio antes deste seq sem
  // apagar nada no servidor nem no arquivo.
  const [ocultarAte, setOcultarAte] = useState(0);

  const timerRef = useRef(null);
  const cursorRef = useRef(0);
  cursorRef.current = cursor;

  // ── chegada pela Cinema: "Ver logs desta geração" ─────────────────────────
  useEffect(() => {
    if (handoff?.target !== 'logs') return;
    if (handoff.payload?.jobId) setJobSelecionado(handoff.payload.jobId);
    setHandoff(null);
  }, [handoff, setHandoff]);

  const verificarConexao = useCallback(async () => {
    setConexao((atual) => ({ ...atual, estado: 'verificando' }));
    try {
      const resultado = await checkConnection();
      setConexao({
        estado: resultado.ok ? 'conectado' : 'desconectado',
        message: resultado.message,
        baseUrl: resultado.baseUrl,
        checks: resultado.checks,
      });
    } catch (error) {
      setConexao({ estado: 'desconectado', message: error.message, checks: [] });
    }
  }, []);

  /** Busca incremental: `reiniciar` refaz a leitura do zero. */
  const buscar = useCallback(async (reiniciar = false) => {
    try {
      const desde = reiniciar ? 0 : cursorRef.current;
      const dados = await fetchLogs({ since: desde });
      setErroDeLeitura(null);
      setStats(dados.stats || null);
      setCursor(dados.cursor || desde);
      setEventos((atuais) => {
        const base = reiniciar ? [] : atuais;
        if (!dados.events?.length) return base;
        // O servidor já devolve só o que é novo; a chave evita duplicar quando
        // duas buscas se cruzam.
        const conhecidos = new Set(base.map((e) => e.seq));
        const novos = dados.events.filter((e) => !conhecidos.has(e.seq));
        return [...base, ...novos];
      });
    } catch (error) {
      setErroDeLeitura(error.message);
    }
  }, []);

  const atualizar = useCallback(async () => {
    setCarregando(true);
    await Promise.all([
      buscar(true),
      verificarConexao(),
      fetchJobs().then((d) => setJobs(d.jobs || [])).catch(() => {}),
    ]);
    setCarregando(false);
  }, [buscar, verificarConexao]);

  useEffect(() => {
    atualizar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Polling do buffer. A conexão não entra aqui: a verificação é cara (cinco
  // requisições ao ComfyUI) e só faz sentido sob demanda.
  useEffect(() => {
    const laco = () => {
      timerRef.current = setTimeout(async () => {
        await buscar(false);
        laco();
      }, INTERVALO_MS);
    };
    laco();
    return () => clearTimeout(timerRef.current);
  }, [buscar]);

  // ── recorte exibido ───────────────────────────────────────────────────────
  const nivelDoFiltro = FILTROS.find((f) => f.id === filtro)?.nivel || null;

  const visiveis = useMemo(() => eventos.filter((e) => {
    if (e.seq <= ocultarAte) return false;
    if (jobSelecionado && e.jobId !== jobSelecionado) return false;
    if (nivelDoFiltro && e.level !== nivelDoFiltro) return false;
    return true;
  }), [eventos, ocultarAte, jobSelecionado, nivelDoFiltro]);

  const contagem = useMemo(() => {
    const base = eventos.filter((e) => e.seq > ocultarAte && (!jobSelecionado || e.jobId === jobSelecionado));
    return {
      todos: base.length,
      info: base.filter((e) => e.level === 'INFO').length,
      avisos: base.filter((e) => e.level === 'AVISO').length,
      erros: base.filter((e) => e.level === 'ERRO').length,
    };
  }, [eventos, ocultarAte, jobSelecionado]);

  /** Jobs que aparecem no log, mais recentes primeiro. */
  const jobsNoLog = useMemo(() => {
    const vistos = new Map();
    for (const e of eventos) {
      if (!e.jobId) continue;
      if (!vistos.has(e.jobId)) vistos.set(e.jobId, e.tsMs);
    }
    return [...vistos.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }, [eventos]);

  /**
   * Retentativa contextual.
   *
   * Se a falha veio depois de o vídeo já existir no ComfyUI, tentar de novo é
   * copiar o arquivo — não ocupar a GPU por mais cinco minutos para produzir o
   * mesmo resultado. `retryKind` vem do servidor junto com o evento de erro.
   */
  const ultimoErro = useMemo(() => {
    for (let i = visiveis.length - 1; i >= 0; i -= 1) {
      if (visiveis[i].level === 'ERRO' && visiveis[i].jobId && visiveis[i].retryKind) return visiveis[i];
    }
    return null;
  }, [visiveis]);

  const jobDoErro = ultimoErro ? jobs.find((j) => j.jobId === ultimoErro.jobId) || null : null;
  const podeRessubmeter = Boolean(jobDoErro?.prompt);
  const retryDisponivel = ultimoErro
    && (ultimoErro.retryKind === 'refinalizar' || podeRessubmeter);

  const tentarNovamente = async () => {
    if (!ultimoErro) return;
    setTentando(true);
    try {
      if (ultimoErro.retryKind === 'refinalizar') {
        await refinalizarJob(ultimoErro.jobId);
        toast('Cópia do vídeo refeita a partir do ComfyUI.', 'ok');
      } else {
        const novo = await ressubmeterJob(jobDoErro);
        setJobSelecionado(novo.jobId);
        toast(`Nova geração enviada — job ${novo.jobId}.`, 'ok');
      }
      await buscar(false);
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      setTentando(false);
    }
  };

  const copiar = async () => {
    const ok = await copiarTexto(formatarTexto(visiveis));
    toast(ok ? `${visiveis.length} linha(s) copiada(s).` : 'O navegador recusou o acesso à área de transferência.', ok ? 'ok' : 'warn');
  };

  const baixar = () => {
    const agora = new Date().toISOString().replace(/[:.]/g, '-');
    baixarJson(`showrunner-logs-${jobSelecionado || 'todos'}-${agora}.json`, {
      geradoEm: new Date().toISOString(),
      filtro: { nivel: nivelDoFiltro, jobId: jobSelecionado || null },
      conexao: { estado: conexao.estado, baseUrl: conexao.baseUrl || null },
      stats,
      eventos: visiveis,
    });
    toast(`${visiveis.length} evento(s) salvos em JSON.`, 'ok');
  };

  return (
    <div className="space-y-4">
      <IndicadorDeConexao conexao={conexao} onVerificar={verificarConexao} />

      <Panel className="space-y-4 p-4">
        <SectionTitle
          title="Eventos da geração"
          subtitle="Registrados pelo servidor durante a geração real. Nada aqui é simulado."
          action={stats ? (
            <span className="font-mono text-[10.5px] text-mist">
              {stats.total}/{stats.capacidade} no buffer
              {stats.descartados ? ` · ${stats.descartados} rotacionados` : ''}
            </span>
          ) : null}
        />

        {/* Filtros e recorte por job ---------------------------------------- */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-hairline bg-panel-2 p-1">
            {FILTROS.map((item) => {
              const ativo = item.id === filtro;
              const quantos = contagem[item.id];
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setFiltro(item.id)}
                  className={`pressable focus-ring rounded-md px-3 py-1.5 text-[12px] font-medium ${
                    ativo ? 'bg-gold text-ink' : 'text-mist hover:text-chalk'
                  }`}
                >
                  {item.label}
                  <span className={`ml-1.5 font-mono text-[10px] ${ativo ? 'text-ink/70' : 'text-mist/60'}`}>
                    {quantos}
                  </span>
                </button>
              );
            })}
          </div>

          <Select
            value={jobSelecionado}
            onChange={(e) => setJobSelecionado(e.target.value)}
            className="w-auto min-w-[210px] flex-none"
          >
            <option value="">Todos os jobs</option>
            {jobsNoLog.map((id) => <option key={id} value={id}>{id}</option>)}
          </Select>
        </div>

        {/* Botões ------------------------------------------------------------ */}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" icon="revise" onClick={atualizar} disabled={carregando}>
            {carregando ? 'Atualizando…' : 'Atualizar'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="close"
            onClick={() => { setOcultarAte(cursor); toast('Visualização limpa. O histórico no servidor foi mantido.', 'ok'); }}
            disabled={!visiveis.length}
          >
            Limpar visualização
          </Button>
          <Button size="sm" variant="ghost" icon="compare" onClick={copiar} disabled={!visiveis.length}>
            Copiar logs
          </Button>
          <Button size="sm" variant="ghost" icon="download" onClick={baixar} disabled={!visiveis.length}>
            Baixar logs em JSON
          </Button>
          {retryDisponivel ? (
            <Button size="sm" variant="primary" icon="spark" onClick={tentarNovamente} disabled={tentando}>
              {tentando
                ? 'Tentando…'
                : ultimoErro.retryKind === 'refinalizar'
                  ? 'Tentar novamente (copiar o vídeo)'
                  : 'Tentar novamente (gerar de novo)'}
            </Button>
          ) : null}
        </div>

        {ocultarAte ? (
          <button
            type="button"
            onClick={() => setOcultarAte(0)}
            className="focus-ring text-[11.5px] text-mist underline decoration-dotted hover:text-chalk"
          >
            Mostrar novamente os eventos ocultados
          </button>
        ) : null}

        {erroDeLeitura ? (
          <p className="rounded-lg border border-danger/30 bg-danger/[0.07] px-3 py-2 text-[11.5px] text-danger/90">
            Não foi possível ler os eventos do servidor: {erroDeLeitura}
          </p>
        ) : null}

        {/* Lista cronológica -------------------------------------------------- */}
        {visiveis.length ? (
          <ol className="space-y-1.5">
            {visiveis.map((evento) => <LinhaDeEvento key={evento.seq} evento={evento} />)}
          </ol>
        ) : (
          <Empty
            icon="video"
            title={eventos.length ? 'Nenhum evento neste filtro.' : 'Nenhum evento registrado ainda.'}
            hint={
              eventos.length
                ? 'Troque o filtro ou escolha outro job.'
                : 'Gere um vídeo na aba Cinema com o motor ComfyUI: cada etapa aparece aqui, do envio à publicação no player.'
            }
            action={
              eventos.length ? null : (
                <Button size="sm" variant="secondary" icon="cinema" onClick={() => navigate('cinema')}>
                  Abrir o Cinema
                </Button>
              )
            }
          />
        )}
      </Panel>

      <p className="px-1 text-[11px] leading-relaxed text-mist/70">
        Chaves de API, tokens, cookies e cabeçalhos de autenticação nunca são gravados: os
        detalhes técnicos passam por sanitização antes de entrar no log. O histórico fica
        limitado às últimas {stats?.capacidade || 500} entradas, com rotação automática que
        preserva os erros mais recentes, e é espelhado em <code className="font-mono">runtime/logs/</code>.
      </p>
    </div>
  );
}

/** Indicador de conexão com o ComfyUI: conectado, desconectado ou verificando. */
function IndicadorDeConexao({ conexao, onVerificar }) {
  const { estado } = conexao;

  const visual = {
    conectado: { tom: 'ok', texto: 'Conectado', cor: 'bg-ok', pulso: false },
    desconectado: { tom: 'alert', texto: 'Desconectado', cor: 'bg-danger', pulso: false },
    verificando: { tom: 'warn', texto: 'Verificando', cor: 'bg-warn', pulso: true },
  }[estado] || { tom: 'neutral', texto: estado, cor: 'bg-mist', pulso: false };

  const reprovados = (conexao.checks || []).filter((c) => !c.ok);

  return (
    <Panel className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${visual.cor} ${visual.pulso ? 'pulse-soft' : ''}`} />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-semibold text-chalk">ComfyUI</span>
              <Badge tone={visual.tom}>{visual.texto}</Badge>
            </div>
            <p className="truncate text-[11.5px] text-mist">
              {conexao.message || 'Consultando o servidor da aplicação…'}
              {conexao.baseUrl ? <span className="font-mono"> · {conexao.baseUrl}</span> : null}
            </p>
          </div>
        </div>

        <Button size="sm" variant="secondary" icon="revise" onClick={onVerificar} disabled={estado === 'verificando'}>
          Verificar conexão
        </Button>
      </div>

      {conexao.checks?.length ? (
        <details className="rounded-lg border border-hairline bg-panel-2 px-3 py-2">
          <summary className="cursor-pointer text-[11.5px] font-medium text-mist hover:text-chalk">
            Verificações {reprovados.length ? `· ${reprovados.length} reprovada(s)` : '· todas aprovadas'}
          </summary>
          <ul className="mt-2 space-y-1">
            {conexao.checks.map((check) => (
              <li key={check.nome} className="flex items-start gap-2 text-[11.5px]">
                <span className={`mt-[2px] shrink-0 ${check.ok ? 'text-ok' : 'text-danger'}`}>
                  <Icon name={check.ok ? 'check' : 'close'} size={12} />
                </span>
                <span className="min-w-0">
                  <span className="text-chalk">{check.nome}</span>
                  {check.detalhe ? <span className="text-mist"> — {check.detalhe}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </Panel>
  );
}

/** Uma linha do log, com os detalhes técnicos dobrados. */
function LinhaDeEvento({ evento }) {
  const erro = evento.level === 'ERRO';
  const aviso = evento.level === 'AVISO';

  const borda = erro ? 'border-danger/30 bg-danger/[0.05]'
    : aviso ? 'border-warn/25 bg-warn/[0.04]'
      : 'border-hairline bg-panel-2';

  const temDetalhe = evento.detail && Object.keys(evento.detail).length > 0;

  return (
    <li className={`rounded-lg border px-3 py-2 ${borda}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <time className="font-mono text-[10.5px] text-mist/70" dateTime={evento.ts}>
          {new Date(evento.tsMs || evento.ts).toLocaleTimeString('pt-BR')}
        </time>
        <Badge tone={TOM_POR_NIVEL[evento.level] || 'neutral'}>{evento.level}</Badge>
        <span className="font-mono text-[10.5px] uppercase tracking-wider text-mist">
          {evento.stage}
        </span>
        <span className="text-[9.5px] text-mist/60">{evento.stageLabel}</span>
      </div>

      <p className={`mt-1 text-[12.5px] leading-relaxed ${erro ? 'text-danger/95' : 'text-chalk'}`}>
        {evento.message}
      </p>

      {/* Explicação em linguagem de usuário; o técnico fica na seção dobrável. */}
      {evento.userHint ? (
        <p className="mt-1 text-[11.5px] leading-relaxed text-mist">{evento.userHint}</p>
      ) : null}

      <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-mist/65">
        {evento.jobId ? <span>job {evento.jobId}</span> : null}
        {evento.promptId ? <span>prompt_id {evento.promptId}</span> : null}
        {evento.workflow ? <span>workflow {evento.workflow}</span> : null}
        <span>#{evento.seq}</span>
      </div>

      {temDetalhe ? (
        <details className="mt-2 border-t border-hairline pt-2">
          <summary className="cursor-pointer text-[11px] font-medium text-mist hover:text-chalk">
            Detalhes técnicos
          </summary>
          <DetalhesTecnicos detail={evento.detail} />
        </details>
      ) : null}
    </li>
  );
}

function DetalhesTecnicos({ detail }) {
  const { http, stack, durationMs, tentativas, ...resto } = detail;
  const semHttp = { ...resto };

  return (
    <div className="mt-2 space-y-2">
      {http ? (
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            <span className="rounded border border-hairline px-1.5 py-0.5 text-chalk">{http.method || 'GET'}</span>
            <span className="min-w-0 break-all text-mist">{http.path}</span>
            {http.status != null ? (
              <span className={http.status >= 400 ? 'text-danger' : 'text-ok'}>HTTP {http.status}</span>
            ) : (
              <span className="text-danger">sem resposta</span>
            )}
            {http.durationMs != null ? <span className="text-mist/70">{http.durationMs} ms</span> : null}
          </div>

          {http.request ? <Bloco titulo="Payload enviado (sanitizado)" valor={http.request} /> : null}
          {http.response ? <Bloco titulo="Resposta recebida (sanitizada)" valor={http.response} /> : null}
          {http.error ? <Bloco titulo="Erro do transporte" valor={http.error} /> : null}
        </div>
      ) : null}

      <dl className="grid grid-cols-2 gap-2 font-mono text-[10.5px] sm:grid-cols-4">
        {durationMs != null ? <Metrica termo="Duração" valor={`${durationMs} ms`} /> : null}
        {tentativas != null ? <Metrica termo="Tentativas" valor={String(tentativas)} /> : null}
        {semHttp.tentativa != null ? <Metrica termo="Tentativa" valor={String(semHttp.tentativa)} /> : null}
        {semHttp.bytes != null ? <Metrica termo="Bytes" valor={String(semHttp.bytes)} /> : null}
      </dl>

      {Object.keys(semHttp).length ? <Bloco titulo="Contexto" valor={semHttp} /> : null}
      {stack ? <Bloco titulo="Stack trace" valor={stack} /> : null}
    </div>
  );
}

function Metrica({ termo, valor }) {
  return (
    <div className="min-w-0">
      <dt className="text-[9.5px] uppercase tracking-wider text-mist/70">{termo}</dt>
      <dd className="truncate text-chalk">{valor}</dd>
    </div>
  );
}

function Bloco({ titulo, valor }) {
  const texto = typeof valor === 'string' ? valor : JSON.stringify(valor, null, 2);
  return (
    <div>
      <p className="text-[9.5px] uppercase tracking-wider text-mist/70">{titulo}</p>
      <pre className="scroll-thin mt-0.5 max-h-56 overflow-auto rounded border border-hairline bg-ink/60 p-2 font-mono text-[10.5px] leading-relaxed text-mist">
        {texto}
      </pre>
    </div>
  );
}
