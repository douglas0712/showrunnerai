// Tools project.get_script e project.save_script
//
// O roteiro do projeto. Um por projeto, e gravar de novo substitui.
//
// ── Por que o roteiro é texto, e as cenas não ───────────────────────────────
//
// O roteiro é a peça que uma PESSOA lê: ela quer o texto corrido, com a voz que
// ele tem. A estrutura que uma máquina percorre — e que "mude a cena 4" precisa
// alcançar — são as cenas, que são linhas de verdade em outra tabela.
//
// Guardar as duas coisas nesta coluna faria editar uma cena virar edição de
// string, com o modelo reescrevendo o texto inteiro para mudar dez segundos.
// Guardar só as cenas, sem texto, jogaria fora o roteiro que o usuário quer ler.
//
// ── Reescrever o roteiro NÃO apaga as cenas ─────────────────────────────────
//
// De propósito, e é uma consequência da modelagem: o `id` do roteiro não muda
// numa regravação, então nada cascateia. Corrigir uma frase do texto não pode
// demolir o plano de cenas.

import { defineTool } from '../schema.js';
import {
  getProductionScript, productionSummary, publicProductionScript,
  saveProductionScript, scriptFields,
} from '../../../domain/production.js';
import {
  argumentosValidos, comoErroDeFerramenta, contextoValido, semArgumentos,
} from './productionPlan.js';

const ACEITOS = new Set(scriptFields());

export const getScriptTool = defineTool({
  name: 'project.get_script',
  description: 'Devolve o roteiro atual deste projeto, por inteiro, e quantas cenas '
    + 'existem a partir dele. Consulte antes de reescrever: o roteiro gravado é a '
    + 'autoridade, não a memória da conversa. Devolve roteiro nulo quando ainda não há um.',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    semArgumentos(args);

    const roteiro = getProductionScript(projectId, db);
    const resumo = productionSummary(projectId, db);

    return {
      script: publicProductionScript(roteiro),
      sceneCount: resumo.sceneCount,
      totalDurationSeconds: resumo.totalDurationSeconds,
    };
  },
});

export const saveScriptTool = defineTool({
  name: 'project.save_script',
  description: 'Grava o roteiro deste projeto. Substitui o roteiro anterior, se houver. '
    + 'Exige que o plano de produção já esteja gravado. '
    + 'Escreva o roteiro como texto corrido, na ordem em que a produção acontece. '
    + 'Depois de gravá-lo, divida-o em cenas com a ferramenta de cenas. '
    + 'Reescrever o roteiro NÃO apaga as cenas: se a estrutura mudou, grave as cenas também.',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Título do roteiro.' },
      summary: { type: 'string', description: 'Resumo curto do que o roteiro cobre.' },
      fullText: { type: 'string', description: 'O roteiro completo, em texto corrido.' },
    },
    required: ['title', 'fullText'],
  },

  async execute(context, args) {
    const { db, projectId } = contextoValido(context);
    const entrada = argumentosValidos(args, ACEITOS);

    try {
      const roteiro = saveProductionScript({ ...entrada, projectId }, db);
      const resumo = productionSummary(projectId, db);
      return {
        script: publicProductionScript(roteiro),
        sceneCount: resumo.sceneCount,
      };
    } catch (erro) {
      throw comoErroDeFerramenta(erro, 'Não consegui gravar o roteiro.');
    }
  },
});
