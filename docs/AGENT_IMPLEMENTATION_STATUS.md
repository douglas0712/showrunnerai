# Showrunner — estado da implementação e handoff

Documento **autossuficiente**. Um agente de código que abra este repositório
pela primeira vez deve conseguir ler só este arquivo e saber onde o projeto
está, o que é verdade, o que não é, e o que continua aberto.

Ele não depende de `/tmp`, de scratchpad, de histórico de conversa nem da
memória de nenhuma sessão.

**Atualizado em:** 9 de setembro de 2026
**HEAD funcional documentado:** `cd4a84faa727e9e1a1d097bfa24a72a0cf85ccc7`

> **Regra de precedência.** Se este documento divergir do código ou do Git, **o
> código e o Git são a fonte de verdade**. Verifique antes de confiar. Foi
> exatamente assim que esta revisão foi escrita: a versão anterior dizia "434
> testes", "branch `feat/showrunner-agent-foundation`", "Echo é o padrão" e
> "Asset ainda não é criado em `finalizeJob`" — as quatro estavam obsoletas.

---

## START HERE FOR THE NEXT CODING AGENT

1. Leia este documento inteiro. Ele tem tudo o que você precisa para começar.
2. `git status --short` — esperado: **vazio** (árvore limpa).
3. `git log --oneline -5` — esperado: `cd4a84f` no topo.
4. `npm test` — esperado: **1308 testes, 1308 passando, 0 falhando** (~3 min).
5. `npm run build` — esperado: compila limpo, 18 páginas estáticas.
6. **Não refaça os Passos 1–13.** Eles estão prontos, testados e commitados. O
   **núcleo** do Passo 10 (10.0 a 10.5) está fechado; **10.6 é backlog** e não
   bloqueia nada — ver seção 17. O **Passo 11** (ingestão de documentos) está
   fechado — ver seção 18. O **Passo 12** (planejamento de produção) está
   fechado — ver seção 22. O **Passo 13** (execução da produção: a cena vira
   imagem e vídeo) está fechado — ver seção 23.
7. **Dois Quality Gates foram executados no produto real e passaram inteiros:**
   o audiovisual do núcleo (seção 20) e o do Passo 13 (seção 23), este último
   com 86 verificações e prova de I2V por SHA-256 do quadro enviado ao executor.
8. **O próximo passo é o PASSO 14 — PRODUCTION AUDIO** (seção 24). Ele ainda
   não foi começado, e a arquitetura dele ainda não foi decidida.
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
| HEAD funcional | `cd4a84faa727e9e1a1d097bfa24a72a0cf85ccc7` |
| Working tree | limpa |
| Testes | 1308 / 1308 passando, 0 falhas |
| Build | limpo (`✓ Compiled successfully`, 18/18 páginas) |
| Node | v24.x (usa `node:sqlite`, experimental) |
| Next | 15.5.15 · React 19.2.8 |

> `origin/main` está **sincronizado** com `main`. Nada existe só localmente.
> (`git rev-list --left-right --count origin/main...main` → `0  0`.)

### Checkpoints importantes

| Commit | O que entrou |
| --- | --- |
| `5101866` | **PASSO 12** — planejamento de produção durável: plano, roteiro e cenas viraram estado do Project (migração 9) |
| `6ed922f` | handoff da linhagem imagem → vídeo verificada |
| `cb7c5e0` | **I2V com linhagem** — "anime essa imagem" passou a virar image-to-video de verdade, com `derivedFromAssetId` real |
| `2c8a227` | handoff do Passo 11, da continuidade de thread e do Quality Gate |
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
og.generate_image             o que a produção FAZ
og.generate_video
og.get_job

project.list_documents        o que o projeto TEM
project.read_document

project.get_production_plan   o que a produção VAI SER
project.save_production_plan
project.get_script
project.save_script
project.list_scenes
project.get_scene
project.replace_scenes
project.update_scene

project.generate_scene_image  o que a produção JÁ TEM
project.generate_scene_video
project.get_scene_media
project.select_scene_take
```

**Dezessete ferramentas.** Eram cinco antes do Passo 12; as oito de planejamento
entraram nele (seção 22) e as **quatro** de execução entraram no Passo 13
(seção 23). Nenhuma foi removida.

As quatro do Passo 13 nunca recebem identificador nosso. `project.*` de execução
é endereçada por **posição**: número da cena, tipo, número da tentativa. Não há
`sceneId`, `mediaId`, `assetId`, `jobId`, `sourceAssetId`, `takeNumber` de
escolha livre, `workflowId`, `aspectRatio` nem `duration` em schema nenhum —
cada um desses seria um campo que o modelo aprende a preencher.

Definidos em `lib/server/agent/tools/handlers/`.

O prefixo diz de quem é a coisa. Uma ferramenta `project.*` opera sobre o
Project inteiro, atravessa conversas, e a autoridade dela é sempre o
`projectId` do ToolContext. As duas de documento entraram no Passo 11 —
seção 18.

As oito de planejamento seguem a mesma regra, e acrescentam uma: **uma cena é
endereçada pela POSIÇÃO (`ordinal`), nunca por um identificador**. O `id` de uma
cena não sai do servidor. Ver seção 22.

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
og_generate_image             →  og.generate_image
og_generate_video             →  og.generate_video
og_get_job                    →  og.get_job
project_list_documents        →  project.list_documents
project_read_document         →  project.read_document
project_get_production_plan   →  project.get_production_plan
project_save_production_plan  →  project.save_production_plan
project_get_script            →  project.get_script
project_save_script           →  project.save_script
project_list_scenes           →  project.list_scenes
project_get_scene             →  project.get_scene
project_replace_scenes        →  project.replace_scenes
project_update_scene          →  project.update_scene
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
2. o plugin registra **treze** nomes e mais nenhum (`plugin.yaml`), e há teste
   que falha se o manifesto e a tabela de aliases discordarem;
3. `toCanonicalToolName` recusa o que não está na tabela de aliases;
4. o bridge escuta num socket Unix `0600` — sem porta, sem token, autorização
   pelo sistema de arquivos;
5. o registry recusa tool desconhecida.

---

## 7 · Domínio e banco

SQLite via `node:sqlite` (zero dependências novas), em `runtime/showrunner.db`.
Migrações versionadas por `PRAGMA user_version`, em `lib/server/domain/db.js`.

**`ESQUEMA_ATUAL = 10`** (dez migrações aplicadas).

| # | Migração | Entidade |
| --- | --- | --- |
| 1 | `projects`, `scenes`, `assets` | domínio base |
| 2–3 | `agent_threads`, `agent_messages` | conversa |
| 4 | `runtime_sessions` | vínculo sessão ↔ thread |
| 5 | `agent_message_assets` | mídia de uma mensagem, por referência |
| 6 | `runtime_sessions.bridgeSessionId` | o segundo nome da mesma sessão |
| 7 | `generation_jobs` | **o livro-razão durável de gerações** (Passo 10.2) |
| 8 | `project_documents`, `document_chunks`, `agent_message_documents` | **o material de referência do Project** (Passo 11) |
| 9 | `production_plans`, `production_plan_sources`, `production_scripts`, `production_scenes` | **o planejamento da produção** (Passo 12) |
| 10 | `production_scene_media`, `production_scene_media_selections` | **a mídia de uma cena: takes e escolha** (Passo 13-A) |

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

### `production_plans` · `production_plan_sources` · `production_scripts` · `production_scenes` (Passo 12)

O plano audiovisual de um Project: o que a produção vai ser, o roteiro dela, e
as cenas em que ele se divide. Migração **9**, aditiva.

```
Project
  └─ production_plans          o que a produção VAI SER       (1 por Project)
       └─ production_plan_sources   de qual material ela saiu (referências)
  └─ production_scripts        o roteiro                       (1 por Project)
       └─ production_scenes    as cenas, em ordem
```

| Tabela | Campos que importam |
| --- | --- |
| `production_plans` | `id` PK · `projectId` **UNIQUE** (CASCADE) · `title` · `logline` · `synopsis` · `format` · `targetDurationSeconds` (CHECK > 0) · `aspectRatio` · `genre` · `tone` · `audience` · `language` · `status` (CHECK) · `createdAt` · `updatedAt` |
| `production_plan_sources` | `PRIMARY KEY (planId, documentId)` — a deduplicação sai de graça · `seq` |
| `production_scripts` | `id` PK · `projectId` **UNIQUE** (CASCADE) · `title` · `summary` · `fullText` (CHECK length > 0) · `status` (CHECK) · timestamps |
| `production_scenes` | `id` PK · `scriptId` (CASCADE) · `ordinal` (CHECK ≥ 1) · `title` · `purpose` · `durationSeconds` (CHECK > 0) · `narration` · `visualDescription` · `status` (CHECK) · timestamps · **`UNIQUE (scriptId, ordinal)`** |

**`UNIQUE(projectId)` é a regra inteira:** um Project tem no máximo um plano e um
roteiro, e gravar de novo **substitui preservando o `id`**. É o que torna "salve
o plano" idempotente sem que ninguém precise conferir se já havia um. Não há
versionamento, e isso é decisão: um histórico de roteiros só vale a pena quando
existe uma forma de escolher entre eles.

**A cena NÃO guarda `projectId`.** Ela pertence a um roteiro, e o roteiro
pertence a um projeto — a coluna extra seria uma segunda resposta para a mesma
pergunta, e duas respostas podem discordar. É o mesmo desenho de
`document_chunks`, que também não repete o dono do documento.

**O status usa o vocabulário que já existia.** `PRODUCTION_STATUS` é
`{ DRAFT: 'rascunho', APPROVED: 'aprovado' }`, derivado de `SCENE_STATUS` em
`lib/storyboard.js` — **zero palavras novas**. Inventar `draft`/`approved` criaria
um segundo idioma para a mesma coisa, e a tela teria de traduzir entre os dois.
São só duas porque o planejamento só tem duas respostas hoje; `pendente`,
`revisão` e `vídeo gerado` pertencem ao ciclo de vida de uma MÍDIA, e não há
mídia aqui.

**O que deliberadamente NÃO está aqui:** o texto do documento (o plano guarda a
REFERÊNCIA — ver seção 22), prompt de modelo (descrição visual não é prompt de
ComfyUI, e escrever um agora congelaria o gerador de hoje dentro do plano),
Asset, job, workflow, e versão.

### `production_scene_media` · `production_scene_media_selections` (Passo 13-A)

A ponte entre a cena DESCRITA (migração 9) e a mídia REAL (migração 1). Migração
**10**, aditiva.

```
production_scenes
  └─ production_scene_media               os takes: tentativas numeradas
       ├─ image take 1 → Asset A
       ├─ image take 2 → Asset B          ← production_scene_media_selections
       └─ video take 1 → Asset C          ← production_scene_media_selections
```

| Tabela | Campos que importam |
| --- | --- |
| `production_scene_media` | `id` PK · `sceneId` (CASCADE) · `kind` (CHECK, de `ASSET_KINDS`) · `takeNumber` (CHECK ≥ 1) · `generationJobId` nullable (SET NULL) · `assetId` nullable (SET NULL) · timestamps · **`UNIQUE (sceneId, kind, takeNumber)`** |
| `production_scene_media_selections` | `sceneId` (CASCADE) · `kind` (CHECK) · `mediaId` · `updatedAt` · **`PRIMARY KEY (sceneId, kind)`** · **`FOREIGN KEY (mediaId, sceneId, kind)` → `production_scene_media (id, sceneId, kind)`** CASCADE |

**Um take é uma LINHA, não uma coluna na cena.** É a decisão inteira: uma coluna
`imageAssetId` em `production_scenes` transformaria "gere de novo" numa
sobrescrita, e a imagem que o usuário talvez preferisse deixaria de existir no
instante em que ele pedisse uma alternativa. É a mesma razão pela qual a `scenes`
da migração 1 — que tem `image` e `videoId` como colunas — não serve aqui.

**A numeração é por cena E por tipo, e é do servidor.** A primeira imagem e o
primeiro vídeo de uma cena são ambos o take 1. O próximo número é
`MAX(takeNumber) + 1` lido e gravado dentro da mesma transação; a corrida que
sobra esbarra no `UNIQUE` e vira erro, em vez de virar dois takes 3. Quem chama
nunca escolhe o número.

**A chave estrangeira da seleção é COMPOSTA, e isso é o ponto.** As duas regras
que importam não são "o take existe": são "o take é DESTA cena" e "o take é
DESTE tipo". Uma FK simples em `mediaId` garantiria só metade da primeira, e a
cena 4 poderia acabar com a imagem da cena 7, ou com um vídeo escolhido como
imagem. Repetindo `sceneId` e `kind` dentro da própria chave, as duas viram
estrutura: a linha errada é **impossível de gravar**, inclusive por SQL escrito à
mão. O índice `production_scene_media_endereco (id, sceneId, kind)` existe só
para ser a chave-pai dessa FK.

**`PRIMARY KEY (sceneId, kind)`** diz "no máximo uma imagem escolhida e um vídeo
escolhido por cena", e diz por estrutura. Uma coluna `selected` na tabela de
mídia permitiria dizer isso duas vezes.

**O que estas tabelas NÃO guardam**, e por quê:

- **estado de geração** — é do `generation_jobs`. A situação de um take é
  DERIVADA (`sceneTakeState`): com Asset é `done`, sem Asset vale o que o
  trabalho dele vale agora. Uma coluna aqui divergiria no primeiro reinício;
- **linhagem** — `derivedFromAssetId` continua no Asset e no livro-razão. Não há
  segunda fonte;
- **nada que já seja do Asset** — caminho, arquivo, URL, MIME, prompt, seed,
  modelo, dimensões;
- **nada que já seja do descriptor** — workflow, provider, nó, formato.

**A cena não guarda `projectId`, e a mídia também não.** Ela pertence a uma cena,
a cena a um roteiro, o roteiro a um projeto. Que o Asset e o job sejam do MESMO
projeto da cena é regra de domínio, conferida no repositório — a chave
estrangeira garante que eles existem, não de quem são.

**`SET NULL` nas duas referências, e não `CASCADE`:** apagar um Asset é faxina de
mídia, e faxina de mídia não pode demolir o planejamento. O take permanece,
vazio, dizendo a verdade — esta tentativa existiu e o arquivo dela não está mais
aqui. (Na prática o Asset de um trabalho **concluído** nem pode ser apagado
sozinho: `generation_jobs.assetId` é `NO ACTION`. O buraco existe só para mídia
sem job concluído, como a que o backfill registra do disco.)

### `replaceProductionScenes` é recusado quando a cena já tem mídia (Passo 13-A.1/A.2)

`replaceProductionScenes` apaga as cenas e as reinsere com `id` novo. Era
inofensivo enquanto uma cena era só texto; desde a migração 10 não é — a mídia
pende do `id` da cena, e o CASCADE levaria takes e seleções junto, em silêncio.

A regra: **se qualquer cena do roteiro tem mídia, a substituição em bloco é
recusada**, com mensagem acionável e sem vazar identificador. Não há `force`, e
não há preservação automática por ordinal — depois de uma reescrita, a cena 4
pode ser outra cena, e reatar a imagem antiga ao número 4 colaria a mídia errada
no lugar certo, que é um defeito que passa despercebido por parecer correto.

A guarda roda **dentro** do `BEGIN IMMEDIATE`, e essa ordem é a correção do
13-A.2: fora da transação havia uma janela real — a guarda encontrava zero
takes, outra conexão gravava um, e o DELETE seguinte o levava junto. `BEGIN
IMMEDIATE` toma o lock de escrita na hora, então entre "não há mídia" e "as cenas
foram apagadas" não cabe mais nada. Há teste com **duas conexões SQLite reais**
provando que uma escrita concorrente nessa janela recebe `database is locked`.

A ordem dentro da transação também importa: a mídia é conferida **antes** da
duração, então a mensagem de proteção vence a de duração inválida — recusar por
duração ensinaria que basta acertar os segundos para a mídia sumir.

### A tabela `scenes` da migração 1 NÃO foi evoluída

Ela continua exatamente como era, e isso é uma decisão registrada, não um
esquecimento.

`scenes` é o espelho, no servidor, do storyboard que a tela monta em
`lib/storyboard.js` e guarda no `localStorage`: `number`, `modelId`,
`revisionNote`, `image`, `videoId`. Ela responde *"qual mídia cada quadro do
storyboard já tem"*. Ela também **não tem escritor em produção**: a varredura do
repositório encontra `createSceneRecord` apenas nos testes.

`production_scenes` responde a outra pergunta: *"o que esta parte do filme quer
dizer, o que se ouve e o que se vê"*. Encaixar isso em `scenes` exigiria quatro
colunas novas, um índice único que aquela tabela **nunca teve** (ela tolera
número repetido de propósito — `renumberScenes` conta com isso) e a troca do
vocabulário de status. Seria mudar o significado de uma tabela publicada para
caber num conceito novo.

Então as duas convivem, com nomes que dizem a que vieram. **Nenhuma migração
destrutiva, nenhum dado antigo tocado.** Há teste que confere as 13 colunas
originais de `scenes` e falha se alguém as alterar
(`domain-production.test.mjs`, `N-bis`).

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

> **O registry tem UM workflow de vídeo, e o id dele é `minimax_h3_t2v`.**
>
> O nome é HISTÓRICO e engana: o descriptor é **multimodal** e declara
> `modes: ['t2v', 'i2v', 'flf']`. Image-to-video **não é outro workflow** — é o
> MESMO grafo recebendo um quadro inicial:
>
> ```
> sourceAssetId → bytes reais do Asset → frames.first
>               → nó LoadImage → first_frame → MiniMaxH3ImageToVideo
> ```
>
> Não existe, e não deve ser inventado, um `minimax_h3_i2v`. Acrescentar um
> descriptor para o que o atual já faz criaria dois grafos disputando o mesmo
> trabalho. Provado com execução real — ver seção 20.

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

**1308 testes, 1308 passando, 0 falhando.** 75 arquivos `tests/*.test.mjs`, com
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
| `domain-production.test.mjs` | o planejamento no domínio e a migração 8→9 (Passo 12) — 42 testes |
| `agent-production-tools.test.mjs` | as oito ferramentas de planejamento e a fronteira delas — 33 testes |
| `agent-production-planning.test.mjs` | o caminho inteiro, multi-turno, sem runtime real — 5 testes |

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
| **Quality Gate audiovisual, à mão, no navegador** | seção 20: identidade → T2I real → "anime essa imagem" → **I2V real** → vídeo → reload preserva mídia → nova conversa preserva a anterior |
| **"anime essa imagem" produz LINHAGEM real** | seção 20, verificado no banco e no `/history` do executor: `B.derivedFromAssetId = A`, e o grafo submetido traz `LoadImage` ligado ao `first_frame`. A execução anterior submetia zero `LoadImage` e gravava linhagem nula |
| **PDF real vira PLANO, ROTEIRO e CENAS persistidos** | Passo 12, seção 22: o mesmo `Prometeu_O_Fogo_da_Humanidade.pdf` (6 páginas, 5.568 caracteres) → plano de 120 s, roteiro de 1.577 caracteres, **7 cenas** somando 120 s. `generation_jobs` e `assets` **inalterados** |
| **"deixe a cena 2 mais dramática" muda a cena 2, e só ela** | Passo 12, seção 22: no banco, apenas a cena 2 tem `updatedAt ≠ createdAt`; as outras seis continuam com os dois carimbos idênticos aos da criação |
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

### F-quater. ~~O plano de produção só existia no chat~~ — RESOLVIDO no Passo 12

O agente propunha um documentário e a proposta morria com o turno. O pedido
seguinte — "mude a cena 4" — obrigava o modelo a reconstruir o filme de memória,
e ele reconstruía OUTRO filme.

Resolvido em `5101866`. Plano, roteiro e cenas são estado do Project. Ver
seção 22.

### G. RAG não existe

Sem base de conhecimento, sem embeddings, sem vector DB, sem recuperação por
semelhança. **Os chunks do Passo 11 não são isso**: eles são paginação
determinística, para o agente conseguir percorrer um documento inteiro. Ver
seção 18.

### G-bis. O planejamento de produção tem limites conhecidos

Todos são decisão, não pendência esquecida. Nenhum deles bloqueia o produto.

- **Sem versionamento** de plano, roteiro ou cenas: gravar de novo substitui.
  Sem takes, sem histórico de revisões. Um histórico só vale a pena quando
  existe uma forma de escolher entre as versões, e não existe.
- **Sem `reorder_scene` e sem `delete_scene`.** Mover a cena 5 para a 2, ou
  apagar uma cena, exige `project.replace_scenes`. Renumerar é reordenar o
  filme, e apagar reabre o buraco no `1..n` — nenhuma das duas é edição
  pontual, e tratá-las como tal quebraria a invariante que torna "a cena 4" um
  endereço.
- **Approval não está integrado.** Só existe a BASE: a coluna `status`, com
  `rascunho` e `aprovado`. **Nada escreve `aprovado`** nesta etapa, e `status`
  não é campo que o modelo possa escrever. Ver a seção 22.
- **Sem UI de planejamento.** Plano, roteiro e cenas só existem pela conversa.
- **Sem ligação Scene → Asset.** Nada conecta uma cena à mídia dela; é o
  Passo 13.
- **Chamadas sucessivas de `update_scene` podem afastar a soma do alvo.** A
  tolerância de ±5 s vale na CRIAÇÃO do conjunto; numa edição pontual ela não é
  imposta, de propósito — ver seção 22. O único freio é o agente avisar, e ele é
  informado da nova soma para poder fazê-lo.
- **A `scenes` legada continua no esquema** e no barril do domínio, sem
  escritores. Não foi removida: seria destrutivo, e ela ainda é coberta por
  testes.

### H. Memória de projeto, personagens e continuidade não existem

Nada mantém a aparência de um personagem entre cenas, nem lembra decisões de
direção entre conversas. **O Passo 12 não resolve isto**: ele guarda o que cada
cena É, não o que faz um personagem parecer o mesmo entre duas delas.

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

### O. A duração de um clipe é o padrão técnico do pipeline

`ProductionScene.durationSeconds` é duração **narrativa** — quanto daquele trecho
do filme a cena ocupa. A duração de um clipe é outra grandeza: quanto o gerador
produz de uma vez. As duas são números em segundos e **não** são a mesma coisa,
e o Passo 13-E decidiu não convertê-las: nada é dividido, arredondado, esticado
ou encolhido. O clipe usa o padrão do pipeline (6 s hoje).

Com o pipeline atual, de clipes curtos, uma cena narrativa mais longa **pode**
vir a ser realizada com mais de um clipe. **Quantos, e de que duração, não está
decidido** — é decisão da entidade **Shot**, que ainda não existe. Não há regra
registrada sobre isso, e inventar uma aqui seria escolher sem medir.

### P. `aspectRatio` do plano é texto livre, e o suporte é conferido ao gerar

`production_plans.aspectRatio` é campo de PRODUÇÃO, não de gerador — o domínio
não conhece capacidade de workflow. Um valor fora das oito proporções que os
descriptors declaram só é descoberto na primeira geração, e aí a recusa é
explícita e não destrói nada (`exigirAspectoSuportado` roda antes do livro-razão
e antes do take). O erro aparece tarde, mas aparece.

### Q. Mudar o `aspectRatio` do plano não regenera a mídia já feita

O formato é resolvido a cada geração. Alterar o plano depois deixa a produção com
cenas em dois formatos até serem regeradas, e **nada avisa**.

### R. A desambiguação de "a outra" é persona, não estrutura

"Use a segunda" funciona e está provado. "Use a outra", com três tentativas, é
meio pedido — a persona manda listar e perguntar, e no gate ela se comportou
assim, mas **nada no servidor impede** o modelo de escolher em silêncio. Não há
parser de linguagem natural no servidor, e não deve haver.

### S. `selectSceneTake` do domínio é primitiva permissiva

Ela move o ponteiro e não exige que o take esteja pronto. A política "só take
concluído, com Asset" é aplicada pela **tool pública**
(`project.select_scene_take`). A primitiva continua permissiva de propósito: o
produto precisa saber representar situações honestas — uma seleção cujo Asset
sumiu, por exemplo. Hoje a tool é o único escritor de escolha deliberada.

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
| **—** — Referência natural a Asset → I2V com linhagem | ✅ | `cb7c5e0` |
| **12** — Production Planning (plano, roteiro e cenas persistentes) | ✅ | `5101866` |
| **13-A** — Scene Media Domain (takes e seleção, migração 10) | ✅ | `3b04848` |
| **13-B** — Image Takes (`project.generate_scene_image`) | ✅ | `3c18d9f` |
| **13-C** — Video Takes / I2V (`project.generate_scene_video`) | ✅ | `90aa84a` |
| **13-D** — Selection & Agent UX (ler a mídia da cena e escolher) | ✅ | `0efe52a` |
| **13-E** — Production Generation Parameters (formato do plano) | ✅ | `cc0d7bb` |
| **13-F** — Quality Gate Final do Passo 13 (86 verificações) | ✅ | `cd4a84f` |

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

### A linhagem, verificada no banco

Este gate rodou em duas etapas, e a segunda existe porque a primeira quase
passou por engano.

**Na primeira execução**, o comportamento pareceu certo: o agente entendeu
*"anime essa imagem"* e o vídeo correspondeu ao pedido. A consulta ao banco
mostrou outra coisa:

```
video  asset_mtu76i49_63170f64   derivedFromAssetId: NULO
ledger                            LoadImage no grafo: 0
```

Não houve image-to-video. Houve um **text-to-video** cujo prompt descrevia a
imagem — e por isso não havia linhagem para gravar. O vídeo "parecer correto"
não bastava, e é essa a lição que esta seção existe para carregar.

Corrigido em `cb7c5e0` (ver seção 21). **Na execução seguinte, com o mesmo
pedido em linguagem natural:**

```
A (imagem) = asset_mtudf9uq_2e61dd53
B (vídeo)  = asset_mtudjqvc_f70c809e

B.kind                                    = video
B.derivedFromAssetId                      = asset_mtudf9uq_2e61dd53   ← A

generation_jobs do vídeo:
  workflowId                              = minimax_h3_t2v
  state                                   = done
  derivedFromAssetId                      = asset_mtudf9uq_2e61dd53   ← A
```

E, no `/history` do ComfyUI, o grafo que foi realmente submetido:

```
nós LoadImage: 1
  sr:first_frame → showrunner/cinema_mtudg6k9_7secrp_first.png
  105:104 MiniMaxH3ImageToVideo | first_frame: ["sr:first_frame", 0]
```

O contraste é a prova:

| | primeira execução | depois da correção |
| --- | --- | --- |
| `LoadImage` no grafo submetido | **0** | **1** |
| `derivedFromAssetId` do Asset | **nulo** | `asset_mtudf9uq_2e61dd53` |
| `derivedFromAssetId` no livro-razão | **nulo** | `asset_mtudf9uq_2e61dd53` |

Todas as consultas foram **somente leitura**. Nenhum dado foi alterado.

### A continuidade da sessão, no mesmo smoke

Entre o turno da imagem e o turno do vídeo houve uma pausa de **25 segundos** —
deliberada, porque a carência do `ws_orphan_reap` é 20 s (seção 19). O runtime
reciclou a sessão, e o turno seguinte a restabeleceu:

```
17:27:47  A conversa do runtime foi restabelecida.  {"threadId": "thread_mtudecac_87149ee1"}
```

Ou seja, o fluxo comprovado atravessa as duas correções ao mesmo tempo:

```
T2I real → espera → sessão reciclada → session.resume
         → "anime essa imagem" → sourceAssetId real → I2V real
         → derivedFromAssetId → vídeo → reload
```

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

## 21 · REFERÊNCIA NATURAL A ASSET — I2V COM LINHAGEM ✅

**Concluído em `cb7c5e0`.** Um defeito que o Quality Gate quase deixou passar,
porque o comportamento parecia certo.

### O sintoma

> *"Anime essa imagem."*

O agente entendia. O vídeo saía correspondendo ao pedido. E o banco dizia outra
coisa: `derivedFromAssetId` nulo, e nenhum `LoadImage` no grafo submetido.

Era um **text-to-video cujo prompt descrevia a imagem** — não uma animação
dela. Nenhuma linhagem, porque não havia linhagem para gravar.

### A causa, que não era do modelo

Desde o **Passo 9**, uma geração termina depois do turno que a pediu:

```
turno 1 → og.generate_image → devolve { jobId, kind, status }
                                       ↑ sem assetId: o Asset AINDA NÃO EXISTE
        → o turno do modelo acaba
        → o JobWatcher conclui, server-side, e o Asset nasce

turno 2 → "anime essa imagem"
        → o modelo entende perfeitamente…
        → …e não tem NENHUM identificador para passar em sourceAssetId
        → chama og.generate_video sem ele → T2V
```

Três coisas que **não** eram o problema, e que foram verificadas antes de
mexer em qualquer linha:

- **não** era falha de compreensão semântica — o agente entendeu todas as vezes;
- **não** era falta de workflow — `minimax_h3_t2v` já é multimodal;
- **não** era bug do pipeline i2v — ele está íntegro desde o Passo 6.1, coberto
  por teste, e havia um Asset de setembro com a linhagem correta.

Era **ausência de referência durável da imagem no turno seguinte**. O agente
fazia a única coisa que podia.

### A correção

O **servidor** passa a dizer ao modelo o que ele pode referenciar. É o mesmo
mecanismo do anexo de documento do Passo 11, e pela mesma razão: uma referência
que aponta para fora da frase só se resolve se o servidor disser qual é o
referente.

| Peça | Papel |
| --- | --- |
| `listThreadAssets()` (`agent/threads.js`) | a mídia que ESTA conversa produziu, com o `prompt` de cada uma |
| `context.images` (`gateway.js`) | entra no contexto do turno, montado no servidor |
| `imageReferenceBriefing()` (`agent/attachments.js`) | o aviso privado ao modelo |

Decisões que valem preservar:

- **escopo é a THREAD, não o Project.** "Essa imagem" é dêitico: aponta para o
  que está à vista, e o que está à vista é esta conversa. Uma conversa nova não
  herda o referente — pela mesma razão que não herda o anexo de um turno.
- **a ordem é a da CONVERSA** (`seq` da mensagem), não a do relógio: duas
  gerações do mesmo turno cabem no mesmo milissegundo, e aí `createdAt` não
  ordena nada.
- **teto de 6.** Isto entra no contexto de um modelo; uma conversa longa tem
  dezenas de Assets e oferecer todos gastaria o turno listando o que ninguém vai
  referenciar.
- **o `prompt` acompanha cada Asset.** É o que torna duas imagens
  DISTINGUÍVEIS — sem ele, uma lista de identificadores nus não ajuda ninguém a
  decidir qual é "a do astronauta". É texto que o próprio modelo escreveu.
- **é uma LISTA, não "a última".** Escolher pelo modelo seria heurística, e
  heurística erra em silêncio exatamente quando há duas imagens — que é quando
  o usuário mais precisa ser entendido. Com mais de uma, o aviso manda
  **PERGUNTAR**. Nada de `MAX(createdAt)`, nada de outra thread, nada aleatório;
  há teste que falha se alguma dessas frases aparecer no aviso.
- **o modelo nunca inventa um id.** Ele escolhe dentro do que o servidor
  ofereceu.

Os schemas (a tool canônica e o do plugin) passaram a dizer o que "opcional"
escondia: pedidos de animação **exigem** `sourceAssetId`.

### A regra T2V × I2V

```
sourceAssetId AUSENTE   →  text-to-video   →  derivedFromAssetId = NULL
sourceAssetId PRESENTE  →  image-to-video  →  derivedFromAssetId = sourceAssetId
```

> **A execução é decidida pelo ARGUMENTO ESTRUTURADO, nunca pela palavra
> "anime" no prompt.** A intenção linguística é resolvida pelo agente; o que o
> executor faz é determinado pelo dado. Há teste que submete
> `prompt: "anime um dragão vermelho voando"` **sem** `sourceAssetId` e exige
> zero quadro e linhagem nula.

E a linhagem nunca é preenchida artificialmente para um t2v.

### Testes

`tests/agent-image-to-video.test.mjs` — **14 testes**. Cobre: a lista oferecida
pelo servidor e o escopo dela; o contexto chegando ao runtime; o caminho inteiro
`sourceAssetId → bytes reais → frames.first → livro-razão`; o Asset final com
linhagem; T2V preservado; os dois caminhos alternados sem contaminação;
cross-project e `kind` errado recusados; a ambiguidade que vira pergunta; e a
superfície pública.

---

## 22 · PASSO 12 — PRODUCTION PLANNING ✅

**Concluído em `5101866`.** Implementado, testado, e validado com execução real
contra o Hermes v0.20.3, o PDF real do Prometeu e o produto de pé.

O Passo 11 entregou a primeira metade do exemplo-guia do produto: o material
entra e o agente o lê. O Passo 12 é a segunda metade — o que se FAZ com ele.

```
Material / ProjectDocument
  → proposta narrativa      (Production Plan)
  → roteiro estruturado     (Production Script)
  → cenas PERSISTENTES      (Production Scenes)
```

> **O Passo 12 NÃO gera mídia.** Nenhuma ferramenta dele alcança `generation/`,
> e o passo termina na cena DESCRITA. Ver "Prova de zero mídia", abaixo.

### Por que isto precisava existir

Porque o pedido seguinte é *"mude a cena 4"*.

Antes deste passo, o agente propunha um documentário e a proposta morria com o
turno. Para atender ao pedido seguinte, a única coisa que ele podia fazer era
reconstruir o filme inteiro pela memória da conversa — e ele reconstruía OUTRO
filme: parecido o bastante para ninguém notar na hora, diferente o bastante para
estragar a produção.

> **O estado do Project é a autoridade. A conversa é o volante.**

### O domínio

Migração **9**, aditiva. As quatro tabelas, os campos e os invariantes de banco
estão na seção 7, junto com a explicação de por que a `scenes` da migração 1
**não foi evoluída**.

A cadeia é obrigatória, e ela é a regra:

```
Project → ProductionPlan → ProductionScript → Scenes
```

Não há roteiro sem plano, e não há cena sem roteiro. Não é burocracia: é o que
impede um conjunto de cenas de existir sem nada contra o que conferir a duração,
e um roteiro de existir sem que ninguém tenha decidido que filme ele é. As duas
recusas dizem o que falta.

`lib/server/domain/production.js` é a única porta de escrita.

### Invariantes, e onde cada um mora

| Invariante | Garantido por |
| --- | --- |
| projeto obrigatório, e nenhum projeto nasce por causa de um plano | repositório (`getProject`) + FK |
| um plano e um roteiro por Project; regravar substitui e **preserva o `id`** | `UNIQUE(projectId)` |
| plano antes do roteiro, roteiro antes das cenas | repositório, com mensagem que diz o que falta |
| ordinais são **exatamente 1..n** — sem repetido, sem buraco | repositório **e** `UNIQUE(scriptId, ordinal)` |
| `durationSeconds > 0`, inteiro | repositório **e** `CHECK` |
| soma das cenas dentro de ±5 s do alvo, **na criação** | repositório |
| `replace_scenes` é transacional | `BEGIN IMMEDIATE` + `ROLLBACK` |
| ids são server-generated | `newId('plan' | 'script' | 'scene')` |
| cross-project bloqueado | **por construção** — ver abaixo |
| `DELETE` de Project leva plano, fontes, roteiro e cenas | `CASCADE` |

**Campos que NÃO entraram:** `location`, `characters`, `transition`. Não havia
necessidade demonstrada, e uma Scene gigante é uma Scene que ninguém edita.

### Cross-project é impronunciável, não recusado

Uma cena é endereçada por **`projectId` (do ToolContext) + `ordinal`**. Nunca por
`id`. O `id` de uma cena **não sai do servidor**, como o `jobId` de uma geração.

Isso é mais forte do que conferir um `sceneId`: não existe identificador para o
modelo carregar de um projeto a outro, confundir ou inventar. Não há um número
que signifique "a cena de outro projeto" — pedir a cena 2 no projeto errado
devolve a cena 2 DAQUELE projeto, ou nada.

O `ordinal` é também o número que a pessoa fala: *"a cena 4"*. A tradução de
linguagem para argumento é 1:1, sem invenção.

### Fontes: referência, nunca cópia

`production_plan_sources` guarda **`documentId`**, e mais nada. O texto do PDF já
está em `document_chunks`; copiá-lo para o plano criaria uma segunda cópia que
envelhece — e que continuaria afirmando coisas sobre um documento depois de ele
mudar.

Cada `documentId` é conferido contra o PROJETO antes de qualquer escrita, com a
mesma implementação e a mesma frase das ferramentas de documento: *"este projeto
não tem um documento com esse identificador"* — a mesma resposta para "não
existe" e para "existe, mas é de outro projeto".

É isto que torna a proposta rastreável: dá para perguntar *"de onde veio este
plano?"* e ter uma resposta que não é a memória da conversa. Há teste que
confere que o plano gravado **não contém** nenhum fato do documento.

### O roteiro é texto; a estrutura são as cenas

`fullText` é o roteiro corrido — a peça que uma PESSOA lê, com a voz que ela tem.
A estrutura que a máquina manipula individualmente são as cenas, que são linhas
de verdade em outra tabela.

Guardar as duas coisas na coluna faria "mude a cena 4" virar edição de string,
com o modelo reescrevendo o texto inteiro para mudar dez segundos. Guardar só as
cenas jogaria fora o roteiro que o usuário quer ler.

**Reescrever o roteiro NÃO apaga as cenas.** O `id` do roteiro não muda numa
regravação, então nada cascateia: corrigir uma frase do texto não pode demolir o
plano de cenas.

### Duração: ±5 s na criação, e nunca numa ordem

Na criação do conjunto (`replace_scenes`), a soma das cenas precisa ficar dentro
de **±5 segundos** de `targetDurationSeconds`. Um plano de "dois minutos" cujas
cenas somam quarenta segundos não é uma aproximação: é outro filme. Cinco
segundos, e não uma porcentagem, porque a conta precisa ser óbvia para quem
escreve o plano — com cenas em segundos inteiros, acertar 120 ± 5 é aritmética.

A recusa é **acionável**: ela diz a soma, o alvo e a tolerância, para o agente
corrigir de primeira em vez de adivinhar.

**Em `update_scene` a tolerância NÃO é imposta**, e isto é a decisão de produto
mais importante deste passo:

> *"Reduza a cena 5 para 10 segundos"* é uma ORDEM, não uma proposta. Recusá-la
> porque a soma passou a divergir do alvo seria a ferramenta desobedecendo ao
> usuário para defender um número que o próprio usuário escolheu — e acabou de
> mudar de ideia sobre.

O que a ferramenta faz é **devolver a nova soma e o alvo**, e a persona manda
avisar. Informar é útil; recusar seria errado.

### As oito ferramentas

| Canônica | Entrada do modelo | Devolve |
| --- | --- | --- |
| `project.get_production_plan` | **nenhuma** (schema vazio) | plano, fontes, `hasScript`, contagem e soma das cenas |
| `project.save_production_plan` | `title`, `targetDurationSeconds` (obrigatórios), `logline`, `synopsis`, `format`, `aspectRatio`, `genre`, `tone`, `audience`, `language`, `sourceDocumentIds` | o plano gravado |
| `project.get_script` | **nenhuma** | roteiro inteiro, contagem de cenas |
| `project.save_script` | `title`, `fullText` (obrigatórios), `summary` | o roteiro gravado |
| `project.list_scenes` | **nenhuma** | resumo **bounded** de todas: `ordinal`, `title`, `purpose`, `durationSeconds`, `status`, mais soma e alvo |
| `project.get_scene` | `ordinal` | a cena inteira, com narração e descrição visual |
| `project.replace_scenes` | `scenes[]` | a estrutura resultante |
| `project.update_scene` | `ordinal` + campos permitidos | a cena, mais a nova soma e o alvo |

**`list_scenes` e `get_scene` existem os dois de propósito.** Listar é para
ESCOLHER: quarenta cenas com quatro mil caracteres de narração cada não caberiam
num turno. Ler uma é para LER. Quem lista está procurando, não lendo.

**Nenhum schema contém** `projectId`, `threadId`, `sessionId`, `workflowId`,
`path`, `filename`, `assetId` ou `jobId` — e um campo interno enfiado nos
argumentos é **RECUSADO com o nome dele**, não ignorado. Aceitar em silêncio
ensinaria ao modelo que o campo existe e que ele foi obedecido; a chamada
seguinte viria com o projeto do vizinho. Vale a regra 5: `ToolContext.projectId`
é a autoridade, sempre.

Os handlers moram em três arquivos, um por entidade
(`productionPlan.js`, `productionScript.js`, `productionScenes.js`), e não em
oito. Cada arquivo é dono da lista de campos editáveis da SUA entidade; separar
`get` de `save` duplicaria essa lista, e a cópia esquecida seria a permissiva.

### Hermes e persona

Oito aliases novos na tabela literal fechada, oito schemas no plugin. **O
registry passou de 5 para 13 ferramentas neste passo.**

A persona (`integrations/hermes/persona/showrunner.md`) ganhou três blocos:

- **transformar material em produção** — a ordem obrigatória (entender → plano →
  roteiro → cenas → responder), a duração alvo em segundos, e a instrução de
  ajustar e regravar sozinho quando a soma não fechar;
- **mudar algo já planejado** — consultar o estado real antes, alterar só o que
  foi pedido, e avisar quando a soma se afastar do alvo em vez de "corrigir" as
  outras cenas;
- **nunca afirmar o que não fez** — não dizer "criei as cenas" sem ter usado as
  ferramentas. Descrever uma estrutura na conversa não é tê-la criado, e um
  usuário que acredita que o plano existe vai pedir "mude a cena 4" sobre algo
  que nunca foi gravado.

E a lista de capacidades passou de quatro para cinco, com "planejar a produção".

**Nada disto entra no contexto de todo turno.** O plano, o roteiro e as cenas são
consultados por ferramenta, sob demanda. Despejar quarenta cenas em cada turno
gastaria o contexto para responder "oi".

### O fluxo real, medido

```
project.read_document  (até eof)
  → project.save_production_plan
  → project.save_script
  → project.replace_scenes
```

O domínio força a ordem; a persona a ensina. As duas coisas, porque a persona
sozinha é obediência a prompt.

### Smoke real — o PDF do Prometeu

Ambiente: ComfyUI `:8188`, Hermes dedicado `:8788` (v0.20.3), Next `:3100`.
Projeto novo, conversa nova, `Prometeu_O_Fogo_da_Humanidade.pdf` anexado —
**6 páginas, 5.568 caracteres**.

> *"Transforme este PDF em um mini-documentário de 2 minutos. Crie o plano, o
> roteiro e as cenas, mas ainda não gere imagens ou vídeos."*

```
FERRAMENTAS: project.read_document → project.save_production_plan
           → project.save_script → project.replace_scenes
```

No banco, em consulta **somente leitura**:

```
plan_mtufdjml_0d13ce16   "Prometeu: O Fogo da Humanidade"
                         format mini-documentário · target 120s · 16:9 · rascunho
  fontes: doc_mtufdag3_ca0bd482 → Prometeu_O_Fogo_da_Humanidade.pdf
script_mtufds3c_e5f3c9cb  1.577 caracteres

 1 | 15s | Antes da centelha        6 | 12s | A libertação
 2 | 17s | A proibição de Zeus      7 | 14s | O fogo que permanece
 3 | 18s | O roubo do fogo
 4 | 22s | A humanidade iluminada   ordinais 1..7 · soma 120s · alvo 120s
 5 | 22s | A ira e o preço
```

### Smoke de edição — a cena 2, e só ela

Na **mesma thread**:

> *"Deixe a cena 2 mais dramática e reduza sua duração em 5 segundos."*

```
FERRAMENTAS: project.list_scenes → project.get_scene → project.update_scene
```

Ele consultou o estado real antes de mexer. A resposta: *"Sua duração foi
reduzida de 17 para 12 segundos. O filme agora soma 115 segundos, ficando 5
segundos abaixo da duração-alvo."* — avisou do desvio em vez de corrigir as
outras cenas por conta própria.

**A prova no banco:**

```
 1 |  15s | created 1788978145093 | updated 1788978145093
 2 |  12s | created 1788978145093 | updated 1788978161965   ← a única alterada
 3 |  18s | created 1788978145093 | updated 1788978145093
 4 |  22s | created 1788978145093 | updated 1788978145093
 5 |  22s | created 1788978145093 | updated 1788978145093
 6 |  12s | created 1788978145093 | updated 1788978145093
 7 |  14s | created 1788978145093 | updated 1788978145093

cenas com updatedAt != createdAt: [2]      soma 115s · alvo 120s
```

Uma cena e apenas uma foi tocada, e é a cena 2. As outras seis mantêm os dois
carimbos idênticos aos da criação — não foram reescritas com o mesmo conteúdo:
não foram escritas.

Terceiro turno, *"Me mostre a estrutura atual das cenas"* → só
`project.list_scenes`, e a tabela devolvida bate com o banco. Ele consultou o
estado real em vez de repetir o que tinha dito.

### Prova de zero mídia

Este é o critério obrigatório do passo, e ele foi medido **no banco**, não
deduzido do comportamento do agente:

```
generation_jobs    6 antes  →   6 depois
assets            28 antes  →  28 depois

neste Project do smoke:   0 generation_jobs · 0 Assets · 0 agent_message_assets
```

> **Production Planning ≠ Production Execution.**

E no SSE dos três turnos — 431 deltas, 8 `tool.completed` — **nenhum carregou
`result`**: a redução final descarta o resultado de qualquer ferramenta que não
produza Asset, e nenhuma destas produz. Nenhum `projectId`, `threadId`,
`documentId`, `plan_`, `script_`, `scene_`, `nextCursor`, `ordinal`, alias do
runtime ou nome do runtime atravessou. Só os nomes canônicos.

### Aprovação — só a base

O que existe é a coluna `status`, com `rascunho` e `aprovado`, no vocabulário que
a aplicação já usava. **Nada escreve `aprovado`**, e `status` não é campo que o
modelo possa escrever.

`lib/approval.js` trata de item de timeline COM MÍDIA (`canAddToTimeline` exige
`url`/`poster`/`mediaUrl`) e não se aplica a um plano. Integrá-lo exigiria
mudança grande, e o enunciado do passo dizia para não fazê-la. **O fluxo de
aprovação fica para uma etapa posterior**, e a base está pronta para ele.

### Testes do Passo 12

**3 arquivos novos, 80 testes.** Baseline: **1128 → 1208**.

| Arquivo | Testes | Protege |
| --- | --- | --- |
| `domain-production.test.mjs` | 42 | os invariantes, a migração 8→9, a `scenes` legada intacta, a forma pública |
| `agent-production-tools.test.mjs` | 33 | ToolContext como autoridade, cross-project, limites, aliases, bridge, fronteira pública |
| `agent-production-planning.test.mjs` | 5 | os três turnos, o plano saído do documento, o reload, e zero mídia |

O multi-turno é determinístico por construção: o runtime é um duplo roteirizado
que usa o `invokeTool` real do gateway, então o ToolContext é o de verdade. Um
teste que dependesse de um modelo real provaria que aquele modelo, naquele dia,
se comportou.

Três detalhes que valem preservar:

- a edição localizada é provada comparando as cenas **campo a campo, `updatedAt`
  incluído**. Um agente que reconstruísse o filme passaria em qualquer teste que
  só olhasse a cena alterada;
- os fatos do fixture são **inventados** (o rio Meridian, o sino Verena, o código
  QV-7731). Uma narração que os contenha só pode ter vindo da leitura;
- o teste de zero mídia conta linhas em `generation_jobs` e `assets`. Provar
  apenas que o duplo não chamou a ferramenta de geração provaria algo sobre o
  duplo.

Sete testes existentes foram ajustados — todos por fixarem listas fechadas ou a
versão do esquema. Dois merecem nota:

- **`agent-architecture.test.mjs`:** a proibição `/\bdocument\b/`, que existe para
  pegar o global do DOM, acertava junto a palavra portuguesa
  *"mini-documentário"* — o hífen abre a palavra e o `á` a fecha, porque o `\b`
  do JavaScript só conhece ASCII. Foi trocada por um padrão que exige `document`
  sozinho como IDENTIFICADOR. `document.getElementById` continua sendo pego;
  "documentário" é vocabulário do produto e deixou de ser acusado;
- **`agent-document-tools.test.mjs`:** ele repetia a lista fechada de aliases que
  `hermes-aliases.test.mjs` já confere. Passou a checar só as duas do Passo 11.
  Três cópias da mesma lista seriam mais um lugar para alguém esquecer — e o
  esquecido é sempre o que deixa passar.

---

## 23 · PASSO 13 — PRODUCTION EXECUTION ✅

O Passo 12 fez o plano existir. O **Passo 13 o fez virar mídia** — e mídia que
pertence a um lugar, não à memória da conversa.

```
Production Scene
  → image take 1 → Asset A
  → image take 2 → Asset B        ← o usuário escolhe esta
  → project.generate_scene_video
  → o SERVIDOR resolve a imagem escolhida
  → I2V real
  → video take 1 → Asset C, derivado de B
```

Seis subpassos, seis commits, todos com Quality Gate próprio no fim.

| Subpasso | O que entrou | Commit |
| --- | --- | --- |
| **13-A** | Scene Media Domain — takes e seleção (migração 10) | `3b04848` |
| **13-B** | Image Takes — `project.generate_scene_image` | `3c18d9f` |
| **13-C** | Video Takes / I2V — `project.generate_scene_video` | `90aa84a` |
| **13-D** | Selection & Agent UX — ler a mídia e escolher | `0efe52a` |
| **13-E** | Production Generation Parameters — formato do plano | `cc0d7bb` |
| **13-F** | Quality Gate Final — 86 verificações, 0 falhas | `cd4a84f` |

`ESQUEMA_ATUAL = 10` · **1308 testes, 1308 passando** · build 18/18.

---

### 13-A · Scene Media Domain

Duas tabelas — `production_scene_media` e `production_scene_media_selections` —
descritas em detalhe na **seção 7**, inclusive a chave estrangeira composta que
torna "a cena 4 escolheu a imagem da cena 7" impossível de gravar.

O que vale repetir aqui, porque é a decisão de produto:

- **regenerar cria um take NOVO**; o anterior nunca é sobrescrito;
- **imagem e vídeo têm numeração independente** — a primeira de cada é o take 1;
- **`takeNumber` é do servidor**, alocado em transação, com o `UNIQUE` como rede;
- **o estado da geração continua em `generation_jobs`** — a situação de um take é
  derivada, nunca guardada;
- **a linhagem continua no Asset e no livro-razão** — `production_scene_media`
  não duplica nem estado nem linhagem;
- **`replaceProductionScenes` é recusado quando já existe mídia**, com a guarda
  rodando sob `BEGIN IMMEDIATE` para que nada caiba entre a verificação e o
  `DELETE` das cenas (13-A.1 e 13-A.2 — ver seção 7).

### 13-B · Image Takes

`project.generate_scene_image { ordinal, prompt }`.

```
Production Scene
  → generation/facade (a MESMA de og.generate_image)
  → generation_job
  → image take, já ligado ao job
  → Job Autonomy
  → Asset
  → take.assetId
```

**A ordem é a decisão.** O take nasce no gancho `aoRegistrar`, na janela entre o
registro durável do trabalho e a submissão ao executor. As duas alternativas
ingênuas são piores, cada uma de um jeito: take primeiro deixaria um take vazio
se a submissão falhasse; geração primeiro deixaria um trabalho real na GPU sem
lugar nenhum. Um take **nunca** fica sem rastro — se a submissão falha, ele
continua apontando para o job, e o desfecho mora em `generation_jobs.state`.

**A primeira imagem concluída vira a escolhida.** Um take posterior **não**
substitui a escolha — regenerar oferece alternativa, e trocar por baixo
transformaria "quero ver outra opção" em "perdi a que eu tinha aprovado".

**O vínculo mora em `completeGenerationJob`**, que é o único evento durável por
onde passam os três caminhos de conclusão: o acompanhamento vivo, a consulta da
tela e a reconciliação depois de um reinício. Pendurá-lo em quem começou o faria
existir só no caminho feliz.

O Agent não escolhe `projectId`, `sceneId`, `takeNumber`, `jobId`, `assetId`,
`workflowId`, `modelId` nem provider. Diz qual cena e o que se vê.

### 13-C · Video Takes / I2V

`project.generate_scene_video { ordinal, prompt }`.

```
Scene
  → selected image
  → o SERVIDOR resolve sourceAssetId
  → startVideoGeneration (a MESMA de og.generate_video)
  → I2V
  → generation_job
  → video take
  → Asset
```

**`sourceAssetId` NÃO vem do modelo.** É a regra inteira do subpasso. A geração
avulsa recebe do modelo qual imagem animar — funciona numa conversa, onde "anime
essa imagem" tem antecedente óbvio. Numa produção não funciona: perguntado qual é
a imagem da cena 1, o modelo responde pela memória, e a memória erra exatamente
depois de uma regeneração que ele não viu.

**Sem imagem escolhida válida, recusa** — e **nunca** um t2v silencioso. Os
quatro casos (sem seleção, take sem mídia, Asset apagado, Asset do tipo errado)
recebem a mesma frase, porque para quem pediu são a mesma situação e têm a mesma
saída. Um t2v devolveria um vídeo bonito que o usuário aceitaria, e que não é a
cena que ele aprovou.

**Primeiro vídeo concluído vira o escolhido; um novo não troca em silêncio** —
mesma política da imagem.

**Linhagem, nos dois lugares:**

```
video Asset.derivedFromAssetId    === selected image Asset
generation_jobs.derivedFromAssetId === selected image Asset   (gravado ANTES da submissão)
```

**`minimax_h3_t2v` continua sendo o descriptor multimodal** — `t2v`, `i2v` e
`flf` são o mesmo grafo com zero, uma ou duas imagens ligadas, porque
`MiniMaxH3ImageToVideo` declara `first_frame` e `last_frame` como entradas
opcionais. **Não existe `minimax_h3_i2v`**, e criar um seria um segundo pipeline
para o mesmo modelo. O nome do descriptor é histórico.

### 13-D · Selection & Agent UX

`project.get_scene_media { ordinal }` e
`project.select_scene_take { ordinal, kind, takeNumber }`.

A conversa comprovada:

| O usuário diz | O que acontece |
| --- | --- |
| "Faça outra imagem da cena 1." | nasce o take seguinte; a escolha **não** muda |
| "Use a segunda imagem." | `get_scene_media` → `select_scene_take`; escolha = take 2 |
| "Qual imagem está selecionada?" | `get_scene_media`; a resposta vem do **banco** |
| "Anime essa versão." | o vídeo usa a imagem escolhida **agora** |

`get_scene_media` devolve, por tipo: `total`, `selectedTakeNumber` e a lista de
`{ takeNumber, state, selected }`. O `state` é derivado (`sceneTakeState`) do
livro-razão e da existência do Asset — **sem palavra nova**. A resposta é
limitada por `MAX_TAKES_POR_CENA`, que é o mesmo número do domínio, e não um
segundo teto que possa divergir.

**Escolher é mover um ponteiro:** não apaga take, não move Asset, não gera nada;
imagem e vídeo são independentes; dá para voltar atrás a qualquer momento. A
**tool pública** só aceita take **pronto** — escolher um que ainda gera faria a
cena apontar para o nada, e escolher um que falhou apontaria para algo que nunca
vai existir. (A primitiva de domínio continua permissiva — limitação S.)

**Ambiguidade é comportamento de persona, não garantia estrutural** (limitação
R). "Use a segunda" é claro e é executado; "use a outra" com três tentativas a
persona manda listar e perguntar. Nada disso é imposto pelo servidor, e não deve
ser: um parser de linguagem natural no servidor seria a arquitetura errada.

### 13-E · Production Generation Parameters

**`ProductionPlan.aspectRatio` é resolvido server-side** e usado pelas duas
gerações de cena. O modelo não escolhe formato — se pudesse, escolheria por cena,
e bem: um plano geral pede 16:9, um close pede 9:16. O resultado seria uma
produção com metade das cenas em cada, cada pedaço plausível sozinho e o conjunto
impossível de montar. **Um filme tem um formato**, decidido uma vez, no plano.

**Formato não suportado recusa antes de criar job ou take** —
`exigirAspectoSuportado` pergunta ao **descriptor** (`descriptor.aspects`), não a
uma tabela que a facade conheça. **Nunca** há fallback para 16:9: silenciar aqui
entregaria a produção inteira no formato errado, descoberta só na montagem.

**`ProductionScene.durationSeconds` é duração NARRATIVA** e **não** é convertida
em duração de clipe. Ver limitação O — inclusive o que deliberadamente **não**
foi decidido sobre Shot.

O modelo também não escolhe `duration`, `resolution`, `model` nem provider.

---

### 23.1 · O QUALITY GATE DO PASSO 13 (13-F)

Executado no produto real, com Hermes, ComfyUI e GPU. **86 verificações, 0
falhas, nenhum bug funcional encontrado, nenhuma linha de código alterada.**

Harness versionado e autossuficiente: `tests/quality-gate-13.mjs`. Ele **cria a
própria produção** — id derivado do relógio —, para que "o take 2" signifique a
mesma coisa a cada rodada.

**A produção do gate:** plano em **9:16**, cena 1 com `durationSeconds = 45`,
nascida sem mídia.

**Os cinco turnos, conversados de verdade:**

| # | Pedido | Tools | Turno |
| --- | --- | --- | --- |
| 1 | "Gere uma imagem para a cena 1." | `get_scene → generate_scene_image` | 7,8 s |
| 2 | "Faça outra imagem da cena 1, mais sombria." | `get_scene_media → generate_scene_image` | 9,3 s |
| 3 | "Use a segunda imagem." | `get_scene_media → select_scene_take` | 7,1 s |
| 4 | "Qual imagem está selecionada?" | `get_scene_media` | 5,4 s |
| 5 | "Anime essa versão." | `get_scene_media → generate_scene_video` | 9,7 s |

**O resultado:**

```
image take 1 → Asset A
image take 2 → Asset B   ← selected image
video take 1 → Asset C   ← selected video
```

**As provas de linhagem:**

```
Asset            C.derivedFromAssetId === B      ✔    (!== A ✔)
generation_jobs     derivedFromAssetId === B      ✔
A e B não derivam de nada                         ✔
```

**A prova do mecanismo I2V**, no `/history` do ComfyUI:

```
LoadImage: 1  ·  sr:first_frame → "showrunner/<job>_first.png"
105:104.first_frame = ["sr:first_frame", 0]     (MiniMaxH3ImageToVideo)
modo lido do grafo: i2v
```

**E a prova que elimina o falso positivo:** o arquivo de entrada foi baixado do
ComfyUI e comparado por **SHA-256** com os Assets em disco.

```
first_frame enviado ao ComfyUI: 41269fced9464447 (197.916 bytes)
bate com Asset A? não
bate com Asset B? SIM
```

Os pixels que foram para a GPU são, byte a byte, os da imagem **escolhida**. Um
vídeo parecido com a imagem não seria prova — um t2v com o mesmo prompt também
pareceria.

**Formato e duração, no mesmo render:**

```
grafo da imagem: 9:16        grafo do vídeo: 9:16
arquivo de B: 768×1376 (pedido 0,563 · real 0,558)

Scene.durationSeconds (narrativa) = 45
duração submetida ao gerador       =  6      ← 45 não foi convertido
```

**Job Autonomy:** os turnos levaram 5–10 s; as gerações, ~28 s (imagem) e ~201 s
(vídeo). Os turnos 1 e 5 terminaram muito antes das respectivas GPUs, os jobs
concluíram sozinhos, e os Assets chegaram aos takes depois. **Ninguém precisou
perguntar "e aí?".**

**Persistência:** bridge fechada, `closeDatabase()`, registro de acompanhamento
em memória apagado, tudo reaberto do zero. `get_scene_media` devolveu **JSON
idêntico** — takes, seleções, Assets e linhagem atravessaram o reinício.

**Replace protection:** com mídia na cena, `project.replace_scenes` foi recusado
com a mensagem de proteção e **sem vazar identificador**; takes, seleções, Assets
e ids das cenas ficaram byte a byte idênticos antes e depois.

**Public surface:** os eventos e as respostas dos cinco turnos foram varridos
contra os 12 identificadores reais da execução (assetIds A/B/C, mediaIds,
`sceneId`, `generationJobId`s, nomes de arquivo, `promptId`) e 13 padrões
(`sourceAssetId`, `derivedFromAssetId`, `workflowId`, `ideogram`, `minimax`,
`comfy`, `LoadImage`, `first_frame`, `hermes`, `session_id`, `enabled_toolsets`,
`runtime/`, `/api/media/`). **Nenhum apareceu.** Os nomes canônicos das tools
aparecem; os aliases do runtime, não.

---

## 24 · O que está aberto, e o próximo passo

### O estado, em sete linhas

```
Passos 1–10 CORE ...................... ✅
Passo 11 · Document Ingestion ......... ✅
Thread Continuity ..................... ✅
Quality Gate Audiovisual .............. ✅
Passo 12 · Production Planning ........ ✅
Passo 13 · Production Execution ....... ✅

10.6 · Operational Hardening .......... ⏸ backlog
```

### NEXT — PASSO 14: PRODUCTION AUDIO

O Passo 13 fez a cena virar imagem e vídeo. O **Passo 14 é a voz**.

**Primeiro subpasso planejado: 14-A — Narration Domain.**

A direção conceitual, e só a direção:

```
Production Scene.narration
  → representação durável da produção de voz/áudio
  → preparação para TTS
```

**A arquitetura completa do Passo 14 NÃO foi decidida, e este documento não a
decide.** Registrar aqui a forma final de um take de áudio, ou a relação entre
narração e clipe, seria escolher sem medir — foi exatamente esse cuidado que
manteve o Passo 13 pequeno em cada subpasso.

O que já está no lugar e não precisa ser inventado:

- **a narração já é estado do Project** — `production_scenes.narration` existe
  desde o Passo 12, separada da descrição visual justamente porque são dois
  destinos diferentes: uma vira voz, a outra vira imagem (seção 22);
- **a forma de uma cena ter mídia numerada e escolhível já existe** — takes e
  seleção, `kind` como vocabulário fechado (seção 7). Se áudio for um `kind`,
  é uma decisão a tomar, não uma estrutura a construir;
- **o pipeline de geração é genérico e durável** — facade, livro-razão,
  autonomia do Passo 9 e recuperação do Passo 10 não sabem o que é imagem;
- **a duração narrativa da cena está lá, intocada** — e a relação dela com a
  duração real da voz é uma das perguntas que o Passo 14 vai ter de responder.

As perguntas em aberto que o Passo 14 vai ter de responder — e que este documento
**não** responde: se áudio é um `kind` de take ou outra entidade; se a narração
gerada tem tentativas como imagem e vídeo; o que acontece quando a voz é mais
longa que a cena planejada; e qual a relação disso com Shot e com a montagem.

### As frentes que continuam abertas

Nada aqui está escolhido, além do Passo 12 acima. É o mapa, com o que cada
frente exige — a ordem é decisão de produto.

| Frente | O que ela exige, concretamente |
| --- | --- |
| **Passo 14 — Production Audio** | **o próximo.** `Scene.narration` → voz durável → TTS. Ver acima |
| **Shot — a decupagem** | a cena narrativa é mais longa que um clipe. Quantos planos, de que duração, e como se ordenam — nada decidido (limitação O) |
| **10.6 — Operational Hardening** | fila própria, backpressure, concorrência controlada, cancelamento seletivo, leases/multi-worker (limitação J) |
| **OCR / PDF escaneado** | fora do Passo 11 por decisão. Hoje um PDF sem texto é recusado com honestidade |
| **Conhecimento / RAG** | limitação G. Os chunks do Passo 11 não são isso |
| **Memória de projeto, personagens, continuidade** | limitação H — é o que faz um personagem parecer o mesmo entre cenas |
| **Approvals** | a BASE já existe: a coluna `status` de plano, roteiro e cena, com `rascunho` e `aprovado` (seção 22). Falta o fluxo — e `lib/approval.js`, que trata de item de timeline COM mídia, não serve como está |
| **Reordenar e apagar cenas** | hoje as duas exigem `project.replace_scenes`. Uma `reorder_scene` precisa decidir o que acontece com os ordinais das outras; uma `delete_scene`, o que fazer com o buraco no `1..n` |
| **Versões de plano, roteiro e cenas** | só vale a pena com uma forma de escolher entre elas. Ver a limitação G-bis |
| **UI de Production Planning** | plano, roteiro e cenas hoje só existem pela conversa |
| **Montagem final** | juntar os planos aprovados numa peça só. Agora há o que juntar: cada cena tem um vídeo ESCOLHIDO (seção 23) |
| **Multi-provider / nuvem** | hoje só ComfyUI local |
| **WhatsApp e outros canais** | a arquitetura permite (toda decisão mora no servidor), nada foi construído — limitação I |
| **Research Lab** | — |

Duas coisas que não são frentes, mas continuam pendentes e são baratas:

- o **`README.md` da raiz** segue desatualizado (limitação L);
- **autenticação** passa a ser obrigatória se o Gateway sair de `127.0.0.1`
  (limitação K).

---

## 25 · NON-NEGOTIABLE ARCHITECTURE RULES

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
31. **O modelo não referencia o que o servidor não ofereceu.** Um identificador
    de Asset ou de documento nunca é lembrado nem inventado pelo modelo: o
    servidor monta, no contexto privado do turno, a lista do que pode ser
    referenciado. E ele OFERECE — não elege. Quando a lista tem mais de um
    item e o pedido não desambigua, a resposta certa é perguntar; "o último" é
    heurística, e heurística erra em silêncio exatamente quando há dois.
32. **A execução é decidida pelo argumento estruturado, nunca pelo texto do
    prompt.** `sourceAssetId` presente é image-to-video; ausente é
    text-to-video. A palavra "anime" na frase do usuário é intenção, e resolver
    intenção é trabalho do agente — deixá-la escolher o caminho do executor
    faria a produção depender de como alguém escreveu uma frase.
33. **Comportamento correto não é prova de mecanismo correto.** O Quality Gate
    quase passou com um vídeo que parecia animar a imagem e não animava: era um
    t2v com um prompt descritivo, e a linhagem nascia nula. Quando existe um
    fato verificável no banco ou no executor, ele é a prova — o que a tela
    mostra, não.
34. **O que é escrito uma vez é conflito, não sobrescrita.** `providerJobId` e
    `assistantMessageId` aceitam o **mesmo fato** repetido (replay é idempotente)
    e recusam um fato diferente. É o que torna reconciliação e acompanhamento
    seguros rodando juntos.
35. **Planejar não é gerar.** O planejamento de produção não cria mídia, e
    nenhuma ferramenta dele alcança `generation/`. Um plano precisa existir e
    ser editável antes de qualquer segundo de GPU ser gasto nele — e a prova
    disso é medida no banco (`generation_jobs` e `assets` inalterados), não
    deduzida do comportamento do agente. Ver seção 22.
36. **Uma cena é endereçada pela POSIÇÃO, não por um identificador.** O
    `ordinal` é o número que a pessoa fala — "a cena 4" — e ele é sempre
    relativo ao projeto do ToolContext. O `id` de uma cena não sai do servidor.
    Isso é mais forte do que conferir um `sceneId`: não existe identificador
    para o modelo carregar entre projetos, confundir ou inventar, então
    cross-project deixa de ser recusado e passa a ser impronunciável. Uma
    fronteira que não precisa de conferência é a única que ninguém esquece de
    conferir.
37. **Uma ordem do usuário não é recusada para defender um número que ele
    escolheu.** "Reduza a cena 5 para 10 segundos" é obedecido mesmo quando
    afasta a produção da duração alvo; o que a ferramenta faz é DEVOLVER a nova
    soma para o agente avisar. A tolerância existe onde a duração é uma
    PROPOSTA (a criação do conjunto), não onde ela é uma instrução. Informar é
    útil; recusar seria a ferramenta discutindo com quem dirige.

---

## 26 · Mapa de arquivos

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
| `lib/server/agent/attachments.js` | os avisos privados ao modelo — quais documentos o turno anexou, e quais imagens esta conversa pode referenciar. É PRODUTO, não integração |

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
| `integrations/hermes/persona/showrunner.md` | **a persona — fonte de verdade**. Inclui a ordem obrigatória do planejamento e a proibição de afirmar o que não foi gravado |
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
| `lib/server/agent/tools/handlers/productionPlan.js` | `project.get_production_plan` · `project.save_production_plan` — e as conferências que as três famílias de planejamento compartilham |
| `lib/server/agent/tools/handlers/productionScript.js` | `project.get_script` · `project.save_script` |
| `lib/server/agent/tools/handlers/productionScenes.js` | `project.list_scenes` · `project.get_scene` · `project.replace_scenes` · `project.update_scene` |
| `lib/server/agent/tools/handlers/productionSceneMedia.js` | `project.generate_scene_image` (Passo 13-B) — a ÚNICA família de produção que alcança `generation/facade` |
| `lib/server/agent/tools/handlers/productionSceneVideo.js` | `project.generate_scene_video` (Passo 13-C) — e a resolução server-side da imagem escolhida |
| `lib/server/agent/tools/handlers/productionSceneTakes.js` | `project.get_scene_media` · `project.select_scene_take` (Passo 13-D) |
| `lib/server/agent/tools/jobWatch.js` | **o acompanhamento**: single-flight, laço, teto, ciclo de vida, associação |

### Geração

| Caminho | Papel |
| --- | --- |
| `lib/server/generation/facade.js` | API de alto nível; onde o Asset nasce e onde o livro-razão é escrito. Também o gancho `aoRegistrar` (entre registrar e submeter) e a conferência de formato contra o descriptor |
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
| `lib/server/domain/assets.js` | Asset e linhagem |
| `lib/server/domain/backfill.js` | registro de mídia já em disco (idempotente) |
| `lib/server/domain/documentTypes.js` | **o vocabulário dos tipos de documento** — zero imports, é domínio |
| `lib/server/domain/documents.js` | **o documento do Project**: criação transacional, leitura paginada, fronteira de projeto |
| `lib/server/domain/production.js` | **o planejamento**: plano, roteiro e cenas. A única porta de escrita, e o lugar onde a cadeia Project → Plan → Script → Scenes é imposta |
| `lib/server/domain/scenes.js` | Scene do **storyboard** (migração 1). Legada, sem escritor em produção — **não confunda com `production.js`**; ver seção 7 |
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
| `tests/*.test.mjs` | 75 arquivos, 1308 testes, na suíte |
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
| `tests/agent-image-to-video.test.mjs` | "anime essa imagem" → I2V com linhagem (seção 21) — 14 testes |
| `tests/domain-production.test.mjs` | o planejamento no domínio, a migração 8→9 e a `scenes` legada intacta (Passo 12) — 42 testes |
| `tests/agent-production-tools.test.mjs` | as oito ferramentas de planejamento e a fronteira delas — 33 testes |
| `tests/agent-production-planning.test.mjs` | o caminho inteiro: documento → plano → roteiro → cenas → edição → reload → zero mídia — 5 testes |
| `tests/domain-scene-media.test.mjs` | a mídia de cena no domínio, a migração 9→10, a guarda do replace e a race com duas conexões (13-A) — 37 testes |
| `tests/agent-scene-image.test.mjs` | a imagem de uma cena, do pedido ao Asset (13-B) — 20 testes |
| `tests/agent-scene-video.test.mjs` | a imagem escolhida vira vídeo, com linhagem (13-C) — 18 testes |
| `tests/agent-scene-takes.test.mjs` | ler o que a cena tem e escolher o take (13-D) — 12 testes |
| `tests/agent-scene-parameters.test.mjs` | formato do plano na geração, e a duração que NÃO atravessa (13-E) — 13 testes |
| `tests/fixtures/documents/` | quatro PDFs mínimos versionados + o `gerar.mjs` que os produz |
| `tests/smoke-hermes-real.mjs` | smoke real com Hermes — **fora** da suíte |
| `tests/smoke-i2v-real.mjs` | smoke real de i2v — **fora** da suíte |
| `tests/smoke-scene-image-real.mjs` | a imagem de uma cena, com runtime e GPU reais — **fora** da suíte |
| `tests/smoke-scene-video-real.mjs` | o vídeo de uma cena, com prova de I2V no grafo — **fora** da suíte |
| `tests/smoke-scene-takes-real.mjs` | a conversa de quatro turnos sobre tentativas — **fora** da suíte |
| `tests/smoke-scene-aspect-real.mjs` | o formato do plano chegando ao gerador — **fora** da suíte |
| `tests/quality-gate-13.mjs` | **o Quality Gate do Passo 13**, 86 verificações — **fora** da suíte |

### Documentação

| Caminho | Papel |
| --- | --- |
| `docs/AGENT_IMPLEMENTATION_STATUS.md` | **este documento** |
| `docs/open-generative-hermes-architecture-audit.pdf` | auditoria arquitetural, 27 páginas |
| `integrations/hermes/README.md` | operação do runtime dedicado |
| `README.md` | visão geral do produto — **desatualizado**, ver limitação L |
| `PASSO-6-*.md` (raiz) | relatórios históricos do Passo 6 |

---

## 27 · Convenções que valem a pena preservar

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
