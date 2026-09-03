// A raiz da aplicação e o que é ancorado nela.
//
// `process.cwd()` não responde "onde a aplicação está": ele é a raiz do
// projeto quando o Next roda o servidor, mas é qualquer coisa quando um script
// ou um teste roda de outro diretório. Um `runtime/` resolvido a partir do cwd
// faria um script escrever num diretório paralelo — sem erro, sem aviso, e com
// os vídeos do usuário em outro lugar.
//
// Estes testes usam SUBPROCESSOS com cwd real diferente. Trocar `process.cwd`
// por um stub provaria menos: o que importa é o comportamento do processo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APP_ROOT, appPath, findAppRootFrom, isAppRoot } from '../lib/server/appRoot.js';

const RAIZ = APP_ROOT;

/** Lê os caminhos da aplicação num subprocesso com o cwd que se pedir. */
function caminhosComCwd(cwd, env = {}) {
  const script = `
    const raiz = ${JSON.stringify(RAIZ)};
    const { APP_ROOT } = await import(raiz + '/lib/server/appRoot.js');
    const { RUNTIME_ROOT } = await import(raiz + '/lib/server/comfy/config.js');
    const { LOGS_DIR } = await import(raiz + '/lib/server/logs/persist.js');
    const { DB_PATH } = await import(raiz + '/lib/server/domain/db.js');
    const { PROJECT_WORKFLOWS_ROOT, WORKFLOWS_ROOT } =
      await import(raiz + '/lib/server/generation/workflows/paths.js');

    process.stdout.write(JSON.stringify({
      cwd: process.cwd(),
      appRoot: APP_ROOT,
      runtimeRoot: RUNTIME_ROOT,
      logsDir: LOGS_DIR,
      dbPath: DB_PATH,
      workflowsProjeto: PROJECT_WORKFLOWS_ROOT,
      workflowsComfy: WORKFLOWS_ROOT,
    }));
  `;
  return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd, env: { ...process.env, ...env }, encoding: 'utf8',
  }));
}

test('RUNTIME_ROOT aponta para o runtime da raiz, venha o cwd de onde vier', async () => {
  const outro = await mkdtemp(path.join(tmpdir(), 'cwd-runtime-'));
  try {
    const daRaiz = caminhosComCwd(RAIZ);
    const deFora = caminhosComCwd(outro);
    const deBarra = caminhosComCwd('/');
    const deTmp = caminhosComCwd(tmpdir());

    // Os cwd são realmente diferentes entre si.
    const cwds = new Set([daRaiz.cwd, deFora.cwd, deBarra.cwd, deTmp.cwd]);
    assert.equal(cwds.size, 4, `os cwd precisam diferir: ${[...cwds].join(', ')}`);

    const esperado = path.join(RAIZ, 'runtime', 'projects');
    for (const r of [daRaiz, deFora, deBarra, deTmp]) {
      assert.equal(r.appRoot, RAIZ, `APP_ROOT errado com cwd=${r.cwd}`);
      assert.equal(r.runtimeRoot, esperado, `RUNTIME_ROOT errado com cwd=${r.cwd}`);
    }

    // O que a correção desfez: com a resolução antiga, cada cwd produziria um
    // runtime diferente. Aqui os quatro precisam ser o mesmo caminho.
    const runtimes = new Set([daRaiz, deFora, deBarra, deTmp].map((r) => r.runtimeRoot));
    assert.equal(runtimes.size, 1, `o runtime variou com o cwd: ${[...runtimes].join(', ')}`);
  } finally {
    await rm(outro, { recursive: true, force: true });
  }
});

test('logs e banco de domínio acompanham a mesma raiz', async () => {
  const outro = await mkdtemp(path.join(tmpdir(), 'cwd-derivados-'));
  try {
    const deFora = caminhosComCwd(outro);

    // Os dois derivam de dirname(RUNTIME_ROOT) e não podiam ficar para trás.
    assert.equal(deFora.logsDir, path.join(RAIZ, 'runtime', 'logs'));
    assert.equal(deFora.dbPath, path.join(RAIZ, 'runtime', 'showrunner.db'));
    assert.equal(path.dirname(deFora.runtimeRoot), path.join(RAIZ, 'runtime'));
  } finally {
    await rm(outro, { recursive: true, force: true });
  }
});

test('a correção do runtime não mexeu nas raízes de workflow', () => {
  const deBarra = caminhosComCwd('/');
  assert.equal(deBarra.workflowsProjeto, path.join(RAIZ, 'workflows'));

  // A raiz do ComfyUI continua sendo a do ambiente, independente da aplicação.
  const comOverride = caminhosComCwd('/', { COMFY_WORKFLOWS_ROOT: '/opt/comfy-wf' });
  assert.equal(comOverride.workflowsComfy, '/opt/comfy-wf');
  assert.equal(comOverride.runtimeRoot, path.join(RAIZ, 'runtime', 'projects'),
    'a variável dos workflows não pode mover o runtime');
  assert.equal(comOverride.workflowsProjeto, path.join(RAIZ, 'workflows'));

  // E a raiz do projeto, quando movida, também não move o runtime.
  const comProjeto = caminhosComCwd('/', { SHOWRUNNER_WORKFLOWS_ROOT: '/opt/wf-projeto' });
  assert.equal(comProjeto.workflowsProjeto, '/opt/wf-projeto');
  assert.equal(comProjeto.runtimeRoot, path.join(RAIZ, 'runtime', 'projects'));
});

test('a descoberta existe uma vez só, e os dois consumidores usam a mesma', async () => {
  const { readFile } = await import('node:fs/promises');

  const config = await readFile(new URL('../lib/server/comfy/config.js', import.meta.url), 'utf8');
  const paths = await readFile(
    new URL('../lib/server/generation/workflows/paths.js', import.meta.url), 'utf8',
  );

  for (const [nome, fonte] of [['config.js', config], ['paths.js', paths]]) {
    assert.match(fonte, /from '\.\.?\/(\.\.\/)*appRoot\.js'/, `${nome} não consome appRoot.js`);
    assert.ok(!/readFileSync/.test(fonte), `${nome} duplicou a descoberta`);
  }
  // Só o código conta: o comentário de config.js cita `process.cwd()` para
  // explicar justamente por que a raiz deixou de vir de lá.
  const codigo = config
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  assert.ok(!/process\.cwd\(\)/.test(codigo), 'config.js ainda deriva algo do cwd');
});

// ── a descoberta em si ──────────────────────────────────────────────────────

test('a raiz é reconhecida pelo package.json com nome', async () => {
  assert.equal(isAppRoot(RAIZ), true);
  assert.equal(findAppRootFrom(path.join(RAIZ, 'lib', 'server', 'comfy')), RAIZ);
  assert.equal(findAppRootFrom(RAIZ), RAIZ);

  // Um diretório sem package.json não é raiz, e subir dele não inventa uma.
  const vazio = await mkdtemp(path.join(tmpdir(), 'sem-pkg-'));
  try {
    assert.equal(isAppRoot(vazio), false);
  } finally {
    await rm(vazio, { recursive: true, force: true });
  }
});

test('um package.json sem nome não é raiz — é o caso do .next/', async () => {
  const { mkdir, writeFile } = await import('node:fs/promises');
  const base = await mkdtemp(path.join(tmpdir(), 'falsa-raiz-'));
  try {
    // Réplica do que a build do Next gera.
    const comoNext = path.join(base, '.next');
    await mkdir(path.join(comoNext, 'server'), { recursive: true });
    await writeFile(path.join(comoNext, 'package.json'), '{"type": "commonjs"}');
    assert.equal(isAppRoot(comoNext), false, 'a busca pararia dentro da build');

    // Com um package.json nomeado acima, a busca chega na raiz de verdade.
    await writeFile(path.join(base, 'package.json'), '{"name":"qualquer-app"}');
    assert.equal(findAppRootFrom(path.join(comoNext, 'server')), path.resolve(base));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('appPath ancora qualquer diretório na raiz', () => {
  assert.equal(appPath('runtime', 'projects'), path.join(RAIZ, 'runtime', 'projects'));
  assert.equal(appPath('workflows'), path.join(RAIZ, 'workflows'));
  assert.equal(appPath(), RAIZ);
});

test('nenhum caminho de máquina foi codificado', async () => {
  const { readFile } = await import('node:fs/promises');
  const fonte = await readFile(new URL('../lib/server/appRoot.js', import.meta.url), 'utf8');
  assert.ok(!/\/media\/|\/home\/|showrunner-studio/.test(fonte));
  // E o módulo é neutro: só primitivas do Node.
  const imports = [...fonte.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports.sort(), ['node:fs', 'node:path', 'node:url']);
});
