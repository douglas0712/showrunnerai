// Tradução de nomes entre o Showrunner e o Hermes.
//
// As tools do Showrunner se chamam `og.generate_image`, `og.generate_video` e
// `og.get_job`. Esses são os nomes canônicos, são os que a UI mostra e são os
// únicos que o registry conhece. Eles não mudam por causa desta integração.
//
// O provider por trás do Hermes recusa ponto em nome de ferramenta:
//
//     HTTP 400: Invalid 'tools[0].name': string does not match pattern.
//     Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'
//
// (observado no PASSO 7A.3, com `showrunner.test_echo`). Por isso existe um
// alias por tool — e ele é detalhe EXCLUSIVO desta integração. Nenhum alias
// aparece num AgentEvent, numa resposta de API ou na tela.
//
// ── Por que uma tabela literal e não uma transformação ──────────────────────
//
// Trocar "_" por "." resolveria o caso de hoje e criaria um tradutor que aceita
// qualquer coisa: `terminal` continua `terminal`, e `og_fake` viraria
// `og.fake`, que o registry rejeitaria — mas só depois de a chamada ter
// atravessado a fronteira. Uma tabela fechada recusa o desconhecido no primeiro
// ponto em que ele aparece, que é onde recusar custa menos.
//
// A tabela é também a terceira barreira da defesa em profundidade: mesmo que o
// `enabled_toolsets` do Hermes regredisse e o modelo enxergasse `terminal`, o
// nome não está aqui e a chamada morre antes do bridge.

/** Erro de tradução de nome. Não é erro de execução: a chamada não aconteceu. */
export class UnknownToolAliasError extends Error {
  constructor(nome, direcao) {
    super(`Nome de ferramenta desconhecido na integração Hermes: "${nome}".`);
    this.name = 'UnknownToolAliasError';
    this.detail = { nome, direcao };
  }
}

/**
 * O mapa. Alias do Hermes → nome canônico do Showrunner.
 *
 * Acrescentar uma tool ao agente é acrescentar uma linha aqui. Esquecer a linha
 * faz a tool simplesmente não existir para o Hermes, que é o modo de falhar
 * correto — o oposto seria ela existir com um nome que ninguém declarou.
 */
const ALIAS_PARA_CANONICO = Object.freeze({
  og_generate_image: 'og.generate_image',
  og_generate_video: 'og.generate_video',
  og_get_job: 'og.get_job',
});

/** O caminho inverso, derivado do mesmo mapa para não haver duas verdades. */
const CANONICO_PARA_ALIAS = Object.freeze(
  Object.fromEntries(Object.entries(ALIAS_PARA_CANONICO).map(([a, c]) => [c, a])),
);

/** Os aliases aceitos. É esta lista, e nada além dela. */
export function hermesAliases() {
  return Object.keys(ALIAS_PARA_CANONICO);
}

/** Os nomes canônicos que a integração cobre. */
export function canonicalToolNames() {
  return Object.values(ALIAS_PARA_CANONICO);
}

export function isKnownAlias(nome) {
  return Object.prototype.hasOwnProperty.call(ALIAS_PARA_CANONICO, String(nome));
}

export function isKnownCanonical(nome) {
  return Object.prototype.hasOwnProperty.call(CANONICO_PARA_ALIAS, String(nome));
}

/**
 * Alias do Hermes → nome canônico.
 *
 * Recusa qualquer coisa fora da tabela, incluindo o próprio nome canônico:
 * `og.generate_image` NÃO é um alias válido. Aceitá-lo abriria uma segunda
 * grafia para a mesma coisa na fronteira, e uma fronteira com duas grafias é
 * uma fronteira que alguém vai atravessar pela grafia menos testada.
 */
export function toCanonicalToolName(alias) {
  const chave = String(alias ?? '');
  const canonico = ALIAS_PARA_CANONICO[chave];
  if (!canonico) throw new UnknownToolAliasError(chave, 'alias->canonico');
  return canonico;
}

/** Nome canônico → alias do Hermes. Usado ao montar o que o plugin registra. */
export function toHermesAlias(canonico) {
  const chave = String(canonico ?? '');
  const alias = CANONICO_PARA_ALIAS[chave];
  if (!alias) throw new UnknownToolAliasError(chave, 'canonico->alias');
  return alias;
}

/**
 * Traduz um nome vindo do Hermes para exibição, sem lançar.
 *
 * O fluxo de eventos não pode derrubar um turno porque o Hermes citou um nome
 * que não conhecemos — mas também não pode repassar esse nome à tela. Devolve
 * `null`, e quem chama omite o evento.
 */
export function canonicalForDisplay(alias) {
  const chave = String(alias ?? '');
  return ALIAS_PARA_CANONICO[chave] ?? null;
}
