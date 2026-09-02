/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fase 1: nenhuma origem remota é permitida. Sem imagens externas,
  // sem fontes remotas, sem telemetria — tudo roda offline.
  images: { remotePatterns: [] },
  // O selo de desenvolvimento do Next flutua sobre o rodapé da barra lateral.
  devIndicators: false,
};

export default nextConfig;
