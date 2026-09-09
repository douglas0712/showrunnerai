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

// `ensureProject` NÃO é reexportado de propósito. Ele cria um projeto a partir
// de um id solto, o que só faz sentido durante o backfill, onde as pastas em
// runtime/projects/ precedem o banco e não há descritor nenhum a consultar.
// Deixá-lo fora do barril é o que impede alguém de materializar projetos por
// acidente ao resolver um projectId que o usuário nunca criou. Quem precisa
// dele importa de './projects.js' explicitamente — hoje, só o backfill.
//
// Para registrar um projeto que o usuário JÁ TEM, com intenção explícita, a
// operação é `registerProject`: ela exige o descritor, com nome, e por isso
// não serve como porta de criação a partir de um identificador qualquer.
export {
  createProject,
  deleteProject,
  registerProject,
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
  linkAssetToJob,
  getAsset,
  listAssets,
  removeAssetRecord,
  setAssetStatus,
} from './assets.js';

export {
  bindGenerationJobMessage,
  completeGenerationJob,
  createGenerationJobRecord,
  findGenerationJobByProvider,
  getGenerationJobRecord,
  JOB_STATES,
  listGenerationJobsByThread,
  listOpenGenerationJobs,
  markGenerationJobSubmitted,
  setGenerationJobState,
  TERMINAL_JOB_STATES,
} from './generationJobs.js';

// Documentos de referência do projeto (PASSO 11).
//
// `readDocumentChunks` sai daqui porque a leitura paginada É regra de domínio —
// o teto, a ordem e o cursor moram junto com a tabela que os sustenta. O que
// NÃO sai é caminho de arquivo: ele não está guardado, e quem grava os bytes é
// a camada de ingestão, em lib/server/documents/.
export {
  countDocumentChunks,
  createProjectDocument,
  declaredDocumentFields,
  DOCUMENT_TYPES,
  DOCUMENT_TYPE_VALUES,
  getProjectDocument,
  getProjectDocumentIn,
  isDocumentType,
  listProjectDocuments,
  MAX_READ_CHARS,
  publicProjectDocument,
  readDocumentChunks,
  removeProjectDocument,
} from './documents.js';

export { backfillVideoAssets } from './backfill.js';
