import type { EntityDetail } from '@tm8/contract';
import { KindIcon, getKind } from '../../domain';
import { edgesOf, type MemorySetParams } from './MemorySetBlock';
import './profile-body.css';

/**
 * PEER ROWS — the entities on the other end of the edge the registry names.
 *
 * Deliberately the plainest block here: a glyph, a title and the peer's KIND.
 * It exists because "who remembers this memory" is now a mixed list — 085
 * widened `remembers.src_kinds` to the wildcard, so teammates, tasks and work
 * sessions all appear in it — and the kind is the only thing that distinguishes
 * them.
 *
 * WHY IT DOES NOT SPLIT AUTHORSHIP OUT OF THE HOLDERS: it must not guess. A
 * `remembers` edge from a work_session and one from a teammate are the same
 * claim ("this is in my working set"); authorship is a DIFFERENT edge
 * (`authored_from`, server-written), so the panel asks for it as a second
 * `peer-rows` row rather than inferring it from the holder's kind. That
 * distinction survives consolidation moving `remembers` edges around, which is
 * why D10 kept both edges.
 */
export function PeerRowsBlock({
  detail,
  params,
  onOpenEntity,
}: {
  detail: EntityDetail;
  params: MemorySetParams;
  onOpenEntity?: (id: string) => void;
}) {
  const peers = edgesOf(detail, params).map((edge) => (
    edge.source.id === detail.id ? edge.target : edge.source
  ));
  if (peers.length === 0) {
    const empty = typeof params.empty === 'string' ? params.empty : 'Nothing here yet.';
    return <p className="pn-section__empty">{empty}</p>;
  }
  return (
    <div className="pn-profile__rows" data-testid="peer-rows">
      {peers.map((peer) => (
        <button
          type="button"
          key={peer.id}
          className="pn-profile__row"
          onClick={() => onOpenEntity?.(peer.id)}
          title={peer.title}
        >
          <span aria-hidden className="pn-profile__row-glyph">
            <KindIcon kind={peer.kind} />
          </span>
          <span className="pn-profile__row-name">{peer.title}</span>
          <span aria-hidden className="pn-profile__sep">·</span>
          {/* The kind IN WORDS, from the registry — the glyph alone cannot
              tell a task from a work session for anyone not fluent in it. */}
          <span className="pn-profile__org-role">{getKind(peer.kind).label}</span>
        </button>
      ))}
    </div>
  );
}

