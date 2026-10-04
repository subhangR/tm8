/**
 * [Story | Game] — the page's view switch. The game is ANOTHER VIEW of the
 * same story, isolated from the normal page: in Story mode nothing of the
 * game is mounted, in Game mode nothing of the page's sections is. The
 * choice is remembered per story (store.ts).
 */
import type { StoryViewMode } from './store';

const MODES: ReadonlyArray<{ mode: StoryViewMode; label: string }> = [
  { mode: 'story', label: 'Story' },
  { mode: 'game', label: 'Game' },
];

export function ModeSwitch({ mode, onChange }: { mode: StoryViewMode; onChange: (mode: StoryViewMode) => void }) {
  return (
    <span className="stg-seg sgm-switch" role="tablist" aria-label="Story view" data-testid="story-mode-switch">
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          role="tab"
          aria-selected={mode === m.mode}
          className={mode === m.mode ? 'stg-seg__b stg-seg__b--on' : 'stg-seg__b'}
          onClick={() => onChange(m.mode)}
        >
          {m.label}
        </button>
      ))}
    </span>
  );
}
