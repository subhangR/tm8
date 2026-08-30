// The tracking observer, at its failure boundaries.
//
// These exist because the review of PR #67 found two blocking defects in this
// file, and BOTH were in branches no test entered. The happy path had been
// exercised live against a real PR; the abort path and the throwing-apply path
// had not been exercised at all. So the cases below are deliberately weighted
// toward what goes wrong rather than what goes right.
//
// The invariant every one of them is really defending, stated once:
//
//   A REQUEST IS ONLY EVER MARKED TERMINAL FOR WORK THAT ACTUALLY HAPPENED.
//
// `tracking.refresh` answers 202. A 202 for work no process did is worse than
// a 501, because it tells the caller their request was accepted. Every test
// here asks some version of "can this path produce a receipt it did not earn?"

import { describe, expect, it, vi } from 'vitest';

import { GithubClient } from '../../src/tracking/github.js';
import { runTrackingObserverTick, type TrackingObserverOptions } from '../../src/tracking/observer.js';
import type { Db, DbClaims } from '../../src/db/types.js';

const SPACE = '11111111-1111-7111-8111-111111111111';
const PR = '22222222-2222-7222-8222-222222222222';
const REQ = '33333333-3333-7333-8333-333333333333';

interface Call {
  fn: string;
  args: readonly unknown[];
}

/**
 * A Db that records RPCs and can be told to throw on a chosen one.
 *
 * Only `rpc` is implemented: the observer touches nothing else, and a fake that
 * implemented more would invite a test to prove something about the fake.
 */
function fakeDb(opts: {
  claimed?: unknown[];
  throwOn?: (fn: string, args: readonly unknown[]) => Error | null;
}): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    rpc: async (_claims: DbClaims, fn: string, args: readonly unknown[] = []) => {
      calls.push({ fn, args });
      const boom = opts.throwOn?.(fn, args);
      if (boom) throw boom;
      if (fn === 'public.claim_tracking_refresh') return { claimed: opts.claimed ?? [] };
      return {};
    },
  } as unknown as Db;
  return { db, calls };
}

function targets(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    entityId: `${PR.slice(0, -1)}${i}`,
    kind: 'pull_request',
    provider: 'github',
    repo: 'o/r',
    number: i + 1,
    sha: null,
  }));
}

function request(targetList: unknown[]): unknown {
  return { requestId: REQ, spaceId: SPACE, attempts: 0, targets: targetList };
}

/** A GithubClient whose transport is a function, so no network is involved. */
function client(handler: (url: string) => Response): GithubClient {
  return new GithubClient({
    fetchImpl: (async (input: string | URL | Request) => handler(String(input))) as typeof fetch,
  });
}

const okPr = (): Response =>
  new Response(JSON.stringify({ title: 't', state: 'open', head: { sha: 'a'.repeat(40) } }), {
    status: 200,
  });

function options(over: Partial<TrackingObserverOptions> & { db: Db }): TrackingObserverOptions {
  return { claims: async () => ({ identityId: 'i' }), ...over };
}

function completions(calls: Call[]): Call[] {
  return calls.filter((c) => c.fn === 'public.complete_tracking_refresh');
}

describe('an aborted tick never writes a receipt it did not earn', () => {
  it('BLOCKING REGRESSION — a tick aborted mid-request does NOT complete it', async () => {
    // The original bug: `if (signal.aborted) break` left the target loop, fell
    // through to `complete_tracking_refresh` with no problems, and the door
    // wrote `completed`. Targets never fetched were recorded as refreshed and
    // the row was never claimable again. The signal fires on every shutdown and
    // every 120s job timeout, so this was the ordinary path, not an edge case.
    const controller = new AbortController();
    const { db, calls } = fakeDb({ claimed: [request(targets(5))] });
    const gh = client(() => {
      controller.abort(); // abort while the first target is in flight
      return okPr();
    });

    const outcome = await runTrackingObserverTick(
      options({ db, client: gh }),
      controller.signal,
    );

    expect(completions(calls)).toEqual([]);
    expect(outcome.detail?.abandoned).toBe(1);
    // Left `running`, so 081's stale window hands it back. That machinery
    // already existed; the bug was simply never reaching it.
  });

  it('a signal already aborted at entry completes nothing at all', async () => {
    const { db, calls } = fakeDb({ claimed: [request(targets(3))] });
    const gh = client(() => okPr());
    await runTrackingObserverTick(options({ db, client: gh }), AbortSignal.abort());
    expect(completions(calls)).toEqual([]);
  });

  it('the target budget stops a tick the same way an abort does — unfinished, not completed', async () => {
    // One request can name every tracked entity in a space (081's claim door,
    // matching what 034 enqueues), so `batchSize` — which counts REQUESTS —
    // does not keep a tick inside its timeout. Overrunning must abandon, not
    // complete.
    const { db, calls } = fakeDb({ claimed: [request(targets(10))] });
    const gh = client(() => okPr());
    const outcome = await runTrackingObserverTick(options({ db, client: gh, targetBudget: 3 }));
    expect(completions(calls)).toEqual([]);
    expect(outcome.affected).toBe(3);
    expect(outcome.detail?.abandoned).toBe(1);
  });
});

describe('one bad row cannot take the batch down with it', () => {
  it('BLOCKING REGRESSION — a throwing apply is a per-target problem, not a dead tick', async () => {
    // The original bug: `db.rpc` throws on any Postgres error, and the apply
    // calls were uncaught. A 42501 (claim door and apply doors disagreeing
    // about entitlement) or a statement timeout propagated out of the tick and
    // abandoned every OTHER request already claimed in the batch.
    const doomed = 'doomed-entity';
    const first = { requestId: 'req-1', spaceId: SPACE, attempts: 0, targets: [
      { entityId: doomed, kind: 'pull_request', provider: 'github', repo: 'o/r', number: 1, sha: null },
    ] };
    const second = { requestId: 'req-2', spaceId: SPACE, attempts: 0, targets: targets(1) };
    const { db, calls } = fakeDb({
      claimed: [first, second],
      throwOn: (fn, args) =>
        fn === 'public.apply_pull_request_facts' && args[0] === doomed
          ? new Error('permission denied for schema public (42501)')
          : null,
    });
    const gh = client(() => okPr());

    const outcome = await runTrackingObserverTick(options({ db, client: gh }));

    // The tick survived and the SECOND request was still serviced.
    const done = completions(calls);
    expect(done).toHaveLength(2);
    expect(outcome.detail?.requests).toBe(2);
    // The failing one is recorded as failed WITH ITS REASON, not silently.
    expect(done[0]?.args[2]).toBe('failed');
    expect(String(done[0]?.args[1])).toContain('42501');
    expect(done[1]?.args[2]).toBe('completed');
  });

  it('a completion that throws is logged, never swallowed', async () => {
    // Silence here produces an invisible loop: the row stays `running`, the
    // stale window hands it back, the next tick re-fetches everything and fails
    // identically — burning provider quota with nothing in the log.
    const { db } = fakeDb({
      claimed: [request(targets(1))],
      throwOn: (fn) => (fn === 'public.complete_tracking_refresh' ? new Error('deadlock detected') : null),
    });
    const log = vi.fn();
    await expect(
      runTrackingObserverTick(options({ db, client: client(() => okPr()) }), undefined, log),
    ).resolves.toBeTruthy();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('deadlock detected'));
  });
});

describe('partial success is success, and says so', () => {
  it('nine of ten completes, and the tenth is still visible in the error', async () => {
    let n = 0;
    const { db, calls } = fakeDb({ claimed: [request(targets(10))] });
    const gh = client(() => {
      n += 1;
      return n === 3 ? new Response('{}', { status: 404 }) : okPr();
    });

    const outcome = await runTrackingObserverTick(options({ db, client: gh }));

    const done = completions(calls);
    expect(done[0]?.args[2]).toBe('completed');
    expect(String(done[0]?.args[1])).toContain('not_found');
    expect(outcome.affected).toBe(9);
  });

  it('but zero of one is a failure — `completed` would be the lie', async () => {
    const { db, calls } = fakeDb({ claimed: [request(targets(1))] });
    const gh = client(() => new Response('{}', { status: 404 }));
    await runTrackingObserverTick(options({ db, client: gh }));
    expect(completions(calls)[0]?.args[2]).toBe('failed');
  });
});

describe('a rate limit is not a verdict about a pull request', () => {
  it('stops the tick and marks NOTHING failed', async () => {
    const { db, calls } = fakeDb({ claimed: [request(targets(4))] });
    const gh = client(
      () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '999' },
        }),
    );
    const outcome = await runTrackingObserverTick(options({ db, client: gh }));
    expect(completions(calls)).toEqual([]);
    expect(outcome.detail?.rateLimited).toBe(true);
  });

  it('a SECONDARY rate limit (403 + retry-after, remaining non-zero) is also a rate limit', async () => {
    // Deciding on `x-ratelimit-remaining === '0'` alone files this as a
    // permission refusal, which the observer then records as terminally
    // `failed` — a permanent verdict for a throttle that clears in seconds.
    const { db, calls } = fakeDb({ claimed: [request(targets(1))] });
    const gh = client(
      () =>
        new Response('{}', {
          status: 403,
          headers: { 'retry-after': '60', 'x-ratelimit-remaining': '4999' },
        }),
    );
    const outcome = await runTrackingObserverTick(options({ db, client: gh }));
    expect(outcome.detail?.rateLimited).toBe(true);
    expect(completions(calls)).toEqual([]);
  });

  it('a genuine 403 with neither header IS a refusal, and is recorded as one', async () => {
    const { db, calls } = fakeDb({ claimed: [request(targets(1))] });
    const gh = client(() => new Response('{}', { status: 403 }));
    await runTrackingObserverTick(options({ db, client: gh }));
    expect(String(completions(calls)[0]?.args[1])).toContain('unauthorized');
  });
});

// 174. An abandoned request used to be claimed AND SILENT: `error` is written
// only by `complete_tracking_refresh`, which the stoppedEarly branch correctly
// does not call, so all three stop reasons left an identical NULL. A row that
// stopped because GitHub refused looked exactly like a row that stopped on the
// clock.
//
// That cost real time on the node this was written for. The observer was making
// ANONYMOUS GitHub calls — 60 requests/hour for the whole host — and once a
// backfill spent the hour's budget, every tick after it stopped on the first
// target with no row, no log line and no error text. Reconstructing that needed
// `curl https://api.github.com/rate_limit` from the host and an arithmetic
// coincidence. The queue could simply have said so.
describe('an abandoned request says why it stopped', () => {
  const notes = (calls: Call[]): Call[] =>
    calls.filter((c) => c.fn === 'public.note_tracking_refresh_stop');

  it('a rate limit writes the reason WITHOUT completing the request', async () => {
    const { db, calls } = fakeDb({ claimed: [request(targets(4))] });
    const gh = client(
      () =>
        new Response('{}', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '999' },
        }),
    );

    await runTrackingObserverTick(options({ db, client: gh }));

    // Both halves matter. The note must be written...
    expect(notes(calls)).toHaveLength(1);
    expect(notes(calls)[0]?.args[0]).toBe(REQ);
    expect(String(notes(calls)[0]?.args[1])).toContain('rate limit');
    // ...and it must NOT have become a completion on the way. The row stays
    // `running` so the stale window still returns it: a note, not a verdict.
    expect(completions(calls)).toEqual([]);
  });

  it('names the CREDENTIAL beside the cause, because that is the missing half', async () => {
    // "rate limited" on its own reads as "GitHub is busy". The content is
    // usually "this node is calling GitHub anonymously, and 60/hour is all
    // anonymous gets" — which is only legible if both facts are in one sentence.
    const { db, calls } = fakeDb({ claimed: [request(targets(2))] });
    const gh = client(
      () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    );

    await runTrackingObserverTick(options({ db, client: gh }));

    const reason = String(notes(calls)[0]?.args[1]);
    expect(reason).toContain('supplied directly'); // the injected-client seam, named honestly
    expect(reason).toContain('0 of 2 target(s) refreshed first');
    expect(reason).toMatch(/still claimed/i);
  });

  it('an ABORT is distinguishable from a rate limit, and warns about the restart', async () => {
    const controller = new AbortController();
    const { db, calls } = fakeDb({ claimed: [request(targets(5))] });
    const gh = client(() => { controller.abort(); return okPr(); });

    await runTrackingObserverTick(options({ db, client: gh }), controller.signal);

    const reason = String(notes(calls)[0]?.args[1]);
    expect(reason).toContain('aborted');
    expect(reason).not.toContain('rate limit');
    // The trap that cost a whole backfill: a resumed tick restarts at target 1,
    // so a request bigger than one tick can burn every attempt without ever
    // finishing. An operator reading this row should not have to derive that.
    expect(reason).toMatch(/restarts at the FIRST target/);
    expect(completions(calls)).toEqual([]);
  });

  it('the TARGET BUDGET is its own reason, not silently filed as an abort', async () => {
    const { db, calls } = fakeDb({ claimed: [request(targets(3))] });
    const gh = client(() => okPr());

    await runTrackingObserverTick(options({ db, client: gh, targetBudget: 1 }));

    const reason = String(notes(calls)[0]?.args[1]);
    expect(reason).toContain('per-target budget');
    expect(reason).toContain('1 of 3 target(s) refreshed first');
  });

  it('a finished request is NOT noted — the note is for abandonment only', async () => {
    const { db, calls } = fakeDb({ claimed: [request(targets(2))] });
    const gh = client(() => okPr());
    await runTrackingObserverTick(options({ db, client: gh }));
    expect(notes(calls)).toEqual([]);
    expect(completions(calls)).toHaveLength(1);
  });

  it('a note that THROWS is logged, and does not take the tick down with it', async () => {
    // This is a diagnostic. A diagnostic that can abort the tick it is
    // describing is worse than no diagnostic at all — it would turn a
    // recoverable rate limit into a dead poller.
    const { db, calls } = fakeDb({
      claimed: [request(targets(2))],
      throwOn: (fn) => (fn === 'public.note_tracking_refresh_stop' ? new Error('42501') : null),
    });
    const gh = client(
      () => new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    );
    const logged: string[] = [];

    const outcome = await runTrackingObserverTick(
      options({ db, client: gh }), undefined, (m) => logged.push(m),
    );

    expect(outcome.detail?.rateLimited).toBe(true);
    expect(outcome.detail?.abandoned).toBe(1);
    expect(logged.join(' ')).toContain('could not record the stop reason');
    expect(notes(calls)).toHaveLength(1); // attempted, and swallowed
  });
});

describe('the tick reports WHERE its token came from', () => {
  it('carries the credential source, not just whether there was one', async () => {
    // `authenticated` alone cannot tell "the operator set an env var" from "the
    // node account's stored credential was opened" from "neither" — and the
    // third case is the one that silently costs the hour's quota.
    const { db } = fakeDb({ claimed: [request(targets(1))] });
    const gh = client(() => okPr());
    const outcome = await runTrackingObserverTick(options({ db, client: gh }));
    expect(outcome.detail?.credentialSource).toBe('injected');
  });
});

describe('the claim call carries its bounds', () => {
  it('passes batch size, stale window and the retirement budget', async () => {
    const { db, calls } = fakeDb({ claimed: [] });
    const outcome = await runTrackingObserverTick(
      options({ db, batchSize: 7, staleAfterSeconds: 42, maxAttempts: 3 }),
    );
    expect(calls[0]).toEqual({
      fn: 'public.claim_tracking_refresh',
      args: [7, 42, 3],
    });
    // An empty queue is a SKIP with a reason, not a silent no-op.
    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toBeTruthy();
  });
});
