// Repositório do livro-razão das gerações.
//
// A tabela é `generation_jobs`, criada na migração 7. O que ela guarda está
// explicado lá; o que ESTE arquivo guarda é a regra: o que pode ser gravado,
// com o quê, e em que ordem.
//
// ── Operações explícitas, não um `update(qualquerCoisa)` ────────────────────
//
// Cada função abaixo tem um nome que diz a INTENÇÃO — o provider aceitou, o
// trabalho mudou de estado, a mídia achou a mensagem dela. Um repositório com
// um `updateGenerationJob(jobId, objeto)` genérico aceitaria qualquer
// combinação de campos, inclusive as impossíveis: um job `preparing` com
// `finishedAt`, um `done` sem Asset. A intenção some, e com ela a chance de o
// banco recusar o que não faz sentido.
//
// ── O que este arquivo NÃO conhece ──────────────────────────────────────────
//
// Não conhece ComfyUI, nó, grafo, arquivo nem fila. Não conhece Hermes, runtime
// de agente, sessão nem ferramenta. Ele grava o que aconteceu; quem faz
// acontecer é outra camada. Há teste que varre este fonte e falha se um desses
// nomes aparecer.

import {
  database, DomainError, GENERATION_JOB_KINDS, inteiroOuNulo, linha, linhas,
  textoOuNulo,
} from './db.js';
import { getProject } from './projects.js';
// O vínculo entre uma geração concluída e o take de cena que a pediu.
//
// Importado, e não reimplementado, pelo mesmo critério dos vocabulários: quem
// sabe o que é um take é `sceneMedia.js`. Não há ciclo — ele importa `db.js` e
// `production.js`, e nenhum dos dois volta para cá.
//
// Que o LIVRO-RAZÃO conheça a produção pode parecer acoplamento. É o contrário:
// concluir é o único evento durável que TODOS os caminhos de geração
// atravessam — o acompanhamento vivo, a consulta da tela e a reconciliação
// depois de um reinício. Pendurar o vínculo em qualquer outro lugar o faria
// existir só no caminho que aquele lugar conhece.
import { linkCompletedJobToSceneTake } from './sceneMedia.js';
import {
  assertJobState, isTerminalJobState, JOB_STATES, TERMINAL_JOB_STATES,
} from './generationJobStates.js';

export { JOB_STATES, TERMINAL_JOB_STATES };

/**
 * A mesma forma de identificador que vira segmento de caminho e nome de
 * arquivo. `jobId` é gerado pela camada de geração — este repositório não o
 * inventa, ele o exige.
 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function idValido(valor, campo) {
  const texto = String(valor ?? '');
  if (!ID_RE.test(texto)) {
    throw new DomainError(`${campo} inválido: "${valor}".`, { campo, valor });
  }
  return texto;
}

/**
 * Confere que uma mensagem serve como referência deste job.
 *
 * O SQLite garante que a mensagem EXISTE — a chave estrangeira faz isso. O que
 * ele não consegue expressar é a coerência: que a mensagem é do papel certo e
 * da conversa certa. Sem esta checagem, um job poderia apontar a âncora do
 * turno para uma resposta do assistente, ou para uma mensagem de outra
 * conversa, e nada reclamaria — a linha ficaria plausível e errada.
 *
 * `papel` é o que separa as duas referências: `userMessageId` é a fala que
 * INICIOU o turno, `assistantMessageId` é a resposta em que a mídia aparece.
 * Trocá-las passaria despercebido até o dia de um reinício.
 */
function mensagemCoerente(messageId, { papel, threadId, campo }, db) {
  const id = idValido(messageId, 'messageId');

  // Conhecer a mensagem sem conhecer a conversa é uma linha que sabe metade:
  // o reinício encontraria a fala e não saberia onde ela mora. Se há mensagem,
  // há conversa.
  if (!threadId) {
    throw new DomainError(
      `${campo} exige threadId: uma mensagem sem conversa não identifica nada.`,
      { campo, messageId: id },
    );
  }
  const mensagem = linha(
    db.prepare('SELECT id, threadId, role FROM agent_messages WHERE id = ?').get(id),
  );

  if (!mensagem) {
    throw new DomainError(`Mensagem desconhecida: "${id}".`, { messageId: id });
  }
  if (mensagem.role !== papel) {
    throw new DomainError(
      `A mensagem "${id}" é do papel "${mensagem.role}", e aqui se espera "${papel}".`,
      { messageId: id, role: mensagem.role, esperado: papel },
    );
  }
  if (mensagem.threadId !== threadId) {
    throw new DomainError(
      `A mensagem "${id}" é de outra conversa.`,
      { messageId: id, threadDaMensagem: mensagem.threadId, threadDoJob: threadId },
    );
  }

  return id;
}

/** Um Asset que existe e é deste projeto. A FK garante o primeiro, não o segundo. */
function assetDoProjeto(assetId, projectId, campo, db) {
  const id = idValido(assetId, campo);
  const asset = linha(db.prepare('SELECT id, projectId FROM assets WHERE id = ?').get(id));

  if (!asset) {
    throw new DomainError(`Asset desconhecido: "${id}".`, { campo, assetId: id });
  }
  if (asset.projectId !== projectId) {
    throw new DomainError(
      `O Asset "${id}" é de outro projeto.`,
      { campo, assetId: id, projetoDoAsset: asset.projectId, projetoDoJob: projectId },
    );
  }
  return id;
}

/**
 * Registra uma geração que está começando.
 *
 * O estado inicial é SEMPRE `preparing`, imposto aqui e não escolhido por quem
 * chama. Um caller capaz de criar um job já `done` poderia registrar um
 * resultado que nunca existiu — e a regra de que Asset só nasce de conclusão
 * real deixaria de valer, porque bastaria dizer que já concluiu.
 *
 * Recuperar um trabalho que já estava em curso é outra operação, e ela ainda
 * não existe: a reconciliação de um reinício lê linhas que este `create` já
 * gravou, e não inventa linhas para trabalhos que nunca foram registrados.
 *
 * ── Duplicata é erro, não idempotência ──────────────────────────────────────
 *
 * O mesmo `jobId` duas vezes não é uma corrida a absorver: é defeito de quem
 * chama. `jobId` é gerado uma vez por geração, antes da submissão. Um UPSERT
 * silencioso aqui esconderia dois trabalhos disputando o mesmo nome de arquivo.
 */
export function createGenerationJobRecord(entrada = {}, db = database()) {
  const {
    jobId,
    projectId,
    kind,
    workflowId,
    threadId = null,
    userMessageId = null,
    derivedFromAssetId = null,
    createdAt = Date.now(),
  } = entrada;

  const id = idValido(jobId, 'jobId');
  const projeto = idValido(projectId, 'projectId');
  const workflow = idValido(workflowId, 'workflowId');

  if (!getProject(projeto, db)) {
    throw new DomainError(`Projeto desconhecido: "${projeto}".`, { projectId: projeto });
  }
  if (!GENERATION_JOB_KINDS.includes(kind)) {
    throw new DomainError(
      `Tipo de geração desconhecido: "${kind}".`,
      { kind, aceitos: GENERATION_JOB_KINDS },
    );
  }
  if (getGenerationJobRecord(id, db)) {
    throw new DomainError(`Já existe uma geração com o id "${id}".`, { jobId: id });
  }

  const thread = threadId === null || threadId === undefined
    ? null
    : idValido(threadId, 'threadId');

  // A âncora do turno (PASSO 10.0). Anulável porque nem toda geração nasce numa
  // conversa — as telas do Studio geram com projeto e sem thread. Quando vem,
  // precisa ser coerente.
  const doUsuario = userMessageId === null || userMessageId === undefined
    ? null
    : mensagemCoerente(
      userMessageId, { papel: 'user', threadId: thread, campo: 'userMessageId' }, db,
    );

  // A imagem que este vídeo anima precisa ser do MESMO projeto. A chave
  // estrangeira só exige que o Asset exista; sem esta checagem, uma produção
  // poderia derivar de material de outra, e a linhagem atravessaria a fronteira
  // que o resto do domínio mantém.
  const origem = derivedFromAssetId === null || derivedFromAssetId === undefined
    ? null
    : assetDoProjeto(derivedFromAssetId, projeto, 'derivedFromAssetId', db);

  const agora = inteiroOuNulo(createdAt) ?? Date.now();

  db.prepare(`
    INSERT INTO generation_jobs (
      jobId, projectId, threadId, userMessageId, assistantMessageId,
      kind, workflowId, providerJobId, state, assetId, derivedFromAssetId,
      error, createdAt, submittedAt, finishedAt, updatedAt
    ) VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?, NULL, ?, NULL, ?, NULL, NULL, ?)
  `).run(
    id, projeto, thread, doUsuario,
    kind, workflow, JOB_STATES.PREPARING, origem,
    agora, agora,
  );

  return getGenerationJobRecord(id, db);
}

/** Uma geração, pelo nosso identificador. */
export function getGenerationJobRecord(jobId, db = database()) {
  if (typeof jobId !== 'string' || !jobId) return null;
  return linha(db.prepare('SELECT * FROM generation_jobs WHERE jobId = ?').get(jobId));
}

/**
 * Uma geração, pelo identificador DO EXECUTOR.
 *
 * É por aqui que a reconciliação de um reinício reencontra um trabalho a partir
 * do que o executor devolve. Nulo não casa com nada: um job ainda não aceito
 * não tem esse nome, e procurar por `null` traria todos eles.
 */
export function findGenerationJobByProvider(providerJobId, db = database()) {
  if (typeof providerJobId !== 'string' || !providerJobId) return null;
  return linha(
    db.prepare('SELECT * FROM generation_jobs WHERE providerJobId = ?').get(providerJobId),
  );
}

/**
 * As gerações que ainda não terminaram, das mais antigas para as mais novas.
 *
 * A lista de terminais vem de `TERMINAL_JOB_STATES` e é LIGADA como parâmetro,
 * não interpolada: uma segunda lista escrita à mão no SQL divergiria da
 * primeira no dia em que um estado entrasse, e o sintoma seria um trabalho
 * terminado reaparecendo para ser reconciliado.
 *
 * A ordem é determinística até o desempate por `jobId`: dois jobs cabem no
 * mesmo milissegundo, e uma varredura de reinício sem ordem estável é uma
 * varredura que não dá para testar.
 */
export function listOpenGenerationJobs({ projectId = null } = {}, db = database()) {
  const marcadores = TERMINAL_JOB_STATES.map(() => '?').join(', ');
  const filtro = projectId ? ' AND projectId = ?' : '';
  const parametros = projectId
    ? [...TERMINAL_JOB_STATES, String(projectId)]
    : [...TERMINAL_JOB_STATES];

  return linhas(db.prepare(`
    SELECT * FROM generation_jobs
    WHERE state NOT IN (${marcadores})${filtro}
    ORDER BY createdAt ASC, jobId ASC
  `).all(...parametros));
}

/** As gerações de uma conversa, das mais antigas para as mais novas. */
export function listGenerationJobsByThread(threadId, db = database()) {
  if (typeof threadId !== 'string' || !threadId) return [];
  return linhas(db.prepare(`
    SELECT * FROM generation_jobs
    WHERE threadId = ?
    ORDER BY createdAt ASC, jobId ASC
  `).all(threadId));
}

// ── ciclo de vida ───────────────────────────────────────────────────────────
//
// As três operações abaixo existem para o passo seguinte, que liga a facade e o
// acompanhamento a este livro-razão. Elas estão aqui, e não lá, porque é o
// repositório que sabe o que é uma transição válida — e porque sem elas os
// estados terminais só seriam alcançáveis por SQL solto, inclusive nos testes.

/**
 * O executor aceitou o trabalho.
 *
 * Uma operação, uma intenção: chega o identificador dele, o estado passa a
 * `submitted` e o relógio da submissão começa. Separar isso em três chamadas
 * permitiria gravar um `providerJobId` num job que ainda diz `preparing`.
 *
 * `providerJobId` é ESCRITA ÚNICA. Repetir o mesmo é replay e não faz nada;
 * trocar por outro é recusado — um trabalho nosso não muda de execução no
 * provider em silêncio, e um registro que mudasse passaria a acompanhar
 * resultado alheio.
 */
export function markGenerationJobSubmitted(jobId, providerJobId, { db = database(), at = Date.now() } = {}) {
  const registro = exigirRegistro(jobId, db);
  const doProvider = idValido(providerJobId, 'providerJobId');
  const agora = inteiroOuNulo(at) ?? Date.now();

  if (!escritaUnica(registro.providerJobId, doProvider, {
    campo: 'providerJobId', jobId: registro.jobId,
  })) {
    // Já é exatamente isto. Nada a gravar, nem o relógio.
    return registro;
  }

  db.prepare(`
    UPDATE generation_jobs
    SET providerJobId = ?, state = ?, submittedAt = ?, updatedAt = ?
    WHERE jobId = ?
  `).run(doProvider, JOB_STATES.SUBMITTED, agora, agora, registro.jobId);

  return getGenerationJobRecord(registro.jobId, db);
}

/**
 * O trabalho mudou de estado.
 *
 * ── O que esta operação NÃO pode fazer ──────────────────────────────────────
 *
 * Não pode levar a `done`. Concluir é a operação que amarra um Asset real, e é
 * só ela — `completeGenerationJob`. Se um estado pudesse ser declarado
 * concluído por aqui, a regra "Asset só nasce de conclusão real" cairia: bastava
 * dizer que concluiu. O esquema também recusa, com um CHECK.
 *
 * Não pode sair de um estado TERMINAL. Um desfecho é um fato; reabri-lo por uma
 * chamada genérica faria um trabalho concluído voltar a ser acompanhado, e uma
 * falha registrada desaparecer. Se a reconciliação de um reinício um dia
 * precisar de exceção, ela terá operação própria, com nome próprio.
 *
 * O que ela PODE fazer é qualquer transição entre estados abertos, e daí para
 * `failed`, `cancelled` ou `orphaned`. Providers pulam etapas — um que não
 * exponha fila nunca passa por `queued` — e uma máquina rígida demais recusaria
 * o caminho real de um executor que ainda não existe.
 *
 * `finishedAt` é carimbado aqui, e só aqui, quando o destino é terminal. Um
 * relógio de fim que dependesse do chamador acabaria ausente exatamente no
 * caminho que menos se exercita: o da falha.
 *
 * `error` é dado de OPERADOR — não é a frase que o usuário lê, não sai em
 * evento e não vai ao navegador. Só é aceito com `failed` ou `orphaned`: um
 * motivo de falha guardado em `running` ou em `cancelled` seria uma linha
 * contando duas histórias, e parar a pedido do usuário não é erro.
 */
export function setGenerationJobState(jobId, state, { db = database(), error = null, at = Date.now() } = {}) {
  const registro = exigirRegistro(jobId, db);
  const destino = assertJobState(state);
  const agora = inteiroOuNulo(at) ?? Date.now();
  const motivo = textoOuNulo(error);

  if (destino === JOB_STATES.DONE) {
    throw new DomainError(
      'Concluir é a operação que amarra o Asset — ver completeGenerationJob.',
      { jobId: registro.jobId, state: destino },
    );
  }
  if (isTerminalJobState(registro.state)) {
    throw new DomainError(
      `A geração "${registro.jobId}" já terminou como "${registro.state}".`,
      { jobId: registro.jobId, de: registro.state, para: destino },
    );
  }
  if (motivo !== null && !ACEITAM_MOTIVO.includes(destino)) {
    throw new DomainError(
      `O estado "${destino}" não carrega motivo de falha.`,
      { jobId: registro.jobId, state: destino, aceitam: [...ACEITAM_MOTIVO] },
    );
  }

  const terminal = isTerminalJobState(destino);

  db.prepare(`
    UPDATE generation_jobs
    SET state = ?, error = ?, finishedAt = ?, updatedAt = ?
    WHERE jobId = ?
  `).run(destino, motivo, terminal ? agora : null, agora, registro.jobId);

  return getGenerationJobRecord(registro.jobId, db);
}

/** Os únicos estados em que um motivo de falha faz sentido. */
const ACEITAM_MOTIVO = Object.freeze([JOB_STATES.FAILED, JOB_STATES.ORPHANED]);

/**
 * O trabalho concluiu, e este é o Asset.
 *
 * ── A ÚNICA porta para `done` ───────────────────────────────────────────────
 *
 * Concluir e ter resultado são a mesma coisa, e por isso são uma operação só.
 * Enquanto eram duas, existia uma janela em que o banco dizia `done` com
 * `assetId` nulo — e uma reconciliação leria como concluído um trabalho sem
 * resultado nenhum. Aqui as duas metades entram juntas ou não entram.
 *
 * A mensagem do assistente é opcional porque a ordem dos dois não é fixa: uma
 * imagem rápida conclui antes de o turno gravar a resposta, e nesse caso a
 * mensagem chega depois, por `bindGenerationJobMessage`.
 *
 * ── Idempotente sobre o MESMO fato ──────────────────────────────────────────
 *
 * Concluir de novo com o mesmo Asset devolve o registro como está, sem gravar
 * nada — nem o relógio. É o caso real que vem aí: o acompanhamento conclui um
 * trabalho e a reconciliação de um reinício observa o mesmo trabalho, ou roda
 * duas vezes. Repetir um fato tem de dar certo.
 *
 * Concluir com OUTRO Asset é recusado, e concluir com outra mensagem também. O
 * mesmo fato repetido é replay; um fato diferente é corrupção.
 *
 * A transação é IMMEDIATE pelo mesmo motivo de `appendMessageRecord`: é um
 * ler-para-depois-escrever, e o segundo processo — o `next build` abrindo o
 * mesmo arquivo — é o caso que ela protege.
 */
export function completeGenerationJob(jobId, { assetId, assistantMessageId = undefined, db = database(), at = Date.now() } = {}) {
  const registro = exigirRegistro(jobId, db);
  const agora = inteiroOuNulo(at) ?? Date.now();

  if (isTerminalJobState(registro.state) && registro.state !== JOB_STATES.DONE) {
    throw new DomainError(
      `A geração "${registro.jobId}" já terminou como "${registro.state}".`,
      { jobId: registro.jobId, de: registro.state },
    );
  }

  db.exec('BEGIN IMMEDIATE');
  try {
    const asset = assetDoProjeto(assetId, registro.projectId, 'assetId', db);

    // O MESMO Asset de novo é replay; outro Asset é corrupção. Ver `escritaUnica`.
    const assetNovo = escritaUnica(registro.assetId, asset, {
      campo: 'assetId', jobId: registro.jobId,
    });

    let mensagem = registro.assistantMessageId;
    let mensagemNova = false;
    if (assistantMessageId !== undefined) {
      const candidata = mensagemCoerente(
        assistantMessageId,
        { papel: 'assistant', threadId: registro.threadId, campo: 'assistantMessageId' },
        db,
      );
      mensagemNova = escritaUnica(registro.assistantMessageId, candidata, {
        campo: 'assistantMessageId', jobId: registro.jobId,
      });
      if (mensagemNova) mensagem = candidata;
    }

    // O take de cena que pediu esta geração encontra o resultado dela — e, se a
    // cena ainda não tinha imagem escolhida, esta vira a escolha.
    //
    // ANTES do desvio de replay logo abaixo, de propósito: uma reconciliação
    // pode chegar a um job que já está `done` e a um take que ficou sem Asset
    // (o processo caiu entre uma coisa e outra). Se o vínculo morasse depois do
    // desvio, esse take nunca seria reparado — a segunda passagem sairia por
    // cima dele. A função é idempotente, então repetir não custa nada.
    //
    // Dentro da MESMA transação: o job dizer `done` e o take receber o Asset
    // são o mesmo fato, e um sem o outro é um estado que ninguém deveria ver.
    //
    // Devolve `null` quando a geração não é de cena nenhuma, que é o caso
    // comum — `og.generate_image` continua existindo e não passa por aqui.
    linkCompletedJobToSceneTake(registro.jobId, asset, db);

    // Nada a gravar: o fato já está registrado, exatamente assim. Não tocar em
    // `updatedAt` é parte da idempotência — um replay que mexesse no relógio
    // faria duas execuções da reconciliação deixarem rastros diferentes.
    if (!assetNovo && !mensagemNova) {
      db.exec('COMMIT');
      return registro;
    }

    db.prepare(`
      UPDATE generation_jobs
      SET assetId = ?, assistantMessageId = ?, state = ?, error = NULL,
          finishedAt = ?, updatedAt = ?
      WHERE jobId = ?
    `).run(
      asset,
      mensagem,
      JOB_STATES.DONE,
      // A hora de fim é a do PRIMEIRO desfecho. Amarrar a mensagem depois não
      // muda quando o trabalho acabou.
      registro.finishedAt ?? agora,
      agora,
      registro.jobId,
    );

    db.exec('COMMIT');
  } catch (erro) {
    db.exec('ROLLBACK');
    throw erro;
  }

  return getGenerationJobRecord(registro.jobId, db);
}

/**
 * O resultado achou a mensagem em que vai aparecer.
 *
 * Separada de `completeGenerationJob` porque a ordem dos dois eventos não é
 * fixa: o turno pode acabar antes do trabalho, e aí a mensagem é conhecida
 * primeiro. Amarrar a mensagem não diz nada sobre o desfecho, e por isso não
 * toca no estado — vale com o trabalho aberto e vale depois de concluído.
 *
 * Repetir a mesma mensagem é replay e não faz nada; apontar para outra é
 * recusado.
 */
export function bindGenerationJobMessage(jobId, assistantMessageId, { db = database(), at = Date.now() } = {}) {
  const registro = exigirRegistro(jobId, db);
  const agora = inteiroOuNulo(at) ?? Date.now();

  const mensagem = mensagemCoerente(
    assistantMessageId,
    { papel: 'assistant', threadId: registro.threadId, campo: 'assistantMessageId' },
    db,
  );

  // Escrita única: a mídia de um trabalho aparece numa resposta, e numa só.
  // Uma reconciliação que pudesse reapontar isso moveria mídia de uma fala para
  // outra — e o usuário veria o resultado surgir num lugar onde nada foi pedido.
  if (!escritaUnica(registro.assistantMessageId, mensagem, {
    campo: 'assistantMessageId', jobId: registro.jobId,
  })) {
    return registro;
  }

  db.prepare(`
    UPDATE generation_jobs SET assistantMessageId = ?, updatedAt = ? WHERE jobId = ?
  `).run(mensagem, agora, registro.jobId);

  return getGenerationJobRecord(registro.jobId, db);
}

/**
 * Um campo que se escreve UMA vez.
 *
 * ── Por que estes campos não podem ser reescritos ───────────────────────────
 *
 * O acompanhamento conclui um trabalho; a reconciliação de um reinício pode
 * observar o MESMO trabalho e concluir de novo. Repetir um fato é replay, e
 * replay precisa dar certo — senão a reconciliação vira uma operação que só
 * pode rodar uma vez, o que é justamente o contrário do que ela é.
 *
 * Mas repetir um fato DIFERENTE não é replay: é corrupção. Um job que trocasse
 * de Asset moveria mídia de uma conversa para outra; um que trocasse de
 * identificador do executor passaria a acompanhar outra execução sem ninguém
 * pedir. As duas coisas são silenciosas, e é por isso que a distinção mora aqui
 * e não no bom senso de quem chama.
 *
 * @returns `true` quando há o que gravar, `false` quando já é exatamente isto.
 */
function escritaUnica(atual, novo, { campo, jobId }) {
  if (atual === null || atual === undefined) return true;
  if (atual === novo) return false;

  throw new DomainError(
    `${campo} já vale "${atual}" nesta geração e não pode virar "${novo}".`,
    { campo, jobId, atual, novo },
  );
}

/** O registro, ou uma falha com nome. Nenhuma operação de ciclo de vida cria. */
function exigirRegistro(jobId, db) {
  const registro = getGenerationJobRecord(String(jobId ?? ''), db);
  if (!registro) {
    throw new DomainError(`Geração desconhecida: "${jobId}".`, { jobId });
  }
  return registro;
}
