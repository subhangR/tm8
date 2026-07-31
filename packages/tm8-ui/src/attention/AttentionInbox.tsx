/**
 * AttentionInbox — what the entity-detail centre shows when nothing is open.
 *
 * The blank state is turned into the space-wide triage list: every entity with
 * pending attention requests, its requests COMBINED into one row carrying the
 * summed points. Clicking a row opens that entity, which (by the existing rule
 * in `views/open-entity.ts`) resolves that entity's whole pending queue — so a
 * row is a single unit of work here as well as visually.
 *
 * Kind-agnostic on purpose: attention is defined on `entities`, so this lists
 * tasks beside sessions beside docs. It is NOT scoped to the list on the left.
 *
 * Honesty notes:
 *  - Rows arrive from the server ordered by points; the GROUPING is ours, and
 *    it only sees the page fetched. When the page is full we say so rather than
 *    implying the list is complete.
 *  - Titles are not on the wire (`AttentionRequest` carries `entityId` only),
 *    so they are hydrated separately. An unhydrated row shows its id, never a
 *    guessed name.
 */
import { useEffect, useRef, useState } from 'react';
import type { AttentionRequest, EntityId, SpaceId } from '@tm8/contract';
import type { Seam } from '../data/seam';
import { getKind } from '../domain/registry';
import { type AttentionEntityGroup, groupAttentionByEntity } from './attention-model';
import './attention.css';

/** One page is a triage screen, not the archive. */
const PAGE_LIMIT = 100;
/** Cap on name lookups so a large queue cannot fan out unboundedly. */
const HYDRATE_LIMIT = 30;

export interface AttentionInboxProps {
  seam: Pick<Seam, 'attentionRequests' | 'entity'>;
  spaceId: SpaceId;
  /** Names already in the store — consulted before any network read. */
  nameOf(id: EntityId): { title: string; kind: string } | undefined;
  onOpenEntity(id: EntityId): void;
  /** Test seam: injected rows skip the fetch entirely. */
  rows?: readonly AttentionRequest[];
}

type LoadState =
  | { phase: 'loading' }
  | { phase: 'ready'; rows: readonly AttentionRequest[]; truncated: boolean }
  | { phase: 'error'; message: string };

export function AttentionInbox(props: AttentionInboxProps) {
  const { seam, spaceId, rows: injected } = props;
  const [state, setState] = useState<LoadState>(
    injected ? { phase: 'ready', rows: injected, truncated: false } : { phase: 'loading' },
  );
  /** Hydrated names for ids the store did not already know. */
  const [fetched, setFetched] = useState<Record<string, { title: string; kind: string }>>({});
  const requested = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (injected || !spaceId) return;
    let live = true;
    setState({ phase: 'loading' });
    seam.attentionRequests({ spaceId, status: 'open', limit: PAGE_LIMIT })
      .then((page) => {
        if (!live) return;
        setState({
          phase: 'ready',
          rows: page.items,
          truncated: page.nextCursor != null,
        });
      })
      .catch((error: unknown) => {
        if (!live) return;
        setState({
          phase: 'error',
          message: String((error as { message?: string })?.message ?? error),
        });
      });
    return () => { live = false; };
  }, [seam, spaceId, injected]);

  const groups = state.phase === 'ready' ? groupAttentionByEntity(state.rows) : [];

  // Names the store cannot supply are read one by one. A failed lookup is left
  // absent so the row falls back to its id rather than inventing a title.
  useEffect(() => {
    let live = true;
    for (const group of groups.slice(0, HYDRATE_LIMIT)) {
      if (props.nameOf(group.entityId) || requested.current.has(group.entityId)) continue;
      requested.current.add(group.entityId);
      void seam.entity(group.entityId).then(
        (detail) => {
          if (!live) return;
          setFetched((current) => ({
            ...current,
            [group.entityId]: { title: detail.title, kind: detail.state.kind },
          }));
        },
        () => { /* leave unhydrated; the row shows its id */ },
      );
    }
    return () => { live = false; };
  }, [groups.map((g) => g.entityId).join(','), seam, props.nameOf]);

  if (state.phase === 'loading') {
    return (
      <div className="att-inbox" data-testid="attention-inbox">
        <div className="att-inbox__inner att-inbox__inner--quiet">Loading attention…</div>
      </div>
    );
  }

  if (state.phase === 'error') {
    return (
      <div className="att-inbox" data-testid="attention-inbox">
        <div className="att-inbox__inner att-inbox__inner--quiet">
          <p className="att-inbox__error">Attention could not be loaded.</p>
          <p className="att-inbox__error-detail">{state.message}</p>
        </div>
      </div>
    );
  }

  if (groups.length === 0) {
    return (
      <div className="att-inbox" data-testid="attention-inbox">
        <div className="att-inbox__inner att-inbox__inner--quiet">
          <div className="att-inbox__glyph" aria-hidden="true">◇</div>
          <p className="att-inbox__none">Nothing needs your attention.</p>
          <p className="att-inbox__hint">Choose anything from the list to open it here.</p>
        </div>
      </div>
    );
  }

  const totalPoints = groups.reduce((sum, group) => sum + group.totalPoints, 0);

  return (
    <div className="att-inbox" data-testid="attention-inbox">
      <div className="att-inbox__inner">
        <div className="att-inbox__eyebrow kit-eyebrow">
          Needs attention · {groups.length} {groups.length === 1 ? 'entity' : 'entities'} · {totalPoints} points
        </div>

        <ul className="att-inbox__list">
          {groups.map((group) => (
            <AttentionRow
              key={group.entityId}
              group={group}
              name={props.nameOf(group.entityId) ?? fetched[group.entityId]}
              onOpen={() => props.onOpenEntity(group.entityId)}
            />
          ))}
        </ul>

        {state.truncated ? (
          <p className="att-inbox__more">
            Showing the {PAGE_LIMIT} highest-scored requests — more are pending.
          </p>
        ) : null}

        <p className="att-inbox__hint">Opening an entity clears its attention.</p>
      </div>
    </div>
  );
}

function AttentionRow(props: {
  group: AttentionEntityGroup;
  name: { title: string; kind: string } | undefined;
  onOpen(): void;
}) {
  const { group, name } = props;
  const config = name ? getKind(name.kind) : undefined;
  // An unhydrated row is honest about it: the id, marked as still loading,
  // never a placeholder title that reads like a real one.
  const title = name?.title ?? group.entityId;
  const combined = group.pendingCount > 1;

  return (
    <li>
      <button
        type="button"
        className="att-inbox__row"
        onClick={props.onOpen}
        data-testid={`attention-row-${group.entityId}`}
        aria-label={[
          title,
          `${group.totalPoints} points`,
          combined ? `${group.pendingCount} requests combined` : '1 request',
          group.latestReason,
        ].join(', ')}
      >
        <span className="att-inbox__points" aria-hidden="true">{group.totalPoints}</span>
        <span className="att-inbox__body">
          <span className="att-inbox__title">
            {config ? <span className="att-inbox__glyph-sm" aria-hidden="true">{config.icon}</span> : null}
            <span className={name ? 'att-inbox__name' : 'att-inbox__name att-inbox__name--raw'}>
              {title}
            </span>
            {config ? <span className="att-inbox__kind">{config.label}</span> : null}
          </span>
          <span className="att-inbox__reason">{group.latestReason}</span>
        </span>
        {/* The count is the whole point of combining: say how many became one. */}
        {combined ? (
          <span className="att-inbox__count">{group.pendingCount} requests</span>
        ) : null}
      </button>
    </li>
  );
}
