// Ingestão de documentos: bytes chegam, documento pronto sai.
//
// PASSO 11. Estes testes exercitam o caminho REAL — parser de PDF de verdade,
// arquivo de verdade no disco, banco de verdade — porque é aqui que moram as
// perguntas que só os bytes respondem: isto é mesmo um PDF? este `.txt` é
// texto? este PDF tem alguma coisa escrita?
//
// Os fixtures são PDFs mínimos escritos à mão, versionados, com fatos
// INVENTADOS: uma cidade que não existe e um prefeito que nunca houve. É a
// única forma de saber que uma resposta veio do documento e não de conhecimento
// prévio. Ver `tests/fixtures/documents/gerar.mjs`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import {
  countDocumentChunks, listProjectDocuments, readDocumentChunks,
} from '../lib/server/domain/documents.js';
import { DOCUMENT_TYPES } from '../lib/server/domain/documentTypes.js';
import {
  detectDocumentType, DocumentIngestionError, ingestDocument,
} from '../lib/server/documents/ingest.js';
import {
  dividir, extractDocument, normalizar, pareceBinario, SEM_TEXTO_EXTRAIVEL,
} from '../lib/server/documents/extract.js';
import { documentDirFor, documentSourcePath } from '../lib/server/documents/storage.js';
import { MAX_CHUNK_CHARS, maxDocumentBytes } from '../lib/server/documents/config.js';
import { handleListDocuments, handleUploadDocument } from '../lib/server/documents/httpApi.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/documents/', import.meta.url));
const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-ingest-'));
test.after(() => rm(RAIZ, { recursive: true, force: true }));

const fixture = (nome) => readFile(path.join(FIXTURES, nome));

let contador = 0;
function cenario() {
  contador += 1;
  const db = openDatabase(':memory:');
  createProject({ id: 'proj_a', name: 'Produção A' }, db);
  createProject({ id: 'proj_b', name: 'Produção B' }, db);
  return { db, root: path.join(RAIZ, `caso-${contador}`) };
}

const texto = (s) => new TextEncoder().encode(s);

// ── 30 · o caminho feliz ────────────────────────────────────────────────────

test('M. um PDF com texto vira documento, com o conteúdo real dentro', async () => {
  const { db, root } = cenario();
  const bytes = await fixture('texto-simples.pdf');

  const doc = await ingestDocument({
    projectId: 'proj_a', filename: 'Arkan Vale.pdf',
    declaredMimeType: 'application/pdf', bytes,
  }, { db, root });

  assert.equal(doc.mimeType, DOCUMENT_TYPES.PDF);
  assert.equal(doc.filename, 'Arkan Vale.pdf');
  assert.equal(doc.pageCount, 1);
  assert.equal(doc.sizeBytes, bytes.length);
  assert.ok(doc.textLength > 100);

  const conteudo = readDocumentChunks(doc.id, {}, db).chunks.map((c) => c.text).join('\n');
  // O. os fatos do fixture estão lá, e são fatos que ninguém sabe de cor.
  assert.match(conteudo, /Arkan Vale/);
  assert.match(conteudo, /17 de marco de 2187/);
  assert.match(conteudo, /Elias Venn/);
  assert.match(conteudo, /4\.812 habitantes/);
});

test('N. um PDF de várias páginas preserva a ordem e o número de cada página', async () => {
  const { db, root } = cenario();

  const doc = await ingestDocument({
    projectId: 'proj_a', filename: 'caderno.pdf',
    declaredMimeType: 'application/pdf', bytes: await fixture('multipagina.pdf'),
  }, { db, root });

  assert.equal(doc.pageCount, 3);

  const { chunks } = readDocumentChunks(doc.id, {}, db);
  assert.deepEqual(chunks.map((c) => c.pageNumber), [1, 2, 3]);
  assert.deepEqual(chunks.map((c) => c.ordinal), [0, 1, 2]);

  // Cada página traz o fato dela, e nenhuma traz o da outra.
  assert.match(chunks[0].text, /QV-7731/);
  assert.match(chunks[1].text, /rio Meridian corre a 240 metros/);
  assert.match(chunks[2].text, /sino do topo se chama Verena/);
  assert.equal(/Verena/.test(chunks[0].text), false);
});

test('P. um TXT em UTF-8 vira documento, sem páginas', async () => {
  const { db, root } = cenario();
  const conteudo = 'A cidade experimental de Arkan Vale foi fundada em 17 de março de 2187.\n'
    + 'Seu primeiro prefeito foi Elias Venn.\n';

  const doc = await ingestDocument({
    projectId: 'proj_a', filename: 'nota.txt',
    declaredMimeType: 'text/plain', bytes: texto(conteudo),
  }, { db, root });

  assert.equal(doc.mimeType, DOCUMENT_TYPES.TEXT);
  assert.equal(doc.pageCount, null);

  const lido = readDocumentChunks(doc.id, {}, db).chunks;
  assert.equal(lido[0].pageNumber, null);
  // O acento sobreviveu inteiro — nenhuma "normalização" o transformou.
  assert.match(lido[0].text, /17 de março de 2187/);
  assert.match(lido[0].text, /Elias Venn/);
});

test('Q. um TXT com BOM é aceito, e o BOM não vira conteúdo', async () => {
  const { db, root } = cenario();
  const bytes = texto('\ufeffArkan Vale foi fundada em 2187.');

  const doc = await ingestDocument({
    projectId: 'proj_a', filename: 'com-bom.txt', declaredMimeType: 'text/plain', bytes,
  }, { db, root });

  const primeiro = readDocumentChunks(doc.id, {}, db).chunks[0].text;
  assert.equal(primeiro.charCodeAt(0), 'A'.charCodeAt(0), 'o BOM ficou no texto');
  assert.equal(primeiro.startsWith('Arkan Vale'), true);
});

// ── 30 · o que é recusado ───────────────────────────────────────────────────

test('R. um tipo não permitido é recusado', async () => {
  const { db, root } = cenario();
  // PNG: assinatura própria, e nenhuma das duas que aceitamos.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

  await assert.rejects(
    () => ingestDocument({
      projectId: 'proj_a', filename: 'foto.png', declaredMimeType: 'image/png', bytes: png,
    }, { db, root }),
    (erro) => erro instanceof DocumentIngestionError && erro.code === 'unsupported_type',
  );

  assert.deepEqual(listProjectDocuments('proj_a', db), []);
});

test('S. um arquivo que se diz PDF e não é, é recusado — e o nome não salva', async () => {
  const { db, root } = cenario();
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 0, 0]);

  // Declarando o MIME de PDF.
  await assert.rejects(
    () => ingestDocument({
      projectId: 'proj_a', filename: 'contrato.pdf',
      declaredMimeType: 'application/pdf', bytes: zip,
    }, { db, root }),
    (erro) => erro instanceof DocumentIngestionError && erro.code === 'not_a_pdf',
  );

  // E sem declarar nada, só com a extensão: a extensão também é declaração.
  await assert.rejects(
    () => ingestDocument({
      projectId: 'proj_a', filename: 'contrato.pdf', declaredMimeType: null, bytes: zip,
    }, { db, root }),
    (erro) => erro.code === 'not_a_pdf',
  );

  // `%PDF-` tem de estar no COMEÇO. Enfiado depois de qualquer coisa, não vale.
  const disfarcado = new Uint8Array([0x47, 0x49, 0x46, 0x38, ...texto('%PDF-1.4\n')]);
  await assert.rejects(
    () => ingestDocument({
      projectId: 'proj_a', filename: 'x.pdf', declaredMimeType: 'application/pdf', bytes: disfarcado,
    }, { db, root }),
    (erro) => erro.code === 'not_a_pdf',
  );
});

test('T. um binário renomeado para .txt é recusado', async () => {
  const { db, root } = cenario();

  const comNul = new Uint8Array([0x68, 0x69, 0x00, 0x68, 0x69, 0x00, 0x68, 0x69, 0x00]);
  const utf8Invalido = new Uint8Array([0xff, 0xfe, 0xc3, 0x28, 0xa0, 0xa1, 0x80, 0x80, 0x80]);
  const cheioDeControle = new Uint8Array(200).fill(0x07);

  for (const bytes of [comNul, utf8Invalido, cheioDeControle]) {
    // eslint-disable-next-line no-await-in-loop
    await assert.rejects(
      () => ingestDocument({
        projectId: 'proj_a', filename: 'disfarce.txt', declaredMimeType: 'text/plain', bytes,
      }, { db, root }),
      (erro) => erro instanceof DocumentIngestionError && erro.code === 'unsupported_type',
    );
  }

  assert.deepEqual(listProjectDocuments('proj_a', db), []);
});

test('T-bis. a mesma pergunta sobre binário é feita por uma função só', () => {
  assert.equal(pareceBinario(texto('texto normal com acentuação e quebra\nde linha')), false);
  assert.equal(pareceBinario(texto('tab\tok\r\ntambém')), false);
  assert.equal(pareceBinario(new Uint8Array([0x61, 0x00, 0x62])), true);
  assert.equal(pareceBinario(new Uint8Array([0xff, 0xfe, 0xfd])), true);
});

test('U. um arquivo acima do limite é recusado antes de qualquer leitura', async () => {
  const { db, root } = cenario();
  const original = process.env.SHOWRUNNER_DOCUMENT_MAX_BYTES;
  process.env.SHOWRUNNER_DOCUMENT_MAX_BYTES = '1024';

  try {
    assert.equal(maxDocumentBytes(), 1024);
    await assert.rejects(
      () => ingestDocument({
        projectId: 'proj_a', filename: 'grande.txt', declaredMimeType: 'text/plain',
        bytes: texto('a'.repeat(2048)),
      }, { db, root }),
      (erro) => erro instanceof DocumentIngestionError && erro.code === 'too_large',
    );
  } finally {
    if (original === undefined) delete process.env.SHOWRUNNER_DOCUMENT_MAX_BYTES;
    else process.env.SHOWRUNNER_DOCUMENT_MAX_BYTES = original;
  }

  // O padrão volta a valer, e é 25 MB.
  assert.equal(maxDocumentBytes(), 25 * 1024 * 1024);
  assert.deepEqual(listProjectDocuments('proj_a', db), []);
});

test('V. um PDF válido SEM texto é recusado, dizendo que OCR não existe', async () => {
  const { db, root } = cenario();
  const bytes = await fixture('sem-texto.pdf');

  await assert.rejects(
    () => ingestDocument({
      projectId: 'proj_a', filename: 'escaneado.pdf',
      declaredMimeType: 'application/pdf', bytes,
    }, { db, root }),
    (erro) => erro instanceof DocumentIngestionError
      && erro.code === 'unreadable'
      && /não possui texto extraível/i.test(erro.message)
      && /OCR/.test(erro.message),
  );

  // Nada meio-pronto: nem linha no banco, nem arquivo órfão no disco.
  //
  // O diretório do PROJETO pode continuar existindo, vazio — ele é criado antes
  // da extração e podar um diretório compartilhado seria disputar com um upload
  // concorrente. O que não pode sobrar é o diretório do DOCUMENTO, porque é ele
  // que guardaria bytes que nenhuma linha do banco menciona.
  assert.deepEqual(listProjectDocuments('proj_a', db), []);
  assert.deepEqual(await entradas(path.join(root, 'proj_a')), []);
});

test('V-bis. a frase do PDF sem texto não inventa conteúdo nem cita o nome do arquivo', async () => {
  const bytes = await fixture('sem-texto.pdf');
  await assert.rejects(
    () => extractDocument(bytes, DOCUMENT_TYPES.PDF),
    (erro) => erro.message === SEM_TEXTO_EXTRAIVEL,
  );
  assert.equal(/\.pdf/.test(SEM_TEXTO_EXTRAIVEL), false);
});

test('projeto inexistente é recusado, e nenhum projeto nasce por causa de um upload', async () => {
  const { db, root } = cenario();

  await assert.rejects(
    () => ingestDocument({
      projectId: 'proj_fantasma', filename: 'x.txt',
      declaredMimeType: 'text/plain', bytes: texto('conteúdo suficiente'),
    }, { db, root }),
    (erro) => erro.code === 'unknown_project',
  );

  assert.equal(db.prepare("SELECT COUNT(*) AS t FROM projects").get().t, 2);
});

// ── 30 · armazenamento e travessia de caminho ───────────────────────────────

test('W. um nome com ../ não escapa do armazenamento — ele nem chega perto do caminho', async () => {
  const { db, root } = cenario();

  const nomes = [
    '../../../../etc/passwd',
    '..\\..\\windows\\system32\\config',
    'nota/../../fora.txt',
    '.env',
    'a'.repeat(400),
  ];

  for (const filename of nomes) {
    // eslint-disable-next-line no-await-in-loop
    const doc = await ingestDocument({
      projectId: 'proj_a', filename, declaredMimeType: 'text/plain',
      bytes: texto(`conteúdo de ${filename}`),
    }, { db, root });

    // O arquivo real está em runtime/documents/<projectId>/<documentId>/source.txt
    const esperado = path.join(root, 'proj_a', doc.id, 'source.txt');
    assert.equal(documentSourcePath('proj_a', doc.id, DOCUMENT_TYPES.TEXT, root), esperado);
    // eslint-disable-next-line no-await-in-loop
    assert.equal((await stat(esperado)).isFile(), true);
  }

  // Tudo caiu debaixo do projeto, e nada saiu da raiz.
  const dentro = await entradas(root);
  assert.deepEqual(dentro, ['proj_a']);
  const porProjeto = await readdir(path.join(root, 'proj_a'));
  assert.equal(porProjeto.length, nomes.length);
  for (const dir of porProjeto) assert.match(dir, /^doc_[A-Za-z0-9_]+$/);

  // E o nome continua existindo, inteiro, como rótulo.
  const guardados = listProjectDocuments('proj_a', db).map((d) => d.filename);
  assert.ok(guardados.includes('../../../../etc/passwd'));
});

test('W-bis. um identificador fora do padrão nunca vira caminho', () => {
  for (const ruim of ['../fuga', 'a/b', 'com espaço', '', 'x'.repeat(65), '.']) {
    assert.throws(() => documentDirFor(ruim, 'doc_ok', RAIZ), /inválido|permitido/i);
    assert.throws(() => documentDirFor('proj_a', ruim, RAIZ), /inválido|permitido/i);
  }
});

test('X. o caminho no disco não aparece em resposta nenhuma, e não é guardado', async () => {
  const { db, root } = cenario();

  const doc = await ingestDocument({
    projectId: 'proj_a', filename: 'pauta.pdf',
    declaredMimeType: 'application/pdf', bytes: await fixture('texto-simples.pdf'),
  }, { db, root });

  const texto1 = JSON.stringify(doc);
  const lista = handleListDocuments({ projectId: 'proj_a' }, { db });
  const texto2 = JSON.stringify(lista.body);

  for (const alvo of [texto1, texto2]) {
    for (const proibido of [root, 'source.pdf', 'runtime/documents', 'absolutePath', 'storagePath', 'sha256']) {
      assert.equal(alvo.includes(proibido), false, `"${proibido}" vazou`);
    }
  }

  // E a tabela também não guarda caminho: não há coluna para isso.
  const colunas = db.prepare('PRAGMA table_info(project_documents)').all().map((c) => c.name);
  assert.deepEqual(colunas.sort(), [
    'createdAt', 'filename', 'id', 'mimeType', 'pageCount', 'projectId',
    'sha256', 'sizeBytes', 'textLength',
  ]);
});

// ── extração: normalização e divisão ────────────────────────────────────────

test('a normalização mexe no mínimo, e não altera o que o documento diz', () => {
  assert.equal(normalizar('linha um\r\nlinha dois\rlinha três'), 'linha um\nlinha dois\nlinha três');
  assert.equal(normalizar('com\u0000nul'), 'comnul');
  assert.equal(normalizar('muitos      espaços'), 'muitos espaços');
  assert.equal(normalizar('  aparado  '), 'aparado');
  // Parágrafo continua sendo parágrafo.
  assert.equal(normalizar('um\n\ndois'), 'um\n\ndois');
  // E o texto em si não é tocado: acento, caixa, pontuação, ordem.
  const original = 'A cidade de Arkan Vale — fundada em 2187 — tem 4.812 habitantes.';
  assert.equal(normalizar(original), original);
});

test('a divisão é determinística e não perde nem duplica um caractere', () => {
  const paragrafos = [];
  for (let i = 0; i < 60; i += 1) {
    paragrafos.push(`Parágrafo ${i}: ${'conteúdo '.repeat(20)}`);
  }
  const inteiro = paragrafos.join('\n\n');

  const partes = dividir(inteiro);
  assert.ok(partes.length > 1, 'este texto deveria ser dividido');
  // A garantia que importa.
  assert.equal(partes.join(''), inteiro);
  for (const parte of partes) {
    assert.ok(parte.length <= MAX_CHUNK_CHARS, `um pedaço passou do tamanho: ${parte.length}`);
  }
  // Determinística: a mesma entrada dá a mesma saída.
  assert.deepEqual(dividir(inteiro), partes);

  // Sem nenhum ponto natural de quebra, corta no teto e continua sem perder nada.
  const semEspaco = 'x'.repeat(MAX_CHUNK_CHARS * 3 + 7);
  const duras = dividir(semEspaco);
  assert.equal(duras.join(''), semEspaco);
  assert.equal(duras.length, 4);
});

test('um TXT grande vira vários pedaços, e a leitura os reconstrói na ordem', async () => {
  const { db, root } = cenario();
  const inteiro = Array.from({ length: 40 }, (_, i) => `Bloco ${i}: ${'texto '.repeat(60)}`).join('\n\n');

  const doc = await ingestDocument({
    projectId: 'proj_a', filename: 'longo.txt', declaredMimeType: 'text/plain',
    bytes: texto(inteiro),
  }, { db, root });

  assert.ok(countDocumentChunks(doc.id, db) > 1);
  const { chunks, eof } = readDocumentChunks(doc.id, {}, db);
  assert.equal(eof, true);
  assert.equal(chunks.map((c) => c.text).join(''), normalizar(inteiro));
});

// ── farejamento de tipo, isolado ────────────────────────────────────────────

test('o tipo real vem dos bytes, e o declarado só desempata o que os bytes não dizem', () => {
  assert.equal(detectDocumentType(texto('%PDF-1.7\n...'), { declaredMimeType: 'text/plain' }), DOCUMENT_TYPES.PDF);
  assert.equal(detectDocumentType(texto('só texto'), { declaredMimeType: 'text/plain' }), DOCUMENT_TYPES.TEXT);
  assert.equal(detectDocumentType(texto('só texto'), { declaredMimeType: '' }), DOCUMENT_TYPES.TEXT);
  assert.equal(detectDocumentType(texto('só texto'), { declaredMimeType: 'text/plain; charset=utf-8' }), DOCUMENT_TYPES.TEXT);
  // Texto com estrutura própria não é tratado como texto puro em silêncio.
  assert.throws(
    () => detectDocumentType(texto('<html><body>oi</body></html>'), { declaredMimeType: 'text/html' }),
    (erro) => erro.code === 'unsupported_type',
  );
});

// ── a API ───────────────────────────────────────────────────────────────────

test('a API devolve 201 com metadata segura, e lista o que o projeto tem', async () => {
  const { db, root } = cenario();

  const criado = await handleUploadDocument({
    projectId: 'proj_a', filename: 'pauta.pdf', declaredMimeType: 'application/pdf',
    bytes: await fixture('texto-simples.pdf'),
  }, { db, root });

  assert.equal(criado.status, 201);
  assert.deepEqual(Object.keys(criado.body.document).sort(), [
    'createdAt', 'filename', 'id', 'mimeType', 'pageCount', 'sizeBytes', 'textLength',
  ]);

  const listado = handleListDocuments({ projectId: 'proj_a' }, { db });
  assert.equal(listado.status, 200);
  assert.equal(listado.body.documents.length, 1);

  // E o projeto B não vê nada do A.
  assert.deepEqual(handleListDocuments({ projectId: 'proj_b' }, { db }).body.documents, []);
});

test('a API traduz cada recusa no status certo, com frase de produto', async () => {
  const { db, root } = cenario();

  const casos = [
    { entrada: { projectId: 'nao/vale', filename: 'x.txt', bytes: texto('abcdefgh') }, status: 400 },
    { entrada: { projectId: 'proj_fantasma', filename: 'x.txt', bytes: texto('abcdefgh') }, status: 422 },
    {
      entrada: {
        projectId: 'proj_a', filename: 'x.pdf', declaredMimeType: 'application/pdf',
        bytes: new Uint8Array([0x50, 0x4b, 3, 4, 0, 0, 0, 0, 0, 0]),
      },
      status: 415,
    },
    {
      entrada: {
        projectId: 'proj_a', filename: 'escaneado.pdf', declaredMimeType: 'application/pdf',
        bytes: await fixture('sem-texto.pdf'),
      },
      status: 422,
    },
  ];

  for (const caso of casos) {
    // eslint-disable-next-line no-await-in-loop
    const r = await handleUploadDocument(caso.entrada, { db, root });
    assert.equal(r.status, caso.status, JSON.stringify(caso.entrada.filename));
    assert.equal(typeof r.body.error, 'string');
    // Nada de pilha, nome de classe, caminho ou nome de biblioteca.
    for (const proibido of ['Error:', 'at ', root, 'unpdf', 'pdf.js', 'node_modules']) {
      assert.equal(r.body.error.includes(proibido), false, `"${proibido}" vazou no erro`);
    }
  }
});

test('acima do limite a API responde 413', async () => {
  const { db, root } = cenario();
  const original = process.env.SHOWRUNNER_DOCUMENT_MAX_BYTES;
  process.env.SHOWRUNNER_DOCUMENT_MAX_BYTES = '512';
  try {
    const r = await handleUploadDocument({
      projectId: 'proj_a', filename: 'grande.txt', declaredMimeType: 'text/plain',
      bytes: texto('a'.repeat(4096)),
    }, { db, root });
    assert.equal(r.status, 413);
  } finally {
    if (original === undefined) delete process.env.SHOWRUNNER_DOCUMENT_MAX_BYTES;
    else process.env.SHOWRUNNER_DOCUMENT_MAX_BYTES = original;
  }
});

async function entradas(dir) {
  try {
    return (await readdir(dir)).sort();
  } catch {
    return [];
  }
}
