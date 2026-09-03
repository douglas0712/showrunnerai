// Camada de domínio — conexão, esquema e migração.
//
// Este é o começo da autoridade do servidor sobre Project, Scene e Asset. O
// navegador continua com o localStorage nesta etapa; nada aqui o substitui
// ainda. O objetivo é existir a base sobre a qual o Agent Gateway vai operar.
//
// O banco vive em runtime/showrunner.db, irmão de runtime/projects/ e
// runtime/logs/ — o mesmo lugar onde o resto do estado de execução já mora, e
// que o .gitignore já mantém fora do versionamento.

import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RUNTIME_ROOT } from '../comfy/config.js';
import { SCENE_STATUS } from '../../storyboard.js';
import { APPROVAL } from '../../approval.js';

/** runtime/showrunner.db — irmão de runtime/projects/ e runtime/logs/. */
export const DB_PATH = path.join(path.dirname(RUNTIME_ROOT), 'showrunner.db');

/**
 * Violação de uma regra de domínio.
 *
 * Distinta de PathValidationError, que continua sendo lançada pelos
 * validadores de caminho reaproveitados de comfy/storage.js — quem chama
 * distingue "identificador inseguro" de "regra de negócio quebrada".
 */
export class DomainError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'DomainError';
    this.detail = detail;
  }
}

/** Vocabulários aceitos, derivados dos módulos que já os definem. */
export const ASSET_KINDS = ['image', 'video'];
export const ASSET_STATUS = Object.values(APPROVAL);
export const SCENE_STATUS_VALUES = Object.values(SCENE_STATUS);

// Vocabulários da conversa do agente. Moram aqui pelo mesmo motivo de
// ASSET_KINDS: as cláusulas CHECK do esquema precisam deles, e o repositório
// que os usa (lib/server/agent/threads.js) importa deste módulo — se fossem
// declarados lá, a importação seria circular.

/** Papéis de uma AgentMessage. */
export const AGENT_ROLES = ['user', 'assistant', 'tool'];

/** Situação de uma AgentThread. */
export const AGENT_THREAD_STATUS = ['active', 'archived'];

/**
 * Situação de uma AgentMessage.
 *
 * Hoje só `completed` é gravado: uma mensagem entra no banco quando já está
 * inteira. `pending` existe para o dia em que a resposta for transmitida em
 * pedaços e a linha nascer antes do último delta; `failed` para a linha que
 * tiver nascido e não puder ser concluída. Enquanto a resposta for montada em
 * memória e gravada de uma vez, um turno que falha simplesmente não deixa
 * mensagem nenhuma — ver `sendMessage` no gateway.
 */
export const AGENT_MESSAGE_STATUS = ['pending', 'completed', 'failed'];

/** Literal SQL a partir de uma lista de valores — para as cláusulas CHECK. */
function listaSql(valores) {
  return valores.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(', ');
}

/**
 * Migrações, em ordem. O índice + 1 é a versão que a migração produz, e
 * `PRAGMA user_version` guarda onde o arquivo está.
 *
 * Nunca edite uma migração já publicada: acrescente outra. Bancos existentes
 * só executam o que falta, então subir a versão é a única forma de mudar o
 * esquema sem apagar o arquivo de ninguém.
 */
const MIGRACOES = [
  // ── 1 ── projects · scenes · assets
  (db) => {
    db.exec(`
      CREATE TABLE projects (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        aspect      TEXT NOT NULL DEFAULT '16:9',
        createdAt   INTEGER NOT NULL,
        updatedAt   INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE scenes (
        id           TEXT PRIMARY KEY,
        projectId    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        number       INTEGER NOT NULL,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL DEFAULT '',
        duration     REAL NOT NULL DEFAULT 6,
        modelId      TEXT,
        status       TEXT NOT NULL CHECK (status IN (${listaSql(SCENE_STATUS_VALUES)})),
        revisionNote TEXT NOT NULL DEFAULT '',
        image        TEXT,
        videoId      TEXT,
        createdAt    INTEGER NOT NULL,
        updatedAt    INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX scenes_por_projeto ON scenes (projectId, number);

      CREATE TABLE assets (
        id                 TEXT PRIMARY KEY,
        projectId          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind               TEXT NOT NULL CHECK (kind IN (${listaSql(ASSET_KINDS)})),
        jobId              TEXT,
        filename           TEXT,
        url                TEXT,
        mimeType           TEXT,
        bytes              INTEGER,
        width              INTEGER,
        height             INTEGER,
        durationSeconds    REAL,
        prompt             TEXT,
        seed               INTEGER,
        modelId            TEXT,
        derivedFromAssetId TEXT REFERENCES assets(id) ON DELETE SET NULL,
        status             TEXT NOT NULL CHECK (status IN (${listaSql(ASSET_STATUS)})),
        createdAt          INTEGER NOT NULL,
        CHECK (derivedFromAssetId IS NULL OR derivedFromAssetId <> id)
      ) STRICT;

      -- Um arquivo por projeto entra uma vez só. É o que torna o backfill
      -- idempotente sem precisar de nenhuma marca de controle à parte.
      CREATE UNIQUE INDEX assets_arquivo ON assets (projectId, filename)
        WHERE filename IS NOT NULL;

      CREATE INDEX assets_por_job    ON assets (jobId);
      CREATE INDEX assets_por_origem ON assets (derivedFromAssetId);
    `);
  },

  // ── 2 ── conversa do agente: agent_threads · agent_messages
  (db) => {
    db.exec(`
      -- projectId é NULLABLE de propósito: a primeira conversa acontece antes
      -- de o usuário ter decidido o que está produzindo. Quando vem
      -- preenchido, a chave estrangeira exige que o projeto exista — nenhum
      -- projeto é materializado por causa de uma thread.
      CREATE TABLE agent_threads (
        id        TEXT PRIMARY KEY,
        projectId TEXT REFERENCES projects(id) ON DELETE CASCADE,
        title     TEXT NOT NULL,
        status    TEXT NOT NULL CHECK (status IN (${listaSql(AGENT_THREAD_STATUS)})),
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX agent_threads_por_projeto ON agent_threads (projectId, updatedAt);

      -- A coluna seq é a ordem da conversa, e não createdAt: um turno inteiro cabe
      -- dentro do mesmo milissegundo (o Echo responde em microssegundos), e
      -- duas linhas com o mesmo createdAt não têm ordem definida. O índice
      -- único é o que garante que a pergunta nunca apareça depois da resposta.
      CREATE TABLE agent_messages (
        id        TEXT PRIMARY KEY,
        threadId  TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        seq       INTEGER NOT NULL,
        role      TEXT NOT NULL CHECK (role IN (${listaSql(AGENT_ROLES)})),
        content   TEXT NOT NULL,
        status    TEXT NOT NULL CHECK (status IN (${listaSql(AGENT_MESSAGE_STATUS)})),
        createdAt INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX agent_messages_ordem ON agent_messages (threadId, seq);
    `);
  },
];

export const ESQUEMA_ATUAL = MIGRACOES.length;

/**
 * Abre (e migra) um banco.
 *
 * `filePath` explícito é o que torna a camada testável: os testes abrem um
 * arquivo temporário e nunca tocam em runtime/. Mesmo padrão do `root =
 * RUNTIME_ROOT` que comfy/storage.js já usa.
 */
export function openDatabase(filePath = DB_PATH) {
  const emMemoria = filePath === ':memory:';
  if (!emMemoria) mkdirSync(path.dirname(filePath), { recursive: true });

  const db = new DatabaseSync(filePath);

  // Sem isto o SQLite aceita silenciosamente uma cena órfã ou um
  // derivedFromAssetId apontando para o nada.
  db.exec('PRAGMA foreign_keys = ON');
  // WAL deixa leitura e escrita conviverem; num banco em memória não se aplica.
  if (!emMemoria) db.exec('PRAGMA journal_mode = WAL');

  migrar(db);
  return db;
}

function migrar(db) {
  const versao = Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
  if (versao >= MIGRACOES.length) return db;

  db.exec('BEGIN');
  try {
    for (let v = versao; v < MIGRACOES.length; v += 1) MIGRACOES[v](db);
    // O PRAGMA não aceita parâmetro ligado; o valor vem do próprio código.
    db.exec(`PRAGMA user_version = ${MIGRACOES.length}`);
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }
  return db;
}

export function schemaVersion(db) {
  return Number(db.prepare('PRAGMA user_version').get().user_version) || 0;
}

// ── instância da aplicação ──────────────────────────────────────────────────
// Guardada em globalThis pelo mesmo motivo documentado em comfy/jobs.js: o
// Fast Refresh do Next recarrega módulos entre requisições em desenvolvimento,
// e uma segunda conexão por recarregamento vazaria descritores de arquivo.

const CHAVE = Symbol.for('showrunner.domain.db');

export function database() {
  if (!globalThis[CHAVE]) globalThis[CHAVE] = openDatabase(DB_PATH);
  return globalThis[CHAVE];
}

/** Fecha a instância da aplicação. Usado no encerramento e nos testes. */
export function closeDatabase() {
  const db = globalThis[CHAVE];
  if (!db) return false;
  db.close();
  delete globalThis[CHAVE];
  return true;
}

/**
 * Identificador novo para cena e asset.
 *
 * Formato `<prefixo>_<tempo base36>_<8 hex aleatórios>`, que respeita a mesma
 * regex de segmento seguro usada nos caminhos (^[A-Za-z0-9_-]{1,64}$) — assim
 * um id pode virar nome de arquivo ou trecho de URL sem tradução.
 *
 * Não usamos `makeId()` de lib/rng.js aqui de propósito: ele conta a partir de
 * um contador de módulo que zera a cada reinício do processo, então dois ids
 * gerados no mesmo milissegundo após um restart colidiriam. No navegador isso
 * é inofensivo; numa chave primária, não.
 */
export function newId(prefixo) {
  if (!/^[A-Za-z][A-Za-z0-9]{0,15}$/.test(String(prefixo || ''))) {
    throw new DomainError(`Prefixo de identificador inválido: "${prefixo}".`);
  }
  return `${prefixo}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
}

// ── utilidades compartilhadas pelos repositórios ────────────────────────────

// `undefined` não é ligável pelo node:sqlite e as colunas STRICT recusam um
// float onde esperam INTEGER. Os três conversores abaixo são a única porta de
// entrada de valor nos repositórios.

/** Inteiro ou NULL. */
export function inteiroOuNulo(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/** Número ou NULL, preservando a fração. */
export function numeroOuNulo(valor) {
  if (valor === null || valor === undefined || valor === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/** Texto ou NULL, sem converter `null` na string "null". */
export function textoOuNulo(valor) {
  if (valor === null || valor === undefined) return null;
  return String(valor);
}

/**
 * Linhas do node:sqlite vêm com protótipo nulo. Copiar para um objeto comum
 * evita surpresa em `assert.deepEqual` e em qualquer `JSON.stringify` adiante.
 */
export function linha(registro) {
  return registro ? { ...registro } : null;
}

export function linhas(registros) {
  return (registros || []).map(linha);
}
