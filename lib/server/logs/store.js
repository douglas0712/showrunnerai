// Buffer circular dos eventos de diagnóstico.
//
// Duas exigências moldam este arquivo:
//
//  1. Teto fixo de entradas, com rotação automática — o processo é longo e o
//     polling é constante, então o buffer precisa ser limitado por construção.
//  2. Os erros mais recentes sobrevivem à rotação. Uma falha de ontem não pode
//     ser empurrada para fora por cem linhas de progresso de hoje: é justamente
//     a linha que o usuário abriu a tela para ler.
//
// `createLogStore` é a fábrica testável; a instância da aplicação vive em
// globalThis pelo mesmo motivo documentado em `comfy/jobs.js` — o Fast Refresh
// do Next recarrega módulos entre requisições em desenvolvimento.

import { LEVELS } from './stages.js';

export const CAPACIDADE_PADRAO = 500;
export const ERROS_RETIDOS_PADRAO = 50;

export function createLogStore({
  capacidade = CAPACIDADE_PADRAO,
  errosRetidos = ERROS_RETIDOS_PADRAO,
} = {}) {
  const eventos = [];
  let proximoSeq = 1;
  let descartados = 0;

  /** Acrescenta um evento já montado e devolve a cópia com `seq` atribuído. */
  function append(evento) {
    const registro = { ...evento, seq: proximoSeq };
    proximoSeq += 1;
    eventos.push(registro);
    rotacionar();
    return registro;
  }

  /**
   * Rotação: remove os mais antigos até caber, pulando os erros protegidos.
   *
   * Protegidos são os `errosRetidos` erros mais recentes. Se sobrarem apenas
   * protegidos (buffer pequeno demais para a política), o mais antigo sai assim
   * mesmo — o teto de memória vale acima de tudo.
   */
  function rotacionar() {
    if (eventos.length <= capacidade) return;

    const protegidos = seqsProtegidos();

    while (eventos.length > capacidade) {
      const indice = eventos.findIndex((e) => !protegidos.has(e.seq));
      const alvo = indice >= 0 ? indice : 0;
      eventos.splice(alvo, 1);
      descartados += 1;
    }
  }

  function seqsProtegidos() {
    const protegidos = new Set();
    for (let i = eventos.length - 1; i >= 0 && protegidos.size < errosRetidos; i -= 1) {
      if (eventos[i].level === LEVELS.ERROR) protegidos.add(eventos[i].seq);
    }
    return protegidos;
  }

  /**
   * Leitura incremental.
   *
   * `since` é o cursor devolvido na chamada anterior: a tela só recebe o que
   * apareceu depois, o que mantém o polling barato mesmo com o buffer cheio.
   */
  function query({ since = 0, jobId = null, level = null, limit = capacidade } = {}) {
    const desde = Number(since) || 0;
    const teto = Math.min(Math.max(Number(limit) || capacidade, 1), capacidade);

    const filtrados = eventos.filter((e) => {
      if (e.seq <= desde) return false;
      if (jobId && e.jobId !== jobId) return false;
      if (level && e.level !== level) return false;
      return true;
    });

    // Buffer estourado entre duas leituras: devolvemos os mais novos e avisamos.
    const recorte = filtrados.slice(-teto);

    return {
      events: recorte,
      cursor: eventos.length ? eventos[eventos.length - 1].seq : desde,
      truncated: filtrados.length > recorte.length,
    };
  }

  /** Todos os eventos de um job, em ordem — usado pelo download em JSON. */
  function byJob(jobId) {
    return eventos.filter((e) => e.jobId === jobId);
  }

  function stats() {
    const porNivel = { [LEVELS.INFO]: 0, [LEVELS.WARN]: 0, [LEVELS.ERROR]: 0 };
    for (const e of eventos) {
      if (porNivel[e.level] !== undefined) porNivel[e.level] += 1;
    }
    return {
      total: eventos.length,
      capacidade,
      errosRetidos,
      descartados,
      porNivel,
      cursor: eventos.length ? eventos[eventos.length - 1].seq : 0,
    };
  }

  /** Esvazia o buffer. Só o servidor chama — a tela limpa apenas a visualização. */
  function reset() {
    eventos.length = 0;
    descartados = 0;
  }

  return { append, query, byJob, stats, reset, get tamanho() { return eventos.length; } };
}

const CHAVE = Symbol.for('showrunner.logs.store');

export function logStore() {
  if (!globalThis[CHAVE]) globalThis[CHAVE] = createLogStore();
  return globalThis[CHAVE];
}
