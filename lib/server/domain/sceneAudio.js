// Repositório da voz de uma cena — os takes de narração e a seleção.
//
// PASSO 14-B. É aqui que a narração ESCRITA do PASSO 12, formalizada como
// contrato no PASSO 14-A, ganha o direito de ter tentativas de áudio — sem que
// gerar uma nova apague a anterior, e sem que editar o texto minta sobre as que
// já existem.
//
//     Scene 4
//       narration = "O trem chega vazio."        ← o texto, autoritativo
//       ├─ take de narração 1 → nasceu do texto X
//       └─ take de narração 2 → nasceu do texto Y   ← seleção de narração
//
// ── A fronteira deste arquivo ───────────────────────────────────────────────
//
// Só banco. Nada aqui fala, sintetiza, escolhe voz, conhece provider, modelo,
// idioma ou arquivo. Um take de narração não guarda NADA que já seja do Asset
// (arquivo, URL, duração, codec) e NADA que ainda não foi decidido (voz,
// velocidade, tom). Ele guarda o lugar que a voz ocupa na cena, a origem
// escrita de que ela nasceu, e referências para quem é dono do resto.
//
// Não existe estado de take, pelo mesmo motivo do 13-A: o que se sabe sobre uma
// geração em curso está no `generation_jobs`, e um segundo estado aqui
// divergiria do primeiro no primeiro reinício.
//
// ── O que ESTE passo não faz ────────────────────────────────────────────────
//
// Não cria job, não cria Asset, não liga um ao outro. `generationJobId` e
// `assetId` existem no esquema e nascem — e permanecem — nulos aqui. Não há
// primitiva de `attach` neste arquivo de propósito: `assets.kind` e
// `generation_jobs.kind` ainda não conhecem a palavra `audio` (ver o relatório
// do 14-B), e a única forma de preencher os campos hoje seria pendurar um Asset
// de imagem ou de vídeo num take de voz. Isso satisfaria a coluna e destruiria
// a invariante que ela existe para carregar. Fica para o 14-C, junto com a
// geração que vai precisar dela.
//
// ── Como um take é endereçado de fora ───────────────────────────────────────
//
// Por `projectId` (do ToolContext) + `ordinal` da cena + `takeNumber`. Nunca
// por `id`, nem de cena nem de take — nenhum dos dois sai do servidor.
//
// É o mesmo desenho de `production.js` e de `sceneMedia.js`, e pela mesma
// razão: um endereço composto pelo projeto do CONTEXTO e por posições dentro
// dele torna cross-project impossível por construção, e não por conferência.
// Não há identificador para o modelo carregar de um projeto a outro, porque não
// há identificador nenhum.

import {
  AUDIO_ROLES, database, DomainError, inteiroOuNulo, linha, linhas, newId,
  textoOuNulo,
} from './db.js';
import { narrationFingerprint, sceneNarration } from './narration.js';
import { getProductionScene } from './production.js';
// O teto é o mesmo do take visual, e importado em vez de redigitado: o número
// não descreve uma propriedade do meio (imagem, vídeo, voz), e sim quantas
// tentativas de uma mesma coisa uma cena comporta antes de o problema ser
// outro. Duas constantes com o mesmo propósito divergiriam na primeira vez que
// alguém mexesse numa delas.
import { MAX_TAKES_POR_CENA } from './sceneMedia.js';

/**
 * Os papéis sonoros de um take. Reexportados de `AUDIO_ROLES`, e não
 * redeclarados, pelo mesmo critério com que `sceneMedia.js` reexporta
 * `ASSET_KINDS`: uma segunda lista divergiria da primeira no dia em que um
 * segundo papel entrasse.
 */
export { AUDIO_ROLES as SCENE_AUDIO_ROLES };

/** O único papel que existe hoje. Ver o cabeçalho de `AUDIO_ROLES`. */
export const NARRATION_ROLE = 'narration';

/** Quantos takes de voz uma cena aceita, por papel. */
export { MAX_TAKES_POR_CENA as MAX_AUDIO_TAKES_POR_CENA };

// ── takes ───────────────────────────────────────────────────────────────────

/**
 * Abre a próxima tentativa de voz de uma cena.
 *
 * ── Por que o número é do SERVIDOR ──────────────────────────────────────────
 *
 * Mesma razão do `takeNumber` visual: quem chama não sabe quantas tentativas já
 * existem — e, quando é um modelo que chama, ele acha que sabe. O próximo
 * número é `MAX(takeNumber) + 1` da cena e do papel, lido e gravado dentro da
 * mesma transação. A corrida que sobra — dois caminhos lendo o mesmo máximo —
 * esbarra em `UNIQUE(sceneId, role, takeNumber)` e vira erro, em vez de virar
 * dois takes 3.
 *
 * ── Por que a impressão também é do SERVIDOR ────────────────────────────────
 *
 * E este é o ponto do passo inteiro. `sourceNarrationFingerprint` sai de
 * `sceneNarration(...)`, isto é, do texto que está GRAVADO na cena neste
 * instante — nunca de um argumento. Uma impressão vinda de fora seria o hash do
 * texto que o chamador lembra, e ele erra exatamente no caso que importa:
 * depois de uma edição que ele não viu acontecer. O take passaria a alegar uma
 * origem falsa, e a alegação é justamente o que ele existe para guardar.
 *
 * Por isso `sourceNarrationFingerprint` e `takeNumber` na entrada são RECUSADOS
 * em vez de ignorados: ignorar ensinaria a quem chama que mandá-los funciona.
 *
 * ── Por que narração vazia recusa ───────────────────────────────────────────
 *
 * Uma cena pode legitimamente não ter narração — ela pode ser só imagem, só
 * música ou só silêncio, e isso não é defeito de planejamento. O que não pode
 * existir é uma tentativa de voz sem texto de origem: ela nasceria com a
 * impressão da string vazia, um valor perfeitamente estável e perfeitamente
 * mentiroso, que alegaria proveniência de um texto que nunca existiu. O PASSO
 * 14-A já responde `hasNarration: false` e `fingerprint: null` nesse caso, e a
 * recusa aqui é o outro lado dessa resposta.
 */
export function createNarrationAudioTake(projectId, ordinal, entrada = {}, db = database()) {
  recusarCamposDoServidor(entrada);

  const cena = exigirCena(projectId, ordinal, db);
  const role = roleValido(entrada.role === undefined ? NARRATION_ROLE : entrada.role);

  const narracao = sceneNarration(projectId, ordinal, db);
  if (!narracao.hasNarration) {
    throw new DomainError(
      `A cena ${cena.ordinal} não tem narração escrita para gravar uma voz. `
      + 'Escreva a narração da cena e tente de novo.',
      { ordinal: cena.ordinal, role },
    );
  }

  const agora = Number(entrada.now) || Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    const usados = Number(db.prepare(
      'SELECT COUNT(*) AS n FROM production_scene_audio_takes WHERE sceneId = ? AND role = ?',
    ).get(cena.id, role).n);

    if (usados >= MAX_TAKES_POR_CENA) {
      throw new DomainError(
        `A cena ${cena.ordinal} já tem ${usados} takes de ${role}; o limite é `
        + `${MAX_TAKES_POR_CENA}.`,
        { ordinal: cena.ordinal, role, total: usados, limite: MAX_TAKES_POR_CENA },
      );
    }

    const maximo = Number(db.prepare(
      'SELECT COALESCE(MAX(takeNumber), 0) AS maximo FROM production_scene_audio_takes '
      + 'WHERE sceneId = ? AND role = ?',
    ).get(cena.id, role).maximo);

    db.prepare(`
      INSERT INTO production_scene_audio_takes
        (id, sceneId, role, takeNumber, sourceNarrationFingerprint,
         generationJobId, assetId, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)
    `).run(
      newId('audio'), cena.id, role, maximo + 1, narracao.fingerprint, agora, agora,
    );

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return listNarrationAudioTakes(projectId, ordinal, role, db).at(-1);
}

/**
 * As tentativas de voz de uma cena, em ordem.
 *
 * Lista vazia quando a cena não existe OU é de outro projeto — a mesma
 * indistinção de `getProductionScene`, e pelo mesmo motivo: separar as duas
 * contaria, a quem perguntou, algo sobre um projeto que não é o dele.
 */
export function listNarrationAudioTakes(projectId, ordinal, role = null, db = database()) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) return [];

  const papel = role === null || role === undefined ? null : roleValido(role);
  const registros = papel === null
    ? linhas(db.prepare(
      'SELECT * FROM production_scene_audio_takes WHERE sceneId = ? '
      + 'ORDER BY role ASC, takeNumber ASC',
    ).all(cena.id))
    : linhas(db.prepare(
      'SELECT * FROM production_scene_audio_takes WHERE sceneId = ? AND role = ? '
      + 'ORDER BY takeNumber ASC',
    ).all(cena.id, papel));

  const atual = narracaoAtual(projectId, ordinal, db);
  return registros.map((registro) => comFrescor(registro, atual));
}

/** Uma tentativa, pelo número. `null` quando não existe. */
export function getNarrationAudioTake(projectId, ordinal, entrada = {}, db = database()) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) return null;

  const role = roleValido(entrada.role === undefined ? NARRATION_ROLE : entrada.role);
  const numero = inteiroOuNulo(entrada.takeNumber);
  if (numero === null || numero < 1) return null;

  const registro = linha(db.prepare(
    'SELECT * FROM production_scene_audio_takes WHERE sceneId = ? AND role = ? AND takeNumber = ?',
  ).get(cena.id, role, numero));

  return registro ? comFrescor(registro, narracaoAtual(projectId, ordinal, db)) : null;
}

// ── seleção ─────────────────────────────────────────────────────────────────

/**
 * Escolhe a voz que está valendo, para um papel.
 *
 * ── O que esta operação NÃO faz ─────────────────────────────────────────────
 *
 * Não apaga nada. Escolher a leitura 2 deixa a leitura 1 exatamente onde
 * estava, e escolher outra depois só move o ponteiro. É a diferença entre uma
 * seleção e uma sobrescrita, e é a razão inteira de a seleção ser uma tabela à
 * parte.
 *
 * ── Por que não dá para escolher errado ─────────────────────────────────────
 *
 * O endereço é `projeto + cena + papel + número`: não há como nomear o take de
 * outra cena, porque não há como nomear um take que não seja pela cena de quem
 * pergunta. E, no banco, a chave estrangeira composta `(takeId, sceneId, role)`
 * recusa a linha mesmo que alguém escreva SQL na mão. As duas metades da regra
 * são estrutura.
 *
 * ── O que a seleção NÃO promete ─────────────────────────────────────────────
 *
 * Que a voz escolhida seja do texto atual. Ela promete que ALGUÉM escolheu
 * aquela tentativa, e nada mais — o resto é `current`, que se deriva na
 * leitura. Ver `getNarrationAudioSelection`.
 */
export function selectNarrationAudioTake(projectId, ordinal, entrada = {}, db = database()) {
  const cena = exigirCena(projectId, ordinal, db);
  const take = exigirTake(projectId, ordinal, entrada, db);

  db.prepare(`
    INSERT INTO production_scene_audio_selections (sceneId, role, takeId, updatedAt)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (sceneId, role) DO UPDATE SET takeId = excluded.takeId,
                                              updatedAt = excluded.updatedAt
  `).run(cena.id, take.role, take.id, Number(entrada.now) || Date.now());

  return getNarrationAudioSelection(projectId, ordinal, take.role, db);
}

/**
 * A voz escolhida para um papel, ou `null`.
 *
 * Devolve o TAKE, e não a linha da seleção: quem pergunta "qual é a narração
 * desta cena?" quer a tentativa, e a linha da seleção só tem um ponteiro.
 *
 * O take vem com `current` já derivado, e é isso que permite a resposta que o
 * 14-B existe para tornar possível: "existe uma voz escolhida, PORÉM ela é de
 * uma versão anterior da narração". Um chamador que recebe `current: false` sabe
 * que a escolha continua de pé e que o texto andou — duas informações que uma
 * coluna `stale` guardada no banco não conseguiria manter em dia sem que todo
 * caminho de escrita da narração se lembrasse de atualizá-la.
 */
export function getNarrationAudioSelection(projectId, ordinal, role = NARRATION_ROLE, db = database()) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) return null;

  const registro = linha(db.prepare(`
    SELECT t.* FROM production_scene_audio_selections s
      JOIN production_scene_audio_takes t ON t.id = s.takeId
     WHERE s.sceneId = ? AND s.role = ?
  `).get(cena.id, roleValido(role)));

  return registro ? comFrescor(registro, narracaoAtual(projectId, ordinal, db)) : null;
}

// ── proveniência ────────────────────────────────────────────────────────────

/**
 * A tentativa de voz nasceu do texto que a cena tem AGORA?
 *
 * ── Por que isto é derivado, e não uma coluna ───────────────────────────────
 *
 * Porque `stale` é uma relação entre duas coisas que já estão no banco — a
 * impressão gravada no take e o texto gravado na cena —, e guardar o resultado
 * ao lado das duas origens cria um terceiro valor que pode discordar delas.
 * Seria preciso que TODO caminho que edita a narração se lembrasse de varrer os
 * takes e remarcá-los; esquecer uma vez deixa persistido um estado que MENTE, e
 * mente do jeito pior: dizendo que a voz está em dia.
 *
 * Comparar na leitura custa um SHA-256 sobre no máximo quatro mil caracteres e
 * não pode divergir de nada.
 *
 * ── Por que isto é só de narração ───────────────────────────────────────────
 *
 * Não há `inputDigest` universal aqui, e não é esquecimento. A pergunta "a
 * entrada mudou?" só tem resposta óbvia para a narração porque a entrada dela é
 * um texto que o produto PERSISTE e o usuário EDITA. A entrada de uma geração
 * de imagem é prompt, modelo, seed e parâmetros — e decidir hoje quais deles
 * contam seria responder, sem ter o problema na mão, uma pergunta que o
 * `production_scene_media` nunca fez.
 *
 * @returns {{role: string, takeNumber: number, sourceNarrationFingerprint: string,
 *            narrationFingerprint: string|null, current: boolean, stale: boolean}|null}
 */
export function narrationAudioTakeFreshness(projectId, ordinal, entrada = {}, db = database()) {
  const take = getNarrationAudioTake(projectId, ordinal, entrada, db);
  if (!take) return null;

  return Object.freeze({
    role: take.role,
    takeNumber: take.takeNumber,
    sourceNarrationFingerprint: take.sourceNarrationFingerprint,
    narrationFingerprint: narracaoAtual(projectId, ordinal, db),
    current: take.current,
    stale: !take.current,
  });
}

/**
 * O resultado de uma geração encontra o take que a pediu.
 *
 * Chamada de dentro de `completeGenerationJob`, na MESMA transação em que o
 * job vira `done`: o trabalho ter concluído e o take ter recebido o arquivo são
 * o mesmo fato, e um sem o outro é um estado que ninguém deveria ver.
 *
 * Devolve `null` quando a geração não é de narração nenhuma — que é o caso
 * comum, porque imagem e vídeo passam por `linkCompletedJobToSceneTake`.
 *
 * ── A política de seleção automática ────────────────────────────────────────
 *
 * Quatro casos, e o que separa os dois primeiros dos dois últimos é sempre a
 * mesma pergunta: este áudio é do texto que está na cena AGORA?
 *
 *   A. não há escolha nenhuma, e o take é do texto atual
 *      → escolhe. É a primeira voz da cena; deixar a cena muda depois de o
 *        usuário ter pedido uma narração seria trabalho perdido no caminho.
 *
 *   B. já há uma escolha, e ela AINDA é do texto atual
 *      → não mexe. Regenerar oferece uma alternativa; trocar por baixo
 *        transformaria "quero ouvir outra opção" em "perdi a que eu aprovei".
 *        É a mesma regra do 13-A, e pelo mesmo motivo.
 *
 *   C. já há uma escolha, mas o texto mudou e ela ficou para trás
 *      → escolhe a nova. Aqui a inércia é que seria o defeito: a escolha
 *        antiga fala um texto que não está mais na cena, e o usuário acabou de
 *        pedir uma voz para o texto que está. Manter a antiga seria preferir um
 *        ponteiro histórico a um pedido explícito.
 *
 *   D. o take terminou, mas o texto já tinha mudado antes de ele concluir
 *      → não escolhe. Ele nasceu velho: a síntese começou para um texto e
 *        terminou depois de outro. É um take legítimo, guardado, e não é a voz
 *        da cena.
 *
 * Os casos C e D são o mesmo instante visto dos dois lados, e é por isso que a
 * política mora num lugar só: espalhada por watcher, finalize e reconcile, ela
 * divergiria no primeiro caminho que alguém esquecesse.
 */
export function linkCompletedJobToNarrationAudioTake(jobId, assetId, db = database()) {
  const doJob = textoOuNulo(jobId);
  if (!doJob) return null;

  const take = linha(db.prepare(
    'SELECT * FROM production_scene_audio_takes WHERE generationJobId = ?',
  ).get(doJob));
  if (!take) return null;

  const id = idValido(assetId, 'assetId');
  const asset = linha(db.prepare('SELECT id, projectId, kind FROM assets WHERE id = ?').get(id));
  if (!asset) {
    throw new DomainError(`Asset desconhecido: "${id}".`, { assetId: id });
  }

  // O projeto da cena, subindo a cadeia — não há coluna a consultar. Mesmo
  // desenho de `linkCompletedJobToSceneTake`.
  const dono = linha(db.prepare(`
    SELECT r.projectId AS projectId
      FROM production_scenes c
      JOIN production_scripts r ON r.id = c.scriptId
     WHERE c.id = ?
  `).get(take.sceneId));

  if (!dono || asset.projectId !== dono.projectId) {
    throw new DomainError(
      `O Asset "${id}" é de outro projeto.`,
      { assetId: id, projetoDoAsset: asset.projectId, projetoDaCena: dono?.projectId ?? null },
    );
  }
  if (asset.kind !== 'audio') {
    throw new DomainError(
      `O Asset "${id}" é de ${asset.kind}, e este take é de voz.`,
      { assetId: id, kindDoAsset: asset.kind },
    );
  }
  if (take.assetId !== null && take.assetId !== id) {
    throw new DomainError(
      `O take ${take.takeNumber} de ${take.role} já tem outro áudio.`,
      { role: take.role, takeNumber: take.takeNumber },
    );
  }

  const agora = Date.now();
  if (take.assetId === null) {
    db.prepare(
      'UPDATE production_scene_audio_takes SET assetId = ?, updatedAt = ? WHERE id = ?',
    ).run(id, agora, take.id);
  }

  // ── a seleção ───────────────────────────────────────────────────────────
  //
  // O texto que a CENA tem agora, lido do banco — nunca o que alguém lembra.
  const atual = linha(db.prepare(
    'SELECT narration FROM production_scenes WHERE id = ?',
  ).get(take.sceneId));
  const fingerprintAtual = narrationFingerprint(
    typeof atual?.narration === 'string' ? atual.narration : '',
  );
  const ehDoTextoAtual = fingerprintAtual !== null
    && take.sourceNarrationFingerprint === fingerprintAtual;

  // D: nasceu velho. Fica guardado, e não vira a voz da cena.
  if (ehDoTextoAtual) {
    const escolhido = linha(db.prepare(`
      SELECT t.* FROM production_scene_audio_selections s
        JOIN production_scene_audio_takes t ON t.id = s.takeId
       WHERE s.sceneId = ? AND s.role = ?
    `).get(take.sceneId, take.role));

    const escolhidoEhAtual = escolhido !== null
      && escolhido.sourceNarrationFingerprint === fingerprintAtual;

    // A (não há escolha) e C (a escolha ficou para trás) tomam o mesmo caminho;
    // B é justamente o que este `if` recusa.
    if (!escolhidoEhAtual) {
      db.prepare(`
        INSERT INTO production_scene_audio_selections (sceneId, role, takeId, updatedAt)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (sceneId, role) DO UPDATE SET takeId = excluded.takeId,
                                                  updatedAt = excluded.updatedAt
      `).run(take.sceneId, take.role, take.id, agora);
    }
  }

  return linha(db.prepare(
    'SELECT * FROM production_scene_audio_takes WHERE id = ?',
  ).get(take.id));
}

// ── projeção pública ────────────────────────────────────────────────────────

// O que atravessa a fronteira do servidor. `id` e `sceneId` ficam de fora pelo
// mesmo motivo de `publicSceneTake`: são a chave por dentro, e um identificador
// que sai é um identificador que volta — de outro projeto, eventualmente.
const CAMPOS_PUBLICOS_DO_TAKE = Object.freeze([
  'role', 'takeNumber', 'sourceNarrationFingerprint', 'generationJobId',
  'assetId', 'current', 'createdAt', 'updatedAt',
]);

export function publicNarrationAudioTake(registro) {
  if (!registro) return null;
  const saida = {};
  for (const campo of CAMPOS_PUBLICOS_DO_TAKE) saida[campo] = registro[campo] ?? null;
  return saida;
}

/** Os campos que atravessam para fora — usados nos testes. */
export function declaredNarrationAudioTakeFields() {
  return [...CAMPOS_PUBLICOS_DO_TAKE];
}

// ── validação interna ───────────────────────────────────────────────────────

/**
 * A impressão do texto que a cena tem agora, ou `null` se não há narração.
 *
 * Uma cena sem narração não tem impressão (PASSO 14-A), e por isso nenhum take
 * pode ser `current` nela: `null === <64 hex>` é falso, que é a resposta certa.
 * A tentativa nasceu de um texto que a cena não tem mais.
 */
function narracaoAtual(projectId, ordinal, db) {
  const narracao = sceneNarration(projectId, ordinal, db);
  return narracao ? narracao.fingerprint : null;
}

/** O registro do banco mais o `current` derivado. */
function comFrescor(registro, fingerprintAtual) {
  return {
    ...registro,
    current: fingerprintAtual !== null
      && registro.sourceNarrationFingerprint === fingerprintAtual,
  };
}

/**
 * O que o servidor decide não entra pela porta.
 *
 * Recusar em vez de ignorar é deliberado: um argumento silenciosamente
 * descartado ensina a quem chama — e sobretudo a um modelo — que mandá-lo
 * funciona, e o dia em que alguém depender disso é o dia em que a proveniência
 * vira ficção.
 */
function recusarCamposDoServidor(entrada) {
  if (entrada.takeNumber !== undefined) {
    throw new DomainError(
      'O número do take é do servidor: ele é a próxima tentativa desta cena, e '
      + 'não um número escolhido por quem pede.',
      { campo: 'takeNumber', valor: entrada.takeNumber },
    );
  }
  if (entrada.sourceNarrationFingerprint !== undefined) {
    throw new DomainError(
      'A impressão da narração é do servidor: ela é calculada do texto gravado '
      + 'na cena, e não aceita um valor de fora.',
      { campo: 'sourceNarrationFingerprint' },
    );
  }
}

/** A mesma forma de identificador que os outros repositórios exigem. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function idValido(valor, campo) {
  const texto = String(valor ?? '');
  if (!ID_RE.test(texto)) {
    throw new DomainError(`${campo} inválido: "${valor}".`, { campo, valor });
  }
  return texto;
}

function roleValido(valor) {
  const role = textoOuNulo(valor);
  if (!AUDIO_ROLES.includes(role)) {
    throw new DomainError(
      `Papel de áudio inválido: "${valor}". Uma cena tem takes de `
      + `${AUDIO_ROLES.join(' ou ')}.`,
      { role: valor, aceitos: [...AUDIO_ROLES] },
    );
  }
  return role;
}

function exigirCena(projectId, ordinal, db) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) {
    throw new DomainError(`Este projeto não tem uma cena ${ordinal}.`, { ordinal });
  }
  return cena;
}

function exigirTake(projectId, ordinal, entrada, db) {
  const take = getNarrationAudioTake(projectId, ordinal, entrada, db);
  if (!take) {
    // "não existe", "é de outra cena" e "é de outro projeto" são a mesma
    // recusa, e pelo mesmo motivo das ferramentas de documento: distinguir as
    // três contaria, a quem perguntou, o que existe fora do projeto dele.
    throw new DomainError(
      `A cena ${ordinal} não tem um take ${entrada.takeNumber} de `
      + `${roleValido(entrada.role === undefined ? NARRATION_ROLE : entrada.role)}.`,
      { ordinal, role: entrada.role, takeNumber: entrada.takeNumber },
    );
  }
  return take;
}
