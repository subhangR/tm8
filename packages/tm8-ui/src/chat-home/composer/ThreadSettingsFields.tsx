/**
 * THE THREAD'S OWN FACTS, inside the ⚙ panel: who answers (teammate), where
 * changes land (project) and how far it may go without asking (permissions).
 *
 * These used to be a teammate chip on the composer row and a `Scratch · Ask
 * first` rail under it; they are folded here so the row carries only
 * [+][⚙ role][👥 N] … [model·effort][send]. Teammate and project are
 * write-once on the server, so a started chat shows them locked with the
 * reason; permissions stays live for the life of the thread.
 */
import type { ChatProjectOption } from '../types';
import {
  PERMISSION_RUNGS,
  SCRATCH_PROJECT_ID,
  type PermissionRung,
} from './composer-model';

export interface ThreadSettingsFieldsProps {
  teammates: readonly { id: string; label: string }[];
  teammateId: string;
  onTeammateChange: (id: string) => void;
  /** `null` ⇒ the port lists no projects; the thread uses a scratch directory. */
  projects: readonly ChatProjectOption[] | null;
  projectChoice: string;
  onProjectChange: (choice: string) => void;
  permission: PermissionRung;
  onPermissionChange: (rung: PermissionRung) => void;
  /** Where the permission default came from — "Builder defaults to Ask first". */
  permissionSource?: string | null;
  /** A started chat: teammate and project are facts now. */
  locked: boolean;
  lockedProjectLabel?: string | null;
}

const LOCKED_WHY = 'fixed when this chat started';

export function ThreadSettingsFields({
  teammates,
  teammateId,
  onTeammateChange,
  projects,
  projectChoice,
  onProjectChange,
  permission,
  onPermissionChange,
  permissionSource,
  locked,
  lockedProjectLabel,
}: ThreadSettingsFieldsProps) {
  const projectValue = projectChoice || SCRATCH_PROJECT_ID;
  return (
    <>
      <label className="tch-optform__row">
        <span className="tch-optform__label">Teammate</span>
        <select
          aria-label="Chat teammate"
          data-testid="tch-settings-teammate"
          value={teammateId}
          disabled={locked}
          title={locked ? LOCKED_WHY : undefined}
          onChange={(event) => onTeammateChange(event.target.value)}
        >
          {teammates.length === 0 ? <option value="">No teammate</option> : null}
          {teammates.map((teammate) => <option key={teammate.id} value={teammate.id}>{teammate.label}</option>)}
        </select>
      </label>
      <label className="tch-optform__row">
        <span className="tch-optform__label">Project</span>
        {locked ? (
          <span data-testid="tch-settings-project-locked" title={LOCKED_WHY}>
            <span aria-hidden>🔒</span> {lockedProjectLabel ?? 'Scratch'}
          </span>
        ) : (
          <select
            aria-label="Project"
            data-testid="tch-settings-project"
            value={projectValue}
            title="where changes land"
            onChange={(event) => onProjectChange(event.target.value)}
          >
            <option value={SCRATCH_PROJECT_ID}>Scratch</option>
            {(projects ?? []).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        )}
      </label>
      <label className="tch-optform__row">
        <span className="tch-optform__label">Permissions</span>
        <select
          aria-label="Permissions"
          data-testid="tch-settings-permission"
          value={permission}
          title={permissionSource ?? 'how far without asking'}
          onChange={(event) => onPermissionChange(event.target.value as PermissionRung)}
        >
          {PERMISSION_RUNGS.map((rung) => <option key={rung.id} value={rung.id} title={rung.allows}>{rung.label}</option>)}
        </select>
      </label>
    </>
  );
}
