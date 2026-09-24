/**
 * `tm8 form wait` — the loop (Forms W2, §7.4), driven dry: a fake clock, a fake
 * change feed and fake reads, so every assertion is about the loop's decisions
 * (what counts as new, which outcome wins, when it degrades), not about a wire.
 * The real-Server runs live in test/integration/form.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { FormResponseView } from '@tm8/contract';
import {
  currentBaseline,
  EXIT_BY_OUTCOME,
  FEED_BACKOFF_MS,
  findNew,
  parseCancelReason,
  POLL_BACKOFF_MS,
  REQUEST_MIN_MS,
  runFormWait,
  STATE_REREAD_MS,
  type FormWaitDeps,
  type WaitBaseline,
} from '../src/commands/form-wait.js';
import { ApiError, TransportError } from '../src/errors.js';
import { EXIT_CODES, EXIT_FORM_TERMINAL, EXIT_OK, EXIT_WAIT_TIMEOUT } from '../src/exit.js';

const FORM = '22222222-2222-7222-8222-222222222222';
const T0 = Date.parse('2026-09-24T12:00:00.000Z');

function view(id: string, submittedAtMs: number, extra: Partial<FormResponseView> = {}): FormResponseView {
  return {
    id, formId: FORM, respondentId: 'm1', respondentName: 'Ada', status: 'submitted', revision: 1,
    supersedesId: null, lineageKey: 'l1', isCurrent: true, structureVersion: 1, answers: {},
    questionsSnapshot: null, messageId: null, createdAt: new Date(submittedAtMs).toISOString(),
    updatedAt: new Date(submittedAtMs).toISOString(), submittedAt: new Date(submittedAtMs).toISOString(),
    version: 1, deliveries: [], ...extra,
  };
}

/**
 * A scripted world. `at(ms, fn)` mutates it when the fake clock passes `ms`
 * (relative to the start); `sleep` advances the clock, so nothing really waits.
 */
function world(opts: { feed?: 'ok' | 'refuse' | 'refuse-later' } = {}) {
  let clock = 0;
  let seq = 100;
  let rows: FormResponseView[] = [];
  let status = 'open';
  let messages: string[] = [];
  const scheduled: { at: number; fn: () => void }[] = [];
  const calls = { list: 0, changes: 0, status: 0, sleeps: [] as number[], warnings: [] as string[] };
  let feedCalls = 0;
  const fire = () => {
    for (const s of scheduled.filter((x) => x.at <= clock)) {
      s.fn();
      seq += 1;
      scheduled.splice(scheduled.indexOf(s), 1);
    }
  };
  let lastSeen = 0;
  const deps: FormWaitDeps = {
    listPage: async () => {
      calls.list++;
      const items = [...rows].sort((a, b) => Date.parse(b.submittedAt!) - Date.parse(a.submittedAt!));
      return { items, nextCursor: null };
    },
    getResponse: async (id) => {
      const r = rows.find((x) => x.id === id);
      if (!r) throw new Error(`no ${id}`);
      return r;
    },
    formStatus: async () => {
      calls.status++;
      return status;
    },
    formMessages: async () => messages,
    changes: async (after) => {
      calls.changes++;
      feedCalls++;
      if (opts.feed === 'refuse' || (opts.feed === 'refuse-later' && feedCalls > 1)) {
        throw new ApiError(422, 'invalid_input', 'index_incomplete', 'req', false, { reason: 'index_incomplete' });
      }
      const changed = after !== 0 && seq > lastSeen;
      lastSeen = seq;
      return { through: seq, changed };
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock += ms;
      fire();
    },
    now: () => clock,
    warn: (line) => calls.warnings.push(line),
  };
  return {
    deps,
    calls,
    at: (ms: number, fn: () => void) => scheduled.push({ at: ms, fn }),
    submit: (r: FormResponseView) => { rows = [...rows.filter((x) => x.lineageKey !== r.lineageKey || x.id === r.id), r]; },
    setStatus: (s: string) => { status = s; },
    setMessages: (m: string[]) => { messages = m; },
    rows: () => rows,
  };
}

const NONE: WaitBaseline = { at: null, tieIds: new Set(), resume: null };

describe('exit codes', () => {
  it('answered 0, terminal 15, timeout 13 — all in the frozen table, all distinct', () => {
    expect(EXIT_BY_OUTCOME).toEqual({ answered: EXIT_OK, terminal: EXIT_FORM_TERMINAL, timeout: EXIT_WAIT_TIMEOUT });
    expect([EXIT_OK, EXIT_FORM_TERMINAL, EXIT_WAIT_TIMEOUT]).toEqual([0, 15, 13]);
    for (const c of Object.values(EXIT_BY_OUTCOME)) expect(EXIT_CODES).toContain(c);
  });
});

describe('what counts as new', () => {
  it('the baseline is the newest submitted response, by Server time', async () => {
    const w = world();
    w.submit(view('r1', T0, { lineageKey: 'a' }));
    w.submit(view('r2', T0 + 5, { lineageKey: 'b' }));
    const base = await currentBaseline(w.deps, 1_000);
    expect(base).toMatchObject({ at: T0 + 5, resume: 'r2' });
    expect(await findNew(w.deps, base, 1_000)).toBeUndefined();
  });

  it('prints the OLDEST new response, so --since <printed-id> chains without skipping', async () => {
    const w = world();
    w.submit(view('old', T0, { lineageKey: 'a' }));
    const base: WaitBaseline = { at: T0, tieIds: new Set(['old']), resume: 'old' };
    w.submit(view('n1', T0 + 10, { lineageKey: 'b' }));
    w.submit(view('n2', T0 + 20, { lineageKey: 'c' }));
    expect((await findNew(w.deps, base, 1_000))?.id).toBe('n1');
    expect((await findNew(w.deps, { at: T0 + 10, tieIds: new Set(['n1']), resume: 'n1' }, 1_000))?.id).toBe('n2');
  });

  it('a same-millisecond sibling is new unless it was already seen; a --since timestamp is strict', async () => {
    const w = world();
    w.submit(view('seen', T0, { lineageKey: 'a' }));
    w.submit(view('twin', T0, { lineageKey: 'b' }));
    expect((await findNew(w.deps, { at: T0, tieIds: new Set(['seen']), resume: 'seen' }, 1_000))?.id).toBe('twin');
    expect(await findNew(w.deps, { at: T0, tieIds: null, resume: null }, 1_000)).toBeUndefined();
  });

  it('an amend (revision 2 superseding the baseline) counts as new', async () => {
    const w = world();
    w.submit(view('rev1', T0, { lineageKey: 'l' }));
    const base = await currentBaseline(w.deps, 1_000);
    w.submit(view('rev2', T0 + 1_000, { lineageKey: 'l', revision: 2, supersedesId: 'rev1' }));
    expect(await findNew(w.deps, base, 1_000)).toMatchObject({ id: 'rev2', revision: 2 });
  });
});

describe('runFormWait', () => {
  it('answered before the wait started but after --since: returns at once, no sleep', async () => {
    const w = world();
    w.submit(view('r1', T0, { lineageKey: 'a' }));
    w.submit(view('r2', T0 + 1, { lineageKey: 'b' }));
    const out = await runFormWait(w.deps, FORM, { at: T0, tieIds: new Set(['r1']), resume: 'r1' }, 600_000);
    expect(out).toMatchObject({ kind: 'answered', response: { id: 'r2' } });
    expect(w.calls.sleeps).toEqual([]);
  });

  it('a submit during the wait: the feed wakes it within one backoff step', async () => {
    const w = world();
    w.at(7_000, () => w.submit(view('r1', T0 + 7_000)));
    const out = await runFormWait(w.deps, FORM, NONE, 600_000);
    expect(out).toMatchObject({ kind: 'answered', response: { id: 'r1' } });
    // 1s, 2s, 4s: the change lands at 7s, seen on the tick that reaches it.
    expect(w.calls.sleeps).toEqual([1_000, 2_000, 4_000]);
    // Quiet ticks cost one feed call each, not a state re-read.
    expect(w.calls.list).toBe(2);
  });

  it('closeOnSubmit — the response and the close in one transaction — is answered (0), not terminal', async () => {
    const w = world();
    w.at(3_000, () => { w.submit(view('r1', T0 + 3_000)); w.setStatus('closed'); });
    const out = await runFormWait(w.deps, FORM, NONE, 600_000);
    expect(out.kind).toBe('answered');
  });

  it('cancel: terminal (15) with the reason parsed from the notice, as data', async () => {
    const w = world();
    w.at(2_000, () => {
      w.setStatus('cancelled');
      w.setMessages([`form_cancelled: T\nform: ${FORM}\nreason: no longer needed; $(rm -rf /)`]);
    });
    const out = await runFormWait(w.deps, FORM, NONE, 600_000);
    expect(out).toEqual({ kind: 'terminal', status: 'cancelled', reason: 'no longer needed; $(rm -rf /)' });
  });

  it('cancel with no reason, or an unreadable notice, is still terminal', async () => {
    const w = world();
    w.setStatus('cancelled');
    w.setMessages([`form_cancelled: T\nform: ${FORM}`]);
    expect(await runFormWait(w.deps, FORM, NONE, 600_000)).toEqual({ kind: 'terminal', status: 'cancelled', reason: null });
    const broken = world();
    broken.setStatus('cancelled');
    broken.deps.formMessages = async () => { throw new Error('boom'); };
    expect(await runFormWait(broken.deps, FORM, NONE, 600_000)).toMatchObject({ kind: 'terminal', reason: null });
  });

  it('closed (no new response) is terminal with a null reason', async () => {
    const w = world();
    w.at(1_000, () => w.setStatus('closed'));
    expect(await runFormWait(w.deps, FORM, NONE, 600_000)).toEqual({ kind: 'terminal', status: 'closed', reason: null });
  });

  it('timeout: 13, with the baseline as the resume token; never sleeps past the deadline', async () => {
    const w = world();
    const out = await runFormWait(w.deps, FORM, { at: T0, tieIds: new Set(['r0']), resume: 'r0' }, 10_000);
    expect(out).toEqual({ kind: 'timeout', resume: 'r0' });
    expect(w.calls.sleeps.reduce((a, b) => a + b, 0)).toBe(10_000);
    expect(Math.max(...w.calls.sleeps)).toBeLessThanOrEqual(FEED_BACKOFF_MS.cap);
  });

  it('an answer in the last backoff interval is still found (the deadline tick re-reads)', async () => {
    const w = world();
    w.at(9_500, () => w.submit(view('late', T0 + 9_500)));
    const out = await runFormWait(w.deps, FORM, NONE, 10_000);
    expect(out).toMatchObject({ kind: 'answered', response: { id: 'late' } });
  });

  it('the bounded fallback: a quiet feed still re-reads the state every STATE_REREAD_MS', async () => {
    const w = world();
    // A write the feed never reports (e.g. hidden from the caller's event RLS).
    w.deps.changes = async () => ({ through: 1, changed: false });
    w.at(12_000, () => w.submit(view('quiet', T0 + 12_000)));
    const out = await runFormWait(w.deps, FORM, NONE, 600_000);
    expect(out).toMatchObject({ kind: 'answered', response: { id: 'quiet' } });
    expect(w.deps.now()).toBeGreaterThanOrEqual(STATE_REREAD_MS);
    expect(w.deps.now()).toBeLessThan(STATE_REREAD_MS + FEED_BACKOFF_MS.cap + 1);
  });

  it('events.changes refuses: degrades to polling the reads, 1s doubling to a 10s cap, and says so once', async () => {
    const w = world({ feed: 'refuse' });
    w.at(40_000, () => w.submit(view('r1', T0 + 40_000)));
    const out = await runFormWait(w.deps, FORM, NONE, 600_000);
    expect(out).toMatchObject({ kind: 'answered', response: { id: 'r1' } });
    // 1+2+4+8+10+10 = 35s, then the 45s tick sees the 40s submit.
    expect(w.calls.sleeps).toEqual([1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000]);
    expect(Math.max(...w.calls.sleeps)).toBe(POLL_BACKOFF_MS.cap);
    expect(w.calls.warnings).toHaveLength(1);
    expect(w.calls.warnings[0]).toMatch(/polling the form instead/);
  });

  it('a feed that refuses mid-wait also degrades, rather than failing the wait', async () => {
    const w = world({ feed: 'refuse-later' });
    w.at(5_000, () => w.submit(view('r1', T0 + 5_000)));
    const out = await runFormWait(w.deps, FORM, NONE, 600_000);
    expect(out.kind).toBe('answered');
    expect(w.calls.warnings).toHaveLength(1);
  });

  it('a retryable blip on a read costs a tick, not the wait', async () => {
    const w = world();
    let failures = 1;
    const list = w.deps.listPage;
    w.deps.listPage = async (c, t) => {
      if (w.deps.now() > 0 && failures-- > 0) {
        throw new ApiError(503, 'upstream_unavailable', 'blip', 'req', true, null);
      }
      return list(c, t);
    };
    w.at(1_000, () => w.submit(view('r1', T0 + 1_000)));
    expect(await runFormWait(w.deps, FORM, NONE, 600_000)).toMatchObject({ kind: 'answered' });
  });
});

describe('transport blips', () => {
  it('a per-request deadline on the feed is a blip: the reads decide that tick, the feed stays on', async () => {
    const w = world();
    const changes = w.deps.changes;
    let n = 0;
    w.deps.changes = async (after, t) => {
      if (++n === 2) throw new TransportError('GET …/events/changes timed out after 1881ms (per-request deadline)');
      return changes(after, t);
    };
    w.at(3_000, () => w.submit(view('r1', T0 + 3_000)));
    expect(await runFormWait(w.deps, FORM, NONE, 600_000)).toMatchObject({ kind: 'answered' });
    expect(w.calls.warnings).toEqual([]);
  });
});

describe('a slow Server: only the deadline ends the wait', () => {
  const slow = () => new TransportError('GET /v2/entities/<form> timed out after 1000ms (per-request deadline)');

  it('a per-request timeout on the LAST tick is a timeout (13), not a transport failure (7)', async () => {
    const w = world();
    const status = w.deps.formStatus;
    w.deps.formStatus = async (t) => {
      if (w.deps.now() >= 10_000) throw slow();
      return status(t);
    };
    expect(await runFormWait(w.deps, FORM, { at: T0, tieIds: new Set(['r0']), resume: 'r0' }, 10_000))
      .toEqual({ kind: 'timeout', resume: 'r0' });
  });

  it('a per-request timeout on a MIDDLE tick is no news: the wait goes on and still finds the answer', async () => {
    const w = world();
    const list = w.deps.listPage;
    let failed = 0;
    w.deps.listPage = async (c, t) => {
      if (w.deps.now() >= 3_000 && failed < 2) {
        failed++;
        throw slow();
      }
      return list(c, t);
    };
    w.at(3_000, () => w.submit(view('r1', T0 + 3_000)));
    expect(await runFormWait(w.deps, FORM, NONE, 600_000)).toMatchObject({ kind: 'answered', response: { id: 'r1' } });
    expect(failed).toBe(2);
    expect(w.calls.warnings).toEqual([]);
  });

  it('the first state read timing out is no news either', async () => {
    const w = world();
    const status = w.deps.formStatus;
    let n = 0;
    w.deps.formStatus = async (t) => {
      if (n++ === 0) throw slow();
      return status(t);
    };
    w.at(2_000, () => w.setStatus('closed'));
    expect(await runFormWait(w.deps, FORM, NONE, 600_000)).toMatchObject({ kind: 'terminal', status: 'closed' });
  });

  it('every read gets at least REQUEST_MIN_MS, even on the deadline tick', async () => {
    const w = world();
    const budgets: number[] = [];
    const status = w.deps.formStatus;
    w.deps.formStatus = async (t) => {
      budgets.push(t);
      return status(t);
    };
    await runFormWait(w.deps, FORM, NONE, 3_000);
    expect(budgets.length).toBeGreaterThan(1);
    expect(Math.min(...budgets)).toBe(REQUEST_MIN_MS);
  });

  it('a transient failure SEEDING the feed retries the seed; it does not drop to polling', async () => {
    const w = world();
    const changes = w.deps.changes;
    let n = 0;
    w.deps.changes = async (after, t) => {
      if (n++ === 0) throw slow();
      return changes(after, t);
    };
    w.at(6_000, () => w.submit(view('r1', T0 + 6_000)));
    expect(await runFormWait(w.deps, FORM, NONE, 600_000)).toMatchObject({ kind: 'answered' });
    expect(w.calls.warnings).toEqual([]);
  });

  it('a hard refusal on a read still ends the wait with its own error', async () => {
    const w = world();
    w.deps.formStatus = async () => { throw new ApiError(404, 'not_found', 'no form', 'req', false, null); };
    await expect(runFormWait(w.deps, FORM, NONE, 600_000)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('parseCancelReason', () => {
  it('reads the reason line of THIS form\'s notice and ignores other bodies', () => {
    const other = '22222222-2222-7222-8222-999999999999';
    expect(parseCancelReason([
      'Form: T\n1. [pick] Pick one → a',
      `form_cancelled: T\nform: ${other}\nreason: not this one`,
      `form_cancelled: T\nform: ${FORM}\nreason: multi\nline`,
    ], FORM)).toBe('multi\nline');
    expect(parseCancelReason([], FORM)).toBeNull();
  });
});
