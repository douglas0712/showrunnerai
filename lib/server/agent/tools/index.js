// Tools do Showrunner — ponto de entrada.
//
// Cria e exporta o registry com as três tools nativas.

import { createToolRegistry, publicToolList, setToolRegistry } from './registry.js';
import { generateImageTool } from './handlers/generateImage.js';
import { generateVideoTool } from './handlers/generateVideo.js';
import { getJobTool } from './handlers/getJob.js';

const TOOLS = [
  generateImageTool,
  generateVideoTool,
  getJobTool,
];

// Instancia e armazena o registry global.
const registry = createToolRegistry(TOOLS);
setToolRegistry(registry);

export { registry, publicToolList };

// Reexporta acesso ao registry e funções para callers
export { toolRegistry } from './registry.js';

// Reexporta classes de erro para que callers saibam quais tratar.
export { ToolError, ToolExecutionError } from './schema.js';
export { ToolNotFoundError, DuplicateToolError } from './registry.js';

// O acompanhamento das gerações que as tools começam.
//
// Sai por este barril, e não por um import direto, porque o gateway alcança a
// camada de tools por AQUI e por mais lugar nenhum. Uma segunda porta de
// entrada faria a lista de imports do gateway — que um teste de arquitetura
// confere item a item — crescer sem que ninguém tivesse decidido isso.
export { bindTurnJobs, threadProduction } from './jobWatch.js';
