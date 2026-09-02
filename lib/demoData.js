// Dados de demonstração.
//
// Servem só para que a interface possa ser avaliada com conteúdo na fase 1.
// Tudo é gerado localmente e marcado como `simulated: true`.

import { placeholderFrame } from './placeholder.js';
import { createScene, SCENE_STATUS } from './storyboard.js';
import { createClip, createAudioClip } from './timeline.js';
import { GREETING } from './agentScript.js';

const HOUR = 3600 * 1000;

const SCENE_SEEDS = [
  { title: 'Abertura — cidade ao amanhecer', description: 'Plano aéreo lento sobre a cidade enquanto a névoa se dissipa. A protagonista atravessa a ponte.', duration: 8, status: SCENE_STATUS.APPROVED },
  { title: 'Encontro no corredor', description: 'Corredor estreito iluminado por luzes práticas piscando. Os dois personagens se cruzam sem falar.', duration: 6, status: SCENE_STATUS.PENDING },
  { title: 'Revelação', description: 'Close no rosto da protagonista ao entender a mensagem. Foco raso, fundo dissolvido.', duration: 4, status: SCENE_STATUS.REVISION },
  { title: 'Perseguição na chuva', description: 'Travelling lateral acompanhando a corrida sob chuva forte, neon refletido no asfalto.', duration: 10, status: SCENE_STATUS.DRAFT },
  { title: 'Encerramento', description: 'Plano geral extremo: a silhueta se afasta em direção ao horizonte enquanto amanhece.', duration: 6, status: SCENE_STATUS.DRAFT },
];

export function demoProjects() {
  return [
    {
      id: 'proj_demo_noir',
      name: 'Curta neo-noir "Sinal"',
      description: 'Curta de 3 minutos, estética neo-noir, protagonista feminina.',
      aspect: '21:9',
      createdAt: Date.now() - 26 * HOUR,
      updatedAt: Date.now() - 2 * HOUR,
      cover: placeholderFrame({ seed: 1041, prompt: 'neo noir city rain', aspect: '21:9', kind: 'video', label: 'PROJETO' }),
      scenes: 5,
    },
    {
      id: 'proj_demo_marca',
      name: 'Campanha — Café da Serra',
      description: 'Três peças verticais de 15s para lançamento de linha premium.',
      aspect: '9:16',
      createdAt: Date.now() - 3 * 24 * HOUR,
      updatedAt: Date.now() - 20 * HOUR,
      cover: placeholderFrame({ seed: 2277, prompt: 'coffee mountain warm morning', aspect: '9:16', kind: 'image', label: 'PROJETO' }),
      scenes: 3,
    },
    {
      id: 'proj_demo_doc',
      name: 'Documentário "Oficina"',
      description: 'Peça documental sobre restauro de instrumentos.',
      aspect: '16:9',
      createdAt: Date.now() - 8 * 24 * HOUR,
      updatedAt: Date.now() - 3 * 24 * HOUR,
      cover: placeholderFrame({ seed: 3390, prompt: 'workshop wood tools documentary', aspect: '16:9', kind: 'image', label: 'PROJETO' }),
      scenes: 7,
    },
  ];
}

export function demoGenerations() {
  const items = [
    { kind: 'image', prompt: 'Retrato em contraluz na janela de um apartamento antigo', aspect: '3:2', seed: 5510, modelId: 'ideogram-4', status: 'aprovado' },
    { kind: 'image', prompt: 'Rua molhada com neon refletido, noite, névoa', aspect: '16:9', seed: 6621, modelId: 'ideogram-4', status: 'pendente' },
    { kind: 'video', prompt: 'Travelling lateral acompanhando a corrida sob chuva', aspect: '21:9', seed: 7732, modelId: 'minimax-h3', status: 'pendente', duration: 6 },
    { kind: 'image', prompt: 'Xícara de café sobre madeira, luz de golden hour', aspect: '9:16', seed: 8843, modelId: 'ideogram-4', status: 'aprovado' },
    { kind: 'video', prompt: 'Plano aéreo sobre a cidade ao amanhecer com névoa', aspect: '16:9', seed: 9954, modelId: 'minimax-h3', status: 'aprovado', duration: 8 },
    { kind: 'image', prompt: 'Detalhe macro de mãos restaurando um violino', aspect: '4:3', seed: 1065, modelId: 'ideogram-4', status: 'revisão' },
  ];

  return items.map((item, index) => {
    const base = {
      id: `gen_demo_${index}`,
      simulated: true,
      providerId: 'mock',
      intendedProviderId: item.modelId === 'minimax-h3' || item.modelId === 'ideogram-4' ? 'local' : 'api',
      revisionNote: item.status === 'revisão' ? 'Deixar o enquadramento mais fechado nas mãos.' : '',
      createdAt: Date.now() - (index + 1) * 2 * HOUR,
      resolution: item.kind === 'video' ? '1080p' : '2K',
      ...item,
    };

    if (item.kind === 'video') {
      return {
        ...base,
        fps: 24,
        audio: false,
        mode: 't2v',
        poster: placeholderFrame({ seed: item.seed, prompt: item.prompt, aspect: item.aspect, kind: 'video', label: 'SIMULAÇÃO' }),
        frames: Array.from({ length: 8 }, (_, i) =>
          placeholderFrame({ seed: item.seed, prompt: item.prompt, aspect: item.aspect, kind: 'video', label: 'SIMULAÇÃO', frame: i / 7 }),
        ),
      };
    }

    return {
      ...base,
      url: placeholderFrame({ seed: item.seed, prompt: item.prompt, aspect: item.aspect, kind: 'image', label: 'SIMULAÇÃO' }),
    };
  });
}

export function demoStoryboard() {
  return SCENE_SEEDS.map((seed, index) =>
    createScene({
      ...seed,
      id: `scene_demo_${index}`,
      number: index + 1,
      modelId: 'minimax-h3',
      revisionNote: seed.status === SCENE_STATUS.REVISION ? 'Segurar mais tempo no olhar antes do corte.' : '',
      image: placeholderFrame({
        seed: 4200 + index * 137,
        prompt: seed.description,
        aspect: '16:9',
        kind: 'image',
        label: `CENA ${index + 1}`,
      }),
    }),
  );
}

export function demoTimeline() {
  const video = SCENE_SEEDS.slice(0, 4).map((seed, index) =>
    createClip({
      id: `clip_demo_${index}`,
      label: seed.title,
      duration: seed.duration,
      sourceId: `scene_demo_${index}`,
      poster: placeholderFrame({
        seed: 4200 + index * 137,
        prompt: seed.description,
        aspect: '16:9',
        kind: 'video',
        label: `CENA ${index + 1}`,
      }),
    }),
  );

  const audio = [
    createAudioClip({ id: 'aclip_demo_0', label: 'Trilha — tema principal', duration: 18 }),
    createAudioClip({ id: 'aclip_demo_1', label: 'Ambiência — chuva', duration: 10 }),
  ];

  return { video, audio };
}

export function demoCharacters() {
  return [
    {
      id: 'char_demo_0',
      name: 'Ana Vidal',
      role: 'Protagonista',
      description: 'Detetive, 38 anos, casaco escuro encharcado, cicatriz na sobrancelha esquerda.',
      seed: 3141,
      lockSeed: true,
      reference: placeholderFrame({ seed: 3141, prompt: 'detective woman portrait noir', aspect: '3:4', kind: 'image', label: 'PERSONAGEM' }),
    },
    {
      id: 'char_demo_1',
      name: 'Otávio',
      role: 'Antagonista',
      description: 'Empresário, 50 anos, terno claro impecável, sempre em ambientes muito iluminados.',
      seed: 2718,
      lockSeed: true,
      reference: placeholderFrame({ seed: 2718, prompt: 'businessman portrait bright', aspect: '3:4', kind: 'image', label: 'PERSONAGEM' }),
    },
    {
      id: 'char_demo_2',
      name: 'A Cidade',
      role: 'Ambiente recorrente',
      description: 'Metrópole chuvosa, neon azul e âmbar, arquitetura de concreto aparente.',
      seed: 1618,
      lockSeed: false,
      reference: placeholderFrame({ seed: 1618, prompt: 'rainy neon city concrete', aspect: '3:4', kind: 'image', label: 'AMBIENTE' }),
    },
  ];
}

export function demoWorkflows() {
  return [
    {
      id: 'wf_demo_0',
      name: 'Storyboard → Vídeo em lote',
      description: 'Percorre as cenas aprovadas, gera o vídeo de cada uma e devolve os clipes à timeline.',
      steps: ['Ler cenas aprovadas', 'Gerar imagem-chave', 'Imagem → vídeo', 'Enviar para a timeline'],
      runtime: 'local',
    },
    {
      id: 'wf_demo_1',
      name: 'Personagem consistente',
      description: 'Fixa a seed do personagem e produz variações de enquadramento mantendo o rosto.',
      steps: ['Carregar personagem', 'Travar seed', 'Gerar 4 enquadramentos', 'Revisar'],
      runtime: 'local',
    },
    {
      id: 'wf_demo_2',
      name: 'Corte vertical para redes',
      description: 'Reenquadra a montagem final em 9:16 e exporta três durações.',
      steps: ['Ler timeline', 'Reenquadrar 9:16', 'Cortar 15s / 30s / 60s', 'Exportar'],
      runtime: 'local',
    },
  ];
}

export function demoConversation() {
  return [
    {
      id: 'msg_demo_0',
      role: 'agent',
      text: GREETING,
      createdAt: Date.now() - 5 * 60 * 1000,
      attachments: [],
    },
  ];
}

export function demoSettings() {
  return {
    comfyUrl: 'http://127.0.0.1:8188',
    localModels: {
      'ideogram-4': { enabled: true, path: '' },
      'minimax-h3': { enabled: true, path: '' },
    },
    apiProviders: {
      veo: { configured: false, enabled: false },
      kling: { configured: false, enabled: false },
      seedance: { configured: false, enabled: false },
      muapi: { configured: false, enabled: false },
    },
    telemetry: false,
  };
}
