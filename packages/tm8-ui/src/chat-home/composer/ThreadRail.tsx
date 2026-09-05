/**
 * UNDER THE COMPOSER = THIS THREAD.
 *
 * Two controls, quieter than the row above them: PROJECT (where changes
 * land) and PERMISSIONS (how far without asking). The rail is not a second
 * chip row — no borders, smaller, sitting on the page — because the whole
 * organising rule of the composer is drawn by this one difference in weight.
 *
 * PROJECT IS WRITE-ONCE ON THE SERVER (167), which is why it is offered only
 * in the empty state and renders LOCKED after the first send. Sending is
 * never blocked on it: unset means `scratch`, and the rail says so.
 *
 * PERMISSIONS NEVER COLLAPSES INTO A LOCK. It stays live for the life of the
 * thread; de-escalation is one click, escalation is the same click (the
 * friction is that the row's conflict strip names the consequence first).
 *
 * THE CONFLICT STRIP sits in the gap between the composer and the rail —
 * physically between the two controls that disagree — and carries the
 * one-click raise. It is never a toast and never a post-send failure.
 */
import type { EntityId } from '@tm8/contract';
import { ComposerSelect, type ComposerSelectOption } from '../ComposerSelect';
import type { ChatProjectOption } from '../types';
import {
  PERMISSION_RUNGS,
  SCRATCH_PROJECT_ID,
  permissionSpec,
  type ModeConflict,
  type PermissionRung,
} from './composer-model';

export interface ThreadRailProps {
  /** `null` ⇒ the port lists no projects; the control says why. */
  projects: readonly ChatProjectOption[] | null;
  projectChoice: string;
  onProjectChange: (choice: string) => void;
  /** After the first send the binding is a fact, drawn with a lock. */
  projectLocked: boolean;
  lockedProjectLabel?: string | null;
  permission: PermissionRung;
  onPermissionChange: (rung: PermissionRung) => void;
  /** Where the default came from — "Builder defaults to Ask first". */
  permissionSource?: string | null;
  conflict: ModeConflict | null;
  /** The teammate's own ceiling as the node reports it; rungs above render disabled. */
  adminCap?: PermissionRung | null;
  testId?: string;
}

export function ThreadRail({
  projects,
  projectChoice,
  onProjectChange,
  projectLocked,
  lockedProjectLabel,
  permission,
  onPermissionChange,
  permissionSource,
  conflict,
  adminCap,
  testId = 'tch-rail',
}: ThreadRailProps) {
  const projectOptions: ComposerSelectOption[] = [
    { id: SCRATCH_PROJECT_ID, label: 'Scratch', hint: 'a private empty directory for this thread' },
    ...(projects ?? []).map((project) => ({ id: project.id as string, label: project.name, hint: 'changes land in this repo' })),
  ];
  const capRank = adminCap ? permissionSpec(adminCap).rank : Number.POSITIVE_INFINITY;
  const permissionOptions: ComposerSelectOption[] = PERMISSION_RUNGS.map((rung) => ({
    id: rung.id,
    label: rung.label,
    hint: rung.allows,
    ...(rung.rank > capRank
      ? { disabledReason: `above this teammate's ${permissionSpec(adminCap!).label} ceiling` }
      : {}),
  }));
  const projectValue = projectChoice || SCRATCH_PROJECT_ID;
  const projectLabel = projectLocked
    ? lockedProjectLabel ?? (projectValue === SCRATCH_PROJECT_ID ? 'Scratch' : projectOptions.find((o) => o.id === projectValue)?.label ?? 'Project')
    : null;

  return (
    <div className="tch-rail" data-testid={testId} data-locked={projectLocked || undefined}>
      {conflict ? (
        <div className="tch-conflict" role="alert" data-testid={`${testId}-conflict`}>
          <span className="tch-conflict__text">{conflict.message}</span>
          <button
            type="button"
            className="tch-conflict__raise"
            data-testid={`${testId}-raise`}
            onClick={() => onPermissionChange(conflict.required)}
          >
            {conflict.raiseLabel}
          </button>
        </div>
      ) : null}
      <div className="tch-rail__row">
        <span className="tch-rail__cell">
          {projectLocked ? (
            <span className="tch-rail__locked" data-testid={`${testId}-project-locked`} title="the project is bound when a thread starts and cannot change">
              <span aria-hidden>🔒</span> {projectLabel}
            </span>
          ) : (
            <ComposerSelect
              label="Project"
              testId={`${testId}-project`}
              variant="quiet"
              glyph="▣"
              options={projectOptions}
              value={projectValue}
              onChange={onProjectChange}
              disabled={projects === null && projectOptions.length <= 1}
              emptyNote="No project is linked to this space."
              note={projects === null ? 'This surface cannot list projects — the thread will use a scratch directory.' : null}
            />
          )}
          <span className="tch-rail__caption">where changes land</span>
        </span>
        <span className="tch-rail__cell">
          <ComposerSelect
            label="Permissions"
            testId={`${testId}-permission`}
            variant="quiet"
            glyph="●"
            options={permissionOptions}
            value={permission}
            onChange={(id) => onPermissionChange(id as PermissionRung)}
            emptyNote="No permission rung is available."
            note={permissionSource ?? null}
          />
          <span className="tch-rail__caption">how far without asking</span>
        </span>
      </div>
    </div>
  );
}
