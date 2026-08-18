/**
 * Route codec property + law tests (LLD §15.3).
 *
 * Round-trip · 2048 cap · ordered atomic drops · unknown-`q`-version discard ·
 * `normalize` idempotence · the D12 preservation-clamp.
 */
import { describe, expect, it } from 'vitest';
import { build, defaultRoute, normalize, parse } from './codec';
import { decodeQ, encodeQ } from './q';
import { MAX_HASH_LENGTH, emptyPanels } from './types';
import type { ContentSurface, PanelTab, Route } from './types';

const SPACE = '019f98a0-1111-2222-3333-444455556666';

function id(n: number): string {
  return `019f98a0-aaaa-bbbb-cccc-${String(n).padStart(12, '0')}`;
}

function routeOf(partial: Partial<Route> = {}): Route {
  return { ...defaultRoute(SPACE, { view: 'workspace' }), ...partial };
}

/** Deterministic PRNG: property tests must fail the same way twice. */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe('grammar (WLT §2.2 verbatim)', () => {
  const cases: [string, unknown][] = [
    [`#/s/${SPACE}/home`, { view: 'home' }],
    [`#/s/${SPACE}/feed`, { view: 'feed' }],
    [`#/s/${SPACE}/inbox`, { view: 'inbox' }],
    [`#/s/${SPACE}/workspace`, { view: 'workspace' }],
    [`#/s/${SPACE}/k/tasks`, { view: 'kind', slug: 'tasks', mode: null, q: null }],
    [`#/s/${SPACE}/k/tasks?mode=board`, { view: 'kind', slug: 'tasks', mode: 'board', q: null }],
    [`#/s/${SPACE}/e/${id(1)}`, { view: 'entity', entityId: id(1), origin: null }],
    [
      `#/s/${SPACE}/e/${id(1)}?origin=sessions.tree`,
      { view: 'entity', entityId: id(1), origin: { slug: 'sessions', mode: 'tree' } },
    ],
    [`#/s/${SPACE}/channels`, { view: 'channels' }],
    [`#/s/${SPACE}/channel/${id(2)}`, { view: 'channel', channelId: id(2), msg: null }],
    [
      `#/s/${SPACE}/channel/${id(2)}?msg=${id(3)}`,
      { view: 'channel', channelId: id(2), msg: id(3) },
    ],
    /* New Session (2026-08-16): hyphenated segment, camel member — the two
       vocabularies are already deliberately different (`dashboard` ↔ `home`). */
    [`#/s/${SPACE}/new-session`, { view: 'newSession' }],
    [`#/s/${SPACE}/settings`, { view: 'settings', section: null }],
    [`#/s/${SPACE}/settings/projects`, { view: 'settings', section: 'projects' }],
    [`#/s/${SPACE}/settings/menu`, { view: 'settings', section: 'menu' }],
  ];

  it.each(cases)('parses %s', (hash, target) => {
    const { route, dropped } = parse(hash);
    expect(dropped).toEqual([]);
    expect(route?.spaceId).toBe(SPACE);
    expect(route?.target).toEqual(target);
  });

  it('renders the space picker when no space is addressed', () => {
    expect(parse('#/').route).toBeNull();
    expect(parse('#/home').route).toBeNull();
  });
});

describe('param encodings (SPEC-FINAL §4.2.2)', () => {
  it('encodes p bottom→top, pin in pin order, t and contentSurface as pairs', () => {
    const route = routeOf({
      panels: {
        stack: [id(1), id(2)],
        pinned: [id(3)],
        tabs: { [id(1)]: 'discussion' },
        contentSurface: { [id(3)]: 'terminal' },
        session: id(4),
      },
    });
    const { hash, dropped } = build(route);
    expect(dropped).toEqual([]);
    expect(hash).toContain(`p=${id(1)}.${id(2)}`);
    expect(hash).toContain(`pin=${id(3)}`);
    expect(hash).toContain(`t=${id(1)}:discussion`);
    expect(hash).toContain(`contentSurface=${id(3)}:terminal`);
    expect(hash).toContain(`session=${id(4)}`);
  });

  it('percent-encodes ids that contain the delimiters', () => {
    const awkward = 'a.b:c,d e/f%g#h';
    const route = routeOf({ panels: { ...emptyPanels(), stack: [awkward], tabs: { [awkward]: 'activity' } } });
    const { hash } = build(route);
    // The dot delimiter is escaped explicitly — encodeURIComponent leaves it.
    expect(hash).not.toMatch(/p=[^&]*[^%]\./);
    const back = parse(hash).route!;
    expect(back.panels.stack).toEqual([awkward]);
    expect(back.panels.tabs[awkward]).toBe('activity');
  });
});

describe('round-trip (property)', () => {
  it('parse ∘ build is the identity on normalized routes', () => {
    const rand = lcg(20260728);
    const tabs: PanelTab[] = ['content', 'discussion', 'connections', 'activity'];
    const surfaces: ContentSurface[] = ['terminal', 'transcript'];

    for (let iteration = 0; iteration < 250; iteration += 1) {
      const stackCount = Math.floor(rand() * 4);
      const pinCount = Math.floor(rand() * 4);
      const stack = Array.from({ length: stackCount }, () => id(Math.floor(rand() * 8)));
      const pinned = Array.from({ length: pinCount }, () => id(Math.floor(rand() * 8)));
      const open = [...stack, ...pinned];
      const tabMap: Record<string, PanelTab> = {};
      const surfaceMap: Record<string, ContentSurface> = {};
      for (const entity of open) {
        if (rand() < 0.5) tabMap[entity] = tabs[Math.floor(rand() * tabs.length)];
        if (rand() < 0.5) surfaceMap[entity] = surfaces[Math.floor(rand() * surfaces.length)];
      }

      const target =
        rand() < 0.5
          ? ({ view: 'workspace' } as const)
          : ({ view: 'kind', slug: 'tasks', mode: 'board', q: { v: 1 as const, sortBy: 'priority' as const } } as const);

      const canonical = normalize(
        routeOf({
          target,
          panels: {
            stack,
            pinned,
            tabs: tabMap,
            contentSurface: surfaceMap,
            session: rand() < 0.3 ? id(9) : null,
          },
        }),
      );

      const { hash, dropped } = build(canonical);
      expect(dropped).toEqual([]);
      const reparsed = parse(hash);
      expect(reparsed.dropped).toEqual([]);
      expect(normalize(reparsed.route!)).toEqual(canonical);
    }
  });
});

describe('normalize (LLD §5.2, §6)', () => {
  it('is idempotent: normalize ∘ normalize = normalize', () => {
    const rand = lcg(4612);
    for (let i = 0; i < 200; i += 1) {
      const stack = Array.from({ length: Math.floor(rand() * 5) }, () => id(Math.floor(rand() * 5)));
      const pinned = Array.from({ length: Math.floor(rand() * 5) }, () => id(Math.floor(rand() * 5)));
      const route = routeOf({
        panels: {
          stack,
          pinned,
          tabs: { [id(0)]: 'content', [id(1)]: 'activity', [id(99)]: 'discussion' },
          contentSurface: { [id(2)]: 'transcript', [id(99)]: 'terminal' },
          session: null,
        },
      });
      const once = normalize(route);
      expect(normalize(once)).toEqual(once);
    }
  });

  it('dedups across sets with precedence PIN > STACK (WLT §2.2 hydration rule)', () => {
    const shared = id(1);
    const canonical = normalize(
      routeOf({
        panels: { ...emptyPanels(), stack: [shared, id(2)], pinned: [shared] },
      }),
    );
    expect(canonical.panels.pinned).toEqual([shared]);
    expect(canonical.panels.stack).toEqual([id(2)]);
  });

  it('prunes tab and surface entries for panels that are not open', () => {
    const canonical = normalize(
      routeOf({
        panels: {
          ...emptyPanels(),
          stack: [id(1)],
          tabs: { [id(1)]: 'activity', [id(7)]: 'discussion' },
          contentSurface: { [id(1)]: 'transcript', [id(7)]: 'terminal' },
        },
      }),
    );
    expect(canonical.panels.tabs).toEqual({ [id(1)]: 'activity' });
    expect(canonical.panels.contentSurface).toEqual({ [id(1)]: 'transcript' });
  });

  it('drops explicit content tabs (an omitted pair already means content)', () => {
    const canonical = normalize(
      routeOf({ panels: { ...emptyPanels(), stack: [id(1)], tabs: { [id(1)]: 'content' } } }),
    );
    expect(canonical.panels.tabs).toEqual({});
  });
});

/**
 * D12, AS IT NOW STANDS. The original rule read "`contentSurface=…:chat` is
 * preserved and rebuilds unchanged", and it was protecting a link authored by a
 * NEWER client from being made lossy by an older one — `chat` was then a
 * FUTURE token this codec did not yet present.
 *
 * `chat` is now a RETIRED token, which inverts the situation the rule was
 * written for. The link is still honoured — that half of D12 is untouched and
 * is what these assertions are mostly about — but it resolves to the surface
 * that token now names, and the retired spelling is not written back out.
 * Nothing is lost by that rewrite: `transcript` is exactly what `chat` meant on
 * a session panel. Re-emitting a name the app no longer uses anywhere else is
 * what would keep the vocabulary alive after it was ruled dead.
 */
describe('D12 — a retired contentSurface token still resolves', () => {
  it('accepts chat, resolves it to transcript, and does not write it back', () => {
    const hash = `#/s/${SPACE}/workspace?p=${id(1)}&contentSurface=${id(1)}:chat`;
    const { route, dropped } = parse(hash);
    // STILL NOT DROPPED. An old link keeps working — that is the half of D12
    // that matters to anyone holding one.
    expect(dropped).toEqual([]);
    expect(route!.panels.contentSurface[id(1)]).toBe('transcript');

    // One-directional: accepted on the way in, never emitted on the way out.
    const rebuilt = build(normalize(route!));
    expect(rebuilt.hash).toContain(`contentSurface=${id(1)}:transcript`);
    expect(rebuilt.hash).not.toContain(':chat');
    expect(parse(rebuilt.hash).route!.panels.contentSurface[id(1)]).toBe('transcript');
  });

  it('is DISTINCT from the atomic discard of an unparseable surface value', () => {
    const { route, dropped } = parse(
      `#/s/${SPACE}/workspace?p=${id(1)}&contentSurface=${id(1)}:hologram`,
    );
    expect(dropped).toContain('tabs');
    expect(route!.panels.contentSurface).toEqual({});
  });
});

describe('unparseable params are discarded ATOMICALLY', () => {
  it('discards the whole t param when any pair is malformed', () => {
    const { route, dropped } = parse(
      `#/s/${SPACE}/workspace?p=${id(1)}.${id(2)}&t=${id(1)}:activity,${id(2)}:nonsense`,
    );
    expect(dropped).toContain('tabs');
    expect(route!.panels.tabs).toEqual({});
    // The other params survive: the discard is per-param, not per-hash.
    expect(route!.panels.stack).toEqual([id(1), id(2)]);
  });

  it('discards an unknown mode and an unregistered origin, keeping the route', () => {
    const mode = parse(`#/s/${SPACE}/k/tasks?mode=hologram`);
    expect(mode.dropped).toContain('mode');
    expect(mode.route!.target).toEqual({ view: 'kind', slug: 'tasks', mode: null, q: null });

    const origin = parse(`#/s/${SPACE}/e/${id(1)}?origin=not-a-slug`);
    expect(origin.dropped).toContain('origin');
    expect(origin.route!.target).toMatchObject({ view: 'entity', origin: null });
  });

  it('accepts a custom-kind origin (c-{name}) as registry-valid', () => {
    const { route, dropped } = parse(`#/s/${SPACE}/e/${id(1)}?origin=c-incident.list`);
    expect(dropped).toEqual([]);
    expect(route!.target).toMatchObject({ origin: { slug: 'c-incident', mode: 'list' } });
  });
});

describe('q codec v1 (SPEC-FINAL §4.2.4)', () => {
  it('round-trips the three carried members', () => {
    const value = { v: 1 as const, filters: { status: ['open' as const] }, sortBy: 'priority' as const, groupBy: 'axis:team' as const };
    expect(decodeQ(encodeQ(value))).toEqual(value);
  });

  /**
   * PHASE 9 — a URL outlives the build that wrote it, so it is the one place
   * the retired word can still ARRIVE from. `v` stays 1 because the change is
   * to v1's VOCABULARY, not to the codec, and the decoder translates.
   */
  describe('a pre-rename `workStatus` link still works', () => {
    const legacy = (payload: object) =>
      btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    it('moves a legacy filter key onto `status`', () => {
      expect(decodeQ(legacy({ v: 1, filters: { workStatus: ['working'] } }))).toEqual({
        v: 1,
        filters: { status: ['working'] },
      });
    });

    it('accepts a legacy groupBy instead of DISCARDING THE WHOLE q', () => {
      // The failure this prevents is not "the grouping is lost". `decodeQ`
      // discards atomically, so an unrecognised groupBy took the user's
      // FILTERS AND SORT down with it.
      expect(
        decodeQ(legacy({ v: 1, filters: { readyToPull: true }, sortBy: 'priority', groupBy: 'workStatus' })),
      ).toEqual({ v: 1, filters: { readyToPull: true }, sortBy: 'priority', groupBy: 'status' });
    });

    it('lets an explicit `status` win when a link carries both', () => {
      // Both spellings means a newer build wrote it; the new key is the one
      // it meant, and the legacy key is dropped rather than merged.
      expect(
        decodeQ(legacy({ v: 1, filters: { workStatus: ['open'], status: ['done'] } })),
      ).toEqual({ v: 1, filters: { status: ['done'] } });
    });

    it('never RE-EMITS the retired word — a translated link normalises itself', () => {
      // The shim is a migration, not a second live sense: the first URL
      // rewrite after a translated read carries only the new spelling.
      const decoded = decodeQ(legacy({ v: 1, filters: { workStatus: ['working'] } }))!;
      const round = JSON.parse(atob(encodeQ(decoded).replace(/-/g, '+').replace(/_/g, '/')));
      expect(JSON.stringify(round)).not.toContain('workStatus');
      expect(round.filters).toEqual({ status: ['working'] });
    });
  });

  it('discards an unknown version atomically — never a partial read', () => {
    const future = btoa(JSON.stringify({ v: 2, filters: { readyToPull: true } }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(decodeQ(future)).toBeNull();

    const { route, dropped } = parse(`#/s/${SPACE}/k/tasks?q=${future}`);
    expect(dropped).toContain('query');
    expect(route!.target).toMatchObject({ view: 'kind', q: null });
  });

  it('discards garbage rather than throwing', () => {
    expect(decodeQ('not-base64!!')).toBeNull();
    expect(decodeQ('')).toBeNull();
  });
});

describe('the 2048 cap and its ordered atomic drops', () => {
  const many = (count: number) => Array.from({ length: count }, (_, i) => id(i));

  it('never exceeds the cap and never cuts mid-token', () => {
    const stack = many(60);
    const route = routeOf({
      target: { view: 'kind', slug: 'tasks', mode: 'board', q: { v: 1, sortBy: 'priority' } },
      panels: {
        stack,
        pinned: many(3),
        tabs: Object.fromEntries(stack.map((e) => [e, 'activity' as PanelTab])),
        contentSurface: Object.fromEntries(stack.map((e) => [e, 'transcript' as ContentSurface])),
        session: null,
      },
    });
    const { hash, dropped } = build(route);
    expect(hash.length).toBeLessThanOrEqual(MAX_HASH_LENGTH);
    expect(dropped.length).toBeGreaterThan(0);
    // Whatever survived still parses — no truncated token ever reaches a user.
    expect(parse(hash).dropped).toEqual([]);
  });

  it('drops in the ruled order: t tier → pin → p → q', () => {
    const grow = (count: number) => {
      const stack = many(count);
      return routeOf({
        target: { view: 'kind', slug: 'tasks', mode: 'board', q: { v: 1, sortBy: 'priority' } },
        panels: {
          stack,
          pinned: many(3),
          tabs: Object.fromEntries(stack.map((e) => [e, 'activity' as PanelTab])),
          contentSurface: Object.fromEntries(stack.map((e) => [e, 'transcript' as ContentSurface])),
          session: null,
        },
      });
    };

    // Sweep the size, so the assertion does not depend on a hand-guessed
    // threshold: the LAW is that drops are always a prefix of the ruled order,
    // and that growing the route only ever drops MORE.
    const order = ['tabs', 'pins', 'stack', 'query'];
    const seen: string[][] = [];
    for (let size = 1; size <= 220; size += 1) seen.push(build(grow(size)).dropped);

    for (const dropped of seen) {
      // Order is a PREFIX property: you never lose `pin` while keeping `t`.
      expect(dropped).toEqual(order.slice(0, dropped.length));
    }
    for (let i = 1; i < seen.length; i += 1) {
      expect(seen[i].length).toBeGreaterThanOrEqual(seen[i - 1].length);
    }
    // Every tier is actually reachable — including the `t`-tier-only state.
    expect(seen.some((d) => d.length === 0)).toBe(true);
    expect(seen.some((d) => d.join() === 'tabs')).toBe(true);
    expect(seen.some((d) => d.join() === 'tabs,pins')).toBe(true);
    expect(seen[seen.length - 1].length).toBeGreaterThanOrEqual(3);
  });

  it('drops t AND contentSurface together — they are ONE tier', () => {
    const stack = many(20);
    const route = routeOf({
      panels: {
        stack,
        pinned: [],
        tabs: Object.fromEntries(stack.map((e) => [e, 'activity' as PanelTab])),
        contentSurface: Object.fromEntries(stack.map((e) => [e, 'transcript' as ContentSurface])),
        session: null,
      },
    });
    const { hash, dropped } = build(route);
    expect(dropped).toContain('tabs');
    expect(hash).not.toContain('t=');
    expect(hash).not.toContain('contentSurface=');
  });

  it('always succeeds: navigation happens even when everything is dropped', () => {
    const stack = many(400);
    const { hash } = build(
      routeOf({ panels: { ...emptyPanels(), stack } }),
    );
    expect(hash.length).toBeLessThanOrEqual(MAX_HASH_LENGTH);
    expect(parse(hash).route).not.toBeNull();
  });
});

describe('the unified Home root and the right trail (task 01a00932)', () => {
  it('round-trips /home/k/{slug} — a kind root is addressable', () => {
    const route = routeOf({ target: { view: 'home', root: { type: 'kind', slug: 'tasks' } } });
    const { hash } = build(route);
    expect(hash).toContain('/home/k/tasks');
    const back = parse(hash).route!;
    expect(back.target).toEqual({ view: 'home', root: { type: 'kind', slug: 'tasks' } });
  });

  it('round-trips /home/chat/{id} — the open conversation is addressable', () => {
    const route = routeOf({
      target: { view: 'home', root: { type: 'chats', threadId: 'th-1' } },
    });
    const { hash } = build(route);
    expect(hash).toContain('/home/chat/th-1');
    const back = parse(hash).route!;
    expect(back.target).toEqual({ view: 'home', root: { type: 'chats', threadId: 'th-1' } });
  });

  it('canonicalizes chats-with-no-thread to bare /home — one address per place', () => {
    const denormal = routeOf({
      target: { view: 'home', root: { type: 'chats', threadId: null } },
    });
    expect(normalize(denormal).target).toEqual({ view: 'home' });
    expect(build(normalize(denormal)).hash.endsWith('/home')).toBe(true);
    // And a hand-typed /home/chat parses to that same denormal form.
    expect(parse('#/s/sp/home/chat').route?.target).toEqual({
      view: 'home',
      root: { type: 'chats', threadId: null },
    });
  });

  it('round-trips the right trail through r=, dot-joined like p=', () => {
    const route = normalize(
      routeOf({ panels: { ...emptyPanels(), stack: ['a', 'b'], right: ['c', 'd'] } }),
    );
    const { hash } = build(route);
    expect(hash).toContain('r=c.d');
    expect(parse(hash).route?.panels.right).toEqual(['c', 'd']);
  });

  it('a malformed r is discarded atomically under its own drop class', () => {
    const { route, dropped } = parse('#/s/sp/home?r=');
    expect(route?.panels.right).toEqual([]);
    expect(dropped).toContain('right');
  });

  it('normalize dedupes the right trail within itself, never against the stack', () => {
    const route = routeOf({
      panels: { ...emptyPanels(), stack: ['a'], right: ['a', 'b', 'b'] },
    });
    // The same entity open centre AND beside it is an honest viewer state.
    expect(normalize(route).panels.right).toEqual(['a', 'b']);
    expect(normalize(route).panels.stack).toEqual(['a']);
  });

  it('keeps tab state for a right-panel id — right ids are open ids', () => {
    const route = routeOf({
      panels: {
        ...emptyPanels(),
        right: ['c'],
        tabs: { c: 'activity' as PanelTab },
      },
    });
    expect(normalize(route).panels.tabs).toEqual({ c: 'activity' });
  });

  it('drops the right trail after the t tier and before pins', () => {
    const stack = ['keep'];
    const right = Array.from({ length: 60 }, (_, i) => `panel-entity-${i}-abcdefghijklmnopqrstuvwxyz`);
    const pinned = ['pin-1'];
    const route = routeOf({
      panels: {
        ...emptyPanels(),
        stack,
        right,
        pinned,
        tabs: { keep: 'activity' as PanelTab },
      },
    });
    const { hash, dropped } = build(route);
    expect(hash.length).toBeLessThanOrEqual(MAX_HASH_LENGTH);
    // The right trail went; the pins and the centre stack survived it.
    expect(dropped).toContain('right');
    expect(dropped).not.toContain('pins');
    expect(dropped).not.toContain('stack');
    expect(hash).toContain('pin=');
    expect(hash).toContain('p=');
  });
});

describe('the Cockpit stage param `?stage=`', () => {
  /* REPLACES `?graph=full` and `?gf=`. The Cockpit ruling retires the
     fullscreen graph dialog and the facet rail that edited `gf`, and both
     stages that remain are ordinary occupants of region B. The lossy-tolerant
     parse is inherited verbatim, because a stale link to the retired
     parameters must degrade to the plain conversation rather than announce
     that it once meant something. */

  it('parses each stage on an addressed conversation', () => {
    for (const stage of ['fleet', 'graph'] as const) {
      const { route, dropped } = parse(`#/s/${SPACE}/home/chat/${id(1)}?stage=${stage}`);
      expect(dropped).toEqual([]);
      expect(route?.target).toEqual({
        view: 'home',
        root: { type: 'chats', threadId: id(1), stage },
      });
    }
  });

  it('round-trips through build, with and without a thread', () => {
    for (const threadId of [id(1), null]) {
      for (const stage of ['fleet', 'graph'] as const) {
        const route = routeOf({
          target: { view: 'home', root: { type: 'chats', threadId, stage } },
        });
        const { hash, dropped } = build(normalize(route));
        expect(dropped).toEqual([]);
        expect(hash).toContain(`stage=${stage}`);
        expect(parse(hash).route?.target).toEqual(route.target);
      }
    }
  });

  it('LOSSY-TOLERANT: an unknown value is silently ignored — no drop, no crash', () => {
    for (const raw of ['stage=weird', 'stage=', 'stage=%ZZ']) {
      const { route, dropped } = parse(`#/s/${SPACE}/home/chat/${id(1)}?${raw}`);
      expect(dropped).toEqual([]);
      expect(route?.target).toEqual({
        view: 'home',
        root: { type: 'chats', threadId: id(1) },
      });
    }
  });

  it('BACK-COMPAT: `?graph=full` decodes to the Graph stage, and is never encoded', () => {
    /* Route-token preserve rule, per the coordinator's ruling. Links to
       `?graph=full` are in histories and in pasted messages, and the view it
       named still exists — it is a stage now. So an old link lands on the
       thing it asked for, while `build` emits only `?stage=`, letting the
       alias fade from every URL the app produces without breaking the ones it
       already handed out. */
    const { route, dropped } = parse(`#/s/${SPACE}/home/chat/${id(1)}?graph=full`);
    expect(dropped).toEqual([]);
    expect(route?.target).toEqual({
      view: 'home',
      root: { type: 'chats', threadId: id(1), stage: 'graph' },
    });
    // Decode-only: re-encoding that route emits the new spelling, not the old.
    const { hash } = build(normalize(routeOf({ target: route!.target })));
    expect(hash).toContain('stage=graph');
    expect(hash).not.toContain('graph=full');
  });

  it('`?stage=` WINS over the alias when a link carries both', () => {
    const { route } = parse(`#/s/${SPACE}/home/chat/${id(1)}?stage=fleet&graph=full`);
    expect(route?.target).toEqual({
      view: 'home',
      root: { type: 'chats', threadId: id(1), stage: 'fleet' },
    });
  });

  it('`?gf=` dies undecoded — it addressed a rail that no longer exists', () => {
    /* Unlike `graph`, this has nothing to alias TO: it was opaque at this
       layer by design and named a facet rail the Cockpit ruling retired.
       Asserting it stops a later reader from reviving a filter vocabulary to
       honour its own URL. */
    for (const raw of ['gf=k%3Atask%3Bm', 'gf=']) {
      const { route, dropped } = parse(`#/s/${SPACE}/home/chat/${id(1)}?${raw}`);
      expect(dropped).toEqual([]);
      expect(route?.target).toEqual({
        view: 'home',
        root: { type: 'chats', threadId: id(1) },
      });
    }
  });

  it('normalize still collapses a bare chats root, but never one holding a stage', () => {
    const bare = routeOf({
      target: { view: 'home', root: { type: 'chats', threadId: null } },
    });
    expect(normalize(bare).target).toEqual({ view: 'home' });
    const staged = routeOf({
      target: { view: 'home', root: { type: 'chats', threadId: null, stage: 'fleet' } },
    });
    expect(normalize(staged).target).toEqual({
      view: 'home',
      root: { type: 'chats', threadId: null, stage: 'fleet' },
    });
    // Idempotent, as normalize must stay.
    expect(normalize(normalize(staged))).toEqual(normalize(staged));
  });

  it('bare /home never grows the param — only the /chat segment reads it', () => {
    const { route } = parse(`#/s/${SPACE}/home?stage=fleet`);
    expect(route?.target).toEqual({ view: 'home' });
  });
});
