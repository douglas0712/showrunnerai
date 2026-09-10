// O sintetizador local — Piper, falando português do Brasil.
//
// PASSO 14-C2. É a implementação do contrato de `provider.js`, e a única peça
// deste passo que conhece um sintetizador concreto.
//
// ── Por que Piper ──────────────────────────────────────────────────────────
//
// Porque ele é o único texto-para-voz que JÁ EXISTE nesta máquina, funcionando,
// sem instalar nada. Os nós de voz do ComfyUI (ElevenLabs, HeyGen, ByteDance)
// são todos `api_node: true` — nuvem paga, com credencial. O que há local é um
// binário completo, com runtime ONNX, fonemizador e três vozes pt-BR em disco.
//
// E ele é rápido de um jeito que muda o desenho: fator de tempo real ~0,03 —
// quase três segundos de fala sintetizados em oitenta milissegundos, em CPU,
// sem GPU e sem concorrer com a placa que gera imagem e vídeo.
//
// ── Por que o caminho NÃO tem default ──────────────────────────────────────
//
// Porque a instalação que existe nesta máquina mora fora deste repositório, no
// diretório pessoal de quem a instalou. Um caminho assim escrito no código
// seria uma dependência invisível de UMA máquina: funcionaria aqui, falharia em
// qualquer outra, e ninguém saberia por quê — o código diria que sabe onde o
// sintetizador está, e estaria errado em toda parte menos numa.
//
// Então `PIPER_HOME` é obrigatório e vem do ambiente. Sem ele, o provider
// recusa cedo e diz o que falta. Não há busca automática em diretório pessoal e
// não há descoberta pelo sistema de arquivos: procurar sozinho seria adivinhar,
// e adivinhar onde executar um binário é exatamente o que não se deve fazer.
//
// ── O que este arquivo não faz ─────────────────────────────────────────────
//
// Não sabe o que é uma cena, um take, uma seleção ou um projeto. Recebe texto e
// um caminho, e devolve um arquivo. Toda a decisão de produto está acima dele.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { access, constants, stat } from 'node:fs/promises';

import { TtsError } from './provider.js';

/**
 * Onde o Piper mora — do ambiente, ou lugar nenhum.
 *
 * `null` quando `PIPER_HOME` não está configurado, e é o valor certo: o
 * Showrunner não sabe onde um sintetizador está instalado, e fingir um palpite
 * seria pior do que dizer que não sabe. Ver o cabeçalho.
 */
export function piperHome() {
  const configurado = String(process.env.PIPER_HOME || '').trim();
  return configurado || null;
}

/**
 * A voz. Uma decisão do SERVIDOR, e é assim que fica neste passo.
 *
 * Nenhum modelo escolhe voz, nenhum navegador manda `voiceId`, e o take de
 * narração não ganha coluna de voz para satisfazer provider nenhum. O dia em
 * que escolher a voz for um recurso de produto, ele será desenhado — e não
 * herdado de um parâmetro que vazou.
 */
export function piperVoice() {
  const configurada = String(process.env.PIPER_VOICE || '').trim();
  return configurada || VOZ_PADRAO;
}

/**
 * O basename da voz quando `PIPER_VOICE` não diz outro.
 *
 * É um nome de modelo, e não um caminho: ele se resolve DENTRO de
 * `PIPER_HOME/voices`, então não reintroduz dependência de máquina nenhuma. Num
 * runtime que não tenha esta voz, `piperDisponivel` recusa como recusaria
 * qualquer outra que faltasse.
 */
export const VOZ_PADRAO = 'pt_BR-faber-medium';

/** Quanto tempo uma síntese pode levar antes de ser considerada travada. */
const TETO_MS = Number(process.env.PIPER_TIMEOUT_MS) || 120_000;

export function piperPaths(home = piperHome(), voice = piperVoice()) {
  if (!home) {
    throw new TtsError(
      'O sintetizador de voz não está configurado nesta instalação.',
      { motivo: 'PIPER_HOME ausente', variavel: 'PIPER_HOME' },
    );
  }
  return {
    binario: path.join(home, 'piper'),
    modelo: path.join(home, 'voices', `${voice}.onnx`),
    config: path.join(home, 'voices', `${voice}.onnx.json`),
    home,
    voice,
  };
}

/**
 * O sintetizador está realmente instalado aqui?
 *
 * Conferido ANTES de o domínio registrar trabalho: recusar cedo é a diferença
 * entre "esta instalação não tem voz" e um take órfão apontando para um job que
 * nunca teve chance de rodar.
 */
export async function piperDisponivel(home = piperHome(), voice = piperVoice()) {
  // Sem configuração não há o que conferir: "não está configurado" e "não está
  // instalado" são a mesma resposta para quem pergunta — não há voz aqui.
  if (!home) return false;

  const { binario, modelo, config } = piperPaths(home, voice);
  try {
    await access(binario, constants.X_OK);
    await access(modelo, constants.R_OK);
    await access(config, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * O provider de voz do Piper.
 *
 * `synthesize` escreve no caminho que o Showrunner escolheu — o binário aceita
 * `--output_file`, então não há diretório de trabalho a adivinhar nem arquivo a
 * procurar depois. O texto vai por stdin, e não por argumento de linha de
 * comando: uma narração pode ter aspas, acentos, quebras e qualquer coisa que
 * um roteirista escreva, e nada disso pode virar sintaxe de shell.
 *
 * Também por isso `spawn` sem `shell: true`. Não há string de comando para
 * alguém injetar nada.
 */
export function piperProvider({ home = piperHome(), voice = piperVoice() } = {}) {
  // Os caminhos são resolvidos a cada síntese, e não aqui: construir o provider
  // não pode exigir que o sintetizador já esteja configurado — é `available()`
  // que responde isso, e é ele que o domínio consulta.
  return {
    name: 'piper',

    describe() {
      return { provider: 'piper', model: voice };
    },

    async available() {
      return piperDisponivel(home, voice);
    },

    async synthesize({ text, outputPath }) {
      const fala = typeof text === 'string' ? text : '';
      if (!fala.trim()) {
        throw new TtsError('Não há texto para sintetizar.', { motivo: 'texto vazio' });
      }
      if (!home) {
        throw new TtsError(
          'O sintetizador de voz não está configurado nesta instalação.',
          { motivo: 'PIPER_HOME ausente', variavel: 'PIPER_HOME' },
        );
      }
      if (!await piperDisponivel(home, voice)) {
        throw new TtsError(
          'O sintetizador de voz não está disponível nesta instalação.',
          { motivo: 'piper ausente', voice },
        );
      }

      await executar(piperPaths(home, voice), fala, outputPath);

      // O binário pode sair com 0 e não ter escrito nada — disco cheio, voz
      // corrompida. Quem prova que existe áudio é o ffprobe, mais adiante; aqui
      // basta descartar o caso em que não há sequer arquivo.
      const info = await stat(outputPath).catch(() => null);
      if (!info || info.size === 0) {
        throw new TtsError(
          'A síntese terminou sem produzir áudio.',
          { motivo: 'arquivo vazio', bytes: info?.size ?? 0 },
        );
      }

      return { path: outputPath, extension: '.wav' };
    },
  };
}

function executar({ binario, modelo, config, home }, texto, destino) {
  return new Promise((resolve, reject) => {
    const proc = spawn(binario, [
      '--model', modelo,
      '--config', config,
      '--output_file', destino,
    ], {
      // O binário carrega libonnxruntime e libpiper_phonemize do próprio
      // diretório, e o fonemizador procura espeak-ng-data relativo ao cwd.
      cwd: home,
      env: { ...process.env, LD_LIBRARY_PATH: home },
      stdio: ['pipe', 'ignore', 'pipe'],
    });

    let erro = '';
    let encerrado = false;

    const relogio = setTimeout(() => {
      encerrado = true;
      proc.kill('SIGKILL');
      reject(new TtsError('A síntese de voz demorou demais e foi interrompida.', {
        motivo: 'timeout', tetoMs: TETO_MS,
      }));
    }, TETO_MS);

    proc.stderr.on('data', (c) => { erro += c.toString(); });
    proc.on('error', (e) => {
      clearTimeout(relogio);
      if (!encerrado) reject(new TtsError('Não foi possível iniciar a síntese de voz.', { causa: e.message }));
    });
    proc.on('close', (code) => {
      clearTimeout(relogio);
      if (encerrado) return;
      if (code !== 0) {
        reject(new TtsError('A síntese de voz falhou.', {
          motivo: 'saída não-zero', code, stderr: erro.slice(0, 500),
        }));
        return;
      }
      resolve();
    });

    proc.stdin.end(texto, 'utf8');
  });
}
