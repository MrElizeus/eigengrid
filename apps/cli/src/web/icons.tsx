export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, React.ReactNode> = {
    moon: <path d="M20 14A8 8 0 0 1 10 4a8 8 0 1 0 10 10Z" />,
    sun: (
      <>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
      </>
    ),
    monitor: (
      <>
        <rect x="3" y="4" width="18" height="13" rx="2" />
        <path d="M8 21h8m-4-4v4" />
      </>
    ),
    edit: (
      <>
        <path d="m15 4 5 5M4 20l5-1L21 7a2 2 0 0 0-4-4L5 15Z" />
      </>
    ),
    retry: (
      <>
        <path d="M3 10a9 9 0 1 1 2 8M3 4v6h6" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5" />
      </>
    ),
    steer: (
      <>
        <path d="M5 20v-6a5 5 0 0 1 5-5h9m-5-5 5 5-5 5" />
      </>
    ),
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M12 19V5m-6 6 6-6 6 6" />,
    chat: <path d="M20 11.5a8 8 0 0 1-8 8H5l-3 2 1.7-5A8 8 0 1 1 20 11.5Z" />,
    settings: (
      <>
        <path d="M4 7h16M4 17h16" />
        <circle cx="9" cy="7" r="3" />
        <circle cx="15" cy="17" r="3" />
      </>
    ),
    close: <path d="m6 6 12 12M6 18 18 6" />,
    trash: (
      <>
        <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 10v7m4-7v7" />
      </>
    ),
    chevron: <path d="m9 5 7 7-7 7" />,
    book: (
      <>
        <path d="M12 5v15M3 4c5-1 9 1 9 1s4-2 9-1v14c-5-1-9 2-9 2s-4-3-9-2Z" />
      </>
    ),
    activity: <path d="M2 12h4l3-8 6 16 3-8h4" />,
    terminal: (
      <>
        <path d="m5 6 6 6-6 6m9 0h6" />
      </>
    ),
    copy: (
      <>
        <rect x="8" y="8" width="12" height="12" rx="2" />
        <path d="M16 8V4H4v12h4" />
      </>
    ),
    panel: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M9 4v16" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    stop: <rect x="6" y="6" width="12" height="12" rx="2" />,
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? paths.chat}
    </svg>
  );
}
export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`mark ${small ? "small" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}
