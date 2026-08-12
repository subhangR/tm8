// One tick of the forge watcher, with no network and no database.
//
// The tick's job is to be a WATCHER rather than a fetcher, and everything that
// distinguishes the two is a conditional-request or a failure-isolation
// behaviour that never shows up on the happy path:
//
//   * does it SEND the stored ETag, and does it leave the row alone on a 304?
//   * does a rate limit stop the tick without recording a verdict?
//   * does one PR that 404s take the other targets down with it?
//   * does it fetch a job log for a nudge that was going to be SUPPRESSED?
//
// 081's observer shipped with two blocking defects, both in branches no test
// entered. These are written on the assumption that this file will be the same
// if they are not.

import { describe, expect, it } from 'vitest';

import { GithubClient } from '../../src/tracking/github.js';
import { runForgeWatchTick, type ForgeWatcherOptions } from '../../src/tracking/loops.js';
import type { Db, DbClaims } from '../../src/db/types.js';

const SPACE = '11111111-1111-7111-8111-111111111111';
const PR = '22222222-2222-7222-8222-222222222222';
const SESSION = '44444444-4444-7444-8444-444444444444';

interface Call { fn: string; args: readonly unknown[] }

function watchTarget(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prEntityId: PR,
    spaceId: SPACE,
    provider: 'github',
    repo: 'acme/forge',
    number: 7,
    state: 'open',
    headSha: 'a'.repeat(40),
    headRef: 'feat/child',
    baseRef: 'main',
    mergeableState: 'clean',
    taskId: '55555555-5555-7555-8555-555555555555',
    owningSessionId: SESSION,
    owningSessionStatus: 'running',
    owningSessionLive: true,
    stackedOnOpenParent: false,
    ...over,
  };
}

/**
 * A Db whose door results are supplied per-RPC. Only `rpc` is implemented — the
 * tick touches nothing else, and a richer fake would invite a test to prove
 * something about the fake.
 */
function fakeDb(results: Record<string, unknown>): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const db = {
    rpc: async (_c: DbClaims, fn: string, args: readonly unknown[] = []) => {
      calls.push({ fn, args });
      const value = results[fn];
      if (value instanceof Error) throw value;
      return value ?? {};
    },
  } as unknown as Db;
  return { db, calls };
}

interface Seen { url: string; headers: Record<string, string>; method: string }

/** A GithubClient whose transport is a function, so no network is involved. */
function client(
  handler: (url: string, init: RequestInit) => Response,
  seen: Seen[] = [],
  token = 'test-token',
): GithubClient {
  return new GithubClient({
    token,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>),
      );
      seen.push({ url: String(input), headers, method: init?.method ?? 'GET' });
      return handler(String(input), init ?? {});
    }) as typeof fetch,
  });
}

const prBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    title: 'a pull request',
    state: 'open',
    head: { sha: 'a'.repeat(40), ref: 'feat/child' },
    base: { ref: 'main' },
    mergeable_state: 'clean',
    ...over,
  });

const json = (body: string, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(body, { status, headers });

/** 304 is a null-body status; `new Response('', {status:304})` throws outright. */
const notModified = (): Response => new Response(null, { status: 304 });

/** Routes the four endpoints the tick can touch. Everything else 404s loudly. */
function route(over: {
  pr?: () => Response;
  checks?: () => Response;
  graphql?: () => Response;
  logs?: () => Response;
} = {}): (url: string) => Response {
  return (url: string) => {
    if (url.includes('/graphql')) {
      return (over.graphql ?? (() => json(JSON.stringify({
        data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
      }))))();
    }
    if (url.includes('/actions/jobs/')) return (over.logs ?? (() => json('no log', 404)))();
    if (url.includes('/check-runs')) {
      return (over.checks ?? (() => json(JSON.stringify({ check_runs: [] }))))();
    }
    if (url.includes('/pulls/')) return (over.pr ?? (() => json(prBody())))();
    return json('{}', 404);
  };
}

/** One row as 102 §K's drain read returns it. */
function pendingRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pendingId: 'pending-1',
    spaceId: SPACE,
    prEntityId: PR,
    loopKind: 'ci_failure',
    scopeKey: `build@${'a'.repeat(40)}`,
    headSha: 'a'.repeat(40),
    payload: { name: 'build', status: 'completed', conclusion: 'failure', externalId: '9001' },
    attempts: 0,
    repo: 'acme/forge',
    number: 7,
    headRef: 'feat/child',
    baseRef: 'main',
    taskId: '55555555-5555-7555-8555-555555555555',
    owningSessionId: SESSION,
    ...over,
  };
}

function options(over: Partial<ForgeWatcherOptions> & { db: Db }): ForgeWatcherOptions {
  return { claims: async () => ({ identityId: 'i' }), ...over };
}

const calls = (list: Call[], fn: string): Call[] => list.filter((c) => c.fn === fn);

describe('an empty watch list is a skip with a reason, not a silent no-op', () => {
  it('skips', async () => {
    const { db } = fakeDb({ 'public.observer_watch_targets': { targets: [] } });
    const outcome = await runForgeWatchTick(options({ db, client: client(route()) }));
    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toBeTruthy();
  });

  it('the watch-list read carries its bounds', async () => {
    const { db, list } = (() => {
      const f = fakeDb({ 'public.observer_watch_targets': { targets: [] } });
      return { db: f.db, list: f.calls };
    })();
    await runForgeWatchTick(options({ db, targetBudget: 11, minAgeSeconds: 42 }));
    expect(list[0]).toEqual({ fn: 'public.observer_watch_targets', args: [11, 42] });
  });
});

describe('conditional requests are what make a watcher affordable', () => {
  it('sends the stored ETag on the pull request read', async () => {
    const seen: Seen[] = [];
    const { db } = fakeDb({
      'public.observer_watch_targets': { targets: [watchTarget()] },
      'public.provider_etag_lookup': { 'gh:pr:acme/forge#7': 'W/"stored"' },
      'public.apply_pull_request_facts': { previousMergeableState: 'clean', mergeableState: 'clean' },
      'public.apply_pr_check_facts': { newlyFailing: [], ciStatus: null },
      'public.apply_pr_review_thread_facts': { newlyUnresolved: [] },
    });
    await runForgeWatchTick(options({ db, client: client(route(), seen) }));

    const prRequest = seen.find((s) => s.url.includes('/pulls/'));
    expect(prRequest?.headers['if-none-match']).toBe('W/"stored"');
  });

  it('BLOCKING — a 304 writes NO facts and records the hit', async () => {
    // A 304 means the stored row is current. Applying facts anyway would stamp
    // `fetched_at`, bump the version and — because the response body is empty —
    // risk blanking columns the provider never spoke about.
    const { db, calls: list } = fakeDb({
      'public.observer_watch_targets': { targets: [watchTarget()] },
      'public.provider_etag_lookup': { 'gh:pr:acme/forge#7': 'W/"stored"' },
      'public.apply_pr_check_facts': { newlyFailing: [], ciStatus: null },
      'public.apply_pr_review_thread_facts': { newlyUnresolved: [] },
    });
    const outcome = await runForgeWatchTick(
      options({ db, client: client(route({ pr: notModified })) }),
    );

    expect(calls(list, 'public.apply_pull_request_facts')).toEqual([]);
    const recorded = calls(list, 'public.provider_etag_record')[0];
    expect(recorded?.args).toEqual([SPACE, 'gh:pr:acme/forge#7', null, true]);
    expect((outcome.detail as Record<string, unknown>).notModified).toBe(1);
  });

  it('BLOCKING — an unchanged PR is not mistaken for a NEW conflict on every tick', async () => {
    // The trap: on a 304 there is no fresh mergeable_state, and treating the
    // missing value as "not dirty before, dirty now" would fire the conflict
    // loop every ninety seconds for a PR nobody touched.
    const { db, calls: list } = fakeDb({
      'public.observer_watch_targets': { targets: [watchTarget({ mergeableState: 'dirty' })] },
      'public.provider_etag_lookup': { 'gh:pr:acme/forge#7': 'W/"stored"' },
      'public.apply_pr_check_facts': { newlyFailing: [], ciStatus: null },
      'public.apply_pr_review_thread_facts': { newlyUnresolved: [] },
    });
    await runForgeWatchTick(options({ db, client: client(route({ pr: notModified })) }));
    expect(calls(list, 'public.post_session_nudge')).toEqual([]);
  });

  it('stores the fresh validator on a 200', async () => {
    const { db, calls: list } = fakeDb({
      'public.observer_watch_targets': { targets: [watchTarget()] },
      'public.provider_etag_lookup': {},
      'public.apply_pull_request_facts': { previousMergeableState: 'clean', mergeableState: 'clean' },
      'public.apply_pr_check_facts': { newlyFailing: [], ciStatus: null },
      'public.apply_pr_review_thread_facts': { newlyUnresolved: [] },
    });
    await runForgeWatchTick(
      options({ db, client: client(route({ pr: () => json(prBody(), 200, { etag: 'W/"fresh"' }) })) }),
    );
    expect(calls(list, 'public.provider_etag_record')[0]?.args).toEqual([
      SPACE, 'gh:pr:acme/forge#7', 'W/"fresh"', false,
    ]);
  });
});

describe('the CI loop', () => {
  const redRun = {
    id: 9001, name: 'build', status: 'completed', conclusion: 'failure',
    details_url: 'https://github.com/acme/forge/runs/9001',
  };

  function ciWorld(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      'public.observer_watch_targets': { targets: [watchTarget()] },
      'public.provider_etag_lookup': {},
      'public.apply_pull_request_facts': { previousMergeableState: 'clean', mergeableState: 'clean' },
      'public.apply_pr_check_facts': {
        newlyFailing: [{ name: 'build', status: 'completed', conclusion: 'failure', externalId: '9001' }],
        ciStatus: 'failing',
      },
      'public.apply_pr_review_thread_facts': { newlyUnresolved: [] },
      'public.claim_pending_nudges': { pending: [] },
      ...over,
    };
  }

  it('posts the failure with the log tail inlined, via the drain', async () => {
    const log = Array.from({ length: 300 }, (_, i) => `line ${String(i)}`).join('\n');
    const { db, calls: list } = fakeDb(ciWorld({
      // The apply door queued this transition; the drain is what delivers it.
      'public.claim_pending_nudges': { pending: [pendingRow()] },
      'public.post_session_nudge': { posted: true, messageId: 'm1', workSessionId: SESSION },
    }));
    const outcome = await runForgeWatchTick(options({
      db,
      client: client(route({
        checks: () => json(JSON.stringify({ check_runs: [redRun] })),
        logs: () => json(log),
      })),
      logTailLines: 100,
    }));

    const post = calls(list, 'public.post_session_nudge')[0];
    const body = String(post?.args[2]);
    expect(body).toContain('CI FAILED');
    expect(body).toContain('line 299');
    expect(body).not.toContain('line 150');
    expect(outcome.affected).toBe(1);
  });

  it('writes the rollup ci_status back through the door that computed it', async () => {
    const { db, calls: list } = fakeDb(ciWorld());
    await runForgeWatchTick(options({
      db,
      client: client(route({ checks: () => json(JSON.stringify({ check_runs: [redRun] })) })),
    }));
    // Second apply call, carrying only the rollup — the first one deliberately
    // passes null for ci_status so the column never holds a guess.
    const applies = calls(list, 'public.apply_pull_request_facts');
    expect(applies[0]?.args[4]).toBeNull();
    expect(applies[1]?.args[4]).toBe('failing');
  });

  it('does NOT fetch a job log when nothing is queued for delivery', async () => {
    // The log is the most expensive call in the tick, and it is now fetched in
    // the DRAIN — so a transition with no live addressee (not handed out by
    // claim_pending_nudges) costs no provider quota at all.
    const seen: Seen[] = [];
    const { db } = fakeDb(ciWorld({ 'public.claim_pending_nudges': { pending: [] } }));
    await runForgeWatchTick(options({
      db,
      client: client(route({ checks: () => json(JSON.stringify({ check_runs: [redRun] })) }), seen),
    }));
    expect(seen.some((s) => s.url.includes('/actions/jobs/'))).toBe(false);
  });

  it('still nudges when the log cannot be read', async () => {
    const { db, calls: list } = fakeDb(ciWorld({
      'public.claim_pending_nudges': { pending: [pendingRow()] },
      'public.post_session_nudge': { posted: true, messageId: 'm1', workSessionId: SESSION },
    }));
    await runForgeWatchTick(options({
      db,
      client: client(route({
        checks: () => json(JSON.stringify({ check_runs: [redRun] })),
        logs: () => json('nope', 500),
      })),
    }));
    expect(String(calls(list, 'public.post_session_nudge')[0]?.args[2]))
      .toContain('Log tail unavailable');
  });
});

describe('the review-thread loop', () => {
  it('delivers only the threads the door called NEW, with their comment bodies', async () => {
    const graphql = JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes: [
        { id: 'RT_new', isResolved: false, isOutdated: false, path: 'src/a.ts', line: 3,
          comments: { nodes: [{ id: 'c1', body: 'this leaks', author: { login: 'reviewer' } }] } },
        { id: 'RT_old', isResolved: false, isOutdated: false, path: 'src/b.ts', line: 9,
          comments: { nodes: [{ id: 'c2', body: 'told you already', author: { login: 'reviewer' } }] } },
      ] } } } },
    });
    const { db, calls: list } = fakeDb({
      'public.observer_watch_targets': { targets: [watchTarget()] },
      'public.provider_etag_lookup': {},
      'public.apply_pull_request_facts': { previousMergeableState: 'clean', mergeableState: 'clean' },
      'public.apply_pr_check_facts': { newlyFailing: [], ciStatus: null },
      // The door saw RT_old last tick; only RT_new is news — and it queues it,
      // carrying the excerpt so the drain needs no second GraphQL call.
      'public.apply_pr_review_thread_facts': { newlyUnresolved: [{ threadKey: 'RT_new' }] },
      'public.claim_pending_nudges': {
        pending: [pendingRow({
          loopKind: 'review_thread',
          scopeKey: 'RT_new',
          headSha: null,
          payload: { threadKey: 'RT_new', path: 'src/a.ts', line: 3, author: 'reviewer',
                     bodyExcerpt: 'this leaks' },
        })],
      },
      'public.post_session_nudge': { posted: true, messageId: 'm1', workSessionId: SESSION },
    });
    await runForgeWatchTick(options({ db, client: client(route({ graphql: () => json(graphql) })) }));

    const posts = calls(list, 'public.post_session_nudge');
    expect(posts).toHaveLength(1);
    expect(String(posts[0]?.args[2])).toContain('this leaks');
    expect(String(posts[0]?.args[2])).not.toContain('told you already');
  });

  it('a GraphQL 200-with-errors is a failure, not zero unresolved threads', async () => {
    // Reading it as success records "the reviewer is happy" for a query that
    // never ran — silence in the reassuring direction.
    const { db, calls: list } = fakeDb({
      'public.observer_watch_targets': { targets: [watchTarget()] },
      'public.provider_etag_lookup': {},
      'public.apply_pull_request_facts': { previousMergeableState: 'clean', mergeableState: 'clean' },
      'public.apply_pr_check_facts': { newlyFailing: [], ciStatus: null },
    });
    const outcome = await runForgeWatchTick(options({
      db,
      client: client(route({
        graphql: () => json(JSON.stringify({ errors: [{ message: 'Bad credentials' }] })),
      })),
    }));
    expect(calls(list, 'public.apply_pr_review_thread_facts')).toEqual([]);
    expect(String((outcome.detail as { problems: string[] }).problems[0])).toContain('Bad credentials');
  });

  it('an unauthenticated node runs the other two loops without complaining per PR', async () => {
    // GraphQL refuses anonymous requests outright. That is a permanent property
    // of the node, not a per-pull-request incident.
    const { db, calls: list } = fakeDb({
      'public.observer_watch_targets': { targets: [watchTarget()] },
      'public.provider_etag_lookup': {},
      'public.apply_pull_request_facts': { previousMergeableState: 'clean', mergeableState: 'clean' },
      'public.apply_pr_check_facts': { newlyFailing: [], ciStatus: null },
    });
    const outcome = await runForgeWatchTick(
      options({ db, client: client(route(), [], '') }),
    );
    expect((outcome.detail as { problems: string[] }).problems).toEqual([]);
    expect(calls(list, 'public.apply_pull_request_facts').length).toBeGreaterThan(0);
  });
});

describe('failure is bounded to the target it happened to', () => {
  it('BLOCKING REGRESSION — one PR that 404s does not end the tick', async () => {
    let n = 0;
    const { db, calls: list } = fakeDb({
      'public.observer_watch_targets': {
        targets: [watchTarget({ number: 7 }), watchTarget({ number: 8, prEntityId: 'pr-8' })],
      },
      'public.provider_etag_lookup': {},
      'public.apply_pull_request_facts': { previousMergeableState: 'clean', mergeableState: 'clean' },
      'public.apply_pr_check_facts': { newlyFailing: [], ciStatus: null },
      'public.apply_pr_review_thread_facts': { newlyUnresolved: [] },
    });
    await runForgeWatchTick(options({
      db,
      client: client(route({
        pr: () => {
          n += 1;
          return n === 1 ? json('{}', 404) : json(prBody());
        },
      })),
    }));
    // The second PR was still serviced.
    expect(calls(list, 'public.apply_pull_request_facts').length).toBeGreaterThan(0);
  });

  it('BLOCKING REGRESSION — a throwing apply is a per-target problem, not a dead tick', async () => {
    // `Db.rpc` throws on any Postgres error. Uncaught, a single 42501 abandons
    // every other PR in the tick, every tick.
    const { db, calls: list } = fakeDb({
      'public.observer_watch_targets': {
        targets: [watchTarget({ number: 7 }), watchTarget({ number: 8, prEntityId: 'pr-8' })],
      },
      'public.provider_etag_lookup': {},
      'public.apply_pull_request_facts': new Error('permission denied for schema public (42501)'),
      'public.apply_pr_check_facts': { newlyFailing: [], ciStatus: null },
      'public.apply_pr_review_thread_facts': { newlyUnresolved: [] },
    });
    const outcome = await runForgeWatchTick(options({ db, client: client(route()) }));
    expect(calls(list, 'public.apply_pull_request_facts')).toHaveLength(2);
    const problems = (outcome.detail as { problems: string[] }).problems;
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('42501');
  });

  it('a rate limit STOPS the tick and marks nothing', async () => {
    const { db, calls: list } = fakeDb({
      'public.observer_watch_targets': {
        targets: [watchTarget({ number: 7 }), watchTarget({ number: 8, prEntityId: 'pr-8' })],
      },
      'public.provider_etag_lookup': {},
    });
    const outcome = await runForgeWatchTick(options({
      db,
      client: client(route({
        pr: () => json('{}', 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '999' }),
      })),
    }));
    expect((outcome.detail as { rateLimited: boolean }).rateLimited).toBe(true);
    expect(calls(list, 'public.apply_pull_request_facts')).toEqual([]);
    // Stopped, not merely skipped: the second target was never attempted.
    expect(calls(list, 'public.provider_etag_lookup')).toHaveLength(1);
  });

  it('an abort signal ends the tick between targets', async () => {
    const controller = new AbortController();
    const { db, calls: list } = fakeDb({
      'public.observer_watch_targets': {
        targets: [watchTarget({ number: 7 }), watchTarget({ number: 8, prEntityId: 'pr-8' })],
      },
      'public.provider_etag_lookup': {},
      'public.apply_pull_request_facts': { previousMergeableState: 'clean', mergeableState: 'clean' },
      'public.apply_pr_check_facts': { newlyFailing: [], ciStatus: null },
      'public.apply_pr_review_thread_facts': { newlyUnresolved: [] },
    });
    await runForgeWatchTick(
      options({
        db,
        client: client(route({ pr: () => { controller.abort(); return json(prBody()); } })),
      }),
      controller.signal,
    );
    expect(calls(list, 'public.provider_etag_lookup')).toHaveLength(1);
  });

  it('a non-github provider is recorded as unimplemented, never silently completed', async () => {
    const { db } = fakeDb({
      'public.observer_watch_targets': { targets: [watchTarget({ provider: 'gitlab' })] },
    });
    const outcome = await runForgeWatchTick(options({ db, client: client(route()) }));
    expect(String((outcome.detail as { problems: string[] }).problems[0])).toContain('gitlab');
  });
});

describe('the job log redirect must not carry our credential', () => {
  it('BLOCKING SECURITY — the 302 is followed by hand, with NO authorization header', async () => {
    // GitHub 302s the log endpoint to objects.githubusercontent.com. Whether
    // undici strips `authorization` on a cross-origin redirect is
    // version-dependent; if it does not, the node's token is posted to a
    // third-party host on every CI failure and nothing in the logs shows it.
    // So the follow is ours: redirect:'manual', then fetch unauthenticated.
    const seen: Seen[] = [];
    const redRun = { id: 9001, name: 'build', status: 'completed', conclusion: 'failure' };
    const { db } = fakeDb({
      'public.observer_watch_targets': { targets: [watchTarget()] },
      'public.provider_etag_lookup': {},
      'public.apply_pull_request_facts': { previousMergeableState: 'clean', mergeableState: 'clean' },
      'public.apply_pr_check_facts': {
        newlyFailing: [{ name: 'build', status: 'completed', conclusion: 'failure', externalId: '9001' }],
        ciStatus: 'failing',
      },
      'public.apply_pr_review_thread_facts': { newlyUnresolved: [] },
      'public.claim_pending_nudges': { pending: [pendingRow()] },
      'public.post_session_nudge': { posted: true, messageId: 'm1', workSessionId: SESSION },
    });

    const BLOB = 'https://objects.githubusercontent.com/signed-blob?token=abc';
    const gh = client(
      (url) => {
        if (url === BLOB) return json('the log tail');
        if (url.includes('/actions/jobs/')) {
          return new Response(null, { status: 302, headers: { location: BLOB } });
        }
        if (url.includes('/check-runs')) return json(JSON.stringify({ check_runs: [redRun] }));
        if (url.includes('/graphql')) {
          return json(JSON.stringify({
            data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } },
          }));
        }
        return json(prBody());
      },
      seen,
    );
    await runForgeWatchTick(options({ db, client: gh }));

    const apiCall = seen.find((s) => s.url.includes('/actions/jobs/'));
    expect(apiCall?.headers.authorization).toBe('Bearer test-token');

    const blobCall = seen.find((s) => s.url === BLOB);
    expect(blobCall).toBeTruthy();
    expect(blobCall?.headers.authorization).toBeUndefined();
  });
});
