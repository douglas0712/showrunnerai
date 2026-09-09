// PASSO 10.1 — o vocabulário de estados de uma geração.
//
// O defeito que estes testes trancam: o estado que chegava ao agente e ao
// acompanhamento era o do ComfyUI traduzido para o português — "na-fila",
// "decodificando", "salvando". Parecia vocabulário nosso e não era: nenhum
// outro provider tem "decodificando", que é uma fase de um grafo de nós.
//
// Agora há três camadas, e cada fronteira tem um dono:
//
//   provider  comfy/status.js → STATES              (o executor)
//   domínio   domain/generationJobStates.js          (o Showrunner)
//   produção  agent/tools/jobWatch.js                (a conversa)
//
// A fonte do vocabulário mudou de lugar no PASSO 10.2, quando ele virou coluna:
// `generation/jobStates.js` continua sendo a porta desta camada, mas é
// reexportação. Quem define é o domínio, porque é o banco que grava.
//
// E a passagem entre a primeira e a segunda mora num ADAPTADOR, não no
// vocabulário:
//
//     comfy/status.js  →  comfyJobState.js  →  jobStates.js  →  domain/…
//
// A direção é a metade que importa. Enquanto a tradução morava dentro do
// vocabulário, o domínio conhecia o nome de um executor — e no dia do segundo
// provider ele viraria uma lista de `fromIssoState`, `fromAquiloState`.
//
// Estes testes protegem o vocabulário, o adaptador, e a direção entre eles.

import test from 'node:test';
import assert from 'node:assert/strict';

import { STATES, TERMINAL_STATES } from '../lib/server/comfy/status.js';
import {
  assertJobState, GenerationStateError, isJobState, isTerminalJobState,
  JOB_STATES, JOB_STATE_VALUES, TERMINAL_JOB_STATES,
} from '../lib/server/generation/jobStates.js';
import {
  fromComfyState, translatedProviderStates,
} from '../lib/server/generation/comfyJobState.js';
import { estadoDeProducao, PRODUCAO } from '../lib/server/agent/tools/jobWatch.js';
import { getJobTool } from '../lib/server/agent/tools/handlers/getJob.js';

// ── A · a tradução, estado por estado ───────────────────────────────────────

test('A. todo estado do executor tem tradução, e é a esperada', () => {
  assert.equal(fromComfyState(STATES.PREPARING), JOB_STATES.PREPARING);
  assert.equal(fromComfyState(STATES.SUBMITTED), JOB_STATES.SUBMITTED);
  assert.equal(fromComfyState(STATES.QUEUED), JOB_STATES.QUEUED);
  assert.equal(fromComfyState(STATES.GENERATING), JOB_STATES.RUNNING);
  assert.equal(fromComfyState(STATES.DECODING), JOB_STATES.RUNNING);
  assert.equal(fromComfyState(STATES.SAVING), JOB_STATES.FINALIZING);
  assert.equal(fromComfyState(STATES.DONE), JOB_STATES.DONE);
  assert.equal(fromComfyState(STATES.FAILED), JOB_STATES.FAILED);
  assert.equal(fromComfyState(STATES.CANCELLED), JOB_STATES.CANCELLED);
});

test('A-bis. a tabela é EXAUSTIVA sobre o vocabulário do executor', () => {
  // É este teste que faz um estado novo do ComfyUI aparecer como buraco em vez
  // de como silêncio. A tabela é montada a partir de `STATES`, não de literais.
  const doExecutor = Object.values(STATES);
  assert.deepEqual(translatedProviderStates().sort(), [...doExecutor].sort());

  for (const estado of doExecutor) {
    assert.ok(isJobState(fromComfyState(estado)), `${estado} traduziu para algo fora do domínio`);
  }
});

// ── B · C · os colapsos que importam ────────────────────────────────────────

test('B. gerando e decodificando colapsam no MESMO estado', () => {
  assert.equal(fromComfyState(STATES.GENERATING), fromComfyState(STATES.DECODING));
  assert.equal(fromComfyState(STATES.GENERATING), JOB_STATES.RUNNING);
  // A diferença entre eles é a fase de um grafo — informação do executor.
  assert.ok(!JOB_STATE_VALUES.includes('decoding'));
});

test('C. salvando vira finalizing, e é a única fase intermediária distinta', () => {
  assert.equal(fromComfyState(STATES.SAVING), JOB_STATES.FINALIZING);
  const intermediarios = [STATES.PREPARING, STATES.SUBMITTED, STATES.QUEUED, STATES.GENERATING, STATES.DECODING]
    .map(fromComfyState);
  assert.ok(!intermediarios.includes(JOB_STATES.FINALIZING));
});

test('D+E+F. os desfechos do executor traduzem um a um', () => {
  assert.equal(fromComfyState(STATES.DONE), JOB_STATES.DONE);
  assert.equal(fromComfyState(STATES.FAILED), JOB_STATES.FAILED);
  assert.equal(fromComfyState(STATES.CANCELLED), JOB_STATES.CANCELLED);
});

// ── G · ORPHANED é do domínio, não do provider ──────────────────────────────

test('G. orphaned é estado de domínio válido e nenhum provider o produz', () => {
  assert.ok(isJobState(JOB_STATES.ORPHANED));
  assert.equal(assertJobState(JOB_STATES.ORPHANED), 'orphaned');

  // Nenhuma tradução do executor chega nele: é conclusão nossa, e só a
  // reconciliação de um reinício poderá escrevê-la.
  for (const estado of Object.values(STATES)) {
    assert.notEqual(fromComfyState(estado), JOB_STATES.ORPHANED);
  }
  assert.ok(!translatedProviderStates().includes('orphaned'));
});

// ── H · estado desconhecido ─────────────────────────────────────────────────

test('H. estado do executor sem tradução falha alto, e não inventa nada', () => {
  for (const desconhecido of ['decodificando-2', 'PENDING', '', null, undefined, 42, {}]) {
    assert.throws(
      () => fromComfyState(desconhecido),
      (erro) => {
        assert.equal(erro.name, 'GenerationStateError');
        assert.ok(erro instanceof GenerationStateError);
        return true;
      },
      `"${String(desconhecido)}" deveria falhar`,
    );
  }
});

test('H-bis. e falhar é seguro porque STATES é constante NOSSA', () => {
  // O valor de `job.state` só é escrito pelo provider, sempre a partir de
  // `STATES`. Um valor fora da tabela não é um ComfyUI diferente: é defeito
  // nosso — e a resposta a um defeito é aparecer, não ser absorvido.
  assert.throws(() => assertJobState('gerando'), /Estado de geração desconhecido/);
  assert.throws(() => assertJobState('na-fila'), /Estado de geração desconhecido/);
  assert.equal(isJobState('salvando'), false);
});

// ── L · terminais ───────────────────────────────────────────────────────────

test('L. done, failed, cancelled e orphaned são terminais — e mais nenhum', () => {
  assert.deepEqual([...TERMINAL_JOB_STATES].sort(), ['cancelled', 'done', 'failed', 'orphaned']);

  for (const estado of TERMINAL_JOB_STATES) assert.ok(isTerminalJobState(estado));
  for (const estado of [JOB_STATES.PREPARING, JOB_STATES.SUBMITTED, JOB_STATES.QUEUED,
    JOB_STATES.RUNNING, JOB_STATES.FINALIZING]) {
    assert.ok(!isTerminalJobState(estado), `${estado} não deveria ser terminal`);
  }

  // Um estado desconhecido NÃO é terminal: ele é um defeito, e tratá-lo como
  // desfecho encerraria um acompanhamento sobre uma premissa quebrada.
  assert.equal(isTerminalJobState('gerando'), false);
  assert.equal(isTerminalJobState(undefined), false);
});

test('L-bis. terminal de domínio e terminal de provider dizem coisas diferentes', () => {
  // O do provider tem três: são os desfechos que o EXECUTOR conhece, e é essa a
  // lista que decide se vale a pena consultá-lo de novo.
  assert.equal(TERMINAL_STATES.length, 3);
  assert.equal(TERMINAL_JOB_STATES.length, 4);

  const doProviderNoDominio = TERMINAL_STATES.map(fromComfyState).sort();
  assert.deepEqual(doProviderNoDominio, ['cancelled', 'done', 'failed']);
  // A diferença é exatamente `orphaned`: o executor nunca dirá que perdeu um
  // trabalho — para ele, o trabalho ou existe ou nunca existiu.
  assert.ok(!doProviderNoDominio.includes(JOB_STATES.ORPHANED));
});

// ── o vocabulário é fechado e provider-neutro ───────────────────────────────

test('o vocabulário é fechado, congelado e não nomeia provider nenhum', () => {
  assert.deepEqual([...JOB_STATE_VALUES].sort(), [
    'cancelled', 'done', 'failed', 'finalizing', 'orphaned',
    'preparing', 'queued', 'running', 'submitted',
  ]);
  assert.ok(Object.isFrozen(JOB_STATES));
  assert.ok(Object.isFrozen(JOB_STATE_VALUES));
  assert.ok(Object.isFrozen(TERMINAL_JOB_STATES));

  const texto = JSON.stringify(JOB_STATE_VALUES).toLowerCase();
  for (const provider of ['comfy', 'minimax', 'ideogram', 'veo', 'kling', 'seedance', 'hermes']) {
    assert.ok(!texto.includes(provider), `o vocabulário cita ${provider}`);
  }
});

// ── M · N · a terceira camada continua simples ──────────────────────────────

test('M. a produção reduz o domínio a quatro palavras', () => {
  const vistos = new Set(JOB_STATE_VALUES.map(estadoDeProducao));
  assert.deepEqual([...vistos].sort(), ['concluido', 'falhou', 'finalizando', 'gerando']);
  assert.deepEqual(
    Object.values(PRODUCAO).sort(),
    ['concluido', 'falhou', 'finalizando', 'gerando'],
  );
});

test('N. nenhum estado de provider nem de domínio chega à camada de produção', () => {
  // A UI recebe as quatro do produto. Nem o vocabulário do executor nem o do
  // domínio aparecem entre elas.
  const daProducao = Object.values(PRODUCAO);
  for (const doExecutor of Object.values(STATES)) {
    if (daProducao.includes(doExecutor)) {
      // "gerando", "concluido" e "falhou" existem nos dois vocabulários por
      // coincidência de palavra — o que não pode existir é a granularidade.
      assert.ok(
        !['na-fila', 'decodificando', 'salvando', 'enviado', 'preparando', 'cancelado'].includes(doExecutor),
        `a produção expõe a granularidade do executor: ${doExecutor}`,
      );
    }
  }
  for (const doDominio of JOB_STATE_VALUES) {
    assert.ok(!daProducao.includes(doDominio), `a produção expõe o domínio: ${doDominio}`);
  }
});

// ── J · a ferramenta não ensina o executor ao modelo ────────────────────────

test('J. og.get_job descreve o vocabulário de domínio, não o do ComfyUI', () => {
  const texto = `${getJobTool.description} ${JSON.stringify(getJobTool.inputSchema)}`.toLowerCase();

  for (const doExecutor of ['na-fila', 'decodificando', 'salvando', 'preparando', 'enviado']) {
    assert.ok(!texto.includes(doExecutor), `a ferramenta ensina "${doExecutor}" ao modelo`);
  }
  for (const doDominio of ['queued', 'running', 'finalizing', 'done', 'failed']) {
    assert.ok(texto.includes(doDominio), `a ferramenta não menciona "${doDominio}"`);
  }
  // E continua sendo a mesma ferramenta, com o mesmo nome e o mesmo argumento.
  assert.equal(getJobTool.name, 'og.get_job');
  assert.deepEqual(getJobTool.inputSchema.required, ['jobId']);
});

// ── a fronteira do arquivo ──────────────────────────────────────────────────

/** O código de um arquivo, sem comentários. */
async function codigoDe(relativo) {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const fonte = await readFile(fileURLToPath(new URL(relativo, import.meta.url)), 'utf8');
  // Comentários fora, pela mesma razão de `agent-architecture.test.mjs`: a
  // explicação PRECISA poder citar o que o código não pode. Proibir a palavra no
  // comentário apagaria a razão junto com o risco.
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((linha) => linha.replace(/\/\/.*$/, '')).join('\n');
}

test('A. o vocabulário não importa NADA — nem o provider, nem o agente', async () => {
  const codigo = await codigoDe('../lib/server/domain/generationJobStates.js');

  const importados = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(importados, [], 'o vocabulário genérico ganhou uma dependência');

  for (const proibido of [/comfy/i, /agent\//, /thread/i, /\btool\b/i, /runtime/i, /jobWatch/]) {
    assert.ok(!proibido.test(codigo), `generationJobStates.js cita ${proibido}`);
  }

  // E a porta da camada de geração é reexportação pura: uma dependência só, e
  // nenhuma constante redeclarada.
  const porta = await codigoDe('../lib/server/generation/jobStates.js');
  assert.deepEqual(
    [...porta.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]),
    ['../domain/generationJobStates.js'],
  );
  assert.ok(!/JOB_STATES\s*=/.test(porta), 'a camada de geração redeclarou o vocabulário');
});

test('B. o vocabulário não nomeia executor nenhum, nem agora nem por engano', async () => {
  const codigo = await codigoDe('../lib/server/domain/generationJobStates.js');

  for (const provider of [
    'comfy', 'veo', 'kling', 'seedance', 'minimax', 'ideogram', 'runway',
    'sora', 'flux', 'replicate', 'fal',
  ]) {
    assert.ok(
      !new RegExp(provider, 'i').test(codigo),
      `generationJobStates.js cita "${provider}" em código`,
    );
  }
});

test('B-bis. o adaptador conhece as DUAS línguas, e só elas', async () => {
  const codigo = await codigoDe('../lib/server/generation/comfyJobState.js');

  const importados = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(importados, ['../comfy/status.js', './jobStates.js']);

  // Um tradutor traduz. Não consulta job, não cria Asset, não conhece conversa.
  for (const proibido of [/agent\//, /thread/i, /createAsset/, /getJob/, /database/, /fetch/]) {
    assert.ok(!proibido.test(codigo), `o adaptador faz mais do que traduzir: ${proibido}`);
  }
});

test('B-ter. a direção é adaptador → vocabulário, nunca o contrário', async () => {
  const vocabulario = await codigoDe('../lib/server/domain/generationJobStates.js');
  const adaptador = await codigoDe('../lib/server/generation/comfyJobState.js');

  assert.ok(adaptador.includes("from './jobStates.js'"), 'o adaptador não aponta para o vocabulário');
  assert.ok(!vocabulario.includes('comfyJobState'), 'o vocabulário aponta para o adaptador');
  assert.ok(!vocabulario.includes('generation/'), 'o domínio aponta para a camada de geração');
  // E acrescentar um provider é acrescentar um arquivo: o vocabulário não tem
  // função nenhuma que nomeie origem.
  assert.ok(!/from[A-Z]\w*State/.test(vocabulario), 'o vocabulário ganhou uma função de tradução');
});
