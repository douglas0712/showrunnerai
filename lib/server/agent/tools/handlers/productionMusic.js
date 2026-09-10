// Tools de MÚSICA — a trilha da produção.
//
// PASSO 14-E. É aqui que "crie uma trilha sombria para esse documentário" vira
// uma decisão gravada, e "use a segunda" vira trilha.
//
// ── Por que estas ferramentas NÃO pedem cena ────────────────────────────────
//
// Porque a música é da PRODUÇÃO, não de uma cena. Uma trilha atravessa cenas —
// o tema que entra na chegada do trem e segue por mais três não pertence a
// nenhuma delas. Pedir `ordinal` aqui obrigaria a eleger uma cena dona, e faria
// a peça parecer morrer quando aquela cena fosse reescrita.
//
// É a diferença que separa esta família das outras duas:
//
//     narração  uma por CENA
//     efeito    vários por CENA
//     música    vários por PRODUÇÃO
//
// Quando existir uma linha do tempo, é ela que dirá em que ponto cada peça
// entra. Não é este passo, e não é esta ferramenta.

import { defineTool, ToolExecutionError } from '../schema.js';
import {
  createProductionMusicCue, deleteProductionMusicCue, getProductionMusicSelection,
  listProductionMusicCues, listProductionMusicTakes, selectProductionMusicTake,
  updateProductionMusicCue,
} from '../../../domain/music.js';
import { startProductionMusicGeneration } from '../../../generation/music.js';
import { getGenerationJobRecord } from '../../../domain/generationJobs.js';
import {
  argumentosValidos, comoErroDeFerramenta, contextoValido,
} from './productionPlan.js';

const CUE_NUMBER = Object.freeze({
  type: 'integer',
  description: 'O número da peça musical nesta produção, como aparece na listagem. Começa em 1.',
});

const TAKE_NUMBER = Object.freeze({
  type: 'integer',
  description: 'O número da tentativa (take), como aparece na listagem. Começa em 1.',
});

const DESCRIPTION = Object.freeze({
  type: 'string',
  description: 'Como a peça soa, em palavras — por exemplo "trilha orquestral sombria, '
    + 'tensão crescendo devagar, cordas graves" ou "piano melancólico e esparso". É deste '
    + 'texto que a música vai nascer.',
});

function numeroValido(bruto, oQue) {
  const n = Number(bruto);
  if (!Number.isInteger(n) || n < 1) {
    throw new ToolExecutionError(`Informe o número ${oQue}, começando em 1.`, {});
  }
  return n;
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

// ── as peças ────────────────────────────────────────────────────────────────

export const createProductionMusicCueTool = defineTool({
  name: 'project.create_music_cue',
  description: 'Acrescenta uma peça musical a esta produção — como a trilha soa, escrita em '
    + 'palavras. Atende "crie uma trilha sombria para o filme". '
    + 'A música pertence à PRODUÇÃO, e não a uma cena: uma peça pode atravessar várias '
    + 'cenas, e por isso esta ferramenta não pede número de cena. '
    + 'Isto é planejamento: NÃO gera música nenhuma. Para gerar, use '
    + 'project.generate_music depois. O número da peça é do estúdio, não seu.',
  inputSchema: {
    type: 'object',
    properties: { description: DESCRIPTION },
    required: ['description'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['description']));

    try {
      const cue = createProductionMusicCue(projectId, { description: entrada.description }, db);
      return { cueNumber: cue.cueNumber, description: cue.description };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível acrescentar esta peça musical.');
    }
  },
});

export const updateProductionMusicCueTool = defineTool({
  name: 'project.update_music_cue',
  description: 'Reescreve a descrição de uma peça musical desta produção. '
    + 'As músicas já geradas continuam existindo, mas passam a ser de uma versão anterior '
    + 'da descrição, e a listagem vai mostrá-las como não atuais.',
  inputSchema: {
    type: 'object',
    properties: { cueNumber: CUE_NUMBER, description: DESCRIPTION },
    required: ['cueNumber', 'description'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['cueNumber', 'description']));
    const cueNumber = numeroValido(entrada.cueNumber, 'da peça');

    try {
      const cue = updateProductionMusicCue(
        projectId, cueNumber, { description: entrada.description }, db,
      );
      return { cueNumber: cue.cueNumber, description: cue.description };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível reescrever esta peça musical.');
    }
  },
});

export const listProductionMusicCuesTool = defineTool({
  name: 'project.list_music_cues',
  description: 'Lista as peças musicais desta produção: o número de cada uma, a descrição, '
    + 'quantas tentativas já existem e se há uma escolhida. '
    + 'Consulte SEMPRE antes de agir sobre "a trilha", "essa música" ou "a segunda".',
  inputSchema: { type: 'object', properties: {} },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    argumentosValidos(args || {}, new Set());

    try {
      const cues = listProductionMusicCues(projectId, db).map((cue) => {
        const selecionado = getProductionMusicSelection(projectId, cue.cueNumber, db);
        return {
          cueNumber: cue.cueNumber,
          description: cue.description,
          takes: listProductionMusicTakes(projectId, cue.cueNumber, db).length,
          selectedTakeNumber: selecionado ? selecionado.takeNumber : null,
        };
      });
      return { cues };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível listar as peças musicais.');
    }
  },
});

export const deleteProductionMusicCueTool = defineTool({
  name: 'project.delete_music_cue',
  description: 'Remove uma peça musical desta produção, junto com as tentativas dela. Não dá '
    + 'para desfazer. '
    + 'Se houver uma geração em andamento para essa peça, a remoção é recusada — espere ela '
    + 'terminar.',
  inputSchema: {
    type: 'object',
    properties: { cueNumber: CUE_NUMBER },
    required: ['cueNumber'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['cueNumber']));
    const cueNumber = numeroValido(entrada.cueNumber, 'da peça');

    try {
      deleteProductionMusicCue(projectId, cueNumber, db);
      return { cueNumber, removed: true };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível remover esta peça musical.');
    }
  },
});

// ── a música ────────────────────────────────────────────────────────────────

export const generateProductionMusicTool = defineTool({
  name: 'project.generate_music',
  description: 'Gera a música de uma peça desta produção, a partir da descrição já escrita '
    + 'nela. Atende "gere a trilha". '
    + 'Chamar de novo na mesma peça cria uma NOVA tentativa (take) — é assim que se atende '
    + '"faça outra versão"; não existe comando separado para regerar. '
    + 'A geração começa e segue em segundo plano; use project.list_music_takes para saber '
    + 'como ficou. '
    + 'Se ainda não houver seleção, a primeira música pronta da descrição atual passa a '
    + 'valer sozinha; se já houver uma escolhida e ela ainda for da descrição atual, ela é '
    + 'mantida.',
  inputSchema: {
    type: 'object',
    properties: { cueNumber: CUE_NUMBER },
    required: ['cueNumber'],
  },

  // `deps` com default, no estilo da casa: o registry nunca o informa, e é o
  // teste que injeta um duplo para provar a delegação sem chamar executor.
  async execute(context, args, deps = {}) {
    const { gerar = startProductionMusicGeneration } = deps;
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['cueNumber']));
    const cueNumber = numeroValido(entrada.cueNumber, 'da peça');

    try {
      const inicio = await gerar({ projectId, cueNumber }, { db });
      return {
        cueNumber: inicio.cueNumber,
        takeNumber: inicio.takeNumber,
        status: 'started',
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível gerar esta música.');
    }
  },
});

export const listProductionMusicTakesTool = defineTool({
  name: 'project.list_music_takes',
  description: 'Lista as músicas já geradas para uma peça desta produção: o número de cada '
    + 'tentativa, a situação, qual está escolhida e se ainda corresponde à descrição atual '
    + 'da peça. '
    + 'Um take com selected verdadeiro e current falso significa que a música escolhida foi '
    + 'gerada antes da última alteração da descrição.',
  inputSchema: {
    type: 'object',
    properties: { cueNumber: CUE_NUMBER },
    required: ['cueNumber'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['cueNumber']));
    const cueNumber = numeroValido(entrada.cueNumber, 'da peça');

    try {
      const selecionado = getProductionMusicSelection(projectId, cueNumber, db);
      const takes = listProductionMusicTakes(projectId, cueNumber, db);
      return {
        cueNumber,
        takes: takes.map((take) => takePublico(take, selecionado, db)),
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível listar as músicas desta peça.');
    }
  },
});

export const selectProductionMusicTakeTool = defineTool({
  name: 'project.select_music_take',
  description: 'Escolhe qual música gerada passa a valer para uma peça desta produção. É o '
    + 'que atende "use a segunda", "prefiro a primeira". '
    + 'Escolher NÃO apaga nada e NÃO gera nada: só move o ponteiro, e dá para voltar. '
    + 'Cada peça tem a sua própria escolha.',
  inputSchema: {
    type: 'object',
    properties: { cueNumber: CUE_NUMBER, takeNumber: TAKE_NUMBER },
    required: ['cueNumber', 'takeNumber'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['cueNumber', 'takeNumber']));
    const cueNumber = numeroValido(entrada.cueNumber, 'da peça');
    const takeNumber = numeroValido(entrada.takeNumber, 'do take');

    try {
      const escolhido = selectProductionMusicTake(projectId, cueNumber, takeNumber, {}, db);
      return {
        cueNumber,
        takeNumber: escolhido.takeNumber,
        current: escolhido.current === true,
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não foi possível escolher esta música.');
    }
  },
});
