/**
 * The CLIENT half of the liveness push — behaviour, and the second half of the
 * latency number.
 *
 * The server half (broadcaster → tripwire → fan-out → bytes in every sink) is
 * measured in `packages/server`'s `liveness-latency.test.ts`. This one starts
 * where that one stops: a frame arrives, and the question is how long until
 * `statusOf` gives a different answer — and whether the answer is right.
 *
 * The two are reported added together. Neither is hidden inside the other, and
 * neither includes network flight time, which is stated in both.
 */
import { describe, expect, it, vi } from 'vitest';
import type { LivenessChangedEvent, SpaceId } from '@tm8/contract';

import { createLivenessManager } from './liveness';
import type { LivenessSnapshot } from '../seam';

const SPACE = '11111111-1111-4111-8111-111111111111' as SpaceId;
const OTHER = '22222222-2222-4222-8222-222222222222' as SpaceId;
const BOOT = 'boot-0001';
const NOW = Date.parse('2026-08-22T12:00:00.000Z');

function sessionId(i: number): string {
  return `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
}

function push(over: Partial<LivenessChangedEvent> = {}): LivenessChangedEvent {
  return {
    type: 'execution.liveness_changed',
    spaceId: SPACE,
    seq: 1,
    occurredAt: '2026-08-22T12:00:00.000Z',
    schemaVersion: 1,
    nodeBootId: BOOT,
    liveEntityIds: [sessionId(1)],
    changed: { id: sessionId(1), transition: 'appeared' },
    confidence: 'reported',
    checkedAt: '2026-08-22T12:00:00.000Z',
    ...over,
  } as LivenessChangedEvent;
}

/**
 * A manager whose HTTP read THROWS. Every test below is about the push path, so
 * a read happening at all is a failure — and one that returns a plausible
 * snapshot instead would let a test pass for the wrong reason.
 */
function manager(now: () => number = () => NOW): ReturnType<typeof createLivenessManager> {
  return createLivenessManager({
    read: () => { throw new Error('the push path must not issue an HTTP read'); },
    now,
  });
}

describe('notePush: the snapshot is applied, and no read is issued', () => {
  it('turns a pushed frame into a live verdict with no request', () => {
    const read = vi.fn();
    const m = createLivenessManager({ read, now: () => NOW });
    m.notePush(push());
    expect(m.statusOf({ id: sessionId(1), status: 'running' })).toBe('live');
    // THE POINT OF THE WHOLE CHANGE.
    expect(read).not.toHaveBeenCalled();
  });

  it('a session missing from the pushed set reads stale, never live', () => {
    const m = manager();
    m.notePush(push({ liveEntityIds: [sessionId(1)] }));
    // Recorded `running`, absent from a FRESH live set. That is the ghost, and
    // `stale` is the honest word for it — not `live`, and not `unknown`, which
    // would claim we have no evidence when we have exactly the evidence that
    // matters.
    expect(m.statusOf({ id: sessionId(2), status: 'running' })).toBe('stale');
  });

  it('an exited session is not-running regardless of the pushed set', () => {
    const m = manager();
    m.notePush(push());
    expect(m.statusOf({ id: sessionId(1), status: 'exited' })).toBe('not-running');
  });

  it('applying the same push twice changes nothing — it is idempotent', () => {
    const m = manager();
    const seen: LivenessSnapshot[] = [];
    m.onChange((s) => seen.push(s));
    m.notePush(push());
    m.notePush(push());
    expect(seen).toHaveLength(2);
    expect(seen[0]?.liveEntityIds).toEqual(seen[1]?.liveEntityIds);
    expect(m.statusOf({ id: sessionId(1), status: 'running' })).toBe('live');
  });

  it('a DROPPED frame self-heals — the next one carries the whole set', () => {
    // The reason the event is a snapshot and not a delta. Frame two is simply
    // never delivered; frame three repairs everything anyway.
    const m = manager();
    m.notePush(push({ liveEntityIds: [sessionId(1)] }));
    /* frame 2 (sessionId(2) appeared) is dropped on the floor */
    m.notePush(push({
      liveEntityIds: [sessionId(1), sessionId(2), sessionId(3)],
      changed: { id: sessionId(3), transition: 'appeared' },
    }));
    expect(m.statusOf({ id: sessionId(2), status: 'running' })).toBe('live');
    expect(m.statusOf({ id: sessionId(3), status: 'running' })).toBe('live');
  });

  it('a stale-on-arrival push reads stale rather than being restamped fresh', () => {
    // `checkedAt` is the NODE's stamp and is not rewritten with the local
    // clock. A frame that sat in a buffer past the 90s window is old, and
    // saying so is the whole reason `unknown` exists.
    const m = manager(() => NOW + 120_000);
    m.notePush(push());
    expect(m.statusOf({ id: sessionId(1), status: 'running' })).toBe('unknown');
  });
});

describe('notePush: provenance rides every reading (#507)', () => {
  it('reports the tier the node attached to the transition', () => {
    const m = manager();
    m.notePush(push({ changed: { id: sessionId(1), transition: 'appeared' }, confidence: 'reported' }));
    expect(m.confidenceOf(sessionId(1))).toBe('reported');

    m.notePush(push({
      seq: 2,
      changed: { id: sessionId(1), transition: 'quiet' },
      confidence: 'guessed',
    }));
    // A silence timer fired. It cannot tell an agent thinking hard from one
    // stopped at a permission prompt, and the client is now told so.
    expect(m.confidenceOf(sessionId(1))).toBe('guessed');
  });

  it('a session the node has never spoken about has NO tier', () => {
    const m = manager();
    m.notePush(push({ liveEntityIds: [sessionId(1), sessionId(9)] }));
    // sessionId(9) is in the live set but was never the `changed` session, so
    // nothing has been REPORTED about it — its state rests on a set membership.
    // Null is the honest answer and is what lets a surface mark it unverified.
    expect(m.confidenceOf(sessionId(9))).toBeNull();
    expect(m.confidenceOf('never-heard-of')).toBeNull();
  });

  it('forgets the tier once the session leaves every live set', () => {
    const m = manager();
    m.notePush(push({ changed: { id: sessionId(1), transition: 'appeared' } }));
    expect(m.confidenceOf(sessionId(1))).toBe('reported');
    m.notePush(push({
      seq: 2,
      liveEntityIds: [],
      changed: { id: sessionId(1), transition: 'vanished' },
    }));
    // Bounded by LIVE sessions. A tier for a dead session is a claim about how
    // well we know something that is no longer happening.
    expect(m.confidenceOf(sessionId(1))).toBeNull();
  });
});

describe('notePush: the node restart', () => {
  it('a changed nodeBootId invalidates every other space, from a push', () => {
    const m = manager();
    const restarts: string[] = [];
    m.onNodeRestart((id) => restarts.push(id));

    m.notePush(push());
    m.notePush(push({ spaceId: OTHER, seq: 2, liveEntityIds: [sessionId(5)] }));
    expect(m.statusOf({ id: sessionId(1), status: 'running' })).toBe('live');

    // The node came back as a different process. Every PTY either client knew
    // about is gone, whichever space it was in.
    m.notePush(push({ seq: 3, nodeBootId: 'boot-0002', liveEntityIds: [] }));

    expect(restarts).toEqual(['boot-0002']);
    expect(m.statusOf({ id: sessionId(1), status: 'running' })).toBe('stale');
    // And the OTHER space's cached set was dropped rather than aged out — it
    // described a process that no longer exists.
    expect(m.statusOf({ id: sessionId(5), status: 'running' })).toBe('stale');
  });
});

describe('notePush: latency, the client half', () => {
  it('applies a frame and flips the verdict, and reports the time', () => {
    const LIVE = 10;
    const TRANSITIONS = 500;
    const m = manager();

    const live = Array.from({ length: LIVE }, (_, i) => sessionId(i));
    m.notePush(push({ liveEntityIds: live }));

    /* The frame as it comes off the socket — a STRING, because `JSON.parse` is
       part of what the client pays and measuring a pre-parsed object would be
       measuring less than the real path. */
    const frames = Array.from({ length: TRANSITIONS }, (_, t) => JSON.stringify(push({
      seq: t + 2,
      liveEntityIds: live,
      changed: { id: sessionId(t % LIVE), transition: t % 2 === 0 ? 'quiet' : 'woke' },
      confidence: 'guessed',
    })));

    // Warm-up, declared rather than folded into the samples: a p95 that is
    // really a JIT artefact is not a latency claim.
    for (let i = 0; i < 200; i += 1) m.notePush(JSON.parse(frames[i % TRANSITIONS] as string));

    const samples: number[] = [];
    for (const frame of frames) {
      const started = performance.now();
      m.notePush(JSON.parse(frame) as LivenessChangedEvent);
      samples.push(performance.now() - started);
    }
    samples.sort((a, b) => a - b);
    const at = (p: number): number => samples[Math.min(samples.length - 1, Math.ceil((p / 100) * samples.length) - 1)] as number;

    // eslint-disable-next-line no-console -- the number IS the deliverable
    console.log(
      `\nliveness push CLIENT half, ${String(LIVE)} live sessions, ${String(TRANSITIONS)} frames\n` +
        `  frame off the socket -> verdict updated:  ` +
        `p50 ${at(50).toFixed(3)}ms  p95 ${at(95).toFixed(3)}ms  max ${samples[samples.length - 1]?.toFixed(3) ?? '?'}ms\n`,
    );

    // The ceiling asserts the property, not the measured value: applying a
    // pushed snapshot does no I/O and does not scale with session history.
    expect(at(95)).toBeLessThan(5);
    expect(m.statusOf({ id: sessionId(0), status: 'running' })).toBe('live');
  });
});
