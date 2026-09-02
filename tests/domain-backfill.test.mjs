// Backfill dos vídeos que já existem em disco.
//
// Duas garantias são o motivo deste arquivo existir:
//
//   1. rodar de novo não duplica nada;
//   2. nenhum byte, nome, tamanho ou data de modificação de um MP4 muda.
//
// Os arquivos usados aqui são SINTÉTICOS, criados num diretório temporário.
// Os vídeos reais do usuário em runtime/projects/ nunca são lidos nem tocados
// por este teste.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { APPROVAL } from '../lib/approval.js';
import { openDatabase } from '../lib/server/domain/db.js';
import { createProject, getProject, listProjects, updateProject } from '../lib/server/domain/projects.js';
import { listAssets } from '../lib/server/domain/assets.js';
import { backfillVideoAssets } from '../lib/server/domain/backfill.js';

const RAIZ = await mkdtemp(path.join(tmpdir(), 'showrunner-domain-backfill-'));
test.after(() => rm(RAIZ, { recursive: true, force: true }));

const JOB_A = 'cinema_aaa111_zzz';
const JOB_B = 'cinema_bbb222_yyy';
const JOB_C = 'cinema_ccc333_xxx';

await mkdir(path.join(RAIZ, 'avulso', 'videos'), { recursive: true });
await mkdir(path.join(RAIZ, 'proj_demo_noir', 'videos'), { recursive: true });
await writeFile(path.join(RAIZ, 'avulso', 'videos', `${JOB_A}.mp4`), 'bytes-do-video-a');
await writeFile(path.join(RAIZ, 'avulso', 'videos', `${JOB_B}.mp4`), 'bytes-do-video-b-maior');
await writeFile(path.join(RAIZ, 'proj_demo_noir', 'videos', `${JOB_C}.mp4`), 'bytes-do-video-c');
// Ruído que a allowlist já sabe recusar e que o backfill herda de graça:
await writeFile(path.join(RAIZ, 'avulso', 'videos', 'anotacoes.txt'), 'não é vídeo');
await mkdir(path.join(RAIZ, '..projeto inválido..', 'videos'), { recursive: true });
await writeFile(path.join(RAIZ, '..projeto inválido..', 'videos', 'x.mp4'), 'fora da allowlist');

/** Impressão digital de toda a árvore de mídia: caminho, tamanho, mtime, hash. */
async function impressaoDigital(raiz) {
  const registro = {};
  for (const projeto of await readdir(raiz, { withFileTypes: true })) {
    if (!projeto.isDirectory()) continue;
    const dir = path.join(raiz, projeto.name, 'videos');
    let arquivos;
    try {
      arquivos = await readdir(dir);
    } catch {
      continue;
    }
    for (const arquivo of arquivos) {
      const completo = path.join(dir, arquivo);
      const info = await stat(completo);
      const conteudo = await readFile(completo);
      registro[path.relative(raiz, completo)] = {
        bytes: info.size,
        mtimeMs: info.mtimeMs,
        sha256: createHash('sha256').update(conteudo).digest('hex'),
      };
    }
  }
  return registro;
}

test('registra um Asset por vídeo da allowlist, sem inventar nada além dela', async () => {
  const db = openDatabase(':memory:');
  const resultado = await backfillVideoAssets({ root: RAIZ, db });

  assert.equal(resultado.total, 3, 'só os três MP4 sob projetos válidos');
  assert.equal(resultado.registrados.length, 3);
  assert.equal(resultado.jaRegistrados.length, 0);
  assert.equal(resultado.ignorados.length, 0);

  const registrados = listAssets({}, db);
  assert.equal(registrados.length, 3);
  assert.ok(registrados.every((a) => a.kind === 'video'));
  assert.ok(registrados.every((a) => a.mimeType === 'video/mp4'));
  assert.ok(registrados.every((a) => a.status === APPROVAL.PENDING));
  assert.ok(registrados.every((a) => a.derivedFromAssetId === null));

  // O .txt e o projeto de nome inválido não entram.
  assert.ok(!registrados.some((a) => a.filename.endsWith('.txt')));
  assert.ok(!registrados.some((a) => a.projectId.includes('inválido')));

  db.close();
});

test('o Asset guarda jobId, URL pública e tamanho reais do arquivo', async () => {
  const db = openDatabase(':memory:');
  await backfillVideoAssets({ root: RAIZ, db });

  const [asset] = listAssets({ projectId: 'avulso' }, db).filter((a) => a.jobId === JOB_A);
  assert.ok(asset, 'o vídeo A precisa ter sido registrado');
  assert.equal(asset.filename, `${JOB_A}.mp4`);
  assert.equal(asset.url, `/api/media/video/avulso/${JOB_A}.mp4`);
  assert.equal(asset.bytes, (await stat(path.join(RAIZ, 'avulso', 'videos', `${JOB_A}.mp4`))).size);

  // Largura, altura e duração exigiriam ffprobe; ficam para uma etapa adiante.
  assert.equal(asset.width, null);
  assert.equal(asset.height, null);
  assert.equal(asset.durationSeconds, null);
  db.close();
});

test('o backfill é idempotente — rodar três vezes não duplica', async () => {
  const db = openDatabase(':memory:');

  const primeira = await backfillVideoAssets({ root: RAIZ, db });
  const segunda = await backfillVideoAssets({ root: RAIZ, db });
  const terceira = await backfillVideoAssets({ root: RAIZ, db });

  assert.equal(primeira.registrados.length, 3);
  assert.equal(segunda.registrados.length, 0);
  assert.equal(terceira.registrados.length, 0);
  assert.equal(segunda.jaRegistrados.length, 3);
  assert.equal(terceira.jaRegistrados.length, 3);

  assert.equal(listAssets({}, db).length, 3, 'nenhuma duplicata após três passadas');
  db.close();
});

test('o backfill NÃO modifica, move, renomeia nem apaga arquivo algum', async () => {
  const db = openDatabase(':memory:');

  const antes = await impressaoDigital(RAIZ);
  await backfillVideoAssets({ root: RAIZ, db });
  await backfillVideoAssets({ root: RAIZ, db });
  const depois = await impressaoDigital(RAIZ);

  assert.deepEqual(
    Object.keys(depois).sort(),
    Object.keys(antes).sort(),
    'nenhum arquivo criado, removido ou renomeado',
  );
  assert.deepEqual(depois, antes, 'bytes, tamanho e data de modificação intactos');

  // E o banco não vazou para dentro da árvore de mídia.
  assert.ok(!Object.keys(depois).some((p) => p.endsWith('.db')));
  db.close();
});

test('cria o projeto que faltava, sem sobrescrever o que já estava cadastrado', async () => {
  const db = openDatabase(':memory:');

  createProject({ id: 'avulso', name: 'Nome escolhido pelo usuário' }, db);

  const resultado = await backfillVideoAssets({ root: RAIZ, db });

  assert.deepEqual(resultado.projetosCriados, ['proj_demo_noir']);
  assert.equal(getProject('avulso', db).name, 'Nome escolhido pelo usuário');
  assert.equal(getProject('proj_demo_noir', db).name, 'proj_demo_noir');
  assert.equal(listProjects(db).length, 2);
  db.close();
});

test('uma renomeação do usuário sobrevive a uma nova passada do backfill', async () => {
  const db = openDatabase(':memory:');

  await backfillVideoAssets({ root: RAIZ, db });
  updateProject('proj_demo_noir', { name: 'Curta neo-noir "Sinal"' }, db);
  await backfillVideoAssets({ root: RAIZ, db });

  assert.equal(getProject('proj_demo_noir', db).name, 'Curta neo-noir "Sinal"');
  db.close();
});

test('raiz inexistente não quebra — devolve lote vazio', async () => {
  const db = openDatabase(':memory:');
  const resultado = await backfillVideoAssets({ root: path.join(RAIZ, 'nao-existe'), db });

  assert.equal(resultado.total, 0);
  assert.deepEqual(resultado.registrados, []);
  assert.deepEqual(resultado.projetosCriados, []);
  db.close();
});

// ── travas estruturais ──────────────────────────────────────────────────────

test('o backfill não importa nenhuma API capaz de escrever em disco', async () => {
  const fonte = await readFile(new URL('../lib/server/domain/backfill.js', import.meta.url), 'utf8');

  // A única chamada de sistema de arquivos permitida aqui é `stat`, que lê.
  const importaDeFs = [...fonte.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs[^']*'/g)]
    .flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
  assert.deepEqual(importaDeFs, ['stat'], `o backfill importa de node:fs: ${importaDeFs.join(', ')}`);

  // E nenhuma escrita vinda de outro caminho.
  const escritas = /\b(writeFile|appendFile|rename|unlink|rmdir|copyFile|truncate|createWriteStream|mkdir|rm)\s*\(/.exec(fonte);
  assert.equal(escritas, null, `chamada de escrita encontrada: ${escritas?.[1]}`);
});

test('só diretórios com projectId válido chegam ao registro', async () => {
  const db = openDatabase(':memory:');
  await backfillVideoAssets({ root: RAIZ, db });

  const projetos = listProjects(db).map((p) => p.id).sort();
  assert.deepEqual(projetos, ['avulso', 'proj_demo_noir']);

  // O diretório '..projeto inválido..' existe em disco com um MP4 dentro e
  // continua fora — a validação de segmento de listRegisteredVideos é herdada.
  assert.ok(!projetos.some((id) => id.includes('inválido')));
  assert.ok(await stat(path.join(RAIZ, '..projeto inválido..', 'videos', 'x.mp4')),
    'o arquivo recusado continua intacto em disco');
  db.close();
});
