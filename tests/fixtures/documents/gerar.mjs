// Gerador dos PDFs de teste.
//
// Os fixtures são versionados (são pequenos e precisam ser estáveis), e este
// script é como eles foram feitos. Ele existe para que ninguém precise
// adivinhar de onde vieram — e para que refazê-los, se um dia for preciso,
// produza exatamente os mesmos bytes.
//
//     node tests/fixtures/documents/gerar.mjs
//
// ── Por que PDF escrito à mão, e não um gerado por biblioteca ───────────────
//
// Porque estes arquivos precisam ser MÍNIMOS e PREVISÍVEIS. Um PDF de
// biblioteca traz metadados, data de criação e compressão — e a data faz os
// bytes mudarem a cada execução, o que transformaria um fixture numa fonte de
// diferença espúria no Git.
//
// A estrutura aqui é a menor que a especificação aceita: catálogo, árvore de
// páginas, uma fonte, um fluxo de conteúdo por página, e uma tabela xref
// correta. Sem compressão, para que o arquivo seja legível com `cat`.

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));

/** Escapa o que é significativo dentro de uma string literal de PDF. */
function literal(texto) {
  return texto.replace(/([\\()])/g, '\\$1');
}

/**
 * Monta um PDF com uma página por elemento de `paginas`.
 *
 * Cada página é uma lista de linhas. Uma página com lista vazia sai SEM
 * operador de texto nenhum — é assim que o fixture "sem texto extraível" é
 * feito: um PDF perfeitamente válido, com página de tamanho normal, e nada
 * escrito. É o que um documento escaneado é, do ponto de vista do extrator.
 */
function montarPdf(paginas) {
  const objetos = [];
  const idCatalogo = 1;
  const idPaginas = 2;
  const idFonte = 3;
  const primeiroDaPagina = 4;

  const idsDePagina = paginas.map((_, i) => primeiroDaPagina + i * 2);

  objetos[idCatalogo] = `<< /Type /Catalog /Pages ${idPaginas} 0 R >>`;
  objetos[idPaginas] = `<< /Type /Pages /Kids [${idsDePagina.map((id) => `${id} 0 R`).join(' ')}] /Count ${paginas.length} >>`;
  // WinAnsiEncoding para que acento sobreviva à volta: o extrator mapeia o
  // código de volta para Unicode por esta declaração.
  objetos[idFonte] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';

  paginas.forEach((linhas, i) => {
    const idPagina = primeiroDaPagina + i * 2;
    const idConteudo = idPagina + 1;

    const corpo = linhas.length
      ? `BT /F1 11 Tf 14 TL 56 736 Td\n${linhas.map((l) => `(${literal(l)}) Tj T*`).join('\n')}\nET\n`
      : '';

    objetos[idPagina] = `<< /Type /Page /Parent ${idPaginas} 0 R /MediaBox [0 0 612 792] `
      + `/Resources << /Font << /F1 ${idFonte} 0 R >> >> /Contents ${idConteudo} 0 R >>`;
    objetos[idConteudo] = { fluxo: corpo };
  });

  // ── serialização, com xref real ───────────────────────────────────────────
  const pedacos = [];
  const offsets = [];
  let posicao = 0;

  const escrever = (texto) => {
    // latin-1: é o que WinAnsiEncoding espera nos bytes da string literal.
    const bytes = Buffer.from(texto, 'latin1');
    pedacos.push(bytes);
    posicao += bytes.length;
  };

  escrever('%PDF-1.4\n');

  for (let id = 1; id < objetos.length; id += 1) {
    const objeto = objetos[id];
    if (objeto === undefined) continue;
    offsets[id] = posicao;

    if (typeof objeto === 'object' && 'fluxo' in objeto) {
      const tamanho = Buffer.from(objeto.fluxo, 'latin1').length;
      escrever(`${id} 0 obj\n<< /Length ${tamanho} >>\nstream\n${objeto.fluxo}endstream\nendobj\n`);
    } else {
      escrever(`${id} 0 obj\n${objeto}\nendobj\n`);
    }
  }

  const inicioXref = posicao;
  const total = objetos.length;

  let xref = `xref\n0 ${total}\n0000000000 65535 f \n`;
  for (let id = 1; id < total; id += 1) {
    xref += `${String(offsets[id] ?? 0).padStart(10, '0')} 00000 n \n`;
  }
  escrever(xref);
  escrever(`trailer\n<< /Size ${total} /Root ${idCatalogo} 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`);

  return Buffer.concat(pedacos);
}

// ── os fixtures ─────────────────────────────────────────────────────────────
//
// Os fatos dentro deles são INVENTADOS de propósito. Um teste que pergunta
// "quem fundou a cidade?" só prova que o documento foi lido se a resposta não
// puder vir de conhecimento prévio nenhum — nem do modelo, nem de quem lê o
// teste. Uma cidade que não existe é a única maneira de saber a diferença.

const ARQUIVOS = {
  'texto-simples.pdf': montarPdf([[
    'RELATORIO DE FUNDACAO - ARKAN VALE',
    '',
    'A cidade experimental de Arkan Vale foi fundada em 17 de marco de 2187.',
    'Seu primeiro prefeito foi Elias Venn, engenheiro hidraulico.',
    'A populacao inicial registrada era de 4.812 habitantes.',
    'O lema gravado no portao norte e "Agua, luz e memoria".',
  ]]),

  'multipagina.pdf': montarPdf([
    [
      'CADERNO DE CAMPO - VOLUME I',
      '',
      'Pagina de abertura. O caderno pertence a Comissao de Arkan Vale.',
      'O codigo de arquivo deste volume e QV-7731.',
    ],
    [
      'CAPITULO 1 - O RIO SUBTERRANEO',
      '',
      'O rio Meridian corre a 240 metros abaixo da praca central.',
      'A primeira bomba foi instalada por Elias Venn no inverno de 2188.',
    ],
    [
      'CAPITULO 2 - A TORRE DE SINAIS',
      '',
      'A torre de sinais tem 63 metros e foi erguida em onze semanas.',
      'O sino do topo se chama Verena e toca duas vezes ao amanhecer.',
    ],
  ]),

  // Um PDF válido, com uma página de tamanho normal, e nada escrito nela. É o
  // que um documento escaneado é para o extrator: páginas sem operador de texto.
  'sem-texto.pdf': montarPdf([[]]),
};

// Um documento grande o bastante para exigir mais de uma leitura.
//
// O teto de uma leitura é MAX_READ_CHARS (24 mil caracteres). Este passa de 30
// mil, então o agente precisa seguir o nextCursor pelo menos uma vez — e o
// teste consegue provar que ele não pulou nem repetiu nada.
const paginasGrandes = [];
for (let p = 1; p <= 14; p += 1) {
  const linhas = [`SECAO ${p} - ARQUIVO CORRENTE DE ARKAN VALE`, ''];
  for (let l = 1; l <= 26; l += 1) {
    linhas.push(
      `Registro ${p}.${l}: a ata numero ${p * 100 + l} descreve a inspecao do setor `
      + `${p} conduzida pela equipe tecnica, sem ocorrencias relevantes no periodo.`,
    );
  }
  // Uma marca por página, para o teste conferir que nenhuma se perdeu.
  linhas.push(`Marca de conferencia da secao ${p}: MARCO-${p}.`);
  paginasGrandes.push(linhas);
}
ARQUIVOS['grande.pdf'] = montarPdf(paginasGrandes);

for (const [nome, bytes] of Object.entries(ARQUIVOS)) {
  writeFileSync(path.join(AQUI, nome), bytes);
  process.stdout.write(`${nome}: ${bytes.length} bytes\n`);
}
