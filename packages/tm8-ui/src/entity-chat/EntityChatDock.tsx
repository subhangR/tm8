/**
 * `EntityChatDock` — the INTERIM place the chat slot renders: a sheet from
 * the right over whatever surface is showing.
 *
 * It exists so the Chat button is usable end to end on every surface the day
 * the slot ships, before the layout lanes land (design 01a0da4e §4: D hosts
 * it as Home's third column and <1200px overlay, E as Work's centre and the
 * phone's sheet). Each of those lanes mounts `EntityChatSlot` itself and
 * returns `true` from `surfaceHostsChatSlot` for its view; the dock then draws
 * nothing there. Nothing else about the slot changes when they do.
 */
import { useNavStore } from '../stores/navStore';
import { EntityChatSlot, useChatSlot, type EntityChatSlotProps } from './EntityChatSlot';
import { surfaceHostsChatSlot } from './openEntityChat';

export type EntityChatDockProps = EntityChatSlotProps;

export function EntityChatDock(slot: EntityChatDockProps) {
  const open = useChatSlot();
  /* The surface on screen, read from the route: the dock stands aside on a
     view that hosts the slot in its own layout. */
  const view = useNavStore((s) => s.view);
  if (!open || surfaceHostsChatSlot(view)) return null;
  return (
    <div className="ecp-dock" data-testid="entity-chat-dock">
      <EntityChatSlot {...slot} />
    </div>
  );
}
