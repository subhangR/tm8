// 306 (Game v1 P0e): the tracking jobs span every space, so WHICH credential
// reads a space's pull requests and WHICH provider budget a rate limit stops
// are now per space. No network, no database.
//
//   * a space with its own GitHub token credential is read with it, and a
//     space without one is never read with somebody else's;
//   * a rate limit on one budget skips only the targets that spend it, and is
//     remembered across ticks until the provider's reset;
//   * every poll is recorded (`record_tracking_poll`), a 304 included;
//   * the `backgroundJob` claim is set by the composition root and nowhere else.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TrackingClients } from '../../src/tracking/clients.js';
import { runForgeWatchTick } from '../../src/tracking/loops.js';
import { runTrackingObserverTick } from '../../src/tracking/observer.js';
import type { Db, DbClaims } from '../../src/db/types.js';

const SPACE_A = '11111111-1111-7111-8111-111111111111';
const SPACE_B = '22222222-2222-7222-8222-222222222222';

interface Call { fn: string; args: readonly unknown[] }

function fakeDb(results: Record<string, unknown>): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    rpc: async (_c: DbClaims, fn: string, args: readonly unknown[] = []) => {
      calls.push({ fn, args });
      const value = results[fn];
      if (typeof value === 'function') return (value as (a: readonly unknown[]) => unknown)(args);
      return value ?? {};
    },
  } as unknown as Db;
  return { db, calls };
}

function target(spaceId: string, prEntityId: string, number: number): Record<string, unknown> {
  return {
    prEntityId, spaceId, provider: 'github', repo: 'acme/forge', number, state: 'open',
    headSha: null, headRef: null, baseRef: null, mergeableState: null,
  };
}

/** Records the Authorization header of every request, and answers per URL. */
function fetchFake(answer: (url: string, auth: string | undefined) => Response): {
  fetchImpl: typeof fetch;
  seen: Array<{ url: string; auth: string | undefined }>;
} {
  const seen: Array<{ url: string; auth: string | undefined }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const auth = ((init?.headers ?? {}) as Record<string, string>).authorization;
    seen.push({ url: String(input), auth });
    return answer(String(input), auth);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

const prJson = (over: Record<string, unknown> = {}): Response => new Response(JSON.stringify({
  title: 't', state: 'closed', merged_at: '2026-10-06T10:00:00Z',
  head: { sha: 'b'.repeat(40), ref: 'feat/x' }, base: { ref: 'main' },
  mergeable_state: 'unknown', ...over,
}), { status: 200 });

const rateLimited = (resetEpochSeconds: number): Response => new Response('{}', {
  status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpochSeconds) },
});

const claims = async (): Promise<DbClaims> => ({ identityId: 'owner', backgroundJob: 'tracking.forge-watcher' });

describe('TrackingClients: one credential and one budget per space', () => {
  it('reads a space with its own token, and a space without one with the node fallback', async () => {
    const { fetchImpl, seen } = fetchFake(() => prJson());
    const clients = new TrackingClients({
      fetchImpl,
      fallbackToken: undefined,
      resolveToken: async (spaceId) => (spaceId === SPACE_A ? 'space-a-token' : undefined),
    });
    const a = await clients.forSpace(SPACE_A);
    const b = await clients.forSpace(SPACE_B);
    expect(a.budget).toBe(`space:${SPACE_A}`);
    expect(b.budget).toBe('anonymous');
    await a.client.pullRequest('acme/forge', 1);
    await b.client.pullRequest('acme/forge', 2);
    expect(seen.map((s) => s.auth)).toEqual(['Bearer space-a-token', undefined]);
  });

  it('a resolver failure falls back rather than throwing', async () => {
    const errors: string[] = [];
    const clients = new TrackingClients({
      fallbackToken: undefined,
      resolveToken: async () => { throw new Error('unreadable'); },
      onResolveError: (spaceId) => { errors.push(spaceId); },
    });
    expect((await clients.forSpace(SPACE_A)).budget).toBe('anonymous');
    expect(errors).toEqual([SPACE_A]);
  });

  it('remembers a backoff until the provider reset, then forgets it', () => {
    let now = 1_000_000;
    const clients = new TrackingClients({ fallbackToken: undefined, now: () => now });
    clients.markLimited('anonymous', now + 60_000);
    expect(clients.isLimited('anonymous')).toBe(true);
    expect(clients.isLimited(`space:${SPACE_A}`)).toBe(false);
    now += 60_001;
    expect(clients.isLimited('anonymous')).toBe(false);
  });
});

describe('forge watcher across spaces', () => {
  it('a rate limit on one space\'s budget does not stop another space, and persists to the next tick', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    const { fetchImpl, seen } = fetchFake((url, auth) => {
      if (auth === undefined && url.includes('/pulls/')) return rateLimited(reset);
      if (url.includes('/check-runs')) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      if (url.includes('/graphql')) {
        return new Response(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }));
      }
      return prJson();
    });
    const clients = new TrackingClients({
      fetchImpl,
      fallbackToken: undefined,
      resolveToken: async (spaceId) => (spaceId === SPACE_B ? 'space-b-token' : undefined),
    });
    const { db, calls } = fakeDb({
      'public.observer_watch_targets': {
        targets: [target(SPACE_A, 'pr-a1', 1), target(SPACE_A, 'pr-a2', 2), target(SPACE_B, 'pr-b1', 3)],
      },
      'public.provider_etag_lookup': {},
      'public.claim_pending_nudges': { pending: [] },
      'public.tracking_sweep_staleness': { raised: 0 },
    });

    const outcome = await runForgeWatchTick({ db, claims, clients });
    const detail = (outcome as { detail: Record<string, unknown> }).detail;
    expect(detail.rateLimited).toBe(true);
    expect(detail.skippedRateLimited).toBe(1); // pr-a2, behind pr-a1's limit
    expect(detail.limitedBudgets).toEqual(['anonymous']);
    // Space B was still read, with its own token, and its merge applied.
    const applied = calls.filter((c) => c.fn === 'public.apply_pull_request_facts').map((c) => c.args[0]);
    expect(applied).toContain('pr-b1');
    expect(applied).not.toContain('pr-a1');
    // A rate limit is not evidence about the PR: no poll recorded for pr-a1.
    const polled = calls.filter((c) => c.fn === 'public.record_tracking_poll').map((c) => c.args[0]);
    expect(polled).toEqual(['pr-b1']);

    // Next tick: the anonymous budget is still backed off, so space A spends nothing.
    seen.length = 0;
    await runForgeWatchTick({ db, claims, clients });
    expect(seen.filter((s) => s.auth === undefined)).toEqual([]);
  });

  it('records every successful poll, and runs the staleness sweep', async () => {
    const { fetchImpl } = fetchFake((url) => {
      if (url.includes('/check-runs')) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      if (url.includes('/graphql')) return new Response('{}', { status: 401 });
      return prJson();
    });
    const { db, calls } = fakeDb({
      'public.observer_watch_targets': { targets: [target(SPACE_A, 'pr-a1', 1)] },
      'public.provider_etag_lookup': {},
      'public.claim_pending_nudges': { pending: [] },
      'public.tracking_sweep_staleness': { raised: 0 },
    });
    await runForgeWatchTick({ db, claims, clients: new TrackingClients({ fetchImpl, fallbackToken: 'env' }) });
    const order = calls.map((c) => c.fn);
    expect(calls.filter((c) => c.fn === 'public.record_tracking_poll').map((c) => c.args)).toEqual([['pr-a1', null]]);
    expect(order).toContain('public.apply_pull_request_facts');
    expect(order).toContain('public.tracking_sweep_staleness');
  });

  it('records a provider error on the row, so health can show it', async () => {
    const { fetchImpl } = fetchFake(() => new Response('{}', { status: 404 }));
    const { db, calls } = fakeDb({
      'public.observer_watch_targets': { targets: [target(SPACE_A, 'pr-a1', 1)] },
      'public.provider_etag_lookup': {},
      'public.claim_pending_nudges': { pending: [] },
    });
    await runForgeWatchTick({ db, claims, clients: new TrackingClients({ fetchImpl, fallbackToken: 'env' }) });
    const poll = calls.find((c) => c.fn === 'public.record_tracking_poll');
    expect(poll?.args[0]).toBe('pr-a1');
    expect(String(poll?.args[1])).toContain('not_found');
  });
});

describe('tracking observer (`tm8 tracking refresh`)', () => {
  it('reads CI as well as state, and records the poll', async () => {
    const { fetchImpl } = fetchFake((url) => {
      if (url.includes('/check-runs')) {
        return new Response(JSON.stringify({
          check_runs: [{ id: 9, name: 'ci', status: 'completed', conclusion: 'success' }],
        }), { status: 200 });
      }
      return prJson();
    });
    const { db, calls } = fakeDb({
      'public.claim_tracking_refresh': {
        claimed: [{
          requestId: 'req-1', spaceId: SPACE_A, attempts: 1,
          targets: [{ entityId: 'pr-a1', kind: 'pull_request', provider: 'github', repo: 'acme/forge', number: 1, sha: null }],
        }],
      },
      'public.apply_pr_check_facts': { ciStatus: 'passing' },
    });
    await runTrackingObserverTick({
      db, claims, clients: new TrackingClients({ fetchImpl, fallbackToken: 'env' }),
    });
    const facts = calls.filter((c) => c.fn === 'public.apply_pull_request_facts');
    expect(facts[0]!.args[2]).toBe('merged');
    expect(facts[1]!.args[4]).toBe('passing');
    expect(calls.filter((c) => c.fn === 'public.record_tracking_poll').map((c) => c.args))
      .toEqual([['pr-a1', null]]);
    expect(calls.find((c) => c.fn === 'public.complete_tracking_refresh')?.args.slice(1)).toEqual([null, 'completed']);
  });
});

describe('the backgroundJob claim', () => {
  it('is set only where the tracking jobs are composed — never by a request path', () => {
    const src = join(__dirname, '../../src');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(src);
    const setters = files
      .filter((file) => /backgroundJob\s*:/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(src, file))
      .sort();
    // main.ts is the composition root that binds it (db/types.ts declares it
    // as an optional field, which this pattern does not match).
    expect(setters).toEqual(['main.ts']);
  });
});
