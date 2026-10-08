/** Volume-only setup in the owned synthetic DB; HTTP reads are production reads. */
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export async function measureSyntheticUnread(node) {
  const space = (await node.request('/v2/spaces', { name: 'Synthetic unread volume', clientMutationId: randomUUID() })).space;
  const author = (await node.request('/v2/entities', { kind: 'team_member', spaceId: space.id,
    title: 'Synthetic volume author', clientMutationId: randomUUID() })).entity.id;
  const anchors = Array.from({ length: 120 }, () => randomUUID());
  const messages = 6000;
  const client = await node.pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into public.entities(id,space_id,kind,created_by)
      select id,$2,'task',$3 from unnest($1::uuid[]) id`, [anchors, space.id, author]);
    await client.query(`insert into public.tasks(entity_id,title,work_status)
      select id,'Synthetic volume anchor','open' from unnest($1::uuid[]) id`, [anchors]);
    const ids = Array.from({ length: messages }, () => randomUUID());
    await client.query(`insert into public.entities(id,space_id,kind,created_by)
      select id,$2,'message',$3 from unnest($1::uuid[]) id`, [ids, space.id, author]);
    await client.query(`insert into public.messages(entity_id,anchor_id,author_id,body)
      select id,($2::uuid[])[((ordinality-1)%120)+1],$3,'Synthetic volume message'
      from unnest($1::uuid[]) with ordinality as rows(id,ordinality)`, [ids, anchors, author]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  const timings = [];
  for (let index = 0; index < 8; index++) {
    const start = performance.now();
    const snapshot = await node.request(`/v2/spaces/${space.id}/unread-counts`);
    timings.push(performance.now() - start);
    if (!snapshot.complete || snapshot.counts.length !== 120 ||
      snapshot.counts.reduce((sum, row) => sum + row.unread, 0) !== messages) throw new Error('Synthetic volume unread mismatch');
  }
  const sorted = [...timings].sort((a, b) => a - b);
  return { anchors: anchors.length, messages, requests: timings.length, milliseconds: timings,
    median: (sorted[3] + sorted[4]) / 2, maximum: sorted.at(-1),
    setup: 'Owned synthetic SQL volume fixture; route reads use real HTTP membership and RLS' };
}
