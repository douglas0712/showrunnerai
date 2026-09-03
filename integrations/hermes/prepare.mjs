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

import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
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

// ── a persona ───────────────────────────────────────────────────────────────
//
// A fonte de verdade é o .md deste repositório. O config do runtime dedicado é
// GERADO a partir dele, entre as marcas abaixo, para que não existam duas
// versões da identidade do produto — uma no repo e outra no arquivo que o
// runtime lê. Reexecutar o script reescreve só esse trecho; o resto do config,
// que é do operador, fica intacto.
const INICIO = '# >>> showrunner:persona — GERADO, não edite à mão';
const FIM = '# <<< showrunner:persona';

const persona = readFileSync(
  path.join(raiz, 'integrations', 'hermes', 'persona', 'showrunner.md'),
  'utf8',
).trimEnd();

// Escalar literal de YAML: a indentação define o bloco, e o conteúdo entra sem
// escape nenhum — é o que permite a persona ter aspas, dois-pontos e listas.
const bloco = [
  INICIO,
  'agent:',
  '  personalities:',
  '    showrunner:',
  '      system_prompt: |',
  ...persona.split('\n').map((linha) => (linha ? `        ${linha}` : '')),
  FIM,
].join('\n');

let config = readFileSync(destinoConfig, 'utf8');
const jaTem = config.indexOf(INICIO);
if (jaTem !== -1) {
  const fim = config.indexOf(FIM, jaTem);
  config = config.slice(0, jaTem) + bloco + config.slice(fim + FIM.length);
} else {
  config = `${config.trimEnd()}\n\n${bloco}\n`;
}
writeFileSync(destinoConfig, config);
console.log('persona instalada no config do runtime dedicado');

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
