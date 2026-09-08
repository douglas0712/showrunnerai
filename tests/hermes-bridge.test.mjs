// O bridge — onde a chamada do runtime volta a ser nossa.
//
// É a peça de segurança do PASSO 7B. Tudo o que entra aqui foi escolhido, em
// parte, por um modelo de linguagem: o nome da ferramenta e os argumentos. O
// que NÃO entra é a identidade — e estes testes existem sobretudo para provar
// que ela continua não entrando, mesmo quando o chamador tenta fornecê-la.

import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createActiveTurnRegistry, handleBridgeInvocation, startBridgeServer,
} from '../lib/server/agent/hermes/bridge.js';
import { bindRuntimeSession, normalizeSessionId } from '../lib/server/agent/hermes/sessionBinding.js';
import { openDatabase, DomainError } from '../lib/server/domain/db.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import { ensureProject } from '../lib/server/domain/projects.js';

/** Registry de mentira: anota o que foi pedido, devolve o que mandarem. */
function registryEspiao({ resultado = { ok: true }, erro = null } = {}) {
  const chamadas = [];
  return {
    chamadas,
    invoke: async (name, context, args) => {
      chamadas.push({ name, context, args });
      if (erro) throw erro;
      return resultado;
    },
  };
}

/** Banco com projeto, thread e sessão já vinculada. */
function cenario({ comProjeto = true } = {}) {
  const db = openDatabase(':memory:');
  let projectId = null;
  if (comProjeto) {
    projectId = ensureProject('proj_bridge', { name: 'Bridge' }, db).project.id;
  }
  const thread = createThreadRecord({ projectId }, db);
  bindRuntimeSession({
    sessionId: 'sess_valida', threadId: thread.id, runtimeId: 'hermes', now: 1000,
  }, db);
  return { db, thread, projectId };
}

// ── o caminho feliz ─────────────────────────────────────────────────────────

test('uma chamada válida vira invocação com contexto do servidor', async () => {
  const { db, thread, projectId } = cenario();
  const registry = registryEspiao({ resultado: { jobId: 'job_1', status: 'enviado' } });

  const resposta = await handleBridgeInvocation({
    sessionId: 'sess_valida', toolName: 'og_generate_image', arguments: { prompt: 'um dragão' },
  }, { db, registry });

  assert.equal(resposta.ok, true);
  assert.deepEqual(resposta.result, { jobId: 'job_1', status: 'enviado' });

  assert.equal(registry.chamadas.length, 1);
  const chamada = registry.chamadas[0];
  // O nome chega CANÔNICO ao registry, nunca o alias.
  assert.equal(chamada.name, 'og.generate_image');
  // O contexto foi construído aqui, não recebido.
  assert.equal(chamada.context.threadId, thread.id);
  assert.equal(chamada.context.projectId, projectId);
  // Os argumentos do modelo passam intactos — validá-los é da tool.
  assert.deepEqual(chamada.args, { prompt: 'um dragão' });
});

// ── a identidade não entra ──────────────────────────────────────────────────

test('projectId e threadId enviados pelo chamador são IGNORADOS', async () => {
  const { db, thread, projectId } = cenario();
  const registry = registryEspiao();

  await handleBridgeInvocation({
    sessionId: 'sess_valida',
    toolName: 'og_get_job',
    arguments: { jobId: 'j1' },
    // Um chamador malicioso — ou um modelo criativo — tentando escolher o alvo.
    projectId: 'proj_de_outra_pessoa',
    threadId: 'thread_falsa',
  }, { db, registry });

  const { context } = registry.chamadas[0];
  assert.equal(context.projectId, projectId);
  assert.equal(context.threadId, thread.id);
  assert.notEqual(context.projectId, 'proj_de_outra_pessoa');
  assert.notEqual(context.threadId, 'thread_falsa');
});

test('projectId e threadId DENTRO dos argumentos não mudam o contexto', async () => {
  const { db, thread, projectId } = cenario();
  const registry = registryEspiao();

  await handleBridgeInvocation({
    sessionId: 'sess_valida',
    toolName: 'og_generate_image',
    arguments: { prompt: 'x', projectId: 'proj_invasor', threadId: 'thread_invasora' },
  }, { db, registry });

  const { context } = registry.chamadas[0];
  assert.equal(context.projectId, projectId);
  assert.equal(context.threadId, thread.id);
});

// ── allowlist ───────────────────────────────────────────────────────────────

test('ferramentas nativas do runtime são recusadas', async () => {
  const { db } = cenario();
  const registry = registryEspiao();

  for (const proibida of ['terminal', 'shell', 'read_file', 'write_file',
    'execute_code', 'browser_navigate', 'tool_call', 'all', '*']) {
    const resposta = await handleBridgeInvocation({
      sessionId: 'sess_valida', toolName: proibida, arguments: {},
    }, { db, registry });

    assert.equal(resposta.ok, false, `"${proibida}" deveria ser recusada`);
    assert.equal(resposta.error.code, 'unknown_tool');
  }
  assert.equal(registry.chamadas.length, 0, 'nenhuma deveria ter chegado ao registry');
});

test('alias inventado é recusado', async () => {
  const { db } = cenario();
  const registry = registryEspiao();
  for (const inventada of ['og_fake', 'og_delete_all', 'og_generate', '']) {
    const resposta = await handleBridgeInvocation({
      sessionId: 'sess_valida', toolName: inventada, arguments: {},
    }, { db, registry });
    assert.equal(resposta.ok, false);
  }
  assert.equal(registry.chamadas.length, 0);
});

test('o nome canônico NÃO é aceito como alias vindo do runtime', async () => {
  // O runtime só conhece aliases. Receber o nome canônico significa que algo
  // fora do desenho está chamando — e isso não deve funcionar.
  const { db } = cenario();
  const registry = registryEspiao();
  const resposta = await handleBridgeInvocation({
    sessionId: 'sess_valida', toolName: 'og.generate_image', arguments: { prompt: 'x' },
  }, { db, registry });

  assert.equal(resposta.ok, false);
  assert.equal(resposta.error.code, 'unknown_tool');
  assert.equal(registry.chamadas.length, 0);
});

// ── sessão ──────────────────────────────────────────────────────────────────

test('sessão desconhecida é recusada sem tocar no registry', async () => {
  const { db } = cenario();
  const registry = registryEspiao();
  for (const sessao of ['sess_que_nao_existe', '', null, undefined, '../../etc/passwd', 'a'.repeat(500)]) {
    const resposta = await handleBridgeInvocation({
      sessionId: sessao, toolName: 'og_get_job', arguments: { jobId: 'j' },
    }, { db, registry });
    assert.equal(resposta.ok, false, `sessão ${JSON.stringify(sessao)} deveria ser recusada`);
    assert.equal(resposta.error.code, 'unknown_session');
  }
  assert.equal(registry.chamadas.length, 0);
});

test('a resposta de recusa não revela o id de sessão pedido', async () => {
  const { db } = cenario();
  const resposta = await handleBridgeInvocation({
    sessionId: 'sess_secreta_do_atacante', toolName: 'og_get_job', arguments: {},
  }, { db, registry: registryEspiao() });
  assert.equal(JSON.stringify(resposta).includes('sess_secreta'), false);
});

test('ids de sessão com formato inesperado são recusados na normalização', () => {
  for (const ruim of ['', '  ', 'com espaço', 'com/barra', 'com.ponto', 'a'.repeat(300)]) {
    assert.throws(() => normalizeSessionId(ruim), DomainError, `"${ruim}" deveria falhar`);
  }
  assert.equal(normalizeSessionId(' sess_ok-123 '), 'sess_ok-123');
});

// ── propriedade do projeto ──────────────────────────────────────────────────

test('conversa sem projeto recusa as tools que exigem projeto', async () => {
  const { db } = cenario({ comProjeto: false });
  const registry = registryEspiao();

  for (const tool of ['og_generate_image', 'og_generate_video', 'og_get_job']) {
    const resposta = await handleBridgeInvocation({
      sessionId: 'sess_valida', toolName: tool, arguments: { prompt: 'x', jobId: 'j' },
    }, { db, registry });
    assert.equal(resposta.ok, false, `${tool} deveria exigir projeto`);
    assert.equal(resposta.error.code, 'project_required');
  }
  assert.equal(registry.chamadas.length, 0);
});

// ── argumentos ──────────────────────────────────────────────────────────────

test('argumentos que não são objeto são recusados', async () => {
  const { db } = cenario();
  const registry = registryEspiao();
  for (const ruim of ['texto', 42, true, ['a']]) {
    const resposta = await handleBridgeInvocation({
      sessionId: 'sess_valida', toolName: 'og_get_job', arguments: ruim,
    }, { db, registry });
    assert.equal(resposta.ok, false);
    assert.equal(resposta.error.code, 'invalid_arguments');
  }
});

// ── falha da tool ───────────────────────────────────────────────────────────

test('falha da tool vira erro sem pilha nem detalhe interno', async () => {
  const { db } = cenario();
  const erro = new Error('Job desconhecido: "j9".');
  erro.detail = { caminho: '/runtime/projects/secreto/x.png' };
  const registry = registryEspiao({ erro });

  const resposta = await handleBridgeInvocation({
    sessionId: 'sess_valida', toolName: 'og_get_job', arguments: { jobId: 'j9' },
  }, { db, registry });

  assert.equal(resposta.ok, false);
  assert.equal(resposta.error.code, 'tool_failed');
  const texto = JSON.stringify(resposta);
  assert.equal(texto.includes('/runtime/'), false);
  assert.equal(texto.includes('stack'), false);
});

// ── sinal do turno ──────────────────────────────────────────────────────────

test('o sinal do turno em andamento chega ao ToolContext', async () => {
  const { db } = cenario();
  const registry = registryEspiao();
  const turns = createActiveTurnRegistry();
  const controlador = new AbortController();

  // O turno é anunciado com o contexto que só o servidor tem — hoje o sinal e a
  // âncora do turno. Ver `createActiveTurnRegistry`.
  turns.begin('sess_valida', { signal: controlador.signal });
  await handleBridgeInvocation({
    sessionId: 'sess_valida', toolName: 'og_get_job', arguments: { jobId: 'j' },
  }, { db, registry, turns });

  assert.equal(registry.chamadas[0].context.signal, controlador.signal);

  turns.end('sess_valida');
  await handleBridgeInvocation({
    sessionId: 'sess_valida', toolName: 'og_get_job', arguments: { jobId: 'j' },
  }, { db, registry, turns });
  assert.equal(registry.chamadas[1].context.signal, null);
});

// ── o socket ────────────────────────────────────────────────────────────────

test('o socket responde e é privado do dono', async () => {
  const { db, thread } = cenario();
  const dir = mkdtempSync(path.join(tmpdir(), 'showrunner-bridge-'));
  const socketPath = path.join(dir, 'bridge.sock');
  const registry = registryEspiao({ resultado: { jobId: 'job_socket' } });

  const servidor = await startBridgeServer({ socketPath, db, registry });
  try {
    // 0600: só o dono. É isto que substitui um token compartilhado.
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);

    const resposta = await pedirPeloSocket(socketPath, {
      sessionId: 'sess_valida', toolName: 'og_generate_image', arguments: { prompt: 'x' },
    });

    assert.equal(resposta.ok, true);
    assert.deepEqual(resposta.result, { jobId: 'job_socket' });
    assert.equal(registry.chamadas[0].context.threadId, thread.id);
  } finally {
    await servidor.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('o socket recusa JSON inválido sem derrubar o servidor', async () => {
  const { db } = cenario();
  const dir = mkdtempSync(path.join(tmpdir(), 'showrunner-bridge-'));
  const socketPath = path.join(dir, 'bridge.sock');
  const servidor = await startBridgeServer({ socketPath, db, registry: registryEspiao() });

  try {
    const ruim = await pedirBruto(socketPath, 'isto não é json\n');
    assert.equal(JSON.parse(ruim).ok, false);

    // O servidor continua atendendo depois do lixo.
    const boa = await pedirPeloSocket(socketPath, {
      sessionId: 'sess_valida', toolName: 'og_get_job', arguments: { jobId: 'j' },
    });
    assert.equal(boa.ok, true);
  } finally {
    await servidor.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function pedirPeloSocket(socketPath, carga) {
  return pedirBruto(socketPath, `${JSON.stringify(carga)}\n`).then(JSON.parse);
}

function pedirBruto(socketPath, texto) {
  return new Promise((resolve, reject) => {
    const cliente = connect(socketPath, () => cliente.write(texto));
    let buffer = '';
    cliente.setEncoding('utf8');
    cliente.on('data', (p) => { buffer += p; });
    cliente.on('end', () => resolve(buffer.trim()));
    cliente.on('error', reject);
  });
}
