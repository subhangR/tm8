import type { EntitySummary } from '@tm8/contract';
import type { TileSignalSpec } from '../../domain';

/**
 * THE ONE SIGNAL — the single live fact a quiet row is allowed to draw
 * between its title and its time (design doc 01a1465d §6, approved
 * 2026-10-16).
 *
 * The rule the approval settled is "ONE signal per kind", and the list it
 * settled it with was per kind: task/PR → assignee avatar · session → live
 * dot, waiting ring or outcome · chat → unread count · teammate → busy/idle ·
 * doc/artifact/everything else → nothing. A row used to draw up to fifteen
 * facts and the live one was indistinguishable from the fourteen dead ones.
 *
 * WHICH signal is REGISTRY DATA (`list.tile.signal`), not a switch in here.
 * §15.2: no component knows a kind, so this file knows four SHAPES of signal —
 * an avatar, a liveness mark, a count, a presence dot — and the registry says
 * which shape each kind wears and which field it reads. A kind that declares
 * none draws nothing, which is the answer for most of them.
 *
 * THE AVATAR SHAPE IS DRAWN BY THE TILE, NOT HERE. The avatar already arrives
 * as a `TileSlot` from the kind's own badge sources (`tile-badges.ts`) and
 * carries provenance and a src with it; re-deriving it here would be a second
 * answer to "whose face is this". `signalIsAvatar` below is how the tile asks.
 */

/** Does this kind's signal slot hold the badge row's avatar? */
export function signalIsAvatar(spec: TileSignalSpec | undefined): boolean {
  return spec?.from === 'avatar';
}

/** Read a state member structurally — never by comparing `kind` (§15.2). */
function field(row: EntitySummary, key: string): unknown {
  const state = row.state as unknown as Record<string, unknown> | null | undefined;
  return state && typeof state === 'object' ? state[key] : undefined;
}

/**
 * The session mark: what the node says, never what the record says (R-UI-5).
 *
 *   live      → a filled dot
 *   waiting   → a ring, for an idle process with a form pending on the viewer
 *   finished  → the outcome, ✓ or ✕
 *
 * `verdict` is the seam's; `waiting` and `failed` are facts the tile already
 * computed for its own word, handed in rather than re-derived, so the mark and
 * the word cannot disagree.
 */
export interface SessionSignalFacts {
  verdict: string | undefined;
  waiting: boolean;
  failed: boolean;
}

export function TileSignal({
  row,
  spec,
  session,
}: {
  row: EntitySummary;
  spec: TileSignalSpec | undefined;
  /** Only consulted by the `liveness` shape; absent elsewhere. */
  session?: SessionSignalFacts;
}) {
  if (!spec) return null;

  if (spec.from === 'liveness') {
    const verdict = session?.verdict;
    if (verdict === 'live') {
      return (
        <span className="lp__signal lp__signal--live" data-signal="live" title="Running">
          <i aria-hidden />
          <span className="sr-only">Running</span>
        </span>
      );
    }
    if (session?.waiting) {
      return (
        <span className="lp__signal lp__signal--waiting" data-signal="waiting" title="Waiting on you">
          <i aria-hidden />
          <span className="sr-only">Waiting on you</span>
        </span>
      );
    }
    /* A session with no verdict at all has nothing to report — an unloaded
       liveness snapshot must not read as a finished run. */
    if (verdict === undefined) return null;
    const failed = session?.failed === true;
    return (
      <span
        className={failed ? 'lp__signal lp__signal--failed' : 'lp__signal lp__signal--done'}
        data-signal={failed ? 'failed' : 'done'}
        title={failed ? 'Ended badly' : 'Finished'}
      >
        <span aria-hidden>{failed ? '✕' : '✓'}</span>
        <span className="sr-only">{failed ? 'Ended badly' : 'Finished'}</span>
      </span>
    );
  }

  if (spec.from === 'count') {
    const value = field(row, spec.field);
    const n = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : 0;
    /* Zero draws nothing, as every count on this row does: "no unread" is the
       resting state of the whole list and a zero on all of it says nothing. */
    if (n <= 0) return null;
    return (
      <span className="lp__signal lp__signal--count" data-signal="count" title={`${n} ${spec.label}`}>
        <span aria-hidden>{n > 99 ? '99+' : n}</span>
        <span className="sr-only">{`${n} ${spec.label}`}</span>
      </span>
    );
  }

  if (spec.from === 'presence') {
    /* Busy is a fact present in the state; idle is its ABSENCE, and both are
       drawn — a teammate list where only the busy rows carry a mark reads as a
       list where the others failed to load. */
    const busy = field(row, spec.field) != null;
    return (
      <span
        className={busy ? 'lp__signal lp__signal--busy' : 'lp__signal lp__signal--idle'}
        data-signal={busy ? 'busy' : 'idle'}
        title={busy ? 'Busy' : 'Idle'}
      >
        <i aria-hidden />
        <span className="sr-only">{busy ? 'Busy' : 'Idle'}</span>
      </span>
    );
  }

  return null;
}

/**
 * THE ONLY PRIORITY A QUIET ROW SHOWS — a red `!` before the title.
 *
 * The approved change list removed priority from tiles "unless urgent". The
 * reason it is the exception and `high` is not: `high` is the priority a third
 * of the space's tasks carry, so a tag on all of them is a tag that sorts
 * nothing. Urgent is rare and is the one value a reader must not have to hover
 * to find.
 *
 * Read structurally (§15.2): any kind whose state carries `priority: 'urgent'`
 * gets the mark, and no kind list in this package decides which those are.
 */
export function isUrgent(row: EntitySummary): boolean {
  return field(row, 'priority') === 'urgent';
}

export function UrgentMark({ title }: { title: string }) {
  return (
    <span className="lp__urgent" data-testid="row-urgent" title={`Urgent — ${title}`}>
      <span aria-hidden>!</span>
      <span className="sr-only">Urgent</span>
    </span>
  );
}
