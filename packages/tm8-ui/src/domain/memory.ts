import type { EntityStaleness, EntitySummary } from '@tm8/contract';

/**
 * WHAT A MEMORY'S EPISTEMIC STATE LOOKS LIKE ON SCREEN, and — more importantly
 * — what this build can and cannot honestly claim about one.
 *
 * Three surfaces need the same answer (the teammate working set, the launch
 * memory picker, the memory detail), so it is derived once here rather than
 * three times with three drifts.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MEASURED DIVERGENCE 1 — "verified" IS NOT OBSERVABLE FROM A READ.
 *
 * `badges.staleness` is the only epistemic signal a client receives, and
 * `entity-read.ts:1326` ends its derivation with:
 *
 *     if (reasons.length === 0) return undefined;
 *
 * `verified` is spread into the badge AFTER that guard, so it can only ever
 * arrive ALONGSIDE a reason. A memory that is verified and otherwise unflagged
 * emits NO badge at all — indistinguishable, on the wire, from a memory nobody
 * has ever examined.
 *
 * The spawn injector does NOT have this limitation: `execution-handlers.ts:236`
 * reads the `verifies` edge directly and renders a literal `[verified]` marker
 * into the manifest. So the agent receiving a memory can be told it is
 * verified while this UI cannot say so.
 *
 * We therefore never draw a positive "verified" badge from an absent
 * staleness. The contract is emphatic about why (`contract.ts:174`): "ABSENT
 * MEANS UNFLAGGED — it does NOT mean verified or current"; an entity nobody has
 * examined must not acquire false authority. Rendering a green tick on silence
 * is exactly that. `unflagged` says what was actually measured, and
 * `VERIFIED_NOT_READABLE` is the reason a reader can reach.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * MEASURED DIVERGENCE 2 — A REMEMBERED MEMORY IS NOT NECESSARILY AN INJECTED ONE.
 *
 * `execution-handlers.ts:162` skips superseded rows when building the working
 * set: `if (!r.remembered || r.superseded) continue;`. The `remembers` edge
 * survives — 056's edges are append-only by design and nothing moves the
 * working-set edge to the chain head automatically — so a teammate's working
 * set genuinely contains memories that spawn will silently NOT inject.
 *
 * A working-set list that draws those rows identically to the rest is telling
 * the reader this teammate carries context it does not carry. `injected` is
 * that fact, and every surface that lists a working set must render it.
 */
export interface MemoryEpistemics {
  /** The word on the badge. Never a bare "verified" — see divergence 1. */
  word: string;
  tone: 'bad' | 'warn' | 'idle';
  /** The sentence behind the word, for `title`/aria. Always names the mechanism. */
  full: string;
  /**
   * Whether a spawn reading this teammate's working set would actually inject
   * this memory. False ONLY for superseded rows — see divergence 2.
   */
  injected: boolean;
}

export const VERIFIED_NOT_READABLE =
  'This build cannot report "verified" from a read: the staleness badge is omitted entirely when nothing is wrong, so a verified memory and an unexamined one look identical on the wire. Spawn-time injection does see it and marks it [verified].';

const UNFLAGGED: MemoryEpistemics = {
  word: 'unflagged',
  tone: 'idle',
  full: `Nothing is marked against this memory. Unflagged is not verified — ${VERIFIED_NOT_READABLE}`,
  injected: true,
};

/**
 * The badge for one memory. `reasons` already arrives in display-precedence
 * order (superseded > disputed > basisDeleted > basisMoved) from the server, so
 * the first one is the headline and this function never re-sorts it — a client
 * that re-ranked would be a second precedence free to disagree with the first.
 */
export function memoryEpistemics(badges: EntitySummary['badges'] | undefined): MemoryEpistemics {
  const staleness = badges?.staleness;
  if (!staleness || staleness.reasons.length === 0) return UNFLAGGED;
  const headline = staleness.reasons[0];
  switch (headline) {
    case 'superseded':
      return {
        word: 'superseded',
        tone: 'bad',
        full: supersededSentence(staleness),
        // The one case spawn drops. Stated here, once.
        injected: false,
      };
    case 'disputed': {
      const open = staleness.disputed?.openCount ?? 0;
      return {
        word: open > 1 ? `disputed · ${String(open)}` : 'disputed',
        tone: 'warn',
        full: `${String(open)} open dispute${open === 1 ? '' : 's'} against this memory — evidence contradicts it and no verification has answered them at the current version. It is still injected, carrying its [disputed] marker.`,
        injected: true,
      };
    }
    case 'basisDeleted':
      return {
        word: 'basis deleted',
        tone: 'warn',
        full: `${String(staleness.basisDeleted?.count ?? 0)} entity this memory was based on has been deleted, so the ground under the claim is gone. It is still injected.`,
        injected: true,
      };
    default:
      return {
        word: 'basis moved',
        tone: 'warn',
        full: `${String(staleness.basisMoved?.count ?? 0)} entity this memory was based on has changed since it was pinned, so the claim may no longer describe it. It is still injected.`,
        injected: true,
      };
  }
}

function supersededSentence(staleness: EntityStaleness): string {
  const head = staleness.superseded?.headId;
  const chain = head
    ? ' Reads resolve to the chain head.'
    : '';
  return `A newer memory supersedes this one.${chain} Spawn DROPS superseded memories from a working set (execution-handlers.ts:162), so this row is remembered but will not be injected — move the remembers edge to the successor to change that.`;
}

/**
 * The 056 scope fields, read off the SUMMARY.
 *
 * They ride in `state`, not `content` (`contract.ts:141`), precisely so that
 * "a value cannot travel away from the conditions that produced it" — every
 * summary read carries them in the same payload as the title. So a list row
 * can state a memory's scope without fetching its detail, and this reader takes
 * the summary rather than the detail to keep that property honest.
 */
export interface MemoryScope {
  mechanism: string;
  subjectScope: string;
  doesNotEstablish: string;
  measuredAt: string | null;
}

export function memoryScopeOf(summary: Pick<EntitySummary, 'state'>): MemoryScope | null {
  const state = summary.state;
  if (state.kind !== 'memory') return null;
  return {
    mechanism: state.mechanism,
    subjectScope: state.subjectScope,
    doesNotEstablish: state.doesNotEstablish,
    measuredAt: state.measuredAt,
  };
}

/**
 * The four fields `create_memory` requires, and the refusal when one is blank.
 *
 * The door btrims and length-checks every one of them (056), so a composer that
 * accepted whitespace would earn a server refusal the author cannot act on.
 * Trimming here and refusing with the FIELD NAME is the same check stated where
 * it can be fixed.
 */
export const MEMORY_FIELDS = [
  { key: 'statement', label: 'Statement', hint: 'the claim itself — this becomes the memory\u2019s title' },
  { key: 'mechanism', label: 'Mechanism', hint: 'how it was measured, so a reader can re-run it' },
  { key: 'subjectScope', label: 'Subject scope', hint: 'what the claim ranges over' },
  { key: 'doesNotEstablish', label: 'Does not establish', hint: 'the neighbouring claim this evidence does NOT support' },
] as const;

export type MemoryFieldKey = (typeof MEMORY_FIELDS)[number]['key'];

export function memoryDraftRefusal(draft: Readonly<Record<string, string>>): string | null {
  for (const field of MEMORY_FIELDS) {
    if ((draft[field.key] ?? '').trim().length === 0) {
      return `${field.label} is required — create_memory btrims and length-checks all four scope fields, so a blank one is refused at the door, not here.`;
    }
  }
  return null;
}

/** The contract's own ceiling: `memoryIds: z.array(...).max(32)` (schemas.ts:1662). */
export const MEMORY_IDS_MAX = 32;
