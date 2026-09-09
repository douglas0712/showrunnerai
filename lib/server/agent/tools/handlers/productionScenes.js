// Tools de cena: project.list_scenes · project.get_scene ·
//                 project.replace_scenes · project.update_scene
//
// As cenas são o coração do PASSO 12. Uma cena responde a quatro perguntas:
// qual a sua posição, quanto dura, o que ela quer comunicar, e o que se ouve e
// se vê nela.
//
// ── Uma cena é endereçada pela POSIÇÃO, nunca por um identificador ──────────
//
// O usuário diz "a cena 4". O modelo passa `ordinal: 4`. E `ordinal` é sempre
// relativo ao projeto do ToolContext — a quarta cena DESTE roteiro.
//
// Isso não é conveniência de escrita: é a fronteira. Um `sceneId` seria um
// identificador que o modelo carrega, pode confundir entre projetos e pode
// inventar — e sobraria para o servidor conferir de onde ele veio. Com a
// posição não há o que conferir: não existe um número que signifique "a cena de
// outro projeto". Cross-project deixa de ser recusado e passa a ser
// impronunciável.
//
// É pela mesma razão que o `id` da cena não aparece em nenhum resultado. Ele é
// nome de coisa nossa, como o `jobId` de uma geração.
//
// ── Por que existem list_scenes E get_scene ─────────────────────────────────
//
// Porque são dois usos com tamanhos diferentes. `list_scenes` é para ESCOLHER:
// número, título, propósito e duração, de todas. `get_scene` é para LER uma:
// com a narração e a descrição visual inteiras. Uma lista que trouxesse os
// textos longos de quarenta cenas não caberia no turno — e quem lista está
// procurando, não lendo.
//
// ── Por que existem replace_scenes E update_scene ───────────────────────────
//
// `replace_scenes` é a criação: o conjunto inteiro de uma vez, porque o
// conjunto tem propriedades que uma cena sozinha não tem — os números formam
// 1..n e a soma bate com a duração alvo. Dez chamadas separadas passariam por
// nove estados em que nenhuma das duas coisas é verdade.
//
// `update_scene` é a edição: "deixe a cena 3 mais dramática" muda a cena 3, e
// as outras não são sequer lidas. Regravar o conjunto para mudar uma frase
// faria o modelo reescrever as outras nove — e reescrever é onde ele muda
// alguma sem querer.

import { defineTool, ToolExecutionError } from '../schema.js';
import {
  DURATION_TOLERANCE_SECONDS, editableSceneFields, getProductionScene,
  listProductionScenes, MAX_SCENES, productionSummary, publicProductionScene,
  publicProductionSceneSummary, replaceProductionScenes, sceneFields,
  updateProductionScene,
} from '../../../domain/production.js';
import {
  argumentosValidos, comoErroDeFerramenta, contextoValido, semArgumentos,
} from './productionPlan.js';

const CAMPOS_DE_CENA = sceneFields();
const EDITAVEIS = editableSceneFields();

/** A forma de uma cena nos schemas. Uma definição, usada nas duas ferramentas. */
const PROPRIEDADES_DE_CENA = Object.freeze({
  ordinal: {
    type: 'integer',
    description: 'A posição da cena na produção, começando em 1. '
      + 'Numa gravação de todas as cenas, os números vão de 1 até a quantidade de cenas, '
      + 'sem repetir e sem pular.',
  },
  title: { type: 'string', description: 'Título curto da cena.' },
  purpose: {
    type: 'string',
    description: 'O que esta cena quer comunicar — o papel dela na narrativa.',
  },
  durationSeconds: {
    type: 'integer',
    description: 'Duração da cena em segundos inteiros, maior que zero.',
  },
  narration: {
    type: 'string',
    description: 'O texto narrado nesta cena. Deixe vazio se não houver narração.',
  },
  visualDescription: {
    type: 'string',
    description: 'O que se vê: enquadramento, ambiente, luz, movimento de câmera. '
      + 'Descreva a cena em linguagem de direção, não como instrução para um gerador.',
  },
});

export const listScenesTool = defineTool({
  name: 'project.list_scenes',
  description: 'Lista as cenas desta produção, na ordem, com número, título, propósito e '
    + 'duração — e a soma das durações comparada com a duração alvo. '
    + 'Use para saber a estrutura atual antes de mudar qualquer coisa, e para descobrir '
    + 'qual é a cena que o usuário mencionou. '
    + 'A narração e a descrição visual não vêm nesta lista; para ler uma cena inteira, '
    + 'use a ferramenta de leitura de cena.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    semArgumentos(args);

    const cenas = listProductionScenes(projectId, db);
    const resumo = productionSummary(projectId, db);

    return {
      sceneCount: resumo.sceneCount,
      totalDurationSeconds: resumo.totalDurationSeconds,
      targetDurationSeconds: resumo.targetDurationSeconds,
      scenes: cenas.map(publicProductionSceneSummary),
    };
  },
});

export const getSceneTool = defineTool({
  name: 'project.get_scene',
  description: 'Devolve uma cena inteira desta produção, pelo número dela — incluindo a '
    + 'narração e a descrição visual. '
    + 'Use antes de alterar uma cena, para partir do que está gravado em vez do que você '
    + 'lembra da conversa.',
  inputSchema: {
    type: 'object',
    properties: {
      ordinal: PROPRIEDADES_DE_CENA.ordinal,
    },
    required: ['ordinal'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal']));
    const ordinal = ordinalValido(entrada.ordinal);

    const cena = getProductionScene(projectId, ordinal, db);
    if (!cena) {
      throw new ToolExecutionError(`Esta produção não tem uma cena ${ordinal}.`, {});
    }

    return { scene: publicProductionScene(cena) };
  },
});

export const replaceScenesTool = defineTool({
  name: 'project.replace_scenes',
  description: 'Grava o plano de cenas desta produção INTEIRO, de uma vez, substituindo o '
    + 'que houver. Exige que o plano de produção e o roteiro já estejam gravados. '
    + `Aceita no máximo ${MAX_SCENES} cenas. `
    + 'Os números das cenas vão de 1 até a quantidade de cenas, sem repetir e sem pular. '
    + 'A soma das durações precisa ficar perto da duração alvo do plano — a diferença '
    + `aceita é de até ${DURATION_TOLERANCE_SECONDS} segundos. Se a soma não bater, a `
    + 'gravação é recusada e a mensagem diz o quanto falta; ajuste e grave de novo. '
    + 'Use esta ferramenta para CRIAR o plano de cenas. Para mudar uma cena depois, use a '
    + 'ferramenta de alteração de cena — regravar tudo para mudar uma cena reescreve as outras.',
  inputSchema: {
    type: 'object',
    properties: {
      scenes: {
        type: 'array',
        description: 'As cenas da produção, na ordem.',
        items: {
          type: 'object',
          properties: PROPRIEDADES_DE_CENA,
          required: ['ordinal', 'title', 'durationSeconds'],
        },
      },
    },
    required: ['scenes'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['scenes']));

    if (!Array.isArray(entrada.scenes)) {
      throw new ToolExecutionError('As cenas precisam vir numa lista.', {});
    }

    try {
      const cenas = replaceProductionScenes(projectId, entrada.scenes, db);
      const resumo = productionSummary(projectId, db);
      return {
        sceneCount: resumo.sceneCount,
        totalDurationSeconds: resumo.totalDurationSeconds,
        targetDurationSeconds: resumo.targetDurationSeconds,
        scenes: cenas.map(publicProductionSceneSummary),
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não consegui gravar as cenas.');
    }
  },
});

export const updateSceneTool = defineTool({
  name: 'project.update_scene',
  description: 'Altera UMA cena desta produção, pelo número dela. As outras cenas não são '
    + 'tocadas. '
    + 'Use sempre que o pedido for localizado — "deixe a cena 3 mais dramática", '
    + '"reduza a cena 5 para 10 segundos". Nunca regrave todas as cenas para mudar uma. '
    + `Informe ${EDITAVEIS.join(', ')} — apenas os campos que mudam. `
    + 'A resposta traz a nova soma das durações da produção; se ela ficar longe da duração '
    + 'alvo, diga isso ao usuário em vez de corrigir por conta própria.',
  inputSchema: {
    type: 'object',
    properties: {
      ordinal: PROPRIEDADES_DE_CENA.ordinal,
      title: PROPRIEDADES_DE_CENA.title,
      purpose: PROPRIEDADES_DE_CENA.purpose,
      durationSeconds: PROPRIEDADES_DE_CENA.durationSeconds,
      narration: PROPRIEDADES_DE_CENA.narration,
      visualDescription: PROPRIEDADES_DE_CENA.visualDescription,
    },
    required: ['ordinal'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(CAMPOS_DE_CENA));
    const ordinal = ordinalValido(entrada.ordinal);

    const patch = {};
    for (const campo of EDITAVEIS) {
      if (entrada[campo] !== undefined) patch[campo] = entrada[campo];
    }
    if (Object.keys(patch).length === 0) {
      throw new ToolExecutionError(
        `Diga o que muda nesta cena: ${EDITAVEIS.join(', ')}.`,
        {},
      );
    }

    try {
      const cena = updateProductionScene(projectId, ordinal, patch, db);
      const resumo = productionSummary(projectId, db);
      return {
        scene: publicProductionScene(cena),
        totalDurationSeconds: resumo.totalDurationSeconds,
        targetDurationSeconds: resumo.targetDurationSeconds,
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não consegui alterar esta cena.');
    }
  },
});

/**
 * O número de uma cena.
 *
 * Nada de coerção solta: `Number("")` é 0 e `Number([])` também, e um ordinal
 * que vira 0 em silêncio é um pedido que se transforma noutro. O que vale é o
 * que ele É — um inteiro, ou os dígitos dele.
 */
function ordinalValido(valor) {
  const ehInteiro = typeof valor === 'number' && Number.isInteger(valor);
  const ehDigitos = typeof valor === 'string' && /^\d+$/.test(valor);
  if (!ehInteiro && !ehDigitos) {
    throw new ToolExecutionError(
      'O número da cena precisa ser um inteiro — a posição dela na produção.',
      {},
    );
  }
  const n = Number(valor);
  if (n < 1) {
    throw new ToolExecutionError('As cenas começam na número 1.', {});
  }
  return n;
}
