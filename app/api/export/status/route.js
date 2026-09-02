import { NextResponse } from 'next/server';
import { getExportJob, publicExportJob } from '@/lib/server/export/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(request) {
  const exportId = new URL(request.url).searchParams.get('exportId');
  if (!ID_RE.test(String(exportId || ''))) {
    return NextResponse.json({ error: 'exportId inválido.' }, { status: 400 });
  }

  const job = getExportJob(exportId);
  if (!job) return NextResponse.json({ error: 'Exportação desconhecida.' }, { status: 404 });

  return NextResponse.json(publicExportJob(job));
}
