// Schema e contrato de uma tool do Showrunner.
//
// As tools são propriedade do Showrunner, não do runtime. O runtime futuro
// (Hermes) apenas receberá os schemas e callables destas tools — não as
// reinventa, não as renomeia, não as estende.
//
// Cada tool declara:
//
//   name       string  — canonical "og.generate_image" (pode ter ponto;
//                        eventual tradução para og_generate_image é
//                        responsabilidade do adapter futuro)
//   description string  — o que a tool faz, em português
//   inputSchema object  — os parâmetros que aceita
//   execute     async   — handler do runtime
//
// inputSchema é JSON-Schema-like, mas validação é própria (não há JSON-Schema
// como dependência). O formato permite que um futuro LLM/tool-calling use,
// mas é a responsabilidade de quem implementa adapters traduzir formatos.

/** Erro de schema ou contrato de tool. */
export class ToolError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ToolError';
    this.detail = detail;
  }
}

/** Erro ao executar uma tool — não é erro de contrato. */
export class ToolExecutionError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ToolExecutionError';
    this.detail = detail;
  }
}

/**
 * Marca de procedência: só um objeto vindo de `defineTool` a carrega.
 * Mesma estratégia dos workflow descriptors.
 */
const MARCA = Symbol.for('showrunner.agent.tool');

/**
 * Valida e congela um descriptor de tool.
 * Nunca muta; devolve um novo objeto se houver problema.
 */
export function defineTool(tool) {
  if (!tool || typeof tool !== 'object') {
    throw new ToolError('Tool descriptor deve ser um objeto.');
  }

  const { name, description, inputSchema, execute } = tool;

  if (typeof name !== 'string' || !name.trim()) {
    throw new ToolError('Tool precisa de um name (string não vazia).');
  }

  if (!/^[a-z0-9_.]+$/.test(name)) {
    throw new ToolError(`Name deve conter apenas letras minúsculas, dígitos, _ e .: "${name}".`);
  }

  if (typeof description !== 'string' || !description.trim()) {
    throw new ToolError('Tool precisa de uma description (string não vazia).');
  }

  if (!inputSchema || typeof inputSchema !== 'object') {
    throw new ToolError('Tool precisa de um inputSchema (objeto).');
  }

  if (typeof execute !== 'function') {
    throw new ToolError('Tool precisa de uma execute function.');
  }

  const descriptor = Object.freeze({
    [MARCA]: true,
    name: name.trim(),
    description: description.trim(),
    inputSchema: Object.freeze({ ...inputSchema }),
    execute,
  });

  return descriptor;
}

/**
 * Um tool descriptor legítimo carrega a marca E está congelado.
 * Mesma garantia que o workflow descriptor.
 */
export function isToolDescriptor(valor) {
  return Boolean(valor && valor[MARCA] === true && Object.isFrozen(valor));
}

/**
 * Extrai o que um runtime precisa de um tool, sem expor o handler.
 * O runtime recebe name, description e inputSchema — não execute.
 */
export function publicToolShape(descriptor) {
  if (!isToolDescriptor(descriptor)) {
    throw new ToolError('Descriptor inválido.');
  }

  return Object.freeze({
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
  });
}
