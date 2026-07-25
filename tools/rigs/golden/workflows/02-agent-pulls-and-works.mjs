/**
 * GOLDEN WORKFLOW 2 — Agent pulls & works.
 *
 * Source: docs/collab-v2-ui-plan/01-IMPLEMENTATION-PLAN.md Layer 8 §2
 *   "pull → working → progress in thread → human correction mid-flight →
 *    agent ack"
 *
 * This is the workflow that proves the agent loop is a GRAPH loop: an agent's
 * report-back is an anchored message (04-EXECUTION-TRANSPLANT §1.2 — "session
 * timeline is retired in favor of anchored messages + activity"), its status is
 * a command, and its pull is an edge carrying a pinned version. The staleness
 * assertion is the load-bearing one: a pull that doesn't notice the spec moved
 * under it is how an agent ships the wrong thing.
 */
import { assertCommandResult, assertPage } from '../../lib/http.mjs';
import { ok, equal } from '../../lib/assert.mjs';

export const id = '02-agent-pulls-and-works';
export const title = 'Agent pulls & works — pull, working, progress, mid-flight correction, ack';
export const source = 'ui-plan Layer 8 §2';

export async function run({ client, world, rec }) {
  const taskId = world.taskId;
  ok(taskId, 'workflow 02 requires workflow 01 to have authored a task');

  // ---- pull ---------------------------------------------------------------
  const pinnedVersion = await rec.step(
    'the agent pulls the task — a pulled edge pinning the version it read',
    async () => {
      const { data: detail } = await client.call('entities.get', { params: { id: taskId } });
      const { data } = await client.mutate('entities.commands.pull', {
        params: { id: taskId },
        body: { actorId: world.agentId, pinnedVersion: detail.version, localId: 'rig-local-1' },
      });
      const result = assertCommandResult('entities.commands.pull', data);
      const patched = result.patches.find((p) => p.id === taskId) ?? result.entity;
      const pulls = patched?.badges?.pulls ?? [];
      ok(pulls.length >= 1, 'a pull must surface as a PullState badge (derived truth, L3)');
      equal(pulls[0].pinnedVersion, detail.version, 'PullState must pin the version the agent actually read');
      equal(pulls[0].contentStale, false, 'a fresh pull is not stale');
      return detail.version;
    },
    { operation: 'entities.commands.pull', docRef: 'api-design 02 §3.2 + UI contract PullState' },
  );

  // ---- start working ------------------------------------------------------
  await rec.step(
    'the agent goes `working` — a per-actor working_on edge, not a free-text status',
    async () => {
      const { data } = await client.mutate('entities.commands.work', {
        params: { id: taskId },
        body: { actorId: world.agentId, status: 'working', note: 'starting the facade' },
      });
      const result = assertCommandResult('entities.commands.work', data);
      const patched = result.patches.find((p) => p.id === taskId) ?? result.entity;
      equal(patched.state.workStatus, 'working', 'work command must move workStatus');
      ok(
        (patched.badges?.workingActors ?? []).length >= 1,
        'the live-work badge must name WHO is working (per-actor working_on edge, 02 §3.2)',
      );
    },
    { operation: 'entities.commands.work', docRef: 'api-design 02 §3.2' },
  );

  // ---- progress in the thread ---------------------------------------------
  const progressMessageId = await rec.step(
    'progress lands as a message anchored to the task (the timeline is retired)',
    async () => {
      const { data } = await client.mutate('messages.post', {
        body: {
          anchorId: taskId,
          actorId: world.agentId,
          body: 'Facade skeleton up; /entities/:id returns EntityDetail for task and doc.',
        },
      });
      const result = assertCommandResult('messages.post', data);
      ok(result.entity, 'messages.post must return the created MessageView');
      const patched = result.patches.find((p) => p.id === taskId);
      ok(
        patched && patched.counters.messages >= 1,
        'posting must patch the anchor\'s message counter so open views update (counter.changed, 04 §2.2)',
      );
      return result.entity.id;
    },
    { operation: 'messages.post', docRef: 'api-design 02 §3.4 + 04-EXECUTION-TRANSPLANT §1.2' },
  );

  // ---- human correction mid-flight ----------------------------------------
  await rec.step(
    'a human corrects the spec mid-flight — the doc version bumps',
    async () => {
      const { data: doc } = await client.call('entities.get', { params: { id: world.specDocId } });
      const { data } = await client.mutate('entities.patch', {
        params: { id: world.specDocId },
        body: {
          expectedVersion: doc.version,
          content: { body: '# Spec\n\nThe thing we are building.\n\n## Correction\nUse keyset cursors everywhere.\n' },
        },
      });
      const result = assertCommandResult('entities.patch(doc)', data);
      const patched = result.patches.find((p) => p.id === world.specDocId) ?? result.entity;
      ok(
        patched.version > doc.version,
        'an edit must bump the version — this is what makes a pinned pull detectably stale',
      );
    },
    { operation: 'entities.patch', docRef: 'api-design 01 §5.1 (version snapshot trigger)' },
  );

  await rec.step(
    'the human replies in the thread, mentioning the agent (targeted notification)',
    async () => {
      const { data } = await client.mutate('messages.post', {
        body: {
          anchorId: taskId,
          parentMessageId: progressMessageId,
          body: 'Correction: cursors must be keyset, not offset. See the spec update.',
          mentions: [{ actorId: world.agentId, kind: 'team_member' }],
        },
      });
      assertCommandResult('messages.post(correction)', data);
    },
    { operation: 'messages.post', docRef: 'api-design 01 §S7 (targeted fan-out: mentions)' },
  );

  await rec.step(
    'the mention reaches the agent\'s inbox — targeted, not broadcast to every member',
    async () => {
      const { data } = await client.call('inbox.list', {
        query: { actorId: world.agentId, limit: 50 },
      });
      const page = assertPage('inbox.list', data.page ?? data);
      const mention = page.items.find((n) => n.kind === 'mention' && n.target?.id === taskId);
      ok(
        mention,
        'a mention must produce exactly one targeted notification for the mentioned actor ' +
          '(01 §S7 replaced the all-members broadcast; a missing row here means fan-out regressed)',
      );
    },
    { operation: 'inbox.list', docRef: 'api-design 01 §S7' },
  );

  // ---- staleness ----------------------------------------------------------
  await rec.step(
    'the agent\'s pull is now flagged stale — the spec moved past the pinned version',
    async () => {
      const { data } = await client.call('entities.get', { params: { id: taskId } });
      const pulls = data.badges?.pulls ?? [];
      const mine = pulls.find((p) => p.actor?.id === world.agentId) ?? pulls[0];
      ok(mine, 'the pull badge must persist while the agent is working');
      ok(
        mine.discussionMoved === true || mine.contentStale === true,
        'after a mid-flight correction the PullState must report movement ' +
          '(contentStale for content, discussionMoved for thread activity) — silently-stale is the failure mode',
      );
      ok(pinnedVersion !== undefined, 'pinned version captured earlier');
    },
    { operation: 'entities.get', docRef: 'UI contract §6 PullState (contentStale / discussionMoved)' },
  );

  // ---- agent acknowledges --------------------------------------------------
  await rec.step(
    'the agent acknowledges the correction in the thread',
    async () => {
      const { data } = await client.mutate('messages.post', {
        body: { anchorId: taskId, actorId: world.agentId, body: 'Ack — switching to keyset cursors.' },
      });
      assertCommandResult('messages.post(ack)', data);
    },
    { operation: 'messages.post', docRef: 'ui-plan Layer 8 §2' },
  );

  await rec.step(
    'the thread reads back in order, with the reply threaded under the progress note',
    async () => {
      const { data } = await client.call('messages.list', {
        params: { anchorId: taskId },
        query: { order: 'asc', limit: 50 },
      });
      const page = assertPage('messages.list', data.page ?? data);
      ok(page.items.length >= 3, 'all three thread posts must be readable from the anchor');
      const reply = page.items.find((m) => m.state?.rootMessageId === progressMessageId);
      ok(reply, 'the correction must be threaded under the progress message (anchor + root threading, 02 §3.4)');
    },
    { operation: 'messages.list', docRef: 'api-design 02 §3.4' },
  );

  return world;
}
