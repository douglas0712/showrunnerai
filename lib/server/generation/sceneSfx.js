// A geração do efeito sonoro de uma cue — da descrição escrita ao arquivo.
//
// PASSO 14-D1B. É a primeira geração de SFX do Showrunner.
//
//     SFX Cue.description  (texto autoritativo, PASSO 14-D1A)
//            ↓  snapshot + impressão
//     generation_job(kind='audio', workflow stable_audio_sfx)
//            ↓
//     SFX Take                       (já ligado ao job)
//            ↓  ComfyUI → Stable Audio Open
//     arquivo real, validado pelo ffprobe
//            ↓
//     Asset(kind='audio')
//            ↓  conclusão central
//     take.assetId + seleção automática POR CUE
//
// ── Por que isto é tão mais curto do que a narração ────────────────────────
//
// Porque não há executor novo. A narração precisou de uma fronteira própria —
// o Piper é um binário, sem fila, sem identidade durável, e por isso ganhou
// `executarNarracao` e uma reconciliação só dela. O efeito sonoro roda no
// ComfyUI, que o Showrunner já sabe operar: `startGeneration` submete,
// `providerJobId` identifica, o histórico e a fila respondem, a reconciliação
// existente recupera, e `completeGenerationJob` conclui.
//
// O que este arquivo faz, então, é pouco e específico: resolver a cue, tirar o
// snapshot do texto, registrar o take ANTES de submeter, e sair da frente.
//
// ── A ordem, que continua sendo a regra ────────────────────────────────────
//
// Registrar antes de submeter. `startGeneration` tem um gancho exatamente para
// isso — `aoRegistrar`, a janela em que o jobId já é definitivo e nada foi
// submetido — e é nele que o take nasce. Se o registro falhar, o erro sobe e
// nenhum trabalho externo começa.

import { DomainError } from '../domain/db.js';
import { getProductionScene } from '../domain/production.js';
import { createSceneSfxTake, getSceneSfxCue } from '../domain/sceneSfx.js';
import { startGeneration } from './facade.js';
import { DEFAULT_SECONDS, MAX_SECONDS, stableAudioSfx } from './workflows/stableAudioSfx.js';

/** O workflow que produz efeito sonoro nesta instalação. */
export const SFX_WORKFLOW_ID = stableAudioSfx.id;

export { DEFAULT_SECONDS as SFX_DEFAULT_SECONDS, MAX_SECONDS as SFX_MAX_SECONDS };

/**
 * Gera o efeito sonoro de uma cue.
 *
 * Endereçada como todo o resto da produção: `projectId` (do contexto) +
 * `ordinal` da cena + `cueNumber`. O chamador NÃO escolhe descrição, impressão,
 * número do take, job, Asset, seed, workflow, modelo nem caminho — tudo isso é
 * do servidor, e é o que torna cross-project impossível por construção.
 *
 * Devolve assim que o trabalho tem registro durável e foi aceito pelo executor;
 * a conclusão vem depois, pelo caminho central.
 */
export async function startSceneSfxGeneration(
  { projectId, ordinal, cueNumber, seconds = DEFAULT_SECONDS } = {},
  { db = null, deps = {} } = {},
) {
  if (!projectId) throw new DomainError('Toda geração exige projectId.', {});

  const banco = db || (await import('../domain/db.js')).database();

  const cena = getProductionScene(projectId, ordinal, banco);
  if (!cena) {
    throw new DomainError(`Este projeto não tem uma cena ${ordinal}.`, { ordinal });
  }

  // ── o snapshot ──────────────────────────────────────────────────────────
  //
  // A descrição sai daqui, do banco, e é ELA que vai ao provider. A impressão
  // que o take guarda é calculada pelo domínio a partir da mesma linha — ler o
  // texto num lugar e a impressão em outro abriria a janela que este passo
  // existe para fechar: um som gerado do texto novo, carimbado com o velho.
  const cue = getSceneSfxCue(projectId, ordinal, cueNumber, banco);
  if (!cue) {
    // "não existe", "é de outra cena" e "é de outro projeto" são a mesma
    // recusa — distinguir as três contaria o que existe fora deste projeto.
    throw new DomainError(
      `A cena ${ordinal} não tem um efeito ${cueNumber}.`,
      { ordinal, cueNumber },
    );
  }

  let take = null;

  // `startGeneration` cuida do livro-razão, da submissão e do `providerJobId`.
  // O que entra aqui é só o que ele não tem como saber: qual take é este.
  const resultado = await startGeneration(
    {
      workflowId: SFX_WORKFLOW_ID,
      // `projectId` vai também nos PARÂMETROS, e não só no contexto: é assim
      // que ele chega ao registro em memória do executor, que decide onde o
      // arquivo publicado vai morar. Sem ele a publicação recusa o caminho.
      projectId,
      // `prompt` é o nome que o caminho de submissão já usa; aqui ele carrega a
      // descrição PERSISTIDA da cue, e nunca texto vindo de quem chamou.
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
      // o take pode nascer JÁ ligado ao trabalho e sem risco de sobrar geração
      // rodando sem dono: um erro aqui sobe antes de o ComfyUI ver qualquer
      // coisa, e o registro fica em `preparing`, que a reconciliação já trata.
      aoRegistrar: async ({ jobId }) => {
        take = createSceneSfxTake(projectId, ordinal, cueNumber, {}, banco);
        banco.prepare(
          'UPDATE production_scene_sfx_takes SET generationJobId = ?, updatedAt = ? WHERE id = ?',
        ).run(jobId, Date.now(), take.id);
      },
    },
  );

  return {
    jobId: resultado.jobId,
    kind: resultado.kind,
    ordinal: cena.ordinal,
    cueNumber: cue.cueNumber,
    takeNumber: take?.takeNumber ?? null,
    sourceCueFingerprint: take?.sourceCueFingerprint ?? null,
    status: resultado.status,
  };
}
