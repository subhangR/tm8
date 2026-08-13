/**
 * `views/InboxView.tsx` — the host that finally MOUNTS the Inbox.
 *
 * NOTHING IN `src/inbox/` WAS BUILT BY THIS FILE. `InboxScreen`, `inbox-model`
 * and `useInboxData` have been finished and tested in the tree for some time;
 * `inbox.list` has been a `v1` operation for just as long; `inbox` has been a
 * member of the closed `MenuViewRef` union since the union existed, and its
 * `menu_view_registry` row was seeded by migration 029. Every part was present
 * and connected to nothing — `GateApp` rendered the "isn't built yet" card for
 * the ref while the screen sat unreferenced, which is the *unreachable finished
 * screen* shape migrations 045, 096 and 102 each fixed for a different view.
 *
 * So this file is a WIRE, not a feature: a hook call, a port, and a navigation
 * callback. It is a separate component rather than a branch inside `GateApp`
 * for one hard reason — `useInboxData` is a hook, and a hook inside a ternary
 * arm is illegal. Mounting the screen through a component means the read only
 * fires when the viewer is actually looking at the Inbox, instead of on every
 * render of every other view.
 *
 * WHY THE PORT IS THE WHOLE `seam`. `InboxSeamPort` names exactly three members
 * (`inbox`, `onEvent`, `commands.markRead`) and a full `Seam` satisfies it
 * structurally, so the narrowing is enforced by the screen's own type rather
 * than by a mapping layer here that could quietly widen.
 */
import type { EntityId } from '@tm8/contract';
import { InboxScreen } from '../inbox';
import { useInboxData, type InboxSeamPort } from '../inbox/useInboxData';

export interface InboxViewProps {
  seam: InboxSeamPort;
  /**
   * Click-through. The oracle's CLICK-THROUGH card splits this in two: the
   * screen always marks the row read itself, and the HOST performs the
   * navigation. Absent ⇒ `InboxScreen` renders its rows disabled-with-reason
   * rather than clickable and silently inert, so passing this is what makes
   * the rows live.
   */
  onOpenEntity?: (id: EntityId) => void;
}

export function InboxView({ seam, onOpenEntity }: InboxViewProps) {
  const data = useInboxData(seam);
  return (
    <InboxScreen
      data={data}
      {...(onOpenEntity
        ? {
            onOpenNotification: (row: { target: { id: string } | null }) => {
              // A notification with no target has nowhere to go. Returning
              // early is honest; synthesizing a destination would send the
              // viewer somewhere the notification never pointed.
              if (!row.target) return;
              onOpenEntity(row.target.id as EntityId);
            },
          }
        : {})}
    />
  );
}
