// Finalização de Asset no caminho do agente.
//
// ── O que este arquivo protege ──────────────────────────────────────────────
//
// A geração do ComfyUI é PULL: ela só progride quando alguém chama `pollJob`.
// Na tela, quem chama é o navegador. No caminho do agente não há navegador, e
// até o PASSO 7B.1 ninguém chamava — o job ficava em "gerando" para sempre e
// nenhum Asset nascia. `finalizeGenerationAsset` existia, era idempotente, era
// testada, e não era chamada de lugar nenhum em produção.
//
// Estes testes fixam as duas metades: consultar AVANÇA a geração, e concluir
// cria o Asset UMA vez.
//
// Determinismo: os jobs são montados direto no store, sem `promptId`. `pollJob`
// devolve cedo quando não há promptId, então nada aqui toca a rede — e o que
// se testa é a decisão da facade, não o ComfyUI.

import test from 'node:test';
import assert from 'node:assert/strict';

import { getGenerationJob, finalizeGenerationAsset, GenerationError } from '../lib/server/generation/facade.js';
import { createJob } from '../lib/server/comfy/jobs.js';
import { STATES } from '../lib/server/comfy/status.js';
import { openDatabase } from '../lib/server/domain/db.js';
import { createProject, findAssetsByJob, createAsset } from '../lib/server/domain/index.js';

let contador = 0;
const proximoJob = () => `job_fin_${Date.now()}_${contador += 1}`;

/** Um banco novo com um projeto, e um job no estado pedido. */
function cenario({
  state = STATES.GENERATING, kind = 'image', projectId = 'proj_fin',
  ext = null, extra = {},
} = {}) {
  const db = openDatabase(':memory:');
  createProject({ id: projectId, name: 'Finalização' }, db);

  const jobId = proximoJob();
  createJob({
    jobId,
    projectId,
    kind,
    state,
    prompt: 'um farol ao amanhecer',
    seed: 7,
    // Sem promptId: pollJob devolve cedo e nada vai à rede.
    promptId: null,
    result: state === STATES.DONE
      ? (() => {
        const extensao = ext ?? (kind === 'image' ? '.png' : '.mp4');
        return {
          url: `/api/media/${kind}/${jobId}${extensao}`,
          filename: `${jobId}${extensao}`,
          bytes: 2048,
        };
      })()
      : null,
    ...extra,
  });

  return { db, jobId, projectId };
}

// ── A · rodando não cria Asset ──────────────────────────────────────────────

test('A. job rodando devolve status e NÃO cria Asset', async () => {
  for (const state of [STATES.PREPARING, STATES.SUBMITTED, STATES.QUEUED, STATES.GENERATING]) {
    const { db, jobId, projectId } = cenario({ state });
    const r = await getGenerationJob(jobId, { projectId, db });

    assert.equal(r.jobId, jobId);
    assert.equal(r.assetId, null, `${state} não deveria produzir Asset`);
    assert.equal(r.asset, null);
    assert.equal(findAssetsByJob(jobId, db).length, 0);
  }
});

// ── B · estados intermediários não são conclusão ────────────────────────────

test('B. decodificando e salvando NÃO criam Asset', async () => {
  // `salvando` é a armadilha: o arquivo ainda está sendo publicado e validado.
  // Um Asset criado aqui apontaria para algo que pode nunca existir.
  for (const state of [STATES.DECODING, STATES.SAVING]) {
    const { db, jobId, projectId } = cenario({ state });
    const r = await getGenerationJob(jobId, { projectId, db });

    assert.equal(r.status, state === STATES.SAVING ? 'salvando' : 'decodificando');
    assert.equal(r.assetId, null, `${state} não deveria produzir Asset`);
    assert.equal(findAssetsByJob(jobId, db).length, 0);
  }
});

test('B-bis. finalizeGenerationAsset recusa qualquer estado que não seja DONE', async () => {
  for (const state of [STATES.GENERATING, STATES.SAVING, STATES.DECODING, STATES.FAILED]) {
    const { db, jobId, projectId } = cenario({ state });
    await assert.rejects(
      () => finalizeGenerationAsset(jobId, { projectId, db }),
      GenerationError,
      `${state} deveria ser recusado`,
    );
  }
});

// ── C · concluído cria o Asset ──────────────────────────────────────────────

test('C. a primeira consulta a um job concluído cria o Asset', async () => {
  const { db, jobId, projectId } = cenario({ state: STATES.DONE });

  assert.equal(findAssetsByJob(jobId, db).length, 0, 'não deveria haver Asset antes');

  const r = await getGenerationJob(jobId, { projectId, db });

  assert.equal(r.status, 'concluido');
  assert.ok(r.assetId, 'o Asset deveria ter sido criado');
  assert.equal(findAssetsByJob(jobId, db).length, 1);
  assert.equal(r.mediaUrl, `/api/media/image/${jobId}.png`);
});

// ── D · idempotência ────────────────────────────────────────────────────────

test('D. a segunda consulta devolve exatamente o MESMO assetId', async () => {
  const { db, jobId, projectId } = cenario({ state: STATES.DONE });

  const primeira = await getGenerationJob(jobId, { projectId, db });
  const segunda = await getGenerationJob(jobId, { projectId, db });
  const terceira = await getGenerationJob(jobId, { projectId, db });

  assert.ok(primeira.assetId);
  assert.equal(segunda.assetId, primeira.assetId);
  assert.equal(terceira.assetId, primeira.assetId);
  assert.equal(findAssetsByJob(jobId, db).length, 1, 'consultar em laço não duplica Asset');
});

// ── E · concorrência ────────────────────────────────────────────────────────

test('E. consultas simultâneas produzem UM Asset só', async () => {
  const { db, jobId, projectId } = cenario({ state: STATES.DONE });

  const respostas = await Promise.all(
    Array.from({ length: 8 }, () => getGenerationJob(jobId, { projectId, db })),
  );

  const ids = new Set(respostas.map((r) => r.assetId));
  assert.equal(ids.size, 1, `oito consultas produziram ${ids.size} Assets diferentes`);
  assert.equal(findAssetsByJob(jobId, db).length, 1);
});

// ── F · propriedade ─────────────────────────────────────────────────────────

test('F. projeto errado não finaliza nem revela o Asset', async () => {
  const { db, jobId, projectId } = cenario({ state: STATES.DONE });
  createProject({ id: 'proj_intruso', name: 'Intruso' }, db);

  await assert.rejects(
    () => getGenerationJob(jobId, { projectId: 'proj_intruso', db }),
    GenerationError,
  );
  assert.equal(findAssetsByJob(jobId, db).length, 0,
    'a consulta de outro projeto criou Asset');

  // E finalizar direto com o projeto errado também é recusado.
  await assert.rejects(
    () => finalizeGenerationAsset(jobId, { projectId: 'proj_intruso', db }),
    GenerationError,
  );
  assert.equal(findAssetsByJob(jobId, db).length, 0);

  // O dono legítimo continua conseguindo.
  const r = await getGenerationJob(jobId, { projectId, db });
  assert.ok(r.assetId);
});

test('F-bis. um Asset já existente não é revelado ao projeto errado', async () => {
  const { db, jobId, projectId } = cenario({ state: STATES.DONE });
  await getGenerationJob(jobId, { projectId, db });
  assert.equal(findAssetsByJob(jobId, db).length, 1);

  createProject({ id: 'proj_intruso2', name: 'Intruso' }, db);
  await assert.rejects(
    () => getGenerationJob(jobId, { projectId: 'proj_intruso2', db }),
    GenerationError,
  );
});

// ── G e H · forma do Asset ──────────────────────────────────────────────────

test('G. imagem produz Asset kind=image', async () => {
  const { db, jobId, projectId } = cenario({ state: STATES.DONE, kind: 'image' });
  const r = await getGenerationJob(jobId, { projectId, db });

  assert.equal(r.kind, 'image');
  assert.equal(r.asset.kind, 'image');
  // O arquivo publicado é .png — antes esta linha esperava image/jpeg, que era
  // o hardcode, não a verdade. Ver J.
  assert.equal(r.asset.mimeType, 'image/png');
  assert.equal(r.asset.derivedFromAssetId, null);
  assert.equal(r.asset.id, r.assetId);
});

test('H. vídeo produz Asset kind=video e preserva a linhagem', async () => {
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_v', name: 'Vídeo' }, db);

  // A imagem de origem, como o PASSO 6.1 a cria.
  const origem = createAsset({
    projectId: 'proj_v', kind: 'image', jobId: 'job_img_origem',
    filename: 'origem.png', url: '/api/media/image/origem.png',
    mimeType: 'image/png', status: 'pendente', createdAt: 1,
  }, db);

  const jobId = proximoJob();
  createJob({
    jobId, projectId: 'proj_v', kind: 'video', state: STATES.DONE, promptId: null,
    derivedFromAssetId: origem.id,
    result: { url: `/api/media/video/${jobId}.mp4`, filename: `${jobId}.mp4`, bytes: 4096 },
  });

  const r = await getGenerationJob(jobId, { projectId: 'proj_v', db });

  assert.equal(r.kind, 'video');
  assert.equal(r.asset.kind, 'video');
  assert.equal(r.asset.mimeType, 'video/mp4');
  assert.equal(r.asset.derivedFromAssetId, origem.id, 'a linhagem imagem→vídeo se perdeu');
});

// ── I · o caminho do runtime não conhece o finalizador ──────────────────────

test('I. o caminho do runtime chega à tool certa sem conhecer o finalizador', async () => {
  // O plugin e o bridge só sabem chamar og_get_job. Quem decide que o job
  // terminou, e quem cria o Asset, é o Showrunner.
  //
  // A prova é feita com um registry espião, e não com um banco em memória, por
  // um motivo concreto: o handler de og.get_job abre o banco GLOBAL
  // (`database()`), então um banco injetado neste teste não chegaria até ele.
  // Testar o roteamento é o que este caso pode afirmar com honestidade; que a
  // finalização acontece está provado em C, D e E.
  const { handleBridgeInvocation } = await import('../lib/server/agent/hermes/bridge.js');
  const { bindRuntimeSession } = await import('../lib/server/agent/hermes/sessionBinding.js');
  const { createThreadRecord } = await import('../lib/server/agent/threads.js');

  const { db, jobId, projectId } = cenario({ state: STATES.DONE });
  const thread = createThreadRecord({ projectId }, db);
  bindRuntimeSession({ sessionId: 'sess_fin', threadId: thread.id, runtimeId: 'hermes', now: 1 }, db);

  const chamadas = [];
  const espiao = {
    invoke: async (name, context, args) => {
      chamadas.push({ name, context, args });
      return { jobId, status: 'concluido', assetId: 'asset_x', asset: { id: 'asset_x' } };
    },
  };

  const r = await handleBridgeInvocation({
    sessionId: 'sess_fin', toolName: 'og_get_job', arguments: { jobId },
  }, { db, registry: espiao });

  assert.equal(r.ok, true);
  assert.equal(chamadas.length, 1);
  assert.equal(chamadas[0].name, 'og.get_job', 'o bridge deveria chamar a tool canônica');
  // O contexto é do servidor, não do runtime.
  assert.equal(chamadas[0].context.projectId, projectId);
  assert.equal(chamadas[0].context.threadId, thread.id);
});

test('I-ter. nem o bridge, nem o adaptador, nem o plugin citam o finalizador', async () => {
  const { readFileSync } = await import('node:fs');

  // Comentários fora, pela mesma razão de agent-architecture.test.mjs: vários
  // destes arquivos EXPLICAM, em comentário, por que não conhecem filename nem
  // Asset — e essa explicação é o que mantém a decisão viva para quem chegar.
  // Proibir a palavra no comentário apagaria a razão junto com o risco.
  const ASPAS = '"'.repeat(3);
  const semComentarios = (fonte) => fonte
    .replace(new RegExp(ASPAS + '[\\s\\S]*?' + ASPAS, 'g'), '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((linha) => linha.replace(/\/\/.*$/, '').replace(/#.*$/, ''))
    .join('\n');

  const arquivos = [
    'lib/server/agent/hermes/bridge.js',
    'lib/server/agent/hermes/aliases.js',
    'lib/server/agent/adapters/HermesRuntimeAdapter.js',
    'integrations/hermes/showrunner-plugin/__init__.py',
  ];
  for (const arquivo of arquivos) {
    const fonte = semComentarios(readFileSync(arquivo, 'utf8'));
    for (const proibido of ['finalizeGenerationAsset', 'createAsset', 'findAssetsByJob',
      'STATES.DONE', 'filename']) {
      assert.equal(fonte.includes(proibido), false,
        `${arquivo} cita "${proibido}" — a decisão de concluir é do Showrunner`);
    }
  }
});

test('I-bis. o resultado público não vaza caminho, workflow nem provider', async () => {
  const { db, jobId, projectId } = cenario({
    state: STATES.DONE,
    extra: { workflowId: 'ideogram4_t2i', promptId: 'prompt-interno-123' },
  });

  const r = await getGenerationJob(jobId, { projectId, db });
  const texto = JSON.stringify(r);

  for (const proibido of ['ideogram', 'comfy', 'promptId', 'prompt-interno',
    'workflowId', '/runtime/', 'subfolder', 'sourceFilename']) {
    assert.equal(texto.toLowerCase().includes(proibido.toLowerCase()), false,
      `"${proibido}" vazou no resultado público`);
  }
});

// ── mimeType reflete o arquivo publicado ────────────────────────────────────

test('J. o mimeType vem da extensão REAL do arquivo publicado', async () => {
  // Antes esta linha era `kind === 'image' ? 'image/jpeg' : 'video/mp4'`, e todo
  // PNG gerado virava um Asset image/jpeg. O smoke real produziu exatamente
  // isso: arquivo .png, Asset image/jpeg.
  const casos = [
    ['image', '.png', 'image/png'],
    ['image', '.jpg', 'image/jpeg'],
    ['image', '.jpeg', 'image/jpeg'],
    ['image', '.webp', 'image/webp'],
    ['video', '.mp4', 'video/mp4'],
  ];

  for (const [kind, ext, esperado] of casos) {
    const { db, jobId, projectId } = cenario({ state: STATES.DONE, kind, ext });
    const r = await getGenerationJob(jobId, { projectId, db });

    assert.equal(r.asset.mimeType, esperado, `${kind}${ext} deveria ser ${esperado}`);
    assert.equal(findAssetsByJob(jobId, db)[0].mimeType, esperado,
      `${kind}${ext}: a linha gravada discorda do resultado público`);
  }
});

test('J-bis. o mimeType usa o MESMO helper que serve o arquivo', async () => {
  // Se o Asset e a rota de mídia discordassem, o navegador receberia bytes com
  // o tipo errado — que é o que `nosniff` existe para impedir.
  const { mimeFor } = await import('../lib/server/generation/mediaKinds.js');

  for (const [kind, ext] of [['image', '.png'], ['image', '.webp'], ['video', '.mp4']]) {
    const { db, jobId, projectId } = cenario({ state: STATES.DONE, kind, ext });
    const r = await getGenerationJob(jobId, { projectId, db });
    assert.equal(r.asset.mimeType, mimeFor(kind, `qualquer${ext}`));
  }
});

test('J-ter. extensão que não sabemos servir NÃO vira Asset', async () => {
  // Falhar é o certo: um Asset que aponta para algo inservível é pior do que
  // nenhum Asset, porque some silenciosamente na hora de exibir.
  const { db, jobId, projectId } = cenario({ state: STATES.DONE, kind: 'image', ext: '.tiff' });
  await assert.rejects(() => getGenerationJob(jobId, { projectId, db }));
  assert.equal(findAssetsByJob(jobId, db).length, 0);
});

// ── erro real de finalização não é engolido ─────────────────────────────────

test('K. erro real de banco NÃO vira "concluido" sem Asset', async () => {
  // O contrato que importa: o agente jamais recebe status de sucesso com
  // assetId nulo por causa de uma falha que ninguém contou a ele.
  const { db, jobId, projectId } = cenario({ state: STATES.DONE });

  const bancoQuebrado = {
    prepare(sql) {
      if (/INSERT INTO assets/i.test(sql)) {
        throw new Error('disco cheio em /var/lib/showrunner/banco.db');
      }
      return db.prepare(sql);
    },
  };

  await assert.rejects(
    () => getGenerationJob(jobId, { projectId, db: bancoQuebrado }),
    (erro) => {
      assert.equal(erro.name, 'GenerationError', 'deveria ser erro tipado da camada');
      // O caminho do banco não pode chegar ao agente.
      assert.equal(/\/var\/lib/.test(erro.message), false, 'vazou caminho de sistema');
      assert.equal(/disco cheio/.test(erro.message), false, 'vazou mensagem do SQLite');
      return true;
    },
  );
});

test('K-bis. o erro real preserva a causa no detail, para o log do servidor', async () => {
  const { db, jobId, projectId } = cenario({ state: STATES.DONE });
  const bancoQuebrado = {
    prepare(sql) {
      if (/INSERT INTO assets/i.test(sql)) throw new Error('falha crua do driver');
      return db.prepare(sql);
    },
  };

  await assert.rejects(
    () => getGenerationJob(jobId, { projectId, db: bancoQuebrado }),
    (erro) => {
      assert.match(String(erro.detail?.causa), /falha crua do driver/);
      return true;
    },
  );
});

test('K-ter. estado intermediário continua respondendo status, sem erro', async () => {
  // A contrapartida de K: endurecer o caminho de DONE não pode transformar uma
  // consulta legítima de job em andamento numa exceção.
  for (const state of [STATES.GENERATING, STATES.SAVING]) {
    const { db, jobId, projectId } = cenario({ state });
    const r = await getGenerationJob(jobId, { projectId, db });
    assert.equal(r.assetId, null);
    assert.equal(r.asset, null);
    assert.ok(r.status);
  }
});
