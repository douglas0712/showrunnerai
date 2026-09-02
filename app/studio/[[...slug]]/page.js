import StudioShell from '@/components/StudioShell';
import { TABS } from '@/components/navigation';

export function generateStaticParams() {
  return [{ slug: [] }, ...TABS.map((tab) => ({ slug: [tab.id] }))];
}

export default async function StudioPage({ params }) {
  const { slug } = await params;
  const requested = Array.isArray(slug) ? slug[0] : undefined;
  const initialTab = TABS.some((tab) => tab.id === requested) ? requested : 'inicio';

  return <StudioShell initialTab={initialTab} />;
}
