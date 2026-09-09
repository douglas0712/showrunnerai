# Showrunner — estado da implementação e handoff

Documento **autossuficiente**. Um agente de código que abra este repositório
pela primeira vez deve conseguir ler só este arquivo e saber onde o projeto
está, o que é verdade, o que não é, e o que continua aberto.

Ele não depende de `/tmp`, de scratchpad, de histórico de conversa nem da
memória de nenhuma sessão.

**Atualizado em:** 9 de setembro de 2026
**HEAD funcional documentado:** `b2ce6b10f3c90e2661ef7a63b9433a906644a7ac`

> **Regra de precedência.** Se este documento divergir do código ou do Git, **o
> código e o Git são a fonte de verdade**. Verifique antes de confiar. Foi
> exatamente assim que esta revisão foi escrita: a versão anterior dizia "434
> testes", "branch `feat/showrunner-agent-foundation`", "Echo é o padrão" e
> "Asset ainda não é criado em `finalizeJob`" — as quatro estavam obsoletas.

---

## START HERE FOR THE NEXT CODING AGENT

1. Leia este documento inteiro. Ele tem tudo o que você precisa para começar.
2. `git status --short` — esperado: **vazio** (árvore limpa).
3. `git log --oneline -5` — esperado: `b2ce6b1` no topo do trabalho funcional.
4. `npm test` — esperado: **1114 testes, 1114 passando, 0 falhando** (~3 min).
5. `npm run build` — esperado: compila limpo, 18 páginas estáticas.
6. **Não refaça os Passos 1–11.** Eles estão prontos, testados e commitados. O
   **núcleo** do Passo 10 (10.0 a 10.5) está fechado; **10.6 é backlog** e não
   bloqueia nada — ver seção 17. O **Passo 11** (ingestão de documentos) está
   fechado — ver seção 18.
7. **O Quality Gate audiovisual foi executado à mão, no produto real, e passou**
   — com uma ressalva medida que você precisa ler antes de confiar na linhagem
   de vídeo: seção 19.
8. **O próximo passo é o PASSO 12 — PRODUCTION PLANNING** (seção 21). Ele ainda
   não foi começado.
9. Preserve as **NON-NEGOTIABLE ARCHITECTURE RULES**. Elas não são estilo: cada
   uma existe porque a alternativa já causou, ou causaria, um defeito concreto.

`npm test` emite `ExperimentalWarning: SQLite is an experimental feature` — é
ruído do `node:sqlite` no Node 24, não uma falha. Não suprima.

---

## 1 · Estado atual do repositório

| Item | Valor |
| --- | --- |
| Caminho | `/media/douglas/SSD2/dev/open/showrunner-studio` |
| Nome do pacote | `showrunner-studio` (ver `package.json`) |
| Branch | `main` |
| Remote | `origin` → `https://github.com/douglas0712/showrunnerai.git` |
| HEAD funcional | `b2ce6b10f3c90e2661ef7a63b9433a906644a7ac` |
| Working tree | limpa |
| Testes | 1114 / 1114 passando, 0 falhas |
| Build | limpo (`✓ Compiled successfully`, 18/18 páginas) |
| Node | v24.x (usa `node:sqlite`, experimental) |
| Next | 15.5.15 · React 19.2.8 |

> **Atenção:** `main` está **1 commit à frente de `origin/main`** neste momento.
> O `b2ce6b1` foi criado localmente e o `git push` falhou por **autenticação** —
> o remote é HTTPS e não havia credencial disponível na sessão. Nenhuma
> configuração de Git foi alterada e nenhuma credencial foi gerada. Publique com
> `git push origin main` quando puder autenticar.
> (`git rev-list --left-right --count origin/main...main` → `0  1`.)

### Checkpoints importantes

| Commit | O que entrou |
| --- | --- |
| `b2ce6b1` | **PASSO 11** — ingestão de documentos (migração 8) **e** a continuidade da mesma AgentThread quando o runtime recicla a sessão dele |
| `6a0a2b9` | **PASSO 10.5** — recuperação dos trabalhos ainda EM VOO no arranque (`/queue`), acompanhamento retomado, e `orphaned` honesto |
| `beff9f0` | **PASSO 10.4** — recuperação, no arranque, dos trabalhos que terminaram durante a queda (`/history`) |
| `a678f6c` | **PASSO 10.3** — o livro-razão ligado ao ciclo de vida real; Agent e Studio pela mesma porta |
| `3d83813` | **PASSO 10.2** — `generation_jobs`, o livro-razão durável (migração 7) |
| `b672460` | **PASSO 10.1** — vocabulário de estados independente de provider |
| `4fd44f3` | **PASSO 10.0** — âncora durável do turno no ToolContext |
| `f7f4586` | handoff do Passo 9 |
| `8f57fa2` | **PASSO 9 — Job Autonomy**: o Showrunner leva sozinho até o fim a geração que começou; e a fronteira pública dos eventos de ferramenta foi fechada |
| `c192779` | **"Nova conversa"** na AgentScreen (thread nova, nada apagado) |
| `d22b7d7` | **Hermes vira o runtime padrão**; fail-closed; fim do fallback silencioso para Echo |
| `3036b76` | Compatibilidade **Hermes v0.20.3** (WebSocket/JSON-RPC) + identity guard |
| `1c6ded0` | `first commit` — o que está publicado no GitHub |
| `3af0e1a` | trabalho de identidade preservado |
| `6848b9c` | AgentScreen ligada ao agente real (Passo 8) |
| `a7afcbf` | integração Hermes + tool bridge seguro (Passo 7) |
| `0d74a9f` | Passo 6 + 6.1 — job ownership, ponte i2v, SMOKE B real |
| `5ce76d7` | tools nativas `og.*` com validação de entrada |
| `0eb684a` | Agent Gateway + Echo runtime (Passo 5) |
| `f62cbed` | Ideogram 4 nativo (Passo 4) |
| `dd53083` | pipeline de geração generalizado imagem + vídeo (Passo 3) |
| `85d2882` | `runtime/` ancorado na raiz da aplicação |

---

## 2 · O que é o Showrunner

Uma plataforma de **criação audiovisual conduzida por conversa**. O usuário
descreve o que quer em linguagem natural e o sistema produz — imagem, vídeo,
acompanhamento do trabalho.

A experiência-alvo, em exemplos concretos:

- "Transforme este PDF em um documentário de 4 minutos."
- "Crie uma imagem cinematográfica desta cena."
- "Anime essa imagem."
- "Refaça a cena 4."
- "Como está o andamento?"

A arquitetura precisa permitir, no futuro, que **web, mobile, WhatsApp e outros
canais** usem o mesmo agente e o mesmo backend. Por isso toda decisão mora no
servidor, e a tela é um cliente entre vários possíveis.

### Princípio central

> **Chat is the steering wheel, not the car.**

A conversa dirige. Ela não é o motor, não guarda estado e não executa nada. Quem
executa e é dono de tudo é o Showrunner.

---

## 3 · Arquitetura atual (o desenho real)

```
AgentScreen  (components/screens/AgentScreen.jsx)
  │  fetch
  ▼
Showrunner Agent API      app/api/agent/{threads,messages,stream}
  │                        rotas finas; a decisão está em lib/server/agent/httpApi.js
  ▼
Agent Gateway             lib/server/agent/gateway.js
  │                        turno, persistência, normalização de eventos
  ▼
AgentRuntimePort          lib/server/agent/AgentRuntimePort.js
  │                        contrato: isAvailable / unavailableReason /
  │                        testConnection / run → AsyncIterable<AgentEvent>
  ▼
HermesRuntimeAdapter      lib/server/agent/adapters/HermesRuntimeAdapter.js
  │  WebSocket + JSON-RPC 2.0
  ▼
Hermes dedicado           processo separado, loopback-only, HERMES_HOME próprio
  │
  ▼
plugin nativo Showrunner  integrations/hermes/showrunner-plugin/
  │  socket de domínio Unix (0600)
  ▼
bridge                    lib/server/agent/hermes/bridge.js
  │
  ▼
invokeTool()              lib/server/agent/gateway.js → tools/registry.js
  │
  ▼
og.generate_image · og.generate_video · og.get_job
  │
  ├────────────► JobWatcher    lib/server/agent/tools/jobWatch.js
  │                acompanha a geração DEPOIS que o turno acabou e
  │                devolve o Asset à mensagem que o pediu (seção 16)
  ▼
generation facade         lib/server/generation/facade.js
  │                        a linha do livro-razão nasce ANTES do submit
  ▼
workflow registry → ComfyUI → Jobs → Assets
                                       ▲
                                       │
arranque do processo ──► instrumentation.js ──► lib/server/generation/reconcile.js
                          reconcilia o que ficou aberto: finaliza o que terminou
                          durante a queda e retoma o acompanhamento do que ainda
                          está em voo (seção 17)
```

Repare que o desenho é **invertido no meio**: a conversa desce do Showrunner
para o runtime; a chamada de ferramenta volta do runtime para o Showrunner por
**outro canal** (o socket Unix), e não pelo mesmo. Isso é deliberado — está
explicado no cabeçalho de `HermesRuntimeAdapter.js`.

### Responsabilidades

**O Showrunner é dono de:**

| Coisa | Onde |
| --- | --- |
| Projects | `lib/server/domain/projects.js` |
| Scenes | `lib/server/domain/scenes.js` |
| Assets | `lib/server/domain/assets.js` |
| **Documentos do Project** | `lib/server/domain/documents.js` |
| **a ingestão deles (bytes, parser, storage)** | `lib/server/documents/` |
| AgentThreads / AgentMessages | `lib/server/agent/threads.js` |
| Jobs (memória do processo) | `lib/server/comfy/jobs.js` |
| **o trabalho de geração, durável** | `lib/server/domain/generationJobs.js` |
| levar uma geração iniciada até o fim | `lib/server/agent/tools/jobWatch.js` |
| retomar o que ficou aberto num reinício | `lib/server/generation/reconcile.js` |
| mídia (bytes, publicação, serviço) | `lib/server/generation/` |
| tool registry e ToolContext | `lib/server/agent/tools/` |
| session binding | `lib/server/agent/hermes/sessionBinding.js` |
| identidade pública | `lib/server/agent/hermes/identity.js` |
| histórico da conversa | SQLite, `runtime/showrunner.db` |

**O Hermes é dono de:** raciocínio, e a escolha de quais ferramentas permitidas
chamar. Mais nada.

> **Hermes reasons. Showrunner executes and owns state.**

---

## 4 · O runtime Hermes — contrato REAL atual

**Versão validada: Hermes v0.20.3** (`Hermes Agent v0.20.3 (2026.8.16.2)`).

**Transporte: WebSocket + JSON-RPC 2.0.** As versões até a v0.19 usavam
HTTP + SSE (`/api/session/new`, `/api/chat/start`, `/api/chat/stream`,
`/api/chat/cancel`, `/api/personality/set`). **Nenhum desses endpoints existe
hoje** — não foram renomeados, foram removidos, e o servidor responde 404. Se
você encontrar documentação ou código falando deles, está obsoleto.

### A superfície inteira que esta integração usa

```
GET  /api/health          diagnóstico, sem autenticação
WS   /api/ws?token=…      a conversa, JSON-RPC 2.0
```

E dentro do WebSocket, **quatro métodos e nada mais**:

| Método | Para quê |
| --- | --- |
| `session.create` | abre a conversa do lado do runtime |
| `session.resume` | reabre, pelo id DURÁVEL, uma conversa que o runtime reciclou — devolve um id vivo novo para a MESMA conversa, com o histórico dela (Passo 11) |
| `prompt.submit` | entrega a fala do usuário e começa o turno |
| `session.interrupt` | cancela o turno em andamento |

O handshake é o quadro `gateway.ready`: antes dele o servidor não aceita RPC.

### Eventos que o runtime emite (traduzidos em `hermes/eventTranslator.js`)

| Evento do runtime | Vira |
| --- | --- |
| `session.info` | conferência de isolamento (não vira evento público) |
| `message.delta` | `agent.message.delta` |
| `message.complete` | `agent.message.completed` |
| `tool.start` | `tool.started` |
| `tool.complete` | `tool.completed` (ou `tool.failed`) |

Eventos conhecidos e deliberadamente ignorados: `gateway.ready`,
`message.start`, `message.interim`, `session.title`, `sessions.changed`,
`status.update`, `tool.generating`, `tool.output_risk`. Um evento **desconhecido**
derruba o turno em vez de passar adiante — é o que impede a tradução de ser
esquecida quando o runtime mudar.

### Vocabulário público do Showrunner (`lib/server/agent/events.js`)

`agent.started` · `agent.status` · `agent.message.delta` ·
`agent.message.completed` · `tool.started` · `tool.completed` · `tool.failed` ·
`agent.completed` · `agent.failed`

Este é o único vocabulário que chega ao navegador.

### Duas reduções, não uma (`publicAgentEvent`)

O vocabulário garante quais CAMPOS atravessam. Ele não garante o que vai
**dentro** deles — e `result` é um objeto inteiro, vindo de uma ferramenta. Por
isso há duas reduções, com donos diferentes:

| Fronteira | Onde | O que passa |
| --- | --- | --- |
| ferramenta → AgentEvent | `hermes/eventTranslator.js` → `resultadoPublico` | o que a APLICAÇÃO pode ver. **Inclui o `jobId`** |
| AgentEvent → navegador | `events.js` → `publicAgentEvent` | o que a CONVERSA mostra. **Sem `jobId`** |

O `jobId` precisa existir na primeira: é dele que o gateway monta a amarração
entre a geração que o turno começou e a mensagem que o turno gravou. Apagá-lo na
origem calaria a autonomia junto com o vazamento — foi essa a armadilha ao
fechar a fronteira.

A ordem é a garantia: o gateway lê o evento **interno**, e só depois entrega a
versão pública. Recuperar o `jobId` do evento já sanitizado faria a autonomia
depender da superfície que existe para escondê-lo.

O que **nunca** chega ao navegador: `jobId`, `promptId`, `workflowId`, provider,
id de nó, caminho de arquivo, estado do ComfyUI (`na-fila`, `decodificando`,
`salvando`), alias do runtime e os `arguments` crus de `tool.started` — que numa
consulta de andamento são, literalmente, o `jobId`.

O que **pode** chegar em `tool.completed`, quando existe: `result.asset` com
`id`, `kind`, `mediaUrl`, `mimeType`, `derivedFromAssetId`. Sem Asset, o evento
sai **sem** `result`. O nome da ferramenta continua sendo o canônico do
Showrunner (`og.generate_image`), nunca o alias.

### Autenticação e isolamento

- O runtime exige credencial em toda rota privada. É um token de processo que o
  operador fixa nos **dois** lados: `HERMES_DASHBOARD_SESSION_TOKEN` no runtime
  e `SHOWRUNNER_HERMES_TOKEN` no Showrunner. Segredo de servidor: mora no
  ambiente, nunca no Git, nunca chega ao navegador.
- `/api/health` é público (`auth_required: false`), então responder a ele **não
  prova** que a credencial está certa. Quem prova é o primeiro turno.
- O isolamento de ferramentas é `HERMES_TUI_TOOLSETS=showrunner`, um pino
  explícito no processo do runtime. O adaptador **não confia nisso**: a cada
  turno ele confere as ferramentas que o runtime anuncia ter dado ao modelo
  (`session.info`), e um toolset a mais derruba o turno.
- A sentinela `no_mcp` é **ignorada** por esse caminho (o runtime imprime
  "ignoring unknown HERMES_TUI_TOOLSETS entries"). Não faz falta: o pino
  explícito devolve só o que foi nomeado.
- A instância é **dedicada** e escuta **apenas em loopback**. O `HERMES_HOME`
  pessoal do desenvolvedor (`~/.hermes`) **não é tocado**.

### Duas identidades por sessão

Uma sessão tem **dois** identificadores, e o runtime entrega um diferente a cada
lado:

- **o do gateway** — curto, vive enquanto o processo do runtime viver; é por ele
  que se manda a fala e se cancela o turno;
- **o durável** (`stored_session_id`) — sobrevive ao reinício, e é **este** que o
  runtime informa ao plugin quando o modelo chama uma ferramenta.

O vínculo grava os dois (`runtime_sessions.sessionId` e `.bridgeSessionId`).
Gravar só um fazia toda chamada de ferramenta ser recusada com "sessão
desconhecida". Migração 6 do esquema.

**O durável é a identidade da integração; o do gateway é substituível.** É essa
assimetria que faz a retomada de sessão funcionar sem quebrar a ponte de
ferramentas — ver a seção 19.

### Seleção de runtime — fail-closed

Desde `d22b7d7`:

| Situação | Resultado |
| --- | --- |
| sem variável nenhuma | `hermes` (é o **padrão**) |
| `SHOWRUNNER_AGENT_RUNTIME=<id>` | esse id, ou erro alto se não existe |
| `SHOWRUNNER_AGENT_RUNTIME=echo` | `echo` + aviso no log a cada construção |
| `createRuntime('echo')` | `echo`, sem ruído — é o piso da suíte |
| id desconhecido | `RuntimeUnavailableError`; **nunca** cai noutro runtime |
| Hermes ausente / fora do ar | **503**, código `runtime_unavailable` |
| Hermes caiu no meio da resposta | **502**, código `agent_turn_failed` |

**O `EchoRuntimeAdapter` existe apenas como runtime de teste.** Ele responde
`"Recebi: <a fala do usuário>"` e não pensa. Era o padrão, e o preço apareceu na
tela do usuário: uma instalação sem variável nenhuma subia inteira, respondia a
tudo e parecia saudável. Não é mais o destino de quem não escolheu nada.

Em toda falha de runtime a superfície pública devolve **uma única frase** — "O
assistente de criação está temporariamente indisponível." — sem `detail`, sem o
id do adaptador e sem o texto de operador. O diagnóstico fica no log do servidor
e em `runtimeDiagnostics()`.

---

## 5 · Identidade Showrunner

**Fonte de verdade da persona:** `integrations/hermes/persona/showrunner.md`.

Mecanismo, em três camadas:

1. **Persona aplicada server-side.** `integrations/hermes/prepare.mjs` lê o
   markdown e escreve **duas** chaves no `config.yaml` do `HERMES_HOME`
   dedicado: `agent.personalities.showrunner` (que **define**) e
   `display.personality: showrunner` (que **escolhe**). Faltar a segunda é uma
   falha silenciosa — o runtime sobe, responde, e responde sem persona.
   Não há RPC de persona: o endpoint que existia foi removido na v0.20.3.
2. **Identity guard antes da superfície pública.**
   `lib/server/agent/hermes/identity.js` → `createIdentityGuard`. Ele roda
   **antes** do `yield` do adaptador, porque depois do `yield` não há retratação:
   um delta entregue foi lido.
3. **Guard com estado, contra vazamento partido entre chunks.** Um delta
   conferido isoladamente deixaria passar `"Sou o Her"` seguido de `"mes Agent"`.
   O guard segura a cauda ambígua e só libera o que já não pode mudar de sentido.

O que o guard corrige e o que ele **não** toca:

- corrige **apenas a construção de autoidentificação** ("sou o X");
- **não** troca toda ocorrência de uma palavra. Um texto sobre o Hermes
  mitológico, ou sobre um personagem chamado assim, passa inteiro — o usuário
  pode legitimamente pedir isso, e censurar a palavra estragaria a resposta boa
  para proteger contra a ruim;
- ids internos (o `sessionId`) são segredos do turno e nunca saem;
- quando há vazamento, ele é registrado no log do servidor **sem o valor do
  segredo** — registrá-lo só mudaria o vazamento de lugar.

**Confirmado por smoke real** contra o Hermes v0.20.3 rodando, pela superfície
HTTP da AgentScreen. Respostas obtidas para "quem é você?":

> "Sou o **Showrunner** — seu parceiro de criação e direção audiovisual."
> "Sou o Showrunner. Ajudo você a desenvolver ideias e levá-las para a tela."

E para "oi": *"Oi! Sou o Showrunner. O que vamos criar hoje?"* — nunca
`"Recebi: oi"`.

---

## 6 · Tools

### Nomes canônicos (os únicos que o registry conhece)

```
og.generate_image        o que a produção FAZ
og.generate_video
og.get_job

project.list_documents   o que o projeto TEM
project.read_document
```

Definidos em `lib/server/agent/tools/handlers/`.

O prefixo diz de quem é a coisa. Uma ferramenta `project.*` opera sobre o
Project inteiro, atravessa conversas, e a autoridade dela é sempre o
`projectId` do ToolContext. As duas de documento entraram no Passo 11 —
seção 18.

### `og.get_job` deixou de ser o motor da autonomia

Consultar continua sendo o que faz a geração PROGREDIR — a máquina é pull. O que
mudou no Passo 9 é **quem consulta**: o Showrunner, em laço, no servidor. Ver
seção 16.

`og.get_job` continua existindo e continua útil para a **pergunta explícita**
("como está aquela imagem?"), para reentrada e para compatibilidade. Chamá-la é
inofensivo: ela consulta a mesma função que o acompanhamento consulta, e criar o
Asset é idempotente.

O que ela **não** é mais: a razão de o trabalho andar. Enquanto era, bastava o
modelo esquecer de chamá-la — e ele esquece, porque o turno dele acaba — para a
produção parar no meio.

`og.generate_image` e `og.generate_video` **registram o acompanhamento
sozinhas**, a partir do resultado estruturado e do ToolContext confiável. A
descrição das três diz isso ao modelo, para que ele não mande o usuário
perguntar de novo nem fique consultando por conta própria — mas a autonomia é
garantida pelo servidor, não por obediência a prompt.

### Aliases — detalhe EXCLUSIVO da integração Hermes

```
og_generate_image       →  og.generate_image
og_generate_video       →  og.generate_video
og_get_job              →  og.get_job
project_list_documents  →  project.list_documents
project_read_document   →  project.read_document
```

Em `lib/server/agent/hermes/aliases.js`. Existem porque o provider por trás do
Hermes recusa ponto em nome de ferramenta (`Invalid 'tools[0].name': string
does not match pattern '^[a-zA-Z0-9_-]+$'`).

É uma **tabela literal fechada**, não uma transformação `_`→`.`. Uma
transformação aceitaria qualquer coisa: `og_fake` viraria `og.fake`, que o
registry rejeitaria — mas só depois de a chamada ter atravessado a fronteira.

**Nenhum alias aparece num AgentEvent, numa resposta de API ou na tela.**

### ToolContext — construído server-side, sempre

O modelo fornece **apenas** os argumentos declarados no `inputSchema` da tool.
Estes campos **nunca** são argumentos controlados pelo modelo:

```
projectId   threadId   sessionId   workflowId   paths   nodeIds
```

Eles vêm do `ToolContext`, que o gateway monta a partir da thread que o servidor
já tem gravada (`criarInvokeTool` em `gateway.js`). Um agente que pudesse dizer
em qual projeto gerar seria um agente sem fronteira.

### Defesa em profundidade da chamada de ferramenta

1. `HERMES_TUI_TOOLSETS=showrunner` no processo do runtime;
2. o plugin registra **três** nomes e mais nenhum (`plugin.yaml`);
3. `toCanonicalToolName` recusa o que não está na tabela de aliases;
4. o bridge escuta num socket Unix `0600` — sem porta, sem token, autorização
   pelo sistema de arquivos;
5. o registry recusa tool desconhecida.

---

## 7 · Domínio e banco

SQLite via `node:sqlite` (zero dependências novas), em `runtime/showrunner.db`.
Migrações versionadas por `PRAGMA user_version`, em `lib/server/domain/db.js`.

**`ESQUEMA_ATUAL = 8`** (oito migrações aplicadas).

| # | Migração | Entidade |
| --- | --- | --- |
| 1 | `projects`, `scenes`, `assets` | domínio base |
| 2–3 | `agent_threads`, `agent_messages` | conversa |
| 4 | `runtime_sessions` | vínculo sessão ↔ thread |
| 5 | `agent_message_assets` | mídia de uma mensagem, por referência |
| 6 | `runtime_sessions.bridgeSessionId` | o segundo nome da mesma sessão |
| 7 | `generation_jobs` | **o livro-razão durável de gerações** (Passo 10.2) |
| 8 | `project_documents`, `document_chunks`, `agent_message_documents` | **o material de referência do Project** (Passo 11) |

Tabelas `STRICT`, chaves estrangeiras ligadas, `CHECK` gerado a partir dos
vocabulários que já existem em `lib/storyboard.js` e `lib/approval.js` — não há
lista de status duplicada em SQL para divergir.

### `generation_jobs` — o livro-razão de gerações (Passo 10.2)

A tabela que faz uma geração sobreviver ao processo. `lib/server/domain/generationJobs.js`
é a única porta de escrita; `lib/server/domain/generationJobStates.js` é o
vocabulário.

| Campo | Papel |
| --- | --- |
| `jobId` | **PK**. O mesmo id que vai no `filename_prefix` da submissão |
| `projectId` | dono, sempre server-side |
| `threadId` · `userMessageId` | de qual conversa e de qual **turno** o trabalho é (âncora do 10.0) |
| `assistantMessageId` | a resposta onde a mídia aparece — **escrita única** |
| `kind` · `workflowId` | o que é, e por qual descriptor |
| `providerJobId` | o `prompt_id` do executor — **escrita única**, `UNIQUE` parcial |
| `state` | o estado de domínio (ver 10.1) |
| `assetId` | o resultado real; `REFERENCES assets(id)` sem `ON DELETE` |
| `derivedFromAssetId` | linhagem (i2v), gravada na criação |
| `error` | texto curto de operador, só em `failed`/`orphaned` |
| `createdAt` · `submittedAt` · `finishedAt` · `updatedAt` | a linha do tempo |

Índices: `UNIQUE(providerJobId)` parcial, `(state, createdAt)` para os abertos,
`(threadId, createdAt)` para a conversa.

Invariantes, garantidos por `CHECK` no banco e pelas operações:

- **`done` ↔ `assetId`**: não existe concluído sem resultado, nem resultado sem
  concluído. `completeGenerationJob` é o **único** caminho até `done`.
- **terminal ↔ `finishedAt`**: `done`, `failed`, `cancelled`, `orphaned` têm hora
  de fim; os abertos não têm.
- **terminal não reabre.** Uma tentativa de voltar a um estado aberto é recusada.
- **`error` só em `failed`/`orphaned`.**
- **Escrita única** em `providerJobId` e `assistantMessageId`: repetir o **mesmo
  fato** é no-op (replay é idempotente); afirmar um **fato diferente** é conflito
  e é recusado, nunca sobrescrito.
- O Asset apontado não pode ser apagado isoladamente (a FK é `NO ACTION`, e a
  recusa é medida em teste); `DELETE` de Project continua íntegro, porque o
  `CASCADE` do projeto resolve tudo dentro da mesma instrução.
- Nenhuma tabela nasceu para o **acompanhamento**. O livro-razão registra o
  TRABALHO, não a vigília.

### `project_documents` · `document_chunks` · `agent_message_documents` (Passo 11)

O material de referência de uma produção. **Documento não é Asset**, e a
distinção é de domínio, não de arrumação: um Asset é mídia que a produção
PRODUZIU — tem `kind`, `mediaUrl`, aprovação e linhagem; um documento é material
que ENTRA. Ninguém aprova um PDF, ninguém deriva um vídeo dele por
`derivedFromAssetId`, e ele não é servido pela rota de mídia. Enfiá-lo em
`assets` faria toda consulta de mídia passar a filtrar o que não é mídia.

```
Project
  └─ project_documents        o material
       └─ document_chunks     as unidades de leitura, ordenadas

AgentMessage
  └─ agent_message_documents  o que foi anexado ÀQUELE turno
```

| Tabela | Campos que importam |
| --- | --- |
| `project_documents` | `id` PK · `projectId` (CASCADE) · `filename` · `mimeType` (CHECK) · `sizeBytes` · `sha256` · `pageCount` (nulo quando o formato não tem páginas) · `textLength` · `createdAt` |
| `document_chunks` | `PRIMARY KEY (documentId, ordinal)` — a chave **é** a ordem · `pageNumber` nulo ou > 0 · `text` |
| `agent_message_documents` | `PRIMARY KEY (messageId, documentId)` — a deduplicação sai de graça · `seq` |

**As duas perguntas que esta modelagem separa**, e que uma tabela só não
conseguiria responder:

- *o projeto tem este documento?* → `project_documents`
- *este turno anexou este documento?* → `agent_message_documents`

É essa separação que faz `"sobre o que é este PDF?"` ter resposta. Sem ela, a
única interpretação possível de "este" seria "o último documento do projeto" —
heurística que acerta enquanto houver um só e erra exatamente quando o usuário
tem dois, que é quando ele mais precisa ser entendido.

**O que deliberadamente NÃO está aqui:** caminho de arquivo (não há coluna; o
caminho é derivado dos ids — ver seção 18), estado de ingestão (ela é síncrona:
ou o documento existe pronto, ou não existe), e qualquer coisa de vetor.

### Project: o mesmo id no frontend e no backend

`registerProject`:

- exige o **descritor explícito** do projeto (id + nome), não só um id;
- cria se não existe, devolve o existente se há;
- **nunca sobrescreve** o que já está no servidor.

Um `projectId` sozinho é um identificador que chegou de fora; um descritor com
nome é a interface declarando em que projeto o usuário está. Sem ele, um id
desconhecido é **recusado** — é isso que impede a rota de virar uma porta de
criação de projeto a partir de qualquer string.

`ensureProject`:

- é **interno**, reservado a backfill e infraestrutura;
- está deliberadamente **fora** de `domain/index.js`, e há teste que falha se
  voltar ao barril;
- **não** está disponível para as agent tools. Se estivesse, uma tool
  materializaria projetos como efeito colateral de resolver um id.

Outros invariantes:

- O `id` de Project **é** o segmento de diretório de `runtime/projects/<id>/`.
  Não há um segundo sistema de identificadores.
- `Asset.derivedFromAssetId` é o que torna "anime essa imagem" possível. Só é
  definido na criação e nunca reapontado — por isso um ciclo é impossível.

---

## 8 · Geração e Assets

### Imagem

```
og.generate_image
  → workflow ideogram4_t2i (workflows/ideogram4_t2i_api.json, 29 nós)
  → ComfyUI
  → Job
  → polling (og.get_job)
  → validação por número mágico + publicação
  → STATES.DONE
  → Asset
```

### Vídeo (image-to-video)

```
sourceAssetId
  → Asset de imagem
  → filename REALMENTE publicado
  → bytes lidos do disco
  → firstFrame
  → workflow MiniMax H3 (i2v)
  → ComfyUI
  → vídeo
  → Asset derivado (derivedFromAssetId aponta para a imagem)
```

Desde o Passo 10.3, **as duas** entradas (agent tools e telas do estúdio)
atravessam `lib/server/generation/facade.js`, e a linha do livro-razão nasce
**antes** de o executor ser chamado. As rotas `/api/comfy/generate|status|result`
não alcançam mais o provider por fora para o ciclo de vida.

### Regras do Asset (`lib/server/generation/facade.js`)

- **Asset só nasce depois de `STATES.DONE` real.** `STATES.SAVING` é
  intermediário e não cria nada. Estados intermediários não criam Asset.
- **Idempotente.** Busca por `jobId` antes de criar; `UNIQUE(projectId, jobId)`
  no banco; corrida perdida recarrega e devolve quem ganhou.
- **Reconciliação com o backfill.** O backfill varre o disco e registra por
  arquivo, sem passar pela finalização — então pode ter chegado primeiro. Nesse
  caso o Asset existente é **adotado** (`linkAssetToJob`), não duplicado.
- `filename` é o nome do arquivo **realmente publicado** — o mesmo que
  `mediaUrl` serve e o mesmo que `resolveMediaPath` usa para achar os bytes.
  Ficava `null`, e isso quebrava a ponte i2v.
- `mimeType` é derivado do **arquivo real**, nunca da extensão declarada.

### Invariante obrigatório de toda mídia publicada

> **bytes reais ↔ extensão final ↔ MIME servido** — os três precisam concordar.

Dois bugs reais foram encontrados e corrigidos ao provar esse invariante: bytes
WebM renomeados para `.mp4` e servidos como `video/mp4`; e bytes PNG publicados
como `.jpg` quando o ComfyUI assim os nomeava. **Não há transcodificação em
lugar nenhum do pipeline** — contêiner não servível é recusado, não convertido.

O que dirige o pipeline é **`descriptor.kind`**, nunca o nome do modelo. Há
teste que remove comentários do fonte e falha se `minimax` ou `ideogram`
aparecerem no código da infraestrutura genérica.

---

## 9 · AgentScreen / UI

**A AgentScreen é real, não simulada.** A máquina de estados local do protótipo
foi removida por inteiro no Passo 8; há teste que falha se `agentScript` ou
`demoConversation` voltarem a ser importados.

Fluxo:

```
POST /api/agent/threads   → abre ou recupera a conversa do projeto
POST /api/agent/stream    → o turno, evento a evento, como SSE
  → AgentEvents do Showrunner (já sanitizados — ver seção 4)
  → redução pura em lib/agentClient.js
  → tela

GET  /api/agent/threads/<id>
  → { thread, messages, production }
  → releitura leve ENQUANTO há produção em curso
```

Características atuais:

- **streaming real**, token a token;
- **atividade de ferramenta em linguagem de produção** — "Gerando imagem…",
  "Verificando a produção…", nunca `og_generate_image`;
- **anexo de documento** (Passo 11): botão "Anexar" (PDF/TXT), upload na hora da
  escolha — é isso que permite mostrar nome, páginas e tamanho antes de a pessoa
  terminar de escrever, e que faz uma recusa chegar enquanto ela ainda pode
  trocar de arquivo. Chip removível antes do envio; o anexo sobrevive ao reload
  porque o vínculo está no banco, não no navegador;
- **imagem inline**; **vídeo** pelo `RealVideoPlayer`;
- **mídia persistida** — sobrevive ao reload, porque a mensagem guarda a
  *referência* ao Asset (`agent_message_assets`) e a URL é lida do Asset;
- **a AgentThread do backend é a fonte da verdade**; o `localStorage` é só um
  **ponteiro**, e o ponteiro é **por Project**
  (`showrunner.agent.threadId.<projectId>`, montado por `agentThreadKey`).

A **atividade** não volta no reload, e isso é deliberado: ela descreve o que
estava acontecendo, e o que estava acontecendo já aconteceu. Reconstruí-la seria
encenar um trabalho que terminou. Pelo mesmo motivo, ela desaparece quando a
produção conclui: o que fica é o resultado — mensagem + Asset. **Nenhum log de
atividade de ferramenta é persistido.**

### `production` — o que a conversa tem em andamento

`GET /api/agent/threads/<id>` passou a devolver, além de `thread` e `messages`:

```json
"production": [
  { "id": "watch_...", "kind": "image", "state": "gerando" }
]
```

`state` ∈ `gerando` · `finalizando` · `concluido` · `falhou` — vocabulário de
produto, não do gerador. O `id` é do próprio acompanhamento, **não** o `jobId`:
a tela precisa de uma chave estável para desenhar e deduplicar, e essa chave não
tem por que ser o nome do trabalho dentro do servidor.

A AgentScreen relê a conversa a cada 3 s **enquanto** houver produção em curso, e
para quando não houver. Nenhuma API nova nasceu para isso — a mesma leitura traz
mensagens, mídia e produção.

> **Isto não faz o trabalho progredir.** Quem faz é o acompanhamento do
> servidor. Se esta tela nunca perguntasse, a imagem ficaria pronta na mesma
> hora; ela só demoraria mais para aparecer. É a diferença entre uma tela que
> observa e uma tela que dirige, e aqui ela observa.

### "Nova conversa" (`c192779`)

Botão discreto no cabeçalho do painel, ao lado do "Parar".

- cria uma **nova AgentThread** no **mesmo Project**;
- a thread antiga **permanece** — continua listada e legível;
- **não** apaga mensagens, **não** exclui Assets, **não** deleta thread, **não**
  cria Project;
- o `localStorage` passa a apontar para a nova, e **só** o ponteiro daquele
  projeto se move;
- **bloqueado** enquanto há turno em andamento (`emAndamento`), enquanto carrega
  e enquanto a criação está em voo (guarda por `ref`, contra duplo clique);
- se a criação falhar, a conversa atual permanece inteira na tela e o ponteiro
  não se move — a escrita acontece **depois** da confirmação do servidor.

Não reaproveita a conversa atual mesmo quando ela está vazia: uma thread vazia
reusada e uma thread nova são indistinguíveis na tela e diferentes no banco.

---

## 10 · Modelos e workflows validados

| Pipeline | Modelo | Estado |
| --- | --- | --- |
| text-to-image | **Ideogram 4** (`ideogram4_t2i`) | **validado com geração real** |
| vídeo | **MiniMax H3** (`minimax_h3_t2v`) | **validado com geração real** |

> **O registry tem UM workflow de vídeo, e o id dele é `minimax_h3_t2v`.** O
> caminho image-to-video não é outro workflow: é o MESMO grafo recebendo um
> quadro inicial, montado pela facade quando `sourceAssetId` é informado. Isso
> funciona e está coberto — mas o Quality Gate de 9 de setembro **não** o
> exercitou, e a ressalva está medida na seção 20. Leia antes de afirmar que
> "anime essa imagem" produz linhagem.

- `workflows/ideogram4_t2i_api.json` — versionado no repositório, 29 nós.
  Descriptor em `lib/server/generation/workflows/ideogram4.js`.
- MiniMax H3 — descriptor em
  `lib/server/generation/workflows/minimaxH3.js`; o arquivo do workflow vive na
  raiz de workflows do ComfyUI (`file: 'minimax_h3_t2v_api.json'`), com override
  de operador por `COMFY_WORKFLOW`.

A tabela de proporções foi lida de `/object_info/ResolutionSelector` no ComfyUI
vivo, não suposta. É conhecimento do **nó**, não do modelo — por isso Ideogram e
MiniMax compartilham `resolutionSelector.js`.

Nomes de arquivos de modelo exigidos estão nos descriptors. **Nenhuma credencial
é registrada aqui nem em lugar nenhum do Git.**

---

## 11 · O que foi testado, e como

### Testes determinísticos — `npm test`

**1114 testes, 1114 passando, 0 falhando.** 66 arquivos `tests/*.test.mjs`, com
`node:test`, sem dependências de teste. Sem rede, sem GPU, sem runtime externo, sem
credencial. Vários são regressões de falhas reais e trazem a causa documentada
no cabeçalho: se um quebrar, o refactor está errado, não o teste.

Categorias notáveis:

| Arquivo | Protege |
| --- | --- |
| `agent-architecture.test.mjs` | as fronteiras da camada de agente (varre o fonte) |
| `agent-ui-identity.test.mjs` | nenhum termo de runtime no frontend |
| `agent-identity.test.mjs` | o identity guard, inclusive vazamento partido em chunks |
| `hermes-adapter.test.mjs` | o adaptador inteiro contra um runtime falso |
| `agent-runtime.test.mjs` | contrato do Port, vocabulário de eventos, **seleção de runtime** |
| `agent-api.test.mjs` | superfície pública, fail-closed, ausência de "Recebi:" |
| `agent-nova-conversa.test.mjs` | "Nova conversa" contra os handlers reais |
| `agent-tools-security.test.mjs` | o modelo não controla identidade nem caminho |
| `agent-job-autonomy.test.mjs` | o acompanhamento inteiro: autonomia, ciclo de vida, propriedade |
| `agent-event-surface.test.mjs` | o que um evento de ferramenta pode mostrar ao navegador |
| `agent-turn-anchor.test.mjs` | a âncora do turno no ToolContext (10.0) — 18 testes |
| `generation-job-states.test.mjs` | o vocabulário de estados e a tradução do provider (10.1) — 18 testes |
| `domain-generation-jobs.test.mjs` | o livro-razão: escrita única, terminais, `done` ↔ Asset (10.2) — 50 testes |
| `generation-ledger-lifecycle.test.mjs` | o livro-razão dentro do ciclo real, pelas duas portas (10.3) — 27 testes |
| `generation-reconcile.test.mjs` | a recuperação de arranque inteira (10.4 + 10.5) — 44 testes |
| `domain-documents.test.mjs` | o domínio do documento e a migração 7→8 (Passo 11) — 25 testes |
| `document-ingestion.test.mjs` | a ingestão real: PDF, TXT, recusas, travessia de caminho — 22 testes |
| `agent-document-tools.test.mjs` | as duas ferramentas de documento e a fronteira delas — 17 testes |
| `agent-document-attachment.test.mjs` | o anexo do turno, e o que ele NÃO é — 13 testes |
| `agent-document-reading.test.mjs` | o caminho inteiro, sem runtime real — 6 testes |
| `documents-boundary.test.mjs` | o parser fora do bundle do cliente, e as camadas — 9 testes |
| `agent-thread-continuity.test.mjs` | a conversa sobrevive à reciclagem da sessão (seção 19) — 12 testes |

O runtime falso vive em `tests/helpers/runtimeFalso.mjs`. Ele ganhou, no Passo
11, um ciclo de vida de sessões (`criarSessoesFalsas`) que imita o
`ws_orphan_reap` sem esperar os 20 s de relógio de parede.

**`agent-job-autonomy.test.mjs`** (40 testes) é determinístico por construção: a
consulta é roteirizada, o relógio é injetado, e a espera entre consultas é um
**freio** que o teste solta — o que permite olhar para o MEIO de uma geração sem
relógio de parede, sem GPU e sem runtime. Cobre: acompanhamento automático em
imagem e vídeo; o turno acabar sem esperar; independência do navegador;
independência do modelo; single-flight; jobs simultâneos independentes; estado
intermediário que não cria Asset; DONE que cria; associação com a mensagem
certa; outra fala no meio que não rouba o resultado; "Nova conversa"; falha;
teto; ciclo de vida do registro (`L1`–`L10`); e a não-durabilidade após
reinício, que é afirmada, não escondida.

**`generation-reconcile.test.mjs`** (44 testes) é determinístico do mesmo jeito:
o `/history` e o `/queue` do executor são objetos, a finalização é injetada, o
banco é em memória, e o acompanhamento usa o **freio** do Passo 9. Cobre os dois
restarts de ponta a ponta — com o trabalho `running` e com ele `queued` —, a
recuperação do `providerJobId` pelo `filename_prefix`, `orphaned` só com
evidência completa, executor offline que **não** vira desfecho, e as varreduras
de fonte que proíbem ressubmissão, modificação de fila, Hermes e navegador.

**`agent-event-surface.test.mjs`** (12 testes) tranca a fronteira pública:
ausência de `jobId` no SSE e na resposta de uma vez, ausência dos `arguments`
crus, ausência de `promptId`/`workflowId`/provider/nó/caminho/estado do ComfyUI,
ausência dos aliases do runtime — e, do outro lado, que o Asset continua
atravessando e a mídia continua sendo montada a partir dele.

### Smokes reais — executados à mão, **fora** do `npm test`

Não fazem parte da suíte porque dependem de runtime rodando, credenciais e rede.
Scripts: `tests/smoke-hermes-real.mjs` e `tests/smoke-i2v-real.mjs`.

**Fatos comprovados com execução real** (não inferidos):

| Fato | Como foi provado |
| --- | --- |
| Ideogram 4 gera imagem real | PNG de 1.318.132 bytes, 1376×768, 29 s, publicado e servido com `image/png`; a imagem corresponde ao prompt pedido, não ao prompt do template |
| MiniMax H3 gera vídeo real | SMOKE B, ciclo completo no mesmo processo Node |
| Asset → i2v real | imagem gerada pelo agente usada como `sourceAssetId` de um vídeo |
| Hermes real responde | v0.20.3 em loopback, WebSocket/JSON-RPC, turnos completos |
| identidade Showrunner real | "Sou o Showrunner…" pela superfície HTTP da tela |
| tool calling real | `tool.started`/`tool.completed` de `og.generate_image` e `og.get_job` num turno real |
| bridge por socket Unix real | socket `0600` criado, plugin chamou de volta, ferramenta executou |
| AgentScreen real | `GET /studio/agente` → 200, conversa completa pela UI |
| imagem real apareceu na UI | mídia inline, vinda de `mediaUrl` do Asset |
| reload recupera a mídia | referência em `agent_message_assets` |
| Echo não é mais o padrão | conversa sem variável nenhuma responde como Showrunner |
| Hermes offline dá erro seguro | runtime derrubado → 503 + `runtime_unavailable` + frase do produto |
| **restart recupera geração concluída durante a queda** | Passo 10.4, medido: turno às 23:27:36 → ledger `running` com `providerJobId=42134beb…` → Next morto por **PID exato** (842993) às 23:28:01, ComfyUI e Hermes intocados → executor concluiu às 23:28:46 (ledger ainda `running`) → Next volta às 23:28:54 → reconciliação `abertos=1 → recuperados=1, naConversa=true` → `state: done`, `assetId: asset_mtthc4qr_a4b0dac8`, PNG real de **1.412.577 bytes** (1376×768) na resposta daquele turno, **zero nova submissão** |
| **PDF real vira documento e o agente responde POR ELE** | Passo 11: `Prometeu_O_Fogo_da_Humanidade.pdf`, 6 páginas, 5.568 caracteres. "Sobre o que é?" → resposta correta; "resuma em 10 pontos" → 10 pontos fiéis; "proponha um mini-documentário de 2 minutos" → estrutura textual, sem gerar mídia |
| **o agente responde por fatos que não pode saber de cor** | TXT com "Arkan Vale", "17 de março de 2187", "Elias Venn" — inventados. A resposta trouxe os três |
| **leitura de documento maior que uma chamada** | PDF de 27 páginas / 43.333 caracteres → **2 chamadas** seguindo o `nextCursor`, até `eof` |
| **PDF sem texto é recusado com honestidade** | 422, frase de OCR, zero linha no banco, zero arquivo órfão |
| **o nome do arquivo não alcança o filesystem** | upload com `filename=../../../../etc/passwd` → 201, arquivo sob `runtime/documents/<projectId>/<documentId>/source.txt`, `/etc/passwd` intacto |
| **a conversa sobrevive à reciclagem da sessão do runtime** | seção 19: 4 turnos na MESMA thread com 25 s de pausa; o runtime reciclou 4 vezes, o Showrunner reabriu 3, uma sessão durável só, zero `runtime_unavailable` |
| **Quality Gate audiovisual, à mão, no navegador** | seção 20: identidade → T2I real → "anime essa imagem" → vídeo real → reload preserva mídia → nova conversa preserva a anterior. **Com a ressalva medida de `derivedFromAssetId`** |
| **o gancho de arranque não quebra o bundle** | o mesmo smoke encontrou `UnhandledSchemeError: node:child_process` (`ffmpeg ← provider ← facade ← reconcile`) causando **500 em toda rota**, que nem `npm test` nem `npm run build` pegavam. Consertado com URL montada em runtime + `webpackIgnore` |
| `/queue` e `filename_prefix` do executor real | Passo 10.5, leitura apenas: `/queue` responde `{queue_running, queue_pending}` pelo cliente do projeto, e uma execução real do histórico traz `filename_prefix: image/showrunner/<jobId>` no nó de gravação do descriptor (`158`) |

Nada acima é suposição. O que **não** foi executado não está nesta tabela. Em
particular: **o restart com o trabalho ainda EM VOO não foi provado com execução
real** — a geração do Ideogram termina rápido demais para controlar a janela com
segurança, e improvisar ali significaria matar processos no escuro. A prova desse
caso é determinística (seção 17), e isso está dito, não escondido.

---

## 12 · Como subir o ambiente

> **Desenvolvimento local precisa de TRÊS processos**, e o Agent só funciona
> inteiro com os três de pé:
>
> ```
> ComfyUI            :8188     geração de mídia
> Hermes dedicado    :8788     raciocínio
> Next (dev)         :3100     o Showrunner
> ```
>
> Faltando o Hermes, o Agent responde *"O assistente de criação está
> temporariamente indisponível."* — que é o fail-closed funcionando, não um
> defeito. Foi exatamente o que aconteceu no início do Quality Gate (seção 20).
> O procedimento oficial de subida do runtime dedicado está em
> `integrations/hermes/README.md`.

### A. Showrunner (Next dev)

```bash
cd /media/douglas/SSD2/dev/open/showrunner-studio
npm run dev -- -p 3100          # http://localhost:3100
```

O `package.json` traz `dev`, `build`, `start` e `test`. A porta não está fixada
em código — `3100` é a convenção em uso.

> **Cuidado:** rodar `npm run build` com o `next dev` vivo sobrescreve os chunks
> dele e derruba o dev server com `Cannot find module './NNN.js'`. Pare o dev
> antes de buildar.

### B. Hermes dedicado

Preparar o `HERMES_HOME` (uma vez, e sempre que a persona mudar):

```bash
node integrations/hermes/prepare.mjs
```

Cria `runtime/hermes/home/`, escreve o `config.yaml` a partir do modelo, instala
a persona e aponta `plugins/showrunner` para `integrations/hermes/showrunner-plugin`
por **symlink** — editar o plugin aqui é editá-lo lá. O script **não** copia
credencial nenhuma; isso é deliberado.

Subir:

```bash
HERMES_HOME=$PWD/runtime/hermes/home \
HERMES_DASHBOARD_SESSION_TOKEN=<segredo do operador> \
HERMES_TUI_TOOLSETS=showrunner \
SHOWRUNNER_BRIDGE_SOCKET=$PWD/runtime/hermes/bridge.sock \
  hermes serve --port 8788 --host 127.0.0.1 --skip-build
```

Verificar: `curl -s http://127.0.0.1:8788/api/health` →
`{"ok":true,"version":"0.20.3","auth_required":false}`.

### C. ComfyUI

Processo externo, fora deste repositório. O Showrunner fala com ele em
`http://127.0.0.1:8188` por padrão (`lib/server/comfy/config.js`), ajustável por
`COMFY_URL`.

### Portas

| Serviço | Porta | Verificado |
| --- | --- | --- |
| Showrunner (Next dev) | `3100` | sim, convenção em uso |
| Hermes dedicado | `8788` | sim, é o do README de integração |
| ComfyUI | `8188` | sim, default em `comfy/config.js` |

### Variáveis de ambiente

Do lado do **Showrunner** — num `.env.local` na raiz, que o Next carrega e o Git
ignora:

| Variável | Para quê |
| --- | --- |
| `SHOWRUNNER_HERMES_URL` | onde o runtime dedicado escuta |
| `SHOWRUNNER_HERMES_TOKEN` | a credencial; **igual** ao token do runtime |
| `SHOWRUNNER_BRIDGE_SOCKET` | caminho do socket; lido pelo Showrunner **e** pelo plugin |
| `SHOWRUNNER_AGENT_RUNTIME` | **opcional**; só para escolher OUTRO runtime |
| `SHOWRUNNER_JOB_WATCH_TIMEOUT_MS` | **opcional**; teto da vigília de uma geração. Padrão **30 min**. Ver seção 16 |
| `COMFY_URL` | opcional; endereço do ComfyUI |

Do lado do **runtime dedicado**:

| Variável | Para quê |
| --- | --- |
| `HERMES_HOME` | o home dedicado; **nunca** o pessoal |
| `HERMES_DASHBOARD_SESSION_TOKEN` | a credencial que o Showrunner apresenta |
| `HERMES_TUI_TOOLSETS=showrunner` | o corte de isolamento (pino explícito) |
| `SHOWRUNNER_BRIDGE_SOCKET` | onde o plugin encontra o Showrunner |

Credenciais do provider de LLM ficam em `runtime/hermes/home/.env` e
`runtime/hermes/home/auth.json` — **fora do Git**.

> **Nenhum valor de token, chave ou senha aparece neste documento, e nenhum deve
> ser acrescentado a ele.** Só nomes de variáveis.

### Precedência de ambiente para localização de arquivos

| Variável | Governa | Precedência |
| --- | --- | --- |
| `COMFY_WORKFLOW` | workflow do MiniMax | 1ª — caminho absoluto, vence tudo |
| `COMFY_WORKFLOWS_ROOT` | raiz de workflows do ComfyUI | senão, raiz padrão embutida |
| `SHOWRUNNER_WORKFLOWS_ROOT` | raiz `workflows/` do projeto | senão, `APP_ROOT/workflows` |
| *(nenhuma)* | `runtime/` | sempre `APP_ROOT/runtime` |

Variável de ambiente é **configuração de operador** e pode definir localização.
Corpo de requisição e argumento de tool são **input de usuário/agente** e nunca
podem: enviam `workflowId` e nada mais.

`APP_ROOT` é **descoberto** (`lib/server/appRoot.js`), não presumido: sobe a
partir do próprio módulo até achar um `package.json` com `name`. A exigência do
`name` impede a busca de parar no `.next/package.json` da build.

---

## 13 · `.gitignore` e segurança

```
node_modules/    .next/    out/    dist/
*.log            runtime/logs/     runtime/
.env*            .DS_Store
__pycache__/     *.pyc
```

Consequências que importam:

- **`runtime/` inteiro está fora do Git.** Isso inclui o `HERMES_HOME` dedicado,
  o banco, os projetos, a mídia, os logs, o socket Unix e — desde o Passo 11 —
  `runtime/documents/`, onde ficam os arquivos originais que o usuário anexou.
- **`.env*` está fora do Git** — `.env.local` incluído.
- Credenciais do provider (`runtime/hermes/home/.env`, `auth.json`) nunca entram.
- O socket Unix (`runtime/hermes/bridge.sock`) nunca entra.
- `__pycache__/` e `*.pyc` do plugin Python nunca entram.

Antes de qualquer commit, confira que nenhum desses caminhos aparece no stage.

---

## 14 · Limitações conhecidas

Esta seção é a mais importante para quem vai continuar. Nada aqui é hipótese:
tudo foi verificado no código.

### A. ~~Job Autonomy não está implementado~~ — RESOLVIDO no Passo 9

Era a limitação principal deste documento. O usuário precisava perguntar "e aí?"
para o trabalho progredir, porque quem consultava era o modelo e o turno dele
acaba quando ele termina de falar.

Resolvido em `8f57fa2`. Ver seção 16.

### B. ~~Reiniciar o processo perdia o trabalho~~ — RESOLVIDO no Passo 10

Era a limitação que sobrava do Passo 9: o job e o acompanhamento viviam num
`Map` em `globalThis`, e um reinício perdia os dois.

O que mudou (seção 17): o **trabalho** agora é durável (`generation_jobs`), e o
arranque reconcilia — o que terminou durante a queda é finalizado (10.4), e o que
ainda está em voo volta a ser acompanhado (10.5).

**O que continua sendo memória, deliberadamente**, é o registro do executor
(`lib/server/comfy/jobs.js`) e o **acompanhamento** em si. Ele é andaime: o
arranque o reconstrói a partir do livro-razão em vez de o persistir. Nenhuma
tabela nasceu para o watcher, e há teste que falha se nascer.

**O que ainda não é recuperável:** um trabalho antigo o bastante para sair da
janela do histórico (`max(50, 4 × abertos)`) e que já não esteja na fila. Ele
continua **aberto** — o que é honesto — e o arquivo publicado, se existir, ainda
o resgata pelo segundo caminho.

### C. ~~Reinício do runtime e retomada de sessão têm limitação conhecida~~ — RESOLVIDO no Passo 11

Não havia caminho de reconexão que revalidasse uma sessão órfã, e o próximo turno
daquela thread falhava. Hoje há: o turno seguinte restabelece a sessão por
`session.resume` pelo id durável, preservando o histórico. Ver seção 19.

Esta limitação era mais grave do que este texto sugeria — ela não dependia de o
runtime **reiniciar**. Bastavam 20 segundos de silêncio, porque o runtime recicla
sozinho as sessões cujo socket criador se desconectou. Foi o smoke do Passo 11
que descobriu isso.

### D. Atividade temporária não é reconstruída no reload

Deliberado — ver seção 9. Não "conserte" isso sem decidir o que significa
mostrar um trabalho que já terminou.

### E. Threads antigas podem não ter associação de mídia retroativa

`agent_message_assets` entrou na migração 5. Mensagens gravadas **antes** dela
não ganharam vínculo retroativo; a mídia dessas conversas antigas não reaparece
no reload.

### F. ~~Ingestão de PDF/documentos não existe no Agent~~ — RESOLVIDO no Passo 11

Havia upload nenhum, parsing nenhum, extração nenhuma. Hoje há: PDF com texto e
TXT em UTF-8 viram documento do Project, e o agente os lê por ferramenta. Ver
seção 18.

**O que continua fora, e é decisão:** DOCX, PPTX, imagem e **OCR**. Um PDF
escaneado é recusado com uma frase honesta, não processado por adivinhação.

### F-bis. Um mesmo arquivo pode ser ingerido mais de uma vez

Não há deduplicação por `sha256`. O mesmo PDF enviado duas vezes vira dois
documentos — foram dois gestos do usuário, e escolher qual dos dois nomes
"vence" seria uma decisão que ninguém pediu. O agente lida com a ambiguidade
perguntando (comprovado no smoke).

### F-ter. Upload removido antes do envio permanece como ProjectDocument

O arquivo sobe assim que é escolhido — é isso que permite mostrar páginas e
tamanho antes de a pessoa terminar de escrever, e que faz uma recusa ("este PDF
não tem texto") chegar enquanto ela ainda pode trocar de arquivo.

Tirar o chip antes de enviar remove o **anexo do turno**; o documento continua no
Project. Não há coletor de lixo, e não deveria haver um sem antes decidir o que
fazer com um documento que outra conversa já pode ter citado.

### G. RAG não existe

Sem base de conhecimento, sem embeddings, sem vector DB, sem recuperação por
semelhança. **Os chunks do Passo 11 não são isso**: eles são paginação
determinística, para o agente conseguir percorrer um documento inteiro. Ver
seção 18.

### H. Memória de projeto, personagens e continuidade não existem

Nada mantém a aparência de um personagem entre cenas, nem lembra decisões de
direção entre conversas.

### I. WhatsApp e outros canais não existem

A arquitetura permite (a decisão está toda no servidor), mas nada foi construído.

### J. Fila própria / backpressure não existem — **10.6, backlog**

O livro-razão durável existe desde o Passo 10.2, e a recuperação de arranque
desde 10.4/10.5. O que **não** existe é o escalonador: fila própria, concorrência
controlada, cancelamento seletivo e leases/multi-worker. Isso é o **Passo 10.6 —
Operational Hardening**, adiado por decisão de produto. **Ele não bloqueia o
produto hoje.**

Os dois riscos concretos continuam valendo até lá:

- **`/interrupt` do ComfyUI é global.** Cancelar um job interrompe o que estiver
  rodando, não necessariamente o alvo. Com um agente disparando jobs em paralelo
  isso vira corrupção silenciosa. É por isso que o Passo 9 **nunca** o chama
  automaticamente: sem cancelamento seletivo seguro, cancelar uma geração
  pediria interromper as outras.
- **Sem backpressure.** Nada limita submissões simultâneas; um laço de agente com
  erro enche a fila da GPU.

Uma fila própria com concorrência 1 resolveria os dois de uma vez.

### K. Sem autenticação na API do Showrunner

É decisão de produto correta hoje ("sem conta, sem chave"), mas `/api/agent/*`
aceita texto livre que vira execução de tool. **Se o Gateway passar a ouvir fora
de `127.0.0.1`, precisa de token antes.**

### L. `README.md` da raiz está desatualizado

Descreve "Fase 1, nenhum modelo é executado", enquanto Cinema, Vídeo, Ideogram e
o Agent geram de verdade. O README de integração
(`integrations/hermes/README.md`) **está** atualizado.

### M. Deploy `standalone` precisa revisar o gancho de arranque

`instrumentation.js` monta a URL de `reconcile.js` em tempo de execução a partir
de `process.cwd()`, com `webpackIgnore` — a única saída encontrada para o
empacotador não arrastar `node:child_process` para um bundle que o rejeita (o
erro está medido no cabeçalho do arquivo). **Isso pressupõe a árvore do projeto
presente em disco no ambiente de execução**, que é o que este projeto já assume
(`runtime/` é ancorado do mesmo jeito). Um deploy `next build --standalone`, que
leva só o bundle, precisa revisitar esse ponto.

### N-bis. Os fixtures de PDF não estão marcados como binários no Git

`tests/fixtures/documents/*.pdf` são PDFs sem compressão, escritos à mão — o Git
os trata como TEXTO. Aqui isso é inofensivo (`core.autocrlf` e `core.eol` não
estão definidos, e foi verificado que os blobs gravados são idênticos byte a
byte aos arquivos).

**Num clone Windows com `autocrlf=true`, a conversão de quebra de linha
corromperia os fixtures** e os testes falhariam de forma misteriosa. Uma linha de
`.gitattributes` (`tests/fixtures/documents/*.pdf binary`) resolve. Não foi feito
porque estava fora do conjunto aprovado para aquele commit.

### N. O estúdio ainda depende do laço da tela para progredir

O acompanhamento server-side do Passo 9 é ligado a uma **conversa** — ele existe
para levar o resultado até uma resposta. A geração iniciada pelas telas antigas
do estúdio nasce sem `threadId`, então no arranque ela tem o **estado
reconciliado** (e é finalizada se já terminou), mas **não** ganha acompanhamento:
quem a leva ao fim continua sendo o navegador, em laço. Está testado como
comportamento esperado, não escondido.

---

## 15 · Passos concluídos

| Passo | Estado | Commit de referência |
| --- | --- | --- |
| **1** — Domínio server-side (Project/Scene/Asset, SQLite) | ✅ | anterior a `1c6ded0` |
| **2** — Workflow Registry (descriptors congelados) | ✅ | anterior a `1c6ded0` |
| **3** — Pipeline de mídia generalizado (imagem + vídeo) | ✅ | `dd53083` |
| **4** — Ideogram 4 nativo | ✅ | `f62cbed` |
| **5** — Agent Gateway + AgentRuntimePort + Echo | ✅ | `0eb684a` |
| **6 + 6.1** — tools nativas, job ownership, ponte i2v | ✅ | `5ce76d7`, `0d74a9f` |
| **7** — integração Hermes + tool bridge seguro | ✅ | `a7afcbf` |
| **8** — AgentScreen real | ✅ | `6848b9c` |
| **8.1** — Project real + persistência de mídia | ✅ | `6848b9c` |
| **8.2 / 8.2B** — identidade + compatibilidade Hermes v0.20.3 | ✅ | `3036b76` |
| **—** — Hermes como runtime padrão (fail-closed) | ✅ | `d22b7d7` |
| **—** — "Nova conversa" | ✅ | `c192779` |
| **9** — Job Autonomy + fechamento da fronteira pública de eventos | ✅ | `8f57fa2` |
| **10.0** — Durable Turn Anchor (âncora do turno no ToolContext) | ✅ | `4fd44f3` |
| **10.1** — estados de geração independentes de provider | ✅ | `b672460` |
| **10.2** — livro-razão durável `generation_jobs` (migração 7) | ✅ | `3d83813` |
| **10.3** — livro-razão ligado ao ciclo de vida real | ✅ | `a678f6c` |
| **10.4** — recuperação dos trabalhos concluídos durante a queda | ✅ | `beff9f0` |
| **10.5** — recuperação dos trabalhos em voo + `orphaned` | ✅ | `6a0a2b9` |
| **10.6** — Operational Hardening (fila, backpressure, leases) | ⏸ **backlog** | — |
| **11** — Document Ingestion (PDF/TXT → Project → o agente lê) | ✅ | `b2ce6b1` |
| **—** — Thread Continuity (a conversa sobrevive à reciclagem da sessão) | ✅ | `b2ce6b1` |
| **—** — Quality Gate Core Audiovisual E2E (manual, no produto real) | ✅ | seção 20 |

---

## 16 · PASSO 9 — JOB AUTONOMY ✅

**Concluído em `8f57fa2`.** Implementado, testado, validado com geração real e
commitado.

### A causa, que era arquitetural

A geração é **pull**: ela só avança quando alguém chama `pollJob`. Esse alguém
era o modelo, através de `og.get_job`.

Mas o turno do modelo acaba quando ele termina de falar. Então:

```
og.generate_image  →  cria job  →  devolve jobId
                                     ↓
o agente PODE chamar og.get_job     ↓
                                     ↓
se ainda estiver gerando, ele responde e ENCERRA o turno
                                     ↓
o trabalho PARA, e só volta a andar quando alguém consulta de novo
                                     ↓
o usuário precisa escrever "e aí?"
```

A autonomia estava delegada a quem não tem como sustentá-la. O modelo
legitimamente não lembra de consultar em laço — não é falha dele, é o formato do
turno.

### A arquitetura atual

```
og.generate_image / og.generate_video
  → jobId INTERNO (resultado estruturado, nunca texto)
  → JobWatcher do Showrunner       lib/server/agent/tools/jobWatch.js
      → getGenerationJob (a MESMA função que og.get_job chama)
          → pollJob
      → DONE / FAILED
      → finalizeGenerationAsset
      → Asset
  → associação determinística com a mensagem e a thread corretas
```

O turno do Hermes termina normalmente, sem esperar. No smoke real, o turno durou
**11 s** e a imagem ficou pronta **37 s** depois dele.

> **Hermes decides what to do.**
> **Showrunner guarantees that started work progresses.**

### Onde o watcher vive, e por quê

`lib/server/agent/tools/jobWatch.js`. Em `tools/` por duas razões que se
reforçam: é a **continuação do que uma ferramenta começou**, e `tools/` é a única
parte da camada de agente autorizada a alcançar `generation/facade` — que é
exatamente o que um acompanhamento precisa consultar. Pôr o watcher fora dali
exigiria afrouxar essa trava, e ela vale mais do que a arrumação.

O que ele **não** faz: não consulta a fila, não conhece nó, não copia arquivo e
não cria Asset. Chama `getGenerationJob`, e é ela quem avança a máquina e faz
nascer o Asset. Uma segunda implementação dessas regras seria uma segunda
oportunidade de elas discordarem.

### Como ele acompanha

- **server-side**, e só;
- **independente do navegador** — a tela pode estar fechada;
- **independente de o modelo chamar `og.get_job`** — ele não precisa saber que
  isto existe;
- **single-flight por `jobId`**: o mesmo job nunca ganha dois laços; observar de
  novo devolve o mesmo registro e a mesma promessa;
- **jobs diferentes são independentes** — sem trava global, sem ordem exigida;
- **espera entre consultas**, nunca laço apertado:

| | |
| --- | --- |
| intervalo inicial | **1500 ms** |
| backoff | **×1,5** a cada volta sem mudança de estado |
| teto do intervalo | **5000 ms** |
| reset | o intervalo volta a 1500 ms **sempre que o estado muda** |

O log só registra **transições** — não há uma linha por consulta. No smoke real,
um job inteiro produziu três linhas: iniciado, mudou, concluiu.

### Ciclo de vida do registro

```
em curso   → permanece no registro global; é ele que garante o single-flight
terminou   → TODO desfecho passa por `assentar`, que AGENDA a saída
             (concluído · falhou · teto estourado · exceção inesperada)
janela      → retenção terminal curta: 2 minutos, só para a tela mostrar o
              desfecho — sobretudo o ruim, que é o único aviso que o usuário tem
depois      → sai do Map, sozinho
```

O descarte é **agendado no momento em que o trabalho termina**, não deixado para
a próxima vez que alguém passar por ali. Enquanto era preguiçoso, uma instalação
que gerasse uma imagem e ficasse quieta guardava aquele registro para sempre —
ninguém chamava a varredura, e nada o tirava de lá. Há varredura na leitura
também, como rede.

O registro usa `globalThis` **enquanto o processo vive** — mesmo motivo do
registro de jobs: o Fast Refresh do Next recarrega módulos entre requisições.

> O **Map não cresce indefinidamente**. O resultado durável é **Asset +
> associação no banco**, não o watcher. O andaime sai; a obra fica.

### Teto do acompanhamento

| Variável | Padrão | Governa |
| --- | --- | --- |
| `SHOWRUNNER_JOB_WATCH_TIMEOUT_MS` | **30 min** | a vigília de uma geração |
| `SILENCIO_MAXIMO_MS` (`hermes/runtimeClient.js`) | **180 s** | o turno do Hermes |

**São grandezas diferentes e não devem ser confundidas.** Um turno mudo por três
minutos está quebrado; uma geração de vídeo que leva catorze minutos está apenas
trabalhando — e já levou. Matá-la pelo relógio da conversa jogaria fora trabalho
de GPU que estava dando certo.

Não há stall-timeout por ausência de mudança de estado, e é decisão consciente:
os estados são grossos (um vídeo fica catorze minutos inteiros em `gerando`), e
"sem mudança" não distingue travado de trabalhando. Mataria exatamente o caso
que precisamos preservar.

Quando o teto estoura:

- o acompanhamento **para**;
- o estado público vira **`falhou`**;
- **nenhum Asset falso** é criado (só `DONE` cria);
- **`/interrupt` NÃO é chamado** — ver limitação J;
- o registro **sai da memória**, como qualquer outro desfecho;
- o job **não é declarado cancelado**, porque não foi: ele pode muito bem
  continuar rodando no gerador e terminar depois.

> Enquanto o processo ainda tiver o job em mãos, uma **consulta explícita** mais
> tarde — o usuário perguntando, o modelo chamando `og.get_job` — reencontra
> esse job e continua a avançá-lo, inclusive até o Asset nascer. É a mesma
> função, e ela é idempotente. O que acabou foi a nossa vigília, não o trabalho.

### Cancelamento

> **Cancelar o turno do agente ≠ cancelar uma geração já aceita.**

"Parar" interrompe a **fala** do Showrunner. A geração continua, e o resultado
dela chega à conversa quando ficar pronto.

O watcher **não recebe o `AbortSignal` do turno**, de propósito. E não existe
cancelamento seletivo seguro no ComfyUI atual: `/interrupt` é global e
interromperia o que estivesse rodando, não necessariamente o alvo — por isso
**não é usado automaticamente em lugar nenhum**. Há teste que varre o fonte do
watcher e falha se `interrupt`, `cancelJob` ou `abort` aparecerem lá.

O caminho do `signal` até uma ferramenta em execução, pelo registro de turnos do
bridge, continua intacto.

### Propriedade: thread e mensagem

A associação é **determinística**, e os dois lados vêm do mesmo turno:

```
jobId    ← resultado ESTRUTURADO interno da ferramenta daquele turno
messageId ← a mensagem de assistente que aquele turno acabou de gravar
threadId
projectId ← ToolContext confiável, montado pelo servidor
```

**Nunca** "a última mensagem da thread": o usuário pode falar de novo antes de o
trabalho acabar, e aí a última mensagem é de outro assunto. **Nunca** um id
garimpado do texto do modelo: um identificador vindo de uma frase é um
identificador que o modelo pode inventar.

O trabalho pode terminar **antes** do turno (imagem rápida) ou **depois** (o caso
normal). Os dois caminhos convergem no mesmo ponto de ligação, que é idempotente.

Consequências, todas testadas:

- o usuário **pode continuar conversando** enquanto o job roda — o input volta a
  ficar livre assim que o turno acaba;
- uma fala nova **não rouba** o Asset da mensagem que o pediu;
- **"Nova conversa" não move nem cancela** o job da thread anterior: quando ele
  terminar, a mídia vai para a conversa que a pediu;
- múltiplos jobs são acompanhados de forma independente.

### O que foi provado com execução real

**Smoke 1 — autonomia.** Uma única mensagem do usuário ("Crie uma imagem
cinematográfica de um dragão vermelho voando sobre uma cidade medieval ao pôr do
sol"). O turno do Hermes durou **11 s** e terminou. O watcher continuou. **Zero**
chamadas do modelo a `og.get_job`. **Nenhum "e aí?"** — uma mensagem de usuário
na thread, do início ao fim. A imagem apareceu sozinha: PNG de **1.624.187
bytes**, 1376×768, servido como `image/png`, e correspondendo ao prompt pedido.

**Smoke 2 — independência do navegador.** Iniciada a geração, houve **~90 s sem
uma única requisição HTTP**. O job concluiu mesmo assim, e o Asset já estava
ligado à mensagem na primeira leitura seguinte. É a prova de que não é a
AgentScreen que dirige o `pollJob`.

**Reload.** Cinco releituras seguidas: mesmas mensagens, mesmo Asset, **sem
duplicata** (2 assets para 2 jobs, 1 cada). Reload **durante** a geração não
criou um segundo acompanhamento — `production` sempre com uma entrada, nunca
duas.

### Testes

**853 / 853** à época do Passo 9 (hoje **1010** — ver seção 11), build limpo em
18/18 páginas.

---

## 17 · PASSO 10 CORE — DURABLE JOBS / RECOVERY ✅

**Concluído em `6a0a2b9`** (subpassos `4fd44f3`, `b672460`, `3d83813`, `a678f6c`,
`beff9f0`, `6a0a2b9`). Implementado, testado, e o caso de recuperação de trabalho
concluído foi provado com execução real.

O Passo 9 fez o Showrunner levar sozinho até o fim a geração que começou —
**enquanto o processo viver**. O Passo 10 fez isso sobreviver ao processo.

> **10.6 é backlog e não bloqueia o produto.** Ver o fim desta seção.

### 10.0 · Durable Turn Anchor (`4fd44f3`)

Não nasceu tabela nenhuma: a âncora **já existia**. A mensagem do usuário é
persistida *antes* de `runtime.run`, e o `id` dela é um identificador durável do
turno. O que faltava era carregá-lo.

O **ToolContext** passou a levar, sempre montado no servidor:

```
threadId · projectId · userMessageId · signal
```

O registro de turnos ativos (`hermes/bridge.js`) carrega o `userMessageId` pelo
caminho Hermes → bridge → tool. **Nem o modelo, nem o Hermes, nem o navegador
fornecem autoridade sobre esse valor** — vale a regra 5.

É essa âncora que permite, depois de um reinício, devolver a mídia à resposta
**daquele turno** sem nunca usar "a última mensagem".

### 10.1 · Estados independentes de provider (`b672460`)

O vocabulário do Showrunner, em `lib/server/domain/generationJobStates.js` (zero
imports — é domínio):

```
preparing · submitted · queued · running · finalizing
done · failed · cancelled · orphaned
```

Terminais: `done`, `failed`, `cancelled`, `orphaned`.

- `lib/server/generation/jobStates.js` é **só reexportação** — a camada de
  geração não é dona do vocabulário.
- A tradução do estado do ComfyUI vive isolada em
  `lib/server/generation/comfyJobState.js`, com **tabela fechada**: um estado
  desconhecido do provider levanta erro em vez de virar um estado do produto.
- `orphaned` **não tem** correspondente no provider. É um desfecho que só o
  Showrunner pode declarar — ver 10.5.
- **O domínio não depende de `generation/` nem do provider.** A direção da
  dependência é uma regra, com teste.

Para a conversa, `jobWatch.js` reduz esse vocabulário a quatro estados de
produção. `orphaned` aparece ao usuário como falha ("Não consegui concluir esta
geração."): a distinção existe para o operador, no log.

### 10.2 · O livro-razão durável (`3d83813`)

Migração **7**, tabela `generation_jobs` — campos, índices e invariantes estão na
seção 7. O resumo do que ela garante:

`jobId` é PK · `providerJobId` e `assistantMessageId` são **escrita única** ·
`done` ↔ `assetId` real · terminal ↔ `finishedAt` · terminal **não reabre** ·
`error` só em `failed`/`orphaned` · **replay do mesmo fato é idempotente, fato
diferente é conflito** · o Asset do resultado não é apagável isoladamente ·
`DELETE` de Project continua íntegro.

### 10.3 · O livro-razão ligado ao ciclo real (`a678f6c`)

A ordem, que é o ponto inteiro:

```
gerar jobId
  → INSERT (preparing) ANTES do submit          ← se cair aqui, existe rastro
  → provider aceita
  → providerJobId (escrita única)
  → estados observados sincronizados
  → arquivo publicado e validado
  → Asset real
  → completeGenerationJob (o único caminho até done)
  → assistantMessageId amarrado (escrita única)
```

E as **duas** portas passaram a atravessar a mesma facade: as agent tools e as
telas do estúdio. `/api/comfy/generate`, `/status` e `/result` não alcançam mais
o provider por fora para o ciclo de vida — o contrato HTTP delas não mudou.

Duas distinções que o passo tranca:

- **Teto ou exceção do acompanhamento ≠ falha do trabalho.** "Parei de vigiar"
  não é "a GPU falhou". O ledger fica aberto e reconciliável.
- **Falha ambígua de submissão fica reconciliável**, não vira desfecho inventado.

### 10.4 · Recuperação do que terminou durante a queda (`beff9f0`)

`instrumentation.js` (gancho `register()` do Next) dispara, **em segundo plano**,
`lib/server/generation/reconcile.js`. O arranque não espera o executor, que é
outro processo e pode subir depois. Dois guardas: não roda em `next build`, não
roda fora do runtime `nodejs`.

Como um trabalho concluído é reencontrado, em ordem:

1. `/history` pelo `providerJobId`;
2. o **nosso** `jobId`, extraído do nome do arquivo de saída — é assim que o
   prefixo é montado na submissão, e é o que fecha a janela entre o `/prompt`
   aceito e a anotação do identificador;
3. o **resultado já publicado** no disco (`findMediaByJobId`).

**Nunca ressubmete** — há teste que varre o fonte. E a propriedade (projeto,
conversa, turno) vem **sempre do livro-razão**, nunca do caminho no disco: um
teste prova que a varredura pode devolver `proj_b` e o Asset ainda nasce em
`proj_a`.

**Como a mensagem é restaurada**, deterministicamente:

- se `assistantMessageId` já existe → é nela;
- senão, pela âncora: `seq(userMessageId) + 1`, **e só se** essa mensagem for
  `role=assistant` da **mesma** thread;
- caso contrário, **não anexa**. Nunca "a última mensagem", nunca o maior `seq`,
  nunca por texto ou por hora.

Nesta subetapa a fila **não** era consultada, e `orphaned` **não** podia nascer:
sem a segunda pergunta, "não encontrei" não significa "não existe".

**Provado com execução real** (a tabela da seção 11 traz os tempos e os bytes):
Showrunner morto por PID exato → ComfyUI continuou → a geração terminou → o
Showrunner voltou → Asset recuperado → ledger `done` → a mídia voltou para a
resposta certa → **zero nova submissão**. Esse smoke também encontrou o defeito
de empacotamento do gancho, que nem `npm test` nem `npm run build` pegavam.

**Limitação técnica registrada:** o carregamento por URL de runtime com
`webpackIgnore` assume a árvore do projeto disponível em `process.cwd()` — ver
limitação M.

### 10.5 · Recuperação do que ainda está EM VOO (`6a0a2b9`)

O caso mais comum: o processo volta e o trabalho **ainda está lá**. Sem ninguém
olhando, a máquina de geração é *pull* e ele para para sempre.

A reconciliação passou a fazer **duas** perguntas em massa, **uma leitura de cada
por ciclo** — nunca uma requisição por trabalho:

```
/history   +   /queue      (em paralelo, falhando de forma independente)
```

Casamento por dois caminhos: pelo `providerJobId`, e pelo **nosso** `jobId`
extraído do `filename_prefix` do nó de gravação do descriptor. Se o
`providerJobId` se perdeu na janela de queda, ele é **recuperado do grafo que
está na fila** — e continua sendo escrita única: outro identificador é recusado,
não sobrescrito.

```
queue_pending  → queued
queue_running  → running
```

Um trabalho vivo **retoma o MESMO acompanhamento do Passo 9** (`watchJob`), com o
single-flight valendo: um acompanhamento existente é reutilizado, nenhum segundo
mecanismo nasceu. Ele continua **sem Hermes e sem navegador** — nenhum dos dois
precisa estar de pé (teste varre o fonte por `hermes`, `bridge`, `window`,
`localStorage` e afins). E **sem ressubmeter**: a fila é lida, nunca modificada.

Quando o acompanhamento retomado assenta, a mídia acha a resposta certa pela
mesma regra determinística do 10.4 — ele não nasceu dentro de um turno, então
quem sabe a que mensagem pertence é o livro-razão.

**Precedência:** o histórico terminal vence a fila; o resultado publicado vence
`orphaned`.

**`orphaned` só nasce com evidência completa**, isto é, com as duas leituras
respondidas:

- o histórico saudável não conhece o trabalho, **e**
- a fila saudável não conhece o trabalho, **e**
- não existe resultado publicado.

Ele é terminal, **não cria Asset**, e não é `failed`: inventar falha afirmaria
sobre a GPU algo que ninguém observou. Tipicamente significa que o executor
reiniciou.

**Executor fora do ar nunca vira `orphaned`** — nem quando as duas leituras
falham, nem quando falha só uma. O trabalho fica aberto, e um arranque futuro o
reconcilia. Do mesmo modo, **teto ou exceção do acompanhamento retomado não vira
falha do trabalho**.

**Os dois restarts em voo foram provados deterministicamente, de ponta a ponta** —
`running` e `queued`: processo A submete (submissões = 1) → a memória some e o
SQLite fica → o executor ainda tem o trabalho → processo B reconcilia, retoma o
acompanhamento e **não** conclui nada ainda → o executor termina → o
acompanhamento retomado leva a `done`, com Asset, na resposta daquele turno, com
**submissões ainda = 1** e sem duplicar Asset, linha ou vínculo.

O smoke **real** desse caso não foi executado: a geração termina rápido demais
para controlar a janela com segurança, e improvisar ali significaria matar
processos no escuro.

### 10.6 · Operational Hardening — **BACKLOG, não bloqueia**

Fora do escopo por decisão de produto. O que ele contém:

- **backpressure** (nada limita submissões simultâneas hoje);
- **fila própria / scheduler**;
- **concorrência controlada** (uma fila com concorrência 1 resolveria dois riscos
  de uma vez);
- **cancelamento seletivo** (o `/interrupt` do ComfyUI é **global** — por isso
  ele nunca é chamado automaticamente, regra 20);
- **leases / multi-worker** (hoje a reconciliação assume um processo).

Nada disso impede o produto de funcionar agora. Ver limitação J.

### Testes do Passo 10

**1010 / 1010**, build limpo em 18/18 páginas. Cinco arquivos novos, 157 testes:
`agent-turn-anchor` (18), `generation-job-states` (18),
`domain-generation-jobs` (50), `generation-ledger-lifecycle` (27) e
`generation-reconcile` (44).

---

## 18 · PASSO 11 — DOCUMENT INGESTION ✅

**Concluído em `b2ce6b1`.** Implementado, testado, e validado com execução real.

O exemplo-guia do produto — *"transforme este PDF num documentário"* — deixou de
ser impossível. O que este passo entrega é a primeira metade dele:

```
DOCUMENTO → conteúdo estruturado dentro do Project
          → o agente descobre, lê e raciocina sobre ele
```

A segunda metade (roteiro, cenas, geração) é o Passo 12.

### O que ele aceita, e o que recusa

| | |
| --- | --- |
| **PDF com texto** | aceito. Páginas preservadas |
| **TXT em UTF-8** | aceito. BOM permitido e removido |
| **PDF escaneado / sem texto** | **recusado com honestidade** — ver abaixo |
| DOCX · PPTX · imagem · OCR | fora, e não há atalho para eles |
| embeddings · vector DB · RAG | **não existem**, e chunk não é embedding |

Um PDF válido feito só de imagens produz **422** com uma frase que diz o que
aconteceu e o que falta:

> *"Este PDF não possui texto extraível. Documentos escaneados precisam de OCR,
> que ainda não é suportado."*

Nenhuma linha no banco, nenhum arquivo órfão, e **nada inventado a partir do
nome do arquivo**. Adivinhar o conteúdo de um documento que não sabemos ler é
exatamente o desfecho que este passo existe para não produzir.

> **Chunk não é RAG.** Não há embedding, não há similaridade, não há recuperação
> por semelhança. É **paginação determinística**: uma ordem estável em que o
> agente consegue percorrer um documento maior que o contexto dele, e parar
> antes se a pergunta for localizada.

### Onde o arquivo bruto fica

```
runtime/documents/<projectId>/<documentId>/source.<ext>
```

Privado, fora do Git (`runtime/` inteiro já está no `.gitignore`), escrito com
temporário + `rename` atômico.

> **O nome que o usuário deu NUNCA participa do caminho.** Nem sanitizado, nem
> escapado. O arquivo se chama sempre `source.<ext>`, a extensão vem da tabela
> de tipos do domínio, e os dois segmentos do caminho são identificadores nossos
> — que ainda assim passam por `validateSegment` e `assertInside`.
>
> Sanitizar um nome é uma corrida que se perde devagar: `../`, `..%2f`,
> separador do Windows, NUL no meio, normalização Unicode que só acontece no
> sistema de arquivos. **Não participar da decisão é a única versão que não tem
> caso de borda.** O nome continua existindo, inteiro, como RÓTULO na coluna
> `filename`.

### Chunks

- **PDF:** um chunk por página, com `pageNumber` preservado. Uma página maior
  que o teto vira vários chunks com o **mesmo** número — a divisão é nossa, a
  página é do documento. Página vazia não vira chunk nenhum.
- **TXT:** blocos determinísticos, `pageNumber` nulo. Um TXT não tem páginas, e
  inventar "página 1" faria o agente citar uma divisão que não existe.
- **Garantia testada:** `dividir(t).join('') === t`. Nenhum caractere perdido,
  duplicado ou reordenado — é isso que permite ao agente percorrer o documento
  inteiro e **saber** que viu o documento inteiro.

A normalização é a menor possível: fim de linha, caractere NUL, espaço em branco
patológico. **Nada é "corrigido" por LLM** — o texto persistido precisa
representar o documento do usuário, porque é sobre ELE que o agente vai afirmar
coisas.

### As duas ferramentas

| Canônica | Entrada do modelo | Autoridade |
| --- | --- | --- |
| `project.list_documents` | **nenhuma** (schema vazio) | `ToolContext.projectId` |
| `project.read_document` | `documentId`, `cursor?` | `ToolContext.projectId` |

O schema de `list_documents` é vazio de propósito: o único parâmetro que ela
poderia ter é `projectId`, e ele é exatamente o campo que o modelo nunca fornece
(regra 5). Um `projectId` opcional no schema seria pior do que inútil — o modelo
o preencheria de boa-fé, e a ferramenta teria de escolher entre obedecer (e
vazar entre projetos) ou ignorar (e ter um campo que mente sobre o que faz).

**Cross-project é bloqueado**, com uma implementação só
(`getProjectDocumentIn`). "Existe mas é de outro projeto" e "não existe"
devolvem a **mesma** resposta: distingui-las diria a quem perguntou que um id
que ele não pode ver é válido.

### Como a leitura pagina

O cursor **é** o ordinal do próximo chunk — não um token opaco, não um
deslocamento em caracteres. A leitura para quando o próximo chunk não caberia
inteiro, e **nunca corta um chunk ao meio**: é isso que mantém o cursor sendo um
número só. Um chunk maior que o teto é lido sozinho, para a leitura nunca travar
naquele ponto. `eof` é **afirmado**, não deduzido de `nextCursor === null`.

Para o documento inteiro, o agente itera `read_document → nextCursor → … → eof`.
Não há laço no navegador. A instrução está em três lugares: a descrição da tool,
o schema do plugin, e a persona — *"não diga que leu o documento inteiro se não
chegou ao fim"*.

### Limites, como estão no código

| Constante | Valor | Onde |
| --- | --- | --- |
| `SHOWRUNNER_DOCUMENT_MAX_BYTES` | **25 MB** (padrão) → **413** | `documents/config.js` |
| piso de arquivo | 8 bytes | `MIN_DOCUMENT_BYTES` |
| `MAX_CHUNK_CHARS` | **4000** | `documents/config.js` |
| `MAX_READ_CHARS` | **24000** | `domain/documents.js` |
| anexos por turno | **12** | `agent/httpApi.js` |

### O parser

**`unpdf@1.8.1`** — MIT, **zero dependências**, build serverless do pdf.js. O
único peer (`@napi-rs/canvas`, o binário nativo) é **opcional e não está
instalado**: ele só serve para rasterizar, que não fazemos. Nada de OCR, Python,
Poppler ou serviço em nuvem.

Carregado por `await import('unpdf')` **dentro da função**, nunca no topo. Um
import estático faria o empacotador arrastar o parser por toda cadeia que passe
por ali — foi assim que um `node:child_process` derrubou TODA rota no Passo
10.4, um defeito que nem `npm test` nem `npm run build` pegavam. Há teste que
falha se o import virar estático, e teste que falha se o parser aparecer em
qualquer arquivo do lado do cliente.

### O anexo pertence ao TURNO

O vínculo é gravado **antes** de `runtime.run` — o que o agente vai raciocinar
sobre este turno precisa já ser um fato do banco, não uma intenção em memória.

O **texto público da mensagem não é tocado**: a linha em `agent_messages` é
exatamente o que o usuário escreveu. A metadata segura dos anexos vai ao runtime
por `context.attachments`, e como ela chega ao modelo é decisão de cada
adaptador — no Hermes, um preâmbulo privado (`agent/attachments.js`), porque
aquele runtime aceita uma coisa por turno.

Consequências, todas testadas:

- uma fala nova **não rouba** o anexo da anterior;
- uma conversa NOVA no mesmo Project **enxerga** o documento (ele é do Project)
  e **não** o tem como anexo (ele não foi anexado àquele turno);
- um documento de outro Project não entra, mesmo pedido pelo navegador.

### O que NÃO atravessa para o navegador

O texto lido, `chunks`, `nextCursor`, `ordinal`, os `arguments` da tool,
`sha256`, `runtime/documents`, caminho absoluto. O `tool.completed` de
`project.read_document` sai **sem `result`** — a redução final já descarta o
resultado de qualquer ferramenta que não produza Asset (regra 21).

O conteúdo de um documento **não tem endpoint público**. Quem o lê é o agente,
server-side, pela ferramenta. Publicá-lo por HTTP criaria um segundo caminho
para o mesmo dado, com a fronteira feita de novo — e a segunda cópia de uma
fronteira é a que alguém esquece de fechar.

### O que foi provado com execução real

| Fato | Como foi provado |
| --- | --- |
| TXT vira documento e o agente responde POR ELE | fatos artificiais, impossíveis de saber de cor: *"Arkan Vale"*, *"17 de março de 2187"*, *"Elias Venn"*. Pergunta: "Em que data Arkan Vale foi fundada e quem foi o primeiro prefeito?" → resposta correta, uma chamada de ferramenta |
| PDF real, com texto | `Prometeu_O_Fogo_da_Humanidade.pdf`, 6 páginas, 5.568 caracteres extraídos |
| "Sobre o que é este documento?" | resposta correta sobre o roubo do fogo, a punição, Heracles, o sentido simbólico |
| "Resuma em 10 pontos" | 10 pontos fiéis ao texto |
| "Proponha um mini-documentário de 2 minutos" | estrutura completa com blocos 0:00–2:00, narração e direção visual. **Nenhuma mídia gerada** — o Passo 11 para na proposta textual |
| **leitura em várias chamadas até `eof`** | PDF de **27 páginas / 43.333 caracteres** → **2 chamadas** seguindo o `nextCursor`, documento inteiro percorrido |
| sem anexo, com dois PDFs parecidos no Project | o agente listou, encontrou ambiguidade e **perguntou qual** — em vez de escolher em silêncio |
| PDF sem texto | **422** com a frase de OCR, zero linha no banco, zero arquivo órfão |
| binário renomeado `.txt` | **415** |
| PNG com nome `.pdf` | **415** |
| `%PDF-` deslocado do offset zero | **415** |
| travessia de caminho | upload com `filename=../../../../etc/passwd` → **201**, arquivo em `runtime/documents/<projectId>/<documentId>/source.txt`, `/etc/passwd` intacto, nome preservado como rótulo |
| nada vaza no SSE | varredura automatizada dos arquivos SSE dos smokes: **todos limpos** |

> Os arquivos usados nos smokes são materiais locais de quem executou. **Eles
> não são contrato de produto** e não estão no repositório. Os fixtures
> versionados ficam em `tests/fixtures/documents/` — quatro PDFs mínimos
> escritos à mão, com `gerar.mjs` documentando como foram feitos.

### Testes do Passo 11

**6 arquivos novos, 92 testes** (mais 12 da continuidade — seção 19):

| Arquivo | Testes | Protege |
| --- | --- | --- |
| `domain-documents.test.mjs` | 25 | migração 7→8, o domínio inteiro, a forma pública |
| `document-ingestion.test.mjs` | 22 | PDF real, multipágina, TXT/BOM, MIME falso, binário, limite, sem texto, travessia |
| `agent-document-tools.test.mjs` | 17 | ToolContext, cross-project, teto, cursor, eof, aliases, bridge |
| `agent-document-attachment.test.mjs` | 13 | vínculo antes do `run`, reload, texto público intacto, conversa nova |
| `agent-document-reading.test.mjs` | 6 | o turno inteiro com duplo, documento grande até `eof` |
| `documents-boundary.test.mjs` | 9 | parser fora do bundle do cliente, camadas isoladas, rota fina |

---

## 19 · THREAD CONTINUITY ✅

**Concluído em `b2ce6b1`, junto do Passo 11.** Um defeito **pré-existente**,
encontrado pelo smoke real do Passo 11 e corrigido antes de fechar o passo.

### O sintoma

O primeiro turno funcionava. Um turno SEGUINTE da **mesma AgentThread** falhava:

```
503  runtime_unavailable
"O assistente de criação está temporariamente indisponível."
```

E a única saída era o usuário clicar em "Nova conversa". Parecia intermitente:
turnos rápidos passavam, turnos com pausa não.

### A causa

Está no runtime, e é deliberada lá. `tui_gateway/server.py`,
`_schedule_ws_orphan_reap`: uma sessão cujo WebSocket criador se desconectou
**e** que não está executando nada é recolhida depois de uma janela de carência
(`HERMES_TUI_WS_ORPHAN_REAP_GRACE_S`, **20 s** por padrão).

Esta integração abre **um socket por RPC e o fecha em seguida** — então **toda
sessão nossa é órfã desde que nasce**. Meio minuto de silêncio entre duas falas
do usuário bastava para o identificador guardado deixar de existir.

```
turno 1 → createSession → socket fecha → cronômetro de 20 s
        → prompt.submit (chega em ms) → OK → socket fecha → novo cronômetro

[o usuário lê a resposta e pensa]

reaper dispara → sessão finalizada

turno 2 → garantirSessao devolve o sessionId GUARDADO, sem conferir nada
        → prompt.submit → 4001 "session not found"
        → nenhum quadro foi recebido → comoIndisponivel()
        → 503 runtime_unavailable
```

O Showrunner tratava *"a conversa do runtime foi reciclada"* (rotina) como
*"o serviço não está disponível"* (instalação quebrada).

### A regra, agora

> **A AgentThread do Showrunner é DURÁVEL. Uma conexão WebSocket não é a
> identidade da conversa.**

```
thread (durável, do Showrunner)
  └─ runtime_sessions
       ├─ bridgeSessionId  ← id DURÁVEL. Estável. É por ele que o plugin
       │                     reconhece a sessão numa chamada de ferramenta.
       └─ sessionId        ← id VIVO. Efêmero, rotativo, substituível.
```

Quando o vivo some, o turno seguinte o restabelece — e o usuário não precisa
criar conversa nova, recarregar a página, nem saber que existe um runtime.

Duas tentativas, **nesta ordem**:

1. **`session.resume`** pelo id durável. O runtime reencontra a conversa no
   armazenamento dele, **com o histórico**, e devolve um id vivo novo. O durável
   não muda.
2. **`session.create`**, só se reabrir for impossível. Degradação honesta: o
   Showrunner mantém mensagens, documentos e Assets, e o agente reencontra o
   material pelas ferramentas de documento.

A ordem importa muito: nesta integração o adaptador manda ao runtime **apenas a
última fala do usuário** — o histórico da conversa mora do lado de lá. Recriar
sempre faria *"resuma esse documento"* chegar a um modelo que nunca viu
documento nenhum.

### Por que a detecção é conjuntiva

`4001` **não** é "session not found" neste protocolo. Auditado no fonte da
v0.20.3: ele é o **"400"** do runtime e aparece em **mais de vinte lugares**,
para condições sem nenhuma relação com sessão — `"malformed server config"`,
`"pcm frame too large"`, `"slug is required"`, `"invalid base64 pcm"`.

Dentro de `prompt.submit`, hoje, ele tem origem única. Mas isso é um detalhe
**interno** de um método de terceiro, e apostar nele significaria que um `4001`
novo acrescentado ali no futuro viraria uma retomada silenciosa e errada.

Então são **três condições, todas obrigatórias**:

| Condição | Robustez |
| --- | --- |
| `rotulo === 'prompt.submit'` | **alta** — é um valor NOSSO, escrito por esta camada |
| `codigo === 4001` | média — recusa por pré-condição, não erro de transporte |
| `motivo` contém `session not found` | baixa — texto de terceiro |

O texto entra porque o código é ambíguo e é o único campo estruturado que resta
(`_err` produz apenas `{code, message}`). Ele entra **em conjunção** com dois
sinais robustos.

> **O modo de falhar foi escolhido, não sofrido.** Se o runtime reescrever a
> frase, a detecção devolve `false`, o turno falha como falhava antes, e
> NENHUMA sessão é restabelecida por engano. Errar para o lado de *não retomar*
> repete um defeito conhecido; errar para o outro lado repetiria a fala do
> usuário contra uma recusa que não era sobre sessão nenhuma.

### Os limites da retomada

- **No máximo uma vez por turno.** Sem teto, um runtime que recusasse toda
  sessão viraria um laço infinito.
- **Só enquanto NADA foi dito.** Repetir depois de o modelo ter começado a falar
  produziria **duas respostas para um turno**.
- **Turno cancelado não é retomado.** O usuário mandou parar; reabrir a conversa
  para insistir seria o oposto de obedecer.
- **O registro de turnos não vaza.** A sessão nova só é adotada no começo da
  volta seguinte, então o `finally` sempre desanuncia o identificador que aquela
  volta anunciou. Testado com `turns.size() === 0` após cada turno, com e sem
  retomada.
- **Uma linha de sessão por thread, sempre.** `rebindRuntimeSession` é
  DELETE + INSERT numa transação, com `UNIQUE(threadId, runtimeId)`.

### O que foi provado com execução real

**Uma AgentThread, quatro turnos, 25 s de pausa entre eles** (carência = 20 s,
para *garantir* que o reap acontecesse):

| Turno | Ferramentas | Resultado |
| --- | --- | --- |
| "Sobre o que é este documento?" | `project.read_document` | ✅ |
| "Agora resuma esse documento em 10 pontos." | — | ✅ |
| "Com base nele, proponha um mini-documentário de 2 minutos." | — | ✅ |
| "Qual foi a punição de Prometeu segundo o documento?" | — | ✅ |

Evidência de que o defeito foi de fato exercitado:

```
reaps registrados pelo runtime:      4
sessões DURÁVEIS criadas no smoke:   1
retomadas no log do Showrunner:      3   (turnos 2, 3 e 4)
linhas de sessão para a thread:      1
```

Uma sessão durável só, criada no turno 1, reciclada 4 vezes, reaberta 3. Zero
`runtime_unavailable`, zero "Nova conversa" como contorno, oito mensagens em
ordem sem duplicata, `threadId` idêntico do primeiro ao último turno, e nada de
`hermes` / `session` / `ws_orphan_reap` nos eventos públicos.

> Os turnos 2–4 responderam sobre o PDF **sem reler o documento**. Isso é a
> prova de que foi `session.resume` e não `session.create`: o histórico do lado
> do runtime sobreviveu.

### Testes

`tests/agent-thread-continuity.test.mjs` — **12 testes**. Com a correção
revertida, **5 deles falham**, incluindo o central. O duplo
(`criarSessoesFalsas`) imita o ciclo de vida real — distingue vivo de durável, e
`reciclar()` é o reap sem esperar os 20 s de relógio de parede.

Dois deles trancam a especificidade da detecção: `4001` com outras mensagens
**não** dispara retomada; a combinação exata do runtime real **dispara**.

---

## 20 · QUALITY GATE — CORE AUDIOVISUAL E2E ✅

**Executado À MÃO, no produto real, pelo navegador.** Não é teste automatizado e
não roda em `npm test`.

### Ambiente

| Serviço | Endereço | Versão |
| --- | --- | --- |
| Showrunner (Next) | `127.0.0.1:3100` | — |
| Hermes dedicado | `127.0.0.1:8788` | v0.20.3 |
| ComfyUI | `127.0.0.1:8188` | — |

### O fluxo comprovado

1. **O Agent abriu normalmente.**
2. **"quem é você?"** → *"Sou o Showrunner. Ajudo a transformar ideias e
   materiais em imagens e vídeos, da conversa criativa até a geração da cena."*
   Identidade correta; nenhum nome de runtime.
3. **Geração real de imagem** pedida em linguagem natural → a imagem foi gerada
   e apareceu no Agent.
4. **"anime essa imagem"**, com instruções de movimento → o agente **entendeu a
   referência à imagem anterior** e um vídeo foi gerado.
5. **O vídeo apareceu na conversa.**
6. **Não foi preciso mandar "e aí?"** — o acompanhamento do servidor levou a
   geração até o fim sozinho (Passo 9).
7. **Após reload (F5):** imagem e vídeo continuaram na conversa.
8. **"Nova conversa":** abriu outra thread **sem apagar** a anterior.

```
conversa → identidade Showrunner → T2I real → Asset aparece
         → referência natural "essa imagem" → vídeo real → vídeo aparece
         → reload preserva a mídia → nova conversa preserva a thread anterior
```

### ⚠️ A ressalva medida — `derivedFromAssetId`

**A linhagem NÃO foi gravada nesta execução, e isso foi verificado no banco.**

Consulta read-only em `runtime/showrunner.db`, no projeto do Quality Gate:

```
image  2026-09-09T14:24:02Z  asset_mtu6vqxg_d7ad3d33   derivedFrom: —
video  2026-09-09T14:32:23Z  asset_mtu76i49_63170f64   derivedFrom: —   ← nulo
```

E o livro-razão da geração de vídeo:

```
workflowId          minimax_h3_t2v      ← TEXT-to-video
derivedFromAssetId  (nulo)
```

**O que isso quer dizer, com precisão:**

- o comportamento **conversacional** funcionou: o agente entendeu *"essa
  imagem"*, chamou `og.generate_video`, e o vídeo resultante correspondeu ao
  pedido;
- mas ele chamou a ferramenta **sem `sourceAssetId`**. Não houve
  image-to-video: houve um **text-to-video** cujo prompt descrevia a imagem;
- por isso não há linhagem — não havia o que registrar.

**O mecanismo i2v não está quebrado.** Ele existe (`og.generate_video` aceita
`sourceAssetId`, valida projeto e `kind`, e a facade grava
`derivedFromAssetId`), está coberto pela suíte determinística, e há um Asset
mais antigo no banco que o comprova:

```
video  2026-09-03  asset_mtlstp28_bc1537a3
       derivedFrom: asset_mtlsae20_daf09b6e  (kind=image, smoke-final.png)
```

O que **não** foi exercitado neste Quality Gate foi o caminho i2v. Fica em
aberto, e é a primeira coisa a repetir no próximo gate:

> **PENDENTE:** provar que *"anime essa imagem"* leva o agente a passar
> `sourceAssetId`, e que o vídeo nasce com `derivedFromAssetId` apontando para o
> Asset da imagem. Vale investigar se a descrição da ferramenta orienta o modelo
> a isso com clareza suficiente, e se o único workflow de vídeo registrado
> (`minimax_h3_t2v`) precisa de um irmão explícito de i2v no registry.

Nenhum dado foi alterado nesta verificação.

### Incidente de operação — não é bug do Agent

No início do gate o Agent respondeu *"O assistente de criação está
temporariamente indisponível."*

**Causa:** o Hermes dedicado não estava rodando na porta 8788. Depois de subir o
runtime dedicado (`GET /api/health` → 200, Hermes 0.20.3), o Agent voltou a
funcionar.

Isto é o **fail-closed funcionando como projetado** (seção 4): sem runtime, a
resposta é um erro seguro com uma frase de produto — nunca um eco silencioso.

> **Desenvolvimento local precisa de três processos.** `ComfyUI :8188`,
> `Hermes dedicado :8788`, `Next :3100`. Ver a seção 12 e
> `integrations/hermes/README.md`, que é o procedimento oficial de subida.

### Nota operacional — `.next`

Houve também um `ENOENT: .next/server/app/studio/[[...slug]]/page.js`, resolvido
parando o dev server, removendo `.next` e reiniciando.

Não é problema de arquitetura. É a mesma armadilha já registrada na seção 12:
**não rode `npm run build` com o `next dev` vivo usando o mesmo `.next`** — o
build sobrescreve os chunks do dev.

---

## 21 · O que está aberto, e o próximo passo

### O estado, em quatro linhas

```
Passos 1–10 CORE ...................... ✅
Passo 11 · Document Ingestion ......... ✅
Thread Continuity ..................... ✅
Quality Gate · Core Audiovisual E2E ... ✅   (com a ressalva da seção 20)

10.6 · Operational Hardening .......... ⏸ backlog
```

### NEXT — PASSO 12: PRODUCTION PLANNING

O Passo 11 entregou a primeira metade do exemplo-guia do produto: o material
entra e o agente o lê. O Passo 12 é a segunda metade — o que se FAZ com ele.

```
Material / ProjectDocument
  → proposta narrativa
  → roteiro estruturado
  → cenas
  → preparação para geração audiovisual
```

**Ele ainda não foi começado.** Nada dele existe no código.

Dois pontos de partida que já estão no lugar e não precisam ser inventados:

- o domínio **já tem `scenes`** (migração 1), com número, título, descrição,
  duração, status e imagem — falta a ponte da conversa até ele;
- o vocabulário de aprovação **já existe** em `lib/approval.js`.

E uma coisa a resolver antes de confiar no fim do pipeline: a ressalva de
`derivedFromAssetId` da seção 20. Um plano de produção que gere cenas encadeadas
depende de a linhagem entre Assets ser real, e o Quality Gate mostrou que o
caminho i2v **não** foi exercitado pelo agente.

### As frentes que continuam abertas

Nada aqui está escolhido, além do Quality Gate acima. É o mapa, com o que cada
frente exige — a ordem é decisão de produto.

| Frente | O que ela exige, concretamente |
| --- | --- |
| **Passo 12 — Production Planning** | **o próximo.** Documento → proposta narrativa → roteiro → cenas. O domínio já tem `scenes`; falta a ponte da conversa até ele |
| **i2v pelo agente, com linhagem** | o Quality Gate mostrou que "anime essa imagem" NÃO passou `sourceAssetId`. Ver a ressalva da seção 20 |
| **10.6 — Operational Hardening** | fila própria, backpressure, concorrência controlada, cancelamento seletivo, leases/multi-worker (limitação J) |
| **OCR / PDF escaneado** | fora do Passo 11 por decisão. Hoje um PDF sem texto é recusado com honestidade |
| **Conhecimento / RAG** | limitação G. Os chunks do Passo 11 não são isso |
| **Memória de projeto, personagens, continuidade** | limitação H — é o que faz um personagem parecer o mesmo entre cenas |
| **Approvals** | o vocabulário já existe em `lib/approval.js`; falta o fluxo |
| **Montagem final** | juntar os planos aprovados numa peça só |
| **Multi-provider / nuvem** | hoje só ComfyUI local |
| **WhatsApp e outros canais** | a arquitetura permite (toda decisão mora no servidor), nada foi construído — limitação I |
| **Research Lab** | — |

Duas coisas que não são frentes, mas continuam pendentes e são baratas:

- o **`README.md` da raiz** segue desatualizado (limitação L);
- **autenticação** passa a ser obrigatória se o Gateway sair de `127.0.0.1`
  (limitação K).

---

## 22 · NON-NEGOTIABLE ARCHITECTURE RULES

Cada regra existe porque a alternativa já causou, ou causaria, um defeito
concreto. Não são preferência de estilo.

1. **O Hermes não possui state de produção.** Project, Scene, Asset, Job,
   storage, approvals e memória estrutural pertencem ao Showrunner.
2. **O browser nunca fala diretamente com o Hermes.** Sempre pelo Agent Gateway.
3. **O browser nunca escolhe runtime.** A escolha é de operador, por variável de
   ambiente, no servidor. A AgentScreen não contém uma única ocorrência de
   `runtime`, `echo` ou `hermes` — e há teste que garante isso.
4. **O Echo não é fallback do produto.** É runtime de teste, alcançável só por
   nome explícito. Falta de configuração vira **erro seguro**, nunca eco.
5. **O modelo nunca fornece `projectId`, `threadId`, `sessionId`, `workflowId`,
   caminho ou id de nó.** Esses valores vêm do ToolContext, montado no servidor.
6. **Tools só executam com ToolContext confiável.** Nenhuma tool deduz identidade
   a partir de argumento.
7. **Alias do Hermes ≠ nome canônico da tool.** `og_generate_image` é detalhe da
   integração; `og.generate_image` é o nome. Nenhum alias chega à UI ou a um
   AgentEvent.
8. **O plugin do Hermes é fino.** Ele encaminha. Não executa geração, não acessa
   disco, não conhece projeto.
9. **O bridge faz allowlist.** Tabela fechada; nome desconhecido morre antes de
   virar chamada.
10. **Project, Asset e Job pertencem ao Showrunner** e a mais ninguém.
11. **Asset só nasce depois de `DONE` real.** Estado intermediário não cria Asset.
12. **Caminhos internos não chegam à UI.** A mídia vem de `asset.mediaUrl`, nunca
    montada a partir de diretório + nome de arquivo.
13. **A identidade pública é sempre "Showrunner".** `agentName` é constante.
14. **Internals de runtime não vazam** — nem em resposta normal, nem em erro, nem
    em `detail`. Diagnóstico vai para o log, não para o navegador.
15. **Não criar Projects fantasma.** `registerProject` exige descritor explícito;
    `ensureProject` fica fora do barril e fora do alcance das tools.
16. **"Nova conversa" não apaga conversa.** Cria outra thread e move o ponteiro.
17. **Não modificar o core do Hermes.** Tudo o que o Showrunner precisa dele vive
    em `integrations/hermes/`, instalado por symlink. Trocar ou atualizar o
    runtime não deve exigir mudança no código do Showrunner.
18. **Rota fina, lógica em `lib/server/`.** As Route Handlers só leem o corpo e
    montam a resposta; a decisão mora em módulos testáveis com `node:test`. As
    rotas importam o gateway, jamais o contrário.
19. **A autonomia é do servidor.** Nem o modelo nem o navegador podem ser a
    razão de um trabalho progredir. O modelo esquece porque o turno dele acaba;
    o navegador fecha. Quem aceitou o trabalho o leva até o fim.
20. **Cancelar o turno não cancela uma geração já aceita.** E `/interrupt` do
    ComfyUI nunca é chamado automaticamente, porque é global.
21. **O evento público não é o resultado interno da ferramenta.** São duas
    reduções (seção 4). O `jobId` existe no evento interno porque o gateway
    precisa dele; ele não atravessa para o navegador. E a ordem importa: o
    servidor lê o interno ANTES de entregar o público — recuperar o `jobId` do
    evento sanitizado faria a autonomia depender da superfície que existe para
    escondê-lo.
22. **O acompanhamento é andaime, não obra.** Ele sai da memória depois de uma
    janela curta, e **nenhuma tabela nasceu para ele** — há teste que falha se
    nascer. O que dura é o TRABALHO (`generation_jobs`), o Asset e o vínculo com
    a mensagem. Depois de um reinício o andaime é **reconstruído** a partir do
    livro-razão, nunca lido de uma tabela de vigília.
23. **A recuperação NUNCA ressubmete.** Reconciliar é observar: `/prompt` não é
    chamado, a fila é lida e jamais modificada. Um reinício que regerasse
    trabalho gastaria GPU sem ninguém pedir e produziria uma segunda mídia para o
    mesmo pedido. Há teste que varre o fonte.
24. **Ignorância não vira desfecho.** `orphaned` — e qualquer estado terminal
    negativo — exige **evidência completa**: o executor precisa ter respondido, e
    ter dito que não conhece o trabalho. Executor fora do ar é executor fora do
    ar; teto ou exceção do acompanhamento é fim da vigília, não falha da GPU. Em
    todos esses casos o trabalho fica **aberto**, e reconciliável.
25. **A propriedade vem do livro-razão, nunca do disco nem do executor.** O
    caminho de um arquivo diz **onde** ele está; de quem ele é já estava gravado.
    Foi a falta disso que fazia a recuperação antiga jogar trabalho recuperado
    numa pasta genérica.
26. **A mídia recuperada volta pela âncora do turno**, não por "a última
    mensagem": `assistantMessageId` se existir, senão `seq(userMessageId) + 1`
    **conferindo papel e thread**, senão não anexa. Uma fala nova no meio, ou uma
    conversa nova, não podem roubar o resultado.
27. **A AgentThread é durável; a sessão do runtime é andaime.** Uma conexão
    WebSocket não é a identidade da conversa. O runtime recicla a sessão dele
    sozinho — o turno seguinte a restabelece pelo id DURÁVEL, e o usuário não
    precisa criar conversa nova nem saber que existe um runtime. A retomada
    acontece no máximo uma vez por turno, só enquanto nada foi dito, e nunca
    num turno cancelado. Ver seção 19.
28. **Ignorância de terceiro não vira certeza nossa.** Um código de erro de um
    serviço externo só identifica a falha quando ele é inequívoco naquele
    protocolo. `4001` do runtime não é — ele serve a mais de vinte condições —,
    e por isso a detecção de "sessão reciclada" é conjuntiva. Quando a
    identificação depende de texto de terceiro, o modo de falhar tem de ser
    escolhido: aqui, uma frase reescrita faz a retomada deixar de acontecer,
    nunca acontecer por engano.
29. **Documento não é Asset.** Asset é mídia que a produção PRODUZIU; documento
    é material que ENTRA. E o documento pertence ao **Project**, enquanto o
    anexo pertence ao **turno** — são duas perguntas, com respostas diferentes,
    e é essa separação que faz "este PDF" ter referente sem heurística.
30. **O nome de arquivo do usuário nunca participa de um caminho.** Nem
    sanitizado. O arquivo se chama `source.<ext>` sob identificadores nossos, e
    o nome sobrevive apenas como rótulo. Sanitizar é uma corrida que se perde
    devagar; não participar da decisão é a única versão sem caso de borda.
31. **O que é escrito uma vez é conflito, não sobrescrita.** `providerJobId` e
    `assistantMessageId` aceitam o **mesmo fato** repetido (replay é idempotente)
    e recusam um fato diferente. É o que torna reconciliação e acompanhamento
    seguros rodando juntos.

---

## 23 · Mapa de arquivos

Só o que ajuda a navegar. Não é catálogo do repositório.

### Agent — frontend

| Caminho | Papel |
| --- | --- |
| `components/screens/AgentScreen.jsx` | a tela da conversa |
| `lib/agentClient.js` | redução pura de AgentEvents + rede (`ensureThread`, `startNewThread`, `streamTurn`) |
| `components/ui/primitives.jsx` | `Button`, `Textarea`, `Panel` |

### Agent — API e gateway

| Caminho | Papel |
| --- | --- |
| `app/api/agent/threads/route.js` | criar / listar conversas |
| `app/api/agent/threads/[threadId]/route.js` | ler uma conversa |
| `app/api/agent/messages/route.js` | um turno, resposta JSON |
| `app/api/agent/stream/route.js` | um turno, SSE |
| `lib/server/agent/httpApi.js` | **a decisão inteira da API**, sem HTTP |
| `lib/server/agent/gateway.js` | o turno: valida, persiste, normaliza, orquestra |
| `lib/server/agent/events.js` | o vocabulário público de eventos, e `publicAgentEvent` — a redução final antes do navegador |
| `lib/server/agent/threads.js` | AgentThread / AgentMessage / vínculo de mídia |
| `lib/server/agent/index.js` | barril de entrada |
| `lib/server/agent/attachments.js` | o aviso privado ao modelo sobre os documentos do turno — é PRODUTO, não integração |

### Runtime adapters

| Caminho | Papel |
| --- | --- |
| `lib/server/agent/AgentRuntimePort.js` | o contrato |
| `lib/server/agent/runtimes.js` | **a tabela de seleção** — o único lugar que sabe quais runtimes existem |
| `lib/server/agent/adapters/HermesRuntimeAdapter.js` | o runtime de produção |
| `lib/server/agent/adapters/EchoRuntimeAdapter.js` | o piso determinístico de teste |

### Integração Hermes

| Caminho | Papel |
| --- | --- |
| `lib/server/agent/hermes/runtimeClient.js` | WebSocket + JSON-RPC; documenta o que mudou da v0.19 |
| `lib/server/agent/hermes/eventTranslator.js` | eventos do runtime → vocabulário do Showrunner |
| `lib/server/agent/hermes/identity.js` | o identity guard |
| `lib/server/agent/hermes/bridge.js` | socket Unix `0600`, registro de turnos |
| `lib/server/agent/hermes/aliases.js` | tabela fechada de nomes |
| `lib/server/agent/hermes/sessionBinding.js` | sessão ↔ thread, os dois ids |
| `integrations/hermes/README.md` | **como operar** — leia antes de subir o runtime |
| `integrations/hermes/prepare.mjs` | prepara o `HERMES_HOME` dedicado |
| `integrations/hermes/persona/showrunner.md` | **a persona — fonte de verdade** |
| `integrations/hermes/config.template.yaml` | modelo do `config.yaml` dedicado |
| `integrations/hermes/showrunner-plugin/` | o plugin (instalado por symlink) |

### Tools

| Caminho | Papel |
| --- | --- |
| `lib/server/agent/tools/registry.js` | o único ponto de execução |
| `lib/server/agent/tools/schema.js` | `defineTool`, validação de entrada |
| `lib/server/agent/tools/handlers/generateImage.js` | `og.generate_image` |
| `lib/server/agent/tools/handlers/generateVideo.js` | `og.generate_video` |
| `lib/server/agent/tools/handlers/getJob.js` | `og.get_job` |
| `lib/server/agent/tools/handlers/listDocuments.js` | `project.list_documents` |
| `lib/server/agent/tools/handlers/readDocument.js` | `project.read_document` |
| `lib/server/agent/tools/jobWatch.js` | **o acompanhamento**: single-flight, laço, teto, ciclo de vida, associação |

### Geração

| Caminho | Papel |
| --- | --- |
| `lib/server/generation/facade.js` | API de alto nível; onde o Asset nasce e onde o livro-razão é escrito |
| `lib/server/generation/reconcile.js` | **a recuperação de arranque**: `/history` + `/queue`, finalização, acompanhamento retomado, `orphaned` |
| `lib/server/generation/jobStates.js` | reexportação do vocabulário do domínio (nada é decidido aqui) |
| `lib/server/generation/comfyJobState.js` | tradução do estado do ComfyUI → estado do Showrunner, tabela fechada |
| `lib/server/generation/mediaKinds.js` | tabela por tipo (diretório, MIME, extensões) |
| `lib/server/generation/outputs.js` | descoberta de saída (puro) |
| `lib/server/generation/mediaServing.js` | resolução de requisição de mídia, byte range |
| `lib/server/generation/workflows/descriptor.js` | o contrato de workflow |
| `lib/server/generation/workflows/registry.js` | `getWorkflow` / `listWorkflows` |
| `lib/server/generation/workflows/ideogram4.js` | descriptor do Ideogram 4 |
| `lib/server/generation/workflows/minimaxH3.js` | descriptor do MiniMax H3 |
| `lib/server/generation/workflows/paths.js` | raízes e resolução segura de caminho |

### Domínio

| Caminho | Papel |
| --- | --- |
| `lib/server/domain/db.js` | conexão, esquema, **migrações** |
| `lib/server/domain/generationJobStates.js` | **o vocabulário de estados de geração** — zero imports, é domínio |
| `lib/server/domain/generationJobs.js` | **o livro-razão**: a única porta de escrita de `generation_jobs` |
| `lib/server/domain/projects.js` | Project (`registerProject`, `ensureProject`) |
| `lib/server/domain/scenes.js` | Scene |
| `lib/server/domain/assets.js` | Asset e linhagem |
| `lib/server/domain/backfill.js` | registro de mídia já em disco (idempotente) |
| `lib/server/domain/documentTypes.js` | **o vocabulário dos tipos de documento** — zero imports, é domínio |
| `lib/server/domain/documents.js` | **o documento do Project**: criação transacional, leitura paginada, fronteira de projeto |
| `lib/server/domain/index.js` | barril — **note o que ele deliberadamente não exporta** |

### Ingestão de documentos (Passo 11)

| Caminho | Papel |
| --- | --- |
| `lib/server/documents/config.js` | limites de operador |
| `lib/server/documents/storage.js` | os bytes originais, privados — e o nome do usuário que NUNCA vira caminho |
| `lib/server/documents/extract.js` | PDF/TXT → texto normalizado em pedaços. **O único arquivo que carrega o parser**, e por import dinâmico |
| `lib/server/documents/ingest.js` | a orquestração: valida, fareja, grava, extrai, persiste |
| `lib/server/documents/httpApi.js` | a decisão da API, sem HTTP |
| `app/api/documents/route.js` | a rota fina: lê o multipart e delega |

### ComfyUI

| Caminho | Papel |
| --- | --- |
| `lib/server/comfy/config.js` | `COMFY_BASE_URL`, `RUNTIME_ROOT` |
| `lib/server/comfy/jobs.js` | os jobs, em memória |
| `lib/server/comfy/client.js` | HTTP com o ComfyUI |
| `lib/server/comfy/storage.js` | `validateSegment` e caminhos |
| `lib/server/appRoot.js` | `APP_ROOT` descoberto |
| `instrumentation.js` (raiz) | o gancho de arranque do Next — dispara a reconciliação em segundo plano |

### Workflows versionados

| Caminho | Papel |
| --- | --- |
| `workflows/ideogram4_t2i_api.json` | Ideogram 4, 29 nós |

### Testes

| Caminho | Papel |
| --- | --- |
| `tests/*.test.mjs` | 59 arquivos, 1010 testes, na suíte |
| `tests/agent-job-autonomy.test.mjs` | o Passo 9 inteiro — 40 testes |
| `tests/agent-event-surface.test.mjs` | a fronteira pública dos eventos — 12 testes |
| `tests/agent-turn-anchor.test.mjs` | a âncora do turno (10.0) — 18 testes |
| `tests/generation-job-states.test.mjs` | vocabulário e tradução de estados (10.1) — 18 testes |
| `tests/domain-generation-jobs.test.mjs` | o livro-razão (10.2) — 50 testes |
| `tests/generation-ledger-lifecycle.test.mjs` | o livro-razão no ciclo real (10.3) — 27 testes |
| `tests/generation-reconcile.test.mjs` | a recuperação de arranque (10.4 + 10.5) — 44 testes |
| `tests/helpers/runtimeFalso.mjs` | o runtime falso do adaptador |
| `tests/domain-documents.test.mjs` | o domínio do documento (Passo 11) — 25 testes |
| `tests/document-ingestion.test.mjs` | a ingestão real, com PDFs de verdade — 22 testes |
| `tests/agent-document-tools.test.mjs` | as ferramentas de documento — 17 testes |
| `tests/agent-document-attachment.test.mjs` | o anexo do turno — 13 testes |
| `tests/agent-document-reading.test.mjs` | o caminho inteiro, sem runtime real — 6 testes |
| `tests/documents-boundary.test.mjs` | as fronteiras da ingestão — 9 testes |
| `tests/agent-thread-continuity.test.mjs` | a continuidade da thread (seção 19) — 12 testes |
| `tests/fixtures/documents/` | quatro PDFs mínimos versionados + o `gerar.mjs` que os produz |
| `tests/smoke-hermes-real.mjs` | smoke real com Hermes — **fora** da suíte |
| `tests/smoke-i2v-real.mjs` | smoke real de i2v — **fora** da suíte |

### Documentação

| Caminho | Papel |
| --- | --- |
| `docs/AGENT_IMPLEMENTATION_STATUS.md` | **este documento** |
| `docs/open-generative-hermes-architecture-audit.pdf` | auditoria arquitetural, 27 páginas |
| `integrations/hermes/README.md` | operação do runtime dedicado |
| `README.md` | visão geral do produto — **desatualizado**, ver limitação L |
| `PASSO-6-*.md` (raiz) | relatórios históricos do Passo 6 |

---

## 24 · Convenções que valem a pena preservar

- **Injeção de dependência no estilo da casa:** último parâmetro com default
  (`db = database()`, `root = RUNTIME_ROOT`, `deps = {}`). É o que torna tudo
  testável sem mocking.
- **Vocabulários gerados** a partir dos módulos que já os definem — não há lista
  de status duplicada em SQL para divergir.
- **`node:test`, sem dependências.** Vários testes são regressões de falhas reais
  e trazem a causa no cabeçalho: se um quebrar, o refactor está errado.
- **Nenhum `if (workflowId === '...')`** na infraestrutura genérica. O que dirige
  o comportamento é `descriptor.kind`.
- **Comentários explicam o porquê, não o quê.** Vários cabeçalhos deste código
  documentam decisões e os defeitos que elas evitam. Apagá-los apaga a razão
  junto com o risco — e os testes de arquitetura removem comentários antes de
  varrer justamente para que a explicação possa citar o que o código não pode.
- **O texto da interface é em português**, em linguagem de produção, nunca de
  sistema.
