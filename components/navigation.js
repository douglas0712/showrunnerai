// Registro de áreas da plataforma.
//
// Padrão derivado do `TABS` de `components/StandaloneShell.js` do
// Open Generative AI (MIT) — uma lista declarativa que alimenta a navegação e o
// roteamento ao mesmo tempo. Ver THIRD_PARTY_NOTICES.md.

export const TABS = [
  { id: 'inicio', label: 'Início', icon: 'inicio', group: 'Produção', description: 'Ponto de partida da produção' },
  { id: 'criar', label: 'Criar', icon: 'criar', group: 'Produção', description: 'Abrir uma nova produção' },
  { id: 'imagem', label: 'Imagem', icon: 'imagem', group: 'Estúdios', description: 'Texto → imagem e imagem → imagem' },
  { id: 'video', label: 'Vídeo', icon: 'video', group: 'Estúdios', description: 'Texto, imagem ou referência → vídeo' },
  { id: 'cinema', label: 'Cinema', icon: 'cinema', group: 'Estúdios', description: 'Direção de câmera e prompt cinematográfico' },
  { id: 'personagens', label: 'Personagens', icon: 'personagens', group: 'Estúdios', description: 'Elenco e consistência visual' },
  { id: 'storyboard', label: 'Storyboard', icon: 'storyboard', group: 'Montagem', description: 'Cenas, aprovação e timeline' },
  { id: 'projetos', label: 'Projetos', icon: 'projetos', group: 'Montagem', description: 'Suas produções' },
  { id: 'biblioteca', label: 'Biblioteca', icon: 'biblioteca', group: 'Montagem', description: 'Tudo que já foi gerado' },
  { id: 'workflows', label: 'Workflows', icon: 'workflows', group: 'Automação', description: 'Pipelines de várias etapas' },
  { id: 'agente', label: 'Agente', icon: 'agente', group: 'Automação', description: 'Entrevista e briefing assistido' },
  { id: 'configuracoes', label: 'Configurações', icon: 'configuracoes', group: 'Sistema', description: 'Modelos locais e provedores' },
  { id: 'logs', label: 'Logs', icon: 'logs', group: 'Sistema', description: 'Diagnóstico da geração real' },
];

export const NAV_GROUPS = TABS.reduce((groups, tab) => {
  const group = groups.find((g) => g.name === tab.group);
  if (group) group.tabs.push(tab);
  else groups.push({ name: tab.group, tabs: [tab] });
  return groups;
}, []);

export function getTab(id) {
  return TABS.find((tab) => tab.id === id) || TABS[0];
}

export function tabPath(id) {
  return id === 'inicio' ? '/studio' : `/studio/${id}`;
}
