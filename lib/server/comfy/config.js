// Configuração da integração com o ComfyUI.
//
// Este módulo só roda no servidor. O navegador nunca fala com o ComfyUI
// diretamente: ele chama as rotas internas em /api/comfy/*.
//
// O que sobrou aqui é o que NÃO pertence a um workflow específico: o endereço
// do ComfyUI, a raiz do armazenamento e as regras de upload de imagem. Tudo
// que era do MiniMax H3 — nós, classes, modelos, grade de frames, proporções,
// modos — mudou-se para o descriptor em
// lib/server/generation/workflows/minimaxH3.js e é reexportado abaixo.
//
// A reexportação é deliberada e temporária: mantém `import { NODE_IDS } from
// './config.js'` funcionando em events.js, provider.js e nos testes, para que
// a introdução do registry não exigisse tocar em nenhum chamador. Código novo
// deve pedir o descriptor ao registry em vez de importar daqui.

import { appPath } from '../appRoot.js';

export const COMFY_BASE_URL = process.env.COMFY_URL || 'http://127.0.0.1:8188';

/**
 * Raiz do armazenamento próprio do Showrunner Studio.
 *
 * Ancorada na raiz da aplicação, não no `process.cwd()`: um script executado
 * de outro diretório precisa enxergar o MESMO runtime, senão passaria a
 * escrever num lugar paralelo sem ninguém perceber. `LOGS_DIR` e o banco de
 * domínio derivam deste caminho e acompanham a correção.
 */
export const RUNTIME_ROOT = appPath('runtime', 'projects');

// ── superfície de compatibilidade: MiniMax H3 ───────────────────────────────
export {
  ASPECT_TO_SELECTOR,
  DEFAULT_ASPECT,
  DEFAULT_DURATION_SECONDS,
  DEFAULT_QUALITY,
  FRAME_GRID,
  FRAME_NODE_IDS,
  GENERATION_MODES,
  MODE_LABELS,
  NATIVE_FPS,
  NODE_CLASSES,
  NODE_IDS,
  OUTPUT_PREFIX_DIR,
  QUALITY_TO_MEGAPIXELS,
  REQUIRED_MODEL_FILES,
  TRAINED_FRAME_RANGE,
  WORKFLOW_PATH,
} from '../generation/workflows/minimaxH3.js';

// ── upload de imagem: vale para qualquer workflow ───────────────────────────

/** Subpasta dentro de `input/` do ComfyUI onde os quadros enviados ficam. */
export const UPLOAD_SUBFOLDER = 'showrunner';

/**
 * Formatos aceitos como quadro.
 *
 * `magic` é conferido nos bytes reais do arquivo: o `Content-Type` declarado
 * pelo navegador não é confiável e a extensão do nome, muito menos.
 */
export const ACCEPTED_IMAGE_TYPES = [
  { ext: 'png', mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: 'jpg', mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { ext: 'webp', mime: 'image/webp', magic: null }, // RIFF....WEBP — conferido à parte
];

/** Teto por quadro enviado. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Piso: abaixo disso não é imagem, é engano. */
export const MIN_UPLOAD_BYTES = 64;
