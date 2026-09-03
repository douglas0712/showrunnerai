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

import { pollJob, submitGeneration } from '../comfy/provider.js';
import { getJob } from '../comfy/jobs.js';
import { getAsset, findAssetsByJob } from '../domain/index.js';
import { DomainError } from '../domain/db.js';
import { STATES, TERMINAL_STATES } from '../comfy/status.js';
import { mediaKind, mimeFor } from './mediaKinds.js';

/** Erro de geração (não de submissão). */
export class GenerationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'GenerationError';
    this.detail = detail;
  }
}

/**
 * Normaliza o estado de um job para um valor público.
 *
 * Job interno usa 'state' (fonte de verdade).
 * Campo legado 'status' nunca é usado; ignorado se presente.
 * Retorna o estado normalizando apenas valores conhecidos.
 */
function normalizeJobState(job) {
  const internalState = job.state || 'unknown';

  // Estados válidos conhecidos do STATES mapping
  if (internalState === STATES.PREPARING) return 'preparando';
  if (internalState === STATES.SUBMITTED) return 'enviado';
  if (internalState === STATES.QUEUED) return 'na-fila';
  if (internalState === STATES.GENERATING) return 'gerando';
  if (internalState === STATES.DECODING) return 'decodificando';
  if (internalState === STATES.SAVING) return 'salvando';
  if (internalState === STATES.DONE) return 'concluido';
  if (internalState === STATES.FAILED) return 'falhou';
  if (internalState === STATES.CANCELLED) return 'cancelado';

  return internalState;
}

/** Capacidade padrão para imagem neste release. */
const IMAGEM_WORKFLOW = 'ideogram4_t2i';

/** Capacidade padrão para vídeo neste release. */
const VÍDEO_WORKFLOW = 'minimax_h3_t2v';

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
  { projectId, db = null } = {},
) {
  if (!projectId) {
    throw new GenerationError('Geração de imagem exige projectId.', {});
  }

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new GenerationError('Prompt é obrigatório e não pode estar vazio.');
  }

  const params = {
    jobId: undefined, // será gerado pelo provider
    prompt: prompt.trim(),
    aspect,
    quality: '1K', // padrão interno para agent
    durationSeconds: undefined, // imagem não tem duração
    seed: seed !== null && seed !== undefined ? Number(seed) : null,
    seedLocked: seed !== null && seed !== undefined,
    projectId,
    workflowId: IMAGEM_WORKFLOW,
  };

  try {
    const job = await submitGeneration(params);
    return { jobId: job.jobId, kind: 'image', status: job.status };
  } catch (erro) {
    throw new GenerationError(
      `Não foi possível iniciar geração de imagem: ${erro?.message || 'erro'}`,
      { originalError: erro?.message, projectId },
    );
  }
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
  { projectId, db = null } = {},
) {
  if (!projectId) {
    throw new GenerationError('Geração de vídeo exige projectId.', {});
  }

  if (typeof prompt !== 'string' || !prompt.trim()) {
    throw new GenerationError('Prompt é obrigatório e não pode estar vazio.');
  }

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
    jobId: undefined,
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

  try {
    const job = await submitGeneration(params);
    return { jobId: job.jobId, kind: 'video', status: job.status };
  } catch (erro) {
    throw new GenerationError(
      `Não foi possível iniciar geração de vídeo: ${erro?.message || 'erro'}`,
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
 * - status
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
