// A identidade do agente.
//
// Bug real: perguntado "quem é você?", o agente respondeu "Sou o Hermes Agent,
// um assistente de IA da Nous Research". O usuário conversa com o Showrunner, e
// o que existe por trás não é assunto dele.
//
// A correção é anterior à geração — a persona entra como instrução de sistema.
// Estes testes fixam as duas metades: que a persona é aplicada a toda sessão, e
// que o vazamento, se acontecer mesmo assim, é detectado e corrigido sem
// estragar texto legítimo.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  AGENT_NAME, corrigirAutoidentificacao, inspecionarIdentidade, PERSONA_NAME,
} from '../lib/server/agent/hermes/identity.js';
import { createHermesRuntime } from '../lib/server/agent/adapters/HermesRuntimeAdapter.js';
import { AGENT_EVENTS } from '../lib/server/agent/events.js';
import { openDatabase } from '../lib/server/domain/db.js';
import { createThreadRecord } from '../lib/server/agent/threads.js';
import { createProject } from '../lib/server/domain/projects.js';

const PERSONA = readFileSync('integrations/hermes/persona/showrunner.md', 'utf8');

// ── a persona ───────────────────────────────────────────────────────────────

test('a persona estabelece o nome do produto', () => {
  assert.match(PERSONA, /Showrunner/);
  assert.match(PERSONA, /assistente de criação e direção audiovisual/i);
});

test('a persona NÃO nomeia o que ela proíbe', () => {
  // Escrever "não diga que você é o Hermes" põe a palavra no contexto do
  // modelo — que é exatamente onde ela não deveria estar. A persona descreve a
  // categoria (runtime, provedor, framework) sem citar nome nenhum.
  for (const proibido of ['hermes', 'nous', 'comfy', 'ideogram', 'minimax',
    'og_generate', 'og.generate']) {
    assert.equal(PERSONA.toLowerCase().includes(proibido), false,
      `a persona cita "${proibido}"`);
  }
});

test('a persona declara as três capacidades reais, e só elas', () => {
  assert.match(PERSONA, /gerar imagens/i);
  assert.match(PERSONA, /gerar vídeos/i);
  assert.match(PERSONA, /acompanhar/i);
});

test('a persona nega explicitamente o que o runtime restrito não tem', () => {
  // O isolamento medido no PASSO 7A.2 dá UMA ferramenta ao runtime. Prometer
  // shell ou navegador seria prometer o que não existe.
  for (const negado of ['terminal', 'shell', 'código', 'arquivos', 'navegador',
    'internet', 'automação']) {
    assert.ok(PERSONA.toLowerCase().includes(negado.toLowerCase()),
      `a persona não nega "${negado}"`);
  }
});

test('a persona manda responder como Showrunner quando questionada', () => {
  assert.match(PERSONA, /perguntarem quem você é/i);
  assert.match(PERSONA, /você é o Showrunner/i);
});

// ── detecção ────────────────────────────────────────────────────────────────

test('a autoidentificação errada é detectada', () => {
  const casos = [
    'Sou o Hermes Agent, um assistente de IA da Nous Research.',
    'Eu sou Hermes.',
    'Me chamo Hermes.',
    'Meu nome é Hermes Agent.',
    'I am Hermes, an AI assistant.',
    "I'm the Hermes Agent.",
    'This is Hermes.',
    'You are talking to Hermes.',
    'Sou um assistente de IA da Nous Research.',
  ];
  for (const texto of casos) {
    const { ok, motivos } = inspecionarIdentidade(texto);
    assert.equal(ok, false, `não detectou: ${texto}`);
    assert.ok(motivos.includes('self_identification'));
  }
});

test('conteúdo legítimo que MENCIONA o nome não é vazamento', () => {
  // A distinção que separa proteção de mutilação: o usuário pode pedir uma cena
  // sobre Hermes, o mensageiro dos deuses, e a resposta certa contém a palavra.
  const legitimos = [
    'Escreva uma cena sobre Hermes, o mensageiro dos deuses.',
    'O personagem se chama Hermes e usa sandálias aladas.',
    'Podemos ambientar em Hermes, a cratera lunar.',
    'A marca Nous quer um comercial de 30 segundos.',
    'Sou o Showrunner. Posso gerar imagens.',
  ];
  for (const texto of legitimos) {
    assert.equal(inspecionarIdentidade(texto).ok, true, `falso positivo: ${texto}`);
    assert.equal(corrigirAutoidentificacao(texto), texto, `texto legítimo alterado: ${texto}`);
  }
});

test('identificadores internos são proibidos em qualquer contexto', () => {
  // Não há pergunta cuja resposta correta contenha `enabled_toolsets`.
  for (const texto of ['O enabled_toolsets está restrito.', 'session_id: abc',
    'stream_id perdido', 'no_mcp ativo', 'via HermesRuntimeAdapter', 'HERMES_HOME=/x']) {
    const { ok, motivos } = inspecionarIdentidade(texto);
    assert.equal(ok, false, `não detectou: ${texto}`);
    assert.ok(motivos.includes('internal_identifier'));
  }
});

test('a correção troca só o nome, preservando a frase', () => {
  assert.equal(
    corrigirAutoidentificacao('Sou o Hermes Agent, e posso gerar imagens.'),
    'Sou o Showrunner, e posso gerar imagens.',
  );
  assert.equal(
    corrigirAutoidentificacao('I am Hermes. How can I help?'),
    'I am Showrunner. How can I help?',
  );
});

test('a correção não inventa identidade onde não havia', () => {
  const neutro = 'Posso gerar uma imagem cinematográfica para você.';
  assert.equal(corrigirAutoidentificacao(neutro), neutro);
});

// ── aplicação por sessão ────────────────────────────────────────────────────

function cenario({ persona = PERSONA_NAME, roteiro = '' } = {}) {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_id', name: 'Identidade' }, db);
  const thread = createThreadRecord({ projectId: 'proj_id' }, db);

  const chamadas = [];
  const fetchImpl = async (url, opcoes = {}) => {
    const caminho = String(url).replace(/^https?:\/\/[^/]+/, '');
    const corpo = opcoes.body ? JSON.parse(opcoes.body) : null;
    chamadas.push({ caminho, corpo });

    const json = (d) => ({ ok: true, status: 200, text: async () => JSON.stringify(d) });

    if (caminho === '/health') return json({ status: 'ok' });
    if (caminho === '/api/session/new') {
      return json({ session: { session_id: 'sess_1', enabled_toolsets: ['showrunner', 'no_mcp'] } });
    }
    if (caminho === '/api/personality/set') return json({ ok: true, personality: persona });
    if (caminho === '/api/chat/start') return json({ stream_id: 'st_1' });
    if (caminho.startsWith('/api/chat/stream')) {
      return {
        ok: true, status: 200,
        body: (async function* () { yield new TextEncoder().encode(roteiro); })(),
      };
    }
    return json({ ok: true });
  };

  const runtime = createHermesRuntime({
    baseUrl: 'http://127.0.0.1:9', db, clock: () => 1000, fetchImpl,
  });
  return { db, thread, runtime, chamadas };
}

const roteiroCom = (texto) => [
  `event: token\ndata: ${JSON.stringify({ text: texto })}\n\n`,
  'event: stream_end\ndata: {}\n\n',
].join('');

async function drenar(iteravel) {
  const saida = [];
  for await (const e of await iteravel) saida.push(e);
  return saida;
}

test('toda sessão nova recebe a identidade ANTES do primeiro turno', async () => {
  const { thread, runtime, chamadas } = cenario({ roteiro: roteiroCom('Olá.') });
  await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));

  const criacao = chamadas.findIndex((c) => c.caminho === '/api/session/new');
  const persona = chamadas.findIndex((c) => c.caminho === '/api/personality/set');
  const conversa = chamadas.findIndex((c) => c.caminho === '/api/chat/start');

  assert.ok(persona > criacao, 'a identidade não foi aplicada após criar a sessão');
  assert.ok(persona < conversa, 'a conversa começou antes da identidade');
  assert.equal(chamadas[persona].corpo.name, PERSONA_NAME);
});

test('sessão que não aceita a identidade NÃO é usada nem gravada', async () => {
  // Melhor nenhum agente do que um agente que se apresenta como outro produto.
  const { db, thread, runtime } = cenario({ persona: null, roteiro: roteiroCom('Olá.') });

  await assert.rejects(
    () => drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] })),
    /identidade/i,
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runtime_sessions').get().n, 0);
});

test('a identidade é aplicada uma vez, e não a cada turno', async () => {
  const { thread, runtime, chamadas } = cenario({ roteiro: roteiroCom('Olá.') });
  await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'um' }] }));
  await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'dois' }] }));

  assert.equal(chamadas.filter((c) => c.caminho === '/api/personality/set').length, 1);
});

test('a persona não chega ao fluxo de eventos', async () => {
  const { thread, runtime } = cenario({ roteiro: roteiroCom('Olá.') });
  const eventos = await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));

  const texto = JSON.stringify(eventos);
  assert.equal(texto.includes('personality'), false);
  assert.equal(texto.includes('system_prompt'), false);
  assert.equal(texto.includes('direção audiovisual'), false, 'a persona vazou para a tela');
});

test('se o runtime vazar identidade, a resposta chega corrigida', async () => {
  const { thread, runtime } = cenario({
    roteiro: roteiroCom('Sou o Hermes Agent, um assistente da Nous Research.'),
  });
  const eventos = await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'quem é você?' }] }));

  const completa = eventos.find((e) => e.type === AGENT_EVENTS.MESSAGE_COMPLETED);
  assert.ok(completa);
  assert.match(completa.text, new RegExp(AGENT_NAME));
  assert.equal(/hermes agent|nous research/i.test(completa.text), false);
});

test('a proteção não altera os nomes canônicos das ferramentas', async () => {
  const roteiro = [
    'event: tool\ndata: {"name":"og_generate_image","tid":"c1"}\n\n',
    'event: tool_complete\ndata: {"name":"og_generate_image","tid":"c1"}\n\n',
    `event: token\ndata: ${JSON.stringify({ text: 'Pronto.' })}\n\n`,
    'event: stream_end\ndata: {}\n\n',
  ].join('');
  const { thread, runtime } = cenario({ roteiro });
  const eventos = await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));

  const iniciada = eventos.find((e) => e.type === AGENT_EVENTS.TOOL_STARTED);
  assert.equal(iniciada.name, 'og.generate_image');
});

test('a identidade não interfere no vínculo de sessão', async () => {
  const { db, thread, runtime } = cenario({ roteiro: roteiroCom('Olá.') });
  await drenar(runtime.run({ thread, messages: [{ role: 'user', content: 'oi' }] }));

  const vinculo = db.prepare('SELECT * FROM runtime_sessions').all();
  assert.equal(vinculo.length, 1);
  assert.equal(vinculo[0].threadId, thread.id);
});
