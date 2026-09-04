/**
 * THE BACK CONTRACT, proved without a DOM.
 *
 * `backContract.ts` is split the way `shell-for.ts`/`useShellKind.ts` is split,
 * and for the same reason: the part that must be provably right is a pure
 * function of a `NavView`, so it is proved here over every route shape, and the
 * live wiring is proved once in `views/mobile-back.test.tsx` where a DOM and a
 * history stack are unavoidable. A rule that needs a browser to state is a rule
 * nobody can check.
 *
 * The contract itself is `docs/features/mobile/BACK-CONTRACT.md`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { EntityId } from '@tm8/contract';
import { applyScreenStackIntent, intentOfRoute, reconcileScreenStacks } from './backContract';
import { screenKeyOf, screenStackStore, stackOf } from './screenStackStore';
import type { NavView } from '../routes/types';

const A = 'task-4f8c2a9e' as EntityId;
const B = 'task-blocked' as EntityId;
const TASKS = screenKeyOf.kind('task');

/** `#/s/{s}/k/tasks` — a bare kind screen. */
const kindRoute: NavView = { view: 'kind', slug: 'tasks', mode: null, q: null };
/** `#/s/{s}/e/{id}?origin=tasks` — the shared-entity link. */
const entityRoute = (id: EntityId): NavView => ({
  view: 'entity',
  entityId: id,
  origin: { slug: 'tasks', mode: null },
});

const stack = () => stackOf(screenStackStore.getState(), TASKS);

beforeEach(() => {
  screenStackStore.getState().clearAll();
});

describe('intentOfRoute — what ONE address says about ONE screen’s stack', () => {
  it('an entity route says that screen shows that entity', () => {
    expect(intentOfRoute(entityRoute(A))).toEqual({ kind: 'open', key: TASKS, entity: A });
  });

  it('a BARE kind route says that screen is at its ROOT — the half that was missing', () => {
    /* THE WHOLE DEFECT, in one assertion. `GateApp`'s seed effect had no branch
       for an address naming no entity, so back from `e/A` to `k/tasks` left the
       stack holding `[A]` and the screen→URL sync pushed `e/A` straight back.
       `clear` is what makes "back at a screen root stays at the root" true. */
    expect(intentOfRoute(kindRoute)).toEqual({ kind: 'clear', key: TASKS });
  });

  it('a route that hosts no stack touches no stack', () => {
    for (const view of [
      { view: 'home' },
      { view: 'workspace' },
      { view: 'inbox' },
      { view: 'feed' },
      { view: 'graph' },
      { view: 'settings', section: null },
      { view: 'channel', channelId: 'ch-1' as EntityId, msg: null },
      { view: 'voice', voiceChannelId: 'vc-1' as EntityId },
    ] as NavView[]) {
      expect(intentOfRoute(view), `${view.view} must not touch a screen stack`).toEqual({
        kind: 'none',
      });
    }
  });

  it('the CHANNELS ALIAS resolves to the channel-kind screen, not to the tasks screen', () => {
    /* `landingOfRoute` turns `channels` into the channel COLLECTION, so the
       intent has to be keyed to that screen. Reading the alias as a view would
       silently key it wrong, and a mis-keyed clear wipes a stack the viewer is
       not even looking at. */
    expect(intentOfRoute({ view: 'channels' })).toEqual({
      kind: 'clear',
      key: screenKeyOf.kind('channel'),
    });
  });

  it('an UNRESOLVABLE route is `none`, NOT `clear` — a refusal must not also destroy state', () => {
    /* Both shapes `landingOfRoute` refuses: a slug naming no registered kind,
       and a bare `e/{id}` with no `origin`. The shell surfaces these as a
       refusal card; wiping the viewer's stack on the way to an error would turn
       one bad link into lost context. */
    expect(intentOfRoute({ view: 'kind', slug: 'not-a-kind', mode: null, q: null })).toEqual({
      kind: 'none',
    });
    expect(intentOfRoute({ view: 'entity', entityId: A, origin: null })).toEqual({ kind: 'none' });
  });

  it('is keyed to the ACTIVE screen and no other', () => {
    /* The reason `screenStackStore` still gets to do its original job: an
       address is a statement about ONE screen. Landing on Channels says nothing
       about what Tasks has open, so the Tasks stack survives and coming back to
       it still restores what you were looking at. */
    screenStackStore.getState().open(TASKS, A);
    reconcileScreenStacks({ view: 'channels' });
    expect(stack()).toEqual([A]);
  });
});

describe('a history walk reconstructs the stack losslessly, in BOTH directions', () => {
  /**
   * The property the whole rule rests on. Drilling A→B writes three history
   * entries, and the stack depth at each one is recoverable from the address
   * alone — so walking back POPS and walking forward PUSHES, with no second
   * history model and nothing intercepting the back gesture.
   */
  const WALK: readonly { readonly at: NavView; readonly stack: readonly EntityId[] }[] = [
    { at: kindRoute, stack: [] },
    { at: entityRoute(A), stack: [A] },
    { at: entityRoute(B), stack: [A, B] },
  ];

  it('walking FORWARD through the entries rebuilds the drill-down', () => {
    for (const step of WALK) {
      reconcileScreenStacks(step.at);
      expect(stack()).toEqual(step.stack);
    }
  });

  it('walking BACK through the entries unwinds it, one rung per entry', () => {
    for (const step of WALK) reconcileScreenStacks(step.at);
    expect(stack()).toEqual([A, B]);

    for (const step of [...WALK].reverse()) {
      reconcileScreenStacks(step.at);
      expect(stack()).toEqual(step.stack);
    }
  });

  it('back TWICE from two deep lands at the screen root, not at the app', () => {
    /* Q3, stated as an assertion: closing the last item exits the SCREEN, and
       the screen root is a screen. Nothing here can express "leave the app" —
       that is the browser's business at history entry zero, and keeping it out
       of this module is the point. */
    for (const step of WALK) reconcileScreenStacks(step.at);
    reconcileScreenStacks(entityRoute(A));
    reconcileScreenStacks(kindRoute);
    expect(stack()).toEqual([]);
  });

  it('back AT the screen root is idempotent — it cannot go negative', () => {
    reconcileScreenStacks(kindRoute);
    reconcileScreenStacks(kindRoute);
    expect(stack()).toEqual([]);
    expect(screenStackStore.getState().stacks[TASKS]).toBeUndefined();
  });
});

describe('R15 composes because an address carries AT MOST ONE entity', () => {
  it('a cold arrival can never produce a stack deeper than 1', () => {
    /* The answer to "how does R15 compose with a per-screen stack several deep":
       it never meets one. A cold arrival is a stack that was never built, and the
       grammar has exactly one `e/{id}` slot, so depth 1 is not a case to handle
       — it is the only reachable state. R15's one-shot replace therefore applies
       to a depth-1 stack by construction, and nothing about a deep stack has to
       be reconciled with it. */
    reconcileScreenStacks(entityRoute(B));
    expect(stack()).toEqual([B]);
  });

  it('the step up from a cold arrival lands on the screen root and stays there', () => {
    reconcileScreenStacks(entityRoute(B));
    reconcileScreenStacks(kindRoute);
    expect(stack()).toEqual([]);
  });
});

describe('applying an intent is a no-op when the store already agrees', () => {
  it('re-applying the same intent changes no state identity', () => {
    /* What keeps this out of the settle loop: an inbound hash that changed
       nothing about the stack must notify no subscriber, or the store→URL sync
       would wake and the two would push history at each other. */
    reconcileScreenStacks(entityRoute(A));
    const before = screenStackStore.getState().stacks;
    reconcileScreenStacks(entityRoute(A));
    expect(screenStackStore.getState().stacks).toBe(before);
  });

  it('clearing an already-empty screen changes no state identity', () => {
    const before = screenStackStore.getState().stacks;
    applyScreenStackIntent({ kind: 'clear', key: TASKS });
    expect(screenStackStore.getState().stacks).toBe(before);
  });

  it('`none` is inert', () => {
    screenStackStore.getState().open(TASKS, A);
    const before = screenStackStore.getState().stacks;
    applyScreenStackIntent({ kind: 'none' });
    expect(screenStackStore.getState().stacks).toBe(before);
  });
});
