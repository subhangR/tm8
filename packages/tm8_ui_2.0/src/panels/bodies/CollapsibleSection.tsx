import { useEffect, useId, useRef, useSyncExternalStore, type ReactNode } from 'react';
import './collapsible-section.css';

/**
 * THE FOLD PRIMITIVE — a hairline section row that expands in place.
 *
 * A collapsed section is ONE line: caret, uppercase label, right-aligned
 * count, a thin top rule. No card, no box around the content. The `<section>`
 * keeps its `data-testid` even while collapsed, so nothing a test (or a
 * reader) navigates by disappears when the fold closes.
 *
 * EMPTINESS (approved design, 2026-08-16): a fold whose `empty` prop is true
 * collapses OUT OF THE FLOW entirely and is re-revealed by the body's single
 * one quiet empty-sections reveal. Critically, a section whose only content is a
 * disabled-with-reason affordance must NOT be marked empty by its caller —
 * hiding a refusal hides its reason, which is the exact failure the honesty
 * rules exist to prevent. That judgement is the CALLER's, made where the data
 * is; this primitive only obeys the verdict it is handed.
 *
 * PERSISTENCE is per section id, GLOBAL — not per entity. Expanding SUBTREE
 * once keeps it expanded on every task until it is collapsed again.
 * `defaultOpen` applies only until the user touches the fold.
 */

export interface CollapsibleSectionProps {
  /** Stable key, used for persistence (e.g. 'subtree', 'acceptance'). */
  id: string;
  /** Uppercase eyebrow text. */
  label: string;
  /** Right-aligned count / summary. */
  count?: ReactNode;
  /** No data rows. A live-but-unused affordance still counts as empty; a
      disabled-with-reason affordance NEVER does — see the header. */
  empty: boolean;
  defaultOpen?: boolean;
  /** Keeps the existing data-testid on the `<section>`. */
  testId?: string;
  children: ReactNode;
}

// ---------------------------------------------------------------------------
// Fold-state store — localStorage-backed, module-level, shared by every fold.
//
// `try/catch` on every storage touch: private mode and SSR both throw, and a
// fold that cannot persist must still fold. The in-memory map is the fallback
// for exactly that case; when storage works it is not consulted, so clearing
// localStorage (tests do) genuinely resets the state.
// ---------------------------------------------------------------------------

const FOLD_KEY_PREFIX = 'tm8.panel.fold.';
const EMPTY_REVEAL_KEY = 'tm8.panel.fold.__empty';

const fallback = new Map<string, string>();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

function readRaw(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return fallback.get(key) ?? null;
  }
}

function writeRaw(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    fallback.set(key, value);
  }
  notify();
}

/** Test seam: clears the in-memory fallback used where storage is absent. */
export function resetFoldStateForTests(): void {
  fallback.clear();
  notify();
}

/** Open/closed for one fold id; `defaultOpen` holds until the user touches it. */
export function useFoldState(id: string, defaultOpen: boolean): [boolean, () => void] {
  const stored = useSyncExternalStore(
    subscribe,
    () => readRaw(FOLD_KEY_PREFIX + id),
    () => null,
  );
  const open = stored == null ? defaultOpen : stored === 'open';
  const toggle = () => writeRaw(FOLD_KEY_PREFIX + id, open ? 'closed' : 'open');
  return [open, toggle];
}

/** Whether the empty-sections reveal is on. Global, like fold state. */
export function useEmptySectionsRevealed(): boolean {
  const stored = useSyncExternalStore(
    subscribe,
    () => readRaw(EMPTY_REVEAL_KEY),
    () => null,
  );
  return stored === 'shown';
}

export function toggleEmptySections(currentlyRevealed: boolean): void {
  writeRaw(EMPTY_REVEAL_KEY, currentlyRevealed ? 'hidden' : 'shown');
}

// ---------------------------------------------------------------------------
// Empty-section registry — how the ONE toggle knows its N. Sections register
// their emptiness on mount (folds do it via this primitive; the runs strip and
// the attachment strip do it themselves), and the toggle in `SubtreeBody`
// subscribes to the count. Keyed per MOUNT, not per id, so two panels showing
// the same section ids cannot corrupt each other's bookkeeping.
// ---------------------------------------------------------------------------

const emptyRegistry = new Map<object, boolean>();

export function useRegisterEmptySection(empty: boolean): void {
  const key = useRef<Record<string, never>>({});
  useEffect(() => {
    emptyRegistry.set(key.current, empty);
    notify();
    const owned = key.current;
    return () => {
      emptyRegistry.delete(owned);
      notify();
    };
  }, [empty]);
}

export function useEmptySectionCount(): number {
  return useSyncExternalStore(
    subscribe,
    () => {
      let n = 0;
      for (const empty of emptyRegistry.values()) if (empty) n += 1;
      return n;
    },
    () => 0,
  );
}

/**
 * The ONE quiet line that reveals every empty section in a body. It lives HERE
 * rather than in any one body because the registry it reads is module-level and
 * shared: every archetype that folds needs exactly this line, and a second copy
 * would be a second vocabulary for the same fact. Rendered only while something
 * is actually hidden or hideable, so a fully-populated entity carries no toggle.
 */
export function EmptySectionsToggle() {
  const count = useEmptySectionCount();
  const revealed = useEmptySectionsRevealed();
  if (count === 0) return null;
  return (
    <button
      type="button"
      className="pn-emptytoggle"
      data-testid="empty-sections-toggle"
      aria-expanded={revealed}
      aria-label={`${revealed ? 'Hide' : 'Show'} ${count} empty ${count === 1 ? 'section' : 'sections'}`}
      onClick={() => toggleEmptySections(revealed)}
    >
      {revealed ? 'Hide empty sections' : 'Show empty sections'}
    </button>
  );
}

// ---------------------------------------------------------------------------

export function CollapsibleSection({
  id,
  label,
  count,
  empty,
  defaultOpen = false,
  testId,
  children,
}: CollapsibleSectionProps) {
  const [open, toggle] = useFoldState(id, defaultOpen);
  const revealed = useEmptySectionsRevealed();
  useRegisterEmptySection(empty);
  const uid = useId();

  // Out of the flow entirely — the empty-sections toggle brings it back,
  // in its normal order. (Hooks above run regardless, so the registry knows.)
  if (empty && !revealed) return null;

  const headId = `${uid}-head`;
  const bodyId = `${uid}-body`;

  return (
    <section
      className="pn-fold"
      data-testid={testId}
      data-fold={id}
      data-empty={empty ? 'true' : 'false'}
    >
      <button
        type="button"
        className="pn-fold__head"
        id={headId}
        aria-expanded={open}
        /* The body is rendered only while open, so a closed fold's
           `aria-controls` names an element that is not in the document — a
           relationship a screen reader announces and then cannot follow, and
           the render gate's `controls-nothing`. `aria-expanded` is the whole of
           what a closed disclosure has to say. */
        aria-controls={open ? bodyId : undefined}
        onClick={toggle}
      >
        <span className={open ? 'pn-fold__caret pn-fold__caret--open' : 'pn-fold__caret'} aria-hidden>
          ▸
        </span>
        <span className="pn-fold__label">{label}</span>
        <span className="pn-fold__spacer" />
        {count != null ? <span className="pn-fold__count">{count}</span> : null}
      </button>
      {open ? (
        <div className="pn-fold__body" id={bodyId} role="region" aria-labelledby={headId}>
          {children}
        </div>
      ) : null}
    </section>
  );
}
