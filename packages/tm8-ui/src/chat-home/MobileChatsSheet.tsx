import type { EntityId } from '@tm8/contract';
import { MobileSheet } from '../mobile';
import type { ChatThreadSummary } from './types';

/**
 * THE PHONE'S CONVERSATION INVENTORY — the desktop's left column, as a sheet.
 *
 * WHY IT IS A SHEET AND NOT A COLUMN. `ChatHomeScreen` puts its thread list in
 * a permanent 210–280px column beside the conversation. At 390px that column
 * has nowhere to be, so it collapsed ON TOP of the chat: a root header, a
 * search field and a thread list stacked above the composer, before a word of
 * the conversation. A phone has one surface (`MobileFrame`'s whole premise),
 * and the inventory is not it. The screen already has the seam for this —
 * `soloConversation`, which is what Craft passes when the HOST owns the thread
 * column — so this is the shell taking that offer rather than a second list.
 *
 * WHY IT IS ITS OWN FILE. `mobile/shell-contract.test.ts` scans `MobileShell`'s
 * SOURCE for `title=` (DEF-033: a `title` tooltip is unreachable on a device
 * with no hover, and the shell must not ship the pattern it asks the lanes to
 * remove). `MobileSheet`'s required `title` PROP is a different thing wearing
 * the same word, and a source scan cannot tell them apart. Rather than weaken
 * the guard — it has already caught a real defect in this file — the sheet
 * lives where `MobileAccountSheet` lives: beside the surface it belongs to.
 * Sheets in their own files is the shape this shell already had.
 */
export interface MobileChatsSheetProps {
  readonly threads: readonly ChatThreadSummary[];
  /** The open thread, so the list can say which row you are reading. */
  readonly selectedId: EntityId | null;
  readonly onSelect: (id: EntityId) => void;
  readonly onNew: () => void;
  readonly onDismiss: () => void;
}

export function MobileChatsSheet({
  threads,
  selectedId,
  onSelect,
  onNew,
  onDismiss,
}: MobileChatsSheetProps) {
  return (
    <MobileSheet title="Conversations" testId="mobile-chats-sheet" onDismiss={onDismiss}>
      <ul className="mchats">
        <li>
          <button type="button" className="mchats__new" onClick={onNew}>
            New conversation
          </button>
        </li>
        {threads.map((thread) => (
          <li key={thread.rootId}>
            <button
              type="button"
              className="mchats__row"
              aria-current={thread.rootId === selectedId ? 'true' : undefined}
              onClick={() => onSelect(thread.rootId)}
            >
              <span className="mchats__title">{thread.title}</span>
              <span className="mchats__preview">{thread.preview}</span>
            </button>
          </li>
        ))}
        {/* ABSENT IS NOT ZERO, and this row says which one it is. An empty list
            under a ☰ that opened is indistinguishable from a read that has not
            landed — and this surface has shipped exactly that confusion once
            already (the missing L2 bridge, which refused the read and blamed
            the node for it). */}
        {threads.length === 0 ? (
          <li className="mchats__empty">No conversations on this space yet.</li>
        ) : null}
      </ul>
    </MobileSheet>
  );
}
