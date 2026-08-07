/**
 * Tests for the three Wave-0 correctness fixes, which share a shape: in each
 * one the client was refusing something the SERVER already does. That class of
 * bug is invisible on screen — a disabled button and an unbuilt endpoint look
 * identical, and a wedged poller looks like a quiet workspace — so it can only
 * be caught here.
 *
 * Companion to ./mapping.test.ts, whose conventions (the DEV-6 fetch stub, fake
 * timers) this file follows.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CollabError } from '../../collab-v2/types/contract';
import { RealFacade } from '../RealFacade';
import { TmClient } from '../TmClient';
import { EventPoller } from '../events';

/** A fetch stub returning the DEV-6 envelope, recording what was sent. */
function stubFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const { status = 200, body } = handler(String(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('TmClient — the DELETE and PUT verbs', () => {
  it('issues the actual HTTP method, so the nine bound operations are reachable', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    vi.stubGlobal('fetch', stubFetch((url, init) => {
      calls.push({ url, method: init?.method });
      return { body: { data: { ok: true }, requestId: 'r' } };
    }));

    const client = new TmClient();
    await client.delete('/v2/entities/e1');
    await client.put('/v2/entities/e1/reactions', { reaction: 'like', enabled: true });

    expect(calls[0]).toEqual({ url: '/v2/entities/e1', method: 'DELETE' });
    expect(calls[1]).toEqual({ url: '/v2/entities/e1/reactions', method: 'PUT' });
  });

  it('sends no body on DELETE and defaults PUT to {}, matching post/patch', async () => {
    const bodies: Array<string | undefined> = [];
    vi.stubGlobal('fetch', stubFetch((_u, init) => {
      bodies.push(init?.body as string | undefined);
      return { body: { data: null } };
    }));

    const client = new TmClient();
    await client.delete('/v2/edges/x');
    await client.put('/v2/inbox/read');

    // undefined, not '{}' — `request` omits the body key entirely, which is what
    // keeps DELETE conventional rather than merely empty.
    expect(bodies[0]).toBeUndefined();
    expect(bodies[1]).toBe('{}');
  });

  it('unwraps the {data, requestId} envelope like every other verb', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ body: { data: { id: 'e1', gone: true }, requestId: 'req_9' } })));
    const out = await new TmClient().delete<{ id: string; gone: boolean }>('/v2/entities/e1');
    expect(out).toEqual({ id: 'e1', gone: true });
    expect(out).not.toHaveProperty('requestId');
  });

  it('maps an error body through the taxonomy rather than resolving', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({
      status: 429,
      body: { error: { code: 'limit_exceeded', message: 'cap reached', retryable: true } },
    })));
    const err = await new TmClient().put('/v2/inbox/read').catch((e) => e as CollabError);
    expect(err).toBeInstanceOf(CollabError);
    expect(err.code).toBe('rate_limited');
    expect(err.details?.tm8Code).toBe('limit_exceeded');
  });

  it('reports an unreachable node on the new verbs too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const client = new TmClient();
    const err = await client.delete('/v2/entities/e1').catch((e) => e as CollabError);
    expect(err.code).toBe('upstream_unavailable');
    expect(client.isConnected()).toBe(false);
  });
});

describe('space creation — mutation identity is always present', () => {
  it('sends a clientMutationId required by the spaces.create contract', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', stubFetch((_url, init) => {
      sent = JSON.parse(String(init?.body));
      return { body: { data: { space: { id: 's1', name: 'My Space' } }, requestId: 'r' } };
    }));

    await new RealFacade(new TmClient()).createSpace('My Space');

    expect(sent.name).toBe('My Space');
    expect(sent.clientMutationId).toEqual(expect.stringMatching(/^space-create_/));
  });
});

describe('grantPoints — implemented server-side, so no longer refused', () => {
  it('POSTs to /v2/entities/:id/points and returns a CommandResult', async () => {
    let sent: Record<string, unknown> = {};
    let seenUrl = '';
    let seenMethod: string | undefined;
    vi.stubGlobal('fetch', stubFetch((url, init) => {
      seenUrl = url;
      seenMethod = init?.method;
      sent = JSON.parse(String(init?.body));
      return { body: { data: {
        entity: { id: 'tm1', counters: { points: 8 } },
        patches: [{ id: 'tm1', counters: { points: 8 } }],
      }, requestId: 'r' } };
    }));

    const result = await new RealFacade(new TmClient()).grantPoints('tm1', {
      amount: 3, reason: 'grant', actorId: 'm1', clientMutationId: 'cm-1',
    });

    expect(seenMethod).toBe('POST');
    expect(seenUrl).toBe('/v2/entities/tm1/points');
    // The envelope rides on the same object the handler reads `amount` from —
    // dropping actorId or clientMutationId would cost attribution and the
    // server-side idempotency that makes a double-press pay once.
    expect(sent).toEqual({ amount: 3, reason: 'grant', actorId: 'm1', clientMutationId: 'cm-1' });
    expect(result.patches).toHaveLength(1);
  });

  it('defaults patches so the stores can iterate unconditionally', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ body: { data: { entity: { id: 'tm1' } } } })));
    const r = await new RealFacade(new TmClient()).grantPoints('tm1', { amount: 1, reason: 'award' });
    expect(r.patches).toEqual([]);
  });

  it('surfaces a server refusal instead of swallowing it', async () => {
    // The RPC grants only to member / team_member. A grant aimed elsewhere is
    // the server's call to reject, and the UI must show that rejection.
    vi.stubGlobal('fetch', stubFetch(() => ({
      status: 422,
      body: { error: { code: 'invariant_violation', message: 'points target must be a member' } },
    })));
    await expect(
      new RealFacade(new TmClient()).grantPoints('task1', { amount: 1, reason: 'grant' }),
    ).rejects.toMatchObject({ code: 'invariant_violation' });
  });
});

describe('event poller — the string cursor and the wedge it prevents', () => {
  /** Drives the poller with a scripted sequence of pages, recording each `since`. */
  function pollerOver(pages: Array<{ items?: unknown[]; nextCursor?: unknown }>) {
    const urls: string[] = [];
    const client = new TmClient();
    vi.spyOn(client, 'get').mockImplementation(async (p: string) => {
      urls.push(p);
      const page = pages[Math.min(urls.length - 1, pages.length - 1)];
      return page as never;
    });
    return { client, urls };
  }

  const evt = (seq: number) => ({
    spaceId: 'sp', seq, occurredAt: '', schemaVersion: 1, type: 'entity.upsert', entity: { id: `e${seq}` },
  });

  it('accepts a STRING nextCursor — the shape the server actually sends', async () => {
    const { client, urls } = pollerOver([
      { items: [evt(3)], nextCursor: '99' },
      { items: [], nextCursor: '99' },
    ]);
    const poller = new EventPoller(client, 'sp', 10);
    poller.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(40);
    // Before the fix this read `since=3`: the string failed `typeof === 'number'`
    // and the server's cursor was thrown away on every single poll.
    expect(urls[1]).toContain('since=99');
  });

  it('does NOT wedge on an empty page whose cursor has advanced', async () => {
    // The regression that matters. The server advances past rows it examined but
    // did not return, so `items` can be empty while the cursor moves. With the
    // cursor discarded, highWater stays at `since`, the client re-asks the same
    // question forever, and the event stream is dead while looking healthy.
    const { client, urls } = pollerOver([
      { items: [], nextCursor: '50' },
      { items: [], nextCursor: '75' },
      { items: [], nextCursor: '120' },
    ]);
    const poller = new EventPoller(client, 'sp', 10);
    poller.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(40);
    expect(urls.slice(0, 4)).toEqual([
      '/v2/spaces/sp/events?since=0',
      '/v2/spaces/sp/events?since=50',
      '/v2/spaces/sp/events?since=75',
      '/v2/spaces/sp/events?since=120',
    ]);
  });

  it('never lets the cursor move backwards', async () => {
    const { client, urls } = pollerOver([
      { items: [evt(40)], nextCursor: '40' },
      { items: [], nextCursor: '7' },     // a rewind: must be ignored
      { items: [], nextCursor: '7' },
    ]);
    const poller = new EventPoller(client, 'sp', 10);
    poller.subscribe(() => {});

    await vi.advanceTimersByTimeAsync(40);
    expect(urls[1]).toContain('since=40');
    expect(urls[2]).toContain('since=40');
    expect(urls.some((u) => u.includes('since=7'))).toBe(false);
  });

  it('falls back to the observed max when the cursor is absent or garbage', async () => {
    for (const bad of [null, undefined, '', '   ', 'abc', {}, []]) {
      const { client, urls } = pollerOver([
        { items: [evt(12)], nextCursor: bad },
        { items: [], nextCursor: bad },
      ]);
      const poller = new EventPoller(client, 'sp', 10);
      const unsub = poller.subscribe(() => {});
      await vi.advanceTimersByTimeAsync(40);
      // Crucially NOT since=0: `Number('')` and `Number([])` are both 0, which
      // would replay the whole log rather than hold position.
      expect(urls[1], `nextCursor=${JSON.stringify(bad)}`).toContain('since=12');
      unsub();
    }
  });

  it('still delivers events and keeps a numeric cursor working', async () => {
    // Numbers are not what the server sends today, but the union permits them
    // and the older tests depend on it — coercion must not narrow the contract.
    const { client, urls } = pollerOver([
      { items: [evt(1), evt(7)], nextCursor: 9 },
      { items: [], nextCursor: 9 },
    ]);
    const seen: string[] = [];
    const poller = new EventPoller(client, 'sp', 10);
    poller.subscribe((e) => seen.push(e.eventId));

    await vi.advanceTimersByTimeAsync(40);
    expect(seen).toEqual(['sp:1', 'sp:7']);
    expect(urls[1]).toContain('since=9');
  });
});
