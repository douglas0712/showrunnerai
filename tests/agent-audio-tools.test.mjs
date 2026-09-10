// As ferramentas de ÁUDIO do agente — narração, efeito e trilha.
//
// PASSO 14-E. Nenhum teste aqui gera um segundo de som: o que se prova é o
// CONTRATO — o que a ferramenta aceita, o que ela devolve, e sobretudo o que
// ela recusa.
//
// O que eles trancam:
//
//   o modelo não escolhe runtime    workflow, provider, seed, caminho, jobId,
//                                   assetId e impressão são RECUSADOS
//   três famílias, três formas      narração pede cena; efeito pede cena e
//                                   número; música não pede cena nenhuma
//   "outra versão" é generate       chamar de novo cria take novo; não há
//                                   ferramenta de regenerar
//   "use a segunda" é takeNumber    nunca Asset, nunca UUID
//   selected ≠ current             a listagem expõe as duas, e é isso que
//                                   permite explicar sem inventar
//   cross-project impossível        projectId vem do CONTEXTO, não dos args
//   erros são de domínio            nada de SQLite, ComfyUI, Piper ou caminho

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

// As ferramentas resolvem o banco pelo `database()` do processo, e não por um
// argumento — é assim que o Agent Gateway as chama. Para isolar o teste, a raiz
// do runtime é trocada ANTES de qualquer módulo do Showrunner ser carregado, e
// por isso os imports abaixo são dinâmicos.
const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-audio-tools-'));
process.env.RUNTIME_ROOT = path.join(RAIZ, 'runtime');
test.after(async () => { await rm(RAIZ, { recursive: true, force: true }); });

const { database } = await import('../lib/server/domain/db.js');
const { createProject } = await import('../lib/server/domain/projects.js');
const { createThreadRecord } = await import('../lib/server/agent/threads.js');
const {
  replaceProductionScenes, saveProductionPlan, saveProductionScript,
} = await import('../lib/server/domain/production.js');
const { publicToolList, registry } = await import('../lib/server/agent/tools/index.js');

const NOMES = {
  narracaoGet: 'project.get_scene_narration',
  narracaoSet: 'project.set_scene_narration',
  narracaoGerar: 'project.generate_scene_narration',
  narracaoTakes: 'project.list_scene_narration_takes',
  narracaoEscolher: 'project.select_scene_narration_take',
  sfxCriar: 'project.create_scene_sfx_cue',
  sfxEditar: 'project.update_scene_sfx_cue',
  sfxListar: 'project.list_scene_sfx_cues',
  sfxRemover: 'project.delete_scene_sfx_cue',
  sfxGerar: 'project.generate_scene_sfx',
  sfxTakes: 'project.list_scene_sfx_takes',
  sfxEscolher: 'project.select_scene_sfx_take',
  musicaCriar: 'project.create_music_cue',
  musicaEditar: 'project.update_music_cue',
  musicaListar: 'project.list_music_cues',
  musicaRemover: 'project.delete_music_cue',
  musicaGerar: 'project.generate_music',
  musicaTakes: 'project.list_music_takes',
  musicaEscolher: 'project.select_music_take',
};

const TODAS = Object.values(NOMES);

function ferramenta(nome) {
  const t = registry.getTool(nome);
  assert.ok(t, `ferramenta ausente: ${nome}`);
  return t;
}

/** Um projeto com duas cenas narradas, e o contexto que as tools recebem. */
let seq = 0;
// O banco é o do PROCESSO (`runtime/showrunner.db`), e ele sobrevive entre
// execuções — não há raiz de runtime configurável. Por isso cada cenário usa
// identificadores únicos: dois runs seguidos não podem disputar o mesmo projeto.
const CORRIDA = `t${Date.now().toString(36)}`;
function cenario() {
  const db = database();
  seq += 1;
  const A = `${CORRIDA}_a${seq}`;
  const B = `${CORRIDA}_b${seq}`;
  for (const id of [A, B]) {
    createProject({ id, name: `P ${id}` }, db);
    saveProductionPlan({ projectId: id, title: 'Plano', targetDurationSeconds: 80 }, db);
    saveProductionScript({ projectId: id, title: 'R', fullText: 'Texto.' }, db);
    replaceProductionScenes(id, [1, 2].map((n) => ({
      ordinal: n, title: `Cena ${n}`, durationSeconds: 40, narration: `Narração ${n}.`,
    })), db);
  }
  const thread = createThreadRecord({ projectId: A, title: 'Conversa' }, db);
  return { db, A, B, contexto: { threadId: thread.id, projectId: A } };
}

// ── as três famílias existem, e têm formas diferentes ──────────────────────

test('as dezenove ferramentas de áudio estão registradas', () => {
  const publicadas = publicToolList(registry).map((t) => t.name);
  for (const nome of TODAS) {
    assert.ok(publicadas.includes(nome), `não publicada: ${nome}`);
  }
});

test('cada família pede o que a cardinalidade dela exige — e nada além', () => {
  const props = (nome) => Object.keys(ferramenta(nome).inputSchema.properties || {}).sort();

  // Narração: uma por cena. Só a cena.
  assert.deepEqual(props(NOMES.narracaoGerar), ['ordinal']);
  assert.deepEqual(props(NOMES.narracaoEscolher), ['ordinal', 'takeNumber']);

  // Efeito: vários por cena. Cena + número do efeito.
  assert.deepEqual(props(NOMES.sfxGerar), ['cueNumber', 'ordinal']);
  assert.deepEqual(props(NOMES.sfxEscolher), ['cueNumber', 'ordinal', 'takeNumber']);

  // Música: da PRODUÇÃO. Nenhuma menção a cena.
  assert.deepEqual(props(NOMES.musicaCriar), ['description']);
  assert.deepEqual(props(NOMES.musicaGerar), ['cueNumber']);
  assert.deepEqual(props(NOMES.musicaEscolher), ['cueNumber', 'takeNumber']);
  assert.deepEqual(props(NOMES.musicaListar), []);
});

test('nenhum schema aceita detalhe de runtime', () => {
  const proibidos = [
    'workflow', 'workflowId', 'provider', 'providerJobId', 'seed', 'checkpoint',
    'model', 'modelId', 'voice', 'voiceId', 'path', 'filePath', 'outputPath',
    'jobId', 'assetId', 'fingerprint', 'sourceCueFingerprint',
    'sourceNarrationFingerprint', 'projectId', 'sceneId', 'cueId', 'takeId',
    'duration', 'durationSeconds', 'lyrics', 'bpm', 'key', 'timesignature',
  ];
  for (const nome of TODAS) {
    const props = Object.keys(ferramenta(nome).inputSchema.properties || {});
    for (const proibido of proibidos) {
      assert.equal(props.includes(proibido), false, `${nome} aceita "${proibido}"`);
    }
  }
});

test('as descrições ensinam o conceito sem citar provider nenhum', () => {
  for (const nome of TODAS) {
    const d = ferramenta(nome).description;
    assert.ok(d.length > 40, `${nome} tem descrição curta demais`);
    for (const vazamento of ['ComfyUI', 'Piper', 'ACE-Step', 'Stable Audio', 'workflow',
      'seed', 'checkpoint', 'safetensors', 'Hermes', 'SQLite']) {
      assert.equal(new RegExp(vazamento, 'i').test(d), false,
        `${nome} cita "${vazamento}" na descrição`);
    }
  }

  // E ensinam o que o passo decidiu: música é da produção, não da cena.
  assert.match(ferramenta(NOMES.musicaCriar).description, /produção/i);
  assert.match(ferramenta(NOMES.musicaCriar).description, /não pede número de cena/i);
  // Gerar de novo é "outra versão", e não um comando separado.
  for (const gerar of [NOMES.narracaoGerar, NOMES.sfxGerar, NOMES.musicaGerar]) {
    assert.match(ferramenta(gerar).description, /outra versão/i);
    assert.match(ferramenta(gerar).description, /nova tentativa|NOVA tentativa/i);
  }
  // Escolher não apaga nem gera.
  for (const escolher of [NOMES.narracaoEscolher, NOMES.sfxEscolher, NOMES.musicaEscolher]) {
    assert.match(ferramenta(escolher).description, /NÃO apaga/);
  }
});

// ── narração ───────────────────────────────────────────────────────────────

test('narração: ler, escrever, e o texto vem do banco', async () => {
  const { db, contexto } = cenario();

  const antes = await ferramenta(NOMES.narracaoGet).execute(contexto, { ordinal: 1 });
  assert.equal(antes.text, 'Narração 1.');
  assert.equal(antes.hasNarration, true);

  const depois = await ferramenta(NOMES.narracaoSet)
    .execute(contexto, { ordinal: 1, text: 'O trem chega vazio.' });
  assert.equal(depois.text, 'O trem chega vazio.');

  // Vazia é legítima.
  const vazia = await ferramenta(NOMES.narracaoSet).execute(contexto, { ordinal: 1, text: '' });
  assert.equal(vazia.hasNarration, false);
});

test('narração: gerar delega ao serviço, e devolve o take sem vazar runtime', async () => {
  const { db, contexto } = cenario();

  const r = await ferramenta(NOMES.narracaoGerar).execute(contexto, { ordinal: 1 });
  assert.equal(r.status, 'started');
  assert.equal(r.takeNumber, 1);
  assert.equal(r.ordinal, 1);

  // Nada de job/provider/caminho na resposta.
  for (const campo of Object.keys(r)) {
    assert.equal(/job|provider|path|asset|workflow|seed/i.test(campo), false,
      `a resposta vaza "${campo}"`);
  }

  // "Outra versão" é a MESMA ferramenta de novo.
  const dois = await ferramenta(NOMES.narracaoGerar).execute(contexto, { ordinal: 1 });
  assert.equal(dois.takeNumber, 2);
});

test('narração: a listagem expõe selected e current, e escolher move o ponteiro', async () => {
  const { db, contexto } = cenario();
  await ferramenta(NOMES.narracaoGerar).execute(contexto, { ordinal: 1 });
  await ferramenta(NOMES.narracaoGerar).execute(contexto, { ordinal: 1 });

  const lista = await ferramenta(NOMES.narracaoTakes).execute(contexto, { ordinal: 1 });
  assert.equal(lista.takes.length, 2);
  assert.deepEqual(Object.keys(lista.takes[0]).sort(),
    ['current', 'selected', 'status', 'takeNumber']);
  // Sem Asset ainda: a tentativa existe e está em curso.
  assert.equal(lista.takes[0].status, 'gerando');

  const escolha = await ferramenta(NOMES.narracaoEscolher)
    .execute(contexto, { ordinal: 1, takeNumber: 2 });
  assert.equal(escolha.takeNumber, 2);

  const depois = await ferramenta(NOMES.narracaoTakes).execute(contexto, { ordinal: 1 });
  assert.equal(depois.takes.find((t) => t.takeNumber === 2).selected, true);
  assert.equal(depois.takes.find((t) => t.takeNumber === 1).selected, false);
});

test('narração: editar o texto torna os takes anteriores não atuais', async () => {
  const { db, contexto } = cenario();
  await ferramenta(NOMES.narracaoGerar).execute(contexto, { ordinal: 1 });
  await ferramenta(NOMES.narracaoEscolher).execute(contexto, { ordinal: 1, takeNumber: 1 });

  const antes = await ferramenta(NOMES.narracaoTakes).execute(contexto, { ordinal: 1 });
  assert.equal(antes.takes[0].current, true);

  await ferramenta(NOMES.narracaoSet).execute(contexto, { ordinal: 1, text: 'Outro texto.' });

  // É este par que permite ao agente explicar sem inventar.
  const depois = await ferramenta(NOMES.narracaoTakes).execute(contexto, { ordinal: 1 });
  assert.equal(depois.takes[0].selected, true);
  assert.equal(depois.takes[0].current, false);
});

// ── efeito ─────────────────────────────────────────────────────────────────

test('efeito: criar, listar, editar e remover cues de uma cena', async () => {
  const { db, contexto } = cenario();

  const trovao = await ferramenta(NOMES.sfxCriar)
    .execute(contexto, { ordinal: 1, description: 'trovão distante' });
  const porta = await ferramenta(NOMES.sfxCriar)
    .execute(contexto, { ordinal: 1, description: 'porta metálica batendo' });
  assert.equal(trovao.cueNumber, 1);
  assert.equal(porta.cueNumber, 2);

  const lista = await ferramenta(NOMES.sfxListar).execute(contexto, { ordinal: 1 });
  assert.deepEqual(lista.cues.map((c) => c.cueNumber), [1, 2]);
  assert.equal(lista.cues[0].takes, 0);
  assert.equal(lista.cues[0].selectedTakeNumber, null);

  await ferramenta(NOMES.sfxEditar)
    .execute(contexto, { ordinal: 1, cueNumber: 1, description: 'trovão muito próximo' });
  const editada = await ferramenta(NOMES.sfxListar).execute(contexto, { ordinal: 1 });
  assert.equal(editada.cues[0].description, 'trovão muito próximo');

  const removida = await ferramenta(NOMES.sfxRemover).execute(contexto, { ordinal: 1, cueNumber: 2 });
  assert.equal(removida.removed, true);
  assert.equal((await ferramenta(NOMES.sfxListar).execute(contexto, { ordinal: 1 })).cues.length, 1);
});

// ── a delegação, provada sem GPU ───────────────────────────────────────────
//
// As três `generate` recebem `deps` como terceiro parâmetro com default — o
// registry chama `execute(context, args)` e nunca o informa, então em produção
// o serviço é sempre o real. Aqui ele é um duplo que só ANOTA o que recebeu:
// nenhum provider é chamado, nenhum job nasce, nenhuma GPU acorda.

/** Um duplo do serviço de geração. Não gera nada; registra o pedido. */
function servicoFalso(resposta) {
  const chamadas = [];
  return {
    chamadas,
    async gerar(pedido, opcoes) {
      chamadas.push({ pedido, opcoes });
      return resposta;
    },
  };
}

test('A. narração: generate delega com a identidade do contexto e a cena certa', async () => {
  const { db, A, contexto } = cenario();
  const servico = servicoFalso({ ordinal: 3, takeNumber: 2 });
  const jobsAntes = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n;

  const r = await ferramenta(NOMES.narracaoGerar)
    .execute(contexto, { ordinal: 1 }, { gerar: servico.gerar });

  assert.equal(servico.chamadas.length, 1);
  // F. o projeto vem do CONTEXTO — o modelo não o disse, e não poderia.
  assert.equal(servico.chamadas[0].pedido.projectId, A);
  assert.equal(servico.chamadas[0].pedido.ordinal, 1);
  // E o pedido não carrega nada além disso.
  assert.deepEqual(Object.keys(servico.chamadas[0].pedido).sort(), ['ordinal', 'projectId']);

  // E. a resposta pública é só a superfície audiovisual.
  assert.deepEqual(r, { ordinal: 3, takeNumber: 2, status: 'started' });

  // D. nenhum job nasceu: o executor real não foi tocado. A conta é relativa
  // porque o banco é o do processo e acumula entre os testes do arquivo.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, jobsAntes);
});

test('B. efeito: generate delega com projeto do contexto, cena e cue certos', async () => {
  const { db, A, contexto } = cenario();
  await ferramenta(NOMES.sfxCriar).execute(contexto, { ordinal: 2, description: 'trovão' });
  const servico = servicoFalso({ ordinal: 2, cueNumber: 1, takeNumber: 1 });
  const jobsAntes = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n;

  const r = await ferramenta(NOMES.sfxGerar)
    .execute(contexto, { ordinal: 2, cueNumber: 1 }, { gerar: servico.gerar });

  assert.equal(servico.chamadas.length, 1);
  assert.deepEqual(servico.chamadas[0].pedido, { projectId: A, ordinal: 2, cueNumber: 1 });
  assert.deepEqual(r, { ordinal: 2, cueNumber: 1, takeNumber: 1, status: 'started' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, jobsAntes);
});

test('C. música: generate delega com projeto do contexto e peça certa — sem cena', async () => {
  const { db, A, contexto } = cenario();
  await ferramenta(NOMES.musicaCriar).execute(contexto, { description: 'trilha sombria' });
  const servico = servicoFalso({ cueNumber: 1, takeNumber: 4 });
  const jobsAntes = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n;

  const r = await ferramenta(NOMES.musicaGerar)
    .execute(contexto, { cueNumber: 1 }, { gerar: servico.gerar });

  assert.equal(servico.chamadas.length, 1);
  assert.deepEqual(servico.chamadas[0].pedido, { projectId: A, cueNumber: 1 });
  // A música é da PRODUÇÃO: nenhum ordinal atravessa a fronteira.
  assert.equal('ordinal' in servico.chamadas[0].pedido, false);
  assert.deepEqual(r, { cueNumber: 1, takeNumber: 4, status: 'started' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, jobsAntes);
});

test('E. o resultado público das três não carrega nada de runtime', async () => {
  const { contexto } = cenario();
  await ferramenta(NOMES.sfxCriar).execute(contexto, { ordinal: 1, description: 'porta' });
  await ferramenta(NOMES.musicaCriar).execute(contexto, { description: 'trilha' });

  // O serviço devolve DE PROPÓSITO um objeto sujo: jobId, providerJobId,
  // workflowId, caminho, Asset e impressão. Nada disso pode atravessar.
  const sujo = {
    ordinal: 1, cueNumber: 1, takeNumber: 1,
    jobId: 'cinema_x', providerJobId: 'prompt-123', workflowId: 'ace_step_15_music',
    assetId: 'asset_x', sourceCueFingerprint: 'a'.repeat(64),
    sourceNarrationFingerprint: 'b'.repeat(64), path: '/runtime/x.flac',
    provider: 'comfy', model: 'ACE-Step', seed: 42,
  };

  for (const [nome, args] of [
    [NOMES.narracaoGerar, { ordinal: 1 }],
    [NOMES.sfxGerar, { ordinal: 1, cueNumber: 1 }],
    [NOMES.musicaGerar, { cueNumber: 1 }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    const r = await ferramenta(nome).execute(contexto, args, { gerar: async () => sujo });
    const chaves = Object.keys(r).sort();
    for (const proibida of ['jobId', 'providerJobId', 'workflowId', 'assetId', 'path',
      'provider', 'model', 'seed', 'sourceCueFingerprint', 'sourceNarrationFingerprint']) {
      assert.equal(chaves.includes(proibida), false, `${nome} vazou "${proibida}"`);
    }
    assert.equal(r.status, 'started');
    assert.ok(chaves.every((k) => ['ordinal', 'cueNumber', 'takeNumber', 'status'].includes(k)),
      `${nome} devolveu ${chaves.join(', ')}`);
  }
});

test('G. argumento proibido é recusado ANTES de o serviço ser chamado', async () => {
  const { contexto } = cenario();
  await ferramenta(NOMES.sfxCriar).execute(contexto, { ordinal: 1, description: 'porta' });
  await ferramenta(NOMES.musicaCriar).execute(contexto, { description: 'trilha' });
  const servico = servicoFalso({});

  const proibidos = ['projectId', 'workflowId', 'provider', 'seed', 'jobId', 'assetId',
    'fingerprint', 'prompt', 'description', 'model', 'path'];

  for (const nome of [NOMES.narracaoGerar, NOMES.sfxGerar, NOMES.musicaGerar]) {
    const base = nome === NOMES.narracaoGerar ? { ordinal: 1 }
      : nome === NOMES.sfxGerar ? { ordinal: 1, cueNumber: 1 } : { cueNumber: 1 };
    for (const proibido of proibidos) {
      // eslint-disable-next-line no-await-in-loop
      await assert.rejects(
        () => ferramenta(nome).execute(contexto, { ...base, [proibido]: 'x' },
          { gerar: servico.gerar }),
        (erro) => /Propriedades desconhecidas/.test(erro.message),
        `${nome} aceitou "${proibido}"`,
      );
    }
  }

  // E o serviço nunca foi chamado: a recusa acontece antes da delegação.
  assert.equal(servico.chamadas.length, 0);
});

test('efeito: a geração recusa antes de tocar no executor quando a cue não existe', async () => {
  const { db, contexto } = cenario();
  await ferramenta(NOMES.sfxCriar).execute(contexto, { ordinal: 1, description: 'trovão' });

  // A execução COM cue válida chega ao ComfyUI de verdade — e por isso não roda
  // aqui: esta suíte não acorda GPU. O que ela tranca é a fronteira, que é onde
  // a ferramenta pode errar: a recusa acontece ANTES de qualquer trabalho
  // externo, e nenhum job nasce. A geração real é provada no smoke do 14-D1B.
  const jobsAntes = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n;

  await assert.rejects(
    () => ferramenta(NOMES.sfxGerar).execute(contexto, { ordinal: 1, cueNumber: 9 }),
    (erro) => /não tem um efeito 9/.test(erro.message)
      && !/ComfyUI|ECONNREFUSED|socket|SQLITE/i.test(erro.message),
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, jobsAntes);
});

// ── música ─────────────────────────────────────────────────────────────────

test('música: criar e listar peças da PRODUÇÃO, sem cena nenhuma', async () => {
  const { db, contexto } = cenario();

  const um = await ferramenta(NOMES.musicaCriar)
    .execute(contexto, { description: 'trilha orquestral sombria' });
  const dois = await ferramenta(NOMES.musicaCriar)
    .execute(contexto, { description: 'piano melancólico' });
  assert.equal(um.cueNumber, 1);
  assert.equal(dois.cueNumber, 2);

  const lista = await ferramenta(NOMES.musicaListar).execute(contexto, {});
  assert.deepEqual(lista.cues.map((c) => c.cueNumber), [1, 2]);
  // A resposta não menciona cena em lugar nenhum.
  assert.equal(/ordinal|scene|cena/i.test(JSON.stringify(lista)), false);

  await ferramenta(NOMES.musicaEditar)
    .execute(contexto, { cueNumber: 1, description: 'trilha luminosa' });
  assert.equal(
    (await ferramenta(NOMES.musicaListar).execute(contexto, {})).cues[0].description,
    'trilha luminosa',
  );

  const removida = await ferramenta(NOMES.musicaRemover).execute(contexto, { cueNumber: 2 });
  assert.equal(removida.removed, true);
});

test('música: a peça não existe → erro de produção, e nada é criado', async () => {
  const { db, contexto } = cenario();
  const jobsAntes = db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n;

  await assert.rejects(
    () => ferramenta(NOMES.musicaGerar).execute(contexto, { cueNumber: 9 }),
    (erro) => /não tem uma peça musical 9/.test(erro.message)
      && !/ComfyUI|ECONNREFUSED|socket|SQLITE/i.test(erro.message),
  );
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM generation_jobs').get().n, jobsAntes);
});

// ── fronteiras ─────────────────────────────────────────────────────────────

test('argumento fora do schema é RECUSADO, e a recusa diz de quem é a identidade', async () => {
  const { db, contexto } = cenario();

  // É este mecanismo que impede o modelo de escolher voz, seed ou workflow.
  for (const [nome, args] of [
    [NOMES.narracaoGerar, { ordinal: 1, provider: 'piper' }],
    [NOMES.narracaoGerar, { ordinal: 1, projectId: 'proj_b' }],
    [NOMES.sfxGerar, { ordinal: 1, cueNumber: 1, seed: 42 }],
    [NOMES.musicaGerar, { cueNumber: 1, workflowId: 'ace_step_15_music' }],
    [NOMES.narracaoEscolher, { ordinal: 1, takeNumber: 1, assetId: 'asset_x' }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => ferramenta(nome).execute(contexto, args),
      (erro) => /Propriedades desconhecidas/.test(erro.message),
      `${nome} aceitou ${JSON.stringify(args)}`,
    );
  }
});

test('cross-project: o projeto vem do CONTEXTO, e não dos argumentos', async () => {
  const { db, A, B, contexto } = cenario();
  await ferramenta(NOMES.musicaCriar).execute(contexto, { description: 'trilha do A' });

  // A conversa do projeto B não enxerga nada do A.
  const threadB = createThreadRecord({ projectId: B, title: 'Outra' }, db);
  const contextoB = { threadId: threadB.id, projectId: B };

  const listaB = await ferramenta(NOMES.musicaListar).execute(contextoB, {});
  assert.deepEqual(listaB.cues, []);

  await assert.rejects(
    () => ferramenta(NOMES.musicaGerar).execute(contextoB, { cueNumber: 1 }),
    (erro) => /não tem uma peça musical 1/.test(erro.message) && !erro.message.includes(A),
  );

  // E a do A continua intacta.
  assert.equal((await ferramenta(NOMES.musicaListar).execute(contexto, {})).cues.length, 1);
});

test('cena inexistente responde em linguagem de produção', async () => {
  const { db, contexto } = cenario();

  for (const [nome, args] of [
    [NOMES.narracaoGet, { ordinal: 99 }],
    [NOMES.narracaoGerar, { ordinal: 99 }],
    [NOMES.sfxCriar, { ordinal: 99, description: 'x' }],
    [NOMES.sfxListar, { ordinal: 99 }],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => ferramenta(nome).execute(contexto, args),
      (erro) => /não tem uma cena 99/.test(erro.message)
        && !/SQLITE|FOREIGN KEY|undefined|null/i.test(erro.message),
      nome,
    );
  }

  // E sem projeto na conversa, a recusa também é de produto.
  await assert.rejects(
    () => ferramenta(NOMES.musicaListar).execute({ threadId: 't1' }, {}),
    (erro) => /não está ligada a um projeto/.test(erro.message),
  );
});

test('ausência: nenhuma mega-ferramenta de áudio, e nada de timeline', () => {
  const publicadas = publicToolList(registry).map((t) => t.name);
  for (const proibida of ['audio.generate', 'project.audio', 'project.generate_audio',
    'project.timeline', 'project.mix', 'project.export_audio']) {
    assert.equal(publicadas.includes(proibida), false, `criada cedo demais: ${proibida}`);
  }
  // As três famílias continuam separadas.
  assert.equal(publicadas.filter((n) => /narration/.test(n)).length, 5);
  assert.equal(publicadas.filter((n) => /sfx/.test(n)).length, 7);
  assert.equal(publicadas.filter((n) => /music/.test(n)).length, 7);
});
