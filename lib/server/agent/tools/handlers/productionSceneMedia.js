// Tool project.generate_scene_image
//
// PASSO 13-B. É aqui que uma cena DESCRITA vira uma cena com imagem.
//
// ── Por que não basta `og.generate_image` ───────────────────────────────────
//
// Porque aquela ferramenta gera uma imagem para a CONVERSA: ela produz um Asset
// do projeto e o mostra no turno, e ninguém nunca saberá de qual cena ele era.
// Perguntar depois "qual é a imagem da cena 4?" não teria resposta — a única
// pista seria a memória do chat, que é justamente o que o PASSO 12 existe para
// não depender.
//
// Esta ferramenta gera a imagem DE UMA CENA. O resultado ocupa um lugar: o take
// de imagem daquela cena, com número, e a cena passa a ter uma imagem escolhida.
//
// ── O que ela NÃO é ─────────────────────────────────────────────────────────
//
// Não é um segundo pipeline. Ela não conhece ComfyUI, Ideogram, workflow, nó de
// saída nem caminho de arquivo: ela chama a MESMA `startImageGeneration` que a
// ferramenta de conversa chama, e o acompanhamento é o MESMO `watchJob`. Trocar
// o gerador de imagem do produto não deve tocar neste arquivo.
//
// ── O que o modelo pode dizer ───────────────────────────────────────────────
//
// Duas coisas: qual cena, e o que se vê nela. Nada mais.
//
// Não há `projectId` (é do ToolContext), não há `sceneId` nem `mediaId` (não
// saem do servidor), não há `takeNumber` (quem numera é o servidor — um modelo
// que escolhesse o número o escolheria pela memória da conversa, e erraria
// justamente depois de uma geração que ele não viu acontecer), e não há
// `workflowId`, `modelId` nem `provider` (a escolha do gerador é do estúdio, e
// um campo desses no schema é um campo que o modelo aprende a preencher).

import { defineTool, ToolExecutionError } from '../schema.js';
import { startImageGeneration } from '../../../generation/facade.js';
import { createSceneTake } from '../../../domain/sceneMedia.js';
import { getProductionPlan, getProductionScene } from '../../../domain/production.js';
import { watchJob } from '../jobWatch.js';
import {
  argumentosValidos, comoErroDeFerramenta, contextoValido,
} from './productionPlan.js';

/** Teto do texto de direção visual. O mesmo de `og.generate_image`. */
const MAX_PROMPT = 4000;

export const generateSceneImageTool = defineTool({
  name: 'project.generate_scene_image',
  description: 'Gera a imagem de UMA cena desta produção, pelo número dela. '
    + 'Use sempre que o pedido for produzir a mídia de uma cena — "gere uma imagem para a '
    + 'cena 1", "quero ver a cena 3". Nunca use a geração de imagem avulsa para isso: '
    + 'só esta ferramenta liga o resultado à cena. '
    + 'O prompt é a direção visual, escrita por você a partir do que a cena diz que se vê '
    + '— leia a cena antes se não a tiver em mãos. '
    + 'Cada chamada cria um take NOVO; a anterior não é apagada. '
    + 'Responde assim que o trabalho é aceito, e o estúdio acompanha sozinho até o fim: '
    + 'não espere, não pergunte de novo e não peça ao usuário para voltar depois.',
  inputSchema: {
    type: 'object',
    properties: {
      ordinal: {
        type: 'integer',
        description: 'O número da cena na produção, começando em 1.',
      },
      prompt: {
        type: 'string',
        description: 'A direção visual desta imagem, em palavras de cinema — o que se vê, '
          + 'o enquadramento, a luz. Construa a partir da descrição visual e do propósito '
          + 'da cena, e do tom da produção.',
      },
    },
    required: ['ordinal', 'prompt'],
  },

  async execute(context, args, deps = {}) {
    const { db, projectId, threadId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'prompt']));
    const { iniciar = startImageGeneration, acompanhar = watchJob } = deps;

    const ordinal = Number(entrada.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      throw new ToolExecutionError(
        'Informe o número da cena, começando em 1.',
        {},
      );
    }

    const prompt = typeof entrada.prompt === 'string' ? entrada.prompt.trim() : '';
    if (!prompt) {
      throw new ToolExecutionError(
        'Escreva a direção visual desta imagem: o que se vê na cena.',
        {},
      );
    }
    if (prompt.length > MAX_PROMPT) {
      throw new ToolExecutionError(
        `A direção visual passa de ${MAX_PROMPT} caracteres.`,
        {},
      );
    }

    // A cena precisa existir NESTE projeto. `getProductionScene` resolve pelo
    // roteiro do projeto do contexto, então "cena de outro projeto" não é uma
    // recusa: é uma coisa que não dá para pedir. Ver o cabeçalho de
    // `production.js`.
    const cena = getProductionScene(projectId, ordinal, db);
    if (!cena) {
      throw new ToolExecutionError(
        `Esta produção não tem uma cena ${ordinal}.`,
        {},
      );
    }

    // ── o formato é da PRODUÇÃO, não do pedido ──────────────────────────
    //
    // `aspectRatio` sai do plano — o mesmo para todas as cenas, porque um
    // filme tem UM formato. Não é argumento da ferramenta de propósito: um
    // modelo que pudesse escolher escolheria por cena, e a produção sairia
    // metade em 16:9 e metade em 9:16, cada pedaço plausível sozinho.
    //
    // Nenhum plano é impossível aqui (não há cena sem roteiro, e não há
    // roteiro sem plano), mas a ausência é recusada em vez de virar um padrão:
    // um 16:9 silencioso seria a decisão errada tomada por omissão.
    const plano = getProductionPlan(projectId, db);
    if (!plano) {
      throw new ToolExecutionError(
        'Esta produção ainda não tem um plano; grave o plano antes de gerar mídia.',
        {},
      );
    }

    // ── a ordem, que é a razão de este trecho existir ────────────────────
    //
    // O take nasce DENTRO da geração, na janela entre o registro durável do
    // trabalho e a submissão ao executor — é para isso que `aoRegistrar`
    // existe. As duas ordens ingênuas são piores, e cada uma de um jeito:
    //
    //   take primeiro, geração depois → se a submissão falha, sobra um take
    //   vazio (sem job e sem Asset), que ninguém consegue distinguir de uma
    //   geração que nunca começou;
    //
    //   geração primeiro, take depois → se o take falha, existe um trabalho
    //   real rodando na GPU que nunca vai encontrar o lugar dele.
    //
    // Com o gancho, o take já nasce apontando para o job, e nada foi submetido
    // ainda. Uma falha aqui deixa o registro em `preparing` sem identificador
    // do executor — que é exatamente a situação que a reconciliação já trata, e
    // sem inventar estado nenhum.
    let take = null;
    try {
      const resultado = await iniciar(
        { prompt, aspect: plano.aspectRatio },
        {
          projectId,
          threadId,
          userMessageId: context.userMessageId ?? null,
          db,
          aoRegistrar: ({ jobId }) => {
            take = createSceneTake(
              projectId, ordinal, { kind: 'image', generationJobId: jobId }, db,
            );
          },
        },
      );

      // O acompanhamento nasce do RESULTADO ESTRUTURADO e do contexto que o
      // servidor montou — nunca de algo que o modelo escreveu. O `signal` do
      // turno fica de fora de propósito: parar a conversa interrompe a fala do
      // agente, não o trabalho que já foi aceito.
      acompanhar({
        jobId: resultado.jobId,
        kind: resultado.kind,
        threadId,
        projectId,
      });

      // ── o que sai daqui ────────────────────────────────────────────────
      //
      // Onde a imagem vai aparecer, e que o trabalho começou. Só isso.
      //
      // Não sai `jobId` — o take já é o endereço desta geração dentro da cena,
      // e um identificador de job na mão do modelo é um identificador que ele
      // vai tentar usar noutro lugar. Não sai o `id` da mídia, não sai caminho,
      // não sai workflow nem provider: nada disso é do modelo.
      return {
        ordinal: cena.ordinal,
        kind: 'image',
        takeNumber: take.takeNumber,
        status: resultado.status,
      };
    } catch (erro) {
      if (erro?.name === 'GenerationError' || erro?.name === 'DomainError') {
        throw comoErroDeFerramenta(erro, 'Não consegui iniciar a imagem desta cena.');
      }
      if (erro?.name === 'ToolExecutionError') throw erro;
      throw new ToolExecutionError('Não consegui iniciar a imagem desta cena.', {});
    }
  },
});
