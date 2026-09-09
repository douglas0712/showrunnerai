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
// O vocabulário de estados de uma geração. Importado, e não copiado, pelo mesmo
// critério dos outros: a cláusula CHECK precisa dele, e uma segunda lista aqui
// divergiria da primeira no dia em que um estado entrasse. `jobStates.js` não
// importa nada, então não há ciclo — foi para isso que ele foi isolado de
// qualquer provider no PASSO 10.1.
import { JOB_STATES, JOB_STATE_VALUES, TERMINAL_JOB_STATES } from './generationJobStates.js';

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

  // ── 3 ── idempotência de Asset: UNIQUE(projectId, jobId)
  (db) => {
    // Constraint que previne duplicação de Assets para a mesma geração.
    // Preserva dados: apenas adiciona a restrição futura.
    // IF NOT EXISTS porque testes podem reexecutar migrações parcialmente.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS assets_idempotencia ON assets (projectId, jobId)
        WHERE jobId IS NOT NULL;
    `);
  },

  // ── 4 ── binding de sessão de runtime externo: runtime_sessions
  (db) => {
    // Uma conversa que roda num runtime externo precisa que o runtime a
    // reconheça entre turnos. O runtime devolve um identificador de sessão
    // próprio; a associação mora AQUI, no servidor, porque é a única forma de
    // uma ferramenta chamada DE VOLTA pelo runtime saber a que thread — e
    // portanto a que projeto — ela pertence.
    //
    // O identificador do runtime nunca é enviado ao modelo nem sai numa
    // resposta pública: ele existe entre o adaptador e o bridge, e mais nada.
    //
    // PRIMARY KEY em sessionId e UNIQUE em (threadId, runtimeId) dizem juntos a
    // regra inteira: uma sessão pertence a exatamente uma thread, e uma thread
    // tem no máximo uma sessão por runtime. É o banco que recusa reaproveitar
    // uma sessão entre conversas diferentes, não a boa vontade do adaptador.
    db.exec(`
      CREATE TABLE runtime_sessions (
        sessionId  TEXT PRIMARY KEY,
        threadId   TEXT NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
        runtimeId  TEXT NOT NULL,
        createdAt  INTEGER NOT NULL,
        lastUsedAt INTEGER NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX runtime_sessions_por_thread
        ON runtime_sessions (threadId, runtimeId);
    `);
  },

  // ── 5 ── mídia de uma mensagem: agent_message_assets
  (db) => {
    // Uma resposta do agente pode ter produzido mídia. Guardar a URL no texto
    // seria copiar um dado que já tem dono — e um dado copiado desatualiza. O
    // que a mensagem guarda é a REFERÊNCIA ao Asset; a verdade continua no
    // Asset, e a URL é lida dele na hora de exibir.
    //
    // A PRIMARY KEY composta dá a deduplicação de graça: a mesma imagem citada
    // por duas ferramentas do mesmo turno entra uma vez só, sem que ninguém
    // precise lembrar de conferir.
    //
    // ON DELETE CASCADE nos dois lados: apagar a conversa não deve deixar
    // referência órfã, e apagar o Asset não deve deixar a mensagem apontando
    // para o vazio.
    db.exec(`
      CREATE TABLE agent_message_assets (
        messageId TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
        assetId   TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        seq       INTEGER NOT NULL,
        PRIMARY KEY (messageId, assetId)
      ) STRICT;

      CREATE INDEX agent_message_assets_ordem
        ON agent_message_assets (messageId, seq);
    `);
  },

  // ── 6 ── o segundo nome da mesma sessão: runtime_sessions.bridgeSessionId
  (db) => {
    // O runtime passou a identificar uma conversa por DOIS identificadores, e
    // entrega um diferente a cada lado da integração:
    //
    //   o do gateway   curto, vivo enquanto o processo do runtime viver. É por
    //                  ele que se manda a fala do usuário e se cancela o turno.
    //   o durável      o que sobrevive ao reinício — e é ESTE que o runtime
    //                  informa ao plugin quando o modelo chama uma ferramenta.
    //
    // Gravar só o primeiro fazia toda chamada de ferramenta ser recusada com
    // "sessão desconhecida": o bridge procurava por um nome que nunca tinha
    // sido gravado. Medido ao portar para a v0.20.3.
    //
    // A coluna é anulável porque um runtime pode ter um nome só — o Echo tem —
    // e porque as linhas que já existem foram gravadas antes de haver dois.
    db.exec(`
      ALTER TABLE runtime_sessions ADD COLUMN bridgeSessionId TEXT;

      CREATE UNIQUE INDEX runtime_sessions_por_bridge
        ON runtime_sessions (bridgeSessionId)
        WHERE bridgeSessionId IS NOT NULL;
    `);
  },

  // ── 7 ── o livro-razão das gerações: generation_jobs
  (db) => {
    // ── O que esta tabela É ─────────────────────────────────────────────────
    //
    // O registro do Showrunner sobre um trabalho de geração: de quem ele é,
    // para onde o resultado vai, e em que pé está. É o LIVRO-RAZÃO.
    //
    // O que ela NÃO é: a fila do executor (essa é dele), o handle de execução
    // (esse vive em memória, em comfy/jobs.js), estado de tela, log, nem
    // tabela de runtime nenhum.
    //
    // ── Por que ela precisa existir ─────────────────────────────────────────
    //
    // Até aqui, nada sobre um trabalho em curso chegava ao banco antes de o
    // Asset nascer — e o Asset só nasce no fim. Entre submeter e concluir, um
    // reinício do processo apagava tudo o que se sabia: de qual projeto era, de
    // qual conversa, de qual turno. O trabalho continuava rodando no executor e
    // virava órfão, e o único jeito de reencontrá-lo era adivinhar o projeto
    // pelo diretório em que o arquivo caiu.
    //
    // ── jobId é a chave, e não um id novo ───────────────────────────────────
    //
    // Ele já é o nome do arquivo publicado, já vai dentro do grafo submetido
    // como `filename_prefix`, e já indexa `assets`. Um segundo sistema de
    // identificadores criaria um segundo sistema de nomes — que é exatamente o
    // que a seção 7 do handoff proíbe.
    //
    // ── Por que threadId e userMessageId são anuláveis ──────────────────────
    //
    // Porque nem toda geração nasce numa conversa. As telas do Studio submetem
    // por /api/comfy/generate com projectId e sem thread nenhuma — é superfície
    // existente, não hipótese. Exigir a âncora no ESQUEMA tornaria o livro-razão
    // incapaz de representar o que o produto já faz hoje.
    //
    // Para as gerações que nascem no Agent a âncora é obrigatória, e essa
    // exigência é do repositório e de quem chama — onde ela pode distinguir os
    // dois casos. O banco garante coerência (a mensagem existe, é do papel
    // certo, é da thread certa); ele não decide de quem é a intenção.
    //
    // ── O que deliberadamente NÃO está aqui ─────────────────────────────────
    //
    // Nada de lease (não há multi-worker), nada de tentativas (não há retry),
    // nada de estado do provider (é vocabulário dele, e o domínio tem o seu),
    // nada de prompt/seed/parâmetros (o executor já guarda o grafo submetido, e
    // duplicá-los criaria uma segunda verdade), nada de caminho de arquivo
    // (quem serve mídia é o Asset).
    db.exec(`
      CREATE TABLE generation_jobs (
        jobId              TEXT PRIMARY KEY,
        projectId          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

        -- De quem é o trabalho, do lado da conversa. SET NULL porque um Asset
        -- sobrevive à conversa que o pediu: apagar a thread não apaga o que ela
        -- produziu, e não pode apagar o registro de que produziu.
        threadId           TEXT REFERENCES agent_threads(id) ON DELETE SET NULL,

        -- A âncora do turno (PASSO 10.0): a fala do usuário que iniciou este
        -- trabalho. Gravada antes de qualquer ferramenta rodar, é ela que
        -- responde "de que turno era isto?" depois de um reinício.
        userMessageId      TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,

        -- Onde a mídia vai aparecer. Nulo até o turno gravar a resposta.
        assistantMessageId TEXT REFERENCES agent_messages(id) ON DELETE SET NULL,

        kind               TEXT NOT NULL CHECK (kind IN (${listaSql(ASSET_KINDS)})),

        -- Resolve o descriptor, e o descriptor é quem sabe onde procurar este
        -- trabalho: nós de saída, prefixo, tipo. Não há coluna de provider
        -- porque não há provider fora do descriptor — acrescentá-la agora seria
        -- guardar, em dois lugares, a mesma resposta.
        workflowId         TEXT NOT NULL,

        -- O identificador DO EXECUTOR. Nulo entre o INSERT e o aceite: é essa
        -- janela que um reinício pode pegar, e é por isso que a reconciliação
        -- não pode depender dele.
        providerJobId      TEXT,

        state              TEXT NOT NULL CHECK (state IN (${listaSql(JOB_STATE_VALUES)})),

        -- O resultado. Nulo até o estado done.
        --
        -- Sem ON DELETE, de propósito: o padrão do SQL é NO ACTION, e é ele que
        -- diz a política que queremos. Apagar sozinho o Asset de um trabalho
        -- concluído é RECUSADO — o livro-razão afirma que aquele trabalho
        -- produziu aquilo, e um resultado que some deixa a afirmação falsa.
        --
        -- Apagar o PROJETO continua funcionando: a checagem de NO ACTION é
        -- feita no fim da instrução, e nessa hora o CASCADE do projeto já
        -- levou o Asset e o registro juntos. É a diferença entre NO ACTION e
        -- RESTRICT, que dispararia antes das outras cascatas e impediria isso.
        --
        -- SET NULL, que estava aqui, era pior de um jeito silencioso: ele
        -- tentava anular a coluna e esbarrava no CHECK de done ↔ assetId, então
        -- a recusa acontecia — mas pelo motivo errado, com a mensagem errada.
        assetId            TEXT REFERENCES assets(id),
        -- Linhagem de imagem → vídeo. Hoje só existe em memória e se perde.
        derivedFromAssetId TEXT REFERENCES assets(id) ON DELETE SET NULL,

        -- Motivo de operador. Não é mensagem pública e não sai para o navegador.
        error              TEXT,

        createdAt          INTEGER NOT NULL,
        submittedAt        INTEGER,
        finishedAt         INTEGER,
        updatedAt          INTEGER NOT NULL,

        -- Um trabalho concluído TEM Asset, e um Asset só existe em trabalho
        -- concluído. As duas metades são a mesma regra, e escrevê-la aqui é o
        -- que a torna verdadeira para qualquer escritor — inclusive um SQL
        -- solto, uma migração futura, ou um caminho que ainda não existe.
        --
        -- Sem ela, a janela "done com assetId nulo" ficaria PERSISTIDA, e uma
        -- reconciliação leria como concluído um trabalho sem resultado.
        CHECK ((state = '${JOB_STATES.DONE}') = (assetId IS NOT NULL)),

        -- Terminou se e somente se tem hora de fim. Um estado aberto com
        -- finishedAt preenchido descreveria um trabalho que acabou e
        -- continua andando.
        CHECK ((state IN (${listaSql(TERMINAL_JOB_STATES)})) = (finishedAt IS NOT NULL)),

        -- Motivo de falha só existe onde houve falha. O estado cancelled fica
        -- de fora de propósito: parar a pedido do usuário não é erro, e se um
        -- dia precisar de motivo, será outro conceito e outra coluna.
        CHECK (error IS NULL OR state IN ('${JOB_STATES.FAILED}', '${JOB_STATES.ORPHANED}'))
      ) STRICT;

      -- Um trabalho do executor pertence a um registro nosso, e a um só.
      -- Parcial porque a coluna nasce nula: dois jobs ainda não aceitos não
      -- colidem entre si.
      CREATE UNIQUE INDEX generation_jobs_provider
        ON generation_jobs (providerJobId) WHERE providerJobId IS NOT NULL;

      -- A varredura do reinício: o que ainda não terminou, na ordem em que
      -- começou.
      CREATE INDEX generation_jobs_abertos ON generation_jobs (state, createdAt);

      CREATE INDEX generation_jobs_por_thread ON generation_jobs (threadId, createdAt);
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
