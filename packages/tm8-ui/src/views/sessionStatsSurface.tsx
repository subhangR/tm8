/**
 * The exited session's POST-MORTEM, composed ONCE for every host that mounts an
 * `EntityDetailPanel` — same shape, and same reason, as `debugSurfaceFor`.
 *
 * WHY IT IS A HOST PROP AND NOT A PANEL FETCH. The numbers come from
 * `execution.transcript`, and the panel layer is presentational by
 * construction: it holds no seam and must not acquire one for a single screen.
 * So the surface is composed here and handed down as a node, exactly like the
 * Debug, Git and Graph surfaces before it. `panel-host-wiring.test.ts` scans
 * every mount for this prop, which is the only thing that stops a sixth host
 * from shipping with a blank exited canvas — the failure that has now happened
 * three times on this panel and was silent every time.
 *
 * A HOST WITHOUT A SEAM RETURNS `undefined`, and the canvas keeps exactly the
 * shape it had before this surface existed: verdict, exit facts, Resume,
 * transcript. Degrading to the previous screen is the honest fallback; a
 * stats block full of dashes on a host that never asked would claim the
 * provider reported nothing, when in fact nobody read.
 */
import type { ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { SessionStatsPanel } from '../transcript/SessionStatsPanel';
import { useSessionTranscript } from '../transcript/useSessionTranscript';

export function sessionStatsSurfaceFor(
  seam: Seam | undefined,
  entityId: string | null | undefined,
): ReactNode | undefined {
  if (!seam || !entityId) return undefined;
  return <SessionStatsSurface seam={seam} sessionId={entityId as EntityId} />;
}

/**
 * ONE READ, NEVER POLLED, and it asks for the file accounting.
 *
 * Both of those follow from the same fact: this surface only ever mounts on a
 * session whose canvas is a fallback, i.e. one that is over. A finished
 * transcript cannot grow, so a poll would re-read an unchanging file forever;
 * and because there is exactly one read, it can afford `files: true` — the
 * whole-file Edit/Write scan that a polling caller must never ask for.
 */
function SessionStatsSurface({ seam, sessionId }: { seam: Seam; sessionId: EntityId }) {
  const { state } = useSessionTranscript(seam, sessionId, { intervalMs: null, files: true });
  return <SessionStatsPanel state={state} />;
}
