// Tool project.generate_scene_video
//
// PASSO 13-C. É aqui que a imagem escolhida de uma cena ganha movimento.
//
// ── Por que esta ferramenta existe separada de `og.generate_video` ──────────
//
// Porque aquela ferramenta anima uma imagem QUE O MODELO INDICA. Ela recebe
// `sourceAssetId`, e é o modelo que decide qual imagem é. Isso funciona numa
// conversa — "anime essa imagem" tem um antecedente óbvio no chat —, e não
// funciona numa produção: perguntado qual é a imagem da cena 1, o modelo
// responderia pela memória, e a memória escolhe a imagem errada exatamente
// depois de uma regeneração que ele não viu acontecer.
//
// Aqui o modelo não escolhe imagem nenhuma. Ele diz QUAL CENA, e o servidor
// resolve a imagem a partir do estado gravado: a seleção de imagem daquela
// cena, e só ela.
//
// ── Por que um arquivo à parte ──────────────────────────────────────────────
//
// Mesma divisão de `generateImage.js` e `generateVideo.js`: imagem e vídeo são
// dois pedidos, com duas pré-condições diferentes. Gerar imagem não exige nada
// da cena; gerar vídeo exige uma imagem escolhida — e é essa exigência que faz
// quase todo o corpo desta ferramenta.
//
// ── O que NÃO existe aqui ───────────────────────────────────────────────────
//
// Nenhum caminho alternativo. Sem imagem escolhida a resposta é RECUSAR, com
// uma frase que diz o que fazer. O que a ferramenta nunca faz:
//
//   - pegar "a última imagem" da cena;
//   - escolher um take por conta própria;
//   - procurar outro Asset de imagem do projeto;
//   - cair para texto → vídeo em silêncio.
//
// O último é o pior dos quatro, e é por isso que ele é o mais tentador: um T2V
// devolve um vídeo bonito, o usuário não percebe nada, e a cena que ele
// aprovou não é a que está no filme. Uma recusa é constrangedora por dois
// segundos; um T2V silencioso estraga a produção sem avisar.
//
// ── Nada de MiniMax aqui ────────────────────────────────────────────────────
//
// Esta ferramenta não conhece workflow, nó, provider nem modo de geração. Ela
// chama a MESMA `startVideoGeneration` de sempre e passa `sourceAssetId`. Quem
// transforma isso em `frames.first` → `LoadImage` → `first_frame` é o
// descriptor, e é lá que essa tradução deve continuar morando.

import { defineTool, ToolExecutionError } from '../schema.js';
import { startVideoGeneration } from '../../../generation/facade.js';
import { createSceneTake, getSceneSelection } from '../../../domain/sceneMedia.js';
import { getProductionPlan, getProductionScene } from '../../../domain/production.js';
import { getAsset } from '../../../domain/assets.js';
import { watchJob } from '../jobWatch.js';
import {
  argumentosValidos, comoErroDeFerramenta, contextoValido,
} from './productionPlan.js';

/** Teto do texto de direção. O mesmo das outras gerações. */
const MAX_PROMPT = 4000;

/**
 * A frase que o usuário precisa ler quando não há de onde animar.
 *
 * Uma só para os quatro casos — sem seleção, take sem mídia, Asset sumido,
 * Asset do tipo errado — de propósito. Para quem pediu, os quatro são a mesma
 * situação ("não há imagem pronta") e têm a mesma saída ("gere uma"), e
 * distingui-los só serviria para contar de dentro o que a diferença é.
 */
const SEM_IMAGEM = 'A cena %s ainda não tem uma imagem pronta para animar. '
  + 'Gere a imagem da cena antes de pedir o vídeo.';

export const generateSceneVideoTool = defineTool({
  name: 'project.generate_scene_video',
  description: 'Anima a imagem JÁ ESCOLHIDA de uma cena desta produção, pelo número dela. '
    + 'Use sempre que o pedido for dar movimento a uma cena — "anime a cena 1", '
    + '"transforme a cena 3 em vídeo". Nunca use a geração de vídeo avulsa para isso, e '
    + 'nunca informe qual imagem animar: o estúdio usa a imagem escolhida da cena, e só '
    + 'ela. Se a cena ainda não tiver imagem, gere a imagem primeiro. '
    + 'O prompt é a direção do MOVIMENTO — o que se move, como a câmera anda —, não uma '
    + 'nova descrição do quadro, que já está na imagem. '
    + 'Cada chamada cria um take NOVO; o anterior não é apagado. '
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
        description: 'A direção do movimento desta cena, em palavras de cinema — o que se '
          + 'move no quadro, para onde a câmera anda, o ritmo. O que se VÊ já está na '
          + 'imagem escolhida; aqui se descreve o que ACONTECE.',
      },
    },
    required: ['ordinal', 'prompt'],
  },

  async execute(context, args, deps = {}) {
    const { db, projectId, threadId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'prompt']));
    const { iniciar = startVideoGeneration, acompanhar = watchJob } = deps;

    const ordinal = Number(entrada.ordinal);
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      throw new ToolExecutionError('Informe o número da cena, começando em 1.', {});
    }

    const prompt = typeof entrada.prompt === 'string' ? entrada.prompt.trim() : '';
    if (!prompt) {
      throw new ToolExecutionError(
        'Escreva a direção do movimento desta cena: o que acontece no quadro.',
        {},
      );
    }
    if (prompt.length > MAX_PROMPT) {
      throw new ToolExecutionError(
        `A direção do movimento passa de ${MAX_PROMPT} caracteres.`,
        {},
      );
    }

    const cena = getProductionScene(projectId, ordinal, db);
    if (!cena) {
      throw new ToolExecutionError(`Esta produção não tem uma cena ${ordinal}.`, {});
    }

    // O formato é da PRODUÇÃO — ver o mesmo trecho em `generate_scene_image`.
    const plano = getProductionPlan(projectId, db);
    if (!plano) {
      throw new ToolExecutionError(
        'Esta produção ainda não tem um plano; grave o plano antes de gerar mídia.',
        {},
      );
    }

    // ── o que NÃO é lido daqui: cena.durationSeconds ────────────────────
    //
    // A duração da cena é NARRATIVA — quanto daquele trecho do filme ela
    // ocupa. A duração de um clipe é técnica: quanto o gerador consegue
    // produzir de uma vez. As duas são números em segundos e não são a mesma
    // coisa, e tratá-las como se fossem é o erro que este comentário existe
    // para impedir.
    //
    // Uma cena de 18 segundos não é, por definição, "um vídeo de 18 segundos".
    // Passar 18 adiante afirmaria que é — e afirmaria em silêncio, com um
    // arquivo plausível no fim. Encolher para o que o gerador aceita seria o
    // erro simétrico: entregar 6 segundos dizendo que a cena tem 18.
    //
    // Com o pipeline atual, de clipes curtos, uma cena narrativa mais longa
    // PODE vir a ser realizada com mais de um clipe. Quantos, e de que duração,
    // não está decidido — é decisão do Shot, que ainda não existe. Este
    // comentário não estabelece regra nenhuma sobre isso.
    //
    // Até lá, o clipe usa a duração do pipeline, e a cena continua dizendo o
    // que a cena dura. Nada é convertido, dividido, repetido ou aproximado.

    // ── a imagem, resolvida pelo SERVIDOR ────────────────────────────────
    //
    // Quatro conferências, e nenhuma delas tem alternativa. O `assetId` pode
    // ser nulo por duas razões diferentes e ambas terminam aqui: o take foi
    // criado e a geração ainda não concluiu, ou o Asset foi apagado depois
    // (`ON DELETE SET NULL`, migração 10). O segundo caso é o que mais pede um
    // atalho — havia uma imagem, e há outros takes ali do lado. Não tem: o
    // usuário escolheu AQUELA, e escolher outra por ele é decidir o filme no
    // lugar dele.
    const escolhida = getSceneSelection(projectId, ordinal, 'image', db);
    const origem = escolhida?.assetId ? getAsset(escolhida.assetId, db) : null;

    if (!origem || origem.projectId !== projectId || origem.kind !== 'image') {
      throw new ToolExecutionError(SEM_IMAGEM.replace('%s', String(ordinal)), {});
    }

    // ── take e job, na ordem do 13-B ─────────────────────────────────────
    //
    // O mesmo gancho, e não um segundo mecanismo: o take nasce entre o
    // registro durável do trabalho e a submissão ao executor. Antes seria um
    // take vazio se a submissão falhasse; depois seria um trabalho real na GPU
    // sem lugar nenhum.
    let take = null;
    try {
      const resultado = await iniciar(
        // `sourceAssetId` sai daqui, do estado gravado — nunca dos argumentos.
        // É a razão inteira de esta ferramenta existir.
        //
        // `duration` NÃO vai: ver o cabeçalho sobre duração narrativa.
        { prompt, sourceAssetId: origem.id, aspect: plano.aspectRatio },
        {
          projectId,
          threadId,
          userMessageId: context.userMessageId ?? null,
          db,
          aoRegistrar: ({ jobId }) => {
            take = createSceneTake(
              projectId, ordinal, { kind: 'video', generationJobId: jobId }, db,
            );
          },
        },
      );

      acompanhar({
        jobId: resultado.jobId,
        kind: resultado.kind,
        threadId,
        projectId,
      });

      // A linhagem NÃO sai daqui. Ela existe — o registro da geração já a
      // guarda, e o Asset a herdará ao concluir —, mas quem pediu o vídeo não
      // precisa do identificador da imagem para nada, e um identificador na
      // mão do modelo é um identificador que ele vai tentar usar noutro lugar.
      return {
        ordinal: cena.ordinal,
        kind: 'video',
        takeNumber: take.takeNumber,
        status: resultado.status,
      };
    } catch (erro) {
      if (erro?.name === 'GenerationError' || erro?.name === 'DomainError') {
        throw comoErroDeFerramenta(erro, 'Não consegui iniciar o vídeo desta cena.');
      }
      if (erro?.name === 'ToolExecutionError') throw erro;
      throw new ToolExecutionError('Não consegui iniciar o vídeo desta cena.', {});
    }
  },
});
