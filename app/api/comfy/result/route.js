import { NextResponse } from 'next/server';
import { finalizeGeneration } from '@/lib/server/generation/facade';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Traz o resultado de uma geração concluída.
 *
 * Entra pela camada de geração pelo mesmo motivo do status: chamar
 * `finalizeJob` direto publicava o arquivo e parava aí — sem Asset e sem
 * registro. A publicação continua sendo a do executor; o que passou a
 * acontecer junto é o que o Showrunner precisa saber sobre ela.
 *
 * A resposta é a mesma de antes.
 */
export async function POST(request) {
  let corpo;
  try {
    corpo = await request.json();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  if (!JOB_RE.test(String(corpo?.jobId || ''))) {
    return NextResponse.json({ error: 'jobId inválido.' }, { status: 400 });
  }

  try {
    const job = await finalizeGeneration(corpo.jobId);
    if (!job) return NextResponse.json({ error: 'Job desconhecido.' }, { status: 404 });
    return NextResponse.json(job);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
}
