// Reconciliação de arranque — os trabalhos que terminaram enquanto estávamos fora.
//
// ── O buraco que isto fecha ─────────────────────────────────────────────────
//
// Desde o PASSO 10.3 uma geração vira linha no banco antes de sair para o
// executor. Mas a linha sozinha não faz nada: se o processo do Showrunner cai
// no meio, o trabalho continua rodando do lado do executor, termina, e o
// resultado fica lá — sem Asset, sem chegar à conversa, e com a linha parada
// num estado aberto para sempre.
//
// Este módulo lê essas linhas quando o processo volta e pergunta ao executor o
// que aconteceu com elas.
//
// ── O que ele NÃO faz, e é deliberado ──────────────────────────────────────
//
// Ele **nunca submete**. Reconciliar é observar: `/prompt` não é chamado, e um
// teste varre este arquivo para garantir. Um reinício que regerasse trabalho
// gastaria GPU sem ninguém pedir e produziria uma segunda imagem para o mesmo
// pedido.
//
// Ele **não recria acompanhamento** para o que já acabou — não há o que
// acompanhar. Para o que ainda está em voo, recria: ver abaixo.
//
// ── O que ele passou a fazer ────────────────────────────────────────────────
//
// Além do que já terminou, ele agora encontra o que AINDA ESTÁ VIVO. A fila do
// executor é lida junto com o histórico, e um trabalho que aparece nela volta a
// ser acompanhado pelo mecanismo do PASSO 9 — o mesmo, não um segundo. O
// trabalho continua de onde parou, sem o navegador e sem o serviço de
// raciocínio: nenhum dos dois precisa estar de pé.
//
// E só então `orphaned` pode existir. Ele exige as DUAS consultas terem sido
// respondidas: o executor precisa dizer, de forma válida, que não conhece
// aquele trabalho. Executor fora do ar não é trabalho perdido — é executor fora
// do ar, e nesse caso nada é declarado.
//
// ── Por que ele conhece a conversa ─────────────────────────────────────────
//
// Porque a linha do livro-razão já sabe de qual turno o trabalho era — a
// âncora do PASSO 10.0 está gravada nela. Restaurar esse vínculo é terminar o
// que a linha registrou, e `attachMessageAssets` é a única porta guardada entre
// mensagem e Asset (ela confere o projeto). Repetir essa checagem aqui seria
// criar uma segunda verdade sobre quem pode ver o quê.

import { historyList, queue as filaDoExecutor } from '../comfy/client.js';
import { createJob, getJob, updateJob } from '../comfy/jobs.js';
import { interpretHistory, STATES } from '../comfy/status.js';
import { findMediaByJobId } from '../comfy/storage.js';
import { recoverableOutputs } from './outputs.js';
import { getWorkflow } from './workflows/registry.js';
import { database } from '../domain/db.js';
import {
  bindGenerationJobMessage, getGenerationJobRecord, listOpenGenerationJobs,
  markGenerationJobSubmitted, setGenerationJobState,
} from '../domain/generationJobs.js';
import { JOB_STATES } from '../domain/generationJobStates.js';
import { attachMessageAssets } from '../agent/threads.js';
import { CHANNELS, STAGES } from '../logs/stages.js';
import { logInfo, logWarn } from '../logs/logger.js';

/**
 * Quantas execuções do histórico do executor pedir.
 *
 * Proporcional ao que temos em aberto, com um piso: uma instalação movimentada
 * empurra as nossas entradas para fora de uma janela pequena, e uma janela
 * ilimitada pediria o histórico inteiro a cada arranque.
 *
 * É uma limitação REAL e conhecida: um trabalho antigo o bastante para sair da
 * janela não é reencontrado por aqui. Ele continua aberto — o que é honesto — e
 * o arquivo publicado, se existir, ainda o resgata pelo segundo caminho.
 */
export function janelaDeHistorico(abertos) {
  return Math.max(50, 4 * abertos);
}

/**
 * Reconcilia os trabalhos abertos com o que o executor sabe.
 *
 * Idempotente por construção: tudo o que ela escreve passa pelas operações do
 * livro-razão, que são de escrita única, e pela finalização, que devolve o
 * Asset existente em vez de criar outro. Rodar duas vezes é rodar uma.
 *
 * @returns {{ recuperados, falhados, abertos, indisponivel }}
 */
export async function reconcileGenerationJobs({ db = database(), deps = {} } = {}) {
  const {
    historico = historyList,
    fila = filaDoExecutor,
    concluir = concluirPelaFacade,
    localizarArquivo = findMediaByJobId,
    acompanhar = acompanharPeloWatcher,
  } = deps;

  // ── só o que ESTE executor sabe executar ────────────────────────────────
  //
  // `listOpenGenerationJobs` filtra por ESTADO, e não por tipo — ele é do
  // livro-razão, que é comum a todos os tipos. Esta reconciliação, porém, é a
  // do ComfyUI: ela pergunta ao histórico e à fila DELE.
  //
  // Uma narração (PASSO 14-C2) nunca esteve nessa fila, então as duas perguntas
  // voltariam vazias e o passo 6 declararia `orphaned` — um veredito sobre uma
  // GPU que nunca viu aquele trabalho. Filtrar aqui é o que impede o executor
  // de imagem/vídeo de opinar sobre um trabalho que não é dele.
  //
  // Quem cuida do áudio interrompido é `reconcileNarrationJobs`.
  const abertos = listOpenGenerationJobs({}, db).filter((job) => job.kind !== 'audio');

  logInfo(STAGES.GENERATION_LEDGER, 'Reconciliação de arranque iniciada.', {
    channel: CHANNELS.COMFY,
    detail: { abertos: abertos.length },
  });

  // Nada em aberto: nem vale acordar o executor. É o caso comum.
  if (!abertos.length) {
    logInfo(STAGES.GENERATION_LEDGER, 'Nada a reconciliar.', { channel: CHANNELS.COMFY });
    return { recuperados: [], falhados: [], abertos: [], indisponivel: false };
  }

  // ── as duas leituras, uma vez cada ────────────────────────────────────────
  //
  // Uma requisição por trabalho aberto seria uma tempestade a cada arranque. As
  // duas respostas viram índice em memória, e o casamento acontece lá.
  //
  // Elas falham de forma INDEPENDENTE, e isso importa: `orphaned` só pode
  // nascer quando as duas responderam. Uma resposta que faltou é ignorância
  // nossa, não desfecho do trabalho.
  const [doHistorico, daFila] = await Promise.all([
    ler('o histórico', abertos, () => historico(janelaDeHistorico(abertos.length))),
    ler('a fila', abertos, () => fila()),
  ]);

  if (doHistorico.falhou && daFila.falhou) {
    // O executor não estar de pé no arranque é normal — ele é outro processo, e
    // pode subir depois. Isso não pode impedir a aplicação de funcionar: os
    // trabalhos ficam abertos e uma reconciliação futura os encontra.
    return {
      recuperados: [], falhados: [], orfaos: [],
      abertos: abertos.map((j) => j.jobId), indisponivel: true,
    };
  }

  const descriptors = descriptorsDe(abertos);
  const porJobId = indexarPorJobId(doHistorico.dados, descriptors);
  const naFila = indexarFila(daFila.dados, descriptors);

  // A evidência só é COMPLETA quando as duas perguntas foram respondidas. Sem
  // isso, "não encontrei" não significa "não existe".
  const evidenciaCompleta = !doHistorico.falhou && !daFila.falhou;

  const recuperados = [];
  const falhados = [];
  const orfaos = [];
  const retomados = [];
  const seguemAbertos = [];

  for (const job of abertos) {
    // eslint-disable-next-line no-await-in-loop
    const desfecho = await reconciliarUm(job, {
      entradas: doHistorico.dados,
      porJobId,
      naFila,
      evidenciaCompleta,
      db,
      concluir,
      localizarArquivo,
      acompanhar,
    });

    if (desfecho === 'recuperado') recuperados.push(job.jobId);
    else if (desfecho === 'falhou') falhados.push(job.jobId);
    else if (desfecho === 'orfao') orfaos.push(job.jobId);
    else if (desfecho === 'retomado') retomados.push(job.jobId);
    else seguemAbertos.push(job.jobId);
  }

  logInfo(STAGES.GENERATION_LEDGER, 'Reconciliação de arranque concluída.', {
    channel: CHANNELS.COMFY,
    detail: {
      recuperados: recuperados.length,
      falhados: falhados.length,
      // Vivos: voltaram a ser acompanhados e seguem daqui em diante sozinhos.
      retomados: retomados.length,
      orfaos: orfaos.length,
      seguemAbertos: seguemAbertos.length,
      evidenciaCompleta,
    },
  });

  return {
    recuperados, falhados, orfaos, retomados, abertos: seguemAbertos, indisponivel: false,
  };
}

/** Uma leitura do executor que pode faltar sem virar decisão. */
async function ler(oQue, abertos, executar) {
  try {
    return { dados: await executar(), falhou: false };
  } catch (erro) {
    logWarn(STAGES.GENERATION_LEDGER, `Não foi possível ler ${oQue} do executor.`, {
      channel: CHANNELS.COMFY,
      detail: { abertos: abertos.length, causa: erro?.message || String(erro) },
    });
    return { dados: null, falhou: true };
  }
}

/**
 * A finalização de verdade, carregada só quando há o que finalizar.
 *
 * ── Por que este import é tardio ────────────────────────────────────────────
 *
 * O gancho de arranque do Next é compilado para mais de um runtime, e a facade
 * arrasta atrás de si o executor inteiro — até `node:child_process`, pelo
 * ffmpeg. Importá-la no topo fazia o pacote do gancho falhar na compilação e
 * derrubava a aplicação com 500 em toda rota. Medido subindo o servidor de
 * desenvolvimento: `Module build failed: UnhandledSchemeError` com o rastro
 * `node:child_process ← ffmpeg ← provider ← facade ← reconcile`.
 *
 * Carregar aqui dentro mantém o topo deste módulo leve — domínio, log e
 * funções puras — e a cadeia pesada só entra em cena quando um trabalho
 * concluído precisa mesmo ser finalizado.
 */
async function concluirPelaFacade(jobId, opcoes) {
  const { finalizeGeneration } = await import('./facade.js');
  return finalizeGeneration(jobId, opcoes);
}

/**
 * O acompanhamento do PASSO 9, carregado tarde pelo mesmo motivo da facade.
 *
 * É o MESMO mecanismo que a conversa usa — não um segundo. Ele tem
 * single-flight por jobId, então retomar um trabalho já acompanhado devolve o
 * acompanhamento existente em vez de abrir outro laço.
 */
async function acompanharPeloWatcher(entrada, opcoes) {
  const { watchJob } = await import('../agent/tools/jobWatch.js');
  return watchJob(entrada, opcoes);
}

/**
 * O índice que fecha a janela de queda entre o `/prompt` e a anotação.
 *
 * Quando o processo cai depois de o executor aceitar e antes de gravarmos o
 * identificador dele, sobra só o nosso `jobId` — e ele está DENTRO do executor,
 * no nome do arquivo de saída, porque é assim que o prefixo é montado na
 * submissão.
 *
 * Uma varredura do histórico inteiro por job seria uma requisição por trabalho
 * aberto. Aqui é uma leitura só, e o casamento acontece em memória.
 */
function descriptorsDe(abertos) {
  const descriptors = new Map();
  for (const job of abertos) {
    if (descriptors.has(job.workflowId)) continue;
    try {
      descriptors.set(job.workflowId, getWorkflow(job.workflowId));
    } catch {
      // Workflow que não existe mais nesta instalação. O trabalho continua
      // aberto: sem o descriptor não há onde procurar a saída dele.
      descriptors.set(job.workflowId, null);
    }
  }
  return descriptors;
}

/**
 * O trabalho na FILA do executor — o que ainda está em voo.
 *
 * As entradas têm a forma `[numero, prompt_id, grafo, …]`, e o grafo é o que
 * submetemos. Dele sai o nosso `jobId`, pelo prefixo de saída — a mesma âncora
 * que o nome do arquivo dá quando o trabalho já terminou, e que fecha a janela
 * de queda entre o aceite e a anotação.
 *
 * O casamento é por identificador, nunca por prompt, posição na fila ou hora
 * aproximada: qualquer um dos três casaria o trabalho errado no dia em que dois
 * pedidos parecidos convivessem.
 */
function indexarFila(fila, descriptors) {
  const porPrompt = new Map();
  const porJobId = new Map();
  if (!fila) return { porPrompt, porJobId, lida: false };

  const listas = [
    [fila.queue_running, true],
    [fila.queue_pending, false],
  ];

  for (const [lista, executando] of listas) {
    for (const item of lista || []) {
      const promptId = item?.[1];
      if (typeof promptId !== 'string') continue;

      const entrada = { promptId, executando };
      if (!porPrompt.has(promptId)) porPrompt.set(promptId, entrada);

      const grafo = item?.[2];
      if (!grafo || typeof grafo !== 'object') continue;

      for (const descriptor of descriptors.values()) {
        if (!descriptor) continue;
        const prefixo = grafo[descriptor.nodeIds.save]?.inputs?.filename_prefix;
        const nosso = jobIdDoPrefixo(prefixo, descriptor.outputPrefix);
        if (nosso && !porJobId.has(nosso)) porJobId.set(nosso, entrada);
      }
    }
  }

  return { porPrompt, porJobId, lida: true };
}

/** `image/showrunner/cinema_x` → `cinema_x`, e só se o prefixo for o nosso. */
function jobIdDoPrefixo(prefixo, esperado) {
  const texto = String(prefixo || '');
  if (!texto || (esperado && !texto.startsWith(`${esperado}/`))) return null;
  const nosso = texto.slice(texto.lastIndexOf('/') + 1);
  return /^[A-Za-z0-9_-]{1,64}$/.test(nosso) ? nosso : null;
}

function indexarPorJobId(entradas, descriptors) {
  const indice = new Map();

  for (const descriptor of descriptors.values()) {
    if (!descriptor) continue;
    const candidatos = recoverableOutputs(entradas, {
      interpret: interpretHistory,
      kind: descriptor.kind,
      saveNodeId: descriptor.nodeIds.save,
      prefix: descriptor.outputPrefix,
      promptNodeId: descriptor.nodeIds.prompt,
    });

    for (const candidato of candidatos) {
      if (candidato.reason || !candidato.jobId) continue;
      if (!indice.has(candidato.jobId)) indice.set(candidato.jobId, candidato);
    }
  }

  return indice;
}

/** Um trabalho aberto, contra o que o executor sabe. */
async function reconciliarUm(job, {
  entradas, porJobId, naFila, evidenciaCompleta, db, concluir, localizarArquivo, acompanhar,
}) {
  // ── 1. o executor conhece este trabalho? ────────────────────────────────
  //
  // Por identificador dele, quando o temos; senão pelo NOSSO, que está no nome
  // do arquivo de saída.
  const doIndice = porJobId.get(job.jobId) || null;
  const naFilaPorNosso = naFila.porJobId.get(job.jobId) || null;
  const naFilaPorDeles = job.providerJobId ? naFila.porPrompt.get(job.providerJobId) : null;
  const vivo = naFilaPorDeles || naFilaPorNosso;

  const providerJobId = job.providerJobId || doIndice?.promptId || vivo?.promptId || null;

  if (!job.providerJobId && providerJobId) {
    // A janela de queda. A escrita é única: se outro caminho já anotou outro
    // identificador, isto é recusado em vez de sobrescrever.
    try {
      markGenerationJobSubmitted(job.jobId, providerJobId, { db });
      logInfo(STAGES.GENERATION_LEDGER, 'Identificador do executor recuperado.', {
        channel: CHANNELS.COMFY,
        jobId: job.jobId,
        detail: { por: doIndice ? 'nome do arquivo' : 'grafo na fila' },
      });
    } catch (erro) {
      logWarn(STAGES.GENERATION_LEDGER, 'Não foi possível anotar o identificador recuperado.', {
        channel: CHANNELS.COMFY,
        jobId: job.jobId,
        detail: { causa: erro?.message || String(erro) },
      });
    }
  }

  const leitura = providerJobId ? interpretHistory(entradas?.[providerJobId]) : null;

  // ── 2. o executor diz que falhou? ───────────────────────────────────────
  if (leitura?.finished && !leitura.success) {
    try {
      setGenerationJobState(job.jobId, JOB_STATES.FAILED, {
        db,
        // Texto de operador, curto. Nada de pilha, nada que vá ao navegador.
        error: leitura.error || 'a execução falhou no executor',
      });
    } catch (erro) {
      logWarn(STAGES.GENERATION_LEDGER, 'Não foi possível anotar a falha recuperada.', {
        channel: CHANNELS.COMFY, jobId: job.jobId, detail: { causa: erro?.message },
      });
      return 'aberto';
    }
    logWarn(STAGES.GENERATION_LEDGER, 'Trabalho recuperado como falho.', {
      channel: CHANNELS.COMFY, jobId: job.jobId,
    });
    return 'falhou';
  }

  // ── 3. terminou com sucesso: reconstruir o bastante para finalizar ──────
  if (leitura?.finished && leitura.success && doIndice?.output) {
    prepararParaFinalizar(job, { comfyOutput: doIndice.output, providerJobId });
    return concluirEAmarrar(job, { db, concluir });
  }

  // ── 4. sem ajuda do executor: o arquivo já foi publicado antes da queda? ─
  const publicado = await localizarArquivo(job.kind, job.jobId).catch(() => null);
  if (publicado) {
    // O caminho no disco diz ONDE o arquivo está; ele não decide de quem é.
    // A propriedade vem do livro-razão, sempre — foi a falta disso que fazia a
    // recuperação antiga jogar trabalho recuperado numa pasta "recuperados".
    prepararParaFinalizar(job, {
      providerJobId,
      resultado: { url: publicado.url, filename: publicado.filename, bytes: null },
    });
    logInfo(STAGES.GENERATION_LEDGER, 'Resultado já publicado, adotado do disco.', {
      channel: CHANNELS.COMFY, jobId: job.jobId,
    });
    return concluirEAmarrar(job, { db, concluir });
  }

  // ── 5. está VIVO na fila do executor: retomar o acompanhamento ──────────
  //
  // O histórico vence quando diz que acabou — por isso ele é consultado antes.
  // Aqui o trabalho não terminou, e o que ele precisa é de alguém olhando: sem
  // acompanhamento, a máquina de geração é pull e ele para de andar.
  if (vivo) {
    const estado = vivo.executando ? JOB_STATES.RUNNING : JOB_STATES.QUEUED;
    if (job.state !== estado) {
      try {
        setGenerationJobState(job.jobId, estado, { db });
      } catch (erro) {
        logWarn(STAGES.GENERATION_LEDGER, 'Não foi possível anotar o estado do trabalho vivo.', {
          channel: CHANNELS.COMFY, jobId: job.jobId, detail: { causa: erro?.message },
        });
      }
    }
    return retomarAcompanhamento(job, { db, acompanhar, estado });
  }

  // ── 6. o executor respondeu e não conhece este trabalho ─────────────────
  //
  // Só AQUI o desfecho pode ser declarado, e só com as DUAS respostas em mãos:
  // não está no histórico, não está na fila, e não há arquivo publicado.
  //
  // `orphaned` não é falha e não é cancelamento. É o que ele diz: o Showrunner
  // sabe que começou algo, e o executor não tem mais evidência do desfecho —
  // tipicamente porque ele reiniciou. Inventar `failed` aqui afirmaria uma
  // coisa sobre a GPU que ninguém observou.
  if (evidenciaCompleta) {
    try {
      setGenerationJobState(job.jobId, JOB_STATES.ORPHANED, {
        db,
        error: 'o executor não conhece mais este trabalho',
      });
    } catch (erro) {
      logWarn(STAGES.GENERATION_LEDGER, 'Não foi possível anotar o trabalho como perdido.', {
        channel: CHANNELS.COMFY, jobId: job.jobId, detail: { causa: erro?.message },
      });
      return 'aberto';
    }
    logWarn(STAGES.GENERATION_LEDGER, 'Trabalho sem evidência no executor.', {
      channel: CHANNELS.COMFY, jobId: job.jobId,
    });
    return 'orfao';
  }

  // ── 7. faltou resposta. Ignorância nossa não vira desfecho ──────────────
  return 'aberto';
}

/**
 * Devolve o trabalho vivo ao acompanhamento do PASSO 9.
 *
 * ── Por que reutilizar, e não recriar ───────────────────────────────────────
 *
 * O acompanhamento tem single-flight por `jobId`: se um já existir — porque
 * outra parte do processo o registrou — `watch` devolve o existente em vez de
 * abrir um segundo laço sobre o mesmo trabalho.
 *
 * O contexto vem TODO do livro-razão. Nada é perguntado ao executor, nada é
 * inferido do disco: de quem é o trabalho já estava gravado.
 *
 * ── Sem conversa não há acompanhamento ──────────────────────────────────────
 *
 * O acompanhamento é, por construção, ligado a uma conversa: ele existe para
 * levar o resultado até uma resposta. Um trabalho do estúdio não tem thread, e
 * `watch` recusa — corretamente. O estado dele é reconciliado (fica `queued` ou
 * `running`, que é a verdade), e quem o leva ao fim continua sendo a tela, que
 * consulta em laço. É a capacidade real de hoje, não um esquecimento.
 */
async function retomarAcompanhamento(job, { db, acompanhar, estado }) {
  if (!job.threadId) {
    logInfo(STAGES.GENERATION_LEDGER, 'Trabalho vivo sem conversa: estado reconciliado.', {
      channel: CHANNELS.COMFY, jobId: job.jobId, detail: { estado },
    });
    return 'retomado';
  }

  let marca;
  try {
    marca = await acompanhar({
      jobId: job.jobId,
      kind: job.kind,
      threadId: job.threadId,
      projectId: job.projectId,
    }, { db });
  } catch (erro) {
    logWarn(STAGES.GENERATION_LEDGER, 'Não foi possível retomar o acompanhamento.', {
      channel: CHANNELS.COMFY, jobId: job.jobId, detail: { causa: erro?.message },
    });
    return 'aberto';
  }

  if (!marca) return 'aberto';

  logInfo(STAGES.GENERATION_LEDGER, 'Acompanhamento retomado.', {
    channel: CHANNELS.COMFY,
    jobId: job.jobId,
    detail: { estado, projectId: job.projectId },
  });

  // Quando ele terminar — daqui a segundos ou a minutos — a mídia precisa achar
  // a resposta certa. O acompanhamento recriado não nasceu dentro de um turno,
  // então ele não sabe a qual mensagem pertence; quem sabe é o livro-razão, e é
  // a mesma regra da recuperação: a mensagem amarrada, ou a âncora do turno.
  marca.pronto?.then(() => {
    const depois = getGenerationJobRecord(job.jobId, db);
    if (depois?.assetId) restaurarMensagem(depois, db);
  }).catch(() => { /* o acompanhamento já registra o próprio desfecho */ });

  return 'retomado';
}

/**
 * Recoloca em memória o mínimo que a finalização precisa.
 *
 * O registro em memória morre com o processo; a finalização existente lê dele.
 * O que se reconstrói aqui vem do LIVRO-RAZÃO — projeto, tipo, workflow,
 * linhagem — e do executor apenas a localização do arquivo produzido.
 */
function prepararParaFinalizar(job, { comfyOutput = null, resultado = null, providerJobId = null }) {
  const existente = getJob(job.jobId);

  if (!existente) {
    createJob({
      jobId: job.jobId,
      projectId: job.projectId,
      kind: job.kind,
      workflowId: job.workflowId,
      promptId: providerJobId,
      derivedFromAssetId: job.derivedFromAssetId ?? null,
      state: resultado ? STATES.DONE : STATES.SAVING,
      createdAt: job.createdAt,
      submittedAt: job.submittedAt ?? job.createdAt,
      progress: 1,
      ...(comfyOutput ? { comfyOutput } : {}),
      ...(resultado ? { result: resultado } : {}),
    });
    return;
  }

  // Já existe em memória — o acompanhamento pode estar vivo e a caminho do
  // mesmo desfecho. Só completamos o que falta; nada é sobrescrito.
  const patch = {};
  if (comfyOutput && !existente.comfyOutput) patch.comfyOutput = comfyOutput;
  if (resultado && !existente.result) {
    patch.result = resultado;
    patch.state = STATES.DONE;
  }
  if (providerJobId && !existente.promptId) patch.promptId = providerJobId;
  if (Object.keys(patch).length) updateJob(job.jobId, patch);
}

/** Publica, cria o Asset, fecha o registro e devolve a mídia à conversa. */
async function concluirEAmarrar(job, { db, concluir }) {
  try {
    await concluir(job.jobId, { db });
  } catch (erro) {
    // Falhar em finalizar não é falhar a geração: o arquivo pode estar lá e a
    // próxima tentativa resolve. Nada de desfecho inventado.
    logWarn(STAGES.GENERATION_LEDGER, 'Não foi possível concluir o trabalho recuperado.', {
      channel: CHANNELS.COMFY, jobId: job.jobId, detail: { causa: erro?.message },
    });
    return 'aberto';
  }

  const depois = getGenerationJobRecord(job.jobId, db);
  if (depois?.state !== JOB_STATES.DONE || !depois.assetId) return 'aberto';

  restaurarMensagem(depois, db);

  logInfo(STAGES.GENERATION_LEDGER, 'Trabalho recuperado e concluído.', {
    channel: CHANNELS.COMFY,
    jobId: job.jobId,
    detail: {
      projectId: depois.projectId,
      assetId: depois.assetId,
      naConversa: Boolean(depois.assistantMessageId),
    },
  });

  return 'recuperado';
}

/**
 * Devolve a mídia recuperada à resposta que a pediu.
 *
 * ── A regra do seq + 1 ──────────────────────────────────────────────────────
 *
 * Quando a resposta do assistente já está amarrada, é ela. Quando não está —
 * porque o turno morreu antes de gravá-la — a âncora do PASSO 10.0 resolve:
 * um turno É a mensagem de usuário que o iniciou, e a resposta daquele turno é
 * a mensagem IMEDIATAMENTE seguinte, `seq + 1`.
 *
 * O papel é conferido. Se `seq + 1` for outra fala do usuário, aquele turno não
 * respondeu, e nada é anexado — é o caso de quem recarregou a página e falou de
 * novo. Se não existir, idem.
 *
 * O que NUNCA se usa: a última mensagem, o maior `seq`, o texto, a hora
 * aproximada. Qualquer uma delas colocaria a imagem numa fala onde ninguém a
 * pediu.
 */
function restaurarMensagem(job, db) {
  if (!job.assetId) return;

  if (job.assistantMessageId) {
    anexar(job.assistantMessageId, job.assetId, job.jobId, db);
    return;
  }

  // Sem conversa não há o que restaurar, e isso é sucesso completo: a geração
  // do estúdio nasce sem thread, e o Asset pertence ao projeto.
  if (!job.threadId || !job.userMessageId) return;

  const doUsuario = db.prepare(
    'SELECT seq FROM agent_messages WHERE id = ? AND threadId = ?',
  ).get(job.userMessageId, job.threadId);
  if (!doUsuario) return;

  const seguinte = db.prepare(
    'SELECT id, role FROM agent_messages WHERE threadId = ? AND seq = ?',
  ).get(job.threadId, Number(doUsuario.seq) + 1);

  if (!seguinte || seguinte.role !== 'assistant') return;

  try {
    bindGenerationJobMessage(job.jobId, seguinte.id, { db });
  } catch (erro) {
    logWarn(STAGES.GENERATION_LEDGER, 'Não foi possível reamarrar a resposta do turno.', {
      channel: CHANNELS.COMFY, jobId: job.jobId, detail: { causa: erro?.message },
    });
    return;
  }

  anexar(seguinte.id, job.assetId, job.jobId, db);
}

/** A mídia na mensagem. `attachMessageAssets` confere o projeto e deduplica. */
function anexar(messageId, assetId, jobId, db) {
  try {
    attachMessageAssets(messageId, [assetId], db);
  } catch (erro) {
    logWarn(STAGES.GENERATION_LEDGER, 'Não foi possível devolver a mídia à conversa.', {
      channel: CHANNELS.COMFY, jobId, detail: { causa: erro?.message },
    });
  }
}

// ── uma vez por processo ────────────────────────────────────────────────────
//
// O Fast Refresh do Next recarrega módulos, e o gancho de arranque pode ser
// chamado de novo. Duas reconciliações simultâneas no mesmo processo não
// corromperiam nada — tudo o que elas escrevem é de escrita única — mas
// pediriam o histórico duas vezes e disputariam a mesma finalização à toa.
//
// A promessa fica em `globalThis` pelo mesmo motivo que o registro de jobs e o
// de acompanhamentos ficam.

const CHAVE = Symbol.for('showrunner.generation.reconcile');

/**
 * A reconciliação desta instalação, uma vez só.
 *
 * Chamar de novo devolve a MESMA promessa enquanto ela estiver correndo. Depois
 * que ela termina, o resultado fica guardado: um segundo arranque no mesmo
 * processo não existe.
 */
export function reconcileOnce(opcoes = {}) {
  if (!globalThis[CHAVE]) {
    globalThis[CHAVE] = reconcileGenerationJobs(opcoes).catch((erro) => {
      // Nada aqui pode derrubar quem chamou: o gancho de arranque roda em
      // segundo plano, e uma reconciliação que falha não impede a aplicação de
      // servir.
      logWarn(STAGES.GENERATION_LEDGER, 'A reconciliação de arranque falhou.', {
        channel: CHANNELS.COMFY,
        detail: { causa: erro?.message || String(erro) },
      });
      return { recuperados: [], falhados: [], abertos: [], indisponivel: true };
    });
  }
  return globalThis[CHAVE];
}

/** Esquece a execução desta instalação. Só para teste. */
export function resetReconcileOnce() {
  delete globalThis[CHAVE];
}
