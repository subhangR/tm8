/**
 * THE VIEW COMPANION — an entity opened on a VIEW screen, carried in the address.
 *
 * `origin` names a KIND's collection and is registry-validated against a slug.
 * `messages`, `inbox` and `dashboard` are `MenuViewRef`s with no kind slug, so a
 * view screen had nowhere to put an open entity and BOTH halves of the
 * route<->stack loop skipped it: `landingOfRoute` produced no `openEntity` for
 * one, and `routeViewOf` could not promote one to the `e/{id}` form.
 *
 * These are the assertions the build service cannot make for me. The instrument
 * photographs a resting screen; a round trip through the codec is a different
 * question and it is answerable here, now, without a capture. It is a positive
 * witness for the wiring and it is NOT a substitute for the pixel verification
 * this change still owes — see the PR body, which says UNVERIFIED and means it.
 */
import { describe, expect, it } from 'vitest';
import { build, parse } from './codec';
import { landingOfRoute, routeViewOf } from '../domain/nav-targets';
import { emptyPanels } from './types';
import type { NavView } from './types';

const SPACE = 'sp-atelier';
const ENTITY = 'task-4f8c2a9e';

/** The hash a route builds to, for round-trip assertions. `Route.target` holds
    the NavView — the field is `target`, not `view`. */
function hashOf(target: NavView): string {
  return build({ spaceId: SPACE as never, target, panels: emptyPanels() }).hash;
}

describe('a view target carries an open entity in its address', () => {
  it('routeViewOf promotes a view screen with an open entity to the e/{id} form', () => {
    // The kind case has always done this — it is what makes an open entity
    // shareable at all. The view case could not, which is the whole gap.
    const route = routeViewOf({ type: 'view', ref: 'messages' }, ENTITY as never);
    expect(route).toMatchObject({ view: 'entity', entityId: ENTITY, originView: 'messages' });
    // And it does NOT invent a collection origin, which would name a screen the
    // ref does not resolve to.
    expect((route as { origin?: unknown }).origin).toBeNull();
  });

  it('landingOfRoute resolves it back to the view screen with the entity seeded', () => {
    const landing = landingOfRoute({ view: 'entity', entityId: ENTITY as never, origin: null, originView: 'messages' });
    expect(landing).toEqual({ target: { type: 'view', ref: 'messages' }, openEntity: ENTITY });
  });

  it('round-trips through the codec as a single origin parameter', () => {
    // ONE `origin=` carries ONE companion, so an address can never name two and
    // the mutual exclusion is structural rather than checked.
    const hash = hashOf({ view: 'entity', entityId: ENTITY as never, origin: null, originView: 'messages' });
    expect(hash).toContain('origin=v-messages');
    const back = parse(hash).route?.target;
    expect(back).toMatchObject({ view: 'entity', entityId: ENTITY, originView: 'messages' });
  });

  it('a collection origin is untouched by the addition', () => {
    // The regression that would matter most: `v-` must not shadow the existing
    // form, and the existing form must not claim a `v-` value.
    const landing = landingOfRoute({
      view: 'entity',
      entityId: ENTITY as never,
      origin: { slug: 'tasks', mode: null },
    });
    expect(landing).toMatchObject({ target: { type: 'kind', ref: 'task' }, openEntity: ENTITY });
  });

  it('an unknown view ref is DROPPED rather than carried', () => {
    // Same honesty `parseOrigin` applies to an unknown slug: a companion we
    // cannot render is worse than no companion, because it names a screen the
    // build does not have and the reader cannot tell.
    const back = parse(`#/s/${SPACE}/e/${ENTITY}?origin=v-notaview`).route?.target as
      | { originView?: unknown; origin?: unknown }
      | undefined;
    expect(back?.originView ?? null).toBeNull();
    expect(back?.origin ?? null).toBeNull();
  });

  it('channels is NOT promoted — it is an alias, and promoting it would lie', () => {
    // `channels` normalizes to the channel collection, so an address carrying it
    // as a view companion would resolve to a screen its companion contradicts.
    const route = routeViewOf({ type: 'view', ref: 'channels' }, ENTITY as never);
    expect((route as { originView?: unknown } | null)?.originView ?? null).toBeNull();
  });
});
