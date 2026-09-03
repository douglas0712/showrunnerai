import { NextResponse } from 'next/server';
import { handleGetThread } from '@/lib/server/agent/httpApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** A conversa e suas mensagens, em ordem. */
export async function GET(_request, { params }) {
  const { threadId } = await params;
  const { status, body } = handleGetThread(threadId);
  return NextResponse.json(body, { status });
}
