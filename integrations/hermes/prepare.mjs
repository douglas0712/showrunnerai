#!/usr/bin/env node
// Prepara o HERMES_HOME dedicado ao Showrunner.
//
// Faz três coisas e para: cria o diretório, escreve o config a partir do
// modelo, e liga o plugin por symlink. Não copia credencial, não sobe processo,
// não toca no ~/.hermes pessoal.
//
// Não copiar credencial é decisão, não limitação: um script que varre a
// máquina atrás de chave e a duplica noutro diretório é exatamente o tipo de
// conveniência que espalha segredo por disco.

import { copyFileSync, existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import path from 'node:path';

const raiz = process.cwd();
const home = process.env.SHOWRUNNER_HERMES_HOME
  || path.join(raiz, 'runtime', 'hermes', 'home');
const modelo = path.join(raiz, 'integrations', 'hermes', 'config.template.yaml');
const plugin = path.join(raiz, 'integrations', 'hermes', 'showrunner-plugin');

mkdirSync(path.join(home, 'plugins'), { recursive: true });

const destinoConfig = path.join(home, 'config.yaml');
if (existsSync(destinoConfig)) {
  console.log(`config.yaml já existe, preservado: ${destinoConfig}`);
} else {
  copyFileSync(modelo, destinoConfig);
  console.log(`config.yaml escrito: ${destinoConfig}`);
}

const destinoPlugin = path.join(home, 'plugins', 'showrunner');
if (existsSync(destinoPlugin) || lstatSafe(destinoPlugin)) {
  try { unlinkSync(destinoPlugin); } catch { /* diretório real: preservado */ }
}
if (!existsSync(destinoPlugin)) {
  symlinkSync(plugin, destinoPlugin, 'dir');
  console.log(`plugin ligado: ${destinoPlugin} -> ${plugin}`);
}

console.log('');
console.log('Falta o operador fazer, porque este script não faz por ele:');
console.log(`  1. credenciais do provider em ${path.join(home, '.env')}`);
console.log(`  2. subir o runtime com HERMES_HOME=${home}, só em loopback`);
console.log('  3. SHOWRUNNER_HERMES_URL apontando para essa porta');
console.log('  4. SHOWRUNNER_BRIDGE_SOCKET igual nos dois lados');

function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}
