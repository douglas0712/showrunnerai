// A identidade do agente, e a última linha de defesa dela.
//
// ── Onde a identidade é decidida ────────────────────────────────────────────
//
// Antes da geração, não depois. O runtime recebe a persona do Showrunner como
// instrução de sistema, e é com ela que ele pensa. Nada aqui reescreve uma
// resposta para parecer outra coisa: uma identidade construída por substituição
// no texto final é uma identidade que o modelo contradiz na frase seguinte, e
// quem lê percebe.
//
// ── Por que ainda existe detecção ───────────────────────────────────────────
//
// Porque a instrução pode falhar. Uma versão nova do runtime, uma sessão criada
// fora do caminho normal, um modelo que ignora o sistema — e o usuário lê que
// está falando com outro produto. Então a resposta é conferida, o vazamento é
// registrado no log do servidor, e a autoidentificação errada é corrigida.
//
// ── A distinção que importa ─────────────────────────────────────────────────
//
// "Sou o Hermes Agent" é vazamento. "Escreva uma cena sobre Hermes, o mensageiro
// dos deuses" é conteúdo que o usuário pediu. Uma lista de palavras proibidas
// não distingue os dois e estragaria o segundo para proteger contra o primeiro.
//
// Então há duas categorias, com regras diferentes:
//
//   AUTOIDENTIFICAÇÃO   só conta quando o texto DIZ ser aquilo. É a construção
//                       ("sou o X", "I am X") que é detectada, não a palavra.
//
//   INTERNOS            identificadores que não têm uso legítimo em conversa
//                       nenhuma. Esses são proibidos onde quer que apareçam.

/** O nome que o produto tem. */
export const AGENT_NAME = 'Showrunner';

/** O nome da persona instalada no runtime dedicado. */
export const PERSONA_NAME = 'showrunner';

/**
 * Identificadores internos: sem uso legítimo numa conversa sobre produção.
 *
 * Diferente dos nomes de produto, estes não podem aparecer nem a pedido — não
 * há pergunta de usuário cuja resposta correta contenha `enabled_toolsets`.
 */
const INTERNOS = Object.freeze([
  /\benabled_toolsets\b/i,
  /\bno_mcp\b/i,
  /\bsession_id\b/i,
  /\bstream_id\b/i,
  /\bHermesRuntimeAdapter\b/i,
  /\bHERMES_HOME\b/i,
]);

/**
 * Os nomes pelos quais o runtime pode tentar se apresentar.
 *
 * Usados SOMENTE dentro de uma construção de autoidentificação — a palavra
 * sozinha não aciona nada.
 */
const NOMES_DO_RUNTIME = String.raw`(?:Hermes(?:\s+Agent)?|Nous(?:\s+Research)?)`;

/**
 * Como uma autoidentificação se parece, em português e inglês.
 *
 * O verbo é obrigatório. É ele que separa "sou o Hermes" de "sobre Hermes".
 */
const AUTOIDENTIFICACAO = [
  // "Sou o Hermes Agent", "Eu sou Hermes", "sou a Nous Research"
  new RegExp(String.raw`\b((?:eu\s+)?sou\s+(?:o\s+|a\s+|um\s+|uma\s+)?)${NOMES_DO_RUNTIME}\b`, 'gi'),
  // "Me chamo Hermes", "meu nome é Hermes"
  new RegExp(String.raw`\b((?:me\s+chamo|meu\s+nome\s+é)\s+(?:o\s+|a\s+)?)${NOMES_DO_RUNTIME}\b`, 'gi'),
  // "I am Hermes", "I'm the Hermes Agent"
  new RegExp(String.raw`\b((?:i\s+am|i'm)\s+(?:the\s+|an?\s+)?)${NOMES_DO_RUNTIME}\b`, 'gi'),
  // "This is Hermes", "You are talking to Hermes"
  new RegExp(String.raw`\b((?:this\s+is|you(?:'re| are)\s+(?:talking|speaking)\s+(?:to|with))\s+(?:the\s+)?)${NOMES_DO_RUNTIME}\b`, 'gi'),
  // "assistente da Nous Research", "assistant by Nous Research"
  new RegExp(String.raw`\b((?:assistente|assistant)\s+(?:de\s+IA\s+)?(?:da|do|de|by|from)\s+)${NOMES_DO_RUNTIME}\b`, 'gi'),
];

/**
 * O que há de errado com este texto.
 *
 * Devolve `{ ok, motivos }` sem modificar nada — é a parte que serve ao log e
 * aos testes. Corrigir é decisão de quem chama.
 */
export function inspecionarIdentidade(texto) {
  const alvo = String(texto ?? '');
  const motivos = [];
  // Um trecho curto em volta do que casou. Sem ele, o log diz que houve
  // vazamento e não dá como agir — e foi exatamente essa a dificuldade na
  // primeira vez que o alarme tocou.
  let amostra = null;

  const anotar = (motivo, encontrado) => {
    motivos.push(motivo);
    if (amostra === null && encontrado) amostra = String(encontrado).slice(0, 80);
  };

  for (const padrao of AUTOIDENTIFICACAO) {
    padrao.lastIndex = 0;
    const achado = padrao.exec(alvo);
    if (achado) { anotar('self_identification', achado[0]); break; }
  }
  for (const padrao of INTERNOS) {
    const achado = padrao.exec(alvo);
    if (achado) { anotar('internal_identifier', achado[0]); break; }
  }

  return { ok: motivos.length === 0, motivos, amostra };
}

/**
 * Corrige a autoidentificação errada, e só ela.
 *
 * Substitui o NOME dentro da construção detectada, preservando o resto da
 * frase: "Sou o Hermes Agent, e posso gerar imagens" vira "Sou o Showrunner, e
 * posso gerar imagens". Nenhuma outra ocorrência da palavra é tocada — uma cena
 * sobre o mensageiro dos deuses continua inteira.
 *
 * Identificadores internos não são reescritos: não há substituto sensato para
 * `enabled_toolsets` numa frase, e inventar um esconderia o defeito. Eles são
 * detectados, registrados, e quem chama decide.
 */
export function corrigirAutoidentificacao(texto) {
  let saida = String(texto ?? '');
  for (const padrao of AUTOIDENTIFICACAO) {
    padrao.lastIndex = 0;
    saida = saida.replace(padrao, (_, prefixo) => `${prefixo}${AGENT_NAME}`);
  }
  return saida;
}
