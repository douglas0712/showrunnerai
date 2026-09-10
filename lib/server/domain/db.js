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
// O vocabulário dos tipos de documento, pelo mesmo critério do anterior: a
// cláusula CHECK precisa dele e `documentTypes.js` não importa nada.
import { DOCUMENT_TYPE_VALUES } from './documentTypes.js';

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

/**
 * Os papéis sonoros que uma cena aceita (PASSO 14-B).
 *
 * Um só, e de propósito. `music`, `sfx`, `dialogue`, `ambient` e `foley` não
 * estão aqui porque não sabemos de quem eles são: música, em particular, tem
 * toda a cara de pertencer ao Project ou a uma sequência, e não a uma cena.
 * Escrever a palavra agora seria decidir a cardinalidade dela sem ter o
 * problema na mão — e o CHECK que a aceitasse passaria a ser um convite.
 *
 * Não é `ASSET_KINDS`, e não pode ser: `kind` diz de que MÍDIA um arquivo é
 * (imagem, vídeo), e `role` diz que PAPEL um áudio cumpre na cena. Um dia os
 * dois vão se encontrar — uma narração é `role='narration'` gravada num Asset
 * `kind='audio'` — mas são duas perguntas, e uma lista só não responde as
 * duas.
 */
export const AUDIO_ROLES = ['narration'];
export const ASSET_STATUS = Object.values(APPROVAL);
export const SCENE_STATUS_VALUES = Object.values(SCENE_STATUS);

/**
 * Os estados de uma peça do planejamento de produção (PASSO 12).
 *
 * Nenhuma palavra nova: as duas saem de `SCENE_STATUS`, que já é o vocabulário
 * da aplicação para o mesmo conceito. Inventar `draft`/`approved` aqui criaria
 * um segundo idioma para dizer a mesma coisa, e a tela teria de traduzir entre
 * os dois.
 *
 * São só duas porque o planejamento só tem duas respostas hoje: ou o plano está
 * sendo escrito, ou o usuário disse que está bom. `pendente`, `revisão` e
 * `vídeo gerado` pertencem ao ciclo de vida de uma MÍDIA, e não há mídia aqui —
 * o PASSO 12 termina antes da geração.
 *
 * Nada escreve `aprovado` nesta etapa: o campo existe como base do fluxo de
 * aprovação, e quem o escreverá é o passo que o implementar. Ver o cabeçalho da
 * migração 9.
 */
export const PRODUCTION_STATUS = Object.freeze({
  DRAFT: SCENE_STATUS.DRAFT,
  APPROVED: SCENE_STATUS.APPROVED,
});

export const PRODUCTION_STATUS_VALUES = Object.values(PRODUCTION_STATUS);

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

  // ── 8 ── documentos do projeto: project_documents · document_chunks ·
  //         agent_message_documents
  (db) => {
    // ── O que estas tabelas SÃO ─────────────────────────────────────────────
    //
    // O material de referência de uma produção: o PDF que o usuário mandou, o
    // TXT que ele colou. É entidade de DOMÍNIO, e o dono é o Project.
    //
    // O que elas NÃO são: um Asset. Um Asset é mídia que a produção PRODUZIU e
    // que vai para a tela — tem `kind`, `mediaUrl`, aprovação e linhagem. Um
    // documento é material que ENTRA, não sai; ninguém aprova um PDF, ninguém
    // deriva um vídeo dele por `derivedFromAssetId`, e ele não é servido pela
    // rota de mídia. Enfiá-lo em `assets` obrigaria a coluna `kind` a crescer
    // e faria toda consulta de mídia passar a filtrar o que não é mídia.
    //
    // ── Por que o texto extraído mora em pedaços ────────────────────────────
    //
    // Porque uma ferramenta devolve o resultado para dentro do contexto de um
    // modelo, e um PDF de 300 páginas não cabe lá. Guardar o texto inteiro numa
    // coluna faria a única leitura possível ser "tudo ou nada", e "tudo"
    // estouraria o turno.
    //
    // Isto NÃO é um índice vetorial e não pretende ser: não há embedding, não
    // há similaridade, não há recuperação por semelhança. É paginação — uma
    // ordem estável em que o agente consegue percorrer o documento inteiro em
    // várias chamadas, e parar antes se a pergunta for localizada.
    //
    // ── O que deliberadamente NÃO está aqui ─────────────────────────────────
    //
    // Nada de caminho de arquivo (quem sabe onde os bytes estão é
    // `documents/storage.js`, e ele deriva o caminho dos ids — um caminho
    // guardado é um caminho que alguém pode ter escrito), nada de sessão de
    // runtime, nada de provider, nada de estado de ingestão (ela é síncrona:
    // ou o documento existe pronto, ou não existe).
    db.exec(`
      CREATE TABLE project_documents (
        id         TEXT PRIMARY KEY,
        projectId  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

        -- O nome que o USUÁRIO deu. É rótulo, e só isso: ele nunca entra num
        -- caminho de arquivo, nunca vira segmento de URL e nunca é validado
        -- como identificador. É por ele que a pessoa reconhece o documento, e
        -- é por ele que o agente o encontra quando o turno não traz anexo.
        filename   TEXT NOT NULL,

        mimeType   TEXT NOT NULL CHECK (mimeType IN (${listaSql(DOCUMENT_TYPE_VALUES)})),
        sizeBytes  INTEGER NOT NULL CHECK (sizeBytes > 0),

        -- A impressão digital dos bytes originais. Não é chave: o mesmo arquivo
        -- enviado duas vezes são dois documentos, porque foram dois gestos do
        -- usuário. Ela existe para conferir integridade e para reconhecer
        -- duplicata quando isso for pedido — não para deduplicar por conta.
        sha256     TEXT NOT NULL,

        -- Nulo quando o formato não tem páginas (TXT). Ver documentTypes.js.
        pageCount  INTEGER CHECK (pageCount IS NULL OR pageCount > 0),

        -- O tamanho do texto extraído. É o que permite dizer "isto tem 40 mil
        -- caracteres" sem ler o documento inteiro para descobrir.
        textLength INTEGER NOT NULL CHECK (textLength > 0),

        createdAt  INTEGER NOT NULL
      ) STRICT;

      CREATE INDEX project_documents_por_projeto
        ON project_documents (projectId, createdAt);

      -- As unidades de leitura, em ordem.
      --
      -- A chave primária composta É a ordem: um documento não pode ter dois
      -- pedaços na mesma posição, e a leitura paginada é um intervalo de
      -- ordinal. Sem ela, "o próximo pedaço" dependeria de um ORDER BY que
      -- alguém poderia esquecer.
      --
      -- ordinal começa em 0 e não tem buraco — é o que faz o cursor da
      -- leitura ser simplesmente o próximo ordinal, sem tradução.
      CREATE TABLE document_chunks (
        documentId TEXT NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
        ordinal    INTEGER NOT NULL CHECK (ordinal >= 0),

        -- A página do PDF de onde este pedaço veio, quando o formato tem
        -- páginas. Uma página grande vira mais de um pedaço, todos com o mesmo
        -- número — a divisão é nossa, a página é do documento.
        pageNumber INTEGER CHECK (pageNumber IS NULL OR pageNumber > 0),

        text       TEXT NOT NULL,
        PRIMARY KEY (documentId, ordinal)
      ) STRICT;

      -- Os documentos anexados a uma fala do usuário.
      --
      -- Mesma forma de agent_message_assets, e pelo mesmo motivo: a mensagem
      -- guarda a REFERÊNCIA, não uma cópia do documento, e a PRIMARY KEY
      -- composta dá a deduplicação de graça — anexar o mesmo documento duas
      -- vezes ao mesmo turno entra uma vez só.
      --
      -- É esta tabela que faz "este PDF" ter resposta. Sem ela, a única
      -- interpretação possível seria "o último documento do projeto", que é
      -- heurística — e erra exatamente quando o usuário tem dois.
      CREATE TABLE agent_message_documents (
        messageId  TEXT NOT NULL REFERENCES agent_messages(id) ON DELETE CASCADE,
        documentId TEXT NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        PRIMARY KEY (messageId, documentId)
      ) STRICT;

      CREATE INDEX agent_message_documents_ordem
        ON agent_message_documents (messageId, seq);
    `);
  },
  // ── 9 ── o planejamento de produção: production_plans ·
  //         production_plan_sources · production_scripts · production_scenes
  (db) => {
    // ── O que estas tabelas SÃO ─────────────────────────────────────────────
    //
    // O plano audiovisual de um Project: o que a produção vai ser, o roteiro
    // dela, e as cenas em que ele se divide. É o resultado do PASSO 12, e a
    // razão de ele existir é que um plano que mora só no chat não é um plano:
    // pedir "mude a cena 4" obrigaria o modelo a reconstruir o filme inteiro de
    // memória, e ele reconstruiria OUTRO filme.
    //
    // O que elas NÃO são: geração. Nenhuma coluna aqui aponta para Asset, job
    // ou workflow. O PASSO 12 termina na cena descrita; produzir a mídia dela é
    // o passo seguinte, e é ele que vai decidir como ligar as duas coisas.
    //
    // ── Por que NÃO evoluímos a tabela `scenes` da migração 1 ───────────────
    //
    // Ela existe, está vazia em produção e ninguém escreve nela: a varredura do
    // repositório encontra `createSceneRecord` apenas nos testes. Ela é o
    // espelho, no servidor, do storyboard que a tela monta em `lib/storyboard.js`
    // e guarda no `localStorage` — `number`, `modelId`, `revisionNote`, `image`,
    // `videoId` — e responde a outra pergunta: qual mídia cada quadro do
    // storyboard já tem.
    //
    // A cena do PASSO 12 responde a uma pergunta diferente: o que esta parte do
    // filme quer dizer, o que se ouve e o que se vê. Encaixá-la em `scenes`
    // exigiria quatro colunas novas, um índice único que aquela tabela nunca
    // teve (ela tolera número repetido de propósito — `renumberScenes` conta com
    // isso) e a troca do vocabulário de status. Seria mudar o significado de uma
    // tabela publicada para caber num conceito novo.
    //
    // Então `scenes` fica **intacta**: nenhum dado antigo é tocado, nenhum
    // comportamento antigo muda, e as duas convivem com nomes que dizem a que
    // vieram. O prefixo `production_` é o que separa as duas famílias.
    //
    // ── Por que um plano por Project, e sem versionamento ───────────────────
    //
    // `UNIQUE(projectId)` em `production_plans` e em `production_scripts` diz a
    // regra inteira: um projeto tem no máximo um plano e um roteiro, e gravar de
    // novo SUBSTITUI. É o que torna "salve o plano" idempotente sem que ninguém
    // precise lembrar de conferir se já havia um.
    //
    // Versões e takes ficam de fora por decisão: um histórico de roteiros só
    // vale a pena quando existe uma forma de escolher entre eles, e não existe.
    //
    // ── Por que a cena não guarda projectId ─────────────────────────────────
    //
    // Porque ela já pertence a um roteiro, e o roteiro pertence a um projeto. A
    // coluna extra seria uma segunda resposta para a mesma pergunta — e duas
    // respostas podem discordar. É o mesmo desenho de `document_chunks`, que
    // também não repete o dono do documento.
    //
    // ── O que deliberadamente NÃO está aqui ─────────────────────────────────
    //
    // Nada de texto de documento copiado (o documento já existe; o que se guarda
    // é a REFERÊNCIA a ele), nada de prompt de modelo (descrição visual não é
    // prompt de ComfyUI, e escrever um agora congelaria o gerador de hoje dentro
    // do plano), nada de Asset, nada de estado de aprovação além das duas
    // palavras que a aplicação já usa, e nada de versão.
    db.exec(`
      CREATE TABLE production_plans (
        id                    TEXT PRIMARY KEY,

        -- UNIQUE: um plano por projeto. Ver o cabeçalho.
        projectId             TEXT NOT NULL UNIQUE
                              REFERENCES projects(id) ON DELETE CASCADE,

        title                 TEXT NOT NULL,

        -- A frase que resume o filme, e o parágrafo que o descreve. Duas
        -- colunas porque são dois usos: a logline cabe numa lista, a sinopse
        -- não.
        logline               TEXT NOT NULL DEFAULT '',
        synopsis              TEXT NOT NULL DEFAULT '',

        -- "mini-documentário", "trailer", "vídeo institucional". Texto livre de
        -- propósito: um vocabulário fechado de formatos audiovisuais teria de
        -- estar certo antes de alguém saber o que o produto aceita, e recusaria
        -- em silêncio o formato que o usuário pediu.
        format                TEXT NOT NULL DEFAULT '',

        -- O alvo que o usuário pediu ("dois minutos" = 120). É contra ELE que a
        -- soma das cenas é conferida.
        targetDurationSeconds INTEGER NOT NULL CHECK (targetDurationSeconds > 0),

        aspectRatio           TEXT NOT NULL DEFAULT '16:9',
        genre                 TEXT NOT NULL DEFAULT '',
        tone                  TEXT NOT NULL DEFAULT '',
        audience              TEXT NOT NULL DEFAULT '',
        language              TEXT NOT NULL DEFAULT '',

        status                TEXT NOT NULL
                              CHECK (status IN (${listaSql(PRODUCTION_STATUS_VALUES)})),

        createdAt             INTEGER NOT NULL,
        updatedAt             INTEGER NOT NULL
      ) STRICT;

      -- De qual material este plano saiu.
      --
      -- Só a REFERÊNCIA. O texto do PDF já está em document_chunks, e copiá-lo
      -- para cá criaria uma segunda cópia que envelhece — e que continuaria
      -- afirmando coisas sobre um documento depois de ele mudar.
      --
      -- É isto que torna o plano rastreável: dá para perguntar "de onde veio
      -- esta proposta?" e ter uma resposta que não é a memória da conversa.
      --
      -- A PRIMARY KEY composta dá a deduplicação de graça, como em
      -- agent_message_documents.
      CREATE TABLE production_plan_sources (
        planId     TEXT NOT NULL REFERENCES production_plans(id) ON DELETE CASCADE,
        documentId TEXT NOT NULL REFERENCES project_documents(id) ON DELETE CASCADE,
        seq        INTEGER NOT NULL,
        PRIMARY KEY (planId, documentId)
      ) STRICT;

      CREATE TABLE production_scripts (
        id        TEXT PRIMARY KEY,

        -- UNIQUE pelo mesmo motivo do plano: um roteiro por projeto, e gravar
        -- de novo substitui.
        projectId TEXT NOT NULL UNIQUE REFERENCES projects(id) ON DELETE CASCADE,

        title     TEXT NOT NULL,
        summary   TEXT NOT NULL DEFAULT '',

        -- O roteiro como texto corrido. Ele é a peça que o humano LÊ, e a
        -- estrutura que a máquina percorre são as cenas — que são linhas de
        -- verdade, não um JSON dentro desta coluna. Guardar a estrutura aqui
        -- faria "mude a cena 4" virar edição de string.
        fullText  TEXT NOT NULL CHECK (length(fullText) > 0),

        status    TEXT NOT NULL
                  CHECK (status IN (${listaSql(PRODUCTION_STATUS_VALUES)})),

        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL
      ) STRICT;

      -- As cenas, em ordem.
      --
      -- "ordinal" começa em 1 porque é o número que uma pessoa fala: "mude a
      -- cena 4". Ele é a posição na produção, e é por ele que uma cena é
      -- endereçada de fora — o "id" não sai do servidor.
      --
      -- UNIQUE(scriptId, ordinal) é a regra "não existem duas cenas na mesma
      -- posição", escrita onde ela vale para qualquer escritor. Sem ela, dois
      -- caminhos de escrita bastariam para a cena 4 virar duas.
      CREATE TABLE production_scenes (
        id                TEXT PRIMARY KEY,
        scriptId          TEXT NOT NULL
                          REFERENCES production_scripts(id) ON DELETE CASCADE,

        ordinal           INTEGER NOT NULL CHECK (ordinal >= 1),

        title             TEXT NOT NULL,

        -- O que esta cena quer comunicar. É o campo que distingue um plano de
        -- uma lista de imagens bonitas.
        purpose           TEXT NOT NULL DEFAULT '',

        -- Inteiro e maior que zero. Uma cena de zero segundo não é uma cena, e
        -- uma duração fracionária não descreve nada que o resto do produto
        -- saiba usar.
        durationSeconds   INTEGER NOT NULL CHECK (durationSeconds > 0),

        -- O que se OUVE e o que se VÊ. Duas colunas porque são dois destinos
        -- diferentes mais adiante: a narração vira voz, a descrição visual vira
        -- imagem. Juntá-las obrigaria alguém a separá-las de novo, adivinhando.
        narration         TEXT NOT NULL DEFAULT '',
        visualDescription TEXT NOT NULL DEFAULT '',

        status            TEXT NOT NULL
                          CHECK (status IN (${listaSql(PRODUCTION_STATUS_VALUES)})),

        createdAt         INTEGER NOT NULL,
        updatedAt         INTEGER NOT NULL,

        UNIQUE (scriptId, ordinal)
      ) STRICT;
    `);
  },
  // ── 10 ── a mídia de uma cena: production_scene_media ·
  //          production_scene_media_selections
  (db) => {
    // ── O que estas tabelas SÃO ─────────────────────────────────────────────
    //
    // A ponte entre a cena DESCRITA (migração 9) e a mídia REAL (migração 1).
    // Uma cena passa a poder ter takes — tentativas — de imagem e de vídeo, e
    // um ponteiro dizendo qual delas está valendo.
    //
    //     Scene 4
    //       ├─ take de imagem 1 → Asset A
    //       ├─ take de imagem 2 → Asset B      ← seleção de imagem
    //       └─ take de vídeo  1 → Asset C      ← seleção de vídeo
    //
    // O que elas NÃO são: nem geração, nem Asset. Nenhuma coluna aqui guarda
    // caminho, nome de arquivo, workflow, prompt, seed ou provider — isso é do
    // Asset e do descriptor, e copiá-lo para cá criaria uma segunda verdade que
    // envelhece. Nenhuma coluna guarda estado de geração — isso é do
    // `generation_jobs`, e um segundo estado divergiria do primeiro no primeiro
    // reinício.
    //
    // ── Por que um take é uma LINHA, e não uma coluna na cena ───────────────
    //
    // Porque regenerar não pode apagar o que veio antes. `production_scenes`
    // com um `imageAssetId` transformaria "gere de novo" numa sobrescrita: a
    // imagem que o usuário talvez preferisse deixaria de existir no instante em
    // que ele pedisse uma alternativa, e não haveria como voltar.
    //
    // É a mesma razão por que a `scenes` da migração 1 — que tem `image` e
    // `videoId` como colunas — não serve aqui: ela guarda UMA mídia por quadro
    // porque foi desenhada para o storyboard da tela, onde a anterior some.
    //
    // ── Por que a seleção é outra tabela ───────────────────────────────────
    //
    // Porque ela é um ponteiro, e um ponteiro tem um ciclo de vida próprio:
    // muda muito mais do que os takes, e mudar não pode tocar em take nenhum.
    // Uma coluna `selected` em `production_scene_media` diria a mesma coisa e
    // permitiria dizê-la duas vezes — dois takes marcados como o escolhido —, e
    // nenhuma restrição de coluna consegue proibir isso. Com `PRIMARY KEY
    // (sceneId, kind)`, "há no máximo uma imagem escolhida por cena" é
    // estrutura, e não uma conferência que alguém pode esquecer de fazer.
    //
    // ── Por que a mídia não guarda projectId ───────────────────────────────
    //
    // Porque ela já pertence a uma cena, a cena a um roteiro, e o roteiro a um
    // projeto. A coluna extra seria uma segunda resposta para a mesma pergunta,
    // e duas respostas podem discordar. Mesmo desenho de `production_scenes` e
    // de `document_chunks`.
    //
    // Que o Asset e o job sejam do MESMO projeto da cena é regra de domínio, e
    // não do esquema: a chave estrangeira garante que eles existem, e é o
    // repositório que confere de quem são — exatamente como `generation_jobs`
    // já faz com `assetDoProjeto`.
    //
    // ── Por que kind reusa ASSET_KINDS ─────────────────────────────────────
    //
    // Palavra nenhuma é nova aqui: um take é de imagem ou de vídeo pelo mesmo
    // vocabulário com que o Asset e o `generation_jobs` dizem isso. Uma segunda
    // lista divergiria da primeira no dia em que um terceiro tipo entrasse.
    db.exec(`
      CREATE TABLE production_scene_media (
        id              TEXT PRIMARY KEY,

        sceneId         TEXT NOT NULL
                        REFERENCES production_scenes(id) ON DELETE CASCADE,

        kind            TEXT NOT NULL CHECK (kind IN (${listaSql(ASSET_KINDS)})),

        -- O número que a pessoa fala: "fico com o take 2". Começa em 1, e é
        -- por cena E por tipo — a primeira imagem e o primeiro vídeo de uma
        -- cena são ambos o take 1. Quem o escolhe é o servidor; ver
        -- \`createSceneTake\`.
        takeNumber      INTEGER NOT NULL CHECK (takeNumber >= 1),

        -- O trabalho que produziu (ou está produzindo) este take. Nulo até
        -- existir, e nulo para sempre num take registrado a partir de mídia que
        -- já estava em disco.
        --
        -- SET NULL, e não CASCADE: o take é o lugar da cena, e não o registro
        -- do trabalho. Perder o job não pode apagar a tentativa nem, através
        -- dela, a seleção do usuário.
        generationJobId TEXT REFERENCES generation_jobs(jobId) ON DELETE SET NULL,

        -- O resultado, quando houver. Nulo enquanto o take não concluiu.
        --
        -- SET NULL pela mesma razão: apagar um Asset é faxina de mídia, e
        -- faxina de mídia não pode demolir o planejamento. O take permanece,
        -- vazio, dizendo a verdade — esta tentativa existiu e o arquivo dela
        -- não está mais aqui.
        assetId         TEXT REFERENCES assets(id) ON DELETE SET NULL,

        createdAt       INTEGER NOT NULL,
        updatedAt       INTEGER NOT NULL,

        -- Não existem dois takes com o mesmo número na mesma cena e no mesmo
        -- tipo. É esta linha que torna a alocação do próximo número segura
        -- mesmo se dois caminhos de escrita a fizerem ao mesmo tempo: um dos
        -- dois esbarra aqui em vez de duplicar o take 3.
        UNIQUE (sceneId, kind, takeNumber)
      ) STRICT;

      -- Um trabalho de geração produz o take de uma cena, e de uma só. Parcial
      -- porque a coluna nasce nula: dois takes ainda sem job não colidem.
      -- Mesmo desenho do índice \`generation_jobs_provider\`.
      CREATE UNIQUE INDEX production_scene_media_job
        ON production_scene_media (generationJobId) WHERE generationJobId IS NOT NULL;

      -- O caminho de volta: "este Asset é take de qual cena?". Não é único de
      -- propósito — a mesma imagem pode servir a duas cenas, e proibir isso
      -- obrigaria a duplicar o arquivo para reaproveitá-lo.
      CREATE INDEX production_scene_media_por_asset
        ON production_scene_media (assetId) WHERE assetId IS NOT NULL;

      -- A chave-pai da seleção. Redundante como índice (o id já é a PRIMARY
      -- KEY), e obrigatória como CONTRATO: o SQLite só aceita uma chave
      -- estrangeira composta apontando para colunas que sejam coletivamente
      -- únicas, e é ela que permite a seleção referenciar identidade, cena e
      -- tipo de uma vez. Ver a tabela abaixo.
      CREATE UNIQUE INDEX production_scene_media_endereco
        ON production_scene_media (id, sceneId, kind);

      -- Qual take está valendo, por cena e por tipo.
      --
      -- ── Por que a chave estrangeira é composta ───────────────────────────
      --
      -- Porque as duas regras que importam não são "o take existe": são "o take
      -- é DESTA cena" e "o take é DESTE tipo". Uma FK simples em \`mediaId\`
      -- garantiria só a primeira metade da primeira, e a cena 4 poderia acabar
      -- com a imagem da cena 7, ou com um vídeo escolhido como imagem, sem que
      -- o banco reclamasse. Repetindo \`sceneId\` e \`kind\` dentro da própria
      -- chave, as duas viram estrutura: uma linha errada não é recusada por
      -- conferência, ela é IMPOSSÍVEL de gravar.
      --
      -- CASCADE: se o take desaparecer, a seleção que apontava para ele
      -- desaparece junto. Um ponteiro para o nada não é um estado que valha a
      -- pena representar.
      CREATE TABLE production_scene_media_selections (
        sceneId   TEXT NOT NULL
                  REFERENCES production_scenes(id) ON DELETE CASCADE,

        kind      TEXT NOT NULL CHECK (kind IN (${listaSql(ASSET_KINDS)})),

        mediaId   TEXT NOT NULL,

        updatedAt INTEGER NOT NULL,

        -- Uma imagem escolhida e um vídeo escolhido por cena. No máximo um de
        -- cada, e independentes entre si.
        PRIMARY KEY (sceneId, kind),

        FOREIGN KEY (mediaId, sceneId, kind)
          REFERENCES production_scene_media (id, sceneId, kind) ON DELETE CASCADE
      ) STRICT;
    `);
  },

  // ── 11 ── a voz da cena: production_scene_audio_takes · _selections
  (db) => {
    // ── O que estas tabelas SÃO ─────────────────────────────────────────────
    //
    // A ponte entre a NARRAÇÃO ESCRITA de uma cena (o texto da migração 9,
    // formalizado no PASSO 14-A) e o áudio que um dia sairá dela. Uma cena
    // passa a poder ter tentativas de voz, e um ponteiro dizendo qual delas
    // está valendo.
    //
    //     Scene 4
    //       narration = "O trem chega vazio."      ← o texto, autoritativo
    //       ├─ take de narração 1 → Asset (futuro)
    //       └─ take de narração 2 → Asset (futuro) ← seleção de narração
    //
    // O que elas NÃO são: nem TTS, nem voz, nem Asset. Nenhuma coluna aqui
    // guarda voz, modelo, provider, idioma, velocidade, tom, ganho, duração,
    // taxa de amostragem, codec, caminho ou nome de arquivo. Metade disso é do
    // Asset, a outra metade é de um provider que ainda não escolhemos, e
    // escrever qualquer uma das duas agora seria decidir o 14-C aqui.
    //
    // ── Por que áudio NÃO entrou em production_scene_media ──────────────────
    //
    // Porque a pergunta que se faz de um take de áudio não é a que se faz de um
    // take visual. De uma imagem se pergunta "qual delas eu escolhi?". De uma
    // narração se pergunta também "ela ainda é do texto que está na cena?" — e
    // essa segunda pergunta só existe porque a narração TEM uma origem escrita
    // e persistida, que o usuário pode editar a qualquer momento.
    //
    // Encaixar isso na tabela visual custaria uma coluna
    // `sourceNarrationFingerprint` que seria NULL para toda imagem e todo vídeo
    // que existe — uma coluna que só faz sentido para um dos valores de `kind`,
    // que é o sintoma clássico de duas tabelas espremidas numa. E o caminho
    // alternativo, generalizar a impressão para "digest da entrada de qualquer
    // take", exigiria decidir hoje o que é a entrada de uma geração de imagem
    // (prompt? seed? modelo? os três?) sem ter esse problema na mão.
    //
    // A pipeline visual e o papel sonoro também não compartilham chave: lá o
    // eixo é `kind` (image/video), aqui é `role` (narration). Forçar os dois no
    // mesmo `CHECK` faria `production_scene_media_selections` aceitar
    // `kind='narration'` e a seleção de áudio aceitar `role='image'`.
    //
    // ── Por que role, e não um único tipo de áudio ─────────────────────────
    //
    // A chave é `(sceneId, role)` mesmo existindo um papel só. Uma chave
    // `(sceneId)` afirmaria que uma cena tem no máximo UM áudio para sempre, e
    // essa é uma afirmação que não temos como fazer: música e efeito são
    // candidatos óbvios a conviver com a narração. Guardar o eixo custa uma
    // coluna e evita uma migração de chave primária.
    db.exec(`
      CREATE TABLE production_scene_audio_takes (
        id              TEXT PRIMARY KEY,

        sceneId         TEXT NOT NULL
                        REFERENCES production_scenes(id) ON DELETE CASCADE,

        -- O papel sonoro. Só \`narration\` hoje; ver AUDIO_ROLES.
        role            TEXT NOT NULL CHECK (role IN (${listaSql(AUDIO_ROLES)})),

        -- O número que a pessoa fala: "fico com a leitura 2". Começa em 1, e é
        -- por cena E por papel. Quem o escolhe é o servidor; ver
        -- \`createNarrationAudioTake\`.
        takeNumber      INTEGER NOT NULL CHECK (takeNumber >= 1),

        -- ── A coluna que dá razão a esta tabela ────────────────────────────
        --
        -- A impressão digital do texto DE QUE ESTE TAKE NASCEU. SHA-256 do
        -- \`production_scenes.narration\` como ele estava no instante em que a
        -- tentativa foi aberta — ver \`narrationFingerprint\` no PASSO 14-A.
        --
        -- É ela que torna possível responder, mais tarde, "esta voz é do texto
        -- que está na tela?" sem guardar uma segunda cópia do parágrafo. E é
        -- por ela ser IMUTÁVEL que a resposta vale: editar a narração muda o
        -- texto da cena e não toca em linha nenhuma daqui, então um take antigo
        -- continua dizendo a verdade sobre a sua própria origem em vez de
        -- passar a alegar uma origem que nunca teve.
        --
        -- NOT NULL porque o único papel que existe hoje SEMPRE nasce de um
        -- texto: sem narração não há o que gravar, e a criação recusa antes de
        -- chegar aqui. Um papel futuro que não tenha origem escrita — música,
        -- por exemplo — vai precisar decidir o que esta coluna significa para
        -- ele, e essa decisão é da migração que o introduzir.
        --
        -- O CHECK é a forma, e não o conteúdo: 64 hexadecimais minúsculos. Ele
        -- não prova que a impressão é a do texto certo (isso é do repositório,
        -- que a calcula), mas impede que qualquer escritor grave aqui um texto
        -- solto, um id, ou a string vazia — que é exatamente o que uma
        -- impressão "de nada" seria.
        sourceNarrationFingerprint TEXT NOT NULL
          CHECK (length(sourceNarrationFingerprint) = 64
                 AND sourceNarrationFingerprint NOT GLOB '*[^0-9a-f]*'),

        -- O trabalho que vai produzir este take. Nulo até existir — e nulo em
        -- todo take do 14-B, que não gera nada. Quem os liga é o 14-C.
        --
        -- SET NULL pelo mesmo critério de \`production_scene_media\`: o take é o
        -- lugar da cena, e não o registro do trabalho. Perder o job não pode
        -- apagar a tentativa nem, através dela, a escolha do usuário.
        generationJobId TEXT REFERENCES generation_jobs(jobId) ON DELETE SET NULL,

        -- O arquivo, quando houver. Nulo enquanto a voz não foi gerada.
        --
        -- SET NULL porque apagar um Asset é faxina de mídia, e faxina de mídia
        -- não pode demolir o planejamento: o take permanece, vazio, dizendo a
        -- verdade — esta tentativa existiu e o arquivo dela não está mais aqui.
        assetId         TEXT REFERENCES assets(id) ON DELETE SET NULL,

        createdAt       INTEGER NOT NULL,
        updatedAt       INTEGER NOT NULL,

        -- Não existem dois takes com o mesmo número na mesma cena e no mesmo
        -- papel. É esta linha que torna a alocação do próximo número segura
        -- mesmo com dois caminhos de escrita ao mesmo tempo: um dos dois
        -- esbarra aqui em vez de duplicar o take 3.
        UNIQUE (sceneId, role, takeNumber)
      ) STRICT;

      -- Um trabalho de geração produz o take de uma cena, e de um só. Parcial
      -- porque a coluna nasce nula: dois takes ainda sem job não colidem.
      CREATE UNIQUE INDEX production_scene_audio_takes_job
        ON production_scene_audio_takes (generationJobId) WHERE generationJobId IS NOT NULL;

      -- O caminho de volta: "este Asset é a voz de qual cena?".
      CREATE INDEX production_scene_audio_takes_por_asset
        ON production_scene_audio_takes (assetId) WHERE assetId IS NOT NULL;

      -- A chave-pai da seleção. Redundante como índice (o id já é a PRIMARY
      -- KEY), e obrigatória como CONTRATO: o SQLite só aceita uma chave
      -- estrangeira composta apontando para colunas coletivamente únicas, e é
      -- ela que deixa a seleção referenciar identidade, cena e papel de uma vez.
      CREATE UNIQUE INDEX production_scene_audio_takes_endereco
        ON production_scene_audio_takes (id, sceneId, role);

      -- Qual take de voz está valendo, por cena e por papel.
      --
      -- ── Por que a chave estrangeira é composta ───────────────────────────
      --
      -- Mesmo desenho de \`production_scene_media_selections\`, e pela mesma
      -- razão: as regras que importam não são "o take existe", são "o take é
      -- DESTA cena" e "o take é DESTE papel". Uma FK simples em \`takeId\`
      -- garantiria só a primeira metade da primeira, e a cena 4 poderia acabar
      -- com a narração da cena 7 sem que o banco reclamasse. Repetindo
      -- \`sceneId\` e \`role\` dentro da própria chave, uma linha errada não é
      -- recusada por conferência: ela é IMPOSSÍVEL de gravar.
      --
      -- Aponta para o TAKE, e não para o Asset. Um ponteiro para o arquivo
      -- perderia justamente a informação de que a escolha é desta tentativa —
      -- e com ela a impressão do texto de que a tentativa nasceu, que é o que
      -- permite dizer "a voz escolhida é de uma versão anterior da narração".
      --
      -- CASCADE: se o take desaparecer, a seleção que apontava para ele
      -- desaparece junto. Um ponteiro para o nada não é um estado que valha a
      -- pena representar.
      CREATE TABLE production_scene_audio_selections (
        sceneId   TEXT NOT NULL
                  REFERENCES production_scenes(id) ON DELETE CASCADE,

        role      TEXT NOT NULL CHECK (role IN (${listaSql(AUDIO_ROLES)})),

        takeId    TEXT NOT NULL,

        updatedAt INTEGER NOT NULL,

        -- Uma voz escolhida por cena e por papel.
        PRIMARY KEY (sceneId, role),

        FOREIGN KEY (takeId, sceneId, role)
          REFERENCES production_scene_audio_takes (id, sceneId, role) ON DELETE CASCADE
      ) STRICT;
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
