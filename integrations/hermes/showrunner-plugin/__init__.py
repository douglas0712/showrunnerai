"""Plugin fino do Showrunner para o runtime Hermes.

Ele é deliberadamente burro. Tudo o que faz é receber a chamada do modelo,
juntá-la ao identificador de sessão que o runtime entrega FORA dos argumentos,
e empurrar os dois por um socket local. Quem decide qualquer coisa é o
Showrunner, do outro lado.

O que este arquivo NÃO faz, e não deve passar a fazer:

    não fala com o ComfyUI
    não abre banco de dados
    não lê Asset, cena, workflow ou arquivo
    não executa shell
    não conhece projectId nem threadId
    não gera nada

Se alguma dessas linhas deixar de ser verdade, a fronteira que o PASSO 7A.3
mediu deixou de existir, e o isolamento do runtime passou a depender de código
que mora fora do Showrunner.

── Por que `session_id` vem por kwargs ─────────────────────────────────────

O runtime chama o handler assim (verificado em model_tools.py:1505-1510 →
tools/registry.py:1124-1126):

    handler(args, session_id=..., task_id=..., user_task=...)

`args` é o que o MODELO escreveu — não confiável. `session_id` é o que o
RUNTIME sabe — e é a única coisa aqui que serve para identificar a conversa. Ele
não aparece em nenhum schema, então o modelo não pode escrevê-lo, sobrescrevê-lo
nem adivinhá-lo.

── Por que os schemas são pobres ───────────────────────────────────────────

Só campos de negócio. Nada de projectId, threadId, sessionId, workflowId, path,
filename ou nodeId: esses são estado do Showrunner, e um campo de estado no
schema é um campo que o modelo pode preencher.
"""

from __future__ import annotations

import json
import os
import socket

# Onde o Showrunner escuta. O caminho é configuração de operador; não há
# descoberta automática, porque adivinhar um socket é adivinhar em quem confiar.
_SOCKET_ENV = "SHOWRUNNER_BRIDGE_SOCKET"

# Uma geração de imagem real leva dezenas de segundos; a de vídeo, minutos. O
# timeout é do socket, não da geração — o Showrunner responde com um jobId e a
# espera acontece via og_get_job.
_TIMEOUT_SEGUNDOS = 120.0

_MAX_RESPOSTA_BYTES = 1 * 1024 * 1024


IMAGE_SCHEMA = {
    "name": "og_generate_image",
    "description": (
        "Gera uma imagem a partir de um prompt textual. Devolve um jobId; "
        "use og_get_job para acompanhar até concluir."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {"type": "string", "description": "Descrição da imagem desejada."},
            "aspect": {"type": "string", "description": 'Proporção: "16:9", "21:9", "1:1". Padrão: "16:9".'},
            "seed": {"type": "integer", "description": "Seed para reprodução. Opcional."},
        },
        "required": ["prompt"],
    },
}

VIDEO_SCHEMA = {
    "name": "og_generate_video",
    "description": (
        "Gera um vídeo a partir de um prompt, opcionalmente animando uma imagem "
        "já gerada. Devolve um jobId; use og_get_job para acompanhar."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {"type": "string", "description": "Descrição do vídeo desejado."},
            "aspect": {"type": "string", "description": 'Proporção: "16:9", "21:9". Padrão: "16:9".'},
            "duration": {"type": "number", "description": "Duração em segundos (1-20). Padrão: 6."},
            "seed": {"type": "integer", "description": "Seed para reprodução. Opcional."},
            "sourceAssetId": {"type": "string", "description": "Id de uma imagem já gerada, para animar. Opcional."},
        },
        "required": ["prompt"],
    },
}

JOB_SCHEMA = {
    "name": "og_get_job",
    "description": "Consulta o estado de uma geração iniciada por og_generate_image ou og_generate_video.",
    "parameters": {
        "type": "object",
        "properties": {
            "jobId": {"type": "string", "description": "Id devolvido pela geração."},
        },
        "required": ["jobId"],
    },
}

# A allowlist do plugin — a segunda das quatro barreiras. O nome pedido tem de
# estar aqui para sequer virar uma mensagem no socket.
_TOOLS = (
    ("og_generate_image", IMAGE_SCHEMA),
    ("og_generate_video", VIDEO_SCHEMA),
    ("og_get_job", JOB_SCHEMA),
)
_ALLOWLIST = frozenset(name for name, _ in _TOOLS)


def _erro(mensagem: str) -> str:
    """Erro no formato que o runtime entrega ao modelo."""
    return json.dumps({"error": mensagem}, ensure_ascii=False)


def _chamar_bridge(tool_name: str, session_id: str, arguments: dict) -> str:
    """Uma requisição ao Showrunner. Uma linha de JSON vai, uma linha volta."""
    caminho = os.environ.get(_SOCKET_ENV, "").strip()
    if not caminho:
        return _erro("O Showrunner não está acessível nesta instalação.")

    requisicao = json.dumps(
        {"sessionId": session_id, "toolName": tool_name, "arguments": arguments},
        ensure_ascii=False,
    ) + "\n"

    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(_TIMEOUT_SEGUNDOS)
            sock.connect(caminho)
            sock.sendall(requisicao.encode("utf-8"))

            pedacos = []
            total = 0
            while True:
                pedaco = sock.recv(65536)
                if not pedaco:
                    break
                pedacos.append(pedaco)
                total += len(pedaco)
                if total > _MAX_RESPOSTA_BYTES:
                    return _erro("Resposta do Showrunner grande demais.")
                if pedacos[-1].endswith(b"\n"):
                    break
    except socket.timeout:
        return _erro("O Showrunner demorou demais para responder.")
    except OSError:
        # Sem detalhe do sistema: o caminho do socket e o errno são informação
        # da instalação e não têm por que chegar ao modelo.
        return _erro("Não foi possível falar com o Showrunner.")

    bruto = b"".join(pedacos).decode("utf-8", "replace").strip()
    if not bruto:
        return _erro("O Showrunner não respondeu.")

    try:
        resposta = json.loads(bruto)
    except ValueError:
        return _erro("Resposta inválida do Showrunner.")

    if not resposta.get("ok"):
        detalhe = (resposta.get("error") or {}).get("message") or "A ferramenta falhou."
        return _erro(detalhe)

    return json.dumps(resposta.get("result"), ensure_ascii=False)


def _make_handler(tool_name: str):
    """Fecha sobre o nome da tool; o handler não recebe nome do modelo."""

    def _handler(args: dict, **kwargs) -> str:
        if tool_name not in _ALLOWLIST:          # barreira 2, defensiva
            return _erro("Ferramenta desconhecida.")

        session_id = kwargs.get("session_id")
        if not session_id:
            # Sem identidade de sessão não há como saber de quem é a chamada, e
            # adivinhar seria exatamente o que este desenho existe para evitar.
            return _erro("Esta conversa não está associada a uma sessão do Showrunner.")

        if not isinstance(args, dict):
            return _erro("Argumentos inválidos.")

        return _chamar_bridge(tool_name, str(session_id), args)

    return _handler


def register(ctx) -> None:
    """Chamado uma vez pelo carregador de plugins do runtime."""
    for nome, schema in _TOOLS:
        ctx.register_tool(
            name=nome,
            toolset="showrunner",
            schema=schema,
            handler=_make_handler(nome),
            emoji="🎬",
        )
