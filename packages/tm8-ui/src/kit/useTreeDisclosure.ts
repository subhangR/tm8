import { useCallback, useMemo, useState } from 'react';

/**
 * TREE DISCLOSURE STATE — COLLAPSED BY DEFAULT, AND REMEMBERED.
 *
 * USER RULING 2026-08-17: "Entity List Panel should be collapsed by default,
 * it's always showing expanded full tree… user can expand and it maintains
 * that and all, i think everywhere i see its expanded."
 *
 * WHY THIS FLIPS FROM A COLLAPSED SET TO AN EXPANDED SET. Both tree renderers
 * (`panels/EntityListPanel`'s `TreeRows` and `views/EntityTree`) previously
 * held a `collapsed: Set` that started EMPTY, which is default-open: a row that
 * was never touched renders its children, and so does a child that arrives
 * later from the event stream. Storing the OPEN rows inverts exactly that —
 * an untouched row, and every row that arrives later, is shut. The set is
 * therefore the user's gestures and nothing else, which is also what makes it
 * safe to persist: it never grows on its own.
 *
 * PERSISTENCE IS PER SCOPE, NOT GLOBAL. `scope` names the surface AND the kind
 * ("list:task", "tree:work_session"), because the side panel and the wide view
 * are two different places to be looking at the same rows, and opening a
 * subtree in one is not a statement about the other.
 *
 * THE SELECTED ROW IS NEVER HIDDEN. Disclosure is only half the story — the
 * caller passes `revealed`, the ancestor chain of whatever is currently
 * selected, and those rows read as expanded WITHOUT being written to storage.
 * Otherwise arriving on a deep child (a route, a click from Home, a spawn that
 * selects its new session) would land the viewer on a selection they cannot
 * see. A reveal is not a gesture, so it must not outlive the selection.
 *
 * EVERY STORAGE ACCESS IS GUARDED, for the reason `data/launch-cache` documents
 * and one more that is specific to the test runner: under this vitest
 * configuration `localStorage` is an object with NO `setItem`/`removeItem`
 * (vite.config.ts records the measurement), so the calls throw TypeError rather
 * than being absent. A disclosure toggle may never be able to fail the tree.
 */

/** Storage-key namespace. Versioned so a shape change cannot mis-parse. */
const KEY_PREFIX = 'tm8.tree.expanded.v1.';

/**
 * How many open rows survive a reload. A cap is needed because the set is
 * keyed by entity id and entities outlive the trees that showed them, so
 * without one this grows forever against a 5MB per-origin budget shared with
 * the launch cache. The newest gestures win — the tail being forgotten costs
 * one click on a subtree the viewer has not touched in a long time.
 */
const MAX_REMEMBERED = 400;

export interface TreeDisclosure {
  /** Does this row show its children right now? */
  isExpanded(id: string): boolean;
  /** Flip one row, and remember it. */
  toggle(id: string): void;
  /**
   * The rows the VIEWER has opened. Excludes reveals: this is the persisted
   * truth, which is what a consumer reasoning about the drawn shape (the
   * message-pulse router) must not confuse with a temporary path-to-selection.
   */
  expanded: ReadonlySet<string>;
}

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch {
    return null;
  }
}

function read(scope: string | null): ReadonlySet<string> {
  if (scope === null) return new Set();
  const store = storage();
  if (!store) return new Set();
  try {
    const raw = store.getItem(KEY_PREFIX + scope);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    // Structural check, not a cast: anything else on this key is another
    // build's shape, and a bad parse must read as "nothing was opened".
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === 'string'));
  } catch {
    return new Set();
  }
}

function write(scope: string | null, ids: ReadonlySet<string>): void {
  if (scope === null) return;
  const store = storage();
  if (!store) return;
  try {
    const list = [...ids];
    store.setItem(
      KEY_PREFIX + scope,
      JSON.stringify(list.length > MAX_REMEMBERED ? list.slice(list.length - MAX_REMEMBERED) : list),
    );
  } catch {
    // Private-mode Safari, a full quota, a disabled-storage policy, or this
    // runner's stub. The toggle already happened in React state; only its
    // memory is lost.
  }
}

/**
 * @param scope  Storage scope, e.g. `list:task`. `null` keeps the state in
 *               memory for this mount only — for a tree with no stable
 *               identity to remember against.
 * @param revealed  Ancestors of the current selection. Read as expanded, never
 *                  written.
 */
export function useTreeDisclosure(
  scope: string | null,
  revealed?: ReadonlySet<string>,
): TreeDisclosure {
  // Lazy initializer: one storage read per mount, not one per render.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => read(scope));

  const toggle = useCallback(
    (id: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        // Insertion order carries recency, which is what MAX_REMEMBERED trims
        // against — so a re-open moves the row to the end rather than keeping
        // its original position.
        if (next.has(id)) next.delete(id);
        else next.add(id);
        write(scope, next);
        return next;
      });
    },
    [scope],
  );

  return useMemo(
    () => ({
      expanded,
      toggle,
      isExpanded: (id: string) => expanded.has(id) || (revealed?.has(id) ?? false),
    }),
    [expanded, toggle, revealed],
  );
}

/**
 * The ancestor chain of `selectedId` within one flat row set — the rows that
 * must be open for the selection to be on screen. The selected row ITSELF is
 * not included: revealing a row means showing it, not opening its own subtree.
 *
 * Parent resolution matches both tree builders: a parent that is not in this
 * row set is not an ancestor here, because the child roots itself instead. The
 * `guard` makes a malformed parent cycle terminate rather than hang the render.
 */
export function ancestorPath(
  rows: readonly { id: string; parentId: string | null }[],
  selectedId: string | null | undefined,
): ReadonlySet<string> {
  if (!selectedId) return EMPTY_PATH;
  const parentOf = new Map(rows.map((row) => [row.id, row.parentId]));
  if (!parentOf.has(selectedId)) return EMPTY_PATH;
  const path = new Set<string>();
  let cursor = parentOf.get(selectedId) ?? null;
  while (cursor !== null && parentOf.has(cursor) && !path.has(cursor)) {
    path.add(cursor);
    cursor = parentOf.get(cursor) ?? null;
  }
  return path.size === 0 ? EMPTY_PATH : path;
}

/**
 * One shared empty set, so the common "nothing selected" case returns a stable
 * reference and does not re-run every `useMemo` keyed on `revealed` each render.
 */
const EMPTY_PATH: ReadonlySet<string> = new Set<string>();
