// Project no servidor: criação, leitura, atualização e — o ponto central —
// que o id continua sendo o mesmo segmento seguro que vira diretório em
// runtime/projects/, sem um segundo sistema de identificadores.

import test from 'node:test';
import assert from 'node:assert/strict';
import { PathValidationError } from '../lib/server/comfy/storage.js';
import { DomainError, openDatabase } from '../lib/server/domain/db.js';
import {
  createProject, deleteProject, ensureProject, getProject, isValidProjectId,
  listProjects, updateProject,
} from '../lib/server/domain/projects.js';

const novoBanco = () => openDatabase(':memory:');

test('cria e recupera um projeto com a forma esperada', () => {
  const db = novoBanco();

  const criado = createProject({
    id: 'proj_demo_noir',
    name: 'Curta neo-noir "Sinal"',
    description: 'Curta de 3 minutos, estética neo-noir.',
    aspect: '21:9',
  }, db);

  assert.deepEqual(Object.keys(criado).sort(), [
    'aspect', 'createdAt', 'description', 'id', 'name', 'updatedAt',
  ]);
  assert.equal(criado.id, 'proj_demo_noir');
  assert.equal(criado.aspect, '21:9');
  assert.equal(typeof criado.createdAt, 'number');
  assert.equal(criado.createdAt, criado.updatedAt);

  assert.deepEqual(getProject('proj_demo_noir', db), criado);
  db.close();
});

test('sem id, gera um identificador próprio já no formato seguro', () => {
  const db = novoBanco();
  const criado = createProject({ name: 'Sem id informado' }, db);
  assert.match(criado.id, /^proj_[A-Za-z0-9_-]+$/);
  assert.ok(isValidProjectId(criado.id));
  db.close();
});

test('o projectId obedece à validação segura já existente', () => {
  const db = novoBanco();
  const maliciosos = [
    '..', '../', '../../etc', 'a/b', 'a\\b', '.', 'a.b', 'a b', '',
    '/etc/passwd', 'x'.repeat(65), 'proj\0nulo',
  ];
  for (const id of maliciosos) {
    assert.throws(
      () => createProject({ id, name: 'X' }, db),
      PathValidationError,
      `aceitou "${id}"`,
    );
  }
  assert.equal(listProjects(db).length, 0);
  db.close();
});

test('projeto sem nome é recusado', () => {
  const db = novoBanco();
  assert.throws(() => createProject({ id: 'p1', name: '' }, db), DomainError);
  assert.throws(() => createProject({ id: 'p1', name: '   ' }, db), DomainError);
  assert.throws(() => createProject({ id: 'p1' }, db), DomainError);
  db.close();
});

test('id repetido é recusado com mensagem de domínio', () => {
  const db = novoBanco();
  createProject({ id: 'p1', name: 'Primeiro' }, db);
  assert.throws(() => createProject({ id: 'p1', name: 'Segundo' }, db), DomainError);
  assert.equal(getProject('p1', db).name, 'Primeiro');
  db.close();
});

test('getProject devolve null — não lança — para id inválido ou ausente', () => {
  const db = novoBanco();
  assert.equal(getProject('../escapa', db), null);
  assert.equal(getProject('nao_existe', db), null);
  assert.equal(getProject(null, db), null);
  assert.equal(getProject(123, db), null);
  db.close();
});

test('atualizar altera os campos e avança updatedAt', async () => {
  const db = novoBanco();
  const criado = createProject({ id: 'p1', name: 'Antes', aspect: '16:9' }, db);

  await new Promise((r) => { setTimeout(r, 2); });
  const alterado = updateProject('p1', { name: 'Depois', aspect: '9:16' }, db);

  assert.equal(alterado.name, 'Depois');
  assert.equal(alterado.aspect, '9:16');
  assert.equal(alterado.description, criado.description);
  assert.equal(alterado.createdAt, criado.createdAt);
  assert.ok(alterado.updatedAt > criado.updatedAt);
  db.close();
});

test('atualizar recusa campo fora da lista editável', () => {
  const db = novoBanco();
  createProject({ id: 'p1', name: 'P' }, db);

  for (const patch of [{ id: 'outro' }, { createdAt: 0 }, { updatedAt: 0 }, { naoExiste: 1 }]) {
    assert.throws(() => updateProject('p1', patch, db), DomainError);
  }
  assert.equal(getProject('p1', db).id, 'p1');
  db.close();
});

test('atualizar projeto desconhecido é erro de domínio', () => {
  const db = novoBanco();
  assert.throws(() => updateProject('fantasma', { name: 'X' }, db), DomainError);
  db.close();
});

test('ensureProject cria uma vez e depois só encontra', () => {
  const db = novoBanco();

  const primeira = ensureProject('avulso', { name: 'avulso' }, db);
  assert.equal(primeira.criado, true);
  assert.equal(primeira.project.name, 'avulso');

  updateProject('avulso', { name: 'Renomeado pelo usuário' }, db);

  const segunda = ensureProject('avulso', { name: 'avulso' }, db);
  assert.equal(segunda.criado, false);
  // O que o usuário renomeou não pode ser sobrescrito por uma segunda passada.
  assert.equal(segunda.project.name, 'Renomeado pelo usuário');
  assert.equal(listProjects(db).length, 1);
  db.close();
});

test('listar traz os projetos, do mais recentemente alterado ao mais antigo', async () => {
  const db = novoBanco();
  createProject({ id: 'p1', name: 'Um' }, db);
  createProject({ id: 'p2', name: 'Dois' }, db);
  await new Promise((r) => { setTimeout(r, 2); });
  updateProject('p1', { name: 'Um alterado' }, db);

  assert.deepEqual(listProjects(db).map((p) => p.id), ['p1', 'p2']);
  db.close();
});

test('remover apaga o registro e devolve false na segunda vez', () => {
  const db = novoBanco();
  createProject({ id: 'p1', name: 'P' }, db);
  assert.equal(deleteProject('p1', db), true);
  assert.equal(getProject('p1', db), null);
  assert.equal(deleteProject('p1', db), false);
  db.close();
});

// ── superfície pública da camada ────────────────────────────────────────────

test('ensureProject NÃO é exposto pelo barril do domínio', async () => {
  const barril = await import('../lib/server/domain/index.js');
  const modulo = await import('../lib/server/domain/projects.js');

  // Continua existindo e funcionando para o backfill…
  assert.equal(typeof modulo.ensureProject, 'function');
  // …mas fora da superfície que o Agent Gateway vai importar, para que uma
  // tool og.* não materialize projetos como efeito colateral de resolver um id.
  assert.equal(barril.ensureProject, undefined);

  // A criação normal continua pública e continua exigindo intenção explícita.
  assert.equal(typeof barril.createProject, 'function');
});

test('nenhuma criação implícita de projeto na superfície pública', async () => {
  const barril = await import('../lib/server/domain/index.js');
  const criadores = Object.keys(barril).filter((n) => /^(ensure|getOrCreate|upsert)/.test(n));
  assert.deepEqual(criadores, [], `criação implícita exposta: ${criadores.join(', ')}`);
});

// ── registro explícito de um projeto que o usuário já tem ───────────────────

test('registerProject cria quando falta e devolve o existente quando há', async () => {
  const { registerProject } = await import('../lib/server/domain/projects.js');
  const db = openDatabase(':memory:');

  const primeira = registerProject({ id: 'proj_studio', name: 'Curta noir', aspect: '21:9' }, db);
  assert.equal(primeira.criado, true);
  assert.equal(primeira.project.name, 'Curta noir');
  assert.equal(primeira.project.aspect, '21:9');

  const segunda = registerProject({ id: 'proj_studio', name: 'Curta noir' }, db);
  assert.equal(segunda.criado, false);
  assert.equal(segunda.project.id, primeira.project.id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 1);
});

test('registerProject NÃO sobrescreve metadata de um projeto já cadastrado', async () => {
  const { registerProject } = await import('../lib/server/domain/projects.js');
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_studio', name: 'Nome de verdade', aspect: '16:9' }, db);

  const { criado, project } = registerProject(
    { id: 'proj_studio', name: 'Nome da tela', aspect: '9:16', description: 'outra' }, db,
  );

  assert.equal(criado, false);
  assert.equal(project.name, 'Nome de verdade');
  assert.equal(project.aspect, '16:9');
});

test('registerProject exige um DESCRITOR, não um id solto', async () => {
  // É esta exigência que impede a operação de virar porta de criação genérica:
  // quem chama precisa saber o que está registrando, e não só repetir um
  // identificador que recebeu de fora.
  const { registerProject } = await import('../lib/server/domain/projects.js');
  const db = openDatabase(':memory:');

  for (const ruim of [undefined, null, 'proj_x', 42, {}, { id: 'proj_x' },
    { id: 'proj_x', name: '   ' }, { name: 'Sem id' }]) {
    assert.throws(() => registerProject(ruim, db), DomainError,
      `${JSON.stringify(ruim)} deveria ser recusado`);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
});

test('registerProject valida o id como qualquer projeto', async () => {
  const { registerProject } = await import('../lib/server/domain/projects.js');
  const db = openDatabase(':memory:');
  for (const id of ['com barra/', 'com espaço', 'a'.repeat(80), 'com.ponto']) {
    assert.throws(() => registerProject({ id, name: 'X' }, db));
  }
});

test('registerProject é público; ensureProject continua fora do barril', async () => {
  const barril = await import('../lib/server/domain/index.js');
  const modulo = await import('../lib/server/domain/projects.js');

  assert.equal(typeof barril.registerProject, 'function',
    'o registro explícito deveria ser público');
  assert.equal(barril.ensureProject, undefined,
    'ensureProject voltou ao barril');
  assert.equal(typeof modulo.ensureProject, 'function');
});

test('ensureProject só é usado pelo backfill em código de produção', async () => {
  // Ele cria a partir de um id solto, e isso só faz sentido onde não existe
  // descritor a consultar: as pastas em runtime/projects/ precedem o banco.
  const { readdir, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const RAIZ = new URL('../lib/', import.meta.url).pathname;

  const varrer = async (dir) => {
    const saida = [];
    for (const entrada of await readdir(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) saida.push(...await varrer(completo));
      else if (entrada.name.endsWith('.js')) saida.push(completo);
    }
    return saida;
  };

  const permitidos = ['domain/projects.js', 'domain/backfill.js'];

  for (const arquivo of await varrer(RAIZ)) {
    const relativo = arquivo.slice(RAIZ.length);
    if (permitidos.some((p) => relativo.endsWith(p))) continue;

    const codigo = (await readFile(arquivo, 'utf8'))
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

    assert.equal(/\bensureProject\b/.test(codigo), false,
      `${relativo} alcança ensureProject`);
  }
});

test('as tools do modelo não conseguem materializar projeto', async () => {
  // A tool recebe um contexto com projectId já resolvido pelo servidor. Se ela
  // pudesse criar projetos, o modelo escolheria onde a geração acontece.
  const { readdir, readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const dir = new URL('../lib/server/agent/tools/', import.meta.url).pathname;

  const varrer = async (raiz) => {
    const saida = [];
    for (const entrada of await readdir(raiz, { withFileTypes: true })) {
      const completo = path.join(raiz, entrada.name);
      if (entrada.isDirectory()) saida.push(...await varrer(completo));
      else if (entrada.name.endsWith('.js')) saida.push(completo);
    }
    return saida;
  };

  const arquivos = await varrer(dir);
  assert.ok(arquivos.length > 0);

  for (const arquivo of arquivos) {
    const codigo = await readFile(arquivo, 'utf8');
    for (const proibido of ['ensureProject', 'registerProject', 'createProject']) {
      assert.equal(codigo.includes(proibido), false,
        `${path.basename(arquivo)} alcança ${proibido}`);
    }
  }
});
