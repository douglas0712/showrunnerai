# Showrunner Studio

**Crie, dirija e produza vídeos com inteligência artificial.**

Estúdio local de produção audiovisual. Abre direto no estúdio: sem chave de API,
sem login, sem cadastro, sem assinatura e sem conexão com serviços externos.

> **Fase 1 — interface e arquitetura.** Nenhum modelo é executado. As gerações
> são **simuladas** e desenhadas localmente para que o fluxo completo possa ser
> avaliado. Toda tela que produz um resultado diz isso explicitamente.

## Requisitos

- Node.js 18 ou superior (desenvolvido e verificado no Node 24)

## Executar

```bash
npm install
npm run dev -- -p 3020     # http://localhost:3020
```

Outros comandos:

```bash
npm test        # 46 testes da lógica pura (node:test, sem dependências extras)
npm run build   # build de produção
npm start       # serve o build
```

> `next build` e `next dev` compartilham o diretório `.next`. Pare o servidor de
> desenvolvimento antes de rodar a build, ou o dev server perde as referências
> de chunk e passa a responder 500.

## Áreas

| Área | O que faz |
| --- | --- |
| **Início** | Campo “O que você quer criar?”, atalhos de pipeline, projetos e gerações recentes, vitrine de modelos com selo Local/API |
| **Criar** | Abre uma produção e escolhe por onde começar |
| **Imagem** | Prompt, referências, proporção, resolução, seed, quantidade, modelo, galeria com aprovar / pedir alteração / baixar / usar no vídeo |
| **Vídeo** | Texto, imagem ou referência → vídeo; movimento, duração, resolução, FPS, áudio, seed; player, comparação e envio à timeline |
| **Cinema** | Nove controles de direção que montam um prompt cinematográfico editável |
| **Personagens** | Elenco com seed travada para manter consistência entre cenas |
| **Storyboard** | Cards de cena com número, imagem, descrição, duração, modelo, status e reordenação — mais a aba **Timeline** |
| **Projetos** | Criar, renomear, ativar e excluir produções |
| **Biblioteca** | Tudo que foi gerado, com filtros por tipo e status |
| **Workflows** | Pipelines de várias etapas com execução simulada |
| **Agente** | Entrevista o usuário, monta o briefing no painel lateral e anexa entregas para aprovação |
| **Configurações** | Modelos locais (ComfyUI, Ideogram 4, MiniMax H3) e provedores por API — nenhum obrigatório |

## Arquitetura

```
app/                          Rotas (App Router). / → /studio
  studio/[[...slug]]/         Uma rota para todas as áreas
components/
  StudioShell.jsx             Barra lateral, topo e roteamento entre áreas
  StudioContext.jsx           Estado único + persistência em localStorage
  navigation.js               Registro declarativo das áreas
  ResultActions.jsx           Aprovar / pedir alteração / baixar — usado por todas as telas
  screens/                    Uma tela por área
  ui/                         Primitivos, modal, avisos, quadros de mídia, ícones
lib/
  providers/                  LocalProvider · ComfyUIProvider · ApiProvider · MockProvider
  models.js                   Catálogo (runtime local/api + status)
  cinema.js                   Controles de direção → prompt
  storyboard.js  timeline.js  Lógica pura de cenas e montagem
  agentScript.js              Máquina de estados da entrevista
  placeholder.js  rng.js      Quadros simulados determinísticos
tests/                        46 testes da lógica pura
```

### Providers substituíveis

Nenhuma tela sabe quem executa. O registry resolve modelo → provider:

```js
const { provider, intended, simulated, reason } = resolveProvider(modelId);
const resultados = await provider.generateVideo({ prompt, duration, seed, ... });
```

Na fase 1 os providers reais **recusam executar** (`NotImplementedError`) e o
registry cai no `MockProvider`, devolvendo também o motivo — que a interface
mostra ao usuário em vez de fingir uma geração real. Conectar o ComfyUI ou um
provedor remoto na fase 2 é implementar um provider; nenhuma tela muda.

### Persistência

Tudo em `localStorage`, sob o prefixo `showrunner.`: projetos, gerações,
storyboard, timeline, conversa do agente, personagens, controles de cinema e
configurações. **Configurações → Dados locais** mostra o tamanho de cada chave e
permite restaurar a demonstração.

### Timeline e FFmpeg

A timeline já usa a estrutura que a montagem real vai consumir: trilhas
separadas de vídeo e áudio, clipes com duração e ordem, `start` derivado da
sequência. `buildExportPlan()` devolve entradas, `filter_complex` de
concatenação e argumentos de saída — e marca `executable: false`. Nenhum
processo FFmpeg é iniciado na fase 1.

## Isolamento e privacidade

- Nenhuma requisição sai da máquina: sem fontes remotas, sem CDNs, sem ícones
  externos, sem telemetria. Verificado por auditoria de rede no navegador.
- Imagens enviadas são lidas com `FileReader` e permanecem no navegador.
- Os quadros de pré-visualização são SVG gerados em tempo de execução a partir
  da seed — determinísticos e sem qualquer arquivo baixado.
- Nenhum modelo é instalado ou baixado.

## Licença

MIT — ver [`LICENSE`](./LICENSE). As atribuições de terceiros, incluindo o que
foi derivado do Open Generative AI (MIT), estão em
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).
