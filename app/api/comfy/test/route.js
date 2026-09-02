import { NextResponse } from 'next/server';
import { testConnection } from '@/lib/server/comfy/provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  try {
    const resultado = await testConnection();
    return NextResponse.json(resultado, { status: resultado.ok ? 200 : 503 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, performedRequest: true, message: error.message, checks: [] },
      { status: 503 },
    );
  }
}

export const GET = POST;
