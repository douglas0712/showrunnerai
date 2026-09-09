// Repositório da mídia de uma cena — os takes e a seleção.
//
// PASSO 13-A. É aqui que a cena DESCRITA do PASSO 12 ganha o direito de ter
// imagens e vídeos, sem que gerar um deles apague o anterior.
//
// ── Por que isto precisa existir ────────────────────────────────────────────
//
// Porque o pedido seguinte a "gere a imagem da cena 4" é "gere outra". Se a
// cena guardasse UMA imagem numa coluna, a segunda geração destruiria a
// primeira — e a primeira era, metade das vezes, a boa. Um take é uma LINHA
// justamente para que regenerar seja acrescentar, e nunca sobrescrever.
//
//     Scene 4
//       ├─ take de imagem 1 → Asset A
//       ├─ take de imagem 2 → Asset B      ← seleção de imagem
//       └─ take de vídeo  1 → Asset C      ← seleção de vídeo
//
// ── A fronteira deste arquivo ───────────────────────────────────────────────
//
// Só banco. Nada aqui gera mídia, conhece workflow, ComfyUI, provider ou
// caminho de arquivo. Um take não guarda NADA que já seja do Asset (arquivo,
// URL, prompt, seed, modelo) e NADA que já seja do `generation_jobs` (estado,
// provider, hora de submissão). Ele guarda o lugar que a mídia ocupa na cena, e
// referências para quem é dono do resto.
//
// Não existe estado de take. O que se sabe sobre uma tentativa em curso está no
// `generation_jobs`, e o que se sabe sobre o resultado está no Asset — quem
// precisa da situação de um take lê a linha do job pelo `generationJobId`. Um
// segundo estado aqui divergiria do primeiro no primeiro reinício.
//
// ── Como um take é endereçado de fora ───────────────────────────────────────
//
// Por `projectId` (do ToolContext) + `ordinal` da cena + `kind` + `takeNumber`.
// Nunca por `id`, nem de mídia nem de cena — nenhum dos dois sai do servidor.
//
// É o mesmo desenho de `production.js`, e pela mesma razão: um endereço
// composto pelo projeto do CONTEXTO e por posições dentro dele torna
// cross-project impossível por construção, e não por conferência. Não há
// identificador para o modelo carregar de um projeto a outro, porque não há
// identificador nenhum.
//
// O que ATRAVESSA a fronteira do projeto — `assetId` e `generationJobId` — são
// identificadores que vêm de outras camadas, e esses são conferidos um a um
// contra o projeto da cena. Ver `assetDoProjeto` e `jobDoProjeto`.

import {
  ASSET_KINDS, database, DomainError, inteiroOuNulo, linha, linhas, newId,
  textoOuNulo,
} from './db.js';
import { getProductionScene } from './production.js';

/**
 * Os tipos de take. Reexportados de `ASSET_KINDS`, e não redeclarados: um take
 * é de imagem ou de vídeo pelo mesmo vocabulário com que o Asset e o
 * `generation_jobs` dizem isso.
 */
export { ASSET_KINDS as SCENE_MEDIA_KINDS };

/** Quantos takes uma cena aceita, por tipo. */
export const MAX_TAKES_POR_CENA = 50;

/** A mesma forma de identificador que os outros repositórios exigem. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// ── takes ───────────────────────────────────────────────────────────────────

/**
 * Reserva o próximo take de uma cena.
 *
 * ── Por que o número é do SERVIDOR ──────────────────────────────────────────
 *
 * Porque quem chama não sabe quantos takes já existem — e, quando é um modelo
 * que chama, ele acha que sabe. Um `takeNumber` vindo de fora seria um número
 * chutado pela memória da conversa, e o chute erra exatamente no caso que mais
 * importa: depois de uma geração que o modelo não viu acontecer.
 *
 * O próximo número é `MAX(takeNumber) + 1` da cena e do tipo, lido e gravado
 * dentro da mesma transação. A corrida que sobra — dois caminhos lendo o mesmo
 * máximo — esbarra em `UNIQUE(sceneId, kind, takeNumber)` e vira erro, em vez
 * de virar dois takes 3.
 *
 * `generationJobId` e `assetId` são opcionais porque as duas ordens acontecem:
 * o take pode nascer junto com o trabalho que vai preenchê-lo, ou nascer já
 * apontando para mídia que existe.
 */
export function createSceneTake(projectId, ordinal, entrada = {}, db = database()) {
  const cena = exigirCena(projectId, ordinal, db);
  const kind = kindValido(entrada.kind);

  const jobId = entrada.generationJobId === null || entrada.generationJobId === undefined
    ? null
    : jobDoProjeto(entrada.generationJobId, projectId, kind, db);

  const assetId = entrada.assetId === null || entrada.assetId === undefined
    ? null
    : assetDoProjeto(entrada.assetId, projectId, kind, db);

  const agora = Number(entrada.now) || Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const usados = Number(db.prepare(
      'SELECT COUNT(*) AS n FROM production_scene_media WHERE sceneId = ? AND kind = ?',
    ).get(cena.id, kind).n);

    if (usados >= MAX_TAKES_POR_CENA) {
      throw new DomainError(
        `A cena ${cena.ordinal} já tem ${usados} takes de ${kind}; o limite é `
        + `${MAX_TAKES_POR_CENA}.`,
        { ordinal: cena.ordinal, kind, total: usados, limite: MAX_TAKES_POR_CENA },
      );
    }

    const maximo = Number(db.prepare(
      'SELECT COALESCE(MAX(takeNumber), 0) AS maximo FROM production_scene_media '
      + 'WHERE sceneId = ? AND kind = ?',
    ).get(cena.id, kind).maximo);

    db.prepare(`
      INSERT INTO production_scene_media
        (id, sceneId, kind, takeNumber, generationJobId, assetId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(newId('media'), cena.id, kind, maximo + 1, jobId, assetId, agora, agora);

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return listSceneTakes(projectId, ordinal, kind, db).at(-1);
}

/**
 * Liga o trabalho de geração a um take que já existe.
 *
 * Escrita ÚNICA: um take que trocasse de job passaria a acompanhar outra
 * execução sem ninguém pedir, e a linha continuaria plausível. Mesma regra, e
 * pelo mesmo motivo, de `escritaUnica` no livro-razão. Regravar exatamente o
 * mesmo job é aceito e não faz nada — é o caso do retry de quem chama.
 */
export function attachSceneTakeJob(projectId, ordinal, entrada = {}, db = database()) {
  const take = exigirTake(projectId, ordinal, entrada, db);
  const jobId = jobDoProjeto(entrada.generationJobId, projectId, take.kind, db);

  if (take.generationJobId !== null && take.generationJobId !== jobId) {
    throw new DomainError(
      `O take ${take.takeNumber} de ${take.kind} da cena ${ordinal} já pertence a `
      + 'outra geração.',
      { ordinal, kind: take.kind, takeNumber: take.takeNumber },
    );
  }

  if (take.generationJobId === null) {
    db.prepare(
      'UPDATE production_scene_media SET generationJobId = ?, updatedAt = ? WHERE id = ?',
    ).run(jobId, Number(entrada.now) || Date.now(), take.id);
  }

  return getSceneTake(projectId, ordinal, entrada, db);
}

/**
 * Liga o Asset concluído a um take.
 *
 * Escrita única pela mesma razão: um take que trocasse de Asset moveria a mídia
 * escolhida pelo usuário debaixo dele. O que NÃO acontece aqui é seleção —
 * concluir uma geração não escolhe nada. Quem escolhe é quem chama
 * `selectSceneTake`, e a política de auto-seleção pertence ao passo que ligar a
 * geração de verdade.
 */
export function attachSceneTakeAsset(projectId, ordinal, entrada = {}, db = database()) {
  const take = exigirTake(projectId, ordinal, entrada, db);
  const assetId = assetDoProjeto(entrada.assetId, projectId, take.kind, db);

  if (take.assetId !== null && take.assetId !== assetId) {
    throw new DomainError(
      `O take ${take.takeNumber} de ${take.kind} da cena ${ordinal} já tem outra mídia.`,
      { ordinal, kind: take.kind, takeNumber: take.takeNumber },
    );
  }

  if (take.assetId === null) {
    db.prepare(
      'UPDATE production_scene_media SET assetId = ?, updatedAt = ? WHERE id = ?',
    ).run(assetId, Number(entrada.now) || Date.now(), take.id);
  }

  return getSceneTake(projectId, ordinal, entrada, db);
}

/**
 * Os takes de uma cena, na ordem em que foram feitos.
 *
 * `kind` nulo devolve os dois tipos — imagens primeiro, e cada tipo em ordem de
 * take. Cena inexistente devolve lista vazia, e não erro: perguntar o que uma
 * cena tem é leitura, e leitura de nada é nada.
 */
export function listSceneTakes(projectId, ordinal, kind = null, db = database()) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) return [];

  if (kind === null || kind === undefined) {
    return linhas(db.prepare(
      'SELECT * FROM production_scene_media WHERE sceneId = ? ORDER BY kind ASC, takeNumber ASC',
    ).all(cena.id));
  }

  return linhas(db.prepare(
    'SELECT * FROM production_scene_media WHERE sceneId = ? AND kind = ? ORDER BY takeNumber ASC',
  ).all(cena.id, kindValido(kind)));
}

/** Um take, pelo tipo e pelo número. `null` quando não existe. */
export function getSceneTake(projectId, ordinal, entrada = {}, db = database()) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) return null;

  const kind = kindValido(entrada.kind);
  const numero = inteiroOuNulo(entrada.takeNumber);
  if (numero === null || numero < 1) return null;

  return linha(db.prepare(
    'SELECT * FROM production_scene_media WHERE sceneId = ? AND kind = ? AND takeNumber = ?',
  ).get(cena.id, kind, numero));
}

// ── seleção ─────────────────────────────────────────────────────────────────

/**
 * Escolhe o take que está valendo, para um tipo.
 *
 * ── O que esta operação NÃO faz ─────────────────────────────────────────────
 *
 * Não apaga nada. Escolher a imagem 2 deixa a imagem 1 exatamente onde estava,
 * e escolher outra depois só move o ponteiro. É a diferença entre uma seleção e
 * uma sobrescrita, e é a razão inteira de a seleção ser uma tabela à parte.
 *
 * Escolher imagem não toca na escolha de vídeo: são duas linhas, com chave
 * `(sceneId, kind)`, e uma não sabe da outra.
 *
 * ── Por que não dá para escolher errado ─────────────────────────────────────
 *
 * O endereço é `projeto + cena + tipo + número`: não há como nomear o take de
 * outra cena, porque não há como nomear um take que não seja pela cena de quem
 * pergunta. E, no banco, a chave estrangeira composta
 * `(mediaId, sceneId, kind)` recusa a linha mesmo que alguém escreva SQL na
 * mão. As duas metades da regra são estrutura.
 */
export function selectSceneTake(projectId, ordinal, entrada = {}, db = database()) {
  const cena = exigirCena(projectId, ordinal, db);
  const take = exigirTake(projectId, ordinal, entrada, db);

  db.prepare(`
    INSERT INTO production_scene_media_selections (sceneId, kind, mediaId, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (sceneId, kind) DO UPDATE SET mediaId = excluded.mediaId,
                                              updatedAt = excluded.updatedAt
  `).run(cena.id, take.kind, take.id, Number(entrada.now) || Date.now());

  return getSceneSelection(projectId, ordinal, take.kind, db);
}

/**
 * O take escolhido para um tipo, ou `null`.
 *
 * Devolve o TAKE, e não a linha da seleção: quem pergunta "qual é a imagem
 * desta cena?" quer o take, e a linha da seleção só tem um ponteiro.
 */
export function getSceneSelection(projectId, ordinal, kind, db = database()) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) return null;

  return linha(db.prepare(`
    SELECT m.* FROM production_scene_media_selections s
      JOIN production_scene_media m ON m.id = s.mediaId
     WHERE s.sceneId = ? AND s.kind = ?
  `).get(cena.id, kindValido(kind)));
}

/**
 * As duas escolhas de uma cena, de uma vez.
 *
 * Uma consulta por tipo, porque as duas perguntas quase nunca são feitas
 * separadas — a cena, para quem vai montá-la, é "a imagem e o vídeo".
 */
export function sceneSelections(projectId, ordinal, db = database()) {
  const saida = {};
  for (const kind of ASSET_KINDS) {
    saida[kind] = getSceneSelection(projectId, ordinal, kind, db);
  }
  return saida;
}

// ── a forma pública ─────────────────────────────────────────────────────────
//
// Lista fechada, pelo mesmo critério de `publicProductionScene`: uma coluna
// nova na tabela não deve aparecer numa resposta por acidente. O que fica de
// fora é `id` e `sceneId` — identidade nossa, que ninguém de fora endereça.
//
// `assetId` SAI, e é o único identificador que sai: é por ele que a camada de
// mídia serve o arquivo, e é ele que o PASSO 13-C vai usar como `sourceAssetId`
// de uma imagem que vira vídeo. `generationJobId` sai pela mesma razão — é por
// ele que se lê a situação da geração, no lugar em que ela mora.

const CAMPOS_PUBLICOS_DO_TAKE = Object.freeze([
  'kind', 'takeNumber', 'generationJobId', 'assetId', 'createdAt', 'updatedAt',
]);

export function publicSceneTake(registro) {
  if (!registro) return null;
  const saida = {};
  for (const campo of CAMPOS_PUBLICOS_DO_TAKE) saida[campo] = registro[campo] ?? null;
  return saida;
}

/** Os campos que atravessam para fora — usados nos testes. */
export function declaredSceneTakeFields() {
  return [...CAMPOS_PUBLICOS_DO_TAKE];
}

// ── validação interna ───────────────────────────────────────────────────────

function kindValido(valor) {
  const kind = textoOuNulo(valor);
  if (!ASSET_KINDS.includes(kind)) {
    throw new DomainError(
      `Tipo de mídia inválido: "${valor}". Uma cena tem takes de ${ASSET_KINDS.join(' ou ')}.`,
      { kind: valor, aceitos: [...ASSET_KINDS] },
    );
  }
  return kind;
}

function exigirCena(projectId, ordinal, db) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) {
    throw new DomainError(`Este projeto não tem uma cena ${ordinal}.`, { ordinal });
  }
  return cena;
}

function exigirTake(projectId, ordinal, entrada, db) {
  const take = getSceneTake(projectId, ordinal, entrada, db);
  if (!take) {
    // "não existe" e "é de outra cena" são a mesma recusa, e pelo mesmo motivo
    // das ferramentas de documento: distinguir as duas contaria, a quem
    // perguntou, o que existe fora do projeto dele.
    throw new DomainError(
      `A cena ${ordinal} não tem um take ${entrada.takeNumber} de `
      + `${kindValido(entrada.kind)}.`,
      { ordinal, kind: entrada.kind, takeNumber: entrada.takeNumber },
    );
  }
  return take;
}

/**
 * Um Asset que existe, é deste projeto e é do tipo do take.
 *
 * A chave estrangeira garante o primeiro; os outros dois são regra de domínio.
 * O tipo importa tanto quanto o projeto: um vídeo ligado ao take de imagem de
 * uma cena seria uma linha coerente para o banco e mentirosa para o produto.
 */
function assetDoProjeto(assetId, projectId, kind, db) {
  const id = idValido(assetId, 'assetId');
  const asset = linha(db.prepare('SELECT id, projectId, kind FROM assets WHERE id = ?').get(id));

  if (!asset) {
    throw new DomainError(`Asset desconhecido: "${id}".`, { assetId: id });
  }
  if (asset.projectId !== projectId) {
    throw new DomainError(
      `O Asset "${id}" é de outro projeto.`,
      { assetId: id, projetoDoAsset: asset.projectId, projetoDaCena: projectId },
    );
  }
  if (asset.kind !== kind) {
    throw new DomainError(
      `O Asset "${id}" é de ${asset.kind}, e este take é de ${kind}.`,
      { assetId: id, kindDoAsset: asset.kind, kindDoTake: kind },
    );
  }
  return id;
}

/** Um job que existe, é deste projeto e produz o tipo do take. */
function jobDoProjeto(generationJobId, projectId, kind, db) {
  const id = idValido(generationJobId, 'generationJobId');
  const job = linha(db.prepare(
    'SELECT jobId, projectId, kind FROM generation_jobs WHERE jobId = ?',
  ).get(id));

  if (!job) {
    throw new DomainError(`Geração desconhecida: "${id}".`, { generationJobId: id });
  }
  if (job.projectId !== projectId) {
    throw new DomainError(
      `A geração "${id}" é de outro projeto.`,
      { generationJobId: id, projetoDoJob: job.projectId, projetoDaCena: projectId },
    );
  }
  if (job.kind !== kind) {
    throw new DomainError(
      `A geração "${id}" produz ${job.kind}, e este take é de ${kind}.`,
      { generationJobId: id, kindDoJob: job.kind, kindDoTake: kind },
    );
  }
  return id;
}

function idValido(valor, campo) {
  const texto = String(valor ?? '');
  if (!ID_RE.test(texto)) {
    throw new DomainError(`${campo} inválido: "${valor}".`, { campo, valor });
  }
  return texto;
}
