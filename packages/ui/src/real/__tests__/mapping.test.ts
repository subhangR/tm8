/**
 * Tests for the RealFacade mapping layer — the part that is genuinely mine.
 *
 * Atlas's 820 tests cover the module; none of them touch this seam. What is
 * tested here is specifically the places where tm8 and the UI snapshot
 * DISAGREE, plus the degradation policy, because those are the two things that
 * cannot be caught by looking at a screen: a wrong error code still renders,
 * and a fabricated empty still renders.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { CollabError } from '../../collab-v2/types/contract';
import { RealFacade } from '../RealFacade';
import { TmClient } from '../TmClient';
import { EventPoller, toWorkspaceEvent } from '../events';
import { isHollow, hollowReason, isUnavailable } from '../capabilities';

/** A fetch stub returning the DEV-6 envelope. */
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

describe('envelope unwrapping (DEV-6)', () => {
  it('returns the bare payload, never the {data, requestId} wrapper', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ body: { data: [{ id: 's1', name: 'Space' }], requestId: 'req_1' } })));
    const spaces = await new RealFacade(new TmClient()).listSpaces();
    // spaces.list is a bare ARRAY server-side, not a {items} page.
    expect(spaces).toEqual([{ id: 's1', name: 'Space' }]);
    expect(spaces).not.toHaveProperty('requestId');
  });

  it('defaults CommandResult.patches so stores can iterate unconditionally', async () => {
    // The project-link command legitimately returns no patches key at all.
    vi.stubGlobal('fetch', stubFetch(() => ({ body: { data: { entity: { id: 'e1' } }, requestId: 'r' } })));
    const r = await new RealFacade(new TmClient()).createEntity({ spaceId: 's', kind: 'task', title: 'T' });
    expect(r.patches).toEqual([]);
  });
});

describe('error taxonomy', () => {
  it('maps tm8-only limit_exceeded onto the UI\'s frozen set, preserving the original', async () => {
    // The UI's CommandErrorCode predates tm8's governance-cap code. It must be
    // mapped, not passed through, or `new CollabError(code)` yields status
    // undefined and nothing downstream can branch on it.
    vi.stubGlobal('fetch', stubFetch(() => ({
      status: 429,
      body: { error: { code: 'limit_exceeded', message: 'session cap reached', retryable: true } },
    })));
    const err = await new RealFacade(new TmClient()).getEntity('x').catch((e) => e as CollabError);
    expect(err).toBeInstanceOf(CollabError);
    expect(err.code).toBe('rate_limited');   // same 429, same retryability
    expect(err.status).toBe(429);
    expect(err.retryable).toBe(true);
    expect(err.details?.tm8Code).toBe('limit_exceeded');  // the truth is not lost
  });

  it('does not invent a precise code for an unrecognised one', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ status: 500, body: { error: { code: 'wormhole', message: 'x' } } })));
    const err = await new RealFacade(new TmClient()).getEntity('x').catch((e) => e as CollabError);
    expect(err.code).toBe('upstream_unavailable');
  });

  it('reports an unreachable node as a transport failure, not a refusal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const facade = new RealFacade(new TmClient());
    const err = await facade.listSpaces().catch((e) => e as CollabError);
    expect(err.code).toBe('upstream_unavailable');
    expect(facade.isConnected()).toBe(false);   // drives the offline banner
  });
});

describe('WorkspaceEvent envelope divergence (AM-2 §3)', () => {
  it('synthesises eventId from (spaceId, seq) and keeps the payload verbatim', () => {
    const e = toWorkspaceEvent({
      spaceId: 'sp1', seq: 42, occurredAt: '2026-07-25T00:00:00Z', schemaVersion: 1,
      type: 'entity.upsert', entity: { id: 'e1' }, clientMutationId: 'cm1',
    } as never);
    expect(e.eventId).toBe('sp1:42');
    expect(e.type).toBe('entity.upsert');
    expect((e as { entity: { id: string } }).entity.id).toBe('e1');
    expect((e as { clientMutationId?: string }).clientMutationId).toBe('cm1');
    // The envelope fields must not leak through as event payload.
    expect(e).not.toHaveProperty('seq');
    expect(e).not.toHaveProperty('schemaVersion');
  });
});

describe('event poller cursor discipline', () => {
  it('advances to max observed seq — gaps are allowed and must not rewind', async () => {
    const seen: string[] = [];
    let call = 0;
    const fetchMock = stubFetch((url) => {
      seen.push(url);
      call += 1;
      if (call === 1) {
        // seq 1 then 7: a gap is legal, and the cursor must follow the MAX,
        // not the item count (which would resume at 2 and replay forever).
        return { body: { data: { items: [
          { spaceId: 'sp', seq: 1, occurredAt: '', schemaVersion: 1, type: 'entity.upsert', entity: { id: 'a' } },
          { spaceId: 'sp', seq: 7, occurredAt: '', schemaVersion: 1, type: 'entity.upsert', entity: { id: 'b' } },
        ], nextCursor: null } } };
      }
      return { body: { data: { items: [], nextCursor: null } } };
    });
    vi.stubGlobal('fetch', fetchMock);

    const events: string[] = [];
    const poller = new EventPoller(new TmClient(), 'sp', 10);
    poller.subscribe((e) => events.push(e.eventId));

    await vi.advanceTimersByTimeAsync(40);
    expect(events).toEqual(['sp:1', 'sp:7']);
    expect(seen[0]).toContain('since=0');
    expect(seen.some((u) => u.includes('since=7'))).toBe(true);
    expect(seen.some((u) => u.includes('since=2'))).toBe(false);
  });

  it('prefers a server-supplied nextCursor over the observed max', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ body: { data: {
      items: [{ spaceId: 'sp', seq: 3, occurredAt: '', schemaVersion: 1, type: 'entity.upsert', entity: { id: 'a' } }],
      nextCursor: 99,
    } } })));
    const urls: string[] = [];
    const client = new TmClient();
    const spy = vi.spyOn(client, 'get');
    spy.mockImplementation(async (p: string) => {
      urls.push(p);
      return { items: urls.length === 1
        ? [{ spaceId: 'sp', seq: 3, occurredAt: '', schemaVersion: 1, type: 'entity.upsert', entity: { id: 'a' } }]
        : [], nextCursor: urls.length === 1 ? 99 : null } as never;
    });
    const poller = new EventPoller(client, 'sp', 10);
    poller.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(40);
    expect(urls[1]).toContain('since=99');
  });

  it('does not advance the cursor when a poll fails, so nothing is skipped', async () => {
    const urls: string[] = [];
    const client = new TmClient();
    vi.spyOn(client, 'get').mockImplementation(async (p: string) => {
      urls.push(p);
      throw new CollabError('upstream_unavailable', 'down');
    });
    const poller = new EventPoller(client, 'sp', 10);
    poller.subscribe(() => {});
    await vi.advanceTimersByTimeAsync(40);
    expect(urls.length).toBeGreaterThan(1);
    expect(urls.every((u) => u.includes('since=0'))).toBe(true);
  });
});

describe('degradation policy — the never-fabricate rule', () => {
  const facade = new RealFacade(new TmClient());

  it('degrades unbuilt READS to typed empties, never to invented rows', async () => {
    vi.stubGlobal('fetch', stubFetch(() => ({ body: { data: null } })));
    expect((await facade.getInbox()).items).toEqual([]);
    expect((await facade.getLeaderboard()).items).toEqual([]);
    expect((await facade.getAwards()).items).toEqual([]);
    expect(await facade.getTaskAxes()).toEqual([]);
    expect(await facade.listSavedViews()).toEqual([]);
    expect(await facade.getChannelTabs()).toEqual([]);
    expect(await facade.getActions()).toEqual([]);
    // A graph with nodes but no edges would LOOK like a real answer.
    expect(await facade.queryGraph({ spaceId: 's' })).toEqual({ nodes: [], edges: [], clusters: [] });
  });

  it('refuses unbuilt WRITES loudly rather than silently doing nothing', async () => {
    const codes = await Promise.all([
      facade.moveEntity('e', { parentId: null, position: 0, expectedVersion: 1 }).catch((e) => e.code),
      facade.deleteEntity('e').catch((e) => e.code),
      facade.setReaction('e', { reaction: 'like' } as never).catch((e) => e.code),
      facade.pullEntity('e', {} as never).catch((e) => e.code),
      facade.placements({} as never).catch((e) => e.code),
      facade.undo('tok').catch((e) => e.code),
    ]);
    expect(codes).toEqual(Array(6).fill('not_implemented'));
  });

  it('makes markRead a silent no-op — it is automatic, not user-invoked', async () => {
    // Throwing here produced an unhandled rejection on EVERY thread open. The
    // unread counters it would clear are hollow zeros, so nothing is faked.
    await expect(facade.markRead('anchor')).resolves.toEqual({ patches: [] });
    expect(isUnavailable('markRead')).toBe(false);
    expect(isUnavailable('markNotificationRead')).toBe(true);
  });

  it('rejects search rather than returning a misleading empty result set', async () => {
    // An empty search result reads as "no matches", which is a different and
    // false claim from "search does not exist".
    await expect(facade.search()).rejects.toMatchObject({ code: 'not_implemented' });
  });
});

describe('hollow-field register', () => {
  it('knows the present-but-permanently-zero fields', () => {
    expect(isHollow('channel.state.unreadCount')).toBe(true);
    expect(isHollow('team_member.state.liveWork')).toBe(true);
    expect(hollowReason('member.state.taskDoneCount')).toMatch(/always 0/);
    // A real field must not be flagged hollow.
    expect(isHollow('task.state.workStatus')).toBe(false);
  });
});

describe('spawn preconditions', () => {
  it('always sends workdir mode "project" — worktree is refused, not defaulted', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', stubFetch((_u, init) => {
      sent = JSON.parse(String(init?.body));
      return { body: { data: { entity: { id: 'sess1' }, patches: [] } } };
    }));
    await new RealFacade(new TmClient()).spawnSession({
      spaceId: 's', projectId: 'p', teamMemberId: 'm', taskIds: ['t'],
    });
    expect(sent.workdir).toEqual({ mode: 'project' });
    expect(sent.mode).toBe('worker');
  });

  it('refuses a completion with no completer instead of letting the server 400', async () => {
    await expect(
      new RealFacade(new TmClient()).completeTask('t', { expectedVersion: 1, completerIds: [] } as never),
    ).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
