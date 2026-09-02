// Esquema do domínio: migração idempotente, chaves estrangeiras ligadas e
// geração de identificadores segura como segmento de caminho.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DomainError, ESQUEMA_ATUAL, newId, openDatabase, schemaVersion,
} from '../lib/server/domain/db.js';

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-domain-db-'));
test.after(() => rm(RAIZ, { recursive: true, force: true }));

test('abrir um banco novo cria o esquema na versão corrente', () => {
  const db = openDatabase(path.join(RAIZ, 'novo.db'));
  assert.equal(schemaVersion(db), ESQUEMA_ATUAL);

  const tabelas = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((t) => t.name)
    .filter((n) => !n.startsWith('sqlite_'));

  assert.deepEqual(tabelas, ['assets', 'projects', 'scenes']);
  db.close();
});

test('reabrir o mesmo arquivo não reexecuta a migração', () => {
  const caminho = path.join(RAIZ, 'reabre.db');

  const primeira = openDatabase(caminho);
  primeira.prepare(`
    INSERT INTO projects (id, name, description, aspect, createdAt, updatedAt)
    VALUES (?, ?, '', '16:9', 1, 1)
  `).run('proj_persistente', 'Sobrevive');
  primeira.close();

  // Se a migração rodasse de novo, o CREATE TABLE falharia ou o dado sumiria.
  const segunda = openDatabase(caminho);
  assert.equal(schemaVersion(segunda), ESQUEMA_ATUAL);
  assert.equal(
    segunda.prepare('SELECT name FROM projects WHERE id = ?').get('proj_persistente').name,
    'Sobrevive',
  );
  segunda.close();
});

test('as chaves estrangeiras estão ligadas nesta conexão', () => {
  const db = openDatabase(':memory:');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);

  // Cena apontando para um projeto que não existe precisa ser recusada.
  assert.throws(() => db.prepare(`
    INSERT INTO scenes (id, projectId, number, title, description, duration,
                        modelId, status, revisionNote, image, videoId, createdAt, updatedAt)
    VALUES ('scene_x', 'proj_inexistente', 1, 'T', '', 6, NULL, 'rascunho', '', NULL, NULL, 1, 1)
  `).run());

  db.close();
});

test('o esquema recusa um tipo de asset fora do vocabulário', () => {
  const db = openDatabase(':memory:');
  db.prepare(`
    INSERT INTO projects (id, name, description, aspect, createdAt, updatedAt)
    VALUES ('p1', 'P', '', '16:9', 1, 1)
  `).run();

  assert.throws(() => db.prepare(`
    INSERT INTO assets (id, projectId, kind, status, createdAt)
    VALUES ('a1', 'p1', 'audio', 'pendente', 1)
  `).run(), /CHECK|constraint/i);

  db.close();
});

test('o esquema recusa um asset que deriva de si mesmo', () => {
  const db = openDatabase(':memory:');
  db.prepare(`
    INSERT INTO projects (id, name, description, aspect, createdAt, updatedAt)
    VALUES ('p1', 'P', '', '16:9', 1, 1)
  `).run();

  assert.throws(() => db.prepare(`
    INSERT INTO assets (id, projectId, kind, derivedFromAssetId, status, createdAt)
    VALUES ('a1', 'p1', 'video', 'a1', 'pendente', 1)
  `).run(), /CHECK|constraint/i);

  db.close();
});

test('newId produz um segmento seguro para caminho e URL', () => {
  for (const prefixo of ['scene', 'asset', 'proj']) {
    for (let i = 0; i < 50; i += 1) {
      const id = newId(prefixo);
      assert.match(id, /^[A-Za-z0-9_-]{1,64}$/, `id inseguro: ${id}`);
      assert.ok(id.startsWith(`${prefixo}_`));
    }
  }
});

test('newId não colide em geração apertada', () => {
  const ids = new Set(Array.from({ length: 5000 }, () => newId('asset')));
  assert.equal(ids.size, 5000);
});

test('newId recusa prefixo que quebraria a regex de segmento', () => {
  for (const ruim of ['', 'com espaco', '../x', 'a/b', '9comeca', null, 'x'.repeat(20)]) {
    assert.throws(() => newId(ruim), DomainError, `aceitou "${ruim}"`);
  }
});
