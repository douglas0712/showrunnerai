// O vocabulário de estados de uma geração, para a camada de geração.
//
// A fonte de verdade mudou de lugar no PASSO 10.2 e passou a ser
// `domain/generationJobStates.js` — porque o mesmo vocabulário virou coluna, e
// a cláusula CHECK do esquema é gerada a partir dele. Um valor que o banco
// grava é vocabulário de domínio, e `domain/db.js` não pode depender de
// `generation/` para saber o que aceita.
//
// Este arquivo continua existindo como a porta desta camada. Quem está em
// `generation/` — a facade, o adaptador do ComfyUI, os que vierem — importa
// daqui e não precisa alcançar o domínio para falar de estado.
//
// Não há constante duplicada: tudo abaixo é reexportação.

export {
  assertJobState,
  GenerationStateError,
  isJobState,
  isTerminalJobState,
  JOB_STATES,
  JOB_STATE_VALUES,
  TERMINAL_JOB_STATES,
} from '../domain/generationJobStates.js';
