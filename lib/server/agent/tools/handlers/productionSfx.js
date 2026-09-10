// Tools de EFEITO SONORO — os eventos de som de uma cena.
//
// PASSO 14-E. É aqui que "adicione um trovão na cena 4" vira uma decisão
// gravada, e "use o segundo" vira efeito.
//
// ── Por que uma cena tem VÁRIOS efeitos ─────────────────────────────────────
//
// Porque o trovão, a porta e os passos coexistem. Cada um é uma CUE, com número
// próprio e escolha própria — e é por isso que estas ferramentas pedem
// `cueNumber` onde as de narração não pedem nada: a cena tem uma narração e
// pode ter dez efeitos.
//
// ── O que o modelo NÃO decide ───────────────────────────────────────────────
//
// Modelo, provider, seed, duração, workflow, caminho, número da cue, número do
// take, impressão do texto. O schema só tem o que é audiovisual, e
// `argumentosValidos` recusa o resto.

import { defineTool, ToolExecutionError } from '../schema.js';
import { getProductionScene } from '../../../domain/production.js';
import {
  createSceneSfxCue, deleteSceneSfxCue, getSceneSfxSelection, listSceneSfxCues,
  listSceneSfxTakes, selectSceneSfxTake, updateSceneSfxCue,
} from '../../../domain/sceneSfx.js';
import { startSceneSfxGeneration } from '../../../generation/sceneSfx.js';
import { getGenerationJobRecord } from '../../../domain/generationJobs.js';
import {
  argumentosValidos, comoErroDeFerramenta, contextoValido,
} from './productionPlan.js';

const ORDINAL = Object.freeze({
  type: 'integer',
  description: 'O número da cena na produção, começando em 1.',
});

const CUE_NUMBER = Object.freeze({
  type: 'integer',
  description: 'O número do efeito dentro da cena, como aparece na listagem. Começa em 1.',
});

const TAKE_NUMBER = Object.freeze({
  type: 'integer',
  description: 'O número da tentativa (take), como aparece na listagem. Começa em 1.',
});

const DESCRIPTION = Object.freeze({
  type: 'string',
  description: 'O que se ouve, em palavras — por exemplo "porta metálica pesada fechando '
    + 'com impacto" ou "trovão distante durante uma tempestade". É deste texto que o som '
    + 'vai nascer.',
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

// ── as cues ─────────────────────────────────────────────────────────────────

export const createSceneSfxCueTool = defineTool({
  name: 'project.create_scene_sfx_cue',
  description: 'Acrescenta um efeito sonoro a uma cena desta produção — o que se ouve, '
    + 'escrito em palavras. Atende "adicione um trovão na cena 4". '
    + 'Isto é planejamento: NÃO gera som nenhum. Para gerar, use '
    + 'project.generate_scene_sfx depois. '
    + 'Uma cena pode ter vários efeitos ao mesmo tempo, e cada um recebe um número. '
    + 'O número é do estúdio, não seu.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL, description: DESCRIPTION },
    required: ['ordinal', 'description'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'description']));
    const ordinal = ordinalValido(entrada.ordinal);
    exigirCena(projectId, ordinal, db);

    try {
      const cue = createSceneSfxCue(projectId, ordinal, { description: entrada.description }, db);
      return { ordinal, cueNumber: cue.cueNumber, description: cue.description };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível acrescentar este efeito.');
    }
  },
});

export const updateSceneSfxCueTool = defineTool({
  name: 'project.update_scene_sfx_cue',
  description: 'Reescreve a descrição de um efeito sonoro de uma cena desta produção. '
    + 'Os sons já gerados continuam existindo, mas passam a ser de uma versão anterior da '
    + 'descrição, e a listagem vai mostrá-los como não atuais.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL, cueNumber: CUE_NUMBER, description: DESCRIPTION },
    required: ['ordinal', 'cueNumber', 'description'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'cueNumber', 'description']));
    const ordinal = ordinalValido(entrada.ordinal);
    const cueNumber = numeroValido(entrada.cueNumber, 'do efeito');
    exigirCena(projectId, ordinal, db);

    try {
      const cue = updateSceneSfxCue(
        projectId, ordinal, cueNumber, { description: entrada.description }, db,
      );
      return { ordinal, cueNumber: cue.cueNumber, description: cue.description };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível reescrever este efeito.');
    }
  },
});

export const listSceneSfxCuesTool = defineTool({
  name: 'project.list_scene_sfx_cues',
  description: 'Lista os efeitos sonoros de uma cena desta produção: o número de cada um, '
    + 'a descrição, quantas tentativas já existem e se há uma escolhida. '
    + 'Consulte SEMPRE antes de agir sobre "esse efeito", "o trovão" ou "o segundo".',
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
      const cues = listSceneSfxCues(projectId, ordinal, db).map((cue) => {
        const selecionado = getSceneSfxSelection(projectId, ordinal, cue.cueNumber, db);
        return {
          cueNumber: cue.cueNumber,
          description: cue.description,
          takes: listSceneSfxTakes(projectId, ordinal, cue.cueNumber, db).length,
          selectedTakeNumber: selecionado ? selecionado.takeNumber : null,
        };
      });
      return { ordinal, cues };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível listar os efeitos desta cena.');
    }
  },
});

export const deleteSceneSfxCueTool = defineTool({
  name: 'project.delete_scene_sfx_cue',
  description: 'Remove um efeito sonoro de uma cena desta produção, junto com as tentativas '
    + 'dele. Não dá para desfazer. '
    + 'Se houver uma geração em andamento para esse efeito, a remoção é recusada — espere '
    + 'ela terminar.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL, cueNumber: CUE_NUMBER },
    required: ['ordinal', 'cueNumber'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'cueNumber']));
    const ordinal = ordinalValido(entrada.ordinal);
    const cueNumber = numeroValido(entrada.cueNumber, 'do efeito');
    exigirCena(projectId, ordinal, db);

    try {
      deleteSceneSfxCue(projectId, ordinal, cueNumber, db);
      return { ordinal, cueNumber, removed: true };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível remover este efeito.');
    }
  },
});

// ── o som ───────────────────────────────────────────────────────────────────

export const generateSceneSfxTool = defineTool({
  name: 'project.generate_scene_sfx',
  description: 'Gera o som de um efeito de uma cena desta produção, a partir da descrição '
    + 'já escrita nele. Atende "gere esse efeito". '
    + 'Chamar de novo no mesmo efeito cria uma NOVA tentativa (take) — é assim que se '
    + 'atende "faça outra versão"; não existe comando separado para regerar. '
    + 'A geração começa e segue em segundo plano; use '
    + 'project.list_scene_sfx_takes para saber como ficou. '
    + 'Se ainda não houver seleção, o primeiro som pronto da descrição atual passa a valer '
    + 'sozinho; se já houver um escolhido e ele ainda for da descrição atual, ele é mantido.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL, cueNumber: CUE_NUMBER },
    required: ['ordinal', 'cueNumber'],
  },

  // `deps` com default, no estilo da casa: o registry nunca o informa, e é o
  // teste que injeta um duplo para provar a delegação sem chamar executor.
  async execute(context, args, deps = {}) {
    const { gerar = startSceneSfxGeneration } = deps;
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'cueNumber']));
    const ordinal = ordinalValido(entrada.ordinal);
    const cueNumber = numeroValido(entrada.cueNumber, 'do efeito');
    exigirCena(projectId, ordinal, db);

    try {
      const inicio = await gerar({ projectId, ordinal, cueNumber }, { db });
      return {
        ordinal: inicio.ordinal,
        cueNumber: inicio.cueNumber,
        takeNumber: inicio.takeNumber,
        status: 'started',
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível gerar este efeito.');
    }
  },
});

export const listSceneSfxTakesTool = defineTool({
  name: 'project.list_scene_sfx_takes',
  description: 'Lista os sons já gerados para um efeito de uma cena desta produção: o número '
    + 'de cada tentativa, a situação, qual está escolhida e se ainda corresponde à descrição '
    + 'atual do efeito. '
    + 'Um take com selected verdadeiro e current falso significa que o som escolhido foi '
    + 'gerado antes da última alteração da descrição.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL, cueNumber: CUE_NUMBER },
    required: ['ordinal', 'cueNumber'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'cueNumber']));
    const ordinal = ordinalValido(entrada.ordinal);
    const cueNumber = numeroValido(entrada.cueNumber, 'do efeito');
    exigirCena(projectId, ordinal, db);

    try {
      const selecionado = getSceneSfxSelection(projectId, ordinal, cueNumber, db);
      const takes = listSceneSfxTakes(projectId, ordinal, cueNumber, db);
      if (takes.length === 0 && selecionado === null) {
        // A cue pode simplesmente não existir; o domínio devolve lista vazia
        // para os dois casos, e é a listagem de cues que distingue.
        listSceneSfxCues(projectId, ordinal, db);
      }
      return {
        ordinal,
        cueNumber,
        takes: takes.map((take) => takePublico(take, selecionado, db)),
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível listar os sons deste efeito.');
    }
  },
});

export const selectSceneSfxTakeTool = defineTool({
  name: 'project.select_scene_sfx_take',
  description: 'Escolhe qual som gerado passa a valer para um efeito de uma cena desta '
    + 'produção. É o que atende "use o segundo", "prefiro o primeiro". '
    + 'Escolher NÃO apaga nada e NÃO gera nada: só move o ponteiro, e dá para voltar. '
    + 'Cada efeito tem a sua própria escolha — escolher o trovão não mexe nos passos.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL, cueNumber: CUE_NUMBER, takeNumber: TAKE_NUMBER },
    required: ['ordinal', 'cueNumber', 'takeNumber'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'cueNumber', 'takeNumber']));
    const ordinal = ordinalValido(entrada.ordinal);
    const cueNumber = numeroValido(entrada.cueNumber, 'do efeito');
    const takeNumber = numeroValido(entrada.takeNumber, 'do take');
    exigirCena(projectId, ordinal, db);

    try {
      const escolhido = selectSceneSfxTake(projectId, ordinal, cueNumber, takeNumber, {}, db);
      return {
        ordinal,
        cueNumber,
        takeNumber: escolhido.takeNumber,
        current: escolhido.current === true,
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível escolher este som.');
    }
  },
});
