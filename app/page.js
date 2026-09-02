import { redirect } from 'next/navigation';

export default function RootPage() {
  // A plataforma abre direto no estúdio: sem login, sem cadastro, sem chave.
  redirect('/studio');
}
