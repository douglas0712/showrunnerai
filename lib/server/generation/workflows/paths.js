// Onde os workflows do ComfyUI moram — e como um nome vira caminho confiável.
//
// Antes existia um caminho absoluto único, codificado em comfy/config.js, que
// era a verdade global do sistema. Aqui ele vira duas coisas separadas: uma
// RAIZ configurável por ambiente e um NOME de arquivo declarado por cada
// descriptor. O caller nunca escolhe caminho — escolhe um workflow por id, e o
// caminho é derivado aqui dentro.
//
// Este módulo não importa nada de comfy/ de propósito. A contenção de caminho
// é reimplementada em poucas linhas porque comfy/storage.js depende de
// comfy/config.js, que por sua vez passa a depender do descriptor do MiniMax —
// importar de lá fecharia um ciclo de módulos.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export class WorkflowPathError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'WorkflowPathError';
    this.detail = detail;
  }
}

// ── Quem pode decidir a localização de um workflow ──────────────────────────
//
// A fronteira é entre CONFIGURAÇÃO DE OPERADOR e INPUT DE USUÁRIO/AGENTE:
//
//   Operador (ambiente do processo, definido por quem opera o servidor)
//     · COMFY_WORKFLOWS_ROOT — troca a raiz de busca. Confiável.
//     · COMFY_WORKFLOW       — legado: caminho ABSOLUTO de um arquivo, podendo
//                              ficar fora da raiz. Confiável pelo mesmo motivo:
//                              quem define isso já controla o processo inteiro.
//
//   Usuário / agente / navegador (corpo de requisição, parâmetro de tool)
//     · NUNCA define localização. Envia `workflowId` e nada mais.
//       O caminho é derivado por: workflowId → registry → descriptor → file.
//
// Por isso a validação de travessia se aplica a `file` — que descreve um
// descriptor e é a única parte que poderia, por engano, ser costurada a partir
// de entrada externa — e não ao override de operador, que é um caminho
// absoluto deliberado.
//
// PRECEDÊNCIA, do mais forte ao mais fraco:
//   1. COMFY_WORKFLOW          (se definida, vence e é usada como está)
//   2. COMFY_WORKFLOWS_ROOT    + descriptor.file
//   3. raiz padrão embutida    + descriptor.file

/**
 * Raiz onde os arquivos de workflow são procurados.
 *
 * O padrão preserva o ambiente atual: é o diretório do caminho que estava
 * codificado antes, para que nada precise ser configurado para continuar
 * funcionando como funcionava.
 */
export const DEFAULT_WORKFLOWS_ROOT = '/media/douglas/SSD2/comfyui_data/workflows';

export const WORKFLOWS_ROOT = process.env.COMFY_WORKFLOWS_ROOT || DEFAULT_WORKFLOWS_ROOT;

/**
 * Uma pasta é a raiz da aplicação quando tem um `package.json` COM NOME.
 *
 * O `name` não é detalhe: o `.next/package.json` gerado pela build contém
 * apenas `{"type":"commonjs"}`, e sem essa condição a busca pararia lá quando
 * o módulo estivesse empacotado. O nome em si não é comparado com nada — não
 * há projeto codificado aqui.
 */
function ehRaizDaAplicacao(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof pkg?.name === 'string' && pkg.name.length > 0;
  } catch {
    return false;
  }
}

/** Sobe a partir de `inicio` até achar a raiz da aplicação. */
function subirAteARaiz(inicio) {
  let dir;
  try {
    dir = path.resolve(inicio);
  } catch {
    return null;
  }
  for (let i = 0; i < 24; i += 1) {
    if (ehRaizDaAplicacao(dir)) return dir;
    const pai = path.dirname(dir);
    if (pai === dir) return null;
    dir = pai;
  }
  return null;
}

/** Onde este módulo está no disco, quando isso é observável. */
function diretorioDesteModulo() {
  try {
    return path.dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
}

/**
 * Raiz da aplicação, descoberta e não presumida.
 *
 * `process.cwd()` sozinho não serve: ele é a raiz do projeto quando o Next
 * roda o servidor, mas é qualquer coisa quando um script ou um teste é
 * executado de outro diretório — e foi exatamente assim que a resolução do
 * workflow do Ideogram falhou. A ordem abaixo tenta o sinal mais confiável
 * primeiro:
 *
 *   1. a localização deste próprio módulo, subindo até o package.json nomeado.
 *      Funciona de qualquer cwd, e continua funcionando se o módulo for
 *      empacotado mais fundo, porque a busca é por marcador e não por
 *      profundidade fixa;
 *   2. o cwd, subindo do mesmo jeito — cobre o caso em que o caminho do módulo
 *      não é observável (bundler com módulo virtual);
 *   3. o cwd cru, último recurso.
 */
export const APP_ROOT = subirAteARaiz(diretorioDesteModulo())
  || subirAteARaiz(process.cwd())
  || path.resolve(process.cwd());

/**
 * Raiz dos workflows que o Showrunner possui e versiona.
 *
 * Um workflow pode morar em dois lugares, e a diferença é de propriedade, não
 * de mecanismo:
 *
 *   · raiz do ComfyUI (WORKFLOWS_ROOT) — arquivos que já existiam na máquina,
 *     mantidos por quem opera o ComfyUI. É onde o MiniMax H3 vive.
 *   · raiz do projeto (`workflows/`) — cópia controlada, versionada junto com
 *     o código, para a aplicação não depender para sempre de um diretório
 *     externo. É onde o Ideogram 4 vive.
 *
 * `SHOWRUNNER_WORKFLOWS_ROOT` é o override de operador, no mesmo espírito de
 * COMFY_WORKFLOWS_ROOT: configuração do servidor, nunca entrada de usuário. O
 * padrão é derivado da própria aplicação, então não precisa ser configurado.
 *
 * A resolução e a contenção de caminho são as mesmas nos dois casos.
 */
export const PROJECT_WORKFLOWS_ROOT = process.env.SHOWRUNNER_WORKFLOWS_ROOT
  ? path.resolve(process.env.SHOWRUNNER_WORKFLOWS_ROOT)
  : path.join(APP_ROOT, 'workflows');

/** Raízes que um descriptor pode declarar. Nunca um caminho livre. */
export const WORKFLOW_ROOTS = Object.freeze({
  comfy: () => WORKFLOWS_ROOT,
  project: () => PROJECT_WORKFLOWS_ROOT,
});

export function rootFor(nome = 'comfy') {
  const resolvedor = WORKFLOW_ROOTS[nome];
  if (!resolvedor) {
    throw new WorkflowPathError(`Raiz de workflow desconhecida: "${nome}".`, {
      nome, aceitas: Object.keys(WORKFLOW_ROOTS),
    });
  }
  return resolvedor();
}

/** Nome de arquivo aceito: sem barra, sem travessia, terminando em .json. */
const ARQUIVO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.json$/;

export function validateWorkflowFilename(valor) {
  if (typeof valor !== 'string' || !ARQUIVO_RE.test(valor) || valor.includes('..')) {
    throw new WorkflowPathError(`Nome de arquivo de workflow inválido: "${valor}".`, { valor });
  }
  return valor;
}

/** Garante que `alvo` está dentro de `raiz`. */
export function assertInsideRoot(raiz, alvo) {
  const base = path.resolve(raiz);
  const destino = path.resolve(alvo);
  const relativo = path.relative(base, destino);
  if (relativo === '' || relativo.startsWith('..') || path.isAbsolute(relativo)) {
    throw new WorkflowPathError('Caminho de workflow fora da raiz permitida.', { raiz: base });
  }
  return destino;
}

/**
 * Nome de arquivo → caminho absoluto, garantidamente dentro da raiz.
 *
 * A checagem de contenção roda mesmo com o nome já validado pela regex — é a
 * mesma defesa em profundidade que comfy/storage.js aplica aos vídeos.
 */
export function resolveWorkflowPath(filename, root = WORKFLOWS_ROOT) {
  validateWorkflowFilename(filename);
  const destino = path.resolve(root, filename);
  return assertInsideRoot(root, destino);
}

/**
 * Caminho de um descriptor, considerando um override explícito de operador.
 *
 * `legacyPathEnv` existe só para compatibilidade: a variável COMFY_WORKFLOW
 * apontava para um arquivo completo antes desta etapa, e quem já a tem
 * configurada não pode ver o comportamento mudar. É um caminho absoluto vindo
 * do ambiente do servidor — nunca do navegador, nunca de um parâmetro de
 * requisição —, por isso escapa da contenção na raiz.
 */
export function resolveDescriptorPath({ file, legacyPathEnv = null, rootName = 'comfy' }, root = null) {
  const legado = legacyPathEnv ? process.env[legacyPathEnv] : null;
  if (legado) return path.resolve(legado);
  // `root` explícito só existe para os testes; em produção quem decide é a
  // raiz que o descriptor declarou, de uma lista fechada.
  return resolveWorkflowPath(file, root || rootFor(rootName));
}
