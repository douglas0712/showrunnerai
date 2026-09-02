import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REDIGIDO, encurtarCaminhos, nomeDeArquivo, redigirCaminhos, resumirFila, resumirGrafo,
  resumirProbe, sanitize, sanitizeChecks, sanitizeHeaders, sanitizeRequestBody,
  sanitizeResponseBody, sanitizeStack, truncarTexto,
} from '../lib/server/logs/sanitize.js';

test('campos secretos são redigidos em qualquer profundidade', () => {
  const saida = sanitize({
    api_key: 'sk-123',
    authorization: 'Bearer abc',
    cookie: 'sessao=1',
    aninhado: { token: 'tok', 'x-api-key': 'k', senha: 'p', normal: 'visível' },
  });

  assert.equal(saida.api_key, REDIGIDO);
  assert.equal(saida.authorization, REDIGIDO);
  assert.equal(saida.cookie, REDIGIDO);
  assert.equal(saida.aninhado.token, REDIGIDO);
  assert.equal(saida.aninhado['x-api-key'], REDIGIDO);
  assert.equal(saida.aninhado.senha, REDIGIDO);
  assert.equal(saida.aninhado.normal, 'visível');
});

test('as variantes de nome de segredo são pegas', () => {
  const nomes = [
    'apiKey', 'API_KEY', 'accessKey', 'private_key', 'credentials',
    'sessionId', 'set-cookie', 'bearerToken', 'PASSWORD',
  ];
  for (const nome of nomes) {
    assert.equal(sanitize({ [nome]: 'x' })[nome], REDIGIDO, `${nome} deveria ser redigido`);
  }
});

test('nenhuma variável de ambiente atravessa a sanitização', () => {
  const saida = sanitize({ env: { HOME: '/home/x', OPENAI_API_KEY: 'sk', AWS_SECRET: 's' } });
  assert.equal(saida.env.OPENAI_API_KEY, REDIGIDO);
  assert.equal(saida.env.AWS_SECRET, REDIGIDO);
});

test('valores circulares não travam a sanitização', () => {
  const a = { nome: 'a' };
  a.eu = a;
  assert.equal(sanitize(a).eu, '[circular]');
});

test('a profundidade é limitada', () => {
  const fundo = { a: { b: { c: { d: { e: { f: 'muito fundo' } } } } } };
  assert.equal(sanitize(fundo).a.b.c.d, '[…]');
});

test('textos longos são truncados com a contagem do resto', () => {
  const saida = truncarTexto('x'.repeat(1000), 100);
  assert.ok(saida.startsWith('x'.repeat(100)));
  assert.ok(saida.includes('+900 caracteres'));
});

test('listas longas são recortadas', () => {
  const saida = sanitize(Array.from({ length: 100 }, (_, i) => i), { itens: 5 });
  assert.equal(saida.length, 6);
  assert.equal(saida[5], '[+95 itens]');
});

test('bytes nunca entram no log', () => {
  const saida = sanitize({ arquivo: Buffer.from('conteúdo do vídeo') });
  assert.match(saida.arquivo, /^\[binário \d+ bytes\]$/);
});

test('cabeçalhos passam por lista de permitidos', () => {
  const saida = sanitizeHeaders({
    'content-type': 'application/json',
    authorization: 'Bearer segredo',
    cookie: 'a=1',
    'x-custom-interno': 'valor',
  });

  assert.deepEqual(Object.keys(saida), ['content-type']);
});

test('cabeçalhos ausentes devolvem null em vez de objeto vazio', () => {
  assert.equal(sanitizeHeaders({ authorization: 'x' }), null);
  assert.equal(sanitizeHeaders(null), null);
});

test('o grafo do workflow vira resumo, não cópia', () => {
  const grafo = {
    92: { class_type: 'SaveVideo', inputs: { filename_prefix: 'video/showrunner/cinema_x' } },
    '105:6': { class_type: 'UNETLoader', inputs: { unet_name: 'modelo.safetensors' } },
    '105:11': { class_type: 'VAELoader' },
    '105:24': { class_type: 'VAELoader' },
  };
  const resumo = resumirGrafo(grafo);

  assert.equal(resumo.nos, 4);
  assert.ok(resumo.classes.includes('VAELoader×2'));
  assert.ok(!JSON.stringify(resumo).includes('modelo.safetensors'));
});

test('o corpo do POST /prompt troca o grafo pelo resumo e esconde o client_id', () => {
  const saida = sanitizeRequestBody({
    prompt: { 1: { class_type: 'SaveVideo' } },
    client_id: 'showrunner-uuid',
  });

  assert.equal(saida.grafo.nos, 1);
  assert.equal(saida.client_id, REDIGIDO);
  assert.equal(saida.prompt, undefined);
});

test('uma resposta de histórico vira contagem em vez de despejo', () => {
  const historico = {
    'prompt-1': { status: { status_str: 'success' }, outputs: {}, prompt: [1, 'x', { grande: true }] },
    'prompt-2': { status: { status_str: 'error' }, outputs: {} },
  };
  const saida = sanitizeResponseBody(historico);

  assert.equal(saida.entradas, 2);
  assert.deepEqual(saida.prompt_ids, ['prompt-1', 'prompt-2']);
  assert.equal(saida.status['prompt-2'], 'error');
});

test('a fila vira contagem', () => {
  const saida = resumirFila({ queue_running: [[1, 'a']], queue_pending: [[2, 'b'], [3, 'c']] });
  assert.deepEqual(saida, { executando: 1, pendentes: 2 });
});

test('o resumo do ffprobe mantém só o que diagnostica', () => {
  const saida = resumirProbe({
    duration: 5.2, bytes: 1024, hasVideo: true, hasAudio: false,
    width: 848, height: 480, fps: 24, videoCodec: 'h264',
  });

  assert.equal(saida.duracaoSegundos, 5.2);
  assert.equal(saida.temVideo, true);
  assert.equal(saida.codec, 'h264');
});

test('caminhos absolutos viram só o nome do arquivo', () => {
  assert.equal(
    nomeDeArquivo('/media/douglas/SSD2/comfyui_data/workflows/minimax_h3_t2v_api.json'),
    'minimax_h3_t2v_api.json',
  );
  assert.equal(nomeDeArquivo(null), null);
});

test('a raiz do projeto some dos textos livres', () => {
  const texto = encurtarCaminhos('erro em /projeto/lib/server/comfy/provider.js:12', '/projeto');
  assert.ok(!texto.includes('/projeto/lib'));
  assert.ok(texto.includes('provider.js:12'));
});

test('o stack trace é encurtado e limitado em linhas', () => {
  const erro = new Error('quebrou');
  erro.stack = ['Error: quebrou', ...Array.from({ length: 40 }, (_, i) => `    at fn${i} (/a/b/c/d/e.js:${i})`)].join('\n');

  const saida = sanitizeStack(erro, 5);
  assert.equal(saida.split('\n').length, 5);
  assert.ok(saida.startsWith('Error: quebrou'));
});

test('sanitizeStack aceita erro sem stack', () => {
  assert.equal(sanitizeStack({}), null);
  assert.equal(sanitizeStack(null), null);
});


// ── redação de caminhos absolutos ───────────────────────────────────────────

test('caminhos sob raízes do sistema viram só o nome do arquivo', () => {
  assert.equal(
    redigirCaminhos('/media/alguem/SSD2/comfyui_data/workflows/minimax.json'),
    '…/minimax.json',
  );
  assert.equal(redigirCaminhos('/home/alguem/.cache/modelo.safetensors'), '…/modelo.safetensors');
  assert.equal(redigirCaminhos('/mnt/disco/pasta/x.png'), '…/x.png');
});

test('a estrutura de diretórios da máquina não sobrevive à redação', () => {
  const saida = redigirCaminhos('lido de /media/douglas/SSD2/comfyui_data/workflows/w.json');
  assert.ok(!saida.includes('douglas'));
  assert.ok(!saida.includes('SSD2'));
  assert.ok(!saida.includes('comfyui_data'));
  assert.ok(saida.includes('w.json'));
});

test('URLs internas da aplicação sobrevivem intactas', () => {
  // Regressão: `/api/media/...` contém "/media/" e era destruído pela redação,
  // levando junto o link que o usuário clica para ver o resultado.
  const url = '/api/media/video/avulso/cinema_x.mp4';
  assert.equal(redigirCaminhos(url), url);
  assert.equal(
    redigirCaminhos(`Vídeo publicado no player: ${url}`),
    `Vídeo publicado no player: ${url}`,
  );
});

test('caminhos relativos e rotas do ComfyUI não são tocados', () => {
  assert.equal(redigirCaminhos('runtime/logs/comfy.ndjson'), 'runtime/logs/comfy.ndjson');
  assert.equal(redigirCaminhos('/history/390e6618'), '/history/390e6618');
  assert.equal(redigirCaminhos('/view?filename=a.mp4&subfolder=video%2Fshowrunner'), '/view?filename=a.mp4&subfolder=video%2Fshowrunner');
});

test('a redação alcança strings dentro de objetos sanitizados', () => {
  const saida = sanitize({ erro: 'falhou em /media/x/y/z/arquivo.json', nivel: 2 });
  assert.equal(saida.erro, 'falhou em …/arquivo.json');
  assert.equal(saida.nivel, 2);
});

test('as checagens de conexão saem sem caminho absoluto', () => {
  const saida = sanitizeChecks([
    { nome: 'Workflow', ok: true, detalhe: '17 nós validados em /media/alguem/wf/minimax.json' },
    { nome: 'Fila', ok: true, detalhe: 'vazia' },
    { nome: 'Servidor', ok: false, detalhe: null },
  ]);

  assert.equal(saida[0].detalhe, '17 nós validados em …/minimax.json');
  assert.equal(saida[1].detalhe, 'vazia');
  assert.equal(saida[2].detalhe, null);
  assert.equal(saida[2].ok, false);
});

test('sanitizeChecks tolera entrada que não é lista', () => {
  assert.equal(sanitizeChecks(null), null);
  assert.equal(sanitizeChecks('nada'), null);
});

test('encurtarCaminhos continua removendo a raiz do projeto', () => {
  const saida = encurtarCaminhos('em /projeto/lib/server/x.js:12', '/projeto');
  assert.ok(!saida.includes('/projeto/lib'));
  assert.ok(saida.includes('x.js:12'));
});
