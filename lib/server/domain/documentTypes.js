// O vocabulário dos documentos de um Project — zero imports, é domínio.
//
// Mesmo critério de `generationJobStates.js`: a cláusula CHECK do esquema
// precisa desta lista, e uma segunda lista escrita em SQL divergiria da
// primeira no dia em que um tipo entrasse. Como este módulo não importa nada,
// `db.js` pode importá-lo sem ciclo.
//
// ── O que este passo aceita, e por que só isto ──────────────────────────────
//
// PDF com texto e TXT em UTF-8. DOCX, PPTX, imagem e PDF escaneado (que exige
// OCR) ficam de fora — não por serem difíceis, mas porque cada um traz um
// extrator e um modo de falhar próprios, e um passo que aceitasse todos de uma
// vez não teria como provar que algum deles funciona.
//
// Acrescentar um tipo é acrescentar uma linha aqui E um extrator. Esquecer o
// segundo faz o upload ser aceito e o conteúdo nascer vazio, que é o modo de
// falhar errado — por isso o extrator recusa o que não sabe ler.

/** Os tipos de arquivo que a ingestão aceita. */
export const DOCUMENT_TYPES = Object.freeze({
  PDF: 'application/pdf',
  TEXT: 'text/plain',
});

/** Os valores aceitos, para a cláusula CHECK e para a validação de upload. */
export const DOCUMENT_TYPE_VALUES = Object.freeze(Object.values(DOCUMENT_TYPES));

/**
 * A extensão com que o arquivo original é guardado, por tipo.
 *
 * O nome que o usuário enviou NUNCA vira nome de arquivo no disco — ver
 * `documents/storage.js`. O arquivo se chama sempre `source<extensão>`, e a
 * extensão sai desta tabela, não do que veio do navegador.
 */
const EXTENSAO_POR_TIPO = Object.freeze({
  [DOCUMENT_TYPES.PDF]: '.pdf',
  [DOCUMENT_TYPES.TEXT]: '.txt',
});

export function isDocumentType(valor) {
  return DOCUMENT_TYPE_VALUES.includes(String(valor));
}

/** A extensão de armazenamento de um tipo. Lança para o que não está na tabela. */
export function storageExtensionFor(mimeType) {
  const ext = EXTENSAO_POR_TIPO[String(mimeType)];
  if (!ext) throw new Error(`Tipo de documento sem extensão declarada: "${mimeType}".`);
  return ext;
}

/**
 * Só o PDF tem páginas.
 *
 * Um TXT não tem, e inventar uma para ele — "página 1" — faria o agente citar
 * uma divisão que não existe no arquivo do usuário. `pageNumber` fica nulo, e
 * nulo aqui quer dizer "este formato não tem páginas", não "não descobrimos".
 */
export function hasPages(mimeType) {
  return String(mimeType) === DOCUMENT_TYPES.PDF;
}
