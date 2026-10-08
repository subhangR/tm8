/** Synthetic fixture shared by storage and Game visual acceptance. No snapshots or tokens are written. */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { databaseUrl, request, repoRoot } from './game-storage-node.mjs';

const require = createRequire(`${repoRoot}/packages/server/package.json`);
const { Pool } = require('pg');
export function fixturePool() { return new Pool({ connectionString: databaseUrl(), max: 4 }); }

export function dataOf(response, stage) {
  if (response.status >= 300 || response.error) throw new Error(`${stage}: HTTP ${response.status}, ${response.error?.code ?? 'missing data'}`);
  return response.data;
}

export async function seedStorageFixture(pool) {
  const mutation = () => randomUUID();
  const space = dataOf(await request('/v2/spaces', { name: 'Synthetic storage world', clientMutationId: mutation() }), 'create space').space;
  const otherSpace = dataOf(await request('/v2/spaces', { name: 'Synthetic foreign world', clientMutationId: mutation() }), 'create foreign space').space;
  const make = async (kind, title, options = {}) => dataOf(await request('/v2/entities', {
    kind, title, spaceId: space.id, clientMutationId: mutation(), ...options,
  }), `create synthetic ${kind}`).entity;
  const story = await make('story', 'Synthetic harbour story');
  const nested = await make('story', 'Synthetic mountain story', { parentId: story.id });
  const task = await make('task', 'Synthetic task');
  const doc = await make('doc', 'Synthetic document');
  const foreignStory = dataOf(await request('/v2/entities', {
    kind: 'story', title: 'Synthetic foreign story', spaceId: otherSpace.id, clientMutationId: mutation(),
  }), 'create foreign story').entity;
  const foreignTask = dataOf(await request('/v2/entities', {
    kind: 'task', title: 'Synthetic foreign task', spaceId: otherSpace.id, clientMutationId: mutation(),
  }), 'create foreign task').entity;
  const { rows: [owner] } = await pool.query(`select m.entity_id as "memberId", m.identity_id as "identityId", a.id as "accountId"
    from public.members m join public.accounts a on a.identity_id=m.identity_id
    where m.space_id=$1 and a.is_owner`, [space.id]);
  if (!owner) throw new Error('fixture owner member absent');

  const human = async (label, join) => {
    const username = `gst${randomBytes(6).toString('hex')}`;
    const password = randomBytes(20).toString('base64url');
    dataOf(await request('/v2/auth/signup', { username, password, displayName: label }), 'signup');
    const auth = dataOf(await request('/v2/auth/login', { username, password }), 'login');
    if (join) {
      const invited = dataOf(await request(`/v2/spaces/${space.id}/invites`, { clientMutationId: mutation(), maxUses: 1 }), 'invite');
      dataOf(await request('/v2/invites/redeem', { code: invited.code, clientMutationId: mutation() }, { token: auth.token }), 'redeem');
    }
    const { rows: [membership] } = await pool.query('select entity_id as "memberId" from public.members where space_id=$1 and identity_id=$2', [space.id, auth.account.identityId]);
    return { token: auth.token, identityId: auth.account.identityId, memberId: membership?.memberId };
  };
  const member = await human('Synthetic second device owner', true);
  const stranger = await human('Synthetic nonmember', false);

  // Minimal synthetic session/persona; never starts an execution process.
  const agentId = randomUUID(), workSessionId = randomUUID(), sessionId = randomUUID();
  const secret = randomBytes(32).toString('base64url');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into public.entities(id,space_id,kind,visibility,created_by) values
      ($1,$3,'team_member','space',$4),($2,$3,'work_session','space',$4)`, [agentId, workSessionId, space.id, owner.memberId]);
    await client.query('insert into public.team_members(entity_id,owner_member_id,name) values($1,$2,$3)', [agentId, owner.memberId, 'Synthetic map agent']);
    await client.query(`insert into public.work_sessions(entity_id,title,status,share_mode,started_at)
      values($1,'Synthetic fixture session','running','space',now())`, [workSessionId]);
    await client.query(`insert into public.auth_sessions(id,account_id,kind,acting_as_team_member_id,work_session_id,space_id,token_hash,expires_at)
      values($1,$2,'agent',$3,$4,$5,$6,now()+interval '1 hour')`, [sessionId, owner.accountId, agentId, workSessionId, space.id, createHash('sha256').update(secret).digest('hex')]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
  return { spaceId: space.id, otherSpaceId: otherSpace.id, storyId: story.id, nestedStoryId: nested.id,
    taskId: task.id, docId: doc.id, foreignTaskId: foreignTask.id, foreignStoryId: foreignStory.id,
    owner, member, stranger, agent: { token: `tm8s_${sessionId}.${secret}`, agentId, workSessionId } };
}
