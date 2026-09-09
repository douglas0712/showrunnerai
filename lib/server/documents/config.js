// Limites e configuração da ingestão de documentos.
//
// Tudo aqui é configuração de OPERADOR — variável de ambiente, lida no
// servidor. Nada disso é escolhido por corpo de requisição nem por argumento de
// ferramenta, pela mesma regra que já governa `COMFY_WORKFLOW` e as raízes de
// workflow: variável de ambiente pode definir política; entrada de usuário não.

/**
 * Teto de um arquivo enviado. Padrão: 25 MB.
 *
 * Escolhido pelo que ele deixa passar: um PDF de texto de algumas centenas de
 * páginas raramente passa de 10 MB, e 25 dá folga para um com imagens sem
 * transformar um upload em algo que o servidor precise transmitir em pedaços.
 * Acima disso o arquivo quase sempre é escaneado — e PDF escaneado precisa de
 * OCR, que este passo não tem.
 *
 * Lido a cada chamada, e não congelado em constante de módulo, para que mudar a
 * variável não exija reiniciar num ambiente que recarrega módulos.
 */
export function maxDocumentBytes() {
  const bruto = Number(process.env.SHOWRUNNER_DOCUMENT_MAX_BYTES);
  if (Number.isFinite(bruto) && bruto > 0) return Math.trunc(bruto);
  return 25 * 1024 * 1024;
}

/** Piso: abaixo disso não é documento, é engano. */
export const MIN_DOCUMENT_BYTES = 8;

/**
 * Tamanho alvo de um pedaço de leitura, em caracteres.
 *
 * Uma página de PDF cabe folgada aqui — a maioria tem entre 1500 e 3000
 * caracteres —, então na prática um pedaço é uma página, que é a unidade que o
 * usuário reconhece. Páginas maiores são divididas; ver `extract.js`.
 */
export const MAX_CHUNK_CHARS = 4000;

/**
 * Onde a divisão de um pedaço grande pode cair.
 *
 * A quebra procura um limite natural nos últimos 25% do pedaço. Sem essa
 * janela, procurar "o último parágrafo" poderia devolver um pedaço minúsculo
 * quando o texto tem uma quebra logo no começo.
 */
export const JANELA_DE_QUEBRA = Math.trunc(MAX_CHUNK_CHARS * 0.25);
