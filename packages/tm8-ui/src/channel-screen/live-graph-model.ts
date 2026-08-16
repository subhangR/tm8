/**
 * LIVE TOOL GRAPH MODEL — a pure fold of the chat feed's activity items into a
 * star graph around the session anchor.
 *
 * NO SERVER, BY CONSTRUCTION. The chat surface already parses each tool call's
 * side-effect into an `activity` feed item carrying the touched entity's
 * summary (`item.anchor`) and the verb. This model reads ONLY those items —
 * the same array the chips are drawn from — so the graph can never claim a
 * touch the feed does not show, and it updates exactly when the feed does.
 *
 * SHAPE: the session at the centre; one node per DISTINCT entity touched; the
 * edge label accumulates verbs ("edited ×3"). Repeat touches never add nodes.
 */
import type { EntityId, FeedItem } from '@tm8/contract';

export interface LiveGraphTouch {
  /** The touched entity — id plus what the feed knows about it. */
  id: EntityId;
  kind: string;
  title: string;
  /** verb → number of times this session's feed shows it against this entity. */
  verbs: Readonly<Record<string, number>>;
  /** Total touches, so the edge can state its weight. */
  count: number;
  /** ISO time of the most recent touch. */
  lastAt: string;
  /** ISO time of the first touch — the stable placement order. */
  firstAt: string;
}

export interface LiveGraphModel {
  /** Ordered by FIRST touch, so a settled node never moves when new ones arrive. */
  touches: readonly LiveGraphTouch[];
  /** Activity items counted in, so the strip can state its own basis. */
  activityCount: number;
}

export function foldLiveGraph(
  items: readonly FeedItem[],
  anchorId: EntityId,
): LiveGraphModel {
  const byId = new Map<string, {
    id: EntityId; kind: string; title: string;
    verbs: Record<string, number>; count: number; lastAt: string; firstAt: string;
  }>();
  let activityCount = 0;

  for (const item of items) {
    if (item.itemKind !== 'activity') continue;
    const entity = item.anchor;
    // A touch needs a far end: no entity summary, or the session touching
    // itself, places nothing. The chip row still shows the raw item.
    if (!entity || entity.id === anchorId) continue;
    activityCount += 1;
    const verb = item.activity.verb;
    const existing = byId.get(entity.id);
    if (existing) {
      existing.verbs[verb] = (existing.verbs[verb] ?? 0) + 1;
      existing.count += 1;
      if (item.createdAt > existing.lastAt) {
        existing.lastAt = item.createdAt;
        // The freshest summary wins the label — a rename shows up live.
        existing.title = entity.title;
        existing.kind = entity.kind;
      }
      if (item.createdAt < existing.firstAt) existing.firstAt = item.createdAt;
    } else {
      byId.set(entity.id, {
        id: entity.id,
        kind: entity.kind,
        title: entity.title,
        verbs: { [verb]: 1 },
        count: 1,
        lastAt: item.createdAt,
        firstAt: item.createdAt,
      });
    }
  }

  const touches = [...byId.values()].sort(
    (a, b) => a.firstAt.localeCompare(b.firstAt) || a.id.localeCompare(b.id),
  );
  return { touches, activityCount };
}

/** The edge's word: the most frequent verb, then "+N more" kinds of touch. */
export function edgeLabel(touch: LiveGraphTouch): string {
  const entries = Object.entries(touch.verbs).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const [verb, n] = entries[0]!;
  const head = n > 1 ? `${verb} ×${n}` : verb;
  return entries.length > 1 ? `${head} +${entries.length - 1}` : head;
}

/**
 * NEUTRAL edge language for the in-feed turn graph: a count, never a verb.
 * Activity verbs can carry tool-shaped strings (`chat.tool_called`), and the
 * turn graph's contract is entity title/kind plus relationship weight only —
 * no tool names, arguments, or payload ever reach the feed.
 */
export function neutralEdgeLabel(touch: LiveGraphTouch): string {
  return touch.count === 1 ? '1 touch' : `${touch.count} touches`;
}

// ---------------------------------------------------------------------------
// Turn segmentation — message-bounded runs, never timestamps.
// ---------------------------------------------------------------------------

export type TurnSegment =
  | { kind: 'item'; item: FeedItem }
  | {
      kind: 'turn';
      /** The run's first activity itemId — the row's stable identity. */
      firstId: string;
      /** ISO time of the run's first activity item — owns the day divider. */
      createdAt: string;
      /** The fold of THIS run only. `touches` may be empty (anchorless run). */
      model: LiveGraphModel;
    };

/**
 * Split the loaded feed into render segments: every non-activity item passes
 * through unchanged, and each MAXIMAL CONSECUTIVE RUN of activity items
 * between them becomes one `turn` segment folded by `foldLiveGraph`.
 *
 * THE BOUNDARY IS THE MESSAGE, DETERMINISTICALLY. `logicalOperationId` is
 * currently null in the server projection, so adjacency between messages is
 * the interim turn rule — never timestamps. If exact turn identity is ever
 * required, that is a contract/server provenance change, not a heuristic here.
 *
 * A run whose fold has no touches (anchorless or self-only activity) is still
 * EMITTED, with an empty model: the caller draws no row and no empty graph for
 * it, but can still treat the position as a boundary (e.g. for clustering).
 */
export function segmentTurnGraphs(
  items: readonly FeedItem[],
  anchorId: EntityId,
): TurnSegment[] {
  const out: TurnSegment[] = [];
  let run: FeedItem[] = [];

  const flush = (): void => {
    if (run.length === 0) return;
    out.push({
      kind: 'turn',
      firstId: run[0]!.itemId,
      createdAt: run[0]!.createdAt,
      model: foldLiveGraph(run, anchorId),
    });
    run = [];
  };

  for (const item of items) {
    if (item.itemKind === 'activity') {
      run.push(item);
      continue;
    }
    flush();
    out.push({ kind: 'item', item });
  }
  flush();
  return out;
}
