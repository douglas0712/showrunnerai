// Tools project.get_scene_media · project.select_scene_take
//
// PASSO 13-D. É aqui que "use a segunda" deixa de ser uma frase que o agente
// entende e vira uma coisa que o Project sabe.
//
// ── Por que estas duas existem ──────────────────────────────────────────────
//
// Porque a conversa sobre uma cena com mídia é feita de dedos apontando:
// "essa", "a outra", "a segunda", "a mais sombria". Apontar só funciona se as
// duas partes estiverem olhando para a MESMA coisa — e a coisa é o estado
// gravado, não a memória do chat.
//
// Sem `get_scene_media`, o agente responderia "qual é o estado da cena 1?" pelo
// que ele lembra de ter feito. Ele lembra errado, e lembra com confiança: uma
// geração que falhou fica na memória dele como uma imagem pronta, porque ele
// viu a ferramenta responder "aceito". A resposta certa vem do banco.
//
// Sem `select_scene_take`, "use a segunda" não teria efeito nenhum — o usuário
// diria, o agente concordaria, e o vídeo seguinte animaria a primeira.
//
// ── O que uma seleção É ─────────────────────────────────────────────────────
//
// Um ponteiro, e só. Escolher não apaga take nenhum, não move Asset nenhum e
// não gera nada. Trocar a escolha é trocar o ponteiro — e é por isso que
// "prefiro a primeira, afinal" é grátis.
//
// ── Só take PRONTO pode ser escolhido ───────────────────────────────────────
//
// Escolher um take que ainda está gerando faria a cena apontar para o nada, e
// `generate_scene_video` recusaria animar logo em seguida — o usuário teria
// escolhido e levado um não. Escolher um take que FALHOU é pior: a cena ficaria
// apontando para uma imagem que nunca vai existir.
//
// Esta regra mora AQUI, e não em `selectSceneTake`, de propósito. Aquela é a
// mecânica do ponteiro, usada também para montar estados de teste e para
// representar situações que o produto precisa saber descrever (uma seleção cujo
// Asset sumiu, por exemplo). Esta é a ESCOLHA DELIBERADA de uma pessoa, e é a
// escolha que precisa apontar para algo pronto.

import { defineTool, ToolExecutionError } from '../schema.js';
import {
  getSceneSelection, getSceneTake, listSceneTakes, MAX_TAKES_POR_CENA,
  SCENE_MEDIA_KINDS, sceneTakeState, selectSceneTake,
} from '../../../domain/sceneMedia.js';
import { getProductionScene } from '../../../domain/production.js';
import { JOB_STATES } from '../../../domain/generationJobStates.js';
import {
  argumentosValidos, comoErroDeFerramenta, contextoValido,
} from './productionPlan.js';

/**
 * Quantos takes de cada tipo a resposta traz.
 *
 * Derivado do teto do domínio, e não um segundo número: uma cena não pode ter
 * mais takes do que isso, então a resposta é limitada por construção. Dois
 * números independentes divergiriam no dia em que um deles mudasse, e a
 * divergência apareceria como uma lista silenciosamente cortada.
 */
const MAX_TAKES_NA_RESPOSTA = MAX_TAKES_POR_CENA;

/** O número da cena nos dois schemas. Uma definição, dois usos. */
const ORDINAL = Object.freeze({
  type: 'integer',
  description: 'O número da cena na produção, começando em 1.',
});

function ordinalValido(bruto) {
  const ordinal = Number(bruto);
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new ToolExecutionError('Informe o número da cena, começando em 1.', {});
  }
  return ordinal;
}

function exigirCena(projectId, ordinal, db) {
  const cena = getProductionScene(projectId, ordinal, db);
  if (!cena) {
    throw new ToolExecutionError(`Esta produção não tem uma cena ${ordinal}.`, {});
  }
  return cena;
}

/**
 * A forma pública de um take.
 *
 * `takeNumber` é o endereço — o número que a pessoa fala. `state` é a palavra do
 * livro-razão, sem tradução. Nada mais atravessa: nem o `id` da mídia, nem o do
 * Asset, nem o da geração, nem arquivo, nem workflow, nem provider, nem
 * linhagem. Um identificador na mão do modelo é um identificador que ele vai
 * tentar usar noutro lugar.
 */
function takePublico(take, selecionado, db) {
  return {
    takeNumber: take.takeNumber,
    state: sceneTakeState(take, db),
    selected: selecionado === take.id,
  };
}

function porTipo(projectId, ordinal, kind, db) {
  const escolhido = getSceneSelection(projectId, ordinal, kind, db);
  const todos = listSceneTakes(projectId, ordinal, kind, db);
  const mostrados = todos.slice(0, MAX_TAKES_NA_RESPOSTA);

  return {
    total: todos.length,
    selectedTakeNumber: escolhido ? escolhido.takeNumber : null,
    takes: mostrados.map((take) => takePublico(take, escolhido?.id ?? null, db)),
  };
}

export const getSceneMediaTool = defineTool({
  name: 'project.get_scene_media',
  description: 'Mostra o que uma cena desta produção já tem de mídia: as imagens e os '
    + 'vídeos gerados para ela, o número de cada tentativa (take), a situação de cada uma '
    + 'e qual está escolhida. '
    + 'Consulte SEMPRE antes de responder "qual imagem está selecionada?", "qual é o '
    + 'estado da cena?" ou qualquer pergunta sobre o que já foi feito — e antes de agir '
    + 'sobre "a segunda", "a outra" ou "essa versão". O que vale é o que está gravado '
    + 'aqui, não o que foi dito na conversa.',
  inputSchema: {
    type: 'object',
    properties: { ordinal: ORDINAL },
    required: ['ordinal'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal']));
    const ordinal = ordinalValido(entrada.ordinal);
    const cena = exigirCena(projectId, ordinal, db);

    try {
      return {
        ordinal: cena.ordinal,
        title: cena.title,
        image: porTipo(projectId, ordinal, 'image', db),
        video: porTipo(projectId, ordinal, 'video', db),
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não consegui ler a mídia desta cena.');
    }
  },
});

export const selectSceneTakeTool = defineTool({
  name: 'project.select_scene_take',
  description: 'Escolhe qual tentativa (take) de imagem ou de vídeo passa a valer para uma '
    + 'cena desta produção. É o que atende "use a segunda", "prefiro a primeira", "fica '
    + 'com essa". '
    + 'Escolher NÃO apaga as outras: as tentativas continuam todas lá, e dá para voltar '
    + 'atrás a qualquer momento. Imagem e vídeo são escolhidos separadamente. '
    + 'Só uma tentativa PRONTA pode ser escolhida — uma que ainda está gerando ou que '
    + 'falhou não serve. '
    + 'Se não estiver claro a qual tentativa o usuário se refere, consulte a mídia da '
    + 'cena e pergunte antes de escolher por ele.',
  inputSchema: {
    type: 'object',
    properties: {
      ordinal: ORDINAL,
      kind: {
        type: 'string',
        enum: [...SCENE_MEDIA_KINDS],
        description: 'O que está sendo escolhido: "image" ou "video".',
      },
      takeNumber: {
        type: 'integer',
        description: 'O número da tentativa, começando em 1 — o mesmo que aparece na '
          + 'mídia da cena. "a segunda imagem" é takeNumber 2.',
      },
    },
    required: ['ordinal', 'kind', 'takeNumber'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, new Set(['ordinal', 'kind', 'takeNumber']));
    const ordinal = ordinalValido(entrada.ordinal);

    const kind = String(entrada.kind ?? '');
    if (!SCENE_MEDIA_KINDS.includes(kind)) {
      throw new ToolExecutionError(
        `Escolha "${SCENE_MEDIA_KINDS.join('" ou "')}".`,
        {},
      );
    }

    const takeNumber = Number(entrada.takeNumber);
    if (!Number.isInteger(takeNumber) || takeNumber < 1) {
      throw new ToolExecutionError('Informe o número da tentativa, começando em 1.', {});
    }

    exigirCena(projectId, ordinal, db);

    // "não existe", "é de outra cena" e "é de outro projeto" são a mesma
    // recusa: o endereço é sempre relativo à cena de quem pergunta, então não
    // há um número que signifique o take de outra produção.
    const take = getSceneTake(projectId, ordinal, { kind, takeNumber }, db);
    if (!take) {
      throw new ToolExecutionError(
        `A cena ${ordinal} não tem uma tentativa ${takeNumber} de ${kind}.`,
        {},
      );
    }

    // Pronto quer dizer: o trabalho terminou e produziu mídia. Ver o cabeçalho.
    const situacao = sceneTakeState(take, db);
    if (situacao !== JOB_STATES.DONE) {
      throw new ToolExecutionError(
        situacao === JOB_STATES.FAILED || situacao === JOB_STATES.CANCELLED
          || situacao === JOB_STATES.ORPHANED
          ? `A tentativa ${takeNumber} de ${kind} da cena ${ordinal} não ficou pronta; `
            + 'escolha outra ou gere de novo.'
          : `A tentativa ${takeNumber} de ${kind} da cena ${ordinal} ainda está sendo `
            + 'gerada; espere ela ficar pronta.',
        {},
      );
    }

    try {
      const escolhido = selectSceneTake(projectId, ordinal, { kind, takeNumber }, db);
      return {
        ordinal,
        kind,
        selectedTakeNumber: escolhido.takeNumber,
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não consegui escolher esta tentativa.');
    }
  },
});
