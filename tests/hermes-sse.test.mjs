// Leitura do protocolo SSE e tradução para o vocabulário do Showrunner.
//
// Os fluxos usados aqui são os REAIS, capturados do runtime rodando durante os
// PASSOS 7A.2 e 7A.3. Inventar o formato e testar contra a invenção provaria
// apenas que o teste concorda com o parser.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createSseParser, parseEventData, parseSse } from '../lib/server/agent/hermes/sseParser.js';
import { createEventTranslator, EVENTOS_DESCARTADOS } from '../lib/server/agent/hermes/eventTranslator.js';
import { AGENT_EVENTS } from '../lib/server/agent/events.js';

const relogio = () => 1000;

// ── parser ──────────────────────────────────────────────────────────────────

test('lê um bloco com id, event e data', () => {
  const eventos = parseSse('id: s:1\nevent: token\ndata: {"text":"Vou"}\n\n');
  assert.equal(eventos.length, 1);
  assert.deepEqual(eventos[0], { id: 's:1', event: 'token', data: '{"text":"Vou"}' });
  assert.deepEqual(parseEventData(eventos[0]), { text: 'Vou' });
});

test('remove exatamente um espaço após os dois-pontos', () => {
  // "data:  x" tem dois espaços; um é separador, o outro é conteúdo.
  const [evento] = parseSse('event: token\ndata:  x\n\n');
  assert.equal(evento.data, ' x');
});

test('junta múltiplas linhas de data com quebra', () => {
  const [evento] = parseSse('event: m\ndata: a\ndata: b\n\n');
  assert.equal(evento.data, 'a\nb');
});

test('ignora comentários de keep-alive', () => {
  const eventos = parseSse(': ping\n\nevent: token\ndata: {"text":"x"}\n\n');
  assert.equal(eventos.length, 1);
  assert.equal(eventos[0].event, 'token');
});

test('aceita CRLF', () => {
  const [evento] = parseSse('event: token\r\ndata: {"text":"x"}\r\n\r\n');
  assert.equal(evento.event, 'token');
  assert.deepEqual(parseEventData(evento), { text: 'x' });
});

test('reconstrói eventos partidos entre chunks', () => {
  // O caso que falha em produção e passa em teste ingênuo: a rede corta no meio
  // de uma linha.
  const parser = createSseParser();
  assert.deepEqual(parser.push('event: to'), []);
  assert.deepEqual(parser.push('ken\ndata: {"te'), []);
  const prontos = parser.push('xt":"oi"}\n\n');
  assert.equal(prontos.length, 1);
  assert.deepEqual(parseEventData(prontos[0]), { text: 'oi' });
});

test('flush entrega o último evento quando falta a linha em branco', () => {
  const parser = createSseParser();
  assert.deepEqual(parser.push('event: done\ndata: {}'), []);
  const restantes = parser.flush();
  assert.equal(restantes.length, 1);
  assert.equal(restantes[0].event, 'done');
});

test('data que não é JSON devolve null em vez de lançar', () => {
  const [evento] = parseSse('event: x\ndata: nao-json\n\n');
  assert.equal(parseEventData(evento), null);
});

// ── tradutor ────────────────────────────────────────────────────────────────

const ev = (event, payload) => ({ event, payload });

test('token vira delta e acumula', () => {
  const t = createEventTranslator({ clock: relogio });
  const a = t.traduzir(ev('token', { text: 'Olá' }));
  const b = t.traduzir(ev('token', { text: ' mundo' }));
  assert.equal(a[0].type, AGENT_EVENTS.MESSAGE_DELTA);
  assert.equal(a[0].text, 'Olá');
  assert.equal(b[0].text, ' mundo');
  assert.equal(t.estado().acumulado, 'Olá mundo');
});

test('o raciocínio privado do runtime NÃO atravessa', () => {
  // Texto real observado no PASSO 7A.2: "**Planning terminal tooling**".
  const t = createEventTranslator({ clock: relogio });
  assert.deepEqual(t.traduzir(ev('reasoning', { text: '**Planning terminal tooling**' })), []);
});

test('eventos de economia e de estado do runtime não atravessam', () => {
  const t = createEventTranslator({ clock: relogio });
  for (const nome of EVENTOS_DESCARTADOS) {
    assert.deepEqual(t.traduzir(ev(nome, { qualquer: 'coisa' })), [],
      `"${nome}" não deveria produzir evento`);
  }
});

test('evento desconhecido some em silêncio', () => {
  const t = createEventTranslator({ clock: relogio });
  assert.deepEqual(t.traduzir(ev('algo_que_nao_existe', { x: 1 })), []);
});

test('tool usa o nome CANÔNICO, nunca o alias', () => {
  const t = createEventTranslator({ clock: relogio });
  const saida = t.traduzir(ev('tool', {
    name: 'og_generate_image', tid: 'call_1', args: { prompt: 'um dragão' },
  }));
  assert.equal(saida.length, 1);
  assert.equal(saida[0].type, AGENT_EVENTS.TOOL_STARTED);
  assert.equal(saida[0].name, 'og.generate_image');
  assert.equal(saida[0].toolCallId, 'call_1');
  assert.deepEqual(saida[0].arguments, { prompt: 'um dragão' });
  assert.equal(JSON.stringify(saida).includes('og_generate_image'), false);
});

test('tool_complete fecha com o mesmo nome canônico', () => {
  const t = createEventTranslator({ clock: relogio });
  t.traduzir(ev('tool', { name: 'og_get_job', tid: 'c1' }));
  const saida = t.traduzir(ev('tool_complete', { name: 'og_get_job', tid: 'c1' }));
  assert.equal(saida[0].type, AGENT_EVENTS.TOOL_COMPLETED);
  assert.equal(saida[0].name, 'og.get_job');
});

test('tool com erro vira tool.failed', () => {
  const t = createEventTranslator({ clock: relogio });
  t.traduzir(ev('tool', { name: 'og_get_job', tid: 'c1' }));
  const saida = t.traduzir(ev('tool_complete', { name: 'og_get_job', tid: 'c1', error: 'estourou' }));
  assert.equal(saida[0].type, AGENT_EVENTS.TOOL_FAILED);
  assert.equal(saida[0].name, 'og.get_job');
});

test('tool que não conhecemos é OMITIDA, não repassada', () => {
  // Se o isolamento do runtime regredisse e ele chamasse `terminal`, o nome não
  // pode aparecer na tela — nem como evento genérico.
  const t = createEventTranslator({ clock: relogio });
  assert.deepEqual(t.traduzir(ev('tool', { name: 'terminal', tid: 'c9', args: { command: 'pwd' } })), []);
  assert.deepEqual(t.traduzir(ev('tool_complete', { name: 'terminal', tid: 'c9' })), []);
});

test('a resposta final não é duplicada entre token e done', () => {
  // O runtime manda a resposta duas vezes; a conversa só pode receber uma.
  const t = createEventTranslator({ clock: relogio });
  t.traduzir(ev('token', { text: 'OK' }));
  t.traduzir(ev('done', {
    session: { messages: [{ role: 'user', content: 'oi' }, { role: 'assistant', content: 'OK' }] },
  }));
  const fim = t.traduzir(ev('stream_end', {}));

  const completas = fim.filter((e) => e.type === AGENT_EVENTS.MESSAGE_COMPLETED);
  assert.equal(completas.length, 1);
  assert.equal(completas[0].text, 'OK');
  assert.equal(fim.at(-1).type, AGENT_EVENTS.COMPLETED);
});

test('sem done, a resposta é o acumulado dos deltas', () => {
  const t = createEventTranslator({ clock: relogio });
  t.traduzir(ev('token', { text: 'meta' }));
  t.traduzir(ev('token', { text: 'de' }));
  const fim = t.finalizar();
  assert.equal(fim[0].text, 'metade');
});

test('finalizar é idempotente', () => {
  const t = createEventTranslator({ clock: relogio });
  t.traduzir(ev('token', { text: 'x' }));
  assert.equal(t.finalizar().length, 2);
  assert.deepEqual(t.finalizar(), []);
});

test('apperror vira falha com mensagem NOSSA', () => {
  // A mensagem real cita status HTTP e forma de payload do provider:
  // "HTTP 400: Invalid 'tools[0].name': ..." — nada disso pode vazar.
  const t = createEventTranslator({ clock: relogio });
  const bruta = "HTTP 400: Invalid 'tools[0].name': string does not match pattern.";
  const saida = t.traduzir(ev('apperror', { message: bruta, details: bruta }));

  assert.equal(saida[0].type, AGENT_EVENTS.FAILED);
  const texto = JSON.stringify(saida);
  assert.equal(texto.includes('HTTP 400'), false);
  assert.equal(texto.includes('tools[0]'), false);
  assert.match(saida[0].error.message, /não conseguiu concluir/);
});

test('depois de falhar, não emite resposta concluída', () => {
  const t = createEventTranslator({ clock: relogio });
  t.traduzir(ev('token', { text: 'parcial' }));
  t.traduzir(ev('apperror', { message: 'x' }));
  assert.deepEqual(t.finalizar(), []);
});

test('done com mensagem de erro do runtime não vira resposta', () => {
  const t = createEventTranslator({ clock: relogio });
  t.traduzir(ev('done', {
    session: { messages: [{ role: 'assistant', content: '**Error:** HTTP 400', _error: true }] },
  }));
  const fim = t.finalizar();
  assert.equal(fim.filter((e) => e.type === AGENT_EVENTS.MESSAGE_COMPLETED).length, 0);
});
