// Generation Facade — abstração de alto nível sobre o provider ComfyUI.
//
// As tools do agente NÃO falam diretamente com o ComfyUI provider.
// Essa facade encapsula a lógica de submissão, capacidade padrão, integração
// com Asset, e garante que o agente continua agnóstico de ComfyUI/workflow/nó.
//
// O Agent conhece apenas:
// - startImageGeneration(prompt, aspect, seed)
// - startVideoGeneration(prompt, aspect, duration, seed, sourceAssetId)
// - getGenerationJob(jobId)
//
// A facade conhece:
// - qual capacity usar (Ideogram 4 para imagem, MiniMax para vídeo)
// - workflow interna
// - submissão ao ComfyUI
// - finalização + Asset

import {
  finalizeJob, newJobId, pollJob, publicJob as providerPublicJob, submitGeneration,
} from '../comfy/provider.js';
import { getJob } from '../comfy/jobs.js';
import { getAsset, findAssetsByJob } from '../domain/index.js';
import { database, DomainError } from '../domain/db.js';
import {
  completeGenerationJob, createGenerationJobRecord, getGenerationJobRecord,
  markGenerationJobSubmitted, setGenerationJobState,
} from '../domain/generationJobs.js';
import { CHANNELS, STAGES } from '../logs/stages.js';
import { logWarn } from '../logs/logger.js';
import { STATES, TERMINAL_STATES } from '../comfy/status.js';
import { mediaKind, mimeFor } from './mediaKinds.js';
import { getWorkflow } from './workflows/registry.js';
import { isTerminalJobState, JOB_STATES, TERMINAL_JOB_STATES } from './jobStates.js';
import { fromComfyState } from './comfyJobState.js';

// A camada de agente alcança a geração por ESTA porta e por mais nenhuma — é o
// que a trava de arquitetura exige e é o que mantém a lista de dependências
// dela curta. Reexportar aqui evita que o vocabulário de estados vire um
// segundo caminho de entrada.
//
// Só o VOCABULÁRIO sai por aqui. `fromComfyState` é assunto desta camada e de
// mais ninguém: quem está do outro lado da porta fala em estados de domínio, e
// nunca precisa saber qual executor produziu um deles.
export { isTerminalJobState, JOB_STATES, TERMINAL_JOB_STATES };

/**
 * O identificador de uma geração.
 *
 * Sai por esta porta para que quem inicia uma geração não precise alcançar o
 * executor só para nomear o trabalho. Ele é identificador do SHOWRUNNER: vira
 * o arquivo publicado, entra no grafo submetido e indexa o Asset.
 */
export { newJobId as newGenerationJobId };

/** Erro de geração (não de submissão). */
export class GenerationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'GenerationError';
    this.detail = detail;
  }
}

/**
 * O estado de um job no vocabulário do SHOWRUNNER.
 *
 * Aqui morava uma cadeia de `if` que devolvia o estado do ComfyUI traduzido
 * para o português — "na-fila", "decodificando", "salvando". Não era
 * normalização: era o vocabulário do executor com outro nome, e ele chegava ao
 * agente e ao registro de acompanhamento como se fosse nosso.
 *
 * A tradução agora é uma só, mora no adaptador do provider
 * (`comfyJobState.js`), e um estado sem tradução lança em vez de passar
 * adiante — ver o porquê lá. O vocabulário em si, em `jobStates.js`, não
 * conhece executor nenhum.
 *
 * O job interno continua usando `state` do provider como fonte de verdade; é
 * ele que a tela antiga do Studio mostra, com a granularidade que ela quer.
 */
function normalizeJobState(job) {
  return fromComfyState(job.state);
}

// ── o livro-razão ───────────────────────────────────────────────────────────
//
// Esta camada é a dona do registro durável de uma geração. Ela grava a linha
// ANTES de o executor ser chamado, anota o identificador que ele devolve, e
// acompanha o que observa depois.
//
// ── Por que aqui, e não no acompanhamento do agente ─────────────────────────
//
// Porque nem toda geração nasce numa conversa. Um livro-razão mantido pelo
// acompanhamento do agente estaria correto só para o caminho do agente — e o
// dia em que outra superfície gerasse algo, o registro ficaria pela metade sem
// ninguém notar. Quem sabe que uma geração começou é quem a começa.
//
// ── Anotar não é gerar ──────────────────────────────────────────────────────
//
// Falhar em ESCREVER no livro-razão não é falhar em GERAR. Depois de o
// executor aceitar o trabalho, ele está rodando com ou sem a nossa anotação, e
// derrubar a geração por causa de um problema de banco seria trocar um defeito
// pequeno por um grande. Por isso as anotações POSTERIORES à submissão são
// registradas e engolidas — menos a primeira, que é a que decide se vale
// submeter.

/** O banco do livro-razão. */
const bancoDoLedger = (db) => db || database();

/**
 * Anota, sem deixar um problema de banco derrubar uma geração que está indo bem.
 *
 * O oposto de `finalizeGenerationAsset`, que NÃO pode ser engolido: lá o que
 * está em jogo é o resultado que o usuário vai ver; aqui é a escrituração, e
 * escrituração atrasada se reconcilia depois.
 */
function anotar(o_que, jobId, fn) {
  try {
    return fn();
  } catch (erro) {
    logWarn(STAGES.GENERATION_LEDGER, `Não foi possível anotar ${o_que} no livro-razão.`, {
      channel: CHANNELS.COMFY,
      jobId,
      detail: { causa: erro?.message || String(erro) },
    });
    return null;
  }
}

/**
 * O executor recusou de forma PROVADA?
 *
 * Só há duas provas: o erro aconteceu antes de a submissão sair (workflow
 * inválido, quadro que não subiu — nada chegou ao executor), ou o executor
 * RESPONDEU com um status de erro.
 *
 * Tudo o mais é ambíguo, e ambíguo não vira desfecho. Um tempo esgotado ou uma
 * conexão que caiu depois do envio não dizem se o trabalho foi aceito — e
 * gravar `failed` aí seria afirmar uma coisa que não sabemos, num registro que
 * existe justamente para ser confiável depois de um reinício. Nesse caso a
 * linha fica em `preparing`, que é a verdade: começamos e não sabemos o resto.
 *
 * Conservador de propósito: a rejeição por nó inválido chega sem status e cai
 * no caso ambíguo. Distingui-la exigiria um discriminador no cliente do
 * executor, que não é assunto deste passo — e errar para o lado de "não sei" é
 * o lado certo.
 */
function recusaProvada(erro) {
  if (erro?.name === 'WorkflowError' || erro?.name === 'UploadError') return true;
  return erro?.name === 'ComfyError' && typeof erro.status === 'number';
}

/**
 * Sincroniza o livro-razão com o que acabou de ser observado.
 *
 * Só escreve quando o estado MUDOU. O acompanhamento consulta de segundo em
 * segundo, e uma escrita por consulta encheria o banco de linhas idênticas
 * para dizer que nada aconteceu.
 *
 * `done` não passa por aqui: concluir é amarrar um Asset real, e isso acontece
 * onde o Asset nasce. Um registro que virasse `done` na observação afirmaria um
 * resultado antes de ele existir.
 */
function sincronizarEstado(jobId, estado, { db, error = null }) {
  if (estado === JOB_STATES.DONE) return;

  anotar('o estado', jobId, () => {
    const banco = bancoDoLedger(db);
    const registro = getGenerationJobRecord(jobId, banco);
    // Sem linha, nada a sincronizar. É o caso de uma geração que nasceu por uma
    // superfície que ainda não escreve no livro-razão, e de toda geração
    // anterior a ele existir. Consultar essas continua funcionando.
    if (!registro) return;
    if (registro.state === estado) return;
    // Um desfecho é um fato; o repositório recusa reabri-lo, e o acompanhamento
    // não deve tentar.
    if (isTerminalJobState(registro.state)) return;

    setGenerationJobState(jobId, estado, { db: banco, error });
  });
}

/** Capacidade padrão para imagem neste release. */
const IMAGEM_WORKFLOW = 'ideogram4_t2i';

/** Capacidade padrão para vídeo neste release. */
const VÍDEO_WORKFLOW = 'minimax_h3_t2v';

/**
 * A proporção pedida cabe no gerador que vai atender?
 *
 * ── Por que aqui, e antes de tudo ───────────────────────────────────────────
 *
 * Porque a recusa natural acontece tarde demais. `selectorForAspect` já lança
 * ao montar o grafo — mas isso é DEPOIS de o trabalho estar registrado no
 * livro-razão e depois de quem chamou ter pendurado coisas nele (o take de uma
 * cena, por exemplo). O resultado seria um take que nasce e morre no mesmo
 * segundo, e uma linha `failed` para dizer o que uma frase resolvia.
 *
 * Conferir antes é o que transforma "a produção é 9:16 e o gerador não faz
 * 9:16" numa resposta, e não num destroço.
 *
 * ── Quem responde é o DESCRIPTOR ────────────────────────────────────────────
 *
 * `aspects` é capacidade declarada do workflow, não uma tabela que esta camada
 * conheça. Trocar o gerador por um que aceite outras proporções muda o
 * descriptor, e esta função continua igual — que é a razão de ela perguntar em
 * vez de saber.
 *
 * ── E NUNCA cair para 16:9 ──────────────────────────────────────────────────
 *
 * Silenciar aqui seria entregar a produção inteira no formato errado, com todas
 * as cenas plausíveis e nenhuma no formato que o usuário pediu — descoberto só
 * na montagem, quando refazer custa tudo de novo.
 */
function exigirAspectoSuportado(aspect, workflowId) {
  const descriptor = getWorkflow(workflowId);
  const aceitos = descriptor?.aspects;
  if (!Array.isArray(aceitos) || aceitos.includes(aspect)) return aspect;

  throw new GenerationError(
    `O formato ${aspect} desta produção não é suportado pela geração atual.`,
    { aspect, suportados: [...aceitos] },
  );
}

/**
 * Inicia uma geração de imagem.
 *
 * Args:
 * - prompt        string requerido
 * - aspect        "16:9" | "21:9" | etc., opcional, padrão interno
 * - seed          integer opcional
 *
 * Resultado:
 * - jobId
 * - kind: "image"
 * - status
 */
export async function startImageGeneration(
  { prompt, aspect = '16:9', seed = null },
  { projectId, threadId = null, userMessageId = null, aoRegistrar = null, db = null, deps = {} } = {},
) {
  if (!projectId) {
    throw new GenerationError('Geração de imagem exige projectId.', {});
  }

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new GenerationError('Prompt é obrigatório e não pode estar vazio.');
  }

  // Antes de registrar qualquer coisa. Ver `exigirAspectoSuportado`.
  exigirAspectoSuportado(aspect, IMAGEM_WORKFLOW);

  // O identificador nasce AQUI, e não dentro do executor. Ele é nome de coisa
  // nossa — vira o arquivo publicado, vai dentro do grafo como prefixo de saída
  // e indexa o Asset. Gerá-lo antes é o que permite registrar o trabalho no
  // livro-razão ANTES de qualquer coisa sair para o executor.
  const jobId = (deps.novoJobId ?? newJobId)();

  const params = {
    jobId,
    prompt: prompt.trim(),
    aspect,
    quality: '1K', // padrão interno para agent
    durationSeconds: undefined, // imagem não tem duração
    seed: seed !== null && seed !== undefined ? Number(seed) : null,
    seedLocked: seed !== null && seed !== undefined,
    projectId,
    workflowId: IMAGEM_WORKFLOW,
  };

  return comMensagemDeProduto(
    'Não foi possível iniciar geração de imagem',
    projectId,
    () => startGeneration(params, { projectId, threadId, userMessageId, aoRegistrar, db, deps }),
  );
}

/**
 * A submissão, com o livro-razão em volta.
 *
 * ── A ordem é a razão de esta função existir ────────────────────────────────
 *
 *   1. registra `preparing`   — antes de qualquer coisa sair daqui
 *   2. submete ao executor
 *   3. anota o identificador que ele devolveu
 *
 * Fazer o passo 1 depois do 2 deixaria aberta a janela que este passo existe
 * para fechar: o executor aceita o trabalho, o processo cai, e o trabalho passa
 * a existir sem que o Showrunner jamais tenha sabido dele. Com a ordem acima,
 * o pior caso é uma linha em `preparing` sem identificador do executor — que é
 * pouco, mas é o suficiente para reencontrá-lo depois pelo nome do arquivo.
 *
 * O passo 1 é o único que pode derrubar a geração: se não dá para registrar,
 * não se submete. Os outros são escrituração — ver `anotar`.
 */
export async function startGeneration(params, {
  projectId, threadId = null, userMessageId = null, derivedFromAssetId = null,
  aoRegistrar = null, db = null, deps = {},
} = {}) {
  if (!projectId) {
    throw new GenerationError('Toda geração exige projectId.', {});
  }

  // O tipo e o workflow saem do DESCRIPTOR, não de quem chama: é ele que sabe
  // o que este workflow produz. Um `kind` informado poderia discordar do
  // arquivo que vai nascer, e o livro-razão passaria a mentir sobre o tipo.
  const workflowId = params.workflowId || VÍDEO_WORKFLOW;
  const { kind } = getWorkflow(workflowId);
  const jobId = params.jobId || (deps.novoJobId ?? newJobId)();
  const completos = { ...params, jobId, workflowId };
  // Injeção no estilo da casa: último parâmetro com padrão. É o que permite um
  // teste exercitar a ORDEM — registrar antes de submeter — sem executor, sem
  // rede e sem GPU.
  const {
    submeter = submitGeneration,
    anotarSubmissao = markGenerationJobSubmitted,
  } = deps;
  const banco = bancoDoLedger(db);

  // Sem try/catch: falhar aqui é falhar ANTES de existir trabalho nenhum, e a
  // resposta certa é não começar.
  createGenerationJobRecord({
    jobId,
    projectId,
    kind,
    workflowId,
    threadId,
    userMessageId,
    derivedFromAssetId,
  }, banco);

  // ── o gancho entre registrar e submeter ────────────────────────────────
  //
  // A janela em que o trabalho já tem registro durável e ainda NÃO existe do
  // lado do executor. É o único instante em que dá para pendurar outra coisa
  // nesta geração com as duas garantias que importam:
  //
  //   - o `jobId` já é definitivo, então o vínculo nasce completo;
  //   - nada foi submetido, então uma falha aqui não deixa trabalho real
  //     rodando sem dono.
  //
  // Quem usa isto hoje é a ferramenta que gera a imagem de uma cena: o take
  // nasce aqui, já apontando para este job. Fazê-lo DEPOIS da submissão abriria
  // exatamente o contrário — uma geração de verdade em curso sem take nenhum.
  //
  // O erro sobe. O registro fica em `preparing` sem identificador do executor,
  // que é a situação que a reconciliação já sabe tratar; nenhum estado novo é
  // inventado para descrevê-la.
  if (aoRegistrar) {
    await aoRegistrar({ jobId, kind, workflowId, projectId });
  }

  let job;
  try {
    job = await submeter(completos);
  } catch (erro) {
    // Só vira desfecho o que dá para provar. Ver `recusaProvada`.
    if (recusaProvada(erro)) {
      sincronizarEstado(jobId, JOB_STATES.FAILED, {
        db: banco,
        error: erro?.message || 'o executor recusou o trabalho',
      });
    } else {
      logWarn(STAGES.GENERATION_LEDGER, 'Submissão sem resposta conclusiva; o registro fica reconciliável.', {
        channel: CHANNELS.COMFY,
        jobId,
        detail: { causa: erro?.message || String(erro) },
      });
    }

    // O erro sobe COMO VEIO. Quem chama distingue as classes — a tela antiga
    // mapeia upload para 400, workflow para 422 e falha do executor para 502 —
    // e embrulhar tudo aqui apagaria essa distinção, transformando um parâmetro
    // inválido em erro interno. Quem quer uma mensagem de produto embrulha em
    // cima, e é o que os dois atalhos do agente fazem.
    throw erro;
  }

  // O executor aceitou. Daqui em diante o trabalho existe do lado de lá, e
  // nenhuma falha de escrituração pode fazer o Showrunner submetê-lo de novo.
  if (job.promptId) {
    anotar('a submissão', jobId, () => (
      anotarSubmissao(jobId, job.promptId, { db: banco })
    ));
  }

  // `providerJob` é a forma que a tela antiga já consome — estado do executor,
  // rótulo, progresso, posição na fila. Ela sai aqui com nome explícito para
  // que ninguém a confunda com vocabulário de domínio: quem quer o estado do
  // Showrunner lê `status`.
  return { jobId, kind, status: fromComfyState(job.state), providerJob: job };
}

/**
 * Inicia uma geração de vídeo.
 *
 * Args:
 * - prompt           string requerido
 * - aspect           opcional
 * - duration         segundos, opcional, padrão interno
 * - seed             opcional
 * - sourceAssetId    Asset imagem para animar, opcional
 *
 * Resultado:
 * - jobId
 * - kind: "video"
 * - status
 */
export async function startVideoGeneration(
  { prompt, aspect = '16:9', duration = 6, seed = null, sourceAssetId = null },
  { projectId, threadId = null, userMessageId = null, aoRegistrar = null, db = null, deps = {} } = {},
) {
  if (!projectId) {
    throw new GenerationError('Geração de vídeo exige projectId.', {});
  }

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new GenerationError('Prompt é obrigatório e não pode estar vazio.');
  }

  // Antes de ler o Asset de origem do disco e antes de registrar o trabalho.
  exigirAspectoSuportado(aspect, VÍDEO_WORKFLOW);

  // Se há sourceAsset, valida que pertence ao mesmo projeto.
  let sourceAsset = null;
  let framesToSubmit = null;
  if (sourceAssetId) {
    if (!db) {
      throw new GenerationError(
        'sourceAssetId requer db para validação.',
        { sourceAssetId },
      );
    }

    sourceAsset = getAsset(sourceAssetId, db);

    if (!sourceAsset) {
      throw new GenerationError(
        `Asset não encontrado: "${sourceAssetId}".`,
        { sourceAssetId },
      );
    }

    if (sourceAsset.projectId !== projectId) {
      throw new GenerationError(
        `Asset pertence a projeto diferente.`,
        { sourceAssetId, assetProject: sourceAsset.projectId, threadProject: projectId },
      );
    }

    if (sourceAsset.kind !== 'image') {
      throw new GenerationError(
        `Asset deve ser imagem para animar.`,
        { sourceAssetId, actualKind: sourceAsset.kind },
      );
    }

    // PASSO 6.1: Ponte Asset → i2v real
    // Lê o arquivo do Asset de forma segura e passa como firstFrame
    if (sourceAsset.filename) {
      try {
        const { readFile } = await import('node:fs/promises');
        const { resolveMediaPath } = await import('../comfy/storage.js');

        const caminhoSeguro = resolveMediaPath('image', sourceAsset.projectId, sourceAsset.filename);
        const bytesImagem = await readFile(caminhoSeguro);

        framesToSubmit = {
          first: {
            bytes: bytesImagem,
            declaredType: sourceAsset.mimeType || 'image/jpeg',
            declaredName: sourceAsset.filename,
          },
        };
      } catch (erro) {
        throw new GenerationError(
          `Não foi possível ler o Asset de origem para i2v: ${erro?.message || 'erro desconhecido'}.`,
          { sourceAssetId, originalError: erro?.message },
        );
      }
    }
  }

  const params = {
    // Ver `startImageGeneration`: o identificador é nosso e nasce antes.
    jobId: (deps.novoJobId ?? newJobId)(),
    prompt: prompt.trim(),
    aspect,
    quality: '480p',
    durationSeconds: Number(duration),
    seed: seed !== null && seed !== undefined ? Number(seed) : null,
    seedLocked: seed !== null && seed !== undefined,
    projectId,
    workflowId: VÍDEO_WORKFLOW,
    frames: framesToSubmit,
    // Guardar no context do job para later retrieval
    _sourceAssetId: sourceAssetId || null,
  };

  return comMensagemDeProduto(
    'Não foi possível iniciar geração de vídeo',
    projectId,
    () => startGeneration(params, {
      projectId,
      threadId,
      userMessageId,
      // A linhagem é registrada DESDE O INÍCIO, e não só quando conclui: ela é
      // o que torna "anime essa imagem" reconstituível, e hoje ela só existia
      // na memória do processo — sumia com ele.
      derivedFromAssetId: sourceAssetId || null,
      // O mesmo gancho da imagem, e pela mesma razão. Ver `startGeneration`:
      // é a janela entre o registro durável e a submissão, a única em que o
      // take de uma cena pode nascer já ligado a este trabalho.
      aoRegistrar,
      db,
      deps,
    }),
  );
}

/**
 * O atalho do agente devolve o recorte estreito e a mensagem de produto.
 *
 * A ferramenta entrega o erro ao modelo, e o modelo ao usuário: ali a classe do
 * erro não ajuda ninguém, e a frase precisa fazer sentido em português. A tela
 * antiga quer o contrário — ela mapeia a CLASSE para o status HTTP —, e por
 * isso `startGeneration` deixa o erro passar cru.
 */
async function comMensagemDeProduto(rotulo, projectId, executar) {
  try {
    const { jobId, kind, status } = await executar();
    return { jobId, kind, status };
  } catch (erro) {
    if (erro instanceof GenerationError) throw erro;
    throw new GenerationError(
      `${rotulo}: ${erro?.message || 'erro'}`,
      { originalError: erro?.message, projectId },
    );
  }
}

/**
 * Consulta o estado de um job.
 *
 * Resultado:
 * - jobId
 * - kind
 * - status    o estado no vocabulário do SHOWRUNNER (`JOB_STATES`), nunca o do
 *             executor. O nome do campo continua `status` para não mexer no
 *             contrato de quem já o lê; o que mudou foram os valores.
 * - assetId (se concluído)
 * - mediaUrl (se concluído)
 * - error (se falhou)
 */
export async function getGenerationJob(jobId, { projectId, db = null } = {}) {
  if (typeof jobId !== 'string' || !jobId) {
    throw new GenerationError('jobId é obrigatório.', {});
  }

  if (!projectId) {
    throw new GenerationError('getGenerationJob exige projectId.', {});
  }

  const job = getJob(jobId);

  if (!job) {
    throw new GenerationError(`Job não encontrado: "${jobId}".`, { jobId });
  }

  // Jobs legados sem projectId não são aceitos no Agent (security boundary).
  // O Agent sempre requer propriedade server-side clara.
  // Compatibilidade legada continua nas telas antigas/provider, não aqui.
  if (!job.projectId) {
    throw new GenerationError(
      'Job não tem propriedade server-side (projectId). Não pode ser consultado pelo Agent.',
      { jobId, detail: 'legacy_job_without_ownership' },
    );
  }

  // Validação de propriedade: o job precisa ser do projeto da thread.
  // A facade valida aqui para evitar vazamento de informações entre projetos.
  if (job.projectId !== projectId) {
    throw new GenerationError(
      'Job não pertence a este projeto.',
      { jobId, jobProject: job.projectId, threadProject: projectId },
    );
  }

  // ── avançar a máquina de estados ────────────────────────────────────────
  //
  // A geração do ComfyUI é PULL: ela só progride quando alguém chama
  // `pollJob`. Na tela isso acontece porque o navegador consulta
  // /api/comfy/status em laço. No caminho do agente não há navegador — e sem
  // esta chamada o job fica em "gerando" para sempre, mesmo com o ComfyUI já
  // tendo terminado. Foi exatamente o que o smoke do PASSO 7B encontrou.
  //
  // `pollJob` é a MESMA função que a rota da tela usa; é ela quem localiza a
  // saída, copia o arquivo e leva o job a DONE (provider.js chama `finalizeJob`
  // por dentro). Nenhuma segunda máquina de estados nasce aqui.
  //
  // Falha de rede ao consultar o ComfyUI não pode derrubar uma consulta de
  // status: o estado conhecido continua valendo e a próxima chamada tenta de
  // novo. Por isso o erro é engolido, e só aqui.
  // `TERMINAL_STATES` é do PROVIDER, e é o certo aqui: a pergunta é se ainda
  // vale a pena consultar o executor. O terminal de DOMÍNIO tem um estado a
  // mais (`orphaned`), que o executor nunca declara — ver `jobStates.js`.
  let atual = job;
  if (!TERMINAL_STATES.includes(job.state)) {
    try {
      await pollJob(jobId);
      atual = getJob(jobId) || job;
    } catch {
      atual = job;
    }
  }

  // ── criar o Asset, uma vez ──────────────────────────────────────────────
  //
  // SOMENTE em DONE. `salvando` e `decodificando` são intermediários: o arquivo
  // ainda não foi publicado e validado, e um Asset criado ali apontaria para
  // algo que pode não existir. `finalizeGenerationAsset` recusa qualquer estado
  // que não seja DONE, então esta condição e a de lá dizem a mesma coisa — o
  // que é intencional, porque a de lá é a que vale se alguém chamar direto.
  let asset = null;
  const publicStatus = normalizeJobState(atual);

  // ── o livro-razão acompanha o que acabou de ser observado ─────────────────
  //
  // Aqui, e não no acompanhamento do agente, porque esta é a função que TODA
  // observação atravessa: o laço automático do agente, a pergunta explícita do
  // modelo e qualquer outro chamador desta camada passam por ela. Três
  // implementações da mesma sincronização divergiriam na primeira mudança.
  //
  // `done` fica de fora de propósito — ele é escrito adiante, junto do Asset.
  sincronizarEstado(jobId, publicStatus, { db, error: atual.error || null });

  if (atual.state === STATES.DONE && db) {
    // Sem try/catch em volta: finalizar NÃO é opcional.
    //
    // A versão anterior engolia qualquer falha e devolvia status "concluido"
    // com `assetId: null`. Para quem consome — o agente — isso é indistinguível
    // de uma geração que concluiu sem produzir nada, e a resposta a essa
    // ambiguidade é a pior possível: seguir em frente como se tivesse dado
    // certo. Um erro real de banco ou de storage precisa chegar a quem chamou.
    //
    // O que É esperado e absorvido continua sendo absorvido, mas DENTRO de
    // `finalizeGenerationAsset`, onde foi projetado no PASSO 6: Asset que já
    // existe devolve o existente, e a corrida de UNIQUE recarrega e devolve o
    // vencedor. Nada disso chega aqui como exceção.
    asset = await finalizeGenerationAsset(jobId, {
      projectId,
      db,
      // Os metadados vêm do PRÓPRIO job, publicados por `finalizeJob`. O
      // chamador não os fornece — e não poderia: ele não sabe onde o arquivo
      // foi parar, que é justamente o que esta camada existe para esconder.
      mediaUrl: atual.result?.url ?? null,
      bytes: atual.result?.bytes ?? null,
      derivedFromAssetId: atual.derivedFromAssetId ?? null,
    });

    // O Asset existe: só agora o livro-razão pode dizer `done`. É a mesma regra
    // do domínio — concluir é amarrar um resultado real —, e a operação é
    // idempotente, então o acompanhamento e uma reconciliação futura podem
    // chegar aqui os dois sem se atrapalharem.
    //
    // Falhar em anotar NÃO desfaz o Asset: ele é o resultado do usuário e já
    // está publicado. O registro fica reconciliável.
    if (asset?.id) {
      anotar('a conclusão', jobId, () => (
        completeGenerationJob(jobId, { assetId: asset.id, db: bancoDoLedger(db) })
      ));
    }
  }

  return {
    jobId: atual.jobId,
    kind: atual.kind || 'unknown',
    status: publicStatus,
    assetId: asset?.id || null,
    mediaUrl: asset?.url || null,
    error: atual.error || null,
    // Forma rica, para o agente conseguir USAR o resultado sem uma segunda
    // consulta. Só campos públicos: nada de caminho, workflow, promptId ou
    // provider. `null` quando ainda não há Asset — nunca ausente, para que
    // quem consome não precise distinguir os dois casos.
    asset: asset
      ? {
        id: asset.id,
        kind: asset.kind,
        mediaUrl: asset.url ?? null,
        mimeType: asset.mimeType ?? null,
        derivedFromAssetId: asset.derivedFromAssetId ?? null,
      }
      : null,
  };
}

/**
 * Observa uma geração e sincroniza o livro-razão.
 *
 * ── Por que existe, ao lado de `getGenerationJob` ───────────────────────────
 *
 * As duas observam a mesma coisa e sincronizam pelo mesmo caminho. O que muda é
 * a fronteira de quem pergunta:
 *
 *   getGenerationJob   o agente. EXIGE `projectId` e recusa job de outro
 *                      projeto — é a checagem de propriedade do PASSO 6, e ela
 *                      existe porque quem pergunta é um modelo.
 *
 *   observeGeneration  a tela do estúdio, que já está dentro do produto e
 *                      pergunta por `jobId` sem asserir projeto nenhum. O
 *                      projeto vem do PRÓPRIO job.
 *
 * Inventar um `projectId` para a segunda só para reusar a primeira seria pior:
 * a checagem passaria a validar um número que o próprio chamador escolheu — ou
 * seja, deixaria de validar.
 *
 * Devolve a forma que a tela antiga já consome, e `null` quando o trabalho não
 * existe. Nenhum vocabulário novo chega à interface.
 */
export async function observeGeneration(jobId, { db = null, deps = {} } = {}) {
  const { consultar = pollJob } = deps;

  const job = getJob(jobId);
  if (!job) return null;

  let atual = job;
  if (!TERMINAL_STATES.includes(job.state)) {
    try {
      atual = (await consultar(jobId)) ? getJob(jobId) || job : job;
    } catch {
      // Falha de rede ao consultar não derruba uma consulta de status: o estado
      // conhecido continua valendo e a próxima tentativa resolve.
      atual = job;
    }
  }

  sincronizarEstado(jobId, fromComfyState(atual.state), {
    db, error: atual.error || null,
  });

  if (atual.state === STATES.DONE) await concluirComAsset(atual, db);

  return publicoDoExecutor(atual);
}

/**
 * Conclui uma geração: publica o arquivo, cria o Asset e fecha o registro.
 *
 * A tela antiga tem um passo explícito de "trazer o resultado", e ele continua
 * existindo. O que mudou é que ele não alcança mais o executor por fora: a
 * publicação continua sendo a do provider, e o Asset e o livro-razão entram
 * pelo mesmo caminho de todo o resto.
 */
export async function finalizeGeneration(jobId, { db = null, deps = {} } = {}) {
  const { publicar = finalizeJob } = deps;

  const publicado = await publicar(jobId);
  if (!publicado) return null;

  const job = getJob(jobId);
  sincronizarEstado(jobId, fromComfyState(job.state), { db, error: job.error || null });
  if (job.state === STATES.DONE) await concluirComAsset(job, db);

  return publicoDoExecutor(job);
}

/**
 * A forma do trabalho que a tela antiga consome.
 *
 * É o recorte que o provider já produzia — estado do executor, rótulo,
 * progresso, posição na fila. Ele atravessa esta camada sem tradução porque É
 * o contrato legado, e mexer nele seria redesenhar a tela em vez de trocar a
 * porta. Quem quer o estado do SHOWRUNNER lê `getGenerationJob().status`.
 */
function publicoDoExecutor(job) {
  return providerPublicJob(job);
}

/**
 * O Asset de um trabalho concluído, e a conclusão anotada no livro-razão.
 *
 * Um lugar só, usado pelos três caminhos de observação — o do agente, o da
 * consulta explícita e o da tela antiga. Enquanto cada um tivesse o seu, o Asset
 * nasceria por três regras diferentes, e a terceira seria a que ninguém revisou.
 */
async function concluirComAsset(job, db) {
  if (!db || !job?.projectId) return null;

  const asset = await finalizeGenerationAsset(job.jobId, {
    projectId: job.projectId,
    db,
    mediaUrl: job.result?.url ?? null,
    bytes: job.result?.bytes ?? null,
    derivedFromAssetId: job.derivedFromAssetId ?? null,
  });

  // O Asset existe: só agora o livro-razão pode dizer `done`. Falhar em anotar
  // NÃO desfaz o Asset — ele é o resultado do usuário e já está publicado.
  if (asset?.id) {
    anotar('a conclusão', job.jobId, () => (
      completeGenerationJob(job.jobId, { assetId: asset.id, db: bancoDoLedger(db) })
    ));
  }

  return asset;
}

/**
 * O MIME do arquivo que foi REALMENTE publicado.
 *
 * A fonte de verdade é a extensão do arquivo publicado, e ela é confiável por
 * construção: para imagem, `mediaKinds` declara `extensionSource: 'bytes'` e o
 * pipeline canonicaliza a extensão a partir do número mágico detectado em
 * `detectImageType` — um nó que chame de .jpg um PNG é normalizado antes de o
 * arquivo ser gravado. Ou seja, a extensão aqui não veio do modelo nem do nome
 * que o ComfyUI devolveu: veio dos bytes.
 *
 * `mimeFor` é o MESMO helper que a rota de mídia usa para servir o arquivo.
 * Usá-lo aqui é o que garante que o Asset e o byte servido nunca discordem —
 * antes esta linha era `kind === 'image' ? 'image/jpeg' : 'video/mp4'`, que
 * registrava image/jpeg para todo PNG gerado.
 *
 * Sem nome de arquivo (job concluído sem `result`, que não deveria acontecer),
 * cai na extensão padrão do tipo em vez de adivinhar. Extensão fora da lista
 * continua sendo erro: `mimeFor` lança, e é isso que queremos — um arquivo que
 * não sabemos servir não vira Asset.
 */
function mimeDoArquivoPublicado(job) {
  const nome = job.result?.filename;
  if (nome) return mimeFor(job.kind, nome);
  return mimeFor(job.kind, `x${mediaKind(job.kind).defaultExtension}`);
}

/**
 * Finaliza uma geração completada criando um Asset.
 *
 * Idempotente: se Asset já existe para esse job, retorna o existente.
 * Se não existe, cria novo.
 *
 * Proteção de corrida: se UNIQUE constraint viola (outro caller criou
 * simultaneamente), recarrega e retorna o Asset já criado.
 * Toda outra violação de constraint é propagada como erro real.
 */
export async function finalizeGenerationAsset(
  jobId,
  { projectId, db = null, mediaUrl = null, bytes = null, width = null, height = null, durationSeconds = null, derivedFromAssetId = null } = {},
) {
  if (!jobId || typeof jobId !== 'string') {
    throw new GenerationError('jobId é obrigatório.', {});
  }
  if (!projectId || typeof projectId !== 'string') {
    throw new GenerationError('projectId é obrigatório.', {});
  }

  const job = getJob(jobId);
  if (!job) {
    throw new GenerationError(`Job não encontrado: "${jobId}".`, { jobId });
  }

  if (job.projectId !== projectId) {
    throw new GenerationError(
      'Job não pertence a este projeto.',
      { jobId, jobProject: job.projectId, threadProject: projectId },
    );
  }

  // Job deve estar em estado DONE (concluído, arquivo publicado e validado).
  // STATES.SAVING é apenas intermediário; Asset só é criado APÓS publicação.
  if (job.state !== STATES.DONE) {
    throw new GenerationError(
      `Job não está concluído: estado=${job.state}.`,
      { jobId, state: job.state },
    );
  }

  // `database` é a FUNÇÃO que abre o banco, não o banco. Sem os parênteses
  // este caminho passava uma função adiante para createAsset/findAssetsByJob.
  // Nunca apareceu porque todo chamador existente passava `db` — e o primeiro
  // que não passasse quebraria longe daqui.
  const database_ = db || (await import('../domain/db.js')).database();
  const {
    createAsset, findAssetByFile, findAssetsByJob, linkAssetToJob,
  } = await import('../domain/index.js');

  // Verifica se Asset já existe para esse job (idempotência normal)
  const existing = findAssetsByJob(jobId, database_);
  if (existing && existing.length > 0) {
    return existing[0];
  }

  // ── o mesmo arquivo físico, registrado por outro caminho ────────────────
  //
  // `(projectId, filename)` e `(projectId, jobId)` identificam a MESMA coisa,
  // porque o nome do arquivo publicado é o jobId mais a extensão. Mas o
  // backfill varre o disco e registra por arquivo, sem passar por aqui — então
  // ele pode ter chegado primeiro, e nesse caso já existe um Asset para este
  // arquivo que a busca por jobId acima não encontrou.
  //
  // Criar outro seria registrar duas vezes um arquivo que só existe uma. O
  // certo é adotar o que está lá e anotar de qual job ele veio. `linkAssetToJob`
  // recusa adotar um Asset que já pertence a outro job — aí não é reconciliação,
  // é premissa quebrada, e vira erro.
  const nomeArquivo = job.result?.filename ?? null;
  if (nomeArquivo) {
    const doArquivo = findAssetByFile(projectId, nomeArquivo, database_);
    if (doArquivo) {
      return linkAssetToJob(doArquivo.id, jobId, database_);
    }
  }

  // Tenta criar novo Asset com metadata do job
  try {
    const asset = createAsset({
      projectId,
      kind: job.kind,
      jobId,
      // O nome do arquivo REALMENTE publicado — o mesmo que `mediaUrl` serve e
      // o mesmo que `resolveMediaPath` usa para achar os bytes no disco.
      //
      // Ficava `null` aqui, e isso quebrava a ponte i2v do PASSO 6.1: um Asset
      // de imagem criado pelo agente não podia ser usado como `sourceAssetId`,
      // porque `resolveMediaPath(kind, projectId, null)` não resolve nada.
      filename: nomeArquivo,
      url: mediaUrl || null,
      mimeType: mimeDoArquivoPublicado(job),
      bytes,
      width,
      height,
      durationSeconds,
      prompt: job.prompt || null,
      seed: job.seed || null,
      modelId: job.workflowId || null,
      derivedFromAssetId: derivedFromAssetId || null,
      status: 'pendente',
      createdAt: Date.now(),
    }, database_);

    return asset;
  } catch (err) {
    // Se é violação UNIQUE(projectId, jobId), outro caller ganhou a corrida.
    // Recarregamos o Asset que foi criado e retornamos idempotentemente.
    // Corrida: outro caller criou o Asset entre a busca e o INSERT. Pode
    // aparecer de duas formas — violação de UNIQUE no SQLite, ou o DomainError
    // que `createAsset` levanta ao encontrar o arquivo já registrado. As duas
    // significam a mesma coisa, e a resposta é a mesma: recarregar e devolver
    // quem ganhou.
    const corridaDeArquivo = err.name === 'DomainError'
      && /já está registrado/i.test(err.message || '');
    const corridaDeIndice = err.code === 'ERR_SQLITE_ERROR'
      && err.message?.includes('UNIQUE');

    if (corridaDeIndice || corridaDeArquivo) {
      const porJob = findAssetsByJob(jobId, database_);
      if (porJob && porJob.length > 0) return porJob[0];

      if (nomeArquivo) {
        const porArquivo = findAssetByFile(projectId, nomeArquivo, database_);
        // `linkAssetToJob` recusa se o vencedor pertencer a outro job — e essa
        // recusa deve subir, não virar sucesso silencioso.
        if (porArquivo) return linkAssetToJob(porArquivo.id, jobId, database_);
      }
    }
    // Não é a corrida esperada: é falha real de banco ou de storage.
    //
    // Propagar `err` cru levaria mensagem de SQLite (nome de tabela, de índice,
    // caminho do arquivo do banco) até o handler da tool, que a repassa ao
    // agente. Vira GenerationError com texto nosso; o original fica no
    // `detail`, que só o log do servidor lê.
    //
    // O que NÃO acontece aqui: devolver um Asset nulo fingindo sucesso.
    throw new GenerationError(
      'Não foi possível registrar o resultado da geração.',
      { jobId, projectId, causa: err?.message || String(err) },
    );
  }
}
