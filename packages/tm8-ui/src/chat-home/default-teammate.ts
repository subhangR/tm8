import { HOUSE_TEAMMATE_NAMES, type ChatMode } from '@tm8/contract';
import type { ChatTeammateOption } from './types';

/**
 * THE TEAMMATE A CRAFT CHAT OR SESSION STARTS WITH: the seeded Crafter, whose
 * whole job is a craft's pages and workspace. The Graph Architect held this
 * seat before the Crafter existed and is the fallback for a space that has
 * not been re-seeded yet. By NAME, because that is how the roster is seeded —
 * a space whose owner renamed or deleted both gets null.
 */
export function craftTeammateId(teammates: readonly { id: string; label: string }[]): string | null {
  for (const name of [HOUSE_TEAMMATE_NAMES.crafter, HOUSE_TEAMMATE_NAMES.graphArchitect]) {
    const found = teammates.find((teammate) => teammate.label === name);
    if (found) return found.id;
  }
  return null;
}

/**
 * THE TEAMMATE A NEW CHAT STARTS WITH, before the viewer picks one.
 *
 * In order: the teammate this chat was seeded with (a remembered or handed-in
 * pick) while the space still has it; in a Craft chat, the Crafter
 * (`craftTeammateId`); otherwise the first teammate listed.
 */
export function defaultChatTeammateId(
  teammates: readonly ChatTeammateOption[],
  opts: { seeded?: string | null; pinnedMode?: ChatMode },
): string {
  if (opts.seeded && teammates.some((teammate) => teammate.id === opts.seeded)) return opts.seeded;
  if (opts.pinnedMode === 'craft') {
    const crafter = craftTeammateId(teammates);
    if (crafter) return crafter;
  }
  return teammates[0]?.id ?? '';
}
