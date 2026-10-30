/**
 * THE firing key (design of record 01a182d4 §3.3/§3.4).
 *
 * One derivation for every mutation id a firing mints: the spawn path's
 * `loop-fire:<key>` and the tool path's `tool-fire:<key>` (379) must name the
 * same firing, so both read this helper and nothing else derives a key.
 * A claimed run passes its run id and the key IS that id; a caller without a
 * run (the pre-claim job) gets the loop id and the firing instant, which keeps
 * two firings of one loop two distinct commands and a transport retry a replay.
 */
export function firingKeyFor(loop: { readonly entityId: string }, firedAt: Date, runId?: string | null): string {
  return runId ?? `${loop.entityId}:${firedAt.toISOString()}`;
}
