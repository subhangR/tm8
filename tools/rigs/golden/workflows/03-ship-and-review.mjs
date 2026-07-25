/**
 * GOLDEN WORKFLOW 3 — Ship & review.
 *
 * Source: docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md Layer 8 §3
 *   "PR link → in_review → side-by-side pinned splits → star → Complete →
 *    award moment → unblock ripple"
 *
 * The panel-stack "side-by-side pinned splits" beat is pure UI (it belongs to
 * G2, in the running app) — the BACKEND obligation underneath it is that the
 * task and its PR are reachable as one connected neighbourhood without N+1
 * fetching, which is what this workflow asserts instead. Every other beat is a
 * real command.
 *
 * The unblock ripple is the sharpest assertion in the whole suite: completing a
 * task must clear the `blocked` badge on its dependents WITHOUT anyone touching
 * those dependents. That is trigger-owned derived truth (01 §5.2); if it needs
 * a client to recompute it, the model has already leaked.
 */
import { assertCommandResult, assertPage } from '../../lib/http.mjs';
import { ok, equal } from '../../lib/assert.mjs';
import { entityIdOf } from '../lib/world.mjs';

export const id = '03-ship-and-review';
export const title = 'Ship & review — PR link, in_review, star, complete, award, unblock ripple';
export const source = 'ui-plan Layer 8 §3';

export async function run({ client, world, rec }) {
  const taskId = world.taskId;
  ok(taskId, 'workflow 03 requires the task authored in workflow 01');

  // ---- a dependent task, so there is something to unblock -----------------
  const dependentId = await rec.step(
    'a downstream task hard-depends on ours → it reports as blocked',
    async () => {
      const { data: created } = await client.mutate('entities.create', {
        body: {
          spaceId: world.spaceId,
          kind: 'task',
          title: 'Transplant the UI onto the real facade',
          parentId: world.channelId,
          content: { description: 'Cannot start until the facade ships.', priority: 'medium' },
        },
      });
      const depId = entityIdOf('entities.create(dependent)', created);

      await client.mutate('edges.create', {
        body: { srcId: depId, dstId: taskId, type: 'depends_on', props: { hard: true } },
      });

      const { data } = await client.call('entities.get', { params: { id: depId } });
      ok(
        data.badges?.blocked?.unresolvedHardDependencyCount >= 1,
        'an unresolved hard dependency must raise the blocked badge (server-computed rollup, 01 §5.2)',
      );
      return depId;
    },
    { operation: 'edges.create', docRef: 'api-design 01 §5.2 (is_resolved + unblock trigger)' },
  );

  // ---- link the PR ---------------------------------------------------------
  await rec.step(
    'link a PR by URL — the pull_request entity and the tracks edge in ONE transaction',
    async () => {
      const { data } = await client.mutate('entities.commands.linkPr', {
        params: { id: taskId },
        body: { url: 'https://github.com/example/tm8/pull/42' },
      });
      const result = assertCommandResult('entities.commands.linkPr', data);
      ok(
        result.entity || result.patches.length,
        'link-pr must return the upserted pull_request / patched task, not just 200',
      );
    },
    { operation: 'entities.commands.linkPr', docRef: 'api-design 02 §3.2 + 01 §6 (link_pr)' },
  );

  await rec.step(
    'the task and its PR read back as one connected neighbourhood (no N+1)',
    async () => {
      const { data } = await client.call('entities.connections', { params: { id: taskId } });
      const groups = Array.isArray(data) ? data : (data.groups ?? data.edges ?? []);
      const flat = JSON.stringify(groups);
      ok(
        flat.includes('tracks') || flat.includes('pull_request'),
        'the tracked PR must appear in the task\'s connections — this is what backs the ' +
          'side-by-side pinned split without the UI fetching per-edge (L3)',
      );
    },
    { operation: 'entities.connections', docRef: 'api-design 02 §3.1' },
  );

  // ---- in_review + star -----------------------------------------------------
  await rec.step('the agent moves the task to in_review', async () => {
    const { data } = await client.mutate('entities.commands.work', {
      params: { id: taskId },
      body: { actorId: world.agentId, status: 'in_review' },
    });
    const result = assertCommandResult('entities.commands.work(in_review)', data);
    const patched = result.patches.find((p) => p.id === taskId) ?? result.entity;
    equal(patched.state.workStatus, 'in_review', 'work command must reach in_review');
  }, { operation: 'entities.commands.work', docRef: 'api-design 02 §3.2' });

  await rec.step(
    'a reviewer stars the work — reactions are mutually exclusive edge sugar',
    async () => {
      const { data } = await client.call('entities.react', {
        params: { id: taskId },
        body: { reaction: 'star', enabled: true, clientMutationId: `golden-03-star-${world.stamp}` },
      });
      const result = assertCommandResult('entities.react', data);
      const patched = result.patches.find((p) => p.id === taskId) ?? result.entity;
      equal(patched.counters.stars, 1, 'star must be reflected in the trigger-derived counters');
      equal(
        patched.counters.viewerReaction,
        'star',
        'viewerReaction is server-computed from the caller\'s edge (DEV-10) — never client state',
      );
    },
    { operation: 'entities.react', docRef: 'api-design 02 §3.3 (reaction = edge sugar)' },
  );

  // ---- complete + award ------------------------------------------------------
  await rec.step(
    'Complete — criteria gate, completers and the award ledger in one transaction',
    async () => {
      const { data: before } = await client.call('entities.get', { params: { id: taskId } });
      const { data } = await client.mutate('entities.commands.complete', {
        params: { id: taskId },
        body: { expectedVersion: before.version, completerIds: [world.agentId] },
      });
      const result = assertCommandResult('entities.commands.complete', data);
      const patched = result.patches.find((p) => p.id === taskId) ?? result.entity;
      equal(patched.state.workStatus, 'done', 'complete must land the task in `done`');
    },
    { operation: 'entities.commands.complete', docRef: 'api-design 02 §3.2 (one txn)' },
  );

  await rec.step(
    'completing twice is refused — the award is single-shot, not a retry hazard',
    async () => {
      const { data: after } = await client.call('entities.get', { params: { id: taskId } });
      const second = await client.mutate('entities.commands.complete', {
        params: { id: taskId },
        body: { expectedVersion: after.version, completerIds: [world.agentId] },
        expectStatus: 409,
      });
      equal(
        second.error.code,
        'invariant_violation',
        'a second complete is an invariant violation (04 §4) — NOT a silent no-op that double-awards',
      );
    },
    { operation: 'entities.commands.complete', docRef: '04 §4 (invariant_violation row)' },
  );

  await rec.step(
    'the award moment is real: a point event exists and the leaderboard moved',
    async () => {
      const { data: awards } = await client.call('spaces.awards', {
        params: { spaceId: world.spaceId },
        query: { limit: 50 },
      });
      const page = assertPage('spaces.awards', awards.page ?? awards);
      const award = page.items.find((e) => e.reason === 'award' && e.ref?.id === taskId);
      ok(award, 'completing must append an `award` point event referencing the task (01 §4 ledger)');

      const { data: board } = await client.call('spaces.leaderboard', { params: { spaceId: world.spaceId } });
      const rows = board.rows ?? board.items ?? board;
      const row = rows.find?.((r) => r.actor?.id === world.agentId);
      ok(row && row.score > 0, 'the completer must appear on the leaderboard with a non-zero score');
    },
    { operation: 'spaces.awards', docRef: 'api-design 01 §6 (leaderboard view)' },
  );

  // ---- the ripple ------------------------------------------------------------
  await rec.step(
    'UNBLOCK RIPPLE: the dependent clears its blocked badge with nobody touching it',
    async () => {
      const { data } = await client.call('entities.get', { params: { id: dependentId } });
      equal(
        data.badges?.blocked?.unresolvedHardDependencyCount ?? 0,
        0,
        'resolving the dependency must clear the dependent\'s blocked rollup automatically ' +
          '(01 §5.2 unblock trigger). If this needs a write to the dependent, derived truth has leaked out of L3.',
      );
    },
    { operation: 'entities.get', docRef: 'api-design 01 §5.2' },
  );

  await rec.step(
    'the ripple also notifies the dependent\'s owner (unblock is a targeted notification)',
    async () => {
      const { data } = await client.call('inbox.list', { query: { limit: 50 } });
      const page = assertPage('inbox.list', data.page ?? data);
      ok(
        page.items.some((n) => n.kind === 'unblock'),
        'an unblock must reach the inbox — an unblocked task nobody hears about is not unblocked in practice',
      );
    },
    { operation: 'inbox.list', docRef: 'api-design 01 §S7 (unblock targeting)' },
  );

  world.dependentId = dependentId;
  return world;
}
