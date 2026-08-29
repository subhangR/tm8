// @vitest-environment jsdom
/**
 * SIGN OUT, HAND THE LAPTOP OVER — the test that pins what the next person
 * does NOT get.
 *
 * THE BUG. `signOutOfServer` cleared the pass and nothing else, while
 * `navStore` and `screenStackStore` are module-level. So the panels, the pins,
 * the `?session=` and every detail screen's stack — all of them entity ids
 * belonging to the viewer who just left — were still there when the next
 * person signed in. Nothing threw. The second viewer simply saw the first
 * viewer's rows.
 *
 * WHAT MAKES THIS TESTABLE AT ALL is that both stores are module-level: this
 * file drives the real `signOutOfServer` against the real stores and then reads
 * them, exactly as the next mount would. A test that rendered a component and
 * asserted on the screen could not tell "cleared" from "not mounted yet".
 *
 * THE ADDRESS IS RULED, NOT ASSUMED (D74). An explicit sign-out blanks it; a
 * session the SERVER ended leaves it exactly as it stands. Both halves are
 * asserted below, because the difference is the whole ruling and a future
 * "tidy up the reset" would otherwise collapse them into whichever was easier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EntitySummary } from '@tm8/contract';
import { signOutOfServer, verifyStoredSession } from './session';
import { forgetSpaceScopedPanels } from './session-reset';
import { noteKnownAccount, readKnownAccounts, readServerPass, writeServerPass } from './pass-store';
import { navStore, resetNav } from '../stores/navStore';
import { screenStackStore, screenKeyOf } from '../stores/screenStackStore';
import { chatStore } from '../channel-screen/chat-store';
import { readLastSpace, readLastTarget, writeLastSpace, writeLastTarget } from '../views/last-place';
import { readLaunchCache, writeLaunchCache } from '../data/launch-cache';

/** A link of the shape §2.2 freezes for a shared entity — the thing at risk. */
const DEEP_LINK = '#/s/019fbd5a-3c5b-71ea-9b91-1d3baa50da25/e/4f8c2a9e-77b1-4e3d-9c2f-a1b0d3e5f6a7?origin=tasks';

const SPACE = '019fbd5a-3c5b-71ea-9b91-1d3baa50da25';
const OPEN = '4f8c2a9e-77b1-4e3d-9c2f-a1b0d3e5f6a7';
const PINNED = '7a1c3d5e-9b2f-4c6a-8d0e-1f2a3b4c5d6e';
const SESSION = '2b4d6f8a-0c1e-4a3b-9d5c-7e8f0a1b2c3d';

/**
 * The `realSeamFlag.test.ts` storage stub, copied per that file's docblock:
 * the ambient `localStorage` under this runner is missing members these modules
 * call — `key`/`length` among them, which the launch-cache sweep walks.
 */
function installStorage(): void {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, String(v)),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => [...store.keys()][i] ?? null,
      get length() {
        return store.size;
      },
    },
  });
}

const teammate = (id: string): EntitySummary =>
  ({
    id,
    spaceId: SPACE,
    kind: 'team_member',
    title: id,
    parentId: null,
    position: 1,
    visibility: 'space',
    version: 1,
    activityAt: '2026-08-15T00:00:00.000Z',
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'm1', kind: 'member', displayName: 'Amber', avatar: null, isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: {
      kind: 'team_member',
      owner: { id: 'm1', kind: 'member', displayName: 'Amber', avatar: null, isAgent: false },
      model: 'claude-opus-5',
      agentTool: 'claude-code',
      liveWork: null,
    },
    badges: {},
  }) as unknown as EntitySummary;

/** The pass the departing viewer holds. `local` is the active server by default. */
function signIn(handle = 'amber'): void {
  writeServerPass('local', {
    token: 'tm8s_sess-1.secret',
    account: {
      handle,
      displayName: handle,
      accountId: 'acct_1',
      identityId: 'id_1',
      isOwner: true,
      isNodeAdmin: true,
    },
    sessionId: 'sess-1',
    expiresAt: '2027-01-01T00:00:00.000Z',
    signedInAt: '2026-08-15T00:00:00.000Z',
  });
  noteKnownAccount('local', {
    handle,
    displayName: handle,
    lastSignedInAt: '2026-08-15T00:00:00.000Z',
  });
}

/** Everything the departing viewer had on screen, in the stores that hold it. */
function fillTheScreen(): void {
  navStore.getState().setSpace(SPACE);
  navStore.getState().push(OPEN);
  navStore.getState().pin(PINNED);
  navStore.getState().setTab(OPEN, 'discussion');
  navStore.getState().setContentSurface(OPEN, 'terminal');
  navStore.getState().setSession(SESSION);
  screenStackStore.getState().open(screenKeyOf.kind('tasks'), OPEN);
  screenStackStore.getState().open(screenKeyOf.channel('c-1'), PINNED);
  chatStore.getState().ensure({
    viewerMemberId: 'mem_amber',
    sessionId: 'sess-1',
    scope: 'session_chat_v1',
    filter: 'chronological',
  });
  writeLastSpace('local', SPACE);
  writeLastTarget('local', SPACE, { type: 'entity', ref: OPEN, kind: 'task' });
  writeLaunchCache('local', SPACE, [teammate('tm-1')]);
}

/** What a fresh browser would show. Read as a whole so a new field cannot slip past. */
function whatSurvives() {
  const nav = navStore.getState();
  return {
    spaceId: nav.spaceId,
    view: nav.view,
    stack: nav.stack,
    pinned: nav.pinned,
    tabs: nav.tabs,
    contentSurface: nav.contentSurface,
    session: nav.session,
    stacks: screenStackStore.getState().stacks,
    chat: Object.keys(chatStore.getState().entries),
  };
}

const NOTHING = {
  spaceId: '',
  view: { view: 'home' },
  stack: [],
  pinned: [],
  tabs: {},
  contentSurface: {},
  session: null,
  stacks: {},
  chat: [],
};

beforeEach(() => {
  installStorage();
  resetNav();
  screenStackStore.getState().clearAll();
  chatStore.getState().clearAll();
  window.location.hash = DEEP_LINK;
  /* The logout revoke is fire-and-forget; it must not decide this test. */
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"data":{}}') })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('an explicit sign-out', () => {
  it('leaves the next viewer nothing: no panels, no pins, no session, no screen stacks', () => {
    signIn();
    fillTheScreen();
    /* The state is genuinely there — otherwise this asserts the reset about a
       screen that was already empty. */
    expect(whatSurvives()).not.toEqual(NOTHING);

    signOutOfServer();

    expect(whatSurvives()).toEqual(NOTHING);
  });

  it('blanks the address, because the bar names an entity to whoever is now at the screen', () => {
    signIn();
    fillTheScreen();

    signOutOfServer();

    expect(window.location.hash).toBe('#/');
  });

  it('forgets this node’s remembered place, which would otherwise restore it on the next sign-in', () => {
    signIn();
    fillTheScreen();
    expect(readLastTarget('local', SPACE)).toEqual({ type: 'entity', ref: OPEN, kind: 'task' });

    signOutOfServer();

    expect(readLastSpace('local')).toBeNull();
    expect(readLastTarget('local', SPACE)).toBeNull();
  });

  it('drops the cached launch sources, so the next viewer’s pickers are not seeded with someone else’s space', () => {
    signIn();
    fillTheScreen();
    expect(readLaunchCache('local', SPACE)).not.toBeNull();

    signOutOfServer();

    expect(readLaunchCache('local', SPACE)).toBeNull();
  });

  it('still forgets the pass, and still remembers WHICH accounts have signed in here', () => {
    signIn();
    fillTheScreen();

    signOutOfServer();

    /* `session.ts`'s two-records rule: the gate must still be able to offer
       "sign back in as @amber". Clearing this would be a different bug. */
    expect(readServerPass('local')).toBeNull();
    expect(readKnownAccounts('local').map((a) => a.handle)).toEqual(['amber']);
  });

  it('writes no address at all when there was no session to end', () => {
    /* The signed-out-gate law (`views/signed-out-hash.test.tsx`): a deep link
       belongs to whoever is holding it, and a defensive sign-out call from a
       viewer who is already out must not destroy theirs. */
    signOutOfServer();

    expect(window.location.hash).toBe(DEEP_LINK);
  });
});

describe('a session the SERVER ended', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          text: () =>
            Promise.resolve(JSON.stringify({ error: { code: 'unauthenticated', message: 'pass revoked' } })),
        }),
      ),
    );
  });

  it('clears the same stores — an expired pass is no more anybody’s than a revoked one', async () => {
    signIn();
    fillTheScreen();

    const verdict = await verifyStoredSession();

    expect(verdict).toEqual({ state: 'invalid' });
    expect(whatSurvives()).toEqual(NOTHING);
  });

  it('leaves the address and the remembered place alone, so signing back in returns you to the page', async () => {
    signIn();
    fillTheScreen();

    await verifyStoredSession();

    /* D74's other half. The viewer did not ask to leave and may not have moved
       from the machine; the destination is theirs to come back to. */
    expect(window.location.hash).toBe(DEEP_LINK);
    expect(readLastTarget('local', SPACE)).toEqual({ type: 'entity', ref: OPEN, kind: 'task' });
  });
});

describe('the shared body a space switch uses', () => {
  it('clears the panels and the screen stacks but keeps the space, which is the whole difference', () => {
    fillTheScreen();

    forgetSpaceScopedPanels();

    const nav = navStore.getState();
    expect(nav.stack).toEqual([]);
    expect(nav.pinned).toEqual([]);
    expect(nav.session).toBeNull();
    /* Pruned with the ids they belonged to, which is why this goes through the
       store's own action rather than a hand-rolled clear. */
    expect(nav.tabs).toEqual({});
    expect(nav.contentSurface).toEqual({});
    expect(screenStackStore.getState().stacks).toEqual({});
    /* `leaveSpaceContext` writes the new space itself, a frame later. A sign-out
       has nowhere to arrive, which is why it calls `resetNav` instead. */
    expect(nav.spaceId).toBe(SPACE);
  });
});
