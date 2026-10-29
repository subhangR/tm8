/**
 * THE LAUNCHING PAGE'S HOST IN WORK (task 01a182d2) — gives every launching
 * page under Work (a launch tab, a booting session's view) its two verbs and
 * its re-attach.
 *
 * CONTRACT
 *   in   Work's gate data and runtime.
 *   out  `LaunchPageHostContext` for the subtree, and the retry popup while
 *        one is open. The hand-off is built directly (`useLaunchHandoff`), and
 *        the full launch port only inside the retry popup while it is open —
 *        a port for all of Work, rebuilt per render, would churn the host.
 *   who  `TabWorkspaceView`, around its content.
 *   invariants
 *     - Edit and retry re-opens the FULL launch popup on the launch's subject —
 *       every control a launch has, nothing trimmed — with the launch's notes
 *       written to the subject's draft, so nothing typed is lost;
 *     - the retry's launch TAKES OVER the failed launch's tab (`replaces`), so
 *       a launch the node never admitted leaves no failed page behind beside
 *       its retry. A session that failed while BOOTING keeps its own tab: it
 *       is a real session, with its own record of what went wrong;
 *     - Dismiss, choose and resume are the hand-off's own (`views/useLaunchHandoff`).
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import type { EntityId, ExecutionSpawnInput } from '@tm8/contract';
import { launchRecord, LaunchPageHostContext, type LaunchPageHost, type LaunchRecord } from '../../launch-handoff';
import { LaunchComposerPopup } from '../../new-session';
import { readDraft, writeDraft } from '../../new-session/launch-draft';
import { useLaunchHandoff } from '../../views/useLaunchHandoff';
import { useLaunchPort, useSessionsSince } from '../../views/useLaunchPort';
import { useWorkspace } from './context';

export function LaunchPageHostProvider({ children }: { children: ReactNode }) {
  const { gate, viewerId, spaceId } = useWorkspace();
  const sessionsSince = useSessionsSince(gate.data.seam);
  const handoff = useLaunchHandoff({ viewerId, spaceId, spawnSession: gate.data.spawn, sessionsSince });
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
      choose: (launchId, sessionId) => handoff.choose(launchId, sessionId),
      resume: (launch, input, startedAt, failure) =>
        handoff.resume({ launchId: launch.clientMutationId, launch, input, startedAt, failure }),
    }),
    [handoff],
  );

  return (
    <LaunchPageHostContext.Provider value={host}>
      {children}
      {retrying ? <RetryPopup record={retrying} onDismiss={() => setRetrying(null)} /> : null}
    </LaunchPageHostContext.Provider>
  );
}

/** The full launch popup on the failed launch's subject; its port lives only while it is open. */
function RetryPopup({ record, onDismiss }: { record: LaunchRecord; onDismiss: () => void }) {
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
  const { subjectId, title, verb } = record.launch;
  const detail = gate.data.detailOf(subjectId);
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
