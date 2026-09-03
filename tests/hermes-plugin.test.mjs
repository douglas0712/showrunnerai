// O plugin que roda dentro do runtime.
//
// Ele é código Python, mora no repositório do Showrunner e é a segunda das
// quatro barreiras. Não dá para exercitá-lo aqui como se exercita um módulo JS,
// mas dá para provar as propriedades que importam — e todas são estruturais,
// legíveis do próprio arquivo.
//
// O que estes testes protegem, na prática: alguém "melhorando" o plugin e
// dando a ele acesso a disco, banco ou shell. O plugin roda dentro do processo
// do runtime; qualquer capacidade que ele ganhe é capacidade que o modelo
// passa a ter a um passo de distância.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { hermesAliases } from '../lib/server/agent/hermes/aliases.js';

const RAIZ = path.join(process.cwd(), 'integrations', 'hermes', 'showrunner-plugin');
const fonte = readFileSync(path.join(RAIZ, '__init__.py'), 'utf8');
const manifesto = readFileSync(path.join(RAIZ, 'plugin.yaml'), 'utf8');

test('o plugin declara exatamente as três tools, e nenhuma outra', () => {
  const declaradas = [...manifesto.matchAll(/^\s*-\s*(og_\w+)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(declaradas.sort(), [...hermesAliases()].sort());
});

test('o manifesto e o código concordam sobre os nomes', () => {
  for (const alias of hermesAliases()) {
    assert.ok(manifesto.includes(alias), `${alias} falta no plugin.yaml`);
    assert.ok(fonte.includes(`"${alias}"`), `${alias} falta no __init__.py`);
  }
});

test('o toolset registrado é "showrunner"', () => {
  // É o nome que o adapter envia em enabled_toolsets. Se divergirem, a sessão
  // fica sem ferramenta nenhuma — falha fechada, mas silenciosa.
  assert.match(fonte, /toolset\s*=\s*"showrunner"/);
});

test('nenhum schema expõe estado do Showrunner ao modelo', () => {
  // O bloco de schemas vai do primeiro até o fim das definições.
  const schemas = fonte.slice(fonte.indexOf('IMAGE_SCHEMA'), fonte.indexOf('_TOOLS = ('));
  for (const proibido of ['projectId', 'threadId', 'sessionId', 'session_id',
    'workflowId', 'nodeId', 'filename', 'path']) {
    assert.equal(schemas.includes(proibido), false,
      `"${proibido}" não pode aparecer num schema visível ao modelo`);
  }
});

test('os campos de negócio continuam nos schemas', () => {
  for (const campo of ['prompt', 'aspect', 'seed', 'duration', 'sourceAssetId', 'jobId']) {
    assert.ok(fonte.includes(`"${campo}"`), `o campo "${campo}" sumiu do schema`);
  }
});

test('o session_id vem de kwargs, nunca dos argumentos do modelo', () => {
  assert.match(fonte, /kwargs\.get\("session_id"\)/);
  // Ler session_id de `args` seria ler algo que o modelo escreveu.
  // (?<!kw) porque "kwargs.get" contém "args.get" — sem isso o teste acusa a
  // própria linha correta logo acima.
  assert.equal(/(?<!kw)args\.get\(\s*["']session_id["']/.test(fonte), false);
  assert.equal(/(?<!kw)args\[\s*["']session_id["']/.test(fonte), false);
});

test('sem session_id, o plugin recusa em vez de adivinhar', () => {
  assert.match(fonte, /if not session_id:/);
});

test('o plugin não tem acesso a disco, banco, shell ou rede aberta', () => {
  // A lista de imports é curta de propósito; qualquer adição aqui é uma
  // capacidade nova dentro do processo do runtime.
  const imports = [...fonte.matchAll(/^\s*(?:import|from)\s+([\w.]+)/gm)].map((m) => m[1]);
  const permitidos = new Set(['__future__', 'json', 'os', 'socket']);
  for (const modulo of imports) {
    assert.ok(permitidos.has(modulo), `import inesperado no plugin: "${modulo}"`);
  }

  for (const proibido of ['subprocess', 'sqlite3', 'shutil', 'requests', 'urllib',
    'httpx', 'pathlib', 'open(', 'eval(', 'exec(', '__import__']) {
    assert.equal(fonte.includes(proibido), false,
      `o plugin não pode usar "${proibido}"`);
  }
});

test('o plugin fala só pelo socket, e o caminho vem do ambiente', () => {
  assert.match(fonte, /socket\.AF_UNIX/);
  assert.match(fonte, /SHOWRUNNER_BRIDGE_SOCKET/);
  // Nada de TCP: uma porta aceitaria qualquer processo da máquina.
  assert.equal(fonte.includes('AF_INET'), false);
});

test('o plugin tem allowlist própria', () => {
  assert.match(fonte, /_ALLOWLIST\s*=\s*frozenset/);
  assert.match(fonte, /if tool_name not in _ALLOWLIST/);
});

test('erros do sistema não chegam ao modelo', () => {
  // Um errno ou o caminho do socket contam sobre a instalação.
  assert.match(fonte, /except OSError:/);
  const trecho = fonte.slice(fonte.indexOf('except OSError:'), fonte.indexOf('except OSError:') + 400);
  assert.equal(/str\(\s*(?:e|exc|erro)\s*\)/.test(trecho), false);
});
