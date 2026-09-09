// O contexto privado dos documentos anexados a um turno.
//
// ── O problema ──────────────────────────────────────────────────────────────
//
// O usuário arrasta um PDF e escreve "sobre o que é este documento?". O texto
// sozinho não tem referente: "este" aponta para algo que aconteceu FORA da
// frase. O modelo precisa saber qual arquivo é — e precisa do identificador
// dele, para poder pedi-lo pela ferramenta.
//
// ── Por que isto é um módulo, e não uma função dentro do adaptador ──────────
//
// Porque são duas responsabilidades diferentes, e elas mudam por motivos
// diferentes:
//
//   o QUE dizer      é produto: a frase que ensina o modelo a interpretar
//                    "este PDF", em português, com o vocabulário da conversa.
//                    Mora aqui, no núcleo da camada de agente.
//   COMO entregar    é integração: um runtime que só aceita uma mensagem por
//                    turno recebe isto como preâmbulo; um que tivesse campo de
//                    anexo receberia de outro jeito. Mora no adaptador.
//
// Mantê-las juntas faria o tradutor de um runtime específico ser o dono do
// texto do produto — e trocar de runtime passaria a exigir reescrever a frase.
//
// ── E o mesmo mecanismo serve à mídia ───────────────────────────────────────
//
// "Anime essa imagem" tem exatamente a mesma forma de "sobre o que é este PDF?":
// uma referência que aponta para fora da frase, e que o modelo não consegue
// resolver sozinho porque o identificador nunca chegou até ele. A resposta é a
// mesma — o servidor diz o que pode ser referenciado, o modelo escolhe, e
// nenhum identificador é inventado. Ver `imageReferenceBriefing`.
//
// ── O que NÃO entra aqui ────────────────────────────────────────────────────
//
// O conteúdo do documento. Nome, tipo, tamanho e identificador, e nada mais: o
// texto pode ter dezenas de milhares de caracteres, é material privado de quem
// o enviou, e é lido SOB DEMANDA pela ferramenta — só a parte que a tarefa
// exigir. Empurrá-lo para dentro de todo turno gastaria o contexto inteiro para
// responder "sobre o que é isto?".
//
// E o texto público da mensagem não é tocado. A linha em `agent_messages` é
// gravada antes disto existir, com o que o usuário escreveu e nada mais — então
// este preâmbulo não aparece na tela, não sobrevive ao reload e não vira
// histórico. É contexto de UM turno, e some com ele.

/**
 * O aviso ao modelo sobre os documentos deste turno.
 *
 * Devolve string vazia quando o turno não trouxe anexo — e a ausência é o caso
 * normal, então ela precisa custar nada.
 */
export function attachmentBriefing(anexos) {
  if (!Array.isArray(anexos) || anexos.length === 0) return '';

  const itens = anexos
    .filter((anexo) => anexo && typeof anexo.documentId === 'string' && anexo.documentId)
    .map((anexo) => `- ${descrever(anexo)}`);

  if (!itens.length) return '';

  return [
    '[contexto do sistema — não repita isto ao usuário]',
    itens.length === 1
      ? 'O usuário anexou este documento a esta mensagem:'
      : 'O usuário anexou estes documentos a esta mensagem:',
    ...itens,
    'Quando ele disser "este documento", "esse PDF" ou "o arquivo que mandei", é a '
    + 'um destes que ele se refere. Leia o conteúdo pela ferramenta de leitura de '
    + 'documento antes de responder qualquer coisa sobre ele, e baseie a resposta '
    + 'no que está escrito — nunca no nome do arquivo.',
  ].join('\n');
}

/**
 * O aviso ao modelo sobre a mídia que ESTA conversa já produziu.
 *
 * ── O problema, medido ──────────────────────────────────────────────────────
 *
 * "Anime essa imagem" exige que a ferramenta receba `sourceAssetId`. Só que o
 * modelo não tem esse id: a geração devolve `{ jobId, kind, status }`, e o Asset
 * nasce depois, no acompanhamento do servidor, com o turno dele já encerrado.
 *
 * Sem uma lista, o modelo faz a única coisa possível — descreve a imagem num
 * prompt e gera um vídeo do zero. Foi exatamente o que aconteceu no Quality
 * Gate: o vídeo pareceu certo e a linhagem nasceu nula, porque não houve
 * imagem→vídeo.
 *
 * ── Por que uma LISTA, e não "a última" ─────────────────────────────────────
 *
 * Porque escolher por ele seria heurística: "a última imagem" acerta enquanto
 * houver uma só, e erra em silêncio quando há duas — que é justamente quando o
 * usuário precisa ser entendido. O servidor oferece o que existe; a
 * DESAMBIGUAÇÃO é do modelo, que tem a conversa, e quando ela não basta a
 * resposta certa é perguntar.
 *
 * O `prompt` de cada Asset é o que os torna distinguíveis. Sem ele, uma lista
 * de identificadores não ajuda ninguém a decidir qual é "a do astronauta".
 */
export function imageReferenceBriefing(imagens) {
  if (!Array.isArray(imagens) || imagens.length === 0) return '';

  const itens = imagens
    .filter((a) => a && typeof a.assetId === 'string' && a.assetId)
    .map((a) => `- ${a.assetId}${a.prompt ? ` — "${a.prompt}"` : ''}`);

  if (!itens.length) return '';

  return [
    '[contexto do sistema — não repita isto ao usuário]',
    itens.length === 1
      ? 'Esta conversa já produziu esta imagem:'
      : 'Esta conversa já produziu estas imagens (da mais recente para a mais antiga):',
    ...itens,
    'Se o usuário pedir para ANIMAR, dar movimento, ou transformar em vídeo uma '
    + 'imagem que já existe, passe o identificador dela em sourceAssetId — sem '
    + 'isso o vídeo é gerado do zero, sem relação com a imagem, e é a coisa '
    + 'errada. Nunca invente um identificador: use um desta lista.',
    itens.length === 1
      ? ''
      : 'Se o pedido não deixar claro a QUAL delas ele se refere, pergunte antes '
        + 'de gerar. Não escolha por conta própria.',
  ].filter(Boolean).join('\n');
}

/** Uma linha por documento: como ele se chama, e o bastante para escolher. */
function descrever(anexo) {
  const partes = [`${anexo.filename || 'arquivo'} (documentId: ${anexo.documentId}`];

  const paginas = Number(anexo.pageCount);
  if (Number.isFinite(paginas) && paginas > 0) {
    partes.push(`, ${paginas} ${paginas === 1 ? 'página' : 'páginas'}`);
  }

  const caracteres = Number(anexo.textLength);
  if (Number.isFinite(caracteres) && caracteres > 0) {
    partes.push(`, ${caracteres} caracteres de texto`);
  }

  partes.push(')');
  return partes.join('');
}
