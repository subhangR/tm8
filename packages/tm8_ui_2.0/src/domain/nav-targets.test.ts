/**
 * nav-targets — round-trip and EXHAUSTIVENESS, in both directions.
 *
 * The exhaustiveness half is the point of the file. `GateApp`'s render switch
 * is an order-dependent ternary chain whose final branch is the workspace, so a
 * target it does not recognise does not throw and does not warn — it silently
 * renders the workspace. That failure mode is invisible to any test that only
 * asserts "a screen rendered", and it has already shipped twice (the voice-room
 * misroute; channels falling through).
 *
 * So: a new `MenuViewRef` or a new `NavView` member must FAIL A TEST rather
 * than quietly acquire the workspace as its screen.
 */
import { describe, expect, it } from 'vitest';
import { MenuViewRefSchema } from '@tm8/contract';
import type { EntityId } from '@tm8/contract';
import type { NavView } from '../routes/types';
import type { MenuTarget } from '../shell';
import { VIEW_REF_ROUTE, landingOfRoute, navViewOfName, routeViewOf } from './nav-targets';
import { collectionKinds, kindOfSlug, slugOfKind } from './registry';

const ENTITY = 'e1' as EntityId;

/**
 * Every `NavView` tag, written out. This list is the test's own authority and
 * is deliberately NOT derived from the type — a derived list would grow
 * automatically and prove nothing. Adding a route member means adding a row
 * here and deciding what screen it lands on, which is the decision this test
 * exists to force.
 */
const ALL_ROUTE_VIEWS: NavView[] = [
  { view: 'home' },
  { view: 'feed' },
  { view: 'inbox' },
  { view: 'workspace' },
  { view: 'channels' },
  { view: 'graph' },
  { view: 'files' },
  { view: 'git' },
  { view: 'messages' },
  /* `board` was missing from this list — a pre-existing gap, added here
     because a hand-written exhaustiveness list that omits a member silently
     stops guarding it, which is the one failure mode this list has. */
  { view: 'board' },
  /* New Session (2026-08-16): the create screen. The ONLY member whose
     landing has `target: null` — a real screen with no rail seat — so it is
     also the case that proves the two nulls are distinguished. */
  { view: 'newSession' },
  { view: 'settings', section: null },
  { view: 'kind', slug: 'tasks', mode: null, q: null },
  { view: 'entity', entityId: ENTITY, origin: { slug: 'tasks', mode: null } },
  { view: 'channel', channelId: ENTITY, msg: null },
  { view: 'voice', voiceChannelId: ENTITY },
  /* CodeBrain (2026-08-31, SPEC §5.5) — BOTH forms, deliberately, because
     they take different codec paths and only the pair covers the grammar.
     This is a REQUIRED EDIT, not a consequence of the type change: this list
     is hand-written and does not fail on an omission (see the docblock
     above), so adding `codebrain` to `NavView` breaks nothing here on its
     own — CodeBrain would fall silently outside this guard without this row. */
  { view: 'codebrain', runId: null },
  { view: 'codebrain', runId: ENTITY },
];

describe('nav-targets — exhaustiveness', () => {
  it('maps every MenuViewRef to a route tag', () => {
    // The contract enum is the closed vocabulary; if a ref is added there and
    // not here, the table is incomplete and a rail row becomes unaddressable.
    const refs = MenuViewRefSchema.options.slice().sort();
    expect(Object.keys(VIEW_REF_ROUTE).sort()).toEqual(refs);
  });

  it('resolves every NavView member to a landing', () => {
    for (const view of ALL_ROUTE_VIEWS) {
      expect(landingOfRoute(view), `no landing for '${view.view}'`).not.toBeNull();
    }
  });

  it('emits a route for every view-ref target', () => {
    for (const ref of MenuViewRefSchema.options) {
      const target: MenuTarget = { type: 'view', ref };
      expect(routeViewOf(target), `no route for view ref '${ref}'`).not.toBeNull();
    }
  });

  it('emits a route for every collection kind screen', () => {
    // A collection kind with no route is a screen you cannot share or reload.
    for (const config of collectionKinds()) {
      const target: MenuTarget = { type: 'kind', ref: config.kind };
      expect(routeViewOf(target), `no route for kind '${config.kind}'`).not.toBeNull();
    }
  });
});

describe('nav-targets — codebrain (SPEC §5.3, AC2)', () => {
  it('navViewOfName resolves a chord to the member with no run selected', () => {
    // A chord names the screen, not a run within it — the same posture
    // `settings` takes with its section (`navViewOfName('settings')`).
    expect(navViewOfName('codebrain')).toEqual({ view: 'codebrain', runId: null });
  });

  it('landingOfRoute returns a Landing, and the Landing itself is not null', () => {
    // THE distinction Task 7 exists to preserve: `landingOfRoute` returning
    // `null` means unresolvable; a `Landing` whose `target` is `null` means a
    // real screen with no rail seat. CodeBrain is the latter, same as
    // `newSession` and `boardV2` — asserted as two separate facts so neither
    // can be mistaken for the other.
    const landing = landingOfRoute({ view: 'codebrain', runId: null });
    expect(landing).not.toBeNull();
    expect(landing?.target).toBeNull();
    expect(landing?.openEntity).toBeNull();
  });
});

describe('nav-targets — round trips', () => {
  it('round-trips the simple view refs', () => {
    // `channels` is excluded ON PURPOSE: it is an alias that normalizes to the
    // channel collection, asserted separately below. Every other ref is a
    // fixed point.
    for (const ref of MenuViewRefSchema.options.filter((r) => r !== 'channels')) {
      const route = routeViewOf({ type: 'view', ref });
      expect(route).not.toBeNull();
      const landing = landingOfRoute(route as NavView);
      expect(landing?.target, `'${ref}' did not round-trip`).toEqual({ type: 'view', ref });
      expect(landing?.openEntity).toBeNull();
    }
  });

  it('round-trips a kind screen, carrying its layout mode', () => {
    // `mode` rides on the target so the switcher's choice survives navigation
    // (§1.1). Dropping it here would silently reset every user's layout.
    const target: MenuTarget = { type: 'kind', ref: 'task', mode: 'board' };
    const route = routeViewOf(target);
    expect(route).toEqual({ view: 'kind', slug: 'tasks', mode: 'board', q: null });
    expect(landingOfRoute(route as NavView)?.target).toEqual(target);
  });

  it('round-trips the board grouping as q.groupBy — a grouped board is shareable (W3)', () => {
    const target = { type: 'kind', ref: 'task', mode: 'board', groupBy: 'axis:type' } as const;
    const route = routeViewOf(target);
    expect(route).toEqual({
      view: 'kind',
      slug: 'tasks',
      mode: 'board',
      q: { v: 1, groupBy: 'axis:type' },
    });
    expect(landingOfRoute(route as NavView)?.target).toEqual(target);
  });

  it('round-trips an open entity as the shareable e/{id}?origin= form', () => {
    // THE REQUIREMENT'S MAIN CASE: a kind screen with an entity open is a link
    // that reopens that entity on that screen.
    const route = routeViewOf({ type: 'kind', ref: 'task' }, ENTITY);
    expect(route).toEqual({
      view: 'entity',
      entityId: ENTITY,
      origin: { slug: 'tasks', mode: null },
    });
    const landing = landingOfRoute(route as NavView);
    expect(landing?.target).toEqual({ type: 'kind', ref: 'task' });
    expect(landing?.openEntity).toBe(ENTITY);
  });

  it('round-trips a voice room, and does NOT confuse it with a channel', () => {
    /* THE REGRESSION GUARD. `routeViewOf` once returned null for every entity
       target that was not a channel, so deriving the shell's target from the
       store would have silently deleted the voice rooms. The rail emits these
       from a dynamic group over the space's live voice channels — they are
       genuinely reachable, and `registry.ts` has emitted this exact route all
       along while the codec could not parse it. */
    const target: MenuTarget = { type: 'entity', ref: ENTITY, kind: 'voice_channel' };
    const route = routeViewOf(target);
    expect(route).toEqual({ view: 'voice', voiceChannelId: ENTITY });
    expect(landingOfRoute(route as NavView)?.target).toEqual(target);

    // Same target SHAPE as a channel; only the kind tells them apart. A tag-only
    // test is what rendered a message feed for a room that has none.
    const channel = routeViewOf({ type: 'entity', ref: ENTITY, kind: 'channel' });
    expect(channel).not.toEqual(route);
  });

  it('keeps voice out of the collection vocabulary', () => {
    // `voice_channel` is `special` with slug null: a room is not a feed, so it
    // gets a route but never a `k/` view.
    expect(slugOfKind('voice_channel')).toBeNull();
    expect(routeViewOf({ type: 'kind', ref: 'voice_channel' })).toBeNull();
  });

  it('still refuses an entity target of some other kind', () => {
    // Widening to voice must not have widened to everything: an arbitrary kind
    // on an entity target is still a misroute at the source.
    expect(routeViewOf({ type: 'entity', ref: ENTITY, kind: 'task' })).toBeNull();
  });

  it('round-trips a channel as the channel route, not the entity route', () => {
    // The rail's `entity` target means A CHANNEL. Mapping it onto `e/{id}`
    // would send a shared channel link to a detail panel instead of the feed.
    const target: MenuTarget = { type: 'entity', ref: ENTITY, kind: 'channel' };
    const route = routeViewOf(target);
    expect(route).toEqual({ view: 'channel', channelId: ENTITY, msg: null });
    expect(landingOfRoute(route as NavView)?.target).toEqual(target);
  });
});

describe('nav-targets — the channels alias', () => {
  it('lands #/channels on the channel collection screen', () => {
    // Not a screen of its own: the Channels destination IS the channel-kind
    // EntityView — the tree of channels with the channel view beside it.
    const landing = landingOfRoute({ view: 'channels' });
    expect(landing?.target).toEqual({ type: 'kind', ref: 'channel' });
  });

  it('normalizes a channels view target to the collection route', () => {
    // So the URL a viewer sees and the URL they share are the same string.
    expect(routeViewOf({ type: 'view', ref: 'channels' })).toEqual({
      view: 'kind',
      slug: 'channels',
      mode: null,
      q: null,
    });
  });

  it('keeps k/channels and channel/{id} as different destinations', () => {
    // The collection versus one channel — the distinction `registry.ts` calls
    // out explicitly when it moved `channel` to a collection strategy.
    const collection = landingOfRoute({ view: 'kind', slug: 'channels', mode: null, q: null });
    const single = landingOfRoute({ view: 'channel', channelId: ENTITY, msg: null });
    expect(collection?.target).toEqual({ type: 'kind', ref: 'channel' });
    expect(single?.target).toEqual({ type: 'entity', ref: ENTITY, kind: 'channel' });
  });
});

describe('nav-targets — honest refusals', () => {
  it('refuses a kind route whose slug names nothing', () => {
    // An unresolvable link must be refused, never defaulted. Substituting the
    // workspace here is precisely the "you quietly land somewhere else" bug.
    expect(landingOfRoute({ view: 'kind', slug: 'not-a-kind', mode: null, q: null })).toBeNull();
  });

  it('refuses an entity route with an unknown origin', () => {
    expect(
      landingOfRoute({ view: 'entity', entityId: ENTITY, origin: { slug: 'nope', mode: null } }),
    ).toBeNull();
  });

  it('refuses an entity route with no origin, leaving it to the canonical-reload rule', () => {
    // §2.2 resolves the companion from the entity's registry STRATEGY, which
    // needs the entity's kind — a read this pure function cannot do.
    expect(landingOfRoute({ view: 'entity', entityId: ENTITY, origin: null })).toBeNull();
  });

  it('emits no route for a kind with no k/ view', () => {
    // `message` is `anchored` and `voice_channel` is `special` (WLT §2.1):
    // neither has a collection route, so there is nothing honest to emit.
    expect(slugOfKind('message')).toBeNull();
    expect(routeViewOf({ type: 'kind', ref: 'message' })).toBeNull();
  });

  it('does not reserve the four new segments as kind slugs', () => {
    // `files` is BOTH a top-level view route and the `file` kind's slug — they
    // are different paths (`/files` vs `/k/files`), exactly as `channels` and
    // `k/channels` already are. Adding the routes must not have stolen the slug.
    expect(kindOfSlug('files')).toBe('file');
  });
});
