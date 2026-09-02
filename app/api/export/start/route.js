import { NextResponse } from 'next/server';
import { startExport, findPendingScenes } from '@/lib/server/export/runner';
import { ExportArgsError, TARGET_PRESETS, DEFAULT_PRESET } from '@/lib/server/export/args';
import { AssetResolutionError } from '@/lib/server/export/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CENAS = 100;

export async function POST(request) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const { projectId, clips, presetId = DEFAULT_PRESET } = corpo || {};

  if (!ID_RE.test(String(projectId || ''))) {
    return NextResponse.json({ error: 'projectId inválido.' }, { status: 400 });
  }
  if (!Array.isArray(clips) || clips.length === 0) {
    return NextResponse.json({ error: 'A timeline não tem cenas para exportar.' }, { status: 400 });
  }
  if (clips.length > MAX_CENAS) {
    return NextResponse.json({ error: `Máximo de ${MAX_CENAS} cenas por exportação.` }, { status: 400 });
  }
  if (!TARGET_PRESETS[presetId]) {
    return NextResponse.json({ error: 'Perfil de exportação desconhecido.' }, { status: 400 });
  }

  // O cliente só pode mandar identificadores — nunca caminho, nunca argumento.
  const limpos = clips.map((clip) => ({
    jobId: typeof clip?.jobId === 'string' ? clip.jobId : undefined,
    mediaUrl: typeof clip?.mediaUrl === 'string' ? clip.mediaUrl : undefined,
    resultId: typeof clip?.resultId === 'string' ? clip.resultId : undefined,
    title: typeof clip?.title === 'string' ? clip.title : undefined,
    status: typeof clip?.status === 'string' ? clip.status : undefined,
    approved: clip?.approved === true,
  }));

  const pendentes = findPendingScenes(limpos);
  if (pendentes.length) {
    return NextResponse.json(
      {
        error: `Há ${pendentes.length} cena(s) sem aprovação.`,
        pending: pendentes,
      },
      { status: 409 },
    );
  }

  try {
    const job = await startExport({ projectId, clips: limpos, presetId });
    return NextResponse.json(job, { status: 202 });
  } catch (erro) {
    const status = erro instanceof ExportArgsError ? 422
      : erro instanceof AssetResolutionError ? 422
        : 500;
    return NextResponse.json(
      { error: erro.message, pending: erro.pending || null, detail: erro.detail || null },
      { status },
    );
  }
}
