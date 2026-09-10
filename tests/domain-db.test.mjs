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

  assert.deepEqual(tabelas, [
    'agent_message_assets',
    // PASSO 11: o documento anexado a um turno.
    'agent_message_documents',
    'agent_messages', 'agent_threads', 'assets',
    // PASSO 11: as unidades de leitura de um documento.
    'document_chunks',
    // PASSO 10.2: o livro-razão das gerações.
    'generation_jobs',
    // PASSO 12: o planejamento da produção — plano, roteiro e cenas.
    // PASSO 14-D2A: a trilha da produção. Pende do PROJETO, e não da cena —
    // uma música atravessa cenas, e substituir o roteiro não a apaga.
    'production_music_cues', 'production_music_selections',
    'production_music_takes',
    'production_plan_sources', 'production_plans',
    // PASSO 14-B: os takes de VOZ de uma cena e a escolha ativa. Tabelas
    // próprias, e não uma extensão das de baixo: de uma imagem se pergunta
    // "qual delas eu escolhi?", e de uma narração se pergunta também "ela ainda
    // é do texto que está na cena?".
    'production_scene_audio_selections', 'production_scene_audio_takes',
    // PASSO 13-A: os takes de uma cena e a escolha ativa. A mídia é uma LINHA
    // por tentativa, e não uma coluna na cena, para que regenerar acrescente em
    // vez de sobrescrever.
    'production_scene_media', 'production_scene_media_selections',
    // PASSO 14-D1A: o desenho de som. Uma cena tem N CUES, cada uma com os seus
    // takes e a sua escolha — cardinalidade que a tabela da voz não comporta.
    'production_scene_sfx_cues', 'production_scene_sfx_selections',
    'production_scene_sfx_takes',
    'production_scenes',
    'production_scripts',
    // PASSO 11: o material de referência do projeto.
    'project_documents',
    // `scenes` é a tabela da migração 1, do storyboard da tela. O PASSO 12 NÃO
    // a evoluiu: a cena de um plano de produção responde a outra pergunta, e
    // mudar o significado de uma tabela publicada custaria mais do que ter as
    // duas com nomes que dizem a que vieram.
    'projects', 'runtime_sessions', 'scenes',
  ]);
  db.close();
});

test('um banco na versão 1 ganha as tabelas da versão 2 sem perder dado', () => {
  const caminho = path.join(RAIZ, 'migra.db');

  // Um arquivo com a forma da versão 1: as tabelas da migração 2 não existem
  // e o user_version diz 1. É o estado de qualquer banco criado antes dela.
  const antigo = openDatabase(caminho);
  // As tabelas das migrações seguintes também precisam sair: o arquivo nasceu
  // na versão corrente, e deixá-las para trás faria a reexecução esbarrar numa
  // tabela já existente — um artefato do teste, não do esquema.
  //
  // A ordem importa: `generation_jobs` referencia conversa, mensagem e Asset,
  // e sai primeiro. Com a chave estrangeira ligada, apagar o referenciado antes
  // do referenciador deixa o esquema num estado que a migração seguinte não
  // consegue reconstruir.
  antigo.exec(
    // PASSO 12: o planejamento sai primeiro de todos — as cenas dependem do
    // roteiro, o roteiro do projeto, e as fontes do plano E do documento.
    // PASSO 14-D2A: a trilha pende do PROJETO e sai antes dele.
    'DROP TABLE production_music_selections; '
    + 'DROP TABLE production_music_takes; '
    + 'DROP TABLE production_music_cues; '
    // PASSO 14-D1A: o desenho de som sai primeiro — cues, takes e escolhas.
    + 'DROP TABLE production_scene_sfx_selections; '
    + 'DROP TABLE production_scene_sfx_takes; '
    + 'DROP TABLE production_scene_sfx_cues; '
    // PASSO 14-B: a voz da cena sai antes da cena, do Asset e do livro-razão —
    // ela referencia os três.
    + 'DROP TABLE production_scene_audio_selections; '
    + 'DROP TABLE production_scene_audio_takes; '
    + 'DROP TABLE production_scene_media_selections; '
    + 'DROP TABLE production_scene_media; '
    + 'DROP TABLE production_scenes; DROP TABLE production_scripts; '
    + 'DROP TABLE production_plan_sources; DROP TABLE production_plans; '
    // PASSO 11: os documentos referenciam projeto e mensagem, então saem antes
    // dos dois — a mesma regra de ordem que já valia para o livro-razão.
    + 'DROP TABLE agent_message_documents; DROP TABLE document_chunks; '
    + 'DROP TABLE project_documents; '
    + 'DROP TABLE generation_jobs; '
    + 'DROP TABLE agent_message_assets; DROP TABLE runtime_sessions; '
    + 'DROP TABLE agent_messages; DROP TABLE agent_threads; '
    + 'PRAGMA user_version = 1',
  );
  antigo.prepare(`
    INSERT INTO projects (id, name, description, aspect, createdAt, updatedAt)
    VALUES ('proj_anterior', 'Existia antes da conversa', '', '16:9', 1, 1)
  `).run();
  antigo.close();

  const migrado = openDatabase(caminho);
  assert.equal(schemaVersion(migrado), ESQUEMA_ATUAL);
  assert.equal(
    migrado.prepare('SELECT name FROM projects WHERE id = ?').get('proj_anterior').name,
    'Existia antes da conversa',
    'a migração apagou dado que já existia',
  );

  // E as tabelas novas estão utilizáveis, com a chave estrangeira valendo.
  migrado.prepare(`
    INSERT INTO agent_threads (id, projectId, title, status, createdAt, updatedAt)
    VALUES ('thread_migrado', 'proj_anterior', 'Conversa', 'active', 2, 2)
  `).run();
  assert.throws(() => migrado.prepare(`
    INSERT INTO agent_threads (id, projectId, title, status, createdAt, updatedAt)
    VALUES ('thread_orfao', 'proj_inexistente', 'Órfã', 'active', 2, 2)
  `).run());

  migrado.close();
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

  // `audio` passou a ser aceito no esquema 12 — ver a migração 12 e
  // `tests/domain-audio-infrastructure.test.mjs`. O CHECK continua fechado para
  // qualquer palavra fora do vocabulário.
  assert.throws(() => db.prepare(`
    INSERT INTO assets (id, projectId, kind, status, createdAt)
    VALUES ('a1', 'p1', 'texto', 'pendente', 1)
  `).run(), /CHECK|constraint/i);

  // E o que o esquema 12 acrescentou, ele aceita de verdade.
  db.prepare(`
    INSERT INTO assets (id, projectId, kind, status, createdAt)
    VALUES ('a_audio', 'p1', 'audio', 'pendente', 1)
  `).run();
  assert.equal(db.prepare('SELECT kind FROM assets WHERE id = ?').get('a_audio').kind, 'audio');

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
