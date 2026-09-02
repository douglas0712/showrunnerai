// Persistência local. Só localStorage — nenhum servidor, nenhum banco remoto.

const PREFIX = 'showrunner.';

export const KEYS = {
  PROJECTS: `${PREFIX}projects`,
  GENERATIONS: `${PREFIX}generations`,
  STORYBOARD: `${PREFIX}storyboard`,
  TIMELINE: `${PREFIX}timeline`,
  CONVERSATION: `${PREFIX}conversation`,
  SETTINGS: `${PREFIX}settings`,
  CHARACTERS: `${PREFIX}characters`,
  CINEMA: `${PREFIX}cinema`,
  CINEMA_JOB: `${PREFIX}cinemaJob`,
  TIMELINE_REVISION: `${PREFIX}timelineRevision`,
  EXPORT_JOB: `${PREFIX}exportJob`,
  ACTIVE_PROJECT: `${PREFIX}activeProject`,
};

export function readKey(key, fallback) {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw == null) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function writeKey(key, value) {
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function clearAll() {
  if (typeof window === 'undefined') return;
  Object.values(KEYS).forEach((key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* ignora */
    }
  });
}

export function storageReport() {
  if (typeof window === 'undefined') return [];
  return Object.entries(KEYS).map(([name, key]) => {
    const raw = (() => {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    })();
    return { name, key, bytes: raw ? raw.length : 0, present: raw != null };
  });
}
