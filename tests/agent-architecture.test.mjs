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
  assert.deepEqual([...FONTES.keys()], [
    'AgentRuntimePort.js',
    'adapters/EchoRuntimeAdapter.js',
    'events.js',
    'gateway.js',
    'httpApi.js',
    'index.js',
    'runtimes.js',
    'threads.js',
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
  const proibidos = [
    /comfy/i, /ComfyError/, /workflow/i, /\bgraph\b/i, /nodeIds?/, /prompt_id/,
    /\/prompt\b/, /\/history\b/, /\/interrupt\b/, /SaveImage/, /SaveVideo/,
    /CLIPTextEncode/, /UNETLoader/, /ResolutionSelector/,
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
  // Os ids de nó do projeto têm a forma "98:24" ou "37". O que se procura aqui
  // é o literal de dois campos, que é inconfundível.
  for (const [arquivo, codigo] of FONTES) {
    const suspeitos = codigo.match(/'\d+:\d+'|"\d+:\d+"/g) || [];
    assert.deepEqual(suspeitos, [], `${arquivo} carrega id de nó: ${suspeitos.join(', ')}`);
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

test('19c. a camada de agente só importa de si mesma, do domínio e do log', () => {
  // Um relativo é resolvido de verdade contra o diretório do arquivo: um
  // `../events.js` de dentro de adapters/ continua sendo a própria camada, e
  // um `../../lib/storage.js` não passaria a ser só porque começa com ponto.
  for (const [arquivo, codigo] of FONTES) {
    const importados = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

    for (const alvo of importados) {
      if (alvo.startsWith('node:')) continue;

      assert.ok(alvo.startsWith('.'), `${arquivo} importa "${alvo}" por caminho não relativo`);

      const resolvido = path.posix.normalize(
        path.posix.join(path.posix.dirname(arquivo), alvo),
      );
      const permitido = !resolvido.startsWith('..')
        || resolvido.startsWith('../domain/')
        || resolvido.startsWith('../logs/');

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
  const proibidos = [
    /generation\//, /submitGeneration/, /finalizeJob/, /publishMediaFile/,
    /mediaTempPath/, /createAsset/, /ffmpeg/i, /ffprobe/i,
    /node:child_process/, /node:fs/, /\bfetch\b/,
  ];

  for (const [arquivo, codigo] of FONTES) {
    for (const proibido of proibidos) {
      assert.ok(!proibido.test(codigo), `${arquivo} cita ${proibido}`);
    }
  }
});

test('as tools reais não existem ainda — esta etapa só reserva o argumento', () => {
  for (const [arquivo, codigo] of FONTES) {
    for (const cedo of [/og\.generate_image/, /og\.generate_video/, /og\.get_job/]) {
      assert.ok(!cedo.test(codigo), `${arquivo} implementa tool antes do passo dela`);
    }
  }
  // O argumento, esse, já existe — e chega vazio.
  assert.match(FONTES.get('gateway.js'), /tools:\s*\[\]/);
});
