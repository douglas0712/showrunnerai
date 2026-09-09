// O caminho inteiro, sem runtime de raciocínio real.
//
// PASSO 11. Este arquivo é o que responde "isto funciona?" de ponta a ponta:
//
//     PDF real → ingestão → documento do projeto → anexo do turno
//              → o agente descobre qual arquivo é
//              → chama a ferramenta
//              → percorre o documento até o fim
//              → responde com fatos que só estão no documento
//
// O runtime é um DUPLO roteirizado. Não é limitação: é o ponto. Um teste que
// dependesse de um modelo real provaria que aquele modelo, naquele dia, se
// comportou — e falharia por motivos que não são nossos. O que precisa ser
// determinístico é o CAMINHO: se o agente pedir, o Showrunner entrega o
// conteúdo certo, do projeto certo, na ordem certa, até o fim.
//
// Os fatos dos fixtures são inventados (Arkan Vale, Elias Venn, o sino Verena).
// Uma resposta que os contenha só pode ter vindo do documento.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createThread, getThread, sendMessage } from '../lib/server/agent/gateway.js';
import { attachmentBriefing } from '../lib/server/agent/attachments.js';
import { AGENT_EVENTS, publicAgentEvent } from '../lib/server/agent/events.js';
import { closeDatabase, openDatabase } from '../lib/server/domain/db.js';
import { createProject } from '../lib/server/domain/projects.js';
import { ingestDocument } from '../lib/server/documents/ingest.js';
import { MAX_READ_CHARS } from '../lib/server/domain/documents.js';

const FIXTURES = fileURLToPath(new URL('./fixtures/documents/', import.meta.url));
const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-leitura-'));

const CHAVE = Symbol.for('showrunner.domain.db');

test.after(async () => {
  closeDatabase();
  delete globalThis[CHAVE];
  await rm(RAIZ, { recursive: true, force: true });
});

let contador = 0;

/**
 * Um projeto, uma conversa e um documento REAL já ingerido.
 *
 * As ferramentas abrem o banco da APLICAÇÃO (elas rodam num turno, onde não há
 * injeção a atravessar o socket do plugin), então a instância global é trocada
 * por uma em memória. O `after` acima a devolve.
 */
async function cenario(arquivo) {
  contador += 1;
  closeDatabase();
  const db = openDatabase(':memory:');
  globalThis[CHAVE] = db;

  createProject({ id: 'proj_a', name: 'Produção A' }, db);
  createProject({ id: 'proj_b', name: 'Produção B' }, db);

  const root = path.join(RAIZ, `caso-${contador}`);
  const documento = await ingestDocument({
    projectId: 'proj_a',
    filename: arquivo,
    declaredMimeType: 'application/pdf',
    bytes: await readFile(path.join(FIXTURES, arquivo)),
  }, { db, root });

  const thread = createThread({ projectId: 'proj_a' }, { db });
  const threadB = createThread({ projectId: 'proj_b' }, { db });

  return { db, root, documento, thread, threadB };
}

/**
 * Um runtime que executa um roteiro de chamadas de ferramenta.
 *
 * Ele usa o `invokeTool` que o gateway entrega — o mesmo caminho que o
 * adaptador real usaria se o runtime dele não chamasse de volta por outro
 * canal. O ToolContext, portanto, é o de verdade: montado pelo servidor, com o
 * projeto da conversa.
 */
function runtimeQueLe(plano) {
  const resultados = [];
  const vistos = [];

  return {
    resultados,
    vistos,
    id: 'leitor',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run({ context, invokeTool, messages }) {
      vistos.push({
        context,
        // O que ESTE runtime receberia como fala, com o aviso privado montado —
        // é o mesmo que o adaptador real monta.
        fala: (() => {
          const ultima = [...messages].reverse().find((m) => m.role === 'user');
          const aviso = attachmentBriefing(context?.attachments);
          return aviso ? `${aviso}\n\n${ultima.content}` : ultima.content;
        })(),
      });

      yield { type: AGENT_EVENTS.STARTED, ts: 1 };

      let i = 0;
      for (const passo of plano(context)) {
        i += 1;
        yield {
          type: AGENT_EVENTS.TOOL_STARTED, ts: 1, toolCallId: `c${i}`,
          name: passo.name, arguments: passo.args,
        };

        // eslint-disable-next-line no-await-in-loop
        const resultado = await invokeTool(passo.name, passo.args).then(
          (r) => ({ ok: true, r }),
          (erro) => ({ ok: false, erro: erro.message }),
        );
        resultados.push({ passo, ...resultado });

        yield resultado.ok
          ? {
            type: AGENT_EVENTS.TOOL_COMPLETED, ts: 1, toolCallId: `c${i}`,
            name: passo.name, result: resultado.r,
          }
          : {
            type: AGENT_EVENTS.TOOL_FAILED, ts: 1, toolCallId: `c${i}`,
            name: passo.name, error: { message: resultado.erro, code: 'tool_failed' },
          };
      }

      yield {
        type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1,
        text: resumoDoQueLeu(resultados),
      };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };
}

/**
 * A "resposta" do duplo: os fatos que ele encontrou no que leu.
 *
 * Ela não interpreta nada — copia trechos do que a ferramenta devolveu. É de
 * propósito: o que este teste prova é que o CONTEÚDO CERTO chegou ao agente,
 * não que um modelo saberia usá-lo.
 *
 * O corte em 2000 caracteres não é cosmético: uma mensagem de agente é limitada
 * a MAX_MESSAGE_LENGTH, e um duplo que despejasse uma leitura inteira derrubaria
 * o turno por um motivo que não é o que este teste investiga. Um agente real
 * responde sobre o que leu; ele não transcreve o documento.
 */
function resumoDoQueLeu(resultados) {
  const trechos = resultados
    .filter((r) => r.ok && Array.isArray(r.r?.chunks))
    .flatMap((r) => r.r.chunks.map((c) => c.text));
  if (!trechos.length) return 'Não li nada.';
  return `Li o documento. ${trechos.join(' ')}`.slice(0, 2000);
}

// ── 33 · o turno inteiro, com o documento anexado ───────────────────────────

test('o agente sabe qual arquivo foi anexado e lê o conteúdo real dele', async () => {
  const { db, documento, thread } = await cenario('texto-simples.pdf');

  // O plano: ler o documento que o turno anexou. O id vem do CONTEXTO — do
  // anexo do turno —, e não de um argumento que alguém inventou.
  const runtime = runtimeQueLe((context) => [
    { name: 'project.read_document', args: { documentId: context.attachments[0].documentId } },
  ]);

  const turno = await sendMessage({
    threadId: thread.id,
    content: 'Sobre o que é este documento?',
    documentIds: [documento.id],
  }, { db, runtime });

  // O runtime soube qual arquivo era, pelo aviso privado.
  const { fala, context } = runtime.vistos[0];
  assert.match(fala, /Arkan Vale\.pdf|texto-simples\.pdf/);
  assert.match(fala, new RegExp(documento.id));
  assert.match(fala, /Sobre o que é este documento\?$/);
  assert.equal(context.projectId, 'proj_a');

  // A ferramenta rodou com o ToolContext de verdade e devolveu o conteúdo real.
  const leitura = runtime.resultados[0];
  assert.equal(leitura.ok, true);
  assert.equal(leitura.r.documentId, documento.id);

  // E a resposta gravada contém fatos que SÓ estão no documento.
  assert.match(turno.assistantMessage.content, /Arkan Vale/);
  assert.match(turno.assistantMessage.content, /17 de marco de 2187/);
  assert.match(turno.assistantMessage.content, /Elias Venn/);
});

test('o conteúdo lido NÃO atravessa para o navegador em evento nenhum', async () => {
  const { db, documento, thread } = await cenario('texto-simples.pdf');

  const runtime = runtimeQueLe((context) => [
    { name: 'project.read_document', args: { documentId: context.attachments[0].documentId } },
  ]);

  const turno = await sendMessage({
    threadId: thread.id, content: 'leia', documentIds: [documento.id],
  }, { db, runtime });

  // Os eventos que a API devolve já são os públicos.
  const publicos = JSON.stringify(turno.events);

  // O evento de FERRAMENTA não carrega o texto lido, nem os argumentos.
  const deFerramenta = turno.events.filter((e) => e.type.startsWith('tool.'));
  assert.ok(deFerramenta.length >= 2, 'os eventos de ferramenta sumiram');
  for (const evento of deFerramenta) {
    assert.equal(evento.result, undefined, 'o resultado bruto atravessou');
    assert.equal(evento.arguments, undefined, 'os argumentos atravessaram');
  }
  for (const proibido of ['chunks', 'nextCursor', 'ordinal', 'pageNumber', documento.id]) {
    assert.equal(
      deFerramenta.some((e) => JSON.stringify(e).includes(proibido)), false,
      `"${proibido}" vazou num evento de ferramenta`,
    );
  }

  // Nome canônico, nunca o alias do runtime.
  assert.ok(publicos.includes('project.read_document'));
  assert.equal(publicos.includes('project_read_document'), false);

  // E a mesma redução, aplicada de novo, não muda nada.
  for (const evento of turno.events) {
    assert.deepEqual(publicAgentEvent(evento), evento);
  }
});

// ── 27 · a fronteira entre projetos, no turno real ──────────────────────────

test('a conversa do projeto B não consegue ler o documento do projeto A', async () => {
  const { db, documento, threadB } = await cenario('texto-simples.pdf');

  // O modelo pede um documentId REAL — o do projeto A — de dentro de uma
  // conversa do projeto B. O ToolContext manda.
  const runtime = runtimeQueLe(() => [
    { name: 'project.read_document', args: { documentId: documento.id } },
    { name: 'project.list_documents', args: {} },
  ]);

  await sendMessage({ threadId: threadB.id, content: 'abra aquele PDF' }, { db, runtime });

  const [leitura, lista] = runtime.resultados;
  assert.equal(leitura.ok, false, 'a leitura cruzada foi permitida');
  assert.match(leitura.erro, /não tem um documento com esse identificador/i);
  // Nem o conteúdo, nem a existência do documento vazam na mensagem de recusa.
  assert.equal(/Arkan Vale/.test(leitura.erro), false);

  // E a lista do B é vazia: o documento do A não aparece nela.
  assert.equal(lista.ok, true);
  assert.deepEqual(lista.r, []);
});

// ── 34 · o documento inteiro, em várias leituras ────────────────────────────

test('um documento grande é percorrido até eof, sem pular nem repetir nada', async () => {
  const { db, documento, thread } = await cenario('grande.pdf');

  assert.equal(documento.pageCount, 14);
  assert.ok(
    documento.textLength > MAX_READ_CHARS,
    `o fixture precisa passar do teto de uma leitura (tem ${documento.textLength})`,
  );

  // O plano é o que a persona pede ao modelo: siga o nextCursor até eof.
  // Aqui ele é executado deterministicamente, com um teto de segurança.
  const leituras = [];
  const runtime = {
    id: 'perseverante',
    isAvailable: () => true,
    unavailableReason: () => null,
    testConnection: async () => ({ ok: true }),
    async* run({ context, invokeTool }) {
      const alvo = context.attachments[0].documentId;
      let cursor;
      let volta = 0;

      for (;;) {
        volta += 1;
        assert.ok(volta <= 20, 'a leitura não terminou');
        // eslint-disable-next-line no-await-in-loop
        const r = await invokeTool(
          'project.read_document',
          cursor === undefined ? { documentId: alvo } : { documentId: alvo, cursor },
        );
        leituras.push(r);
        if (r.eof) break;
        cursor = r.nextCursor;
      }

      yield { type: AGENT_EVENTS.MESSAGE_COMPLETED, ts: 1, text: `Li em ${leituras.length} partes.` };
      yield { type: AGENT_EVENTS.COMPLETED, ts: 1 };
    },
  };

  const turno = await sendMessage({
    threadId: thread.id, content: 'Resuma este documento em 10 pontos.', documentIds: [documento.id],
  }, { db, runtime });

  // Mais de uma leitura foi necessária — é para isso que o fixture é grande.
  assert.ok(leituras.length >= 2, `esperava várias leituras, houve ${leituras.length}`);

  // A primeira não é o fim, e traz um cursor; a última é o fim, e não traz.
  assert.equal(leituras[0].eof, false);
  assert.equal(typeof leituras[0].nextCursor, 'number');
  const ultima = leituras[leituras.length - 1];
  assert.equal(ultima.eof, true);
  assert.equal(ultima.nextCursor, null);

  // Cada leitura respeitou o teto.
  for (const r of leituras) {
    const soma = r.chunks.reduce((t, c) => t + c.text.length, 0);
    assert.ok(soma <= MAX_READ_CHARS, `uma leitura trouxe ${soma} caracteres`);
  }

  // Nada pulado, nada duplicado: os ordinais são 0..n-1, uma vez cada.
  const ordinais = leituras.flatMap((r) => r.chunks.map((c) => c.ordinal));
  assert.deepEqual(ordinais, [...Array(ordinais.length).keys()]);

  // E o documento inteiro foi visto: a marca de cada uma das 14 seções apareceu
  // exatamente uma vez.
  const tudo = leituras.flatMap((r) => r.chunks.map((c) => c.text)).join('\n');
  for (let p = 1; p <= 14; p += 1) {
    const ocorrencias = tudo.split(`MARCO-${p}.`).length - 1;
    assert.equal(ocorrencias, 1, `a marca da seção ${p} apareceu ${ocorrencias} vezes`);
  }

  assert.equal(turno.assistantMessage.content, `Li em ${leituras.length} partes.`);
});

test('parar antes do eof é visível — a leitura diz que ainda há mais', async () => {
  const { db, documento, thread } = await cenario('grande.pdf');

  // Um agente que lê só a primeira parte recebe, na própria resposta da
  // ferramenta, a informação de que não chegou ao fim. É o que a persona usa
  // para não afirmar ter lido o documento inteiro.
  const runtime = runtimeQueLe((context) => [
    { name: 'project.read_document', args: { documentId: context.attachments[0].documentId } },
  ]);

  await sendMessage({
    threadId: thread.id, content: 'do que trata a primeira parte?', documentIds: [documento.id],
  }, { db, runtime });

  const r = runtime.resultados[0].r;
  assert.equal(r.eof, false);
  assert.ok(Number.isInteger(r.nextCursor) && r.nextCursor > 0);
  assert.equal(r.pageCount, 14);
});

// ── 21 · sem anexo no turno, o agente descobre pela lista ───────────────────

test('numa conversa nova, o agente encontra o documento do projeto pelo nome', async () => {
  const { db, documento, thread } = await cenario('multipagina.pdf');

  // Nenhum documentIds neste turno. O agente lista e escolhe pelo filename.
  const runtime = runtimeQueLe(() => [{ name: 'project.list_documents', args: {} }]);
  await sendMessage({ threadId: thread.id, content: 'abra o caderno que eu mandei' }, { db, runtime });

  assert.deepEqual(runtime.vistos[0].context.attachments, []);

  const lista = runtime.resultados[0];
  assert.equal(lista.ok, true);
  assert.equal(lista.r.length, 1);
  assert.equal(lista.r[0].documentId, documento.id);
  assert.equal(lista.r[0].filename, 'multipagina.pdf');
  assert.equal(lista.r[0].pageCount, 3);

  // E o documento continua acessível como documento do projeto na releitura.
  const { messages } = getThread(thread.id, { db });
  for (const m of messages) assert.deepEqual(m.documents, []);
});
