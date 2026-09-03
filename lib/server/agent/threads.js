// Repositório de AgentThread e AgentMessage.
//
// A conversa do agente passa a ser estado de servidor. Quem é dono da criação,
// da leitura, da ordem e dos relógios é este módulo — não o navegador. Nada
// aqui depende de localStorage, e a tela atual não foi migrada nesta etapa: a
// superfície nasce completa e a interface a alcança depois.
//
// O esquema mora em domain/db.js, junto com o de Project, Scene e Asset,
// porque é um banco só e um lugar só decide migração. O que este arquivo tem é
// a regra: o que pode ser criado, com o quê, e em que ordem sai.
//
// ── Sobre `projectId` ───────────────────────────────────────────────────────
//
// Uma thread SEM projeto é permitida. O motivo é concreto: a primeira coisa
// que alguém diz ao Showrunner é frequentemente o que quer produzir, e exigir
// um projeto antes da primeira frase inverteria a ordem natural — obrigaria a
// interface a criar um projeto vazio só para poder abrir a conversa, que é
// exatamente o tipo de projeto fantasma que o domínio evita.
//
// Uma thread COM projeto exige que o projeto exista. Verificamos antes do
// INSERT para que a mensagem diga o que houve, e a chave estrangeira continua
// no esquema como rede de segurança. `ensureProject` não é importado aqui e
// não deve ser: nenhum projeto nasce como efeito colateral de alguém abrir uma
// conversa.

import {
  AGENT_MESSAGE_STATUS, AGENT_ROLES, AGENT_THREAD_STATUS,
  database, DomainError, linha, linhas, newId,
} from '../domain/db.js';
import { getProject } from '../domain/projects.js';
import { getAsset } from '../domain/assets.js';

export { AGENT_MESSAGE_STATUS, AGENT_ROLES, AGENT_THREAD_STATUS };

/** Limite do texto de uma mensagem. Generoso, mas não infinito. */
export const MAX_MESSAGE_LENGTH = 16000;

/** Título usado quando quem cria a thread não informa nenhum. */
const TITULO_PADRAO = 'Nova conversa';

/** Comprimento máximo do título. */
const MAX_TITLE_LENGTH = 200;

/**
 * Cria uma thread.
 *
 * `projectId` é opcional; quando vem, o projeto precisa existir.
 */
export function createThreadRecord(entrada = {}, db = database()) {
  const {
    id = newId('thread'),
    projectId = null,
    title = TITULO_PADRAO,
    status = AGENT_THREAD_STATUS[0],
    createdAt = Date.now(),
  } = entrada;

  const projeto = projectId === null || projectId === undefined || projectId === ''
    ? null
    : String(projectId);

  if (projeto !== null && !getProject(projeto, db)) {
    throw new DomainError(`Projeto desconhecido: "${projeto}".`, { projectId: projeto });
  }

  if (!AGENT_THREAD_STATUS.includes(status)) {
    throw new DomainError(
      `Situação de conversa desconhecida: "${status}".`,
      { status, aceitos: AGENT_THREAD_STATUS },
    );
  }

  if (getThreadRecord(id, db)) {
    throw new DomainError(`Já existe uma conversa com o id "${id}".`, { id });
  }

  const agora = Number(createdAt) || Date.now();

  db.prepare(`
    INSERT INTO agent_threads (id, projectId, title, status, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, projeto, tituloValido(title), status, agora, agora);

  return getThreadRecord(id, db);
}

export function getThreadRecord(id, db = database()) {
  if (typeof id !== 'string' || !id) return null;
  return linha(db.prepare('SELECT * FROM agent_threads WHERE id = ?').get(id));
}

/**
 * Threads mais recentes primeiro. `projectId` filtra; `null` explícito lista
 * as que não têm projeto, e omitir o filtro lista todas.
 */
export function listThreadRecords(filtro = {}, db = database()) {
  if (!('projectId' in filtro)) {
    return linhas(db.prepare(
      'SELECT * FROM agent_threads ORDER BY updatedAt DESC, id ASC',
    ).all());
  }

  const { projectId } = filtro;
  if (projectId === null) {
    return linhas(db.prepare(
      'SELECT * FROM agent_threads WHERE projectId IS NULL ORDER BY updatedAt DESC, id ASC',
    ).all());
  }

  return linhas(db.prepare(
    'SELECT * FROM agent_threads WHERE projectId = ? ORDER BY updatedAt DESC, id ASC',
  ).all(String(projectId)));
}

/**
 * Acrescenta uma mensagem ao fim da conversa.
 *
 * `seq` é atribuído aqui, nunca por quem chama: a posição na conversa é do
 * servidor. O SELECT do último `seq` e o INSERT correm na mesma transação, e
 * ela é IMMEDIATE porque é um ler-para-depois-escrever: uma transação
 * postergada pegaria o lock de leitura primeiro e tentaria promovê-lo no
 * INSERT, que é a forma clássica de dois escritores calcularem o mesmo número
 * e um deles morrer com SQLITE_BUSY no meio da gravação. Dentro de um único
 * processo o node:sqlite é síncrono e o bloco corre inteiro sem intercalação;
 * o que isto protege é o segundo processo — o `next build` e o `next dev`
 * abrindo o mesmo arquivo, que já é o caso hoje.
 */
export function appendMessageRecord(entrada = {}, db = database()) {
  const {
    id = newId('msg'),
    threadId,
    role,
    content,
    status = 'completed',
    createdAt = Date.now(),
  } = entrada;

  const thread = getThreadRecord(threadId, db);
  if (!thread) {
    throw new DomainError(`Conversa desconhecida: "${threadId}".`, { threadId });
  }

  if (!AGENT_ROLES.includes(role)) {
    throw new DomainError(
      `Papel de mensagem desconhecido: "${role}".`,
      { role, aceitos: AGENT_ROLES },
    );
  }

  if (!AGENT_MESSAGE_STATUS.includes(status)) {
    throw new DomainError(
      `Situação de mensagem desconhecida: "${status}".`,
      { status, aceitos: AGENT_MESSAGE_STATUS },
    );
  }

  const texto = conteudoValido(content, { threadId, role });
  const agora = Number(createdAt) || Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const ultimo = db.prepare(
      'SELECT MAX(seq) AS seq FROM agent_messages WHERE threadId = ?',
    ).get(threadId);
    const seq = (Number(ultimo?.seq) || 0) + 1;

    db.prepare(`
      INSERT INTO agent_messages (id, threadId, seq, role, content, status, createdAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, threadId, seq, role, texto, status, agora);

    // A conversa "aconteceu" agora — o relógio é do servidor, não do cliente.
    db.prepare('UPDATE agent_threads SET updatedAt = ? WHERE id = ?').run(agora, threadId);

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return linha(db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(id));
}

/**
 * As mensagens da conversa, em ordem.
 *
 * `ORDER BY seq` e não por createdAt: um turno inteiro cabe no mesmo
 * milissegundo, e nesse caso o carimbo de tempo não ordena nada.
 */
export function listMessageRecords(threadId, db = database()) {
  if (typeof threadId !== 'string' || !threadId) return [];
  return linhas(db.prepare(
    'SELECT * FROM agent_messages WHERE threadId = ? ORDER BY seq ASC',
  ).all(threadId));
}

/** Renomeia a conversa. Único campo editável de uma thread hoje. */
export function renameThreadRecord(threadId, title, db = database()) {
  if (!getThreadRecord(threadId, db)) {
    throw new DomainError(`Conversa desconhecida: "${threadId}".`, { threadId });
  }
  db.prepare('UPDATE agent_threads SET title = ?, updatedAt = ? WHERE id = ?')
    .run(tituloValido(title), Date.now(), threadId);
  return getThreadRecord(threadId, db);
}

function tituloValido(title) {
  const texto = String(title ?? '').trim();
  if (!texto) return TITULO_PADRAO;
  return texto.slice(0, MAX_TITLE_LENGTH);
}

function conteudoValido(content, detalhe) {
  if (typeof content !== 'string' || !content.trim()) {
    throw new DomainError('A mensagem está vazia.', detalhe);
  }
  if (content.length > MAX_MESSAGE_LENGTH) {
    throw new DomainError(
      `A mensagem excede ${MAX_MESSAGE_LENGTH} caracteres.`,
      { ...detalhe, caracteres: content.length, limite: MAX_MESSAGE_LENGTH },
    );
  }
  return content;
}

// ── mídia de uma mensagem ───────────────────────────────────────────────────

/**
 * Liga a mídia produzida no turno à mensagem que a anunciou.
 *
 * A associação nasce SERVER-SIDE, do resultado real da ferramenta — nunca de um
 * id que o navegador mandou. É a diferença entre "esta conversa produziu esta
 * imagem" e "alguém disse que produziu", e só a primeira pode virar linha.
 *
 * Cada asset é conferido contra o projeto da conversa antes de entrar. Um id
 * que aponte para outro projeto é descartado em silêncio: não é erro do turno,
 * é uma referência que não pertence a esta conversa, e a resposta certa é ela
 * não existir aqui.
 */
export function attachMessageAssets(messageId, assetIds = [], db = database()) {
  const mensagem = linha(
    db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(String(messageId)),
  );
  if (!mensagem) throw new DomainError(`Mensagem desconhecida: "${messageId}".`, { messageId });

  const thread = getThreadRecord(mensagem.threadId, db);
  if (!thread) throw new DomainError('Conversa desconhecida.', { threadId: mensagem.threadId });

  const aceitos = [];
  let seq = 0;

  for (const bruto of assetIds) {
    const assetId = typeof bruto === 'string' ? bruto.trim() : '';
    if (!assetId) continue;

    const asset = getAsset(assetId, db);
    if (!asset) continue;
    // A fronteira de propriedade. Sem ela, um resultado de outro projeto
    // apareceria numa conversa que não tem direito a vê-lo.
    if (!thread.projectId || asset.projectId !== thread.projectId) continue;

    try {
      db.prepare(
        'INSERT INTO agent_message_assets (messageId, assetId, seq) VALUES (?, ?, ?)',
      ).run(mensagem.id, assetId, seq);
      aceitos.push(assetId);
      seq += 1;
    } catch {
      // PRIMARY KEY (messageId, assetId): já estava lá. É a deduplicação
      // fazendo o trabalho dela, não uma falha.
    }
  }

  return aceitos;
}

/**
 * A mídia de uma mensagem, pronta para exibir.
 *
 * Resolve do Asset — que é o dono da verdade — e devolve só o que a conversa
 * mostra. Nada de caminho de arquivo, nada de job, nada de workflow.
 */
export function listMessageAssets(messageId, db = database()) {
  const referencias = linhas(db.prepare(
    'SELECT assetId FROM agent_message_assets WHERE messageId = ? ORDER BY seq ASC',
  ).all(String(messageId)));

  const saida = [];
  for (const { assetId } of referencias) {
    const asset = getAsset(assetId, db);
    if (!asset || !asset.url) continue;
    saida.push({
      assetId: asset.id,
      kind: asset.kind,
      mediaUrl: asset.url,
      mimeType: asset.mimeType ?? null,
      derivedFromAssetId: asset.derivedFromAssetId ?? null,
    });
  }
  return saida;
}
