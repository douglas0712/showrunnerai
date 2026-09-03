// Superfície de compatibilidade do workflow.
//
// A carga e o patch do grafo deixaram de ser uma função global do MiniMax H3 e
// passaram a ser responsabilidade de um descriptor, em
// lib/server/generation/workflows/minimaxH3.js, selecionado pelo registry.
//
// Este arquivo continua existindo para que `provider.js`, as rotas e os testes
// já escritos não precisassem mudar junto com a introdução do registry. Ele não
// tem lógica própria: reexporta o descriptor do MiniMax e resolve o template
// pelo registry.
//
// Código novo deve pedir o workflow ao registry:
//
//   import { getWorkflow } from '../generation/workflows/registry.js';
//   const wf = getWorkflow('minimax_h3_t2v');
//   const template = await wf.loadTemplate();
//   const { graph, meta } = wf.patch(template, params);

import { getWorkflow } from '../generation/workflows/registry.js';
import { minimaxH3T2V } from '../generation/workflows/minimaxH3.js';
import { loadWorkflowFile, WorkflowError } from '../generation/workflows/descriptor.js';

/**
 * Lê o workflow do disco. Somente leitura.
 *
 * Sem argumento, usa o descriptor do MiniMax — o comportamento que os
 * chamadores atuais esperam. Com um caminho explícito, lê aquele arquivo; isso
 * existe apenas para chamadas internas do servidor e **nunca** recebe valor
 * vindo do navegador, que só informa parâmetros de geração.
 */
export async function loadWorkflowTemplate(filePath = null) {
  if (!filePath) return minimaxH3T2V.loadTemplate();

  // Caminho explícito: o descriptor continua sendo quem valida o grafo.
  return loadWorkflowFile({
    file: minimaxH3T2V.file,
    resolvePath: () => filePath,
    validate: minimaxH3T2V.validate,
  });
}

/** Template do workflow escolhido por id no registry. */
export function loadWorkflowById(workflowId) {
  return getWorkflow(workflowId).loadTemplate();
}

export {
  attachFrames,
  aspectFromSelector,
  computeFrames,
  framesToSeconds,
  isWithinTrainedRange,
  megapixelsForQuality,
  metaFromSubmittedGraph,
  minimaxH3T2V,
  modeFromGraph,
  patchWorkflow,
  qualityFromMegapixels,
  randomSeed,
  selectorForAspect,
  validateWorkflow,
} from '../generation/workflows/minimaxH3.js';

export { WorkflowError };
