'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStudio } from '../StudioContext';
import { Button, Panel, Textarea } from '../ui/primitives';
import { ImageFrame } from '../ui/MediaFrame';
import { RealVideoPlayer } from '../ui/RealVideoPlayer';
import { Icon } from '../ui/icons';
import {
  aplicarEvento, ensureThread, fetchThread, friendlyError, labelForProduction,
  lembrarThread, novaResposta, producaoEmCurso, semUrlsJaExibidas, startNewThread,
  streamTurn, threadLembrada, uploadDocument,
} from '@/lib/agentClient';

/**
 * De quanto em quanto tempo a tela relê a conversa enquanto há produção.
 *
 * É atualização de TELA, e só isso. A geração é levada até o fim pelo servidor
 * e andaria igual se esta tela estivesse fechada — o que muda aqui é só quando
 * o resultado aparece, não se ele vai aparecer.
 */
const INTERVALO_ATUALIZACAO_MS = 3000;

/** O que o seletor de arquivos oferece. O servidor confere os bytes de novo. */
const TIPOS_ACEITOS = '.pdf,.txt,application/pdf,text/plain';

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
  const [abrindoNova, setAbrindoNova] = useState(false);
  // O que esta conversa tem em produção agora. Vem do servidor, que é quem
  // sabe: o turno acaba muito antes de a mídia existir.
  const [producao, setProducao] = useState([]);
  const [tique, setTique] = useState(0);
  // Os documentos já enviados e ainda não anexados a uma mensagem.
  //
  // Eles JÁ são documentos do projeto — o upload aconteceu na hora em que o
  // arquivo foi escolhido. O que esta lista guarda é a intenção de anexá-los ao
  // PRÓXIMO turno; tirar um daqui não desfaz o upload (ver a limitação
  // registrada no handoff).
  const [anexos, setAnexos] = useState([]);
  const [enviandoAnexo, setEnviandoAnexo] = useState(false);

  const bottomRef = useRef(null);
  const abortRef = useRef(null);
  const inputRef = useRef(null);
  const arquivoRef = useRef(null);
  // Guarda contra duplo envio: o estado do React chega tarde demais para
  // barrar dois cliques seguidos, ou um Enter que repete.
  const enviandoRef = useRef(false);
  // A mesma guarda, pelo mesmo motivo, para "Nova conversa": dois cliques
  // seguidos abririam DUAS conversas no banco, e a primeira ficaria órfã.
  const abrindoNovaRef = useRef(false);

  // ── abrir a conversa ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelado = false;

    (async () => {
      try {
        // O ponteiro é POR PROJETO, e quem sabe montar a chave é o cliente.
        const salvo = threadLembrada(activeProjectId);

        const { thread, messages: historico, production } = await ensureThread({
          threadId: salvo,
          project: descritorDoProjeto(activeProject),
        });

        if (cancelado) return;

        setThreadId(thread.id);
        setSemProjeto(!thread.projectId);
        setMessages(historico.map(paraTela));
        // Recarregar a página no meio de uma geração não interrompe nada: o
        // trabalho é do servidor. A tela apenas volta a saber que ele existe.
        setProducao(production || []);
        lembrarThread(activeProjectId, thread.id);
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

  /**
   * Relê a conversa uma vez.
   *
   * As mensagens só são substituídas quando alguma produção CONCLUIU ou quando
   * não sobrou nenhuma em andamento — que é quando existe mídia nova para
   * mostrar. Substituí-las a cada leitura apagaria, a cada três segundos, a
   * lista do que o Showrunner acabou de fazer no turno; e reescrever a conversa
   * inteira para descobrir que nada mudou é trabalho à toa.
   */
  const relerConversa = useCallback(async (alvo) => {
    const dados = await fetchThread({ threadId: alvo });
    if (!dados) return;

    const concluiuAlgo = dados.production.some((item) => item.state === 'concluido');
    setProducao(dados.production);
    if (concluiuAlgo || !producaoEmCurso(dados.production)) {
      setMessages(dados.messages.map(paraTela));
    }
  }, []);

  /**
   * Enquanto há trabalho em produção, a tela se atualiza sozinha.
   *
   * Isto NÃO é o que faz a geração progredir — quem faz é o acompanhamento do
   * servidor. Se este laço nunca rodasse, a imagem ficaria pronta na mesma
   * hora; ela só demoraria mais para aparecer. É a diferença entre uma tela que
   * observa e uma tela que dirige, e nesta arquitetura ela observa.
   *
   * Fica parado durante um turno: enquanto o Showrunner responde, quem manda
   * na tela é o fluxo de eventos do próprio turno.
   */
  useEffect(() => {
    if (!threadId || emCurso || !producaoEmCurso(producao)) return undefined;

    let vivo = true;
    const relogio = setTimeout(async () => {
      await relerConversa(threadId);
      // O tique continua o laço mesmo quando a leitura falha: uma atualização
      // perdida não pode encerrar o acompanhamento da tela.
      if (vivo) setTique((n) => n + 1);
    }, INTERVALO_ATUALIZACAO_MS);

    return () => { vivo = false; clearTimeout(relogio); };
  }, [threadId, emCurso, producao, tique, relerConversa]);

  const enviar = useCallback(async (texto) => {
    const content = String(texto ?? '').trim();
    if (!content || enviandoRef.current || !threadId) return;

    enviandoRef.current = true;
    setDraft('');

    // Os anexos saem da caixa de texto e passam a pertencer a ESTE turno. O
    // servidor grava o vínculo antes de o Showrunner pensar, e a partir daí é
    // ele que sabe o que "este documento" quer dizer.
    const doTurno = anexos;
    setAnexos([]);

    setMessages((atuais) => [...atuais, {
      id: `local_${Date.now()}`,
      role: 'user',
      text: content,
      createdAt: Date.now(),
      media: [],
      activity: [],
      // A mesma forma que o servidor devolve na releitura, para que a mensagem
      // otimista e a recarregada sejam desenhadas pelo mesmo código.
      documents: doTurno.map((anexo) => ({
        documentId: anexo.id,
        filename: anexo.filename,
        mimeType: anexo.mimeType,
        pageCount: anexo.pageCount,
        textLength: anexo.textLength,
      })),
    }]);

    let resposta = novaResposta(`resp_${Date.now()}`);
    setEmCurso(resposta);

    const controlador = new AbortController();
    abortRef.current = controlador;

    try {
      await streamTurn({
        threadId,
        content,
        documentIds: doTurno.map((anexo) => anexo.id),
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

      // O turno acabou, mas o trabalho que ele começou pode não ter acabado.
      // Só a produção é lida aqui: as mensagens continuam as da tela, com a
      // lista do que o Showrunner acabou de fazer ainda visível.
      const dados = await fetchThread({ threadId });
      if (dados) setProducao(dados.production);
    }
  }, [threadId, anexos]);

  /**
   * O arquivo escolhido vira documento do projeto na hora.
   *
   * Enviar agora, e não junto com a mensagem, é o que permite mostrar o nome, o
   * tamanho e o número de páginas antes de a pessoa terminar de escrever — o
   * servidor já leu o arquivo e já sabe. E é o que faz uma recusa ("este PDF
   * não tem texto") chegar enquanto ela ainda pode escolher outro arquivo, em
   * vez de derrubar o turno inteiro depois.
   */
  const anexar = useCallback(async (arquivo) => {
    if (!arquivo || enviandoAnexo) return;

    if (!activeProjectId || semProjeto) {
      toast('Escolha um projeto antes de anexar um documento.', 'error');
      return;
    }

    setEnviandoAnexo(true);
    try {
      const documento = await uploadDocument({ projectId: activeProjectId, file: arquivo });
      setAnexos((atuais) => (
        atuais.some((a) => a.id === documento.id) ? atuais : [...atuais, documento]
      ));
    } catch (falha) {
      // A frase vem do servidor: ele é quem sabe se o arquivo é grande demais,
      // se não é PDF, ou se é um PDF sem texto. Todas já são de produto.
      toast(falha?.message || 'Não consegui anexar este arquivo.', 'error');
    } finally {
      setEnviandoAnexo(false);
      // Sem isto, escolher o MESMO arquivo de novo não dispara `change`.
      if (arquivoRef.current) arquivoRef.current.value = '';
    }
  }, [activeProjectId, semProjeto, enviandoAnexo, toast]);

  /**
   * Tira o anexo do próximo turno.
   *
   * O documento CONTINUA no projeto — ele já foi enviado, já foi lido e já
   * está lá. O que isto desfaz é a intenção de anexá-lo a esta mensagem.
   * Apagá-lo do projeto exigiria decidir o que fazer com um documento que outra
   * conversa pode já ter citado, e isso não é decisão de um X num chip.
   */
  const removerAnexo = useCallback((documentId) => {
    setAnexos((atuais) => atuais.filter((anexo) => anexo.id !== documentId));
  }, []);

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

  /**
   * Começar outra conversa no MESMO projeto.
   *
   * Nada é apagado: a conversa anterior continua no servidor, com as mensagens
   * e a mídia que ela produziu. O que muda é qual conversa este projeto aponta
   * como atual — e é só o ponteiro deste projeto que se move.
   *
   * A tela só troca DEPOIS de o servidor confirmar a nova conversa. Se a
   * criação falhar, o usuário continua exatamente onde estava, com o histórico
   * na frente dele; limpar antes de saber que deu certo deixaria a tela vazia
   * apontando para uma conversa que não existe.
   */
  const novaConversa = useCallback(async () => {
    if (abrindoNovaRef.current || emCurso) return;

    abrindoNovaRef.current = true;
    setAbrindoNova(true);

    try {
      const { thread } = await startNewThread({
        project: descritorDoProjeto(activeProject),
        projectId: activeProjectId ?? null,
      });

      setThreadId(thread.id);
      setSemProjeto(!thread.projectId);
      setMessages([]);
      setEmCurso(null);
      // A produção que a conversa ANTERIOR começou continua acontecendo no
      // servidor, e o resultado dela vai parar lá, na mensagem que a pediu.
      // Ela some daqui porque esta é outra conversa — não porque foi cancelada.
      setProducao([]);
      setDraft('');
      setAnexos([]);
      setErroDeAbertura(null);
      inputRef.current?.focus();
    } catch (falha) {
      // A conversa atual permanece inteira na tela — nada foi limpo ainda.
      toast(friendlyError(falha), 'error');
    } finally {
      abrindoNovaRef.current = false;
      setAbrindoNova(false);
    }
  }, [activeProject, activeProjectId, emCurso, toast]);

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
          <div className="flex items-center gap-2">
            {emAndamento ? (
              <Button size="sm" variant="ghost" icon="close" onClick={cancelar}>
                Parar
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              icon="plus"
              title="Começar uma conversa nova neste projeto"
              onClick={novaConversa}
              // Enquanto o Showrunner está respondendo, o botão fica fora do ar:
              // trocar de conversa no meio de um turno descartaria uma resposta
              // que está sendo escrita, sem o usuário ter pedido isso.
              disabled={emAndamento || carregando || abrindoNova}
            >
              Nova conversa
            </Button>
          </div>
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

          {/* O que continua sendo produzido depois de o turno ter acabado. */}
          {!emCurso && producao.length ? <Producao itens={producao} /> : null}

          <div ref={bottomRef} />
        </div>

        <footer className="border-t border-hairline p-3">
          {/* Os documentos que vão junto com a próxima mensagem. */}
          {anexos.length ? (
            <ul className="mb-2 flex flex-wrap gap-1.5">
              {anexos.map((anexo) => (
                <li
                  key={anexo.id}
                  className="flex items-center gap-1.5 rounded-lg border border-hairline bg-panel-2 px-2 py-1 text-[11.5px] text-chalk"
                >
                  <span className="text-gold"><Icon name="documento" size={12} /></span>
                  <span className="max-w-[220px] truncate">{anexo.filename}</span>
                  <span className="text-mist">{descricaoDoAnexo(anexo)}</span>
                  <button
                    type="button"
                    onClick={() => removerAnexo(anexo.id)}
                    title="Não enviar este documento nesta mensagem"
                    className="ml-0.5 text-mist transition-colors hover:text-danger"
                  >
                    <Icon name="close" size={11} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <div className="flex items-end gap-2">
            <input
              ref={arquivoRef}
              type="file"
              accept={TIPOS_ACEITOS}
              className="hidden"
              onChange={(event) => anexar(event.target.files?.[0])}
            />
            <Button
              variant="ghost"
              icon="documento"
              title="Anexar um PDF ou arquivo de texto a este projeto"
              onClick={() => arquivoRef.current?.click()}
              disabled={carregando || Boolean(erroDeAbertura) || enviandoAnexo || semProjeto}
            >
              {enviandoAnexo ? 'Lendo…' : 'Anexar'}
            </Button>
            <Textarea
              ref={inputRef}
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

/**
 * O descritor do projeto em que o usuário está.
 *
 * É com ele que o servidor registra o projeto, se ainda não o conhecer — com o
 * MESMO id que a tela já usa. Nenhum projeto é inventado aqui: sem projeto
 * ativo, sai `null`, e a conversa nasce sem projeto.
 */
function descritorDoProjeto(project) {
  if (!project) return null;
  return {
    id: project.id,
    name: project.name,
    description: project.description || '',
    aspect: project.aspect || undefined,
  };
}

/**
 * O que ainda está sendo produzido nesta conversa.
 *
 * Fala em linguagem de produção — "Gerando imagem…", "Finalizando…" — e não
 * carrega nada de mecanismo: nem identificador de trabalho, nem estado interno,
 * nem de onde a mídia vai sair. Uma produção concluída não aparece aqui, porque
 * o resultado dela já está na conversa e fala por si.
 *
 * Isto não é fala do Showrunner: é estado do produto. Nenhuma frase daqui vira
 * mensagem da conversa nem é atribuída ao agente.
 */
function Producao({ itens }) {
  const visiveis = itens
    .map((item) => ({ ...item, rotulo: labelForProduction(item) }))
    .filter((item) => item.rotulo);

  if (!visiveis.length) return null;

  return (
    <ul className="fade-up space-y-1 pl-11">
      {visiveis.map((item) => (
        <li key={item.id} className="flex items-center gap-2 text-[11.5px]">
          <span className={item.state === 'falhou' ? 'text-danger' : 'text-gold'}>
            <Icon name={item.state === 'falhou' ? 'close' : 'spark'} size={12} />
          </span>
          <span className={item.state === 'falhou' ? 'text-danger' : 'pulse-soft text-mist'}>
            {item.rotulo}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Como um anexo se descreve em uma linha.
 *
 * Páginas quando o formato tem — é o que a pessoa reconhece num PDF. Um TXT não
 * tem páginas e mostra o tamanho do texto, que é a única grandeza honesta que
 * ele oferece.
 */
function descricaoDoAnexo(anexo) {
  if (Number(anexo?.pageCount) > 0) {
    return `· ${anexo.pageCount} ${anexo.pageCount === 1 ? 'página' : 'páginas'}`;
  }
  if (Number(anexo?.textLength) > 0) {
    return `· ${Math.max(1, Math.round(anexo.textLength / 1000))} mil caracteres`;
  }
  return '';
}

/** Uma mensagem da conversa: texto, o que está sendo feito, a mídia e os anexos. */
function Message({ message, emCurso = false }) {
  const isAgent = message.role !== 'user';
  const activity = message.activity || [];
  const media = message.media || [];
  const documents = message.documents || [];

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

        {/* Os documentos que o usuário anexou a este turno. Sobrevivem ao
            reload porque o vínculo está no banco, não no navegador. */}
        {documents.length ? (
          <ul className={`mt-1.5 flex flex-wrap gap-1.5 ${isAgent ? '' : 'justify-end'}`}>
            {documents.map((anexo) => (
              <li
                key={anexo.documentId}
                className="flex items-center gap-1.5 rounded-lg border border-hairline bg-panel-2 px-2 py-1 text-[11.5px] text-chalk"
              >
                <span className="text-gold"><Icon name="documento" size={12} /></span>
                <span className="max-w-[220px] truncate">{anexo.filename}</span>
                <span className="text-mist">{descricaoDoAnexo(anexo)}</span>
              </li>
            ))}
          </ul>
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
    // Os anexos do turno voltam do servidor, como a mídia: o navegador nunca
    // guardou o arquivo nem os bytes dele. Depois de recarregar a página, a
    // mensagem continua mostrando o documento que a acompanhou.
    documents: Array.isArray(registro.documents) ? registro.documents : [],
    error: null,
  };
}
