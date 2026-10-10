/**
 * THE OVERVIEW TAB'S BODY — the craft's own tab, always first and pinned.
 * One mount, so the craft detail panel (every page live, stacked) drops in
 * here; until then it is the craft's own entity body. Its strip is the
 * craft's (Run, rename, delete, links), mounted by `CraftScreen`.
 */
import type { EntityId } from '@tm8/contract';
import { EntityTabBody, getKindAdapter, type EntityTabRecord } from '../tab-workspace/embed';
import type { CraftPageRow } from './craft-source';

export interface CraftOverviewProps {
  /** The craft's record in the screen's private runtime; null without a Workspace host. */
  tab: EntityTabRecord | null;
  pages: readonly CraftPageRow[];
  onOpenEntity(id: EntityId): void;
  onClose(): void;
}

export function CraftOverview({ tab, pages, onOpenEntity, onClose }: CraftOverviewProps) {
  if (tab) {
    return (
      <div className="dsn-entity tws-entity-main tws-entity-host" data-testid="dsn-overview">
        <EntityTabBody
          tab={tab}
          adapter={getKindAdapter(tab.kind)}
          onOpenEntity={(id) => onOpenEntity(id as EntityId)}
          onClose={onClose}
        />
      </div>
    );
  }
  return pages.length === 0 ? (
    <p className="crf-empty" data-testid="dsn-no-pages">
      No pages yet. Ask the chat to start one, or add a page with ＋.
    </p>
  ) : (
    <p className="crf-empty" data-testid="dsn-overview">
      {`${pages.length} page${pages.length === 1 ? '' : 's'}. Pick one above.`}
    </p>
  );
}
