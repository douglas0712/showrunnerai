import { NextResponse } from 'next/server';
import { pollJob } from '@/lib/server/comfy/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(request) {
  const jobId = new URL(request.url).searchParams.get('jobId');
  if (!JOB_RE.test(String(jobId || ''))) {
    return NextResponse.json({ error: 'jobId inválido.' }, { status: 400 });
  }

  try {
    const job = await pollJob(jobId);
    if (!job) return NextResponse.json({ error: 'Job desconhecido.' }, { status: 404 });
    return NextResponse.json(job);
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 502 });
  }
}
