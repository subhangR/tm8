/**
 * ACCEPTANCE 5 (LLD §7): **the optimistic round-trip closes, for real, on
 * `clientMutationId`.**
 *
 * The optimistic pattern has exactly two exits and the LLD says both must be
 * deterministic: a command settles with a `CommandResult` **or** it rejects,
 * and separately any event echoing the same `clientMutationId` also reconciles
 * — "first wins", idempotent. Unit tests can prove the journal's bookkeeping;
 * only a real node can prove that the id the client minted survives the whole
 * round trip (HTTP body → SEC1 replay binding → capture trigger → durable log →
 * pump → socket → `connection.ts` dispatch) and comes back attached to the
 * echo. If it did not, every optimistic entry would sit pending until its
 * `CommandResult` happened to arrive, and the echo path — the one that covers a
 * command whose response was lost — would be dead code that reads as live.
 *
 * All three exits are exercised against the node, each with the OTHER two
 * ruled out:
 *   A. reconcile on `CommandResult`, then prove the later echo is a no-op;
 *   B. reconcile on the ECHO ALONE, with the CommandResult deliberately
 *      ignored — the path that is otherwise never taken in a healthy test;
 *   C. reject → `rollback` returns the captured pre-optimistic state.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CollabError, type EntitySummary } from '@tm8/contract';

import {
  assertHarnessWiring,
  createSeamHarness,
  createSpace,
  startIntegrationNode,
  waitFor,
  type IntegrationNode,
  type SeamHarness,
  type SpaceFixture,
} from './node-fixture';
import { createJournal } from '../project/journal';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 240_000 });

/**
 * The pre-optimistic cache state rollback must restore. Local shape only — no
 * server truth is claimed here.
 *
 * FULLY TYPED, WITH NO CAST, DELIBERATELY. An `as unknown as EntitySummary`
 * would compile over any object at all, which is exactly the blind spot that
 * put two remembered-shape errors into this lane in the first place (a
 * `WorkStatus` literal outside the union, and a `.summary` property
 * `EntityDetail` does not have — cross-lane flag [bridge->B4 8]). Removing the
 * cast is what turns these fields from recall into compiler-checked facts:
 * writing it out this way immediately surfaced that the earlier stub was
 * missing `ActorSummary.isAgent` and every required member of
 * `EntityCounters`, and had `state: {}` where `EntityState` is a discriminated
 * union. None of that was load-bearing for the journal — which keys on ids —
 * but "not load-bearing" is a conclusion, and the cast was hiding the evidence
 * needed to reach it.
 */
function stubSummary(id: string, spaceId: string, title: string): EntitySummary {
  return {
    id,
    spaceId,
    kind: 'task',
    title,
    parentId: null,
    position: 0,
    visibility: 'space',
    version: 1,
    activityAt: '2026-07-28T00:00:00.000Z',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
    deletedAt: null,
    createdBy: { id: 'actor_stub', kind: 'member', displayName: 'stub', isAgent: false },
    counters: { likes: 0, dislikes: 0, stars: 0, points: 0, messages: 0, viewerReaction: null },
    state: {
      kind: 'task',
      status: 'open',
      priority: 'medium',
      axes: {},
      assignees: [],
      acceptance: { total: 0, completed: 0 },
    },
    badges: {},
  };
}

describe('optimistic reconcile round-trip on clientMutationId (real node)', () => {
  let node: IntegrationNode;
  let space: SpaceFixture;
  let harness: SeamHarness;

  beforeAll(async () => {
    assertHarnessWiring();
    node = await startIntegrationNode('optimistic');
    space = await createSpace(node, 'b4 optimistic');
    harness = createSeamHarness(node);
    await harness.seam.openSpace(space.spaceId);
    await waitFor(
      () => harness.seam.getConnection().phase === 'live',
      () => `phase is ${harness.seam.getConnection().phase}, expected live`,
    );
  });

  afterAll(async () => {
    harness?.dispose();
    await node?.close();
  });

  it('A: CommandResult reconciles first, and the later echo carries the same id and is a no-op', async () => {
    const journal = createJournal();
    const clientMutationId = `cmid_opt_a_${Date.now().toString(36)}`;
    const optimisticId = 'ent_optimistic_placeholder_a';

    journal.applyOptimistic(
      clientMutationId,
      [stubSummary(optimisticId, space.spaceId, 'optimistic title A')],
      () => undefined,
    );
    expect(journal.pending()).toEqual([clientMutationId]);

    const eventsBeforeCommand = harness.events.length;
    const result = await harness.seam.commands.createTask({
      spaceId: space.spaceId,
      title: 'optimistic A',
      clientMutationId,
    });

    // The authoritative answer arrives on the COMMAND, before the stream has
    // said anything. Safe to assert rather than race: the pump ticks at 1s and
    // the HTTP response returns on commit, so an echo inside the round trip
    // would mean the pump published a row before the transaction that wrote it
    // returned.
    const echoedBeforeResult = harness.events
      .slice(eventsBeforeCommand)
      .filter((e) => e.clientMutationId === clientMutationId);
    expect(echoedBeforeResult, 'the echo beat its own CommandResult').toEqual([]);
    expect(result.patches.length, 'CommandResult must carry authoritative patches').toBeGreaterThan(0);

    // Exit 1: the CommandResult reconciles.
    expect(journal.reconcile(clientMutationId), 'CommandResult did not reconcile the entry').toBe(true);
    expect(journal.pending()).toEqual([]);

    // …and the echo still arrives, still carrying the id the CLIENT minted.
    await waitFor(
      () => harness.events.some((e) => e.clientMutationId === clientMutationId),
      () => `no event carried ${clientMutationId}; saw ids [${harness.events.map((e) => e.clientMutationId ?? '-').join(',')}]`,
    );
    const echoes = harness.events.filter((e) => e.clientMutationId === clientMutationId);
    expect(echoes.length, 'the command produced no echo carrying its clientMutationId').toBeGreaterThan(0);
    // The id survived the whole path and came back on a real entity event.
    expect(echoes.some((e) => e.type === 'entity.upsert')).toBe(true);
    // The real patch id is on the wire too — the placeholder was optimistic,
    // the server's is authoritative.
    const serverId = result.patches[0]!.id;
    expect(echoes.some((e) => (e.raw['entity'] as { id?: string } | undefined)?.id === serverId)).toBe(true);

    // FIRST WINS: reconciling again from the echo is a no-op, not a second
    // drop. A store that treated this as "unknown id, something is wrong"
    // would surface a phantom error on every healthy command.
    expect(journal.reconcile(clientMutationId), 'the echo re-reconciled an already-settled entry').toBe(false);
  });

  it('B: the ECHO ALONE reconciles — the path a lost CommandResult depends on', async () => {
    const journal = createJournal();
    const clientMutationId = `cmid_opt_b_${Date.now().toString(36)}`;

    journal.applyOptimistic(
      clientMutationId,
      [stubSummary('ent_optimistic_placeholder_b', space.spaceId, 'optimistic title B')],
      () => undefined,
    );

    // The CommandResult is deliberately DISCARDED. In production this is the
    // response that never came back; here it is the only way to prove the echo
    // path can close the entry on its own, rather than being permanently
    // shadowed by a CommandResult that always arrives first in a healthy test.
    await harness.seam.commands.createTask({
      spaceId: space.spaceId,
      title: 'optimistic B',
      clientMutationId,
    });
    expect(journal.pending(), 'the entry must still be pending — nothing has reconciled it yet').toEqual([
      clientMutationId,
    ]);

    await waitFor(
      () => harness.events.some((e) => e.clientMutationId === clientMutationId),
      () => `the echo for ${clientMutationId} never arrived`,
    );

    // Exit 2: the echo closes it.
    expect(journal.reconcile(clientMutationId), 'the echo alone did not reconcile the entry').toBe(true);
    expect(journal.pending()).toEqual([]);
  });

  it('C: a rejected command rolls back to the captured pre-optimistic state', async () => {
    const journal = createJournal();
    const clientMutationId = `cmid_opt_c_${Date.now().toString(36)}`;

    // A real entity, and a real cached summary to restore.
    const created = await harness.seam.commands.createTask({
      spaceId: space.spaceId,
      title: 'optimistic C original',
      clientMutationId: `cmid_opt_c_seed_${Date.now().toString(36)}`,
    });
    const target = created.patches[0]!;
    const cached = stubSummary(target.id, space.spaceId, 'optimistic C original');

    journal.applyOptimistic(
      clientMutationId,
      [stubSummary(target.id, space.spaceId, 'optimistic C deleted-locally')],
      (id) => (id === target.id ? cached : undefined),
    );
    expect(journal.has(clientMutationId)).toBe(true);

    // The documented §16 adaptation, exercised for real: the seam types `ctx`
    // optional but the server binds RequiredCommandContextSchema, so an omitted
    // context earns an HONEST invalid_input rather than a synthesized id that
    // could never reconcile a journal entry the caller does not hold.
    const rejection = await harness.seam.commands
      .deleteEntity(target.id)
      .then(() => undefined, (error: unknown) => error);

    expect(rejection, 'deleteEntity without a context must reject, not resolve').toBeInstanceOf(CollabError);
    expect((rejection as CollabError).code).toBe('invalid_input');

    // Exit 3: rollback hands back the restore instructions.
    const restore = journal.rollback(clientMutationId);
    expect(restore.length, 'rollback produced no restore instruction for a captured entity').toBeGreaterThan(0);
    expect(journal.pending()).toEqual([]);

    // …and the entity is genuinely still there, because the command really did
    // fail. Without this the rollback assertion above would be equally
    // consistent with a delete that succeeded and a client that lied about it.
    // `EntityDetail extends EntitySummary`, so deletedAt is a TOP-LEVEL field —
    // there is no nested `summary`. (Caught by the data-test tsconfig lane,
    // which vitest does not run: the assertion below passed as a green test
    // while reading `undefined?.deletedAt ?? null` and comparing it to null,
    // i.e. it could not have failed for any input.)
    const stillThere = await harness.seam.entity(target.id);
    expect(stillThere.deletedAt, 'the entity was deleted despite the rejection').toBeNull();
    expect(stillThere.id).toBe(target.id);
  });
});
