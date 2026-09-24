/**
 * `events.changes` against a real database — spec doc 01a0cf35 §6, acceptance
 * 1, 3–8, 12, 14, 15, and the §3.3 floor measurement. (Acceptance 2 and 13 —
 * the differential oracle and the `more` chains — live in
 * changes-oracle.pg.test.ts.)
 *
 * Every event under test is written by the capture trigger in response to a
 * `public.*` RPC; the only superuser writes are the ones no RPC can make (a
 * hard delete, a pruned range, a session envelope, a watermark).
 */
import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  EVENT_CHANGES_MIN_TOTAL_BYTES,
  getOperation,
  isCollabError,
  type EntityContextV2View,
  type EventChangeEntry,
  type EventChangesView,
} from '@tm8/contract';

import { HandlerRegistry, registerFacadeHandlers } from '../../src/facade/index.js';
import { registerEventHandlers } from '../../src/events/handlers.js';
import {
  byteLength,
  parseChangesQuery,
  PgChangeFeed,
  type ChangesRequest,
} from '../../src/events/changes.js';
import type { LoopbackOwner } from '../../src/identity/loopback.js';
import { ChangesFixture } from './changes-fixture.js';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 300_000 });

const f = new ChangesFixture();
let feed: PgChangeFeed;

function req(query: Record<string, string>): ChangesRequest {
  return parseChangesQuery(new URLSearchParams(query));
}

async function read(query: Record<string, string>): Promise<EventChangesView> {
  return feed.read(f.spaceId, req(query), f.claims());
}


function entry(view: EventChangesView, id: string): EventChangeEntry | undefined {
  return view.changed?.find((e) => e.id === id);
}

async function refusal(p: Promise<unknown>): Promise<{ code: string; reason?: string; details: Record<string, unknown> }> {
  try {
    await p;
  } catch (err) {
    if (!isCollabError(err)) throw err;
    const details = (err.details ?? {}) as Record<string, unknown>;
    return { code: err.code, reason: details['reason'] as string | undefined, details };
  }
  throw new Error('expected a refusal');
}

const testOwner = (): Promise<LoopbackOwner> =>
  Promise.resolve({
    identityId: f.identityId,
    accountId: '00000000-0000-0000-0000-000000000000',
    username: 'owner',
    isNodeAdmin: false,
    isOwner: true,
  });

beforeAll(async () => {
  await f.open('changes_accept');
  feed = new PgChangeFeed(f.db);
}, 300_000);

afterAll(async () => {
  await f.close();
});

describe('acceptance 1 — fixture size (a subtree of 11 tasks, 500 events, 6 changed)', () => {
  it('the digest is ≤ 3 KB minified (§6.1 re-baselined) and the unchanged poll is ≤ 100 B', async () => {
    const root = await f.createTask('Work on: tm8 context research: complete notebook, data and evidence');
    const children: string[] = [];
    for (let i = 0; i < 10; i++) children.push(await f.createTask(`Research child ${String(i)}: a realistic task title`, root));
    const noise = await f.createTask('Unrelated task outside the subtree');
    const base = await f.head();

    // The six changed entities, interleaved with noise elsewhere in the space.
    await f.post(root, 'Follow-up work launched (all Opus 5.5 1M teammate sessions are running now)');
    for (let i = 0; i < 6; i++) await f.post(children[0]!, `short reply for measurement ${String(i)}`);
    await f.complete(children[0]!);
    await f.rename(children[1]!, 'Research child 1: renamed during the window');
    await f.setStatus(children[2]!, 'working');
    await f.linkPr(children[3]!, 42);
    await f.edge(children[4]!, f.memberId, 'assigned_to');
    while ((await f.head()) - base < 500) await f.post(noise, 'noise outside the subtree');
    const head = await f.head();
    // Trim to EXACTLY the 500-event window, as measured live.
    const after = head - 500;
    expect(after).toBeGreaterThanOrEqual(base);

    const view = await read({ subtree: root, after: String(after) });
    const bytes = byteLength(view);
    console.info(`[acceptance 1] seeded fixture: ${String(view.changed?.length)} changed, digest ${String(bytes)} B minified`);
    expect(view.more).toBe(false);
    expect(view.gap).toBeNull();
    expect(new Set(view.changed?.map((e) => e.id))).toEqual(
      new Set([root, children[0], children[1], children[2], children[3], children[4]]),
    );
    // §6.1 is RE-BASELINED to 3 KB (spec doc 01a0d044 §6.1, step 4): the
    // trims (parentId omitted under the one --subtree root, status only when it
    // moved, messagesNext on the context's section cursor) took this fixture
    // from 2,797 B to the figure logged above; the rest is the agreed field set
    // — one anchor with 3 new messages plus its `messagesNext` alone is ~1 KB.
    expect(bytes).toBeLessThanOrEqual(3072);
    // The trims themselves: the root's children carry no parentId, and only
    // entities whose status moved carry one.
    for (const e of view.changed!) {
      if (e.id === root) expect(e.parentId).toBeNull();
      else expect(e).not.toHaveProperty('parentId');
    }
    expect(view.changed!.filter((e) => e.status !== undefined).map((e) => e.id).sort())
      .toEqual([children[0], children[2]].sort());

    const quiet = await read({ subtree: root, after: String(view.through) });
    const quietBytes = byteLength(quiet);
    console.info(`[acceptance 1] unchanged poll: ${String(quietBytes)} B minified — ${JSON.stringify(quiet)}`);
    expect(quiet.changed).toEqual([]);
    expect(quiet.more).toBe(false);
    expect(quietBytes).toBeLessThanOrEqual(100);
  });
});

describe('acceptance 3 — a page padded with unreadable rows never stops early', () => {
  it('through advances past rows the caller cannot read; nothing about them is emitted', async () => {
    const base = await f.head();
    const kept = await f.createTask('kept');
    const gone: string[] = [];
    for (let i = 0; i < 3; i++) gone.push(await f.createTask(`hard-deleted ${String(i)}`));
    for (const id of gone) await f.hardDelete(id);
    const head = await f.head();

    const view = await read({ after: String(base) });
    expect(view.through).toBe(head);
    expect(view.more).toBe(false);
    expect(view.changed?.map((e) => e.id)).toContain(kept);
    for (const id of gone) expect(view.changed?.map((e) => e.id)).not.toContain(id);

    // A window of ONLY unreadable rows: empty, not more, and `through` is still the head.
    const afterKept = await f.head();
    const late = await f.createTask('late, then deleted');
    await f.hardDelete(late);
    const padded = await read({ after: String(afterKept) });
    expect(padded.changed).toEqual([]);
    expect(padded.more).toBe(false);
    expect(padded.through).toBe(await f.head());
    expect(padded.through).toBeGreaterThan(afterKept);
  });
});

describe('acceptance 5 — the index gate', () => {
  it('after < indexedFrom - 1 is index_incomplete; once backfilled the same request succeeds', async () => {
    const task = await f.createTask('gate probe');
    const head = await f.head();
    const indexedFrom = head - 3;
    await f.db.asOwner((q) => q.query(
      `insert into internal.event_subject_index(space_id, indexed_from) values ($1, $2)
       on conflict (space_id) do update set indexed_from = excluded.indexed_from, completed_at = null`,
      [f.spaceId, indexedFrom],
    ));
    try {
      const refused = await refusal(read({ entity: task, after: String(indexedFrom - 2) }));
      expect(refused.code).toBe('invalid_cursor');
      expect(refused.reason).toBe('index_incomplete');
      expect(refused.details['indexedFrom']).toBe(indexedFrom);
      expect(String(refused.details['hint'])).toContain(`--after ${String(indexedFrom - 1)}`);
      // The boundary itself is covered: `after = N` examines seq > N.
      await expect(read({ entity: task, after: String(indexedFrom - 1) })).resolves.toBeDefined();
      // Unscoped reads do not use the index and are not gated.
      await expect(read({ after: String(indexedFrom - 2) })).resolves.toBeDefined();
    } finally {
      await f.db.asOwner((q) => q.query('delete from internal.event_subject_index where space_id = $1', [f.spaceId]));
    }
    const ok = await read({ entity: task, after: String(indexedFrom - 2) });
    expect(ok.gap).toBeNull();
  });
});

describe('acceptance 6 — hard delete, unresolved, not_found', () => {
  it('a named hard-deleted id is reported deleted; an unreadable id is unresolved; all unresolved is not_found', async () => {
    const base = await f.head();
    const doomed = await f.createTask('named then hard-deleted');
    const survivor = await f.createTask('named survivor');
    await f.hardDelete(doomed);
    const never = randomUUID();

    const view = await read({ entity: `${doomed},${survivor},${never}`, after: String(base) });
    const deleted = entry(view, doomed);
    expect(deleted?.changes).toEqual(['deleted']);
    expect(deleted?.kind).toBe('task');
    expect(entry(view, survivor)).toBeDefined();
    expect(view.unresolved).toEqual([never]);

    const refused = await refusal(read({ entity: never, after: String(base) }));
    expect(refused.code).toBe('not_found');

    // UNNAMED ids that no longer resolve are simply omitted.
    const unnamed = await read({ after: String(base) });
    expect(entry(unnamed, doomed)).toBeUndefined();
  });
});

describe('acceptance 7 — subtree resolution at request time', () => {
  it('includes a child created inside the window and a session working_on a descendant', async () => {
    const root = await f.createTask('subtree root');
    const child = await f.createTask('existing child', root);
    const base = await f.head();
    const born = await f.createTask('grandchild born in the window', child);
    const session = await f.createSession('worker on the grandchild');
    await f.edge(session, born, 'working_on');
    const outside = await f.createTask('outside the subtree');

    const view = await read({ subtree: root, after: String(base) });
    const ids = view.changed?.map((e) => e.id) ?? [];
    expect(ids).toContain(born);
    expect(ids).toContain(session);
    expect(ids).not.toContain(outside);
  });

  it('refuses a scope over 1,000 ids with scope_too_large, never truncating', async () => {
    const root = await f.createTask('huge subtree root');
    await f.db.asOwner((q) => q.query(
      `select public.create_task($1, 'bulk child ' || g, $2, '', '{}'::jsonb, $3::uuid, null, 'medium', '[]'::jsonb,
                                 null, null, null, null, 'attached_to', 'cmid_bulk_' || $3::uuid::text || '_' || g)
         from generate_series(1, 1000) g`,
      [f.spaceId, f.memberId, root],
    ), f.claims());
    const refused = await refusal(read({ subtree: root, after: String(await f.head()) }));
    expect(refused.code).toBe('invalid_input');
    expect(refused.reason).toBe('scope_too_large');
    expect(String(refused.details['hint'])).toMatch(/narrow the scope/);
  });
});

describe('acceptance 8 — status classes and sessions', () => {
  it('names `from` only when both spine rows are in the window', async () => {
    const task = await f.createTask('status walker');
    const before = await f.head();
    await f.setStatus(task, 'working');
    const between = await f.head();
    await f.complete(task);

    const both = entry(await read({ entity: task, after: String(before) }), task);
    expect(both?.changes).toContain('status:in_progress→done');
    expect(both?.changes).not.toContain('updated');

    const onlyLast = entry(await read({ entity: task, after: String(between) }), task);
    expect(onlyLast?.changes).toContain('status:done');
    expect(onlyLast?.changes.some((c) => c.includes('→'))).toBe(false);
    expect(onlyLast?.status).toBe('done');

    const rename = await f.head();
    await f.rename(task, 'status walker renamed');
    expect(entry(await read({ entity: task, after: String(rename) }), task)?.changes).toEqual(['updated']);
  });

  it('a crashed session is visible as running→failed(crashed: <reason>)', async () => {
    const session = await f.createSession('a worker that will crash');
    await f.transition(session, 'running');
    const base = await f.head();
    const reason = 'The agent process died with signal SIGKILL while writing the report; nothing was saved to disk';
    await f.transition(session, 'failed', 'crashed', reason);

    const e = entry(await read({ entity: session, after: String(base) }), session);
    expect(e).toBeDefined();
    const label = e!.changes[0]!;
    expect(label.startsWith('status:running→failed(crashed: ')).toBe(true);
    // The reason is bounded to 80 characters.
    expect(label).toContain(reason.slice(0, 40));
    expect(label.length).toBeLessThanOrEqual('status:running→failed(crashed: '.length + 80 + 1);
    expect(e!.status).toBe('failed');
  });
});

describe('acceptance 12 — message caps', () => {
  it('a task anchor lists the newest 3, with the total and a working messagesNext', async () => {
    const task = await f.createTask('busy thread');
    const base = await f.head();
    const posted: string[] = [];
    for (let i = 0; i < 7; i++) posted.push(await f.post(task, `thread message ${String(i)}`));

    const e = entry(await read({ anchor: task, after: String(base) }), task)!;
    expect(e.messages?.map((m) => m.id)).toEqual([posted[6], posted[5], posted[4]]);
    expect(e.messagesTotal).toBe(7);
    expect(e.messagesMore).toBe(true);
    expect(e.changes).toContain('message');

    // `messagesNext` is the context's own messages-section expand (#687), and it
    // works: its cursor continues right after the last message shown.
    const next = e.messagesNext!;
    const match = /^tm8 entity context ([0-9a-f-]{36}) --sections messages --cursor (\S+)$/.exec(next);
    expect(match, next).not.toBeNull();
    expect(match![1]).toBe(task);
    const registry = new HandlerRegistry();
    registerFacadeHandlers(registry, { db: f.db, config: {} as never, owner: testOwner });
    const op = getOperation('entities.context');
    const result = (await registry.get('entities.context')!({
      op, opName: 'entities.context', params: { id: match![1] },
      query: new URLSearchParams({ schema: 'v2', sections: 'messages', cursor: match![2]! }),
      body: undefined, requestId: `req_${randomUUID()}`, identity: { kind: 'auto-owner' },
      headers: {}, method: op.method, path: op.path,
    } as never)) as EntityContextV2View | { data: EntityContextV2View };
    const page = 'data' in result ? result.data : result;
    // The next page (a task's is 3 wide, listed oldest→newest) is exactly the
    // three messages before the last one shown — none repeated, none skipped.
    expect(page.messages?.map((m) => m.id)).toEqual([posted[1], posted[2], posted[3]]);
  });

  it('a chat anchor lists the newest 10', async () => {
    const channel = await f.channelId();
    const base = await f.head();
    for (let i = 0; i < 12; i++) await f.post(channel, `channel message ${String(i)}`);
    const e = entry(await read({ anchor: channel, after: String(base) }), channel)!;
    expect(e.messages).toHaveLength(10);
    expect(e.messagesTotal).toBe(12);
    expect(e.messagesMore).toBe(true);
  });

  it('when the page stops early the count is spelled as a lower bound', async () => {
    const base = await f.head();
    const tasks: string[] = [];
    for (let i = 0; i < 12; i++) {
      const t = await f.createTask(`budget ${String(i)} ${'x'.repeat(60)}`);
      tasks.push(t);
      for (let j = 0; j < 4; j++) await f.post(t, `${'long message body '.repeat(10)} ${String(j)}`);
    }
    const view = await read({ after: String(base), totalBytes: '8192' });
    expect(view.more).toBe(true);
    const withMessages = view.changed!.filter((e) => e.messages !== undefined);
    expect(withMessages.length).toBeGreaterThan(0);
    for (const e of withMessages) {
      expect(e.messagesTotal).toBeUndefined();
      expect(e.messagesTotalAtLeast).toBeGreaterThanOrEqual(e.messages!.length);
    }
  });
});

describe('acceptance 4 — gap (runs last: it prunes the log)', () => {
  it('after below the oldest retained row sets gap and reads from the oldest', async () => {
    const task = await f.createTask('survives the prune');
    const head = await f.head();
    const cut = head - 5;
    await f.db.asOwner((q) => q.query('delete from public.workspace_events where space_id = $1 and seq < $2', [f.spaceId, cut]));
    const view = await read({ after: '10' });
    expect(view.gap).toEqual({ after: 10, oldestRetained: cut });
    expect(view.since).toBe(10);
    expect(view.through).toBe(head);
    // Never rendered as unchanged: the DTO carries scope + next even if empty.
    expect(view.next).toBeDefined();
    const scoped = await read({ entity: task, after: '10' });
    expect(scoped.gap).toEqual({ after: 10, oldestRetained: cut });
    // A cursor at or past the oldest retained row is not a gap.
    expect((await read({ after: String(cut - 1) })).gap).toBeNull();
  });
});

describe('acceptance 14 / 15 and the §3.3 floor — groups, progress, the worst entity', () => {
  let s1: string;
  let s2: string;
  let base: number;
  let worst: EventChangeEntry;

  beforeAll(async () => {
    // Two MAXIMUM-size entities: session anchors (10 messages each), titles at
    // the 80-char cap, every message excerpt at the 120-char cap, several
    // change classes and actors. The FIRST event in the window is the edge
    // between them, so they form one atomic group.
    s1 = await f.createSession('S'.repeat(200));
    s2 = await f.createSession('T'.repeat(200));
    base = await f.head();
    await f.edge(s1, s2, 'relates_to');
    for (const s of [s1, s2]) {
      for (let i = 0; i < 12; i++) await f.post(s, `${String(i)} ${'w'.repeat(400)}`);
    }
  });

  it('acceptance 14 — both max-size entities of the first event emit in one page and through > since', async () => {
    const view = await read({ anchor: `${s1},${s2}`, after: String(base), totalBytes: String(EVENT_CHANGES_MIN_TOTAL_BYTES) });
    const ids = view.changed!.map((e) => e.id);
    expect(ids).toEqual(expect.arrayContaining([s1, s2]));
    expect(view.through).toBeGreaterThan(view.since);
    expect(byteLength(view)).toBeLessThanOrEqual(EVENT_CHANGES_MIN_TOTAL_BYTES);
    worst = [...view.changed!].sort((a, b) => byteLength(b) - byteLength(a))[0]!;
  });

  it('§3.3 — the measured worst ASCII entity keeps 2 × worst + envelope under the 8,192 floor', async () => {
    const worstBytes = byteLength(worst);
    const envelope = byteLength({
      scope: { anchor: [s1, s2] }, since: 99_999_999, through: 99_999_999, more: true, gap: null, unresolved: [],
      changed: [], next: `tm8 event changes --anchor ${s1} --anchor ${s2} --after 99999999`,
    });
    console.info(`[floor] worst single entity (10 message rows, ASCII): ${String(worstBytes)} B; envelope ${String(envelope)} B; 2×worst+envelope = ${String(2 * worstBytes + envelope)} B`);
    expect(worst.messages).toHaveLength(10);
    expect(2 * worstBytes + envelope).toBeLessThanOrEqual(EVENT_CHANGES_MIN_TOTAL_BYTES);
  });

  it('§3.3 — the multi-byte worst case FITS the 8,192 floor: titles and excerpts are cut in bytes, not refused', async () => {
    const a = await f.createSession('会'.repeat(200));
    const b = await f.createSession('議'.repeat(200));
    const at = await f.head();
    await f.edge(a, b, 'relates_to');
    for (const s of [a, b]) for (let i = 0; i < 10; i++) await f.post(s, '漢字'.repeat(200));
    let view: EventChangesView | undefined;
    let refused: string | undefined;
    try {
      view = await read({ anchor: `${a},${b}`, after: String(at), totalBytes: String(EVENT_CHANGES_MIN_TOTAL_BYTES) });
    } catch (err) {
      refused = isCollabError(err) ? String((err.details as { reason?: string } | undefined)?.reason) : String(err);
    }
    const big = await read({ anchor: `${a},${b}`, after: String(at), totalBytes: '32768' });
    const cjkWorst = Math.max(...big.changed!.map((e) => byteLength(e)));
    console.info(`[floor] worst single entity (10 message rows, 3-byte CJK): ${String(cjkWorst)} B; at the 8,192 floor: ${refused ?? `fits (${String(byteLength(view))} B)`}`);
    expect(refused).toBeUndefined();
    expect(byteLength(view)).toBeLessThanOrEqual(EVENT_CHANGES_MIN_TOTAL_BYTES);
    expect(view!.changed!.map((e) => e.id).sort()).toEqual([a, b].sort());
    expect(view!.through).toBeGreaterThan(view!.since);
    for (const e of view!.changed!) {
      // Nothing dropped: every row and field is there, only shorter, and marked.
      expect(e.messages).toHaveLength(10);
      expect(Buffer.byteLength(e.title!, 'utf8')).toBeLessThanOrEqual(80);
      for (const m of e.messages!) {
        expect(m.truncated).toBe(true);
        expect(m.excerpt.endsWith('…')).toBe(true);
        expect(Buffer.byteLength(m.excerpt, 'utf8')).toBeLessThanOrEqual(120);
      }
    }
    // A budget with room for them keeps them whole.
    for (const e of big.changed!) expect(e.messages![0]!.excerpt.length).toBeGreaterThan(100);
  });

  it('acceptance 15 — a forced oversize group is refused: no partial output, cursor not advanced', async () => {
    // The test hook: `PgChangeFeed.read` enforces the budget it is given; only
    // the query parser enforces the 8,192 floor. A budget below one group forces it.
    const forced: ChangesRequest = { ...req({ anchor: `${s1},${s2}`, after: String(base) }), totalBytes: 1_000 };
    const refused = await refusal(feed.read(f.spaceId, forced, f.claims()));
    expect(refused.code).toBe('payload_too_large');
    expect(refused.reason).toBe('digest_group_too_large');
    expect(refused.details['seq']).toBe(base + 1);
  });

  it('the handler refuses --total-bytes outside 8192..32768 before any read', async () => {
    const registry = new HandlerRegistry();
    registerEventHandlers(registry, { db: f.db, config: {} as never, owner: testOwner });
    const handler = registry.get('events.changes')!;
    const ctx = (query: Record<string, string>): never => ({
      params: { spaceId: f.spaceId }, query: new URLSearchParams(query), requestId: `req_${randomUUID()}`,
      identity: { kind: 'auto-owner' },
    }) as never;
    for (const bad of ['8191', '32769']) {
      await expect(handler(ctx({ totalBytes: bad }))).rejects.toThrow(/totalBytes must be an integer in 8192\.\.32768/);
    }
    const okResult = (await handler(ctx({ after: String(base), anchor: s1 }))) as { data: EventChangesView };
    expect(okResult.data.changed?.map((e) => e.id)).toContain(s1);
  });
});
