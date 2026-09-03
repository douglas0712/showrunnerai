// AgentRuntimePort, vocabulário de eventos e EchoRuntimeAdapter.
//
// O que estes testes protegem é a fronteira. O Showrunner é o produto e o
// runtime que raciocina é peça trocável — mas isso só é verdade enquanto o
// contrato for conferido de verdade e enquanto os eventos que saem de um
// runtime forem reduzidos ao vocabulário do Showrunner antes de chegarem a
// qualquer outro lugar.
//
// O Echo é o piso: determinístico, sem rede, sem modelo, sem disco. Se um teste
// da camada de agente falhar, a culpa é da nossa camada, nunca do runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  AGENT_EVENT_TYPES, assertRuntimeAvailable, assertRuntimePort, describeRuntime,
  RUNTIME_METHODS, RuntimeContractError, RuntimeUnavailableError,
} from '../lib/server/agent/AgentRuntimePort.js';
import {
  AGENT_EVENTS, AgentEventError, agentErrorPayload, createAgentEvent,
  declaredFieldsFor, isAgentEventType, normalizeAgentEvent,
} from '../lib/server/agent/events.js';
import { createEchoRuntime } from '../lib/server/agent/adapters/EchoRuntimeAdapter.js';
import {
  availableRuntimeIds, configuredRuntimeId, createRuntime, DEFAULT_RUNTIME_ID,
} from '../lib/server/agent/runtimes.js';

const RELOGIO_FIXO = () => 1_700_000_000_000;

const drenar = async (iteravel) => {
  const eventos = [];
  for await (const e of iteravel) eventos.push(e);
  return eventos;
};

const turno = (texto) => ({
  thread: { id: 'thread_t', projectId: null, title: 'T', status: 'active' },
  messages: [{ id: 'm1', threadId: 'thread_t', seq: 1, role: 'user', content: texto }],
  context: { agentName: 'Showrunner', threadId: 'thread_t', projectId: null },
  tools: [],
  signal: null,
});

// ── 9 · o Echo cumpre o contrato ────────────────────────────────────────────

test('9. o EchoRuntimeAdapter implementa o AgentRuntimePort', () => {
  const echo = createEchoRuntime();

  // A conferência é a de produção, não uma lista paralela escrita no teste.
  assert.equal(assertRuntimePort(echo), echo);

  for (const metodo of RUNTIME_METHODS) {
    assert.equal(typeof echo[metodo], 'function', `${metodo} não é função`);
  }
  assert.equal(typeof echo.id, 'string');
  assert.equal(echo.isAvailable(), true);
  assert.equal(echo.unavailableReason(), null);
  assert.equal(assertRuntimeAvailable(echo), echo);
});

test('9b. um objeto que não cumpre o contrato é RECUSADO na fronteira', () => {
  const completo = createEchoRuntime();

  for (const faltando of RUNTIME_METHODS) {
    const capenga = { ...completo };
    delete capenga[faltando];
    assert.throws(
      () => assertRuntimePort(capenga),
      (erro) => erro instanceof RuntimeContractError && erro.detail.faltando.includes(faltando),
      `aceitou runtime sem ${faltando}`,
    );
  }

  // Sem id, sem contrato: o diagnóstico precisa saber de quem está falando.
  assert.throws(() => assertRuntimePort({ ...completo, id: '' }), RuntimeContractError);
  for (const naoObjeto of [null, undefined, 'echo', 42, () => {}]) {
    assert.throws(() => assertRuntimePort(naoObjeto), RuntimeContractError);
  }
});

test('9c. run devolve um AsyncIterable — o contrato já é o de um fluxo', async () => {
  const fluxo = createEchoRuntime().run(turno('Olá'));
  assert.equal(typeof fluxo[Symbol.asyncIterator], 'function');

  const eventos = await drenar(fluxo);
  assert.ok(eventos.length > 1, 'um turno precisa produzir vários eventos');
});

test('9d. runtime indisponível falha com o motivo, sem virar turno', () => {
  const desligado = {
    ...createEchoRuntime(),
    isAvailable: () => false,
    unavailableReason: () => 'O agente não está configurado nesta instalação.',
  };

  assert.throws(
    () => assertRuntimeAvailable(desligado),
    (erro) => erro instanceof RuntimeUnavailableError
      && /não está configurado/.test(erro.message),
  );

  assert.deepEqual(describeRuntime(desligado), {
    id: 'echo',
    available: false,
    unavailableReason: 'O agente não está configurado nesta instalação.',
  });
});

// ── 10 · determinismo ───────────────────────────────────────────────────────

test('10. o Echo é determinístico — mesma entrada, mesma sequência de eventos', async () => {
  const echo = createEchoRuntime({ clock: RELOGIO_FIXO });

  const a = await drenar(echo.run(turno('Olá Showrunner')));
  const b = await drenar(echo.run(turno('Olá Showrunner')));
  const c = await drenar(createEchoRuntime({ clock: RELOGIO_FIXO }).run(turno('Olá Showrunner')));

  // Campo a campo, inclusive o carimbo de tempo — por isso o relógio é injetado.
  assert.deepEqual(a, b);
  assert.deepEqual(a, c, 'duas instâncias divergiram: há estado escondido');

  // E entradas diferentes produzem saídas diferentes: determinismo não é
  // devolver sempre a mesma coisa.
  const outra = await drenar(echo.run(turno('Outra pergunta')));
  assert.notDeepEqual(a, outra);
});

test('10b. o Echo responde à última fala do usuário, e os deltas somam o texto', async () => {
  const eventos = await drenar(createEchoRuntime().run({
    ...turno('ignorada'),
    messages: [
      { role: 'user', content: 'primeira' },
      { role: 'assistant', content: 'Recebi: primeira' },
      { role: 'user', content: 'Olá Showrunner' },
    ],
  }));

  const completa = eventos.find((e) => e.type === AGENT_EVENTS.MESSAGE_COMPLETED);
  assert.equal(completa.text, 'Recebi: Olá Showrunner');

  const deltas = eventos.filter((e) => e.type === AGENT_EVENTS.MESSAGE_DELTA);
  assert.ok(deltas.length >= 1);
  assert.equal(
    deltas.map((e) => e.text).join(''), completa.text,
    'a concatenação dos deltas precisa dar exatamente a mensagem completa',
  );

  // A ordem do turno: começa, termina, e nada depois do fim.
  assert.equal(eventos[0].type, AGENT_EVENTS.STARTED);
  assert.equal(eventos.at(-1).type, AGENT_EVENTS.COMPLETED);
});

test('10c. turno sem fala de usuário falha alto, em vez de responder do nada', async () => {
  await assert.rejects(
    () => drenar(createEchoRuntime().run({ ...turno('x'), messages: [] })),
    /Não há mensagem de usuário/,
  );
  await assert.rejects(
    () => drenar(createEchoRuntime().run({
      ...turno('x'), messages: [{ role: 'assistant', content: 'só eu falei' }],
    })),
    /Não há mensagem de usuário/,
  );
});

test('10d. o Echo não emite evento de tool — não há ferramenta executada', async () => {
  const eventos = await drenar(createEchoRuntime().run(turno('Olá')));
  const deFerramenta = eventos.filter((e) => e.type.startsWith('tool.'));
  assert.deepEqual(deFerramenta, [], 'log simulado de ferramenta');
});

// ── 11 · sem rede ───────────────────────────────────────────────────────────

test('11. o Echo não usa rede — nem no código, nem em execução', async () => {
  const fonte = await readFile(
    new URL('../lib/server/agent/adapters/EchoRuntimeAdapter.js', import.meta.url), 'utf8',
  );
  const codigo = tirarComentarios(fonte);

  // Camada 1 — o módulo importa o vocabulário de eventos e nada mais.
  const importados = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(importados, ['../events.js'], `o Echo importa ${importados.join(', ')}`);

  for (const proibido of [/\bfetch\b/, /node:http/, /node:net/, /XMLHttpRequest/, /WebSocket/]) {
    assert.ok(!proibido.test(codigo), `o Echo cita ${proibido}`);
  }
  // Nem disco, nem processo, nem aleatoriedade.
  for (const proibido of [/node:fs/, /child_process/, /Math\.random/, /node:crypto/]) {
    assert.ok(!proibido.test(codigo), `o Echo cita ${proibido}`);
  }

  // Camada 2 — com a rede armada para explodir, o turno inteiro passa.
  const originais = { fetch: globalThis.fetch };
  globalThis.fetch = () => { throw new Error('o Echo tentou usar a rede'); };
  try {
    const eventos = await drenar(createEchoRuntime().run(turno('Olá Showrunner')));
    assert.equal(
      eventos.find((e) => e.type === AGENT_EVENTS.MESSAGE_COMPLETED).text,
      'Recebi: Olá Showrunner',
    );
    assert.deepEqual(await createEchoRuntime().testConnection(), {
      ok: true, detail: { runtime: 'echo', network: false },
    });
  } finally {
    globalThis.fetch = originais.fetch;
  }
});

// ── 24 · tools vazias ───────────────────────────────────────────────────────

test('24. uma coleção vazia de tools pode ser oferecida ao runtime', async () => {
  const eventos = await drenar(createEchoRuntime().run({ ...turno('Olá'), tools: [] }));
  assert.ok(eventos.length > 0, 'tools: [] derrubou o turno');

  // O parâmetro é conferido: o Passo 6 acrescenta conteúdo a ele, não um
  // argumento novo — e algo que não seja coleção precisa falhar hoje.
  for (const ruim of ['og.generate_image', 42, {}]) {
    await assert.rejects(
      () => drenar(createEchoRuntime().run({ ...turno('Olá'), tools: ruim })),
      TypeError,
      `aceitou tools ${JSON.stringify(ruim)}`,
    );
  }
});

// ── 25 · vocabulário normalizado ────────────────────────────────────────────

test('25. os nove eventos do vocabulário do Showrunner existem', () => {
  assert.deepEqual(AGENT_EVENT_TYPES, [
    'agent.started',
    'agent.status',
    'agent.message.delta',
    'agent.message.completed',
    'tool.started',
    'tool.completed',
    'tool.failed',
    'agent.completed',
    'agent.failed',
  ]);
  for (const tipo of AGENT_EVENT_TYPES) assert.ok(isAgentEventType(tipo));
  assert.equal(isAgentEventType('message_delta'), false);
});

test('25b. todo evento do Echo está no vocabulário e sobrevive à normalização', async () => {
  const eventos = await drenar(createEchoRuntime({ clock: RELOGIO_FIXO }).run(turno('Olá')));

  for (const evento of eventos) {
    assert.ok(isAgentEventType(evento.type), `${evento.type} fora do vocabulário`);
    // Normalizar de novo não muda nada: o que o Echo emite já É o normalizado.
    assert.deepEqual(normalizeAgentEvent(evento), evento);
    assert.equal(typeof evento.ts, 'number');
  }
});

test('25c. a normalização DESCARTA tudo que não é do vocabulário', () => {
  // Este é o teste que sustenta a promessa da etapa: um adaptador futuro pode
  // anexar o que quiser ao evento — id de sessão, contagem de tokens, nome do
  // modelo — e nada disso atravessa a fronteira.
  const vazado = normalizeAgentEvent({
    type: AGENT_EVENTS.MESSAGE_COMPLETED,
    ts: 1,
    text: 'resposta',
    sessionId: 'sess_interna_do_runtime',
    model: 'algum-modelo-interno',
    runtime: 'nome-do-runtime',
    tokens: { input: 10, output: 4 },
    raw: { qualquer: 'coisa' },
  });

  assert.deepEqual(vazado, { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: 'resposta' });
  assert.deepEqual(Object.keys(vazado).sort(), ['text', 'ts', 'type']);

  // E os campos declarados de cada tipo são exatamente esses.
  assert.deepEqual(declaredFieldsFor(AGENT_EVENTS.STARTED), ['type', 'ts']);
  assert.deepEqual(declaredFieldsFor(AGENT_EVENTS.STATUS), ['type', 'ts', 'status']);
  assert.deepEqual(
    declaredFieldsFor(AGENT_EVENTS.TOOL_STARTED),
    ['type', 'ts', 'toolCallId', 'name', 'arguments'],
  );
});

test('25d. tipo fora do vocabulário é RECUSADO, não repassado', () => {
  // Nomes que um runtime de terceiro poderia usar internamente.
  for (const alheio of [
    'message_delta', 'content_block_delta', 'session.created', 'executing',
    'progress', 'agent.thinking', '', null, undefined,
  ]) {
    assert.throws(
      () => normalizeAgentEvent({ type: alheio, ts: 1 }),
      AgentEventError,
      `deixou passar o tipo ${JSON.stringify(alheio)}`,
    );
  }
  for (const naoObjeto of [null, undefined, 'agent.started', 42]) {
    assert.throws(() => normalizeAgentEvent(naoObjeto), AgentEventError);
  }
});

test('25e. um evento sem os campos que o próprio tipo exige é recusado', () => {
  const faltas = [
    [AGENT_EVENTS.STATUS, {}],
    [AGENT_EVENTS.MESSAGE_DELTA, {}],
    [AGENT_EVENTS.MESSAGE_COMPLETED, { text: null }],
    [AGENT_EVENTS.TOOL_STARTED, { name: 'og.alguma' }],
    [AGENT_EVENTS.TOOL_FAILED, { toolCallId: 'c1', name: 'og.alguma' }],
    [AGENT_EVENTS.FAILED, {}],
  ];

  for (const [type, carga] of faltas) {
    assert.throws(
      () => normalizeAgentEvent({ type, ts: 1, ...carga }),
      AgentEventError,
      `${type} passou incompleto`,
    );
  }

  // Os que não exigem nada continuam válidos com o mínimo.
  for (const tipo of [AGENT_EVENTS.STARTED, AGENT_EVENTS.COMPLETED]) {
    assert.deepEqual(normalizeAgentEvent({ type: tipo, ts: 7 }), { type: tipo, ts: 7 });
  }
});

test('25f. o payload de erro é sempre message + code, nunca a exceção crua', () => {
  const erro = new Error('quebrou lá dentro');
  erro.stack = 'PILHA INTERNA QUE NÃO PODE VAZAR';
  erro.responseBody = '{"segredo":true}';

  assert.deepEqual(agentErrorPayload(erro), {
    message: 'quebrou lá dentro', code: 'agent_error',
  });
  assert.deepEqual(agentErrorPayload('texto puro', 'meu_code'), {
    message: 'texto puro', code: 'meu_code',
  });

  const evento = createAgentEvent(AGENT_EVENTS.FAILED, { error: agentErrorPayload(erro) }, RELOGIO_FIXO);
  assert.deepEqual(Object.keys(evento).sort(), ['error', 'ts', 'type']);
  assert.ok(!JSON.stringify(evento).includes('PILHA INTERNA'));
});

// ── seleção de runtime ──────────────────────────────────────────────────────

test('17a. o echo continua sendo o padrão, mesmo com o runtime dedicado disponível', () => {
  // PASSO 7B acrescentou 'hermes'. O padrão NÃO mudou junto: trocar o runtime
  // é decisão de operador, por variável de ambiente, e uma instalação que não
  // decidiu nada continua no piso determinístico.
  assert.deepEqual(availableRuntimeIds(), ['echo', 'hermes']);
  assert.equal(DEFAULT_RUNTIME_ID, 'echo');
  assert.equal(configuredRuntimeId(), 'echo');
  assert.equal(createRuntime().id, 'echo');
  assert.equal(createRuntime('echo').id, 'echo');
});

test('17a-bis. o runtime dedicado nasce indisponível sem configuração', () => {
  // Sem endereço configurado ele não é utilizável — e o gateway confere a
  // disponibilidade ANTES de escrever qualquer coisa, então uma instalação
  // meio-configurada não deixa turno pela metade no banco.
  const runtime = createRuntime('hermes', { baseUrl: '' });
  assert.equal(runtime.id, 'hermes');
  assert.equal(runtime.isAvailable(), false);
  assert.match(runtime.unavailableReason(), /não está configurado/);
});

test('17b. runtime desconhecido falha explicitamente — nunca cai em outro', () => {
  for (const id of ['nao_existe', 'llm', '', 'ECHO']) {
    assert.throws(
      () => createRuntime(id),
      (erro) => erro instanceof RuntimeUnavailableError
        && erro.detail.disponiveis.includes('echo'),
      `"${id}" caiu silenciosamente em outro runtime`,
    );
  }
});

function tirarComentarios(fonte) {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
}
