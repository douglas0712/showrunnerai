// A redução de AgentEvents em estado de tela.
//
// É a metade do cliente onde mora a decisão: o que aparece, com que palavra, e
// o que é descartado. Testável sem navegador, sem React e sem rede — que é o
// motivo de ela estar separada do fetch.
//
// O que estes testes protegem, sobretudo: que nenhum vocabulário do runtime
// chegue à tela, e que a mesma mídia não seja mostrada duas vezes.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  aplicarEvento, blocoParaEvento, comMidia, EVENTOS, friendlyError,
  labelForTool, novaResposta,
} from '../lib/agentClient.js';

const relogio = () => 1000;
const inicial = () => novaResposta('r1', relogio);

const ev = (type, extra = {}) => ({ type, ts: 1, ...extra });

// ── texto ───────────────────────────────────────────────────────────────────

test('deltas se acumulam na ordem', () => {
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.DELTA, { text: 'Vou ' }));
  r = aplicarEvento(r, ev(EVENTOS.DELTA, { text: 'gerar' }));
  assert.equal(r.text, 'Vou gerar');
  assert.equal(r.status, 'streaming');
});

test('a mensagem completa SUBSTITUI o acumulado, não soma', () => {
  // Somar duplicaria a resposta inteira: os deltas são prévia do mesmo texto.
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.DELTA, { text: 'OK' }));
  r = aplicarEvento(r, ev(EVENTOS.COMPLETED_MSG, { text: 'OK' }));
  assert.equal(r.text, 'OK');
});

test('agent.completed encerra e limpa o rótulo de status', () => {
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.STATUS, { status: 'Pensando' }));
  assert.equal(r.statusLabel, 'Pensando');
  r = aplicarEvento(r, ev(EVENTOS.COMPLETED));
  assert.equal(r.status, 'completed');
  assert.equal(r.statusLabel, null);
});

test('evento fora do vocabulário não muda nada — nem por cópia', () => {
  const r = inicial();
  assert.equal(aplicarEvento(r, ev('hermes.qualquer.coisa')), r);
  assert.equal(aplicarEvento(r, ev('tool_use')), r);
  assert.equal(aplicarEvento(r, null), r);
});

// ── atividade de produção ───────────────────────────────────────────────────

test('a atividade aparece em linguagem de produção, não de console', () => {
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.TOOL_STARTED, { toolCallId: 'c1', name: 'og.generate_image' }));

  assert.equal(r.activity.length, 1);
  assert.equal(r.activity[0].label, 'Gerando imagem…');
  assert.equal(r.activity[0].state, 'running');

  // Nada de nome de ferramenta na frase que o usuário lê.
  assert.equal(/og[._]generate/.test(r.activity[0].label), false);
});

test('cada ferramenta tem a própria frase', () => {
  assert.equal(labelForTool('og.generate_image'), 'Gerando imagem…');
  assert.equal(labelForTool('og.generate_video'), 'Gerando vídeo…');
  assert.equal(labelForTool('og.get_job'), 'Verificando a produção…');
  // Ferramenta que a tela não conhece ainda assim não expõe o nome técnico.
  assert.equal(labelForTool('og.qualquer_outra'), 'Trabalhando…');
});

test('tool.completed fecha a atividade certa', () => {
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.TOOL_STARTED, { toolCallId: 'c1', name: 'og.generate_image' }));
  r = aplicarEvento(r, ev(EVENTOS.TOOL_STARTED, { toolCallId: 'c2', name: 'og.get_job' }));
  r = aplicarEvento(r, ev(EVENTOS.TOOL_COMPLETED, { toolCallId: 'c1', name: 'og.generate_image' }));

  assert.equal(r.activity.find((a) => a.id === 'c1').state, 'done');
  assert.equal(r.activity.find((a) => a.id === 'c1').label, 'Imagem gerada');
  assert.equal(r.activity.find((a) => a.id === 'c2').state, 'running');
});

test('tool.failed vira frase compreensível, sem detalhe técnico', () => {
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.TOOL_STARTED, { toolCallId: 'c1', name: 'og.generate_image' }));
  r = aplicarEvento(r, ev(EVENTOS.TOOL_FAILED, {
    toolCallId: 'c1', name: 'og.generate_image',
    error: { message: 'ECONNREFUSED 127.0.0.1:8188', code: 'tool_failed' },
  }));

  const item = r.activity[0];
  assert.equal(item.state, 'failed');
  assert.equal(/ECONNREFUSED|8188/.test(item.label), false, 'vazou detalhe técnico');
});

test('tool.started repetido não duplica a linha', () => {
  let r = inicial();
  const e = ev(EVENTOS.TOOL_STARTED, { toolCallId: 'c1', name: 'og.generate_image' });
  r = aplicarEvento(r, e);
  r = aplicarEvento(r, e);
  assert.equal(r.activity.length, 1);
});

// ── mídia ───────────────────────────────────────────────────────────────────

const ASSET_IMG = {
  asset: {
    id: 'asset_1', kind: 'image',
    mediaUrl: '/api/media/image/proj/x.png', mimeType: 'image/png',
    derivedFromAssetId: null,
  },
};

test('imagem no resultado vira mídia da mensagem', () => {
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.TOOL_COMPLETED, {
    toolCallId: 'c1', name: 'og.generate_image', result: ASSET_IMG,
  }));

  assert.equal(r.media.length, 1);
  assert.deepEqual(r.media[0], {
    assetId: 'asset_1', kind: 'image',
    mediaUrl: '/api/media/image/proj/x.png', mimeType: 'image/png',
    derivedFromAssetId: null,
  });
});

test('vídeo é reconhecido como vídeo', () => {
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.TOOL_COMPLETED, {
    toolCallId: 'c1', name: 'og.generate_video',
    result: { asset: { id: 'asset_v', kind: 'video', mediaUrl: '/api/media/video/proj/v.mp4', mimeType: 'video/mp4', derivedFromAssetId: 'asset_1' } },
  }));

  assert.equal(r.media[0].kind, 'video');
  assert.equal(r.media[0].derivedFromAssetId, 'asset_1');
});

test('o mesmo Asset citado por duas ferramentas aparece UMA vez', () => {
  // og.generate_image cria; og.get_job confirma. Mostrar duas vezes faria
  // parecer que houve duas gerações.
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.TOOL_COMPLETED, {
    toolCallId: 'c1', name: 'og.generate_image', result: ASSET_IMG,
  }));
  r = aplicarEvento(r, ev(EVENTOS.TOOL_COMPLETED, {
    toolCallId: 'c2', name: 'og.get_job', result: ASSET_IMG,
  }));

  assert.equal(r.media.length, 1);
});

test('resultado sem Asset utilizável não vira mídia', () => {
  const base = [];
  assert.equal(comMidia(base, null), base);
  assert.equal(comMidia(base, { jobId: 'j1', status: 'gerando' }), base);
  // Asset sem URL não tem o que exibir.
  assert.equal(comMidia(base, { asset: { id: 'a', kind: 'image', mediaUrl: null } }), base);
});

test('a mídia nunca vem de caminho de arquivo', () => {
  // Só `mediaUrl` do Asset. Montar URL a partir de caminho seria expor o disco.
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.TOOL_COMPLETED, {
    toolCallId: 'c1', name: 'og.generate_image', result: ASSET_IMG,
  }));
  assert.match(r.media[0].mediaUrl, /^\/api\/media\//);
  assert.equal(/runtime\/|\/home\/|\.\.\//.test(r.media[0].mediaUrl), false);
});

// ── falhas ──────────────────────────────────────────────────────────────────

test('agent.failed vira frase amigável', () => {
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.FAILED, {
    error: { message: 'AgentTurnError: ECONNREFUSED', code: 'agent_turn_failed' },
  }));

  assert.equal(r.status, 'failed');
  assert.match(r.error.message, /Algo deu errado/);
  assert.equal(/ECONNREFUSED|AgentTurnError/.test(r.error.message), false);
});

test('runtime indisponível tem frase própria e acionável', () => {
  const frase = friendlyError({ code: 'runtime_unavailable' });
  assert.match(frase, /temporariamente indisponível/);
  assert.match(frase, /novamente/);
});

test('nenhuma frase de erro nomeia peça interna', () => {
  for (const code of ['runtime_unavailable', 'thread_not_found', 'invalid_request',
    'network', 'agent_turn_failed', null]) {
    const frase = friendlyError({ code });
    for (const proibido of ['hermes', 'sqlite', 'socket', 'comfy', 'session',
      'stream', 'toolset', 'stack', 'ECONN']) {
      assert.equal(frase.toLowerCase().includes(proibido.toLowerCase()), false,
        `"${proibido}" apareceu em: ${frase}`);
    }
  }
});

// ── SSE ─────────────────────────────────────────────────────────────────────

test('um bloco SSE vira o evento que carrega', () => {
  const bloco = 'event: agent.message.delta\ndata: {"type":"agent.message.delta","ts":1,"text":"oi"}';
  assert.deepEqual(blocoParaEvento(bloco), {
    type: 'agent.message.delta', ts: 1, text: 'oi',
  });
});

test('bloco sem data, ou com data inválido, devolve null', () => {
  assert.equal(blocoParaEvento('event: x'), null);
  assert.equal(blocoParaEvento('data: nao-json'), null);
  assert.equal(blocoParaEvento(''), null);
});

// ── um turno inteiro ────────────────────────────────────────────────────────

test('um turno com imagem monta texto, atividade e mídia — sem vazamento', () => {
  const turno = [
    ev(EVENTOS.STARTED),
    ev(EVENTOS.STATUS, { status: 'Pensando' }),
    ev(EVENTOS.TOOL_STARTED, { toolCallId: 'c1', name: 'og.generate_image', arguments: { prompt: 'um dragão' } }),
    ev(EVENTOS.TOOL_COMPLETED, { toolCallId: 'c1', name: 'og.generate_image', result: ASSET_IMG }),
    ev(EVENTOS.DELTA, { text: 'Pronto: ' }),
    ev(EVENTOS.DELTA, { text: 'o dragão está aí.' }),
    ev(EVENTOS.COMPLETED_MSG, { text: 'Pronto: o dragão está aí.' }),
    ev(EVENTOS.COMPLETED),
  ];

  let r = inicial();
  for (const e of turno) r = aplicarEvento(r, e);

  assert.equal(r.status, 'completed');
  assert.equal(r.text, 'Pronto: o dragão está aí.');
  assert.equal(r.media.length, 1);
  assert.equal(r.activity[0].label, 'Imagem gerada');

  const superficie = JSON.stringify(r).toLowerCase();
  for (const proibido of ['hermes', 'session_id', 'stream_id', 'enabled_toolsets',
    'no_mcp', 'plugin', 'socket', 'comfy', 'workflowid', 'promptid',
    'og_generate', 'ideogram', 'minimax', '/runtime/']) {
    assert.equal(superficie.includes(proibido.toLowerCase()), false,
      `"${proibido}" vazou para o estado da tela`);
  }
});

// ── a URL não aparece duas vezes ────────────────────────────────────────────

test('a URL da mídia exibida sai do texto', async () => {
  // Observado no smoke: o agente escreve o endereço do arquivo na resposta.
  // Como a imagem já aparece logo abaixo, deixar a URL mostra a mesma coisa
  // duas vezes — e uma delas em forma de endereço, que a conversa não expõe.
  const { semUrlsJaExibidas } = await import('../lib/agentClient.js');
  const midia = [{ mediaUrl: '/api/media/image/p/x.png' }];

  assert.equal(
    semUrlsJaExibidas('Pronta — aqui está:\n\nMEDIA:/api/media/image/p/x.png', midia),
    'Pronta — aqui está:',
  );
  assert.equal(semUrlsJaExibidas('Veja: /api/media/image/p/x.png', midia), 'Veja:');
});

test('uma URL que NÃO está sendo exibida permanece no texto', () => {
  // Aí ela é a única pista que o usuário tem.
  const midia = [{ mediaUrl: '/api/media/image/p/x.png' }];
  const texto = 'Veja /api/media/image/OUTRA/y.png';
  assert.equal(aplicarEvento(
    { ...inicial(), text: texto, media: midia },
    ev(EVENTOS.COMPLETED),
  ).text, texto);
});

test('sem mídia, o texto passa intacto', () => {
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.COMPLETED_MSG, { text: 'Só texto, nada de mídia.' }));
  r = aplicarEvento(r, ev(EVENTOS.COMPLETED));
  assert.equal(r.text, 'Só texto, nada de mídia.');
});

test('o turno completo remove a URL e mantém a imagem', () => {
  let r = inicial();
  r = aplicarEvento(r, ev(EVENTOS.TOOL_COMPLETED, {
    toolCallId: 'c1', name: 'og.generate_image', result: ASSET_IMG,
  }));
  r = aplicarEvento(r, ev(EVENTOS.COMPLETED_MSG, {
    text: 'Pronta:\n\nMEDIA:/api/media/image/proj/x.png',
  }));
  r = aplicarEvento(r, ev(EVENTOS.COMPLETED));

  assert.equal(r.text, 'Pronta:');
  assert.equal(r.media.length, 1);
});
