// Repositório da trilha da produção — as cues musicais, os takes e as escolhas.
//
// PASSO 14-D2A. É aqui que uma produção ganha o direito de ter MÚSICA, escrita
// antes de existir como arquivo.
//
//     Project
//       ├─ cue 1  "trilha épica e sombria, crescendo lentamente"
//       │    ├─ take 1
//       │    └─ take 2   ← escolha da cue 1
//       └─ cue 2  "tema introspectivo e melancólico"
//            └─ take 1   ← escolha da cue 2
//
// ── Por que a música NÃO pertence a uma cena ───────────────────────────────
//
// Porque uma trilha ATRAVESSA cenas. O tema que entra na chegada do trem e
// segue por mais três não é de nenhuma delas — e pendurá-lo na primeira teria
// duas consequências ruins: obrigaria a eleger uma "cena dona" entre as que a
// peça cobre, e faria a música inteira morrer quando aquela cena fosse
// reescrita.
//
// É a terceira cardinalidade deste passo do produto, e as três são diferentes:
//
//     narração  Scene   → UM slot, o texto daquela cena
//     efeito    Scene   → N cues pontuais, cada uma DENTRO de uma cena
//     música    Project → N peças, que podem cobrir várias cenas
//
// Por isso `AUDIO_ROLES` continua sendo `['narration']` e as tabelas de SFX
// continuam sendo de SFX: enfiar música em qualquer uma delas trocaria a posse
// da peça por conveniência de tabela.
//
// ── Por que Project, e não ProductionPlan ──────────────────────────────────
//
// Porque o plano é um documento sobre INTENÇÃO, e ele é reescrito. Uma trilha
// já produzida não pode depender da vida de uma linha que descreve o que se
// pretendia fazer. `projects` é a raiz durável de todo o resto do esquema.
//
// ── A fronteira deste arquivo ───────────────────────────────────────────────
//
// Só banco. Nada aqui compõe, conhece provider, modelo, prompt ou arquivo. Uma
// cue diz O QUE a peça é; o 14-D2B fará existir.
//
// E nada aqui diz QUANDO ela toca. Não há `startSeconds`, `sceneRange`,
// `offset`, `loop`, `fadeIn`, `gain` nem `ducking` — nem `bpm`, `key`, `genre`
// ou `lyrics`, que são receita técnica que provider nenhum pediu ainda. A
// Timeline do Passo 15 responderá onde e quando a peça soa.

import {
  database, DomainError, inteiroOuNulo, linha, linhas, newId, textoOuNulo,
} from './db.js';
import { createHash } from 'node:crypto';
// O teto é o mesmo das outras famílias, e importado em vez de redigitado: o
// número não descreve uma propriedade do meio, e sim quantas tentativas de uma
// mesma coisa alguém comporta antes de o problema ser outro.
import { MAX_TAKES_POR_CENA } from './sceneMedia.js';

/** Quantas peças musicais uma produção aceita. */
export const MAX_CUES_POR_PRODUCAO = 40;

/** Quantos caracteres a descrição de uma peça aceita. */
export const MAX_MUSIC_DESCRIPTION_CHARS = 4000;

/** Quantos takes uma cue musical aceita. */
export { MAX_TAKES_POR_CENA as MAX_MUSIC_TAKES_POR_CUE };

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A impressão digital da descrição de uma peça musical.
 *
 * SHA-256, em hexadecimal, do texto EXATAMENTE como ele está persistido. Sem
 * normalização, pelo mesmo motivo das outras duas famílias: a forma canônica é
 * a que este módulo grava, e uma segunda canonicalização seria uma segunda
 * opinião — a que discorda da primeira no dia em que alguém mudar uma das duas.
 *
 * Provider-neutral: nada de modelo, seed, duração, Asset ou número de take
 * entra no hash. Ele representa a INTENÇÃO ESCRITA, e nada além.
 */
export function musicCueFingerprint(texto) {
  if (typeof texto !== 'string' || texto === '') return null;
  return createHash('sha256').update(texto, 'utf8').digest('hex');
}

// ── cues ────────────────────────────────────────────────────────────────────

/**
 * Escreve mais uma peça musical na produção.
 *
 * O número é do SERVIDOR: quem chama não sabe quantas peças já existem, e um
 * modelo acha que sabe. É `MAX(cueNumber) + 1` lido e gravado na mesma
 * transação; a corrida que sobra esbarra em `UNIQUE(projectId, cueNumber)`.
 */
export function createProductionMusicCue(projectId, entrada = {}, db = database()) {
  recusarCamposDoServidor(entrada, 'cueNumber');

  const projeto = exigirProjeto(projectId, db);
  const description = descricaoValida(entrada.description);
  const agora = Number(entrada.now) || Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const usadas = Number(db.prepare(
      'SELECT COUNT(*) AS n FROM production_music_cues WHERE projectId = ?',
    ).get(projeto).n);

    if (usadas >= MAX_CUES_POR_PRODUCAO) {
      throw new DomainError(
        `Esta produção já tem ${usadas} peças musicais; o limite é `
        + `${MAX_CUES_POR_PRODUCAO}.`,
        { total: usadas, limite: MAX_CUES_POR_PRODUCAO },
      );
    }

    const maximo = Number(db.prepare(
      'SELECT COALESCE(MAX(cueNumber), 0) AS maximo FROM production_music_cues '
      + 'WHERE projectId = ?',
    ).get(projeto).maximo);

    db.prepare(`
      INSERT INTO production_music_cues
        (id, projectId, cueNumber, description, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(newId('musica'), projeto, maximo + 1, description, agora, agora);

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return listProductionMusicCues(projectId, db).at(-1);
}

/** As peças de uma produção, na ordem em que foram escritas. */
export function listProductionMusicCues(projectId, db = database()) {
  const id = textoOuNulo(projectId);
  if (!id) return [];

  return linhas(db.prepare(
    'SELECT * FROM production_music_cues WHERE projectId = ? ORDER BY cueNumber ASC',
  ).all(id));
}

/** Uma peça, pelo número. `null` quando não existe. */
export function getProductionMusicCue(projectId, cueNumber, db = database()) {
  const id = textoOuNulo(projectId);
  if (!id) return null;

  const numero = inteiroOuNulo(cueNumber);
  if (numero === null || numero < 1) return null;

  return linha(db.prepare(
    'SELECT * FROM production_music_cues WHERE projectId = ? AND cueNumber = ?',
  ).get(id, numero));
}

/**
 * Reescreve a intenção de uma peça.
 *
 * Só a descrição. `id`, `projectId`, `cueNumber` e os carimbos são identidade e
 * histórico — deixá-los editáveis permitiria uma peça trocar de produção ou de
 * posição, e nenhum take saberia que isso aconteceu.
 *
 * O que esta operação NÃO faz: apagar take, reescrever impressão, mexer em
 * seleção, compor. Os takes antigos continuam dizendo a verdade sobre a
 * intenção de que nasceram — e passam a ser reconhecíveis como anteriores.
 */
export function updateProductionMusicCue(projectId, cueNumber, entrada = {}, db = database()) {
  recusarCamposDoServidor(entrada, 'cueNumber');

  const cue = exigirCue(projectId, cueNumber, db);
  const description = descricaoValida(entrada.description);

  db.prepare(
    'UPDATE production_music_cues SET description = ?, updatedAt = ? WHERE id = ?',
  ).run(description, Number(entrada.now) || Date.now(), cue.id);

  return getProductionMusicCue(projectId, cueNumber, db);
}

/**
 * Apaga uma peça da produção.
 *
 * Recusa enquanto há geração em voo, pela mesma razão do PASSO 14-D1A: apagar a
 * cue leva os takes por cascata, e um take em voo tem trabalho real acontecendo
 * do outro lado — apagá-lo deixaria a geração rodando para um lugar que não
 * existe mais. Cancelar é um conceito com consequências próprias, e inventá-lo
 * de passagem seria decidir sem o problema na mão.
 *
 * O que a exclusão NUNCA leva: Asset e `generation_jobs`. São infraestrutura
 * compartilhada, e um deles é o registro de que um trabalho aconteceu — apagar
 * o registro porque o pedido sumiu tornaria falsa uma afirmação sobre o passado.
 */
export function deleteProductionMusicCue(projectId, cueNumber, db = database()) {
  const cue = exigirCue(projectId, cueNumber, db);

  const emVoo = Number(db.prepare(`
    SELECT COUNT(*) AS n
      FROM production_music_takes t
      JOIN generation_jobs j ON j.jobId = t.generationJobId
     WHERE t.cueId = ?
       AND j.state NOT IN ('done', 'failed', 'cancelled', 'orphaned')
  `).get(cue.id).n);

  if (emVoo > 0) {
    throw new DomainError(
      `A peça ${cue.cueNumber} tem uma geração em andamento. `
      + 'Espere ela terminar para poder apagá-la.',
      { cueNumber: cue.cueNumber, emVoo },
    );
  }

  db.prepare('DELETE FROM production_music_cues WHERE id = ?').run(cue.id);
  return true;
}

// ── takes ───────────────────────────────────────────────────────────────────

/**
 * Abre a próxima tentativa de uma peça.
 *
 * O chamador informa QUAL peça, e nada mais. A descrição sai da cue gravada, a
 * impressão sai dessa descrição, e o número sai do banco.
 */
export function createProductionMusicTake(projectId, cueNumber, entrada = {}, db = database()) {
  recusarCamposDoServidor(entrada, 'takeNumber');

  const cue = exigirCue(projectId, cueNumber, db);
  const impressao = musicCueFingerprint(cue.description);
  const agora = Number(entrada.now) || Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const usados = Number(db.prepare(
      'SELECT COUNT(*) AS n FROM production_music_takes WHERE cueId = ?',
    ).get(cue.id).n);

    if (usados >= MAX_TAKES_POR_CENA) {
      throw new DomainError(
        `A peça ${cue.cueNumber} já tem ${usados} takes; o limite é `
        + `${MAX_TAKES_POR_CENA}.`,
        { cueNumber: cue.cueNumber, total: usados, limite: MAX_TAKES_POR_CENA },
      );
    }

    const maximo = Number(db.prepare(
      'SELECT COALESCE(MAX(takeNumber), 0) AS maximo FROM production_music_takes '
      + 'WHERE cueId = ?',
    ).get(cue.id).maximo);

    db.prepare(`
      INSERT INTO production_music_takes
        (id, cueId, takeNumber, sourceCueFingerprint, generationJobId, assetId,
         createdAt, updatedAt)
      VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(newId('mustake'), cue.id, maximo + 1, impressao, agora, agora);

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return listProductionMusicTakes(projectId, cueNumber, db).at(-1);
}

/** As tentativas de uma peça, com o frescor já derivado. */
export function listProductionMusicTakes(projectId, cueNumber, db = database()) {
  const cue = getProductionMusicCue(projectId, cueNumber, db);
  if (!cue) return [];

  const atual = musicCueFingerprint(cue.description);
  return linhas(db.prepare(
    'SELECT * FROM production_music_takes WHERE cueId = ? ORDER BY takeNumber ASC',
  ).all(cue.id)).map((registro) => comFrescor(registro, atual));
}

/** Uma tentativa, pelo número. `null` quando não existe. */
export function getProductionMusicTake(projectId, cueNumber, takeNumber, db = database()) {
  const cue = getProductionMusicCue(projectId, cueNumber, db);
  if (!cue) return null;

  const numero = inteiroOuNulo(takeNumber);
  if (numero === null || numero < 1) return null;

  const registro = linha(db.prepare(
    'SELECT * FROM production_music_takes WHERE cueId = ? AND takeNumber = ?',
  ).get(cue.id, numero));

  return registro ? comFrescor(registro, musicCueFingerprint(cue.description)) : null;
}

// ── seleção ─────────────────────────────────────────────────────────────────

/**
 * Escolhe o take que está valendo, PARA UMA PEÇA.
 *
 * As peças são independentes: escolher o tema de abertura não toca na escolha
 * do tema de encerramento. Não dá para escolher errado por duas razões
 * somadas — o endereço é `projeto + cue + take`, então não há como NOMEAR o
 * take de outra peça; e a chave estrangeira composta `(takeId, cueId)` recusa a
 * linha mesmo que alguém escreva SQL na mão.
 */
export function selectProductionMusicTake(
  projectId, cueNumber, takeNumber, entrada = {}, db = database(),
) {
  const cue = exigirCue(projectId, cueNumber, db);
  const take = exigirTake(projectId, cueNumber, takeNumber, db);

  db.prepare(`
    INSERT INTO production_music_selections (cueId, takeId, updatedAt)
    VALUES (?, ?, ?)
    ON CONFLICT (cueId) DO UPDATE SET takeId = excluded.takeId,
                                      updatedAt = excluded.updatedAt
  `).run(cue.id, take.id, Number(entrada.now) || Date.now());

  return getProductionMusicSelection(projectId, cueNumber, db);
}

/**
 * O take escolhido para uma peça, ou `null`.
 *
 * Devolve o TAKE, com `current` derivado — é o que permite dizer "existe uma
 * música escolhida, PORÉM ela é de uma intenção anterior" sem guardar essa
 * resposta em lugar nenhum.
 */
export function getProductionMusicSelection(projectId, cueNumber, db = database()) {
  const cue = getProductionMusicCue(projectId, cueNumber, db);
  if (!cue) return null;

  const registro = linha(db.prepare(`
    SELECT t.* FROM production_music_selections s
      JOIN production_music_takes t ON t.id = s.takeId
     WHERE s.cueId = ?
  `).get(cue.id));

  return registro ? comFrescor(registro, musicCueFingerprint(cue.description)) : null;
}

// ── proveniência ────────────────────────────────────────────────────────────

/**
 * A tentativa nasceu da intenção que a cue tem AGORA?
 *
 * Derivado, e nunca guardado: `stale` é uma relação entre duas coisas que já
 * estão no banco, e um terceiro valor ao lado delas pode discordar. Bastaria um
 * caminho de edição esquecer de remarcar os takes para ficar persistido um
 * estado que MENTE — dizendo que a trilha está em dia quando a intenção mudou.
 */
export function musicTakeFreshness(projectId, cueNumber, takeNumber, db = database()) {
  const cue = getProductionMusicCue(projectId, cueNumber, db);
  if (!cue) return null;

  const take = getProductionMusicTake(projectId, cueNumber, takeNumber, db);
  if (!take) return null;

  return Object.freeze({
    cueNumber: cue.cueNumber,
    takeNumber: take.takeNumber,
    sourceCueFingerprint: take.sourceCueFingerprint,
    cueFingerprint: musicCueFingerprint(cue.description),
    current: take.current,
    stale: !take.current,
  });
}

/**
 * O resultado de uma geração encontra o take que a pediu.
 *
 * Chamada de dentro de `completeGenerationJob`, na MESMA transação em que o job
 * vira `done`. Devolve `null` quando a geração não é de música nenhuma — que é
 * o caso da imagem, do vídeo, da narração e do efeito.
 *
 * ── A política de seleção, POR PEÇA ─────────────────────────────────────────
 *
 * A mesma das outras famílias, resolvida dentro de UMA cue. O tema de abertura
 * ser escolhido não diz nada sobre o de encerramento.
 *
 *   A. a peça não tem escolha, e o take é da intenção atual
 *      → escolhe. É a primeira música daquela cue.
 *
 *   B. já há escolha, e ela AINDA é da intenção atual
 *      → não mexe. Regerar oferece alternativa; trocar por baixo transformaria
 *        "quero ouvir outra" em "perdi a que eu aprovei".
 *
 *   C. já há escolha, mas a intenção mudou e ela ficou para trás
 *      → escolhe a nova. A antiga toca uma peça que não é mais o que a cue
 *        pede, e o usuário acabou de pedir música para o que ela pede agora.
 *
 *   D. o take terminou depois de a própria intenção mudar
 *      → não escolhe. Nasceu velho.
 */
export function linkCompletedJobToMusicTake(jobId, assetId, db = database()) {
  const doJob = textoOuNulo(jobId);
  if (!doJob) return null;

  const take = linha(db.prepare(
    'SELECT * FROM production_music_takes WHERE generationJobId = ?',
  ).get(doJob));
  if (!take) return null;

  const id = musicIdValido(assetId, 'assetId');
  const asset = linha(db.prepare('SELECT id, projectId, kind FROM assets WHERE id = ?').get(id));
  if (!asset) {
    throw new DomainError(`Asset desconhecido: "${id}".`, { assetId: id });
  }

  // O projeto da peça — aqui a cadeia é curta, porque a música pende do
  // projeto direto. É a vantagem prática do ownership escolhido no 14-D2A.
  const cue = linha(db.prepare(
    'SELECT id, projectId, description FROM production_music_cues WHERE id = ?',
  ).get(take.cueId));

  if (!cue || asset.projectId !== cue.projectId) {
    throw new DomainError(
      `O Asset "${id}" é de outro projeto.`,
      { assetId: id, projetoDoAsset: asset.projectId, projetoDaCue: cue?.projectId ?? null },
    );
  }
  if (asset.kind !== 'audio') {
    throw new DomainError(
      `O Asset "${id}" é de ${asset.kind}, e este take é de música.`,
      { assetId: id, kindDoAsset: asset.kind },
    );
  }
  if (take.assetId !== null && take.assetId !== id) {
    throw new DomainError(
      `O take ${take.takeNumber} desta peça já tem outro áudio.`,
      { takeNumber: take.takeNumber },
    );
  }

  const agora = Date.now();
  if (take.assetId === null) {
    db.prepare(
      'UPDATE production_music_takes SET assetId = ?, updatedAt = ? WHERE id = ?',
    ).run(id, agora, take.id);
  }

  const fingerprintAtual = musicCueFingerprint(
    typeof cue.description === 'string' ? cue.description : '',
  );
  const ehDaIntencaoAtual = fingerprintAtual !== null
    && take.sourceCueFingerprint === fingerprintAtual;

  if (ehDaIntencaoAtual) {
    const escolhido = linha(db.prepare(`
      SELECT t.* FROM production_music_selections s
        JOIN production_music_takes t ON t.id = s.takeId
       WHERE s.cueId = ?
    `).get(take.cueId));

    const escolhidoEhAtual = escolhido !== null
      && escolhido.sourceCueFingerprint === fingerprintAtual;

    if (!escolhidoEhAtual) {
      db.prepare(`
        INSERT INTO production_music_selections (cueId, takeId, updatedAt)
        VALUES (?, ?, ?)
        ON CONFLICT (cueId) DO UPDATE SET takeId = excluded.takeId,
                                          updatedAt = excluded.updatedAt
      `).run(take.cueId, take.id, agora);
    }
  }

  return linha(db.prepare('SELECT * FROM production_music_takes WHERE id = ?').get(take.id));
}

// ── projeção pública ────────────────────────────────────────────────────────

const CAMPOS_PUBLICOS_DA_CUE = Object.freeze([
  'cueNumber', 'description', 'createdAt', 'updatedAt',
]);

const CAMPOS_PUBLICOS_DO_TAKE = Object.freeze([
  'takeNumber', 'sourceCueFingerprint', 'generationJobId', 'assetId',
  'current', 'createdAt', 'updatedAt',
]);

export function publicProductionMusicCue(registro) {
  if (!registro) return null;
  const saida = {};
  for (const campo of CAMPOS_PUBLICOS_DA_CUE) saida[campo] = registro[campo] ?? null;
  return saida;
}

export function publicProductionMusicTake(registro) {
  if (!registro) return null;
  const saida = {};
  for (const campo of CAMPOS_PUBLICOS_DO_TAKE) saida[campo] = registro[campo] ?? null;
  return saida;
}

export function declaredProductionMusicFields() {
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
      'O número é do servidor: ele é a próxima posição, e não um valor '
      + 'escolhido por quem pede.',
      { campo: numero, valor: entrada[numero] },
    );
  }
  for (const campo of ['sourceCueFingerprint', 'id', 'projectId', 'cueId', 'assetId',
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
      'A peça musical precisa de uma descrição — é dela que a música vai nascer.',
      { campo: 'description' },
    );
  }
  if (texto.length > MAX_MUSIC_DESCRIPTION_CHARS) {
    throw new DomainError(
      `A descrição da peça tem ${texto.length} caracteres; o limite é `
      + `${MAX_MUSIC_DESCRIPTION_CHARS}.`,
      { campo: 'description', tamanho: texto.length, limite: MAX_MUSIC_DESCRIPTION_CHARS },
    );
  }
  return texto;
}

function exigirProjeto(projectId, db) {
  const id = textoOuNulo(projectId);
  const projeto = id
    ? linha(db.prepare('SELECT id FROM projects WHERE id = ?').get(id))
    : null;
  if (!projeto) {
    throw new DomainError('Este projeto não existe.', {});
  }
  return projeto.id;
}

function exigirCue(projectId, cueNumber, db) {
  const cue = getProductionMusicCue(projectId, cueNumber, db);
  if (!cue) {
    // "não existe" e "é de outro projeto" são a mesma recusa: distinguir as
    // duas contaria, a quem perguntou, o que existe fora do projeto dele.
    throw new DomainError(
      `Esta produção não tem uma peça musical ${cueNumber}.`,
      { cueNumber },
    );
  }
  return cue;
}

function exigirTake(projectId, cueNumber, takeNumber, db) {
  const take = getProductionMusicTake(projectId, cueNumber, takeNumber, db);
  if (!take) {
    throw new DomainError(
      `A peça musical ${cueNumber} não tem um take ${takeNumber}.`,
      { cueNumber, takeNumber },
    );
  }
  return take;
}

/** Um identificador com a forma que os outros repositórios exigem. */
export function musicIdValido(valor, campo) {
  const texto = String(valor ?? '');
  if (!ID_RE.test(texto)) {
    throw new DomainError(`${campo} inválido: "${valor}".`, { campo, valor });
  }
  return texto;
}
