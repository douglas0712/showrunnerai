// PASSO 9 — Job Autonomy.
//
// O defeito que estes testes trancam: uma geração só progredia enquanto alguém
// consultava, e esse alguém era o modelo. Como o turno do modelo acaba quando
// ele termina de falar, o trabalho parava no meio e só voltava a andar quando o
// usuário escrevia "e aí?". Quem consulta agora é o Showrunner, sozinho, depois
// que o turno acabou.
//
// Tudo aqui é determinístico. A consulta é roteirizada, o relógio é injetado, e
// a espera entre consultas é um FREIO: o laço dá uma consulta e para, até o
// teste soltar. É isso que permite olhar para o meio de uma geração — que é
// onde moram os casos interessantes — sem relógio de parede, sem GPU, sem rede
// e sem o runtime de raciocínio.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { createAsset } from '../lib/server/domain/assets.js';
import {
  appendMessageRecord, createThreadRecord, listMessageAssets,
} from '../lib/server/agent/threads.js';
import {
  criarRegistroDeAcompanhamento, estadoDeProducao, limiteConfigurado,
  LIMITE_PADRAO_MS, PRODUCAO, producaoTerminou, RETENCAO_MS,
} from '../lib/server/agent/tools/jobWatch.js';
import { generateImageTool } from '../lib/server/agent/tools/handlers/generateImage.js';
import { generateVideoTool } from '../lib/server/agent/tools/handlers/generateVideo.js';
import { getJobTool } from '../lib/server/agent/tools/handlers/getJob.js';
import { createToolRegistry, setToolRegistry } from '../lib/server/agent/tools/registry.js';
import { defineTool } from '../lib/server/agent/tools/schema.js';
import { createThread, getThread, sendMessage } from '../lib/server/agent/gateway.js';
import { handleGetThread } from '../lib/server/agent/httpApi.js';
import { labelForProduction, producaoEmCurso } from '../lib/agentClient.js';

const INSTANTE = 1_700_000_000_000;

/** Deixa o laço do acompanhamento correr o que já pode correr. */
const tique = () => new Promise((resolver) => { setImmediate(resolver); });

// ── o cenário ───────────────────────────────────────────────────────────────

/**
 * A consulta de job, roteirizada.
 *
 * Cada jobId tem uma sequência de respostas; a última se repete. O roteiro é
 * lido na hora da chamada, e não na construção, para que um teste possa
 * escrevê-lo depois de criar o Asset a que ele se refere.
 */
function consultaRoteirizada(roteiro) {
  const vezes = new Map();
  const chamadas = [];

  const consultar = async (jobId, { projectId } = {}) => {
    chamadas.push({ jobId, projectId });
    const passos = roteiro[jobId];
    if (!passos) throw new Error(`Job desconhecido: "${jobId}".`);

    const i = vezes.get(jobId) ?? 0;
    vezes.set(jobId, i + 1);
    const passo = passos[Math.min(i, passos.length - 1)];

    if (passo instanceof Error) throw passo;
    return { jobId, kind: 'image', error: null, assetId: null, ...passo };
  };

  consultar.chamadas = chamadas;
  return consultar;
}

/**
 * O freio entre consultas.
 *
 * Enquanto está puxado, o laço para depois de cada consulta. Solto, ele corre
 * até o fim cedendo o controle a cada volta — nunca em laço apertado, que
 * travaria o processo do teste.
 */
function criarFreio() {
  const pendentes = [];
  let solto = false;

  return {
    esperar: () => (solto
      ? tique()
      : new Promise((resolver) => { pendentes.push(resolver); })),
    soltar() {
      solto = true;
      while (pendentes.length) pendentes.shift()();
    },
  };
}

function ambiente({ agora = () => INSTANTE, ...opcoes } = {}) {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_a', name: 'Projeto A' }, db);
  createProject({ id: 'proj_b', name: 'Projeto B' }, db);

  const roteiro = {};
  const consultar = consultaRoteirizada(roteiro);
  const freio = criarFreio();

  // O descarte do registro é agendado, não imediato — a tela precisa de uma
  // janela para mostrar o desfecho. Aqui ele é COLETADO em vez de agendado,
  // para que o teste diga quando o relógio "chega".
  const descartes = [];

  const registro = criarRegistroDeAcompanhamento({
    consultar,
    esperar: freio.esperar,
    agendar: (fn, ms) => { descartes.push({ fn, ms }); return null; },
    agora,
    ...opcoes,
  });

  const descartar = () => { while (descartes.length) descartes.shift().fn(); };

  return { db, registro, consultar, roteiro, soltar: freio.soltar, descartes, descartar };
}

const gerando = () => ({ status: 'gerando' });
const salvando = () => ({ status: 'salvando' });
const concluido = (assetId) => ({ status: 'concluido', assetId });
const falhou = () => ({ status: 'falhou', error: 'a execução falhou' });

/** Um Asset já publicado, para o roteiro poder concluir num id real. */
function assetPronto(db, { projectId = 'proj_a', kind = 'image', jobId = null } = {}) {
  // O nome sai do jobId porque é assim que o pipeline real publica: um arquivo
  // por job. Dois Assets com o mesmo nome no mesmo projeto seriam o mesmo
  // arquivo registrado duas vezes, e o domínio recusa isso.
  const nome = `${jobId || 'sem-job'}.${kind === 'video' ? 'mp4' : 'png'}`;
  return createAsset({
    projectId,
    kind,
    jobId,
    filename: nome,
    url: `/api/media/${kind}/${nome}`,
    mimeType: kind === 'video' ? 'video/mp4' : 'image/png',
  }, db);
}

const contexto = (threadId, projectId = 'proj_a') => ({ threadId, projectId, signal: null });

const acompanharCom = (registro, db) => (entrada) => registro.watch(entrada, { db });

// ── A + B · o que é posto para gerar passa a ser acompanhado ────────────────

test('A. og.generate_image registra o acompanhamento sozinho', async () => {
  const pedidos = [];

  const resultado = await generateImageTool.execute(
    contexto('thread_1'),
    { prompt: 'um dragão vermelho' },
    {
      iniciar: async () => ({ jobId: 'job_img', kind: 'image', status: 'gerando' }),
      acompanhar: (entrada) => { pedidos.push(entrada); return null; },
    },
  );

  assert.equal(resultado.jobId, 'job_img');
  // O contexto vem do SERVIDOR: o modelo forneceu o prompt e nada mais.
  assert.deepEqual(pedidos, [{
    jobId: 'job_img', kind: 'image', threadId: 'thread_1', projectId: 'proj_a',
  }]);
});

test('B. og.generate_video registra o acompanhamento sozinho', async () => {
  const db = openDatabase(':memory:');
  const pedidos = [];

  const resultado = await generateVideoTool.execute(
    contexto('thread_1'),
    { prompt: 'a cidade ao pôr do sol' },
    {
      iniciar: async () => ({ jobId: 'job_vid', kind: 'video', status: 'gerando' }),
      acompanhar: (entrada) => { pedidos.push(entrada); return null; },
      abrirBanco: () => db,
    },
  );

  assert.equal(resultado.jobId, 'job_vid');
  assert.deepEqual(pedidos, [{
    jobId: 'job_vid', kind: 'video', threadId: 'thread_1', projectId: 'proj_a',
  }]);

  db.close();
});

test('A+B-bis. as ferramentas devolvem sem esperar a mídia ficar pronta', async () => {
  // Uma geração pode levar minutos. Se a ferramenta esperasse, o turno da
  // conversa ficaria preso junto com ela — que é o que este passo desfaz.
  let terminou = false;

  const resultado = await generateImageTool.execute(
    contexto('thread_1'),
    { prompt: 'x' },
    {
      iniciar: async () => ({ jobId: 'job_x', kind: 'image', status: 'gerando' }),
      acompanhar: () => {
        // O acompanhamento existe; a mídia não.
        setImmediate(() => { terminou = true; });
        return null;
      },
    },
  );

  assert.equal(resultado.status, 'gerando');
  assert.equal(terminou, false, 'a ferramenta esperou o trabalho acabar');
});

// ── D + Q · o trabalho anda sem modelo e sem navegador ─────────────────────

test('D. o job avança até o fim sem nova mensagem e sem ninguém consultar de fora', async () => {
  const { db, registro, consultar, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [gerando(), gerando(), salvando(), concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  soltar();
  await marca.pronto;

  // Ninguém pediu nada: nem o modelo chamou a ferramenta de status, nem a tela
  // consultou. O trabalho andou porque o servidor o levou.
  assert.equal(marca.state, PRODUCAO.CONCLUIDO);
  assert.equal(marca.assetId, asset.id);
  assert.equal(consultar.chamadas.length, 4);

  db.close();
});

test('Q. ler a conversa não é o que faz o trabalho andar', async () => {
  const { db, registro, consultar, roteiro } = ambiente();
  roteiro.job_1 = [gerando(), gerando(), falhou()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  await tique();
  const antes = consultar.chamadas.length;

  // A tela pergunta cinco vezes. Nenhuma dessas leituras consulta o gerador.
  for (let i = 0; i < 5; i += 1) {
    registro.production(thread.id);
    getThread(thread.id, { db, watchRegistry: registro });
  }
  await tique();

  assert.equal(consultar.chamadas.length, antes, 'a leitura da tela consultou o gerador');

  db.close();
});

test('P. o acompanhamento não depende de a ferramenta de status ser chamada', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [gerando(), concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  soltar();
  await marca.pronto;

  // `og.get_job` continua existindo — e não foi chamada uma única vez.
  assert.equal(marca.state, PRODUCAO.CONCLUIDO);
  assert.match(getJobTool.description, /não é preciso chamar esta ferramenta em/i);

  db.close();
});

// ── E + F · single-flight, e independência entre jobs ──────────────────────

test('E. o mesmo job nunca ganha dois laços', async () => {
  const { db, registro, roteiro } = ambiente();
  roteiro.job_1 = [gerando(), gerando(), falhou()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const alvo = { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' };

  const primeiro = registro.watch(alvo, { db });
  const segundo = registro.watch(alvo, { db });

  assert.equal(segundo, primeiro, 'observar de novo devolve o acompanhamento que já existe');
  assert.equal(registro.size(), 1);
  assert.equal(segundo.pronto, primeiro.pronto, 'nasceu um segundo laço sobre o mesmo job');

  db.close();
});

test('F. jobs diferentes são acompanhados de forma independente', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const daImagem = assetPronto(db, { jobId: 'job_a' });
  const doVideo = assetPronto(db, { kind: 'video', jobId: 'job_b' });
  roteiro.job_a = [concluido(daImagem.id)];
  roteiro.job_b = [gerando(), gerando(), gerando(), concluido(doVideo.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const a = registro.watch({ jobId: 'job_a', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db });
  const b = registro.watch({ jobId: 'job_b', kind: 'video', threadId: thread.id, projectId: 'proj_a' }, { db });

  assert.equal(registro.size(), 2);
  assert.notEqual(a.id, b.id);

  soltar();
  await Promise.all([a.pronto, b.pronto]);

  // Um não esperou pelo outro, e não precisaram terminar na mesma ordem.
  assert.equal(a.state, PRODUCAO.CONCLUIDO);
  assert.equal(b.state, PRODUCAO.CONCLUIDO);
  assert.equal(a.assetId, daImagem.id);
  assert.equal(b.assetId, doVideo.id);

  db.close();
});

// ── G · estado intermediário não cria nada ──────────────────────────────────

test('G. estado intermediário não vira Asset nem conclui o acompanhamento', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [salvando(), salvando(), concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);

  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });

  await tique();

  // "salvando" é intermediário: o arquivo ainda não foi publicado, e um Asset
  // criado aqui apontaria para algo que pode não existir.
  assert.equal(marca.state, PRODUCAO.FINALIZANDO);
  assert.equal(marca.assetId, null);
  assert.equal(listMessageAssets(mensagem.id, db).length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n, 0);

  soltar();
  await marca.pronto;
  assert.equal(marca.state, PRODUCAO.CONCLUIDO);

  db.close();
});

test('G-bis. o estado público não repete o vocabulário do gerador', () => {
  assert.equal(estadoDeProducao('preparando'), PRODUCAO.GERANDO);
  assert.equal(estadoDeProducao('enviado'), PRODUCAO.GERANDO);
  assert.equal(estadoDeProducao('na-fila'), PRODUCAO.GERANDO);
  assert.equal(estadoDeProducao('decodificando'), PRODUCAO.GERANDO);
  assert.equal(estadoDeProducao('salvando'), PRODUCAO.FINALIZANDO);
  assert.equal(estadoDeProducao('concluido'), PRODUCAO.CONCLUIDO);
  assert.equal(estadoDeProducao('falhou'), PRODUCAO.FALHOU);
  assert.equal(estadoDeProducao('cancelado'), PRODUCAO.FALHOU);
});

// ── H + I · o Asset nasce e vai parar na mensagem certa ─────────────────────

test('H+I. ao concluir, o Asset é ligado à mensagem do turno que o pediu', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [gerando(), concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);

  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });

  soltar();
  await marca.pronto;

  assert.deepEqual(listMessageAssets(mensagem.id, db).map((m) => m.assetId), [asset.id]);

  db.close();
});

test('H-bis. o trabalho que termina ANTES do turno também chega à mensagem', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  soltar();
  await marca.pronto;

  // O trabalho acabou e ainda não havia mensagem nenhuma para ligá-lo. O turno
  // grava a dele depois, e a amarração acontece nesse momento.
  assert.equal(marca.state, PRODUCAO.CONCLUIDO);
  assert.equal(marca.messageId, null);

  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Pronto.',
  }, db);
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });

  assert.deepEqual(listMessageAssets(mensagem.id, db).map((m) => m.assetId), [asset.id]);

  db.close();
});

// ── J · outra mensagem durante o trabalho não rouba o resultado ─────────────

test('J. uma fala nova no meio da geração não rouba o Asset da mensagem certa', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [gerando(), gerando(), concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  const daGeracao = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);
  registro.bind(thread.id, daGeracao.id, ['job_1'], { db });

  // O usuário fala de novo enquanto a imagem renderiza, e o Showrunner responde
  // outra coisa. Essa segunda resposta não começou geração nenhuma.
  appendMessageRecord({ threadId: thread.id, role: 'user', content: 'e a trilha?' }, db);
  const depois = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Podemos pensar numa trilha.',
  }, db);
  registro.bind(thread.id, depois.id, [], { db });

  soltar();
  await marca.pronto;

  assert.deepEqual(listMessageAssets(daGeracao.id, db).map((m) => m.assetId), [asset.id]);
  assert.deepEqual(listMessageAssets(depois.id, db), [], 'a última mensagem herdou o resultado');

  db.close();
});

// ── K · "Nova conversa" não move nem cancela o trabalho antigo ──────────────

test('K. nova conversa: o trabalho antigo continua e termina na conversa antiga', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [gerando(), gerando(), concluido(asset.id)];

  const antiga = createThreadRecord({ projectId: 'proj_a' }, db);
  const nova = createThreadRecord({ projectId: 'proj_a' }, db);
  const mensagem = appendMessageRecord({
    threadId: antiga.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);

  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: antiga.id, projectId: 'proj_a' }, { db },
  );
  registro.bind(antiga.id, mensagem.id, ['job_1'], { db });

  // A conversa nova não vê o trabalho da antiga; a antiga continua vendo.
  assert.equal(registro.production(nova.id).length, 0);
  assert.equal(registro.production(antiga.id).length, 1);

  soltar();
  await marca.pronto;

  // O trabalho não foi cancelado nem mudou de lugar.
  assert.equal(marca.state, PRODUCAO.CONCLUIDO);
  assert.equal(marca.threadId, antiga.id);
  assert.deepEqual(listMessageAssets(mensagem.id, db).map((m) => m.assetId), [asset.id]);
  assert.equal(registro.production(nova.id).length, 0);

  db.close();
});

// ── N · falha ───────────────────────────────────────────────────────────────

test('N. geração que falha para o acompanhamento e não cria Asset', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  roteiro.job_1 = [gerando(), falhou()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);

  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });

  soltar();
  await marca.pronto;

  assert.equal(marca.state, PRODUCAO.FALHOU);
  assert.equal(marca.assetId, null);
  assert.deepEqual(listMessageAssets(mensagem.id, db), []);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);

  db.close();
});

test('N-bis. consulta que quebra encerra o acompanhamento em vez de repetir o erro', async () => {
  const { db, registro, consultar, roteiro, soltar } = ambiente();
  roteiro.job_1 = [gerando(), new Error('Job não encontrado: "job_1".')];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  soltar();
  await marca.pronto;

  assert.equal(marca.state, PRODUCAO.FALHOU);
  assert.equal(consultar.chamadas.length, 2, 'insistiu num erro que não se resolve consultando');

  db.close();
});

test('N-ter. a falha que chega à tela é uma frase, sem causa técnica', () => {
  const frase = labelForProduction({ id: 'w', kind: 'image', state: 'falhou' });
  assert.equal(frase, 'Não consegui concluir esta geração.');
  for (const proibido of [/job/i, /comfy/i, /sqlite/i, /\//]) {
    assert.ok(!proibido.test(frase), `a frase de falha cita ${proibido}`);
  }
});

// ── O · cancelar o turno não cancela a geração ──────────────────────────────

test('O. a geração já aceita continua depois de o turno ser interrompido', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [gerando(), gerando(), concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const controlador = new AbortController();

  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  // O usuário aperta "Parar": o TURNO é interrompido. O trabalho já aceito não.
  controlador.abort();
  soltar();
  await marca.pronto;

  assert.equal(marca.state, PRODUCAO.CONCLUIDO);

  db.close();
});

test('O-bis. nada no acompanhamento pede o cancelamento do gerador', async () => {
  const fonte = await readFile(
    fileURLToPath(new URL('../lib/server/agent/tools/jobWatch.js', import.meta.url)),
    'utf8',
  );
  // Comentários fora: a explicação PRECISA poder dizer o que não fazemos, e por
  // quê — o cancelamento do gerador é global nesta instalação, então cancelar
  // uma geração pediria interromper as outras.
  const codigo = fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((linha) => linha.replace(/\/\/.*$/, '')).join('\n');

  for (const proibido of [/interrupt/i, /cancelJob/, /\bcancelar\b/i, /abort/i]) {
    assert.ok(!proibido.test(codigo), `o acompanhamento cita ${proibido}`);
  }
});

// ── L · recarregar não duplica nada ─────────────────────────────────────────

test('L. recarregar durante a produção não cria um segundo acompanhamento', async () => {
  const { db, registro, roteiro } = ambiente();
  roteiro.job_1 = [gerando(), gerando(), falhou()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  // Um F5 é exatamente isto: abrir a conversa de novo pela API.
  for (let i = 0; i < 3; i += 1) {
    const r = handleGetThread(thread.id, { db, watchRegistry: registro });
    assert.equal(r.status, 200);
    assert.equal(r.body.production.length, 1);
  }

  assert.equal(registro.size(), 1);

  db.close();
});

// ── M + R · o que a interface recebe ────────────────────────────────────────

test('M. a conversa expõe o que está em produção, e depois a mídia', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [gerando(), concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);

  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });

  const emAndamento = handleGetThread(thread.id, { db, watchRegistry: registro }).body;
  assert.deepEqual(emAndamento.production.map((p) => p.state), ['gerando']);
  assert.ok(producaoEmCurso(emAndamento.production));
  assert.equal(emAndamento.messages[0].assets.length, 0);

  soltar();
  await marca.pronto;

  const pronta = handleGetThread(thread.id, { db, watchRegistry: registro }).body;
  assert.deepEqual(pronta.production.map((p) => p.state), ['concluido']);
  assert.ok(!producaoEmCurso(pronta.production));
  assert.deepEqual(pronta.messages[0].assets.map((a) => a.assetId), [asset.id]);
  // Concluída, ela não fala mais: o resultado já está na conversa.
  assert.equal(labelForProduction(pronta.production[0]), null);

  db.close();
});

test('R. nenhum identificador de trabalho nem estado interno chega à interface', async () => {
  const { db, registro, roteiro } = ambiente();
  roteiro.job_segredo = [gerando(), gerando(), falhou()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  registro.watch(
    { jobId: 'job_segredo', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  const corpo = handleGetThread(thread.id, { db, watchRegistry: registro }).body;

  assert.deepEqual(Object.keys(corpo.production[0]).sort(), ['id', 'kind', 'state']);

  const texto = JSON.stringify(corpo.production);
  assert.ok(!texto.includes('job_segredo'), 'o identificador do trabalho vazou');
  for (const proibido of ['jobId', 'promptId', 'salvando', 'na-fila', 'runtime', 'hermes']) {
    assert.ok(!texto.includes(proibido), `a produção expõe "${proibido}"`);
  }

  // E o rótulo que a tela monta fala de produção, não de mecanismo.
  assert.equal(labelForProduction(corpo.production[0]), 'Gerando imagem…');
  assert.equal(
    labelForProduction({ id: 'w', kind: 'video', state: 'finalizando' }),
    'Finalizando o vídeo…',
  );

  db.close();
});

// ── S · deduplicação por asset ──────────────────────────────────────────────

test('S. o mesmo Asset não entra duas vezes na mesma mensagem', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Pronto.',
  }, db);

  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  soltar();
  await marca.pronto;

  // A amarração acontece uma vez, e insistir nela não duplica.
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });

  assert.deepEqual(listMessageAssets(mensagem.id, db).map((m) => m.assetId), [asset.id]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n, 1);

  db.close();
});

// ── T · propriedade ─────────────────────────────────────────────────────────

test('T. o acompanhamento carrega o projeto do servidor e não cruza conversas', async () => {
  const { db, registro, consultar, roteiro } = ambiente();
  roteiro.job_a = [gerando(), gerando(), falhou()];
  roteiro.job_b = [gerando(), gerando(), falhou()];

  const daA = createThreadRecord({ projectId: 'proj_a' }, db);
  const daB = createThreadRecord({ projectId: 'proj_b' }, db);

  registro.watch({ jobId: 'job_a', kind: 'image', threadId: daA.id, projectId: 'proj_a' }, { db });
  registro.watch({ jobId: 'job_b', kind: 'image', threadId: daB.id, projectId: 'proj_b' }, { db });

  await tique();

  // Cada consulta leva o projeto do SEU acompanhamento — é o que a camada de
  // geração confere antes de devolver qualquer coisa sobre um job.
  const porJob = new Map(consultar.chamadas.map((c) => [c.jobId, c.projectId]));
  assert.equal(porJob.get('job_a'), 'proj_a');
  assert.equal(porJob.get('job_b'), 'proj_b');

  assert.equal(registro.production(daA.id).length, 1);
  assert.equal(registro.production(daB.id).length, 1);

  // Uma conversa não pode amarrar a si o trabalho da outra.
  const mensagem = appendMessageRecord({
    threadId: daA.id, role: 'assistant', content: 'oi',
  }, db);
  assert.deepEqual(registro.bind(daA.id, mensagem.id, ['job_b'], { db }), []);
  assert.equal(registro.get('job_b').messageId, null);

  db.close();
});

// ── 8 · o teto do acompanhamento ────────────────────────────────────────────

/** Um relógio que anda sozinho, um passo por leitura. */
function relogioQueAnda(passoMs) {
  let t = INSTANTE;
  return () => { t += passoMs; return t; };
}

test('8. um trabalho longo sobrevive ao teto de silêncio de um turno', async () => {
  const { db, registro, roteiro, soltar } = ambiente({
    agora: relogioQueAnda(10_000),
    limiteMs: 900_000,
  });
  const asset = assetPronto(db, { kind: 'video', jobId: 'job_lento' });
  // Vinte e cinco voltas a dez segundos: mais de duzentos segundos de trabalho,
  // muito além dos 180 s de silêncio que derrubariam um TURNO. São grandezas
  // diferentes, e um vídeo de catorze minutos não pode morrer pelo relógio da
  // conversa.
  roteiro.job_lento = [...Array(25).fill(gerando()), concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_lento', kind: 'video', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  soltar();
  await marca.pronto;

  assert.equal(marca.state, PRODUCAO.CONCLUIDO);
  assert.equal(marca.assetId, asset.id);

  db.close();
});

test('8-bis. mas o acompanhamento também não é infinito', async () => {
  const { db, registro, roteiro, soltar } = ambiente({
    agora: relogioQueAnda(10_000),
    limiteMs: 60_000,
  });
  roteiro.job_eterno = [gerando()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_eterno', kind: 'video', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  soltar();
  await marca.pronto;

  assert.equal(marca.state, PRODUCAO.FALHOU);
  assert.equal(marca.assetId, null);

  db.close();
});

test('8-ter. o teto é configuração de operador, nunca do modelo', () => {
  assert.equal(limiteConfigurado({}), LIMITE_PADRAO_MS);
  assert.equal(limiteConfigurado({ SHOWRUNNER_JOB_WATCH_TIMEOUT_MS: '900000' }), 900_000);
  // Valor sem sentido não vira teto zero — cai no padrão.
  assert.equal(limiteConfigurado({ SHOWRUNNER_JOB_WATCH_TIMEOUT_MS: 'quando der' }), LIMITE_PADRAO_MS);
  assert.equal(limiteConfigurado({ SHOWRUNNER_JOB_WATCH_TIMEOUT_MS: '-1' }), LIMITE_PADRAO_MS);
});

// ── U · a durabilidade não é fingida ────────────────────────────────────────

test('U. reiniciar o processo perde o acompanhamento — e isso não é escondido', async () => {
  const { db, registro, roteiro } = ambiente();
  roteiro.job_1 = [gerando(), gerando(), falhou()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  assert.equal(registro.production(thread.id).length, 1);

  // Um processo novo é um registro novo: o acompanhamento vive em memória,
  // exatamente como o job que ele acompanha. Nada foi gravado no banco a
  // respeito dele — gravar criaria uma linha durável apontando para um trabalho
  // que já não existe, que é durabilidade de fachada.
  const depoisDoReinicio = criarRegistroDeAcompanhamento({ consultar: async () => ({}) });
  assert.equal(depoisDoReinicio.size(), 0);
  assert.equal(depoisDoReinicio.production(thread.id).length, 0);

  const tabelas = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all().map((t) => t.name);
  assert.ok(!tabelas.some((n) => /watch|acompanh/i.test(n)), 'nasceu uma tabela de durabilidade');

  db.close();
});

// ── C + V + W · o turno inteiro, pelo gateway ───────────────────────────────

/** Um runtime que pede uma geração e termina o turno sem esperar por ela. */
function runtimeQuePedeGeracao(texto = 'Vou criar essa imagem.') {
  return {
    id: 'teste',
    isAvailable: () => true,
    unavailableReason: () => null,
    async testConnection() { return { ok: true }; },
    async* run({ invokeTool }) {
      yield { type: 'agent.started', ts: 1 };
      yield { type: 'tool.started', ts: 2, toolCallId: 'c1', name: 'og.generate_image' };
      const resultado = await invokeTool('og.generate_image', { prompt: 'um dragão' });
      yield {
        type: 'tool.completed', ts: 3, toolCallId: 'c1', name: 'og.generate_image', result: resultado,
      };
      yield { type: 'agent.message.completed', ts: 4, text: texto };
      yield { type: 'agent.completed', ts: 5 };
    },
  };
}

test('C+V+W. o turno acaba, o trabalho continua, e o resultado chega na mensagem', async () => {
  const { db, registro, roteiro, soltar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_turno' });
  roteiro.job_turno = [gerando(), gerando(), salvando(), concluido(asset.id)];

  // Uma ferramenta com o nome real, que inicia o trabalho e devolve na hora —
  // sem esperar a imagem, que é justamente o ponto.
  setToolRegistry(createToolRegistry([defineTool({
    name: 'og.generate_image',
    description: 'gera imagem',
    inputSchema: { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] },
    async execute(ctx) {
      acompanharCom(registro, db)({
        jobId: 'job_turno', kind: 'image', threadId: ctx.threadId, projectId: ctx.projectId,
      });
      return { jobId: 'job_turno', kind: 'image', status: 'gerando' };
    },
  })]));

  const deps = { db, runtime: runtimeQuePedeGeracao(), watchRegistry: registro };
  const thread = createThread({ projectId: 'proj_a' }, deps);

  const turno = await sendMessage(
    { threadId: thread.id, content: 'Crie uma imagem cinematográfica de um dragão.' },
    deps,
  );

  // O turno terminou. A identidade do Showrunner não regrediu (V) e o trabalho
  // ainda está acontecendo — o turno não esperou por ele.
  assert.equal(turno.assistantMessage.content, 'Vou criar essa imagem.');
  assert.ok(!/Recebi:/.test(turno.assistantMessage.content));

  const marca = registro.get('job_turno');
  assert.ok(!producaoTerminou(marca.state), 'o turno esperou a imagem ficar pronta');
  assert.equal(marca.messageId, turno.assistantMessage.id, 'o destino do resultado não foi decidido');
  assert.equal(getThread(thread.id, deps).production.length, 1);

  // "Nova conversa" (W): outra thread no mesmo projeto, sem tocar no trabalho.
  const nova = createThread({ projectId: 'proj_a' }, deps);
  assert.notEqual(nova.id, thread.id);
  assert.equal(getThread(nova.id, deps).production.length, 0);
  assert.equal(getThread(thread.id, deps).messages.length, 2);

  soltar();
  await marca.pronto;

  // E o resultado aparece na mensagem daquele turno, sem ninguém ter falado de
  // novo com o Showrunner — nenhum "e aí?" foi enviado.
  const lida = getThread(thread.id, deps);
  const doAgente = lida.messages.find((m) => m.role === 'assistant');
  assert.deepEqual(doAgente.assets.map((a) => a.assetId), [asset.id]);
  assert.equal(lida.messages.filter((m) => m.role === 'user').length, 1);

  db.close();
});

// ── ciclo de vida do registro ───────────────────────────────────────────────
//
// O defeito que esta seção tranca: o descarte era PREGUIÇOSO — corria só dentro
// de `watch` e de `production`. Uma instalação que gerasse uma imagem e ficasse
// quieta guardava aquele registro para sempre, porque ninguém voltava para
// varrer. O andaime precisa sair sozinho quando a obra acaba.

test('L1. enquanto o trabalho corre, o acompanhamento fica no registro', async () => {
  const { db, registro, roteiro, descartes } = ambiente();
  roteiro.job_1 = [gerando(), gerando(), falhou()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  await tique();

  assert.equal(registro.size(), 1);
  assert.equal(registro.get('job_1'), marca);
  assert.ok(!producaoTerminou(marca.state));
  // Nada de saída marcada enquanto há trabalho: sair daqui é o fim, não uma
  // fase.
  assert.equal(descartes.length, 0);

  db.close();
});

test('L2. concluído sai do registro depois da janela — e a janela é curta', async () => {
  const { db, registro, roteiro, soltar, descartes, descartar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [gerando(), concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);

  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });

  soltar();
  await marca.pronto;

  // A saída é agendada NA HORA em que o trabalho termina, e por uma janela
  // curta e fechada — não é cache.
  assert.equal(descartes.length, 1);
  assert.equal(descartes[0].ms, RETENCAO_MS);
  assert.equal(registro.size(), 1, 'sumiu antes de a tela poder mostrar o desfecho');

  descartar();

  assert.equal(registro.size(), 0);
  assert.equal(registro.get('job_1'), null);
  assert.deepEqual(registro.production(thread.id), []);

  db.close();
});

test('L3. falhou sai do registro pela mesma porta', async () => {
  const { db, registro, roteiro, soltar, descartes, descartar } = ambiente();
  roteiro.job_1 = [gerando(), falhou()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  soltar();
  await marca.pronto;

  assert.equal(marca.state, PRODUCAO.FALHOU);
  assert.equal(descartes.length, 1);
  descartar();
  assert.equal(registro.size(), 0);

  db.close();
});

test('L4. teto estourado também sai, e não declara o job cancelado', async () => {
  const { db, registro, roteiro, soltar, descartes, descartar } = ambiente({
    agora: relogioQueAnda(10_000),
    limiteMs: 60_000,
  });
  roteiro.job_eterno = [gerando()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_eterno', kind: 'video', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  soltar();
  await marca.pronto;

  // O acompanhamento parou. O job não foi tocado: nenhum Asset falso nasceu, e
  // nada foi pedido ao gerador — o que acabou foi a nossa vigília.
  assert.equal(marca.state, PRODUCAO.FALHOU);
  assert.equal(marca.assetId, null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 0);

  assert.equal(descartes.length, 1);
  descartar();
  assert.equal(registro.size(), 0, 'o registro do teto estourado vazou');

  db.close();
});

test('L5. exceção inesperada assenta, fica registrada, e sai', async () => {
  // Uma consulta que devolve lixo em vez de um resultado: o laço não trata
  // isso, e é justamente esse o caso que não pode deixar um registro mudo
  // ocupando o lugar do jobId para sempre.
  const { db, registro, descartes, descartar } = ambiente({
    consultar: async () => null,
  });

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  await marca.pronto;

  assert.equal(marca.state, PRODUCAO.FALHOU);
  assert.equal(descartes.length, 1);
  descartar();
  assert.equal(registro.size(), 0);

  db.close();
});

test('L5-bis. exceção DEPOIS de o trabalho terminar não desfaz o desfecho, e sai', async () => {
  // Ligar o Asset à mensagem quebra — falha real de banco. O trabalho concluiu
  // de verdade e continua concluído; o que não pode acontecer é o registro
  // ficar preso porque o desfecho já tinha sido assentado.
  const { db, registro, roteiro, soltar, descartes, descartar } = ambiente({
    vincular: () => { throw new Error('banco fora do ar'); },
  });
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);

  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });

  soltar();
  await marca.pronto;

  assert.equal(marca.state, PRODUCAO.CONCLUIDO, 'o desfecho real foi desfeito por uma falha posterior');
  assert.ok(descartes.length >= 1);
  descartar();
  assert.equal(registro.size(), 0);

  db.close();
});

test('L6. o single-flight vale enquanto o acompanhamento está ativo', async () => {
  const { db, registro, roteiro, consultar } = ambiente();
  roteiro.job_1 = [gerando(), gerando(), falhou()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const alvo = { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' };

  const primeiro = registro.watch(alvo, { db });
  await tique();
  const durante = registro.watch(alvo, { db });

  assert.equal(durante, primeiro);
  assert.equal(durante.pronto, primeiro.pronto);
  assert.equal(registro.size(), 1);
  // E o segundo pedido não somou consultas: não há dois laços sobre o job.
  const depoisDeDuas = consultar.chamadas.length;
  await tique();
  assert.ok(consultar.chamadas.length - depoisDeDuas <= 1);

  db.close();
});

test('L7. um watch atrasado, depois do descarte, não duplica Asset nem vínculo', async () => {
  const { db, registro, roteiro, soltar, descartar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);

  const primeiro = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });

  soltar();
  await primeiro.pronto;
  descartar();
  assert.equal(registro.size(), 0);

  // A chamada atrasada chega depois de o registro já ter saído. Ela começa
  // OUTRO acompanhamento — e isso é inofensivo, porque a defesa do resultado
  // não é este arquivo: o job já é terminal e o Asset daquele job já existe,
  // então reconfirmar devolve o mesmo, nunca outro.
  const atrasado = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  assert.notEqual(atrasado, primeiro);

  await atrasado.pronto;

  assert.equal(atrasado.state, PRODUCAO.CONCLUIDO);
  assert.equal(atrasado.assetId, asset.id, 'o acompanhamento atrasado inventou outro Asset');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n, 1);
  assert.deepEqual(listMessageAssets(mensagem.id, db).map((m) => m.assetId), [asset.id]);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_message_assets').get().n, 1);

  descartar();
  assert.equal(registro.size(), 0);

  db.close();
});

test('L8. o descarte acontece sozinho, sem ninguém ler nem gerar de novo', async () => {
  // Sem `agendar` injetado: o relógio de verdade. É o caso que estava quebrado
  // — antes, um registro terminal só saía se alguém voltasse a passar por
  // `watch` ou `production`, e uma instalação quieta nunca voltava.
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_a', name: 'Projeto A' }, db);
  const asset = assetPronto(db, { jobId: 'job_1' });

  const roteiro = { job_1: [concluido(asset.id)] };
  const registro = criarRegistroDeAcompanhamento({
    consultar: consultaRoteirizada(roteiro),
    esperar: tique,
    retencaoMs: 5,
  });

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  await marca.pronto;
  assert.equal(registro.size(), 1);

  await new Promise((r) => { setTimeout(r, 40); });

  assert.equal(registro.size(), 0, 'o registro terminal ficou no Map indefinidamente');

  db.close();
});

test('L9. production não carrega o jobId real, nem detalhe técnico nenhum', async () => {
  const { db, registro, roteiro } = ambiente();
  roteiro.cinema_abc123_xyz = [gerando(), gerando(), falhou()];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  registro.watch(
    { jobId: 'cinema_abc123_xyz', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );

  const corpo = handleGetThread(thread.id, { db, watchRegistry: registro }).body;
  const item = corpo.production[0];

  // Três campos, e o `id` é um identificador PRÓPRIO do acompanhamento — a
  // interface precisa de uma chave estável para desenhar e deduplicar, e essa
  // chave não tem por que ser o nome do trabalho no gerador.
  assert.deepEqual(Object.keys(item).sort(), ['id', 'kind', 'state']);
  assert.match(item.id, /^watch_/);
  assert.notEqual(item.id, 'cinema_abc123_xyz');
  assert.ok(!JSON.stringify(corpo.production).includes('cinema_abc123_xyz'));

  for (const proibido of [
    'promptId', 'workflow', 'provider', 'comfy', 'na-fila', 'decodificando',
    'salvando', '/api/media', 'runtime/', 'projectId', 'threadId',
  ]) {
    assert.ok(
      !JSON.stringify(corpo.production).toLowerCase().includes(proibido.toLowerCase()),
      `production expõe "${proibido}"`,
    );
  }

  db.close();
});

test('L10. a mídia continua na conversa depois de o acompanhamento sair da memória', async () => {
  const { db, registro, roteiro, soltar, descartar } = ambiente();
  const asset = assetPronto(db, { jobId: 'job_1' });
  roteiro.job_1 = [gerando(), concluido(asset.id)];

  const thread = createThreadRecord({ projectId: 'proj_a' }, db);
  const mensagem = appendMessageRecord({
    threadId: thread.id, role: 'assistant', content: 'Vou criar essa imagem.',
  }, db);

  const marca = registro.watch(
    { jobId: 'job_1', kind: 'image', threadId: thread.id, projectId: 'proj_a' }, { db },
  );
  registro.bind(thread.id, mensagem.id, ['job_1'], { db });

  soltar();
  await marca.pronto;
  descartar();

  assert.equal(registro.size(), 0);

  // O acompanhamento sumiu; o resultado não. Três reloads seguidos continuam
  // trazendo a mesma mídia, uma vez só — porque o que dura é o Asset e o
  // vínculo com a mensagem, no banco, e não o andaime que os produziu.
  for (let i = 0; i < 3; i += 1) {
    const corpo = handleGetThread(thread.id, { db, watchRegistry: registro }).body;
    assert.deepEqual(corpo.production, []);
    assert.deepEqual(
      corpo.messages.flatMap((m) => m.assets.map((a) => a.assetId)),
      [asset.id],
    );
    assert.equal(corpo.messages[0].assets[0].mediaUrl, asset.url);
  }

  db.close();
});
