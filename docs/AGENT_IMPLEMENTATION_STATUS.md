# Agent — estado da implementação

Handoff para uma nova sessão continuar sem depender do histórico de conversa.

**Atualizado em:** 3 de setembro de 2026

---

## Ao retomar, antes de qualquer alteração

```bash
git status --short          # esperado: vazio (árvore limpa)
git log --oneline -6
npm test                    # esperado: 434 testes, 434 passando, 0 falhando
```

Se algum dos três divergir, pare e investigue antes de mudar qualquer coisa.

`npm test` emite `ExperimentalWarning: SQLite is an experimental feature` — é
ruído do `node:sqlite` no Node 24, não uma falha. Não suprima.

---

## Estado atual

**Branch:** `feat/showrunner-agent-foundation` (6 commits à frente de `master`)

| Commit | O que entrou |
| --- | --- |
| `85d2882` | runtime ancorado na raiz da aplicação |
| `f62cbed` | Passo 4 — Ideogram 4 nativo |
| `dd53083` | Passo 3 — pipeline imagem + vídeo |
| `454778e` | Passo 2 — Workflow Registry |
| `bf5f74f` | Passo 1 — domínio server-side |
| `6311f5f` | baseline anterior à integração |

**434/434 testes passando. Árvore limpa.**

O projeto se chama `showrunner-studio` (ver `package.json`). "Open Generative AI"
aparece só em `THIRD_PARTY_NOTICES.md`, como atribuição MIT de padrões
derivados — não é este projeto.

---

## O que já está implementado

### Passo 1 — Domínio server-side · `lib/server/domain/`

Autoridade do servidor sobre `Project`, `Scene` e `Asset`, em SQLite
(`node:sqlite`, zero dependências novas) em `runtime/showrunner.db`.

| Arquivo | Papel |
| --- | --- |
| `db.js` | conexão, esquema, migração versionada por `user_version`, `DomainError`, `newId` |
| `projects.js` | CRUD de Project |
| `scenes.js` | CRUD de Scene, `renumberScenes` (transacional) |
| `assets.js` | CRUD de Asset, linhagem (`assetLineage`, `assetDerivatives`) |
| `backfill.js` | registra vídeos já existentes em disco, somente-leitura e idempotente |
| `index.js` | barril de entrada |

Decisões que importam:

- O `id` de Project **é** o segmento de diretório de `runtime/projects/<id>/`.
  Não há um segundo sistema de identificadores. A validação reaproveita
  `validateSegment` de `comfy/storage.js`.
- `Scene` reaproveita `createScene()` e `SCENE_STATUS` de `lib/storyboard.js`;
  a forma não foi reinventada.
- `Asset.derivedFromAssetId` é o campo que torna "anime essa imagem" possível.
  Só é definido na criação e nunca reapontado — por isso um ciclo é impossível.
- Tabelas `STRICT`, chaves estrangeiras ligadas, `CHECK` gerado a partir dos
  vocabulários de `lib/storyboard.js` e `lib/approval.js`.
- **`ensureProject` é interno de migração/backfill.** Está deliberadamente
  fora de `domain/index.js` para que uma tool `og.*` não materialize projetos
  como efeito colateral de resolver um id. Há teste que falha se voltar ao barril.

### Passo 2 — Workflow Registry · `lib/server/generation/workflows/`

| Arquivo | Papel |
| --- | --- |
| `descriptor.js` | contrato genérico: `defineWorkflow`, `validateGraphAgainst`, `WorkflowError`, `deepFreeze` |
| `registry.js` | `getWorkflow` / `hasWorkflow` / `listWorkflows` / `createWorkflowRegistry` |
| `paths.js` | raízes e resolução segura de caminho |
| `resolutionSelector.js` | conhecimento do nó `ResolutionSelector` (compartilhado) |
| `minimaxH3.js` | descriptor do MiniMax H3 |
| `ideogram4.js` | descriptor do Ideogram 4 |

Contrato do descriptor:

```js
{
  id, label, kind: 'image'|'video',
  file,                    // NOME do arquivo, nunca caminho
  rootName: 'comfy'|'project',
  legacyPathEnv,           // override de operador, opcional
  nodeIds, nodeClasses, requiredModels, outputPrefix,
  validate(graph),         // valida as próprias exigências
  patch(template, params), // → { graph, meta }; nunca muta o template
  metaFromGraph(graph, jobId),
  resolvePath(root), loadTemplate(root),
}
```

- Descriptors são **congelados em profundidade** — `nodeIds`, `nodeClasses` e
  `requiredModels` são lidos a cada geração; mutá-los corromperia todas as
  gerações seguintes em silêncio.
- Só objetos vindos de `defineWorkflow` entram no registry (marca não
  enumerável + `Object.isFrozen`). Um `{ ...descriptor }` é recusado.
- Id desconhecido lança `UnknownWorkflowError`. **Nunca** cai em outro workflow.
- `lib/server/comfy/config.js` e `lib/server/comfy/workflow.js` viraram
  superfícies de compatibilidade que reexportam do descriptor. Não têm lógica
  própria. `tests/comfy-compat-surface.test.mjs` varre o repositório e falha se
  algum símbolo importado delas deixar de existir.

### Passo 3 — Pipeline de geração imagem + vídeo · `lib/server/generation/`

| Arquivo | Papel |
| --- | --- |
| `mediaKinds.js` | tabela por tipo: diretório, segmento de URL, extensões, MIME, política de extensão |
| `outputs.js` | `findMediaOutput`, `jobIdFromOutputFilename`, `recoverableOutputs` (puros) |
| `mediaServing.js` | `resolveMediaRequest`, `parseByteRange` — extraídos da rota para serem testáveis |

O que dirige o pipeline é **`descriptor.kind`**, nunca o nome do modelo. Há
teste que remove comentários do fonte e falha se `minimax` ou `ideogram`
aparecerem no código da infraestrutura genérica.

Duas listas de extensão por tipo, e a diferença é proposital:

- `discoveryExtensions` — o que reconhecemos no `/history` do ComfyUI.
  Vídeo: `mp4, webm, mkv, mov, m4v`.
- `mimeByExtension` — o que gravamos e servimos. Vídeo: **só** `.mp4`.

**Invariante obrigatório de toda mídia publicada:**
`bytes reais ↔ extensão final ↔ MIME servido` — os três precisam concordar.

Dois bugs reais foram encontrados e corrigidos ao provar esse invariante:

1. Bytes WebM eram renomeados para `.mp4` e servidos como `video/mp4`.
   `validarMp4` só checava `hasVideo` e `duration > 0`, que um WebM satisfaz.
   Correção: `normalizeProbe` passou a expor `formatName`, `validarMp4` exige
   a família MP4/MOV, e a publicação **recusa** contêiner não servível em vez
   de renomear. Não há transcodificação em lugar nenhum do pipeline.
2. Bytes PNG eram publicados como `.jpg` quando o ComfyUI assim os nomeava.
   Correção: `extensionSource` por tipo — imagem publica pelo formato
   **detectado nos bytes** (`canonicalExtensionFor`), vídeo pela extensão
   declarada. `publishMediaFile` agora exige extensão explícita: o default
   silencioso era o mesmo mecanismo que causou o bug.

Validação de imagem é por **número mágico** (`detectImageType` de
`comfy/images.js`), nunca por extensão. Um `.txt` chamado `resultado.png` é
recusado.

Jobs carregam `workflowId` e `kind`. A fronteira está documentada em
`descriptorForJob`: job novo resolve pelo próprio `workflowId` e id
desconhecido é erro; só job **legado** (criado antes desta etapa, sem os
campos) cai no workflow de vídeo padrão.

### Passo 4 — Ideogram 4 · `ideogram4_t2i`

Workflow versionado em `workflows/ideogram4_t2i_api.json` (29 nós). É uma cópia
controlada do pipeline validado à mão em `/home/douglas/hermes-ideogram/`, que
**não deve ser modificado nem usado como runtime**.

A cópia removeu 10 nós órfãos — uma cadeia de "magic prompt" que alimentava
apenas nós `PreviewAny` e não era alcançável a partir do `SaveImage`. Como
`PreviewAny` é nó de saída no ComfyUI, mantê-los faria o servidor executar a
cadeia inteira a cada geração. O subgrafo que produz a imagem ficou **byte a
byte idêntico** ao validado, e há teste que compara nó a nó contra o original.

| Papel | Nó | Classe | Input |
| --- | --- | --- | --- |
| Prompt | `98:24` | `CLIPTextEncode` | `text` (string literal) |
| Seed | `98:18` | `RandomNoise` | `noise_seed` |
| Resolução | `37` | `ResolutionSelector` | `aspect_ratio`, `megapixels` |
| Output | `158` | `SaveImage` | `filename_prefix` |

Modelos exigidos: `ideogram4_nvfp4_mixed.safetensors` em **dois** `UNETLoader`
(`98:23` e `98:154` — o `DualModelGuider` recebe modelo positivo e negativo),
`qwen3vl_8b_nvfp4.safetensors` (CLIP `98:14`), `flux2-vae.safetensors`
(VAE `98:9`).

A tabela de proporções foi lida de `/object_info/ResolutionSelector` no ComfyUI
vivo, não suposta: 8 opções, idênticas às do MiniMax porque é conhecimento do
**nó**, não do modelo. O caller informa `"16:9"`; a allowlist devolve
`"16:9 (Widescreen)"`. Valor arbitrário para input de nó é recusado.

**Smoke test real concluído com sucesso**, pelo pipeline Node do Showrunner e
sem o `generate_image.py` externo: PNG de 1.318.132 bytes, 1376×768, 29 s,
publicado em `runtime/projects/proj_smoke_ideogram/images/` e servido por
`/api/media/image/...` com `image/png`. A imagem corresponde ao prompt pedido
e não ao prompt padrão do template — prova de que o patch alcançou o modelo.

### Infra — `lib/server/appRoot.js`

`APP_ROOT` é **descoberto**, não presumido: sobe a partir da localização do
próprio módulo até achar um `package.json` com `name`, com o `cwd` como
alternativa. A exigência do `name` é o que impede a busca de parar no
`.next/package.json` da build, que contém só `{"type":"commonjs"}`.

`runtime/` e `workflows/` são ancorados nele e **não dependem mais de
`process.cwd()`**. Módulo neutro: importa apenas `node:fs`, `node:path` e
`node:url`.

Precedência de ambiente:

| Variável | Governa | Precedência |
| --- | --- | --- |
| `COMFY_WORKFLOW` | workflow do MiniMax | 1ª — caminho absoluto, vence tudo |
| `COMFY_WORKFLOWS_ROOT` | raiz de workflows do ComfyUI | senão, raiz padrão embutida |
| `SHOWRUNNER_WORKFLOWS_ROOT` | raiz `workflows/` do projeto | senão, `APP_ROOT/workflows` |
| *(nenhuma)* | `runtime/` | sempre `APP_ROOT/runtime` |

Variável de ambiente é **configuração de operador** e pode definir localização.
Corpo de requisição e argumento de tool são **input de usuário/agente** e nunca
podem: enviam `workflowId` e nada mais.

---

## Arquitetura aprovada

O Showrunner é o produto e o *system of record*. O Hermes será apenas runtime
de raciocínio, escondido.

```
Showrunner UI
   → Agent Gateway
      → AgentRuntimePort
         → HermesRuntimeAdapter
            → Hermes
      → tools do Showrunner
         → domain / generation
```

**Nunca:** frontend → Hermes diretamente.

O Hermes **não** é dono de: Project, Scene, Asset, Job, storage, approvals nem
memória estrutural da produção. Ele interpreta, planeja, dirige, decide e pede
tools.

### Identidade

O usuário deve perceber **apenas o Showrunner**. Persona, skills, tools,
knowledge e memória são propriedade e configuração do Showrunner.

Nenhum nome, evento, erro ou conceito específico do Hermes pode atravessar o
Agent Gateway até a UI normal.

---

## Pendência importante

**`Asset` ainda NÃO é criado automaticamente em `finalizeJob`.**

Motivo concreto, verificado: os projetos usados pelas telas de vídeo
(`avulso`, `proj_demo_noir`, `recuperados`) vivem no `localStorage` e **não
existem** no domínio server-side. Chamar `createAsset` ali hoje quebraria toda
geração de vídeo com "Projeto desconhecido".

**Não resolver com `ensureProject`.** O desbloqueio correto é o Agent Gateway /
fluxo novo criar e operar Projects server-side válidos.

Quando for a hora, o ponto de integração é `finalizeJob`, logo após
`publishMediaFile` e antes do `updateJob(state: DONE)` — é onde `salvo.url`,
`filename`, `bytes`, `kind`, `jobId`, `projectId`, `prompt` e `seed` estão
todos em mãos.

---

## Próximo passo

### Passo 5 — Agent Gateway + EchoRuntimeAdapter

**Começar SEM Hermes.** O objetivo é criar a abstração de runtime própria do
Showrunner e provar o fluxo de conversa e tools sem depender dele.

```
lib/server/agent/
  gateway.js
  AgentRuntimePort.js
  adapters/
    EchoRuntimeAdapter.js
  tools/
  events.js
  threads.js
```

Convenção do repositório a seguir: **rota fina em `app/api/`, lógica em
`lib/server/`, adaptador de navegador em `lib/providers/`.**

Dependências proibidas dentro de `lib/server/agent/`:

- `components/`, React, `lib/storage.js` — o Gateway roda no servidor;
- `next/server` — as rotas importam o gateway, não o contrário. É o que o
  mantém testável com `node:test` como o resto;
- `lib/server/comfy/client.js` direto — handlers chamam `generation`, que chama
  `comfy`. Falar HTTP com o ComfyUI a partir de uma tool violaria a regra
  "ComfyUI é controlado pelo Showrunner".

### Depois

- **Passo 6** — tools `og.*`
- **Passo 7** — `HermesRuntimeAdapter`
- **Passo 8** — AgentScreen real

### Fase posterior

Persona / alma · skills · knowledge base / RAG · memória de projeto ·
personagens e continuidade · approvals · SSE · fila durável.

---

## Riscos ainda abertos

- **`/interrupt` do ComfyUI é global.** Cancelar um job interrompe o que
  estiver rodando, não necessariamente o alvo. Com um agente disparando jobs
  em paralelo isso vira corrupção silenciosa. A fila própria com concorrência 1
  resolve os dois problemas de uma vez.
- **Sem backpressure.** Nada limita submissões simultâneas; um laço de agente
  com erro enche a fila da GPU.
- **Jobs somem no restart.** `Map` em `globalThis`, poda de terminais em 6 h.
  `recoverFromHistory` mitiga, mas só para o que tem o prefixo de saída da
  aplicação.
- **Sem autenticação.** É decisão de produto correta hoje ("sem conta, sem
  chave"), mas `/api/agent/*` aceitando texto livre que vira execução de tool é
  outra classe de superfície. Se o Gateway ouvir fora de `127.0.0.1`, precisa
  de token.
- **`README.md` está desatualizado** — descreve "Fase 1, nenhum modelo é
  executado", enquanto Cinema, Vídeo e agora Ideogram geram de verdade.

---

## Convenções que valem a pena preservar

- Injeção de dependência no estilo da casa: último parâmetro com default
  (`root = RUNTIME_ROOT`, `db = database()`). É o que torna tudo testável sem
  mocking.
- Vocabulários gerados a partir dos módulos que já os definem — não há lista de
  status duplicada em SQL para divergir.
- Testes com `node:test`, sem dependências. Vários deles são regressões de
  falhas reais e trazem a causa documentada no cabeçalho: se um quebrar, o
  refactor está errado, não o teste.
- Nenhum `if (workflowId === '...')` na infraestrutura genérica. O que dirige o
  comportamento é `descriptor.kind`.
- Auditoria arquitetural completa em
  `docs/open-generative-hermes-architecture-audit.pdf` (27 páginas) — contexto
  de por que cada camada existe.
