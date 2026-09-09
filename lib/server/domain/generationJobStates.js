// O vocabulário de estados de uma geração — do SHOWRUNNER, não de um provider.
//
// ── Por que ele existe ──────────────────────────────────────────────────────
//
// Até aqui, o estado de uma geração era o do ComfyUI traduzido para o
// português: "na-fila", "decodificando", "salvando". Funcionava porque só havia
// um executor. Mas "decodificando" é uma fase de um grafo de nós — não é um
// conceito de produção audiovisual, e nenhum outro provider tem esse estado.
//
// Um dia haverá outros. Quando houver, ou o domínio já falava a própria língua,
// ou cada provider novo entra empurrando o vocabulário dele para dentro do
// banco, da tela e da conversa. Este arquivo é a língua do domínio.
//
// ── As TRÊS camadas de estado, e por que são três ───────────────────────────
//
//   estado do PROVIDER    `comfy/status.js` → STATES. O que o executor está
//                         fazendo, no vocabulário dele. Continua existindo e
//                         continua correto: é ele que a tela antiga do Studio
//                         mostra, com a granularidade que ela quer.
//
//   estado de DOMÍNIO     este arquivo. O que o Showrunner sabe sobre um
//                         trabalho, independentemente de quem o executa. É o
//                         que vai virar coluna quando o registro durável de
//                         gerações existir.
//
//   estado de PRODUÇÃO    `agent/tools/jobWatch.js` → PRODUCAO. O que a
//                         conversa mostra: quatro estados, em linguagem de
//                         produto. Quem espera uma imagem não precisa saber a
//                         diferença entre "na fila" e "gerando".
//
// A tradução acontece uma vez em cada fronteira, e cada fronteira tem um dono.
// Duas traduções da mesma coisa em lugares diferentes é a maneira de elas
// discordarem um dia.
//
// ── Por que ele mora no DOMÍNIO ─────────────────────────────────────────────
//
// Ele nasceu em `generation/` no PASSO 10.1, quando era só o que a facade
// devolvia. No 10.2 esse mesmo vocabulário virou COLUNA: a cláusula CHECK de
// `generation_jobs.state` é gerada a partir dele. Um valor que o banco grava é
// vocabulário de domínio — e `domain/db.js` não pode depender de `generation/`
// para saber o que aceita.
//
// ── A direção da dependência ────────────────────────────────────────────────
//
// Este arquivo não importa nada, e é assim que ele deve continuar.
//
//     domain/db.js  ─┐
//     domain/generationJobs.js  ─┼──►  domain/generationJobStates.js
//                                            ▲
//                              generation/jobStates.js  (reexporta)
//                                            ▲
//                              generation/comfyJobState.js  (traduz)
//                              generation/veoJobState.js …
//
// Nunca o contrário. Um vocabulário que soubesse o nome dos executores deixaria
// de ser genérico no dia do segundo — viraria uma lista de `fromIssoState`,
// `fromAquiloState`, e o domínio cresceria a cada integração.
//
// Acrescentar um provider é acrescentar um adaptador em `generation/`. Este
// arquivo não muda, e o esquema do banco tampouco.

/** Falha ao interpretar um estado de geração. */
export class GenerationStateError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'GenerationStateError';
    this.detail = detail;
  }
}

/**
 * Os estados que uma geração pode ter, para o Showrunner.
 *
 * Valores em minúsculas e em inglês pelo mesmo motivo de `AGENT_ROLES` e
 * `AGENT_THREAD_STATUS`: são identificadores de domínio, não texto de tela. O
 * que o usuário lê é montado a partir deles, nunca são eles.
 */
export const JOB_STATES = Object.freeze({
  /** Existe para o Showrunner; nenhum provider o aceitou ainda. */
  PREPARING: 'preparing',
  /** O provider aceitou. Ainda não observamos onde o trabalho está. */
  SUBMITTED: 'submitted',
  /** Esperando a vez. Nem todo provider expõe fila — este estado é opcional. */
  QUEUED: 'queued',
  /** Executando. */
  RUNNING: 'running',
  /** O provider terminou; o arquivo está sendo buscado, validado e publicado. */
  FINALIZING: 'finalizing',
  /** Existe Asset. */
  DONE: 'done',
  /** Não produziu resultado. */
  FAILED: 'failed',
  /** Parado a pedido explícito do usuário. */
  CANCELLED: 'cancelled',
  /**
   * Procuramos e não encontramos — não sabemos o desfecho.
   *
   * Nenhum provider produz este estado: ele é conclusão NOSSA, e só a
   * reconciliação de um reinício pode escrevê-lo. Ele já existe no vocabulário
   * porque o conjunto de estados precisa estar fechado antes de virar coluna;
   * nenhum fluxo o produz hoje, e é isso mesmo.
   */
  ORPHANED: 'orphaned',
});

/** Todos os valores, para validação e para as cláusulas CHECK de um dia. */
export const JOB_STATE_VALUES = Object.freeze(Object.values(JOB_STATES));

/**
 * Os estados em que já não há o que esperar.
 *
 * ── Terminal de domínio ≠ terminal de provider ──────────────────────────────
 *
 * `comfy/status.js` também tem `TERMINAL_STATES`, com três: concluído, falhou e
 * cancelado. São os desfechos que o EXECUTOR conhece, e é essa a lista que
 * decide se vale a pena consultá-lo de novo.
 *
 * Esta lista tem quatro. `ORPHANED` é um desfecho que só o Showrunner pode
 * declarar — o provider nunca dirá que perdeu um trabalho, porque para ele o
 * trabalho ou existe ou nunca existiu. As duas listas dizem coisas diferentes e
 * não devem ser unificadas.
 */
export const TERMINAL_JOB_STATES = Object.freeze([
  JOB_STATES.DONE, JOB_STATES.FAILED, JOB_STATES.CANCELLED, JOB_STATES.ORPHANED,
]);

/** É um estado de geração conhecido? */
export function isJobState(estado) {
  return JOB_STATE_VALUES.includes(estado);
}

/** Já terminou? Um estado desconhecido não é terminal — ele é um defeito. */
export function isTerminalJobState(estado) {
  return TERMINAL_JOB_STATES.includes(estado);
}

/** Confere e devolve. Para quem vai gravar ou decidir sobre o valor. */
export function assertJobState(estado) {
  if (!isJobState(estado)) {
    throw new GenerationStateError(
      `Estado de geração desconhecido: "${estado}".`,
      { estado, aceitos: [...JOB_STATE_VALUES] },
    );
  }
  return estado;
}
