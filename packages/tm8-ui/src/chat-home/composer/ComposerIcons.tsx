/**
 * THE COMPOSER'S ICONS — one set, drawn on `VectorIcon`'s 16×16 grid with a
 * 1.5 stroke in `currentColor` and round caps, so the toolbar, the ⚙ panel
 * and the model popover read as one family. They replace text glyphs and
 * emoji (⚙︎, 👥, ＋, ▾, ›) that each sat on their own font's baseline and drew
 * at a different weight from everything around them.
 */
import { VectorIcon } from '../../kit';

/** Path data by name; exported for tests and for any host that wants the raw art. */
export const COMPOSER_ICON_ART = {
  /** Settings — three slider rails with their knobs (deliberately not a gear). */
  sliders: [
    'M2 3.5h6.5', 'M12.5 3.5H14', 'M10.5 2a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3',
    'M2 8h1.5', 'M7.5 8H14', 'M5.5 6.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3',
    'M2 12.5h7.5', 'M13.5 12.5h.5', 'M11.5 11a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3',
  ],
  /** Team — two overlapping people, the second behind the first. */
  team: [
    'M6 3.25a2.25 2.25 0 1 1 0 4.5a2.25 2.25 0 1 1 0-4.5',
    'M1.75 13.25c0-2.4 1.9-4 4.25-4s4.25 1.6 4.25 4',
    'M10.25 2.6a2 2 0 1 1 .9 3.85',
    'M11.75 9.4c1.5.45 2.5 1.75 2.5 3.85',
  ],
  /** Worker — a hammer. */
  worker: ['M9.1 2.6l4.3 4.3-2 2-4.3-4.3z', 'M2.75 13.25l6.5-6.5'],
  /** Coordinator — a compass. */
  coordinator: ['M8 2a6 6 0 1 1 0 12a6 6 0 1 1 0-12', 'M10.6 5.4L9.1 9.1L5.4 10.6L6.9 6.9z'],
  /** Dispatcher — one source fanning out to three. */
  dispatcher: [
    'M2 8h4', 'M6 8l5.2-3.4', 'M6 8h5', 'M6 8l5.2 3.4',
    'M13 2.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3',
    'M13 6.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3',
    'M13 10.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3',
  ],
  plus: ['M8 3v10', 'M3 8h10'],
  chevronDown: ['M4.5 6.5L8 10l3.5-3.5'],
  chevronRight: ['M6.5 4.5L10 8l-3.5 3.5'],
  check: ['M3.5 8.5l3 3 6-7'],
  arrowUp: ['M8 13V3.5', 'M4 7.5l4-4 4 4'],
  search: ['M7 2.75a4.25 4.25 0 1 1 0 8.5a4.25 4.25 0 1 1 0-8.5', 'M10.25 10.25l3.25 3.25'],
  lock: ['M4 7.5h8v6H4z', 'M5.75 7.5v-2a2.25 2.25 0 0 1 4.5 0v2'],
  close: ['M4.5 4.5l7 7', 'M11.5 4.5l-7 7'],
} as const;

export type ComposerIconName = keyof typeof COMPOSER_ICON_ART;

export function ComposerIcon({ name, size = 16, className }: { name: ComposerIconName; size?: number; className?: string }) {
  return (
    <VectorIcon
      paths={COMPOSER_ICON_ART[name]}
      size={size}
      strokeWidth={1.5}
      className={['tch-icon', className].filter(Boolean).join(' ')}
    />
  );
}
