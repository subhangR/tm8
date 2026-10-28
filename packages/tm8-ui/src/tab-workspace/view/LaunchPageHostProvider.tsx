/**
 * THE LAUNCHING PAGE'S HOST IN WORK (task 01a182d2) — gives every launching
 * page under Work (a launch tab, a booting session's view) its two verbs and
 * its re-attach.
 *
 * CONTRACT
 *   in   Work's gate data — the same launch port every Work surface builds.
 *   out  `LaunchPageHostContext` for the subtree, and the retry popup while
 *        one is open.
 *   who  `TabWorkspaceView`, around its content.
 *   invariants
 *     - Edit and retry re-opens the FULL launch popup on the launch's subject —
 *       every control a launch has, nothing trimmed — with the launch's notes
 *       written to the subject's draft, so nothing typed is lost;
 *     - the retry's launch TAKES OVER the failed launch's tab (`replaces`), so
 *       a launch the node never admitted leaves no failed page behind beside
 *       its retry. A session that failed while BOOTING keeps its own tab: it
 *       is a real session, with its own record of what went wrong;
 *     - Dismiss and resume are the hand-off's own (`views/useLaunchHandoff`).
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { launchRecord, LaunchPageHostContext, type LaunchPageHost, type LaunchRecord } from '../../launch-handoff';
import { LaunchComposerPopup } from '../../new-session';
import { readDraft, writeDraft } from '../../new-session/launch-draft';
import { useLaunchPort, type LaunchPort } from '../../views/useLaunchPort';
import { useWorkspace } from './context';

export function LaunchPageHostProvider({ children }: { children: ReactNode }) {
  const { gate, runtime } = useWorkspace();
  /* Work's own landing for a retry the popup does not hand over: the session
     opens as its tab, as every Work surface opens one. */
  const onSpawn = useCallback(
    async (input: ExecutionSpawnInput) => {
      const sessionId = await gate.data.spawn(input);
      runtime.dispatch({ command: 'workspace.tabs.open', args: { kind: 'work_session', entityId: sessionId }, source: 'system' });
    },
    [gate.data, runtime],
  );
  const port = useLaunchPort(gate.data, { onSpawn });
  const { handoff } = port;
  const [retrying, setRetrying] = useState<LaunchRecord | null>(null);

  const host = useMemo<LaunchPageHost>(
    () => ({
      editAndRetry: (launchId) => {
        const record = launchRecord(launchId);
        if (!record) return;
        const { subjectId, notes } = record.launch;
        writeDraft(subjectId, { ...(readDraft(subjectId) ?? {}), notes });
        setRetrying(record);
      },
      dismiss: (launchId) => handoff.dismiss(launchId),
      resume: (launch, input, startedAt) =>
        handoff.resume({ launchId: launch.clientMutationId, launch, input, startedAt }),
    }),
    [handoff],
  );

  return (
    <LaunchPageHostContext.Provider value={host}>
      {children}
      {retrying ? (
        <RetryPopup record={retrying} port={port} detailOf={gate.data.detailOf} onDismiss={() => setRetrying(null)} />
      ) : null}
    </LaunchPageHostContext.Provider>
  );
}

function RetryPopup({
  record,
  port,
  detailOf,
  onDismiss,
}: {
  record: LaunchRecord;
  port: LaunchPort;
  detailOf: (id: string) => { id: string; title: string; kind: string } | undefined;
  onDismiss: () => void;
}) {
  const { subjectId, title, verb } = record.launch;
  const detail = detailOf(subjectId);
  const subject = detail ? { id: detail.id, title: detail.title, kind: detail.kind } : { id: subjectId, title };
  return (
    <LaunchComposerPopup
      subject={subject}
      mode={verb}
      spaceId={port.spaceId}
      teammates={port.teammates}
      projects={port.projects}
      capacity={port.capacity}
      jev={port.jev}
      loadInstalledPlugins={port.loadInstalledPlugins}
      selection={port.selection}
      profileFor={port.profileFor}
      upload={port.upload}
      onDispatch={port.dispatch ? (note, key) => port.dispatch!(subjectId as EntityId, note, key) : undefined}
      jevKeyStatus={port.jevKeyStatus}
      sessionsSince={port.sessionsSince}
      onSpawn={port.onSpawn}
      onLaunchStarted={(launch) => port.handoff.onLaunchStarted(launch, record.id)}
      loadDescription={port.descriptionOf ? () => port.descriptionOf!(subjectId) : undefined}
      canEditSubject={Boolean(port.onUpdateEntity)}
      onDismiss={onDismiss}
      newClientMutationId={() => port.mutationId(subjectId)}
    />
  );
}
