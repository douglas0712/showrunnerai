// Ideogram 4 — o segundo workflow nativo, e o primeiro de imagem.
//
// O template usado aqui é o do projeto (`workflows/ideogram4_t2i_api.json`),
// uma cópia controlada do pipeline validado à mão. Estes testes provam que o
// descriptor é dono do próprio conhecimento e que ele não interfere no MiniMax.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getWorkflow, hasWorkflow, listWorkflows, workflowRegistry,
} from '../lib/server/generation/workflows/registry.js';
import {
  ideogram4T2I, NODE_IDS, OUTPUT_PREFIX_DIR, QUALITY_TO_MEGAPIXELS, REQUIRED_MODEL_FILES,
} from '../lib/server/generation/workflows/ideogram4.js';
import { minimaxH3T2V } from '../lib/server/generation/workflows/minimaxH3.js';
import { WorkflowError } from '../lib/server/generation/workflows/descriptor.js';
import {
  PROJECT_WORKFLOWS_ROOT, resolveWorkflowPath,
} from '../lib/server/generation/workflows/paths.js';
import { findMediaOutput, jobIdFromOutputFilename } from '../lib/server/generation/outputs.js';
import { mediaKind } from '../lib/server/generation/mediaKinds.js';

const template = await ideogram4T2I.loadTemplate();
const minimaxTemplate = await minimaxH3T2V.loadTemplate();

const PARAMS = {
  prompt: 'a red dragon over an ancient city',
  seed: 4242,
  aspect: '16:9',
  quality: '1K',
  jobId: 'img_teste_ideogram',
};

// ── 1–3. registro e identidade ──────────────────────────────────────────────

test('1. o Ideogram aparece no registry ao lado do MiniMax', () => {
  assert.equal(hasWorkflow('ideogram4_t2i'), true);
  assert.deepEqual(workflowRegistry.ids(), ['minimax_h3_t2v', 'ideogram4_t2i', 'stable_audio_sfx',
    'ace_step_15_music']);

  const resumo = listWorkflows().find((w) => w.id === 'ideogram4_t2i');
  assert.ok(resumo);
  assert.equal(resumo.kind, 'image');
  assert.equal(resumo.file, 'ideogram4_t2i_api.json');
  assert.deepEqual(resumo.modes, ['t2i']);
  assert.equal(getWorkflow('ideogram4_t2i'), ideogram4T2I);
});

test('2. kind é image, e isso é o que dirige o pipeline', () => {
  assert.equal(ideogram4T2I.kind, 'image');
  assert.equal(mediaKind(ideogram4T2I.kind).dir, 'images');
  assert.equal(mediaKind(ideogram4T2I.kind).urlSegment, 'image');
  assert.equal(mediaKind(ideogram4T2I.kind).supportsRange, false);
  assert.equal(mediaKind(ideogram4T2I.kind).extensionSource, 'bytes');
});

test('3. o descriptor é imutável, inclusive nas tabelas críticas', () => {
  assert.ok(Object.isFrozen(ideogram4T2I));
  assert.ok(Object.isFrozen(ideogram4T2I.nodeIds));
  assert.ok(Object.isFrozen(ideogram4T2I.nodeClasses));
  assert.ok(Object.isFrozen(ideogram4T2I.requiredModels));
  for (const modelo of ideogram4T2I.requiredModels) assert.ok(Object.isFrozen(modelo));

  assert.throws(() => { ideogram4T2I.kind = 'video'; }, TypeError);
  assert.throws(() => { ideogram4T2I.nodeIds.prompt = 'HACK'; }, TypeError);
  assert.throws(() => { ideogram4T2I.requiredModels[0].file = 'outro.safetensors'; }, TypeError);
  assert.equal(NODE_IDS.prompt, '98:24');
});

// ── 4–5. template real ──────────────────────────────────────────────────────

test('4. o template real do projeto é validado pelo descriptor', () => {
  assert.equal(ideogram4T2I.validate(template), true);
  assert.equal(Object.keys(template).length, 29);

  // O arquivo é o do projeto, não o diretório externo onde foi validado.
  const caminho = ideogram4T2I.resolvePath();
  assert.equal(path.dirname(caminho), PROJECT_WORKFLOWS_ROOT);
  assert.ok(!caminho.includes('hermes-ideogram'), 'ainda aponta para fora do projeto');
});

test('5. o nó de prompt é o 98:24 CLIPTextEncode, com input text literal', () => {
  assert.equal(NODE_IDS.prompt, '98:24');
  assert.equal(template[NODE_IDS.prompt].class_type, 'CLIPTextEncode');
  assert.equal(typeof template[NODE_IDS.prompt].inputs.text, 'string',
    'o prompt precisa ser literal — se virar link, o patch não o alcança');

  // Os demais nós que o descriptor declara batem com o grafo real.
  for (const [nodeId, classe] of Object.entries(ideogram4T2I.nodeClasses)) {
    assert.equal(template[nodeId]?.class_type, classe, `nó ${nodeId}`);
  }
  // E os quatro arquivos de modelo continuam referenciados.
  for (const m of REQUIRED_MODEL_FILES) {
    assert.equal(template[m.node].inputs[m.field], m.file, m.role);
  }
});

test('a cópia do projeto não carrega os nós órfãos do original', async () => {
  // Os 10 nós removidos alimentavam apenas PreviewAny e não eram alcançáveis
  // pelo SaveImage; mantê-los faria o ComfyUI executá-los a cada geração.
  for (const orfao of ['111', '134:114', '134:115', '134:163', '134:164',
    '134:165', '134:166', '134:167', '134:169', '134:170']) {
    assert.equal(template[orfao], undefined, `nó órfão ${orfao} veio junto`);
  }
  assert.ok(!Object.values(template).some((n) => n.class_type === 'PreviewAny'));

  // E o subgrafo que gera a imagem continua idêntico ao validado.
  const original = JSON.parse(
    await readFile('/home/douglas/hermes-ideogram/workflow_ideogram4_api.json', 'utf8'),
  );
  for (const [nodeId, node] of Object.entries(template)) {
    assert.deepEqual(node, original[nodeId], `nó ${nodeId} divergiu do original`);
  }
});

// ── 6–7. patch ──────────────────────────────────────────────────────────────

test('6. o patch troca o prompt sem tocar no template', () => {
  const antes = JSON.stringify(template);
  const { graph, meta } = ideogram4T2I.patch(template, PARAMS);

  assert.equal(graph[NODE_IDS.prompt].inputs.text, PARAMS.prompt);
  assert.equal(meta.prompt, PARAMS.prompt);
  assert.equal(meta.mode, 't2i');
  assert.equal(meta.model, 'Ideogram 4');

  assert.equal(JSON.stringify(template), antes, 'o template foi mutado');
  assert.notEqual(graph[NODE_IDS.prompt], template[NODE_IDS.prompt]);
});

test('7. o patch troca a seed, e sem seed gera uma nova', () => {
  const comSeed = ideogram4T2I.patch(template, PARAMS);
  assert.equal(comSeed.graph[NODE_IDS.seed].inputs.noise_seed, 4242);
  assert.equal(comSeed.meta.seed, 4242);
  assert.equal(comSeed.meta.seedLocked, true);

  const semSeed = ideogram4T2I.patch(template, { ...PARAMS, seed: null });
  assert.equal(typeof semSeed.graph[NODE_IDS.seed].inputs.noise_seed, 'number');
  assert.equal(semSeed.meta.seedLocked, false);
  assert.notEqual(semSeed.meta.seed, template[NODE_IDS.seed].inputs.noise_seed);
});

test('o patch aplica proporção pela allowlist do nó, nunca valor livre', () => {
  const { graph, meta } = ideogram4T2I.patch(template, PARAMS);
  assert.equal(graph[NODE_IDS.resolution].inputs.aspect_ratio, '16:9 (Widescreen)');
  assert.equal(graph[NODE_IDS.resolution].inputs.megapixels, 1.0);
  assert.equal(meta.aspect, '16:9');

  // Um rótulo interno ou uma proporção inventada são recusados.
  for (const ruim of ['7:3', '16:9 (Widescreen)', 'qualquer', '', null, 42, '../x']) {
    assert.throws(() => ideogram4T2I.patch(template, { ...PARAMS, aspect: ruim }),
      WorkflowError, `aceitou aspect "${ruim}"`);
  }
  for (const ruim of ['8K', '480p', '', null, 99]) {
    assert.throws(() => ideogram4T2I.patch(template, { ...PARAMS, quality: ruim }),
      WorkflowError, `aceitou quality "${ruim}"`);
  }
});

test('o patch recusa prompt vazio e jobId inseguro', () => {
  for (const ruim of ['', '   ', null, 42, 'x'.repeat(4001)]) {
    assert.throws(() => ideogram4T2I.patch(template, { ...PARAMS, prompt: ruim }), WorkflowError);
  }
  for (const ruim of ['../escapar', 'a/b', '', null, 'x'.repeat(65)]) {
    assert.throws(() => ideogram4T2I.patch(template, { ...PARAMS, jobId: ruim }), WorkflowError);
  }
  assert.throws(() => ideogram4T2I.patch(template, { ...PARAMS, seed: -1 }), WorkflowError);
});

test('o filename_prefix é derivado do jobId, sob o prefixo do descriptor', () => {
  const { graph, meta } = ideogram4T2I.patch(template, PARAMS);
  assert.equal(graph[NODE_IDS.save].inputs.filename_prefix, 'image/showrunner/img_teste_ideogram');
  assert.equal(meta.filenamePrefix, 'image/showrunner/img_teste_ideogram');
  assert.equal(ideogram4T2I.outputPrefix, OUTPUT_PREFIX_DIR);

  // O template original vinha com o prefixo do pipeline externo.
  assert.equal(template[NODE_IDS.save].inputs.filename_prefix, 'Ideogram_4.0');
});

test('o patch não altera sampler, scheduler nem o guider validados', () => {
  const { graph } = ideogram4T2I.patch(template, PARAMS);
  for (const nodeId of [NODE_IDS.sampler, NODE_IDS.scheduler, NODE_IDS.guider,
    NODE_IDS.unet, NODE_IDS.unetNegative, NODE_IDS.clip, NODE_IDS.vae]) {
    assert.deepEqual(graph[nodeId], template[nodeId], `o patch mexeu no nó ${nodeId}`);
  }
});

test('metaFromGraph reconstrói a proveniência de um grafo submetido', () => {
  const { graph } = ideogram4T2I.patch(template, PARAMS);
  const meta = ideogram4T2I.metaFromGraph(graph, 'img_recuperado');

  assert.equal(meta.jobId, 'img_recuperado');
  assert.equal(meta.prompt, PARAMS.prompt);
  assert.equal(meta.seed, 4242);
  assert.equal(meta.aspect, '16:9');
  assert.equal(meta.quality, '1K');
  assert.equal(meta.recovered, true);
  assert.equal(ideogram4T2I.metaFromGraph({}, 'x'), null);
});

// ── isolamento entre os dois workflows ──────────────────────────────────────

test('um workflow não interfere na validação do outro', () => {
  assert.throws(() => ideogram4T2I.validate(minimaxTemplate), WorkflowError);
  assert.throws(() => minimaxH3T2V.validate(template), WorkflowError);

  // Nós, modelos e prefixos são distintos e não se cruzam.
  assert.notEqual(ideogram4T2I.nodeIds.prompt, minimaxH3T2V.nodeIds.prompt);
  assert.notEqual(ideogram4T2I.outputPrefix, minimaxH3T2V.outputPrefix);
  assert.equal(ideogram4T2I.rootName, 'project');
  assert.equal(minimaxH3T2V.rootName, 'comfy');

  const modelosIdeogram = new Set(ideogram4T2I.requiredModels.map((m) => m.file));
  const modelosMinimax = new Set(minimaxH3T2V.requiredModels.map((m) => m.file));
  for (const f of modelosIdeogram) assert.ok(!modelosMinimax.has(f), `modelo compartilhado: ${f}`);
});

test('a descoberta de saída segue o kind de cada descriptor', () => {
  const saidaImagem = {
    [ideogram4T2I.nodeIds.save]: {
      images: [{ filename: 'img_x_00001_.png', subfolder: 'image/showrunner', type: 'output' }],
    },
  };

  const achado = findMediaOutput(saidaImagem, {
    kind: ideogram4T2I.kind,
    saveNodeId: ideogram4T2I.nodeIds.save,
  });
  assert.equal(achado.filename, 'img_x_00001_.png');
  assert.equal(achado.mime, 'image/png');
  assert.equal(jobIdFromOutputFilename(achado.filename, { kind: 'image' }), 'img_x');

  // O mesmo payload, procurado como vídeo, não devolve nada.
  assert.equal(findMediaOutput(saidaImagem, { kind: 'video' }), null);
});

test('a tabela de qualidade é do Ideogram, não herdada do vídeo', () => {
  assert.deepEqual(Object.keys(QUALITY_TO_MEGAPIXELS), ['1K', '2K', '4K']);
  assert.equal(QUALITY_TO_MEGAPIXELS['1K'], 1.0, 'o padrão precisa ser o do workflow validado');
  assert.deepEqual(ideogram4T2I.qualities, ['1K', '2K', '4K']);
  assert.deepEqual(ideogram4T2I.aspects.slice(0, 3), ['1:1', '2:3', '3:2']);
});

// ── raiz do projeto independente do cwd ─────────────────────────────────────
//
// O smoke test do Passo 4 falhou ao ser executado de outro diretório porque a
// raiz `workflows/` era `process.cwd() + '/workflows'`. Agora ela é descoberta
// a partir da localização do próprio módulo, subindo até o package.json com
// nome — o que funciona de qualquer cwd e não presume profundidade fixa.

import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { APP_ROOT } from '../lib/server/generation/workflows/paths.js';

const PROJECT_WORKFLOWS_ROOT_LOCAL = PROJECT_WORKFLOWS_ROOT;

const RAIZ_PROJETO = APP_ROOT;

/** Resolve o Ideogram num subprocesso com o cwd que se pedir. */
function resolverComCwd(cwd, env = {}) {
  const script = `
    const raiz = ${JSON.stringify(RAIZ_PROJETO)};
    const { APP_ROOT, PROJECT_WORKFLOWS_ROOT } =
      await import(raiz + '/lib/server/generation/workflows/paths.js');
    const { getWorkflow } =
      await import(raiz + '/lib/server/generation/workflows/registry.js');

    const wf = getWorkflow('ideogram4_t2i');
    const template = await wf.loadTemplate();

    process.stdout.write(JSON.stringify({
      cwd: process.cwd(),
      appRoot: APP_ROOT,
      workflowsRoot: PROJECT_WORKFLOWS_ROOT,
      caminho: wf.resolvePath(),
      valido: wf.validate(template),
      nos: Object.keys(template).length,
      temPromptNode: typeof template['98:24']?.inputs?.text === 'string',
    }));
  `;
  const saida = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8',
  });
  return JSON.parse(saida);
}

test('a raiz do projeto não depende do cwd do processo', async () => {
  const outroCwd = await mkdtemp(path.join(tmpdir(), 'cwd-alheio-'));
  try {
    const daRaiz = resolverComCwd(RAIZ_PROJETO);
    const deFora = resolverComCwd(outroCwd);
    const deRaizDoSistema = resolverComCwd('/');

    // Os três cwd são realmente diferentes.
    assert.equal(daRaiz.cwd, RAIZ_PROJETO);
    assert.equal(deFora.cwd, outroCwd);
    assert.equal(deRaizDoSistema.cwd, '/');

    // …e os três encontram exatamente o mesmo arquivo.
    for (const r of [daRaiz, deFora, deRaizDoSistema]) {
      assert.equal(r.appRoot, RAIZ_PROJETO, `APP_ROOT errado com cwd=${r.cwd}`);
      assert.equal(r.workflowsRoot, path.join(RAIZ_PROJETO, 'workflows'));
      assert.equal(r.caminho, path.join(RAIZ_PROJETO, 'workflows', 'ideogram4_t2i_api.json'));
      assert.equal(r.valido, true, `template não validou com cwd=${r.cwd}`);
      assert.equal(r.nos, 29);
      assert.equal(r.temPromptNode, true);
    }
  } finally {
    await rm(outroCwd, { recursive: true, force: true });
  }
});

test('SHOWRUNNER_WORKFLOWS_ROOT é o override de operador, com padrão derivado', async () => {
  const alternativa = await mkdtemp(path.join(tmpdir(), 'wf-alternativa-'));
  try {
    // Sem a variável, a raiz vem da própria aplicação.
    assert.equal(resolverComCwd('/').workflowsRoot, path.join(RAIZ_PROJETO, 'workflows'));

    // Com ela, a raiz muda — mas continua sendo configuração de servidor.
    const script = `
      const { PROJECT_WORKFLOWS_ROOT } =
        await import(${JSON.stringify(RAIZ_PROJETO)} + '/lib/server/generation/workflows/paths.js');
      process.stdout.write(PROJECT_WORKFLOWS_ROOT);
    `;
    const saida = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: '/',
      env: { ...process.env, SHOWRUNNER_WORKFLOWS_ROOT: alternativa },
      encoding: 'utf8',
    });
    assert.equal(saida, path.resolve(alternativa));
  } finally {
    await rm(alternativa, { recursive: true, force: true });
  }
});

test('as duas raízes continuam separadas e independentes', () => {
  const script = `
    const raiz = ${JSON.stringify(RAIZ_PROJETO)};
    const { PROJECT_WORKFLOWS_ROOT, WORKFLOWS_ROOT } =
      await import(raiz + '/lib/server/generation/workflows/paths.js');
    const { getWorkflow } = await import(raiz + '/lib/server/generation/workflows/registry.js');
    process.stdout.write(JSON.stringify({
      projeto: PROJECT_WORKFLOWS_ROOT,
      comfy: WORKFLOWS_ROOT,
      ideogram: getWorkflow('ideogram4_t2i').resolvePath(),
      minimax: getWorkflow('minimax_h3_t2v').resolvePath(),
    }));
  `;
  const r = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: '/',
    env: { ...process.env, COMFY_WORKFLOWS_ROOT: '/opt/comfy-wf', COMFY_WORKFLOW: '' },
    encoding: 'utf8',
  }));

  // COMFY_WORKFLOWS_ROOT move só os workflows externos.
  assert.equal(r.comfy, '/opt/comfy-wf');
  assert.equal(r.minimax, '/opt/comfy-wf/minimax_h3_t2v_api.json');

  // A raiz do projeto não se mexe com isso.
  assert.equal(r.projeto, path.join(RAIZ_PROJETO, 'workflows'));
  assert.equal(r.ideogram, path.join(RAIZ_PROJETO, 'workflows', 'ideogram4_t2i_api.json'));
});

test('a descoberta da raiz não para no package.json da build do Next', async () => {
  const { readFile } = await import('node:fs/promises');
  // A descoberta mora em lib/server/appRoot.js, consumida por paths.js e por
  // comfy/config.js — uma fonte de verdade só.
  const fonte = await readFile(
    new URL('../lib/server/appRoot.js', import.meta.url), 'utf8',
  );

  // O `.next/package.json` gerado pela build tem só {"type":"commonjs"}; a
  // exigência de um `name` é o que impede a busca de parar lá.
  assert.match(fonte, /typeof pkg\?\.name === 'string'/);
  assert.ok(!/showrunner-studio/.test(fonte), 'caminho do projeto codificado');

  const dePaths = await readFile(
    new URL('../lib/server/generation/workflows/paths.js', import.meta.url), 'utf8',
  );
  assert.ok(!/process\.cwd\(\), 'workflows'/.test(dePaths), 'a raiz voltou a ser derivada do cwd');
  assert.ok(!/readFileSync/.test(dePaths), 'a descoberta foi duplicada em paths.js');
});

test('a contenção de caminho vale igual na raiz do projeto', () => {
  for (const nome of ['../fora.json', '../../etc/passwd.json', 'sub/../../x.json',
    '/absoluto.json', 'a/b.json', 'x.exe']) {
    assert.throws(
      () => resolveWorkflowPath(nome, PROJECT_WORKFLOWS_ROOT_LOCAL),
      { name: 'WorkflowPathError' },
      `aceitou "${nome}"`,
    );
  }
  const bom = resolveWorkflowPath('ideogram4_t2i_api.json', PROJECT_WORKFLOWS_ROOT_LOCAL);
  assert.ok(bom.startsWith(`${PROJECT_WORKFLOWS_ROOT_LOCAL}${path.sep}`));
});
