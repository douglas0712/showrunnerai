import { NextResponse } from 'next/server';
import { handleListDocuments, handleUploadDocument } from '@/lib/server/documents/httpApi';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Os documentos de um projeto. Só metadata — o conteúdo não tem rota pública. */
export async function GET(request) {
  const projectId = new URL(request.url).searchParams.get('projectId');
  const { status, body } = handleListDocuments({ projectId });
  return NextResponse.json(body, { status });
}

/**
 * Anexa um documento a um projeto.
 *
 * `multipart/form-data` com `projectId` e `file`. A rota faz o que só ela pode
 * fazer — ler o corpo — e entrega os bytes à camada, que decide o resto.
 */
export async function POST(request) {
  const tipoDeConteudo = request.headers.get('content-type') || '';
  if (!tipoDeConteudo.includes('multipart/form-data')) {
    return NextResponse.json(
      { error: 'Envie o arquivo como multipart/form-data.' },
      { status: 415 },
    );
  }

  let formulario;
  try {
    formulario = await request.formData();
  } catch {
    return NextResponse.json({ error: 'Corpo inválido.' }, { status: 400 });
  }

  const arquivo = formulario.get('file');
  if (!arquivo || typeof arquivo.arrayBuffer !== 'function') {
    return NextResponse.json({ error: 'Nenhum arquivo enviado.' }, { status: 400 });
  }

  const { status, body } = await handleUploadDocument({
    projectId: formulario.get('projectId'),
    // O nome vem do navegador e é tratado como RÓTULO. Ele não forma caminho
    // nenhum — ver lib/server/documents/storage.js.
    filename: arquivo.name || 'documento',
    declaredMimeType: arquivo.type || null,
    bytes: new Uint8Array(await arquivo.arrayBuffer()),
  });

  return NextResponse.json(body, { status });
}
