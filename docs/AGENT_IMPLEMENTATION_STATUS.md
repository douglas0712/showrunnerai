# Showrunner — estado da implementação e handoff

Documento **autossuficiente**. Um agente de código que abra este repositório
pela primeira vez deve conseguir ler só este arquivo e saber onde o projeto
está, o que é verdade, o que não é, e o que continua aberto.

Ele não depende de `/tmp`, de scratchpad, de histórico de conversa nem da
memória de nenhuma sessão.

**Atualizado em:** 8 de setembro de 2026
**HEAD documentado:** `8f57fa2c465220650da6e05c31a8662eac03b43a`

> **Regra de precedência.** Se este documento divergir do código ou do Git, **o
> código e o Git são a fonte de verdade**. Verifique antes de confiar. Foi
> exatamente assim que esta revisão foi escrita: a versão anterior dizia "434
> testes", "branch `feat/showrunner-agent-foundation`", "Echo é o padrão" e
> "Asset ainda não é criado em `finalizeJob`" — as quatro estavam obsoletas.

---

## START HERE FOR THE NEXT CODING AGENT

1. Leia este documento inteiro. Ele tem tudo o que você precisa para começar.
2. `git status --short` — esperado: **vazio** (árvore limpa).
3. `git log --oneline -5` — esperado: `8f57fa2` no topo.
4. `npm test` — esperado: **853 testes, 853 passando, 0 falhando** (~3 min).
5. `npm run build` — esperado: compila limpo, 18 páginas estáticas.
6. **Não refaça os Passos 1–9.** Eles estão prontos, testados e commitados.
7. **Não há um próximo passo já escolhido.** A seção 16 registra o Passo 9 e
   lista as frentes que continuam abertas, com o que cada uma exige. Escolher
   entre elas é decisão de produto — não do próximo agente.
8. Preserve as **NON-NEGOTIABLE ARCHITECTURE RULES**. Elas não são estilo: cada
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
| HEAD | `8f57fa2c465220650da6e05c31a8662eac03b43a` |
| Working tree | limpa |
| Testes | 853 / 853 passando, 0 falhas |
| Build | limpo (`✓ Compiled successfully`, 18/18 páginas) |
| Node | v24.x (usa `node:sqlite`, experimental) |
| Next | 15.5.15 · React 19.2.8 |

> `origin/main` está **sincronizado** com `main`, em `8f57fa2`. Nada existe só
> localmente.

### Checkpoints importantes

| Commit | O que entrou |
| --- | --- |
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
  │
  ▼
workflow registry → ComfyUI → Jobs → Assets
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
| AgentThreads / AgentMessages | `lib/server/agent/threads.js` |
| Jobs | `lib/server/comfy/jobs.js` |
| levar uma geração iniciada até o fim | `lib/server/agent/tools/jobWatch.js` |
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

E dentro do WebSocket, **três métodos e nada mais**:

| Método | Para quê |
| --- | --- |
| `session.create` | abre a conversa do lado do runtime |
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
og.generate_image
og.generate_video
og.get_job
```

Definidos em `lib/server/agent/tools/handlers/`.

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
og_generate_image  →  og.generate_image
og_generate_video  →  og.generate_video
og_get_job         →  og.get_job
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

**`ESQUEMA_ATUAL = 6`** (seis migrações aplicadas).

| # | Migração | Entidade |
| --- | --- | --- |
| 1 | `projects`, `scenes`, `assets` | domínio base |
| 2–3 | `agent_threads`, `agent_messages` | conversa |
| 4 | `runtime_sessions` | vínculo sessão ↔ thread |
| 5 | `agent_message_assets` | mídia de uma mensagem, por referência |
| 6 | `runtime_sessions.bridgeSessionId` | o segundo nome da mesma sessão |

Tabelas `STRICT`, chaves estrangeiras ligadas, `CHECK` gerado a partir dos
vocabulários que já existem em `lib/storyboard.js` e `lib/approval.js` — não há
lista de status duplicada em SQL para divergir.

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
| image-to-video | **MiniMax H3** (`minimax_h3`) | **validado com geração real** |

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

**853 testes, 853 passando, 0 falhando.** 54 arquivos `tests/*.test.mjs`, com
`node:test`, sem dependências. Sem rede, sem GPU, sem runtime externo, sem
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

O runtime falso vive em `tests/helpers/runtimeFalso.mjs`.

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

Nada acima é suposição. O que **não** foi executado não está nesta tabela.

---

## 12 · Como subir o ambiente

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
  o banco, os projetos, a mídia, os logs e o socket Unix.
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

Resolvido em `8f57fa2`. Ver seção 16. **O que continua valendo** é a limitação
**B** logo abaixo: o acompanhamento vive enquanto o processo viver.

### B. Jobs vivem em memória do processo

`lib/server/comfy/jobs.js` guarda um `Map` em `globalThis` (para sobreviver ao
Fast Refresh do Next). **Reiniciar o servidor perde os handles dos jobs.**

O acompanhamento do Passo 9 vive do mesmo jeito, e isso é deliberado: gravar o
acompanhamento num banco enquanto o job continua em memória criaria uma linha
durável apontando para um trabalho que já não existe — durabilidade de fachada,
que é pior do que nenhuma. **Reiniciar o processo perde o acompanhamento junto
com o job.** O que sobrevive é o que já estava no banco: Asset e o vínculo com a
mensagem. Nenhuma tabela nasceu para o watcher, e há teste que falha se nascer.
`recoverFromHistory` mitiga, mas só para o que tem o prefixo de saída da
aplicação.

### C. Reinício do runtime e retomada de sessão têm limitação conhecida

O `sessionId` do gateway morre com o processo do runtime. O `bridgeSessionId`
durável é gravado, mas não há hoje um caminho de **reconexão** que revalide uma
sessão órfã: se o runtime reiniciar no meio de uma conversa, o próximo turno
daquela thread pode falhar até que uma sessão nova seja criada.

### D. Atividade temporária não é reconstruída no reload

Deliberado — ver seção 9. Não "conserte" isso sem decidir o que significa
mostrar um trabalho que já terminou.

### E. Threads antigas podem não ter associação de mídia retroativa

`agent_message_assets` entrou na migração 5. Mensagens gravadas **antes** dela
não ganharam vínculo retroativo; a mídia dessas conversas antigas não reaparece
no reload.

### F. Ingestão de PDF/documentos não existe no Agent

"Transforme este PDF em um documentário" ainda não é possível. Não há upload, não
há parsing, não há extração.

### G. RAG não existe

Sem base de conhecimento, sem embeddings, sem recuperação.

### H. Memória de projeto, personagens e continuidade não existem

Nada mantém a aparência de um personagem entre cenas, nem lembra decisões de
direção entre conversas.

### I. WhatsApp e outros canais não existem

A arquitetura permite (a decisão está toda no servidor), mas nada foi construído.

### J. Fila de produção durável não existe

E há dois riscos concretos ligados a isso:

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

**853 / 853**, build limpo em 18/18 páginas. Ver seção 11 para o que os dois
arquivos novos cobrem.

---

## 16.1 · O que está aberto

Nada aqui está escolhido. É o mapa das frentes que continuam abertas, com o que
cada uma exige — a ordem é decisão de produto.

| Frente | O que ela exige, concretamente |
| --- | --- |
| **Jobs duráveis / fila / recuperação** | é a continuação natural do Passo 9, e a única que **remove uma limitação já registrada** (B e J). Fila própria com concorrência 1 resolveria de uma vez o `/interrupt` global e a falta de backpressure |
| **Ingestão de PDF/documentos** | destrava "transforme este PDF num documentário", que é o exemplo-guia do produto. Não há upload, parsing nem extração hoje (limitação F) |
| **Produção Script → Scene → Shot** | o domínio já tem Scene; falta a ponte da conversa até uma estrutura de roteiro |
| **Conhecimento / RAG** | limitação G |
| **Memória de projeto, personagens, continuidade** | limitação H — é o que faz um personagem parecer o mesmo entre cenas |
| **Approvals** | o vocabulário já existe em `lib/approval.js`; falta o fluxo |
| **Multi-provider / nuvem** | hoje só ComfyUI local |
| **WhatsApp e outros canais** | a arquitetura permite (toda decisão mora no servidor), nada foi construído — limitação I |
| **Research Lab** | — |

Duas coisas que não são frentes, mas continuam pendentes e são baratas:

- o **`README.md` da raiz** segue desatualizado (limitação L);
- **autenticação** passa a ser obrigatória se o Gateway sair de `127.0.0.1`
  (limitação K).

---

## 17 · NON-NEGOTIABLE ARCHITECTURE RULES

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
    janela curta. O que dura é o Asset e o vínculo com a mensagem, no banco.
    Nenhuma tabela nasceu para ele, e não deve nascer sem um passo que decida
    durabilidade de verdade.

---

## 18 · Mapa de arquivos

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
| `lib/server/agent/tools/jobWatch.js` | **o acompanhamento**: single-flight, laço, teto, ciclo de vida, associação |

### Geração

| Caminho | Papel |
| --- | --- |
| `lib/server/generation/facade.js` | API de alto nível; onde o Asset nasce |
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
| `lib/server/domain/projects.js` | Project (`registerProject`, `ensureProject`) |
| `lib/server/domain/scenes.js` | Scene |
| `lib/server/domain/assets.js` | Asset e linhagem |
| `lib/server/domain/backfill.js` | registro de mídia já em disco (idempotente) |
| `lib/server/domain/index.js` | barril — **note o que ele deliberadamente não exporta** |

### ComfyUI

| Caminho | Papel |
| --- | --- |
| `lib/server/comfy/config.js` | `COMFY_BASE_URL`, `RUNTIME_ROOT` |
| `lib/server/comfy/jobs.js` | os jobs, em memória |
| `lib/server/comfy/client.js` | HTTP com o ComfyUI |
| `lib/server/comfy/storage.js` | `validateSegment` e caminhos |
| `lib/server/appRoot.js` | `APP_ROOT` descoberto |

### Workflows versionados

| Caminho | Papel |
| --- | --- |
| `workflows/ideogram4_t2i_api.json` | Ideogram 4, 29 nós |

### Testes

| Caminho | Papel |
| --- | --- |
| `tests/*.test.mjs` | 54 arquivos, 853 testes, na suíte |
| `tests/agent-job-autonomy.test.mjs` | o Passo 9 inteiro — 40 testes |
| `tests/agent-event-surface.test.mjs` | a fronteira pública dos eventos — 12 testes |
| `tests/helpers/runtimeFalso.mjs` | o runtime falso do adaptador |
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

## 19 · Convenções que valem a pena preservar

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
