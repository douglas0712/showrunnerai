import { NextResponse } from 'next/server';
import { listJobs, recoverFromHistory } from '@/lib/server/comfy/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PROJECT_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Lista os jobs conhecidos e, opcionalmente, adota resultados que existem no
 * ComfyUI mas ainda não chegaram à aplicação (`?recover=1`).
 *
 * A recuperação apenas lê o histórico e copia arquivos já produzidos — nunca
 * submete um grafo nem regenera nada.
 */
export async function GET(request) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get('projectId');
  const recover = url.searchParams.get('recover') === '1';

  if (projectId && !PROJECT_RE.test(projectId)) {
    return NextResponse.json({ error: 'projectId inválido.' }, { status: 400 });
  }

  let recuperacao = null;
  if (recover) {
    recuperacao = await recoverFromHistory();
  }

  return NextResponse.json({
    jobs: listJobs({ projectId: projectId || null }),
    recovered: recuperacao?.recovered || [],
    skipped: recuperacao?.skipped || [],
    recoveryError: recuperacao?.error || null,
  });
}
