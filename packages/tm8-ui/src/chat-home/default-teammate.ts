import { HOUSE_TEAMMATE_NAMES, type ChatMode } from '@tm8/contract';
import type { ChatTeammateOption } from './types';

/**
 * THE TEAMMATE A NEW CHAT STARTS WITH, before the viewer picks one.
 *
 * In order: the teammate this chat was seeded with (a remembered or handed-in
 * pick) while the space still has it; in a Craft chat, the seeded Graph
 * Architect, because a blueprint is that role's whole job; otherwise the first
 * teammate listed. By NAME, because that is how the roster is seeded — a space
 * whose owner renamed or deleted the Graph Architect falls through to the
 * first teammate rather than to nobody.
 */
export function defaultChatTeammateId(
  teammates: readonly ChatTeammateOption[],
  opts: { seeded?: string | null; pinnedMode?: ChatMode },
): string {
  if (opts.seeded && teammates.some((teammate) => teammate.id === opts.seeded)) return opts.seeded;
  if (opts.pinnedMode === 'craft') {
    const architect = teammates.find((teammate) => teammate.label === HOUSE_TEAMMATE_NAMES.graphArchitect);
    if (architect) return architect.id;
  }
  return teammates[0]?.id ?? '';
}
