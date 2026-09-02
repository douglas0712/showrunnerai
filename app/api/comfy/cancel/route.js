import { NextResponse } from 'next/server';
import { cancelJob } from '@/lib/server/comfy/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_RE = /^[A-Za-z0-9_-]{1,64}$/;

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
    const job = await cancelJob(corpo.jobId);
    if (!job) return NextResponse.json({ error: 'Job desconhecido.' }, { status: 404 });
    return NextResponse.json(job);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
}
