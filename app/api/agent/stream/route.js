import { handleStreamMessage } from '@/lib/server/agent/httpApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Um turno, evento a evento, por Server-Sent Events.
 *
 * O que trafega aqui é o vocabulário do Showrunner — `agent.message.delta`,
 * `tool.started`, e os outros de `events.js`. O protocolo do runtime que
 * produziu esses eventos não chega a este arquivo, muito menos ao navegador.
 *
 * A rota faz o que só ela pode fazer: ler o corpo, montar a resposta e
 * serializar. A decisão inteira está em `handleStreamMessage`, que é testável
 * sem `next/server`.
 */
export async function POST(request) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return Response.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const resultado = handleStreamMessage(corpo, { signal: request.signal });

  // Validação falhou antes de o fluxo abrir: ainda dá para responder com
  // status. Depois do primeiro byte, não daria.
  if (!resultado.stream) {
    return Response.json(resultado.body, { status: resultado.status });
  }

  const codificador = new TextEncoder();
  const fluxo = new ReadableStream({
    async start(controlador) {
      try {
        for await (const { event, data } of resultado.stream) {
          controlador.enqueue(codificador.encode(
            `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          ));
        }
      } catch {
        // O gerador já converte falha em `agent.failed`. Chegar aqui significa
        // que o próprio fluxo quebrou — fechar é tudo o que resta, e o cliente
        // trata fim sem `agent.completed` como turno interrompido.
      } finally {
        controlador.close();
      }
    },
  });

  return new Response(fluxo, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Sem isto, um proxy reverso pode segurar os eventos e entregar tudo no
      // fim — o que anula o streaming sem dar nenhum sinal de que anulou.
      'X-Accel-Buffering': 'no',
    },
  });
}
