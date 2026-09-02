// Agente de produção — roteiro de entrevista simulado.
//
// Fase 1: nenhuma LLM, nenhuma API. O agente é uma máquina de estados que
// percorre as perguntas de um briefing audiovisual e monta o briefing a partir
// das respostas. A assinatura `respond(state, userText)` é a mesma que um
// backend de LLM vai expor depois, então trocar a simulação por um modelo real
// não muda a tela.

export const BRIEFING_FIELDS = [
  { key: 'formato', label: 'Formato' },
  { key: 'tema', label: 'Tema' },
  { key: 'publico', label: 'Público' },
  { key: 'tom', label: 'Tom' },
  { key: 'duracao', label: 'Duração' },
  { key: 'proporcao', label: 'Proporção' },
];

export const GREETING =
  'Olá! Vou ajudar você a transformar sua ideia em uma produção audiovisual. Para começar, que tipo de vídeo você deseja criar?';

// Cada entrada guarda a pergunta que ESTÁ sendo respondida: `field` e
// `suggestions` pertencem a ela, enquanto `followUp` já enuncia a próxima.
const SCRIPT = [
  {
    field: 'formato',
    question: GREETING,
    followUp: (answer) =>
      `Ótimo — ${answer}. Sobre o que é essa produção? Descreva a ideia central em uma ou duas frases.`,
    suggestions: ['Curta narrativo', 'Vídeo publicitário', 'Clipe musical', 'Documentário'],
  },
  {
    field: 'tema',
    followUp: () => 'Entendi. Para quem é esse vídeo? Descreva o público que você quer alcançar.',
    suggestions: ['Uma história de superação', 'Lançamento de produto', 'Um mistério noir', 'Um retrato documental'],
  },
  {
    field: 'publico',
    followUp: () => 'Perfeito. Que tom você quer transmitir?',
    suggestions: ['Público geral', 'Investidores', 'Jovens adultos', 'Clientes de marca'],
  },
  {
    field: 'tom',
    followUp: () => 'Anotado. Qual a duração aproximada da peça final?',
    suggestions: ['Épico e cinematográfico', 'Íntimo e sensível', 'Enérgico', 'Sóbrio e elegante'],
  },
  {
    field: 'duracao',
    followUp: () => 'E em qual proporção ela será exibida?',
    suggestions: ['15 segundos', '30 segundos', '1 minuto', '3 minutos'],
  },
  {
    field: 'proporcao',
    followUp: () =>
      'Briefing completo. Montei uma proposta de abertura e um plano de vídeo para você avaliar — aprove ou peça alteração em cada um.',
    suggestions: ['16:9 — horizontal', '9:16 — vertical', '21:9 — cinemascope', '1:1 — quadrado'],
    final: true,
  },
];

export function initialAgentState() {
  return {
    step: 0,
    briefing: {},
    complete: false,
  };
}

export function currentQuestion(state) {
  return SCRIPT[state.step] || null;
}

export function currentSuggestions(state) {
  return SCRIPT[state.step]?.suggestions || [];
}

/**
 * Processa a resposta do usuário e devolve o próximo estado + o que o agente diz.
 * @returns {{state: object, reply: string, attachments: string[], briefingPatch: object}}
 */
export function respond(state, userText = '') {
  const step = SCRIPT[state.step];
  const answer = String(userText).trim();

  if (!step) {
    return {
      state,
      reply:
        'O briefing já está fechado. Você pode revisar cada item no painel lateral, ou pedir alteração em qualquer entrega acima.',
      attachments: [],
      briefingPatch: {},
    };
  }

  const briefingPatch = answer ? { [step.field]: answer } : {};
  const briefing = { ...state.briefing, ...briefingPatch };
  const nextStep = state.step + 1;
  const isFinal = Boolean(step.final) || nextStep >= SCRIPT.length;

  return {
    state: { step: Math.min(nextStep, SCRIPT.length), briefing, complete: isFinal },
    reply: step.followUp(answer || 'sem resposta'),
    // Na etapa final o agente anexa entregas simuladas para aprovação.
    attachments: isFinal ? ['image', 'video'] : [],
    briefingPatch,
  };
}

export function briefingProgress(briefing = {}) {
  const filled = BRIEFING_FIELDS.filter((field) => Boolean(briefing[field.key])).length;
  return { filled, total: BRIEFING_FIELDS.length, percent: Math.round((filled / BRIEFING_FIELDS.length) * 100) };
}
