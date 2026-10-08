/** Every entity and credential here is synthetic and confined to the owned DB. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export async function seedTasklandFixture(node) {
  const { request, pool } = node;
  const space = (await request('/v2/spaces', { name: 'Synthetic Taskland world', clientMutationId: randomUUID() })).space;
  const make = async (kind, title, options = {}) => (await request('/v2/entities', {
    kind, title, spaceId: space.id, clientMutationId: randomUUID(), ...options,
  })).entity;
  const task = (title, estimate, parentId, criteria = 0) => make('task', title, {
    ...(parentId ? { parentId } : {}), content: {
      description: 'Synthetic durable Taskland acceptance',
      ...(estimate === undefined ? {} : { pointsEstimate: estimate }),
      acceptanceCriteria: Array.from({ length: criteria }, (_, index) => ({ id: `ac${index + 1}`, text: `Synthetic criterion ${index + 1}`, done: false })),
    },
  });
  const story = await make('story', 'Synthetic harbour story');
  const root = await task('Harbour construction', 3, null, 3);
  const child = await task('Independent boathouse', 1, root.id);
  const tree = await task('Nested workshop', 5);
  const branch = await task('Workshop child', 3, tree.id, 2);
  const grandchild = await task('Workshop grandchild', 2, branch.id, 2);
  const sibling = await task('Workshop sibling', 1, tree.id);
  const tent = await task('Estimate needed', undefined);
  const neighbour = await task('Stable neighbour', 8);
  const cancel = await task('Cancelled watchtower', 3);
  const cancelledChild = await task('Cancelled annex', 2, tree.id);
  const shipRoot = await task('Shipped root with live child', 2);
  const shipChild = await task('Last live child', 1, shipRoot.id);
  const tasks = { root, child, tree, branch, grandchild, sibling, tent, neighbour, cancel, cancelledChild, shipRoot, shipChild };
  for (const row of Object.values(tasks).filter(row => !row.parentId)) {
    await request(`/v2/actions?contextEntityId=${story.id}&schema=v2&limit=100`);
    await request(`/v2/collections/${story.id}/items`, { entityId: row.id, clientMutationId: randomUUID() });
  }
  const { rows: [owner] } = await pool.query(`select m.entity_id as "memberId", m.identity_id as "identityId", a.id as "accountId"
    from public.members m join public.accounts a on a.identity_id=m.identity_id
    where m.space_id=$1 and a.is_owner`, [space.id]);
  if (!owner) throw new Error('Synthetic owner member not created');

  const teammate = await make('team_member', 'Synthetic construction worker', {
    content: { model: 'claude-sonnet-4-5', agentTool: 'claude-code', mode: 'worker' },
  });
  const project = await request('/v2/projects', { name: 'Synthetic Taskland project', workingDir: node.runRoot,
    trust: 'trusted', clientMutationId: randomUUID() });
  await request(`/v2/spaces/${space.id}/projects`, { projectId: project.id, clientMutationId: randomUUID() });
  const spawned = await request('/v2/execution/spawn', { spaceId: space.id, teamMemberId: teammate.id,
    projectId: project.id, taskIds: [tree.id], workdir: { mode: 'project' }, mode: 'worker', cols: 120, rows: 30,
    clientMutationId: randomUUID() });
  const agentId = teammate.id, sessionId = spawned.entity.id;
  // A local credential bound to the REAL echo-agent runtime. Only this fixture
  // knows it; no private runtime files or token values are published.
  const token = await rotateFixtureToken(node, sessionId);
  await mutateEntity(node, tree.id, 'release', { note: 'Synthetic fixture baseline ready' }, { token });
  await mutateEntity(node, tree.id, 'work', { status: 'open' });
  return { spaceId: space.id, storyId: story.id, memberId: owner.memberId, agentId, sessionId, token, tasks };
}

/** Rotate only this synthetic echo-session credential; never read a runtime secret. */
export async function rotateFixtureToken(node, sessionId) {
  const secret = randomBytes(32).toString('base64url');
  const { rows: [auth] } = await node.pool.query(`update public.auth_sessions set token_hash=$2
    where work_session_id=$1 and revoked_at is null and expires_at>now() returning id`,
  [sessionId, createHash('sha256').update(secret).digest('hex')]);
  if (!auth) throw new Error('No live synthetic echo-session credential to rotate');
  return `tm8s_${auth.id}.${secret}`;
}

export async function mutateEntity(node, entityId, command, body, options = {}) {
  // Discover current authority and version immediately before the mutation.
  await node.request(`/v2/actions?contextEntityId=${entityId}&schema=v2&limit=100`, undefined, options);
  const entity = await node.request(`/v2/entities/${entityId}`, undefined, options);
  return node.request(`/v2/entities/${entityId}/commands/${command}`, {
    ...body, ...(['tick', 'complete'].includes(command) ? { expectedVersion: entity.version } : {}),
  }, options);
}
