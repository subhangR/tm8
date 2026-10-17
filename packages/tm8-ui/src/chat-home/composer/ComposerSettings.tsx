/**
 * THE ⚙ BUTTON — the composer's one settings control.
 *
 * The trigger always names the selected role (`⚙ Coordinator`), so the mode
 * is never hidden behind a click. The popover offers exactly three roles
 * (`COMPOSER_ROLES`, each a label over the server mode it sends) and, under
 * them, what used to be separate chips on the row: the credential choice and
 * the mode's own options. Host-specific extras ride `children`.
 */
import type { ReactNode } from 'react';
import type { ChatMode } from '@tm8/contract';
import { ComposerPopover } from './ComposerPopover';
import { COMPOSER_ROLES, roleSpec, type ComposerRole } from './composer-model';

export interface ComposerSettingsProps {
  role: ComposerRole;
  /** The server mode underneath the role, carried on the trigger as `data-mode`. */
  mode?: ChatMode;
  onRoleChange: (role: ComposerRole) => void;
  /** The roles cannot be changed (a host-pinned mode, a chat still starting); the rest of the panel still can. */
  roleLocked?: string | null;
  children?: ReactNode;
  testId?: string;
}

export function ComposerSettings({ role, mode, onRoleChange, roleLocked = null, children, testId = 'tch-settings' }: ComposerSettingsProps) {
  const selected = roleSpec(role);
  return (
    <ComposerPopover
      label="Chat settings"
      testId={testId}
      className="tch-settings"
      title={`Mode: ${selected.label} — ${selected.consequence}`}
      menuHeight={420}
      menuWidth={300}
      trigger={<>
        <span className="tch-pop__gear" aria-hidden>⚙︎</span>
        <span className="tch-pop__value" data-testid={`${testId}-role`} data-mode={mode}>{selected.label}</span>
      </>}
    >
      {(close) => (
        <div className="tch-settings__panel">
          <div className="tch-settings__roles" role="radiogroup" aria-label="Chat mode">
            {COMPOSER_ROLES.map((entry) => (
              <button
                key={entry.id}
                type="button"
                role="radio"
                aria-checked={entry.id === role}
                aria-disabled={roleLocked ? true : undefined}
                title={roleLocked ?? undefined}
                className="tch-pickmenu__opt"
                data-testid={`${testId}-${entry.id}`}
                onClick={() => { if (!roleLocked) { onRoleChange(entry.id); close(); } }}
              >
                <span className="tch-pickmenu__text">
                  <span className="tch-pickmenu__name">{entry.label}</span>
                  <span className="tch-pickmenu__hint">{entry.consequence}</span>
                </span>
                <span className="tch-pickmenu__mark" aria-hidden>{entry.id === role ? '✓' : ''}</span>
              </button>
            ))}
          </div>
          {children ? <div className="tch-settings__more">{children}</div> : null}
        </div>
      )}
    </ComposerPopover>
  );
}
