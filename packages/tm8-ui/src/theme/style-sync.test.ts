// @vitest-environment jsdom
/**
 * STYLE SYNC (styles spec v8 §3.6, §4.3, §10.1): where the pair comes from
 * once signed in, the one-time legacy migration, and the live events.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ATELIER_DARK, ATELIER_LIGHT, type DurableWorkspaceEvent, type StyleDoc, type StylePrefsView } from '@tm8/contract';

import {
  ACTIVE_STYLE_ELEMENT_ID,
  STYLE_CACHE_KEY,
  __resetStyleStoreForTests,
  getStyleState,
  installActiveStyle,
  setTheme,
} from './style-store';
import { __resetStyleSyncForTests, chooseStyle, startStyleSync, type StyleSyncSeam } from './style-sync';

const SPACE = '01a0fb3d-558e-7d92-b370-d0601112607a';
const STYLE_ID = '01a0fd00-0000-7000-8000-000000000001';
const STYLE_REF = `space:${STYLE_ID}`;
const ME = 'member-me';

const PAPER_A = 'rgb(16, 20, 32)';
const PAPER_B = 'rgb(40, 20, 16)';

function doc(paper: string): StyleDoc {
  return { schemaVersion: 1, foundation: 'builtin:atelier-dark', vars: { '--pn-paper': paper }, css: null };
}

function prefsView(over: Partial<StylePrefsView> = {}): StylePrefsView {
  return {
    currentStyle: 'builtin:atelier-light',
    darkStyle: null,
    followOs: false,
    trustedCss: [],
    snapshot: { current: null, dark: null, currentHash: null, currentTitle: null },
    revision: 1,
    updatedAt: '2026-10-02T00:00:00Z',
    ...over,
  };
}

function collab(code: string): Error {
  return Object.assign(new Error(code), { code });
}

interface Fake {
  seam: StyleSyncSeam;
  emit(event: Partial<DurableWorkspaceEvent> & { type: string }): void;
  setPrefs: ReturnType<typeof vi.fn>;
  stylePrefs: ReturnType<typeof vi.fn>;
}

function fakeSeam(opts: {
  prefs?: StylePrefsView | null;
  defaultStyle?: string | null;
  styles?: Record<string, StyleDoc | 'not_found'>;
}): Fake {
  const listeners = new Set<(e: DurableWorkspaceEvent) => void>();
  let prefs = opts.prefs;
  const setPrefs = vi.fn(async (input: { currentStyle?: string; darkStyle?: string | null; followOs?: boolean }) => {
    prefs = prefsView({
      currentStyle: input.currentStyle ?? 'builtin:atelier-light',
      darkStyle: input.darkStyle ?? null,
      followOs: input.followOs ?? false,
      revision: (prefs?.revision ?? 0) + 1,
    });
    return { prefs, resolved: {} as never };
  });
  const stylePrefs = vi.fn(async () => ({ prefs: prefs ?? null }));
  const seam: StyleSyncSeam = {
    identity: async () => ({ stylePrefs: prefs }) as never,
    onEvent: (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onResync: () => () => {},
    stylePrefs,
    setStylePrefs: setPrefs as never,
    styleDefault: async (spaceId) => ({
      spaceId,
      defaultStyle: opts.defaultStyle ?? 'builtin:atelier-light',
      setBy: null,
      revision: opts.defaultStyle ? 1 : 0,
      updatedAt: null,
    }),
    style: async (ref) => {
      const found = opts.styles?.[ref];
      if (!found || found === 'not_found') throw collab('not_found');
      return { doc: found, title: 'Midnight', version: 1, space: { pushedBy: 'someone' } } as never;
    },
  };
  return {
    seam,
    setPrefs,
    stylePrefs,
    emit: (event) => {
      for (const cb of [...listeners])
        cb({ spaceId: SPACE, seq: 1, occurredAt: '2026-10-02T00:00:00Z', schemaVersion: 1, ...event } as DurableWorkspaceEvent);
    },
  };
}

const sheet = () => document.getElementById(ACTIVE_STYLE_ELEMENT_ID)?.textContent ?? '';

/** Let the boot reads and the per-frame commit run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
}

function stubOs(dark: boolean) {
  const query = { matches: dark, addEventListener: () => {}, removeEventListener: () => {} };
  window.matchMedia = (() => query) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  localStorage.clear();
  stubOs(false);
  __resetStyleSyncForTests();
  __resetStyleStoreForTests();
  installActiveStyle();
});

afterEach(() => {
  __resetStyleSyncForTests();
});

describe('style sync — §3.6 resolution', () => {
  it('no prefs, no space default, nothing chosen: follows the OS and writes nothing', async () => {
    const fake = fakeSeam({ prefs: null });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    expect(getStyleState().source).toBe('os');
    expect(getStyleState().ref).toBe(ATELIER_LIGHT.id);
    expect(fake.setPrefs).not.toHaveBeenCalled();
  });

  it('a new member with no prefs gets the space default (acceptance a2)', async () => {
    const fake = fakeSeam({ prefs: null, defaultStyle: STYLE_REF, styles: { [STYLE_REF]: doc(PAPER_A) } });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    expect(getStyleState().source).toBe('default');
    expect(getStyleState().ref).toBe(STYLE_REF);
    expect(sheet()).toContain(`--pn-paper: ${PAPER_A};`);
  });

  it('prefs outrank the space default', async () => {
    const fake = fakeSeam({ prefs: prefsView({ currentStyle: ATELIER_DARK.id }), defaultStyle: STYLE_REF });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    expect(getStyleState().ref).toBe(ATELIER_DARK.id);
  });

  it('an unreadable current style paints the prefs snapshot and reads as removed', async () => {
    const fake = fakeSeam({
      prefs: prefsView({
        currentStyle: STYLE_REF,
        snapshot: { current: doc(PAPER_B), dark: null, currentHash: null, currentTitle: 'Midnight' },
      }),
      styles: { [STYLE_REF]: 'not_found' },
    });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    expect(getStyleState().current.status).toBe('removed');
    expect(sheet()).toContain(`--pn-paper: ${PAPER_B};`);
  });

  it('follow OS with a dark style paints the dark half while the OS is dark', async () => {
    stubOs(true);
    const fake = fakeSeam({ prefs: prefsView({ darkStyle: ATELIER_DARK.id, followOs: true }) });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    expect(getStyleState().ref).toBe(ATELIER_DARK.id);
  });
});

describe('style sync — §10.1 legacy migration', () => {
  it('migrates tm8ui.theme once on the first authenticated boot, then deletes it', async () => {
    localStorage.setItem('tm8ui.theme', 'dark');
    __resetStyleStoreForTests();
    const fake = fakeSeam({ prefs: null });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    expect(fake.setPrefs).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRevision: 0, currentStyle: ATELIER_DARK.id, followOs: false }),
    );
    expect(localStorage.getItem('tm8ui.theme')).toBeNull();
    expect(getStyleState().source).toBe('prefs');
  });

  it('with a prefs row already, the legacy key is dropped and the row wins', async () => {
    localStorage.setItem('tm8ui.theme', 'dark');
    __resetStyleStoreForTests();
    const fake = fakeSeam({ prefs: prefsView() });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    expect(fake.setPrefs).not.toHaveBeenCalled();
    expect(localStorage.getItem('tm8ui.theme')).toBeNull();
    expect(getStyleState().ref).toBe(ATELIER_LIGHT.id);
  });

  it('a node that predates styles keeps the local choice and the legacy key', async () => {
    localStorage.setItem('tm8ui.theme', 'dark');
    __resetStyleStoreForTests();
    const fake = fakeSeam({ prefs: undefined });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    expect(fake.setPrefs).not.toHaveBeenCalled();
    expect(localStorage.getItem('tm8ui.theme')).toBe('dark');
    expect(getStyleState().ref).toBe(ATELIER_DARK.id);
  });
});

describe('style sync — the boot cache', () => {
  it('paints the cached pair before any network answer', () => {
    localStorage.setItem(
      STYLE_CACHE_KEY,
      JSON.stringify({
        docs: { current: { ref: STYLE_REF, doc: doc(PAPER_A), title: 'Midnight', trustCss: false }, dark: null },
        hash: 'x',
        followOs: false,
        revision: 3,
        source: 'prefs',
      }),
    );
    __resetStyleStoreForTests();
    installActiveStyle();
    expect(getStyleState().ref).toBe(STYLE_REF);
    expect(getStyleState().revision).toBe(3);
    expect(sheet()).toContain(`--pn-paper: ${PAPER_A};`);
  });

  it('ignores a cache whose document fails the schema', () => {
    localStorage.setItem(
      STYLE_CACHE_KEY,
      JSON.stringify({ docs: { current: { ref: STYLE_REF, doc: { nope: 1 } }, dark: null }, hash: 'x', followOs: false, revision: 3 }),
    );
    __resetStyleStoreForTests();
    expect(getStyleState().ref).toBe(ATELIER_LIGHT.id);
  });
});

describe('style sync — live events (§4.3)', () => {
  it('repaints from the full document on entity.upsert of the current space style', async () => {
    const fake = fakeSeam({ prefs: prefsView({ currentStyle: STYLE_REF }), styles: { [STYLE_REF]: doc(PAPER_A) } });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    expect(sheet()).toContain(`--pn-paper: ${PAPER_A};`);
    fake.emit({
      type: 'entity.upsert',
      entity: {
        id: STYLE_ID,
        kind: 'style',
        title: 'Midnight',
        version: 2,
        deletedAt: null,
        state: { kind: 'style', doc: doc(PAPER_B), resolvedHash: null, pushedBy: 'other', pushedAt: '', sourceOwnerIdentityId: '', tags: [] },
      },
    } as never);
    await settle();
    expect(sheet()).toContain(`--pn-paper: ${PAPER_B};`);
  });

  it('entity.deleted keeps painting and marks the style removed', async () => {
    const fake = fakeSeam({ prefs: prefsView({ currentStyle: STYLE_REF }), styles: { [STYLE_REF]: doc(PAPER_A) } });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    fake.emit({ type: 'entity.deleted', entity: { id: STYLE_ID, kind: 'style', deletedAt: '2026-10-02T00:00:00Z' } } as never);
    await settle();
    expect(getStyleState().current.status).toBe('removed');
    expect(sheet()).toContain(`--pn-paper: ${PAPER_A};`);
  });

  it('ignores a stale identity.style_prefs.updated and re-reads a newer one', async () => {
    const fake = fakeSeam({ prefs: prefsView({ revision: 4 }) });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    fake.emit({ type: 'identity.style_prefs.updated', revision: 4, currentStyle: '', darkStyle: null, followOs: false, currentHash: null } as never);
    await settle();
    expect(fake.stylePrefs).not.toHaveBeenCalled();
    fake.emit({ type: 'identity.style_prefs.updated', revision: 5, currentStyle: '', darkStyle: null, followOs: false, currentHash: null } as never);
    await settle();
    expect(fake.stylePrefs).toHaveBeenCalledTimes(1);
  });

  it('space.style_default.updated re-resolves a viewer with no prefs', async () => {
    const fake = fakeSeam({ prefs: null, styles: { [STYLE_REF]: doc(PAPER_A) } });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    expect(getStyleState().source).toBe('os');
    fake.emit({ type: 'space.style_default.updated', defaultStyle: STYLE_REF, revision: 1 } as never);
    await settle();
    expect(getStyleState().ref).toBe(STYLE_REF);
  });
});

describe('style sync — writes', () => {
  it('use() paints at once and records the ref with expectedRevision', async () => {
    const fake = fakeSeam({ prefs: prefsView({ revision: 2 }), styles: { [STYLE_REF]: doc(PAPER_A) } });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    await chooseStyle(STYLE_REF);
    expect(fake.setPrefs).toHaveBeenCalledWith(expect.objectContaining({ expectedRevision: 2, currentStyle: STYLE_REF }));
    await settle();
    expect(getStyleState().revision).toBe(3);
    expect(sheet()).toContain(`--pn-paper: ${PAPER_A};`);
  });

  it('the legacy light/dark toggle writes prefs instead of the legacy key while signed in', async () => {
    const fake = fakeSeam({ prefs: prefsView() });
    startStyleSync(fake.seam, { spaceId: SPACE, viewerMemberId: ME });
    await settle();
    setTheme('dark');
    await settle();
    expect(fake.setPrefs).toHaveBeenCalledWith(expect.objectContaining({ currentStyle: ATELIER_DARK.id }));
    expect(localStorage.getItem('tm8ui.theme')).toBeNull();
  });
});
