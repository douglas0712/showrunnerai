// ComfyUIProvider real (lado servidor).
//
// Orquestra: carregar workflow → aplicar parâmetros em memória → submeter →
// acompanhar → localizar o MP4 → copiar para o armazenamento do Showrunner.
//
// O estado é decidido por polling HTTP (/queue e /history); o websocket só
// acrescenta progresso fino.

import { open, rm, writeFile } from 'node:fs/promises';
import * as comfy from './client.js';
import { probe as probeFile } from '../export/ffmpeg.js';
import { ComfyError } from './client.js';
import { ensureEventStream, eventStreamStatus } from './events.js';
import { allJobs, createJob, clientId, getJob, updateJob } from './jobs.js';
import { findMediaByJobId, mediaTempPath, publishMediaFile } from './storage.js';
import {
  STATES, STATE_LABELS, findInQueue, interpretHistory, isTerminal,
} from './status.js';
import { WorkflowError } from './workflow.js';
import { DEFAULT_VIDEO_WORKFLOW_ID, getWorkflow } from '../generation/workflows/registry.js';
import { findMediaOutput, recoverableOutputs } from '../generation/outputs.js';
import {
  canonicalExtensionFor, extensionOf, extensionsFor, extensionSourceFor, isStorableExtension,
} from '../generation/mediaKinds.js';
import {
  detectImageType, FRAME_ROLES, frameLogInfo, roleLabel, UploadError, validateFrame,
} from './images.js';
import { COMFY_BASE_URL } from './config.js';
import { runInJobContext, updateJobContext } from '../logs/context.js';
import { logError, logInfo, logWarn } from '../logs/logger.js';
import { STAGES } from '../logs/stages.js';
import { nomeDeArquivo, resumirFila, resumirProbe, sanitizeChecks } from '../logs/sanitize.js';

/**
 * Testa a conexão de verdade: estatísticas, fila, presença do nó do MiniMax H3
 * e dos quatro arquivos de modelo, e leitura do workflow.
 */
export async function testConnection({ workflowId = DEFAULT_VIDEO_WORKFLOW_ID } = {}) {
  const descriptor = getWorkflow(workflowId);
  // O nó característico e os modelos exigidos vêm do descriptor, não de uma
  // constante global: outro workflow traz as próprias exigências.
  const noPrincipal = descriptor.nodeClasses[descriptor.nodeIds.prompt];
  const caminhoDoWorkflow = descriptor.resolvePath();

  const checks = [];
  let ok = true;

  const registrar = (nome, sucesso, detalhe) => {
    checks.push({ nome, ok: sucesso, detalhe });
    if (!sucesso) ok = false;
  };

  let stats = null;
  try {
    stats = await comfy.systemStats();
    const dispositivo = stats?.devices?.[0];
    registrar(
      'Servidor ComfyUI',
      true,
      `versão ${stats?.system?.comfyui_version || '?'} · ${dispositivo?.name || 'dispositivo desconhecido'}`,
    );
  } catch (error) {
    registrar('Servidor ComfyUI', false, error.message);
    logError(STAGES.CONNECTION_CHECK, error, { detail: { baseUrl: COMFY_BASE_URL, checks: sanitizeChecks(checks) } });
    return {
      ok: false,
      performedRequest: true,
      baseUrl: COMFY_BASE_URL,
      checks,
      message: `Sem resposta do ComfyUI em ${COMFY_BASE_URL}.`,
    };
  }

  try {
    const fila = await comfy.queue();
    const rodando = fila?.queue_running?.length || 0;
    const pendente = fila?.queue_pending?.length || 0;
    registrar('Fila', true, rodando || pendente ? `${rodando} em execução, ${pendente} pendente(s)` : 'vazia');
  } catch (error) {
    registrar('Fila', false, error.message);
  }

  let info = null;
  try {
    info = await comfy.objectInfo(noPrincipal);
    registrar(`Nó ${noPrincipal}`, Boolean(info?.[noPrincipal]), 'disponível no servidor');
  } catch (error) {
    registrar(`Nó ${noPrincipal}`, false, error.message);
  }

  // Os quatro arquivos precisam estar nas listas que o próprio servidor publica.
  try {
    const [unet, clip, vae] = await Promise.all([
      comfy.objectInfo('UNETLoader'),
      comfy.objectInfo('CLIPLoader'),
      comfy.objectInfo('VAELoader'),
    ]);
    const listas = {
      unet_name: unet?.UNETLoader?.input?.required?.unet_name?.[0] || [],
      clip_name: clip?.CLIPLoader?.input?.required?.clip_name?.[0] || [],
      vae_name: vae?.VAELoader?.input?.required?.vae_name?.[0] || [],
    };
    const faltando = descriptor.requiredModels.filter((m) => !(listas[m.field] || []).includes(m.file));
    registrar(
      'Arquivos do MiniMax H3',
      faltando.length === 0,
      faltando.length ? `faltando: ${faltando.map((m) => m.file).join(', ')}` : 'os 4 arquivos estão presentes',
    );
  } catch (error) {
    registrar('Arquivos do MiniMax H3', false, error.message);
  }

  try {
    const template = await descriptor.loadTemplate();
    registrar('Workflow', true, `${Object.keys(template).length} nós validados em ${nomeDeArquivo(caminhoDoWorkflow)}`);
    // O caminho completo fica só aqui, no console do processo: é o que resolve
    // "está lendo o arquivo errado?" sem publicar a árvore de diretórios da
    // máquina na interface, no arquivo de log e no JSON baixado.
    console.info(`[showrunner] workflow lido de ${caminhoDoWorkflow}`);
  } catch (error) {
    registrar('Workflow', false, error.message);
    console.info(`[showrunner] falha ao ler o workflow em ${caminhoDoWorkflow}: ${error.message}`);
  }

  ensureEventStream();

  const mensagem = ok
    ? 'ComfyUI conectado e pronto para gerar com o MiniMax H3.'
    : 'O ComfyUI respondeu, mas há verificações pendentes.';

  const reprovados = checks.filter((c) => !c.ok);
  if (ok) {
    logInfo(STAGES.CONNECTION_CHECK, mensagem, { detail: { baseUrl: COMFY_BASE_URL, checks: sanitizeChecks(checks) }, http: null });
  } else {
    logWarn(STAGES.CONNECTION_CHECK, `${mensagem} Reprovados: ${reprovados.map((c) => c.nome).join(', ')}.`, {
      detail: { baseUrl: COMFY_BASE_URL, checks: sanitizeChecks(checks) },
      http: null,
    });
  }

  return {
    ok,
    performedRequest: true,
    baseUrl: COMFY_BASE_URL,
    checks,
    eventStream: eventStreamStatus(),
    message: mensagem,
  };
}

/** Identificador de job. Exposto para que a rota já valide sob o mesmo id. */
export function newJobId() {
  return `cinema_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Descriptor do workflow que produziu (ou vai produzir) este job.
 *
 * ── A fronteira entre job novo e job legado ────────────────────────────────
 *
 * JOB NOVO — criado por `submitGeneration` ou adotado por `recoverFromHistory`
 * depois desta etapa. Carrega SEMPRE `workflowId` e `kind`, ambos copiados do
 * descriptor registrado. Aqui ele resolve pelo próprio `workflowId`, e um id
 * desconhecido é ERRO — nunca cai no padrão. Não existe fallback silencioso
 * para job novo.
 *
 * JOB LEGADO — criado antes desta etapa e ainda vivo no registro em memória.
 * Não tem os campos, porque quando nasceu só existia um workflow. Para ele, e
 * só para ele, vale o workflow de vídeo padrão: era literalmente o único que
 * podia tê-lo produzido. É compatibilidade, não conveniência, e desaparece
 * sozinha quando o processo reinicia.
 *
 * Em nenhum dos dois casos o nome do modelo é consultado: o tipo de mídia vem
 * sempre de `descriptor.kind`.
 */
export function descriptorForJob(job) {
  // Job novo: a autoridade é o workflowId gravado nele.
  if (job?.workflowId) return getWorkflow(job.workflowId);
  // Job legado: o único workflow que existia quando ele foi criado.
  return getWorkflow(DEFAULT_VIDEO_WORKFLOW_ID);
}

/** O job foi criado antes de os campos de workflow existirem? */
export function isLegacyJob(job) {
  return Boolean(job) && (!job.workflowId || !job.kind);
}

/** Caminho do workflow deste job — só para correlacionar no log. */
function caminhoDoWorkflowDoJob(job) {
  try {
    return descriptorForJob(job).resolvePath();
  } catch {
    return null;
  }
}

/**
 * O arquivo copiado é realmente do tipo que o workflow declarou?
 *
 * Vídeo continua sendo conferido pelo ffprobe — precisa abrir, ter duração e
 * ter fluxo de vídeo. Imagem é conferida pelos bytes iniciais, o mesmo
 * mecanismo que `images.js` usa para os quadros que o usuário envia: extensão
 * e Content-Type não decidem nada.
 */
export async function validarMidia(kind, caminho) {
  if (kind === 'video') return validarMp4(caminho);
  if (kind === 'image') return validarImagem(caminho);
  return { ok: false, motivo: `tipo de mídia sem validação: ${kind}`, probe: null };
}

/**
 * Extensão com que o arquivo será publicado.
 *
 * A regra é do tipo de mídia, não deste módulo: `extensionSource` diz se a
 * autoridade são os bytes detectados ou o nome declarado pelo produtor. É o
 * que garante o invariante de toda mídia publicada — bytes reais, extensão
 * final e MIME servido concordam entre si.
 */
export function extensaoParaPublicar(kind, extensaoDeclarada, validacao) {
  if (extensionSourceFor(kind) !== 'bytes') return extensaoDeclarada;

  const detectado = validacao?.probe?.ext;
  if (!detectado) return extensaoDeclarada;
  return canonicalExtensionFor(kind, detectado);
}

/** Lê os primeiros bytes e confirma o formato pelo número mágico. */
export async function validarImagem(caminho) {
  let handle;
  try {
    handle = await open(caminho, 'r');
    const buffer = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buffer, 0, 32, 0);
    if (bytesRead < 12) return { ok: false, motivo: 'arquivo pequeno demais para ser imagem', probe: null };

    const tipo = detectImageType(buffer.subarray(0, bytesRead));
    if (!tipo) return { ok: false, motivo: 'os bytes não são PNG, JPEG nem WebP', probe: null };

    return { ok: true, motivo: '', probe: { mime: tipo.mime, ext: tipo.ext } };
  } catch (erro) {
    return { ok: false, motivo: `não foi possível ler o arquivo (${erro.message})`, probe: null };
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Prepara e submete uma geração. Não espera o resultado.
 *
 * `jobId` pode vir pronto da rota: assim o evento de validação de parâmetros,
 * emitido antes daqui, já nasce amarrado ao mesmo job.
 */
export async function submitGeneration(params = {}) {
  const {
    prompt, seed = null, durationSeconds, aspect, quality, fps, projectId,
    jobId: jobIdInformado = null,
    frames: quadros = null,
    // O caller informa um ID de workflow, nunca um caminho. O padrão é o
    // workflow de vídeo — o comportamento que a aba Cinema e a aba Vídeo já
    // tinham antes de existir registry.
    workflowId = DEFAULT_VIDEO_WORKFLOW_ID,
    // sourceAssetId: para rastreamento de linhagem (i2v).
    // Será implementado em PASSO 7 com suporte completo ao bridge de arquivo.
    _sourceAssetId = null,
  } = params;

  const jobId = jobIdInformado || newJobId();
  const descriptor = getWorkflow(workflowId);

  return runInJobContext({ jobId, workflow: descriptor.resolvePath(), iniciadoEm: Date.now() }, async () => {
    // ── quadros ───────────────────────────────────────────────────────────
    // Sobem antes do workflow porque o grafo precisa dos nomes que o ComfyUI
    // devolve. Em t2v o laço não roda e nada muda no caminho já validado.
    let referencias;
    try {
      referencias = await enviarQuadros(jobId, quadros);
    } catch (error) {
      logError(error.stage || STAGES.UPLOADING_START_FRAME, error, {
        jobId,
        detail: error.detail || null,
      });
      throw error;
    }

    let graph;
    let meta;
    try {
      const template = await descriptor.loadTemplate();
      ({ graph, meta } = descriptor.patch(template, {
        prompt, seed, durationSeconds, aspect, quality, fps, jobId, frames: referencias,
      }));
    } catch (error) {
      logError(STAGES.PREPARING_WORKFLOW, error, { jobId, detail: error.detail || null });
      throw error;
    }

    logInfo(STAGES.PREPARING_WORKFLOW, `Workflow carregado e parametrizado em modo ${meta.modeLabel}: ${Object.keys(graph).length} nós.`, {
      http: null,
      detail: {
        modo: meta.mode,
        primeiroQuadro: meta.frameFirst,
        ultimoQuadro: meta.frameLast,
        nos: Object.keys(graph).length,
        seed: meta.seed,
        seedTravada: meta.seedLocked,
        frames: meta.frames,
        duracaoPedida: meta.durationRequested,
        duracaoReal: meta.durationActual,
        dentroDaFaixaTreinada: meta.withinTrainedRange,
        aspect: meta.aspect,
        quality: meta.quality,
        megapixels: meta.megapixels,
        fps: meta.fps,
        filenamePrefix: meta.filenamePrefix,
      },
    });

    if (meta.withinTrainedRange === false) {
      logWarn(STAGES.PREPARING_WORKFLOW, `${meta.frames} frames está fora da faixa treinada do modelo (124–362). O resultado pode degradar.`, {
        http: null,
        detail: { frames: meta.frames },
      });
    }

    // `workflowId` e `kind` acompanham o job daqui em diante: é assim que o
    // polling e a finalização sabem que tipo de arquivo procurar, sem
    // consultar o nome do modelo.
    createJob({
      jobId,
      projectId,
      ...meta,
      workflowId: descriptor.id,
      kind: descriptor.kind,
      state: STATES.PREPARING,
      // sourceAssetId para rastreamento de linhagem (i2v)
      derivedFromAssetId: _sourceAssetId || null,
    });

    ensureEventStream();

    let resposta;
    try {
      resposta = await comfy.submitPrompt(graph, clientId());
    } catch (error) {
      updateJob(jobId, { state: STATES.FAILED, error: error.message, finishedAt: Date.now() });
      logError(STAGES.SUBMITTING_TO_COMFYUI, error, { jobId });
      throw error;
    }

    if (resposta?.node_errors && Object.keys(resposta.node_errors).length) {
      const detalhe = JSON.stringify(resposta.node_errors).slice(0, 500);
      updateJob(jobId, { state: STATES.FAILED, error: `O ComfyUI rejeitou o grafo: ${detalhe}`, finishedAt: Date.now() });
      logError(STAGES.SUBMITTING_TO_COMFYUI, 'O ComfyUI rejeitou o grafo.', {
        jobId,
        detail: { node_errors: resposta.node_errors },
        userHint: 'O ComfyUI recusou um ou mais nós do grafo. Costuma ser um arquivo de modelo ausente ou um parâmetro fora da faixa aceita pelo nó.',
      });
      throw new ComfyError('O ComfyUI rejeitou o grafo.', { detail: detalhe });
    }
    if (!resposta?.prompt_id) {
      updateJob(jobId, { state: STATES.FAILED, error: 'O ComfyUI não devolveu prompt_id.', finishedAt: Date.now() });
      logError(STAGES.SUBMITTING_TO_COMFYUI, 'O ComfyUI não devolveu prompt_id.', { jobId });
      throw new ComfyError('O ComfyUI não devolveu prompt_id.');
    }

    updateJob(jobId, {
      promptId: resposta.prompt_id,
      queueNumber: resposta.number ?? null,
      state: STATES.SUBMITTED,
      submittedAt: Date.now(),
    });
    updateJobContext({ promptId: resposta.prompt_id });

    logInfo(STAGES.SUBMITTING_TO_COMFYUI, `Grafo aceito pelo ComfyUI — prompt_id ${resposta.prompt_id}.`, {
      jobId,
      promptId: resposta.prompt_id,
      detail: { numeroNaFila: resposta.number ?? null },
    });

    return publicJob(getJob(jobId));
  });
}

/**
 * Valida e envia os quadros ao ComfyUI, um por vez, com log próprio por papel.
 *
 * Cada quadro passa por três portões antes de virar nó no grafo: o tipo é lido
 * dos bytes, o nome interno é construído a partir do jobId (nunca do nome do
 * usuário) e, depois do upload, confirmamos que o ComfyUI realmente enxerga o
 * arquivo. Sem o terceiro, um upload aceito mas gravado em outro lugar só
 * apareceria como falha lá na execução do grafo, minutos depois.
 *
 * @returns {{first?: object, last?: object}} referências prontas para o grafo
 */
async function enviarQuadros(jobId, quadros) {
  const referencias = {};
  if (!quadros?.first && !quadros?.last) return referencias;

  const ordem = [
    [FRAME_ROLES.FIRST, quadros?.first, STAGES.UPLOADING_START_FRAME],
    [FRAME_ROLES.LAST, quadros?.last, STAGES.UPLOADING_END_FRAME],
  ];

  for (const [role, quadro, stage] of ordem) {
    if (!quadro) continue;

    let info;
    try {
      info = validateFrame(quadro.bytes, {
        role,
        jobId,
        declaredType: quadro.declaredType,
        declaredName: quadro.declaredName,
      });
    } catch (error) {
      error.stage = stage;
      throw error;
    }

    if (info.mismatch) {
      logWarn(stage, `O navegador declarou "${info.declaredType}" mas o conteúdo do ${roleLabel(role)} é ${info.mime}. Vale o conteúdo.`, {
        http: null,
        detail: frameLogInfo(info),
      });
    }

    let resposta;
    try {
      // eslint-disable-next-line no-await-in-loop
      resposta = await comfy.uploadImage({
        bytes: quadro.bytes,
        filename: info.filename,
        subfolder: info.subfolder,
        mime: info.mime,
      });
    } catch (error) {
      error.stage = stage;
      error.detail = frameLogInfo(info);
      throw error;
    }

    const ref = {
      name: resposta?.name || info.filename,
      subfolder: resposta?.subfolder ?? info.subfolder,
      type: resposta?.type || 'input',
    };

    // eslint-disable-next-line no-await-in-loop
    const visivel = await comfy.imageExists(ref);
    if (!visivel) {
      const erro = new ComfyError(
        `O ComfyUI aceitou o ${roleLabel(role)} mas não consegue localizá-lo em input/${ref.subfolder || ''}.`,
      );
      erro.stage = stage;
      erro.detail = { ...frameLogInfo(info), nomeNoComfy: ref.name, subpastaNoComfy: ref.subfolder };
      throw erro;
    }

    logInfo(stage, `${roleLabel(role)} enviado e localizado no ComfyUI: ${ref.name}`, {
      detail: {
        ...frameLogInfo(info),
        nomeNoComfy: ref.name,
        subpastaNoComfy: ref.subfolder,
        confirmadoNoComfy: true,
      },
    });

    referencias[role] = ref;
  }

  return referencias;
}

/** Consulta o estado atual, sem baixar o arquivo. */
export async function pollJob(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  if (isTerminal(job.state)) return publicJob(job);
  if (!job.promptId) return publicJob(job);

  // O polling roda a cada 1,5s: só vira evento o que mudou. Repetir "na fila"
  // trinta vezes encheria o buffer e esconderia justamente o que interessa.
  const estadoAnterior = job.state;
  const posicaoAnterior = job.queuePosition;

  return runInJobContext({ jobId, promptId: job.promptId, workflow: caminhoDoWorkflowDoJob(job) }, async () => {
    // 1) O histórico é definitivo: se está lá com sucesso ou erro, acabou.
    try {
      const historico = await comfy.history(job.promptId);
      const entrada = historico?.[job.promptId];
      const leitura = interpretHistory(entrada);

      if (leitura.finished && leitura.success) {
        logInfo(STAGES.READING_HISTORY, 'A execução consta como concluída no histórico do ComfyUI.');

        const descriptor = descriptorForJob(job);
        const saida = findMediaOutput(leitura.outputs, {
          kind: descriptor.kind,
          saveNodeId: descriptor.nodeIds.save,
        });
        if (saida) {
          logInfo(STAGES.LOCATING_OUTPUT, `Arquivo encontrado no /history: ${saida.filename}`, {
            http: null,
            detail: {
              filename: saida.filename,
              subfolder: saida.subfolder,
              tipo: saida.type,
              nodeId: saida.nodeId,
            },
          });
          updateJob(jobId, { state: STATES.SAVING, comfyOutput: saida, progress: 1 });
          // Copiamos aqui mesmo, no servidor. Antes a cópia dependia de o
          // navegador chamar /api/comfy/result — se o polling parasse (aba
          // trocada, recarregamento, erro de rede), o vídeo terminava no ComfyUI
          // e nunca chegava à aplicação. Agora a conclusão é durável.
          try {
            await finalizeJob(jobId);
          } catch (error) {
            updateJob(jobId, { lastPollError: error.message });
          }
        } else {
          const semArquivo = `A execução terminou, mas nenhum arquivo de ${descriptorForJob(job).kind === 'image' ? 'imagem' : 'vídeo'} foi encontrado nas saídas.`;
          updateJob(jobId, {
            state: STATES.FAILED,
            error: semArquivo,
            finishedAt: Date.now(),
          });
          logError(STAGES.LOCATING_OUTPUT, semArquivo, {
            http: null,
            detail: { nosComSaida: Object.keys(leitura.outputs || {}) },
          });
        }
        return publicJob(getJob(jobId));
      }

      if (leitura.finished && !leitura.success) {
        updateJob(jobId, { state: STATES.FAILED, error: leitura.error, finishedAt: Date.now() });
        logError(STAGES.GENERATING, leitura.error || 'A execução falhou no ComfyUI.', {
          detail: { statusStr: entrada?.status?.status_str || null },
        });
        return publicJob(getJob(jobId));
      }
    } catch (error) {
      // Falha de histórico não é terminal: a fila ainda pode responder.
      updateJob(jobId, { lastPollError: error.message });
      logWarn(STAGES.READING_HISTORY, `Não foi possível ler o histórico: ${error.message} A fila ainda pode responder.`);
    }

    // 2) Onde está na fila.
    try {
      const fila = await comfy.queue();
      const posicao = findInQueue(fila, job.promptId);

      if (posicao.running) {
        const atual = getJob(jobId);
        // O websocket pode ter avançado para uma fase mais específica.
        const estado = [STATES.GENERATING, STATES.DECODING, STATES.SAVING].includes(atual.state)
          ? atual.state
          : STATES.GENERATING;
        updateJob(jobId, { state: estado, queuePosition: 0, startedAt: atual.startedAt || Date.now() });
        if (estadoAnterior !== estado) {
          logInfo(STAGES.GENERATING, `O ComfyUI está executando este prompt — ${STATE_LABELS[estado] || estado}.`, {
            detail: { fila: resumirFila(fila) },
          });
        }
      } else if (posicao.pending) {
        updateJob(jobId, { state: STATES.QUEUED, queuePosition: posicao.position });
        if (estadoAnterior !== STATES.QUEUED || posicaoAnterior !== posicao.position) {
          logInfo(STAGES.QUEUED, `Aguardando na fila do ComfyUI — posição ${posicao.position}.`, {
            detail: { posicao: posicao.position, fila: resumirFila(fila) },
          });
        }
      } else if (job.cancelRequested) {
        updateJob(jobId, { state: STATES.CANCELLED, finishedAt: Date.now() });
        logWarn(STAGES.CANCELLED, 'Cancelamento confirmado: o prompt não está mais na fila.');
      }
    } catch (error) {
      updateJob(jobId, { lastPollError: error.message });
      logWarn(STAGES.QUEUED, `Não foi possível consultar a fila do ComfyUI: ${error.message}`);
    }

    return publicJob(getJob(jobId));
  });
}

/**
 * Baixa o MP4 do ComfyUI e o copia para o armazenamento do Showrunner.
 * Idempotente: chamado duas vezes, devolve o mesmo resultado.
 */
export async function finalizeJob(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  if (job.result) return publicJob(job);

  if (!job.comfyOutput) {
    throw new ComfyError('O job ainda não produziu um arquivo para copiar.');
  }

  // Trava contra chamadas concorrentes: sem ela, duas finalizações do mesmo job
  // gravariam dois arquivos (o segundo com sufixo) para uma única geração.
  if (job.finalizing) {
    return publicJob(job);
  }
  updateJob(jobId, { finalizing: true, state: STATES.SAVING });

  return runInJobContext({ jobId, promptId: job.promptId, workflow: caminhoDoWorkflowDoJob(job), iniciadoEm: Date.now() }, async () => {
    // Este job já foi copiado numa sessão anterior? Adota o arquivo existente em
    // vez de baixar de novo — senão cada reinício do servidor duplicaria o vídeo.
    const kind = descriptorForJob(job).kind;
    const jaGravado = await findMediaByJobId(kind, jobId).catch(() => null);
    if (jaGravado) {
      logInfo(STAGES.PUBLISHING_RESULT, `Este job já tinha arquivo gravado: ${jaGravado.filename}. Adotado sem baixar de novo.`, {
        http: null,
        detail: { url: jaGravado.url, filename: jaGravado.filename, projectId: jaGravado.projectId, adotado: true },
      });
      updateJob(jobId, {
        state: STATES.DONE,
        finishedAt: Date.now(),
        progress: 1,
        projectId: jaGravado.projectId,
        result: {
          url: jaGravado.url,
          filename: jaGravado.filename,
          bytes: null,
          adopted: true,
          sourceFilename: job.comfyOutput.filename,
          sourceSubfolder: job.comfyOutput.subfolder,
        },
      });
      logInfo(STAGES.COMPLETED, 'Geração concluída (arquivo já existente adotado).', { http: null });
      return publicJob(getJob(jobId));
    }

    let bytes;
    let salvo;
    try {
      // 1) Espera o arquivo parar de crescer no ComfyUI.
      const estabilidade = await aguardarFonteEstavel(job.comfyOutput);
      if (estabilidade.estavel) {
        logInfo(STAGES.FINALIZING_FILE, `Arquivo estável no ComfyUI: ${formatarBytes(estabilidade.tamanho)}.`, {
          detail: { bytes: estabilidade.tamanho, estavel: true },
        });
      } else {
        logWarn(STAGES.FINALIZING_FILE, `O arquivo não estabilizou antes do prazo (${estabilidade.motivo}). Copiando mesmo assim e validando depois.`, {
          detail: { bytes: estabilidade.tamanho, estavel: false, motivo: estabilidade.motivo },
        });
      }

      // 2) Baixa, valida e só então publica — com nova tentativa se vier parcial.
      ({ bytes, salvo } = await baixarValidarPublicar(job));
    } catch (error) {
      // Destrava para que o usuário possa tentar de novo sem regerar o vídeo.
      updateJob(jobId, { finalizing: false, state: STATES.FAILED, error: error.message, finishedAt: Date.now() });
      logError(etapaDaFalhaDeCopia(error), error, {
        detail: { tentativas: error.tentativas ?? null },
      });
      throw error;
    }

    updateJob(jobId, {
      state: STATES.DONE,
      finishedAt: Date.now(),
      progress: 1,
      result: {
        url: salvo.url,
        filename: salvo.filename,
        bytes: bytes.length,
        sourceFilename: job.comfyOutput.filename,
        sourceSubfolder: job.comfyOutput.subfolder,
      },
    });

    const concluido = getJob(jobId);
    const decorridoMs = Date.now() - (concluido.submittedAt || concluido.createdAt);
    logInfo(STAGES.COMPLETED, `Geração concluída em ${Math.round(decorridoMs / 1000)}s.`, {
      http: null,
      detail: {
        url: salvo.url,
        filename: salvo.filename,
        bytes: bytes.length,
        duracaoSegundos: concluido.durationActual,
        frames: concluido.frames,
        seed: concluido.seed,
        decorridoMs,
      },
    });

    return publicJob(getJob(jobId));
  });
}

/**
 * A cópia falha em etapas diferentes; a mensagem diz qual. Sem isto, todo
 * problema de finalização apareceria como se fosse do download.
 */
function etapaDaFalhaDeCopia(error) {
  const texto = String(error?.message || '');
  if (/não é reproduzível|ffprobe/i.test(texto)) return STAGES.VALIDATING_WITH_FFPROBE;
  if (/gravar|publicar|EACCES|ENOSPC/i.test(texto)) return STAGES.PUBLISHING_RESULT;
  return STAGES.FINALIZING_FILE;
}

function formatarBytes(total) {
  if (!Number.isFinite(Number(total))) return 'tamanho desconhecido';
  const mb = Number(total) / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.round(Number(total) / 1024)} KB`;
}

/**
 * Recupera resultados que existem no ComfyUI mas ainda não chegaram à aplicação.
 *
 * Varre o histórico procurando saídas cujo `filename_prefix` é desta aplicação e,
 * para cada uma que ainda não foi copiada, adota o job e copia o MP4. Funciona
 * mesmo depois de o servidor reiniciar: a proveniência (prompt, seed, duração,
 * resolução) é reconstruída do grafo que o próprio ComfyUI guardou.
 *
 * Não submete nada e não altera nada no ComfyUI — só lê.
 */
export async function recoverFromHistory({ maxItems = 50, workflowId = DEFAULT_VIDEO_WORKFLOW_ID } = {}) {
  const descriptor = getWorkflow(workflowId);
  let historico;
  try {
    historico = await comfy.historyList(maxItems);
  } catch (error) {
    logWarn(STAGES.READING_HISTORY, `Não foi possível varrer o histórico do ComfyUI: ${error.message}`);
    return { recovered: [], skipped: [], error: error.message };
  }

  const recovered = [];
  const skipped = [];

  const candidatos = recoverableOutputs(historico, {
    interpret: interpretHistory,
    kind: descriptor.kind,
    saveNodeId: descriptor.nodeIds.save,
    prefix: descriptor.outputPrefix,
    promptNodeId: descriptor.nodeIds.prompt,
  });

  for (const { promptId, jobId, output: saida, graph, startedAt, reason } of candidatos) {
    if (reason) {
      skipped.push({ promptId, filename: saida?.filename, motivo: reason });
      continue;
    }

    const existente = getJob(jobId);
    if (existente?.result) {
      skipped.push({ promptId, jobId, motivo: 'já recuperado' });
      continue;
    }

    // Reconstrói o job se o servidor não o conhece mais.
    if (!existente) {
      const meta = descriptor.metaFromGraph?.(graph, jobId) ?? null;
      if (!meta) {
        skipped.push({ promptId, jobId, motivo: 'proveniência não reconstruível' });
        continue;
      }
      createJob({
        ...meta,
        jobId,
        promptId,
        workflowId: descriptor.id,
        kind: descriptor.kind,
        projectId: projectIdFromExisting(jobId),
        state: STATES.SAVING,
        // A cronologia vem do ComfyUI, não do momento da recuperação.
        createdAt: startedAt || Date.now(),
        submittedAt: startedAt || Date.now(),
      });
    }

    updateJob(jobId, { promptId, comfyOutput: saida, state: STATES.SAVING, progress: 1 });

    logInfo(STAGES.LOCATING_OUTPUT, `Resultado órfão encontrado no ComfyUI e adotado: ${saida.filename}`, {
      jobId,
      promptId,
      http: null,
      detail: { filename: saida.filename, subfolder: saida.subfolder, recuperado: true },
    });

    try {
      const finalizado = await finalizeJob(jobId);
      recovered.push(finalizado);
    } catch (error) {
      skipped.push({ promptId, jobId, motivo: error.message });
    }
  }

  return { recovered, skipped, error: null };
}

/**
 * Projeto de destino de um job adotado. Sem registro em memória não há como
 * saber o projeto original, então cai numa pasta dedicada — o arquivo fica
 * acessível e nada é sobrescrito.
 */
function projectIdFromExisting(jobId) {
  return getJob(jobId)?.projectId || 'recuperados';
}

/** Jobs conhecidos pelo servidor, mais novos primeiro. */
export function listJobs({ projectId = null } = {}) {
  return allJobs()
    .filter((job) => !projectId || job.projectId === projectId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    .map(publicJob);
}

/**
 * Espera o arquivo ficar estável no ComfyUI.
 *
 * Duas leituras consecutivas com o mesmo tamanho antes de copiar. Sem isso,
 * podemos baixar um MP4 ainda sendo gravado — que passa no download mas não
 * abre no player.
 */
export async function aguardarFonteEstavel(comfyOutput, { tentativas = 10, intervaloMs = 400 } = {}) {
  let anterior = null;

  for (let i = 0; i < tentativas; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const tamanho = await comfy.viewFileSize(comfyOutput);

    if (tamanho === null) return { estavel: false, motivo: 'tamanho-indisponivel', tamanho: null };
    if (anterior !== null && tamanho === anterior && tamanho > 0) {
      return { estavel: true, motivo: '', tamanho };
    }
    anterior = tamanho;

    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, intervaloMs); });
  }
  return { estavel: false, motivo: 'ainda-crescendo', tamanho: anterior };
}

/**
 * Baixa para um temporário, confere com o ffprobe e publica com rename atômico.
 * Nunca publica um MP4 que não abra.
 */
async function baixarValidarPublicar(job, { tentativas = 3 } = {}) {
  const { jobId, projectId } = job;
  const kind = descriptorForJob(job).kind;

  // A extensão de destino vem do que o ComfyUI produziu, e só é aceita se for
  // uma que sabemos gravar E servir com o MIME certo. Renomear silenciosamente
  // um contêiner alheio para a extensão padrão do tipo produziria um arquivo
  // que mente sobre si mesmo — um `.mp4` servido como `video/mp4` contendo
  // WebM. Aqui não há transcodificação: o que não pode ser servido
  // honestamente é recusado, com o motivo dito por inteiro.
  const extensaoOrigem = extensionOf(job.comfyOutput?.filename || '');
  if (!isStorableExtension(kind, `x${extensaoOrigem}`)) {
    const erro = new ComfyError(
      `O ComfyUI produziu "${extensaoOrigem || 'um arquivo sem extensão'}", que não é um formato que a aplicação publica para ${kind}. `
      + `Aceitos: ${extensionsFor(kind).join(', ')}.`,
    );
    erro.detail = { kind, extensaoOrigem, aceitas: extensionsFor(kind) };
    throw erro;
  }
  const extensao = extensaoOrigem;

  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= tentativas; tentativa += 1) {
    // eslint-disable-next-line no-await-in-loop
    const bytes = await comfy.viewFile(job.comfyOutput);

    if (!bytes?.length) {
      ultimoErro = new ComfyError('O arquivo veio vazio do ComfyUI.');
      logWarn(STAGES.FINALIZING_FILE, 'O download devolveu um arquivo vazio.', {
        detail: { tentativa, tentativasPrevistas: tentativas },
      });
    } else {
      logInfo(STAGES.FINALIZING_FILE, `Arquivo baixado do ComfyUI: ${formatarBytes(bytes.length)}.`, {
        detail: { bytes: bytes.length, tentativa, tentativasPrevistas: tentativas },
      });

      // eslint-disable-next-line no-await-in-loop
      const temporario = await mediaTempPath(kind, projectId, jobId, extensao);
      // eslint-disable-next-line no-await-in-loop
      await writeFile(temporario, bytes);

      // eslint-disable-next-line no-await-in-loop
      const validacao = await validarMidia(kind, temporario);
      if (validacao.ok) {
        // A extensão publicada segue a política do tipo. Para imagem ela vem
        // do formato DETECTADO nos bytes: o ComfyUI pode chamar de .jpg um
        // arquivo que é PNG, e publicar assim serviria image/jpeg sobre bytes
        // PNG. Para vídeo continua sendo a declarada, já restrita a MP4.
        const extensaoFinal = extensaoParaPublicar(kind, extensao, validacao);
        if (extensaoFinal !== extensao) {
          logInfo(STAGES.PUBLISHING_RESULT, `O arquivo veio como "${extensao}" mas os bytes são ${validacao.probe?.mime}; publicando como "${extensaoFinal}".`, {
            http: null,
            detail: { extensaoDeclarada: extensao, extensaoPublicada: extensaoFinal, mimeReal: validacao.probe?.mime },
          });
        }
        logInfo(STAGES.VALIDATING_WITH_FFPROBE, kind === 'image'
          ? `Os bytes confirmam uma imagem ${validacao.probe?.mime || ''}.`.trim()
          : 'O ffprobe confirmou um MP4 reproduzível.', {
          http: null,
          detail: { tentativa, kind, probe: resumirProbe(validacao.probe) },
        });

        // eslint-disable-next-line no-await-in-loop
        const publicado = await publishMediaFile(kind, projectId, jobId, temporario, extensaoFinal);

        logInfo(STAGES.PUBLISHING_RESULT, `Vídeo publicado no player: ${publicado.url}`, {
          http: null,
          detail: { url: publicado.url, filename: publicado.filename, projectId, tentativas: tentativa },
        });
        return { bytes, salvo: publicado, probe: validacao.probe };
      }

      ultimoErro = new ComfyError(`O arquivo copiado não é utilizável: ${validacao.motivo}`);
      ultimoErro.tentativas = tentativa;
      logWarn(STAGES.VALIDATING_WITH_FFPROBE, `A validação recusou o arquivo copiado: ${validacao.motivo}. Descartado sem publicar.`, {
        http: null,
        detail: { tentativa, motivo: validacao.motivo, probe: resumirProbe(validacao.probe) },
      });
      // eslint-disable-next-line no-await-in-loop
      await rm(temporario, { force: true }).catch(() => {});
    }

    if (tentativa < tentativas) {
      updateJob(jobId, { state: STATES.SAVING, finalizingAttempt: tentativa });
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 800 * tentativa); });
    }
  }

  const falha = ultimoErro || new ComfyError('Não foi possível copiar o arquivo.');
  falha.tentativas = tentativas;
  throw falha;
}

/**
 * Contêineres que o ffprobe reporta para um arquivo da família MP4/MOV.
 * O ffprobe devolve a lista completa: "mov,mp4,m4a,3gp,3g2,mj2".
 */
const CONTAINERS_MP4 = ['mp4', 'mov', 'm4a', 'm4v', 'isom'];

/**
 * O MP4 abre, tem duração, tem fluxo de vídeo — e é mesmo um MP4?
 *
 * A última pergunta foi acrescentada depois de um caso concreto: bytes WebM
 * gravados com o nome `.mp4` passavam nas três primeiras checagens, porque o
 * ffprobe abre WebM sem reclamar e reporta vídeo e duração normalmente. O
 * arquivo era então servido como `video/mp4`, mentindo sobre o próprio
 * conteúdo. Nada aqui transcodifica: se o contêiner não for MP4, recusamos.
 */
export async function validarMp4(caminho) {
  let info;
  try {
    info = await probeFile(caminho);
  } catch (erro) {
    return { ok: false, motivo: `ffprobe falhou (${erro.message})`, probe: null };
  }
  if (!info.hasVideo) return { ok: false, motivo: 'sem fluxo de vídeo', probe: info };
  if (!(info.duration > 0)) return { ok: false, motivo: 'duração zero', probe: info };

  const containers = String(info.formatName || '').toLowerCase().split(',').map((c) => c.trim());
  if (!containers.some((c) => CONTAINERS_MP4.includes(c))) {
    return {
      ok: false,
      motivo: `o contêiner é "${info.formatName || 'desconhecido'}", não MP4`,
      probe: info,
    };
  }

  return { ok: true, motivo: '', probe: info };
}

/** Cancela: remove da fila se pendente, interrompe se estiver executando. */
export async function cancelJob(jobId) {
  const job = getJob(jobId);
  if (!job) return null;
  if (isTerminal(job.state)) return publicJob(job);

  updateJob(jobId, { cancelRequested: true });

  let acao = 'nenhuma';
  try {
    const fila = await comfy.queue();
    const posicao = findInQueue(fila, job.promptId);

    if (posicao.pending) {
      await comfy.deleteFromQueue(job.promptId);
      acao = 'removido-da-fila';
    } else if (posicao.running) {
      await comfy.interrupt();
      acao = 'interrompido';
    }
  } catch (error) {
    updateJob(jobId, { lastPollError: error.message });
  }

  updateJob(jobId, { state: STATES.CANCELLED, finishedAt: Date.now(), cancelAction: acao });
  logWarn(STAGES.CANCELLED, `Geração cancelada pelo usuário (${acao}).`, {
    jobId,
    promptId: job.promptId,
    http: null,
    detail: { acao },
  });
  return publicJob(getJob(jobId));
}

/** Recorte seguro do job para enviar ao navegador. */
export function publicJob(job) {
  if (!job) return null;
  const agora = Date.now();
  return {
    jobId: job.jobId,
    projectId: job.projectId,
    promptId: job.promptId,
    // Novos nesta etapa. Consumidores antigos ignoram campos extras; quem
    // precisar distinguir imagem de vídeo lê `kind`, nunca `model`.
    workflowId: job.workflowId || DEFAULT_VIDEO_WORKFLOW_ID,
    kind: job.kind || 'video',
    // Vai ao cliente para que ele possa ordenar por "mais recente" também.
    createdAt: job.createdAt ?? null,
    state: job.state,
    stateLabel: STATE_LABELS[job.state] || job.state,
    terminal: isTerminal(job.state),
    progress: job.progress,
    node: job.node,
    queuePosition: job.queuePosition,
    error: job.error,
    // Falha transitória do último polling. Era registrada no job e nunca saía
    // daqui — é o aviso mais útil quando o ComfyUI oscila durante a geração.
    lastPollError: job.lastPollError || null,
    elapsedMs: (job.finishedAt || agora) - (job.submittedAt || job.createdAt),
    model: job.model,
    mode: job.mode || 't2v',
    modeLabel: job.modeLabel || 'Texto → vídeo',
    frameFirst: job.frameFirst || null,
    frameLast: job.frameLast || null,
    seed: job.seed,
    seedLocked: job.seedLocked,
    prompt: job.prompt,
    frames: job.frames,
    durationRequested: job.durationRequested,
    durationActual: job.durationActual,
    withinTrainedRange: job.withinTrainedRange,
    aspect: job.aspect,
    quality: job.quality,
    megapixels: job.megapixels,
    fps: job.fps,
    costUsd: 0,
    result: job.result || null,
    readyToFinalize: job.state === STATES.SAVING && Boolean(job.comfyOutput) && !job.result,
  };
}

export { WorkflowError, ComfyError, UploadError };
