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
 * THE SESSION MARK, FROM THE WORD'S OWN DERIVATION.
 *
 * §6 allows a session one signal: a live dot, a waiting ring, or the outcome.
 * Spec D1 §5.1 ALREADY decided which of those every session case is — that is
 * what `SessionWord.icon` is — so this takes the icon and the tone rather than
 * re-deriving them from the seam verdict. Two derivations of "is this running"
 * is how a mark and a word end up disagreeing on the same row, and
 * `session-outcome.ts` has 34 assertions holding the one that exists.
 *
 * The WORD rides along and is drawn for a screen reader and in `title`, never
 * as a pill: §6's rule for the status mark, applied to the anatomy whose
 * status mark this is.
 */
export interface SessionSignalFacts {
  /** `SessionWord.icon` — spinner · ring-dot · check · square · ring-x · ring. */
  icon: string;
  /** `SessionWord.tone` — wait · run · done · idle · block. */
  tone: string;
  /**
   * `SessionWord.word` — the SHORT readout ("Working", "Crashed"), which is
   * what §6 means by "the word stays for screen readers".
   */
  label: string;
  /** `SessionWord.reason` — the one-sentence explanation, for the tooltip. */
  reason?: string | null;
  /** Bytes moving right now: the live dot pulses. */
  streaming?: boolean;
  /** `SessionWord.case`, so a colour can single out one case (Finished, still open). */
  case?: string;
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
    /* No word yet means no claim yet: an unresolved row must not read as a
       finished run, which is the one wrong answer available here. */
    if (!session) return null;
    const { icon, tone, label, reason, streaming, case: sessionCase } = session;
    /*
     * THREE SHAPES, AND THE ICON COLUMN ALONE DOES NOT GIVE THEM.
     *
     * §5.1 spends `ring-dot` on FIVE cases — Working, Stale, Unverified, Ready
     * to complete and Idle — which are not one shape: the first is a process
     * that is UP and the rest are processes waiting on somebody. The column
     * that separates them is the TONE (`run` for Working alone). Reading the
     * icon by itself drew a waiting ring on every running session, which is
     * the one thing a sessions list exists to tell you, and it took a test to
     * notice because both renderings look deliberate.
     */
    const ended = icon === 'check' || icon === 'ring-x' || icon === 'square';
    const shape = ended ? 'outcome' : tone === 'run' ? 'live' : 'waiting';
    const glyph = icon === 'check' ? '✓' : icon === 'ring-x' ? '✕' : '▪';
    /* THE COLOUR IS THE STATE (Subhang, 2026-10-17). The shape says live,
       waiting or ended; the tone class colours it — green working, amber
       waiting on someone, grey idle at its prompt or stopped, blue ready to
       complete or finished-but-open, red crashed — so no two states a reader
       has to tell apart share a dot. `ring` (ended, not completed) is a
       hollow amber ring rather than a glyph: it is waiting on a person. */
    return (
      <span
        className={`lp__signal lp__signal--${shape} lp__signal--tone-${tone}`}
        data-signal={shape}
        data-session-icon={icon}
        data-session-case={sessionCase}
        data-streaming={shape === 'live' && streaming ? 'true' : undefined}
        title={reason ?? label}
      >
        {shape === 'outcome' ? <span aria-hidden>{glyph}</span> : <i aria-hidden />}
        {/* §6: colour and glyph only, and the word stays for a screen reader. */}
        <span className="sr-only">{label}</span>
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
