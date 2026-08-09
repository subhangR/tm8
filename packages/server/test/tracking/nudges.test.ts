// The three loops' DECISION, and the delivery's dedup contract.
//
// `decideNudges` is pure precisely so these can exist: suppression ("do not
// nudge about a conflict on a stacked PR") and transition detection ("dirty is
// not news, BECOMING dirty is") are the rules most likely to be subtly wrong,
// and both of them are invisible to any test that has to stand up a database
// and an HTTP server first.
//
// The invariant underneath all of it:
//
//   A NUDGE IS ONLY EVER SENT FOR SOMETHING THE AGENT HAS NOT BEEN TOLD, AND
//   ONLY TO SOMEBODY WHO CAN ACT ON IT.
//
// Every case below asks one half of that.

import { describe, expect, it } from 'vitest';

import type { CheckRunFacts, ReviewThreadFacts } from '../../src/tracking/github.js';
import type { Db, DbClaims } from '../../src/db/types.js';
import {
  capBody,
  decideNudges,
  deliverPendingNudges,
  isNewConflict,
  renderPendingNudge,
  REVIEW_THREAD_NUDGE_CAP,
  type PendingNudge,
  type PullRequestDiff,
  type RenderedNudge,
  type WatchTarget,
} from '../../src/tracking/nudges.js';

const SESSION = '44444444-4444-7444-8444-444444444444';
const PR = '22222222-2222-7222-8222-222222222222';
const TASK = '55555555-5555-7555-8555-555555555555';

function target(over: Partial<WatchTarget> = {}): WatchTarget {
  return {
    prEntityId: PR,
    spaceId: '11111111-1111-7111-8111-111111111111',
    provider: 'github',
    repo: 'acme/forge',
    number: 7,
    state: 'open',
    headSha: 'a'.repeat(40),
    headRef: 'feat/child',
    baseRef: 'main',
    mergeableState: 'clean',
    taskId: TASK,
    owningSessionId: SESSION,
    owningSessionStatus: 'running',
    owningSessionLive: true,
    stackedOnOpenParent: false,
    ...over,
  };
}

function diff(over: Partial<PullRequestDiff> = {}): PullRequestDiff {
  return {
    newlyFailing: [],
    newlyUnresolved: [],
    previousMergeableState: 'clean',
    mergeableState: 'clean',
    ...over,
  };
}

const redCheck = (name = 'build'): CheckRunFacts => ({
  name,
  status: 'completed',
  conclusion: 'failure',
  externalId: '9001',
  detailsUrl: 'https://github.com/acme/forge/runs/9001',
  startedAt: null,
  completedAt: null,
});

const thread = (key: string): ReviewThreadFacts => ({
  threadKey: key,
  path: 'src/a.ts',
  line: 12,
  isResolved: false,
  isOutdated: false,
  comments: [{ id: 'c1', author: 'reviewer', body: 'this leaks a file handle' }],
});

describe('loop (a) — CI failure carries the log INLINE', () => {
  it('inlines the log tail, because the agent cannot open a browser', () => {
    const tails = new Map([['build', 'error: cannot find module x\nexit 1']]);
    const { nudges } = decideNudges(target(), diff({ newlyFailing: [redCheck()] }), tails);

    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.loop).toBe('ci_failure');
    expect(nudges[0]?.sessionId).toBe(SESSION);
    expect(nudges[0]?.body).toContain('error: cannot find module x');
    // A nudge that only linked out would make the agent shell out to `gh` to
    // learn anything, at which point the message did no work.
    expect(nudges[0]?.body).toContain('CI FAILED');
    expect(nudges[0]?.body).toContain(TASK);
  });

  it('says so out loud when the log could not be read', () => {
    // Silence here reads as "the job produced no output", which is a different
    // and far less alarming fact than "we could not fetch the log".
    const { nudges } = decideNudges(target(), diff({ newlyFailing: [redCheck()] }), new Map());
    expect(nudges[0]?.body).toContain('Log tail unavailable');
  });

  it('is UNCAPPED — ten red checks are ten things to fix', () => {
    const { nudges } = decideNudges(
      target(),
      diff({ newlyFailing: [redCheck('build'), redCheck('lint'), redCheck('types')] }),
      new Map(),
    );
    expect(nudges).toHaveLength(3);
    expect(nudges.every((n) => n.scopeCap === null)).toBe(true);
    // Distinct scopes, so a cap could never collapse them even if one were added.
    expect(new Set(nudges.map((n) => n.scopeKey)).size).toBe(3);
  });

  it('the signature includes the log tail, so a second failure for a NEW reason is new', () => {
    const one = decideNudges(target(), diff({ newlyFailing: [redCheck()] }), new Map([['build', 'boom A']]));
    const two = decideNudges(target(), diff({ newlyFailing: [redCheck()] }), new Map([['build', 'boom B']]));
    const same = decideNudges(target(), diff({ newlyFailing: [redCheck()] }), new Map([['build', 'boom A']]));

    expect(one.nudges[0]?.signature).not.toBe(two.nudges[0]?.signature);
    expect(one.nudges[0]?.signature).toBe(same.nudges[0]?.signature);
  });

  it('the signature moves with the commit — the same failure on a new sha is new', () => {
    const first = decideNudges(target(), diff({ newlyFailing: [redCheck()] }), new Map());
    const pushed = decideNudges(
      target({ headSha: 'b'.repeat(40) }),
      diff({ newlyFailing: [redCheck()] }),
      new Map(),
    );
    expect(first.nudges[0]?.signature).not.toBe(pushed.nudges[0]?.signature);
  });
});

describe('loop (b) — merge conflict, and the stacked-PR suppression', () => {
  it('nudges on the TRANSITION into conflict', () => {
    const { nudges } = decideNudges(
      target(),
      diff({ previousMergeableState: 'clean', mergeableState: 'dirty' }),
      new Map(),
    );
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.loop).toBe('merge_conflict');
    expect(nudges[0]?.body).toContain('MERGE CONFLICT');
  });

  it('does NOT nudge while it merely REMAINS conflicted', () => {
    // The state, rather than the transition, would re-fire on every tick for as
    // long as the conflict existed — which is most of the time it exists.
    expect(isNewConflict(diff({ previousMergeableState: 'dirty', mergeableState: 'dirty' }))).toBe(false);
    const { nudges } = decideNudges(
      target(),
      diff({ previousMergeableState: 'dirty', mergeableState: 'dirty' }),
      new Map(),
    );
    expect(nudges).toEqual([]);
  });

  it('treats unknown -> dirty as a real transition', () => {
    // GitHub reports `unknown` while it recomputes the merge, which happens
    // after every push. Excluding it would drop the conflict announcement that
    // matters most: the one caused by the push.
    expect(isNewConflict(diff({ previousMergeableState: 'unknown', mergeableState: 'dirty' }))).toBe(true);
  });

  it('BLOCKING RULE — a PR stacked on an open parent is suppressed', () => {
    const { nudges, suppressed } = decideNudges(
      target({ stackedOnOpenParent: true }),
      diff({ previousMergeableState: 'clean', mergeableState: 'dirty' }),
      new Map(),
    );
    expect(nudges).toEqual([]);
    // Suppression is REPORTED, never silent: a watcher that quietly does
    // nothing looks identical to a watcher that is broken.
    expect(suppressed).toEqual([{ loop: 'merge_conflict', reason: 'stacked_on_open_parent' }]);
  });

  it('the suppression is scoped to the conflict, not to the whole PR', () => {
    // A stacked PR still has real CI failures, and swallowing those with the
    // conflict would be a much bigger loss than the noise it saves.
    const { nudges } = decideNudges(
      target({ stackedOnOpenParent: true }),
      diff({ newlyFailing: [redCheck()], previousMergeableState: 'clean', mergeableState: 'dirty' }),
      new Map(),
    );
    expect(nudges.map((n) => n.loop)).toEqual(['ci_failure']);
  });
});

describe('loop (c) — unresolved review threads', () => {
  it('delivers the thread id and the comment bodies so the agent can answer', () => {
    const { nudges } = decideNudges(target(), diff({ newlyUnresolved: [thread('RT_1')] }), new Map());
    expect(nudges).toHaveLength(1);
    expect(nudges[0]?.scopeKey).toBe('RT_1');
    expect(nudges[0]?.body).toContain('RT_1');
    expect(nudges[0]?.body).toContain('this leaks a file handle');
    expect(nudges[0]?.body).toContain('src/a.ts:12');
  });

  it('is capped per thread — an unanswered reviewer is not more unanswered every minute', () => {
    const { nudges } = decideNudges(target(), diff({ newlyUnresolved: [thread('RT_1')] }), new Map());
    expect(nudges[0]?.scopeCap).toBe(REVIEW_THREAD_NUDGE_CAP);
  });

  it('a new reply on the same thread is a new signature', () => {
    const base = thread('RT_1');
    const replied: ReviewThreadFacts = {
      ...base,
      comments: [...base.comments, { id: 'c2', author: 'reviewer', body: 'still waiting' }],
    };
    const a = decideNudges(target(), diff({ newlyUnresolved: [base] }), new Map());
    const b = decideNudges(target(), diff({ newlyUnresolved: [replied] }), new Map());
    expect(a.nudges[0]?.signature).not.toBe(b.nudges[0]?.signature);
    expect(a.nudges[0]?.scopeKey).toBe(b.nudges[0]?.scopeKey);
  });
});

describe('there must be somebody who can act', () => {
  it('no owning session suppresses every loop, with a reason', () => {
    const { nudges, suppressed } = decideNudges(
      target({ owningSessionId: null, owningSessionLive: false }),
      diff({ newlyFailing: [redCheck()], newlyUnresolved: [thread('RT_1')] }),
      new Map(),
    );
    expect(nudges).toEqual([]);
    expect(suppressed.map((s) => s.reason)).toEqual(['no_owning_session', 'no_owning_session']);
  });

  it('an exited session suppresses every loop — a message with no reader is not a loop', () => {
    const { nudges, suppressed } = decideNudges(
      target({ owningSessionStatus: 'exited', owningSessionLive: false }),
      diff({ newlyFailing: [redCheck()] }),
      new Map(),
    );
    expect(nudges).toEqual([]);
    expect(suppressed).toEqual([{ loop: 'ci_failure', reason: 'session_not_live' }]);
  });

  it('nothing changed means nothing is decided, and nothing is suppressed either', () => {
    expect(decideNudges(target(), diff(), new Map())).toEqual({ nudges: [], suppressed: [] });
  });
});

// -----------------------------------------------------------------------------

interface Call { fn: string; args: readonly unknown[] }

function fakeDb(opts: {
  post?: (args: readonly unknown[]) => unknown;
  throwOn?: (fn: string) => Error | null;
}): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    rpc: async (_c: DbClaims, fn: string, args: readonly unknown[] = []) => {
      calls.push({ fn, args });
      const boom = opts.throwOn?.(fn);
      if (boom) throw boom;
      if (fn === 'public.post_session_nudge') {
        return opts.post?.(args) ?? { posted: true, messageId: 'msg-1', workSessionId: SESSION };
      }
      return {};
    },
  } as unknown as Db;
  return { db, calls };
}

const queued = (over: Partial<PendingNudge> = {}): PendingNudge => ({
  pendingId: 'pending-1',
  spaceId: '11111111-1111-7111-8111-111111111111',
  prEntityId: PR,
  loopKind: 'ci_failure',
  scopeKey: 'build@abc',
  headSha: 'a'.repeat(40),
  payload: { name: 'build', status: 'completed', conclusion: 'failure', externalId: '9001' },
  attempts: 0,
  repo: 'acme/forge',
  number: 7,
  headRef: 'feat/child',
  baseRef: 'main',
  taskId: TASK,
  owningSessionId: SESSION,
  ...over,
});

const rendered = async (): Promise<RenderedNudge> => ({
  signature: 'sig-1',
  body: 'CI FAILED',
  scopeCap: null,
});

describe('delivery hands the whole decision to the door', () => {
  it('posts through post_session_nudge, never through post_message', async () => {
    // The defect this replaced: `post_message` is revoked from tm8_app (019) and
    // mints no delivery intent, so every nudge answered 42501 and none could
    // ever have reached a terminal.
    const { db, calls } = fakeDb({});
    const result = await deliverPendingNudges(db, {}, [queued()], rendered);
    expect(result.delivered).toBe(1);
    expect(calls.map((c) => c.fn)).toContain('public.post_session_nudge');
    expect(calls.map((c) => c.fn)).not.toContain('public.post_message');
  });

  it('BLOCKING — a renderer that declines leaves the row QUEUED and settles nothing', async () => {
    // A suppression is a statement about right now. The stacked parent may
    // merge before the next drain, and then the conflict IS the agent's problem.
    const { db, calls } = fakeDb({});
    const result = await deliverPendingNudges(db, {}, [queued()], async () => null);
    expect(result.delivered).toBe(0);
    expect(calls.filter((c) => c.fn === 'public.post_session_nudge')).toEqual([]);
    expect(calls.filter((c) => c.fn === 'public.record_pending_nudge_failure')).toEqual([]);
  });

  it('counts the door refusals apart, because they mean different things', async () => {
    const reasons = ['duplicate', 'capped', 'session_not_live'] as const;
    let i = 0;
    const { db } = fakeDb({ post: () => ({ posted: false, reason: reasons[i++] }) });
    const result = await deliverPendingNudges(
      db,
      {},
      [queued(), queued({ pendingId: 'p2' }), queued({ pendingId: 'p3' })],
      rendered,
    );
    expect(result).toMatchObject({ delivered: 0, duplicates: 1, capped: 1, notLive: 1 });
  });

  it('BLOCKING — a failed post records WHY without settling the row', async () => {
    // The door is atomic, so the transaction already rolled the claim back. All
    // that is left to do is say why, or a poisonous nudge is invisible.
    const { db, calls } = fakeDb({
      throwOn: (fn) => (fn === 'public.post_session_nudge' ? new Error('deadlock detected') : null),
    });
    const result = await deliverPendingNudges(db, {}, [queued()], rendered);
    expect(result.delivered).toBe(0);
    expect(result.failed[0]).toContain('deadlock detected');
    expect(calls.map((c) => c.fn)).toContain('public.record_pending_nudge_failure');
  });

  it('the signature is the client mutation id — 019 idempotency under 084 dedup', async () => {
    const { db, calls } = fakeDb({});
    await deliverPendingNudges(db, {}, [queued()], rendered);
    const post = calls.find((c) => c.fn === 'public.post_session_nudge');
    expect(post?.args[0]).toBe('pending-1');
    expect(post?.args[1]).toBe('sig-1');
    expect(post?.args[4]).toBe('nudge:ci_failure:sig-1');
  });

  it('records routes and dispatches only after a real send', async () => {
    const dispatched: string[] = [];
    const { db, calls } = fakeDb({});
    await deliverPendingNudges(db, {}, [queued()], rendered, async ({ workSessionId }) => {
      dispatched.push(workSessionId);
    });
    expect(calls.map((c) => c.fn)).toContain('public.w2_record_session_message_routes');
    expect(dispatched).toEqual([SESSION]);
  });

  it('a dispatch failure is reported but does NOT unwind the stored message', async () => {
    // Stored-first: the message and the settlement are committed; only the
    // terminal write failed, and 019's delivery rows own that retry.
    const { db } = fakeDb({});
    const result = await deliverPendingNudges(db, {}, [queued()], rendered, async () => {
      throw new Error('pty closed');
    });
    expect(result.delivered).toBe(1);
    expect(result.failed[0]).toContain('pty closed');
  });

  it('one poisonous row does not take the rest of the drain down', async () => {
    let n = 0;
    const { db } = fakeDb({
      throwOn: (fn) => {
        if (fn !== 'public.post_session_nudge') return null;
        n += 1;
        return n === 1 ? new Error('permission denied (42501)') : null;
      },
    });
    const result = await deliverPendingNudges(
      db, {}, [queued(), queued({ pendingId: 'p2' })], rendered,
    );
    expect(result.delivered).toBe(1);
    expect(result.failed[0]).toContain('42501');
  });
});

describe('the body must fit what 019 will accept', () => {
  it('BLOCKING — a long log is capped, and trimmed FROM THE TOP', async () => {
    // 019 refuses a body outside 1..10000 chars (22023). The end of a failing
    // build is where the error is; trimming the tail would drop the one thing
    // the agent needs and keep the dependency install it does not.
    const log = Array.from({ length: 4000 }, (_, i) => `line ${String(i)}`).join('\n');
    const { db, calls } = fakeDb({});
    await deliverPendingNudges(db, {}, [queued()], async () => ({
      signature: 'sig-long',
      body: log,
      scopeCap: null,
    }));
    const body = String(calls.find((c) => c.fn === 'public.post_session_nudge')?.args[2]);
    expect(body.length).toBeLessThanOrEqual(10000);
    expect(body).toContain('line 3999');
    expect(body).not.toContain('line 0\n');
    expect(body).toContain('trimmed');
  });

  it('capBody leaves a body that already fits completely alone', () => {
    expect(capBody('short')).toBe('short');
  });
});

describe('rendering one queued transition', () => {
  it('a stacked conflict declines, and stays queued for a later drain', () => {
    const row = queued({ loopKind: 'merge_conflict', scopeKey: 'conflict@abc', payload: {} });
    expect(renderPendingNudge(row, { stackedOnOpenParent: true, logTail: null })).toBeNull();
    expect(renderPendingNudge(row, { stackedOnOpenParent: false, logTail: null })).not.toBeNull();
  });

  it('a CI row inlines the log it was given, fenced and labelled', () => {
    const out = renderPendingNudge(queued(), { stackedOnOpenParent: false, logTail: 'boom\n```\nx' });
    expect(out?.body).toContain('UNTRUSTED CONTENT');
    expect(out?.body).toContain('boom');
    const opener = /^(`{3,})$/m.exec(out?.body ?? '')?.[1] ?? '';
    expect(opener.length).toBeGreaterThan(3);
  });

  it('the log tail is part of the CI signature, so a new reason is a new nudge', () => {
    const a = renderPendingNudge(queued(), { stackedOnOpenParent: false, logTail: 'reason A' });
    const b = renderPendingNudge(queued(), { stackedOnOpenParent: false, logTail: 'reason B' });
    expect(a?.signature).not.toBe(b?.signature);
  });

  it('a review row is capped per thread', () => {
    const row = queued({
      loopKind: 'review_thread',
      scopeKey: 'RT_1',
      headSha: null,
      payload: { threadKey: 'RT_1', path: 'a.ts', author: 'r', bodyExcerpt: 'fix this' },
    });
    const out = renderPendingNudge(row, { stackedOnOpenParent: false, logTail: null });
    expect(out?.scopeCap).toBe(REVIEW_THREAD_NUDGE_CAP);
    expect(out?.body).toContain('fix this');
  });
});
