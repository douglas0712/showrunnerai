import { NextResponse } from 'next/server';
import { listExportJobs } from '@/lib/server/export/runner';
import { ffmpegAvailable } from '@/lib/server/export/ffmpeg';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** Permite retomar o acompanhamento depois de recarregar a página. */
export async function GET(request) {
  const projectId = new URL(request.url).searchParams.get('projectId');
  if (projectId && !ID_RE.test(projectId)) {
    return NextResponse.json({ error: 'projectId inválido.' }, { status: 400 });
  }

  const ffmpeg = await ffmpegAvailable();
  return NextResponse.json({
    exports: listExportJobs({ projectId: projectId || null }),
    ffmpeg: { ok: ffmpeg.ok, version: ffmpeg.version || null },
  });
}
