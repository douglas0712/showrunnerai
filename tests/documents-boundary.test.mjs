// As fronteiras da ingestão de documentos.
//
// PASSO 11. Três travas estruturais, todas varrendo o código-fonte — o mesmo
// método de `agent-architecture.test.mjs`, e pelo mesmo motivo: são as regras
// que ninguém quebra de propósito, e por isso ninguém percebe quando quebra.
//
//   1. o parser de PDF é EXCLUSIVAMENTE server-side. Ele não pode entrar no
//      bundle do navegador — nem por um import solto, nem por uma cadeia.
//   2. a camada de agente não alcança a ingestão. Ela lê o texto do BANCO; abrir
//      arquivo é trabalho de outra camada, e a separação é o que impede uma
//      ferramenta de virar um leitor de sistema de arquivos.
//   3. a superfície pública não cita caminho, parser, biblioteca nem runtime.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicProjectDocument } from '../lib/server/domain/documents.js';
import { attachmentBriefing } from '../lib/server/agent/attachments.js';
import { labelForTool } from '../lib/agentClient.js';

const PROJETO = fileURLToPath(new URL('../', import.meta.url));

/** Comentários fora: a proibição vale sobre CÓDIGO, e a explicação pode citá-la. */
function apenasCodigo(fonte) {
  return fonte
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((linha) => linha.replace(/\/\/.*$/, '')).join('\n');
}

async function varrer(relativo, extensoes = ['.js', '.jsx', '.mjs']) {
  const raiz = path.join(PROJETO, relativo);
  const saida = [];

  async function descer(dir) {
    let entradas;
    try {
      entradas = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entrada of entradas) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (['node_modules', '.next', 'runtime'].includes(entrada.name)) continue;
        // eslint-disable-next-line no-await-in-loop
        await descer(completo);
      } else if (extensoes.some((e) => entrada.name.endsWith(e))) {
        saida.push(path.relative(PROJETO, completo));
      }
    }
  }

  await descer(raiz);
  return saida.sort();
}

const CLIENTE = [
  ...await varrer('components'),
  ...await varrer('app'),
  // `lib/` na raiz é compartilhado: o que está em `lib/server/` é do servidor,
  // o resto pode acabar no navegador.
  ...(await varrer('lib')).filter((f) => !f.startsWith(`lib${path.sep}server${path.sep}`)),
];

// ── 1 · o parser não entra no navegador ─────────────────────────────────────

test('nenhum arquivo do lado do cliente cita o parser de PDF', async () => {
  assert.ok(CLIENTE.length > 20, 'a varredura não encontrou o código de cliente');

  for (const arquivo of CLIENTE) {
    // eslint-disable-next-line no-await-in-loop
    const codigo = apenasCodigo(await readFile(path.join(PROJETO, arquivo), 'utf8'));
    for (const proibido of [/unpdf/, /pdfjs/i, /pdf-parse/, /pdf\.worker/]) {
      assert.equal(proibido.test(codigo), false, `${arquivo} cita ${proibido}`);
    }
  }
});

test('nenhum arquivo do lado do cliente alcança a camada de ingestão', async () => {
  // O navegador fala com `/api/documents`. Ele não importa o extrator, não
  // importa o armazenamento e não conhece o caminho de nada.
  for (const arquivo of CLIENTE) {
    // eslint-disable-next-line no-await-in-loop
    const codigo = apenasCodigo(await readFile(path.join(PROJETO, arquivo), 'utf8'));

    // As rotas de API são server-side e PODEM importar a camada — é o trabalho
    // delas. O que não pode é um componente.
    const ehRota = arquivo.startsWith(`app${path.sep}api${path.sep}`);
    if (ehRota) continue;

    for (const proibido of [
      /server\/documents/, /documents\/ingest/, /documents\/extract/, /documents\/storage/,
      /node:fs/, /runtime\/documents/,
    ]) {
      assert.equal(proibido.test(codigo), false, `${arquivo} cita ${proibido}`);
    }
  }
});

test('só a camada de ingestão carrega o parser, e sob demanda', async () => {
  const arquivos = await varrer('lib/server');
  const citam = [];

  for (const arquivo of arquivos) {
    // eslint-disable-next-line no-await-in-loop
    const codigo = apenasCodigo(await readFile(path.join(PROJETO, arquivo), 'utf8'));
    if (/unpdf/.test(codigo)) citam.push(arquivo);
  }

  assert.deepEqual(citam, [path.join('lib', 'server', 'documents', 'extract.js')]);

  // E o carregamento é DINÂMICO, dentro da função. Um import estático no topo
  // faria o empacotador arrastar o parser por toda cadeia que passe por aqui —
  // foi assim que um `node:child_process` derrubou toda rota no PASSO 10.4.
  const extrator = await readFile(
    path.join(PROJETO, 'lib', 'server', 'documents', 'extract.js'), 'utf8',
  );
  assert.match(extrator, /await import\('unpdf'\)/);
  assert.equal(/^import .*unpdf/m.test(extrator), false, 'o parser é importado estaticamente');
});

// ── 2 · a camada de agente não alcança a ingestão ───────────────────────────

test('a camada de agente lê o texto do banco, e nunca abre um arquivo', async () => {
  const arquivos = await varrer('lib/server/agent');

  for (const arquivo of arquivos) {
    // eslint-disable-next-line no-await-in-loop
    const codigo = apenasCodigo(await readFile(path.join(PROJETO, arquivo), 'utf8'));
    for (const proibido of [
      /unpdf/, /documents\/ingest/, /documents\/extract/, /documents\/storage/,
      /DOCUMENTS_ROOT/, /runtime\/documents/, /source\.pdf/,
    ]) {
      assert.equal(proibido.test(codigo), false, `${arquivo} cita ${proibido}`);
    }
  }
});

test('a camada de ingestão não conhece agente, conversa nem runtime', async () => {
  const arquivos = await varrer('lib/server/documents');
  assert.deepEqual(arquivos.map((f) => path.basename(f)).sort(), [
    'config.js', 'extract.js', 'httpApi.js', 'ingest.js', 'storage.js',
  ]);

  for (const arquivo of arquivos) {
    // eslint-disable-next-line no-await-in-loop
    const codigo = apenasCodigo(await readFile(path.join(PROJETO, arquivo), 'utf8'));
    for (const proibido of [
      /hermes/i, /agent\//, /threadId/, /sessionId/, /runtime\.run/,
      /comfy\/client/, /generation\//, /\bwindow\b/, /localStorage/, /next\/server/,
    ]) {
      assert.equal(proibido.test(codigo), false, `${arquivo} cita ${proibido}`);
    }
  }
});

// ── 3 · a superfície pública ────────────────────────────────────────────────

test('a forma pública de um documento não carrega nada de infraestrutura', () => {
  const publico = publicProjectDocument({
    id: 'doc_x',
    projectId: 'proj_a',
    filename: 'Prometeu.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    sha256: 'f'.repeat(64),
    pageCount: 27,
    textLength: 41000,
    createdAt: 1,
  });

  const texto = JSON.stringify(publico);
  for (const proibido of [
    'sha256', 'f'.repeat(64), 'runtime', 'documents/', 'source.pdf',
    'storagePath', 'absolutePath', 'unpdf', 'hermes', 'bridge', 'projectId',
  ]) {
    assert.equal(texto.includes(proibido), false, `"${proibido}" vazou`);
  }

  // E o que a tela precisa continua lá.
  assert.equal(publico.filename, 'Prometeu.pdf');
  assert.equal(publico.pageCount, 27);
});

test('o aviso privado do turno não carrega nada de infraestrutura', () => {
  const aviso = attachmentBriefing([{
    documentId: 'doc_x', filename: 'Prometeu.pdf', mimeType: 'application/pdf',
    pageCount: 27, textLength: 41000,
  }]);

  for (const proibido of [
    'runtime/', 'source.pdf', 'sha256', 'projectId', 'threadId', 'sessionId',
    'hermes', 'bridge', 'unpdf', 'og_', '/api/',
  ]) {
    assert.equal(aviso.includes(proibido), false, `"${proibido}" entrou no aviso`);
  }
});

test('a tela fala das ferramentas de documento em linguagem de produção', () => {
  // Nada de nome de ferramenta, nada de alias, nada de mecanismo.
  for (const nome of ['project.list_documents', 'project.read_document']) {
    for (const estado of ['running', 'done']) {
      const rotulo = labelForTool(nome, estado);
      assert.ok(rotulo && rotulo !== 'Trabalhando…' && rotulo !== 'Concluído',
        `${nome}/${estado} caiu no rótulo genérico`);
      for (const proibido of ['project.', 'project_', '_document', 'tool', 'cursor', 'chunk']) {
        assert.equal(rotulo.includes(proibido), false, `"${proibido}" apareceu no rótulo`);
      }
    }
  }

  assert.equal(labelForTool('project.read_document', 'running'), 'Lendo o documento…');
});

// ── a rota é fina ───────────────────────────────────────────────────────────

test('a rota de documentos só lê o corpo e delega', async () => {
  const codigo = apenasCodigo(
    await readFile(path.join(PROJETO, 'app', 'api', 'documents', 'route.js'), 'utf8'),
  );

  const importados = [...codigo.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(importados.sort(), [
    '@/lib/server/documents/httpApi',
    'next/server',
  ]);

  // Nada de regra dentro dela: nem banco, nem parser, nem sistema de arquivos.
  for (const proibido of [
    /database\(/, /openDatabase/, /ingestDocument/, /extractDocument/,
    /createProjectDocument/, /node:fs/, /unpdf/, /prepare\(/,
  ]) {
    assert.equal(proibido.test(codigo), false, `a rota faz o trabalho da camada: ${proibido}`);
  }

  assert.match(codigo, /export const runtime = 'nodejs'/);
  assert.match(codigo, /export const dynamic = 'force-dynamic'/);
});
