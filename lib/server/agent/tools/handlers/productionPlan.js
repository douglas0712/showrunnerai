// Tools project.get_production_plan e project.save_production_plan
//
// O plano geral da produção: o que este projeto vai virar.
//
// ── Por que as duas moram no mesmo arquivo ──────────────────────────────────
//
// Porque elas compartilham a lista de campos editáveis, e essa lista é a
// fronteira inteira desta ferramenta: é ela que diz o que o modelo pode
// escrever e, por ausência, o que é do servidor. Duas cópias dela em dois
// arquivos discordariam na primeira vez que um campo entrasse — e a cópia
// desatualizada seria a permissiva.
//
// ── O que o modelo NÃO fornece ──────────────────────────────────────────────
//
//   projectId    vem do ToolContext (regra 5)
//   id           é do servidor
//   status       é do servidor; nada escreve "aprovado" nesta etapa
//   createdAt    é do servidor
//
// Nenhum deles está no schema, e um deles no corpo dos argumentos é recusado —
// não ignorado. Ignorar em silêncio ensinaria ao modelo que o campo existe e
// que ele foi obedecido.

import { defineTool, ToolExecutionError } from '../schema.js';
import { database, DomainError } from '../../../domain/db.js';
import {
  getProductionPlan, getProductionScript, listPlanSources, planFields,
  productionSummary, publicProductionPlan, saveProductionPlan,
} from '../../../domain/production.js';

/** Os campos que o modelo pode escrever. A lista vem do domínio, não daqui. */
const EDITAVEIS = planFields();

/** `sourceDocumentIds` é rastreabilidade, não um campo do plano. */
const ACEITOS = new Set([...EDITAVEIS, 'sourceDocumentIds']);

export const getProductionPlanTool = defineTool({
  name: 'project.get_production_plan',
  description: 'Devolve o plano de produção deste projeto: formato, duração alvo, '
    + 'logline, tom, público, e de quais documentos ele saiu. '
    + 'Diz também se já existe roteiro e quantas cenas há, com a soma das durações. '
    + 'Consulte ANTES de propor mudanças: o estado do projeto é a autoridade, '
    + 'não a memória da conversa. Devolve plano nulo quando ainda não há plano.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },

  async execute(context, args) {
    const { db } = contextoValido(context);
    semArgumentos(args);

    const plano = getProductionPlan(context.projectId, db);
    const resumo = productionSummary(context.projectId, db);

    return {
      plan: publicProductionPlan(plano),
      sources: plano ? listPlanSources(context.projectId, db) : [],
      hasScript: Boolean(getProductionScript(context.projectId, db)),
      sceneCount: resumo.sceneCount,
      totalDurationSeconds: resumo.totalDurationSeconds,
    };
  },
});

export const saveProductionPlanTool = defineTool({
  name: 'project.save_production_plan',
  description: 'Grava o plano de produção deste projeto. Substitui o plano anterior, '
    + 'se houver — um projeto tem um plano só. '
    + 'Use quando o usuário pedir para transformar um material ou uma ideia numa '
    + 'produção: decida o formato, a duração alvo e a proposta narrativa, e grave. '
    + 'targetDurationSeconds é a duração pedida em segundos ("dois minutos" = 120). '
    + 'Se a proposta veio de documentos do projeto, informe sourceDocumentIds — é '
    + 'assim que fica registrado de onde ela saiu. '
    + 'Grave o plano ANTES do roteiro e das cenas.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Título da produção.' },
      logline: { type: 'string', description: 'Uma frase que resume a produção.' },
      synopsis: { type: 'string', description: 'A proposta narrativa, em um ou dois parágrafos.' },
      format: {
        type: 'string',
        description: 'Formato: "mini-documentário", "trailer", "vídeo institucional"…',
      },
      targetDurationSeconds: {
        type: 'integer',
        description: 'Duração alvo total, em segundos. Obrigatória.',
      },
      aspectRatio: { type: 'string', description: 'Proporção: "16:9", "9:16", "1:1". Padrão "16:9".' },
      genre: { type: 'string', description: 'Gênero.' },
      tone: { type: 'string', description: 'Tom: contemplativo, urgente, épico…' },
      audience: { type: 'string', description: 'Para quem é.' },
      language: { type: 'string', description: 'Idioma da narração.' },
      sourceDocumentIds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Os documentos deste projeto em que a proposta se baseia. '
          + 'Use identificadores que o estúdio informou; nunca invente um.',
      },
    },
    required: ['title', 'targetDurationSeconds'],
  },

  async execute(context, args) {
    const { db } = contextoValido(context);
    const entrada = argumentosValidos(args, ACEITOS);

    try {
      const plano = saveProductionPlan(
        { ...entrada, projectId: context.projectId },
        db,
      );
      return {
        plan: publicProductionPlan(plano),
        sources: listPlanSources(context.projectId, db),
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não consegui gravar o plano de produção.');
    }
  },
});

// ── as conferências que todas as ferramentas de produção repetem ────────────
//
// Elas moram aqui e são reexportadas para os outros dois arquivos desta família.
// Uma cópia por arquivo seria três oportunidades de uma delas ficar para trás —
// e a que ficasse para trás seria a que aceita.

/** ToolContext confiável. Sem thread não há turno; sem projeto não há dono. */
export function contextoValido(context) {
  const { threadId, projectId } = context || {};

  if (!threadId) {
    throw new ToolExecutionError('Contexto inválido: threadId faltando.', {});
  }
  if (!projectId) {
    throw new ToolExecutionError('A conversa não está ligada a um projeto.', { threadId });
  }

  return { db: database(), projectId, threadId };
}

/**
 * Uma ferramenta de schema vazio não recebe nada.
 *
 * Aceitar ruído em silêncio ensinaria que o campo existe — e o primeiro campo
 * que um modelo tenta escrever numa ferramenta de projeto é `projectId`.
 */
export function semArgumentos(args) {
  if (args && typeof args === 'object' && Object.keys(args).length > 0) {
    throw new ToolExecutionError(
      `Esta ferramenta não recebe argumentos. Recebidos: ${Object.keys(args).join(', ')}.`,
      {},
    );
  }
}

/** Só os campos declarados. Qualquer outro é recusado, com o nome dele. */
export function argumentosValidos(args, aceitos) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolExecutionError('Argumentos inválidos.', {});
  }

  const desconhecidos = Object.keys(args).filter((campo) => !aceitos.has(campo));
  if (desconhecidos.length > 0) {
    throw new ToolExecutionError(
      `Propriedades desconhecidas: ${desconhecidos.join(', ')}. `
      + 'A identidade do projeto e da produção é do estúdio, não sua.',
      { desconhecidos },
    );
  }

  return { ...args };
}

/**
 * Uma regra de domínio quebrada vira mensagem para o modelo; qualquer outra
 * coisa vira uma frase única.
 *
 * A distinção importa: "as cenas somam 95s e a produção é de 120s" é acionável
 * — o modelo corrige e grava de novo. Um erro de banco não é, e o texto dele
 * não tem por que atravessar.
 */
export function comoErroDeFerramenta(erro, frasePadrao) {
  if (erro instanceof DomainError) return new ToolExecutionError(erro.message, {});
  if (erro && erro.name === 'ToolExecutionError') return erro;
  return new ToolExecutionError(frasePadrao, {});
}
