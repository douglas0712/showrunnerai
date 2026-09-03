// Registry de workflows.
//
// Ponto único onde um identificador vira um workflow conhecido. O caller
// escolhe por `workflowId`; o caminho em disco é derivado do descriptor, nunca
// recebido de fora. É essa direção — id → descriptor → path — que impede uma
// requisição de apontar para um arquivo arbitrário da máquina.
//
// A forma segue lib/providers/registry.js, que já resolve o mesmo problema do
// outro lado da aplicação: uma fábrica testável mais uma instância padrão.

import { isWorkflowDescriptor, WorkflowError } from './descriptor.js';
import { minimaxH3T2V } from './minimaxH3.js';

/** Workflow pedido não existe no registry. */
export class UnknownWorkflowError extends Error {
  constructor(id, conhecidos = []) {
    super(
      `Workflow desconhecido: "${id}". Conhecidos: ${conhecidos.join(', ') || 'nenhum'}.`,
    );
    this.name = 'UnknownWorkflowError';
    this.detail = { id, conhecidos };
  }
}

/**
 * Monta um registry a partir de uma lista de descriptors.
 *
 * Id repetido é erro na construção, não a última definição vencendo em
 * silêncio: dois workflows disputando o mesmo id é defeito de programação, e
 * descobrir isso na carga do módulo é melhor do que numa geração.
 */
export function createWorkflowRegistry(descriptors = []) {
  const porId = new Map();

  for (const descriptor of descriptors) {
    // Só entra o que passou por `defineWorkflow`. Um objeto solto que por
    // acaso tenha um `id` seria aceito aqui e só falharia lá na frente, na
    // primeira geração, ao faltar `patch` ou `validate`.
    if (!isWorkflowDescriptor(descriptor)) {
      throw new WorkflowError(
        'Só descriptors criados por defineWorkflow() podem ser registrados.',
        { recebido: descriptor?.id ?? typeof descriptor },
      );
    }
    if (porId.has(descriptor.id)) {
      throw new WorkflowError(`Workflow duplicado no registry: "${descriptor.id}".`, {
        id: descriptor.id,
      });
    }
    porId.set(descriptor.id, descriptor);
  }

  return {
    /**
     * Descriptor de um id conhecido.
     *
     * Falha alto e cedo: nunca devolve `undefined` e nunca cai em outro
     * workflow — submeter o grafo errado seria pior do que não submeter nada.
     */
    get(id) {
      const descriptor = porId.get(id);
      if (!descriptor) throw new UnknownWorkflowError(id, [...porId.keys()]);
      return descriptor;
    },
    has(id) {
      return porId.has(id);
    },
    /**
     * Resumo dos workflows registrados — seguro para log e para a interface.
     *
     * Cada chamada devolve objetos novos e uma cópia de `modes`: quem recebe a
     * lista não consegue alcançar o descriptor por dentro dela.
     */
    list() {
      return [...porId.values()].map((d) => ({
        id: d.id,
        label: d.label,
        kind: d.kind,
        file: d.file,
        modes: Array.isArray(d.modes) ? [...d.modes] : null,
      }));
    },
    ids() {
      return [...porId.keys()];
    },
    get size() {
      return porId.size;
    },
  };
}

/**
 * Registry da aplicação.
 *
 * Nesta etapa há um workflow real. Acrescentar outro é acrescentar um
 * descriptor a esta lista — nenhuma linha da infraestrutura muda.
 */
export const workflowRegistry = createWorkflowRegistry([
  minimaxH3T2V,
]);

export function getWorkflow(id) {
  return workflowRegistry.get(id);
}

export function hasWorkflow(id) {
  return workflowRegistry.has(id);
}

export function listWorkflows() {
  return workflowRegistry.list();
}

/** Id do workflow que a aba Cinema e a aba Vídeo usam hoje. */
export const DEFAULT_VIDEO_WORKFLOW_ID = minimaxH3T2V.id;

export { WorkflowError };
