/**
 * World builder — the black-box replacement for the UI foundation tests'
 * seeded MockFacade. Conformance owns no server internals, so each suite
 * builds its narrative through the public API itself: a space, channels, an
 * epic with children, dependencies, a persona, docs, messages, points.
 *
 * Against the G0 stub every call here 501s, which is exactly the red signal
 * the gate wants. Against a conformant server this must succeed end-to-end.
 */
import type { EntityDetail, EntitySummary } from '@tm8/contract';
import { api } from './client.js';
import { randomUUID } from 'node:crypto';

export interface World {
  spaceId: string;
  chGeneral: string;
  chBuild: string;
  epic: string;      // T-100 parent
  t101: string;      // done-able leaf (has criteria, attached to build)
  t102: string;      // dependency target
  t103: string;      // depends_on t102 (hard) → blocked
  t104: string;      // free task for pull/work flows
  forge: string;     // team_member persona
  docSpec: string;   // doc attached to build
  rootMessage: string;
  viewerId: string;
  depEdgeId: string;
}

function cmid(label: string): string {
  return `cmid-${label}-${randomUUID()}`;
}

async function createEntity(input: Record<string, unknown>): Promise<EntityDetail> {
  const res = (await api.command('entities.create', input)) as { entity?: EntityDetail };
  if (!res.entity) throw new Error('entities.create returned no entity');
  return res.entity;
}

export async function buildWorld(prefix: string): Promise<World> {
  const spaceName = `conf-${prefix}-${randomUUID().slice(0, 8)}`;
  const space = (await api.command('spaces.create', { name: spaceName, clientMutationId: cmid('space') })) as { id?: string } & Record<string, unknown>;
  const spaceId = (space.id ?? (space as { space?: { id: string } }).space?.id) as string;
  if (!spaceId) throw new Error('spaces.create returned no space id');

  const nav = (await api.read('spaces.navigation', { spaceId })) as {
    viewer: { id: string };
    // Nav channels are TREE NODES wrapping a summary, not bare summaries.
    channels?: Array<{ entity?: { id: string; title?: string } }>;
  };
  const viewerId = nav.viewer.id;

  // `general` is NOT ours to create. `create_space` already seeds the space
  // with an owner member, a `general` channel and the default `type` task axis
  // in one transaction (007:424), and `channels` is UNIQUE (space_id, name)
  // (001:507). Creating it here collided with the space's own channel on every
  // single run — a 409 that aborted buildWorld before one suite executed. The
  // server is right and the world builder was wrong: adopt the seeded channel.
  const seededGeneral = nav.channels?.find((c) => c.entity?.title === 'general')?.entity;
  if (!seededGeneral) {
    throw new Error(
      "spaces.navigation did not report the 'general' channel that create_space seeds — " +
        'the world builder cannot adopt it',
    );
  }
  const chGeneral = seededGeneral.id;
  const chBuild = (await createEntity({ spaceId, kind: 'channel', title: 'build', content: { topic: 'The build' }, clientMutationId: cmid('ch2') })).id;

  const epic = (await createEntity({
    spaceId, kind: 'task', title: 'T-100 · Conformance epic',
    content: { description: 'Parent of the conformance narrative.', priority: 'high', axes: { type: 'code' } },
    clientMutationId: cmid('t100'),
  })).id;

  const t101 = (await createEntity({
    spaceId, kind: 'task', title: 'T-101 · Schema foundation', parentId: epic, position: 1,
    content: {
      description: 'Lay the schema.', priority: 'medium', axes: { type: 'code' },
      acceptanceCriteria: [{ text: 'tables exist' }, { text: 'triggers fire' }],
    },
    attachTo: { entityId: chBuild, edgeType: 'attached_to' },
    clientMutationId: cmid('t101'),
  })).id;

  const t102 = (await createEntity({
    spaceId, kind: 'task', title: 'T-102 · RLS policies', parentId: epic, position: 2,
    content: { description: 'Guard the graph.', priority: 'urgent', axes: { type: 'code' } },
    clientMutationId: cmid('t102'),
  })).id;

  const t103 = (await createEntity({
    spaceId, kind: 'task', title: 'T-103 · Facade routes', parentId: epic, position: 3,
    content: { description: 'Bind the catalog.', priority: 'medium', axes: { type: 'design' } },
    clientMutationId: cmid('t103'),
  })).id;

  const t104 = (await createEntity({
    spaceId, kind: 'task', title: 'T-104 · Entity panel UI', parentId: epic, position: 4,
    content: { description: 'Z3/Z4 panels.', priority: 'low', axes: { type: 'design' } },
    clientMutationId: cmid('t104'),
  })).id;

  const dep = (await api.command('edges.create', {
    srcId: t103, dstId: t102, type: 'depends_on', props: { hard: true }, clientMutationId: cmid('dep'),
  })) as { edge?: { id: string } };
  const depEdgeId = dep.edge?.id ?? '';

  const forge = (await createEntity({
    spaceId, kind: 'team_member', title: 'Forge',
    content: { identity: 'Implementer persona for conformance.', model: 'claude-opus-4-8', agentTool: 'claude-code' },
    clientMutationId: cmid('forge'),
  })).id;

  await api.command('edges.create', { srcId: t101, dstId: forge, type: 'assigned_to', clientMutationId: cmid('assign') });

  const docSpec = (await createEntity({
    spaceId, kind: 'doc', title: 'Conformance spec',
    content: { body: '# Spec\nEverything through one contract.', format: 'markdown' },
    attachTo: { entityId: chBuild, edgeType: 'attached_to' },
    clientMutationId: cmid('doc'),
  })).id;

  const msg = (await api.command('messages.post', {
    anchorId: t101, body: 'Progress: schema drafted.', clientMutationId: cmid('msg'),
  })) as { entity?: { id: string } };
  const rootMessage = msg.entity?.id ?? '';

  // Points go to the PERSONA, not the task. `grant_points` (007:1577) refuses
  // anything that is not a member or team_member — "points are granted to a
  // member or team_member" (22023) — and it is right to: points are earned by
  // someone, and a task cannot earn anything. This targeted t101 (a task), so
  // buildWorld raised 400 even once the channel collision was fixed.
  await api.command('entities.points.add', { amount: 5, reason: 'grant', clientMutationId: cmid('pts') }, { id: forge });

  return { spaceId, chGeneral, chBuild, epic, t101, t102, t103, t104, forge, docSpec, rootMessage, viewerId, depEdgeId };
}

/** Zod assertion helper with readable failure output. */
export function expectValid<T>(schema: { safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] }; data?: T } }, value: unknown, label: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new Error(`${label} failed contract schema:\n${JSON.stringify(r.error?.issues, null, 2)}\nvalue: ${JSON.stringify(value, null, 2).slice(0, 2000)}`);
  }
  return r.data as T;
}

export function summariesOf(page: unknown): EntitySummary[] {
  return (page as { items: EntitySummary[] }).items;
}
