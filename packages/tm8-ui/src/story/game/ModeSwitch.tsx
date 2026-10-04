/**
 * [Graph | Tree | Game] — the page's view switch. The game is ANOTHER VIEW of the
 * same story, isolated from the normal page: in Story mode nothing of the
 * game is mounted, in Game mode nothing of the page's sections is. The
 * choice is remembered per story (store.ts).
 */
import type { StoryViewMode } from './store';

const MODES: ReadonlyArray<{ mode: StoryViewMode; label: string }> = [
  { mode: 'story', label: 'Graph' },
  { mode: 'tree', label: 'Tree' },
  { mode: 'game', label: 'Game' },
];

export function ModeSwitch({ mode, onChange, idPrefix, panelId }: {
  mode: StoryViewMode;
  onChange: (mode: StoryViewMode) => void;
  idPrefix?: string;
  panelId?: string;
}) {
  return (
    <span className="stg-seg sgm-switch" role="tablist" aria-label="Story view" data-testid="story-mode-switch"
      onKeyDown={event => {
        const index = MODES.findIndex(item => item.mode === mode);
        const next = event.key === 'ArrowRight' ? (index + 1) % MODES.length
          : event.key === 'ArrowLeft' ? (index - 1 + MODES.length) % MODES.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? MODES.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.querySelectorAll<HTMLButtonElement>('[role=tab]')[next]?.focus();
        onChange(MODES[next]!.mode);
      }}>
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          role="tab"
          id={idPrefix ? `${idPrefix}-${m.mode}` : undefined}
          aria-controls={panelId}
          aria-selected={mode === m.mode}
          tabIndex={mode === m.mode ? 0 : -1}
          className={mode === m.mode ? 'stg-seg__b stg-seg__b--on' : 'stg-seg__b'}
          onClick={() => onChange(m.mode)}
        >
          {m.label}
        </button>
      ))}
    </span>
  );
}
