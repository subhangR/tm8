/**
 * `src/entity-chat/` — a chat ABOUT one entity, beside the entity (design
 * 01a0da4e). The public surface the layout lanes place:
 *
 *   · `EntityChatSlot` — the host; mount it in a layout's own container.
 *   · `useChatSlot`    — is a slot open (style the container on it).
 *   · `surfaceHostsChatSlot` — flip it for a view that hosts the slot itself.
 *   · `EntityChatDock` — the interim sheet the shell mounts for the rest.
 *
 * The stylesheet is imported HERE and only here: a deep-path import of a
 * component in this directory renders it unstyled.
 */
import './entity-chat.css';

export { EntityChatPanel, switcherCaption } from './EntityChatPanel';
export type { EntityChatPanelProps, EntityChatSubject } from './EntityChatPanel';
export { EntityChatSlot, useChatSlot } from './EntityChatSlot';
export type { EntityChatSlotProps } from './EntityChatSlot';
export { EntityChatDock } from './EntityChatDock';
export type { EntityChatDockProps } from './EntityChatDock';
export { chatSlotFor, openEntityChat, surfaceHostsChatSlot } from './openEntityChat';
export { chatsAboutFrom, eventTouchesChatsAbout, readChatsAbout, useChatsAbout } from './chatsAbout';
export type { ChatAboutRow, ChatsAbout, ChatsAboutSeam } from './chatsAbout';
export { WithChatCounts, useChatCounts } from './chatCounts';
export type { PrimaryCounts } from './chatCounts';
