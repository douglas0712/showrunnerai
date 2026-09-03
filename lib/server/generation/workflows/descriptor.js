// Contrato do Workflow Descriptor — a parte genérica.
//
// Nada aqui conhece MiniMax, Ideogram ou qualquer modelo. A infraestrutura
// sabe apenas que um workflow declara os nós que exige, as classes que esses
// nós precisam ter, os arquivos de modelo que devem estar referenciados, e
// sabe carregar e conferir um grafo contra essas declarações.
//
// O conhecimento específico mora no descriptor concreto — hoje minimaxH3.js.

import { readFile } from 'node:fs/promises';
import { resolveDescriptorPath } from './paths.js';

/**
 * Falha de workflow: arquivo ilegível, grafo com estrutura inesperada ou
 * parâmetro fora do que o workflow aceita.
 *
 * Definida uma vez aqui e reexportada por comfy/workflow.js, para que o
 * `instanceof WorkflowError` de app/api/comfy/generate/route.js continue
 * valendo — é o que mapeia a falha para HTTP 422.
 */
export class WorkflowError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'WorkflowError';
    this.detail = detail;
  }
}

/** Tipos de saída que um workflow pode produzir. */
export const WORKFLOW_KINDS = ['image', 'video'];

const ID_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;

/**
 * Marca de procedência: só um objeto vindo de `defineWorkflow` a carrega.
 *
 * É o que permite ao registry recusar um objeto solto que por acaso tenha um
 * `id`. Sem isto, `{ id: 'x' }` entrava no registry e só falhava lá na frente,
 * quando alguém chamasse `patch` de um descriptor que não tem `patch`.
 */
const MARCA = Symbol.for('showrunner.workflow.descriptor');

/**
 * Um descriptor legítimo carrega a marca E está congelado.
 *
 * As duas condições são necessárias: o espalhamento `{ ...descriptor }` copia
 * símbolos próprios enumeráveis, então a marca sozinha deixaria passar uma
 * cópia mutável — funcional, mas com as tabelas de nós abertas a alteração em
 * tempo de execução, que é justamente o que o congelamento existe para impedir.
 * A marca é definida como não enumerável, e o congelamento é reconferido aqui.
 */
export function isWorkflowDescriptor(valor) {
  return Boolean(valor && valor[MARCA] === true && Object.isFrozen(valor));
}

/**
 * Congela um objeto e as estruturas que ele contém.
 *
 * `Object.freeze` é superficial: congelar o descriptor deixava `nodeIds`,
 * `nodeClasses` e `requiredModels` mutáveis. Como o patch e a validação leem
 * essas tabelas a cada geração, alterá-las em tempo de execução corromperia
 * todas as gerações seguintes do processo, em silêncio — e o grafo submetido
 * ao ComfyUI passaria a apontar para nós errados.
 */
export function deepFreeze(valor) {
  if (valor === null || typeof valor !== 'object' || Object.isFrozen(valor)) return valor;
  Object.freeze(valor);
  for (const chave of Object.getOwnPropertyNames(valor)) {
    deepFreeze(valor[chave]);
  }
  return valor;
}

/**
 * Valida e congela um descriptor.
 *
 * Chamar isto é o que separa "objeto solto com os campos certos" de "workflow
 * registrável": um descriptor malformado falha na carga do módulo, não na
 * primeira geração do usuário.
 */
export function defineWorkflow(spec = {}) {
  const obrigatorios = {
    id: 'string',
    label: 'string',
    kind: 'string',
    file: 'string',
    nodeIds: 'object',
    nodeClasses: 'object',
    requiredModels: 'object',
    validate: 'function',
    patch: 'function',
  };

  for (const [campo, tipo] of Object.entries(obrigatorios)) {
    // eslint-disable-next-line valid-typeof
    if (typeof spec[campo] !== tipo || spec[campo] === null) {
      throw new WorkflowError(
        `Descriptor de workflow inválido: "${campo}" precisa ser ${tipo}.`,
        { campo, recebido: typeof spec[campo] },
      );
    }
  }

  if (!ID_RE.test(spec.id)) {
    throw new WorkflowError(
      `Id de workflow inválido: "${spec.id}". Use minúsculas, dígitos e sublinhado.`,
      { id: spec.id },
    );
  }
  if (!WORKFLOW_KINDS.includes(spec.kind)) {
    throw new WorkflowError(
      `Tipo de workflow desconhecido: "${spec.kind}".`,
      { kind: spec.kind, aceitos: WORKFLOW_KINDS },
    );
  }
  if (!Array.isArray(spec.requiredModels)) {
    throw new WorkflowError('Descriptor de workflow inválido: "requiredModels" precisa ser uma lista.');
  }

  // As tabelas que a validação e o patch consultam a cada geração ficam
  // imutáveis já aqui, antes de qualquer chamador enxergá-las.
  deepFreeze(spec.nodeIds);
  deepFreeze(spec.nodeClasses);
  deepFreeze(spec.requiredModels);
  if (Array.isArray(spec.modes)) deepFreeze(spec.modes);

  const descriptor = {
    legacyPathEnv: null,
    metaFromGraph: null,
    // 'comfy' = raiz do ComfyUI na máquina; 'project' = workflows/ versionado.
    rootName: 'comfy',
    ...spec,
    /** Caminho absoluto confiável. Resolvido a cada chamada, nunca guardado. */
    resolvePath(root) {
      return resolveDescriptorPath(
        {
          file: descriptor.file,
          legacyPathEnv: descriptor.legacyPathEnv,
          rootName: descriptor.rootName,
        },
        root,
      );
    },
    /** Lê o grafo do disco e o valida. Somente leitura — o arquivo é intocado. */
    loadTemplate(root) {
      return loadWorkflowFile(descriptor, root);
    },
  };

  // Não enumerável: um `{ ...descriptor }` não leva a marca junto, então uma
  // cópia solta nunca se passa pelo original perante o registry.
  Object.defineProperty(descriptor, MARCA, {
    value: true, enumerable: false, writable: false, configurable: false,
  });

  return Object.freeze(descriptor);
}

/**
 * Lê e valida o arquivo de um descriptor.
 *
 * A mensagem cita apenas o nome do arquivo: ela vira log e interface, e o
 * caminho completo revelaria a estrutura de diretórios da máquina.
 */
export async function loadWorkflowFile(descriptor, root) {
  const caminho = descriptor.resolvePath(root);
  const nome = caminho.split(/[\\/]/).pop() || caminho;

  let bruto;
  try {
    bruto = await readFile(caminho, 'utf8');
  } catch (erro) {
    throw new WorkflowError(`Não foi possível ler o workflow "${nome}".`, { cause: erro.code });
  }

  let grafo;
  try {
    grafo = JSON.parse(bruto);
  } catch {
    throw new WorkflowError(`O workflow "${nome}" não é JSON válido.`);
  }

  descriptor.validate(grafo);
  return grafo;
}

/**
 * Confere um grafo contra as declarações de um descriptor.
 *
 * É o motor genérico de validação: recebe as tabelas, não as conhece. Divergiu,
 * não submetemos — é melhor falhar aqui do que enfileirar um grafo errado.
 */
export function validateGraphAgainst(graph, { nodeClasses = {}, requiredModels = [] } = {}) {
  if (!graph || typeof graph !== 'object' || Array.isArray(graph)) {
    throw new WorkflowError('O workflow precisa ser um objeto de nós (formato API).');
  }

  const faltando = [];
  const divergentes = [];

  for (const [nodeId, classeEsperada] of Object.entries(nodeClasses)) {
    const node = graph[nodeId];
    if (!node) {
      faltando.push(nodeId);
      continue;
    }
    if (node.class_type !== classeEsperada) {
      divergentes.push({ nodeId, esperado: classeEsperada, encontrado: node.class_type });
    }
  }

  if (faltando.length) {
    throw new WorkflowError(`O workflow não tem os nós esperados: ${faltando.join(', ')}.`, { faltando });
  }
  if (divergentes.length) {
    throw new WorkflowError('O workflow mudou de estrutura: class_type divergente.', { divergentes });
  }

  const modelosDivergentes = requiredModels.filter(
    (m) => graph[m.node]?.inputs?.[m.field] !== m.file,
  );
  if (modelosDivergentes.length) {
    throw new WorkflowError('O workflow aponta para arquivos de modelo diferentes dos esperados.', {
      modelosDivergentes: modelosDivergentes.map((m) => ({
        role: m.role,
        esperado: m.file,
        encontrado: graph[m.node]?.inputs?.[m.field] ?? null,
      })),
    });
  }

  return true;
}
