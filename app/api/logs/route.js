import { NextResponse } from 'next/server';
import { logStore } from '@/lib/server/logs/store';
import { persistStatus } from '@/lib/server/logs/persist';
import { LEVELS } from '@/lib/server/logs/stages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JOB_RE = /^[A-Za-z0-9_-]{1,64}$/;
const NIVEIS = new Set(Object.values(LEVELS));

/**
 * Eventos de diagnóstico do servidor.
 *
 * Leitura incremental por cursor: a tela manda o `since` que recebeu na chamada
 * anterior e só volta o que apareceu depois. É o que mantém o polling barato
 * mesmo com o buffer cheio.
 */
export async function GET(request) {
  const params = new URL(request.url).searchParams;

  const jobId = params.get('jobId');
  if (jobId && !JOB_RE.test(jobId)) {
    return NextResponse.json({ error: 'jobId inválido.' }, { status: 400 });
  }

  const level = params.get('level');
  if (level && !NIVEIS.has(level)) {
    return NextResponse.json({ error: 'Nível inválido.' }, { status: 400 });
  }

  const since = Number(params.get('since')) || 0;
  const limit = Number(params.get('limit')) || undefined;

  const { events, cursor, truncated } = logStore().query({ since, jobId, level, limit });

  return NextResponse.json({
    events,
    cursor,
    truncated,
    stats: logStore().stats(),
    persist: persistStatus(),
  });
}
