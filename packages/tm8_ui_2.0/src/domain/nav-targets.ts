/**
 * nav-targets — the ONE mapping between the shell's `MenuTarget` vocabulary and
 * the route codec's `NavView` vocabulary.
 *
 * WHY THIS FILE EXISTS. The app has had two independent names for "where you
 * are" since the route codec was written, and nothing ever joined them:
 *
 *   - `MenuTarget` (`shell/MenuRail.tsx`) — what the rail emits and what
 *     `GateApp`'s render switch consumes. This is the vocabulary that decides
 *     what is on screen.
 *   - `NavView` (`routes/types.ts`) — what the URL encodes, one member per
 *     WLT §2.2 route line. This is the vocabulary that decides what the address
 *     bar says.
 *
 * They do not align, and the mismatches are not cosmetic:
 *
 *   - `dashboard` (rail) is `home` (route). A name difference only.
 *   - The rail's `{type:'entity'}` means A CHANNEL — `GateApp` renders
 *     `ChannelView` for it. The route's `{view:'entity'}` means an entity
 *     DETAIL panel. Mapping one onto the other by its tag is wrong in both
 *     directions, and that is exactly the misroute class this codebase has
 *     already been bitten by twice (the voice-room misroute, and channels
 *     falling through to the workspace).
 *   - `graph`, `files`, `git` and `messages` are `MenuViewRef` members with no
 *     route line at all.
 *   - The entity a kind screen has open lives in `screenStackStore`, which has
 *     no `MenuTarget` representation whatsoever. A route that names an entity
 *     therefore sets TWO pieces of state, only one of which is a target — see
 *     `Landing`.
 *
 * WHY IT LIVES IN `domain/`. It has to say `'channel'` out loud to map the
 * channels route onto the channel-kind screen, and `panels/no-branching.test.ts`
 * bans quoted kind literals everywhere except `domain/` and `fixtures/`. That
 * ban is the reason this is a domain concern rather than a routing one, and it
 * is the right home anyway: WLT §2.1 says ONE registry drives routes, `origin`
 * validation, palette generation and the menu config. Slugs are resolved
 * through `kindOfSlug`/`slugOfKind` here rather than written down twice.
 *
 * PURE AND TOTAL. No store reads, no React. Every function is total over its
 * input union, and `nav-targets.test.ts` asserts exhaustiveness in BOTH
 * directions — a new `MenuViewRef` or a new `NavView` member fails a test
 * rather than silently falling through to the workspace.
 */
import type { EntityId, MenuViewRef } from '@tm8/contract';
import type { NavView } from '../routes/types';
/* Type-only, and deliberately so: `shell/` already imports `domain/`, so a
   value import here would close a cycle. `import type` is erased entirely. */
import type { MenuTarget } from '../shell';
import { kindOfSlug, slugOfKind } from './registry';

/**
 * The kind whose collection screen IS the Channels destination.
 *
 * NOT a second channels screen. `#/s/{space}/channels` and the rail's Channels
 * row both land on the `channel`-kind `EntityView` — the tree of channels with
 * the channel view beside it (`GateApp`'s own comment: "CHANNELS is a contract
 * VIEW ref but IS the channel EntityView"). `registry.ts` moved `channel` to
 * `strategy: 'collection'` on 2026-08-01 and WLT §2.1 has not caught up; the
 * code is the truth and the spec amendment follows it.
 */
/* EXPORTED for the shells' entity-arm guards. Both `GateApp` and `MobileShell`
   must tell a channel from a voice room BY KIND — the discrimination rule
   stated above — and a bare `'channel'` literal in each of them is two places
   for that rule to be spelled and one place for it to be spelled wrong. */
export const CHANNEL_KIND = 'channel';

/**
 * The kind of a VOICE ROOM, which the rail also emits as an `entity` target.
 *
 * THE BUG THIS CONSTANT FIXES. `routeViewOf` used to return `null` for every
 * `entity` target whose kind was not `channel`, on the assumption that channels
 * were the only ones the rail produced. They are not — a dynamic rail group
 * lists the space's live voice channels. So deriving the shell's active target
 * from `navStore` (which needs every reachable target to HAVE a route) would
 * have silently dropped the voice rooms entirely.
 *
 * `registry.ts:923` has emitted `#/s/{spaceId}/voice/{id}` all along; the codec
 * simply could not parse it. The route existed in the registry and nowhere
 * else, which is why nothing caught it until the two vocabularies were joined.
 *
 * The discrimination rule that matters: an `entity` MenuTarget means a channel
 * OR a voice room, told apart BY KIND and never by its tag. `GateApp`'s
 * voice-misroute guard depends on exactly that — its comment records the day a
 * bare `type === 'entity'` test rendered a message feed for a room that has
 * none, and "the feed would have looked empty rather than wrong."
 */
const VOICE_KIND = 'voice_channel';

/**
 * `MenuViewRef` → the `NavView` tag that addresses it.
 *
 * Total over the closed `MenuViewRef` enum by construction: `Record<MenuViewRef, …>`
 * makes a missing row a type error, which is the whole point of writing it as a
 * table instead of a switch.
 *
 * `channels` is deliberately absent from the value side — it is not a view of
 * its own but an alias for the channel collection, resolved in `landingOfRoute`
 * and `routeViewOf` so that both directions agree. Everything else is either a
 * one-to-one route line or one of the four refs that had no route until the
 * §2.1/§2.2 amendment.
 */
export const VIEW_REF_ROUTE = {
  dashboard: 'home',
  feed: 'feed',
  inbox: 'inbox',
  workspace: 'workspace',
  settings: 'settings',
  /* Added by the 2026-08-14 amendment. These four rendered from the rail with
     no route line, so their screens could not be reloaded, shared, or reached
     by the back button. The contract's `MenuViewRef` already carried all four;
     it was WLT §2.3's "CLOSED v1 union" of six that was stale. */
  graph: 'graph',
  files: 'files',
  git: 'git',
  messages: 'messages',
  /* The task Board tab (2026-08-16) — same flat-segment posture. */
  board: 'board',
  /* The Craft studio (2026-08-16) — same flat-segment posture. */
  craft: 'craft',
  /* CodeBrain (2026-09-01) — same flat-segment posture. */
  codebrain: 'codebrain',
  /* The Help shelf (2026-08-19) — same flat-segment posture. Help has a route
     of its own even though it is not in the default spine: its door is a bar
     control, and a reference screen with no address could not be linked to. */
  help: 'help',
  /* Alias, not a view — see CHANNEL_KIND. Present so the record stays total
     over MenuViewRef; `routeViewOf` never emits it. */
  channels: 'channels',
} as const satisfies Record<MenuViewRef, string>;

/** Reverse of `VIEW_REF_ROUTE`, minus the `channels` alias. */
const ROUTE_VIEW_REF: Partial<Record<string, MenuViewRef>> = Object.fromEntries(
  (Object.entries(VIEW_REF_ROUTE) as [MenuViewRef, string][])
    .filter(([ref]) => ref !== 'channels')
    .map(([ref, view]) => [view, ref]),
);

/**
 * A ROUTE-VIEW NAME → the `NavView` that addresses it, or `null` for a name
 * that addresses nothing.
 *
 * WHY THIS EXISTS, AND WHY IT IS NOT `{ type: 'view', ref }`. Some callers hold
 * a route view as a STRING rather than as a value — the keyboard contract's
 * `nav.view` bindings are the live case, and their refs look deceptively like
 * rail refs while speaking the route vocabulary:
 *
 *   - `g h` carries `ref: 'home'`. The `MenuViewRef` for that screen is
 *     `dashboard`. Hand-assembling `{type:'view', ref:'home'}` produces a ref
 *     that is not a `MenuViewRef` at all, and after Phase 0.5 that draws the
 *     loud unrouted card — the chord would report an error instead of going
 *     Home.
 *   - `g c` carries `ref: 'channels'`, which is the ALIAS. It has to resolve
 *     through `landingOfRoute` to the channel-kind screen; as a view target it
 *     lands on the unbuilt-view card.
 *
 * So a string-holding caller comes in through the ROUTE vocabulary and lets
 * this file do the translation, which is the whole reason it exists. `nav.kind`
 * refs are SLUGS (`tasks`, not `task`) and need no helper — they are already a
 * `{view:'kind', slug}` away, and `landingOfRoute` refuses an unknown slug.
 */
export function navViewOfName(name: string): NavView | null {
  switch (name) {
    case 'home':
    case 'feed':
    case 'inbox':
    case 'workspace':
    case 'graph':
    case 'files':
    case 'git':
    case 'messages':
    case 'board':
    case 'channels':
      return { view: name };
    case 'settings':
      /* No section: a chord names the screen, not a section within it. */
      return { view: 'settings', section: null };
    default:
      return null;
  }
}

/**
 * What a route asks the shell to do.
 *
 * TWO fields because a route can name two things at once, and this is the shape
 * the requirement is actually about: `#/s/{s}/e/{id}?origin=tasks` means "the
 * Tasks screen, with THAT entity open". The target is the screen; `openEntity`
 * is what `screenStackStore` gets seeded with. Collapsing them into one value
 * is what made `MenuTarget` unable to express a shared entity link.
 */
export interface Landing {
  /**
   * The screen to show, or `null` for a REACHABLE screen that has no
   * `MenuTarget` representation.
   *
   * THE TWO NULLS ARE DIFFERENT AND THE DISTINCTION IS THE POINT.
   * `landingOfRoute` returning `null` means the ROUTE IS UNRESOLVABLE — a slug
   * naming no kind, a bare `e/{id}` with no origin — which the shell surfaces
   * as a refusal. `target: null` means the route resolved perfectly well to a
   * real screen that simply is not a rail destination, so there is nothing for
   * the rail to highlight. Collapsing the two would either turn a working
   * screen into an error card or make a broken link look like a screen.
   */
  target: MenuTarget | null;
  /** Entity to seed onto that screen's stack, or `null` for a bare screen. */
  openEntity: EntityId | null;
}

/**
 * Route → shell. Total over `NavView`.
 *
 * Returns `null` ONLY for a route whose slug names no registered kind — an
 * unresolvable link, which the caller must surface as a refusal rather than
 * quietly substituting a default. Silently landing somewhere else is the
 * failure this whole lane exists to remove.
 */
export function landingOfRoute(view: NavView): Landing | null {
  switch (view.view) {
    case 'home':
    case 'feed':
    case 'inbox':
    case 'workspace':
      return { target: { type: 'view', ref: refOfRouteView(view.view) }, openEntity: null };

    case 'settings':
      /* §2.2 carries `section` (`projects` | `menu`); `MenuTarget` has no slot
         for it. The section is read from the route directly by the settings
         shell rather than smuggled through the target — noting it here because
         the asymmetry is real and easy to mistake for a bug. */
      return { target: { type: 'view', ref: 'settings' }, openEntity: null };

    case 'graph':
    case 'files':
    case 'git':
    case 'messages':
    case 'board':
    case 'craft':
    case 'codebrain':
    case 'help':
      return { target: { type: 'view', ref: refOfRouteView(view.view) }, openEntity: null };

    case 'newSession':
      /*
       * A REAL SCREEN WITH NO RAIL SEAT. New Session is reached from a quick
       * action and from the sessions empty state, not from the menu, so it is
       * deliberately not a `MenuViewRef` — that would cost a menu revision and
       * a migration to buy a rail entry nobody asked for.
       *
       * `target: null` rather than `null`: the route resolved, the screen
       * exists, and it simply hosts no stack and lights up no rail item. See
       * `Landing.target`.
       */
      return { target: null, openEntity: null };

    case 'boardV2':
      /* Board v2 — route-only for the same no-migration reason as newSession.
         `target: null`: no menu group owns it; the shell appends its tab
         client-side and highlights it off the route directly. */
      return { target: null, openEntity: null };

    case 'channels':
      /* The alias resolving to the real screen. */
      return { target: { type: 'kind', ref: CHANNEL_KIND }, openEntity: null };

    case 'kind': {
      const kind = kindOfSlug(view.slug);
      if (!kind) return null;
      return {
        target: {
          type: 'kind',
          ref: kind,
          ...(view.mode ? { mode: view.mode } : {}),
          /* W3: the board's grouping rides `q` — the codec already parsed and
             validated it (`q.ts`), this just stops dropping it on the floor. */
          ...(view.q?.groupBy ? { groupBy: view.q.groupBy } : {}),
        },
        openEntity: null,
      };
    }

    case 'channel':
      /* Carrying the kind explicitly is what stops `GateApp`'s
         `type === 'entity'` branch from rendering a message feed for something
         that has none. */
      return {
        target: { type: 'entity', ref: view.channelId, kind: CHANNEL_KIND },
        openEntity: null,
      };

    case 'voice':
      /* Same target SHAPE as a channel, different kind — and the kind is the
         whole discrimination. See VOICE_KIND. */
      return {
        target: { type: 'entity', ref: view.voiceChannelId, kind: VOICE_KIND },
        openEntity: null,
      };

    case 'entity': {
      /* THE SHARED-LINK CASE. The screen comes from `origin`; the entity is
         seeded onto that screen's stack. With no `origin` the caller applies the
         §2.2 canonical-reload rule against the registry strategy — it needs the
         entity's kind, which is a read, so it cannot be resolved here. */

      /* A VIEW COMPANION RESOLVES WITHOUT A REGISTRY LOOKUP, because the ref IS
         the screen. `messages`, `inbox` and `dashboard` are `MenuViewRef`s and
         have no kind slug, which is exactly why the collection form could not
         express them and why both halves of the route<->stack loop skipped a
         view screen carrying an open entity. Checked BEFORE `origin`, because
         the codec guarantees only one of the two is ever present. */
      if (view.originView) {
        return { target: { type: 'view', ref: view.originView }, openEntity: view.entityId };
      }
      if (!view.origin) return null;
      const kind = kindOfSlug(view.origin.slug);
      if (!kind) return null;
      return {
        target: {
          type: 'kind',
          ref: kind,
          ...(view.origin.mode ? { mode: view.origin.mode } : {}),
        },
        openEntity: view.entityId,
      };
    }
  }
}

/**
 * Shell → route. Total over `MenuTarget`.
 *
 * `openEntity` promotes a kind screen to the `e/{id}?origin=` form, which is
 * what makes an open entity shareable at all.
 *
 * Returns `null` for a target naming a kind with no slug — the `special` and
 * `anchored` strategies (`voice_channel`, `message`) have no `k/` view by
 * design (WLT §2.1), so there is genuinely no route to emit and the caller must
 * leave the URL alone rather than invent one.
 */
export function routeViewOf(target: MenuTarget, openEntity: EntityId | null = null): NavView | null {
  switch (target.type) {
    case 'view': {
      /* AN OPEN ENTITY PROMOTES A VIEW SCREEN TO THE `e/{id}` FORM, exactly as
         it does for a kind screen below — which is what makes an entity opened
         on a view screen shareable at all. `channels` is excluded because it is
         an ALIAS that normalizes to the channel collection; promoting it would
         emit an address whose companion contradicts the screen it resolves to. */
      if (openEntity && target.ref !== 'channels') {
        return { view: 'entity', entityId: openEntity, origin: null, originView: target.ref };
      }
      if (target.ref === 'channels') {
        /* Normalized to the collection it actually is, so the URL a viewer sees
           and the URL they share are the same string. */
        const slug = slugOfKind(CHANNEL_KIND);
        return slug ? { view: 'kind', slug, mode: null, q: null } : null;
      }
      const view = VIEW_REF_ROUTE[target.ref];
      switch (view) {
        case 'home':
        case 'feed':
        case 'inbox':
        case 'workspace':
        case 'graph':
        case 'files':
        case 'git':
        case 'messages':
        case 'board':
        case 'craft':
        case 'codebrain':
          return { view };
        case 'help':
          /* The rail seat opens the LIBRARY, never a particular plate — same
             posture as `settings`, whose section this function also leaves
             null. Which plate is open is read from the route by the Help shell
             itself; a menu click is "go to Help", not "go to plate 07". */
          return { view: 'help', plate: null };
        case 'settings':
          return { view: 'settings', section: null };
        default:
          return null;
      }
    }

    case 'kind': {
      const slug = slugOfKind(target.ref);
      if (!slug) return null;
      const mode = target.mode ?? null;
      if (openEntity) {
        return { view: 'entity', entityId: openEntity, origin: { slug, mode } };
      }
      /* W3: a grouped board is shareable — the choice travels as `q.groupBy`,
         the union `q.ts` already validates on the way back in. */
      return { view: 'kind', slug, mode, q: target.groupBy ? { v: 1, groupBy: target.groupBy } : null };
    }

    case 'entity':
      /* An `entity` target is a channel OR a voice room, discriminated BY KIND.
         This used to return null for anything that was not a channel, which
         would have deleted the voice rooms the moment the shell derived its
         target from the store — see VOICE_KIND. Any OTHER kind arriving here is
         still a genuine misroute at the source and still refuses, because
         inventing a route for it would put an entity on a screen built for
         something else. */
      if (target.kind === CHANNEL_KIND) {
        return { view: 'channel', channelId: target.ref as EntityId, msg: null };
      }
      if (target.kind === VOICE_KIND) {
        return { view: 'voice', voiceChannelId: target.ref as EntityId };
      }
      return null;
  }
}

/** `MenuViewRef` for a simple route tag. Internal; the table is the authority. */
function refOfRouteView(view: string): MenuViewRef {
  const ref = ROUTE_VIEW_REF[view];
  /* Unreachable while the table and `NavView` agree, which is what the
     exhaustiveness test enforces. Throwing beats returning a default: a wrong
     screen that renders is the bug class this file exists to prevent. */
  if (!ref) throw new Error(`nav-targets: no MenuViewRef for route view '${view}'`);
  return ref;
}
