// Ponto de entrada da camada de domínio.
//
// Quem consome o domínio importa daqui; os módulos internos ficam livres para
// se reorganizar sem quebrar chamadores. Nesta etapa nenhuma rota ainda usa
// este barril — a camada existe, e o localStorage do navegador continua sendo
// a fonte de verdade da interface até que a migração progressiva comece.

export {
  ASSET_KINDS,
  ASSET_STATUS,
  closeDatabase,
  database,
  DB_PATH,
  DomainError,
  ESQUEMA_ATUAL,
  newId,
  openDatabase,
  SCENE_STATUS_VALUES,
  schemaVersion,
} from './db.js';

// `ensureProject` NÃO é reexportado de propósito. Ele cria um projeto sem que
// ninguém tenha pedido, o que só faz sentido durante o backfill, onde as
// pastas em runtime/projects/ precedem o banco. Deixá-lo fora do barril é o
// que impede o Agent Gateway de, no futuro, materializar projetos por acidente
// ao resolver um projectId que o usuário nunca criou. Quem precisa dele
// importa de './projects.js' explicitamente — hoje, só o backfill.
export {
  createProject,
  deleteProject,
  getProject,
  isValidProjectId,
  listProjects,
  updateProject,
} from './projects.js';

export {
  createSceneRecord,
  getScene,
  listScenes,
  removeSceneRecord,
  renumberScenes,
  SCENE_STATUS,
  updateSceneRecord,
} from './scenes.js';

export {
  APPROVAL,
  assetDerivatives,
  assetLineage,
  createAsset,
  findAssetByFile,
  findAssetsByJob,
  getAsset,
  listAssets,
  removeAssetRecord,
  setAssetStatus,
} from './assets.js';

export { backfillVideoAssets } from './backfill.js';
