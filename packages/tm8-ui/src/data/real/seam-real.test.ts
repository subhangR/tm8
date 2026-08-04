/**
 * seam-real.ts — assembly, the C-4 menu fallback, and the three wires.
 *
 * ZERO NETWORK: `createRealSeam` REQUIRES `fetch` and `webSocketFactory`, so
 * every test here supplies fakes and the module has no way to construct a real
 * transport on its own. That requirement is itself asserted below — it is the
 * positive control for the whole "prepare, not wire" claim.
 */
import { describe, expect, it } from 'vitest';
import { CollabError } from '@tm8/contract';
import { createRealSeam, deriveWsUrl, type RealSeam, type RealSeamOptions } from './seam-real';
import { FakeClock, fakeFetch, fakeSocketPool, flush, type FakeFetch, type FakeReply, type FakeSocketPool } from './test-support';

interface Harness {
  seam: RealSeam;
  f: FakeFetch;
  pool: FakeSocketPool;
  clock: FakeClock;
}

function mk(route: (url: string, method: string) => FakeReply, over: Partial<RealSeamOptions> = {}): Harness {
  const clock = new FakeClock();
  const pool = fakeSocketPool();
  const f = fakeFetch((call) => route(call.url, call.method));
  const seam = createRealSeam({
    baseUrl: '',
    wsUrl: 'ws://fake.invalid/v2/ws',
    fetch: f.fetch,
    webSocketFactory: pool.factory,
    timers: clock.timers,
    now: clock.now,
    random: clock.random,
    ...over,
  });
  return { seam, f, pool, clock };
}

const ok = (data: unknown): FakeReply => ({ data });
const err = (status: number, code: string): FakeReply => ({
  status, error: { code, message: code, requestId: 'r', retryable: false },
});

// ---------------------------------------------------------------------------

describe('seam-real: menu() — the ONE soft fallback (LLD C-4)', () => {
  it('resolves null for 501 not_implemented', async () => {
    const { seam } = mk(() => err(501, 'not_implemented'));
    await expect(seam.menu('sp-1')).resolves.toBeNull();
  });

  it('resolves null for 404 not_found — deliberately INDISTINGUISHABLE from 501', async () => {
    const { seam } = mk(() => err(404, 'not_found'));
    await expect(seam.menu('sp-1')).resolves.toBeNull();
  });

  it('rejects on any other code — the fallback is not a swallow-everything', async () => {
    const { seam } = mk(() => err(403, 'forbidden'));
    await expect(seam.menu('sp-1')).rejects.toBeInstanceOf(CollabError);
  });

  it('a transport failure is NOT a missing menu', async () => {
    const { seam } = mk(() => ({ networkError: 'ECONNREFUSED' }));
    const e = await seam.menu('sp-1').catch((x: unknown) => x) as CollabError;
    expect(e.code).toBe('upstream_unavailable');
  });

  it('the control: a real menu comes back as itself', async () => {
    const menu = { schemaVersion: 1, groups: [], revision: 3 };
    const { seam } = mk(() => ok(menu));
    await expect(seam.menu('sp-1')).resolves.toEqual(menu);
  });
});

describe('seam-real: openSpace', () => {
  it('subscribes, resumes and starts the liveness cadence', async () => {
    const { seam, pool, f } = mk((url) =>
      url.includes('/execution/liveness')
        ? ok({ liveEntityIds: ['ws-1'], nodeBootId: 'boot-A', checkedAt: '2026-07-28T12:00:00.000Z' })
        : ok({}));

    await seam.openSpace('sp-1');
    pool.last().openIt();
    await flush();

    expect(pool.last().frames()).toEqual([
      { type: 'subscribe', spaceIds: ['sp-1'] },
      { type: 'resume', spaceId: 'sp-1', since: 0 },
    ]);
    expect(f.calls.map((c) => c.url)).toContain('/v2/spaces/sp-1/execution/liveness');
    expect(seam.liveness.statusOf({ id: 'ws-1', workStatus: 'running' })).toBe('live');
  });

  it('SURVIVES a liveness read that fails — today every one of them 404s', async () => {
    // execution.liveness has no server route yet (LLD §13). If openSpace
    // awaited the snapshot, every openSpace would reject against a real node.
    const { seam, pool } = mk((url) => (url.includes('/execution/liveness') ? err(404, 'not_found') : ok({})));
    await expect(seam.openSpace('sp-1')).resolves.toBeUndefined();
    pool.last().openIt();
    await flush();
    expect(seam.getConnection()).toEqual({ phase: 'live' });
    expect(seam.liveness.statusOf({ id: 'ws-1', workStatus: 'running' })).toBe('unknown');
  });

  it('rejects for a space with a RECORDED refusal rather than re-opening into silence', async () => {
    const { seam, pool } = mk(() => ok({}));
    const refusals: string[] = [];
    seam.realControls.onSpaceRefused((spaceId) => refusals.push(spaceId));

    await seam.openSpace('sp-1');
    pool.last().openIt();
    pool.last().deliver({ type: 'control.refused', frame: 'subscribe', spaceId: 'sp-1', reason: 'forbidden' });
    expect(refusals).toEqual(['sp-1']);

    const e = await seam.openSpace('sp-1').catch((x: unknown) => x) as CollabError;
    expect(e).toBeInstanceOf(CollabError);
    expect(e.code).toBe('forbidden');
  });
});

describe('seam-real: the three wires', () => {
  it('wire 1 — an HTTP transport failure drives polling→offline', async () => {
    let reachable = true;
    const { seam, pool, clock } = mk(() => (reachable ? ok({ items: [], nextCursor: '0' }) : { networkError: 'down' }));

    await seam.openSpace('sp-1');
    pool.last().openIt();
    await flush();
    expect(seam.getConnection().phase).toBe('live');

    pool.last().drop();
    await flush();
    expect(seam.getConnection().phase).toBe('polling');

    reachable = false;
    clock.advance(1_500);
    await flush();
    expect(seam.getConnection().phase).toBe('offline');
  });

  it('wire 2 — a work_session upsert on the stream triggers a liveness re-read', async () => {
    const { seam, pool, f } = mk((url) =>
      url.includes('/execution/liveness')
        ? ok({ liveEntityIds: [], nodeBootId: 'boot-A', checkedAt: '2026-07-28T12:00:00.000Z' })
        : ok({}));

    await seam.openSpace('sp-1');
    pool.last().openIt();
    await flush();
    const before = f.calls.filter((c) => c.url.includes('liveness')).length;

    pool.last().deliver({
      type: 'entity.upsert', spaceId: 'sp-1', seq: 1, occurredAt: 'x', schemaVersion: 1,
      entity: { id: 'ws-1', state: { kind: 'work_session' } },
    });
    await flush();

    expect(f.calls.filter((c) => c.url.includes('liveness')).length).toBe(before + 1);
  });

  it('wire 3 — a reconnect triggers a liveness re-read', async () => {
    const { seam, pool, clock, f } = mk((url) =>
      url.includes('/execution/liveness')
        ? ok({ liveEntityIds: [], nodeBootId: 'boot-A', checkedAt: '2026-07-28T12:00:00.000Z' })
        : ok({ items: [], nextCursor: '0' }));

    await seam.openSpace('sp-1');
    pool.last().openIt();
    await flush();
    pool.last().drop();
    await flush();
    const before = f.calls.filter((c) => c.url.includes('liveness')).length;

    clock.advance(10_000);
    await flush();
    pool.last().openIt();
    await flush();

    expect(f.calls.filter((c) => c.url.includes('liveness')).length).toBe(before + 1);
  });
});

describe('seam-real: commands that adapt the server shape', () => {
  it('upsertReadMark does not send the caller lastReadAt (strict schema; server stamps it)', async () => {
    const { seam, f } = mk(() => ok({}));
    await seam.commands.upsertReadMark('a-1', '2026-07-28T11:00:00.000Z');
    expect(f.last().url).toBe('/v2/read-marks/a-1');
    expect(f.last().body).not.toHaveProperty('lastReadAt');
    expect(Object.keys(f.last().body as object)).toEqual(['clientMutationId']);
  });

  it('editMessage returns a CommandResult carrying the server MessageView as the patch', async () => {
    const view = { id: 'm-1', title: 'edited' };
    const { seam } = mk(() => ok(view));
    await expect(seam.commands.editMessage('m-1', { clientMutationId: 'c', expectedVersion: 1, body: 'x' }))
      .resolves.toEqual({ patches: [view] });
  });

  it('execution.prompt passes the permanent 403 through unchanged', async () => {
    const { seam } = mk(() => err(403, 'forbidden'));
    const e = await seam.commands.prompt('ws-1', { clientMutationId: 'c', body: 'hi' } as never)
      .catch((x: unknown) => x) as CollabError;
    expect(e.code).toBe('forbidden');
  });
});

describe('seam-real: wsUrl derivation refuses to guess', () => {
  it('derives ws:// and wss:// from an absolute base, using the catalog path', () => {
    expect(deriveWsUrl('http://127.0.0.1:4610')).toBe('ws://127.0.0.1:4610/v2/ws');
    expect(deriveWsUrl('https://tm8.example')).toBe('wss://tm8.example/v2/ws');
    expect(deriveWsUrl('http://x.test/')).toBe('ws://x.test/v2/ws');
  });

  it('derives from the page origin when the base is relative', () => {
    expect(deriveWsUrl('', 'http://127.0.0.1:4612')).toBe('ws://127.0.0.1:4612/v2/ws');
  });

  it('THROWS rather than inventing a URL — a wrong socket URL looks like a flaky network', () => {
    expect(() => deriveWsUrl('')).toThrow(CollabError);
    expect(() => deriveWsUrl('/v2')).toThrow(/wsUrl is required/);
  });

  it('puts the per-server pass on the browser socket grant URL', async () => {
    const { seam, pool } = mk(() => ok({}), { getAuthToken: () => 'tm8s_session.secret/value' });
    await seam.openSpace('sp-1');
    expect(pool.urls).toEqual([
      'ws://fake.invalid/v2/ws?token=tm8s_session.secret%2Fvalue',
    ]);
  });

  it('keeps the loopback auto-owner socket unchanged when no pass exists', async () => {
    const { seam, pool } = mk(() => ok({}), { getAuthToken: () => null });
    await seam.openSpace('sp-1');
    expect(pool.urls).toEqual(['ws://fake.invalid/v2/ws']);
  });
});

describe('seam-real: prepare-not-wire is a type-level property', () => {
  /* AMENDED 2026-07-29 (brokered: bridge lane closed by user; FE-authored
   * under master endorsement [master->fe 45], the flag-gated last-mile).
   * The ORIGINAL assertion here was the inverse — `createRealSeam` NOT
   * exported — encoding Phase-1's "prepared, not wired" decision. That
   * decision was REOPENED by the endorsement: the index now exports the
   * constructor, and the flag-gated selection (off by default) lives in
   * views/, outside this lane. What this suite actually guards is UNCHANGED
   * and stated by the header above: nothing in src/data can reach the
   * network ALONE — construction requires explicitly injected fetch and
   * WebSocket factories with no defaults. The export moved; the property
   * did not. (The original assertion broke in-tree when the export landed
   * without this amendment — the guard and the value must move as one
   * commit, and this text is the record that they now do.) */
  it('IS exported from the data-layer index — wire-behind-flag per [master->fe 45]', async () => {
    const index = await import('../index');
    expect(Object.keys(index)).toContain('createRealSeam');
    expect(Object.keys(index)).toContain('browserWebSocketFactory');
  });

  it('the seam surface matches the locked interface, method for method', () => {
    const { seam } = mk(() => ok({}));
    expect(Object.keys(seam.commands).sort()).toEqual([
      'complete', 'createEntity', 'createTask',
      // Amendment 5 (2026-08-04, attachments): deleteEdge — DETACH. Sorts
      // BEFORE deleteEntity ('Ed' < 'En'), and the two are not the same act:
      // this deletes the `attached_to` link, never the file behind it.
      'deleteEdge',
      'deleteEntity', 'editMessage', 'markRead',
      'moveEntity', 'patchEntity', 'patchTask', 'postMessage',
      // Amendment 2 (2026-07-31): the artifacts preview decisions were
      // ratified, so the Run button gained its one command (seam.ts header).
      'previewArtifact',
      'prompt', 'react',
      // `resolveAttention` shipped into the seam without this lock being
      // updated, so the guard was red in-tree before the attention inbox
      // landed. Recorded here rather than silently corrected.
      'resolveAttention',
      // 2026-08-01: resume — the exited card's button. Sorts AFTER
      // restoreEntity ('rest' < 'resu'), which is not where it reads like it
      // belongs. Locked here the same way, so the seam cannot gain a command
      // without this list saying so.
      'restoreEntity', 'resume', 'spawn', 'terminate',
      // Amendment 4 (2026-08-01): updateProfile — identity display (067).
      // The viewer's OWN profile row; the op names no subject by design.
      'updateProfile',
      'upsertReadMark', 'work',
    ]);
    expect(Object.keys(seam.liveness).sort()).toEqual(['onChange', 'refresh', 'statusOf']);
    // Amendment 3 (2026-08-01, attachments): `downloadHref` — the one seam
    // member that answers a URL rather than a DTO, because `files.download`
    // answers raw bytes and a browser reaches those through `href`/`src`.
    // Locked here so the file group cannot grow a verb in silence.
    expect(Object.keys(seam.files).sort()).toEqual([
      'abort', 'complete', 'downloadHref', 'putBytes', 'uploadInit',
    ]);
    for (const m of ['openSpace', 'closeSpace', 'dispose', 'onEvent', 'onConnection', 'getConnection',
      'onResync', 'identity', 'spaces', 'menu', 'query', 'entityKinds', 'entity', 'children',
      'connections', 'activity', 'messages', 'handoffs', 'journal', 'launch', 'inbox', 'feed',
      'delivery', 'attentionRequests']) {
      expect(typeof (seam as unknown as Record<string, unknown>)[m]).toBe('function');
    }
  });

  /**
   * Amendment 5 — DETACH ON THE WIRE. The method and the path are the whole
   * risk here: `edges.delete` is DELETE /v2/edges/:edgeId, and a detach that
   * POSTed, or that put the FILE's id in the path, would be green on every
   * spy-based test and would remove the wrong thing (or nothing) in
   * production. The body carries the mutation id because the server binds
   * `RequiredCommandContextSchema` and refuses without it.
   */
  it('detach speaks DELETE /v2/edges/:edgeId and carries the mutation id', async () => {
    const { seam, f } = mk(() => ok({ patches: [] }));
    await seam.commands.deleteEdge('edge-7', { clientMutationId: 'cmid-detach' });
    const call = f.calls[f.calls.length - 1]!;
    expect(call.method).toBe('DELETE');
    expect(call.url).toBe('/v2/edges/edge-7');
    expect(call.body).toEqual({ clientMutationId: 'cmid-detach' });
  });

  it('dispose tears down both managers', async () => {
    const { seam, pool, clock } = mk(() => ok({}));
    await seam.openSpace('sp-1');
    pool.last().openIt();
    seam.dispose();
    expect(pool.last().closeCalls).toBe(1);
    clock.advance(300_000);
    expect(clock.pending()).toBe(0);
  });
});
