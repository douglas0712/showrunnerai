// Registry de workflows: seleção por id, isolamento entre descriptors e a
// garantia central desta etapa — o caminho do arquivo vem do descriptor, nunca
// de quem pede a geração.
//
// A validação do MiniMax continua sendo testada em tests/comfy-workflow.test.mjs
// pela superfície antiga. Aqui ela é reconferida pela superfície nova, para que
// as duas não possam divergir em silêncio.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createWorkflowRegistry, getWorkflow, hasWorkflow, listWorkflows,
  UnknownWorkflowError, workflowRegistry,
} from '../lib/server/generation/workflows/registry.js';
import {
  defineWorkflow, validateGraphAgainst, WorkflowError,
} from '../lib/server/generation/workflows/descriptor.js';
import {
  assertInsideRoot, resolveWorkflowPath, validateWorkflowFilename, WORKFLOWS_ROOT,
  WorkflowPathError,
} from '../lib/server/generation/workflows/paths.js';
import { minimaxH3T2V, NODE_IDS, REQUIRED_MODEL_FILES } from '../lib/server/generation/workflows/minimaxH3.js';
import { patchWorkflow as patchPelaSuperficieAntiga } from '../lib/server/comfy/workflow.js';

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-wf-'));
test.after(() => rm(RAIZ, { recursive: true, force: true }));

const template = await minimaxH3T2V.loadTemplate();

// ── registry ────────────────────────────────────────────────────────────────

test('o MiniMax aparece em listWorkflows() com a forma esperada', () => {
  const lista = listWorkflows();
  const minimax = lista.find((w) => w.id === 'minimax_h3_t2v');

  assert.ok(minimax, 'o MiniMax precisa estar registrado');
  assert.equal(minimax.kind, 'video');
  assert.equal(minimax.file, 'minimax_h3_t2v_api.json');
  assert.deepEqual(minimax.modes, ['t2v', 'i2v', 'flf']);

  // O resumo é seguro para log e interface: declara o NOME do arquivo, nunca
  // o caminho em disco nem a raiz configurada.
  const serializado = JSON.stringify(lista);
  assert.ok(!serializado.includes(WORKFLOWS_ROOT), 'listWorkflows vazou a raiz');
  assert.ok(!lista.some((w) => w.file.includes('/')), 'file precisa ser só o nome');
  assert.ok(!Object.keys(minimax).includes('path'), 'o resumo não expõe caminho');
});

test('getWorkflow devolve o descriptor correto', () => {
  const wf = getWorkflow('minimax_h3_t2v');
  assert.equal(wf, minimaxH3T2V, 'precisa ser o mesmo objeto, não uma cópia');
  assert.equal(wf.nodeIds.prompt, '105:104');
  assert.equal(wf.nodeClasses[wf.nodeIds.prompt], 'MiniMaxH3ImageToVideo');
  assert.equal(wf.requiredModels.length, 4);
  assert.equal(typeof wf.patch, 'function');
  assert.equal(typeof wf.validate, 'function');
});

test('hasWorkflow distingue conhecido de desconhecido', () => {
  assert.equal(hasWorkflow('minimax_h3_t2v'), true);
  assert.equal(hasWorkflow('ideogram4_t2i'), true, 'o Ideogram passou a ser registrado no Passo 4');
  assert.equal(hasWorkflow('workflow_inexistente'), false);
  assert.equal(hasWorkflow(''), false);
  assert.equal(hasWorkflow(null), false);
  assert.equal(hasWorkflow('../../etc/passwd'), false);
});

test('workflow desconhecido falha alto, e nunca cai em outro', () => {
  for (const id of ['workflow_inexistente', 'nao_existe', '', null, undefined, 42]) {
    assert.throws(
      () => getWorkflow(id),
      UnknownWorkflowError,
      `aceitou silenciosamente "${id}"`,
    );
  }

  // A mensagem diz o que existe, para o erro ser acionável.
  try {
    getWorkflow('workflow_inexistente');
    assert.fail('deveria ter lançado');
  } catch (erro) {
    assert.match(erro.message, /Workflow desconhecido: "workflow_inexistente"/);
    assert.match(erro.message, /minimax_h3_t2v/);
    assert.deepEqual(erro.detail.conhecidos, ['minimax_h3_t2v', 'ideogram4_t2i', 'stable_audio_sfx',
    'ace_step_15_music']);
  }
});

test('o descriptor congelado não pode ser adulterado em tempo de execução', () => {
  assert.ok(Object.isFrozen(minimaxH3T2V));
  assert.throws(() => { minimaxH3T2V.file = 'outro.json'; }, TypeError);
  assert.equal(minimaxH3T2V.file, 'minimax_h3_t2v_api.json');
});

// ── coexistência de descriptors ─────────────────────────────────────────────

function descriptorFicticio(id, extras = {}) {
  return defineWorkflow({
    id,
    label: `Fictício ${id}`,
    kind: 'image',
    file: `${id}.json`,
    nodeIds: { prompt: '1' },
    nodeClasses: { 1: 'CLIPTextEncode' },
    requiredModels: [],
    validate: (graph) => validateGraphAgainst(graph, { nodeClasses: { 1: 'CLIPTextEncode' } }),
    patch: (tpl, opts) => ({ graph: structuredClone(tpl), meta: { id, ...opts } }),
    ...extras,
  });
}

test('dois descriptors fictícios coexistem sem interferência', () => {
  const a = descriptorFicticio('ficticio_a');
  const b = descriptorFicticio('ficticio_b', { kind: 'video' });
  const registro = createWorkflowRegistry([a, b, minimaxH3T2V]);

  assert.equal(registro.size, 3);
  assert.deepEqual(registro.ids(), ['ficticio_a', 'ficticio_b', 'minimax_h3_t2v']);

  // Cada um mantém a própria identidade, nós e patch.
  assert.equal(registro.get('ficticio_a').kind, 'image');
  assert.equal(registro.get('ficticio_b').kind, 'video');
  assert.equal(registro.get('ficticio_a').patch({}, { x: 1 }).meta.id, 'ficticio_a');
  assert.equal(registro.get('ficticio_b').patch({}, { x: 1 }).meta.id, 'ficticio_b');
  assert.equal(registro.get('minimax_h3_t2v').nodeIds.prompt, '105:104');

  // O grafo do MiniMax não passa na validação do fictício, e vice-versa —
  // prova de que cada descriptor valida as próprias exigências.
  assert.throws(() => registro.get('ficticio_a').validate(template), WorkflowError);
  assert.throws(() => registro.get('minimax_h3_t2v').validate({ 1: { class_type: 'CLIPTextEncode' } }), WorkflowError);

  // E o registry da aplicação continua só com os workflows reais — os
  // fictícios acima vivem no registry local deste teste, não nele.
  assert.deepEqual(workflowRegistry.ids(), ['minimax_h3_t2v', 'ideogram4_t2i', 'stable_audio_sfx',
    'ace_step_15_music']);
});

test('id duplicado é erro de construção, não a última definição vencendo', () => {
  const a = descriptorFicticio('mesmo_id');
  const b = descriptorFicticio('mesmo_id', { label: 'Outro' });
  assert.throws(() => createWorkflowRegistry([a, b]), WorkflowError);
});

test('descriptor malformado falha ao ser definido', () => {
  const base = {
    id: 'ok_id',
    label: 'L',
    kind: 'image',
    file: 'a.json',
    nodeIds: {},
    nodeClasses: {},
    requiredModels: [],
    validate: () => true,
    patch: () => ({}),
  };

  assert.ok(defineWorkflow(base));
  assert.throws(() => defineWorkflow({ ...base, id: 'ID Com Espaço' }), WorkflowError);
  assert.throws(() => defineWorkflow({ ...base, id: '../escapa' }), WorkflowError);
  // `audio` virou kind VÁLIDO de workflow no PASSO 14-D1B — o Stable Audio
  // Open produz som pelo mesmo caminho de imagem e vídeo. O que continua
  // sendo recusado é uma palavra fora do vocabulário.
  assert.throws(() => defineWorkflow({ ...base, kind: 'texto' }), WorkflowError);
  assert.equal(defineWorkflow({ ...base, kind: 'audio' }).kind, 'audio');
  assert.throws(() => defineWorkflow({ ...base, validate: 'não é função' }), WorkflowError);
  assert.throws(() => defineWorkflow({ ...base, patch: null }), WorkflowError);
  assert.throws(() => defineWorkflow({ ...base, requiredModels: 'lista?' }), WorkflowError);
  assert.throws(() => defineWorkflow({ ...base, file: 42 }), WorkflowError);
});

// ── validação do MiniMax pela superfície nova ───────────────────────────────

test('o descriptor valida o workflow real em disco', () => {
  assert.equal(minimaxH3T2V.validate(template), true);
  assert.equal(template[NODE_IDS.prompt].class_type, 'MiniMaxH3ImageToVideo');
});

test('continua rejeitando nó ausente', () => {
  const semPrompt = structuredClone(template);
  delete semPrompt[NODE_IDS.prompt];

  assert.throws(() => minimaxH3T2V.validate(semPrompt), WorkflowError);
  try {
    minimaxH3T2V.validate(semPrompt);
  } catch (erro) {
    assert.ok(erro.detail.faltando.includes(NODE_IDS.prompt));
  }
});

test('continua rejeitando class_type divergente', () => {
  const classeErrada = structuredClone(template);
  classeErrada[NODE_IDS.seed].class_type = 'KSampler';

  assert.throws(() => minimaxH3T2V.validate(classeErrada), WorkflowError);
  try {
    minimaxH3T2V.validate(classeErrada);
  } catch (erro) {
    assert.equal(erro.detail.divergentes[0].nodeId, NODE_IDS.seed);
    assert.equal(erro.detail.divergentes[0].esperado, 'RandomNoise');
    assert.equal(erro.detail.divergentes[0].encontrado, 'KSampler');
  }
});

test('continua rejeitando arquivo de modelo trocado', () => {
  const modeloTrocado = structuredClone(template);
  const alvo = REQUIRED_MODEL_FILES[0];
  modeloTrocado[alvo.node].inputs[alvo.field] = 'outro_modelo.safetensors';

  assert.throws(() => minimaxH3T2V.validate(modeloTrocado), WorkflowError);
  try {
    minimaxH3T2V.validate(modeloTrocado);
  } catch (erro) {
    assert.equal(erro.detail.modelosDivergentes[0].esperado, alvo.file);
    assert.equal(erro.detail.modelosDivergentes[0].encontrado, 'outro_modelo.safetensors');
  }
});

test('continua rejeitando grafo que não é objeto de nós', () => {
  for (const ruim of [null, undefined, [], 'texto', 42]) {
    assert.throws(() => minimaxH3T2V.validate(ruim), WorkflowError);
  }
});

// ── patch ───────────────────────────────────────────────────────────────────

const PARAMS = {
  prompt: 'plano geral da estação ao amanhecer',
  seed: 12345,
  durationSeconds: 5.2,
  aspect: '16:9',
  quality: '480p',
  fps: 24,
  jobId: 'cinema_teste_registry',
};

test('o patch não muta o template nem o arquivo em disco', async () => {
  const antes = JSON.stringify(template);
  const { graph } = minimaxH3T2V.patch(template, PARAMS);

  assert.equal(JSON.stringify(template), antes, 'o template em memória mudou');
  assert.notEqual(graph, template, 'o patch precisa devolver uma cópia');
  assert.notEqual(graph[NODE_IDS.prompt], template[NODE_IDS.prompt], 'cópia rasa não basta');

  // E o arquivo continua igual ao que foi lido.
  const relido = await minimaxH3T2V.loadTemplate();
  assert.equal(JSON.stringify(relido), antes);
});

test('o patch pelo descriptor é equivalente ao da superfície antiga', () => {
  const pelaNova = minimaxH3T2V.patch(template, PARAMS);
  const pelaAntiga = patchPelaSuperficieAntiga(template, PARAMS);

  assert.deepEqual(pelaNova.graph, pelaAntiga.graph);
  assert.deepEqual(pelaNova.meta, pelaAntiga.meta);
});

test('o patch aplica todos os parâmetros no grafo', () => {
  const { graph, meta } = minimaxH3T2V.patch(template, PARAMS);

  assert.equal(graph[NODE_IDS.prompt].inputs.prompt, PARAMS.prompt);
  assert.equal(graph[NODE_IDS.seed].inputs.noise_seed, 12345);
  assert.equal(graph[NODE_IDS.duration].inputs.value, 5.2);
  assert.equal(graph[NODE_IDS.resolution].inputs.aspect_ratio, '16:9 (Widescreen)');
  assert.equal(graph[NODE_IDS.resolution].inputs.megapixels, 0.4);
  assert.equal(graph[NODE_IDS.createVideo].inputs.fps, 24);
  assert.equal(graph[NODE_IDS.save].inputs.filename_prefix, 'video/showrunner/cinema_teste_registry');

  assert.equal(meta.mode, 't2v');
  // 5,2 s × 24 fps = 125 quadros, elevados para a grade 17k+5 do modelo = 141.
  assert.equal(meta.frames, 141);
  assert.equal(meta.durationActual, 5.88);
  assert.equal(meta.seedLocked, true);
  assert.equal(meta.withinTrainedRange, true);
});

test('o patch com quadros continua produzindo i2v e flf', () => {
  const primeiro = { name: 'job_first.png', subfolder: 'showrunner', type: 'input' };
  const ultimo = { name: 'job_last.jpg', subfolder: 'showrunner', type: 'input' };

  const i2v = minimaxH3T2V.patch(template, { ...PARAMS, frames: { first: primeiro } });
  assert.equal(i2v.meta.mode, 'i2v');
  assert.equal(i2v.meta.frameFirst, 'showrunner/job_first.png');

  const flf = minimaxH3T2V.patch(template, { ...PARAMS, frames: { first: primeiro, last: ultimo } });
  assert.equal(flf.meta.mode, 'flf');
  assert.equal(flf.meta.frameLast, 'showrunner/job_last.jpg');

  // E o template segue intocado depois dos três modos.
  assert.equal(minimaxH3T2V.validate(template), true);
});

test('o patch continua recusando parâmetros inválidos', () => {
  assert.throws(() => minimaxH3T2V.patch(template, { ...PARAMS, prompt: '   ' }), WorkflowError);
  assert.throws(() => minimaxH3T2V.patch(template, { ...PARAMS, jobId: '../escapar' }), WorkflowError);
  assert.throws(() => minimaxH3T2V.patch(template, { ...PARAMS, durationSeconds: 0 }), WorkflowError);
  assert.throws(() => minimaxH3T2V.patch(template, { ...PARAMS, seed: -5 }), WorkflowError);
  assert.throws(() => minimaxH3T2V.patch(template, { ...PARAMS, aspect: '7:3' }), WorkflowError);
  assert.throws(() => minimaxH3T2V.patch(template, { ...PARAMS, quality: '8k' }), WorkflowError);
});

// ── caminhos ────────────────────────────────────────────────────────────────

test('o caller não escolhe caminho: o descriptor declara o arquivo', () => {
  // A superfície pública do registry só aceita id. Não existe getWorkflowByPath.
  const superficie = Object.keys({ getWorkflow, hasWorkflow, listWorkflows, createWorkflowRegistry });
  assert.ok(!superficie.some((n) => /path|caminho|file/i.test(n)));

  // E o descriptor deriva o caminho do próprio nome declarado.
  assert.equal(minimaxH3T2V.file, 'minimax_h3_t2v_api.json');
  assert.ok(minimaxH3T2V.resolvePath().endsWith('minimax_h3_t2v_api.json'));
});

test('nome de arquivo com travessia é recusado', () => {
  const maliciosos = [
    '../fora.json', '../../etc/passwd.json', '/etc/passwd', 'a/b.json', 'a\\b.json',
    'sem-extensao', 'x.json.exe', '.json', '', null, 42, 'a..b.json',
  ];
  for (const nome of maliciosos) {
    assert.throws(
      () => validateWorkflowFilename(nome),
      WorkflowPathError,
      `aceitou "${nome}"`,
    );
    assert.throws(() => resolveWorkflowPath(nome, RAIZ), WorkflowPathError, `resolveu "${nome}"`);
  }
});

test('a raiz é configurável e o caminho resolvido fica dentro dela', () => {
  const resolvido = resolveWorkflowPath('qualquer.json', RAIZ);

  assert.equal(resolvido, path.join(path.resolve(RAIZ), 'qualquer.json'));
  assert.ok(resolvido.startsWith(path.resolve(RAIZ)), 'escapou da raiz');

  // A contenção é conferida mesmo com o nome já validado — defesa em profundidade.
  assert.throws(() => assertInsideRoot(RAIZ, '/etc/passwd'), WorkflowPathError);
  assert.throws(() => assertInsideRoot(RAIZ, path.join(RAIZ, '..', 'vizinho.json')), WorkflowPathError);
  assert.throws(() => assertInsideRoot(RAIZ, RAIZ), WorkflowPathError, 'a própria raiz não é arquivo');
});

test('COMFY_WORKFLOWS_ROOT muda a raiz de verdade, num processo limpo', async () => {
  const raizAlternativa = path.join(RAIZ, 'outra-raiz');
  await writeFile(path.join(RAIZ, 'marcador.txt'), 'x');

  const script = `
    import { WORKFLOWS_ROOT, resolveWorkflowPath } from './lib/server/generation/workflows/paths.js';
    process.stdout.write(JSON.stringify({
      raiz: WORKFLOWS_ROOT,
      resolvido: resolveWorkflowPath('exemplo.json'),
    }));
  `;

  const saida = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, COMFY_WORKFLOWS_ROOT: raizAlternativa },
    cwd: process.cwd(),
    encoding: 'utf8',
  });

  const { raiz, resolvido } = JSON.parse(saida);
  assert.equal(raiz, raizAlternativa);
  assert.equal(resolvido, path.join(raizAlternativa, 'exemplo.json'));
});

test('sem configuração, a raiz padrão preserva o ambiente atual', () => {
  // O caminho que antes estava codificado em comfy/config.js continua sendo
  // alcançado — é o que mantém a instalação existente funcionando sem ajuste.
  assert.equal(
    path.join(WORKFLOWS_ROOT, minimaxH3T2V.file),
    minimaxH3T2V.resolvePath(WORKFLOWS_ROOT),
  );
});

// ══ REVISÃO DE PRE-COMMIT ═══════════════════════════════════════════════════

// ── 1. registry: o que pode entrar e o que sai ──────────────────────────────

test('objeto solto com id não entra no registry', () => {
  const impostores = [
    { id: 'falso' },
    { id: 'falso', validate: () => true },                 // sem patch
    { id: 'falso', patch: () => ({}) },                    // sem validate
    { ...descriptorFicticio('copia_rasa') },               // perdeu a marca ao ser espalhado
    null, undefined, 'minimax_h3_t2v', 42, [],
  ];
  for (const impostor of impostores) {
    assert.throws(
      () => createWorkflowRegistry([impostor]),
      WorkflowError,
      `aceitou impostor: ${JSON.stringify(impostor)}`,
    );
  }
  // O legítimo continua entrando.
  assert.equal(createWorkflowRegistry([descriptorFicticio('legitimo')]).size, 1);
});

test('listWorkflows não dá alcance ao descriptor por dentro da lista', () => {
  const modesOriginais = [...minimaxH3T2V.modes];

  const lista = listWorkflows();
  lista[0].id = 'sequestrado';
  lista[0].modes.push('INVASOR');
  lista.length = 0;

  // Nem o registry nem o descriptor sentiram nada.
  assert.deepEqual(listWorkflows().map((w) => w.id), ['minimax_h3_t2v', 'ideogram4_t2i', 'stable_audio_sfx',
    'ace_step_15_music']);
  assert.deepEqual([...minimaxH3T2V.modes], modesOriginais);

  // E cada chamada devolve objetos novos.
  assert.notEqual(listWorkflows()[0], listWorkflows()[0]);
  assert.notEqual(listWorkflows()[0].modes, listWorkflows()[0].modes);
});

// ── 5. imutabilidade das tabelas críticas ───────────────────────────────────

test('as tabelas que patch e validate consultam são profundamente imutáveis', () => {
  const alvos = {
    nodeIds: minimaxH3T2V.nodeIds,
    nodeClasses: minimaxH3T2V.nodeClasses,
    requiredModels: minimaxH3T2V.requiredModels,
    modes: minimaxH3T2V.modes,
  };

  for (const [nome, tabela] of Object.entries(alvos)) {
    assert.ok(Object.isFrozen(tabela), `${nome} não está congelada`);
  }
  // Os objetos DENTRO da lista de modelos também — freeze raso não bastaria.
  for (const modelo of minimaxH3T2V.requiredModels) {
    assert.ok(Object.isFrozen(modelo), `entrada de requiredModels mutável: ${modelo.role}`);
  }

  assert.throws(() => { minimaxH3T2V.nodeIds.prompt = 'HACK'; }, TypeError);
  assert.throws(() => { minimaxH3T2V.nodeClasses['92'] = 'Outro'; }, TypeError);
  assert.throws(() => { minimaxH3T2V.requiredModels.push({}); }, TypeError);
  assert.throws(() => { minimaxH3T2V.requiredModels[0].file = 'trocado.safetensors'; }, TypeError);

  // O que importa: depois das tentativas, o grafo produzido continua correto.
  assert.equal(NODE_IDS.prompt, '105:104');
  const { graph } = minimaxH3T2V.patch(template, PARAMS);
  assert.equal(graph['105:104'].inputs.prompt, PARAMS.prompt);
  assert.equal(minimaxH3T2V.validate(template), true);
});

test('as tabelas de conversão do MiniMax também são imutáveis', async () => {
  const mod = await import('../lib/server/generation/workflows/minimaxH3.js');
  for (const nome of ['ASPECT_TO_SELECTOR', 'QUALITY_TO_MEGAPIXELS', 'FRAME_GRID',
    'TRAINED_FRAME_RANGE', 'GENERATION_MODES', 'MODE_LABELS', 'FRAME_NODE_IDS']) {
    assert.ok(Object.isFrozen(mod[nome]), `${nome} não está congelada`);
  }
  assert.throws(() => { mod.ASPECT_TO_SELECTOR['16:9'] = 'errado'; }, TypeError);
  assert.equal(minimaxH3T2V.patch(template, PARAMS).graph['115'].inputs.aspect_ratio, '16:9 (Widescreen)');
});

// ── 2. travessia de caminho, caso a caso ────────────────────────────────────

test('travessia no filename do descriptor é recusada em todas as formas', () => {
  const travessias = [
    '../workflow.json',
    '../../foo.json',
    'subdir/../../foo.json',
    '/absolute/path.json',
    './local.json',
    'a/b/c.json',
    '..\\windows.json',
    'workflow.json/../../etc/passwd',
    '%2e%2e/foo.json',
    'foo.json\0.png',
  ];

  for (const nome of travessias) {
    assert.throws(() => validateWorkflowFilename(nome), WorkflowPathError, `nome aceito: "${nome}"`);
    assert.throws(() => resolveWorkflowPath(nome, RAIZ), WorkflowPathError, `path resolvido: "${nome}"`);
    // E um descriptor não consegue nascer com esse arquivo e depois resolvê-lo.
    assert.throws(
      () => descriptorFicticio('x', { file: nome }).resolvePath(RAIZ),
      WorkflowPathError,
      `descriptor resolveu: "${nome}"`,
    );
  }
});

test('nenhum caminho resolvido escapa da raiz', () => {
  for (const nome of ['ok.json', 'com-hifen.json', 'com_sublinhado.json', 'v2.api.json']) {
    const resolvido = resolveWorkflowPath(nome, RAIZ);
    assert.ok(resolvido.startsWith(`${path.resolve(RAIZ)}${path.sep}`), `escapou: ${nome}`);
    assert.equal(path.dirname(resolvido), path.resolve(RAIZ));
  }
});

// ── 3. precedência das variáveis de ambiente ────────────────────────────────
//
// A fronteira: variável de ambiente é configuração de OPERADOR e pode definir
// localização. Corpo de requisição e argumento de tool são input de
// USUÁRIO/AGENTE e nunca podem — só informam `workflowId`.

/** Resolve o caminho do MiniMax num processo limpo, com o ambiente dado. */
function resolveEmProcessoLimpo(env) {
  const script = `
    import { WORKFLOWS_ROOT, DEFAULT_WORKFLOWS_ROOT } from './lib/server/generation/workflows/paths.js';
    import { minimaxH3T2V } from './lib/server/generation/workflows/minimaxH3.js';
    process.stdout.write(JSON.stringify({
      raiz: WORKFLOWS_ROOT,
      padrao: DEFAULT_WORKFLOWS_ROOT,
      resolvido: minimaxH3T2V.resolvePath(),
    }));
  `;
  const limpo = { ...process.env };
  delete limpo.COMFY_WORKFLOWS_ROOT;
  delete limpo.COMFY_WORKFLOW;

  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...limpo, ...env },
    cwd: process.cwd(),
    encoding: 'utf8',
  }));
}

test('sem nenhuma variável, vale a raiz padrão embutida', () => {
  const r = resolveEmProcessoLimpo({});
  assert.equal(r.raiz, r.padrao);
  assert.equal(r.resolvido, path.join(r.padrao, 'minimax_h3_t2v_api.json'));
});

test('COMFY_WORKFLOWS_ROOT troca a raiz, mantendo o filename do descriptor', () => {
  const r = resolveEmProcessoLimpo({ COMFY_WORKFLOWS_ROOT: '/opt/wf' });
  assert.equal(r.raiz, '/opt/wf');
  assert.equal(r.resolvido, '/opt/wf/minimax_h3_t2v_api.json');
});

test('COMFY_WORKFLOW (legado) vence a raiz e pode apontar para fora dela', () => {
  const r = resolveEmProcessoLimpo({ COMFY_WORKFLOW: '/outro/lugar/legado.json' });
  assert.equal(r.resolvido, '/outro/lugar/legado.json');
  assert.notEqual(path.dirname(r.resolvido), r.raiz, 'o legado sai da raiz de propósito');
});

test('com as duas definidas, o legado tem precedência', () => {
  const r = resolveEmProcessoLimpo({
    COMFY_WORKFLOWS_ROOT: '/opt/wf',
    COMFY_WORKFLOW: '/legado/arquivo.json',
  });
  assert.equal(r.raiz, '/opt/wf', 'a raiz continua configurada…');
  assert.equal(r.resolvido, '/legado/arquivo.json', '…mas o legado vence para este descriptor');
});

test('só paths.js lê o ambiente para decidir localização', () => {
  // Um `grep` por leitura real de process.env — menção em comentário ou em
  // texto de erro não conta, e declarar o NOME da variável num descriptor
  // (legacyPathEnv) também não: quem lê continua sendo um módulo só.
  const leitores = execFileSync('grep', [
    '-rl', 'process\\.env', '--include=*.js', '--include=*.jsx',
    'lib/server/generation', 'app/api',
  ], { cwd: process.cwd(), encoding: 'utf8' }).trim().split('\n').filter(Boolean).sort();

  assert.deepEqual(leitores, ['lib/server/generation/workflows/paths.js'],
    `ambiente lido fora de paths.js: ${leitores.join(', ')}`);
});

test('nenhuma rota de API aceita caminho de workflow vindo da requisição', () => {
  // `grep` sai com código 1 quando não encontra nada — que é exatamente o
  // resultado esperado aqui.
  let achados = '';
  try {
    achados = execFileSync('grep', [
      '-rn', '-i', '-e', 'workflowPath', '-e', 'workflow_path',
      '--include=*.js', 'app/api',
    ], { cwd: process.cwd(), encoding: 'utf8' });
  } catch (erro) {
    assert.equal(erro.status, 1, `grep falhou: ${erro.stderr}`);
  }

  assert.equal(achados.trim(), '', `caminho de workflow trafegando pela API: ${achados}`);
});

test('o descriptor não carrega caminho pronto nem aceita arquivo absoluto', () => {
  const wf = getWorkflow('minimax_h3_t2v');
  assert.ok(!('path' in wf), 'o descriptor não deve carregar caminho pronto');
  assert.equal(typeof wf.resolvePath, 'function', 'o caminho é derivado a cada chamada');

  // Um descriptor não nasce com arquivo absoluto ou com travessia.
  assert.throws(() => descriptorFicticio('t', { file: '/abs.json' }).resolvePath(RAIZ), WorkflowPathError);
  assert.throws(() => descriptorFicticio('t', { file: '../fora.json' }).resolvePath(RAIZ), WorkflowPathError);
});
