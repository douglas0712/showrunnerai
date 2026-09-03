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
    INSERT INTO runtime_sessions (sessionId, threadId, runtimeId, createdAt, lastUsedAt)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, threadId, runtimeId, agora, agora);

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

/** A associação de uma sessão, ou `null`. Não lança: quem chama decide. */
export function findBindingBySession(sessionId, db = database()) {
  let chave;
  try {
    chave = normalizeSessionId(sessionId);
  } catch {
    return null;
  }
  return linha(db.prepare('SELECT * FROM runtime_sessions WHERE sessionId = ?').get(chave)) ?? null;
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

/** Marca uso. Serve a diagnóstico e a uma futura expiração. */
export function touchRuntimeSession(sessionId, now = Date.now(), db = database()) {
  db.prepare('UPDATE runtime_sessions SET lastUsedAt = ? WHERE sessionId = ?')
    .run(Number(now) || Date.now(), String(sessionId));
}

/** Remove a associação. Usado quando o runtime informa que a sessão morreu. */
export function unbindRuntimeSession(sessionId, db = database()) {
  db.prepare('DELETE FROM runtime_sessions WHERE sessionId = ?').run(String(sessionId));
}
