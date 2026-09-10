// A geração da voz de uma cena — do texto gravado ao arquivo publicado.
//
// PASSO 14-C2. É o primeiro passo em que o Showrunner realmente sintetiza voz.
//
//     Scene.narration  (texto autoritativo, PASSO 12)
//            ↓  snapshot + impressão   (PASSO 14-A)
//     generation_job(kind='audio')     (livro-razão de sempre)
//            ↓
//     Narration Audio Take             (PASSO 14-B, já ligado ao job)
//            ↓  provider de voz
//     arquivo real, validado pelo ffprobe
//            ↓
//     Asset(kind='audio')              (PASSO 14-C1)
//            ↓  conclusão central
//     take.assetId + seleção automática, quando for o caso
//
// ── A ordem, que é a regra inteira ─────────────────────────────────────────
//
// Registrar ANTES de submeter. O take nasce apontando para o job antes de uma
// única amostra ser sintetizada, e é isso que garante que nunca exista voz
// sendo produzida sem dono. Se o registro falhar, nada é submetido — o
// contrário deixaria trabalho real rodando para um take que não existe.
//
// É a mesma ordem de `startGeneration`, e pela mesma razão. O que muda é que
// aqui o snapshot do TEXTO entra junto: o take guarda a impressão do parágrafo
// de que ele nasceu, e é ela que responde, depois, se a voz ainda serve.
//
// ── Por que o turno não espera ─────────────────────────────────────────────
//
// Porque o tempo do turno não pode ser o tempo da geração. Mesmo com um
// sintetizador rápido, `startNarrationGeneration` devolve assim que o estado
// durável existe: quem conclui é a mesma conclusão central da imagem e do
// vídeo, e ela não depende de ninguém vivo no processo que começou.

import path from 'node:path';
import { rm } from 'node:fs/promises';

import { DomainError } from '../domain/db.js';
import { sceneNarration } from '../domain/narration.js';
import { getProductionScene, getProductionPlan } from '../domain/production.js';
import { createNarrationAudioTake } from '../domain/sceneAudio.js';
import {
  createGenerationJobRecord, completeGenerationJob, setGenerationJobState,
} from '../domain/generationJobs.js';
import { JOB_STATES } from './jobStates.js';
import { mediaTempPath, publishMediaFile } from '../comfy/storage.js';
import { probe } from '../export/ffmpeg.js';
import { newJobId } from '../comfy/provider.js';
import { ttsProvider } from '../tts/provider.js';
// O sintetizador que esta instalação embarca. A escolha mora AQUI, no ponto de
// composição, e não dentro da fronteira: `provider.js` define o que um provider
// tem de saber fazer, e não qual deles o produto usa. Trocar de sintetizador é
// trocar esta linha.
import { piperProvider } from '../tts/piper.js';
import { logInfo, logWarn } from '../logs/logger.js';
import { CHANNELS, STAGES } from '../logs/stages.js';

/**
 * O identificador de "workflow" de uma narração.
 *
 * `generation_jobs.workflowId` é NOT NULL e existe para resolver o descriptor
 * do ComfyUI. Uma narração não tem grafo — e é DE PROPÓSITO que este valor não
 * resolve em `getWorkflow`: é ele que faz a reconciliação do ComfyUI reconhecer
 * o trabalho como não sendo dela. Ver `reconcile.js`.
 */
export const NARRATION_WORKFLOW_ID = 'narration-tts';

/**
 * O provider de voz padrão da instalação.
 *
 * Construí-lo não exige que o sintetizador esteja configurado: quem responde
 * isso é `available()`, e sem `PIPER_HOME` a síntese recusa cedo, com uma
 * mensagem que diz o que falta. Ver `lib/server/tts/piper.js`.
 */
function providerPadrao() {
  return piperProvider();
}

/**
 * Sintetiza a narração de uma cena.
 *
 * Endereçada como todo o resto do planejamento: `projectId` (do contexto) +
 * `ordinal` da cena. O chamador NÃO escolhe texto, impressão, número do take,
 * job, Asset, voz, modelo nem caminho — tudo isso é do servidor, e é o que
 * torna cross-project impossível por construção.
 *
 * Devolve assim que o trabalho tem registro durável; a conclusão vem depois.
 */
export async function startNarrationGeneration(
  { projectId, ordinal } = {},
  { db = null, deps = {} } = {},
) {
  if (!projectId) throw new DomainError('Toda geração exige projectId.', {});

  const banco = db || (await import('../domain/db.js')).database();
  const {
    provider = ttsProvider(providerPadrao()),
    despachar = executarNarracao,
    novoJobId = newJobId,
  } = deps;

  const cena = getProductionScene(projectId, ordinal, banco);
  if (!cena) {
    throw new DomainError(`Este projeto não tem uma cena ${ordinal}.`, { ordinal });
  }

  // ── o snapshot ──────────────────────────────────────────────────────────
  //
  // O texto e a impressão saem daqui, JUNTOS e do banco, e é este par que vai
  // ao provider e ao take. Ler o texto num lugar e a impressão em outro abriria
  // a janela exata que este passo existe para fechar: uma voz gravada com o
  // texto novo e carimbada com a impressão do velho.
  const narracao = sceneNarration(projectId, ordinal, banco);
  if (!narracao.hasNarration) {
    throw new DomainError(
      `A cena ${cena.ordinal} não tem narração escrita para gravar uma voz. `
      + 'Escreva a narração da cena e tente de novo.',
      { ordinal: cena.ordinal },
    );
  }

  const jobId = novoJobId();

  // 1. o livro-razão. Falhar aqui é falhar antes de existir trabalho nenhum.
  createGenerationJobRecord({
    jobId,
    projectId,
    kind: 'audio',
    workflowId: NARRATION_WORKFLOW_ID,
    threadId: null,
    userMessageId: null,
    derivedFromAssetId: null,
  }, banco);

  // 2. o take, já ligado ao job e carimbado com a impressão do texto.
  //
  // Se ISTO falhar, nada é sintetizado: o job fica em `preparing` sem
  // identificador de executor, que é a situação que a reconciliação já sabe
  // tratar, e nenhum estado novo é inventado para descrevê-la.
  let take;
  try {
    take = createNarrationAudioTake(projectId, ordinal, {}, banco);
    banco.prepare(
      'UPDATE production_scene_audio_takes SET generationJobId = ?, updatedAt = ? WHERE id = ?',
    ).run(jobId, Date.now(), take.id);
  } catch (erro) {
    setGenerationJobState(jobId, JOB_STATES.FAILED, {
      db: banco,
      error: 'não foi possível registrar a tentativa de narração',
    });
    throw erro;
  }

  // 3. só agora o trabalho externo. O idioma sai do plano persistido — nunca é
  // pedido a cada geração.
  const plano = getProductionPlan(projectId, banco);
  const trabalho = despachar({
    jobId,
    projectId,
    text: narracao.text,
    language: plano?.language || null,
    provider,
    db: banco,
  });

  // Sem `await`: o turno devolve controle e a síntese segue. O erro é tratado
  // dentro de `executarNarracao`, que o registra no livro-razão — uma promessa
  // solta aqui nunca fica sem quem a observe.
  if (trabalho && typeof trabalho.catch === 'function') {
    trabalho.catch(() => { /* já registrado no job; ver executarNarracao */ });
  }

  return {
    jobId,
    kind: 'audio',
    ordinal: cena.ordinal,
    takeNumber: take.takeNumber,
    sourceNarrationFingerprint: take.sourceNarrationFingerprint,
    state: JOB_STATES.PREPARING,
  };
}

/**
 * O trabalho em si: sintetizar, validar, publicar, concluir.
 *
 * Separado de `startNarrationGeneration` para que a fronteira entre "o que o
 * turno espera" e "o que acontece depois" seja visível, e para que um teste
 * possa exercer as duas metades em separado.
 */
export async function executarNarracao({
  jobId, projectId, text, language, provider, db,
}) {
  try {
    setGenerationJobState(jobId, JOB_STATES.RUNNING, { db });

    const temporario = await mediaTempPath('audio', projectId, jobId, '.wav');
    const produzido = await provider.synthesize({
      text, outputPath: temporario, language,
    });

    // ── a prova de que é áudio ────────────────────────────────────────────
    //
    // ffprobe abre o arquivo. É mais forte do que conferir extensão ou número
    // mágico: ele diz se existe FLUXO de áudio e qual a duração. Um HTML de
    // erro renomeado para .wav, um arquivo truncado ou um vídeo fingindo ser
    // som não passam daqui.
    const medida = await probe(produzido.path);
    if (!medida.hasAudio || !(medida.duration > 0) || medida.hasVideo) {
      await rm(produzido.path, { force: true });
      throw new DomainError('O arquivo produzido não é um áudio válido.', {
        temAudio: medida.hasAudio, temVideo: medida.hasVideo, duracao: medida.duration,
      });
    }

    const publicado = await publishMediaFile(
      'audio', projectId, jobId, produzido.path, produzido.extension,
    );

    const { createAsset } = await import('../domain/assets.js');
    const asset = createAsset({
      projectId,
      kind: 'audio',
      jobId,
      filename: path.basename(publicado.path || publicado.filename || ''),
      url: publicado.url,
      mimeType: 'audio/wav',
      bytes: medida.bytes || null,
      // A duração REAL medida, e não a estimada pelo planejamento.
      durationSeconds: medida.duration,
      // A voz nasce de TEXTO, e não de outro Asset. Ver o relatório do 14-C2.
      derivedFromAssetId: null,
    }, db);

    // A conclusão central: é ela que liga o Asset ao take e aplica a política
    // de seleção. Nenhuma lógica de seleção mora aqui.
    completeGenerationJob(jobId, { assetId: asset.id, db });

    logInfo(STAGES.GENERATION_LEDGER, 'Narração sintetizada.', {
      channel: CHANNELS.COMFY,
      jobId,
      detail: { duracao: medida.duration, bytes: medida.bytes },
    });

    return asset;
  } catch (erro) {
    // A mensagem pública é provider-neutral; o detalhe técnico fica no log.
    setGenerationJobState(jobId, JOB_STATES.FAILED, {
      db,
      error: 'não foi possível gerar a narração',
    });
    logWarn(STAGES.GENERATION_LEDGER, 'A síntese de narração falhou.', {
      channel: CHANNELS.COMFY,
      jobId,
      detail: { causa: erro?.message || String(erro) },
    });
    throw erro;
  }
}

/**
 * O que fazer com uma narração que estava em voo quando o processo morreu.
 *
 * ── A limitação, dita em voz alta ───────────────────────────────────────────
 *
 * O sintetizador local é um processo FILHO deste. Ele não tem fila, não tem
 * identificador durável do lado de lá e não sobrevive a um reinício: quando o
 * Showrunner cai, a síntese cai junto, e não há a quem perguntar o que houve.
 *
 * Isso é o oposto do ComfyUI, que mantém histórico e fila próprios — e é por
 * isso que a reconciliação dele não serve aqui.
 *
 * ── Por que ORPHANED, e por que NUNCA regerar sozinho ──────────────────────
 *
 * `orphaned` é exatamente o que aconteceu: o Showrunner sabe que começou algo e
 * não tem mais como saber o desfecho. Não é falha (ninguém observou o
 * sintetizador falhar) e não é cancelamento (ninguém pediu para parar).
 *
 * Regerar automaticamente seria a saída fácil e a errada: o processo pode ter
 * morrido DEPOIS de o áudio ficar pronto, e o usuário acabaria com duas vozes
 * para o mesmo texto sem ter pedido a segunda. "Não consigo recuperar, então
 * vou gerar de novo" troca uma incerteza por um fato indesejado.
 *
 * O take permanece, ligado ao job, sem Asset — evidência de que a tentativa
 * existiu. Pedir de novo é decisão de quem produz, não do arranque.
 *
 * Nenhum estado novo: `orphaned` já existia e já significa isto.
 */
export function reconcileNarrationJobs({ db = null } = {}) {
  const banco = db;
  const abertos = banco.prepare(`
    SELECT jobId FROM generation_jobs
     WHERE kind = 'audio' AND state NOT IN ('done', 'failed', 'cancelled', 'orphaned')
     ORDER BY createdAt ASC
  `).all();

  const orfaos = [];
  for (const job of abertos) {
    setGenerationJobState(job.jobId, JOB_STATES.ORPHANED, {
      db: banco,
      error: 'a síntese de voz não sobreviveu ao reinício do servidor',
    });
    orfaos.push(job.jobId);
  }

  if (orfaos.length) {
    logInfo(STAGES.GENERATION_LEDGER, 'Narrações interrompidas por reinício.', {
      channel: CHANNELS.COMFY,
      detail: { orfaos: orfaos.length },
    });
  }

  return { orfaos };
}
