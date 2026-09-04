// @vitest-environment jsdom
/**
 * The launch recents — the order the teammate picker offers personas in.
 *
 * The cases that matter are the ones about ORDER SEMANTICS and about the
 * failure modes that are silent: a duplicate that ranks one id twice, a cap
 * that drops the wrong end, a storage that throws, and a sign-out that leaves
 * one viewer's launches ranking the next viewer's picker.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLaunchRecents,
  readLaunchRecents,
  rememberLaunchPick,
} from './launch-recents';

/**
 * An in-memory localStorage, for the reason `launch-cache.test.ts` gives: the
 * runner's ambient one is Node's own and is missing `clear`, so cases would
 * leak into each other and a stale order would read as this case's answer.
 */
beforeEach(() => {
  const map = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => [...map.keys()][i] ?? null,
      get length() {
        return map.size;
      },
    },
  });
});

describe('round trip', () => {
  it('persists a pick so the next boot ranks it', () => {
    rememberLaunchPick('local', 'space-1', 't1');
    expect(readLaunchRecents('local', 'space-1')).toEqual(['t1']);
  });

  it('returns [] when nothing was written — never null', () => {
    // The caller feeds this straight to the ordering rule, which ranks nothing
    // and falls through to the alphabetical tail. A null would need a guard at
    // every call site to say the same thing.
    expect(readLaunchRecents('local', 'space-1')).toEqual([]);
  });

  it('hands back the new order rather than making the caller re-read', () => {
    const first = rememberLaunchPick('local', 'space-1', 't1');
    expect(rememberLaunchPick('local', 'space-1', 't2', first)).toEqual(['t2', 't1']);
  });
});

describe('most recent first, which is the entire point', () => {
  it('puts the newest pick at the head', () => {
    let order = rememberLaunchPick('local', 'space-1', 't1');
    order = rememberLaunchPick('local', 'space-1', 't2', order);
    order = rememberLaunchPick('local', 'space-1', 't3', order);
    expect(order).toEqual(['t3', 't2', 't1']);
  });

  it('MOVES a re-picked teammate to the front rather than leaving it in place', () => {
    // THREE entries, deliberately. With only two, a move-to-front and a plain
    // append collapse to the same answer under a first-wins dedupe, so a
    // two-entry case cannot tell a working implementation from a broken one —
    // it stayed green against the append mutant. Three separates them: t1 has
    // to jump over BOTH of the others.
    let order = rememberLaunchPick('local', 'space-1', 't1');
    order = rememberLaunchPick('local', 'space-1', 't2', order);
    order = rememberLaunchPick('local', 'space-1', 't3', order);
    expect(order).toEqual(['t3', 't2', 't1']);
    order = rememberLaunchPick('local', 'space-1', 't1', order);
    expect(order).toEqual(['t1', 't3', 't2']);
    // And it survives the round trip, not just the return value.
    expect(readLaunchRecents('local', 'space-1')).toEqual(['t1', 't3', 't2']);
  });

  it('drops the LEAST recent when the cap is reached, never the most recent', () => {
    let order: readonly string[] = [];
    for (let i = 0; i < 60; i += 1) order = rememberLaunchPick('local', 'space-1', `t${i}`, order);
    expect(order).toHaveLength(50);
    expect(order[0]).toBe('t59');
    // t0..t9 are the oldest ten and are the ten that went.
    expect(order).not.toContain('t0');
    expect(order).not.toContain('t9');
    expect(order).toContain('t10');
  });
});

describe('keys, and what must not cross them', () => {
  it('keeps two spaces apart — a persona is not launched "somewhere"', () => {
    rememberLaunchPick('local', 'space-1', 't1');
    rememberLaunchPick('local', 'space-2', 't2');
    expect(readLaunchRecents('local', 'space-1')).toEqual(['t1']);
    expect(readLaunchRecents('local', 'space-2')).toEqual(['t2']);
  });

  it('keeps two nodes apart — a named Server’s teammates are not this one’s', () => {
    rememberLaunchPick('local', 'space-1', 't1');
    rememberLaunchPick('_relay_abc', 'space-1', 't2');
    expect(readLaunchRecents('local', 'space-1')).toEqual(['t1']);
    expect(readLaunchRecents('_relay_abc', 'space-1')).toEqual(['t2']);
  });

  it('sign-out drops EVERY space under the node, and no other node', () => {
    rememberLaunchPick('local', 'space-1', 't1');
    rememberLaunchPick('local', 'space-2', 't2');
    rememberLaunchPick('_relay_abc', 'space-1', 't3');
    clearLaunchRecents('local');
    expect(readLaunchRecents('local', 'space-1')).toEqual([]);
    expect(readLaunchRecents('local', 'space-2')).toEqual([]);
    // Sign-out is per node; another node's order is not this sign-out's to drop.
    expect(readLaunchRecents('_relay_abc', 'space-1')).toEqual(['t3']);
  });
});

describe('nothing here may break a launch', () => {
  it('ignores a corrupt payload and REMOVES it, rather than throwing every boot', () => {
    localStorage.setItem('tm8.launch-recents.v1.local.space-1', '{not json');
    expect(readLaunchRecents('local', 'space-1')).toEqual([]);
    expect(localStorage.getItem('tm8.launch-recents.v1.local.space-1')).toBeNull();
  });

  it('ignores a payload of the wrong shape', () => {
    localStorage.setItem('tm8.launch-recents.v1.local.space-1', JSON.stringify({ ids: 'nope' }));
    expect(readLaunchRecents('local', 'space-1')).toEqual([]);
  });

  it('drops non-string entries rather than letting them reach a rank map', () => {
    localStorage.setItem(
      'tm8.launch-recents.v1.local.space-1',
      JSON.stringify({ savedAt: 'x', ids: ['t1', 42, null, '', 't2'] }),
    );
    expect(readLaunchRecents('local', 'space-1')).toEqual(['t1', 't2']);
  });

  it('dedupes a hand-written list first-wins, so no id ranks twice', () => {
    localStorage.setItem(
      'tm8.launch-recents.v1.local.space-1',
      JSON.stringify({ savedAt: 'x', ids: ['t1', 't2', 't1'] }),
    );
    expect(readLaunchRecents('local', 'space-1')).toEqual(['t1', 't2']);
  });

  it('still returns the right order when storage REFUSES the write', () => {
    // Private-mode Safari and a full quota both throw on setItem. The launch
    // succeeded; the order must be correct for this session even though it
    // will not survive the reload.
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => null,
        setItem: () => {
          throw new Error('QuotaExceededError');
        },
        removeItem: () => {},
        clear: () => {},
        key: () => null,
        length: 0,
      },
    });
    expect(() => rememberLaunchPick('local', 'space-1', 't2', ['t1'])).not.toThrow();
    expect(rememberLaunchPick('local', 'space-1', 't2', ['t1'])).toEqual(['t2', 't1']);
  });

  it('survives storage that throws on READ', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled by policy');
      },
    });
    expect(readLaunchRecents('local', 'space-1')).toEqual([]);
    expect(() => clearLaunchRecents('local')).not.toThrow();
  });

  it('records nothing for an empty teammate id', () => {
    expect(rememberLaunchPick('local', 'space-1', '', ['t1'])).toEqual(['t1']);
    expect(readLaunchRecents('local', 'space-1')).toEqual([]);
  });
});
