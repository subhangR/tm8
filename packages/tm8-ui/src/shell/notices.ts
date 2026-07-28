/**
 * The notice queue (LLD §4.3) — ONE vocabulary, ONE queue.
 *
 * Owns three things that would otherwise grow three dialects: the R4-7 URL
 * overflow notice, command failures, and panel demotion notices.
 *
 * The T1-4 canvas is binding on behavior as well as pixels: bottom-center, 6s,
 * and **never stacks** — "counts aggregate into one card". So this is not a
 * toast list. It is a queue with a single visible card, and a repeated notice
 * of the same class UPDATES the live card rather than piling a second one on.
 */
import type { EntityId } from '@tm8/contract';

/** T1-4 draws one glyph and one tone for this family: wait-amber, never block-red. */
export type NoticeTone = 'warn' | 'error';

export interface Notice {
  id: string;
  tone: NoticeTone;
  /** Bold line — WHAT happened. */
  title: string;
  /** Plain-language line — WHICH state, in class names, never raw ids. */
  body: string;
  /** Milliseconds before auto-dismiss; T1-4 says 6s. */
  ttlMs: number;
}

export const NOTICE_TTL_MS = 6000;

/**
 * R4-7's class vocabulary. The rule is that a dropped-state notice names the
 * CLASS of state that was lost and never a raw id — a viewer cannot act on
 * `ent_01H8…`, and printing one leaks identifiers into a shareable surface.
 */
export type DroppedClass = 'tab' | 'surface' | 'pin' | 'panel' | 'filter';

const CLASS_NOUNS: Record<DroppedClass, [singular: string, plural: string]> = {
  tab: ['tab', 'tabs'],
  surface: ['surface', 'surfaces'],
  pin: ['pinned panel', 'pinned panels'],
  panel: ['panel', 'panels'],
  filter: ['filter', 'filters'],
};

/** "2 pinned panels and 1 filter weren't carried in this link." (T1-4 copy.) */
export function describeDropped(dropped: Partial<Record<DroppedClass, number>>): string | null {
  const parts = (Object.keys(CLASS_NOUNS) as DroppedClass[])
    .map((key) => [key, dropped[key] ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${CLASS_NOUNS[key][count === 1 ? 0 : 1]}`);

  if (parts.length === 0) return null;
  const list =
    parts.length === 1
      ? parts[0]
      : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${list} weren't carried in this link.`;
}

export function overflowNotice(dropped: Partial<Record<DroppedClass, number>>): Notice | null {
  const body = describeDropped(dropped);
  if (!body) return null;
  return {
    // Stable id per class — a second overflow REPLACES the card rather than
    // stacking a duplicate (T1-4: "never stacks").
    id: 'route-overflow',
    tone: 'warn',
    title: 'Link restored partially',
    body,
    ttlMs: NOTICE_TTL_MS,
  };
}

/**
 * §5.3 demotion notice. Like the overflow notice it names a count, not ids —
 * the viewer's question is "how many did I lose", and the panels themselves are
 * on the stack where they can be seen.
 */
export function demotionNotice(demoted: readonly EntityId[]): Notice | null {
  if (demoted.length === 0) return null;
  return {
    id: 'panel-demotion',
    tone: 'warn',
    title: demoted.length === 1 ? 'A pinned panel was unpinned' : 'Pinned panels were unpinned',
    body:
      `${demoted.length} pinned ${demoted.length === 1 ? 'panel' : 'panels'} moved to the stack — ` +
      'the center needs 320px per column. Widening does not restore them; re-pin when there is room.',
    ttlMs: NOTICE_TTL_MS,
  };
}
