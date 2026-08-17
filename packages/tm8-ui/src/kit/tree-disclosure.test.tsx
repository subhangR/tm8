// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

import { ancestorPath, useTreeDisclosure } from './useTreeDisclosure';

/**
 * THE DEFAULT IS THE FEATURE. Every tree in this app used to hold a `collapsed`
 * set that started empty — default-open, which paints a whole workspace
 * hierarchy on arrival. The ruling (2026-08-17) inverted it, and these are the
 * tests that keep it inverted: the state is the viewer's own gestures, it is
 * remembered per scope, and nothing about it may make the current selection
 * unreachable.
 *
 * STORAGE IS STUBBED PER FILE, DELIBERATELY. `vite.config.ts` records the
 * measurement that under this runner `localStorage` is an object with no
 * `setItem`/`removeItem` at all — so a persistence test that trusted the ambient
 * global would silently assert nothing. The stub is installed and torn down
 * here; the LAST test then removes it entirely to prove the hook survives a
 * storage that throws, which is the shipped condition in private-mode Safari
 * and under this very runner.
 */

interface StubStore {
  storage: Storage;
  map: Map<string, string>;
}

function makeStore(): StubStore {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
  return { storage, map };
}

let store: StubStore;
const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function install(value: unknown): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value,
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  store = makeStore();
  install(store.storage);
});

afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'localStorage', original);
  else install(undefined);
});

/** A minimal consumer: one row per id, each with a toggle and a read-out. */
function Harness({ scope, ids, revealed }: { scope: string | null; ids: string[]; revealed?: ReadonlySet<string> }) {
  const disclosure = useTreeDisclosure(scope, revealed);
  return (
    <ul>
      {ids.map((id) => (
        <li key={id}>
          <button type="button" onClick={() => disclosure.toggle(id)}>
            {`toggle ${id}`}
          </button>
          <span data-testid={`state-${id}`}>{disclosure.isExpanded(id) ? 'open' : 'shut'}</span>
        </li>
      ))}
    </ul>
  );
}

/** Opens many rows in ONE click, and reads back only the two that matter. */
function BulkHarness({ scope, ids }: { scope: string; ids: string[] }) {
  const disclosure = useTreeDisclosure(scope);
  return (
    <div>
      <button type="button" onClick={() => ids.forEach((id) => disclosure.toggle(id))}>
        open all
      </button>
      <span data-testid={`state-${ids[0]}`}>{disclosure.isExpanded(ids[0]!) ? 'open' : 'shut'}</span>
    </div>
  );
}

describe('useTreeDisclosure', () => {
  it('starts with EVERY row shut — the default is collapsed, not remembered-open', () => {
    const view = render(<Harness scope="list:task" ids={['a', 'b', 'c']} />);
    for (const id of ['a', 'b', 'c']) {
      expect(view.getByTestId(`state-${id}`).textContent, id).toBe('shut');
    }
    // Nothing was written either: an untouched tree must not author storage.
    expect(store.map.size).toBe(0);
  });

  it('a toggle opens the row, and a second one shuts it again', () => {
    const view = render(<Harness scope="list:task" ids={['a']} />);
    fireEvent.click(view.getByText('toggle a'));
    expect(view.getByTestId('state-a').textContent).toBe('open');
    fireEvent.click(view.getByText('toggle a'));
    expect(view.getByTestId('state-a').textContent).toBe('shut');
  });

  it('MAINTAINS IT: what was opened is still open on the next mount', () => {
    const first = render(<Harness scope="list:task" ids={['a', 'b']} />);
    fireEvent.click(first.getByText('toggle a'));
    first.unmount();

    const second = render(<Harness scope="list:task" ids={['a', 'b']} />);
    expect(second.getByTestId('state-a').textContent).toBe('open');
    // …and only what was opened. `b` was never touched.
    expect(second.getByTestId('state-b').textContent).toBe('shut');
  });

  it('scopes are separate: opening in the side list says nothing about the wide tree', () => {
    const list = render(<Harness scope="list:task" ids={['a']} />);
    fireEvent.click(list.getByText('toggle a'));
    list.unmount();

    const tree = render(<Harness scope="tree:task" ids={['a']} />);
    expect(tree.getByTestId('state-a').textContent).toBe('shut');
  });

  it('a null scope keeps the state in memory — it toggles, it does not persist', () => {
    const first = render(<Harness scope={null} ids={['a']} />);
    fireEvent.click(first.getByText('toggle a'));
    expect(first.getByTestId('state-a').textContent).toBe('open');
    expect(store.map.size).toBe(0);
    first.unmount();

    const second = render(<Harness scope={null} ids={['a']} />);
    expect(second.getByTestId('state-a').textContent).toBe('shut');
  });

  it('caps what it remembers, keeping the NEWEST gestures', () => {
    const ids = Array.from({ length: 405 }, (_, i) => `row-${i}`);
    // ONE click that opens all 405. Clicking 405 separate rows re-renders 405
    // rows 405 times, which is O(n²) and times out under a parallel suite run
    // — the cap is about what `write` keeps, not about how the clicks arrive.
    const view = render(<BulkHarness scope="list:task" ids={ids} />);
    fireEvent.click(view.getByText('open all'));

    const stored: string[] = JSON.parse(store.map.get('tm8.tree.expanded.v1.list:task')!);
    expect(stored).toHaveLength(400);
    expect(stored).toContain('row-404');
    expect(stored).not.toContain('row-0');

    // The live mount is NOT truncated — the cap is about what survives a
    // reload, and silently shutting a row the viewer just opened would be a
    // gesture the app undid on its own.
    expect(view.getByTestId('state-row-0').textContent).toBe('open');
  });

  it('a revealed row reads as open but is NEVER written — a selection is not a gesture', () => {
    const view = render(
      <Harness scope="list:task" ids={['parent', 'other']} revealed={new Set(['parent'])} />,
    );
    expect(view.getByTestId('state-parent').textContent).toBe('open');
    expect(view.getByTestId('state-other').textContent).toBe('shut');
    expect(store.map.size, 'a reveal authored nothing').toBe(0);
  });

  it('garbage on the key reads as "nothing was opened" rather than throwing', () => {
    store.map.set('tm8.tree.expanded.v1.list:task', '{"not":"an array"}');
    const view = render(<Harness scope="list:task" ids={['a']} />);
    expect(view.getByTestId('state-a').textContent).toBe('shut');
  });

  it('SURVIVES A STORAGE THAT THROWS — the toggle still works, only its memory is lost', () => {
    // The shipped hazard, and this runner's own condition: an object that looks
    // like Storage and has neither method.
    install({} as Storage);
    const view = render(<Harness scope="list:task" ids={['a']} />);
    expect(view.getByTestId('state-a').textContent).toBe('shut');
    fireEvent.click(view.getByText('toggle a'));
    expect(view.getByTestId('state-a').textContent).toBe('open');
  });
});

describe('ancestorPath', () => {
  const rows = [
    { id: 'root', parentId: null },
    { id: 'mid', parentId: 'root' },
    { id: 'leaf', parentId: 'mid' },
    { id: 'orphan', parentId: 'gone' },
  ];

  it('is every ancestor of the selection, and never the selection itself', () => {
    expect([...ancestorPath(rows, 'leaf')].sort()).toEqual(['mid', 'root']);
    expect(ancestorPath(rows, 'leaf').has('leaf')).toBe(false);
  });

  it('is empty for a root, an unknown id, and no selection at all', () => {
    expect(ancestorPath(rows, 'root').size).toBe(0);
    expect(ancestorPath(rows, 'not-in-this-list').size).toBe(0);
    expect(ancestorPath(rows, null).size).toBe(0);
    expect(ancestorPath(rows, undefined).size).toBe(0);
  });

  it('stops at a parent that is not in this row set — the child roots itself there', () => {
    // Matches both tree builders: `orphan` renders at depth 0, so `gone` is not
    // an ancestor to open and must not be reported as one.
    expect(ancestorPath(rows, 'orphan').size).toBe(0);
  });

  it('terminates on a parent cycle instead of hanging the render', () => {
    const cyclic = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect([...ancestorPath(cyclic, 'a')].sort()).toEqual(['a', 'b']);
  });

  it('returns the SAME empty set every time, so a memo keyed on it does not churn', () => {
    expect(ancestorPath(rows, null)).toBe(ancestorPath(rows, 'root'));
  });
});
