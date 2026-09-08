# Showrunner — estado da implementação e handoff

Documento **autossuficiente**. Um agente de código que abra este repositório
pela primeira vez deve conseguir ler só este arquivo e saber onde o projeto
está, o que é verdade, o que não é, e qual é o próximo passo.

Ele não depende de `/tmp`, de scratchpad, de histórico de conversa nem da
memória de nenhuma sessão.

**Atualizado em:** 8 de setembro de 2026
**HEAD documentado:** `c19277920ba09691ae37f85071605ac4f2878d23`

> **Regra de precedência.** Se este documento divergir do código ou do Git, **o
> código e o Git são a fonte de verdade**. Verifique antes de confiar. Foi
> exatamente assim que esta revisão foi escrita: a versão anterior dizia "434
> testes", "branch `feat/showrunner-agent-foundation`", "Echo é o padrão" e
> "Asset ainda não é criado em `finalizeJob`" — as quatro estavam obsoletas.

---

## START HERE FOR THE NEXT CODING AGENT

1. Leia este documento inteiro. Ele tem tudo o que você precisa para começar.
2. `git status --short` — esperado: **vazio** (árvore limpa).
3. `git log --oneline -5` — esperado: `c192779` no topo.
4. `npm test` — esperado: **801 testes, 801 passando, 0 falhando** (~3 min).
5. `npm run build` — esperado: compila limpo, 18 páginas estáticas.
6. **Não refaça os Passos 1–8.** Eles estão prontos, testados e commitados.
7. Continue pelo **PASSO 9 — Job Autonomy** (seção "Próximo passo exato").
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
| HEAD | `c19277920ba09691ae37f85071605ac4f2878d23` |
| Working tree | limpa |
| Testes | 801 / 801 passando, 0 falhas |
| Build | limpo (`✓ Compiled successfully`, 18/18 páginas) |
| Node | v24.x (usa `node:sqlite`, experimental) |
| Next | 15.5.15 · React 19.2.8 |

> **Atenção:** `origin/main` está em `1c6ded0`. Os três commits mais recentes
> (`3036b76`, `d22b7d7`, `c192779`) **existem só localmente** e ainda não foram
> enviados. Se você for trabalhar noutra máquina, empurre antes.

### Checkpoints importantes

| Commit | O que entrou |
| --- | --- |
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
  → AgentEvents do Showrunner
  → redução pura em lib/agentClient.js
  → tela
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
encenar um trabalho que terminou.

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

**801 testes, 801 passando, 0 falhando.** 52 arquivos `tests/*.test.mjs`, com
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

O runtime falso vive em `tests/helpers/runtimeFalso.mjs`.

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

### A. Job Autonomy **não** está implementado — é o próximo problema principal

Hoje o ciclo é:

```
og.generate_image  →  cria job  →  devolve jobId
                                     ↓
o agente PODE chamar og.get_job     ↓
                                     ↓
se ainda estiver gerando, o agente pode responder e ENCERRAR o turno
```

O usuário pode precisar perguntar **"e aí?"** para o trabalho progredir. Pior:
`og.get_job` não é só uma consulta — **consultar é o que faz a geração
progredir**, porque a máquina do ComfyUI é pull. Está escrito no cabeçalho de
`tools/handlers/getJob.js`. Sem alguém chamando em laço, o job não anda.

### B. Jobs vivem em memória do processo

`lib/server/comfy/jobs.js` guarda um `Map` em `globalThis` (para sobreviver ao
Fast Refresh do Next). **Reiniciar o servidor perde os handles dos jobs.**
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
  isso vira corrupção silenciosa.
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

---

## 16 · Próximo passo exato

# PASSO 9 — JOB AUTONOMY

**Não implementado. É por aqui que a próxima sessão continua.**

### O problema

O usuário diz "Crie uma imagem."

**Hoje:**

```
→ o agente chama og.generate_image
→ recebe um jobId
→ pode chamar og.get_job uma vez
→ se ainda estiver renderizando, responde algo como
  "A imagem está em renderização" e ENCERRA o turno
→ o trabalho para de progredir até alguém consultar de novo
→ o usuário precisa escrever "e aí?"
```

**Desejado:**

```
→ o agente chama og.generate_image
→ acompanha automaticamente
→ aguarda sem bloquear indevidamente (o turno não pode travar a tela,
  nem segurar o socket para sempre)
→ consulta o progresso
→ detecta DONE
→ recupera o Asset
→ responde com o resultado
```

Sem o usuário precisar perguntar nada.

### Pontos de partida no código

| Arquivo | Por quê |
| --- | --- |
| `lib/server/agent/tools/handlers/getJob.js` | consultar é o que faz o job progredir — está documentado lá |
| `lib/server/comfy/jobs.js` | onde os jobs vivem hoje (memória; ver limitação B) |
| `lib/server/generation/facade.js` | `finalizeGenerationAsset`, o ponto em que o Asset nasce |
| `lib/server/agent/gateway.js` | o turno; onde uma espera teria que caber sem travar o streaming |
| `lib/server/agent/adapters/HermesRuntimeAdapter.js` | o laço do turno e o cancelamento |

### Considerar antes de escolher o desenho

- A limitação **B** (jobs em memória) e a **J** (sem fila durável) tocam
  diretamente neste passo. Uma solução que assuma jobs duráveis precisa criar
  essa durabilidade primeiro.
- O turno tem um teto de silêncio (`SILENCIO_MAXIMO_MS`, 180 s, em
  `hermes/runtimeClient.js`). Uma espera ingênua dentro do turno esbarra nele.
- O cancelamento (`signal`) precisa continuar alcançando a ferramenta pelo
  registro de turnos do bridge.

**Nesta tarefa de handoff, nada disso foi implementado. Apenas documentado.**

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
| `lib/server/agent/events.js` | o vocabulário público de eventos |
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
| `tests/*.test.mjs` | 52 arquivos, 801 testes, na suíte |
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
