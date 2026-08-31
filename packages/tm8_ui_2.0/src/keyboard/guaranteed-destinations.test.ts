/**
 * EVERY NAVIGATION CHORD MUST NAME A REAL DESTINATION.
 *
 * `contract.ts` declares ten `g` chords `guaranteed: true` — `g h`, `g t`,
 * `g s`, `g d`, `g m`, `g p`, `g c`, `g i`, `g r`, `g ,` — and `guaranteed` is a
 * PROMISE: the binding is advertised on every platform because nothing can take
 * the key away. None of the original nine had ever worked, because `GateApp`
 * dropped the `ref` argument on the way out of the controller, so no reader had
 * any reason to look at these strings. A table nothing validates drifts
 * silently, and this one drifted in two directions at once:
 *
 *   - `nav.view` refs are ROUTE view names (`home`), not `MenuViewRef`s
 *     (`dashboard`).
 *   - `nav.kind` refs are SLUGS (`tasks`), not kinds (`task`).
 *
 * Both mismatches are invisible by inspection — the strings LOOK like rail refs
 * — and both produce a wrong screen rather than an error. So the contract is
 * pinned to the resolver the shell actually dispatches through: if a ref stops
 * resolving, or a chord is added with a plausible-looking ref in the wrong
 * vocabulary, this fails instead of the chord quietly landing somewhere else.
 *
 * The same shape and the same reason as the exhaustiveness assertions in
 * `domain/nav-targets.test.ts`.
 *
 * `g r` (CodeBrain, SPEC §5.4) added a THIRD failure mode this file must now
 * tell apart from the first two: a chord to a route-only screen (`target:
 * null` — a real screen with no rail seat, same as New Session and Board v2).
 * `destinationOf` below mirrors `GateApp`'s post-two-nulls-split dispatch
 * exactly, returning a discriminated result, so a chord that resolves
 * route-only is distinguished from one that does not resolve at all — the
 * collapse `GateApp.tsx` used to make, and the reason `g r` logged an error
 * and did nothing before the split.
 */
import { describe, expect, it } from 'vitest';
import { BINDINGS } from './contract';
import { landingOfRoute, navViewOfName } from '../domain/nav-targets';
import type { MenuTarget } from '../shell';

type Destination =
  | { kind: 'unresolvable' }
  | { kind: 'route-only' }
  | { kind: 'target'; target: MenuTarget };

/** The shell's dispatch, exactly — see `GateApp`'s `navigateToRouteView`. */
function destinationOf(command: string, ref: string): Destination {
  if (command === 'nav.view') {
    const view = navViewOfName(ref);
    if (!view) return { kind: 'unresolvable' };
    const landing = landingOfRoute(view);
    if (!landing) return { kind: 'unresolvable' };
    return landing.target ? { kind: 'target', target: landing.target } : { kind: 'route-only' };
  }
  if (command === 'nav.kind') {
    const landing = landingOfRoute({ view: 'kind', slug: ref, mode: null, q: null });
    if (!landing) return { kind: 'unresolvable' };
    return landing.target ? { kind: 'target', target: landing.target } : { kind: 'route-only' };
  }
  return { kind: 'unresolvable' };
}

const NAV_BINDINGS = BINDINGS.filter(
  (binding) => binding.command === 'nav.view' || binding.command === 'nav.kind',
);

describe('the guaranteed navigation chords resolve to real screens', () => {
  it('has navigation chords at all', () => {
    /* Vacuity guard: a filter that matched nothing would make every assertion
       below pass while proving nothing about the ten chords. */
    expect(NAV_BINDINGS.length).toBe(10);
  });

  it.each(NAV_BINDINGS.map((b) => [b.id, b.command, b.ref ?? ''] as const))(
    '%s (%s) resolves',
    (id, command, ref) => {
      expect(ref, `${id} declares a navigation command with no ref`).not.toBe('');
      expect(
        destinationOf(command, ref).kind,
        `${id} → ${command} '${ref}'`,
      ).not.toBe('unresolvable');
    },
  );

  it('g.codebrain resolves route-only — a real screen with no rail seat', () => {
    /* The specific case the two-nulls split exists for: before it, this
       chord's landing had `target: null`, which the OLD collapsed dispatch
       read as unresolvable — logging an error and doing nothing instead of
       navigating. */
    expect(destinationOf('nav.view', 'codebrain')).toEqual({ kind: 'route-only' });
  });

  it('every navigation chord is one of the ten guaranteed ones', () => {
    /* If a navigation chord is ever added WITHOUT `guaranteed`, the promise
       above stops describing the set this file checks, and the mismatch should
       be a decision rather than a discovery. */
    for (const binding of NAV_BINDINGS) {
      expect(binding.guaranteed, `${binding.id} is a nav chord but not guaranteed`).toBe(true);
    }
  });

  it('refuses a ref in the WRONG vocabulary, which is the failure mode', () => {
    /* The two mistakes this file exists to catch, asserted as refusals so the
       resolver's honesty is pinned and not merely assumed. */
    expect(destinationOf('nav.view', 'dashboard')).toEqual({ kind: 'unresolvable' });
    expect(destinationOf('nav.kind', 'task')).toEqual({ kind: 'unresolvable' });
  });
});
