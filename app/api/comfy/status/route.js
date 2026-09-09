import { NextResponse } from 'next/server';
import { observeGeneration } from '@/lib/server/generation/facade';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * O estado de uma geração.
 *
 * Entra pela camada de geração, e não pelo executor. A rota chamava `pollJob`
 * direto — o que funcionava, mas deixava esta observação fora do livro-razão:
 * a mesma geração vista pelo agente atualizava o registro durável, e vista por
 * esta tela não atualizava nada. Duas portas com semânticas diferentes.
 *
 * O corpo da resposta é o mesmo de antes; o que mudou foi por onde ele passa.
 */
export async function GET(request) {
  const jobId = new URL(request.url).searchParams.get('jobId');
  if (!JOB_RE.test(String(jobId || ''))) {
    return NextResponse.json({ error: 'jobId inválido.' }, { status: 400 });
  }

  try {
    const job = await observeGeneration(jobId);
    if (!job) return NextResponse.json({ error: 'Job desconhecido.' }, { status: 404 });
    return NextResponse.json(job);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
}
