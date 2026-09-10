// Repositório do desenho de som de uma cena — as cues, os takes e as escolhas.
//
// PASSO 14-D1A. É aqui que uma cena ganha o direito de ter EFEITOS SONOROS,
// escritos antes de existirem como arquivo.
//
//     Scene 4
//       ├─ cue 1  "um trovão forte explode ao longe"
//       │    ├─ take 1
//       │    └─ take 2   ← escolha da cue 1
//       ├─ cue 2  "madeira quebrando lentamente"
//       │    └─ take 1   ← escolha da cue 2
//       └─ cue 3  "passos rápidos sobre pedra"
//
// ── Por que isto não é um papel de `sceneAudio.js` ─────────────────────────
//
// Porque a cardinalidade é outra, e a diferença é o passo inteiro:
//
//     narração   Scene → UM slot  → N takes → UMA escolha
//     efeito     Scene → N CUES   → cada uma com N takes e UMA escolha
//
// Uma cena tem uma narração e pode ter três efeitos ao mesmo tempo. Modelar
// SFX como `role='sfx'` em `production_scene_audio_takes` daria à cena UM
// efeito escolhido — e o trovão, a porta e os passos brigariam por um lugar só.
// Por isso `AUDIO_ROLES` continua sendo `['narration']`: aquela tabela responde
// a outra pergunta, e enfiar efeito nela seria estragar as duas.
//
// ── A fronteira deste arquivo ───────────────────────────────────────────────
//
// Só banco. Nada aqui gera som, conhece provider, modelo, prompt ou arquivo.
// Uma cue diz O QUE deve existir; o 14-D1B fará existir.
//
// E nada aqui diz QUANDO o som toca. Não há `startSeconds`, `offset`, `track`,
// `gain`, `pan` nem `fade` — isso é montagem, e montagem é outro passo. Um
// efeito autoral e a posição dele na linha do tempo são duas decisões, tomadas
// por pessoas diferentes em momentos diferentes.
//
// ── Como uma cue é endereçada de fora ──────────────────────────────────────
//
// Por `projectId` (do ToolContext) + `ordinal` da cena + `cueNumber` + (para o
// take) `takeNumber`. Nunca por `id` — nenhum identificador interno sai do
// servidor, e é isso que torna cross-project impossível por construção.

import {
  database, DomainError, inteiroOuNulo, linha, linhas, newId, textoOuNulo,
} from './db.js';
import { getProductionScene } from './production.js';
import { createHash } from 'node:crypto';
// O teto é o mesmo das outras famílias, e importado em vez de redigitado: o
// número não descreve uma propriedade do meio, e sim quantas tentativas de uma
// mesma coisa alguém comporta antes de o problema ser outro.
import { MAX_TAKES_POR_CENA } from './sceneMedia.js';

/** Quantas cues uma cena aceita. */
export const MAX_CUES_POR_CENA = 40;

/** Quantos caracteres a descrição de um efeito aceita. */
export const MAX_CUE_DESCRIPTION_CHARS = 4000;

/** Quantos takes uma cue aceita. */
export { MAX_TAKES_POR_CENA as MAX_SFX_TAKES_POR_CUE };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A impressão digital da descrição de um efeito.
 *
 * SHA-256, em hexadecimal, do texto EXATAMENTE como ele está persistido. Sem
 * normalização, pelo mesmo motivo de `narrationFingerprint`: a forma canônica
 * de uma descrição é a que este módulo grava, e uma segunda canonicalização
 * seria uma segunda opinião — a que discorda da primeira no dia em que alguém
 * mudar uma das duas.
 *
 * Provider-neutral por construção: nada de modelo, seed, arquivo, Asset ou
 * número de take entra no hash. Ele representa a ORIGEM SEMÂNTICA escrita do
 * efeito, e nada além — se o provider entrasse, "a descrição mudou?" e "o
 * modelo mudou?" viravam a mesma pergunta, e o domínio precisa que sejam duas.
 */
export function sfxCueFingerprint(texto) {
  if (typeof texto !== 'string' || texto === '') return null;
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

// ── cues ────────────────────────────────────────────────────────────────────

/**
 * Escreve mais um efeito na cena.
 *
 * O número é do SERVIDOR, pelo mesmo motivo do `takeNumber` do PASSO 13-A:
 * quem chama não sabe quantas cues já existem, e um modelo acha que sabe. É
 * `MAX(cueNumber) + 1` lido e gravado na mesma transação; a corrida que sobra
 * esbarra em `UNIQUE(sceneId, cueNumber)` e vira erro em vez de duas cues 3.
 */
export function createSceneSfxCue(projectId, ordinal, entrada = {}, db = database()) {
  recusarCamposDoServidor(entrada, 'cueNumber');

  const cena = exigirCena(projectId, ordinal, db);
  const description = descricaoValida(entrada.description);
  const agora = Number(entrada.now) || Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const usadas = Number(db.prepare(
      'SELECT COUNT(*) AS n FROM production_scene_sfx_cues WHERE sceneId = ?',
    ).get(cena.id).n);

    if (usadas >= MAX_CUES_POR_CENA) {
      throw new DomainError(
        `A cena ${cena.ordinal} já tem ${usadas} efeitos; o limite é ${MAX_CUES_POR_CENA}.`,
        { ordinal: cena.ordinal, total: usadas, limite: MAX_CUES_POR_CENA },
      );
    }

    const maximo = Number(db.prepare(
      'SELECT COALESCE(MAX(cueNumber), 0) AS maximo FROM production_scene_sfx_cues '
      + 'WHERE sceneId = ?',
    ).get(cena.id).maximo);

    db.prepare(`
      INSERT INTO production_scene_sfx_cues
        (id, sceneId, cueNumber, description, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(newId('sfx'), cena.id, maximo + 1, description, agora, agora);

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return listSceneSfxCues(projectId, ordinal, db).at(-1);
}

/** Os efeitos de uma cena, na ordem em que foram escritos. */
export function listSceneSfxCues(projectId, ordinal, db = database()) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) return [];

  return linhas(db.prepare(
    'SELECT * FROM production_scene_sfx_cues WHERE sceneId = ? ORDER BY cueNumber ASC',
  ).all(cena.id));
}

/** Um efeito, pelo número. `null` quando não existe. */
export function getSceneSfxCue(projectId, ordinal, cueNumber, db = database()) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) return null;

  const numero = inteiroOuNulo(cueNumber);
  if (numero === null || numero < 1) return null;

  return linha(db.prepare(
    'SELECT * FROM production_scene_sfx_cues WHERE sceneId = ? AND cueNumber = ?',
  ).get(cena.id, numero));
}

/**
 * Reescreve a descrição de um efeito.
 *
 * Só a descrição. `id`, `sceneId`, `cueNumber` e os carimbos de tempo são
 * identidade e histórico — deixá-los editáveis permitiria uma cue trocar de
 * cena ou de posição, e nenhum take saberia que isso aconteceu.
 *
 * O que esta operação NÃO faz: apagar take, reescrever impressão, mexer em
 * seleção, gerar som. Ver `sfxTakeFreshness` — os takes antigos continuam
 * dizendo a verdade sobre a descrição de que nasceram, e passam a ser
 * reconhecíveis como anteriores.
 */
export function updateSceneSfxCue(projectId, ordinal, cueNumber, entrada = {}, db = database()) {
  recusarCamposDoServidor(entrada, 'cueNumber');

  const cue = exigirCue(projectId, ordinal, cueNumber, db);
  const description = descricaoValida(entrada.description);

  db.prepare(
    'UPDATE production_scene_sfx_cues SET description = ?, updatedAt = ? WHERE id = ?',
  ).run(description, Number(entrada.now) || Date.now(), cue.id);

  return getSceneSfxCue(projectId, ordinal, cueNumber, db);
}

/**
 * Apaga um efeito da cena.
 *
 * ── Por que RECUSAR quando há geração em voo ────────────────────────────────
 *
 * Porque apagar a cue leva os takes por cascata, e um take em voo tem um
 * trabalho de verdade acontecendo do outro lado. Apagá-lo deixaria a geração
 * rodando para um lugar que não existe mais, e o resultado chegaria a um take
 * fantasma — exatamente o tipo de órfão que o livro-razão existe para impedir.
 *
 * Cancelar o trabalho seria a outra saída, e não é deste passo: cancelamento é
 * um conceito com consequências próprias (o que fazer com o arquivo a meio, o
 * que o executor faz com a fila) e inventá-lo aqui, de passagem, seria decidir
 * sem o problema na mão. A resposta segura é recusar e dizer por quê.
 *
 * O que a exclusão NUNCA leva: Asset e `generation_jobs`. Os dois são
 * infraestrutura compartilhada, e um deles é o registro de que um trabalho
 * aconteceu — apagar o registro porque o pedido sumiu tornaria falsa uma
 * afirmação sobre o passado.
 */
export function deleteSceneSfxCue(projectId, ordinal, cueNumber, db = database()) {
  const cue = exigirCue(projectId, ordinal, cueNumber, db);

  const emVoo = Number(db.prepare(`
    SELECT COUNT(*) AS n
      FROM production_scene_sfx_takes t
      JOIN generation_jobs j ON j.jobId = t.generationJobId
     WHERE t.cueId = ?
       AND j.state NOT IN ('done', 'failed', 'cancelled', 'orphaned')
  `).get(cue.id).n);

  if (emVoo > 0) {
    throw new DomainError(
      `O efeito ${cue.cueNumber} da cena ${ordinal} tem uma geração em andamento. `
      + 'Espere ela terminar para poder apagá-lo.',
      { ordinal, cueNumber: cue.cueNumber, emVoo },
    );
  }

  db.prepare('DELETE FROM production_scene_sfx_cues WHERE id = ?').run(cue.id);
  return true;
}

// ── takes ───────────────────────────────────────────────────────────────────

/**
 * Abre a próxima tentativa de um efeito.
 *
 * O chamador informa QUAL efeito, e nada mais. A descrição sai da cue gravada,
 * a impressão sai dessa descrição, e o número sai do banco. Nenhum dos três
 * entra pela porta — ver `recusarCamposDoServidor`.
 *
 * Não há caso de descrição vazia a tratar aqui: uma cue sem descrição não pode
 * existir (o `CHECK` da tabela e `descricaoValida` o impedem), então um take
 * sempre nasce de um texto real.
 */
export function createSceneSfxTake(projectId, ordinal, cueNumber, entrada = {}, db = database()) {
  recusarCamposDoServidor(entrada, 'takeNumber');

  const cue = exigirCue(projectId, ordinal, cueNumber, db);
  const impressao = sfxCueFingerprint(cue.description);
  const agora = Number(entrada.now) || Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const usados = Number(db.prepare(
      'SELECT COUNT(*) AS n FROM production_scene_sfx_takes WHERE cueId = ?',
    ).get(cue.id).n);

    if (usados >= MAX_TAKES_POR_CENA) {
      throw new DomainError(
        `O efeito ${cue.cueNumber} já tem ${usados} takes; o limite é `
        + `${MAX_TAKES_POR_CENA}.`,
        { cueNumber: cue.cueNumber, total: usados, limite: MAX_TAKES_POR_CENA },
      );
    }

    const maximo = Number(db.prepare(
      'SELECT COALESCE(MAX(takeNumber), 0) AS maximo FROM production_scene_sfx_takes '
      + 'WHERE cueId = ?',
    ).get(cue.id).maximo);

    db.prepare(`
      INSERT INTO production_scene_sfx_takes
        (id, cueId, takeNumber, sourceCueFingerprint, generationJobId, assetId,
         createdAt, updatedAt)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(newId('sfxtake'), cue.id, maximo + 1, impressao, agora, agora);

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return listSceneSfxTakes(projectId, ordinal, cueNumber, db).at(-1);
}

/** As tentativas de um efeito, com o frescor já derivado. */
export function listSceneSfxTakes(projectId, ordinal, cueNumber, db = database()) {
  const cue = getSceneSfxCue(projectId, ordinal, cueNumber, db);
  if (!cue) return [];

  const atual = sfxCueFingerprint(cue.description);
  return linhas(db.prepare(
    'SELECT * FROM production_scene_sfx_takes WHERE cueId = ? ORDER BY takeNumber ASC',
  ).all(cue.id)).map((registro) => comFrescor(registro, atual));
}

/** Uma tentativa, pelo número. `null` quando não existe. */
export function getSceneSfxTake(projectId, ordinal, cueNumber, takeNumber, db = database()) {
  const cue = getSceneSfxCue(projectId, ordinal, cueNumber, db);
  if (!cue) return null;

  const numero = inteiroOuNulo(takeNumber);
  if (numero === null || numero < 1) return null;

  const registro = linha(db.prepare(
    'SELECT * FROM production_scene_sfx_takes WHERE cueId = ? AND takeNumber = ?',
  ).get(cue.id, numero));

  return registro ? comFrescor(registro, sfxCueFingerprint(cue.description)) : null;
}

// ── seleção ─────────────────────────────────────────────────────────────────

/**
 * Escolhe o take que está valendo, PARA UMA CUE.
 *
 * As cues são independentes: escolher o trovão não toca na escolha dos passos.
 * São linhas distintas, com `PRIMARY KEY (cueId)`, e uma não sabe da outra.
 *
 * Não dá para escolher errado por duas razões somadas: o endereço é
 * `projeto + cena + cue + take`, então não há como NOMEAR o take de outra cue;
 * e a chave estrangeira composta `(takeId, cueId)` recusa a linha mesmo que
 * alguém escreva SQL na mão.
 */
export function selectSceneSfxTake(
  projectId, ordinal, cueNumber, takeNumber, entrada = {}, db = database(),
) {
  const cue = exigirCue(projectId, ordinal, cueNumber, db);
  const take = exigirTake(projectId, ordinal, cueNumber, takeNumber, db);

  db.prepare(`
    INSERT INTO production_scene_sfx_selections (cueId, takeId, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT (cueId) DO UPDATE SET takeId = excluded.takeId,
                                      updatedAt = excluded.updatedAt
  `).run(cue.id, take.id, Number(entrada.now) || Date.now());

  return getSceneSfxSelection(projectId, ordinal, cueNumber, db);
}

/**
 * O take escolhido para uma cue, ou `null`.
 *
 * Devolve o TAKE, com `current` derivado — é o que permite dizer "existe um
 * efeito escolhido, PORÉM ele é de uma descrição anterior" sem guardar essa
 * resposta em lugar nenhum.
 */
export function getSceneSfxSelection(projectId, ordinal, cueNumber, db = database()) {
  const cue = getSceneSfxCue(projectId, ordinal, cueNumber, db);
  if (!cue) return null;

  const registro = linha(db.prepare(`
    SELECT t.* FROM production_scene_sfx_selections s
      JOIN production_scene_sfx_takes t ON t.id = s.takeId
     WHERE s.cueId = ?
  `).get(cue.id));

  return registro ? comFrescor(registro, sfxCueFingerprint(cue.description)) : null;
}

// ── proveniência ────────────────────────────────────────────────────────────

/**
 * A tentativa nasceu da descrição que a cue tem AGORA?
 *
 * Derivado, e nunca guardado, pelo mesmo motivo do PASSO 14-B: `stale` é uma
 * relação entre duas coisas que já estão no banco, e um terceiro valor ao lado
 * delas pode discordar. Bastaria um caminho de edição esquecer de remarcar os
 * takes para ficar persistido um estado que MENTE — dizendo que o som está em
 * dia quando a descrição mudou.
 */
export function sfxTakeFreshness(projectId, ordinal, cueNumber, takeNumber, db = database()) {
  const cue = getSceneSfxCue(projectId, ordinal, cueNumber, db);
  if (!cue) return null;

  const take = getSceneSfxTake(projectId, ordinal, cueNumber, takeNumber, db);
  if (!take) return null;

  return Object.freeze({
    cueNumber: cue.cueNumber,
    takeNumber: take.takeNumber,
    sourceCueFingerprint: take.sourceCueFingerprint,
    cueFingerprint: sfxCueFingerprint(cue.description),
    current: take.current,
    stale: !take.current,
  });
}

/**
 * O resultado de uma geração encontra o take que a pediu.
 *
 * Chamada de dentro de `completeGenerationJob`, na MESMA transação em que o job
 * vira `done` — o trabalho concluir e o take receber o arquivo são o mesmo
 * fato. Devolve `null` quando a geração não é de efeito nenhum, que é o caso da
 * imagem, do vídeo e da narração.
 *
 * ── A política de seleção, POR CUE ──────────────────────────────────────────
 *
 * A mesma do 14-C2, com uma diferença que é o passo inteiro: aqui ela se
 * resolve dentro de UMA cue, e cue nenhuma mexe na escolha de outra. O trovão
 * ser escolhido não diz nada sobre a porta.
 *
 *   A. a cue não tem escolha, e o take é da descrição atual
 *      → escolhe. É o primeiro som daquele efeito.
 *
 *   B. já há escolha, e ela AINDA é da descrição atual
 *      → não mexe. Regerar oferece alternativa; trocar por baixo transformaria
 *        "quero ouvir outra" em "perdi a que eu aprovei".
 *
 *   C. já há escolha, mas a descrição mudou e ela ficou para trás
 *      → escolhe a nova. A antiga toca um efeito que não é mais o que a cue
 *        pede, e o usuário acabou de pedir um som para o que ela pede agora.
 *
 *   D. o take terminou depois de a própria descrição mudar
 *      → não escolhe. Nasceu velho: começou para um texto e terminou noutro.
 */
export function linkCompletedJobToSfxTake(jobId, assetId, db = database()) {
  const doJob = textoOuNulo(jobId);
  if (!doJob) return null;

  const take = linha(db.prepare(
    'SELECT * FROM production_scene_sfx_takes WHERE generationJobId = ?',
  ).get(doJob));
  if (!take) return null;

  const id = sfxIdValido(assetId, 'assetId');
  const asset = linha(db.prepare('SELECT id, projectId, kind FROM assets WHERE id = ?').get(id));
  if (!asset) {
    throw new DomainError(`Asset desconhecido: "${id}".`, { assetId: id });
  }

  // O projeto da cue, subindo a cadeia: cue → cena → roteiro → projeto.
  const dono = linha(db.prepare(`
    SELECT r.projectId AS projectId
      FROM production_scene_sfx_cues q
      JOIN production_scenes c ON c.id = q.sceneId
      JOIN production_scripts r ON r.id = c.scriptId
     WHERE q.id = ?
  `).get(take.cueId));

  if (!dono || asset.projectId !== dono.projectId) {
    throw new DomainError(
      `O Asset "${id}" é de outro projeto.`,
      { assetId: id, projetoDoAsset: asset.projectId, projetoDaCena: dono?.projectId ?? null },
    );
  }
  if (asset.kind !== 'audio') {
    throw new DomainError(
      `O Asset "${id}" é de ${asset.kind}, e este take é de efeito sonoro.`,
      { assetId: id, kindDoAsset: asset.kind },
    );
  }
  if (take.assetId !== null && take.assetId !== id) {
    throw new DomainError(
      `O take ${take.takeNumber} deste efeito já tem outro áudio.`,
      { takeNumber: take.takeNumber },
    );
  }

  const agora = Date.now();
  if (take.assetId === null) {
    db.prepare(
      'UPDATE production_scene_sfx_takes SET assetId = ?, updatedAt = ? WHERE id = ?',
    ).run(id, agora, take.id);
  }

  // A descrição que a CUE tem agora — lida do banco, nunca lembrada.
  const cue = linha(db.prepare(
    'SELECT description FROM production_scene_sfx_cues WHERE id = ?',
  ).get(take.cueId));
  const fingerprintAtual = sfxCueFingerprint(
    typeof cue?.description === 'string' ? cue.description : '',
  );
  const ehDaDescricaoAtual = fingerprintAtual !== null
    && take.sourceCueFingerprint === fingerprintAtual;

  // D: nasceu velho. Fica guardado, e não vira o som da cue.
  if (ehDaDescricaoAtual) {
    const escolhido = linha(db.prepare(`
      SELECT t.* FROM production_scene_sfx_selections s
        JOIN production_scene_sfx_takes t ON t.id = s.takeId
       WHERE s.cueId = ?
    `).get(take.cueId));

    const escolhidoEhAtual = escolhido !== null
      && escolhido.sourceCueFingerprint === fingerprintAtual;

    // A e C tomam este caminho; B é o que o `if` recusa.
    if (!escolhidoEhAtual) {
      db.prepare(`
        INSERT INTO production_scene_sfx_selections (cueId, takeId, updatedAt)
        VALUES (?, ?, ?)
        ON CONFLICT (cueId) DO UPDATE SET takeId = excluded.takeId,
                                          updatedAt = excluded.updatedAt
      `).run(take.cueId, take.id, agora);
    }
  }

  return linha(db.prepare(
    'SELECT * FROM production_scene_sfx_takes WHERE id = ?',
  ).get(take.id));
}

// ── projeção pública ────────────────────────────────────────────────────────

const CAMPOS_PUBLICOS_DA_CUE = Object.freeze([
  'cueNumber', 'description', 'createdAt', 'updatedAt',
]);

const CAMPOS_PUBLICOS_DO_TAKE = Object.freeze([
  'takeNumber', 'sourceCueFingerprint', 'generationJobId', 'assetId',
  'current', 'createdAt', 'updatedAt',
]);

export function publicSceneSfxCue(registro) {
  if (!registro) return null;
  const saida = {};
  for (const campo of CAMPOS_PUBLICOS_DA_CUE) saida[campo] = registro[campo] ?? null;
  return saida;
}

export function publicSceneSfxTake(registro) {
  if (!registro) return null;
  const saida = {};
  for (const campo of CAMPOS_PUBLICOS_DO_TAKE) saida[campo] = registro[campo] ?? null;
  return saida;
}

export function declaredSceneSfxFields() {
  return { cue: [...CAMPOS_PUBLICOS_DA_CUE], take: [...CAMPOS_PUBLICOS_DO_TAKE] };
}

// ── validação interna ───────────────────────────────────────────────────────

function comFrescor(registro, fingerprintAtual) {
  return {
    ...registro,
    current: fingerprintAtual !== null
      && registro.sourceCueFingerprint === fingerprintAtual,
  };
}

/**
 * O que o servidor decide não entra pela porta.
 *
 * Recusar em vez de ignorar: um argumento silenciosamente descartado ensina a
 * quem chama — e sobretudo a um modelo — que mandá-lo funciona.
 */
function recusarCamposDoServidor(entrada, numero) {
  if (entrada[numero] !== undefined) {
    throw new DomainError(
      `O número é do servidor: ele é a próxima posição, e não um valor escolhido `
      + 'por quem pede.',
      { campo: numero, valor: entrada[numero] },
    );
  }
  for (const campo of ['sourceCueFingerprint', 'id', 'sceneId', 'cueId', 'assetId',
    'generationJobId']) {
    if (entrada[campo] !== undefined) {
      throw new DomainError(
        `"${campo}" não é escolhido por quem pede.`,
        { campo, valor: entrada[campo] },
      );
    }
  }
}

function descricaoValida(valor) {
  const texto = textoOuNulo(valor);
  if (texto === null || texto.trim() === '') {
    throw new DomainError(
      'O efeito precisa de uma descrição — é dela que o som vai nascer.',
      { campo: 'description' },
    );
  }
  if (texto.length > MAX_CUE_DESCRIPTION_CHARS) {
    throw new DomainError(
      `A descrição do efeito tem ${texto.length} caracteres; o limite é `
      + `${MAX_CUE_DESCRIPTION_CHARS}.`,
      { campo: 'description', tamanho: texto.length, limite: MAX_CUE_DESCRIPTION_CHARS },
    );
  }
  return texto;
}

function exigirCena(projectId, ordinal, db) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) {
    throw new DomainError(`Este projeto não tem uma cena ${ordinal}.`, { ordinal });
  }
  return cena;
}

function exigirCue(projectId, ordinal, cueNumber, db) {
  const cue = getSceneSfxCue(projectId, ordinal, cueNumber, db);
  if (!cue) {
    // "não existe", "é de outra cena" e "é de outro projeto" são a mesma
    // recusa: distinguir as três contaria, a quem perguntou, o que existe fora
    // do projeto dele.
    throw new DomainError(
      `A cena ${ordinal} não tem um efeito ${cueNumber}.`,
      { ordinal, cueNumber },
    );
  }
  return cue;
}

function exigirTake(projectId, ordinal, cueNumber, takeNumber, db) {
  const take = getSceneSfxTake(projectId, ordinal, cueNumber, takeNumber, db);
  if (!take) {
    throw new DomainError(
      `O efeito ${cueNumber} da cena ${ordinal} não tem um take ${takeNumber}.`,
      { ordinal, cueNumber, takeNumber },
    );
  }
  return take;
}

/** Um identificador com a forma que os outros repositórios exigem. */
export function sfxIdValido(valor, campo) {
  const texto = String(valor ?? '');
  if (!ID_RE.test(texto)) {
    throw new DomainError(`${campo} inválido: "${valor}".`, { campo, valor });
  }
  return texto;
}
