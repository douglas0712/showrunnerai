// Serve os arquivos de mídia gravados pelo Showrunner Studio.
//
// Segurança: a rota NÃO aceita caminho. Ela aceita exatamente três segmentos
// — kind/projectId/arquivo — cada um validado antes de qualquer acesso ao
// disco, e o caminho final é resolvido e conferido contra a raiz do runtime.
//
// A decisão de qual arquivo, qual MIME e qual política de Range vive em
// lib/server/generation/mediaServing.js, onde é testável; aqui fica só o I/O e
// a montagem da resposta.
//
//   video/<projeto>/<arquivo>.mp4        → clipe gerado
//   image/<projeto>/<arquivo>.png|jpg…   → imagem gerada
//   export/<projeto>/<arquivo>.mp4       → montagem final
//   frame/<projeto>/<arquivo>.jpg        → quadro da filmstrip em cache

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import { MediaRequestError, parseByteRange, resolveMediaRequest } from '@/lib/server/generation/mediaServing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { segments } = await params;

  let recurso;
  try {
    recurso = resolveMediaRequest(segments);
  } catch (error) {
    const status = error instanceof MediaRequestError ? error.status : 500;
    const mensagem = status === 400 ? 'Recurso inválido.' : 'Recurso não encontrado.';
    return NextResponse.json({ error: mensagem }, { status });
  }

  let info;
  try {
    info = await stat(recurso.absolutePath);
  } catch {
    return NextResponse.json({ error: 'Recurso não encontrado.' }, { status: 404 });
  }
  if (!info.isFile()) {
    return NextResponse.json({ error: 'Recurso não encontrado.' }, { status: 404 });
  }

  const total = info.size;

  const cabecalhosBase = {
    'content-type': recurso.mime,
    'cache-control': recurso.cacheControl,
    'content-disposition': `inline; filename="${recurso.filename}"`,
    'x-content-type-options': 'nosniff',
    ...(recurso.range ? { 'accept-ranges': 'bytes' } : {}),
  };

  // Requisição parcial: o player usa isso para buscar posição no vídeo.
  if (recurso.range) {
    const faixa = parseByteRange(request.headers.get('range'), total);

    if (faixa === 'invalido') {
      return new NextResponse(null, {
        status: 416,
        headers: { 'content-range': `bytes */${total}` },
      });
    }

    if (faixa) {
      const { inicio, fim } = faixa;
      return new NextResponse(
        toWebStream(createReadStream(recurso.absolutePath, { start: inicio, end: fim })),
        {
          status: 206,
          headers: {
            ...cabecalhosBase,
            'content-range': `bytes ${inicio}-${fim}/${total}`,
            'content-length': String(fim - inicio + 1),
          },
        },
      );
    }
  }

  return new NextResponse(toWebStream(createReadStream(recurso.absolutePath)), {
    status: 200,
    headers: { ...cabecalhosBase, 'content-length': String(total) },
  });
}

/** Converte o stream do Node no ReadableStream que a resposta espera. */
function toWebStream(nodeStream) {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      nodeStream.on('end', () => controller.close());
      nodeStream.on('error', (error) => controller.error(error));
    },
    cancel() {
      nodeStream.destroy();
    },
  });
}
