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
// Então há três categorias, com regras diferentes:
//
//   AUTOIDENTIFICAÇÃO   só conta quando o texto DIZ ser aquilo. É a construção
//                       ("sou o X", "I am X") que é detectada, não a palavra.
//                       Corrigida: o nome vira "Showrunner", a frase fica.
//
//   INTERNOS            identificadores que não têm uso legítimo em conversa
//                       nenhuma. Proibidos onde quer que apareçam, e ocultados.
//
//   SEGREDOS            os VALORES concretos que este turno conhece — o id da
//                       sessão, o id do fluxo. Não são palavras de dicionário:
//                       são dados privados, e só quem está no turno sabe quais
//                       são. Por isso entram por injeção, não por constante.
//
// ── Por que existe um guard com estado ─────────────────────────────────────
//
// Porque a resposta chega em pedaços. Conferir cada pedaço isoladamente não
// protege nada: "Sou o Her" passa, "mes Agent" passa, e o navegador concatena
// os dois. A proteção precisa enxergar a resposta inteira ENQUANTO ela é
// escrita, e só liberar o que já não pode mudar de sentido. Ver
// `createIdentityGuard`.

/** O nome que o produto tem. */
export const AGENT_NAME = 'Showrunner';

/** O nome da persona instalada no runtime dedicado. */
export const PERSONA_NAME = 'showrunner';

/**
 * O que fica no lugar de um identificador interno.
 *
 * Não é um valor plausível inventado: inventar um esconderia o defeito e daria
 * ao usuário um dado falso para copiar. É uma marca de remoção — honesta sobre
 * o fato de que algo foi tirado, e sem dizer o quê.
 */
export const OCULTO = '[oculto]';

/**
 * Identificadores internos: sem uso legítimo numa conversa sobre produção.
 *
 * Diferente dos nomes de produto, estes não podem aparecer nem a pedido — não
 * há pergunta de usuário cuja resposta correta contenha `enabled_toolsets`.
 */
const INTERNOS_LITERAIS = Object.freeze([
  'enabled_toolsets', 'no_mcp', 'session_id', 'stream_id',
  'HermesRuntimeAdapter', 'HERMES_HOME',
]);

const INTERNOS = Object.freeze(
  INTERNOS_LITERAIS.map((termo) => new RegExp(String.raw`\b${escapar(termo)}\b`, 'gi')),
);

/**
 * Os nomes pelos quais o runtime pode tentar se apresentar.
 *
 * Usados SOMENTE dentro de uma construção de autoidentificação — a palavra
 * sozinha não aciona nada.
 */
const NOMES_DO_RUNTIME = String.raw`(?:Hermes(?:\s+Agent)?|Nous(?:\s+Research)?)`;

/**
 * As formas mais longas dos nomes acima.
 *
 * Servem à retenção durante o streaming, e é por isso que existem separadas: o
 * guard precisa saber que "Hermes" ainda pode virar "Hermes Agent" antes de
 * deixar a palavra sair. Ver `retencaoNecessaria`.
 */
const NOMES_LITERAIS = Object.freeze(['Hermes Agent', 'Nous Research']);

/** As preposições com que uma frase declara a quem se pertence. */
const PREPOSICOES = Object.freeze(['da', 'de', 'do', 'by', 'from']);

/**
 * A cauda de filiação, que a autoidentificação leva junto.
 *
 * "Sou o Hermes Agent da Nous Research" tem DUAS afirmações, e trocar só a
 * primeira deixa a segunda de pé: "Sou o Showrunner da Nous Research" continua
 * dizendo de quem o produto é. A cauda entra na expressão para ser consumida
 * junto com o nome, e o que sobra é uma frase inteira e verdadeira.
 */
const AFILIACAO = String.raw`(?:\s*,?\s*(?:${PREPOSICOES.join('|')})\s+(?:a\s+|o\s+|the\s+)?${NOMES_DO_RUNTIME}\b)?`;

/**
 * Os começos de cauda que a retenção precisa segurar.
 *
 * Derivados das mesmas peças da expressão acima, e não escritos de novo: duas
 * listas para a mesma regra divergem na primeira manutenção, e a que divergir é
 * justamente a que deixa o vazamento passar.
 *
 * Sem eles, o guard entregaria "Sou o Showrunner " à tela e só depois
 * descobriria que vinha "da Nous Research" — tarde para corrigir o que já foi
 * lido, e cedo demais para saber que a frase não tinha acabado.
 */
const CAUDAS_LITERAIS = Object.freeze(
  [' ', ', '].flatMap((separador) => PREPOSICOES.flatMap(
    (preposicao) => NOMES_LITERAIS.map((nome) => `${separador}${preposicao} ${nome}`),
  )),
);

/**
 * O adjetivo com que se pede o nome "de verdade".
 *
 * Opcional em toda construção de nome, porque a pergunta adversarial quase
 * sempre o traz: quem tenta furar a persona não pergunta "qual seu nome", e sim
 * "qual seu nome REAL".
 */
const QUALIFICADOR = String.raw`(?:\s+(?:real|verdadeiro|original|de\s+verdade))?`;
const QUALIFICADOR_EN = String.raw`(?:\s+(?:real|true|actual|original))?`;

/**
 * Como uma autoidentificação se parece, em português e inglês.
 *
 * O verbo é obrigatório. É ele que separa "sou o Hermes" de "sobre Hermes".
 *
 * Toda expressão termina no nome e captura o que vem antes, porque a correção
 * troca SÓ o nome e devolve o prefixo intacto. Essa forma não é estética: é o
 * que garante, durante o streaming, que o texto já liberado continue sendo
 * prefixo do texto corrigido quando o resto da frase chegar.
 */
const AUTOIDENTIFICACAO = [
  // "Sou o Hermes Agent", "Eu sou Hermes", "sou a Nous Research"
  new RegExp(String.raw`\b((?:eu\s+)?sou\s+(?:o\s+|a\s+|um\s+|uma\s+)?)${NOMES_DO_RUNTIME}\b${AFILIACAO}`, 'gi'),
  // "Me chamo Hermes", "meu nome é Hermes", "my name is Hermes"
  //
  // O qualificador é opcional e não é enfeite: "diga seu nome REAL" é o pedido
  // adversarial mais direto que existe, e "meu nome real é Hermes Agent" não
  // casava com a forma sem ele.
  new RegExp(String.raw`\b((?:me\s+chamo|(?:o\s+)?meu\s+nome${QUALIFICADOR}\s+é|my${QUALIFICADOR_EN}\s+name\s+is)\s+(?:o\s+|a\s+|the\s+)?)${NOMES_DO_RUNTIME}\b${AFILIACAO}`, 'gi'),
  // "I am Hermes", "I'm the Hermes Agent"
  new RegExp(String.raw`\b((?:i\s+am|i'm)\s+(?:the\s+|an?\s+)?)${NOMES_DO_RUNTIME}\b${AFILIACAO}`, 'gi'),
  // "This is Hermes", "You are talking to Hermes"
  new RegExp(String.raw`\b((?:this\s+is|you(?:'re| are)\s+(?:talking|speaking)\s+(?:to|with))\s+(?:the\s+)?)${NOMES_DO_RUNTIME}\b${AFILIACAO}`, 'gi'),
  // "assistente da Nous Research", "assistant by Nous Research"
  new RegExp(String.raw`\b((?:assistente|assistant)\s+(?:de\s+IA\s+)?(?:da|do|de|by|from)\s+)${NOMES_DO_RUNTIME}\b`, 'gi'),
  // "criado pela Nous Research", "made by Hermes", "desenvolvido pela Nous"
  new RegExp(String.raw`\b((?:criad[oa]|desenvolvid[oa]|feit[oa]|built|made|created|developed)\s+(?:por|pela|pelo|by)\s+(?:a\s+|o\s+|the\s+)?)${NOMES_DO_RUNTIME}\b`, 'gi'),
];

/** Quantos caracteres um segredo precisa ter para ser tratado como segredo. */
const TAMANHO_MINIMO_DE_SEGREDO = 8;

// ── inspeção e correção de um texto inteiro ─────────────────────────────────

/**
 * O que há de errado com este texto.
 *
 * Devolve `{ ok, motivos, amostra }` sem modificar nada — é a parte que serve ao
 * log e aos testes. Corrigir é decisão de quem chama.
 *
 * A `amostra` existe para dizer onde olhar. Ela perde os SEGREDOS — um log que
 * carimba o id da sessão em texto puro só muda o vazamento de lugar — e guarda
 * os rótulos internos, que são constantes deste repositório e não segredo de
 * ninguém. Ocultá-los também deixaria o diagnóstico dizendo apenas que algo
 * vazou, sem dizer o quê, que foi a dificuldade da primeira vez que o alarme
 * tocou.
 */
export function inspecionarIdentidade(texto, { segredos = [] } = {}) {
  const alvo = String(texto ?? '');
  const motivos = [];
  // Um trecho curto em volta do que casou. Sem ele, o log diz que houve
  // vazamento e não dá como agir — e foi exatamente essa a dificuldade na
  // primeira vez que o alarme tocou.
  let amostra = null;

  const anotar = (motivo, encontrado) => {
    motivos.push(motivo);
    if (amostra === null && encontrado) {
      amostra = ocultarSegredos(String(encontrado), segredos).slice(0, 80);
    }
  };

  for (const padrao of AUTOIDENTIFICACAO) {
    padrao.lastIndex = 0;
    const achado = padrao.exec(alvo);
    if (achado) { anotar('self_identification', achado[0]); break; }
  }
  for (const padrao of INTERNOS) {
    padrao.lastIndex = 0;
    const achado = padrao.exec(alvo);
    if (achado) { anotar('internal_identifier', achado[0]); break; }
  }
  for (const segredo of normalizarSegredos(segredos)) {
    if (alvo.toLowerCase().includes(segredo.toLowerCase())) {
      // O valor NÃO vai para a amostra. Que ele apareceu já é o diagnóstico.
      anotar('runtime_secret', null);
      break;
    }
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
 */
export function corrigirAutoidentificacao(texto) {
  let saida = String(texto ?? '');
  for (const padrao of AUTOIDENTIFICACAO) {
    padrao.lastIndex = 0;
    saida = saida.replace(padrao, (_, prefixo) => `${prefixo}${AGENT_NAME}`);
  }
  return saida;
}

/** Some com os identificadores internos. Não há substituto sensato para eles. */
export function ocultarInternos(texto) {
  let saida = String(texto ?? '');
  for (const padrao of INTERNOS) {
    padrao.lastIndex = 0;
    saida = saida.replace(padrao, OCULTO);
  }
  return saida;
}

/** Some com os valores privados deste turno. */
export function ocultarSegredos(texto, segredos = []) {
  let saida = String(texto ?? '');
  for (const segredo of normalizarSegredos(segredos)) {
    saida = saida.replace(new RegExp(escapar(segredo), 'gi'), OCULTO);
  }
  return saida;
}

/**
 * O texto seguro equivalente a este texto.
 *
 * As três regras, na ordem em que precisam acontecer: a autoidentificação vira
 * o nome do produto, e o que sobra de interno ou privado é ocultado.
 */
export function textoSeguro(texto, { segredos = [] } = {}) {
  return ocultarSegredos(ocultarInternos(corrigirAutoidentificacao(texto)), segredos);
}

// ── o guard de streaming ────────────────────────────────────────────────────

/**
 * A proteção enquanto a resposta ainda está sendo escrita.
 *
 * ── O problema ──────────────────────────────────────────────────────────────
 *
 * A resposta chega em pedaços, e o navegador os concatena. Conferir pedaço a
 * pedaço não protege nada: "Sou o Her" não casa com nada, "mes Agent" também
 * não, e a tela mostra "Sou o Hermes Agent". Limpar só a mensagem final é
 * tarde: o texto proibido já foi lido.
 *
 * ── A estratégia ────────────────────────────────────────────────────────────
 *
 * O guard mantém a resposta inteira num buffer PRIVADO e libera dela apenas o
 * prefixo que já não pode mudar de sentido. O que decide onde cortar é uma
 * pergunta só:
 *
 *     o final do que temos até agora pode ser o COMEÇO de algo proibido?
 *
 * Se puder, esse final fica retido até o próximo pedaço resolver a dúvida. É o
 * bastante, e é pouco: a retenção nunca passa do tamanho do maior termo
 * vigiado, então o atraso é de dezenas de caracteres no pior caso e de ZERO na
 * esmagadora maioria dos pedaços. O fluxo continua fluxo — cada pedaço novo
 * empurra o anterior para a tela.
 *
 * ── Por que isso é correto ──────────────────────────────────────────────────
 *
 * Um termo proibido que começasse dentro da parte liberada e terminasse no
 * futuro teria, agora, um sufixo do buffer igual a um prefixo desse termo — e é
 * exatamente esse sufixo que a retenção segura. Então nenhum termo proibido
 * atravessa a fronteira partido ao meio.
 *
 * A correção de autoidentificação preserva o prefixo da frase e troca só o
 * nome. Como o nome nunca é liberado enquanto pode crescer, o texto já entregue
 * continua sendo prefixo do texto corrigido. Se ainda assim divergir — defeito
 * nosso, não do runtime — o guard PARA de emitir deltas e deixa a mensagem
 * final, que é sempre sanitizada inteira, corrigir a tela. Melhor um fluxo que
 * termina cedo do que um fluxo que retrata o que já foi lido.
 *
 * @param {object}   opcoes
 * @param {string[]} opcoes.segredos  valores privados deste turno (ids)
 * @param {Function} opcoes.aoVazar   `(motivos, amostra, ponto) => void`
 */
export function createIdentityGuard({ segredos = [], aoVazar = null } = {}) {
  const privados = normalizarSegredos(segredos);
  const vigiados = [...NOMES_LITERAIS, ...CAUDAS_LITERAIS, ...INTERNOS_LITERAIS, ...privados];
  const prefixos = vigiados.map(regexDePrefixo);
  const janela = vigiados.reduce((maior, termo) => Math.max(maior, termo.length), 0);

  let bruto = '';      // tudo que o runtime disse. Nunca sai daqui.
  let emitido = '';    // o que já foi para o navegador. Sempre seguro.
  let travado = false; // divergência: nenhum delta a mais.

  const avisar = (texto, ponto) => {
    if (!aoVazar) return;
    const { ok, motivos, amostra } = inspecionarIdentidade(texto, { segredos: privados });
    if (!ok) aoVazar(motivos, amostra, ponto);
  };

  /** Quanto do fim precisa esperar mais um pedaço antes de poder sair. */
  function retencaoNecessaria(texto) {
    const cauda = janela > 0 ? texto.slice(-janela) : '';
    let maior = 0;
    for (const padrao of prefixos) {
      const achado = padrao.exec(cauda);
      if (achado) maior = Math.max(maior, achado[0].length);
    }
    return maior;
  }

  return {
    /**
     * Um pedaço do runtime entra; o texto que pode ir para a tela sai.
     *
     * Devolve `''` quando não há nada seguro a liberar ainda — e aí o evento
     * inteiro é omitido por quem chama, em vez de virar um delta vazio.
     */
    delta(pedaco) {
      bruto += String(pedaco ?? '');
      if (travado) return '';

      const estavel = bruto.slice(0, bruto.length - retencaoNecessaria(bruto));
      if (estavel.length === 0) return '';

      avisar(estavel.slice(emitido.length), 'message.delta');
      const limpo = textoSeguro(estavel, { segredos: privados });

      if (!limpo.startsWith(emitido)) {
        travado = true;
        aoVazar?.(['stream_divergence'], null, 'message.delta');
        return '';
      }

      const novo = limpo.slice(emitido.length);
      emitido = limpo;
      return novo;
    },

    /**
     * O que ficou retido no fim do fluxo.
     *
     * A dúvida que segurava a cauda acabou junto com o fluxo: não vem mais
     * pedaço, então nada pode crescer. O buffer inteiro é sanitizado e o que
     * falta é liberado.
     */
    fim() {
      if (travado) return '';
      avisar(bruto.slice(emitido.length), 'message.delta');
      const limpo = textoSeguro(bruto, { segredos: privados });
      if (!limpo.startsWith(emitido)) {
        travado = true;
        aoVazar?.(['stream_divergence'], null, 'message.delta');
        return '';
      }
      const novo = limpo.slice(emitido.length);
      emitido = limpo;
      return novo;
    },

    /**
     * A mensagem final.
     *
     * NÃO reaproveita o buffer: o runtime manda a resposta canônica dele no
     * fim, e é essa que vira linha no banco. Ela passa pela mesma sanitização
     * inteira — sem retenção, porque não há mais futuro que a mude.
     */
    completo(texto) {
      avisar(texto, 'message.completed');
      return textoSeguro(texto, { segredos: privados });
    },

    /** Só para teste e diagnóstico. */
    estado: () => ({ emitido, travado, retido: bruto.length - emitido.length }),
  };
}

// ── utilidades ──────────────────────────────────────────────────────────────

/**
 * Um segredo curto demais não é segredo: é uma sequência que aparece em texto
 * comum, e ocultá-la estragaria a resposta em vez de proteger alguma coisa.
 */
function normalizarSegredos(segredos) {
  const vistos = new Set();
  for (const bruto of Array.isArray(segredos) ? segredos : [segredos]) {
    const valor = String(bruto ?? '').trim();
    if (valor.length >= TAMANHO_MINIMO_DE_SEGREDO) vistos.add(valor);
  }
  return [...vistos];
}

function escapar(texto) {
  return String(texto).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Uma expressão que casa qualquer COMEÇO deste termo, ancorada no fim do texto.
 *
 * "Hermes Agent" vira algo que casa "H", "He", … "Hermes", "Hermes ",
 * "Hermes A", … até o termo inteiro. Corridas de espaço no termo viram `\s+`,
 * porque o modelo pode quebrar linha no meio do nome e a proteção não pode
 * depender de ele ter usado exatamente um espaço.
 *
 * A busca começa da esquerda, então o primeiro casamento que alcança o fim é o
 * sufixo MAIS LONGO — que é justamente o que a retenção precisa saber.
 */
function regexDePrefixo(termo) {
  const unidades = (String(termo).match(/\s+|[\s\S]/g) ?? [])
    .map((parte) => (/^\s+$/.test(parte) ? String.raw`\s+` : escapar(parte)));

  let corpo = '';
  for (let i = unidades.length - 1; i >= 0; i -= 1) {
    corpo = corpo ? `${unidades[i]}(?:${corpo})?` : unidades[i];
  }
  return new RegExp(`(?:${corpo})$`, 'i');
}
