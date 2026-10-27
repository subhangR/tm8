/**
 * The tab's side column (task 01a122b9): one column right of the entity body
 * holding Chat, Messages or Links. It is the chat dock's column, so it keeps
 * the dock's state — `ui.chat.open` per tab, `layout.chatWidth` shared — and
 * adds `ui.chat.section`. The body always shows the entity; Messages and Links
 * no longer replace it.
 */
import type { EntityTabRecord, SideSection, TabSubview, TabUi } from '../runtime/types';

/**
 * The section each tab last showed, kept on the client too. A node on a
 * contract from before `section` drops the field when it normalises the
 * stored workspace, and every ack rebuilds the store from that copy — a
 * column resize was enough to snap the column back to Chat. The record wins
 * when it carries the field; this only fills the gap.
 */
const lastSection = new Map<string, SideSection>();

/** The section showing, or null when the column is closed. */
export function openSideSection(tab: EntityTabRecord, chatAvailable: boolean): SideSection | null {
  if (!tab.ui.chat?.open) return null;
  const section = tab.ui.chat.section ?? lastSection.get(tab.id) ?? 'chat';
  /* A kind without chat falls back to Messages rather than an empty column. */
  return section === 'chat' && !chatAvailable ? 'messages' : section;
}

/**
 * The patch that shows `section`: opening the column on it, or — when it is
 * already the one showing and `toggle` — closing the column.
 */
export function sidePatch(
  tab: EntityTabRecord,
  section: SideSection,
  chatAvailable: boolean,
  toggle = true,
): Partial<TabUi> {
  const showing = openSideSection(tab, chatAvailable);
  if (toggle && showing === section) return { chat: { open: false } };
  lastSection.set(tab.id, section);
  return { chat: { open: true, section } };
}

/** The old full-page subviews, read as the side section they became. */
export function sideSectionOfSubview(subview: TabSubview): SideSection | null {
  return subview === 'connections' ? 'links' : subview === 'messages' ? 'messages' : null;
}
