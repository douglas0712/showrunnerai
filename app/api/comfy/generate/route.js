import { NextResponse } from 'next/server';
import { newGenerationJobId, startGeneration } from '@/lib/server/generation/facade';
import { logError, logInfo } from '@/lib/server/logs/logger';
import { STAGES } from '@/lib/server/logs/stages';
import { WorkflowError } from '@/lib/server/comfy/workflow';
import { ComfyError } from '@/lib/server/comfy/client';
import {
  ASPECT_TO_SELECTOR, MAX_UPLOAD_BYTES, NATIVE_FPS, QUALITY_TO_MEGAPIXELS,
} from '@/lib/server/comfy/config';
import { detectImageType, UploadError } from '@/lib/server/comfy/images';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PROMPT = 4000;
const PROJECT_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function POST(request) {
  // Duas formas de corpo, um único pipeline: JSON para texto → vídeo (o que a
  // aba Cinema já usava) e multipart quando há quadros. O que muda é só a
  // leitura; daqui para baixo o caminho é o mesmo.
  const tipoDeConteudo = request.headers.get('content-type') || '';
  const multipart = tipoDeConteudo.includes('multipart/form-data');

  let corpo;
  let quadros = null;

  if (multipart) {
    try {
      ({ corpo, quadros } = await lerMultipart(request));
    } catch (error) {
      const status = error instanceof UploadError ? 400 : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
  } else {
    try {
      corpo = await request.json();
    } catch {
      return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
    }
  }

  // O jobId nasce aqui, antes da validação, para que a primeira linha do log
  // já esteja amarrada ao job — senão os erros de parâmetro ficariam órfãos.
  // Ele vem pela camada de geração: é identificador do Showrunner, e esta rota
  // não alcança mais o executor para nada.
  const jobId = newGenerationJobId();

  const erro = validar(corpo) || validarQuadros(quadros);
  if (erro) {
    logError(STAGES.VALIDATING_INPUTS, erro, {
      jobId,
      userHint: erro,
      http: { method: 'POST', path: '/api/comfy/generate', status: 400 },
      detail: { parametros: parametrosDoLog(corpo), quadros: quadrosDoLog(quadros) },
    });
    return NextResponse.json({ error: erro }, { status: 400 });
  }

  logInfo(STAGES.VALIDATING_INPUTS, `Parâmetros validados (${descricaoDoModo(quadros)}).`, {
    jobId,
    http: { method: 'POST', path: '/api/comfy/generate', status: 202 },
    detail: { parametros: parametrosDoLog(corpo), quadros: quadrosDoLog(quadros) },
  });

  try {
    // Pela camada de geração: é ela que registra o trabalho no livro-razão
    // ANTES de submeter, e depois anota o identificador que o executor devolve.
    // Esta tela não nasce numa conversa, então o registro fica sem thread e sem
    // turno — o que é a verdade, e o livro-razão sabe representá-la.
    const { providerJob } = await startGeneration({
      jobId,
      frames: quadros,
      prompt: corpo.prompt,
      seed: corpo.seedLocked ? Number(corpo.seed) : null,
      seedLocked: Boolean(corpo.seedLocked),
      durationSeconds: Number(corpo.durationSeconds),
      aspect: corpo.aspect,
      quality: corpo.quality,
      fps: NATIVE_FPS,
    }, {
      projectId: corpo.projectId,
    });
    return NextResponse.json(providerJob, { status: 202 });
  } catch (error) {
    if (error instanceof UploadError) {
      return NextResponse.json({ error: error.message, detail: error.detail || null }, { status: 400 });
    }
    const status = error instanceof WorkflowError ? 422 : 502;
    return NextResponse.json(
      { error: error.message, detail: error.detail || null },
      { status: error instanceof ComfyError || error instanceof WorkflowError ? status : 500 },
    );
  }
}

/**
 * Lê o corpo multipart.
 *
 * Os arquivos viram Buffer em memória e param aqui: o arquivo do usuário nunca
 * é regravado, renomeado ou movido — só lido. O nome original vai adiante
 * apenas como metadado de log, nunca como caminho.
 */
async function lerMultipart(request) {
  let form;
  try {
    form = await request.formData();
  } catch (error) {
    throw new UploadError(`Não foi possível ler o formulário enviado: ${error.message}`);
  }

  const corpo = {
    prompt: form.get('prompt'),
    projectId: form.get('projectId'),
    aspect: form.get('aspect'),
    quality: form.get('quality'),
    durationSeconds: form.get('durationSeconds'),
    seed: form.get('seed'),
    seedLocked: form.get('seedLocked') === 'true',
  };

  const quadros = {};
  for (const [campo, papel] of [['firstFrame', 'first'], ['lastFrame', 'last']]) {
    const arquivo = form.get(campo);
    if (!arquivo || typeof arquivo.arrayBuffer !== 'function') continue;

    if (arquivo.size > MAX_UPLOAD_BYTES) {
      const limiteMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
      throw new UploadError(`O arquivo enviado em "${campo}" passa de ${limiteMb} MB.`);
    }

    quadros[papel] = {
      // eslint-disable-next-line no-await-in-loop
      bytes: Buffer.from(await arquivo.arrayBuffer()),
      declaredType: arquivo.type || null,
      declaredName: arquivo.name || null,
    };
  }

  return { corpo, quadros: Object.keys(quadros).length ? quadros : null };
}

/**
 * Validação dos quadros na etapa de parâmetros.
 *
 * O tipo é conferido nos bytes já aqui para que um arquivo inválido falhe em
 * VALIDATING_INPUTS, com HTTP 400, antes de qualquer coisa sair da máquina.
 */
function validarQuadros(quadros) {
  if (!quadros) return null;

  if (quadros.last && !quadros.first) {
    return 'O último quadro só pode ser enviado junto com o primeiro.';
  }

  for (const [papel, rotulo] of [['first', 'primeiro quadro'], ['last', 'último quadro']]) {
    const quadro = quadros[papel];
    if (!quadro) continue;
    if (!detectImageType(quadro.bytes)) {
      return `O ${rotulo} não é PNG, JPEG nem WebP. O conteúdo do arquivo foi conferido, não a extensão.`;
    }
  }
  return null;
}

function descricaoDoModo(quadros) {
  if (quadros?.first && quadros?.last) return 'primeiro e último quadro';
  if (quadros?.first) return 'imagem → vídeo';
  return 'texto → vídeo';
}

/** Metadados dos quadros para o log — nunca os bytes, nunca o nome como caminho. */
function quadrosDoLog(quadros) {
  if (!quadros) return null;
  const saida = {};
  for (const papel of ['first', 'last']) {
    const quadro = quadros[papel];
    if (!quadro) continue;
    const tipo = detectImageType(quadro.bytes);
    saida[papel] = {
      bytes: quadro.bytes.length,
      tipoReal: tipo?.mime || null,
      tipoDeclarado: quadro.declaredType || null,
      nomeOriginalCaracteres: quadro.declaredName ? quadro.declaredName.length : 0,
    };
  }
  return saida;
}

/**
 * Recorte dos parâmetros para o log.
 *
 * O prompt entra truncado — ele é do usuário, não é segredo, mas 4000
 * caracteres em cada linha tornariam a tela ilegível.
 */
function parametrosDoLog(corpo) {
  return {
    projectId: corpo?.projectId ?? null,
    aspect: corpo?.aspect ?? null,
    quality: corpo?.quality ?? null,
    durationSeconds: corpo?.durationSeconds ?? null,
    seedLocked: Boolean(corpo?.seedLocked),
    seed: corpo?.seedLocked ? corpo?.seed ?? null : null,
    promptCaracteres: typeof corpo?.prompt === 'string' ? corpo.prompt.length : 0,
    prompt: typeof corpo?.prompt === 'string' ? corpo.prompt.slice(0, 240) : null,
  };
}

function validar(corpo) {
  if (!corpo || typeof corpo !== 'object') return 'Corpo inválido.';

  if (typeof corpo.prompt !== 'string' || !corpo.prompt.trim()) {
    return 'O prompt cinematográfico está vazio.';
  }
  if (corpo.prompt.length > MAX_PROMPT) {
    return `O prompt excede ${MAX_PROMPT} caracteres.`;
  }
  if (!PROJECT_RE.test(String(corpo.projectId || ''))) {
    return 'projectId inválido.';
  }
  if (!Object.keys(ASPECT_TO_SELECTOR).includes(corpo.aspect)) {
    return `Proporção não suportada: "${corpo.aspect}".`;
  }
  if (!Object.keys(QUALITY_TO_MEGAPIXELS).includes(corpo.quality)) {
    return `Qualidade não suportada: "${corpo.quality}".`;
  }

  const duracao = Number(corpo.durationSeconds);
  if (!Number.isFinite(duracao) || duracao < 1 || duracao > 20) {
    return 'A duração precisa estar entre 1 e 20 segundos.';
  }

  if (corpo.seedLocked) {
    const seed = Number(corpo.seed);
    if (!Number.isInteger(seed) || seed < 0 || seed > Number.MAX_SAFE_INTEGER) {
      return 'Seed inválida.';
    }
  }
  return null;
}
