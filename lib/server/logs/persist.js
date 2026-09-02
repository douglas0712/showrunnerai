// Persistência dos eventos em NDJSON.
//
// O buffer em memória some a cada reinício do servidor — e em desenvolvimento
// isso acontece o tempo todo. Sem um arquivo, diagnosticar a falha de ontem
// seria impossível. Uma linha JSON por evento: fácil de abrir, de filtrar com
// grep e de anexar sem reescrever nada.
//
// Nada aqui pode derrubar uma geração: toda falha de escrita é engolida e
// contabilizada. O log é uma comodidade, não uma dependência.

import { appendFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { RUNTIME_ROOT } from '../comfy/config.js';

/** `runtime/logs/`, irmão de `runtime/projects/`. */
export const LOGS_DIR = path.join(path.dirname(RUNTIME_ROOT), 'logs');

/** Acima disso o arquivo do dia ganha um sufixo e recomeça. */
const MAX_BYTES_ARQUIVO = 8 * 1024 * 1024;

/** Arquivos mais antigos que isto são removidos na primeira escrita do dia. */
const RETENCAO_DIAS = 7;

const CHAVE = Symbol.for('showrunner.logs.persist');

function estado() {
  if (!globalThis[CHAVE]) {
    globalThis[CHAVE] = { fila: Promise.resolve(), dirPronto: false, falhas: 0, ultimaPoda: null };
  }
  return globalThis[CHAVE];
}

function nomeDoDia(data = new Date()) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

/**
 * Arquivo do dia, com sufixo quando o anterior passou do teto de tamanho.
 * Percorre `-2`, `-3`… até achar um que ainda caiba.
 */
async function arquivoAtual(dia = nomeDoDia()) {
  for (let parte = 1; parte < 100; parte += 1) {
    const sufixo = parte === 1 ? '' : `-${parte}`;
    const caminho = path.join(LOGS_DIR, `comfy-${dia}${sufixo}.ndjson`);
    try {
      const info = await stat(caminho);
      if (info.size < MAX_BYTES_ARQUIVO) return caminho;
    } catch {
      return caminho; // não existe ainda: é este.
    }
  }
  return path.join(LOGS_DIR, `comfy-${dia}-99.ndjson`);
}

/**
 * Enfileira a gravação de um evento.
 *
 * As escritas são serializadas numa cadeia de promessas para que duas gerações
 * simultâneas não intercalem meia linha uma na outra.
 */
export function persistEvent(evento) {
  const s = estado();
  s.fila = s.fila.then(() => gravar(evento)).catch(() => {});
  return s.fila;
}

async function gravar(evento) {
  const s = estado();
  try {
    if (!s.dirPronto) {
      await mkdir(LOGS_DIR, { recursive: true });
      s.dirPronto = true;
    }

    const hoje = nomeDoDia();
    if (s.ultimaPoda !== hoje) {
      s.ultimaPoda = hoje;
      await podarAntigos().catch(() => {});
    }

    const caminho = await arquivoAtual(hoje);
    await appendFile(caminho, `${JSON.stringify(evento)}\n`, 'utf8');
  } catch {
    s.falhas += 1;
  }
}

/** Remove arquivos de log além da janela de retenção. */
export async function podarAntigos(dias = RETENCAO_DIAS, agora = Date.now()) {
  let arquivos;
  try {
    arquivos = await readdir(LOGS_DIR);
  } catch {
    return 0;
  }

  const limite = agora - dias * 24 * 3600 * 1000;
  let removidos = 0;

  for (const nome of arquivos) {
    const data = /^comfy-(\d{4})-(\d{2})-(\d{2})/.exec(nome);
    if (!data) continue;
    const quando = new Date(Number(data[1]), Number(data[2]) - 1, Number(data[3])).getTime();
    if (quando < limite) {
      await rm(path.join(LOGS_DIR, nome), { force: true }).catch(() => {});
      removidos += 1;
    }
  }
  return removidos;
}

export function persistStatus() {
  const s = estado();
  return { dir: LOGS_DIR, falhas: s.falhas };
}
