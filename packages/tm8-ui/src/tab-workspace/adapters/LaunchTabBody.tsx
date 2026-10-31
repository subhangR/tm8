/**
 * A LAUNCH TAB'S BODY (task 01a182d2) — the launching page for a pressed
 * launch whose session does not exist yet, in the Work draft tab that holds it.
 *
 * CONTRACT
 *   in   the launch tab; its stored values (`runtime/launchTabs.ts`) are read
 *        live, so a retry rewriting them in place is drawn at once.
 *   out  the page (`panels/bodies/SessionLaunching.tsx`), drawn from this
 *        window's launch record, else from the stored values while the record
 *        is being re-adopted.
 *   who  `adapters/draft.tsx`, for a `work_session` draft whose values are a
 *        launch's.
 *   invariants: draws, never decides — the page's state is the page model's;
 *        a record this window lacks (a reload, another window) is re-adopted
 *        through the page host's `resume`: a stored failure is drawn as it is,
 *        otherwise the SAME input is replayed after the grace.
 *
 * The body never binds the tab: Work renders only the active tab, so a page
 * that bound on mount would leave a background launch unbound. The hand-off
 * binds through the runtime when the node answers, wherever the viewer is.
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { launchPageModel, launchRecord, startingRecord, useLaunchPageHost, useLaunchRecord } from '../../launch-handoff';
import { SessionLaunching } from '../../panels/bodies/SessionLaunching';
import { subscribeDrafts } from '../runtime/draftStore';
import { launchTabValues } from '../runtime/launchTabs';
import type { DraftTabRecord } from '../runtime/types';
import { useWorkspace } from '../view/context';

export function LaunchTabBody({ tab }: { tab: DraftTabRecord }) {
  const { runtime } = useWorkspace();
  /* The values are read LIVE, not once per mount: a retry rewrites them in
     place (a local write, which bumps the revision but not the remote
     version DraftHost keys its body on), and the page must follow. */
  const version = useSyncExternalStore(
    subscribeDrafts,
    () => `${String(runtime.drafts.revisionOf(tab.draftId))}:${String(runtime.drafts.remoteVersionOf(tab.draftId))}`,
  );
  const values = useMemo(() => launchTabValues(runtime.drafts.get(tab.draftId)), [runtime, tab.draftId, version]);
  if (!values) {
    return (
      <div className="tws-launch-tab" data-testid="tws-launch-tab">
        <p className="tws-draft-note" role="status" data-testid="tws-launch-tab-unrestorable">
          This launch could not be restored.{' '}
          <button
            type="button"
            className="pn-btn"
            onClick={() => runtime.dispatch({ command: 'workspace.tabs.close', args: { tabId: tab.id }, source: 'click' })}
          >
            Dismiss
          </button>
        </p>
      </div>
    );
  }
  return <LaunchTabPage values={values} />;
}

function LaunchTabPage({ values }: { values: NonNullable<ReturnType<typeof launchTabValues>> }) {
  const host = useLaunchPageHost();
  const record = useLaunchRecord(values.launchId);
  const stored = useRef(values);
  stored.current = values;

  /* RE-ATTACH, keyed by the LAUNCH and nothing else. Adopting the launch puts
     a record in the store, so an effect that also keyed on "has a record"
     would re-run on its own adoption; and the replay is the hand-off's to own
     (`resume` schedules it and re-checks the tab when it fires), so this has
     no cleanup that could cancel it. */
  useEffect(() => {
    if (!host || launchRecord(values.launchId)) return;
    const { launch, input, startedAt, failure } = stored.current;
    host.resume(launch, input, startedAt, failure);
  }, [host, values.launchId]);

  const model = launchPageModel(
    record ?? {
      ...startingRecord(values.launch, values.input, values.startedAt, null),
      ...(values.failure ? { state: 'failed' as const, failure: values.failure } : {}),
    },
    null,
  );
  return (
    <div className="tws-launch-tab" data-testid="tws-launch-tab" data-launch-id={values.launchId}>
      {model ? <SessionLaunching model={model} /> : null}
    </div>
  );
}
