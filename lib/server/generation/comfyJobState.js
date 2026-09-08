// O adaptador de estado do ComfyUI para o vocabulário do Showrunner.
//
// ── A direção, e por que ela importa ────────────────────────────────────────
//
//     comfy/status.js  →  ESTE ARQUIVO  →  jobStates.js
//
// O vocabulário do domínio não sabe que este arquivo existe, e não pode saber.
// Enquanto a tradução morava lá, o domínio conhecia o nome de um executor — e
// no dia do segundo provider ele viraria uma lista de `fromIssoState`,
// `fromAquiloState`, crescendo a cada integração. Um vocabulário que cresce
// com os executores não é genérico; é a união deles.
//
// Acrescentar um provider passa a ser acrescentar um arquivo ao lado deste.
// `jobStates.js` não muda, o banco não muda, a tela não muda.
//
// ── O que este arquivo é ────────────────────────────────────────────────────
//
// Um tradutor, e nada além. Ele conhece as duas línguas porque é a função dele
// conhecer — um tradutor que não pudesse citar as duas não traduziria nada. O
// que ele não faz é decidir: não consulta job, não toca em Asset, não conhece
// thread nem conversa.

import { STATES } from '../comfy/status.js';
import { GenerationStateError, JOB_STATES } from './jobStates.js';

/**
 * A tabela, montada a partir de `STATES` e não de literais.
 *
 * É o que faz um estado novo do executor aparecer aqui como buraco, e não como
 * silêncio: há teste que exige que TODO valor de `STATES` tenha tradução.
 *
 * `gerando` e `decodificando` colapsam em `RUNNING` porque a diferença entre
 * eles é a fase de um grafo — informação do executor, não do trabalho.
 * `salvando` vira `FINALIZING` porque ali o arquivo existe e está sendo
 * trazido, que é uma etapa que qualquer provider tem.
 */
const DO_COMFY = Object.freeze({
  [STATES.PREPARING]: JOB_STATES.PREPARING,
  [STATES.SUBMITTED]: JOB_STATES.SUBMITTED,
  [STATES.QUEUED]: JOB_STATES.QUEUED,
  [STATES.GENERATING]: JOB_STATES.RUNNING,
  [STATES.DECODING]: JOB_STATES.RUNNING,
  [STATES.SAVING]: JOB_STATES.FINALIZING,
  [STATES.DONE]: JOB_STATES.DONE,
  [STATES.FAILED]: JOB_STATES.FAILED,
  [STATES.CANCELLED]: JOB_STATES.CANCELLED,
});

/**
 * O estado do ComfyUI, no vocabulário do Showrunner.
 *
 * ── Estado desconhecido FALHA, e falha alto ─────────────────────────────────
 *
 * A versão anterior devolvia o valor cru quando não reconhecia — o que
 * transformava a fronteira num cano. Aqui um valor fora da tabela lança.
 *
 * Isso é seguro porque `STATES` é constante NOSSA: `provider.js` é o único que
 * escreve `job.state`, e escreve sempre a partir dela. Um valor fora da tabela
 * não é um ComfyUI diferente — é um defeito do nosso lado, e a resposta a um
 * defeito é aparecer, não ser absorvido. Inventar um estado seria pior: dizer
 * `RUNNING` para algo terminal prenderia um acompanhamento até o teto, e dizer
 * `FAILED` abandonaria um trabalho que estava indo bem.
 */
export function fromComfyState(estadoDoProvider) {
  const traduzido = DO_COMFY[estadoDoProvider];
  if (!traduzido) {
    throw new GenerationStateError(
      `Estado do executor sem tradução: "${estadoDoProvider}".`,
      { estadoDoProvider, aceitos: Object.keys(DO_COMFY) },
    );
  }
  return traduzido;
}

/** Os estados do executor que esta tradução conhece — usado nos testes. */
export function translatedProviderStates() {
  return Object.keys(DO_COMFY);
}
