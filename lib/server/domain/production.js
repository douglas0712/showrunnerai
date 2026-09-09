// Repositório do planejamento de produção — plano, roteiro e cenas.
//
// PASSO 12. É aqui que "transforme este PDF num mini-documentário de dois
// minutos" deixa de ser uma resposta bonita no chat e vira estado do Project.
//
// ── Por que isto precisa existir ────────────────────────────────────────────
//
// Porque o pedido seguinte é "mude a cena 4". Sem cenas persistidas, a única
// forma de atender seria o modelo reconstruir o filme inteiro pela memória da
// conversa — e ele reconstruiria OUTRO filme, parecido o bastante para ninguém
// notar na hora e diferente o bastante para estragar a produção. O estado do
// Project é a autoridade; a conversa é o volante.
//
// ── A cadeia, e por que ela é uma cadeia ────────────────────────────────────
//
//     Project
//       └─ ProductionPlan     o que a produção VAI SER          (1 por Project)
//            └─ sources       de qual material ela saiu         (referências)
//       └─ ProductionScript   o roteiro                          (1 por Project)
//            └─ Scenes        as cenas, em ordem
//
// A ordem é obrigatória, e ela é a regra: não há roteiro sem plano, e não há
// cena sem roteiro. Não é burocracia — é o que impede um conjunto de cenas de
// existir sem nada contra o que conferir a duração, e um roteiro de existir sem
// que ninguém tenha decidido que filme ele é.
//
// ── A fronteira deste arquivo ───────────────────────────────────────────────
//
// Só banco. Nada aqui gera mídia, conhece workflow, Asset, job ou ComfyUI. O
// PASSO 12 termina na cena DESCRITA; produzir a imagem dela é o passo seguinte.
//
// ── Como uma cena é endereçada de fora ──────────────────────────────────────
//
// Por `projectId` (do ToolContext) + `ordinal`. Nunca por `id`.
//
// O `ordinal` é o número que a pessoa fala — "a cena 4" —, e ele é sempre
// relativo ao projeto de quem pergunta. Isso não é conveniência: um endereço
// composto pelo projeto do CONTEXTO e por uma posição dentro dele torna
// cross-project impossível por construção, e não por conferência. Não há
// identificador para o modelo carregar de um projeto a outro, porque não há
// identificador nenhum — o `id` da cena não sai do servidor.

import {
  database, DomainError, inteiroOuNulo, linha, linhas, newId,
  PRODUCTION_STATUS, PRODUCTION_STATUS_VALUES, textoOuNulo,
} from './db.js';
import { getProjectDocumentIn } from './documents.js';
import { getProject } from './projects.js';

export { PRODUCTION_STATUS, PRODUCTION_STATUS_VALUES };

// ── limites ─────────────────────────────────────────────────────────────────
//
// Todos existem pela mesma razão: o que sai daqui entra no contexto de um
// modelo, e um contexto tem fim. Um plano sem teto é um plano que, um dia,
// ocupa o turno inteiro só para ser lido.

/** Quantas cenas um roteiro pode ter. */
export const MAX_SCENES = 40;

/** Duração alvo máxima de uma produção: duas horas. */
export const MAX_TARGET_DURATION_SECONDS = 7200;

/** Duração máxima de uma cena. */
export const MAX_SCENE_DURATION_SECONDS = 600;

/** Teto do roteiro em caracteres. */
export const MAX_SCRIPT_CHARS = 40000;

/**
 * Quanto a soma das cenas pode divergir da duração alvo.
 *
 * Existe porque "dois minutos" é um pedido, não uma medida: um documentário de
 * 118 ou 123 segundos é o que o usuário pediu. O que a tolerância impede é o
 * outro caso — o plano de "dois minutos" cujas cenas somam quarenta segundos,
 * que não é uma aproximação, é outro filme.
 *
 * Cinco segundos, e não uma porcentagem, porque a conta precisa ser óbvia para
 * quem escreve o plano: com cenas em segundos inteiros, acertar 120 ± 5 é
 * aritmética, não otimização.
 */
export const DURATION_TOLERANCE_SECONDS = 5;

/** Tetos de texto, por campo. Rótulo curto, descrição longa. */
const TETOS = Object.freeze({
  title: 200,
  logline: 500,
  synopsis: 4000,
  format: 100,
  aspectRatio: 20,
  genre: 100,
  tone: 200,
  audience: 200,
  language: 40,
  summary: 4000,
  purpose: 500,
  narration: 4000,
  visualDescription: 4000,
});

// ── plano ───────────────────────────────────────────────────────────────────

/**
 * Os campos do plano que quem chama pode escrever.
 *
 * `id`, `projectId`, `status`, `createdAt` e `updatedAt` NÃO estão aqui, e é a
 * lista que os mantém fora: eles são do servidor. Um plano cujo projeto viesse
 * de fora seria um plano que qualquer chamador poderia mudar de dono.
 */
const CAMPOS_DO_PLANO = Object.freeze([
  'title', 'logline', 'synopsis', 'format', 'targetDurationSeconds',
  'aspectRatio', 'genre', 'tone', 'audience', 'language',
]);

export function planFields() {
  return [...CAMPOS_DO_PLANO];
}

/**
 * Grava o plano de produção de um projeto.
 *
 * SUBSTITUI o que houver: um projeto tem no máximo um plano, e o banco garante
 * isso com `UNIQUE(projectId)`. Chamar de novo com os mesmos campos deixa o
 * mesmo plano, com o mesmo `id` — a operação é idempotente no que importa, e o
 * `id` não é reemitido porque o plano não é outro.
 *
 * `sourceDocumentIds` é a rastreabilidade: de qual material esta proposta saiu.
 * Cada um é conferido contra o PROJETO — um documento de outro projeto não
 * entra, e a recusa é explícita.
 */
export function saveProductionPlan(entrada = {}, db = database()) {
  const projectId = textoOuNulo(entrada.projectId);
  if (!projectId) {
    throw new DomainError('Um plano de produção precisa de um projeto.', {});
  }
  if (!getProject(projectId, db)) {
    throw new DomainError(`Projeto desconhecido: "${projectId}".`, { projectId });
  }

  const title = textoObrigatorio(entrada.title, 'title');
  const alvo = duracaoAlvoValida(entrada.targetDurationSeconds);

  const campos = {
    title,
    logline: textoOpcional(entrada.logline, 'logline'),
    synopsis: textoOpcional(entrada.synopsis, 'synopsis'),
    format: textoOpcional(entrada.format, 'format'),
    targetDurationSeconds: alvo,
    aspectRatio: textoOpcional(entrada.aspectRatio, 'aspectRatio') || '16:9',
    genre: textoOpcional(entrada.genre, 'genre'),
    tone: textoOpcional(entrada.tone, 'tone'),
    audience: textoOpcional(entrada.audience, 'audience'),
    language: textoOpcional(entrada.language, 'language'),
  };

  const fontes = fontesValidas(projectId, entrada.sourceDocumentIds, db);

  const existente = getProductionPlan(projectId, db);
  const agora = Number(entrada.now) || Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    let id;
    if (existente) {
      id = existente.id;
      db.prepare(`
        UPDATE production_plans SET
          title = ?, logline = ?, synopsis = ?, format = ?,
          targetDurationSeconds = ?, aspectRatio = ?, genre = ?, tone = ?,
          audience = ?, language = ?, updatedAt = ?
        WHERE id = ?
      `).run(
        campos.title, campos.logline, campos.synopsis, campos.format,
        campos.targetDurationSeconds, campos.aspectRatio, campos.genre,
        campos.tone, campos.audience, campos.language, agora, id,
      );
    } else {
      id = newId('plan');
      db.prepare(`
        INSERT INTO production_plans (
          id, projectId, title, logline, synopsis, format,
          targetDurationSeconds, aspectRatio, genre, tone, audience, language,
          status, createdAt, updatedAt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, projectId, campos.title, campos.logline, campos.synopsis,
        campos.format, campos.targetDurationSeconds, campos.aspectRatio,
        campos.genre, campos.tone, campos.audience, campos.language,
        PRODUCTION_STATUS.DRAFT, agora, agora,
      );
    }

    // As fontes são substituídas junto com o plano: elas descrevem de onde ESTA
    // versão saiu, e manter as antigas afirmaria uma origem que deixou de valer.
    db.prepare('DELETE FROM production_plan_sources WHERE planId = ?').run(id);
    const inserirFonte = db.prepare(
      'INSERT INTO production_plan_sources (planId, documentId, seq) VALUES (?, ?, ?)',
    );
    for (let i = 0; i < fontes.length; i += 1) inserirFonte.run(id, fontes[i], i);

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return getProductionPlan(projectId, db);
}

/** O plano do projeto, ou `null`. */
export function getProductionPlan(projectId, db = database()) {
  const alvo = textoOuNulo(projectId);
  if (!alvo) return null;
  return linha(db.prepare('SELECT * FROM production_plans WHERE projectId = ?').get(alvo));
}

/** Os documentos de onde o plano saiu, na ordem em que foram declarados. */
export function listPlanSources(projectId, db = database()) {
  const plano = getProductionPlan(projectId, db);
  if (!plano) return [];
  return linhas(db.prepare(`
    SELECT s.documentId AS documentId, d.filename AS filename
      FROM production_plan_sources s
      JOIN project_documents d ON d.id = s.documentId
     WHERE s.planId = ?
     ORDER BY s.seq ASC
  `).all(plano.id));
}

// ── roteiro ─────────────────────────────────────────────────────────────────

const CAMPOS_DO_ROTEIRO = Object.freeze(['title', 'summary', 'fullText']);

export function scriptFields() {
  return [...CAMPOS_DO_ROTEIRO];
}

/**
 * Grava o roteiro de um projeto. Substitui o que houver.
 *
 * Exige o plano. Um roteiro sem plano é um roteiro sem duração alvo, sem
 * formato e sem tom — e é contra esses que as cenas dele vão ser conferidas.
 *
 * As CENAS sobrevivem a uma reescrita do roteiro, de propósito: o `id` do
 * roteiro não muda, então nada cascateia. Reescrever o texto e perder as cenas
 * seria transformar uma correção de uma frase numa demolição.
 */
export function saveProductionScript(entrada = {}, db = database()) {
  const projectId = textoOuNulo(entrada.projectId);
  if (!projectId) {
    throw new DomainError('Um roteiro precisa de um projeto.', {});
  }
  if (!getProject(projectId, db)) {
    throw new DomainError(`Projeto desconhecido: "${projectId}".`, { projectId });
  }
  if (!getProductionPlan(projectId, db)) {
    throw new DomainError(
      'Este projeto ainda não tem um plano de produção; grave o plano antes do roteiro.',
      { projectId },
    );
  }

  const title = textoObrigatorio(entrada.title, 'title');
  const summary = textoOpcional(entrada.summary, 'summary');

  const fullText = String(entrada.fullText ?? '').trim();
  if (!fullText) {
    throw new DomainError('O roteiro não pode estar vazio.', {});
  }
  if (fullText.length > MAX_SCRIPT_CHARS) {
    throw new DomainError(
      `O roteiro excede ${MAX_SCRIPT_CHARS} caracteres.`,
      { caracteres: fullText.length, limite: MAX_SCRIPT_CHARS },
    );
  }

  const existente = getProductionScript(projectId, db);
  const agora = Number(entrada.now) || Date.now();

  if (existente) {
    db.prepare(`
      UPDATE production_scripts SET title = ?, summary = ?, fullText = ?, updatedAt = ?
       WHERE id = ?
    `).run(title, summary, fullText, agora, existente.id);
  } else {
    db.prepare(`
      INSERT INTO production_scripts
        (id, projectId, title, summary, fullText, status, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId('script'), projectId, title, summary, fullText,
      PRODUCTION_STATUS.DRAFT, agora, agora,
    );
  }

  return getProductionScript(projectId, db);
}

/** O roteiro do projeto, ou `null`. */
export function getProductionScript(projectId, db = database()) {
  const alvo = textoOuNulo(projectId);
  if (!alvo) return null;
  return linha(db.prepare('SELECT * FROM production_scripts WHERE projectId = ?').get(alvo));
}

// ── cenas ───────────────────────────────────────────────────────────────────

const CAMPOS_DA_CENA = Object.freeze([
  'ordinal', 'title', 'purpose', 'durationSeconds', 'narration', 'visualDescription',
]);

/** Os campos que `updateProductionScene` aceita. `ordinal` não se edita por aqui. */
const CAMPOS_EDITAVEIS_DA_CENA = Object.freeze([
  'title', 'purpose', 'durationSeconds', 'narration', 'visualDescription',
]);

export function sceneFields() {
  return [...CAMPOS_DA_CENA];
}

export function editableSceneFields() {
  return [...CAMPOS_EDITAVEIS_DA_CENA];
}

/**
 * Substitui TODAS as cenas do roteiro, de uma vez.
 *
 * ── Por que substituir, e não inserir uma a uma ─────────────────────────────
 *
 * Porque a criação inicial produz o conjunto INTEIRO, e um conjunto tem
 * propriedades que uma cena sozinha não tem: os ordinais formam 1..n, e a soma
 * das durações bate com o alvo. Dez inserções separadas passariam por nove
 * estados intermediários em que nenhuma das duas coisas é verdade — e um erro
 * na sétima deixaria seis cenas de um filme que não existe.
 *
 * ── O que é conferido ANTES de qualquer escrita ─────────────────────────────
 *
 * Tudo. Os ordinais são exatamente 1..n (sem repetido, sem buraco), toda
 * duração é inteira e positiva, os textos cabem nos tetos, e a soma está dentro
 * da tolerância. Só então a transação começa. Uma validação feita no meio da
 * escrita transformaria "este plano está errado" em "metade deste plano está
 * gravada".
 */
export function replaceProductionScenes(projectId, cenas = [], db = database()) {
  const { plano, roteiro } = exigirRoteiro(projectId, db);

  if (!Array.isArray(cenas)) {
    throw new DomainError('As cenas precisam vir numa lista.', {});
  }
  if (cenas.length === 0) {
    throw new DomainError('Um roteiro precisa de pelo menos uma cena.', {});
  }
  if (cenas.length > MAX_SCENES) {
    throw new DomainError(
      `Um roteiro aceita no máximo ${MAX_SCENES} cenas; vieram ${cenas.length}.`,
      { total: cenas.length, limite: MAX_SCENES },
    );
  }

  const normalizadas = cenas.map((cena, indice) => cenaValida(cena, indice));

  // Os ordinais são exatamente 1..n. "Sem repetido" e "sem buraco" são a mesma
  // conferência: um conjunto de n posições distintas entre 1 e n é 1..n.
  const vistos = new Set();
  for (const cena of normalizadas) {
    if (cena.ordinal > normalizadas.length) {
      throw new DomainError(
        `A cena ${cena.ordinal} está fora da sequência: um roteiro de ${normalizadas.length} `
        + `cenas usa os números de 1 a ${normalizadas.length}.`,
        { ordinal: cena.ordinal, total: normalizadas.length },
      );
    }
    if (vistos.has(cena.ordinal)) {
      throw new DomainError(
        `Duas cenas com o número ${cena.ordinal}. Cada cena ocupa uma posição só.`,
        { ordinal: cena.ordinal },
      );
    }
    vistos.add(cena.ordinal);
  }

  const soma = normalizadas.reduce((total, cena) => total + cena.durationSeconds, 0);
  const desvio = soma - plano.targetDurationSeconds;
  if (Math.abs(desvio) > DURATION_TOLERANCE_SECONDS) {
    throw new DomainError(
      `As cenas somam ${soma}s e a produção foi planejada para `
      + `${plano.targetDurationSeconds}s. A diferença aceita é de até `
      + `${DURATION_TOLERANCE_SECONDS}s — ajuste as durações e grave de novo.`,
      {
        soma,
        alvo: plano.targetDurationSeconds,
        tolerancia: DURATION_TOLERANCE_SECONDS,
      },
    );
  }

  normalizadas.sort((a, b) => a.ordinal - b.ordinal);
  const agora = Date.now();

  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM production_scenes WHERE scriptId = ?').run(roteiro.id);
    const inserir = db.prepare(`
      INSERT INTO production_scenes (
        id, scriptId, ordinal, title, purpose, durationSeconds,
        narration, visualDescription, status, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const cena of normalizadas) {
      inserir.run(
        newId('scene'), roteiro.id, cena.ordinal, cena.title, cena.purpose,
        cena.durationSeconds, cena.narration, cena.visualDescription,
        PRODUCTION_STATUS.DRAFT, agora, agora,
      );
    }
    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return listProductionScenes(projectId, db);
}

/** As cenas do projeto, na ordem da produção. */
export function listProductionScenes(projectId, db = database()) {
  const roteiro = getProductionScript(projectId, db);
  if (!roteiro) return [];
  return linhas(db.prepare(
    'SELECT * FROM production_scenes WHERE scriptId = ? ORDER BY ordinal ASC',
  ).all(roteiro.id));
}

/**
 * Uma cena do projeto, pela POSIÇÃO dela.
 *
 * O projeto vem de quem chama (e, na camada de agente, do ToolContext). Não há
 * como pedir a cena de outro projeto: o número 4 sempre significa "a quarta
 * cena DESTE roteiro". Ver o cabeçalho.
 */
export function getProductionScene(projectId, ordinal, db = database()) {
  const roteiro = getProductionScript(projectId, db);
  if (!roteiro) return null;

  const posicao = inteiroOuNulo(ordinal);
  if (posicao === null || posicao < 1) return null;

  return linha(db.prepare(
    'SELECT * FROM production_scenes WHERE scriptId = ? AND ordinal = ?',
  ).get(roteiro.id, posicao));
}

/**
 * Altera UMA cena, e só ela.
 *
 * É a operação de "deixe a cena 3 mais dramática". Substituir o conjunto
 * inteiro para mudar uma frase reescreveria as outras nove — e o modelo, ao
 * reescrevê-las, mudaria alguma sem querer. Aqui as demais não são sequer
 * lidas.
 *
 * ── Por que a tolerância de duração NÃO é conferida aqui ────────────────────
 *
 * Porque "reduza a cena 5 para 10 segundos" é uma ordem, não uma proposta.
 * Recusá-la porque a soma passou a divergir do alvo seria a ferramenta
 * desobedecendo ao usuário para defender um número que o próprio usuário
 * escolheu — e que ele acabou de mudar de ideia sobre.
 *
 * O que a operação faz é DEVOLVER a soma e o desvio, para que o agente possa
 * dizer "a produção agora está com 112s". Informar é útil; recusar seria errado.
 * A tolerância continua valendo onde ela é uma proposta: em `replaceProductionScenes`.
 */
export function updateProductionScene(projectId, ordinal, patch = {}, db = database()) {
  const atual = getProductionScene(projectId, ordinal, db);
  if (!atual) {
    throw new DomainError(
      `Este projeto não tem uma cena ${ordinal}.`,
      { ordinal },
    );
  }

  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new DomainError('Alteração de cena inválida.', {});
  }

  const desconhecidos = Object.keys(patch).filter(
    (campo) => !CAMPOS_EDITAVEIS_DA_CENA.includes(campo),
  );
  if (desconhecidos.length) {
    throw new DomainError(
      `Campos não editáveis em uma cena: ${desconhecidos.join(', ')}.`,
      { desconhecidos, editaveis: [...CAMPOS_EDITAVEIS_DA_CENA] },
    );
  }
  if (Object.keys(patch).length === 0) {
    throw new DomainError('Nenhuma alteração foi pedida para esta cena.', {});
  }

  const proximo = { ...atual };
  if ('title' in patch) proximo.title = textoObrigatorio(patch.title, 'title');
  if ('purpose' in patch) proximo.purpose = textoOpcional(patch.purpose, 'purpose');
  if ('narration' in patch) proximo.narration = textoOpcional(patch.narration, 'narration');
  if ('visualDescription' in patch) {
    proximo.visualDescription = textoOpcional(patch.visualDescription, 'visualDescription');
  }
  if ('durationSeconds' in patch) {
    proximo.durationSeconds = duracaoDeCenaValida(patch.durationSeconds, atual.ordinal);
  }

  db.prepare(`
    UPDATE production_scenes SET
      title = ?, purpose = ?, durationSeconds = ?, narration = ?,
      visualDescription = ?, updatedAt = ?
    WHERE id = ?
  `).run(
    proximo.title, proximo.purpose, proximo.durationSeconds, proximo.narration,
    proximo.visualDescription, Date.now(), atual.id,
  );

  return getProductionScene(projectId, atual.ordinal, db);
}

/**
 * O retrato numérico da produção: quantas cenas, quanto somam, e o quanto isso
 * difere do alvo.
 *
 * Uma consulta só, porque as três perguntas nunca são feitas separadas.
 */
export function productionSummary(projectId, db = database()) {
  const plano = getProductionPlan(projectId, db);
  const cenas = listProductionScenes(projectId, db);
  const total = cenas.reduce((soma, cena) => soma + cena.durationSeconds, 0);
  const alvo = plano ? plano.targetDurationSeconds : null;

  return {
    sceneCount: cenas.length,
    totalDurationSeconds: total,
    targetDurationSeconds: alvo,
    driftSeconds: alvo === null ? null : total - alvo,
    toleranceSeconds: DURATION_TOLERANCE_SECONDS,
  };
}

// ── a forma pública ─────────────────────────────────────────────────────────
//
// Listas fechadas, pelo mesmo critério de `publicProjectDocument`: uma coluna
// nova na tabela não deve aparecer numa resposta por acidente. O que fica de
// fora é sempre o mesmo: `id`, `projectId`, `scriptId` — identidade nossa,
// que nem a tela nem o modelo têm o que fazer com.

const CAMPOS_PUBLICOS_DO_PLANO = Object.freeze([
  'title', 'logline', 'synopsis', 'format', 'targetDurationSeconds',
  'aspectRatio', 'genre', 'tone', 'audience', 'language', 'status',
  'createdAt', 'updatedAt',
]);

const CAMPOS_PUBLICOS_DO_ROTEIRO = Object.freeze([
  'title', 'summary', 'fullText', 'status', 'createdAt', 'updatedAt',
]);

const CAMPOS_PUBLICOS_DA_CENA = Object.freeze([
  'ordinal', 'title', 'purpose', 'durationSeconds', 'narration',
  'visualDescription', 'status',
]);

/**
 * A cena numa LISTA: o bastante para escolher qual editar, sem o texto longo.
 *
 * A narração e a descrição visual ficam de fora porque quarenta cenas com
 * quatro mil caracteres cada não cabem num turno — e quem lista está procurando,
 * não lendo. Para ler uma, existe `get_scene`. É por isso que as duas
 * ferramentas existem.
 */
const CAMPOS_DA_CENA_EM_LISTA = Object.freeze([
  'ordinal', 'title', 'purpose', 'durationSeconds', 'status',
]);

export function publicProductionPlan(registro) {
  return reduzir(registro, CAMPOS_PUBLICOS_DO_PLANO);
}

export function publicProductionScript(registro) {
  return reduzir(registro, CAMPOS_PUBLICOS_DO_ROTEIRO);
}

export function publicProductionScene(registro) {
  return reduzir(registro, CAMPOS_PUBLICOS_DA_CENA);
}

export function publicProductionSceneSummary(registro) {
  return reduzir(registro, CAMPOS_DA_CENA_EM_LISTA);
}

/** Os campos que atravessam para fora — usados nos testes. */
export function declaredPlanFields() {
  return [...CAMPOS_PUBLICOS_DO_PLANO];
}

export function declaredScriptFields() {
  return [...CAMPOS_PUBLICOS_DO_ROTEIRO];
}

export function declaredSceneFields() {
  return [...CAMPOS_PUBLICOS_DA_CENA];
}

export function declaredSceneSummaryFields() {
  return [...CAMPOS_DA_CENA_EM_LISTA];
}

function reduzir(registro, campos) {
  if (!registro) return null;
  const saida = {};
  for (const campo of campos) saida[campo] = registro[campo] ?? null;
  return saida;
}

// ── validação interna ───────────────────────────────────────────────────────

function exigirRoteiro(projectId, db) {
  const alvo = textoOuNulo(projectId);
  if (!alvo) {
    throw new DomainError('As cenas precisam de um projeto.', {});
  }
  const plano = getProductionPlan(alvo, db);
  if (!plano) {
    throw new DomainError(
      'Este projeto ainda não tem um plano de produção; grave o plano antes das cenas.',
      { projectId: alvo },
    );
  }
  const roteiro = getProductionScript(alvo, db);
  if (!roteiro) {
    throw new DomainError(
      'Este projeto ainda não tem roteiro; grave o roteiro antes das cenas.',
      { projectId: alvo },
    );
  }
  return { plano, roteiro };
}

function cenaValida(bruta, indice) {
  if (!bruta || typeof bruta !== 'object' || Array.isArray(bruta)) {
    throw new DomainError(`A cena na posição ${indice + 1} não é um objeto.`, { indice });
  }

  const desconhecidos = Object.keys(bruta).filter((campo) => !CAMPOS_DA_CENA.includes(campo));
  if (desconhecidos.length) {
    throw new DomainError(
      `Campos desconhecidos numa cena: ${desconhecidos.join(', ')}.`,
      { desconhecidos, aceitos: [...CAMPOS_DA_CENA] },
    );
  }

  const ordinal = inteiroOuNulo(bruta.ordinal);
  if (ordinal === null || ordinal < 1) {
    throw new DomainError(
      `A cena na posição ${indice + 1} precisa de um número maior que zero.`,
      { indice, ordinal: bruta.ordinal },
    );
  }

  return {
    ordinal,
    title: textoObrigatorio(bruta.title, 'title'),
    purpose: textoOpcional(bruta.purpose, 'purpose'),
    durationSeconds: duracaoDeCenaValida(bruta.durationSeconds, ordinal),
    narration: textoOpcional(bruta.narration, 'narration'),
    visualDescription: textoOpcional(bruta.visualDescription, 'visualDescription'),
  };
}

function duracaoDeCenaValida(valor, ordinal) {
  const segundos = inteiroOuNulo(valor);
  if (segundos === null || segundos <= 0) {
    throw new DomainError(
      `A cena ${ordinal} precisa de uma duração em segundos maior que zero.`,
      { ordinal, durationSeconds: valor },
    );
  }
  if (segundos > MAX_SCENE_DURATION_SECONDS) {
    throw new DomainError(
      `A cena ${ordinal} passa de ${MAX_SCENE_DURATION_SECONDS}s.`,
      { ordinal, durationSeconds: segundos, limite: MAX_SCENE_DURATION_SECONDS },
    );
  }
  return segundos;
}

function duracaoAlvoValida(valor) {
  const segundos = inteiroOuNulo(valor);
  if (segundos === null || segundos <= 0) {
    throw new DomainError(
      'A produção precisa de uma duração alvo em segundos maior que zero.',
      { targetDurationSeconds: valor },
    );
  }
  if (segundos > MAX_TARGET_DURATION_SECONDS) {
    throw new DomainError(
      `A duração alvo passa de ${MAX_TARGET_DURATION_SECONDS}s.`,
      { targetDurationSeconds: segundos, limite: MAX_TARGET_DURATION_SECONDS },
    );
  }
  return segundos;
}

function textoObrigatorio(valor, campo) {
  const texto = String(valor ?? '').trim();
  if (!texto) {
    throw new DomainError(`O campo "${campo}" é obrigatório.`, { campo });
  }
  return cortar(texto, campo);
}

function textoOpcional(valor, campo) {
  if (valor === null || valor === undefined) return '';
  const texto = String(valor).trim();
  return texto ? cortar(texto, campo) : '';
}

/**
 * Corta no teto em vez de recusar.
 *
 * Um texto longo demais não é uma violação de regra: é um modelo escrevendo
 * demais. Recusar o plano inteiro por causa de uma sinopse comprida faria o
 * agente perder um turno reescrevendo o que já estava certo.
 *
 * Uma duração fora do lugar é outra coisa, e essa é recusada — ali o número
 * errado muda o filme, e cortá-lo seria inventar um valor que ninguém pediu.
 */
function cortar(texto, campo) {
  const teto = TETOS[campo];
  return teto && texto.length > teto ? texto.slice(0, teto) : texto;
}

function fontesValidas(projectId, ids, db) {
  if (ids === null || ids === undefined) return [];
  if (!Array.isArray(ids)) {
    throw new DomainError('As fontes do plano precisam vir numa lista.', {});
  }

  const saida = [];
  for (const bruto of ids) {
    const id = textoOuNulo(bruto)?.trim();
    if (!id) continue;
    if (saida.includes(id)) continue;
    // Mesma fronteira das ferramentas de documento: "é de outro projeto" e "não
    // existe" são a mesma recusa, e pelo mesmo motivo.
    if (!getProjectDocumentIn(projectId, id, db)) {
      throw new DomainError(
        'Este projeto não tem um documento com esse identificador.',
        {},
      );
    }
    saida.push(id);
  }
  return saida;
}
