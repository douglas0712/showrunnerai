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

// Reexporta classes de erro para que callers saibam quais tratar.
export { ToolError, ToolExecutionError } from './schema.js';
export { ToolNotFoundError, DuplicateToolError } from './registry.js';
