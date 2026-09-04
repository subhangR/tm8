/**
 * FLEET REFS + THEIR READS → THE ROWS THE PANE DRAWS. Pure, so the honesty
 * rules below are testable without a host.
 *
 * THIS MODULE CHOOSES NOTHING ABOUT STATUS. The word, the tone and the dot all
 * come from `homeRowOf` — the one summary→row projection Home, the rail and
 * the tiles already use — composed with the seam's liveness verdict. That is
 * not politeness about layering: `homeRowOf` is where the two-source law lives
 * (a `pulse` is reachable only through a `live` verdict; a `running` record
 * with no live process reads `stale`, never live), and a fleet pane that
 * re-derived a status word would be the fourth place that law could rot.
 *
 * SECTIONS ARE KIND-DERIVED, AND KIND ARRIVES LATE. A ref's kind is usually
 * unknown until its read settles, so `section` is a function of the READ, not
 * of the fold. An unsettled ref sits in `unsettled` — it is NOT quietly filed
 * under "other", because a session that is still loading is not a non-session,
 * and shuffling it between sections as its read lands would move every row
 * under the viewer's cursor.
 *
 * A FAILED READ IS A ROW, NOT AN ABSENCE (the same rule the induced graph
 * holds for a failed seed). We know the conversation named this id and we know
 * what act named it; we do not know its title or status. The row says exactly
 * that. Dropping it would silently shrink a fleet, which is the one outcome a
 * fleet pane must never produce.
 */
import type { EntityDetail, EntitySummary, WorkSessionStatus } from '@tm8/contract';
import type { SessionLiveness } from '../../data/seam';
import { homeRowOf, type HomeDot } from '../../home/home-model';
import type { PillTone } from '../../kit';
import { badgePullRequestFactsOf, type LinkedPullRequestFacts } from '../../pull-requests';
import { truncateEntityId } from '../entity-refs';
import type { FleetRef } from './fleet-model';
import { originSentence } from './fleet-model';
import type { FleetEntityRead } from './use-fleet-entities';

/**
 * Where a row sits. `unsettled` is a real section, not a waiting room — see
 * the header note on late kinds.
 */
export type FleetSection = 'sessions' | 'tasks' | 'other' | 'unsettled';

export interface FleetRow {
  id: string;
  section: FleetSection;
  /** Null while unknown or unreadable — the pane then draws no kind mark
   *  rather than inventing one. */
  kind: string | null;
  /** The entity's title once read; the truncated id until then. Never blank. */
  title: string;
  /** True when `title` is still standing in for a name we do not have. */
  titleIsPlaceholder: boolean;
  /** Status word from `homeRowOf`. Null means this kind has no status — which
   *  is not the same as an unknown one, and both render as nothing. */
  word: string | null;
  tone: PillTone;
  dot: HomeDot;
  /** `homeRowOf`'s long-form honest sentence for a degraded verdict. */
  statusDetail?: string | undefined;
  /** ONLY true when the seam's verdict is 'live' right now. */
  live: boolean;
  /** The seam verdict itself, for the rows that want to say why. */
  liveness: SessionLiveness | null;
  /** How this conversation came to name it, and what it did to it. */
  originSentence: string;
  origin: FleetRef['origin'];
  /** From the entity's OWN badge — no extra read, no graph page lottery.
   *  Empty means "the server made no claim", which is why it renders nothing
   *  rather than "no PRs". */
  pullRequests: readonly LinkedPullRequestFacts[];
  /**
   * The read's state.
   *
   * `unread` is NOT `pending`, and conflating them was a real bug caught by
   * looking at the pane in a browser: with no host reader at all, every row
   * reported "Reading" forever. Nothing was reading. A row that will never be
   * resolved and a row that is being resolved right now are different facts
   * and the viewer can act on the difference.
   */
  read: FleetEntityRead['state'] | 'unread';
}

/**
 * The liveness verdict, asked for exactly the kinds that have one.
 *
 * `statusOf` takes the id and the recorded status; a work session carries its
 * own status vocabulary (`spawning | running | idle | exited | failed`) in
 * `state.status`. Anything else has no verdict, and the ABSENCE of a host
 * `livenessOf` is also a no-verdict — never a live claim.
 */
function livenessFor(
  detail: EntityDetail,
  livenessOf: FleetRowInput['livenessOf'],
): SessionLiveness | null {
  if (detail.kind !== 'work_session' || !livenessOf) return null;
  const status = (detail.state as { status?: WorkSessionStatus }).status ?? null;
  return livenessOf({ id: detail.id, status: status });
}

export interface FleetRowInput {
  refs: readonly FleetRef[];
  reads: ReadonlyMap<string, FleetEntityRead>;
  livenessOf?: ((session: { id: string; status: WorkSessionStatus | null }) => SessionLiveness) | undefined;
  /** False ⇒ this host supplied no reader, so an unsettled row is UNREAD, not
   *  pending. Nothing is in flight and the pane must not imply it is. */
  hasReader?: boolean | undefined;
  /** §9.2 pool byte-activity, per id. Can only REFINE a live verdict — it is
   *  handed straight to `homeRowOf`, which enforces that. */
  streamingIds?: ReadonlySet<string> | undefined;
}

export function fleetRowsOf({
  refs,
  reads,
  livenessOf,
  streamingIds,
  hasReader = true,
}: FleetRowInput): readonly FleetRow[] {
  return refs.map((ref) => {
    const read = reads.get(ref.id) ?? { state: hasReader ? ('pending' as const) : ('unread' as const) };
    const base = {
      id: ref.id,
      origin: ref.origin,
      originSentence: originSentence(ref),
    };

    if (read.state !== 'loaded') {
      /* The fold sometimes carries kind/title from the tool payload itself,
         and that is a real fact even before the read settles — but it never
         promotes an unsettled row into a kind section, because a payload's
         `kind` is a hint from a blob and the read is the authority. */
      return {
        ...base,
        section: read.state === 'failed' ? 'other' : 'unsettled',
        kind: ref.kind ?? null,
        title: ref.title ?? truncateEntityId(ref.id),
        titleIsPlaceholder: ref.title === undefined,
        word: null,
        tone: 'idle' as PillTone,
        dot: null,
        live: false,
        liveness: null,
        pullRequests: [],
        read: read.state,
      };
    }

    const detail = read.detail;
    const liveness = livenessFor(detail, livenessOf);
    const row = homeRowOf(detail as EntitySummary, {
      ...(liveness ? { liveness } : {}),
      ...(streamingIds?.has(detail.id) ? { streaming: true } : {}),
    });

    return {
      ...base,
      section: sectionOf(detail.kind),
      kind: detail.kind,
      title: detail.title,
      titleIsPlaceholder: false,
      word: row.word,
      tone: row.tone,
      dot: row.dot,
      statusDetail: row.detail,
      live: liveness === 'live',
      liveness,
      /* Tasks project their tracked PRs onto their own summary; a session's
         PR story is inherited and provenance-sensitive (`indexLinkedPullRequests`
         is where that lives), so this pane claims only what the row itself
         carries and lets the detail panel tell the fuller story. */
      pullRequests: badgePullRequestFactsOf(detail as EntitySummary),
      read: 'loaded' as const,
    };
  });
}

function sectionOf(kind: string): FleetSection {
  if (kind === 'work_session') return 'sessions';
  if (kind === 'task') return 'tasks';
  return 'other';
}

export interface FleetGroups {
  sessions: readonly FleetRow[];
  tasks: readonly FleetRow[];
  other: readonly FleetRow[];
  unsettled: readonly FleetRow[];
  /** How many sessions the seam says are live RIGHT NOW. Never a count of
   *  'running' records — that is the claim `homeRowOf` exists to withdraw. */
  liveSessionCount: number;
}

/** Group without reordering: within a section, first-reference order survives,
 *  because a row that jumped when its read settled would move under a click. */
export function groupFleetRows(rows: readonly FleetRow[]): FleetGroups {
  const sessions = rows.filter((row) => row.section === 'sessions');
  return {
    sessions,
    tasks: rows.filter((row) => row.section === 'tasks'),
    other: rows.filter((row) => row.section === 'other'),
    unsettled: rows.filter((row) => row.section === 'unsettled'),
    liveSessionCount: sessions.filter((row) => row.live).length,
  };
}
