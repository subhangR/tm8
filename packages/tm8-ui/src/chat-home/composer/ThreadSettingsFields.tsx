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
import { Initial, PickRow, StaticRow } from './MenuRows';
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

  locked,
  lockedProjectLabel,
}: ThreadSettingsFieldsProps) {
  const projectValue = projectChoice || SCRATCH_PROJECT_ID;
  const teammate = teammates.find((entry) => entry.id === teammateId);
  return (
    <>
      {locked ? (
        <StaticRow
          label="Runs as"
          value={<>{teammate ? <Initial name={teammate.label} /> : null}{teammate?.label ?? '—'}</>}
          title={LOCKED_WHY}
          testId="tch-settings-teammate"
        />
      ) : (
        <PickRow
          label="Runs as"
          ariaLabel="Chat teammate"
          choices={teammates.map((entry) => ({ id: entry.id, label: entry.label, leading: <Initial name={entry.label} /> }))}
          value={teammateId}
          onPick={onTeammateChange}
          testId="tch-settings-teammate"
        />
      )}
      {locked || projects === null ? (
        <StaticRow
          label="Project"
          value={locked ? lockedProjectLabel ?? 'Scratch' : 'Scratch'}
          locked
          title={locked ? LOCKED_WHY : 'this surface cannot list projects — the chat uses a scratch directory'}
          testId="tch-settings-project-locked"
        />
      ) : (
        <PickRow
          label="Project"
          choices={[
            { id: SCRATCH_PROJECT_ID, label: 'Scratch', hint: 'a private empty directory' },
            ...projects.map((project) => ({ id: project.id as string, label: project.name, hint: 'changes land in this repo' })),
          ]}
          value={projectValue}
          onPick={onProjectChange}
          testId="tch-settings-project"
        />
      )}
      <PickRow
        label="Permissions"
        choices={PERMISSION_RUNGS.map((rung) => ({ id: rung.id, label: rung.label, hint: rung.allows }))}
        value={permission}
        onPick={(id) => onPermissionChange(id as PermissionRung)}
        testId="tch-settings-permission"
      />
    </>
  );
}
