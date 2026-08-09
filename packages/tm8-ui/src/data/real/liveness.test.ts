/**
 * liveness.ts — the R-UI-5 predicate and the LLD §9 cadence.
 *
 * The predicate tests are written around what each verdict CAN BE SATISFIED BY,
 * not around a happy path: 'live' must require a snapshot that is both present
 * AND fresh, and the two ways of losing that must both land on 'unknown'.
 */
import { describe, expect, it } from 'vitest';
import type { DurableWorkspaceEvent, SpaceId } from '@tm8/contract';
import { createLivenessManager, type LivenessManager } from './liveness';
import type { LivenessSnapshot } from '../seam';
import { FakeClock, flush } from './test-support';

const T0 = '2026-07-28T12:00:00.000Z';

interface Harness {
  mgr: LivenessManager;
  clock: FakeClock;
  reads: SpaceId[];
  changes: LivenessSnapshot[];
  restarts: string[];
  reply(spaceId: SpaceId, snap: Partial<LivenessSnapshot>): void;
  fail(err: unknown): void;
}

function mk(): Harness {
  const clock = new FakeClock();
  const reads: SpaceId[] = [];
  const changes: LivenessSnapshot[] = [];
  const restarts: string[] = [];
  const replies = new Map<SpaceId, LivenessSnapshot>();
  let failure: unknown = null;

  const mgr = createLivenessManager({
    read: async (spaceId) => {
      reads.push(spaceId);
      if (failure !== null) throw failure;
      return replies.get(spaceId) ?? {
        spaceId, liveEntityIds: [], nodeBootId: 'boot-A', checkedAt: new Date(clock.now()).toISOString(),
      };
    },
    timers: clock.timers,
    now: clock.now,
  });
  mgr.onChange((s) => changes.push(s));
  mgr.onNodeRestart((b) => restarts.push(b));

  return {
    mgr, clock, reads, changes, restarts,
    reply(spaceId, snap) {
      replies.set(spaceId, {
        spaceId,
        liveEntityIds: [],
        nodeBootId: 'boot-A',
        checkedAt: new Date(clock.now()).toISOString(),
        ...snap,
      });
    },
    fail(err) { failure = err; },
  };
}

const running = (id: string) => ({ id, workStatus: 'running' as const });

// ---------------------------------------------------------------------------

describe('liveness: the R-UI-5 predicate', () => {
  it('a session that is not running is not-running, regardless of any snapshot', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: ['ws-1'] });
    await h.mgr.refresh('sp-1');
    expect(h.mgr.statusOf({ id: 'ws-1', workStatus: 'exited' })).toBe('not-running');
    expect(h.mgr.statusOf({ id: 'ws-1', workStatus: null })).toBe('not-running');
  });

  it('running + in the live set = live', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: ['ws-1'] });
    await h.mgr.refresh('sp-1');
    expect(h.mgr.statusOf(running('ws-1'))).toBe('live');
  });

  it('idle + in the live set = live', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: ['ws-1'] });
    await h.mgr.refresh('sp-1');
    expect(h.mgr.statusOf({ id: 'ws-1', workStatus: 'idle' })).toBe('live');
  });

  it('idle + absent from the live set = stale, never exited', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: ['ws-other'] });
    await h.mgr.refresh('sp-1');
    expect(h.mgr.statusOf({ id: 'ws-1', workStatus: 'idle' })).toBe('stale');
  });

  it('running + NOT in the live set = stale (the whole point of Delta 2)', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: ['ws-other'] });
    await h.mgr.refresh('sp-1');
    expect(h.mgr.statusOf(running('ws-1'))).toBe('stale');
  });

  it('NO snapshot = unknown — never live, and never stale either', () => {
    const h = mk();
    expect(h.mgr.statusOf(running('ws-1'))).toBe('unknown');
  });

  it('a snapshot older than 90s = unknown — absence of evidence is not evidence', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: ['ws-1'] });
    await h.mgr.refresh('sp-1');
    expect(h.mgr.statusOf(running('ws-1'))).toBe('live');   // the control, before ageing

    h.clock.advance(90_000);
    expect(h.mgr.statusOf(running('ws-1'))).toBe('live');   // exactly at the boundary
    h.clock.advance(1);
    expect(h.mgr.statusOf(running('ws-1'))).toBe('unknown');
  });

  it('an unparseable checkedAt is NOT treated as fresh', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: ['ws-1'], checkedAt: 'not-a-timestamp' });
    await h.mgr.refresh('sp-1');
    expect(h.mgr.statusOf(running('ws-1'))).toBe('unknown');
  });

  it('a stale snapshot cannot make an absent session read as stale', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: [] });
    await h.mgr.refresh('sp-1');
    expect(h.mgr.statusOf(running('ws-1'))).toBe('stale');   // fresh + absent
    h.clock.advance(90_001);
    expect(h.mgr.statusOf(running('ws-1'))).toBe('unknown');  // aged out → neutral
  });

  it('membership is checked across every fresh snapshot, so a second space does not mask the first', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: [] });
    h.reply('sp-2', { liveEntityIds: ['ws-2'] });
    await h.mgr.refresh('sp-1');
    await h.mgr.refresh('sp-2');
    expect(h.mgr.statusOf(running('ws-2'))).toBe('live');
    expect(h.mgr.statusOf(running('ws-1'))).toBe('stale');
  });
});

describe('liveness: one in-flight read at a time (LLD §9)', () => {
  it('a second refresh joins the first rather than issuing a second call', async () => {
    const h = mk();
    const a = h.mgr.refresh('sp-1');
    const b = h.mgr.refresh('sp-1');
    expect(h.reads).toEqual(['sp-1']);
    expect(await a).toEqual(await b);
    // And a later refresh does issue a new one — the guard is per-flight, not a latch.
    await h.mgr.refresh('sp-1');
    expect(h.reads).toEqual(['sp-1', 'sp-1']);
  });

  it('different spaces are not serialized behind each other', () => {
    const h = mk();
    void h.mgr.refresh('sp-1');
    void h.mgr.refresh('sp-2');
    expect(h.reads).toEqual(['sp-1', 'sp-2']);
  });
});

describe('liveness: nodeBootId change = the node restarted', () => {
  it('signals a restart and drops every other cached snapshot before re-reading', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: ['ws-1'], nodeBootId: 'boot-A' });
    h.reply('sp-2', { liveEntityIds: ['ws-2'], nodeBootId: 'boot-A' });
    h.mgr.noteSpaceOpened('sp-1');
    h.mgr.noteSpaceOpened('sp-2');
    await flush();
    expect(h.mgr.statusOf(running('ws-2'))).toBe('live');

    // sp-1 comes back from a NEW process: every previously-live PTY is gone.
    h.reply('sp-1', { liveEntityIds: [], nodeBootId: 'boot-B' });
    h.reply('sp-2', { liveEntityIds: [], nodeBootId: 'boot-B' });
    await h.mgr.refresh('sp-1');

    expect(h.restarts).toEqual(['boot-B']);
    // ws-2's old snapshot claimed it was live; it must not survive the restart.
    expect(h.mgr.statusOf(running('ws-2'))).not.toBe('live');
    await flush();
    expect(h.reads.filter((s) => s === 'sp-2').length).toBeGreaterThan(1);
  });

  it('the FIRST snapshot is not a restart — there was nothing to change from', async () => {
    const h = mk();
    await h.mgr.refresh('sp-1');
    expect(h.restarts).toEqual([]);
  });

  it('an unchanged nodeBootId is not a restart', async () => {
    const h = mk();
    await h.mgr.refresh('sp-1');
    await h.mgr.refresh('sp-1');
    expect(h.restarts).toEqual([]);
  });
});

describe('liveness: the LLD §9 cadence', () => {
  it('reads on openSpace', async () => {
    const h = mk();
    h.mgr.noteSpaceOpened('sp-1');
    await flush();
    expect(h.reads).toEqual(['sp-1']);
  });

  it('reads on an entity.upsert whose entity is a work_session — and ONLY then', async () => {
    const h = mk();
    h.mgr.noteSpaceOpened('sp-1');
    await flush();
    h.reads.length = 0;

    h.mgr.noteEvent(upsert('sp-1', 'task'));
    h.mgr.noteEvent({ type: 'message.created', spaceId: 'sp-1', seq: 2 } as unknown as DurableWorkspaceEvent);
    expect(h.reads).toEqual([]);

    h.mgr.noteEvent(upsert('sp-1', 'work_session'));
    expect(h.reads).toEqual(['sp-1']);
  });

  it('reads every tracked space on reconnect', async () => {
    const h = mk();
    h.mgr.noteSpaceOpened('sp-1');
    h.mgr.noteSpaceOpened('sp-2');
    await flush();
    h.reads.length = 0;
    h.mgr.noteReconnect();
    expect(h.reads.sort()).toEqual(['sp-1', 'sp-2']);
  });

  it('the 30s interval runs only while a session surface is visible', async () => {
    const h = mk();
    h.mgr.noteSpaceOpened('sp-1');
    await flush();
    h.reads.length = 0;

    h.clock.advance(120_000);
    expect(h.reads).toEqual([]);            // invisible surfaces poll nothing

    h.mgr.setVisible(true);
    expect(h.reads).toEqual(['sp-1']);      // becoming visible re-reads at once
    // Each tick must SETTLE before the next: the one-in-flight guard would
    // otherwise coalesce the interval read into the pending one, which is the
    // guard working correctly and would make this test measure the wrong thing.
    await flush();
    h.reads.length = 0;

    h.clock.advance(30_000);
    expect(h.reads).toEqual(['sp-1']);
    await flush();
    h.clock.advance(30_000);
    expect(h.reads).toEqual(['sp-1', 'sp-1']);
    await flush();

    h.mgr.setVisible(false);
    h.reads.length = 0;
    h.clock.advance(300_000);
    expect(h.reads).toEqual([]);
  });

  it('closing a space stops tracking it and forgets its snapshot', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: ['ws-1'] });
    h.mgr.noteSpaceOpened('sp-1');
    await flush();
    expect(h.mgr.statusOf(running('ws-1'))).toBe('live');

    h.mgr.noteSpaceClosed('sp-1');
    expect(h.mgr.statusOf(running('ws-1'))).toBe('unknown');
    h.mgr.noteReconnect();
    expect(h.reads).toEqual(['sp-1']);
  });
});

describe('liveness: a failing read is honest, not fatal', () => {
  it('the cadence swallows the rejection and statusOf stays unknown', async () => {
    // This is today's REAL server behaviour: execution.liveness has no route
    // yet, so every cadence read 404s. openSpace must survive it.
    const h = mk();
    h.fail(new Error('404 not_found'));
    h.mgr.noteSpaceOpened('sp-1');
    await flush();
    expect(h.mgr.statusOf(running('ws-1'))).toBe('unknown');
  });

  it('an explicit refresh() still rejects — the caller asked, so the caller is told', async () => {
    const h = mk();
    h.fail(new Error('boom'));
    await expect(h.mgr.refresh('sp-1')).rejects.toThrow('boom');
  });
});

describe('liveness: dispose', () => {
  it('cancels the interval and clears state', async () => {
    const h = mk();
    h.reply('sp-1', { liveEntityIds: ['ws-1'] });
    h.mgr.noteSpaceOpened('sp-1');
    h.mgr.setVisible(true);
    await flush();

    h.mgr.dispose();
    h.reads.length = 0;
    h.clock.advance(300_000);
    expect(h.reads).toEqual([]);
    expect(h.clock.pending()).toBe(0);
    expect(h.mgr.statusOf(running('ws-1'))).toBe('unknown');
  });
});

function upsert(spaceId: SpaceId, kind: string): DurableWorkspaceEvent {
  return {
    type: 'entity.upsert',
    spaceId,
    seq: 1,
    occurredAt: T0,
    schemaVersion: 1,
    entity: { id: 'e-1', state: { kind } },
  } as unknown as DurableWorkspaceEvent;
}
