'use client';

import { useEffect, useRef, useState } from 'react';
import { useStudio } from '../StudioContext';
import { Badge, Button, Panel, SimulationNote, Textarea } from '../ui/primitives';
import { ImageFrame, VideoFrame } from '../ui/MediaFrame';
import { ResultActions, StatusPill } from '../ResultActions';
import { Icon } from '../ui/icons';
import {
  BRIEFING_FIELDS, briefingProgress, currentSuggestions, initialAgentState, respond,
} from '@/lib/agentScript';
import { placeholderFrame } from '@/lib/placeholder';
import { makeId, randomSeed } from '@/lib/rng';
import { demoConversation } from '@/lib/demoData';

export default function AgentScreen({ navigate }) {
  const {
    conversation, setConversation, generations, addGenerations, toast, handoff, setHandoff,
  } = useStudio();
  const [draft, setDraft] = useState('');
  const [thinking, setThinking] = useState(false);
  const bottomRef = useRef(null);

  const messages = conversation.messages || [];
  const agentState = conversation.agent || initialAgentState();
  const progress = briefingProgress(agentState.briefing);
  const suggestions = currentSuggestions(agentState);

  // Ideia trazida da Início / Criar entra como primeira resposta do usuário.
  useEffect(() => {
    if (handoff?.target !== 'agente') return;
    const idea = handoff.payload?.idea;
    setHandoff(null);
    if (idea) send(idea);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length, thinking]);

  /** Cria as entregas simuladas que o agente anexa ao fechar o briefing. */
  const buildAttachments = (kinds, briefing) => {
    const prompt = [briefing.tema, briefing.tom].filter(Boolean).join(', ') || 'proposta de abertura';
    const seed = randomSeed();

    return kinds.map((kind) => {
      if (kind === 'video') {
        return {
          id: makeId('vid'),
          kind: 'video',
          simulated: true,
          providerId: 'mock',
          intendedProviderId: 'local',
          modelId: 'minimax-h3',
          prompt: `Plano de abertura — ${prompt}`,
          aspect: '16:9',
          resolution: '1080p',
          duration: 6,
          fps: 24,
          audio: false,
          mode: 't2v',
          seed,
          status: 'pendente',
          revisionNote: '',
          createdAt: Date.now(),
          poster: placeholderFrame({ seed, prompt, aspect: '16:9', kind: 'video', label: 'SIMULAÇÃO' }),
          frames: Array.from({ length: 8 }, (_, i) =>
            placeholderFrame({ seed, prompt, aspect: '16:9', kind: 'video', label: 'SIMULAÇÃO', frame: i / 7 }),
          ),
        };
      }
      return {
        id: makeId('img'),
        kind: 'image',
        simulated: true,
        providerId: 'mock',
        intendedProviderId: 'local',
        modelId: 'ideogram-4',
        prompt: `Quadro-chave — ${prompt}`,
        aspect: '16:9',
        resolution: '2K',
        seed: seed + 1,
        status: 'pendente',
        revisionNote: '',
        createdAt: Date.now(),
        url: placeholderFrame({ seed: seed + 1, prompt, aspect: '16:9', kind: 'image', label: 'SIMULAÇÃO' }),
      };
    });
  };

  const send = (text) => {
    const content = String(text ?? draft).trim();
    if (!content || thinking) return;

    const userMessage = {
      id: makeId('msg'),
      role: 'user',
      text: content,
      createdAt: Date.now(),
      attachments: [],
    };

    setConversation((current) => ({ ...current, messages: [...current.messages, userMessage] }));
    setDraft('');
    setThinking(true);

    // Resposta simulada e local — nenhuma LLM é chamada.
    setTimeout(() => {
      setConversation((current) => {
        const state = current.agent || initialAgentState();
        const result = respond(state, content);
        const items = result.attachments.length
          ? buildAttachments(result.attachments, result.state.briefing)
          : [];

        if (items.length) addGenerations(items);

        return {
          agent: result.state,
          messages: [
            ...current.messages,
            {
              id: makeId('msg'),
              role: 'agent',
              text: result.reply,
              createdAt: Date.now(),
              attachments: items.map((item) => item.id),
            },
          ],
        };
      });
      setThinking(false);
    }, 700);
  };

  const reset = () => {
    setConversation({ messages: demoConversation(), agent: initialAgentState() });
    toast('Conversa reiniciada.', 'info');
  };

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,330px)]">
      {/* Conversa -------------------------------------------------------------- */}
      <Panel className="flex h-[calc(100vh-190px)] min-h-[520px] flex-col overflow-hidden p-0">
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-gold/30 bg-gold/10 text-gold">
              <Icon name="agente" size={17} />
            </span>
            <div>
              <p className="text-[13px] font-semibold text-chalk">Agente de produção</p>
              <p className="text-[11px] text-mist">Entrevista você e monta o briefing</p>
            </div>
          </div>
          <Button size="sm" variant="ghost" icon="revise" onClick={reset}>
            Reiniciar
          </Button>
        </header>

        <div className="scroll-thin flex-1 space-y-4 overflow-y-auto px-4 py-5">
          {messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              generations={generations}
              navigate={navigate}
            />
          ))}

          {thinking ? (
            <div className="flex items-center gap-2 pl-11 text-[12px] text-mist">
              <span className="pulse-soft">O agente está formulando a próxima pergunta…</span>
            </div>
          ) : null}

          <div ref={bottomRef} />
        </div>

        {suggestions.length ? (
          <div className="flex flex-wrap gap-1.5 border-t border-hairline px-4 py-2.5">
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                type="button"
                onClick={() => send(suggestion)}
                className="pressable focus-ring rounded-full border border-hairline bg-white/[0.05] px-3 py-1 text-[11.5px] text-mist hover:border-gold/40 hover:text-chalk"
              >
                {suggestion}
              </button>
            ))}
          </div>
        ) : null}

        <footer className="border-t border-hairline p-3">
          <div className="flex items-end gap-2">
            <Textarea
              rows={2}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  send();
                }
              }}
              placeholder="Responda ao agente…  (Enter envia, Shift+Enter quebra linha)"
              className="flex-1"
            />
            <Button variant="primary" icon="send" onClick={() => send()} disabled={thinking || !draft.trim()}>
              Enviar
            </Button>
          </div>
        </footer>
      </Panel>

      {/* Briefing --------------------------------------------------------------- */}
      <div className="space-y-4">
        <Panel className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-[13px] font-semibold text-chalk">Briefing em construção</h3>
            <Badge tone={progress.percent === 100 ? 'ok' : 'gold'}>{progress.percent}%</Badge>
          </div>

          <div className="mb-4 h-1.5 overflow-hidden rounded-full bg-hairline">
            <div
              className="h-full rounded-full bg-gold transition-all duration-500"
              style={{ width: `${progress.percent}%` }}
            />
          </div>

          <ul className="space-y-2.5">
            {BRIEFING_FIELDS.map((field) => {
              const value = agentState.briefing?.[field.key];
              return (
                <li key={field.key} className="flex gap-2.5">
                  <span className={`mt-0.5 shrink-0 ${value ? 'text-ok' : 'text-mist/40'}`}>
                    <Icon name={value ? 'check' : 'plus'} size={13} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10.5px] uppercase tracking-wider text-mist">{field.label}</span>
                    <span className={`block text-[12.5px] leading-snug ${value ? 'text-chalk' : 'text-mist/50'}`}>
                      {value || 'aguardando'}
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>

          {progress.percent === 100 ? (
            <Button
              variant="primary"
              icon="storyboard"
              className="mt-4 w-full"
              onClick={() => navigate('storyboard')}
            >
              Levar para o storyboard
            </Button>
          ) : null}
        </Panel>

        <SimulationNote>
          O agente é uma máquina de estados local. Nenhuma LLM é chamada e nenhum texto sai desta
          máquina nesta fase.
        </SimulationNote>
      </div>
    </div>
  );
}

function Message({ message, generations, navigate }) {
  const isAgent = message.role === 'agent';
  const attachments = (message.attachments || [])
    .map((id) => generations.find((item) => item.id === id))
    .filter(Boolean);

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
        <div
          className={`rounded-xl border px-3.5 py-2.5 text-[13px] leading-relaxed ${
            isAgent ? 'border-hairline bg-panel-2 text-chalk' : 'border-gold/25 bg-gold/[0.08] text-chalk'
          }`}
        >
          {message.text}
        </div>

        {attachments.length ? (
          <div className="mt-2.5 grid gap-3 sm:grid-cols-2">
            {attachments.map((item) => (
              <div key={item.id} className="overflow-hidden rounded-xl border border-hairline bg-panel/70">
                {item.kind === 'video' ? (
                  <VideoFrame item={item} aspect="16:9" className="rounded-none border-0 border-b border-hairline" compact />
                ) : (
                  <ImageFrame src={item.url} alt={item.prompt} aspect="16:9" className="rounded-none border-0 border-b border-hairline" />
                )}
                <div className="space-y-2 p-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[11.5px] text-mist">
                      {item.kind === 'video' ? 'Plano de vídeo' : 'Quadro-chave'}
                    </p>
                    <StatusPill status={item.status} />
                  </div>
                  <ResultActions item={item} actions={['approve', 'revise']} />
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
