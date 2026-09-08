# Integração com o runtime Hermes

O Showrunner conversa com um runtime de raciocínio externo. Esta pasta contém
tudo o que o Showrunner precisa para isso — e **nada** dela mora no repositório
do runtime.

## Desenho

```
Showrunner UI → Agent Gateway → AgentRuntimePort → HermesRuntimeAdapter
                                                          │ JSON-RPC / WebSocket
                                                          ▼
                                              Hermes dedicado (loopback)
                                                          │
                                                  plugin do Showrunner
                                                          │ socket Unix
                                                          ▼
                                              bridge interno → invokeTool()
                                                          │
                                                          ▼
                                              og.generate_image / _video / get_job
```

O runtime raciocina. O Showrunner executa e é dono de todo o estado.

## O que é de quem

| Peça | Dono | Onde |
|---|---|---|
| `plugin.yaml`, `__init__.py` | Showrunner | `integrations/hermes/showrunner-plugin/` |
| `config.template.yaml` | Showrunner | `integrations/hermes/` |
| HERMES_HOME dedicado | operador | `runtime/hermes/home/` (ignorado pelo Git) |
| credenciais | operador | `runtime/hermes/home/.env` (ignorado pelo Git) |

O plugin é instalado por **symlink**, então editá-lo aqui é editá-lo lá. O
runtime pode ser atualizado ou substituído sem que este código mude.

## Preparar a instância dedicada

```bash
node integrations/hermes/prepare.mjs
```

O script cria `runtime/hermes/home/`, escreve o `config.yaml` a partir do
modelo e aponta `plugins/showrunner` para esta pasta. Ele **não** copia
credencial nenhuma — isso é deliberado.

O script escreve DUAS chaves da persona: `agent.personalities.showrunner`, que
a define, e `display.personality`, que a escolhe. Faltar a segunda é uma falha
silenciosa — o runtime sobe, responde, e responde sem persona.

Depois, o operador coloca as credenciais do provider em
`runtime/hermes/home/.env` e sobe o runtime com esse `HERMES_HOME`, numa porta
só de loopback:

```bash
HERMES_HOME=$PWD/runtime/hermes/home \
HERMES_DASHBOARD_SESSION_TOKEN=<segredo do operador> \
HERMES_TUI_TOOLSETS=showrunner \
SHOWRUNNER_BRIDGE_SOCKET=$PWD/runtime/hermes/bridge.sock \
  hermes serve --port 8788 --host 127.0.0.1 --skip-build
```

E sobe o Showrunner com o MESMO token e o MESMO socket.

## Variáveis

Do lado do **Showrunner**:

| Variável | Para quê |
|---|---|
| `SHOWRUNNER_AGENT_RUNTIME=hermes` | escolhe este runtime |
| `SHOWRUNNER_HERMES_URL` | onde o runtime dedicado escuta |
| `SHOWRUNNER_HERMES_TOKEN` | a credencial; igual ao token do runtime |
| `SHOWRUNNER_BRIDGE_SOCKET` | caminho do socket; lido pelo Showrunner **e** pelo plugin |

Do lado do **runtime dedicado**:

| Variável | Para quê |
|---|---|
| `HERMES_HOME` | o home dedicado; nunca o pessoal |
| `HERMES_DASHBOARD_SESSION_TOKEN` | a credencial que o Showrunner apresenta |
| `HERMES_TUI_TOOLSETS=showrunner` | o corte de isolamento (pino explícito) |
| `SHOWRUNNER_BRIDGE_SOCKET` | onde o plugin encontra o Showrunner |

## O protocolo

O turno é JSON-RPC sobre WebSocket em `/api/ws`, com três métodos —
`session.create`, `prompt.submit`, `session.interrupt` — e `GET /api/health`
para diagnóstico. Nada mais. Ver `lib/server/agent/hermes/runtimeClient.js`,
que documenta o que mudou em relação ao HTTP+SSE das versões anteriores.

Uma sessão tem DOIS identificadores: o do gateway, que o adaptador usa para
falar, e o durável, que o runtime informa ao plugin. O vínculo guarda os dois —
sem isso, toda chamada de ferramenta volta como "sessão desconhecida".

## Segurança

- O bridge é um **socket de domínio Unix** em modo `0600`. Não há porta, não há
  token, e a autorização é do sistema de arquivos.
- A instância do runtime deve escutar **apenas em loopback**.
- Ela exige **credencial** em toda rota privada. O token é segredo de operador:
  mora no ambiente dos dois processos, nunca no Git, e nunca chega ao navegador.
- O isolamento de ferramentas é `HERMES_TUI_TOOLSETS=showrunner`. O adapter NÃO
  confia nisso: a cada turno ele confere as ferramentas que o runtime anuncia
  ter dado ao modelo (`session.info`), e um toolset a mais derruba o turno.
- A sentinela `no_mcp` é ignorada por esse caminho, e não faz falta: o pino
  explícito devolve só o que foi nomeado, então nenhum servidor MCP entra sem
  ser pedido.
