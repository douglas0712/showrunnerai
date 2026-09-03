'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudio } from '../StudioContext';
import { Button, Panel, Textarea } from '../ui/primitives';
import { ImageFrame } from '../ui/MediaFrame';
import { RealVideoPlayer } from '../ui/RealVideoPlayer';
import { Icon } from '../ui/icons';
import {
  aplicarEvento, ensureThread, friendlyError, novaResposta, semUrlsJaExibidas, streamTurn,
} from '@/lib/agentClient';

/**
 * A conversa com o Showrunner.
 *
 * A tela não guarda a verdade da conversa: quem guarda é o servidor. O que
 * mora aqui é o que está acontecendo AGORA — a resposta chegando pedaço a
 * pedaço — e ao recarregar tudo é relido da thread real. Antes desta etapa o
 * agente era uma máquina de estados local; nenhuma parte dela sobrou.
 */
export default function AgentScreen() {
  const { activeProject, activeProjectId, toast, handoff, setHandoff } = useStudio();

  const [threadId, setThreadId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [emCurso, setEmCurso] = useState(null);
  const [carregando, setCarregando] = useState(true);
  const [erroDeAbertura, setErroDeAbertura] = useState(null);
  const [semProjeto, setSemProjeto] = useState(false);
  const [draft, setDraft] = useState('');

  const bottomRef = useRef(null);
  const abortRef = useRef(null);
  // Guarda contra duplo envio: o estado do React chega tarde demais para
  // barrar dois cliques seguidos, ou um Enter que repete.
  const enviandoRef = useRef(false);

  // ── abrir a conversa ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelado = false;

    (async () => {
      try {
        // A chave é POR PROJETO: cada produção tem a própria conversa, e
        // voltar a um projeto volta à conversa dele. Uma chave única faria a
        // troca de projeto herdar a conversa anterior.
        const chave = `showrunner.agent.threadId.${activeProjectId || 'sem-projeto'}`;
        const salvo = typeof window !== 'undefined'
          ? window.localStorage.getItem(chave)
          : null;

        // O descritor do projeto em que o usuário está. É com ele que o
        // servidor registra o projeto, se ainda não o conhecer.
        const descritor = activeProject
          ? {
            id: activeProject.id,
            name: activeProject.name,
            description: activeProject.description || '',
            aspect: activeProject.aspect || undefined,
          }
          : null;

        const { thread, messages: historico } = await ensureThread({
          threadId: salvo,
          project: descritor,
        });

        if (cancelado) return;

        setThreadId(thread.id);
        setSemProjeto(!thread.projectId);
        setMessages(historico.map(paraTela));
        if (typeof window !== 'undefined') {
          window.localStorage.setItem(chave, thread.id);
        }
      } catch (falha) {
        if (!cancelado) setErroDeAbertura(friendlyError(falha));
      } finally {
        if (!cancelado) setCarregando(false);
      }
    })();

    return () => { cancelado = true; };
    // Trocar de projeto abre outra conversa — é o comportamento que a tela
    // sempre teve, e o servidor é quem decide se o projeto existe.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProjectId, activeProject]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, emCurso?.text, emCurso?.activity?.length]);

  const enviar = useCallback(async (texto) => {
    const content = String(texto ?? '').trim();
    if (!content || enviandoRef.current || !threadId) return;

    enviandoRef.current = true;
    setDraft('');

    setMessages((atuais) => [...atuais, {
      id: `local_${Date.now()}`,
      role: 'user',
      text: content,
      createdAt: Date.now(),
      media: [],
      activity: [],
    }]);

    let resposta = novaResposta(`resp_${Date.now()}`);
    setEmCurso(resposta);

    const controlador = new AbortController();
    abortRef.current = controlador;

    try {
      await streamTurn({
        threadId,
        content,
        signal: controlador.signal,
        onEvent: (evento) => {
          resposta = aplicarEvento(resposta, evento);
          setEmCurso(resposta);
        },
      });
    } catch (falha) {
      // Abortar é escolha do usuário, não erro a exibir.
      if (falha?.name !== 'AbortError') {
        resposta = { ...resposta, status: 'failed', error: { message: friendlyError(falha) } };
      } else {
        resposta = { ...resposta, status: 'cancelled' };
      }
    } finally {
      abortRef.current = null;
      enviandoRef.current = false;

      // A resposta em curso vira mensagem da conversa — a menos que tenha sido
      // cancelada sem nada dito, caso em que não há o que guardar.
      const vazia = !resposta.text && !resposta.media.length && !resposta.error;
      setEmCurso(null);
      if (!vazia) setMessages((atuais) => [...atuais, resposta]);
    }
  }, [threadId]);

  // Ideia trazida de outra tela entra como primeira fala.
  useEffect(() => {
    if (handoff?.target !== 'agente' || !threadId) return;
    const idea = handoff.payload?.idea;
    setHandoff(null);
    if (idea) enviar(idea);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff, threadId]);

  const cancelar = () => {
    abortRef.current?.abort();
    toast('Resposta interrompida.', 'info');
  };

  const emAndamento = Boolean(emCurso);

  return (
    <div className="grid gap-5">
      <Panel className="flex h-[calc(100vh-190px)] min-h-[520px] flex-col overflow-hidden p-0">
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-gold/30 bg-gold/10 text-gold">
              <Icon name="agente" size={17} />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-chalk">Showrunner</p>
              <p className="text-[11px] text-mist">
                {semProjeto
                  ? 'Conversa aberta — escolha um projeto para poder gerar mídia'
                  : 'Conversa e produção no mesmo lugar'}
              </p>
            </div>
          </div>
          {emAndamento ? (
            <Button size="sm" variant="ghost" icon="close" onClick={cancelar}>
              Parar
            </Button>
          ) : null}
        </header>

        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto px-4 py-5">
          {carregando ? (
            <p className="pl-11 text-[12px] text-mist">Abrindo a conversa…</p>
          ) : null}

          {erroDeAbertura ? (
            <p className="pl-11 text-[12px] text-danger">{erroDeAbertura}</p>
          ) : null}

          {!carregando && !erroDeAbertura && messages.length === 0 && !emCurso ? (
            <p className="pl-11 text-[12px] text-mist">
              Conte o que você quer produzir. Eu conduzo daqui.
            </p>
          ) : null}

          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}

          {emCurso ? <Message message={emCurso} emCurso /> : null}

          <div ref={bottomRef} />
        </div>

        <footer className="border-t border-hairline p-3">
          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  enviar(draft);
                }
              }}
              placeholder="Fale com o Showrunner…  (Enter envia, Shift+Enter quebra linha)"
              className="flex-1"
              disabled={carregando || Boolean(erroDeAbertura)}
            />
            <Button
              variant="primary"
              icon="send"
              onClick={() => enviar(draft)}
              disabled={emAndamento || carregando || !draft.trim()}
            >
              Enviar
            </Button>
          </div>
        </footer>
      </Panel>
    </div>
  );
}

/** Uma mensagem da conversa: texto, o que está sendo feito, e a mídia. */
function Message({ message, emCurso = false }) {
  const isAgent = message.role !== 'user';
  const activity = message.activity || [];
  const media = message.media || [];

  return (
    <div className={`fade-up flex gap-2.5 ${isAgent ? '' : 'flex-row-reverse'}`}>
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border ${
          isAgent ? 'border-gold/30 bg-gold/10 text-gold' : 'border-hairline bg-white/[0.06] text-mist'
        }`}
      >
        <Icon name={isAgent ? 'agente' : 'personagens'} size={15} />
      </span>

      <div className={`min-w-0 max-w-[min(680px,86%)] ${isAgent ? '' : 'items-end'}`}>
        {message.text ? (
          <div
            className={`whitespace-pre-wrap rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed ${
              isAgent ? 'border-hairline bg-panel-2 text-chalk' : 'border-gold/25 bg-gold/[0.08] text-chalk'
            }`}
          >
            {message.text}
          </div>
        ) : null}

        {/* O que a produção está fazendo — em linguagem de produção. */}
        {activity.length ? (
          <ul className="mt-2 space-y-1">
            {activity.map((item) => (
              <li key={item.id} className="flex items-center gap-2 text-[11.5px] text-mist">
                <span className={
                  item.state === 'done' ? 'text-ok'
                    : item.state === 'failed' ? 'text-danger' : 'text-gold'
                }>
                  <Icon
                    name={item.state === 'done' ? 'check' : item.state === 'failed' ? 'close' : 'spark'}
                    size={12}
                  />
                </span>
                <span className={item.state === 'running' ? 'pulse-soft' : ''}>{item.label}</span>
              </li>
            ))}
          </ul>
        ) : null}

        {emCurso && !message.text && !activity.length ? (
          <p className="text-[12px] text-mist">
            <span className="pulse-soft">{message.statusLabel || 'Pensando…'}</span>
          </p>
        ) : null}

        {media.length ? (
          <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
            {media.map((item) => (
              <div key={item.assetId} className="overflow-hidden rounded-xl border border-hairline bg-panel/70">
                {item.kind === 'video' ? (
                  <RealVideoPlayer src={item.mediaUrl} aspect="16:9" className="rounded-none border-0" />
                ) : (
                  <ImageFrame
                    src={item.mediaUrl}
                    alt="Resultado da produção"
                    aspect="16:9"
                    className="rounded-none border-0"
                  />
                )}
              </div>
            ))}
          </div>
        ) : null}

        {message.error ? (
          <p className="mt-2 rounded-lg border border-danger/30 bg-danger/[0.08] px-3 py-2 text-[12px] text-danger">
            {message.error.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Uma mensagem vinda do servidor no formato da tela.
 *
 * A mídia volta pela referência que a mensagem guarda — o servidor resolve o
 * Asset e manda `assets`. A URL não é reconstruída aqui, nem lida do texto:
 * ela vem do Asset, que é o dono dela.
 *
 * A limpeza do texto usa a MESMA função do turno ao vivo, de propósito: a
 * resposta precisa parecer igual antes e depois de recarregar, e duas
 * implementações da mesma regra divergiriam na primeira mudança.
 *
 * A atividade não volta: ela descreve o que estava acontecendo, e o que estava
 * acontecendo já aconteceu. Reconstruí-la seria encenar um trabalho que
 * terminou.
 */
function paraTela(registro) {
  const media = Array.isArray(registro.assets) ? registro.assets : [];
  return {
    id: registro.id,
    role: registro.role === 'user' ? 'user' : 'agent',
    text: semUrlsJaExibidas(registro.content || '', media),
    createdAt: registro.createdAt,
    activity: [],
    media,
    error: null,
  };
}
