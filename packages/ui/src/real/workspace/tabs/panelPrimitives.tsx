import type { CSSProperties } from 'react';

/**
 * The small visual kit used by Maestro's SessionsSection. Paths and component
 * structure are copied from `components/maestro/redesign/kit.tsx`; keeping the
 * glyphs local avoids pulling the host shell's icon classes into this panel.
 */
const ICONS = {
  plus: 'M8 3.5v9M3.5 8h9',
  chevronR: 'M6 3.5L10.5 8 6 12.5',
  sliders: 'M3 5h7M12.5 5H13M3 11h.5M6 11h7M9 3.5v3M5 9.5v3',
  settings: 'M8 10a2 2 0 100-4 2 2 0 000 4zM8 1.5v1.5M8 13v1.5M3.05 3.05l1.06 1.06M11.9 11.9l1.05 1.05M1.5 8H3M13 8h1.5M3.05 12.95l1.06-1.06M11.9 4.1l1.05-1.05',
  check: 'M3.5 8.5L6.5 11.5 12.5 5',
  clock: 'M8 4.5V8l2.5 1.5M8 14A6 6 0 108 2a6 6 0 000 12z',
  sparkles: 'M8 2.5l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1 1-2.6zM12.5 9l.5 1.3 1.3.5-1.3.5-.5 1.3-.5-1.3-1.3-.5 1.3-.5.5-1.3z',
  terminal: 'M3 4l3 3-3 3M8 11h5',
  layers: 'M8 2l5.5 3L8 8 2.5 5 8 2zM2.5 8L8 11l5.5-3M2.5 11L8 14l5.5-3',
  pen: 'M2.5 13.5l2.5-.6 7-7-1.9-1.9-7 7zM10.6 4.6l1.9 1.9 1.3-1.3a1 1 0 000-1.4l-.5-.5a1 1 0 00-1.4 0z',
  refresh: 'M13 7a5 5 0 10-1.2 4.2M13 3.5V7h-3.5',
  doc: 'M5 2h5l3.5 3.5V13a1 1 0 01-1 1H5a1 1 0 01-1-1V3a1 1 0 011-1zM10 2v4h4M6.5 9h4M6.5 11.5h2.5',
} as const;

export type PanelIconName = keyof typeof ICONS;

const AGENT_SRC: Record<string, string> = {
  claude: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAMAAABF0y+mAAAAG1BMVEXVXjLZdlXaaUXab0z99/T13dbsv7Lfi3Lloo5sGnyfAAAAAXRSTlP+GuMHfQAAAQRJREFUKJGtkdtyxCAMQ4184/+/uJIhaaez06ea3QA+liCOrT/C/gG26+mfoFcUQUd/ghnhKtm+gN+wg3nCdmS8kGa+G6hIMK//4226AyIKTqllWmnDpL/KoIxZi5rlubbb1OjE0KnBilBisnYmly45QuawB4owTGJFdqkG5KzxXYy9O+OJrGZett5VmS/JvcxMwoHH1q4yjxRXOXzxOidvOjS/ofoTm73PoTDAXygZOnSz2JkHHQjs3LaijEfxJTJdFIQz00cCNmDTtvKkxx3ToUXjBhvfQhp6IXIK+dU2IVwrsWM7gxYmNeaqw2R7l/r1s5s97M7Pcya/FfYDXPyGG/6IL52cCINYBRS9AAAAAElFTkSuQmCC',
  codex: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABwAAAAcCAAAAABXZoBIAAABEElEQVR4AbTJIWyDQACG0d+rWsxENQ6Jwi0YFLIWRTKFxecc6pIzJzF4QTKDT23lSby5BPUt6ZJe2i1ze/aJP/x/+ly5/z2PU7ne1rIYm4/tR9YDsNeaFqP3l9wFx6AJgPLylLN6rrpEcBaiQko6dR/YDq4659po55SL8D1ujI0MLGpbl/K84nr8SWbSCBj5lNrvWewQCy1wU0gZsDV+ABi603nHtI9sJ0KW9d/paCxBjwy6wawyQiwdg2VPiZeBY5S10j3XjJRNoxWMqn20DB4tKeeWTUWhDfqJsX9rSRl0gLUQe20McpCSSwWAUxdBgaek0rQ6lQEwFS/JZ1cNebWFrVaElInLlNmv0TNpYgIAMy6KDbFgKo8AAAAASUVORK5CYII=',
  gemini: 'data:image/png;base64,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',
};

export function PanelIcon({ name, size = 16, sw = 1.6, style }: {
  name: PanelIconName;
  size?: number;
  sw?: number;
  style?: CSSProperties;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden="true"
    >
      {ICONS[name].split('M').filter(Boolean).map((segment, index) => (
        <path key={index} d={`M${segment}`} />
      ))}
    </svg>
  );
}

export function AgentTile({ tool, large = false }: { tool: string | null | undefined; large?: boolean }) {
  const normalized = tool === 'claude-code' ? 'claude' : (tool || 'agent').toLowerCase();
  const src = AGENT_SRC[normalized];
  if (src) {
    return <span className={`pn-agent${large ? ' pn-agent--lg' : ''}`}><img src={src} alt={normalized} /></span>;
  }
  const label = normalized === 'claude'
    ? '✳'
    : normalized === 'codex'
      ? '❉'
      : normalized === 'gemini'
        ? '✦'
        : normalized === 'hermes'
          ? '✳'
          : normalized.charAt(0).toUpperCase();
  return (
    <span className={`pn-agent${large ? ' pn-agent--lg' : ''}`} data-agent-kind={normalized} aria-label={tool || 'agent'}>
      <span className="ws-agent-mark" aria-hidden="true">{label}</span>
    </span>
  );
}

export function AgentLogo({ tool }: { tool: string }) {
  const src = AGENT_SRC[tool];
  return src ? <img src={src} alt="" aria-hidden="true" /> : <span className="ws-quick-mark" data-tool={tool} aria-hidden="true">✳</span>;
}

/** Status glyph copied from Maestro's kit Glyph primitive. */
export function StatusGlyph({ kind, size = 16 }: { kind: string; size?: number }) {
  const ring = <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" />;
  let inner;
  switch (kind) {
    case 'running':
    case 'working':
      inner = <>{ring}<circle cx="8" cy="8" r="2.6" fill="currentColor" /></>;
      break;
    case 'spawning':
      inner = <><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.28" /><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" pathLength="100" strokeDasharray="36 100" transform="rotate(-90 8 8)" /></>;
      break;
    case 'exited':
    case 'completed':
      inner = <><circle cx="8" cy="8" r="6.5" fill="currentColor" /><path d="M5 8.2l2.1 2.1L11 6.4" fill="none" stroke="var(--pn-card)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /></>;
      break;
    case 'failed':
      inner = <>{ring}<path d="M5.7 5.7l4.6 4.6M10.3 5.7l-4.6 4.6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>;
      break;
    case 'archived':
    case 'stopped':
      inner = <rect x="3" y="3" width="10" height="10" rx="2.2" fill="currentColor" />;
      break;
    default:
      inner = ring;
  }
  return <svg className={`pn-stat pn-stat--${kind}`} width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">{inner}</svg>;
}
