// Tool Registry — catálogo das tools disponíveis no Showrunner.
//
// As tools são registradas uma única vez, no startup. O registry é imutável;
// chamadores não conseguem alterar ou adicionar tools em tempo de execução.
//
// A registry conhece:
// - name, description, inputSchema, execute
//
// O chamador recebe:
// - name, description, inputSchema (SEM execute)
//
// Isso mantém a fronteira entre o que Showrunner oferece (tool definitions)
// e o que runtime pode fazer (invocar callables preparadas para ele).

import { defineTool, isToolDescriptor, ToolError } from './schema.js';

/** Erro de acesso à registry. */
export class ToolNotFoundError extends ToolError {
  constructor(name) {
    super(`Tool desconhecida: "${name}".`);
    this.name = 'ToolNotFoundError';
    this.detail = { toolName: name };
  }
}

export class DuplicateToolError extends ToolError {
  constructor(name) {
    super(`Tool duplicada no registry: "${name}".`);
    this.name = 'DuplicateToolError';
    this.detail = { toolName: name };
  }
}

/**
 * Constrói um registry.
 *
 * Cada tool é um descriptor (produzido por defineTool).
 * Nomes duplicados são erro de startup, e o processo falha alto.
 */
export function createToolRegistry(toolDefinitions = []) {
  const tools = new Map();

  for (const descriptor of toolDefinitions) {
    if (!isToolDescriptor(descriptor)) {
      throw new ToolError('Tool no registry precisa vir de defineTool().');
    }

    if (tools.has(descriptor.name)) {
      throw new DuplicateToolError(descriptor.name);
    }

    tools.set(descriptor.name, descriptor);
  }

  // Congelado: chamadores não conseguem fazer registry.tools.set(...).
  return Object.freeze({
    getTool: (name) => {
      const tool = tools.get(String(name));
      if (!tool) throw new ToolNotFoundError(name);
      return tool;
    },

    hasTool: (name) => tools.has(String(name)),

    listTools: () => Array.from(tools.values()),

    /**
     * Invoca uma tool.
     *
     * Responsabilidades:
     * - existe?
     * - validação acontece dentro do handler
     * - handler pode lançar ToolExecutionError
     *
     * O contexto é confiável (vem do Gateway).
     * Os args vêm do runtime e podem ser arbitrários.
     */
    invoke: async (name, context, args) => {
      const tool = tools.get(String(name));
      if (!tool) throw new ToolNotFoundError(name);

      try {
        return await tool.execute(context, args);
      } catch (erro) {
        if (erro && typeof erro === 'object' && erro.name === 'ToolExecutionError') {
          throw erro;
        }
        // Erro não tipado: embrulha para deixar claro que foi na execução.
        throw new ToolError(
          `Tool "${name}" falhou: ${erro?.message || 'erro desconhecido'}.`,
          { toolName: name, originalError: erro?.message },
        );
      }
    },
  });
}

/**
 * Cria a lista de tools PÚBLICAS que será oferecida ao runtime.
 *
 * O runtime recebe name, description, inputSchema.
 * Execute fica interno; o runtime invoca através de um callable seguro
 * preparado pelo Gateway.
 */
export function publicToolList(registry) {
  return registry.listTools().map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  }));
}

/** Instância global do registry. Criada uma única vez. */
let instanceRegistry = null;

export function setToolRegistry(registry) {
  instanceRegistry = registry;
}

export function toolRegistry() {
  if (!instanceRegistry) {
    throw new ToolError('Tool registry não foi inicializado.');
  }
  return instanceRegistry;
}
