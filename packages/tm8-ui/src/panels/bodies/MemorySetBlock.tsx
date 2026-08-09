import type { EdgeView, EntityDetail } from '@tm8/contract';
import { KindIcon } from '../../domain';
import { memoryEpistemics, memoryScopeOf } from '../../domain/memory';
import './profile-body.css';

/**
 * THE MEMORY WORKING SET, as a standalone block.
 *
 * WHY IT LIVES HERE AND NOT IN `ProfileBody`, where it was born: TWO BODIES
 * NEED IT. 085 widened `remembers.src_kinds` to the wildcard, so a task holds a
 * working set exactly as a teammate does — and the task panel is
 * `archetype: 'subtree'`, a different body entirely. Leaving the block inside
 * ProfileBody would have meant either a second copy or giving SubtreeBody a
 * generic block renderer it does not want.
 *
 * IT IS EDGE-TYPED, NEVER KIND-TYPED. Everything it needs arrives through
 * registry params (`edgeType`, `direction`) plus the detail's own connections,
 * so it holds §15.2 in both hosts: neither body asks what the entity IS.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE TWO FACTS PER ROW, which is the only reason this block exists rather
 * than a plain link list:
 *   · REMEMBERED — the edge is present. That is what the list is.
 *   · INJECTED — whether a spawn would actually hand this to the agent.
 * They are NOT the same fact. `execution-handlers.ts:162` drops superseded
 * memories from a working set while the edge survives, so a row can be in the
 * set and never reach a session. Drawing those rows identically would tell the
 * reader this holder carries context it does not carry.
 *
 * On a TASK this matters more, not less: a `remembers(task -> memory)` edge
 * changes what every session spawned on that task is told, and before this
 * block existed those edges rendered as undifferentiated "linked" chips with
 * no marker and no way to detach them.
 */

export interface MemorySetParams {
  readonly [key: string]: string | number | boolean | undefined;
}

export interface MemoryAuthoring {
  /** Compose a new memory and remember it here. The host owns the form. */
  onAdd(): void;
  /**
   * Drop the `remembers` edge — and ONLY that edge. The memory entity
   * survives, which is not a nicety: 056's epistemic edges are append-only and
   * a memory is the target of other actors' marks, so deleting the claim
   * because one holder stopped tracking it would destroy other people's
   * evidence. Takes the EDGE id, so the block must keep edges and not just
   * peers.
   */
  onForget(edgeId: string, title: string): void;
  /** Set when authoring is refused, so controls disable WITH a reason (L6/D28). */
  refusal?: string | null;
  /** Edge ids currently in flight, so a row can say so instead of looking inert. */
  pending?: readonly string[];
}

/**
 * MEMORY SET — the memories this entity `remembers` (056/084/085).
 *
 * WHY THIS REPLACES A NUMBER. The teammate frame used to render memories as a
 * `field-grid` cell, and `FieldValue` prints any array as `value.length`. After
 * 084 emptied `team_members.memories` that cell prints `0` forever: a count of
 * a column nobody writes, next to a graph nobody was reading. A stat that can
 * only ever be zero is worse than no stat, because it reads as a measurement.
 *
 * WHY IT IS EDGE-BACKED AND NOT KIND-BOUND. 085 widened `remembers.src_kinds`
 * to the wildcard, so a task holds a working set exactly like a teammate does.
 * This block therefore names an EDGE TYPE in registry params and never a kind —
 * the same row on a task panel needs no code here, which is the §15.2 rule
 * paying for itself.
 *
 * THE TWO FACTS PER ROW, and the reason this block exists at all:
 *   · REMEMBERED — the edge is present. That is what the list is.
 *   · INJECTED — whether a spawn would actually hand this to the agent.
 * They are NOT the same fact. `execution-handlers.ts:162` drops superseded
 * memories from a working set while the edge survives, so a row can be in the
 * set and still never reach a session. Drawing those rows identically would
 * tell the reader the teammate carries context it does not carry — see
 * `domain/memory.ts` for the measurement. So a dropped row is struck and says
 * `not injected` in words.
 */
export function MemorySetBlock({
  detail,
  params,
  onOpenEntity,
  authoring,
}: {
  detail: EntityDetail;
  params: MemorySetParams;
  onOpenEntity?: (id: string) => void;
  authoring?: MemoryAuthoring | null;
}) {
  const edges = edgesOf(detail, params);
  const refusal = authoring?.refusal ?? null;
  const pending = new Set(authoring?.pending ?? []);

  const add = authoring ? (
    <button
      type="button"
      className="pn-memory__add"
      data-testid="memory-add"
      // L6/D28: refused controls stay FOCUSABLE so the reason is reachable.
      aria-disabled={refusal ? true : undefined}
      title={refusal ?? 'Author a memory and add it to this working set'}
      onClick={(event) => (refusal ? event.preventDefault() : authoring.onAdd())}
    >
      + remember something
    </button>
  ) : null;

  if (edges.length === 0) {
    const empty =
      typeof params.empty === 'string'
        ? params.empty
        : 'No memories remembered here yet. A memory is a scope-carrying claim — what was measured, how, and what it does not establish.';
    return (
      <div className="pn-memory">
        <p className="pn-section__empty">{empty}</p>
        {add}
      </div>
    );
  }

  return (
    <div className="pn-memory">
      <div className="pn-memory__rows">
        {edges.map((edge) => {
          const peer = edge.source.id === detail.id ? edge.target : edge.source;
          const mark = memoryEpistemics(peer.badges);
          const scope = memoryScopeOf(peer);
          const inFlight = pending.has(edge.id);
          return (
            <div
              key={edge.id}
              className="pn-memory__row"
              data-testid="memory-row"
              data-injected={mark.injected ? 'yes' : 'no'}
            >
              <button
                type="button"
                className="pn-memory__claim"
                onClick={() => onOpenEntity?.(peer.id)}
                title={peer.title}
              >
                <span aria-hidden className="pn-profile__row-glyph">
                  <KindIcon kind={peer.kind} />
                </span>
                <span className="pn-memory__statement">{peer.title}</span>
              </button>
              <span className="pn-memory__marks">
                <span className="pn-memory__mark" data-tone={mark.tone} title={mark.full}>
                  {mark.word}
                </span>
                {/* Stated only when it is FALSE. "injected" on every healthy row
                    would be noise; "not injected" is the exception a reader
                    must not miss, and it carries the mechanism in its title. */}
                {mark.injected ? null : (
                  <span className="pn-memory__mark" data-tone="bad" title={mark.full}>
                    not injected
                  </span>
                )}
              </span>
              {/* The scope, from the SUMMARY — 056 puts these in `state` so they
                  travel with the title and a row never has to fetch a detail to
                  say what a claim ranges over. */}
              {scope && scope.subjectScope.length > 0 ? (
                <span className="pn-memory__scope" title={`Does not establish: ${scope.doesNotEstablish}`}>
                  {scope.subjectScope}
                </span>
              ) : null}
              {authoring ? (
                <button
                  type="button"
                  className="pn-memory__forget"
                  data-testid="memory-forget"
                  aria-disabled={refusal || inFlight ? true : undefined}
                  aria-label={`Forget: ${peer.title}`}
                  title={
                    refusal ??
                    (inFlight
                      ? 'Removing…'
                      : 'Drop the remembers edge. The memory entity survives — other actors\u2019 marks on it are evidence and are never deleted from here.')
                  }
                  onClick={(event) =>
                    refusal || inFlight ? event.preventDefault() : authoring.onForget(edge.id, peer.title)
                  }
                >
                  {inFlight ? '…' : 'forget'}
                </button>
              ) : null}
            </div>
          );
        })}
      </div>
      {add}
    </div>
  );
}


/**
 * The edges of the group the registry names (`params.edgeType`/`direction`).
 *
 * Returns EDGES and not peers, because an edge-backed block that offers to
 * remove a link needs the edge's own id — `edges.delete` takes the edge, and
 * re-deriving it from a peer id would be a second lookup free to pick the wrong
 * one when two edge types join the same pair.
 */
export function edgesOf(detail: EntityDetail, params: MemorySetParams): readonly EdgeView[] {
  const type = typeof params.edgeType === 'string' ? params.edgeType : null;
  const direction = params.direction === 'incoming' ? 'incoming' : 'outgoing';
  const groups = direction === 'outgoing' ? detail.connections.outgoing : detail.connections.incoming;
  return groups.filter((group) => type == null || group.type === type).flatMap((group) => group.edges);
}
