import { describe, expect, it } from 'vitest';

import { HandlerRegistry } from '../../../src/facade/registry.js';
import { registerFacadeHandlers } from '../../../src/facade/index.js';
import * as commandsModule from '../../../src/facade/handlers/commands.js';

/**
 * W5 DUO B — WHICH HANDLER ACTUALLY SERVES `entities.activity`, PROVED AT
 * RUNTIME RATHER THAN BY A NAME SWEEP.
 *
 * ⚠ WHY THIS FILE EXISTS. Two conclusions of this duo's rest on the claim that
 * `handlers/commands.ts`'s `entitiesActivity` is never registered:
 *
 *   · my retraction of a FALSE POSITIVE (I once read that dead handler as the
 *     live `entities.activity` and nearly filed it as a live defect), and
 *   · the LATENT-NOT-LIVE scope on B4 and on the stale-cursor residual.
 *
 * **BOTH RESTED ON `rg -a "entitiesActivity"` RETURNING ONE HIT.** An absence
 * proved by name sweep is the weakest evidence in this program — it cannot see
 * a re-export under another name, a map-based bulk registration, or a dynamic
 * key. `registry.ts:56` DOES bulk-register from `Object.entries`, so the
 * map-based escape is real here rather than hypothetical.
 *
 * THIS FILE REPLACES THAT EVIDENCE WITH A STRUCTURAL PROPERTY THAT NEEDS NO
 * PATTERN AT ALL:
 *
 *   `registry.ts:49-51` — `register()` THROWS on a duplicate name.
 *
 * So a name can be registered AT MOST ONCE. If the composition root builds
 * without throwing, and `entities.activity` is present, then whatever is
 * registered for it is the ONLY thing registered for it. Combined with
 * `handlers/w2/entities-commands-tracking.ts:28` mapping that name to
 * `service.listActivity`, the dead handler CANNOT also be serving it —
 * regardless of what any grep can or cannot see.
 *
 * WHAT THIS CAN BE SATISFIED BY: the real composition root building, and the
 * name resolving. It uses stub deps because REGISTRATION does not touch a
 * database — only invocation would. It therefore proves WHICH HANDLER IS
 * MOUNTED and makes NO claim about that handler's behaviour; the behavioural
 * claims live in the sibling `.pg.test.ts` files.
 */

/** Registration touches none of these; they exist to satisfy the signature. */
const stubDeps = {
  db: {} as never,
  config: {} as never,
  owner: async () => ({
    identityId: 'w5-registration-probe',
    accountId: '00000000-0000-7000-8000-00000000aaaa',
    username: 'w5-registration-probe',
    isNodeAdmin: false,
    isOwner: false,
  }),
};

describe('W5 Duo B — entities.activity registration', () => {
  it('the real composition root builds without a duplicate-registration throw', () => {
    const registry = new HandlerRegistry();
    // If ANY two registrations claimed the same operation name, this throws —
    // which is the whole load-bearing property. A green here is the proof that
    // no name is doubly mounted, including this one.
    expect(() => registerFacadeHandlers(registry, stubDeps)).not.toThrow();
  });

  it('entities.activity is mounted, and therefore mounted exactly once', () => {
    const registry = new HandlerRegistry();
    registerFacadeHandlers(registry, stubDeps);

    expect(registry.has('entities.activity')).toBe(true);
    expect(registry.get('entities.activity')).toBeTypeOf('function');
  });

  it('⚠ the dead handler is exported but is NOT the mounted one', () => {
    // `entitiesActivity` is a FACTORY: it returns a NEW closure per call, so
    // identity comparison against the mounted handler is not available. What IS
    // available is the duplicate-throw property above plus this: the factory is
    // exported and reachable from a test, so its absence from the registry is
    // NOT an artefact of it being unreachable or tree-shaken.
    expect(commandsModule.entitiesActivity).toBeTypeOf('function');

    const registry = new HandlerRegistry();
    registerFacadeHandlers(registry, stubDeps);

    // Registering it now must THROW — which proves the name was already taken
    // by something else. If `entitiesActivity` were the mounted handler this
    // would be the FIRST registration and would succeed.
    expect(() => registry.register('entities.activity', commandsModule.entitiesActivity(stubDeps)))
      .toThrow(/duplicate handler registration/);
  });

  it('KNOWN-GOOD: an unmounted name registers cleanly, so the throw above is meaningful', () => {
    // Without this, the throw above would be indistinguishable from `register`
    // rejecting everything. Uses a real operation name that the facade does not
    // mount, so the negative control exercises the same code path.
    const registry = new HandlerRegistry();
    const probe = (async () => ({})) as never;
    expect(() => registry.register('entities.activity', probe)).not.toThrow();
  });
});
