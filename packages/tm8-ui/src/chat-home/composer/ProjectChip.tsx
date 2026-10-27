/**
 * THE COMPOSER'S PROJECT CHIP — where this chat runs, on the row itself.
 *
 * The project used to be reachable only inside the ⚙ panel (Runs as · Project
 * · Permissions), so a new chat LOOKED projectless and nobody found the picker
 * (Bhargav, 19 Oct: "projects don't have a working folder"; Subhang, 20 Oct:
 * "chat already should have the project switcher in the composer in the start
 * state"). The chip shows the choice before the first message and opens the
 * same list the ⚙ row does; the ⚙ row stays, so both read one value.
 *
 * Write-once on the server: a started chat shows the chip still, with the
 * project it was started in and the reason it can no longer change.
 */
import { VectorIcon } from '../../kit';
import type { ChatProjectOption } from '../types';
import { ComposerIcon } from './ComposerIcons';
import { ComposerPopover } from './ComposerPopover';
import { SCRATCH_PROJECT_ID } from './composer-model';

/** A folder, on the composer icons' 16×16 grid. */
const FOLDER_ART = ['M2 4.25h4l1.5 1.5H14v7H2z'];

export interface ProjectChipProps {
  /** `null` ⇒ the port lists no projects; the chat uses a scratch directory. */
  projects: readonly ChatProjectOption[] | null;
  /** `''` or `SCRATCH_PROJECT_ID` ⇒ scratch. */
  projectChoice: string;
  onProjectChange: (choice: string) => void;
  /** A started chat: the project is a fact now. */
  locked: boolean;
  lockedProjectLabel?: string | null;
  testId?: string;
}

const LOCKED_WHY = 'fixed when this chat started';

export function ProjectChip({
  projects,
  projectChoice,
  onProjectChange,
  locked,
  lockedProjectLabel,
  testId = 'tch-project',
}: ProjectChipProps) {
  const value = projectChoice || SCRATCH_PROJECT_ID;
  const current = projects?.find((project) => project.id === value);
  const label = locked ? lockedProjectLabel ?? 'Scratch' : current?.name ?? 'Scratch';
  const why = locked
    ? `Project: ${label} — ${LOCKED_WHY}`
    : projects === null
      ? 'this surface cannot list projects — the chat uses a scratch directory'
      : null;
  const choices = [
    { id: SCRATCH_PROJECT_ID, name: 'Scratch', hint: 'a private empty directory' },
    ...(projects ?? []).map((project) => ({ id: project.id as string, name: project.name, hint: 'runs in this project’s folder' })),
  ];
  return (
    <ComposerPopover
      label="Chat project"
      testId={testId}
      className="tch-project"
      title={why ?? `Project: ${label} — the chat runs in its folder`}
      disabled={why !== null}
      disabledReason={why ?? undefined}
      menuHeight={320}
      menuWidth={260}
      fitViewport
      trigger={<>
        <VectorIcon paths={FOLDER_ART} size={14} strokeWidth={1.5} className="tch-icon" />
        <span className="tch-pop__value" data-testid={`${testId}-value`}>{label}</span>
        <ComposerIcon name="chevronDown" size={12} className="tch-pick__caret" />
      </>}
    >
      {(close) => (
        <div role="menu" aria-label="Chat project" className="tch-project__menu">
          <p className="tch-menu__heading">Run this chat in</p>
          {choices.map((choice) => {
            const selected = choice.id === value;
            return (
              <button
                key={choice.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className="tch-submenu__opt"
                data-testid={`${testId}-${choice.id}`}
                onClick={() => { onProjectChange(choice.id); close(); }}
              >
                <span className="tch-submenu__text">
                  <span className="tch-submenu__name">{choice.name}</span>
                  <span className="tch-submenu__hint">{choice.hint}</span>
                </span>
                <span className="tch-submenu__mark" aria-hidden>{selected ? <ComposerIcon name="check" size={14} /> : null}</span>
              </button>
            );
          })}
        </div>
      )}
    </ComposerPopover>
  );
}
