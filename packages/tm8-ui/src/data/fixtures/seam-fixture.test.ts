import { describe, expect, it } from 'vitest';
import {
  EntityDetailSchema,
  EntitySummarySchema,
  ProjectBranchTopologySchema,
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
  memberAda,
  taskGuideLines,
  taskUuidTitle,
  teamMemberForge,
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

describe('fixture seam — projectBranches (seam Amendment 6)', () => {
  it('answers schema-valid topology for the fixture project and not_found for others', async () => {
    const seam = await openSeam();

    const topology = await seam.projectBranches('proj-tm8ui');
    expect(ProjectBranchTopologySchema.safeParse(topology).success).toBe(true);
    expect(topology.defaultBranch).toBe('main');
    expect(topology.branches.some((b) => b.isCurrent)).toBe(true);

    await expect(seam.projectBranches('proj-nope')).rejects.toSatisfy(
      (e: unknown) => isCollabError(e) && e.code === 'not_found',
    );
  });

  it('honours limit (truncated flips) and staleAfterDays (stale re-derived from fixed dates)', async () => {
    const seam = await openSeam();

    const capped = await seam.projectBranches('proj-tm8ui', { limit: 2 });
    expect(capped.branches).toHaveLength(2);
    expect(capped.truncated).toBe(true);

    // At the default 30 days exactly one fixture branch is stale; at a huge
    // threshold none are. The option changes the ANSWER, not just the echo.
    const relaxed = await seam.projectBranches('proj-tm8ui', { staleAfterDays: 3650 });
    expect(relaxed.staleAfterDays).toBe(3650);
    expect(relaxed.branches.every((b) => !b.stale)).toBe(true);

    const strict = await seam.projectBranches('proj-tm8ui', { staleAfterDays: 1 });
    expect(strict.branches.filter((b) => b.stale).length).toBeGreaterThan(1);
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

  it('file uploads use the same grant → raw bytes → complete lifecycle as the real seam', async () => {
    const seam = await openSeam();
    const grant = await seam.files.uploadInit({
      clientMutationId: 'cmid-file-init',
      spaceId: FIXTURE_SPACE_ID,
      name: 'plan.txt',
      mime: 'text/plain',
      sizeBytes: 4,
      checksumSha256: 'a'.repeat(64),
    });
    await seam.files.putBytes(grant, new Blob(['plan']));
    const completed = await seam.files.complete(grant.uploadId, {
      clientMutationId: 'cmid-file-complete',
      targets: [taskGuideLines.id],
    });
    expect(completed.entity).toMatchObject({
      kind: 'file',
      title: 'plan.txt',
      state: { kind: 'file', name: 'plan.txt', mimeType: 'text/plain', sizeBytes: 4 },
    });
    await expect(seam.entity(completed.entity!.id)).resolves.toMatchObject({ kind: 'file' });

    const abandoned = await seam.files.uploadInit({
      clientMutationId: 'cmid-file-init-2',
      spaceId: FIXTURE_SPACE_ID,
      name: 'scratch.txt',
      mime: 'text/plain',
      sizeBytes: 0,
      checksumSha256: 'b'.repeat(64),
    });
    await expect(seam.files.abort(abandoned.uploadId, { clientMutationId: 'cmid-file-abort' }))
      .resolves.toMatchObject({ patches: [] });
    await expect(seam.files.putBytes(abandoned, new Blob())).rejects.toMatchObject({ code: 'not_found' });
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

/**
 * The write side of the relationship graph, added 2026-08-04.
 *
 * WHY IT MATTERS THAT THE PROJECTION MOVES, and not just that the edge lands:
 * `EntitySummary.state.assignees` is a PROJECTION of `assigned_to` (the real
 * node builds it in `entity-read.ts`). A fixture that stored the edge and left
 * `assignees` alone would be a seam that passes its own tests while the UI it
 * exists to exercise renders an assignment that never appears. Reads and
 * writes have to agree in the double, or the double is not one.
 */
describe('fixture seam — assignment edges reproject state.assignees', () => {
  const assigneesOf = (r: CommandResult) => {
    const state = r.patches[0]!.state as { assignees?: { id: string }[] };
    return (state.assignees ?? []).map((a) => a.id);
  };

  it('createEdge adds the actor to the projection, and is idempotent on (src, dst, type)', async () => {
    const seam = await openSeam();
    const first = await seam.commands.createEdge({
      srcId: taskGuideLines.id, dstId: memberAda.id, type: 'assigned_to',
      clientMutationId: 'cmid-edge-1',
    });
    expect(assigneesOf(first)).toContain(memberAda.id);

    // UPSERT, matching `write_edge` on the node: a double-click must not
    // assign the same person twice.
    const again = await seam.commands.createEdge({
      srcId: taskGuideLines.id, dstId: memberAda.id, type: 'assigned_to',
      clientMutationId: 'cmid-edge-2',
    });
    expect(assigneesOf(again).filter((id) => id === memberAda.id)).toHaveLength(1);
  });

  it('assigns an AGENT the same way it assigns a person', async () => {
    const seam = await openSeam();
    const result = await seam.commands.createEdge({
      srcId: taskGuideLines.id, dstId: teamMemberForge.id, type: 'assigned_to',
    });
    const state = result.patches[0]!.state as { assignees?: { id: string; isAgent: boolean }[] };
    expect(state.assignees?.find((a) => a.id === teamMemberForge.id)?.isAgent).toBe(true);
  });

  it('deleteEdge removes it again, addressed by the EDGE id the reads hand out', async () => {
    const seam = await openSeam();
    await seam.commands.createEdge({
      srcId: taskGuideLines.id, dstId: memberAda.id, type: 'assigned_to',
    });
    // The remove path is a read THEN a write: the projection carries the
    // actor, never the edge, so only `connections()` knows what to delete.
    const page = await seam.connections(taskGuideLines.id);
    const edge = page.items.find(
      (e) => e.type === 'assigned_to' && e.target.id === memberAda.id,
    )!;
    expect(edge).toBeDefined();

    const removed = await seam.commands.deleteEdge(edge.id);
    expect(assigneesOf(removed)).not.toContain(memberAda.id);
  });

  it('rejects an edge id it does not hold, rather than silently succeeding', async () => {
    const seam = await openSeam();
    await expect(seam.commands.deleteEdge('edge-that-never-was'))
      .rejects.toSatisfy(isCollabError);
  });
});

describe('fixture seam — server-parity of the Board wave (PR #253 review findings)', () => {
  it('a priority patch is a MOVE into state — the returned detail stays contract-valid', async () => {
    /* The node's `update_task_content` writes `tasks.priority`; `stateOf`
       projects it and `contentOf` never carries it. A fixture that merged it
       into content answered every post-patch read with a detail
       `EntityDetailSchema` refuses — contract-invalid in a way the real
       server never is. Same law for `dueDate`. */
    const seam = await openSeam();
    const before = await seam.entity(taskGuideLines.id);
    await seam.commands.patchEntity(taskGuideLines.id, {
      expectedVersion: before.version,
      content: { priority: 'high', dueDate: '2026-09-01' },
      clientMutationId: 'cmid-prio-1',
    });
    const after = await seam.entity(taskGuideLines.id);
    expect(after.state.kind === 'task' && after.state.priority).toBe('high');
    expect(after.state.kind === 'task' && after.state.dueDate).toBe('2026-09-01');
    expect('priority' in (after.content as Record<string, unknown>)).toBe(false);
    expect('dueDate' in (after.content as Record<string, unknown>)).toBe(false);
    expect(EntityDetailSchema.safeParse(after).success).toBe(true);
  });

  it('an EMPTY filter list is NO constraint, exactly as the server ignores it', async () => {
    const seam = await openSeam();
    const bare = await seam.query({ spaceId: FIXTURE_SPACE_ID, kinds: ['task'] });
    const empties = await seam.query({
      spaceId: FIXTURE_SPACE_ID, kinds: ['task'],
      filters: { priority: [], workStatus: [], assigneeIds: [] },
    });
    expect(empties.page.items.map((s) => s.id)).toEqual(bare.page.items.map((s) => s.id));
  });

  it('grouping buckets NON-tasks into the server defaults and hands back server labels', async () => {
    /* collections.ts groupItems: a non-task row lands in 'open' / 'medium' /
       Unassigned rather than vanishing from the groups it counts toward, and
       labels are display words ('High'), not raw keys ('high'). */
    const seam = await openSeam();
    const result = await seam.query({ spaceId: FIXTURE_SPACE_ID, groupBy: 'priority', limit: 100 });
    expect(result.groups).toBeDefined();
    const groups = result.groups!;
    // every fetched row is in exactly one priority bucket — none dropped
    const grouped = groups.reduce((n, g) => n + g.items.length, 0);
    expect(grouped).toBe(result.page.items.length);
    const medium = groups.find((g) => g.key === 'medium')!;
    expect(medium.label).toBe('Medium');
    // the non-task rows all defaulted into 'medium', so the bucket holds
    // more than the medium-priority tasks alone
    const mediumTasks = result.page.items.filter((s) => s.state.kind === 'task' && s.state.priority === 'medium');
    expect(medium.items.length).toBeGreaterThan(mediumTasks.length);
    const status = await seam.query({ spaceId: FIXTURE_SPACE_ID, kinds: ['task'], groupBy: 'workStatus', limit: 100 });
    expect(status.groups!.find((g) => g.key === 'in_review')!.label).toBe('In review');
  });

  it('129 parity: assignments record WHO assigned, and assignedByIds selects by it', async () => {
    const seam = await openSeam();
    /* Before any seam-made assignment, NO task carries `assignments` — the
       provenance filter matches nothing, exactly as pre-129 rows read NULL
       `assigned_by` on the node. */
    const before = await seam.query({
      spaceId: FIXTURE_SPACE_ID, kinds: ['task'],
      filters: { assignedByIds: [memberAda.id] },
    });
    expect(before.page.items).toHaveLength(0);

    const result = await seam.commands.createEdge({
      srcId: taskGuideLines.id, dstId: teamMemberForge.id, type: 'assigned_to',
    });
    /* The performer is the VIEWER, projected in the ENTITY id vocabulary —
       the same one the sibling `assignee` arm and the roster chips speak.
       (`act-ada` here would be a filter that can never match; the server has
       one id for both.) */
    const state = result.patches[0]!.state as {
      assignments?: { assignee: { id: string }; assignedBy: { id: string } | null; assignedAt: string }[];
    };
    expect(state.assignments?.map((a) => [a.assignee.id, a.assignedBy?.id])).toEqual([
      [teamMemberForge.id, memberAda.id],
    ]);

    // Her id now selects exactly the task she assigned…
    const hers = await seam.query({
      spaceId: FIXTURE_SPACE_ID, kinds: ['task'],
      filters: { assignedByIds: [memberAda.id] },
    });
    expect(hers.page.items.map((s) => s.id)).toEqual([taskGuideLines.id]);
    // …and the HOLDER's id selects nothing: the axis is provenance, not
    // possession — "tasks forge holds" is `assigneeIds`' question.
    const holders = await seam.query({
      spaceId: FIXTURE_SPACE_ID, kinds: ['task'],
      filters: { assignedByIds: [teamMemberForge.id] },
    });
    expect(holders.page.items).toHaveLength(0);
  });
});
