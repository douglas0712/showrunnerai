'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { StudioProvider, useStudio } from './StudioContext';
import { NAV_GROUPS, getTab, tabPath, TABS } from './navigation';
import { Icon } from './ui/icons';
import { Badge, IconButton } from './ui/primitives';
import { Toaster } from './ui/Toaster';

import HomeScreen from './screens/HomeScreen';
import CreateScreen from './screens/CreateScreen';
import ImageScreen from './screens/ImageScreen';
import VideoScreen from './screens/VideoScreen';
import CinemaScreen from './screens/CinemaScreen';
import CharactersScreen from './screens/CharactersScreen';
import StoryboardScreen from './screens/StoryboardScreen';
import ProjectsScreen from './screens/ProjectsScreen';
import LibraryScreen from './screens/LibraryScreen';
import WorkflowsScreen from './screens/WorkflowsScreen';
import AgentScreen from './screens/AgentScreen';
import SettingsScreen from './screens/SettingsScreen';
import LogsScreen from './screens/LogsScreen';

const SCREENS = {
  inicio: HomeScreen,
  criar: CreateScreen,
  imagem: ImageScreen,
  video: VideoScreen,
  cinema: CinemaScreen,
  personagens: CharactersScreen,
  storyboard: StoryboardScreen,
  projetos: ProjectsScreen,
  biblioteca: LibraryScreen,
  workflows: WorkflowsScreen,
  agente: AgentScreen,
  configuracoes: SettingsScreen,
  logs: LogsScreen,
};

export default function StudioShell({ initialTab = 'inicio' }) {
  return (
    <StudioProvider>
      <ShellLayout initialTab={initialTab} />
    </StudioProvider>
  );
}

function ShellLayout({ initialTab }) {
  const router = useRouter();
  const [tabId, setTabId] = useState(initialTab);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const { toasts, dismissToast, setHandoff } = useStudio();

  useEffect(() => {
    setTabId(initialTab);
  }, [initialTab]);

  /**
   * Navegação única da aplicação. `payload` permite que uma tela entregue um
   * contexto para outra (ex.: "usar esta imagem no vídeo") sem estado global
   * espalhado.
   */
  const navigate = useCallback(
    (id, payload = null) => {
      if (!SCREENS[id]) return;
      if (payload) setHandoff({ target: id, payload, at: Date.now() });
      setTabId(id);
      setMobileNavOpen(false);
      router.push(tabPath(id), { scroll: false });
    },
    [router, setHandoff],
  );

  const Screen = SCREENS[tabId] || HomeScreen;
  const tab = getTab(tabId);

  return (
    <div className="flex min-h-screen">
      <Sidebar
        tabId={tabId}
        navigate={navigate}
        open={mobileNavOpen}
        onClose={() => setMobileNavOpen(false)}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar tab={tab} navigate={navigate} onOpenNav={() => setMobileNavOpen(true)} />
        <main className="scroll-thin flex-1 overflow-y-auto px-4 pb-14 pt-6 sm:px-6 lg:px-8">
          <div className="mx-auto w-full max-w-[1400px]">
            <Screen navigate={navigate} />
          </div>
        </main>
      </div>

      <Toaster toasts={toasts} onDismiss={dismissToast} />
    </div>
  );
}

function Sidebar({ tabId, navigate, open, onClose }) {
  return (
    <>
      {open ? (
        <button
          type="button"
          aria-label="Fechar navegação"
          onClick={onClose}
          className="fixed inset-0 z-30 bg-black/70 lg:hidden"
        />
      ) : null}

      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-[248px] shrink-0 flex-col border-r border-hairline bg-ink-2/95 backdrop-blur-xl transition-transform lg:static lg:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <button
          type="button"
          onClick={() => navigate('inicio')}
          className="focus-ring flex items-start gap-3 px-5 pb-5 pt-6 text-left"
        >
          <Logo />
          <span className="min-w-0">
            <span className="block text-[14px] font-semibold leading-tight tracking-tight text-chalk">
              Showrunner Studio
            </span>
            <span className="mt-0.5 block text-[10.5px] leading-snug text-mist">
              Crie, dirija e produza vídeos com inteligência artificial.
            </span>
          </span>
        </button>

        <nav className="scroll-thin flex-1 overflow-y-auto px-3 pb-4">
          {NAV_GROUPS.map((group) => (
            <div key={group.name} className="mb-4">
              <p className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-mist/55">
                {group.name}
              </p>
              <ul className="space-y-0.5">
                {group.tabs.map((item) => {
                  const active = item.id === tabId;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => navigate(item.id)}
                        aria-current={active ? 'page' : undefined}
                        className={`pressable focus-ring flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] ${
                          active
                            ? 'bg-white/[0.09] font-medium text-chalk'
                            : 'text-mist hover:bg-white/[0.05] hover:text-chalk'
                        }`}
                      >
                        <span className={active ? 'text-gold' : 'text-mist/80'}>
                          <Icon name={item.icon} size={16} />
                        </span>
                        {item.label}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="border-t border-hairline px-4 py-3">
          <div className="flex items-center gap-2">
            <Badge tone="teal">100% local</Badge>
            <span className="text-[10.5px] text-mist">sem conta, sem chave</span>
          </div>
          <p className="mt-1.5 text-[10.5px] leading-snug text-mist/70">
            Cinema gera de verdade pelo ComfyUI. Os demais estúdios ainda são simulados.
          </p>
        </div>
      </aside>
    </>
  );
}

function TopBar({ tab, navigate, onOpenNav }) {
  const { activeProject } = useStudio();

  return (
    <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-hairline bg-ink/85 px-4 py-3 backdrop-blur-xl sm:px-6 lg:px-8">
      <button
        type="button"
        aria-label="Abrir navegação"
        onClick={onOpenNav}
        className="focus-ring flex h-9 w-9 items-center justify-center rounded-lg border border-hairline text-mist lg:hidden"
      >
        <Icon name="storyboard" size={16} />
      </button>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[14px] font-semibold tracking-tight text-chalk">{tab.label}</h1>
        <p className="truncate text-[11.5px] text-mist">{tab.description}</p>
      </div>

      {activeProject ? (
        <button
          type="button"
          onClick={() => navigate('projetos')}
          className="focus-ring hidden max-w-[240px] items-center gap-2 rounded-lg border border-hairline bg-white/[0.04] px-3 py-1.5 text-left hover:bg-white/[0.08] sm:flex"
        >
          <Icon name="projetos" size={14} />
          <span className="min-w-0">
            <span className="block text-[9.5px] uppercase tracking-wider text-mist">Projeto ativo</span>
            <span className="block truncate text-[12px] text-chalk">{activeProject.name}</span>
          </span>
        </button>
      ) : null}

      <IconButton icon="configuracoes" label="Configurações" onClick={() => navigate('configuracoes')} />
    </header>
  );
}

function Logo() {
  return (
    <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-gold/30 bg-gradient-to-br from-gold/25 to-violet/20">
      <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.4" className="text-gold" />
        <path d="M10 8.2 16.2 12 10 15.8z" className="fill-gold" />
      </svg>
    </span>
  );
}

export { TABS };
