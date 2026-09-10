// Tools de NARRAÇÃO — o texto falado de uma cena, e as vozes gravadas dele.
//
// PASSO 14-E. É aqui que "gere a narração da cena 3" e "use a segunda" deixam
// de ser frases que o agente entende e viram coisas que o Project sabe.
//
// ── O que o modelo NÃO decide ───────────────────────────────────────────────
//
// Voz, modelo, provider, seed, workflow, caminho de arquivo, número do take,
// impressão do texto. Nada disso entra pela porta: `argumentosValidos` recusa
// qualquer propriedade fora do schema, e o schema só tem o que é audiovisual —
// a cena, o texto, o número do take.
//
// O usuário fala "narração", "take", "cena". Quem sabe que existe um
// sintetizador do outro lado é o servidor, e ele não conta.
//
// ── Por que `set` e `generate` são duas ferramentas ─────────────────────────
//
// Porque são dois atos diferentes, e confundi-los seria caro. Escrever o texto
// é planejamento e não custa nada; gravar a voz ocupa uma máquina. Uma
// ferramenta só faria toda correção de vírgula disparar uma síntese.

import { defineTool, ToolExecutionError } from '../schema.js';
import { sceneNarration } from '../../../domain/narration.js';
import { getProductionScene, updateProductionScene } from '../../../domain/production.js';
import {
  getNarrationAudioSelection, listNarrationAudioTakes, NARRATION_ROLE,
  selectNarrationAudioTake,
} from '../../../domain/sceneAudio.js';
import { startNarrationGeneration } from '../../../generation/narration.js';
import { getGenerationJobRecord } from '../../../domain/generationJobs.js';
import {
  argumentosValidos, comoErroDeFerramenta, contextoValido,
} from './productionPlan.js';

const ORDINAL = Object.freeze({
  type: 'integer',
  description: 'O número da cena na produção, começando em 1.',
});

const TAKE_NUMBER = Object.freeze({
  type: 'integer',
  description: 'O número da tentativa (take), como aparece na listagem. Começa em 1.',
});

function ordinalValido(bruto) {
  const ordinal = Number(bruto);
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new ToolExecutionError('Informe o número da cena, começando em 1.', {});
  }
  return ordinal;
}

function numeroValido(bruto, oQue) {
  const n = Number(bruto);
  if (!Number.isInteger(n) || n < 1) {
    throw new ToolExecutionError(`Informe o número ${oQue}, começando em 1.`, {});
  }
  return n;
}

function exigirCena(projectId, ordinal, db) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) {
    throw new ToolExecutionError(`Esta produção não tem uma cena ${ordinal}.`, { ordinal });
  }
  return cena;
}

/**
 * A situação de um take, em linguagem de produção.
 *
 * `selected` e `current` são as duas dimensões que o agente precisa para
 * explicar o estado sem inventar: uma diz o que está valendo, a outra diz se
 * ainda corresponde ao texto que está na cena. Um take pode ser as duas coisas,
 * nenhuma, ou — o caso que importa — `selected` sem ser `current`.
 *
 * `status` vem do livro-razão, e não de uma coluna: quem sabe se a gravação
 * terminou é o job. Sem Asset e sem job, a tentativa foi registrada e nunca saiu
 * do lugar.
 */
function takePublico(take, selecionado, db) {
  const job = take.generationJobId ? getGenerationJobRecord(take.generationJobId, db) : null;

  let status = 'registrada';
  if (take.assetId) status = 'pronta';
  else if (job && job.state === 'failed') status = 'falhou';
  else if (job && job.state === 'orphaned') status = 'interrompida';
  else if (job) status = 'gerando';

  return {
    takeNumber: take.takeNumber,
    selected: selecionado?.takeNumber === take.takeNumber,
    current: take.current === true,
    status,
  };
}

// ── o texto ─────────────────────────────────────────────────────────────────

export const getSceneNarrationTool = defineTool({
  name: 'project.get_scene_narration',
  description: 'Mostra o texto de narração de uma cena desta produção — o que será falado '
    + 'em voz alta. Consulte antes de responder "o que a cena 3 narra?" ou antes de '
    + 'reescrever: o que vale é o texto gravado, não o que foi dito na conversa. '
    + 'Uma cena pode legitimamente não ter narração; isso não é defeito.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL },
    required: ['ordinal'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal']));
    const ordinal = ordinalValido(entrada.ordinal);
    exigirCena(projectId, ordinal, db);

    try {
      const narracao = sceneNarration(projectId, ordinal, db);
      return {
        ordinal: narracao.ordinal,
        text: narracao.text,
        hasNarration: narracao.hasNarration,
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível ler a narração desta cena.');
    }
  },
});

export const setSceneNarrationTool = defineTool({
  name: 'project.set_scene_narration',
  description: 'Escreve ou reescreve o texto de narração de uma cena desta produção. '
    + 'É planejamento: escrever NÃO grava voz nenhuma — para isso use '
    + 'project.generate_scene_narration. '
    + 'Atenção ao reescrever: as vozes já gravadas continuam existindo, mas passam a ser '
    + 'de uma versão anterior do texto, e a listagem vai mostrá-las como não atuais. '
    + 'Texto vazio é aceito: uma cena pode ser só imagem ou silêncio.',
  inputSchema: {
    type: 'object',
    properties: {
      ordinal: ORDINAL,
      text: {
        type: 'string',
        description: 'O texto que será falado. Use string vazia para deixar a cena sem narração.',
      },
    },
    required: ['ordinal', 'text'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'text']));
    const ordinal = ordinalValido(entrada.ordinal);
    exigirCena(projectId, ordinal, db);

    if (typeof entrada.text !== 'string') {
      throw new ToolExecutionError('O texto da narração precisa ser uma string.', {});
    }

    try {
      updateProductionScene(projectId, ordinal, { narration: entrada.text }, db);
      const narracao = sceneNarration(projectId, ordinal, db);
      return {
        ordinal: narracao.ordinal,
        text: narracao.text,
        hasNarration: narracao.hasNarration,
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível gravar a narração desta cena.');
    }
  },
});

// ── a voz ───────────────────────────────────────────────────────────────────

export const generateSceneNarrationTool = defineTool({
  name: 'project.generate_scene_narration',
  description: 'Grava a voz da narração de uma cena desta produção, a partir do texto que '
    + 'já está escrito nela. Atende "gere a narração da cena 3". '
    + 'Chamar de novo na mesma cena cria uma NOVA tentativa (take) — é assim que se atende '
    + '"faça outra versão"; não existe comando separado para regerar. '
    + 'A gravação começa e o trabalho segue em segundo plano; use '
    + 'project.list_scene_narration_takes para saber como ficou. '
    + 'Se ainda não houver seleção, a primeira voz pronta do texto atual passa a valer '
    + 'sozinha; se já houver uma escolhida e ela ainda for do texto atual, ela é mantida.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL },
    required: ['ordinal'],
  },

  // `deps` é o terceiro parâmetro com default, no estilo da casa. O registry
  // chama `execute(context, args)` e nunca o informa, então em produção ele é
  // sempre o serviço real; é o teste que injeta um duplo para provar a
  // delegação sem acordar sintetizador nenhum.
  async execute(context, args, deps = {}) {
    const { gerar = startNarrationGeneration } = deps;
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal']));
    const ordinal = ordinalValido(entrada.ordinal);
    exigirCena(projectId, ordinal, db);

    try {
      const inicio = await gerar({ projectId, ordinal }, { db });
      return {
        ordinal: inicio.ordinal,
        takeNumber: inicio.takeNumber,
        status: 'started',
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível gravar a narração desta cena.');
    }
  },
});

export const listSceneNarrationTakesTool = defineTool({
  name: 'project.list_scene_narration_takes',
  description: 'Lista as vozes já gravadas para a narração de uma cena desta produção: o '
    + 'número de cada tentativa (take), a situação, qual está escolhida e se ainda '
    + 'corresponde ao texto atual da cena. '
    + 'Consulte SEMPRE antes de agir sobre "a segunda", "a outra" ou "essa voz", e antes '
    + 'de responder qualquer pergunta sobre o que já existe. '
    + 'Um take com selected verdadeiro e current falso significa que a voz escolhida foi '
    + 'gravada antes da última alteração do texto.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL },
    required: ['ordinal'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal']));
    const ordinal = ordinalValido(entrada.ordinal);
    exigirCena(projectId, ordinal, db);

    try {
      const narracao = sceneNarration(projectId, ordinal, db);
      const selecionado = getNarrationAudioSelection(projectId, ordinal, NARRATION_ROLE, db);
      const takes = listNarrationAudioTakes(projectId, ordinal, NARRATION_ROLE, db);

      return {
        ordinal,
        hasNarration: narracao.hasNarration,
        takes: takes.map((take) => takePublico(take, selecionado, db)),
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível listar as narrações desta cena.');
    }
  },
});

export const selectSceneNarrationTakeTool = defineTool({
  name: 'project.select_scene_narration_take',
  description: 'Escolhe qual voz gravada passa a valer para a narração de uma cena desta '
    + 'produção. É o que atende "use a segunda", "prefiro a primeira", "fica com essa". '
    + 'Escolher NÃO apaga nada e NÃO grava nada: só move o ponteiro, e dá para voltar. '
    + 'Use o número que aparece em project.list_scene_narration_takes.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL, takeNumber: TAKE_NUMBER },
    required: ['ordinal', 'takeNumber'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'takeNumber']));
    const ordinal = ordinalValido(entrada.ordinal);
    const takeNumber = numeroValido(entrada.takeNumber, 'do take');
    exigirCena(projectId, ordinal, db);

    try {
      const escolhido = selectNarrationAudioTake(
        projectId, ordinal, { role: NARRATION_ROLE, takeNumber }, db,
      );
      return {
        ordinal,
        takeNumber: escolhido.takeNumber,
        current: escolhido.current === true,
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível escolher esta narração.');
    }
  },
});
