/**
 * THE PHONE DRAWER'S TREE SECTIONS (drawer mockup v3, task 01a14ccc).
 *
 * Top to bottom the drawer draws ＋ New chat, then these kinds as collapsible
 * trees, then the pinned kinds. The order is the mockup's: Chats first because
 * it is what a reader returns to, then the three populations a phone reader
 * acts on — sessions, docs, tasks.
 *
 * WHY THIS LIVES IN `domain/`: §15.2 makes a kind literal outside `domain/` a
 * build failure, and the drawer must not spell kinds. Same precedent as
 * `HOME_QUICK_BIRTH_KINDS` beside it.
 */
import { CHATS_ROOT_LIST_KIND } from './home-rail';
import { collectionKinds } from './registry';
import type { KindConfig } from './types';

/** The kinds the drawer always draws as trees, in order. */
export const DRAWER_TREE_KINDS: readonly string[] = [CHATS_ROOT_LIST_KIND, 'work_session', 'doc', 'task'];

/**
 * The tree kinds resolved against the live registry. A kind this node does not
 * register is skipped rather than drawn as an empty section.
 */
export function drawerTreeKinds(): KindConfig[] {
  const byKind = new Map<string, KindConfig>(collectionKinds().map((config) => [config.kind, config]));
  return DRAWER_TREE_KINDS.flatMap((kind) => {
    const config = byKind.get(kind);
    return config ? [config] : [];
  });
}

/**
 * Is this the conversation kind? Its rows open in the chat screen, and its
 * See all opens the conversation list rather than the kind's list route.
 */
export function isDrawerChatKind(kind: string): boolean {
  return kind === CHATS_ROOT_LIST_KIND;
}
