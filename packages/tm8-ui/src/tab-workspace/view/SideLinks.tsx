/**
 * The side column's Links section (task 01a122b9, D6): everything the entity
 * is connected to as ONE flat list, newest first, narrowed by family chips.
 * A row is the kind icon, the title, the relation as a small pill, the peer's
 * status and how long ago — the left rail's row grammar. The parent and the
 * children are rows too, pilled as such.
 *
 * The peers are `groupByPeer`'s, the same reading the old Links page drew, so
 * the two can never disagree about what is linked.
 */
import { useMemo, useRef, useState } from 'react';
import type { Connections, EntityDetail, EntitySummary } from '@tm8/contract';
import { EDGE_FAMILY_LABEL, EDGE_FAMILY_ORDER, KindIcon, getKind, type EdgeFamily } from '../../domain';
import { peerStatus } from '../../domain/peer-state';
import { absTime, relTime } from '../../kit/time';
import { groupByPeer, newestRelationInstant } from '../../panels/detail/linksModel';
import { useLinksCursor } from '../../panels/detail/linksCursor';

/** One row of the list: a linked peer, or the parent / a child. */
export interface SideLink {
  peer: EntitySummary;
  /** The relation as the pill reads it ("Depends on", "Parent"). */
  relation: string;
  family: EdgeFamily;
  /** Sort key and the row's time; null when nothing dated it. */
  at: string | null;
  /** An unresolved hard dependency — drawn red. */
  blocking: boolean;
}

export function sideLinksOf(detail: EntityDetail, connections: Connections | undefined): SideLink[] {
  const groups = [
    ...(connections?.outgoing ?? detail.connections.outgoing),
    ...(connections?.incoming ?? detail.connections.incoming),
  ];
  const rows: SideLink[] = groupByPeer(groups, detail.id).map((entry) => ({
    peer: entry.peer,
    relation: entry.primary.verb,
    family: entry.primary.family,
    at: newestRelationInstant(entry),
    blocking: entry.unresolvedHard,
  }));
  const seen = new Set(rows.map((row) => row.peer.id));
  const hierarchy = (peer: EntitySummary, relation: string) => {
    if (seen.has(peer.id)) return;
    seen.add(peer.id);
    rows.push({ peer, relation, family: 'work', at: peer.updatedAt ?? peer.createdAt ?? null, blocking: false });
  };
  if (detail.hierarchy.parent) hierarchy(detail.hierarchy.parent, 'Parent');
  for (const child of detail.hierarchy.children.items) hierarchy(child, 'Child');
  /* Newest first; an undated row sinks, keeping its relative order. */
  return rows
    .map((row, i) => ({ row, i, t: row.at ? Date.parse(row.at) : Number.NEGATIVE_INFINITY }))
    .sort((a, b) => (b.t === a.t ? a.i - b.i : b.t - a.t))
    .map(({ row }) => row);
}

type Filter = 'all' | EdgeFamily;

export function SideLinks({
  detail,
  connections,
  onOpenEntity,
}: {
  detail: EntityDetail;
  connections: Connections | undefined;
  onOpenEntity: (id: string) => void;
}) {
  const links = useMemo(() => sideLinksOf(detail, connections), [detail, connections]);
  const [filter, setFilter] = useState<Filter>('all');
  const listRef = useRef<HTMLUListElement>(null);
  const cursor = useLinksCursor(listRef, onOpenEntity);

  const counts = new Map<EdgeFamily, number>();
  for (const link of links) counts.set(link.family, (counts.get(link.family) ?? 0) + 1);
  const families = EDGE_FAMILY_ORDER.filter((family) => (counts.get(family) ?? 0) > 0);
  /* A family that has since gone reads as All, never as an unexplained empty list. */
  const active: Filter = filter !== 'all' && counts.has(filter) ? filter : 'all';
  const shown = active === 'all' ? links : links.filter((link) => link.family === active);

  if (links.length === 0) return <p className="tws-side-empty">Nothing linked yet.</p>;

  return (
    <div className="tws-side-links" data-testid="tws-side-links">
      {families.length > 1 ? (
        <div className="tws-side-chips" role="group" aria-label="Show links of one kind">
          {(['all', ...families] as Filter[]).map((id) => (
            <button
              key={id}
              type="button"
              className="tws-side-chip"
              data-family={id}
              aria-pressed={active === id}
              onClick={() => setFilter(id)}
            >
              {id === 'all' ? 'All' : id === 'sessions' ? 'Sessions' : EDGE_FAMILY_LABEL[id]}
              <em>{id === 'all' ? links.length : counts.get(id)}</em>
            </button>
          ))}
        </div>
      ) : null}
      <div className="tws-side-scroll">
        <ul
          ref={listRef}
          className="tws-side-list"
          aria-label="Links — j/k to move, Enter to open"
          data-testid="tws-side-links-list"
          tabIndex={-1}
          onFocus={cursor.onFocus}
          onBlur={cursor.onBlur}
          onKeyDown={cursor.onKeyDown}
        >
          {shown.map((link) => (
            <LinkRow key={link.peer.id} link={link} onOpen={() => onOpenEntity(link.peer.id)} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function LinkRow({ link, onOpen }: { link: SideLink; onOpen: () => void }) {
  const { peer } = link;
  const status = peerStatus(peer);
  const kindLabel = getKind(peer.kind).label;
  return (
    <li className="tws-side-row" data-peer-id={peer.id} data-blocking={link.blocking || undefined}>
      <button type="button" className="tws-side-row__hit" title={`${kindLabel} · ${peer.title}`} onClick={onOpen}>
        <span className="tws-side-row__lead tws-side-row__icon">
          <KindIcon kind={peer.kind} size={14} />
        </span>
        <span className="tws-side-row__main">
          <span className="tws-side-row__line">
            <span className="tws-side-row__title">{peer.title || 'Untitled'}</span>
            {link.at ? (
              <time className="tws-side-row__when" dateTime={link.at} title={absTime(link.at)}>
                {relTime(link.at)}
              </time>
            ) : null}
          </span>
          <span className="tws-side-row__tags">
            <span className="tws-side-pill" data-tone={link.blocking ? 'block' : undefined}>
              {link.relation}
            </span>
            {status ? (
              <span className="tws-side-status" data-tone={status.tone}>
                <i aria-hidden />
                {status.label}
              </span>
            ) : null}
          </span>
        </span>
      </button>
    </li>
  );
}
