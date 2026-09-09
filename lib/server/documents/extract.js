// Extração de texto: PDF e TXT → unidades de leitura ordenadas.
//
// ── O que é extração, e o que não é ─────────────────────────────────────────
//
// Extrair é ler o que está no arquivo. Não é corrigir, não é resumir, não é
// reescrever, e em especial não é passar o texto por um modelo para "melhorar"
// — o texto persistido precisa representar o documento do usuário, porque é
// sobre ELE que o agente vai afirmar coisas. Um texto melhorado transformaria
// cada resposta numa afirmação sobre a nossa paráfrase.
//
// A normalização é a menor possível: fim de linha, caractere NUL e espaço em
// branco patológico. Nada disso muda o que o documento diz.
//
// ── Por que o parser de PDF é carregado sob demanda ─────────────────────────
//
// `import()` dinâmico, dentro da função. Duas razões, e as duas são concretas:
//
//   1. o empacotador não arrasta o parser para lugar nenhum onde ele não seja
//      usado. Foi um `node:child_process` puxado por uma cadeia de imports que
//      derrubou TODA rota no PASSO 10.4 — um defeito que nem `npm test` nem
//      `npm run build` pegaram;
//   2. um TXT não paga o custo de carregar um parser de PDF.
//
// Este módulo é server-side e mais nada. Nenhum componente o importa; há teste
// de arquitetura que falha se um dia importar.

import { MAX_CHUNK_CHARS, JANELA_DE_QUEBRA } from './config.js';
import { DOCUMENT_TYPES } from '../domain/documentTypes.js';

/** Falha de extração — o arquivo chegou, e não deu para ler o conteúdo dele. */
export class DocumentExtractionError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'DocumentExtractionError';
    this.detail = detail;
  }
}

/**
 * A frase que o usuário lê quando o PDF não tem texto.
 *
 * Ela diz o que aconteceu E o que falta, porque as duas coisas são acionáveis:
 * a pessoa pode mandar outra versão do arquivo, e sabe que OCR é uma capacidade
 * ausente e não um erro dela. O que ela NÃO faz é adivinhar o conteúdo pelo
 * nome do arquivo — um documento sobre o qual não sabemos nada precisa produzir
 * essa resposta, não uma suposição.
 */
export const SEM_TEXTO_EXTRAIVEL = 'Este PDF não possui texto extraível. '
  + 'Documentos escaneados precisam de OCR, que ainda não é suportado.';

// ── a porta única ───────────────────────────────────────────────────────────

/**
 * Bytes + tipo → `{ pageCount, chunks }`.
 *
 * Recusa o tipo que não sabe ler, em vez de devolver vazio. Um tipo aceito no
 * upload e não tratado aqui viraria um documento em branco no banco — o modo de
 * falhar errado, porque o agente o abriria e concluiria que o arquivo está
 * vazio.
 */
export async function extractDocument(bytes, mimeType) {
  if (mimeType === DOCUMENT_TYPES.PDF) return extrairPdf(bytes);
  if (mimeType === DOCUMENT_TYPES.TEXT) return extrairTexto(bytes);
  throw new DocumentExtractionError(
    `Não sei ler este tipo de documento: "${mimeType}".`,
    { mimeType },
  );
}

// ── PDF ─────────────────────────────────────────────────────────────────────

/**
 * PDF com texto → uma unidade de leitura por página, na ordem das páginas.
 *
 * A página é preservada porque ela é a referência que o usuário tem: "está na
 * página 12" é acionável, "está no trecho 37" não é. Uma página maior que o
 * pedaço vira várias unidades, todas com o MESMO número de página — a divisão é
 * nossa, a página é do documento.
 *
 * Páginas vazias (uma folha só com imagem, uma página de separação) não viram
 * unidade nenhuma: um pedaço vazio ocuparia uma posição no cursor e faria a
 * leitura gastar uma volta para não devolver nada.
 */
async function extrairPdf(bytes) {
  // Carregado agora, e não no topo do arquivo — ver o cabeçalho.
  const { extractText } = await import('unpdf');

  let bruto;
  try {
    bruto = await extractText(new Uint8Array(bytes), { mergePages: false });
  } catch (erro) {
    // A mensagem do parser é de operador: ela cita offset de byte, número de
    // objeto e nome de estrutura interna do PDF. Nada disso é assunto de quem
    // mandou o arquivo, e o que a pessoa precisa saber é que o arquivo não abre.
    throw new DocumentExtractionError(
      'Não consegui abrir este PDF. Ele pode estar corrompido ou protegido por senha.',
      { causa: erro?.message || null },
    );
  }

  const paginas = Array.isArray(bruto?.text) ? bruto.text : [String(bruto?.text ?? '')];
  const pageCount = Number(bruto?.totalPages) || paginas.length;

  const chunks = [];
  for (let i = 0; i < paginas.length; i += 1) {
    const texto = normalizar(paginas[i]);
    if (!temConteudo(texto)) continue;
    for (const parte of dividir(texto)) {
      chunks.push({ pageNumber: i + 1, text: parte });
    }
  }

  // Zero conteúdo em TODAS as páginas é o PDF escaneado. Não é falha do parser
  // e não é arquivo corrompido: é um PDF válido feito de imagens. A resposta
  // honesta é dizer isso — ver SEM_TEXTO_EXTRAIVEL.
  if (chunks.length === 0) {
    throw new DocumentExtractionError(SEM_TEXTO_EXTRAIVEL, { pageCount });
  }

  return { pageCount: pageCount > 0 ? pageCount : null, chunks };
}

// ── TXT ─────────────────────────────────────────────────────────────────────

/**
 * TXT em UTF-8 → unidades de leitura sem página.
 *
 * A decodificação é FATAL de propósito: um arquivo que não é UTF-8 válido tem
 * de ser recusado, não decodificado com losango de substituição. Aceitá-lo
 * gravaria lixo no banco e o agente afirmaria coisas sobre ele.
 *
 * BOM é permitido e removido. Ele é marca de codificação, não conteúdo, e
 * deixá-lo faria a primeira palavra do documento começar com um caractere
 * invisível que estraga qualquer busca por ela.
 */
function extrairTexto(bytes) {
  let decodificado;
  try {
    decodificado = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new DocumentExtractionError(
      'Este arquivo não é texto em UTF-8.',
      {},
    );
  }

  const semBom = decodificado.charCodeAt(0) === 0xfeff ? decodificado.slice(1) : decodificado;
  const texto = normalizar(semBom);

  if (!temConteudo(texto)) {
    throw new DocumentExtractionError('Este arquivo de texto está vazio.', {});
  }

  return { pageCount: null, chunks: dividir(texto).map((parte) => ({ pageNumber: null, text: parte })) };
}

/**
 * Um arquivo binário renomeado para `.txt`.
 *
 * Três perguntas, da mais barata para a mais cara, e qualquer uma basta:
 *
 *   NUL              nenhum texto legítimo tem byte zero. É o sinal mais claro
 *                    que existe, e é o primeiro porque custa uma varredura.
 *   UTF-8 inválido   a decodificação fatal recusa quase todo binário — as
 *                    sequências de continuação de UTF-8 são raras por acaso.
 *   controles C0     o que sobra: um binário que por acidente é UTF-8 válido e
 *                    não tem NUL ainda vem cheio de bytes de controle, que
 *                    texto de verdade não tem.
 *
 * Exportada porque quem valida o upload precisa da MESMA resposta que a
 * extração dá — duas implementações de "isto é binário?" divergiriam, e a
 * divergência apareceria como um arquivo aceito no upload e recusado depois.
 */
export function pareceBinario(bytes) {
  const vista = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

  let controles = 0;
  for (let i = 0; i < vista.length; i += 1) {
    const b = vista[i];
    if (b === 0x00) return true;
    // C0 exceto tab (0x09), LF (0x0a), CR (0x0d) e form feed (0x0c).
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c) controles += 1;
  }

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(vista);
  } catch {
    return true;
  }

  return vista.length > 0 && controles / vista.length > 0.02;
}

// ── normalização e divisão ──────────────────────────────────────────────────

/**
 * A menor normalização que ainda deixa o texto utilizável.
 *
 * Fim de linha vira `\n` (um PDF gerado no Windows traz CRLF, e o CR isolado
 * vira caractere invisível no meio da frase). NUL sai — ele não deveria estar
 * lá, e uma coluna TEXT do SQLite trunca em silêncio quando encontra um.
 * Espaço em branco patológico é comprimido: o extrator de PDF produz corridas
 * de dezenas de espaços onde havia tabulação de layout, e elas gastam contexto
 * sem dizer nada.
 *
 * O que NÃO é tocado: acento, maiúscula, pontuação, quebra de parágrafo,
 * ortografia, ordem. Nada que mude o que o documento diz.
 */
export function normalizar(texto) {
  return String(texto ?? '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    // Espaços e tabulações em corrida viram um espaço. `\n` fica de fora da
    // classe de propósito: comprimi-lo apagaria a separação de parágrafos.
    .replace(/[^\S\n]{2,}/g, ' ')
    // Quatro ou mais linhas em branco viram duas. Duas já são a maior pausa que
    // um texto expressa; o resto é a paginação do PDF vazando para o conteúdo.
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

/** Tem pelo menos um caractere que não é espaço em branco. */
function temConteudo(texto) {
  return /\S/.test(String(texto ?? ''));
}

/**
 * Divide um texto em unidades de leitura, deterministicamente e sem perder
 * nada.
 *
 * A garantia que importa: `dividir(t).join('') === t`. Nenhum caractere é
 * descartado, duplicado ou reordenado — é isso que permite ao agente percorrer
 * o documento inteiro e saber que viu o documento inteiro.
 *
 * A quebra procura um limite natural nos últimos JANELA_DE_QUEBRA caracteres:
 * primeiro fim de parágrafo, depois fim de linha, depois espaço. Sem nenhum
 * deles (uma corrida de caracteres sem espaço), corta no teto — um pedaço
 * ligeiramente feio é melhor do que um pedaço sem tamanho.
 */
export function dividir(texto, tamanho = MAX_CHUNK_CHARS) {
  const inteiro = String(texto ?? '');
  const teto = Math.max(1, Number(tamanho) || MAX_CHUNK_CHARS);
  if (inteiro.length <= teto) return inteiro ? [inteiro] : [];

  const janela = Math.min(JANELA_DE_QUEBRA, Math.trunc(teto / 2));
  const partes = [];
  let inicio = 0;

  while (inicio < inteiro.length) {
    if (inteiro.length - inicio <= teto) {
      partes.push(inteiro.slice(inicio));
      break;
    }

    const limite = inicio + teto;
    const piso = limite - janela;
    const corte = melhorCorte(inteiro, piso, limite) ?? limite;

    partes.push(inteiro.slice(inicio, corte));
    inicio = corte;
  }

  return partes;
}

/** O melhor ponto de quebra dentro da janela, ou `null` se não houver. */
function melhorCorte(texto, piso, limite) {
  for (const marca of ['\n\n', '\n', ' ']) {
    const achado = texto.lastIndexOf(marca, limite - marca.length);
    // O corte fica DEPOIS da marca: assim ela pertence ao pedaço que termina, e
    // a concatenação continua sendo o texto original.
    if (achado >= piso) return achado + marca.length;
  }
  return null;
}
