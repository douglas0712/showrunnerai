import './globals.css';

export const metadata = {
  title: 'Showrunner Studio',
  description: 'Crie, dirija e produza vídeos com inteligência artificial.',
  applicationName: 'Showrunner Studio',
};

export const viewport = {
  themeColor: '#060608',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body className="app-backdrop min-h-screen bg-ink text-chalk antialiased">
        <div className="relative z-10">{children}</div>
      </body>
    </html>
  );
}
