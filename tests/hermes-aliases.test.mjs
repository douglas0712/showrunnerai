// Tradução de nomes entre Showrunner e o runtime externo.
//
// A tabela de aliases é uma das quatro barreiras da defesa em profundidade, e é
// a única que roda inteiramente do nosso lado do processo. Estes testes existem
// para que ela continue FECHADA: um tradutor que aceita o desconhecido não é
// uma barreira, é um encaminhador.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  canonicalForDisplay, canonicalToolNames, hermesAliases, isKnownAlias,
  toCanonicalToolName, toHermesAlias, UnknownToolAliasError,
} from '../lib/server/agent/hermes/aliases.js';

test('os aliases existem e mapeiam para os nomes canônicos', () => {
  assert.deepEqual(hermesAliases().sort(), [
    'og_generate_image', 'og_generate_video', 'og_get_job',
    // PASSO 13-B: a imagem de uma cena da produção.
    'project_generate_scene_image',
    // PASSO 11: o material de referência do projeto.
    'project_get_production_plan',
    'project_get_scene',
    'project_get_script',
    'project_list_documents',
    'project_list_scenes',
    'project_read_document',
    // PASSO 12: o planejamento da produção.
    'project_replace_scenes',
    'project_save_production_plan',
    'project_save_script',
    'project_update_scene',
  ]);
  assert.equal(toCanonicalToolName('og_generate_image'), 'og.generate_image');
  assert.equal(toCanonicalToolName('og_generate_video'), 'og.generate_video');
  assert.equal(toCanonicalToolName('og_get_job'), 'og.get_job');
  assert.equal(toCanonicalToolName('project_list_documents'), 'project.list_documents');
  assert.equal(toCanonicalToolName('project_read_document'), 'project.read_document');
});

test('a volta é consistente com a ida', () => {
  for (const alias of hermesAliases()) {
    assert.equal(toHermesAlias(toCanonicalToolName(alias)), alias);
  }
  for (const canonico of canonicalToolNames()) {
    assert.equal(toCanonicalToolName(toHermesAlias(canonico)), canonico);
  }
});

test('nenhum nome canônico contém underscore no lugar do ponto', () => {
  // Se um dia alguém "simplificar" renomeando as tools internas, este teste cai
  // — que é o objetivo. O nome canônico é contrato do Showrunner.
  // O separador é o PONTO, e o prefixo diz de quem é a ferramenta: `og.` é a
  // produção, `project.` é o que o projeto tem. O que este teste tranca é o
  // separador — se um dia alguém "simplificar" renomeando `og.get_job` para
  // `og_get_job`, o nome canônico e o alias viram a mesma string, e a fronteira
  // que a tabela existe para desenhar deixa de existir.
  for (const canonico of canonicalToolNames()) {
    assert.match(canonico, /^(og|project)\.[a-z_]+$/);
    assert.equal(canonico.split('.').length, 2);
  }
});

test('todo alias é aceito pelo padrão que o provider exige', () => {
  // A razão de os aliases existirem: `^[a-zA-Z0-9_-]+$`, observado no
  // PASSO 7A.3 recusando `showrunner.test_echo`.
  for (const alias of hermesAliases()) {
    assert.match(alias, /^[a-zA-Z0-9_-]+$/);
  }
});

test('ferramentas nativas do runtime são recusadas', () => {
  for (const proibido of ['terminal', 'read_file', 'write_file', 'execute_code',
    'shell', 'browser_navigate', 'tool_call', 'tool_search']) {
    assert.throws(() => toCanonicalToolName(proibido), UnknownToolAliasError,
      `"${proibido}" deveria ser recusado`);
    assert.equal(isKnownAlias(proibido), false);
  }
});

test('curingas são recusados', () => {
  for (const curinga of ['all', '*', '', null, undefined, 'og_*']) {
    assert.throws(() => toCanonicalToolName(curinga), UnknownToolAliasError);
  }
});

test('alias inventado com prefixo certo é recusado', () => {
  // O prefixo `og_` não é senha: a tabela é fechada, não um padrão.
  assert.throws(() => toCanonicalToolName('og_fake'), UnknownToolAliasError);
  assert.throws(() => toCanonicalToolName('og_delete_project'), UnknownToolAliasError);
});

test('o nome canônico NÃO vale como alias', () => {
  // Duas grafias para a mesma coisa na fronteira é uma grafia a mais para
  // testar — e a menos testada é por onde passa o problema.
  for (const canonico of canonicalToolNames()) {
    assert.throws(() => toCanonicalToolName(canonico), UnknownToolAliasError);
  }
});

test('não há transformação genérica de underscore para ponto', () => {
  // `terminal_x` viraria `terminal.x` numa transformação por regra.
  assert.throws(() => toCanonicalToolName('terminal_exec'), UnknownToolAliasError);
  assert.throws(() => toCanonicalToolName('a_b'), UnknownToolAliasError);
});

test('canonicalForDisplay devolve null em vez de lançar', () => {
  // O fluxo de eventos não pode derrubar um turno por um nome estranho — mas
  // também não pode mostrar esse nome.
  assert.equal(canonicalForDisplay('og_get_job'), 'og.get_job');
  assert.equal(canonicalForDisplay('terminal'), null);
  assert.equal(canonicalForDisplay(undefined), null);
});
