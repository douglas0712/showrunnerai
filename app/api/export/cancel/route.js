import { NextResponse } from 'next/server';
import { cancelExport } from '@/lib/server/export/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function POST(request) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  if (!ID_RE.test(String(corpo?.exportId || ''))) {
    return NextResponse.json({ error: 'exportId inválido.' }, { status: 400 });
  }

  // O cancelamento atinge apenas o processo deste exportId.
  const job = await cancelExport(corpo.exportId);
  if (!job) return NextResponse.json({ error: 'Exportação desconhecida.' }, { status: 404 });
  return NextResponse.json(job);
}
