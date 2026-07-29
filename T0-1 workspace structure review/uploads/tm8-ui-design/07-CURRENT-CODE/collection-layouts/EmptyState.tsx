/**
 * Teaching empty state — an empty collection explains the composition
 * grammar instead of showing a blank pane. Per-kind copy is registry data
 * (`collectionEmptyHint`); kinds without a hint get the generic line.
 */
import { Kbd } from '../kit';
import { registryFor } from '../registry';
import type { EntityKind } from '../types/contract';

export function EmptyState({ kinds }: { kinds?: EntityKind[] }) {
  const hint = (kinds?.length === 1 && registryFor(kinds[0]).collectionEmptyHint)
    || 'nothing here yet — drag an entity in, or press';
  return (
    <div className="cv2-collection__empty" role="status">
      <div className="cv2-collection__emptyglyph" aria-hidden="true">◇</div>
      <p>
        {hint} <Kbd>⌘K</Kbd> to create or link one.
      </p>
    </div>
  );
}
