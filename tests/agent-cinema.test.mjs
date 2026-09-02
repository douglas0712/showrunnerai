import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BRIEFING_FIELDS, GREETING, briefingProgress, currentSuggestions,
  initialAgentState, respond,
} from '../lib/agentScript.js';
import { CINEMA_CONTROLS, buildCinematicPrompt, fragmentFor } from '../lib/cinema.js';

test('o agente abre com a mensagem exigida', () => {
  assert.equal(
    GREETING,
    'Olá! Vou ajudar você a transformar sua ideia em uma produção audiovisual. Para começar, que tipo de vídeo você deseja criar?',
  );
});

test('a entrevista percorre todo o briefing e fecha completa', () => {
  let state = initialAgentState();
  const respostas = ['Curta narrativo', 'Uma detetive e um sinal', 'Público geral', 'Épico', '3 minutos', '21:9'];

  respostas.forEach((resposta) => {
    const result = respond(state, resposta);
    state = result.state;
    assert.ok(result.reply.length > 0);
  });

  assert.equal(state.complete, true);
  BRIEFING_FIELDS.forEach((field) => {
    assert.ok(state.briefing[field.key], `faltou preencher ${field.key}`);
  });
  assert.equal(briefingProgress(state.briefing).percent, 100);
});

test('o agente anexa entregas para aprovação só no fim', () => {
  let state = initialAgentState();
  const respostas = ['Curta', 'Tema', 'Público', 'Tom', '1 minuto', '16:9'];
  const anexos = respostas.map((resposta) => {
    const result = respond(state, resposta);
    state = result.state;
    return result.attachments;
  });

  assert.deepEqual(anexos.slice(0, 5).flat(), []);
  assert.deepEqual(anexos[5], ['image', 'video']);
});

test('toda pergunta aberta oferece sugestões; depois do fim, nenhuma', () => {
  let state = initialAgentState();
  for (let i = 0; i < 6; i += 1) {
    assert.ok(currentSuggestions(state).length > 0, `passo ${i} sem sugestões`);
    state = respond(state, 'x').state;
  }
  assert.deepEqual(currentSuggestions(state), []);
});

test('as sugestões correspondem à pergunta que está sendo respondida', () => {
  let state = initialAgentState();
  // passo 0 pergunta o formato
  assert.ok(currentSuggestions(state).includes('Curta narrativo'));

  state = respond(state, 'Curta narrativo').state; // agora pergunta o tema
  assert.ok(!currentSuggestions(state).includes('Investidores'), 'público não é tema');

  state = respond(state, 'Um mistério').state; // agora pergunta o público
  assert.ok(currentSuggestions(state).includes('Investidores'));

  state = respond(state, 'Investidores').state; // agora pergunta o tom
  assert.ok(currentSuggestions(state).includes('Épico e cinematográfico'));

  state = respond(state, 'Épico').state; // agora pergunta a duração
  assert.ok(currentSuggestions(state).includes('30 segundos'));

  state = respond(state, '30 segundos').state; // agora pergunta a proporção
  assert.ok(currentSuggestions(state).includes('21:9 — cinemascope'));
});

test('responder depois do fim não quebra o estado', () => {
  let state = initialAgentState();
  for (let i = 0; i < 8; i += 1) state = respond(state, 'x').state;
  const result = respond(state, 'e agora?');
  assert.ok(result.reply.includes('briefing'));
});

test('o prompt cinematográfico combina descrição e controles na ordem fixa', () => {
  const prompt = buildCinematicPrompt('Uma detetive atravessa o corredor', {
    framing: 'close',
    movement: 'dolly-in',
    lighting: 'neon',
    aspect: '21:9',
  });

  assert.ok(prompt.startsWith('Uma detetive atravessa o corredor.'));
  const posClose = prompt.indexOf('Close no rosto');
  const posDolly = prompt.indexOf('dolly in');
  const posNeon = prompt.indexOf('neon noturno');
  const posAspect = prompt.indexOf('21:9');
  assert.ok(posClose < posDolly && posDolly < posNeon && posNeon < posAspect);
});

test('o prompt é determinístico e ignora controles não especificados', () => {
  const controls = { framing: 'close', movement: '', lens: '' };
  assert.equal(
    buildCinematicPrompt('Cena', controls),
    buildCinematicPrompt('Cena', controls),
  );
  assert.equal(buildCinematicPrompt('Cena', controls), 'Cena. Close no rosto.');
});

test('sem descrição e sem controles o prompt é vazio', () => {
  assert.equal(buildCinematicPrompt('', {}), '');
  assert.equal(buildCinematicPrompt('', { framing: 'close' }), 'Close no rosto.');
});

test('os nove controles exigidos existem e têm opções', () => {
  const chaves = CINEMA_CONTROLS.map((c) => c.key);
  ['camera', 'lens', 'focal', 'aperture', 'movement', 'lighting', 'framing', 'style', 'aspect']
    .forEach((chave) => assert.ok(chaves.includes(chave), `faltou o controle ${chave}`));

  CINEMA_CONTROLS.forEach((control) => {
    assert.ok(control.options.length > 1, control.key);
    assert.equal(control.options[0].value, '', `${control.key} precisa da opção neutra`);
  });

  assert.equal(fragmentFor('inexistente', 'x'), '');
});
