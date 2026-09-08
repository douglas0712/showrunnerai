// O bridge interno — onde a ferramenta chamada pelo runtime volta a ser nossa.
//
// ── A inversão que este arquivo resolve ─────────────────────────────────────
//
// O Showrunner chama o runtime por HTTP. O runtime chama o Showrunner de volta
// por AQUI. Nesse caminho de volta chegam três coisas, e só três:
//
//     sessionId   quem está falando, do ponto de vista do runtime
//     toolName    o alias, escolhido pelo modelo dentro de uma lista fechada
//     arguments   o que o modelo escreveu
//
// `projectId` e `threadId` NÃO chegam, e o desenho depende disso. Eles são
// deduzidos aqui, do que o servidor já sabia: a associação gravada quando a
// sessão foi criada. Se chegassem pelo canal, seriam entrada controlada pelo
// modelo, e a checagem de propriedade do PASSO 6 passaria a validar um número
// que o próprio chamador escolheu — ou seja, deixaria de validar.
//
// ── Por que socket de domínio Unix ──────────────────────────────────────────
//
// Uma porta TCP, mesmo em loopback, aceita qualquer processo da máquina. Um
// socket de arquivo é autorizado pelo sistema de arquivos: modo 0600 e só o
// dono abre. Não há segredo para distribuir, rotacionar ou vazar em log, o que
// é uma vantagem real sobre um token compartilhado.
//
// ── As barreiras, e por que são quatro ──────────────────────────────────────
//
//   1. schema do Hermes    o modelo só enxerga as três tools (medido: 1 tool
//                          no catálogo com o toolset restrito)
//   2. allowlist do plugin o plugin registra três nomes e mais nenhum
//   3. allowlist daqui     `toCanonicalToolName` recusa o que não está na tabela
//   4. registry nativo     `toolRegistry().invoke` só conhece as tools reais
//
// Quatro porque a primeira não basta: no PASSO 7A.3 foi medido que uma chamada
// DIRETA a `handle_function_call` no Hermes ignora `enabled_toolsets` e executa
// — o corte por toolset vale para o schema, não para o despacho. Então a
// barreira do Hermes protege contra o modelo pedir; as nossas protegem contra
// o pedido chegar.

import { createServer } from 'node:net';
import { chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';
import path from 'node:path';

import { database, DomainError } from '../../domain/db.js';
import { CHANNELS, STAGES } from '../../logs/stages.js';
import { logError, logInfo, logWarn } from '../../logs/logger.js';
import { toolRegistry } from '../tools/index.js';
import { getThreadRecord } from '../threads.js';
import { toCanonicalToolName, UnknownToolAliasError } from './aliases.js';
import { requireBindingBySession, touchRuntimeSession, UnknownRuntimeSessionError } from './sessionBinding.js';

/** Tamanho máximo de uma requisição do bridge. Uma linha JSON não passa disso. */
const MAX_REQUISICAO_BYTES = 256 * 1024;

/** Tools que exigem um projeto para rodar. `og.get_job` também exige. */
const EXIGEM_PROJETO = Object.freeze([
  'og.generate_image', 'og.generate_video', 'og.get_job',
]);

/** Caminho padrão do socket. Fica no runtime/, que o Git ignora. */
export function defaultBridgeSocketPath() {
  const configurado = String(process.env.SHOWRUNNER_BRIDGE_SOCKET || '').trim();
  if (configurado) return configurado;
  return path.join(process.cwd(), 'runtime', 'hermes', 'bridge.sock');
}

/**
 * Registro dos turnos em andamento.
 *
 * O `signal` do ToolContext precisa ser o do turno que está rodando, senão
 * cancelar a conversa não alcançaria a ferramenta. O adaptador anuncia o início
 * e o fim; o bridge consulta. Quando não há turno anunciado (o runtime chamou
 * fora de um turno nosso), a ferramenta roda com um sinal que nunca aborta —
 * que é o comportamento correto: não temos motivo para abortá-la.
 */
export function createActiveTurnRegistry() {
  const ativos = new Map();
  // (sessionId, nome canônico) → fila de resultados ainda não reclamados.
  const resultados = new Map();
  const chave = (sessionId, toolName) => `${sessionId}\u0000${toolName}`;

  return {
    begin(sessionId, signal) { ativos.set(String(sessionId), signal ?? null); },
    end(sessionId) {
      ativos.delete(String(sessionId));
      for (const k of [...resultados.keys()]) {
        if (k.startsWith(`${sessionId}\u0000`)) resultados.delete(k);
      }
    },
    signalFor(sessionId) { return ativos.get(String(sessionId)) ?? null; },
    size() { return ativos.size; },

    /**
     * Guarda o que a ferramenta devolveu, para o fluxo de eventos poder mostrá-lo.
     *
     * O runtime também anuncia a conclusão da ferramenta, mas o que ele carrega
     * junto é um preview TRUNCADO do resultado — bom para log, inútil para
     * montar a tela, porque um JSON cortado ao meio não volta a ser objeto.
     * Aqui o resultado é o nosso, inteiro, do lado de cá do socket.
     *
     * É uma FILA por nome: duas chamadas da mesma ferramenta no mesmo turno
     * concluem na ordem em que começaram.
     */
    recordResult(sessionId, toolName, result) {
      const k = chave(String(sessionId), String(toolName));
      const fila = resultados.get(k) || [];
      fila.push(result);
      resultados.set(k, fila);
    },

    /** Retira o próximo resultado desta ferramenta. `null` se não houver. */
    takeResult(sessionId, toolName) {
      const k = chave(String(sessionId), String(toolName));
      const fila = resultados.get(k);
      if (!fila || fila.length === 0) return null;
      const primeiro = fila.shift();
      if (fila.length === 0) resultados.delete(k);
      return primeiro;
    },
  };
}

/**
 * Executa uma chamada vinda do runtime.
 *
 * Separado do servidor de propósito: é aqui que mora a regra, e uma regra que
 * só possa ser exercitada abrindo um socket é uma regra mal testada.
 */
export async function handleBridgeInvocation(requisicao = {}, {
  db = database(),
  turns = null,
  registry = null,
} = {}) {
  const { sessionId, toolName, arguments: argumentos } = requisicao;

  // 1. o alias precisa estar na tabela fechada
  let canonico;
  try {
    canonico = toCanonicalToolName(toolName);
  } catch (erro) {
    if (erro instanceof UnknownToolAliasError) {
      return recusa('unknown_tool', 'Ferramenta desconhecida.', { sessionId, toolName });
    }
    throw erro;
  }

  // 2. a sessão precisa existir e estar associada a uma conversa
  let vinculo;
  try {
    vinculo = requireBindingBySession(sessionId, db);
  } catch (erro) {
    if (erro instanceof UnknownRuntimeSessionError || erro instanceof DomainError) {
      return recusa('unknown_session', 'Sessão desconhecida.', { sessionId, toolName });
    }
    throw erro;
  }

  // 3. a conversa precisa existir
  const thread = getThreadRecord(vinculo.threadId, db);
  if (!thread) return recusa('unknown_thread', 'Conversa desconhecida.', { sessionId, toolName });

  // 4. e ter projeto, quando a ferramenta exige um
  if (EXIGEM_PROJETO.includes(canonico) && !thread.projectId) {
    return recusa(
      'project_required',
      'Esta conversa ainda não está associada a um projeto.',
    );
  }

  // 5. os argumentos vêm do modelo: precisam ser um objeto, e nada além disso
  //    é assumido. A validação de conteúdo é da própria tool.
  if (argumentos !== undefined && (typeof argumentos !== 'object' || argumentos === null
      || Array.isArray(argumentos))) {
    return recusa('invalid_arguments', 'Argumentos inválidos.');
  }

  // 6. o contexto é construído AQUI, do que o servidor sabe. Nada dele veio
  //    pelo canal.
  const contexto = {
    threadId: thread.id,
    projectId: thread.projectId,
    signal: turns?.signalFor(vinculo.sessionId) ?? null,
  };

  touchRuntimeSession(vinculo.sessionId, Date.now(), db);

  logInfo(STAGES.AGENT_TURN_STARTED, 'Ferramenta solicitada pelo runtime.', {
    channel: CHANNELS.AGENT,
    detail: { threadId: thread.id, projectId: thread.projectId, tool: canonico },
  });

  try {
    const alvo = registry ?? toolRegistry();
    const resultado = await alvo.invoke(canonico, contexto, argumentos ?? {});
    const limpo = sanitizarResultado(resultado);

    // O fluxo de eventos precisa disto para mostrar a mídia na conversa. Fica
    // guardado sob o nome CANÔNICO, que é o mesmo que o evento vai carregar.
    turns?.recordResult(vinculo.sessionId, canonico, limpo);

    return { ok: true, result: limpo };
  } catch (erro) {
    logError(STAGES.AGENT_TURN_FAILED, erro, {
      channel: CHANNELS.AGENT,
      detail: { threadId: thread.id, tool: canonico },
    });
    // A mensagem da tool é nossa e pode ir; o resto (pilha, detail, nome da
    // classe) não sai daqui.
    return recusa('tool_failed', erro?.message || 'A ferramenta falhou.');
  }
}

/**
 * Recusa uma chamada — e deixa registro de por quê.
 *
 * Sem o log, uma recusa é invisível: o modelo recebe a frase, conta ao usuário
 * que "não encontrou", e quem opera a instalação não tem como saber se o job
 * não existe ou se o vínculo de sessão quebrou. Foi exatamente essa a confusão
 * ao portar para a v0.20.3, quando o runtime passou a reportar um id diferente
 * do que o adaptador tinha gravado.
 *
 * Só o COMEÇO do id vai para o log: o bastante para casar com o vínculo do
 * banco, e não o identificador inteiro.
 */
function recusa(code, message, { sessionId = null, toolName = null } = {}) {
  logWarn(STAGES.AGENT_TURN_FAILED, 'Chamada de ferramenta recusada pelo bridge.', {
    channel: CHANNELS.AGENT,
    detail: {
      code,
      toolName: toolName ?? null,
      sessaoPrefixo: sessionId ? `${String(sessionId).slice(0, 8)}…` : null,
    },
  });
  return { ok: false, error: { code, message } };
}

/**
 * Reduz o resultado ao que pode atravessar.
 *
 * O que a tool devolve já é público por construção (ela foi escrita para o
 * agente), mas passar por JSON aqui garante que nada não-serializável, nenhum
 * getter e nenhuma referência viva atravesse o socket.
 */
function sanitizarResultado(resultado) {
  if (resultado === undefined || resultado === null) return null;
  try {
    return JSON.parse(JSON.stringify(resultado));
  } catch {
    return null;
  }
}

/**
 * Sobe o servidor do bridge.
 *
 * Protocolo: uma linha de JSON por requisição, uma linha de JSON por resposta.
 * Simples de falar em Python (o plugin tem seis linhas para isso) e sem
 * dependência de nenhum framework dos dois lados.
 */
export function startBridgeServer({
  socketPath = defaultBridgeSocketPath(),
  db = database(),
  turns = createActiveTurnRegistry(),
  registry = null,
} = {}) {
  mkdirSync(path.dirname(socketPath), { recursive: true });

  // Um socket órfão de um processo morto impediria o bind. Remover é seguro:
  // se houvesse um servidor vivo ali, o bind falharia depois com EADDRINUSE.
  if (existsSync(socketPath)) {
    try { unlinkSync(socketPath); } catch { /* o bind reclama a seguir */ }
  }

  const servidor = createServer((conexao) => {
    let buffer = '';
    let excedeu = false;

    conexao.setEncoding('utf8');

    conexao.on('data', async (pedaco) => {
      if (excedeu) return;
      buffer += pedaco;

      if (buffer.length > MAX_REQUISICAO_BYTES) {
        excedeu = true;
        responder(conexao, recusa('too_large', 'Requisição grande demais.'));
        return;
      }

      const quebra = buffer.indexOf('\n');
      if (quebra === -1) return;

      const linha = buffer.slice(0, quebra);
      buffer = buffer.slice(quebra + 1);

      let requisicao;
      try {
        requisicao = JSON.parse(linha);
      } catch {
        responder(conexao, recusa('invalid_json', 'Requisição inválida.'));
        return;
      }

      try {
        const resposta = await handleBridgeInvocation(requisicao, { db, turns, registry });
        responder(conexao, resposta);
      } catch (erro) {
        logError(STAGES.AGENT_TURN_FAILED, erro, { channel: CHANNELS.AGENT, detail: {} });
        responder(conexao, recusa('bridge_error', 'Falha interna no bridge.'));
      }
    });

    conexao.on('error', () => { /* cliente sumiu; nada a fazer */ });
  });

  return new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(socketPath, () => {
      // Só o dono abre. É esta linha que substitui um token compartilhado.
      try { chmodSync(socketPath, 0o600); } catch { /* sistema sem modo; segue */ }

      logInfo(STAGES.AGENT_THREAD_CREATED, 'Bridge de ferramentas no ar.', {
        channel: CHANNELS.AGENT,
        detail: { socket: socketPath },
      });

      resolve({
        socketPath,
        turns,
        async close() {
          await new Promise((r) => servidor.close(r));
          if (existsSync(socketPath)) {
            try { unlinkSync(socketPath); } catch { /* já saiu */ }
          }
        },
      });
    });
  });
}

function responder(conexao, carga) {
  try {
    conexao.write(`${JSON.stringify(carga)}\n`);
    conexao.end();
  } catch { /* conexão já fechada */ }
}
