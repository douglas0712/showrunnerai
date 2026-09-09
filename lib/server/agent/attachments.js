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
