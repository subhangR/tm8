/**
 * A LAUNCH TAB'S BODY (task 01a182d2) — the launching page for a pressed
 * launch whose session does not exist yet, in the Work draft tab that holds it.
 *
 * CONTRACT
 *   in   the tab's stored launch values (`runtime/launchTabs.ts`).
 *   out  the page (`panels/bodies/SessionLaunching.tsx`), drawn from this
 *        window's launch record, else from the stored values while the record
 *        is being re-adopted.
 *   who  `adapters/draft.tsx`, for a `work_session` draft whose values are a
 *        launch's.
 *   invariants: draws, never decides — the page's state is the page model's;
 *        a record this window lacks (a reload, another window) is re-adopted
 *        through the page host's `resume`, which replays the SAME input.
 *
 * The body never binds the tab: Work renders only the active tab, so a page
 * that bound on mount would leave a background launch unbound. The hand-off
 * binds through the runtime when the node answers, wherever the viewer is.
 */
import { useEffect, useRef } from 'react';
import { launchPageModel, startingRecord, useLaunchPageHost, useLaunchRecord } from '../../launch-handoff';
import { SessionLaunching } from '../../panels/bodies/SessionLaunching';
import type { LaunchTabValues } from '../runtime/launchTabs';

export function LaunchTabBody({ values }: { values: LaunchTabValues }) {
  const host = useLaunchPageHost();
  const record = useLaunchRecord(values.launchId);
  const known = record !== null;
  const stored = useRef(values);
  stored.current = values;

  useEffect(() => {
    if (known || !host) return;
    const { launch, input, startedAt } = stored.current;
    return host.resume(launch, input, startedAt);
  }, [known, host, values.launchId]);

  const model = launchPageModel(record ?? startingRecord(values.launch, values.input, values.startedAt, null), null);
  return (
    <div className="tws-launch-tab" data-testid="tws-launch-tab" data-launch-id={values.launchId}>
      {model ? <SessionLaunching model={model} /> : null}
    </div>
  );
}
