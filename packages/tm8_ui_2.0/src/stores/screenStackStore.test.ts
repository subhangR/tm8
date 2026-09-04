import { beforeEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import {
  MAX_DEPTH,
  screenKeyOf,
  screenStackStore,
  stackOf,
  topOf,
} from './screenStackStore';

/**
 * THE DEFECT UNDER TEST (user report, 2026-07-31): opening an entity and then
 * switching rail items lost the entity entirely, on every detail screen. The
 * cause was component-local `useState` in views that GateApp UNMOUNTS on a
 * switch — so these tests are about one property above all others: the stack
 * is a fact about a SCREEN, not about a mounted component, and nothing here
 * may depend on a React lifecycle.
 *
 * The other property with teeth is ISOLATION. Every channel and every kind
 * owns its own stack (user ruling), which is what makes the old hand-enforced
 * "don't carry a doc into the Tasks screen" rule structural.
 */

const id = (n: string) => n as EntityId;
const DOCS = screenKeyOf.kind('doc');
const TASKS = screenKeyOf.kind('task');

beforeEach(() => {
  screenStackStore.getState().clearAll();
});

const state = () => screenStackStore.getState();

describe('a stack per screen', () => {
  it('remembers what a screen had open, with no component involved', () => {
    state().open(DOCS, id('d1'));
    // No render, no mount, no unmount anywhere in this test — which is the
    // whole point: unmounting the view can no longer destroy the selection.
    expect(topOf(state(), DOCS)).toBe('d1');
  });

  it('an untouched screen is empty, which is what shows the attention page', () => {
    expect(topOf(state(), DOCS)).toBeNull();
    expect(stackOf(state(), DOCS)).toEqual([]);
  });

  it('keeps screens isolated, so a doc can never surface in the Tasks view', () => {
    state().open(DOCS, id('d1'));
    state().open(TASKS, id('t1'));

    expect(topOf(state(), DOCS)).toBe('d1');
    expect(topOf(state(), TASKS)).toBe('t1');
  });

  it('gives every channel its own stack, not one shared channels stack', () => {
    const design = screenKeyOf.channel('c-design');
    const random = screenKeyOf.channel('c-random');
    state().open(design, id('m1'));
    state().open(random, id('m2'));

    expect(topOf(state(), design)).toBe('m1');
    expect(topOf(state(), random)).toBe('m2');
  });

  it('does not confuse a kind and a channel that share a name', () => {
    state().open(screenKeyOf.kind('design'), id('k1'));
    state().open(screenKeyOf.channel('design'), id('c1'));
    expect(topOf(state(), screenKeyOf.kind('design'))).toBe('k1');
    expect(topOf(state(), screenKeyOf.channel('design'))).toBe('c1');
  });
});

describe('going back', () => {
  it('pops to the entity the current one was opened from', () => {
    state().open(DOCS, id('a'));
    state().open(DOCS, id('b'));
    expect(stackOf(state(), DOCS)).toEqual(['a', 'b']);

    state().pop(DOCS);
    expect(topOf(state(), DOCS)).toBe('a');
  });

  it('pops from a single entry to empty — the old Esc behaviour, unchanged', () => {
    state().open(DOCS, id('a'));
    state().pop(DOCS);
    expect(topOf(state(), DOCS)).toBeNull();
  });

  it('popping an empty stack is a no-op, not an error', () => {
    expect(() => state().pop(DOCS)).not.toThrow();
    expect(topOf(state(), DOCS)).toBeNull();
  });

  it('re-opening what is already open is not a navigation', () => {
    state().open(DOCS, id('a'));
    state().open(DOCS, id('a'));
    expect(stackOf(state(), DOCS)).toEqual(['a']);
  });

  it('revisiting truncates rather than stacking a duplicate', () => {
    // A→B→A leaves [a]. Otherwise Esc from there would land on a B the user
    // had already backed out of, and a cycle would grow the stack forever.
    state().open(DOCS, id('a'));
    state().open(DOCS, id('b'));
    state().open(DOCS, id('a'));
    expect(stackOf(state(), DOCS)).toEqual(['a']);
  });

  it('bounds depth by dropping the oldest entry', () => {
    for (let i = 0; i < MAX_DEPTH + 10; i += 1) state().open(DOCS, id(`e${i}`));
    const stack = stackOf(state(), DOCS);
    expect(stack).toHaveLength(MAX_DEPTH);
    // The newest is kept and the oldest is what went.
    expect(stack[stack.length - 1]).toBe(`e${MAX_DEPTH + 9}`);
    expect(stack[0]).toBe('e10');
  });
});

describe('clearing', () => {
  it('clear empties one screen and leaves the others alone', () => {
    state().open(DOCS, id('d1'));
    state().open(TASKS, id('t1'));
    state().clear(DOCS);

    expect(topOf(state(), DOCS)).toBeNull();
    expect(topOf(state(), TASKS)).toBe('t1');
  });

  it('clearAll empties every screen, because entity ids are space-scoped', () => {
    /*
     * THE BUG THIS PREVENTS: this store is module-level, so it survives the
     * remount that a space or server switch causes. Left alone, the Docs
     * screen in the NEW space would restore a doc id belonging to the OLD
     * one — a detail panel confidently showing a foreign entity. GateApp
     * calls this wherever it already wipes navStore.
     */
    state().open(DOCS, id('d1'));
    state().open(screenKeyOf.channel('c1'), id('m1'));
    state().clearAll();

    expect(topOf(state(), DOCS)).toBeNull();
    expect(topOf(state(), screenKeyOf.channel('c1'))).toBeNull();
  });
});

describe('subscribers', () => {
  it('notifies on open and pop, so a mounted screen re-renders', () => {
    let seen = 0;
    const unsubscribe = screenStackStore.subscribe(() => {
      seen += 1;
    });
    state().open(DOCS, id('a'));
    state().pop(DOCS);
    unsubscribe();
    expect(seen).toBe(2);
  });

  it('does not notify when nothing changed', () => {
    state().open(DOCS, id('a'));
    let seen = 0;
    const unsubscribe = screenStackStore.subscribe(() => {
      seen += 1;
    });
    state().open(DOCS, id('a')); // already on top
    state().pop(TASKS); // empty
    state().clear(TASKS); // absent
    unsubscribe();
    expect(seen).toBe(0);
  });
});
