// @vitest-environment jsdom
/**
 * The launch-source cache — the half of "the pickers are empty" that was NOT
 * the missing prop. The option set had no existence independent of one in-
 * flight request, so every slow or failed boot read reopened an empty window.
 *
 * The tests that matter here are the ones about FORGETTING, not remembering.
 * A cache that only ever grows would offer personas the server has stopped
 * returning, forever, and that failure is silent and permanent.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import {
  CACHED_LAUNCH_KINDS,
  clearLaunchCache,
  nodeKeyOf,
  readLaunchCache,
  writeLaunchCache,
} from './launch-cache';

const teammate = (id: string, over: Partial<EntitySummary> = {}): EntitySummary =>
  ({
    id,
    spaceId: 'space-1',
    kind: 'team_member',
    title: id,
    parentId: null,
    position: 1,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-02T00:00:00.000Z',
    createdAt: '2026-08-02T00:00:00.000Z',
    updatedAt: '2026-08-02T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'm1', kind: 'member', displayName: 'Owner', avatar: null, isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: { kind: 'team_member', owner: { id: 'm1', kind: 'member', displayName: 'Owner', avatar: null, isAgent: false }, model: 'claude-opus-5', agentTool: 'claude-code', liveWork: null },
    badges: {},
    ...over,
  }) as unknown as EntitySummary;

/**
 * An in-memory localStorage. The runner's ambient one is Node's own, which is
 * missing `clear` — and a cache test that shares state between cases would
 * report the previous case's payload as this case's result.
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
  it('returns what was written, so the next boot can seed', () => {
    writeLaunchCache('local', 'space-1', [teammate('t1'), teammate('t2')]);
    expect(readLaunchCache('local', 'space-1')?.map((r) => r.id)).toEqual(['t1', 't2']);
  });

  it('returns null when nothing was ever written — never an empty array', () => {
    // The caller branches on null to decide whether to seed at all; an empty
    // array would be a claim that this space HAS no teammates.
    expect(readLaunchCache('local', 'space-1')).toBeNull();
  });
});

describe('it forgets, which is the whole risk', () => {
  it('REPLACES rather than merges, so a removed teammate stops being offered', () => {
    writeLaunchCache('local', 'space-1', [teammate('t1'), teammate('t2')]);
    writeLaunchCache('local', 'space-1', [teammate('t1')]);
    expect(readLaunchCache('local', 'space-1')?.map((r) => r.id)).toEqual(['t1']);
  });

  it('never stores a tombstone', () => {
    writeLaunchCache('local', 'space-1', [teammate('t1'), teammate('t2', { deletedAt: '2026-08-02T01:00:00.000Z' })]);
    expect(readLaunchCache('local', 'space-1')?.map((r) => r.id)).toEqual(['t1']);
  });

  it('clears the key when the set empties, leaving no stale payload behind', () => {
    writeLaunchCache('local', 'space-1', [teammate('t1')]);
    writeLaunchCache('local', 'space-1', []);
    expect(readLaunchCache('local', 'space-1')).toBeNull();
  });
});

describe('scoping — a picker must never offer another node’s or space’s personas', () => {
  it('separates spaces', () => {
    writeLaunchCache('local', 'space-1', [teammate('t1')]);
    expect(readLaunchCache('local', 'space-2')).toBeNull();
  });

  it('separates nodes', () => {
    writeLaunchCache('local', 'space-1', [teammate('t1')]);
    expect(readLaunchCache(nodeKeyOf('/relay/prod'), 'space-1')).toBeNull();
  });

  it('collapses an absent serverBaseUrl to the local node, stably', () => {
    expect(nodeKeyOf(undefined)).toBe('local');
    expect(nodeKeyOf('')).toBe('local');
    expect(nodeKeyOf('/relay/prod')).toBe(nodeKeyOf('/relay/prod'));
  });
});

describe('it cannot break boot', () => {
  it('drops a corrupt payload instead of failing every future load', () => {
    localStorage.setItem('tm8.launch-sources.v1.local.space-1', '{not json');
    expect(readLaunchCache('local', 'space-1')).toBeNull();
    // and it removed the poison rather than leaving it to fail again
    expect(localStorage.getItem('tm8.launch-sources.v1.local.space-1')).toBeNull();
  });

  it('rejects rows of the wrong shape rather than passing them to the store', () => {
    localStorage.setItem(
      'tm8.launch-sources.v1.local.space-1',
      JSON.stringify({ savedAt: 'x', rows: [{ id: 'nope' }, { nothing: true }] }),
    );
    expect(readLaunchCache('local', 'space-1')).toBeNull();
  });

  it('stores only the option-set kinds it declares', () => {
    expect([...CACHED_LAUNCH_KINDS].sort()).toEqual(['interaction_profile', 'team_member']);
    writeLaunchCache('local', 'space-1', [teammate('t1'), teammate('task-1', { kind: 'task', state: { kind: 'task' } } as Partial<EntitySummary>)]);
    expect(readLaunchCache('local', 'space-1')?.map((r) => r.id)).toEqual(['t1']);
  });
});

describe('sign-out forgets it', () => {
  /* The cache is keyed by node and space, never by ACCOUNT — so it outlived the
     pass it was read under, and the next viewer on this browser had the last
     one's teammates and personas seeded into their pickers before the first
     authoritative read. `auth/session-reset.ts` calls this on an explicit
     sign-out. */
  it('drops every space under the node, because sign-out does not know which ones the pass reached', () => {
    writeLaunchCache('local', 'space-1', [teammate('t1')]);
    writeLaunchCache('local', 'space-2', [teammate('t2')]);

    clearLaunchCache('local');

    expect(readLaunchCache('local', 'space-1')).toBeNull();
    expect(readLaunchCache('local', 'space-2')).toBeNull();
  });

  it('leaves another node alone, because signing out of one server is not signing out of the other', () => {
    writeLaunchCache('local', 'space-1', [teammate('t1')]);
    writeLaunchCache('_relay_prod', 'space-1', [teammate('t2')]);

    clearLaunchCache('local');

    expect(readLaunchCache('local', 'space-1')).toBeNull();
    expect(readLaunchCache('_relay_prod', 'space-1')?.map((r) => r.id)).toEqual(['t2']);
  });

  it('survives a browser with no storage at all', () => {
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined });
    expect(() => clearLaunchCache('local')).not.toThrow();
  });
});
