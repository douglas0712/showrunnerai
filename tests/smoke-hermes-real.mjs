// SMOKE REAL — o ciclo inteiro, com runtime de verdade.
//
// NÃO faz parte de `npm test`: o nome termina em `.mjs` e não em `.test.mjs`
// justamente porque depende de um runtime rodando, de credenciais e da rede.
// A suíte determinística não pode depender de nada disso.
//
// O que ele exercita, de ponta a ponta:
//
//   gateway → adaptador → HTTP/SSE → runtime dedicado
//   runtime → plugin → socket Unix → bridge → invokeTool → og.*
//
// Uso:
//   SHOWRUNNER_HERMES_URL=http://127.0.0.1:8788 \
//   SHOWRUNNER_BRIDGE_SOCKET=<caminho> \
//   node tests/smoke-hermes-real.mjs [--image]
//
// Sem `--image` roda só a conversa textual, que é o teste do "cérebro". Com
// `--image`, pede UMA imagem — e é aí que o bridge e as tools entram.

import path from 'node:path';
import { AGENT_EVENTS } from '../lib/server/agent/events.js';
import { createRuntime } from '../lib/server/agent/runtimes.js';
import { startBridgeServer } from '../lib/server/agent/hermes/bridge.js';
import { createThread, sendMessage } from '../lib/server/agent/gateway.js';
import { database } from '../lib/server/domain/db.js';
import { ensureProject } from '../lib/server/domain/projects.js';

const COM_IMAGEM = process.argv.includes('--image');
const SOCKET = process.env.SHOWRUNNER_BRIDGE_SOCKET
  || path.join(process.cwd(), 'runtime', 'hermes', 'bridge.sock');

let falhas = 0;
const ok = (cond, texto) => {
  console.log(`${cond ? '  ✔' : '  ✖'} ${texto}`);
  if (!cond) falhas += 1;
};

console.log('SMOKE REAL — runtime dedicado + bridge\n');

const db = database();
const runtime = createRuntime('hermes');

console.log('runtime:');
ok(runtime.isAvailable(), 'o runtime está configurado e disponível');
const conexao = await runtime.testConnection();
ok(conexao.ok, 'o serviço de raciocínio respondeu');
console.log(`    isolamento anunciado: ${JSON.stringify(conexao.detail?.isolation)}`);

const bridge = await startBridgeServer({ socketPath: SOCKET, db });
console.log(`\nbridge no ar: ${bridge.socketPath}`);

try {
  const { project } = ensureProject('smoke_agente', { name: 'Smoke do agente' }, db);

  // ── 1 · conversa textual ────────────────────────────────────────────────
  console.log('\n1. conversa textual (sem ferramenta):');
  const t1 = createThread({ projectId: project.id, title: 'Smoke textual' }, { db });
  const r1 = await sendMessage(
    { threadId: t1.id, content: 'Responda apenas OK.' },
    { db, runtime },
  );

  console.log(`    resposta: ${JSON.stringify(r1.assistantMessage.content)}`);
  ok(r1.assistantMessage.content.length > 0, 'o agente respondeu');
  ok(r1.events.some((e) => e.type === AGENT_EVENTS.COMPLETED), 'o turno concluiu');

  // ── 2 · a identidade do runtime não vaza ────────────────────────────────
  console.log('\n2. identidade do runtime:');
  // A superfície é o que SAI do agente: os eventos e a resposta. A fala do
  // usuário não entra — se ele escrever "hermes", isso é conteúdo da conversa,
  // não vazamento do runtime, e incluí-la tornaria o teste um detector de
  // palavras em vez de um detector de fronteira furada.
  const superficie = JSON.stringify({
    eventos: r1.events, resposta: r1.assistantMessage.content,
  }).toLowerCase();
  for (const proibido of ['hermes', 'session_id', 'stream_id', 'enabled_toolsets',
    'no_mcp', 'toolset', 'gpt-', 'openai-codex', 'hermes_home', '/runtime/']) {
    ok(!superficie.includes(proibido.toLowerCase()), `"${proibido}" não aparece`);
  }

  // ── 3 · o binding foi gravado ───────────────────────────────────────────
  console.log('\n3. binding de sessão:');
  const vinculos = db.prepare('SELECT * FROM runtime_sessions WHERE threadId = ?').all(t1.id);
  ok(vinculos.length === 1, 'a sessão foi gravada, e só uma');
  ok(vinculos[0]?.runtimeId === 'hermes', 'gravada para o runtime certo');

  // ── 4 · shell continua indisponível ─────────────────────────────────────
  console.log('\n4. isolamento (terminal/shell):');
  const r2 = await sendMessage(
    { threadId: t1.id, content: 'Execute `pwd` no terminal e me diga o resultado.' },
    { db, runtime },
  );
  const eventosDeTool = r2.events.filter((e) => [
    AGENT_EVENTS.TOOL_STARTED, AGENT_EVENTS.TOOL_COMPLETED, AGENT_EVENTS.TOOL_FAILED,
  ].includes(e.type));
  console.log(`    resposta: ${JSON.stringify(r2.assistantMessage.content.slice(0, 160))}`);
  // A palavra "terminal" APARECE na resposta — o usuário perguntou por ela e o
  // agente disse que não a tem. Isso é a conversa funcionando. O que precisa
  // ser zero é ferramenta invocada.
  ok(eventosDeTool.length === 0, 'nenhuma ferramenta foi invocada');
  ok(!JSON.stringify(eventosDeTool).includes('terminal'),
    'nenhum evento de ferramenta cita terminal');

  // ── 5 · imagem real, só com --image ─────────────────────────────────────
  if (COM_IMAGEM) {
    console.log('\n5. geração de imagem real (Ideogram):');
    const t2 = createThread({ projectId: project.id, title: 'Smoke imagem' }, { db });
    const r3 = await sendMessage({
      threadId: t2.id,
      content: 'Gere uma imagem de um farol solitário ao amanhecer. '
        + 'Use a ferramenta de geração de imagem e me diga o jobId.',
    }, { db, runtime });

    const iniciadas = r3.events.filter((e) => e.type === AGENT_EVENTS.TOOL_STARTED);
    const concluidas = r3.events.filter((e) => e.type === AGENT_EVENTS.TOOL_COMPLETED);

    console.log(`    tools iniciadas: ${JSON.stringify(iniciadas.map((e) => e.name))}`);
    console.log(`    resposta: ${JSON.stringify(r3.assistantMessage.content.slice(0, 240))}`);

    ok(iniciadas.length > 0, 'o agente usou uma ferramenta');
    ok(iniciadas.every((e) => e.name.startsWith('og.')),
      'os eventos usam o nome canônico (og.*), não o alias');
    ok(!JSON.stringify(r3.events).includes('og_generate'),
      'o alias do runtime não aparece nos eventos');
    ok(concluidas.length > 0, 'a ferramenta concluiu');

    // O job é assíncrono e vive na MEMÓRIA deste processo (comfy/jobs.js guarda
    // num Map em globalThis). Então esperar por ele tem de acontecer aqui —
    // outro processo simplesmente não o enxerga.
    //
    // A espera usa o MESMO caminho do runtime: og_get_job pelo bridge. É o
    // caminho real, não um atalho pelo domínio.
    const jobId = extrairJobId(r3.assistantMessage.content);
    ok(Boolean(jobId), `o agente informou o jobId (${jobId ?? 'nenhum'})`);

    if (jobId) {
      console.log('    aguardando a geração (og.get_job pelo bridge, como o runtime faria)...');
      const final = await esperarJob(jobId, t2.id, db);
      console.log(`    estado final: ${JSON.stringify(final).slice(0, 260)}`);

      // As três fases, separadas — foi a confusão entre elas que fez o smoke do
      // PASSO 7B parecer completo quando a última nunca acontecia.
      console.log('\n    fase 1 · Hermes/tool-call:');
      ok(iniciadas.length > 0 && concluidas.length > 0, 'o runtime chamou a tool e ela concluiu');

      console.log('    fase 2 · submissão da geração:');
      ok(final?.jobId === jobId, 'o job existe e responde pelo bridge');
      ok(final?.status != null, `o job reportou estado ("${final?.status}")`);

      console.log('    fase 3 · finalização do Asset:');
      ok(final?.status === 'concluido', 'a geração chegou a concluído');
      ok(final?.assetId != null, 'o Asset foi criado');
      ok(final?.asset?.mediaUrl != null, 'o Asset tem mediaUrl utilizável');

      if (final?.assetId) {
        console.log(`      assetId:  ${final.assetId}`);
        console.log(`      mediaUrl: ${final.asset?.mediaUrl}`);
        console.log(`      mimeType: ${final.asset?.mimeType}`);

        // Idempotência no caminho REAL, não só no teste determinístico.
        const repetida = await consultarPeloBridge(jobId, t2.id, db);
        ok(repetida?.assetId === final.assetId,
          'a segunda consulta devolve o MESMO assetId');
        const linhas = db.prepare(
          'SELECT COUNT(*) AS n FROM assets WHERE jobId = ?',
        ).get(jobId);
        ok(linhas.n === 1, `existe exatamente 1 Asset para o job (achei ${linhas.n})`);
      }

      const assets = db.prepare(
        'SELECT id, kind, jobId FROM assets WHERE projectId = ? ORDER BY createdAt DESC LIMIT 3',
      ).all(project.id);
      console.log(`    assets no projeto: ${assets.length}`);
    }
  } else {
    console.log('\n5. geração de imagem: PULADA (rode com --image)');
  }
} finally {
  await bridge.close();
}

/** O jobId que o agente citou na resposta. */
function extrairJobId(texto) {
  const achado = String(texto || '').match(/\b((?:cinema|job)_[A-Za-z0-9_]+)\b/);
  return achado ? achado[1] : null;
}

/**
 * Espera a geração terminar, consultando pelo bridge.
 *
 * Usa a sessão da thread da IMAGEM — a mesma que o runtime usaria. Se não
 * houver sessão gravada para ela, a consulta é feita direto pelo registry, que
 * é o que o bridge faria depois de resolver o vínculo.
 */
async function consultarPeloBridge(jobId, threadId, bd) {
  const { handleBridgeInvocation } = await import('../lib/server/agent/hermes/bridge.js');
  const vinculo = bd.prepare('SELECT sessionId FROM runtime_sessions WHERE threadId = ?').get(threadId);
  if (!vinculo) return null;
  const r = await handleBridgeInvocation({
    sessionId: vinculo.sessionId, toolName: 'og_get_job', arguments: { jobId },
  }, { db: bd });
  return r.ok ? r.result : null;
}

async function esperarJob(jobId, threadIdImagem, bd) {
  const { handleBridgeInvocation } = await import('../lib/server/agent/hermes/bridge.js');
  const vinculo = bd.prepare(
    'SELECT sessionId FROM runtime_sessions WHERE threadId = ?',
  ).get(threadIdImagem);

  if (!vinculo) return { erro: 'sem sessão para a thread da imagem' };

  let ultimo = null;
  for (let i = 0; i < 30; i += 1) {
    const resposta = await handleBridgeInvocation({
      sessionId: vinculo.sessionId, toolName: 'og_get_job', arguments: { jobId },
    }, { db: bd });

    if (!resposta.ok) return { erro: resposta.error?.code };
    ultimo = resposta.result || {};
    if (ultimo.assetId || /conclu|falh|erro/i.test(String(ultimo.status || ''))) return ultimo;
    await new Promise((r) => setTimeout(r, 5000));
  }
  return ultimo ?? { erro: 'sem resposta' };
}

console.log(`\n${falhas === 0 ? 'SMOKE OK' : `SMOKE COM ${falhas} FALHA(S)`}`);
process.exit(falhas === 0 ? 0 : 1);
