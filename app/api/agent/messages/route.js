import { NextResponse } from 'next/server';
import { handleSendMessage } from '@/lib/server/agent/httpApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Um turno de conversa: a mensagem do usuário entra, a resposta sai.
 *
 * Chamada síncrona, resposta JSON. Não há SSE nesta etapa — mas os eventos
 * normalizados do turno já acompanham a resposta, no mesmo vocabulário em que
 * o streaming vai chegar.
 */
export async function POST(request) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const { status, body } = await handleSendMessage(corpo);
  return NextResponse.json(body, { status });
}
