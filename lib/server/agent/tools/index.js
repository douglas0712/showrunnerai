// Tools do Showrunner — ponto de entrada.
//
// Cria e exporta o registry com as tools nativas.
//
// Duas famílias, e a divisão é de propósito:
//
//   og.*        o que a produção FAZ — gerar imagem, gerar vídeo, consultar o
//               andamento de uma geração.
//   project.*   o que o projeto TEM — o material de referência que o usuário
//               entregou, e o PLANO da produção: o que ela vai ser, o roteiro
//               e as cenas.
//
// O prefixo diz de quem é a coisa, e é isso que o torna útil: uma ferramenta
// `project.*` opera sobre o Project inteiro, atravessa conversas, e a
// autoridade dela é sempre o `projectId` do ToolContext.

import { createToolRegistry, publicToolList, setToolRegistry } from './registry.js';
import { generateImageTool } from './handlers/generateImage.js';
import { generateVideoTool } from './handlers/generateVideo.js';
import { getJobTool } from './handlers/getJob.js';
import { listDocumentsTool } from './handlers/listDocuments.js';
import { readDocumentTool } from './handlers/readDocument.js';
import {
  getProductionPlanTool, saveProductionPlanTool,
} from './handlers/productionPlan.js';
import { getScriptTool, saveScriptTool } from './handlers/productionScript.js';
import {
  getSceneTool, listScenesTool, replaceScenesTool, updateSceneTool,
} from './handlers/productionScenes.js';
import { generateSceneImageTool } from './handlers/productionSceneMedia.js';
import { generateSceneVideoTool } from './handlers/productionSceneVideo.js';
import {
  getSceneMediaTool, selectSceneTakeTool,
} from './handlers/productionSceneTakes.js';
import {
  generateSceneNarrationTool, getSceneNarrationTool, listSceneNarrationTakesTool,
  selectSceneNarrationTakeTool, setSceneNarrationTool,
} from './handlers/productionNarration.js';
import {
  createSceneSfxCueTool, deleteSceneSfxCueTool, generateSceneSfxTool,
  listSceneSfxCuesTool, listSceneSfxTakesTool, selectSceneSfxTakeTool,
  updateSceneSfxCueTool,
} from './handlers/productionSfx.js';
import {
  createProductionMusicCueTool, deleteProductionMusicCueTool,
  generateProductionMusicTool, listProductionMusicCuesTool,
  listProductionMusicTakesTool, selectProductionMusicTakeTool,
  updateProductionMusicCueTool,
} from './handlers/productionMusic.js';

const TOOLS = [
  generateImageTool,
  generateVideoTool,
  getJobTool,
  listDocumentsTool,
  readDocumentTool,
  // PASSO 12 — o planejamento da produção. Elas NÃO geram mídia: o passo
  // termina na cena descrita, e é por isso que nenhuma delas alcança
  // generation/.
  getProductionPlanTool,
  saveProductionPlanTool,
  getScriptTool,
  saveScriptTool,
  listScenesTool,
  getSceneTool,
  replaceScenesTool,
  updateSceneTool,
  // PASSO 13-B — a cena descrita vira cena com imagem. Ela alcança
  // generation/facade, ao contrário das oito acima: aqui o passo é gerar. O
  // que ela NÃO alcança é ComfyUI, workflow ou provider — isso continua sendo
  // da facade.
  generateSceneImageTool,
  // PASSO 13-C — a imagem escolhida da cena ganha movimento. O modelo diz
  // qual cena; quem resolve QUAL IMAGEM animar é o servidor.
  generateSceneVideoTool,
  // PASSO 13-D — conversar sobre o que a cena já tem. `get_scene_media` é o
  // que impede o agente de responder "qual imagem está selecionada?" pela
  // memória; `select_scene_take` é o que faz "use a segunda" ter efeito.
  getSceneMediaTool,
  selectSceneTakeTool,
  // PASSO 14-E — o som da produção vira conversa. Três famílias, e as três
  // separadas de propósito: a cardinalidade de cada uma é diferente, e uma
  // ferramenta só ("audio.generate") teria de esconder isso num parâmetro.
  //
  //     narração  uma por CENA      — o texto falado daquela cena
  //     efeito    vários por CENA   — trovão, porta e passos coexistem
  //     música    vários por PRODUÇÃO — uma trilha atravessa cenas
  //
  // Nenhuma delas alcança provider, workflow ou arquivo: isso continua sendo
  // de generation/, e o modelo nunca vê essas palavras.
  getSceneNarrationTool,
  setSceneNarrationTool,
  generateSceneNarrationTool,
  listSceneNarrationTakesTool,
  selectSceneNarrationTakeTool,
  createSceneSfxCueTool,
  updateSceneSfxCueTool,
  listSceneSfxCuesTool,
  deleteSceneSfxCueTool,
  generateSceneSfxTool,
  listSceneSfxTakesTool,
  selectSceneSfxTakeTool,
  createProductionMusicCueTool,
  updateProductionMusicCueTool,
  listProductionMusicCuesTool,
  deleteProductionMusicCueTool,
  generateProductionMusicTool,
  listProductionMusicTakesTool,
  selectProductionMusicTakeTool,
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
