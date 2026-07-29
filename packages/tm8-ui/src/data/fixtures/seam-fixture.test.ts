import { describe, expect, it } from 'vitest';
import {
  EntityDetailSchema,
  EntitySummarySchema,
  GraphResultSchema,
  HandoffViewSchema,
  WORKSPACE_EVENT_SCHEMA_VERSION,
  isCollabError,
  type DurableWorkspaceEvent,
  type CommandResult,
  type WorkStatus,
} from '@tm8/contract';
import {
  FIXTURE_SPACE_ID,
  channelDesign,
  fixtureSummaries,
  messageAgentNullProvenance,
  sessionExited,
  sessionLive,
  sessionStale,
  taskGuideLines,
  taskUuidTitle,
} from '../../fixtures';
import type { ConnectionState, LivenessSnapshot } from '../seam';
import { createFixtureSeam } from './seam-fixture';

/** Drain the microtask queue so queueMicrotask-dispatched echoes land. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** work_session statuses travel through the locked seam type as WorkStatus. */
const asWorkStatus = (s: string): WorkStatus => s as WorkStatus;

async function openSeam() {
  const seam = createFixtureSeam();
  await seam.openSpace(FIXTURE_SPACE_ID);
  return seam;
}

describe('fixture seam — reads', () => {
  it('every read surface resolves with contract-shaped data', async () => {
    const seam = await openSeam();

    const identity = await seam.identity();
    expect(identity.username).toBe('ada');
    expect(identity.memberships[0]?.spaceId).toBe(FIXTURE_SPACE_ID);

    const spaces = await seam.spaces();
    expect(spaces.map((s) => s.id)).toEqual([FIXTURE_SPACE_ID]);

    const settings = await seam.spaceSettings(FIXTURE_SPACE_ID);
    expect(settings.defaultInteractionProfileId).toBe('ip-house-style');
    expect(settings.settingsRevision).toBe(1);

    const result = await seam.query({ spaceId: FIXTURE_SPACE_ID });
    expect(result.page.items.length).toBeGreaterThan(0);
    for (const s of result.page.items) {
      expect(EntitySummarySchema.safeParse(s).success, s.id).toBe(true);
    }

    const graph = await seam.graph({ spaceId: FIXTURE_SPACE_ID, layout: 'graph', limit: 150 });
    expect(GraphResultSchema.safeParse(graph).success).toBe(true);
    expect(graph.nodes.length).toBeGreaterThan(0);
    expect(graph.edges.length).toBeGreaterThan(0);
    const graphIds = new Set(graph.nodes.map((node) => node.id));
    expect(graph.edges.every((edge) => graphIds.has(edge.source.id) && graphIds.has(edge.target.id))).toBe(true);

    const detail = await seam.entity(taskUuidTitle.id);
    expect(EntityDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.hierarchy.parent?.id).toBe(channelDesign.id);

    const children = await seam.children(channelDesign.id);
    expect(children.items.some((c) => c.id === taskUuidTitle.id)).toBe(true);

    const connections = await seam.connections(taskUuidTitle.id);
    expect(connections.items.length).toBeGreaterThan(0);

    const activity = await seam.activity(taskUuidTitle.id);
    expect(activity.items[0]?.verb).toBeTypeOf('string');

    const messages = await seam.messages(taskGuideLines.id);
    expect(messages.items.length).toBeGreaterThan(0);
    expect(messages.items.every((m) => m.state.anchorId === taskGuideLines.id)).toBe(true);

    // A1c dataset: sessionLive is the target of the full legal delivery×record
    // matrix — the seam serves it end-to-end, every row contract-valid.
    const handoffs = await seam.handoffs(sessionLive.id);
    expect(handoffs.items.length).toBeGreaterThan(0);
    for (const h of handoffs.items) {
      expect(HandoffViewSchema.safeParse(h).success, h.handoffId).toBe(true);
      expect(h.targetWorkSessionId).toBe(sessionLive.id);
    }

    const inbox = await seam.inbox();
    expect(inbox.items).toEqual([]);

    const feed = await seam.feed(taskGuideLines.id);
    expect(feed.resolvedScope).toBe('direct_v1');
    expect(feed.items.every((i) => i.itemKind === 'message')).toBe(true);

    const kinds = await seam.entityKinds(FIXTURE_SPACE_ID);
    expect(kinds.map((k) => k.kind)).toEqual(['c:ritual']);
    expect(kinds[0]?.origin).toBe('custom');
  });

  it('entity() synthesizes a kind-correct detail for summaries without one', async () => {
    const seam = await openSeam();
    // taskGuideLines has no dataset detail — the seam must still answer.
    const detail = await seam.entity(taskGuideLines.id);
    expect(EntityDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.content.kind).toBe('task');
  });

  it('menu() resolves null (C-4 — the UI substitutes its shipped default)', async () => {
    const seam = await openSeam();
    await expect(seam.menu(FIXTURE_SPACE_ID)).resolves.toBeNull();
    await expect(seam.menu('sp-anything')).resolves.toBeNull();
  });

  it('query respects kinds / deleted / subtreeOf filters and pages honestly', async () => {
    const seam = await openSeam();

    const tasks = await seam.query({ spaceId: FIXTURE_SPACE_ID, kinds: ['task'], subtreeOf: channelDesign.id });
    expect(tasks.page.items.every((s) => s.kind === 'task')).toBe(true);
    // default deleted:'exclude' hides the tombstone
    expect(tasks.page.items.some((s) => s.id === 'task-tombstone')).toBe(false);

    const only = await seam.query({ spaceId: FIXTURE_SPACE_ID, filters: { deleted: 'only' } });
    expect(only.page.items.map((s) => s.id)).toEqual(['task-tombstone']);

    const paged = await seam.query({ spaceId: FIXTURE_SPACE_ID, limit: 3 });
    expect(paged.page.items).toHaveLength(3);
    expect(paged.page.nextCursor).toBe('3');
    expect(paged.page.total).toBeGreaterThan(3);
  });

  it('query implements the sessionStatus filter executor-side (D57: the contract declared it at dd41e89 — this asserts the fixture executor honors it)', async () => {
    const seam = await openSeam();

    const running = await seam.query({
      spaceId: FIXTURE_SPACE_ID, kinds: ['work_session'], filters: { sessionStatus: ['running'] },
    });
    const runningIds = running.page.items.map((s) => s.id);
    expect(runningIds).toContain(sessionLive.id);
    expect(runningIds).toContain(sessionStale.id); // stale is a RECORD 'running' — the filter reads the record, liveness verdicts are the seam's other surface
    expect(runningIds).not.toContain(sessionExited.id);

    const done = await seam.query({
      spaceId: FIXTURE_SPACE_ID, kinds: ['work_session'], filters: { sessionStatus: ['exited', 'failed'] },
    });
    const doneIds = done.page.items.map((s) => s.id);
    expect(doneIds).toContain(sessionExited.id);
    expect(doneIds).not.toContain(sessionLive.id);
    expect(done.page.items.every((s) => s.state.kind === 'work_session' && s.state.status !== 'running')).toBe(true);
  });

  it('delivery facets pass through UNCOLLAPSED — unknown stays unknown', async () => {
    const seam = await openSeam();
    const view = await seam.delivery(messageAgentNullProvenance.id);
    const statuses = view.deliveries.map((d) => d.status).sort();
    expect(statuses).toEqual(['delivered', 'unknown']);
    const unknown = view.deliveries.find((d) => d.status === 'unknown')!;
    expect(unknown.settledAt).toBeNull();
  });

  it('reads reject with CollabError not_found for unknown ids', async () => {
    const seam = await openSeam();
    for (const p of [seam.entity('nope'), seam.children('nope'), seam.messages('nope')]) {
      await expect(p).rejects.toSatisfy((e: unknown) => isCollabError(e) && e.code === 'not_found');
    }
  });
});

describe('fixture seam — commands + echo events', () => {
  it('command → CommandResult.patches + async echo event with cmid and full envelope', async () => {
    const seam = await openSeam();
    const events: DurableWorkspaceEvent[] = [];
    seam.onEvent((e) => events.push(e));

    const pending = seam.commands.createTask({
      spaceId: FIXTURE_SPACE_ID, title: 'echo me', parentId: channelDesign.id,
      clientMutationId: 'cmid-echo-1',
    });
    // the echo is asynchronous — nothing delivered before the microtask queue
    // drains (so a store can journal the optimistic entry first)
    expect(events).toHaveLength(0);
    const result = await pending as CommandResult;

    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].title).toBe('echo me');
    expect(result.entity?.content.kind).toBe('task');

    await flush();
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.type).toBe('entity.upsert');
    expect(e.clientMutationId).toBe('cmid-echo-1');
    expect(e.spaceId).toBe(FIXTURE_SPACE_ID);
    expect(e.seq).toBeTypeOf('number');
    expect(e.occurredAt).toMatch(/^2026-07-28T/);
    expect(e.schemaVersion).toBe(WORKSPACE_EVENT_SCHEMA_VERSION);
  });

  it('seqs are strictly increasing per space across mixed commands', async () => {
    const seam = await openSeam();
    const events: DurableWorkspaceEvent[] = [];
    seam.onEvent((e) => events.push(e));

    const t = (await seam.commands.createTask({
      spaceId: FIXTURE_SPACE_ID, title: 'seq run', clientMutationId: 'cmid-s1',
    }) as CommandResult).patches[0];
    await seam.commands.patchTask(t.id, { expectedVersion: 1, workStatus: 'working', clientMutationId: 'cmid-s2' });
    await seam.commands.react(t.id, { reaction: 'like', enabled: true, clientMutationId: 'cmid-s3' });
    await seam.commands.deleteEntity(t.id, { clientMutationId: 'cmid-s4' });
    await seam.commands.restoreEntity(t.id, { clientMutationId: 'cmid-s5' });
    await flush();

    expect(events.map((e) => e.clientMutationId)).toEqual(['cmid-s1', 'cmid-s2', 'cmid-s3', 'cmid-s4', 'cmid-s5']);
    const seqs = events.map((e) => e.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i], `seq[${i}]`).toBeGreaterThan(seqs[i - 1]);
  });

  it('events are delivered only for open spaces; results still resolve', async () => {
    const seam = createFixtureSeam(); // no openSpace
    const events: DurableWorkspaceEvent[] = [];
    seam.onEvent((e) => events.push(e));
    const result = await seam.commands.createTask({
      spaceId: FIXTURE_SPACE_ID, title: 'quiet space', clientMutationId: 'cmid-q1',
    }) as CommandResult;
    await flush();
    expect(result.patches[0].title).toBe('quiet space');
    expect(events).toHaveLength(0);
  });

  it('version mismatch rejects version_conflict carrying the current detail', async () => {
    const seam = await openSeam();
    const err = await seam.commands
      .patchTask(taskUuidTitle.id, { expectedVersion: 999, title: 'nope' })
      .then(() => null, (e: unknown) => e);
    expect(isCollabError(err) && err.code === 'version_conflict').toBe(true);
    expect(isCollabError(err) && err.current?.id).toBe(taskUuidTitle.id);
  });

  it('postMessage: single anchor → CommandResult, multi-anchor → MessageBatchResult', async () => {
    const seam = await openSeam();
    const events: DurableWorkspaceEvent[] = [];
    seam.onEvent((e) => events.push(e));

    const single = await seam.commands.postMessage({
      clientMutationId: 'cmid-m1', anchorIds: [taskGuideLines.id], body: 'hello from the seam test',
    });
    expect('patches' in single && single.patches.some((p) => p.id === taskGuideLines.id)).toBe(true);

    const batch = await seam.commands.postMessage({
      clientMutationId: 'cmid-m2', anchorIds: [taskGuideLines.id, taskUuidTitle.id], body: 'fan out',
    });
    expect('messageBatchId' in batch && batch.messages).toHaveLength(2);

    await flush();
    const created = events.filter((e) => e.type === 'message.created');
    expect(created).toHaveLength(3);
    // messages() reflects the mutation
    const msgs = await seam.messages(taskGuideLines.id);
    expect(msgs.items.some((m) => m.content.body === 'hello from the seam test')).toBe(true);
  });

  it('spawn/terminate drive the live set; prompt refuses a non-running session', async () => {
    const seam = await openSeam();
    const snaps: LivenessSnapshot[] = [];
    seam.liveness.onChange((s) => snaps.push(s));

    const spawned = (await seam.commands.spawn({
      clientMutationId: 'cmid-sp1', spaceId: FIXTURE_SPACE_ID,
      teamMemberId: 'ent-tm-forge', taskIds: [taskGuideLines.id],
    })).patches[0];
    expect(seam.liveness.statusOf({ id: spawned.id, workStatus: asWorkStatus('running') })).toBe('live');
    expect(snaps[snaps.length - 1]?.liveEntityIds).toContain(spawned.id);

    await seam.commands.terminate(spawned.id, { clientMutationId: 'cmid-sp2' });
    expect(snaps[snaps.length - 1]?.liveEntityIds).not.toContain(spawned.id);
    await expect(seam.commands.prompt(spawned.id, { message: 'hi' }))
      .rejects.toSatisfy((e: unknown) => isCollabError(e) && e.code === 'invariant_violation');
  });
});

describe('fixture seam — liveness predicate (R-UI-5)', () => {
  it('computes all four values; stale/live hold out of the box', async () => {
    const seam = await openSeam();
    const statusOf = (id: string, ws: string | null) =>
      seam.liveness.statusOf({ id, workStatus: ws === null ? null : asWorkStatus(ws) });

    // not-running: the record itself says so
    expect(statusOf(sessionExited.id, 'exited')).toBe('not-running');
    expect(statusOf(sessionExited.id, null)).toBe('not-running');
    // live: running AND in the snapshot's live set
    expect(statusOf(sessionLive.id, 'running')).toBe('live');
    // stale: running per record, NOT in the live set — never rendered live
    expect(statusOf(sessionStale.id, 'running')).toBe('stale');
    // unknown: no snapshot covers the session — neutral, never live
    expect(statusOf('ghost-session', 'running')).toBe('unknown');
  });

  it('refresh returns the current snapshot with nodeBootId', async () => {
    const seam = await openSeam();
    const snap = await seam.liveness.refresh(FIXTURE_SPACE_ID);
    expect(snap.liveEntityIds).toEqual([sessionLive.id]);
    expect(snap.nodeBootId).toBeTypeOf('string');
    expect(snap.checkedAt).toBeTypeOf('string');
  });
});

describe('fixture controls', () => {
  it('setConnection drives onConnection and getConnection', async () => {
    const seam = await openSeam();
    expect(seam.getConnection()).toEqual({ phase: 'live' });
    const seen: ConnectionState[] = [];
    const off = seam.onConnection((s) => seen.push(s));
    const polling: ConnectionState = { phase: 'polling', disconnectedSince: '2026-07-28T12:00:05.000Z' };
    seam.fixtureControls.setConnection(polling);
    expect(seen).toEqual([polling]);
    expect(seam.getConnection()).toEqual(polling);
    off();
    seam.fixtureControls.setConnection({ phase: 'live' });
    expect(seen).toHaveLength(1);
  });

  it('setLiveness drives onChange and flips statusOf', async () => {
    const seam = await openSeam();
    const snaps: LivenessSnapshot[] = [];
    seam.liveness.onChange((s) => snaps.push(s));
    seam.fixtureControls.setLiveness(FIXTURE_SPACE_ID, [], 'boot-2');
    expect(snaps).toHaveLength(1);
    expect(snaps[0].nodeBootId).toBe('boot-2');
    // previously-live session is now honestly stale
    expect(seam.liveness.statusOf({ id: sessionLive.id, workStatus: asWorkStatus('running') })).toBe('stale');
  });

  it('triggerResync fires onResync with the spaceId', async () => {
    const seam = await openSeam();
    const seen: string[] = [];
    seam.onResync((spaceId) => seen.push(spaceId));
    seam.fixtureControls.triggerResync(FIXTURE_SPACE_ID);
    expect(seen).toEqual([FIXTURE_SPACE_ID]);
  });
});

describe('dataset isolation', () => {
  it('two seam instances never share mutations; module fixtures stay pristine', async () => {
    const a = await openSeam();
    const b = await openSeam();
    const baselineTitle = taskUuidTitle.title;
    const baselineVersion = taskUuidTitle.version;
    const baselineCount = fixtureSummaries.length;

    await a.commands.patchTask(taskUuidTitle.id, { expectedVersion: baselineVersion, title: 'mutated in A' });
    await a.commands.deleteEntity(taskGuideLines.id);
    await a.commands.createTask({ spaceId: FIXTURE_SPACE_ID, title: 'only in A' });

    // B sees the pristine dataset
    const inB = await b.entity(taskUuidTitle.id);
    expect(inB.title).toBe(baselineTitle);
    expect(inB.version).toBe(baselineVersion);
    expect((await b.entity(taskGuideLines.id)).deletedAt).toBeNull();
    await expect(b.query({ spaceId: FIXTURE_SPACE_ID })).resolves.toSatisfy(
      (r) => !r.page.items.some((s: { title: string }) => s.title === 'only in A'),
    );

    // the module-level dataset objects were never touched
    expect(taskUuidTitle.title).toBe(baselineTitle);
    expect(taskUuidTitle.version).toBe(baselineVersion);
    expect(fixtureSummaries.length).toBe(baselineCount);
  });

  it('returned objects are defensive copies — caller mutation cannot corrupt the seam', async () => {
    const seam = await openSeam();
    const d1 = await seam.entity(taskUuidTitle.id);
    d1.title = 'vandalized';
    const d2 = await seam.entity(taskUuidTitle.id);
    expect(d2.title).toBe(taskUuidTitle.title);
  });
});
