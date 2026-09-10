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
        "Gera um vídeo. Sem sourceAssetId, gera do zero a partir do texto; com "
        "sourceAssetId, ANIMA a imagem indicada e o vídeo fica ligado a ela. "
        "Pedidos como \"anime essa imagem\" exigem sourceAssetId. "
        "Devolve um jobId; o estúdio acompanha sozinho até o fim."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "prompt": {"type": "string", "description": "Descrição do vídeo desejado."},
            "aspect": {"type": "string", "description": 'Proporção: "16:9", "21:9". Padrão: "16:9".'},
            "duration": {"type": "number", "description": "Duração em segundos (1-20). Padrão: 6."},
            "seed": {"type": "integer", "description": "Seed para reprodução. Opcional."},
            "sourceAssetId": {
                "type": "string",
                "description": (
                    "Id de uma imagem já produzida nesta conversa, para ANIMAR. "
                    "Ausente: vídeo do zero, a partir do texto. Presente: anima "
                    "aquela imagem. Pedidos como \"anime essa imagem\" ou "
                    "\"transforme essa imagem em vídeo\" EXIGEM este campo — sem "
                    "ele o vídeo não tem relação com a imagem, por mais que o "
                    "prompt a descreva. Use um identificador que o sistema "
                    "informou; nunca invente um."
                ),
            },
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

# ── documentos de referência do projeto ────────────────────────────────────
#
# O plugin NÃO abre PDF, não lê arquivo e não conhece caminho. Ele encaminha o
# pedido, e quem tem o documento — e quem sabe de qual projeto ele é — é o
# Showrunner, do outro lado do socket. É a mesma fronteira das ferramentas de
# geração, e vale pelo mesmo motivo.
#
# Repare que nenhum dos dois schemas tem projectId. Ele é estado do Showrunner,
# e um campo de estado no schema é um campo que o modelo pode preencher.

LIST_DOCUMENTS_SCHEMA = {
    "name": "project_list_documents",
    "description": (
        "Lista os documentos de referência já anexados a este projeto (PDF ou TXT), "
        "com nome, páginas e tamanho do texto. Use quando o usuário citar um "
        "documento sem anexá-lo neste turno, para descobrir o documentId."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

READ_DOCUMENT_SCHEMA = {
    "name": "project_read_document",
    "description": (
        "Lê o conteúdo de um documento do projeto, em partes. Devolve um trecho, "
        "um nextCursor e um eof. Para tarefas que exigem o documento inteiro "
        "(resumir, listar todos os pontos, propor uma estrutura), chame de novo "
        "passando o nextCursor recebido até eof ser true, e não afirme ter lido "
        "o documento inteiro antes disso."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "documentId": {"type": "string", "description": "Id do documento."},
            "cursor": {"type": "integer", "description": "nextCursor da leitura anterior. Omita para começar do início."},
        },
        "required": ["documentId"],
    },
}

# ── planejamento de produção ───────────────────────────────────────────────
#
# PASSO 12. O plugin continua sem saber o que é uma cena: ele encaminha, e quem
# grava — e quem sabe de qual projeto o plano é — é o Showrunner.
#
# Nenhum destes schemas gera mídia. Planejar e gerar são coisas diferentes, e a
# separação é do produto, não uma limitação: um plano de cenas precisa existir e
# ser editável antes de qualquer segundo de GPU ser gasto nele.
#
# Repare, de novo, que nenhum schema carrega a identidade do projeto. Uma cena é
# endereçada pela POSIÇÃO dela — "a cena 4" —, e a posição só tem significado
# dentro do projeto que o Showrunner já conhece.

GET_PRODUCTION_PLAN_SCHEMA = {
    "name": "project_get_production_plan",
    "description": (
        "Devolve o plano de produção deste projeto: formato, duração alvo, logline, "
        "tom, público e de quais documentos ele saiu; diz também se já há roteiro e "
        "quantas cenas existem. Consulte antes de propor mudanças — o estado do "
        "projeto é a autoridade, não a memória da conversa."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

SAVE_PRODUCTION_PLAN_SCHEMA = {
    "name": "project_save_production_plan",
    "description": (
        "Grava o plano de produção deste projeto, substituindo o anterior. Use quando "
        "o usuário pedir para transformar um material ou uma ideia numa produção. "
        "targetDurationSeconds é a duração pedida em segundos (\"dois minutos\" = 120). "
        "Grave o plano ANTES do roteiro e das cenas."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Título da produção."},
            "logline": {"type": "string", "description": "Uma frase que resume a produção."},
            "synopsis": {"type": "string", "description": "A proposta narrativa, em um ou dois parágrafos."},
            "format": {"type": "string", "description": 'Formato: "mini-documentário", "trailer", "vídeo institucional"…'},
            "targetDurationSeconds": {"type": "integer", "description": "Duração alvo total, em segundos."},
            "aspectRatio": {"type": "string", "description": 'Proporção: "16:9", "9:16", "1:1". Padrão "16:9".'},
            "genre": {"type": "string", "description": "Gênero."},
            "tone": {"type": "string", "description": "Tom: contemplativo, urgente, épico…"},
            "audience": {"type": "string", "description": "Para quem é."},
            "language": {"type": "string", "description": "Idioma da narração."},
            "sourceDocumentIds": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Os documentos deste projeto em que a proposta se baseia. Use "
                    "identificadores que o estúdio informou; nunca invente um."
                ),
            },
        },
        "required": ["title", "targetDurationSeconds"],
    },
}

GET_SCRIPT_SCHEMA = {
    "name": "project_get_script",
    "description": (
        "Devolve o roteiro atual deste projeto, por inteiro, e quantas cenas existem "
        "a partir dele. Consulte antes de reescrever."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

SAVE_SCRIPT_SCHEMA = {
    "name": "project_save_script",
    "description": (
        "Grava o roteiro deste projeto, substituindo o anterior. Exige que o plano de "
        "produção já esteja gravado. Escreva o roteiro como texto corrido, na ordem em "
        "que a produção acontece; depois divida-o em cenas. Reescrever o roteiro não "
        "apaga as cenas."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "Título do roteiro."},
            "summary": {"type": "string", "description": "Resumo curto do que o roteiro cobre."},
            "fullText": {"type": "string", "description": "O roteiro completo, em texto corrido."},
        },
        "required": ["title", "fullText"],
    },
}

# A forma de uma cena, escrita uma vez. Duas cópias divergiriam, e a que
# divergisse seria a que o modelo lê no dia errado.
_SCENE_PROPERTIES = {
    "ordinal": {
        "type": "integer",
        "description": (
            "A posição da cena na produção, começando em 1. Numa gravação de todas as "
            "cenas, os números vão de 1 até a quantidade de cenas, sem repetir e sem pular."
        ),
    },
    "title": {"type": "string", "description": "Título curto da cena."},
    "purpose": {"type": "string", "description": "O que esta cena quer comunicar."},
    "durationSeconds": {"type": "integer", "description": "Duração da cena em segundos inteiros, maior que zero."},
    "narration": {"type": "string", "description": "O texto narrado nesta cena."},
    "visualDescription": {
        "type": "string",
        "description": (
            "O que se vê: enquadramento, ambiente, luz, movimento de câmera. Em "
            "linguagem de direção, não como instrução para um gerador."
        ),
    },
}

LIST_SCENES_SCHEMA = {
    "name": "project_list_scenes",
    "description": (
        "Lista as cenas desta produção, na ordem, com número, título, propósito e "
        "duração, mais a soma das durações comparada com a duração alvo. Use para saber "
        "a estrutura atual antes de mudar qualquer coisa. A narração e a descrição "
        "visual não vêm nesta lista."
    ),
    "parameters": {"type": "object", "properties": {}, "required": []},
}

GET_SCENE_SCHEMA = {
    "name": "project_get_scene",
    "description": (
        "Devolve uma cena inteira desta produção, pelo número dela, incluindo narração "
        "e descrição visual. Use antes de alterar uma cena."
    ),
    "parameters": {
        "type": "object",
        "properties": {"ordinal": _SCENE_PROPERTIES["ordinal"]},
        "required": ["ordinal"],
    },
}

REPLACE_SCENES_SCHEMA = {
    "name": "project_replace_scenes",
    "description": (
        "Grava o plano de cenas desta produção INTEIRO, de uma vez, substituindo o que "
        "houver. Exige o plano e o roteiro gravados. Os números vão de 1 até a "
        "quantidade de cenas, sem repetir e sem pular, e a soma das durações precisa "
        "ficar perto da duração alvo — se não ficar, a gravação é recusada e a mensagem "
        "diz o quanto falta. Use para CRIAR o plano de cenas; para mudar uma cena "
        "depois, use project_update_scene."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "scenes": {
                "type": "array",
                "description": "As cenas da produção, na ordem.",
                "items": {
                    "type": "object",
                    "properties": _SCENE_PROPERTIES,
                    "required": ["ordinal", "title", "durationSeconds"],
                },
            },
        },
        "required": ["scenes"],
    },
}

UPDATE_SCENE_SCHEMA = {
    "name": "project_update_scene",
    "description": (
        "Altera UMA cena desta produção, pelo número dela; as outras não são tocadas. "
        "Use sempre que o pedido for localizado — \"deixe a cena 3 mais dramática\", "
        "\"reduza a cena 5 para 10 segundos\". Nunca regrave todas as cenas para mudar "
        "uma. Informe apenas os campos que mudam."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "ordinal": _SCENE_PROPERTIES["ordinal"],
            "title": _SCENE_PROPERTIES["title"],
            "purpose": _SCENE_PROPERTIES["purpose"],
            "durationSeconds": _SCENE_PROPERTIES["durationSeconds"],
            "narration": _SCENE_PROPERTIES["narration"],
            "visualDescription": _SCENE_PROPERTIES["visualDescription"],
        },
        "required": ["ordinal"],
    },
}

# ── a imagem de uma cena ───────────────────────────────────────────────────
#
# Note o que este schema NÃO tem: sceneId, mediaId, takeNumber, assetId, jobId,
# workflow, modelo, provider. O endereço da cena é o NÚMERO dela, e o número do
# take é do estúdio. Um campo de estado no schema é um campo que o modelo pode
# preencher — e o primeiro que ele tenta preencher é justamente o que não é
# dele.

GENERATE_SCENE_IMAGE_SCHEMA = {
    "name": "project_generate_scene_image",
    "description": (
        "Gera a imagem de UMA cena desta produção, pelo número dela. Use sempre que o "
        "pedido for produzir a mídia de uma cena — \"gere uma imagem para a cena 1\". "
        "Nunca use og_generate_image para isso: só esta ferramenta liga o resultado à "
        "cena. O prompt é a direção visual, escrita a partir do que a cena diz que se vê. "
        "Cada chamada cria um take NOVO, sem apagar o anterior. Responde assim que o "
        "trabalho é aceito; o estúdio acompanha sozinho até o fim."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "ordinal": _SCENE_PROPERTIES["ordinal"],
            "prompt": {
                "type": "string",
                "description": (
                    "A direção visual desta imagem, em palavras de cinema: o que se vê, "
                    "o enquadramento, a luz."
                ),
            },
        },
        "required": ["ordinal", "prompt"],
    },
}

# ── o vídeo de uma cena ────────────────────────────────────────────────────
#
# Note o que FALTA aqui, e que é o ponto do passo: sourceAssetId. A geração de
# vídeo avulsa o recebe — lá é o modelo que indica qual imagem animar. Aqui não
# existe: o estúdio usa a imagem ESCOLHIDA da cena, resolvida do estado
# gravado. Oferecer o campo seria devolver ao modelo a decisão que este passo
# existe para tirar dele.

GENERATE_SCENE_VIDEO_SCHEMA = {
    "name": "project_generate_scene_video",
    "description": (
        "Anima a imagem JÁ ESCOLHIDA de uma cena desta produção, pelo número dela. Use "
        "sempre que o pedido for dar movimento a uma cena — \"anime a cena 1\". Nunca use "
        "og_generate_video para isso, e nunca informe qual imagem animar: o estúdio usa a "
        "imagem escolhida da cena. Se a cena ainda não tiver imagem, gere a imagem "
        "primeiro. O prompt é a direção do MOVIMENTO, não uma nova descrição do quadro. "
        "Cada chamada cria um take NOVO. Responde assim que o trabalho é aceito; o "
        "estúdio acompanha sozinho até o fim."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "ordinal": _SCENE_PROPERTIES["ordinal"],
            "prompt": {
                "type": "string",
                "description": (
                    "A direção do movimento desta cena: o que se move no quadro, para "
                    "onde a câmera anda, o ritmo."
                ),
            },
        },
        "required": ["ordinal", "prompt"],
    },
}

# A allowlist do plugin — a segunda das quatro barreiras. O nome pedido tem de
# estar aqui para sequer virar uma mensagem no socket.
_TOOLS = (
    ("og_generate_image", IMAGE_SCHEMA),
    ("og_generate_video", VIDEO_SCHEMA),
    ("og_get_job", JOB_SCHEMA),
    ("project_list_documents", LIST_DOCUMENTS_SCHEMA),
    ("project_read_document", READ_DOCUMENT_SCHEMA),
    ("project_get_production_plan", GET_PRODUCTION_PLAN_SCHEMA),
    ("project_save_production_plan", SAVE_PRODUCTION_PLAN_SCHEMA),
    ("project_get_script", GET_SCRIPT_SCHEMA),
    ("project_save_script", SAVE_SCRIPT_SCHEMA),
    ("project_list_scenes", LIST_SCENES_SCHEMA),
    ("project_get_scene", GET_SCENE_SCHEMA),
    ("project_replace_scenes", REPLACE_SCENES_SCHEMA),
    ("project_update_scene", UPDATE_SCENE_SCHEMA),
    ("project_generate_scene_image", GENERATE_SCENE_IMAGE_SCHEMA),
    ("project_generate_scene_video", GENERATE_SCENE_VIDEO_SCHEMA),
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
