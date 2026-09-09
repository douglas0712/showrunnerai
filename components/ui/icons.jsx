// Ícones desenhados inline — nenhuma biblioteca externa, nenhum arquivo remoto.

const base = {
  width: 18,
  height: 18,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
};

function Svg({ children, size = 18, ...rest }) {
  return (
    <svg {...base} width={size} height={size} aria-hidden="true" {...rest}>
      {children}
    </svg>
  );
}

export const Icons = {
  inicio: (p) => (
    <Svg {...p}>
      <path d="M3 10.5 12 3l9 7.5" />
      <path d="M5 9.5V21h14V9.5" />
      <path d="M9.5 21v-6h5v6" />
    </Svg>
  ),
  criar: (p) => (
    <Svg {...p}>
      <path d="m12 3 2.1 5.4L19.5 10l-5.4 2.1L12 17.5l-2.1-5.4L4.5 10l5.4-1.6z" />
      <path d="M18.5 16.5 19.5 19l2.5 1-2.5 1-1 2.5" />
    </Svg>
  ),
  imagem: (p) => (
    <Svg {...p}>
      <rect x="3" y="4.5" width="18" height="15" rx="2.5" />
      <circle cx="8.75" cy="9.75" r="1.6" />
      <path d="m3.5 17 4.8-4.4 3.5 3.1 3.3-3.1L20.5 17" />
    </Svg>
  ),
  video: (p) => (
    <Svg {...p}>
      <rect x="2.5" y="6" width="13" height="12" rx="2.4" />
      <path d="m15.5 11 6-3.2v8.4l-6-3.2z" />
    </Svg>
  ),
  cinema: (p) => (
    <Svg {...p}>
      <circle cx="7" cy="8" r="3.6" />
      <circle cx="16" cy="8" r="3.6" />
      <path d="M4 20.5 8.6 12M12.5 20.5 17 12M3.5 20.5h17" />
    </Svg>
  ),
  personagens: (p) => (
    <Svg {...p}>
      <circle cx="9.5" cy="8.5" r="3.4" />
      <path d="M3.5 20c0-3.3 2.7-5.6 6-5.6s6 2.3 6 5.6" />
      <path d="M16.5 6.2a3.4 3.4 0 0 1 0 6.1M18 14.7c1.7.8 2.8 2.4 2.8 4.4" />
    </Svg>
  ),
  storyboard: (p) => (
    <Svg {...p}>
      <rect x="2.5" y="5" width="8" height="6.5" rx="1.4" />
      <rect x="13.5" y="5" width="8" height="6.5" rx="1.4" />
      <rect x="2.5" y="14" width="8" height="5" rx="1.4" />
      <rect x="13.5" y="14" width="8" height="5" rx="1.4" />
    </Svg>
  ),
  projetos: (p) => (
    <Svg {...p}>
      <path d="M3 7.5c0-1.1.9-2 2-2h4l2 2.2h6c1.1 0 2 .9 2 2v8.8c0 1.1-.9 2-2 2H5c-1.1 0-2-.9-2-2z" />
      <path d="M3 11h18" />
    </Svg>
  ),
  biblioteca: (p) => (
    <Svg {...p}>
      <path d="M4 4.5h3.4v15H4zM9.6 4.5H13v15H9.6z" />
      <path d="m15.4 5.6 3.2-.8 3 14.2-3.3.7z" />
    </Svg>
  ),
  workflows: (p) => (
    <Svg {...p}>
      <rect x="2.5" y="3.5" width="6.5" height="5" rx="1.4" />
      <rect x="15" y="3.5" width="6.5" height="5" rx="1.4" />
      <rect x="8.75" y="15.5" width="6.5" height="5" rx="1.4" />
      <path d="M5.75 8.5v3.2a1.8 1.8 0 0 0 1.8 1.8h8.9a1.8 1.8 0 0 0 1.8-1.8V8.5M12 13.5v2" />
    </Svg>
  ),
  agente: (p) => (
    <Svg {...p}>
      <rect x="3" y="6.5" width="18" height="12" rx="3" />
      <circle cx="9" cy="12.5" r="1.3" />
      <circle cx="15" cy="12.5" r="1.3" />
      <path d="M12 3.2v3.3M8.5 18.5 7 21.5l4-3" />
    </Svg>
  ),
  configuracoes: (p) => (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06A2 2 0 1 1 4.15 16.9l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.87l-.06-.06A2 2 0 1 1 7.08 4.1l.06.06a1.7 1.7 0 0 0 1.87.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9a1.7 1.7 0 0 0 1.56 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.03z" />
    </Svg>
  ),
  play: (p) => (
    <Svg {...p}>
      <path d="M7 4.5 19 12 7 19.5z" fill="currentColor" stroke="none" />
    </Svg>
  ),
  pause: (p) => (
    <Svg {...p}>
      <rect x="6.5" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
      <rect x="13.5" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" />
    </Svg>
  ),
  check: (p) => (
    <Svg {...p}>
      <path d="m4.5 12.5 5 5 10-11" />
    </Svg>
  ),
  revise: (p) => (
    <Svg {...p}>
      <path d="M3.5 12a8.5 8.5 0 0 1 14.6-5.9L21 9" />
      <path d="M21 4.5V9h-4.5" />
      <path d="M20.5 12a8.5 8.5 0 0 1-14.6 5.9L3 15" />
      <path d="M3 19.5V15h4.5" />
    </Svg>
  ),
  download: (p) => (
    <Svg {...p}>
      <path d="M12 3.5v11" />
      <path d="m7.5 10.5 4.5 4.5 4.5-4.5" />
      <path d="M4.5 19.5h15" />
    </Svg>
  ),
  arrow: (p) => (
    <Svg {...p}>
      <path d="M4.5 12h14" />
      <path d="m13 6.5 5.5 5.5L13 17.5" />
    </Svg>
  ),
  plus: (p) => (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  ),
  trash: (p) => (
    <Svg {...p}>
      <path d="M4.5 6.5h15M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7" />
      <path d="M6.5 6.5 7.4 20a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-13.5" />
    </Svg>
  ),
  up: (p) => (
    <Svg {...p}>
      <path d="m6 14 6-6 6 6" />
    </Svg>
  ),
  down: (p) => (
    <Svg {...p}>
      <path d="m6 10 6 6 6-6" />
    </Svg>
  ),
  // Uma folha com o canto dobrado. É o material de referência que entra no
  // projeto — PDF ou texto —, e não a mídia que a produção gera.
  documento: (p) => (
    <Svg {...p}>
      <path d="M13.5 3.5H7.2A1.7 1.7 0 0 0 5.5 5.2v13.6a1.7 1.7 0 0 0 1.7 1.7h9.6a1.7 1.7 0 0 0 1.7-1.7V8.5z" />
      <path d="M13.5 3.5v5h5" />
      <path d="M8.8 13h6.4M8.8 16.4h4.4" />
    </Svg>
  ),
  upload: (p) => (
    <Svg {...p}>
      <path d="M12 20V8.5" />
      <path d="m7.5 12.5 4.5-4.5 4.5 4.5" />
      <path d="M4.5 4.5h15" />
    </Svg>
  ),
  compare: (p) => (
    <Svg {...p}>
      <rect x="3" y="5" width="7.5" height="14" rx="1.6" />
      <rect x="13.5" y="5" width="7.5" height="14" rx="1.6" />
      <path d="M12 3v18" strokeDasharray="2 2.5" />
    </Svg>
  ),
  timeline: (p) => (
    <Svg {...p}>
      <path d="M3 7.5h18M3 16.5h18" />
      <rect x="4.5" y="4.8" width="6" height="5.4" rx="1.2" fill="currentColor" stroke="none" opacity="0.35" />
      <rect x="12.5" y="4.8" width="7" height="5.4" rx="1.2" fill="currentColor" stroke="none" opacity="0.2" />
      <rect x="4.5" y="13.8" width="9" height="5.4" rx="1.2" fill="currentColor" stroke="none" opacity="0.2" />
    </Svg>
  ),
  close: (p) => (
    <Svg {...p}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  ),
  dice: (p) => (
    <Svg {...p}>
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <circle cx="9" cy="9" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="15" cy="15" r="1.2" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
    </Svg>
  ),
  spark: (p) => (
    <Svg {...p}>
      <path d="m12 4 1.7 4.6L18.5 10l-4.8 1.4L12 16l-1.7-4.6L5.5 10l4.8-1.4z" />
    </Svg>
  ),
  send: (p) => (
    <Svg {...p}>
      <path d="M4 12 20.5 4.5 13.5 20.5 11.5 13z" />
      <path d="m11.5 13 9-8.5" />
    </Svg>
  ),
  export: (p) => (
    <Svg {...p}>
      <path d="M12 3.5v11" />
      <path d="m8 7.5 4-4 4 4" />
      <path d="M5 14.5v4a1.5 1.5 0 0 0 1.5 1.5h11a1.5 1.5 0 0 0 1.5-1.5v-4" />
    </Svg>
  ),
  logs: (p) => (
    <Svg {...p}>
      <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5H5a1.5 1.5 0 0 1-1.5-1.5V6A1.5 1.5 0 0 1 5 4.5z" />
      <path d="M7.5 9h6M7.5 12h9M7.5 15h4" />
    </Svg>
  ),
};

export function Icon({ name, ...rest }) {
  const Cmp = Icons[name];
  return Cmp ? <Cmp {...rest} /> : null;
}
