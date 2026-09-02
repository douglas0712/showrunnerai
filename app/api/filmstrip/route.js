import { NextResponse } from 'next/server';
import { getFilmstrip, FilmstripError } from '@/lib/server/media/filmstrip';
import { AssetResolutionError } from '@/lib/server/export/assets';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Filmstrip de um clipe registrado.
 *
 * O cliente informa apenas o jobId; o caminho do MP4 vem da allowlist do
 * servidor. Extrai na primeira chamada e serve do cache nas seguintes.
 */
export async function GET(request) {
  const jobId = new URL(request.url).searchParams.get('jobId');
  if (!JOB_RE.test(String(jobId || ''))) {
    return NextResponse.json({ error: 'jobId inválido.' }, { status: 400 });
  }

  try {
    const tira = await getFilmstrip(jobId);
    return NextResponse.json(tira, {
      // O conteúdo é imutável para uma dada chave de cache.
      headers: { 'cache-control': 'private, max-age=300' },
    });
  } catch (erro) {
    const status = erro instanceof AssetResolutionError ? 404
      : erro instanceof FilmstripError ? 422
        : 500;
    return NextResponse.json({ error: erro.message, detail: erro.detail || null }, { status });
  }
}
