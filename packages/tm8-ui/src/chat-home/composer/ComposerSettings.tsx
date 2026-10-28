/**
 * THE ⚙ BUTTON — the composer's one settings control.
 *
 * The trigger always names the selected role (`[sliders] Coordinator`), so the
 * mode is never hidden behind a click, and beside it the teammate the chat runs
 * as whenever that name is not the role's own word (`[sliders] Coordinator ·
 * Worker`). The roles share their names with seeded house teammates, so a chip
 * reading only "Coordinator" over a chat that runs as Worker named the wrong
 * teammate (task 01a181da). The panel is three groups in one row
 * grammar (`MenuRows`):
 *
 *   MODE      the three roles, compact: icon · name · a few words · ✓
 *   ───────   who it runs as, project, permissions, credentials (the host's)
 *   ───────   the mode's own options, as rows and switches
 *
 * Each role is a label over the server mode it sends (`COMPOSER_ROLES`).
 */
import type { ReactNode } from 'react';
import type { ChatMode } from '@tm8/contract';
import { ComposerIcon } from './ComposerIcons';
import { ComposerPopover } from './ComposerPopover';
import { MenuSection, moveRowFocus } from './MenuRows';
import { COMPOSER_ROLES, roleSpec, type ComposerRole } from './composer-model';

export interface ComposerSettingsProps {
  role: ComposerRole;
  /** The server mode underneath the role, carried on the trigger as `data-mode`. */
  mode?: ChatMode;
  onRoleChange: (role: ComposerRole) => void;
  /** The label of the teammate the chat runs as; drawn on the trigger unless it is the role's own word. */
  runsAs?: string | null;
  /** The roles cannot be changed (a host-pinned mode, a chat still starting); the rest of the panel still can. */
  roleLocked?: string | null;
  /** The thread's rows: runs as, project, permissions, credentials. */
  thread?: ReactNode;
  /** The mode's own options, as rows. */
  options?: ReactNode;
  testId?: string;
}

export function ComposerSettings({ role, mode, onRoleChange, runsAs = null, roleLocked = null, thread, options, testId = 'tch-settings' }: ComposerSettingsProps) {
  const selected = roleSpec(role);
  const teammate = runsAs && runsAs !== selected.label ? runsAs : null;
  return (
    <ComposerPopover
      label="Chat settings"
      testId={testId}
      className="tch-settings"
      title={`Mode: ${selected.label} — ${selected.consequence}${runsAs ? `; runs as ${runsAs}` : ''}`}
      menuHeight={460}
      menuWidth={300}
      fitViewport
      trigger={<>
        <ComposerIcon name="sliders" />
        <span className="tch-pop__value" data-testid={`${testId}-role`} data-mode={mode}>{selected.label}</span>
        {teammate ? <span className="tch-pop__value tch-pop__runsas" data-testid={`${testId}-runs-as`}>· {teammate}</span> : null}
      </>}
    >
      {(close) => (
        <div className="tch-settings__panel">
          <MenuSection title="Mode">
            <div role="radiogroup" aria-label="Chat mode">
              {COMPOSER_ROLES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  role="radio"
                  aria-checked={entry.id === role}
                  aria-disabled={roleLocked ? true : undefined}
                  title={roleLocked ?? entry.consequence}
                  className="tch-menu__mode"
                  data-menu-row
                  data-testid={`${testId}-${entry.id}`}
                  onKeyDown={moveRowFocus}
                  onClick={() => { if (!roleLocked) { onRoleChange(entry.id); close(); } }}
                >
                  <ComposerIcon name={entry.id} className="tch-menu__modeicon" />
                  <span className="tch-menu__modename">{entry.label}</span>
                  <span className="tch-menu__modehint">{entry.hint}</span>
                  <span className="tch-menu__mark" aria-hidden>{entry.id === role ? <ComposerIcon name="check" size={14} /> : null}</span>
                </button>
              ))}
            </div>
          </MenuSection>
          {thread ? <MenuSection>{thread}</MenuSection> : null}
          {options ? <MenuSection>{options}</MenuSection> : null}
        </div>
      )}
    </ComposerPopover>
  );
}
