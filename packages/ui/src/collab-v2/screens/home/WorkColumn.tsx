/**
 * Home column — one live `CollectionQuery` rendered as Z2 rows.
 *
 * Why not `CollectionView` here: Home's columns need a per-row screen
 * affordance (PULL) and a facade-backed live badge row (RE-PULL), which the
 * collection layouts deliberately don't carry. The column therefore composes
 * the *same* pieces CollectionView does — `useCollection` for the live,
 * cached, event-patched query, `EntityCard` for the cell, `EmptyState` for the
 * teaching empty — and adds only screen chrome.
 */
import type { ReactNode } from 'react';
import { EmptyState, useCollection } from '../../collections';
import { useFacade } from '../../entity';
import { Eyebrow } from '../../kit';
import type { CollectionQuery, EntityId, EntitySummary } from '../../types/contract';
import { EntityRow } from './rows';

export interface WorkColumnProps {
  title: string;
  hint: string;
  query: CollectionQuery;
  onOpen: (id: EntityId) => void;
  renderAction?: (entity: EntitySummary) => ReactNode;
  renderMeta?: (entity: EntitySummary) => ReactNode;
  testId: string;
}

export function WorkColumn({
  title, hint, query, onOpen, renderAction, renderMeta, testId,
}: WorkColumnProps) {
  const facade = useFacade();
  const { items, loading, error, refetch } = useCollection(query);

  return (
    <section className="cv2-home__col" data-testid={testId} aria-label={title}>
      <header className="cv2-home__colhead">
        <Eyebrow>{title}</Eyebrow>
        <span className="cv2-home__count" data-testid={`${testId}-count`}>{items.length}</span>
      </header>
      <p className="cv2-home__hint">{hint}</p>

      {error && (
        <div className="cv2-home__error" role="alert">
          {error.message}
          <button type="button" className="cv2-home__retry" onClick={refetch}>retry</button>
        </div>
      )}

      {loading && items.length === 0 && (
        <div className="cv2-home__loading" role="status">loading…</div>
      )}

      {!loading && items.length === 0 && !error && <EmptyState kinds={query.kinds} />}

      <div className="cv2-home__rows">
        {items.map((entity) => (
          <EntityRow
            key={entity.id}
            entity={entity}
            facade={facade}
            onOpen={onOpen}
            action={renderAction?.(entity)}
            meta={renderMeta?.(entity)}
          />
        ))}
      </div>
    </section>
  );
}
