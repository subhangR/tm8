import { useRef, useState } from 'react';
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { KindIcon, getKind } from '../../domain';
import { Chip } from '../../kit';
import { Tile, type EntityListPanelProps } from '../EntityListPanel';
import { edgesOf, type MemorySetParams } from './MemorySetBlock';
import './profile-body.css';

/**
 * COLLECTION MEMBERSHIP, as one block serving BOTH directions.
 *
 * Membership is a `contains` edge (collection → entity, 001:921), so the same
 * block draws a collection's ITEMS (`direction: 'outgoing'`) and an entity's
 * COLLECTIONS (`direction: 'incoming'`) — which side it is on arrives through
 * registry params, never through a kind check (§15.2). This is the
 * `MemorySetBlock` shape deliberately: edge-typed, kind-blind, and the block
 * raises INTENT while a hook in `authoring/` performs the writes.
 *
 * WHY THE ROWS ARE EDGES AND NOT `content.items`. The detail's `items` preview
 * is bounded (the node caps it) and one-directional; the connections carry the
 * SAME `contains` edges on both endpoints, so rendering from edges keeps the
 * two panels — the collection's and the member's — reading one fact. The
 * eyebrow count (`params.count`) is of these very edges, so label and list
 * cannot disagree.
 *
 * THE PICKER IS A BOUNDED RECENCY LIST, STATED AS SUCH. The catalog's
 * `search.query` is reserved (honest 501), so there is no server text search
 * to delegate to. `authoring.search` pages recent entities through
 * `collections.query` and this block filters that one page by title locally —
 * a match list that says "recent", never "everything". When real search lands,
 * the picker upgrades without this file changing shape.
 */

export interface MembershipAuthoring {
  /** Put `peerId` into / take it out of the membership this block draws. */
  onAdd(peerId: string, title: string): void;
  onRemove(peerId: string, title: string): void;
  /** One bounded page of candidates; the block filters it by title locally. */
  search(text: string): Promise<EntitySummary[]>;
  /** Set when authoring is refused, so controls disable WITH a reason (L6/D28). */
  refusal?: string | null;
  /** Peer ids currently in flight, so a row can say so instead of looking inert. */
  pending?: readonly string[];
}

export function MembershipBlock({
  detail,
  params,
  onOpenEntity,
  authoring,
  itemsHost,
}: {
  detail: EntityDetail;
  params: MemorySetParams;
  onOpenEntity?: (id: string) => void;
  authoring?: MembershipAuthoring | null;
  /**
   * When set, the OUTGOING side (a collection's ITEMS) renders each member as
   * a REAL list tile — the kind's own registry anatomy, badges, PR chips and
   * control strip — instead of a chip (user ruling 2026-08-13: "the items
   * that are linked should be shown like the task items… whatever task tile,
   * session tile we are using, with the git baked in"). The host object is
   * composed ONCE by the detail panel; per row only `kind` is re-pointed so
   * each member draws from its own registry row (§15.2). Absent ⇒ chips, the
   * honest degradation for hosts with nothing to wire. The INCOMING side (an
   * entity's COLLECTIONS) keeps chips: a list of containers is a list of
   * names, not of workloads.
   */
  itemsHost?: EntityListPanelProps | null;
}) {
  const direction = params.direction === 'incoming' ? 'incoming' : 'outgoing';
  const edges = edgesOf(detail, params);
  /**
   * AN UNWIRED HOST IS A REFUSAL, NOT AN ABSENCE (L6/D28). This used to be
   * `authoring ? <add> : null`, which made a host that forgot to pass
   * `membershipAuthoring` pixel-identical to a genuine read-only refusal —
   * the add control simply did not exist, and the defect read as "i dont see
   * any add item in the collection detail page". The control now always
   * renders; a missing authoring lane is one more disabled-with-reason.
   */
  const refusal = authoring
    ? authoring.refusal ?? null
    : 'This view has not wired membership authoring; the panel can show these collections but not change them here.';
  const pending = new Set(authoring?.pending ?? []);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<readonly EntitySummary[]>([]);
  const searchSeq = useRef(0);

  const memberIds = new Set(
    edges.map((edge) => (edge.source.id === detail.id ? edge.target.id : edge.source.id)),
  );

  const runSearch = (text: string) => {
    setQuery(text);
    if (!authoring) return;
    const seq = ++searchSeq.current;
    void authoring.search(text).then((page) => {
      if (seq !== searchSeq.current) return; // a newer keystroke owns the list
      const needle = text.trim().toLowerCase();
      setOptions(
        page
          .filter((option) => option.id !== detail.id && !memberIds.has(option.id))
          .filter((option) => needle === '' || option.title.toLowerCase().includes(needle))
          .slice(0, 8),
      );
    });
  };

  const addLabel = typeof params.addLabel === 'string' ? params.addLabel : '+ add';
  const add = (
    <div className="pn-membership__add">
      <button
        type="button"
        className="pn-memory__add"
        data-testid="membership-add"
        // L6/D28: refused controls stay FOCUSABLE so the reason is reachable.
        aria-disabled={refusal ? true : undefined}
        title={refusal ?? undefined}
        onClick={(event) => {
          if (refusal) return event.preventDefault();
          setOpen((was) => !was);
          if (!open) runSearch('');
        }}
      >
        {addLabel}
      </button>
      {open && !refusal ? (
        <div className="pn-membership__picker" data-testid="membership-picker">
          <input
            type="text"
            className="pn-membership__input"
            placeholder="Filter recent by title…"
            aria-label="Filter candidates by title"
            value={query}
            onChange={(event) => runSearch(event.target.value)}
          />
          {options.length === 0 ? (
            <p className="pn-section__empty">No recent match. The list is one recent page, not a full search.</p>
          ) : (
            options.map((option) => (
              <button
                key={option.id}
                type="button"
                className="pn-membership__option"
                data-testid="membership-option"
                onClick={() => {
                  // The picker cannot open unauthored (`open && !refusal`),
                  // so this only narrows the type, never the behaviour.
                  authoring?.onAdd(option.id, option.title);
                  setOpen(false);
                  setQuery('');
                }}
              >
                <KindIcon kind={option.kind} /> {option.title}
              </button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );

  if (edges.length === 0) {
    const empty = typeof params.empty === 'string'
      ? params.empty
      : direction === 'outgoing'
        ? 'Nothing here yet. An empty collection is a real state — add any entity to curate it.'
        : 'In no collection yet.';
    return (
      <div className="pn-membership" data-testid="membership-block">
        <p className="pn-section__empty">{empty}</p>
        {add}
      </div>
    );
  }

  if (direction === 'outgoing' && itemsHost) {
    return (
      <div className="pn-membership" data-testid="membership-block">
        <div className="pn-membership__items" data-testid="membership-items">
          {edges.map((edge) => {
            const peer = edge.source.id === detail.id ? edge.target : edge.source;
            const inFlight = pending.has(peer.id);
            return (
              <div className="pn-membership__itemrow" data-testid="membership-row" key={edge.id}>
                {/* The member's OWN registry row decides the anatomy — a task
                    draws the control-card, a session the session tile — so
                    `kind` is re-pointed per row and nothing else changes. */}
                <div className="pn-membership__tile">
                  <Tile
                    row={peer}
                    props={{ ...itemsHost, kind: peer.kind }}
                    config={getKind(peer.kind)}
                  />
                </div>
                {authoring ? (
                  <button
                    type="button"
                    className="pn-membership__remove"
                    data-testid="membership-remove"
                    aria-label={`Remove ${peer.title}`}
                    aria-disabled={refusal || inFlight ? true : undefined}
                    title={refusal ?? (inFlight ? 'Removing…' : `Remove ${peer.title}`)}
                    onClick={(event) =>
                      refusal || inFlight
                        ? event.preventDefault()
                        : authoring.onRemove(peer.id, peer.title)}
                  >
                    ×
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

  return (
    <div className="pn-membership" data-testid="membership-block">
      <div className="pn-chiprow">
        {edges.map((edge) => {
          const peer = edge.source.id === detail.id ? edge.target : edge.source;
          const inFlight = pending.has(peer.id);
          return (
            <span className="pn-membership__row" data-testid="membership-row" key={edge.id}>
              <Chip glyph={<KindIcon kind={peer.kind} />} onClick={() => onOpenEntity?.(peer.id)}>
                {peer.title}
              </Chip>
              {authoring ? (
                <button
                  type="button"
                  className="pn-membership__remove"
                  data-testid="membership-remove"
                  aria-label={`Remove ${peer.title}`}
                  aria-disabled={refusal || inFlight ? true : undefined}
                  title={refusal ?? (inFlight ? 'Removing…' : `Remove ${peer.title}`)}
                  onClick={(event) =>
                    refusal || inFlight
                      ? event.preventDefault()
                      : authoring.onRemove(peer.id, peer.title)}
                >
                  ×
                </button>
              ) : null}
            </span>
          );
        })}
      </div>
      {add}
    </div>
  );
}
