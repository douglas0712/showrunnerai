// Trava arquitetural da camada de agente.
//
// O Showrunner é o produto; o runtime que raciocina é peça trocável. Essa
// frase só continua verdadeira enquanto ninguém acrescentar, em `gateway.js`,
// um `if` que conhece o runtime instalado — e é exatamente o tipo de linha que
// entra sem ninguém notar, para "resolver rapidinho" um caso.
//
// Estes testes varrem o código-fonte de `lib/server/agent/` e falham se a
// camada passar a conhecer:
//
//   um runtime específico   (o nome do produto que raciocina)
//   o ComfyUI               (nó, grafo, endpoint, workflow)
//   um modelo               (MiniMax, Ideogram)
//   a interface             (React, components/, StudioContext, localStorage)
//   o Next                  (`next/server` — a rota importa o gateway, jamais
//                            o contrário; é isso que a mantém testável)
//
// A exceção prevista, quando existir, é `adapters/HermesRuntimeAdapter.js` —
// é o lugar onde conhecer aquele runtime é a função do arquivo. Ela já está
// escrita na regra abaixo, e o teste também confere que ela ainda não existe.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../lib/server/agent/', import.meta.url));
const RAIZ_ROTAS = fileURLToPath(new URL('../app/api/agent/', import.meta.url));

/**
 * O único arquivo que poderá citar o runtime que o encapsula, quando existir.
 * Enquanto não existir, a lista serve de documentação da exceção.
 */
const ADAPTADOR_DEDICADO = 'adapters/HermesRuntimeAdapter.js';

async function arquivosDe(raiz, prefixo = '') {
  const entradas = await readdir(path.join(raiz, prefixo), { withFileTypes: true });
  const arquivos = [];
  for (const entrada of entradas) {
    const relativo = path.posix.join(prefixo, entrada.name);
    if (entrada.isDirectory()) {
      arquivos.push(...await arquivosDe(raiz, relativo));
    } else if (entrada.name.endsWith('.js')) {
      arquivos.push(relativo);
    }
  }
  return arquivos.sort();
}

/**
 * Comentários fora, para que a proibição valha sobre CÓDIGO.
 *
 * Vários arquivos desta camada explicam, em comentário, por que não conhecem
 * o ComfyUI ou qual runtime entra depois — e essa explicação é o que mantém a
 * decisão viva para quem chegar. Proibir a palavra no comentário apagaria a
 * razão junto com o risco.
 */
function apenasCodigo(fonte) {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((linha) => linha.replace(/\/\/.*$/, '')).join('\n');
}

const FONTES = new Map();
for (const relativo of await arquivosDe(RAIZ)) {
  FONTES.set(relativo, apenasCodigo(await readFile(path.join(RAIZ, relativo), 'utf8')));
}

test('a camada de agente tem os arquivos que esta etapa previu', () => {
  // PASSO 6: Tools foram adicionadas deliberadamente. A lista agora inclui
  // lib/server/agent/tools/ e seus handlers.
  assert.deepEqual([...FONTES.keys()], [
    'AgentRuntimePort.js',
    'adapters/EchoRuntimeAdapter.js',
    'events.js',
    'gateway.js',
    'httpApi.js',
    'index.js',
    'runtimes.js',
    'threads.js',
    'tools/handlers/generateImage.js',
    'tools/handlers/generateVideo.js',
    'tools/handlers/getJob.js',
    'tools/index.js',
    'tools/registry.js',
    'tools/schema.js',
  ]);
});

// ── 18 · nenhum runtime específico é conhecido ──────────────────────────────

test('18. o Gateway não conhece nenhum runtime pelo nome — nem o Echo', () => {
  const gateway = FONTES.get('gateway.js');

  // O gateway não cita adaptador nenhum. Ele recebe um objeto que cumpre o
  // AgentRuntimePort e não pergunta de onde veio.
  for (const nome of [/hermes/i, /\becho\b/i, /EchoRuntimeAdapter/, /adapters\//]) {
    assert.ok(!nome.test(gateway), `gateway.js cita ${nome}`);
  }

  // A única coisa que ele importa sobre runtimes é o contrato e a fábrica.
  const importados = [...gateway.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(importados.sort(), [
    '../domain/db.js',
    '../domain/projects.js',
    '../logs/logger.js',
    '../logs/stages.js',
    './AgentRuntimePort.js',
    './events.js',
    './runtimes.js',
    './threads.js',
  ]);
});

test('18b. nenhum arquivo da camada cita um runtime de terceiro', () => {
  for (const [arquivo, codigo] of FONTES) {
    if (arquivo === ADAPTADOR_DEDICADO) continue;
    assert.ok(!/hermes/i.test(codigo), `${arquivo} cita Hermes em código`);
  }
});

test('18c. o adaptador dedicado ainda não existe — esta etapa não integra nada', () => {
  assert.ok(
    !FONTES.has(ADAPTADOR_DEDICADO),
    'o adaptador do runtime externo apareceu antes do passo que o prevê',
  );
  // E só um adaptador existe hoje.
  assert.deepEqual(
    [...FONTES.keys()].filter((f) => f.startsWith('adapters/')),
    ['adapters/EchoRuntimeAdapter.js'],
  );
});

test('18d. só runtimes.js sabe quais runtimes existem', () => {
  for (const [arquivo, codigo] of FONTES) {
    if (arquivo === 'runtimes.js') continue;
    assert.ok(
      !/adapters\//.test(codigo),
      `${arquivo} alcança um adaptador direto; a seleção é de runtimes.js`,
    );
  }
  assert.match(FONTES.get('runtimes.js'), /adapters\/EchoRuntimeAdapter\.js/);
});

// ── anti-lock-in: geração, modelos, ComfyUI ─────────────────────────────────

test('a camada de agente não conhece o ComfyUI, nem workflow, nem nó', () => {
  // PASSO 6: Tools podem usar generation/facade (high-level API).
  // Facade conhece ComfyUI internamente, mas tools não devem importar comfy/* direto.
  // Essa trava impede acoplamento direto do agent com ComfyUI.
  const proibidos = [
    /from.*comfy/i,  // Nenhum import direto de comfy/ (includes comfy/jobs.js, comfy/provider.js, etc)
    /ComfyError/,
    /workflow/i,
    /\bgraph\b/i,
    /nodeIds?/,
    /prompt_id/,
    /\/prompt\b/,
    /\/history\b/,
    /\/interrupt\b/,
    /SaveImage/,
    /SaveVideo/,
    /CLIPTextEncode/,
    /UNETLoader/,
    /ResolutionSelector/,
  ];

  for (const [arquivo, codigo] of FONTES) {
    for (const proibido of proibidos) {
      assert.ok(!proibido.test(codigo), `${arquivo} cita ${proibido}`);
    }
  }
});

test('a camada de agente não conhece modelo nenhum', () => {
  for (const [arquivo, codigo] of FONTES) {
    for (const proibido of [/minimax/i, /ideogram/i, /\bflux\b/i, /\bqwen\b/i, /safetensors/]) {
      assert.ok(!proibido.test(codigo), `${arquivo} cita ${proibido}`);
    }
  }
});

test('nenhum id de nó de workflow aparece na camada de agente', () => {
  // Os ids de nó do projeto têm a forma "98:24" ou "37".
  // Aspect ratios como "16:9" NÃO são node IDs — são conceitos públicos legítimos.
  // Apenas nós ComfyUI reais são proibidos (que aparecem em NODE_IDS de workflows).
  // Exemplos reais de node IDs: "105:104" (prompt node em minimax), "92" (save node).
  //
  // A trava agora busca por patterns que indicam acesso explícito a node IDs
  // internos: imports de descriptors, referências a NODE_IDS, citação de nó específico.
  for (const [arquivo, codigo] of FONTES) {
    // Proíbe imports de workflow descriptors que contenham NODE_IDS
    assert.ok(
      !/NODE_IDS|nodeIds/i.test(codigo),
      `${arquivo} cita NODE_IDS ou nodeIds — acesso a node internos de workflow`
    );
    // Proíbe citação direta de nós conhecidos do ComfyUI
    assert.ok(
      !/FRAME_NODE_IDS|ResolutionSelector|SaveVideo|UNETLoader/.test(codigo),
      `${arquivo} cita nó interno específico`
    );
  }
});

// ── 19 · nada de interface ──────────────────────────────────────────────────

test('19. a camada de agente não importa React, components/ nem StudioContext', () => {
  const proibidos = [
    /from\s+'react/, /from\s+"react/, /\breact\b/i,
    /components\//, /StudioContext/, /localStorage/, /sessionStorage/,
    /\bwindow\b/, /\bdocument\b/, /useState|useEffect|useMemo/,
    /lib\/storage/, /\.jsx/,
  ];

  for (const [arquivo, codigo] of FONTES) {
    for (const proibido of proibidos) {
      assert.ok(!proibido.test(codigo), `${arquivo} cita ${proibido}`);
    }
  }
});

test('19b. a camada de agente não importa next/server — a rota é que a importa', () => {
  for (const [arquivo, codigo] of FONTES) {
    assert.ok(!/next\/server/.test(codigo), `${arquivo} importa next/server`);
    assert.ok(!/NextResponse|NextRequest/.test(codigo), `${arquivo} usa a resposta do Next`);
  }
});

test('19c. a camada de agente só importa de si mesma, domínio, log, e tools pode usar generation/facade', () => {
  // PASSO 6: Tools foram adicionadas e podem importar generation/facade.
  // A arquitetura é:
  // - agent/gateway, core: apenas domain/, logs/, si mesmas
  // - agent/tools: pode importar generation/facade (alta nível) mas não comfy (detalhe)
  //
  // Um relativo é resolvido de verdade contra o diretório do arquivo.
  for (const [arquivo, codigo] of FONTES) {
    const importados = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

    for (const alvo of importados) {
      if (alvo.startsWith('node:')) continue;

      assert.ok(alvo.startsWith('.'), `${arquivo} importa "${alvo}" por caminho não relativo`);

      const resolvido = path.posix.normalize(
        path.posix.join(path.posix.dirname(arquivo), alvo),
      );

      // Tools podem importar generation/facade (high-level)
      const isToolFile = arquivo.startsWith('tools/');
      const isFacadeImport = resolvido.startsWith('../generation/facade');

      const permitido = !resolvido.startsWith('..')
        || resolvido.startsWith('../domain/')
        || resolvido.startsWith('../logs/')
        || (isToolFile && isFacadeImport);

      assert.ok(
        permitido,
        `${arquivo} importa "${alvo}" (${resolvido}), fora do que a camada pode alcançar`,
      );
    }
  }
});

// ── as rotas são finas ──────────────────────────────────────────────────────

test('as Route Handlers do agente só validam a forma e delegam', async () => {
  const rotas = await arquivosDe(RAIZ_ROTAS);
  assert.deepEqual(rotas, [
    'messages/route.js',
    'threads/[threadId]/route.js',
    'threads/route.js',
  ]);

  for (const relativo of rotas) {
    const codigo = apenasCodigo(await readFile(path.join(RAIZ_ROTAS, relativo), 'utf8'));

    // Tudo que a rota importa: o Next e a camada de agente sem HTTP.
    const importados = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const alvo of importados) {
      assert.ok(
        alvo === 'next/server' || alvo === '@/lib/server/agent/httpApi',
        `${relativo} importa "${alvo}"`,
      );
    }

    // E nada de regra dentro dela: nem banco, nem runtime, nem persistência.
    for (const proibido of [
      /database\(/, /openDatabase/, /createRuntime/, /appendMessageRecord/,
      /createThreadRecord/, /prepare\(/, /sendMessage\(\{/,
    ]) {
      assert.ok(!proibido.test(codigo), `${relativo} faz o trabalho da camada: ${proibido}`);
    }

    assert.match(codigo, /export const runtime = 'nodejs'/);
    assert.match(codigo, /export const dynamic = 'force-dynamic'/);
  }
});

// ── o gateway não executa geração ───────────────────────────────────────────

test('o Gateway não alcança a camada de geração nem executa mídia', () => {
  // PASSO 6: O CORE GATEWAY (gateway.js, AgentRuntimePort.js, threads.js, etc)
  // continua sem conhecer generation/. Mas tools/* PODEM usar generation/facade.
  // Esta trava protege apenas o core contra acoplamento com geração.
  const proibidos = [
    /submitGeneration/, /finalizeJob/, /publishMediaFile/,
    /mediaTempPath/, /ffmpeg/i, /ffprobe/i,
    /node:child_process/, /node:fs/, /\bfetch\b/,
  ];

  // 'generation/' é permitido apenas em tools/
  const proibidosCore = [...proibidos, /generation\//];

  for (const [arquivo, codigo] of FONTES) {
    // Se é arquivo de tools, permite generation/facade
    if (arquivo.startsWith('tools/')) {
      for (const proibido of proibidos) {
        assert.ok(!proibido.test(codigo), `${arquivo} cita ${proibido}`);
      }
    } else {
      // Core gateway não pode conhecer generation
      for (const proibido of proibidosCore) {
        assert.ok(!proibido.test(codigo), `${arquivo} (core) cita ${proibido}`);
      }
    }
  }
});

test('PASSO 6: Tools estão implementadas com segurança arquitetural', () => {
  // PASSO 6 implementou og.generate_image, og.generate_video, og.get_job.
  // Essa trava verifica que sua implementação respeita as restrições:
  // 1. Registry com execute() privado (nunca exposto)
  // 2. Handlers isolados de comfy/ direto
  // 3. Tudo passa por generation/facade (high-level)

  // Tools devem estar nos handlers
  const generateImage = FONTES.get('tools/handlers/generateImage.js');
  const generateVideo = FONTES.get('tools/handlers/generateVideo.js');
  const getJob = FONTES.get('tools/handlers/getJob.js');

  assert.ok(generateImage, 'tools/handlers/generateImage.js deve existir');
  assert.ok(generateVideo, 'tools/handlers/generateVideo.js deve existir');
  assert.ok(getJob, 'tools/handlers/getJob.js deve existir');

  assert.match(generateImage, /og\.generate_image/,
    'generateImage deve implementar og.generate_image');
  assert.match(generateVideo, /og\.generate_video/,
    'generateVideo deve implementar og.generate_video');
  assert.match(getJob, /og\.get_job/,
    'getJob deve implementar og.get_job');

  const registry = FONTES.get('tools/registry.js');
  assert.match(registry, /publicToolList/,
    'Registry deve expor publicToolList sem execute()');
  assert.match(registry, /invoke:\s*async/,
    'Registry deve ter invoke() para execução segura');

  // Confirma que gateway.js ainda não chama tools (isso é PASSO 7)
  const gateway = FONTES.get('gateway.js');
  assert.ok(!/registry\.invoke|tool.*execute/i.test(gateway),
    'Gateway (PASSO 7) ainda não invoca tools');
});
