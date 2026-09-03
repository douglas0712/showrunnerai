// Onde a aplicação está no disco.
//
// Módulo neutro: importa apenas primitivas do Node e não conhece workflow,
// runtime, ComfyUI nem domínio. É a única fonte de verdade sobre a raiz da
// aplicação, consumida por quem precisa ancorar um diretório nela.
//
// Existe porque `process.cwd()` não responde essa pergunta. Ele é a raiz do
// projeto quando o Next roda o servidor, mas é qualquer coisa quando um script
// ou um teste é executado de outro diretório — e foi exatamente assim que a
// resolução do workflow do Ideogram falhou uma vez.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Uma pasta é a raiz da aplicação quando tem um `package.json` COM NOME.
 *
 * O `name` não é detalhe: o `.next/package.json` gerado pela build contém
 * apenas `{"type":"commonjs"}`, e sem essa condição a busca pararia lá quando
 * o módulo estivesse empacotado. O nome em si não é comparado com nada — não
 * há projeto codificado aqui.
 */
export function isAppRoot(dir) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return typeof pkg?.name === 'string' && pkg.name.length > 0;
  } catch {
    return false;
  }
}

/** Sobe a partir de `inicio` até achar a raiz da aplicação. */
export function findAppRootFrom(inicio) {
  let dir;
  try {
    dir = path.resolve(inicio);
  } catch {
    return null;
  }
  for (let i = 0; i < 24; i += 1) {
    if (isAppRoot(dir)) return dir;
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
 * A ordem tenta o sinal mais confiável primeiro:
 *
 *   1. a localização deste próprio módulo, subindo até o package.json nomeado.
 *      Funciona de qualquer cwd, e continua funcionando se o módulo for
 *      empacotado mais fundo, porque a busca é por marcador e não por
 *      profundidade fixa;
 *   2. o cwd, subindo do mesmo jeito — cobre o caso em que o caminho do módulo
 *      não é observável (bundler com módulo virtual);
 *   3. o cwd cru, último recurso.
 */
export const APP_ROOT = findAppRootFrom(diretorioDesteModulo())
  || findAppRootFrom(process.cwd())
  || path.resolve(process.cwd());

/**
 * Um diretório ancorado na raiz da aplicação.
 *
 * `envVar` é o override de operador — configuração do servidor, nunca entrada
 * de usuário — e o padrão é sempre derivado da própria aplicação, de modo que
 * nada precise ser configurado para funcionar.
 */
export function appPath(...segmentos) {
  return path.join(APP_ROOT, ...segmentos);
}

export function appPathWithOverride(envVar, ...segmentos) {
  const override = envVar ? process.env[envVar] : null;
  return override ? path.resolve(override) : appPath(...segmentos);
}
