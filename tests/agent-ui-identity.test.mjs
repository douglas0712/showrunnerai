// A identidade do produto na superfície que o usuário vê.
//
// A interface fala com o Showrunner. Qual runtime raciocina por trás é detalhe
// de instalação, e a tela não deve nem poder aprender essa palavra: uma UI que
// a aprendesse passaria a depender dela, e trocar o runtime deixaria de ser
// uma linha em runtimes.js.
//
// Varre o código do frontend — componentes e o cliente da conversa — e falha se
// alguma peça interna aparecer. Comentários ficam de fora pelo mesmo motivo de
// sempre: eles explicam por que a fronteira existe, e apagar a explicação junto
// com o risco deixa a próxima pessoa sem a razão.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('../', import.meta.url));

/**
 * O runtime de raciocínio, em qualquer forma. Proibido em TODO o frontend.
 *
 * Estes termos não têm nenhuma razão legítima de existir na interface: são o
 * runtime, a sessão dele, o isolamento dele e o canal privado até ele.
 */
const PROIBIDOS_SEMPRE = [
  /hermes/i,
  /session_id/,
  /stream_id/,
  /enabled_toolsets/,
  /no_mcp/,
  /\btoolset/i,
  /bridge\.sock/,
  /HERMES_HOME/,
  /openai-codex/i,
];

/**
 * Detalhe de produção — proibido na SUPERFÍCIE DO AGENTE, não no Studio inteiro.
 *
 * A distinção é deliberada e importa. A tela de Ajustes tem um campo
 * "ComfyUI — URL", e a de Cinema é um painel de controle explícito dele: ali o
 * nome é a função da tela, e escondê-lo tornaria a configuração impossível.
 *
 * Na conversa com o agente é o oposto. Quem fala com o Showrunner está pedindo
 * uma imagem, não operando um pipeline — e "ComfyUI", "workflowId" ou
 * "promptId" ali seriam vazamento de como a casa funciona por dentro.
 */
const PROIBIDOS_NO_AGENTE = [
  ...PROIBIDOS_SEMPRE,
  /\bcomfyui\b/i,
  /workflowId/,
  /promptId/,
  /runtime\/projects/,
  /ideogram/i,
  /minimax/i,
];

function apenasCodigo(fonte) {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((linha) => linha.replace(/\/\/.*$/, '')).join('\n');
}

async function arquivosDe(dir, filtro) {
  const entradas = await readdir(dir, { withFileTypes: true });
  const saida = [];
  for (const entrada of entradas) {
    const completo = path.join(dir, entrada.name);
    if (entrada.isDirectory()) {
      if (entrada.name === 'node_modules' || entrada.name === '.next') continue;
      saida.push(...await arquivosDe(completo, filtro));
    } else if (filtro(entrada.name)) {
      saida.push(completo);
    }
  }
  return saida;
}

const ehFrontend = (nome) => nome.endsWith('.jsx') || nome.endsWith('.js');

test('NENHUM componente do Studio cita o runtime de raciocínio', async () => {
  const arquivos = await arquivosDe(path.join(RAIZ, 'components'), ehFrontend);
  assert.ok(arquivos.length > 0, 'não achei componente nenhum para varrer');

  for (const arquivo of arquivos) {
    const codigo = apenasCodigo(await readFile(arquivo, 'utf8'));
    for (const proibido of PROIBIDOS_SEMPRE) {
      assert.ok(!proibido.test(codigo),
        `${path.relative(RAIZ, arquivo)} cita ${proibido}`);
    }
  }
});

test('a superfície do agente também não cita detalhe de produção', async () => {
  const superficie = [
    'components/screens/AgentScreen.jsx',
    'lib/agentClient.js',
  ];

  for (const relativo of superficie) {
    const codigo = apenasCodigo(await readFile(path.join(RAIZ, relativo), 'utf8'));
    for (const proibido of PROIBIDOS_NO_AGENTE) {
      assert.ok(!proibido.test(codigo), `${relativo} cita ${proibido}`);
    }
  }
});

test('a AgentScreen fala com a API do Showrunner, e só com ela', async () => {
  const fonte = await readFile(path.join(RAIZ, 'components/screens/AgentScreen.jsx'), 'utf8');
  const codigo = apenasCodigo(fonte);

  // Nenhum endereço além das rotas do próprio Showrunner.
  const urls = [...codigo.matchAll(/['"`](\/api\/[^'"`]*)/g)].map((m) => m[1]);
  for (const url of urls) {
    assert.ok(url.startsWith('/api/agent/') || url.startsWith('/api/media/'),
      `AgentScreen alcança "${url}"`);
  }
  assert.equal(/127\.0\.0\.1|localhost|:87\d\d|:8188/.test(codigo), false,
    'AgentScreen tem endereço de serviço cravado');
});

test('o agente simulado não é mais usado pela AgentScreen', async () => {
  // PASSO 8 substituiu a máquina de estados local pela API real. Dois agentes
  // concorrentes seria a pior das duas opções: um deles ficaria sem manutenção
  // e ninguém saberia qual dos dois respondeu.
  const codigo = await readFile(path.join(RAIZ, 'components/screens/AgentScreen.jsx'), 'utf8');
  assert.equal(codigo.includes('agentScript'), false);
  assert.equal(codigo.includes('demoConversation'), false);
  assert.equal(codigo.includes('placeholderFrame'), false);
  assert.equal(/simulated:\s*true/.test(codigo), false);
});

test('a tela usa o nome do produto', async () => {
  const codigo = await readFile(path.join(RAIZ, 'components/screens/AgentScreen.jsx'), 'utf8');
  assert.match(codigo, /Showrunner/);
});

test('a mídia vem de mediaUrl, nunca montada de caminho de arquivo', async () => {
  const codigo = apenasCodigo(
    await readFile(path.join(RAIZ, 'components/screens/AgentScreen.jsx'), 'utf8'),
  );
  assert.match(codigo, /item\.mediaUrl/);
  // Nada de concatenar diretório com nome de arquivo para formar uma URL.
  assert.equal(/['"`]\/api\/media\/\$\{/.test(codigo), false,
    'a tela monta URL de mídia em vez de usar a que o Asset traz');
});
