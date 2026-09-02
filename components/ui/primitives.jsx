'use client';

import { Icon } from './icons';

/* ---------------------------------------------------------------------------
   Primitivos compartilhados.
   O contrato de altura fixa (38px) para controles de parâmetro e o botão
   primário único vêm da disciplina do "Prompt Composer" do Open Generative AI
   (MIT) — ver THIRD_PARTY_NOTICES.md. A implementação abaixo é própria.
   --------------------------------------------------------------------------- */

export const CONTROL_HEIGHT = 'h-[38px]';

const VARIANTS = {
  primary:
    'bg-gold text-ink font-semibold hover:bg-gold-soft disabled:bg-hairline disabled:text-mist',
  secondary:
    'bg-white/[0.06] text-chalk hover:bg-white/[0.11] border border-hairline',
  ghost: 'bg-transparent text-mist hover:text-chalk hover:bg-white/[0.06]',
  danger: 'bg-danger/15 text-danger hover:bg-danger/25 border border-danger/30',
  ok: 'bg-ok/15 text-ok hover:bg-ok/25 border border-ok/30',
};

export function Button({
  children,
  variant = 'secondary',
  icon,
  size = 'md',
  className = '',
  ...rest
}) {
  const sizing =
    size === 'sm'
      ? 'h-8 px-3 text-xs gap-1.5'
      : size === 'lg'
        ? 'h-12 px-6 text-sm gap-2'
        : 'h-[38px] px-4 text-[13px] gap-2';

  return (
    <button
      type="button"
      className={`pressable focus-ring inline-flex items-center justify-center rounded-lg ${sizing} ${VARIANTS[variant]} disabled:cursor-not-allowed disabled:opacity-60 ${className}`}
      {...rest}
    >
      {icon ? <Icon name={icon} size={size === 'sm' ? 14 : 16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({ icon, label, className = '', size = 16, ...rest }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`pressable focus-ring inline-flex h-8 w-8 items-center justify-center rounded-lg border border-hairline bg-white/[0.04] text-mist hover:text-chalk hover:bg-white/[0.09] disabled:cursor-not-allowed disabled:opacity-40 ${className}`}
      {...rest}
    >
      <Icon name={icon} size={size} />
    </button>
  );
}

const TONES = {
  neutral: 'bg-white/[0.07] text-mist border-hairline',
  ok: 'bg-ok/15 text-ok border-ok/30',
  warn: 'bg-warn/15 text-warn border-warn/30',
  alert: 'bg-danger/15 text-danger border-danger/30',
  accent: 'bg-violet/20 text-violet border-violet/40',
  gold: 'bg-gold/15 text-gold border-gold/35',
  teal: 'bg-teal/15 text-teal border-teal/30',
};

export function Badge({ children, tone = 'neutral', className = '' }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${TONES[tone] || TONES.neutral} ${className}`}
    >
      {children}
    </span>
  );
}

/** Selo Local/API exigido em todo card de modelo. */
export function RuntimeBadge({ model }) {
  if (!model) return null;
  const isLocal = model.runtime === 'local';
  return (
    <Badge tone={isLocal ? 'teal' : 'gold'}>
      <span className={`inline-block h-1.5 w-1.5 rounded-full ${isLocal ? 'bg-teal' : 'bg-gold'}`} />
      {isLocal ? 'Local' : 'API'}
    </Badge>
  );
}

export function StatusBadge({ model }) {
  if (!model) return null;
  const available = model.status === 'available';
  return (
    <Badge tone={available ? 'ok' : 'neutral'}>
      {available ? 'Disponível' : 'Não configurado'}
    </Badge>
  );
}

export function Field({ label, hint, children, className = '' }) {
  return (
    <label className={`flex flex-col gap-1.5 ${className}`}>
      <span className="text-[11px] font-semibold uppercase tracking-wider text-mist">
        {label}
      </span>
      {children}
      {hint ? <span className="text-[11px] leading-snug text-mist/70">{hint}</span> : null}
    </label>
  );
}

export function Select({ className = '', children, ...rest }) {
  return (
    <select
      className={`focus-ring ${CONTROL_HEIGHT} w-full appearance-none rounded-lg border border-hairline bg-panel-2 px-3 text-[13px] text-chalk hover:border-white/20 ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Input({ className = '', ...rest }) {
  return (
    <input
      className={`focus-ring ${CONTROL_HEIGHT} w-full rounded-lg border border-hairline bg-panel-2 px-3 text-[13px] text-chalk placeholder:text-mist/60 disabled:opacity-50 ${className}`}
      {...rest}
    />
  );
}

export function Textarea({ className = '', ...rest }) {
  return (
    <textarea
      className={`focus-ring scroll-thin w-full resize-none rounded-lg border border-hairline bg-panel-2 p-3 text-[13px] leading-relaxed text-chalk placeholder:text-mist/60 ${className}`}
      {...rest}
    />
  );
}

export function Segmented({ options = [], value, onChange, className = '' }) {
  return (
    <div className={`inline-flex rounded-lg border border-hairline bg-panel-2 p-1 ${className}`}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            className={`pressable focus-ring rounded-md px-3 py-1.5 text-[12px] font-medium ${
              active ? 'bg-gold text-ink' : 'text-mist hover:text-chalk'
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export function Toggle({ checked, onChange, label }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`focus-ring relative h-6 w-11 shrink-0 rounded-full border transition-colors ${
        checked ? 'border-gold/50 bg-gold/70' : 'border-hairline bg-panel-2'
      }`}
    >
      <span
        className={`absolute top-[3px] h-4 w-4 rounded-full transition-all ${
          checked ? 'left-[25px] bg-ink' : 'left-[3px] bg-mist'
        }`}
      />
    </button>
  );
}

export function Panel({ children, className = '', as: Tag = 'section' }) {
  return <Tag className={`panel ${className}`}>{children}</Tag>;
}

export function SectionTitle({ title, subtitle, action }) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        <h2 className="text-[15px] font-semibold tracking-tight text-chalk">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[12px] text-mist">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Empty({ title, hint, icon = 'spark', action }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-hairline px-6 py-12 text-center">
      <span className="text-mist/60">
        <Icon name={icon} size={26} />
      </span>
      <p className="text-[13px] font-medium text-chalk">{title}</p>
      {hint ? <p className="max-w-sm text-[12px] leading-relaxed text-mist">{hint}</p> : null}
      {action}
    </div>
  );
}

export function SimulationNote({ children, className = '' }) {
  return (
    <p
      className={`flex items-start gap-2 rounded-lg border border-warn/25 bg-warn/[0.07] px-3 py-2 text-[11.5px] leading-relaxed text-warn/90 ${className}`}
    >
      <span className="mt-[1px] shrink-0">
        <Icon name="spark" size={13} />
      </span>
      <span>{children}</span>
    </p>
  );
}
