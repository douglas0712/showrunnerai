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
