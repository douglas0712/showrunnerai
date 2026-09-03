// Vocabulário do diagnóstico: níveis, etapas e explicações legíveis.
//
// Módulo puro — nenhum I/O, nenhum estado. É o único lugar onde o texto que o
// usuário lê numa falha é escrito, para que a mensagem técnica (que vai para os
// detalhes) e a explicação (que vai para a tela) nunca saiam de sincronia.

export const LEVELS = {
  INFO: 'INFO',
  WARN: 'AVISO',
  ERROR: 'ERRO',
};

export const LEVEL_ORDER = [LEVELS.INFO, LEVELS.WARN, LEVELS.ERROR];

/** Canais de origem. `export` já está previsto para o FFmpeg entrar depois. */
export const CHANNELS = {
  COMFY: 'comfy',
  EXPORT: 'export',
};

/**
 * Etapas da geração.
 *
 * UPLOADING_START_FRAME e UPLOADING_END_FRAME estão declaradas mas **não são
 * emitidas**: o provider atual é texto → vídeo e não envia quadros ao ComfyUI.
 * Registrá-las hoje seria log simulado. Quando o imagem → vídeo existir, basta
 * emitir — a tela já sabe rotulá-las.
 */
export const STAGES = {
  VALIDATING_INPUTS: 'VALIDATING_INPUTS',
  PREPARING_WORKFLOW: 'PREPARING_WORKFLOW',
  UPLOADING_START_FRAME: 'UPLOADING_START_FRAME',
  UPLOADING_END_FRAME: 'UPLOADING_END_FRAME',
  SUBMITTING_TO_COMFYUI: 'SUBMITTING_TO_COMFYUI',
  QUEUED: 'QUEUED',
  GENERATING: 'GENERATING',
  READING_HISTORY: 'READING_HISTORY',
  LOCATING_OUTPUT: 'LOCATING_OUTPUT',
  FINALIZING_FILE: 'FINALIZING_FILE',
  VALIDATING_WITH_FFPROBE: 'VALIDATING_WITH_FFPROBE',
  PUBLISHING_RESULT: 'PUBLISHING_RESULT',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  // Fora do fluxo de um job: verificação de conexão e varredura de recuperação.
  CONNECTION_CHECK: 'CONNECTION_CHECK',
};

/** Ordem cronológica esperada — usada para ordenar e para o retry contextual. */
export const STAGE_ORDER = [
  STAGES.VALIDATING_INPUTS,
  STAGES.PREPARING_WORKFLOW,
  STAGES.UPLOADING_START_FRAME,
  STAGES.UPLOADING_END_FRAME,
  STAGES.SUBMITTING_TO_COMFYUI,
  STAGES.QUEUED,
  STAGES.GENERATING,
  STAGES.READING_HISTORY,
  STAGES.LOCATING_OUTPUT,
  STAGES.FINALIZING_FILE,
  STAGES.VALIDATING_WITH_FFPROBE,
  STAGES.PUBLISHING_RESULT,
  STAGES.COMPLETED,
];

export const STAGE_LABELS = {
  [STAGES.VALIDATING_INPUTS]: 'Validando parâmetros',
  [STAGES.PREPARING_WORKFLOW]: 'Preparando o workflow',
  [STAGES.UPLOADING_START_FRAME]: 'Enviando quadro inicial',
  [STAGES.UPLOADING_END_FRAME]: 'Enviando quadro final',
  [STAGES.SUBMITTING_TO_COMFYUI]: 'Enviando ao ComfyUI',
  [STAGES.QUEUED]: 'Na fila',
  [STAGES.GENERATING]: 'Gerando',
  [STAGES.READING_HISTORY]: 'Lendo o histórico',
  [STAGES.LOCATING_OUTPUT]: 'Localizando o arquivo',
  [STAGES.FINALIZING_FILE]: 'Baixando o arquivo',
  [STAGES.VALIDATING_WITH_FFPROBE]: 'Validando com ffprobe',
  [STAGES.PUBLISHING_RESULT]: 'Publicando no player',
  [STAGES.COMPLETED]: 'Concluído',
  [STAGES.FAILED]: 'Falhou',
  [STAGES.CANCELLED]: 'Cancelado',
  [STAGES.CONNECTION_CHECK]: 'Verificação de conexão',
};

export function stageLabel(stage) {
  return STAGE_LABELS[stage] || stage || '—';
}

/**
 * Etapas em que a falha aconteceu **depois** de o vídeo já existir no ComfyUI.
 * Nesses casos, tentar de novo é refinalizar (copiar o arquivo) — não regerar,
 * o que pouparia a GPU e não mudaria o resultado.
 */
const STAGES_APOS_GERACAO = [
  STAGES.LOCATING_OUTPUT,
  STAGES.FINALIZING_FILE,
  STAGES.VALIDATING_WITH_FFPROBE,
  STAGES.PUBLISHING_RESULT,
];

/**
 * Qual retentativa faz sentido depois de uma falha nesta etapa.
 * @returns {'refinalizar'|'ressubmeter'|null}
 */
export function retryKindForStage(stage) {
  if (!stage) return null;
  if (STAGES_APOS_GERACAO.includes(stage)) return 'refinalizar';
  if (STAGE_ORDER.includes(stage)) return 'ressubmeter';
  return null;
}

export const RETRY_LABELS = {
  refinalizar: 'Tentar novamente (copiar o vídeo que já existe no ComfyUI)',
  ressubmeter: 'Tentar novamente (gerar de novo)',
};

/**
 * Explicação em linguagem de usuário para uma falha.
 *
 * A mensagem técnica continua inteira nos detalhes; isto é o que aparece em
 * cima dela. Casamos por etapa e por trecho da mensagem, com um texto genérico
 * por etapa como último recurso — nunca devolvemos vazio.
 */
export function explainFailure(stage, message = '') {
  const texto = String(message || '');

  // Padrões que valem em qualquer etapa: o diagnóstico é a causa, não o passo.
  if (/não foi possível falar com o comfyui|não respondeu em/i.test(texto)) {
    return 'O ComfyUI não respondeu. Verifique se ele está rodando e acessível no endereço configurado.';
  }
  if (/ECONNREFUSED|fetch failed/i.test(texto)) {
    return 'A conexão com o ComfyUI foi recusada. O servidor provavelmente está parado.';
  }
  if (/respondeu 4\d\d/i.test(texto)) {
    return 'O ComfyUI recusou a requisição. Normalmente é um parâmetro fora do que o workflow aceita.';
  }
  if (/respondeu 5\d\d/i.test(texto)) {
    return 'O ComfyUI encontrou um erro interno ao processar a requisição. O log do próprio ComfyUI tem o detalhe.';
  }
  if (/out of memory|CUDA|VRAM/i.test(texto)) {
    return 'A GPU ficou sem memória. Reduza a resolução ou a duração e tente de novo.';
  }

  const porEtapa = {
    [STAGES.VALIDATING_INPUTS]:
      'Algum parâmetro do plano está fora do aceito. Corrija o campo indicado e gere de novo.',
    [STAGES.PREPARING_WORKFLOW]:
      'O arquivo de workflow não pôde ser lido ou não bate com o esperado. Confira a raiz em COMFY_WORKFLOWS_ROOT (ou o caminho completo em COMFY_WORKFLOW) e os nós do grafo.',
    [STAGES.SUBMITTING_TO_COMFYUI]:
      'O ComfyUI não aceitou o grafo. Costuma ser um nó ausente ou um arquivo de modelo que não está instalado.',
    [STAGES.QUEUED]:
      'Não foi possível consultar a fila do ComfyUI. A geração pode continuar rodando mesmo assim.',
    [STAGES.GENERATING]:
      'A execução falhou dentro do ComfyUI. A mensagem do nó que quebrou está nos detalhes técnicos.',
    [STAGES.READING_HISTORY]:
      'Não foi possível ler o histórico do ComfyUI. Se a geração terminou, ela pode ser recuperada depois.',
    [STAGES.LOCATING_OUTPUT]:
      'A execução terminou mas nenhum arquivo de vídeo apareceu nas saídas. Verifique o nó SaveVideo do workflow.',
    [STAGES.FINALIZING_FILE]:
      'O arquivo não pôde ser copiado do ComfyUI para o estúdio. O vídeo continua lá e a cópia pode ser refeita.',
    [STAGES.VALIDATING_WITH_FFPROBE]:
      'O arquivo copiado não abre como vídeo. Ele foi descartado em vez de publicado quebrado — tentar de novo costuma resolver.',
    [STAGES.PUBLISHING_RESULT]:
      'O vídeo foi baixado e validado, mas não pôde ser gravado no armazenamento do estúdio. Verifique permissão e espaço em runtime/.',
    [STAGES.CONNECTION_CHECK]:
      'A verificação de conexão com o ComfyUI não passou. Os itens reprovados estão nos detalhes.',
  };

  return porEtapa[stage] || 'A operação falhou. Os detalhes técnicos estão logo abaixo.';
}
