// Serve os vídeos gravados pelo Showrunner Studio.
//
// Segurança: a rota NÃO aceita caminho. Ela aceita exatamente três segmentos
// — kind/projectId/arquivo — cada um validado contra uma regex estrita antes
// de qualquer acesso ao disco. O caminho final é resolvido e conferido contra
// a raiz do runtime; qualquer coisa fora dela é recusada.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { NextResponse } from 'next/server';
import {
  PathValidationError, resolveExportPath, resolveFramePath, resolveVideoPath,
} from '@/lib/server/comfy/storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request, { params }) {
  const { segments } = await params;

  // Três tipos, todos com exatamente três segmentos e nomes validados:
  //   video/<projeto>/<arquivo>.mp4   → clipe gerado
  //   export/<projeto>/<arquivo>.mp4  → montagem final
  //   frame/<projeto>/<arquivo>.jpg   → quadro da filmstrip em cache
  const TIPOS = {
    video: { resolver: resolveVideoPath, mime: 'video/mp4', range: true },
    export: { resolver: resolveExportPath, mime: 'video/mp4', range: true },
    frame: { resolver: resolveFramePath, mime: 'image/jpeg', range: false },
  };

  if (!Array.isArray(segments) || segments.length !== 3 || !TIPOS[segments[0]]) {
    return NextResponse.json({ error: 'Recurso não encontrado.' }, { status: 404 });
  }

  const [tipo, projectId, filename] = segments;
  const config = TIPOS[tipo];

  let caminho;
  try {
    caminho = config.resolver(projectId, filename);
  } catch (error) {
    const status = error instanceof PathValidationError ? 400 : 500;
    return NextResponse.json({ error: 'Recurso inválido.' }, { status });
  }

  let info;
  try {
    info = await stat(caminho);
  } catch {
    return NextResponse.json({ error: 'Recurso não encontrado.' }, { status: 404 });
  }
  if (!info.isFile()) {
    return NextResponse.json({ error: 'Recurso não encontrado.' }, { status: 404 });
  }

  const total = info.size;
  const range = request.headers.get('range');

  const cabecalhosBase = {
    'content-type': config.mime,
    'cache-control': config.range ? 'private, max-age=3600' : 'private, max-age=86400, immutable',
    'content-disposition': `inline; filename="${filename}"`,
    'x-content-type-options': 'nosniff',
    ...(config.range ? { 'accept-ranges': 'bytes' } : {}),
  };

  // Requisição parcial: o player usa isso para buscar posição no vídeo.
  if (range && config.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      let inicio = match[1] === '' ? null : Number(match[1]);
      let fim = match[2] === '' ? null : Number(match[2]);

      if (inicio === null && fim !== null) {
        inicio = Math.max(0, total - fim);
        fim = total - 1;
      } else {
        inicio = inicio ?? 0;
        fim = fim === null ? total - 1 : Math.min(fim, total - 1);
      }

      if (!Number.isFinite(inicio) || !Number.isFinite(fim) || inicio > fim || inicio >= total) {
        return new NextResponse(null, {
          status: 416,
          headers: { 'content-range': `bytes */${total}` },
        });
      }

      return new NextResponse(toWebStream(createReadStream(caminho, { start: inicio, end: fim })), {
        status: 206,
        headers: {
          ...cabecalhosBase,
          'content-range': `bytes ${inicio}-${fim}/${total}`,
          'content-length': String(fim - inicio + 1),
        },
      });
    }
  }

  return new NextResponse(toWebStream(createReadStream(caminho)), {
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
