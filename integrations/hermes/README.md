# Integração com o runtime Hermes

O Showrunner conversa com um runtime de raciocínio externo. Esta pasta contém
tudo o que o Showrunner precisa para isso — e **nada** dela mora no repositório
do runtime.

## Desenho

```
Showrunner UI → Agent Gateway → AgentRuntimePort → HermesRuntimeAdapter
                                                          │ HTTP + SSE
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

Depois, o operador coloca as credenciais do provider em
`runtime/hermes/home/.env` e sobe o runtime com esse `HERMES_HOME`, numa porta
só de loopback.

## Variáveis

| Variável | Para quê |
|---|---|
| `SHOWRUNNER_AGENT_RUNTIME=hermes` | escolhe este runtime |
| `SHOWRUNNER_HERMES_URL` | onde o runtime dedicado escuta |
| `SHOWRUNNER_BRIDGE_SOCKET` | caminho do socket; lido pelo Showrunner **e** pelo plugin |

## Segurança

- O bridge é um **socket de domínio Unix** em modo `0600`. Não há porta, não há
  token, e a autorização é do sistema de arquivos.
- A instância do runtime deve escutar **apenas em loopback**.
- Ela roda **sem autenticação HTTP** no MVP. Isso é aceitável somente em
  loopback local: qualquer processo do mesmo usuário pode criar sessões nela.
  Antes de qualquer exposição de rede, isso deixa de ser aceitável.
- Nenhuma sessão é criada sem `enabled_toolsets: ["showrunner", "no_mcp"]`, e o
  adapter confere o que o servidor respondeu antes de usar a sessão.
