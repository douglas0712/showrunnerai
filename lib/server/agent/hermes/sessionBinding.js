// Associação entre a sessão de um runtime externo e a conversa do Showrunner.
//
// ── Por que isto existe ─────────────────────────────────────────────────────
//
// No desenho do Hermes, a ferramenta não é executada dentro do fluxo de `run`.
// O Hermes chama de volta, por um canal próprio, e tudo o que ele carrega nessa
// chamada é o identificador da sessão dele e os argumentos que o MODELO
// escreveu. `projectId` e `threadId` não estão lá — e não podem estar, porque
// qualquer coisa que o modelo escreva é entrada não confiável.
//
// Então a pergunta "a que projeto pertence esta chamada?" só tem uma resposta
// honesta: a que o servidor já sabia antes de a chamada existir. Esta tabela é
// esse conhecimento. O adaptador grava a associação quando cria a sessão; o
// bridge a lê quando a chamada volta. Entre os dois, o modelo não participa.
//
// ── Dois nomes para a mesma sessão ──────────────────────────────────────────
//
// O runtime identifica uma conversa de duas formas, e entrega uma para cada
// lado: o adaptador recebe o identificador do gateway, curto e vivo enquanto o
// processo do runtime viver; o plugin recebe o durável, o que sobrevive a um
// reinício. São a MESMA sessão, e nenhum dos dois lados vê o nome do outro.
//
// Por isso a associação guarda os dois, e a consulta do bridge aceita qualquer
// um deles. Guardar só o do gateway fazia toda chamada de ferramenta ser
// recusada com "sessão desconhecida" — o bridge procurava por um nome que
// nunca havia sido gravado.
//
// ── Por que no banco, e não num Map ─────────────────────────────────────────
//
// Um Map em memória sobrevive ao processo que o criou e a mais nada. O bridge
// atende chamadas que chegam por outro canal, possivelmente depois de um
// reinício, e uma associação perdida vira uma ferramenta que não sabe de quem
// é — que é exatamente o caso em que a resposta segura é recusar, não adivinhar.
// O banco também dá a garantia de unicidade de graça: é ele que impede duas
// threads de compartilharem uma sessão.

import { database, DomainError, linha } from '../../domain/db.js';

/** A sessão citada não corresponde a nenhuma conversa conhecida. */
export class UnknownRuntimeSessionError extends Error {
  constructor(sessionId) {
    super('Sessão de runtime desconhecida.');
    this.name = 'UnknownRuntimeSessionError';
    // O id fica no detail, para o log do servidor. Não vai para a resposta.
    this.detail = { sessionId };
  }
}

/** Comprimento máximo aceito num id de sessão vindo do runtime. */
const MAX_SESSION_ID = 200;

/**
 * Normaliza e valida um id de sessão vindo de fora.
 *
 * O id chega pela rede (do runtime) ou pelo socket (do plugin) e nunca é
 * confiável. Ele vira chave de consulta, então a forma é conferida antes: um id
 * com formato inesperado é recusado aqui, e não usado numa query para descobrir
 * depois que não existia.
 */
export function normalizeSessionId(valor) {
  const texto = String(valor ?? '').trim();
  if (!texto) throw new DomainError('Id de sessão de runtime vazio.', {});
  if (texto.length > MAX_SESSION_ID) {
    throw new DomainError('Id de sessão de runtime longo demais.', { caracteres: texto.length });
  }
  if (!/^[A-Za-z0-9_-]+$/.test(texto)) {
    throw new DomainError('Id de sessão de runtime com formato inesperado.', {});
  }
  return texto;
}

/**
 * Registra a associação sessão → thread.
 *
 * Falha se a sessão já pertence a OUTRA thread. Não é um caso a tolerar
 * silenciosamente: uma sessão reaproveitada entre conversas faria as
 * ferramentas de uma thread rodarem com o projeto de outra, que é a falha de
 * isolamento mais cara que este desenho pode ter.
 */
export function bindRuntimeSession(entrada = {}, db = database()) {
  const sessionId = normalizeSessionId(entrada.sessionId);
  // O segundo nome é opcional: um runtime pode ter um só, e o Echo tem.
  const bridgeSessionId = entrada.bridgeSessionId === undefined
    || entrada.bridgeSessionId === null
    || entrada.bridgeSessionId === ''
    ? null
    : normalizeSessionId(entrada.bridgeSessionId);
  const threadId = String(entrada.threadId ?? '').trim();
  const runtimeId = String(entrada.runtimeId ?? '').trim();
  const agora = Number(entrada.now) || Date.now();

  if (!threadId) throw new DomainError('threadId é obrigatório para vincular a sessão.', {});
  if (!runtimeId) throw new DomainError('runtimeId é obrigatório para vincular a sessão.', {});

  const existente = linha(
    db.prepare('SELECT * FROM runtime_sessions WHERE sessionId = ?').get(sessionId),
  );
  if (existente) {
    if (existente.threadId !== threadId) {
      throw new DomainError('Esta sessão de runtime já pertence a outra conversa.', {
        sessionId, threadId,
      });
    }
    touchRuntimeSession(sessionId, agora, db);
    return existente;
  }

  db.prepare(`
    INSERT INTO runtime_sessions
      (sessionId, threadId, runtimeId, createdAt, lastUsedAt, bridgeSessionId)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(sessionId, threadId, runtimeId, agora, agora, bridgeSessionId);

  return linha(
    db.prepare('SELECT * FROM runtime_sessions WHERE sessionId = ?').get(sessionId),
  );
}

/** A sessão registrada para uma thread neste runtime, ou `null`. */
export function findSessionForThread(threadId, runtimeId, db = database()) {
  return linha(db.prepare(
    'SELECT * FROM runtime_sessions WHERE threadId = ? AND runtimeId = ?',
  ).get(String(threadId), String(runtimeId))) ?? null;
}

/**
 * A associação de uma sessão, ou `null`. Não lança: quem chama decide.
 *
 * Aceita QUALQUER um dos dois nomes da sessão. O bridge é chamado pelo plugin,
 * que só conhece o durável; o adaptador consulta pelo do gateway. Uma consulta
 * que só entendesse um dos dois deixaria metade da integração sem resposta.
 */
export function findBindingBySession(sessionId, db = database()) {
  let chave;
  try {
    chave = normalizeSessionId(sessionId);
  } catch {
    return null;
  }
  return linha(db.prepare(
    'SELECT * FROM runtime_sessions WHERE sessionId = ? OR bridgeSessionId = ?',
  ).get(chave, chave)) ?? null;
}

/**
 * A associação de uma sessão, ou lança.
 *
 * É a forma que o bridge usa: lá, não encontrar a associação é motivo para
 * recusar a chamada, e recusar precisa de um erro com nome.
 */
export function requireBindingBySession(sessionId, db = database()) {
  const encontrado = findBindingBySession(sessionId, db);
  if (!encontrado) throw new UnknownRuntimeSessionError(String(sessionId ?? ''));
  return encontrado;
}

/**
 * Troca o identificador VIVO da sessão desta conversa, preservando a thread.
 *
 * ── Por que esta operação precisa existir ───────────────────────────────────
 *
 * O runtime recicla sozinho as sessões cujo socket criador se desconectou.
 * Quando isso acontece, a conversa do Showrunner continua inteira — ela é
 * durável e é nossa —, mas o nome pelo qual o runtime a conhecia deixou de
 * existir. Restabelecê-la produz um nome VIVO novo para a MESMA conversa, e
 * esta função é o que grava essa troca.
 *
 * ── O que NÃO muda ──────────────────────────────────────────────────────────
 *
 * A thread. É a linha inteira do vínculo que continua sendo daquela conversa —
 * trocar de sessão nunca pode virar trocar de conversa, que é a falha de
 * isolamento que `bindRuntimeSession` existe para recusar.
 *
 * E o identificador DURÁVEL, na prática, também não: ele é o nome pelo qual o
 * plugin reconhece a sessão quando o modelo chama uma ferramenta, e é
 * justamente por ele ser estável que restabelecer a sessão não quebra a ponte
 * de ferramentas no meio de um turno. O parâmetro existe porque o runtime é
 * quem confirma esse valor, e aceitar a confirmação dele é mais honesto do que
 * presumir.
 *
 * DELETE + INSERT, e não UPDATE, porque `sessionId` é a chave primária. Numa
 * transação só: um vínculo apagado e não recriado deixaria a conversa sem
 * sessão nenhuma, que é pior do que o problema que estamos consertando.
 */
export function rebindRuntimeSession(entrada = {}, db = database()) {
  const threadId = String(entrada.threadId ?? '').trim();
  const runtimeId = String(entrada.runtimeId ?? '').trim();
  const sessionId = normalizeSessionId(entrada.sessionId);
  const bridgeSessionId = entrada.bridgeSessionId === undefined
    || entrada.bridgeSessionId === null
    || entrada.bridgeSessionId === ''
    ? null
    : normalizeSessionId(entrada.bridgeSessionId);
  const agora = Number(entrada.now) || Date.now();

  if (!threadId) throw new DomainError('threadId é obrigatório para religar a sessão.', {});
  if (!runtimeId) throw new DomainError('runtimeId é obrigatório para religar a sessão.', {});

  // Um id vivo que já pertence a OUTRA conversa é recusado — a mesma regra de
  // `bindRuntimeSession`, e pelo mesmo motivo.
  const ocupado = linha(
    db.prepare('SELECT * FROM runtime_sessions WHERE sessionId = ?').get(sessionId),
  );
  if (ocupado && ocupado.threadId !== threadId) {
    throw new DomainError('Esta sessão de runtime já pertence a outra conversa.', {
      sessionId, threadId,
    });
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM runtime_sessions WHERE threadId = ? AND runtimeId = ?')
      .run(threadId, runtimeId);
    db.prepare(`
      INSERT INTO runtime_sessions
        (sessionId, threadId, runtimeId, createdAt, lastUsedAt, bridgeSessionId)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(sessionId, threadId, runtimeId, agora, agora, bridgeSessionId);
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return linha(
    db.prepare('SELECT * FROM runtime_sessions WHERE sessionId = ?').get(sessionId),
  );
}

/** Marca uso. Serve a diagnóstico e a uma futura expiração. */
export function touchRuntimeSession(sessionId, now = Date.now(), db = database()) {
  db.prepare('UPDATE runtime_sessions SET lastUsedAt = ? WHERE sessionId = ?')
    .run(Number(now) || Date.now(), String(sessionId));
}

/** Remove a associação. Usado quando o runtime informa que a sessão morreu. */
export function unbindRuntimeSession(sessionId, db = database()) {
  db.prepare('DELETE FROM runtime_sessions WHERE sessionId = ?').run(String(sessionId));
}
