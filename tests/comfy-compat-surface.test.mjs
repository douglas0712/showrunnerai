// Superfície de compatibilidade de comfy/config.js e comfy/workflow.js.
//
// O Passo 2 moveu o conhecimento do MiniMax H3 para um descriptor e deixou
// esses dois módulos reexportando dele. Este arquivo varre o repositório
// inteiro, coleta TODO símbolo que alguém importa deles e confirma que cada um
// continua existindo — é a rede que impede a próxima limpeza de reexportação
// de quebrar um consumidor em silêncio.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const MODULOS = {
  'lib/server/comfy/config.js': await import('../lib/server/comfy/config.js'),
  'lib/server/comfy/workflow.js': await import('../lib/server/comfy/workflow.js'),
};

/** Arquivos que importam qualquer um dos dois módulos. */
function arquivosQueImportam() {
  const saida = execFileSync('grep', [
    '-rl', '-e', "comfy/config.js", '-e', "comfy/workflow.js",
    '--include=*.js', '--include=*.jsx', '--include=*.mjs',
    'app', 'lib', 'components', 'tests',
  ], { cwd: process.cwd(), encoding: 'utf8' });
  return saida.trim().split('\n').filter(Boolean);
}

/** Símbolos nomeados importados de um dos dois módulos, por arquivo. */
async function importsDe(arquivo) {
  const fonte = await readFile(path.join(process.cwd(), arquivo), 'utf8');
  const encontrados = [];

  const re = /import\s*\{([^}]*)\}\s*from\s*['"]([^'"]*comfy\/(?:config|workflow)\.js)['"]/g;
  for (const m of fonte.matchAll(re)) {
    const alvo = m[2].includes('config.js')
      ? 'lib/server/comfy/config.js'
      : 'lib/server/comfy/workflow.js';
    const simbolos = m[1]
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean);
    encontrados.push({ alvo, simbolos });
  }
  return encontrados;
}

test('todo símbolo importado de config.js e workflow.js continua exportado', async () => {
  const arquivos = arquivosQueImportam();
  assert.ok(arquivos.length >= 10, `varredura encontrou poucos arquivos: ${arquivos.length}`);

  const faltando = [];
  let conferidos = 0;

  for (const arquivo of arquivos) {
    for (const { alvo, simbolos } of await importsDe(arquivo)) {
      for (const simbolo of simbolos) {
        conferidos += 1;
        if (!(simbolo in MODULOS[alvo])) {
          faltando.push(`${arquivo} → ${alvo}: ${simbolo}`);
        }
      }
    }
  }

  assert.deepEqual(faltando, [], `imports quebrados:\n  ${faltando.join('\n  ')}`);
  assert.ok(conferidos >= 25, `conferiu poucos símbolos: ${conferidos}`);
});

test('os símbolos que o MiniMax cedeu continuam alcançáveis por config.js', async () => {
  const config = MODULOS['lib/server/comfy/config.js'];
  const doMinimax = [
    'ASPECT_TO_SELECTOR', 'DEFAULT_ASPECT', 'DEFAULT_DURATION_SECONDS', 'DEFAULT_QUALITY',
    'FRAME_GRID', 'FRAME_NODE_IDS', 'GENERATION_MODES', 'MODE_LABELS', 'NATIVE_FPS',
    'NODE_CLASSES', 'NODE_IDS', 'OUTPUT_PREFIX_DIR', 'QUALITY_TO_MEGAPIXELS',
    'REQUIRED_MODEL_FILES', 'TRAINED_FRAME_RANGE', 'WORKFLOW_PATH',
  ];
  const proprios = [
    'COMFY_BASE_URL', 'RUNTIME_ROOT', 'UPLOAD_SUBFOLDER',
    'ACCEPTED_IMAGE_TYPES', 'MAX_UPLOAD_BYTES', 'MIN_UPLOAD_BYTES',
  ];

  for (const nome of [...doMinimax, ...proprios]) {
    assert.ok(nome in config, `config.js deixou de exportar ${nome}`);
  }
});

test('as funções que workflow.js cedeu continuam alcançáveis por ele', async () => {
  const wf = MODULOS['lib/server/comfy/workflow.js'];
  for (const nome of [
    'attachFrames', 'aspectFromSelector', 'computeFrames', 'framesToSeconds',
    'isWithinTrainedRange', 'loadWorkflowTemplate', 'megapixelsForQuality',
    'metaFromSubmittedGraph', 'modeFromGraph', 'patchWorkflow', 'qualityFromMegapixels',
    'randomSeed', 'selectorForAspect', 'validateWorkflow', 'WorkflowError',
  ]) {
    assert.ok(nome in wf, `workflow.js deixou de exportar ${nome}`);
  }
});

test('WorkflowError é uma classe só, em todos os módulos que a reexportam', async () => {
  const [antiga, descriptor, minimax, registry] = await Promise.all([
    import('../lib/server/comfy/workflow.js'),
    import('../lib/server/generation/workflows/descriptor.js'),
    import('../lib/server/generation/workflows/minimaxH3.js'),
    import('../lib/server/generation/workflows/registry.js'),
  ]);

  assert.equal(antiga.WorkflowError, descriptor.WorkflowError);
  assert.equal(descriptor.WorkflowError, minimax.WorkflowError);
  assert.equal(minimax.WorkflowError, registry.WorkflowError);

  // É o `instanceof` de app/api/comfy/generate/route.js que mapeia para 422.
  const template = await antiga.loadWorkflowTemplate();
  assert.throws(
    () => antiga.patchWorkflow(template, { prompt: '', jobId: 'j' }),
    (erro) => erro instanceof antiga.WorkflowError && erro.name === 'WorkflowError',
  );
});
