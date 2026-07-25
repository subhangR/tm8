/**
 * ChannelHubBody — shelf + auto-tab strip + the active pane.
 *
 * Factored out of the screen so the SAME body can mount two ways:
 *   · the `channel` center view (`ChannelHub`), and
 *   · `EntityFullView`'s `hub` slot (`channelHubSlot()`), the Z4 promote path.
 * One hub, two mounts — no second implementation to drift.
 */
import { useMemo, useState } from 'react';
import { useFacade } from '../../entity';
import { DropSurface, promoteReactionsSlot, targetRef } from '../../interactions';
import { ReactionsPointsBar } from '../../subsystems/reactions';
import { Thread } from '../../subsystems/thread';
import { useNavStore } from '../../stores';
import type { EntityDetail, EntityId } from '../../types/contract';
import { ChannelShelf } from './ChannelShelf';
import { ChannelTabPane, ChannelTabStrip, FEED_TAB_KEY } from './ChannelTabs';
import { channelShelf } from './projection';
import { useChannelTabs } from './useChannelData';

export interface ChannelHubBodyProps {
  detail: EntityDetail;
  /** Defaults to pushing a Z3 panel (the shell's universal open action). */
  onOpenEntity?: (id: EntityId) => void;
}

export function ChannelHubBody({ detail, onOpenEntity }: ChannelHubBodyProps) {
  const facade = useFacade();
  const { value: tabs } = useChannelTabs(facade, detail.id);
  const [selected, setSelected] = useState<string>(FEED_TAB_KEY);

  const openEntity = onOpenEntity
    ?? ((id: EntityId) => useNavStore.getState().pushPanel({ entityId: id }));

  const strip = tabs ?? [];
  // A tab can disappear when its last attachment goes — fall back to the feed.
  const active = useMemo(
    () => strip.find((t) => t.key === selected) ?? strip[0] ?? null,
    [strip, selected],
  );

  return (
    // The whole hub body is the grammar's 'channel' drop surface (§6.2 row 1:
    // chip→channel = attached_to, optional embed) — shelf and feed included.
    <DropSurface target={targetRef(detail, 'channel')}>
    <div className="cv2-hub__body" data-testid="channel-hub-body">
      <ChannelShelf items={channelShelf(detail)} onOpenEntity={openEntity} />
      <ChannelTabStrip
        tabs={strip}
        activeKey={active?.key ?? FEED_TAB_KEY}
        onSelect={setSelected}
      />
      {active && active.key !== FEED_TAB_KEY ? (
        <ChannelTabPane tab={active} onOpenEntity={openEntity} />
      ) : (
        <div
          className="cv2-hub__pane cv2-hub__pane--feed"
          role="tabpanel"
          id={`cv2-hubpane-${FEED_TAB_KEY}`}
          aria-labelledby={`cv2-hubtab-${FEED_TAB_KEY}`}
          data-testid="channel-pane-feed"
        >
          {/* The feed IS the Thread: living embeds, activity folds, composer,
              and the universal reactions bar on every message row. */}
          <Thread
            anchorId={detail.id}
            variant="feed"
            markReadOnView
            reactionsSlot={promoteReactionsSlot((message) => (
              <ReactionsPointsBar
                entityId={message.id}
                entity={message}
                size="sm"
                hideZeroCounts
              />
            ))}
          />
        </div>
      )}
    </div>
    </DropSurface>
  );
}
