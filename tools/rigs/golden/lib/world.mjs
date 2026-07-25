/**
 * Seed-world builder for the golden workflows.
 *
 * Every workflow needs the same substrate — a space, a viewer identity, a
 * channel, task axes, an agent persona, a spec doc, a milestone. Building it
 * through the PUBLIC contract (never a SQL fixture) is deliberate: if the seed
 * can't be built from the operation catalog, the catalog is incomplete, and
 * that is itself a G1 finding. A fixture loaded behind the facade would hide it.
 *
 * The world is created fresh per run with a unique space name, so runs are
 * isolated and re-runnable without a teardown step (soft-delete makes teardown
 * a lie anyway — see `deleted: 'exclude'` in the collection filters).
 */
import { assertCommandResult } from '../../lib/http.mjs';
import { ok, isString, hasKeys } from '../../lib/assert.mjs';

/** Entity id out of a CommandResult, with the contract shape checked on the way. */
export function entityIdOf(operationName, data) {
  const result = assertCommandResult(operationName, data);
  ok(result.entity, `${operationName}: CommandResult.entity missing (needed to continue the workflow)`, { data });
  isString(result.entity.id, `${operationName}: CommandResult.entity.id must be a non-empty string`);
  return result.entity.id;
}

export async function buildWorld(client, rec, { label = 'golden' } = {}) {
  const stamp = `${label}-${Date.now().toString(36)}`;
  const world = { stamp };

  world.viewer = await rec.step(
    'identity resolves to a viewer actor',
    async () => {
      const { data } = await client.call('identity.get');
      hasKeys(data, ['actor'], 'identity.get must return the caller as an ActorSummary');
      return data.actor;
    },
    { operation: 'identity.get', docRef: 'api-design 02 §4' },
  );

  world.spaceId = await rec.step(
    'create the space (default visibility private)',
    async () => {
      const { data } = await client.mutate('spaces.create', {
        body: { name: `golden ${stamp}`, description: 'golden-workflow rig world', visibility: 'private' },
      });
      const id = data?.space?.id ?? data?.entity?.id ?? data?.id;
      isString(id, 'spaces.create must return the created space id');
      return id;
    },
    { operation: 'spaces.create', docRef: 'api-design 01 §2 (create_space default private)' },
  );

  world.channelId = await rec.step(
    'create a channel (kind is data, not a route)',
    async () => {
      const { data } = await client.mutate('entities.create', {
        body: {
          spaceId: world.spaceId,
          kind: 'channel',
          title: `build-${stamp}`,
          content: { topic: 'golden workflow staging ground' },
        },
      });
      return entityIdOf('entities.create(channel)', data);
    },
    { operation: 'entities.create', docRef: 'api-design 02 §3.1 (DEV-1: one create form)' },
  );

  world.axis = await rec.step(
    'create a task axis (the second organizing axis)',
    async () => {
      const { data } = await client.mutate('spaces.taskAxes.create', {
        params: { spaceId: world.spaceId },
        body: { name: 'area', axisValues: ['engine', 'ui', 'ops'], kind: 'manual', position: 0 },
      });
      return data?.axis ?? data;
    },
    { operation: 'spaces.taskAxes.create', docRef: 'api-design 01 §3' },
  );

  world.agentId = await rec.step(
    'create the agent persona (team_member)',
    async () => {
      const { data } = await client.mutate('entities.create', {
        body: {
          spaceId: world.spaceId,
          kind: 'team_member',
          title: `Rigger-${stamp}`,
          content: {
            identity: 'Golden-workflow agent persona. Exists to be pulled to, worked, and completed.',
            model: 'claude-opus-5',
            agentTool: 'claude',
          },
        },
      });
      return entityIdOf('entities.create(team_member)', data);
    },
    { operation: 'entities.create', docRef: 'api-design 01 §6 (create_team_member)' },
  );

  world.specDocId = await rec.step(
    'create the spec doc that tasks will hang off',
    async () => {
      const { data } = await client.mutate('entities.create', {
        body: {
          spaceId: world.spaceId,
          kind: 'doc',
          title: `spec-${stamp}`,
          parentId: world.channelId,
          content: { body: '# Spec\n\nThe thing we are building.\n', format: 'markdown' },
        },
      });
      return entityIdOf('entities.create(doc)', data);
    },
    { operation: 'entities.create', docRef: 'api-design 02 §3.1' },
  );

  return world;
}
