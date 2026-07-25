/**
 * Auto-tab strip + panes.
 *
 * Tabs appear automatically for whatever is linked to the channel — and the
 * list is NOT derived here: `facade.getChannelTabs()` is the projection, this
 * renders it 1:1 (order, labels, counts). Empty kinds simply never appear.
 *
 * Feed pane  → the Thread subsystem (the channel's own conversation).
 * Every other pane → `CollectionView` executing that tab's `ChannelTab.query`
 * verbatim, with the layout switcher/pivot available so Tasks can become a
 * board and Docs a gallery in one click.
 */
import { CollectionView } from '../../collections';
import type { ChannelTab, EntityId } from '../../types/contract';

/** The one tab the contract always emits first: the channel's own feed. */
export const FEED_TAB_KEY = 'feed';

export interface ChannelTabStripProps {
  tabs: ChannelTab[];
  activeKey: string;
  onSelect: (key: string) => void;
}

export function ChannelTabStrip({ tabs, activeKey, onSelect }: ChannelTabStripProps) {
  return (
    <div className="cv2-hub__tabs" role="tablist" aria-label="Channel tabs" data-testid="channel-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          role="tab"
          id={`cv2-hubtab-${tab.key}`}
          aria-selected={tab.key === activeKey}
          aria-controls={`cv2-hubpane-${tab.key}`}
          className="cv2-hub__tab"
          data-tab={tab.key}
          data-active={tab.key === activeKey || undefined}
          onClick={() => onSelect(tab.key)}
        >
          {tab.label}
          <span className="cv2-hub__tabcount t-mono">{tab.count}</span>
        </button>
      ))}
    </div>
  );
}

export interface ChannelTabPaneProps {
  tab: ChannelTab;
  onOpenEntity: (id: EntityId) => void;
}

/** A non-feed tab: its query, rendered by the one collection system. */
export function ChannelTabPane({ tab, onOpenEntity }: ChannelTabPaneProps) {
  return (
    <div
      className="cv2-hub__pane"
      role="tabpanel"
      id={`cv2-hubpane-${tab.key}`}
      aria-labelledby={`cv2-hubtab-${tab.key}`}
      data-testid={`channel-pane-${tab.key}`}
    >
      <CollectionView query={tab.query} onOpenEntity={onOpenEntity} />
    </div>
  );
}
