// Leitor de Server-Sent Events.
//
// Módulo puro: recebe texto, devolve eventos. Não abre conexão, não conhece o
// Hermes e não sabe o que os eventos significam. É essa ignorância que o torna
// testável sem servidor nenhum — e o parsing de um protocolo de texto é
// exatamente o tipo de código que precisa ser testado sem servidor.
//
// O formato (WHATWG): linhas `campo: valor`, blocos separados por linha em
// branco. Nos eventos observados do Hermes:
//
//     id: <stream>:<n>
//     event: token
//     data: {"text":"Vou"}
//
// `data` pode aparecer em várias linhas; a especificação manda juntá-las com
// "\n". O Hermes emite uma só, mas seguir a especificação aqui custa três
// linhas e evita um bug que só apareceria com uma carga grande.

/** Um evento pronto. `data` é sempre string; interpretar JSON é de quem usa. */
function montar(evento) {
  return {
    id: evento.id ?? null,
    event: evento.event || 'message',
    data: evento.data.join('\n'),
  };
}

/**
 * Um leitor incremental.
 *
 * Guarda o resto entre chamadas, porque um chunk de rede corta no meio de uma
 * linha com frequência e um parser que assuma o contrário funciona em teste e
 * falha em produção.
 */
export function createSseParser() {
  let buffer = '';
  let atual = { id: null, event: null, data: [] };
  const prontos = [];

  const finalizarBloco = () => {
    if (atual.data.length || atual.event) prontos.push(montar(atual));
    atual = { id: null, event: null, data: [] };
  };

  const consumirLinha = (linhaBruta) => {
    // \r\n vira \n: a especificação aceita os dois e o servidor escolhe.
    const linha = linhaBruta.replace(/\r$/, '');

    if (linha === '') { finalizarBloco(); return; }
    // Linha iniciada por ":" é comentário/keep-alive. Descartada.
    if (linha.startsWith(':')) return;

    const sep = linha.indexOf(':');
    const campo = sep === -1 ? linha : linha.slice(0, sep);
    // A especificação manda remover UM espaço após os dois-pontos, não todos.
    let valor = sep === -1 ? '' : linha.slice(sep + 1);
    if (valor.startsWith(' ')) valor = valor.slice(1);

    if (campo === 'id') atual.id = valor;
    else if (campo === 'event') atual.event = valor;
    else if (campo === 'data') atual.data.push(valor);
    // Qualquer outro campo (retry, o que for) é ignorado: não usamos.
  };

  return {
    /** Entrega um pedaço e recebe os eventos que ele completou. */
    push(chunk) {
      buffer += String(chunk ?? '');
      let quebra = buffer.indexOf('\n');
      while (quebra !== -1) {
        consumirLinha(buffer.slice(0, quebra));
        buffer = buffer.slice(quebra + 1);
        quebra = buffer.indexOf('\n');
      }
      return prontos.splice(0, prontos.length);
    },

    /**
     * Fecha o fluxo e devolve o que sobrou.
     *
     * Um servidor que encerra sem a linha em branco final deixaria o último
     * evento preso no buffer. Aqui ele sai.
     */
    flush() {
      if (buffer) { consumirLinha(buffer); buffer = ''; }
      finalizarBloco();
      return prontos.splice(0, prontos.length);
    },
  };
}

/** Conveniência para testes: texto inteiro → lista de eventos. */
export function parseSse(texto) {
  const parser = createSseParser();
  return [...parser.push(texto), ...parser.flush()];
}

/**
 * Interpreta o `data` de um evento como JSON.
 *
 * Devolve `null` quando não é JSON, em vez de lançar: um evento malformado no
 * meio de um fluxo não deve derrubar o turno inteiro, e quem chama já precisa
 * saber ignorar evento que não reconhece.
 */
export function parseEventData(evento) {
  if (!evento || typeof evento.data !== 'string' || !evento.data) return null;
  try {
    return JSON.parse(evento.data);
  } catch {
    return null;
  }
}
