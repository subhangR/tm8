/**
 * THE OVERVIEW TAB'S BODY — the craft's own tab, always first and pinned.
 * Its view is the craft detail panel (`CraftDetailPanel`, L4.2): every page
 * live, stacked. Its strip is the craft's (Run, rename, delete, links),
 * mounted by `CraftScreen`.
 *
 * The craft's own entity body stays MOUNTED under a Workspace host: it is
 * what portals the craft's Run and ⋯ into the strip, and what the strip's
 * Links and Messages show. It is hidden while the overview's section is the
 * entity view, where the detail panel stands in its place.
 */
import type { EntityId } from '@tm8/contract';
import { EntityTabBody, getKindAdapter, type EntityTabRecord } from '../tab-workspace/embed';
import { CraftDetailPanel, type CraftDetailPanelProps } from './CraftDetailPanel';
import type { CraftPageRow } from './craft-source';

export interface CraftOverviewProps {
  /** The craft's record in the screen's private runtime; null without a Workspace host. */
  tab: EntityTabRecord | null;
  pages: readonly CraftPageRow[];
  /** What the detail panel needs besides the pages. */
  panel: Omit<CraftDetailPanelProps, 'pages'>;
  onOpenEntity(id: EntityId): void;
  onClose(): void;
}

export function CraftOverview({ tab, pages, panel, onOpenEntity, onClose }: CraftOverviewProps) {
  const section = tab?.ui.subview ?? 'entity';
  const view =
    pages.length === 0 ? (
      <p className="crf-empty" data-testid="dsn-no-pages">
        No pages yet. Ask the chat to start one, or add a page with ＋.
      </p>
    ) : (
      <CraftDetailPanel {...panel} pages={pages} />
    );
  if (!tab) return <div className="dsn-entity" data-testid="dsn-overview">{view}</div>;
  return (
    <div className="dsn-entity" data-testid="dsn-overview">
      {section === 'entity' ? view : null}
      <div className="dsn-entity tws-entity-main tws-entity-host" hidden={section === 'entity'} data-testid="dsn-overview-entity">
        <EntityTabBody
          tab={tab}
          adapter={getKindAdapter(tab.kind)}
          onOpenEntity={(id) => onOpenEntity(id as EntityId)}
          onClose={onClose}
        />
      </div>
    </div>
  );
}
