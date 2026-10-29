/**
 * The COMPLETE legacy-redirect table (LLD §6, SPEC-FINAL §4.2.5).
 *
 * Every row of the spec table is a case here, including the rows the spec
 * marks "unchanged" — an accidental redirect of a canonical route is exactly
 * as broken as a missing one.
 */
import { describe, expect, it } from 'vitest';
import { redirect } from './redirects';
import { parse } from './codec';

const S = 'space-1';
const ID = 'entity-9';

describe('the redirect table', () => {
  const rows: [legacy: string, next: string][] = [
    [`#/s/${S}/tasks`, `#/s/${S}/k/tasks`],
    [`#/s/${S}/sessions`, `#/s/${S}/k/sessions`],
    [`#/s/${S}/sessions/${ID}`, `#/s/${S}/e/${ID}?origin=sessions`],
    [`#/s/${S}/docs`, `#/s/${S}/k/docs`],
    [`#/s/${S}/team`, `#/s/${S}/k/teammates`],
    [`#/s/${S}/tracking`, `#/s/${S}/k/pulls`],
  ];

  it.each(rows)('%s → %s', (legacy, next) => {
    expect(redirect(legacy)?.hash).toBe(next);
  });

  it('preserves the space and the query string across a redirect', () => {
    expect(redirect(`#/s/${S}/tasks?mode=board&p=${ID}`)?.hash).toBe(
      `#/s/${S}/k/tasks?mode=board&p=${ID}`,
    );
    expect(redirect(`#/s/${S}/sessions/${ID}?p=${ID}`)?.hash).toBe(
      `#/s/${S}/e/${ID}?p=${ID}&origin=sessions`,
    );
  });

  it('sends deferred features to home AND reports the deferral (R7)', () => {
    for (const [legacy, feature] of [[`#/s/${S}/leaderboard`, 'leaderboard']] as const) {
      const outcome = redirect(legacy);
      expect(outcome?.hash).toBe(`#/s/${S}/home`);
      // Never a silent swallow: the notice is what makes the deferral honest.
      expect(outcome?.deferredFeature).toBe(feature);
    }
  });

  it('no longer defers graph — its screen shipped, so the route stands', () => {
    // The mirror of the test above, and the reason it lost a row. `graph` was
    // deferred when this table was written; `GraphScreen` has since been built
    // and mounted, and the palette offers it as a live destination. Redirecting
    // to Home with "Graph view isn't available yet" was the app lying about a
    // screen one rail click away. A deferral notice must not outlive the
    // deferral, so `graph` is a route now and NOT a redirect.
    expect(redirect(`#/s/${S}/graph`)).toBeNull();
    expect(parse(`#/s/${S}/graph`).route?.target).toEqual({ view: 'graph' });
  });

  it('leaves canonical routes alone', () => {
    for (const canonical of [
      `#/s/${S}/home`,
      `#/s/${S}/feed`,
      `#/s/${S}/inbox`,
      `#/s/${S}/settings`,
      `#/s/${S}/settings/projects`,
      `#/s/${S}/workspace`,
      `#/s/${S}/channels`,
      `#/s/${S}/channel/${ID}`,
      `#/s/${S}/e/${ID}`,
      `#/s/${S}/k/tasks`,
    ]) {
      expect(redirect(canonical)).toBeNull();
    }
  });

  it('distinguishes bare `sessions` from the id-bearing form', () => {
    expect(redirect(`#/s/${S}/sessions`)?.hash).toBe(`#/s/${S}/k/sessions`);
    expect(redirect(`#/s/${S}/sessions/${ID}`)?.hash).toBe(`#/s/${S}/e/${ID}?origin=sessions`);
  });
});

describe('bare legacy forms', () => {
  it('resolve against the last-active space', () => {
    expect(redirect('#/tasks', { lastActiveSpaceId: S })?.hash).toBe(`#/s/${S}/k/tasks`);
    expect(redirect('#/home', { lastActiveSpaceId: S })?.hash).toBe(`#/s/${S}/home`);
  });

  it('resolve to nothing without one — the caller shows the space picker', () => {
    expect(redirect('#/tasks')).toBeNull();
    expect(redirect('#/graph')).toBeNull();
    expect(redirect('#/')).toBeNull();
  });
});

describe('redirect output is always parseable', () => {
  it('every redirected hash parses into a route with the space preserved', () => {
    for (const legacy of [
      `#/s/${S}/tasks`,
      `#/s/${S}/sessions`,
      `#/s/${S}/sessions/${ID}`,
      `#/s/${S}/docs`,
      `#/s/${S}/team`,
      `#/s/${S}/tracking`,
      `#/s/${S}/leaderboard`,
    ]) {
      const outcome = redirect(legacy);
      const { route, dropped } = parse(outcome!.hash);
      expect(route?.spaceId).toBe(S);
      expect(dropped).toEqual([]);
    }
  });

  it('lands sessions/{id} on the entity route with a REGISTRY-VALID origin', () => {
    const { route } = parse(redirect(`#/s/${S}/sessions/${ID}`)!.hash);
    expect(route?.target).toEqual({
      view: 'entity',
      entityId: ID,
      origin: { slug: 'sessions', mode: null },
    });
  });
});
