import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureRoot, claimsFor, rootClaims, json, scalar, ok, denied, runAsync, uuid, literal, cmid, OWNER_URL } from './helpers.mjs';

ensureRoot();
for (const who of ['a','b']) json(`select public.ensure_account('identity-placement-${who}','placement-${who}','Placement ${who}',null,false,false)`,{claims:rootClaims()});
const spaceA = json("select public.create_space('Placement A','test','private')",{claims:claimsFor('identity-placement-a')});
const spaceB = json("select public.create_space('Placement B','test','private')",{claims:claimsFor('identity-placement-b')});
const w = {
  spaceA:spaceA.space.id,spaceB:spaceB.space.id,memberA:spaceA.memberId,memberB:spaceB.memberId,
  channelA:spaceA.defaultChannelId,claimsA:claimsFor('identity-placement-a',spaceA.memberId),claimsB:claimsFor('identity-placement-b',spaceB.memberId),
};
w.taskA = json(`select public.create_task(${uuid(w.spaceA)},'Existing task')`,{claims:w.claimsA}).entity.id;
w.taskB = json(`select public.create_task(${uuid(w.spaceB)},'Other task')`,{claims:w.claimsB}).entity.id;
w.personaA = json(`select public.create_team_member(${uuid(w.spaceA)},'Placement agent')`,{claims:w.claimsA}).entity.id;
const create = (title, parent = null) => json(`select public.create_task(${uuid(w.spaceA)}, ${literal(title)}, null, '', '{}'::jsonb, ${uuid(parent)})`, { claims: w.claimsA }).entity;
const read = (id, claims = w.claimsA) => json(`select to_jsonb(e) from public.entities e where id=${uuid(id)}`, { claims });
const ids = (parent = null) => json(`select coalesce(jsonb_agg(id order by position,id),'[]') from public.entities where space_id=${uuid(w.spaceA)} and kind='task' and parent_id is not distinct from ${uuid(parent)} and deleted_at is null`, { claims: w.claimsA });
const placeSql = (id, target, relation, version, mutation = cmid('place')) => `select public.move_entity_relative(${uuid(id)},${uuid(target)},${literal(relation)},${version},null,${literal(mutation)})`;
const place = (row, target, relation, claims = w.claimsA) => json(placeSql(row.id, target, relation, read(row.id).version), { claims });

const identityC = 'identity-placement-c';
json(`select public.ensure_account(${literal(identityC)},'placement-c','Peer',null,false,false)`, { claims: rootClaims() });
const invite = json(`select public.create_invite(${uuid(w.spaceA)},5)`, { claims: w.claimsA }).invite;
const memberC = json(`select public.redeem_invite(${literal(invite.code)})`, { claims: claimsFor(identityC) }).memberId;
const claimsC = claimsFor(identityC, memberC);

test('roots and children insert first; concurrent inserts have distinct ranks', async () => {
  const root = create('Parent');
  const first = create('First child', root.id); const second = create('Second child', root.id);
  assert.deepEqual(ids(root.id), [second.id, first.id]);
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runAsync(
    `select public.create_task(${uuid(w.spaceA)},'Concurrent ${i}',null,'','{}'::jsonb,${uuid(root.id)})`, { claims: i % 2 ? claimsC : w.claimsA })));
  for (const result of results) assert.ok(result.ok, result.stderr);
  const inserted = results.map((r) => JSON.parse(r.stdout.split('\n').find((line) => line.startsWith('{'))).entity);
  assert.equal(new Set(inserted.map((r) => r.position)).size, 8);
  assert.ok(inserted.every((r) => r.position < second.position));
  assert.deepEqual(ids(root.id).slice(-2), [second.id, first.id]);
  const newest = create('Newest root'); assert.equal(ids()[0], newest.id);
});

test('shared placement moves a whole subtree; two authorized readers see identical rows and events', () => {
  const parent = create('Moving parent'); const child = create('Child', parent.id); const grandchild = create('Grandchild', child.id); const target = create('Destination');
  const seq = scalar(`select coalesce(max(seq),0) from public.workspace_events where space_id=${uuid(w.spaceA)}`, { url: OWNER_URL });
  place(parent, target.id, 'inside', claimsC);
  assert.equal(read(parent.id).parent_id, target.id);
  assert.deepEqual(read(parent.id, claimsC), read(parent.id));
  assert.equal(read(child.id).parent_id, parent.id); assert.equal(read(grandchild.id).parent_id, child.id);
  // Poll the same durable feed as two independently authorized clients.
  const eventQuery = `select coalesce(jsonb_agg(to_jsonb(e) order by seq),'[]') from public.workspace_events e where space_id=${uuid(w.spaceA)} and seq>${seq}`;
  const events = json(eventQuery, { claims: w.claimsA });
  assert.deepEqual(json(eventQuery, { claims: claimsC }), events);
  assert.ok(events.some((event) => JSON.stringify(event).includes(parent.id)));
  denied('cycle', placeSql(target.id, grandchild.id, 'inside', read(target.id).version), { claims: w.claimsA });
  denied('outsider', placeSql(parent.id, null, 'inside', read(parent.id).version), { claims: w.claimsB });
  denied('cross-kind', placeSql(parent.id, w.channelA, 'inside', read(parent.id).version), { claims: w.claimsA });
  denied('cross-space', placeSql(parent.id, w.taskB, 'inside', read(parent.id).version), { claims: w.claimsA });
});

test('competing moves serialize and stale versions refuse; opposing moves cannot create a cycle', async () => {
  const a = create('Race A'); const b = create('Race B'); const c = create('Race C');
  const result = await Promise.all([
    runAsync(placeSql(a.id,b.id,'inside',a.version), { claims: w.claimsA }),
    runAsync(placeSql(a.id,c.id,'inside',a.version), { claims: claimsC }),
  ]);
  assert.equal(result.filter((r) => r.ok).length, 1, JSON.stringify(result));
  const x = create('Cycle X'); const y = create('Cycle Y');
  const opposing = await Promise.all([
    runAsync(placeSql(x.id,y.id,'inside',x.version), { claims: w.claimsA }),
    runAsync(placeSql(y.id,x.id,'inside',y.version), { claims: claimsC }),
  ]);
  assert.equal(opposing.filter((r) => r.ok).length, 1, JSON.stringify(opposing));
});

test('precision exhaustion rebalances without changing sibling order or losing target intent', () => {
  const parent = create('Precision'); const a = create('A',parent.id); const b = create('B',parent.id); const moving = create('M');
  ok(`update public.entities set position=case id when ${uuid(a.id)} then 1 else 1.0000000000000002 end where id in (${uuid(a.id)},${uuid(b.id)})`, { url: OWNER_URL });
  place(moving,b.id,'before');
  assert.deepEqual(ids(parent.id),[a.id,moving.id,b.id]);
  const epoch = Number(scalar(`select revision from public.entity_placement_revisions where space_id=${uuid(w.spaceA)}`, { claims: claimsC }));
  assert.ok(epoch > 0);
  const last = create('Equal rank',parent.id);
  ok(`update public.entities set position=1024 where id in (${uuid(a.id)},${uuid(last.id)})`, { url: OWNER_URL });
  place(moving,last.id,'before');
  const order = ids(parent.id); assert.equal(order[order.indexOf(last.id)-1],moving.id);
});

test('session placement is authorized presentation only; lifecycle and activity keep rank and parent', () => {
  const spawn = (title) => json(`select public.execution_spawn(${uuid(w.spaceA)},${uuid(w.personaA)},'{}'::uuid[],null,'project',null,null,null,null,null,${literal(title)},'node-1',true,64,null,${literal(cmid('spawn'))})`, { claims: w.claimsA }).entity;
  const a = spawn('Session A'); const b = spawn('Session B');
  const sessionBefore = json(`select to_jsonb(s) from public.work_sessions s where entity_id=${uuid(a.id)}`, { claims: w.claimsA });
  place(a,b.id,'inside',claimsC);
  const placed = read(a.id);
  assert.equal(placed.parent_id,b.id);
  assert.deepEqual(json(`select to_jsonb(s) from public.work_sessions s where entity_id=${uuid(a.id)}`, { claims: w.claimsA }),sessionBefore);
  json(`select public.rename_work_session(${uuid(a.id)},${placed.version},null,'Renamed',${literal(cmid('rename'))})`, { claims: w.claimsA });
  json(`select public.work_session_transition(${uuid(a.id)},'failed',1,'Test launch failure')`, { claims: w.claimsA });
  ok(`update public.entities set activity_at=now() where id=${uuid(a.id)}`, { url: OWNER_URL });
  assert.equal(read(a.id).position,placed.position); assert.equal(read(a.id).parent_id,placed.parent_id);
  denied('session cycle',placeSql(b.id,a.id,'inside',read(b.id).version),{claims:w.claimsA});
});
