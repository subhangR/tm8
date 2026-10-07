import { useEffect, useRef, useState } from 'react';
import type { EdgeView, EntityDetail, EntitySummary } from '@tm8/contract';
import { KindIcon, type AttachPaletteRow } from '../../domain';
import { DisabledIconControl } from '../honesty/DisabledWithReason';

/** What a rail relation writes through: the attachments port's verbs, no more. */
export interface RailRelationsPort {
  /** Server word search for one kind; '' ⇒ the most recent. */
  search(kind: string, text: string): Promise<EntitySummary[]>;
  link(input: { srcId: string; dstId: string; type: string }): Promise<void>;
  /** Deletes the EDGE, never either entity. */
  unlink(edgeId: string): Promise<void>;
}

/** A relation drawn in the rail: the peer, and the edge to remove. */
interface RelationLink {
  edgeId: string;
  peer: EntitySummary;
}

const DEBOUNCE_MS = 150;

/** The edges `row` reads off `detail`, from the end the row names. */
export function relationLinks(detail: EntityDetail, row: AttachPaletteRow): RelationLink[] {
  const groups = row.direction === 'outgoing' ? detail.connections.outgoing : detail.connections.incoming;
  return groups
    .filter((group) => group.type === row.edgeType)
    .flatMap((group) => group.edges)
    .map((edge: EdgeView) => ({ edgeId: edge.id, peer: edge.source.id === detail.id ? edge.target : edge.source }))
    .filter((link) => link.peer.kind === row.kind);
}

/**
 * THE RAIL'S RELATIONS (task 01a1163a PR3, mockup r6) — "Depends on" and
 * "Blocks" as properties, not as anonymous chips in LINKED.
 *
 * Each row is registry data (`panel.railRelations`): the kind the picker
 * searches, the edge a pick writes, and which end the open entity is. A peer
 * opens on click and × removes the EDGE, never the peer. ＋ opens one inline
 * search, the attach palette's server word search, narrowed to the row's kind;
 * the open entity and anything already linked through the row are left out,
 * and the server's `validate_edge` is the final check.
 *
 * Absent port ⇒ the rows still read, and add says why it is not here (L6).
 */
export function RailRelations({
  detail,
  rows,
  port,
  refusal,
  onChanged,
  onOpenEntity,
}: {
  detail: EntityDetail;
  rows: readonly AttachPaletteRow[];
  port?: RailRelationsPort | null;
  /** Set when linking is refused; add and remove disable WITH the reason. */
  refusal?: string | null;
  /** A link landed or left; the host refetches the anchor. */
  onChanged?: () => void;
  onOpenEntity?: (id: string) => void;
}) {
  return (
    <div className="sb-relations" data-testid="rail-relations">
      {rows.map((row) => (
        <RelationRow
          key={`${row.edgeType}:${row.direction}`}
          detail={detail}
          row={row}
          port={port}
          refusal={refusal}
          onChanged={onChanged}
          onOpenEntity={onOpenEntity}
        />
      ))}
    </div>
  );
}

function RelationRow({
  detail,
  row,
  port,
  refusal,
  onChanged,
  onOpenEntity,
}: {
  detail: EntityDetail;
  row: AttachPaletteRow;
  port?: RailRelationsPort | null;
  refusal?: string | null;
  onChanged?: () => void;
  onOpenEntity?: (id: string) => void;
}) {
  const links = relationLinks(detail, row);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const writable = port != null && !refusal;
  const blocked = port == null
    ? { cause: 'Linking isn’t connected here', remedy: 'this view was mounted without a link port' }
    : refusal
      ? { cause: refusal, remedy: 'ask someone who can edit this task' }
      : null;

  const unlink = async (edgeId: string) => {
    setError(null);
    try {
      await port!.unlink(edgeId);
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const link = async (peer: EntitySummary) => {
    setError(null);
    try {
      await port!.link(
        row.direction === 'outgoing'
          ? { srcId: detail.id, dstId: peer.id, type: row.edgeType }
          : { srcId: peer.id, dstId: detail.id, type: row.edgeType },
      );
      setAdding(false);
      onChanged?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <div className="sb-relation" data-testid="rail-relation" data-edge={row.edgeType} data-direction={row.direction}>
      <span className="sb-relation__label">{row.label}</span>
      <div className="sb-relation__values">
        {links.length === 0 && !adding ? <span className="sb-relation__none">None</span> : null}
        {links.map((item) => (
          <span className="sb-relation__peer" key={item.edgeId} data-testid="rail-relation-peer">
            <button type="button" className="sb-relation__open" onClick={() => onOpenEntity?.(item.peer.id)}>
              <KindIcon kind={item.peer.kind} />
              <span className="sb-relation__title">{item.peer.title}</span>
            </button>
            {writable ? (
              <button
                type="button"
                className="sb-relation__remove"
                aria-label={`Remove ${item.peer.title} from ${row.label}`}
                data-testid="rail-relation-remove"
                onClick={() => void unlink(item.edgeId)}
              >
                ×
              </button>
            ) : null}
          </span>
        ))}
        {adding && writable ? (
          <RelationPicker
            anchorId={detail.id}
            row={row}
            linkedIds={new Set(links.map((item) => item.peer.id))}
            search={port!.search}
            onPick={(peer) => void link(peer)}
            onClose={() => setAdding(false)}
          />
        ) : blocked ? (
          <DisabledIconControl label={`Add to ${row.label}`} reason={blocked}>
            ＋ Add
          </DisabledIconControl>
        ) : (
          <button
            type="button"
            className="sb-relation__add"
            data-testid="rail-relation-add"
            onClick={() => setAdding(true)}
          >
            ＋ Add
          </button>
        )}
        {error ? (
          <span className="sb-relation__error" role="alert">
            {error}
          </span>
        ) : null}
      </div>
    </div>
  );
}

function RelationPicker({
  anchorId,
  row,
  linkedIds,
  search,
  onPick,
  onClose,
}: {
  anchorId: string;
  row: AttachPaletteRow;
  linkedIds: ReadonlySet<string>;
  search: RailRelationsPort['search'];
  onPick: (peer: EntitySummary) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState('');
  const [found, setFound] = useState<EntitySummary[] | null>(null);
  const [current, setCurrent] = useState(0);
  const box = useRef<HTMLDivElement | null>(null);
  /* The host may build its port per render; a search that re-ran on every new
     function identity would re-render itself forever. */
  const searchRef = useRef(search);
  searchRef.current = search;

  useEffect(() => {
    let live = true;
    const timer = setTimeout(() => {
      searchRef.current(row.kind, text.trim()).then(
        (items) => {
          if (!live) return;
          setFound(items);
          setCurrent(0);
        },
        () => {
          if (live) setFound([]);
        },
      );
    }, DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [row.kind, text]);

  // Verified before the edge, as the palette does: the row's kind, never the
  // anchor, never a peer this row already holds.
  const items = (found ?? []).filter(
    (item) => item.kind === row.kind && item.id !== anchorId && !linkedIds.has(item.id),
  );
  return (
    <div
      className="sb-relation__picker"
      ref={box}
      onBlur={(event) => {
        if (!box.current?.contains(event.relatedTarget as Node | null)) onClose();
      }}
    >
      <input
        className="sb-relation__search"
        data-testid="rail-relation-search"
        aria-label={`Search for a ${row.label.toLowerCase()} entry`}
        placeholder="Search…"
        autoFocus
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            onClose();
          } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            if (items.length === 0) return;
            const step = event.key === 'ArrowDown' ? 1 : -1;
            setCurrent((at) => (at + step + items.length) % items.length);
          } else if (event.key === 'Enter') {
            event.preventDefault();
            const pick = items[current];
            if (pick) onPick(pick);
          }
        }}
      />
      {found === null ? null : items.length === 0 ? (
        <p className="sb-relation__none">Nothing found.</p>
      ) : (
        <ul className="sb-relation__results" role="listbox" aria-label={`${row.label} candidates`}>
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={index === current}
                className="sb-relation__result"
                data-testid="rail-relation-result"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onPick(item)}
              >
                <KindIcon kind={item.kind} />
                <span className="sb-relation__title">{item.title}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
