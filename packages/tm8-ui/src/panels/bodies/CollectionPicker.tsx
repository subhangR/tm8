/**
 * The entity picker behind both "add" flows.
 *
 * ONE COMPONENT, TWO DIRECTIONS. Filing a task into a list and pulling a task
 * into a list are the same write with the two ids swapped — `addCollectionItem
 * (collectionId, {entityId})`. Building them as two components would give the
 * same operation two search surfaces, two empty states and two failure
 * sentences to drift apart, so the caller supplies which id it already holds
 * and this supplies the other.
 *
 * IT SEARCHES THROUGH `reads.query`, the same executor behind every list in
 * the product, rather than a bespoke lookup. A picker with its own query path
 * is a picker that disagrees with the list the user just came from about what
 * exists — and `collections.query` already applies RLS, so a row that reaches
 * here is a row the viewer may genuinely link.
 *
 * NO KIND FILTER BY DEFAULT when picking members. A collection is
 * heterogeneous; pre-filtering to tasks would quietly rebuild the
 * one-kind-per-parent restriction that collections exist to escape.
 */
import { useEffect, useState } from 'react';
import type { CollectionQuery, CollectionResult, EntityKind, EntitySummary } from '@tm8/contract';
import { getKind } from '../../domain';
import { Chip, Eyebrow } from '../../kit';

export interface PickerReads {
  query(input: CollectionQuery): Promise<CollectionResult>;
}

/** How many rows one picker page shows. Small on purpose: this is a chooser. */
const PAGE = 25;

export function CollectionPicker({
  spaceId,
  kinds,
  excludeIds,
  label,
  reads,
  onPick,
  onCancel,
}: {
  spaceId: string;
  /** Restrict the search. Omitted means every kind — the heterogeneous case. */
  kinds?: readonly EntityKind[];
  /** Rows already in the list, hidden so picking one cannot look like a no-op. */
  excludeIds?: readonly string[];
  label: string;
  reads: PickerReads;
  onPick(entity: EntitySummary): void | Promise<void>;
  onCancel(): void;
}) {
  const [term, setTerm] = useState('');
  const [rows, setRows] = useState<EntitySummary[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setFailure(null);
    reads
      .query({
        spaceId,
        ...(kinds && kinds.length > 0 ? { kinds: [...kinds] } : {}),
        sort: 'activityAt_desc',
        limit: PAGE,
      })
      .then((result) => {
        if (live) setRows(result.page.items);
      })
      .catch((error: unknown) => {
        // An empty picker and a broken picker look identical unless one says
        // so. Rows stay null (not []) so the empty state cannot claim the
        // space is empty when the query never answered.
        if (live) setFailure(error instanceof Error ? error.message : 'the search failed');
      });
    return () => { live = false; };
  }, [reads, spaceId, kinds]);

  const hidden = new Set(excludeIds ?? []);
  // Filtered in the client because `collections.query` carries no text filter
  // (search.query is reserved and unbuilt). This narrows the page already
  // fetched — it is a convenience over what is shown, NOT a search, and the
  // placeholder says so rather than implying it reaches the whole space.
  const visible = (rows ?? []).filter(
    (row) => !hidden.has(row.id)
      && (term.trim() === '' || row.title.toLowerCase().includes(term.trim().toLowerCase())),
  );

  return (
    <div className="pn-picker" data-testid="collection-picker" role="dialog" aria-label={label}>
      <Eyebrow faint>{label}</Eyebrow>
      <input
        className="pn-picker__filter"
        type="text"
        value={term}
        placeholder="Filter the rows below"
        aria-label="Filter the rows below"
        onChange={(e) => setTerm(e.target.value)}
      />
      {failure ? (
        <p className="pn-section__error" role="status">
          Could not load anything to pick ({failure}).
        </p>
      ) : null}
      {!failure && rows === null ? <p className="pn-section__empty">Loading…</p> : null}
      {!failure && rows !== null && visible.length === 0 ? (
        <p className="pn-section__empty">Nothing here to add.</p>
      ) : null}
      <div className="pn-picker__rows">
        {visible.map((row) => (
          <Chip
            key={row.id}
            glyph={getKind(row.kind).chip.glyph}
            onClick={() => void onPick(row)}
          >
            {row.title}
          </Chip>
        ))}
      </div>
      <button type="button" className="pn-picker__cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
