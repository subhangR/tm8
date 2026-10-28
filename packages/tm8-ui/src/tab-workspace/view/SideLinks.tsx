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
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Connections, EntityDetail, EntitySummary } from '@tm8/contract';
import { EDGE_FAMILY_LABEL, EDGE_FAMILY_ORDER, KindIcon, getKind, type EdgeFamily } from '../../domain';
import { peerStatus } from '../../domain/peer-state';
import { absTime, relTime } from '../../kit/time';
import { groupByPeer, newestRelationInstant } from '../../panels/detail/linksModel';
import { useLinksCursor } from '../../panels/detail/linksCursor';
import { takeLinkFocus, useLinkFocus } from '../../panels/list/linkFocus';

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

/**
 * WHAT THE LIST IS NARROWED BY. Two axes, and they are not the same question:
 * `family` is the RELATION ("depends on", "produces") and `kind` is the PEER
 * ("docs", "artifacts"). The family chips were here already; the KIND filter
 * is what a counts-line click on a list row asks for (design doc 01a1465d §6),
 * because `📄2` counted docs and the thing the reader wants to see is the two
 * docs — not every edge of whatever type carried them.
 *
 * ONE AT A TIME. Picking a family clears the kind and the reverse, because two
 * stacked narrowings on a list this short produce empty results the reader
 * cannot attribute to either control.
 */
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
  /* The group a list row's counts line asked for, consumed once (linkFocus.ts).
     Held in state afterwards so the reader can clear it like any other chip. */
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const cursor = useLinksCursor(listRef, onOpenEntity);
  const pending = useLinkFocus();
  useEffect(() => {
    const request = takeLinkFocus(detail.id);
    if (!request) return;
    setKindFilter(request.kind);
    setFilter('all');
    /* `pending` is in the deps so a SECOND click on the same group re-applies
       (the request carries a `seq`); `detail.id` so switching entity picks up
       a request filed for the new one. */
  }, [pending, detail.id]);

  const counts = new Map<EdgeFamily, number>();
  for (const link of links) counts.set(link.family, (counts.get(link.family) ?? 0) + 1);
  const families = EDGE_FAMILY_ORDER.filter((family) => (counts.get(family) ?? 0) > 0);
  /* A family that has since gone reads as All, never as an unexplained empty list. */
  const active: Filter = filter !== 'all' && counts.has(filter) ? filter : 'all';
  /* A kind nothing is linked of reads as All, never as an unexplained empty
     list — the same rule the family filter above already keeps. This is the
     normal case for a count a mid-rollout server sent and the graph page did
     not cover: the number was honest, and so is showing the whole list. */
  const kindCount = kindFilter ? links.filter((link) => link.peer.kind === kindFilter).length : 0;
  const activeKind = kindFilter && kindCount > 0 ? kindFilter : null;
  const shown = activeKind
    ? links.filter((link) => link.peer.kind === activeKind)
    : active === 'all'
      ? links
      : links.filter((link) => link.family === active);

  if (links.length === 0) return <p className="tws-side-empty">Nothing linked yet.</p>;

  return (
    <div className="tws-side-links" data-testid="tws-side-links" data-kind-filter={activeKind ?? undefined}>
      {/* THE GROUP CHIP, AND IT CLEARS. A filter a row applied from another
          column has to be visible and dismissible here, or the reader is
          looking at a short list with no idea why. */}
      {activeKind ? (
        <div className="tws-side-chips" role="group" aria-label="Showing one group">
          <button
            type="button"
            className="tws-side-chip"
            data-kind={activeKind}
            data-testid="tws-side-kind-chip"
            aria-pressed="true"
            title={`Showing ${getKind(activeKind).labelPlural.toLowerCase()} only — click to show everything`}
            onClick={() => setKindFilter(null)}
          >
            {getKind(activeKind).labelPlural}
            <em>{kindCount}</em>
            <span aria-hidden>✕</span>
          </button>
        </div>
      ) : null}
      {!activeKind && families.length > 1 ? (
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
