import { NextResponse } from 'next/server';
import { handleCreateThread, handleListThreads } from '@/lib/server/agent/httpApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Conversas conhecidas. `?projectId=` filtra; `?projectId=none` traz as sem projeto. */
export async function GET(request) {
  const projectId = new URL(request.url).searchParams.get('projectId');

  const params = projectId === null
    ? {}
    : { projectId: projectId === 'none' ? null : projectId };

  const { status, body } = handleListThreads(params);
  return NextResponse.json(body, { status });
}

/** Cria uma conversa. `projectId` é opcional; quando vem, o projeto precisa existir. */
export async function POST(request) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const { status, body } = handleCreateThread(corpo);
  return NextResponse.json(body, { status });
}
