/**
 * `EntityChatSlot` — THE HOST for the chat slot: reads `PanelState.chat` from
 * the route, the chats about its subject from the seam, and draws
 * `EntityChatPanel` with the solo chat surface as its body.
 *
 * THIS is what a layout places (design 01a0da4e §3.1). Home's third column,
 * the <1200px overlay, Work's centre and the phone sheet each mount this one
 * component in their own container; none of them re-derives the slot, the
 * switcher list, or the body. Renders nothing while no slot is open, so a
 * layout can mount it unconditionally and style the container on
 * `useChatSlot() !== null`.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { EntityId } from '@tm8/contract';
import { getKind } from '../domain';
import type { ChatSlot } from '../routes';
import { navStore, selectChatSlot, useNavStore } from '../stores/navStore';
import { entityChatSurfaceFor, type EntityChatSurfaceHost } from '../views/conversationSurface';
import { EntityChatPanel, type EntityChatSubject } from './EntityChatPanel';
import { useChatsAbout } from './chatsAbout';

/** The open slot, or `null`. The ONE subscription every slot host makes. */
export function useChatSlot(): ChatSlot | null {
  return useNavStore(selectChatSlot);
}

export interface EntityChatSlotProps extends EntityChatSurfaceHost {
  /**
   * The subject's title and kind when the host already holds it (GateData's
   * `detailOf`). Absent or a miss ⇒ one `seam.entity` read.
   */
  subjectOf?: ((id: EntityId) => { title: string; kind: string } | undefined) | undefined;
  /** The switcher's teammate names. */
  teammateLabel?: ((id: EntityId) => string | null) | undefined;
  /** The subject chip's press — "open it" means something different per layout. */
  onOpenSubject?: ((id: EntityId) => void) | undefined;
  /**
   * LANE C'S SEAM — the new-chat settings card (§3.4). Called only while the
   * thread is `new`, with the composer this slot would otherwise render; the
   * return value is what the panel body shows. A gate that wants the card
   * FIRST renders the card and withholds the composer until "Start chat".
   * Absent ⇒ the composer renders straight away.
   */
  newChatGate?: ((composer: ReactNode, subject: { id: EntityId; kind: string | null }) => ReactNode) | undefined;
}

function useSubject(
  seam: EntityChatSlotProps['seam'],
  about: EntityId | null,
  subjectOf: EntityChatSlotProps['subjectOf'],
): { title: string; kind: string } | null {
  const held = about ? subjectOf?.(about) : undefined;
  const [read, setRead] = useState<{ id: EntityId; title: string; kind: string } | null>(null);
  useEffect(() => {
    if (!about || held) return;
    let live = true;
    seam.entity(about).then(
      (detail) => { if (live) setRead({ id: about, title: detail.title, kind: detail.kind }); },
      () => { /* The chip keeps its placeholder; the chat itself still works. */ },
    );
    return () => { live = false; };
  }, [seam, about, held]);
  if (held) return held;
  return read && read.id === about ? { title: read.title, kind: read.kind } : null;
}

export function EntityChatSlot({
  subjectOf,
  teammateLabel,
  onOpenSubject,
  newChatGate,
  ...host
}: EntityChatSlotProps) {
  const slot = useChatSlot();
  const about = slot?.about ?? null;
  const { chats } = useChatsAbout(host.seam, about);
  const known = useSubject(host.seam, about, subjectOf);
  if (!slot) return null;

  const subject: EntityChatSubject = {
    id: slot.about,
    title: known?.title ?? null,
    glyph: known ? getKind(known.kind).chip.glyph : undefined,
  };
  const select = (thread: EntityId | 'new') => navStore.getState().setChatThread(thread);
  const surface = entityChatSurfaceFor(slot.about, slot.thread, host, select);
  const body = slot.thread === 'new' && newChatGate
    ? newChatGate(surface, { id: slot.about, kind: known?.kind ?? null })
    : surface;

  return (
    <EntityChatPanel
      /* A different subject is a different panel: nothing typed or chosen for
         one entity may carry over to the next. */
      key={slot.about}
      slot={slot}
      subject={subject}
      chats={chats}
      teammateLabel={teammateLabel}
      onOpenSubject={onOpenSubject}
      onSelectThread={select}
      onClose={() => navStore.getState().closeChat()}
    >
      {body}
    </EntityChatPanel>
  );
}
