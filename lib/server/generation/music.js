// A geração da trilha de uma peça — da intenção escrita ao arquivo.
//
// PASSO 14-D2B. É a primeira geração de MÚSICA do Showrunner.
//
//     Music Cue.description  (intenção autoritativa, PASSO 14-D2A)
//            ↓  snapshot + impressão
//     generation_job(kind='audio', workflow ace_step_15_music)
//            ↓
//     Music Take                     (já ligado ao job)
//            ↓  ComfyUI → ACE-Step 1.5 turbo
//     arquivo real, validado pelo ffprobe
//            ↓
//     Asset(kind='audio')
//            ↓  conclusão central
//     take.assetId + seleção automática POR PEÇA
//
// ── O que este arquivo NÃO precisou construir ──────────────────────────────
//
// Executor, fila, recuperação, validação de áudio, publicação. Tudo isso já
// existia: o efeito sonoro do 14-D1B abriu o caminho ComfyUI para áudio, e a
// música entra por ele. A única diferença é o descriptor — e é por isso que
// `reconcile.js` não precisou de uma linha: ele roteia por WORKFLOW, e um
// workflow novo no registry já é a resposta que ele procura.
//
// ── Music continua sendo do PROJETO ────────────────────────────────────────
//
// Nada aqui introduz cena, sequência ou linha do tempo. O endereço é
// `projectId + cueNumber`, e continua sendo — gerar a peça não muda de quem
// ela é.

import { DomainError } from '../domain/db.js';
import { createProductionMusicTake, getProductionMusicCue } from '../domain/music.js';
import { startGeneration } from './facade.js';
import { aceStep15Music, DEFAULT_SECONDS, MAX_SECONDS } from './workflows/aceStep15Music.js';

/** O workflow que produz música nesta instalação. */
export const MUSIC_WORKFLOW_ID = aceStep15Music.id;

export { DEFAULT_SECONDS as MUSIC_DEFAULT_SECONDS, MAX_SECONDS as MUSIC_MAX_SECONDS };

/**
 * Gera a trilha de uma peça musical.
 *
 * Endereçada por `projectId` (do contexto) + `cueNumber`. O chamador NÃO
 * escolhe descrição, impressão, número do take, job, Asset, seed, workflow,
 * modelo, letra nem caminho.
 *
 * `seconds` é decisão TÉCNICA e tem default do workflow — não é propriedade do
 * domínio, e não vira duração de nada na Timeline futura. Ver o 14-D2A.
 *
 * Devolve assim que o trabalho tem registro durável e foi aceito pelo executor;
 * a conclusão vem depois, pelo caminho central.
 */
export async function startProductionMusicGeneration(
  { projectId, cueNumber, seconds = DEFAULT_SECONDS } = {},
  { db = null, deps = {} } = {},
) {
  if (!projectId) throw new DomainError('Toda geração exige projectId.', {});

  const banco = db || (await import('../domain/db.js')).database();

  // ── o snapshot ──────────────────────────────────────────────────────────
  //
  // A intenção sai daqui, do banco, e é ELA que vai ao modelo. A impressão que
  // o take guarda é calculada pelo domínio a partir da mesma linha — ler o
  // texto num lugar e a impressão em outro abriria a janela que este passo
  // existe para fechar: uma peça composta da intenção nova, carimbada com a
  // velha.
  const cue = getProductionMusicCue(projectId, cueNumber, banco);
  if (!cue) {
    // "não existe" e "é de outro projeto" são a mesma recusa.
    throw new DomainError(
      `Esta produção não tem uma peça musical ${cueNumber}.`,
      { cueNumber },
    );
  }

  let take = null;

  const resultado = await startGeneration(
    {
      workflowId: MUSIC_WORKFLOW_ID,
      // Vai também nos PARÂMETROS, e não só no contexto: é assim que ele chega
      // ao registro em memória do executor, que decide onde o arquivo publicado
      // vai morar.
      projectId,
      // `prompt` é o nome que o caminho de submissão já usa; aqui ele carrega a
      // intenção PERSISTIDA da cue, e nunca texto vindo de quem chamou.
      prompt: cue.description,
      durationSeconds: seconds,
    },
    {
      projectId,
      db: banco,
      deps,
      // ── a janela entre registrar e submeter ────────────────────────────
      //
      // O jobId já é definitivo e nada foi submetido. É o único instante em que
      // o take pode nascer JÁ ligado ao trabalho sem risco de sobrar geração
      // rodando sem dono: um erro aqui sobe antes de o ComfyUI ver qualquer
      // coisa, e o registro fica em `preparing`, que a reconciliação já trata.
      aoRegistrar: async ({ jobId }) => {
        take = createProductionMusicTake(projectId, cueNumber, {}, banco);
        banco.prepare(
          'UPDATE production_music_takes SET generationJobId = ?, updatedAt = ? WHERE id = ?',
        ).run(jobId, Date.now(), take.id);
      },
    },
  );

  return {
    jobId: resultado.jobId,
    kind: resultado.kind,
    cueNumber: cue.cueNumber,
    takeNumber: take?.takeNumber ?? null,
    sourceCueFingerprint: take?.sourceCueFingerprint ?? null,
    status: resultado.status,
  };
}
