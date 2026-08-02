/**
 * GOLDEN WORKFLOW 1 — Author & stage.
 *
 * Source: docs/history/collab-v2/ui-plan/01-IMPLEMENTATION-PLAN.md Layer 8 §1
 *   "create in channel → criteria → attach doc → drag-assign → bounty"
 *
 * Beyond the narrative, this workflow is where G1 pins the MUTATION invariants
 * that every other workflow then relies on (09 §3.3): optimistic concurrency
 * (`expectedVersion` → `version_conflict`), uniform idempotency (replaying a
 * `clientMutationId` returns the recorded CommandResult rather than acting
 * twice), and the placement grammar resolving a drag into a real edge.
 */
import { assertCommandResult } from '../../lib/http.mjs';
import { ok, equal, isString } from '../../lib/assert.mjs';
import { entityIdOf } from '../lib/world.mjs';

export const id = '01-author-and-stage';
export const title = 'Author & stage — create in channel, criteria, attach doc, drag-assign, bounty';
export const source = 'ui-plan Layer 8 §1';

export async function run({ client, world, rec }) {
  // ---- create the task inside the channel -------------------------------
  const taskId = await rec.step(
    'author a task in the channel, with acceptance criteria, in one create',
    async () => {
      const { data } = await client.mutate('entities.create', {
        body: {
          spaceId: world.spaceId,
          kind: 'task',
          title: 'Ship the entity-graph facade',
          parentId: world.channelId,
          content: {
            description: 'The facade must answer /entities and the closed command set.',
            priority: 'high',
            axes: { area: 'engine' },
            acceptanceCriteria: [
              { text: 'GET /entities/:id returns EntityDetail' },
              { text: 'commands are closed and discoverable via capabilities' },
            ],
            pointsEstimate: 8,
          },
        },
      });
      const result = assertCommandResult('entities.create(task)', data);
      // Derived truth is computed server-side (L3) — a task is born `open`
      // with its criteria counted, not with the client doing the arithmetic.
      equal(result.entity.state.kind, 'task', 'created entity must discriminate as a task');
      equal(result.entity.state.workStatus, 'open', 'a freshly authored task starts `open`');
      equal(
        result.entity.state.acceptance.total,
        2,
        'acceptance.total must be server-derived from the criteria (UI contract §6 / L3)',
      );
      return result.entity.id;
    },
    { operation: 'entities.create', docRef: 'api-design 02 §3.1' },
  );
  world.taskId = taskId;

  // ---- idempotent replay (DEV-9 / 04 §5) ---------------------------------
  await rec.step(
    'replaying a clientMutationId returns the recorded result, does not create twice',
    async () => {
      const cmid = 'golden-01-replay-' + world.stamp;
      const body = {
        spaceId: world.spaceId,
        kind: 'task',
        title: 'Idempotency probe',
        parentId: world.channelId,
        content: { description: 'posted twice on purpose' },
      };
      const first = await client.mutate('entities.create', { body, clientMutationId: cmid });
      const second = await client.mutate('entities.create', { body, clientMutationId: cmid });
      const a = entityIdOf('entities.create(first)', first.data);
      const b = entityIdOf('entities.create(replay)', second.data);
      equal(b, a, 'replay must return the SAME entity — the command ledger replays, it does not re-execute');
    },
    { operation: 'entities.create', docRef: '04 §5.1 (command_ledger), DEV-9' },
  );

  // ---- optimistic concurrency (04 §4) ------------------------------------
  await rec.step(
    'a stale expectedVersion is rejected with version_conflict + the current detail',
    async () => {
      const { data: detail } = await client.call('entities.get', { params: { id: taskId } });
      const current = detail.version;
      ok(Number.isInteger(current), 'EntityDetail.version must be an integer');

      const bad = await client.mutate('entities.patch', {
        params: { id: taskId },
        body: { expectedVersion: current - 1, content: { description: 'written against a stale read' } },
        expectStatus: 409,
      });
      equal(bad.error.code, 'version_conflict', 'a stale write must be `version_conflict`, not a generic 400');
      ok(
        bad.error.details?.current,
        'version_conflict must carry `details.current: EntityDetail` so the client can rebase (04 §4)',
      );
    },
    { operation: 'entities.patch', docRef: '04 §4 (version_conflict row)' },
  );

  // ---- attach the spec doc ----------------------------------------------
  await rec.step(
    'attach the spec doc to the task as a first-class edge (no bespoke route)',
    async () => {
      const { data } = await client.mutate('edges.create', {
        body: { srcId: taskId, dstId: world.specDocId, type: 'attached_to' },
      });
      const result = assertCommandResult('edges.create', data);
      ok(result.edge, 'edges.create must return the created EdgeView');
      equal(result.edge.type, 'attached_to', 'edge type must round-trip from the registry');
    },
    { operation: 'edges.create', docRef: 'api-design 02 §3.3 (edges are first-class)' },
  );

  // ---- drag-assign via the placement grammar -----------------------------
  const undoToken = await rec.step(
    'drag the agent onto the task → placement resolves to an assignment edge, with undo',
    async () => {
      const { data } = await client.mutate('placements.apply', {
        body: { sourceId: world.agentId, targetId: taskId, intent: 'assign' },
      });
      const result = assertCommandResult('placements.apply', data);
      ok(
        result.edge || result.patches.length,
        'a placement must resolve into a concrete edge/patch — intent is resolved server-side, not by the UI',
      );
      // Placements are cheaply invertible, so the contract promises an undo
      // handle (DEV-11 / 04 §5.1). Its absence is a real gap, not a nicety:
      // the UI's drag affordance is built on being able to take it back.
      ok(result.undo, 'a placement must return an UndoToken (04 §5.1, DEV-11)');
      isString(result.undo.token, 'UndoToken.token must be an opaque string');
      return result.undo.token;
    },
    { operation: 'placements.apply', docRef: 'api-design 02 §3.5 + 04 §5.1' },
  );

  await rec.step(
    'the undo token reverses the assignment, then the task is re-assigned for the rest of the run',
    async () => {
      await client.mutate('commands.undo', { body: { token: undoToken } });
      const { data } = await client.call('entities.get', { params: { id: taskId } });
      equal(
        data.state.assignees?.length ?? 0,
        0,
        'undo must actually remove the assignment — an undo that only returns 200 is a lie',
      );
      // Put it back: workflows 2-3 need the task assigned.
      await client.mutate('placements.apply', {
        body: { sourceId: world.agentId, targetId: taskId, intent: 'assign' },
      });
    },
    { operation: 'commands.undo', docRef: '04 §5.1 (undo = inverse command, same actor)' },
  );

  // ---- bounty -------------------------------------------------------------
  await rec.step(
    'put a bounty on the task (append-only points ledger, reflected in counters)',
    async () => {
      const { data } = await client.mutate('entities.points.add', {
        params: { id: taskId },
        body: { amount: 25, reason: 'grant' },
      });
      const result = assertCommandResult('entities.points.add', data);
      const patched = result.patches.find((p) => p.id === taskId) ?? result.entity;
      ok(patched, 'a points grant must patch the task so open views update without a refetch');
      equal(patched.counters.points, 25, 'counters.points is trigger-maintained, not client arithmetic');
    },
    { operation: 'entities.points.add', docRef: 'api-design 01 §4 (point_events ledger)' },
  );

  // ---- the staged task is visible where the UI looks for it ---------------
  await rec.step(
    'the staged task appears in the channel collection with its derived badges',
    async () => {
      const { data } = await client.call('collections.query', {
        body: {
          spaceId: world.spaceId,
          kinds: ['task'],
          parentId: world.channelId,
          sort: 'activityAt_desc',
          limit: 50,
        },
      });
      const items = data.page?.items ?? [];
      const mine = items.find((e) => e.id === taskId);
      ok(mine, 'the authored task must be returned by a channel-scoped collection query');
      equal(mine.state.assignees.length, 1, 'the assignment must be visible as derived state, not requiring an edge fetch');
    },
    { operation: 'collections.query', docRef: 'api-design 02 §3.5' },
  );

  return world;
}
