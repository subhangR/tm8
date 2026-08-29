/**
 * The defect under test, in the owner's words: "switching back from remote
 * server to local server doesn't remember the space — it goes back to the first
 * space every time. Not just the space, the view on the space too."
 *
 * The store is what makes remembering possible; the two callers (useGateData's
 * boot pick, GateApp's restore) consult it. These cases pin the properties they
 * depend on — per-node isolation, per-space views, and never crashing boot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearLastPlace,
  readLastSpace,
  readLastTarget,
  writeLastSpace,
  writeLastTarget,
} from './last-place';

/**
 * An in-memory localStorage. The runner's ambient one is Node's own, which is
 * missing `clear` — cases would otherwise read the previous case's writes.
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

describe('the remembered space', () => {
  it('survives the round trip that used to lose it', () => {
    writeLastSpace('local', 'space-b');
    expect(readLastSpace('local')).toBe('space-b');
  });

  it('is null for a node never visited, so boot falls back to the first space', () => {
    expect(readLastSpace('_v2_server-connections_utho_proxy')).toBeNull();
  });

  it('is PER NODE — a space id from one node means nothing on another', () => {
    writeLastSpace('local', 'space-b');
    writeLastSpace('_v2_server-connections_utho_proxy', 'space-z');
    expect(readLastSpace('local')).toBe('space-b');
    expect(readLastSpace('_v2_server-connections_utho_proxy')).toBe('space-z');
  });
});

describe('the remembered view', () => {
  it('is kept per space, so A→B→A restores A and not B', () => {
    writeLastTarget('local', 'space-a', { type: 'kind', ref: 'doc' });
    writeLastTarget('local', 'space-b', { type: 'view', ref: 'graph' });
    expect(readLastTarget('local', 'space-a')).toEqual({ type: 'kind', ref: 'doc' });
    expect(readLastTarget('local', 'space-b')).toEqual({ type: 'view', ref: 'graph' });
  });

  it('does not disturb the remembered space it shares a record with', () => {
    writeLastSpace('local', 'space-a');
    writeLastTarget('local', 'space-a', { type: 'entity', ref: 'chan-1', kind: 'channel' });
    expect(readLastSpace('local')).toBe('space-a');
    expect(readLastTarget('local', 'space-a')).toEqual({
      type: 'entity',
      ref: 'chan-1',
      kind: 'channel',
    });
  });
});

describe('hostile storage never reaches boot', () => {
  it('ignores a corrupt record rather than throwing', () => {
    localStorage.setItem('tm8.last-place.v1.local', '{not json');
    expect(readLastSpace('local')).toBeNull();
    expect(readLastTarget('local', 'space-a')).toBeNull();
  });

  it('drops a target whose shape it no longer understands', () => {
    // An `entity` target without its kind would misroute the view region — the
    // branch that renders ChannelView tests the kind, so a half-record must be
    // discarded, not coerced.
    localStorage.setItem(
      'tm8.last-place.v1.local',
      JSON.stringify({ spaceId: 'space-a', targets: { 'space-a': { type: 'entity', ref: 'x' } } }),
    );
    expect(readLastSpace('local')).toBe('space-a');
    expect(readLastTarget('local', 'space-a')).toBeNull();
  });

  it('survives storage that throws on read', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled by policy');
      },
    });
    expect(readLastSpace('local')).toBeNull();
    expect(() => writeLastSpace('local', 'space-a')).not.toThrow();
  });
});

describe('what sign-out forgets', () => {
  /* A remembered place is a preference of the VIEWER and this module could not
     tell: the record outlived the pass, so the next person to sign in on this
     browser was restored into the last person's space and onto the last
     person's entity. `auth/session-reset.ts` calls this on an explicit
     sign-out. */
  it('drops the space and every remembered target for the node', () => {
    writeLastSpace('local', 'space-a');
    writeLastTarget('local', 'space-a', { type: 'entity', ref: 'ent-1', kind: 'task' });

    clearLastPlace('local');

    expect(readLastSpace('local')).toBeNull();
    expect(readLastTarget('local', 'space-a')).toBeNull();
  });

  it('leaves another node’s memory intact, because sign-out is per server', () => {
    writeLastSpace('local', 'space-a');
    writeLastSpace('remote-1', 'space-z');

    clearLastPlace('local');

    expect(readLastSpace('local')).toBeNull();
    expect(readLastSpace('remote-1')).toBe('space-z');
  });

  it('survives storage that throws on read', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled by policy');
      },
    });
    expect(() => clearLastPlace('local')).not.toThrow();
  });
});
