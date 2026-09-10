// A fronteira de síntese de voz — o contrato, e nada mais.
//
// PASSO 14-C2. Este arquivo não fala com sintetizador nenhum. Ele diz o que o
// Showrunner exige de qualquer um deles, para que trocar de provider seja
// trocar um módulo, e não reescrever o domínio.
//
// ── Por que uma fronteira própria, e não um workflow do ComfyUI ─────────────
//
// Porque o sintetizador que existe nesta máquina não é um workflow. O ComfyUI
// tem nós de texto-para-voz registrados — ElevenLabs, HeyGen, ByteDance — e os
// três são `api_node: true`: serviços pagos, na nuvem, com credencial. O que
// existe local e gratuito é um binário. Embrulhá-lo num grafo falso só para
// caber no caminho de imagem/vídeo seria inventar uma peça de ComfyUI que não
// existe, e todo o resto do sistema passaria a acreditar nela.
//
// A regra que essa decisão preserva: o Showrunner é dono do CONTRATO, e o
// provider é implementação substituível. Quem manda no que uma narração é —
// o texto, a proveniência, o take, a seleção — é o domínio. O provider só sabe
// transformar texto em arquivo.
//
// ── O que um provider NÃO decide ───────────────────────────────────────────
//
// De quem é o projeto, que texto será falado, qual take isto vira, se a voz
// passa a ser a escolhida, onde o arquivo mora. Nada disso chega até ele: a
// função abaixo recebe texto e um caminho de saída que o Showrunner escolheu, e
// devolve o que produziu.

/** Falha de síntese. Mensagem pública é provider-neutral; detalhe é interno. */
export class TtsError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'TtsError';
    this.detail = detail;
  }
}

/**
 * O contrato que todo provider de voz cumpre.
 *
 * ```
 * synthesize({ text, outputPath, language }) → { path, extension }
 * ```
 *
 * - `text`      o que falar. Vem do snapshot persistido da cena, nunca do
 *               chamador — ver `startNarrationGeneration`.
 * - `outputPath` onde escrever. Resolvido pelo Showrunner, dentro do runtime.
 *               O provider NUNCA escolhe caminho: um provider que escrevesse
 *               onde quisesse seria um provider capaz de escrever em qualquer
 *               lugar.
 * - `language`  dica de idioma, quando o provider a aceita. Resolvida do
 *               estado persistido do projeto, e não pedida a cada chamada.
 *
 * Devolve o caminho realmente escrito e a extensão que ele produziu — o
 * Showrunner publica no formato do provider em vez de transcodificar por
 * preferência.
 *
 * `describe()` devolve o que identifica o provider para o livro-razão, sem
 * segredo nenhum: nome e modelo/voz resolvidos server-side.
 */

/** O provider ativo. Trocar aqui troca a voz do produto inteiro. */
let ativo = null;

/**
 * Injeção no estilo da casa: o default é o provider real, e um teste passa o
 * dele. É o que permite provar a ORDEM e a POLÍTICA sem sintetizar um segundo
 * de áudio — nenhum teste automatizado depende do binário estar instalado.
 */
export function ttsProvider(provider = null) {
  if (provider) return provider;
  if (ativo) return ativo;
  throw new TtsError(
    'Não há sintetizador de voz configurado nesta instalação.',
    { motivo: 'provider ausente' },
  );
}

export function setTtsProvider(provider) {
  ativo = provider;
  return ativo;
}
