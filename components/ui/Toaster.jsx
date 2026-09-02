'use client';

import { Icon } from './icons';

const TONE_STYLES = {
  info: 'border-hairline bg-panel-2 text-chalk',
  ok: 'border-ok/35 bg-ok/10 text-ok',
  warn: 'border-warn/35 bg-warn/10 text-warn',
  error: 'border-danger/35 bg-danger/10 text-danger',
};

const TONE_ICON = { info: 'spark', ok: 'check', warn: 'revise', error: 'close' };

export function Toaster({ toasts = [], onDismiss }) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-[60] flex w-[min(92vw,380px)] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`fade-up pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[12.5px] leading-snug shadow-2xl backdrop-blur ${
            TONE_STYLES[toast.tone] || TONE_STYLES.info
          }`}
        >
          <span className="mt-[1px] shrink-0">
            <Icon name={TONE_ICON[toast.tone] || 'spark'} size={14} />
          </span>
          <span className="flex-1">{toast.message}</span>
          <button
            type="button"
            aria-label="Dispensar"
            onClick={() => onDismiss(toast.id)}
            className="shrink-0 opacity-60 hover:opacity-100"
          >
            <Icon name="close" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
