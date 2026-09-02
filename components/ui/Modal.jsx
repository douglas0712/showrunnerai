'use client';

import { useEffect } from 'react';
import { IconButton, Button } from './primitives';

export function Modal({ open, title, subtitle, onClose, children, footer, wide = false }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Fechar"
        onClick={onClose}
        className="absolute inset-0 bg-black/75 backdrop-blur-sm"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`panel fade-up relative z-10 flex max-h-[88vh] w-full flex-col overflow-hidden ${
          wide ? 'max-w-4xl' : 'max-w-lg'
        }`}
      >
        <header className="flex items-start justify-between gap-4 border-b border-hairline px-5 py-4">
          <div>
            <h3 className="text-[15px] font-semibold text-chalk">{title}</h3>
            {subtitle ? <p className="mt-0.5 text-[12px] text-mist">{subtitle}</p> : null}
          </div>
          <IconButton icon="close" label="Fechar" onClick={onClose} />
        </header>
        <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? (
          <footer className="flex items-center justify-end gap-2 border-t border-hairline px-5 py-3">
            {footer}
          </footer>
        ) : null}
      </div>
    </div>
  );
}

export function ConfirmFooter({ onCancel, onConfirm, confirmLabel = 'Confirmar', variant = 'primary', disabled }) {
  return (
    <>
      <Button variant="ghost" onClick={onCancel}>
        Cancelar
      </Button>
      <Button variant={variant} onClick={onConfirm} disabled={disabled}>
        {confirmLabel}
      </Button>
    </>
  );
}
