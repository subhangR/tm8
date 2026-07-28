import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  successData,
  type W3PublicServer,
} from './public-harness.js';

/**
 * W3 public gate for W2.G02 — the nineteen universal-entity, entity-command and
 * tracking operations, exercised through the REAL production HTTP boundary that
 * `startW3PublicServer` boots from `bootstrap()`.
 *
 * Every domain prerequisite below is created through a PUBLIC operation.
 * `harness.rows` is used only to OBSERVE — never to manufacture a fixture the
 * public surface refused to produce, because a fixture written by direct DML
 * proves nothing about the operation that was supposed to write it.
 *
 * Where a law already holds and no natural red is reachable, the assertion is
 * PROBE-RED in place: the same `it` feeds the input that should violate the law
 * and shows the check catches it, so a passing line is evidence of a
 * discriminating test rather than of a vacuous one.
 */

interface Counters {
  likes: number;
  dislikes: number;
  stars: number;
  points: number;
  messages: number;
  viewerReaction: string | null;
}

interface SummaryLike {
  id: string;
  spaceId: string;
  kind: string;
  title: string;
  parentId: string | null;
  position: number;
  version: number;
  deletedAt: string | null;
  counters: Counters;
  state: { kind: string } & Record<string, unknown>;
}

interface EdgeViewLike {
  id: string;
  type: string;
  source: { id: string };
  target: { id: string };
  props: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

interface HierarchyLike {
  parent: SummaryLike | null;
  path: SummaryLike[];
  children: { items: SummaryLike[]; nextCursor: string | null };
}

interface DetailLike extends SummaryLike {
  content: { kind: string } & Record<string, unknown>;
  hierarchy: HierarchyLike;
  connections: {
    outgoing: Array<{ type: string; direction: string; label: string; edges: EdgeViewLike[] }>;
    incoming: Array<{ type: string; direction: string; label: string; edges: EdgeViewLike[] }>;
    unresolvedHardDependencyCount: number;
  };
  capabilities: Record<string, boolean>;
}

interface CommandResultLike {
  entity?: DetailLike;
  edge?: EdgeViewLike;
  activity?: { id: string; verb: string; entityId: string | null };
  patches: SummaryLike[];
  undo?: { token: string; label: string; expiresAt?: string };
}

interface PageLike<T> {
  items: T[];
  nextCursor: string | null;
}

interface VersionItem {
  entityId: string;
  version: number;
  snapshot: Record<string, unknown>;
  changedBy: { id: string } | null;
  changedAt: string;
}

interface ActivityItemLike {
  id: string;
  entityId: string | null;
  actor: { id: string } | null;
  verb: string;
  summary: Record<string, unknown>;
  createdAt: string;
  refId: string | null;
  workSessionId: string | null;
}

interface RefreshAccepted {
  accepted: boolean;
  status: string;
  requestIds: string[];
}

const ABSENT_UUID = '00000000-0000-4000-8000-0000000000ff';

describe.sequential('W3.G02 universal entities, commands and tracking through the production Server', () => {
  let harness: W3PublicServer;
  let spaceId = '';
  let memberId = '';
  let otherSpaceId = '';
  let otherSpaceTask = '';

  const createTask = async (
    suffix: string,
    extra: Record<string, unknown> = {},
    targetSpace?: string,
  ): Promise<string> => {
    const created = successData<CommandResultLike>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: `w3-g02-fixture-${suffix}`,
        spaceId: targetSpace ?? spaceId,
        kind: 'task',
        title: `G02 ${suffix}`,
        ...extra,
      }),
    );
    if (!created.entity) throw new Error(`fixture ${suffix} returned no entity`);
    return created.entity.id;
  };

  const versionOf = async (id: string): Promise<number> => {
    const detail = successData<DetailLike>(await harness.request('GET', `/v2/entities/${id}`));
    return detail.version;
  };

  beforeAll(async () => {
    harness = await startW3PublicServer('g02');
    const space = successData<{ space: { id: string }; memberId: string; defaultChannelId: string }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g02-space',
        name: 'W3 G02 public gate',
      }),
    );
    spaceId = space.space.id;
    memberId = space.memberId;

    const other = successData<{ space: { id: string }; memberId: string }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g02-space-other',
        name: 'W3 G02 neighbouring space',
      }),
    );
    otherSpaceId = other.space.id;
    otherSpaceTask = await createTask('other-space-task', {}, otherSpaceId);
  }, 180_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  // -------------------------------------------------------------------------
  // A. Envelope + transport
  // -------------------------------------------------------------------------

  it('A: wraps success in {data, requestId} matching the header, and returns 201 on entities.create', async () => {
    // /health is deliberately OUTSIDE the operation envelope.
    const health = await harness.request<never>('GET', '/health');
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true, server: 'tm8-server' });
    expect(health.body.data).toBeUndefined();
    expect(health.body.requestId).toBeUndefined();

    // entities.create — 201 is the EXPECTED success status, not an anomaly.
    const created = await harness.request<CommandResultLike>('POST', '/v2/entities', {
      clientMutationId: 'w3-g02-envelope-create',
      spaceId,
      kind: 'task',
      title: 'G02 envelope task',
      content: { priority: 'high', description: 'envelope probe' },
    });
    expect(created.status).toBe(201);
    expect(created.contentType).toContain('application/json');
    expect(Object.keys(created.body).sort()).toEqual(['data', 'requestId']);
    expect(created.requestIdHeader).toBe(created.body.requestId);
    const createdResult = successData<CommandResultLike>(created);
    expect(createdResult.entity).toMatchObject({ kind: 'task', title: 'G02 envelope task', version: 1 });

    // The error envelope is closed the same way, header included.
    const missing = await harness.request('GET', `/v2/entities/${ABSENT_UUID}`);
    expect(missing.status).toBe(404);
    expect(errorCode(missing)).toBe('not_found');
    expect(Object.keys(missing.body)).toEqual(['error']);
    expect(Object.keys(missing.body.error ?? {}).sort())
      .toEqual(['code', 'message', 'requestId', 'retryable']);
  }, 60_000);

  // -------------------------------------------------------------------------
  // B. Strict input
  // -------------------------------------------------------------------------

  it('B: refuses unknown keys, malformed JSON and out-of-domain values with the closed envelope and NO write', async () => {
    const target = await createTask('strict');

    const unknownKey = await harness.request('POST', '/v2/entities', {
      clientMutationId: 'w3-g02-strict-unknown',
      spaceId,
      kind: 'task',
      title: 'G02 must not land',
      unknownField: true,
    });
    expect(unknownKey.status).toBe(400);
    expect(errorCode(unknownKey)).toBe('invalid_input');

    const badReaction = await harness.request('PUT', `/v2/entities/${target}/reaction`, {
      clientMutationId: 'w3-g02-strict-reaction',
      reaction: 'love',
      enabled: true,
    });
    expect(badReaction.status).toBe(400);
    expect(errorCode(badReaction)).toBe('invalid_input');

    const zeroPoints = await harness.request('POST', `/v2/entities/${memberId}/points`, {
      clientMutationId: 'w3-g02-strict-points',
      amount: 0,
      reason: 'grant',
    });
    expect(zeroPoints.status).toBe(400);
    expect(errorCode(zeroPoints)).toBe('invalid_input');

    const noExpectedVersion = await harness.request('PATCH', `/v2/entities/${target}`, {
      clientMutationId: 'w3-g02-strict-noversion',
      title: 'G02 must not land either',
    });
    expect(noExpectedVersion.status).toBe(400);
    expect(errorCode(noExpectedVersion)).toBe('invalid_input');

    // A malformed body is malformed whatever it was aimed at — sent raw,
    // because the harness helper can only serialise well-formed JSON.
    const malformed = await fetch(new URL('/v2/entities', harness.baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    const malformedBody = await malformed.json() as { error?: { code: string; requestId?: string } };
    expect(malformed.status).toBe(400);
    expect(malformedBody.error?.code).toBe('invalid_input');
    expect(malformed.headers.get('x-tm8-request-id')).toBe(malformedBody.error?.requestId);

    // Absence of effect, proven in the database rather than inferred.
    const rows = await harness.rows<{ ledger: number; strays: number; title: string; version: number }>(
      `select
         (select count(*)::integer from public.command_ledger
           where client_mutation_id like 'w3-g02-strict-%') ledger,
         (select count(*)::integer from public.entities
           where space_id = $1 and id in (
             select entity_id from public.tasks where title like 'G02 must not land%')) strays,
         (select title from public.tasks where entity_id = $2) title,
         (select version from public.entities where id = $2) version`,
      [spaceId, target],
    );
    expect(rows[0]).toEqual({ ledger: 0, strays: 0, title: 'G02 strict', version: 1 });

    // PROBE-RED: the same shape MINUS the offending key does land, so the
    // assertions above discriminate rather than rejecting everything.
    const accepted = successData<CommandResultLike>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-g02-strict-probe-ok',
        spaceId,
        kind: 'task',
        title: 'G02 strict probe',
      }),
    );
    expect(accepted.entity?.title).toBe('G02 strict probe');
  }, 60_000);

  // -------------------------------------------------------------------------
  // C. Idempotency
  // -------------------------------------------------------------------------

  it('C: replays a repeated clientMutationId with exactly one ledger row and one entity', async () => {
    const body = {
      clientMutationId: 'w3-g02-idem-create',
      spaceId,
      kind: 'task',
      title: 'G02 idempotent task',
      content: { priority: 'low' },
    };
    const first = await harness.request<CommandResultLike>('POST', '/v2/entities', body);
    const replay = await harness.request<CommandResultLike>('POST', '/v2/entities', body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    const firstResult = successData<CommandResultLike>(first);
    const replayResult = successData<CommandResultLike>(replay);
    expect(replayResult).toEqual(firstResult);

    const entityId = firstResult.entity!.id;

    // A command with a body is replayed too, not only a create.
    const reactBody = {
      clientMutationId: 'w3-g02-idem-react',
      reaction: 'star',
      enabled: true,
    };
    const reacted = successData<CommandResultLike>(
      await harness.request('PUT', `/v2/entities/${entityId}/reaction`, reactBody),
    );
    const reactedReplay = successData<CommandResultLike>(
      await harness.request('PUT', `/v2/entities/${entityId}/reaction`, reactBody),
    );
    expect(reactedReplay).toEqual(reacted);

    const rows = await harness.rows<{
      create_ledger: number;
      react_ledger: number;
      entities: number;
      star_edges: number;
    }>(
      `select
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g02-idem-create') create_ledger,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g02-idem-react') react_ledger,
         (select count(*)::integer from public.entities e
           join public.tasks t on t.entity_id = e.id
          where e.space_id = $1 and t.title = 'G02 idempotent task') entities,
         (select count(*)::integer from public.edges
           where dst_id = $2 and type = 'stars') star_edges`,
      [spaceId, entityId],
    );
    expect(rows[0]).toEqual({ create_ledger: 1, react_ledger: 1, entities: 1, star_edges: 1 });

    // PROBE-RED: the SAME intent under a DIFFERENT clientMutationId is a second
    // effect. Without this, "one row" could just mean creates never duplicate.
    const distinct = successData<CommandResultLike>(
      await harness.request('POST', '/v2/entities', { ...body, clientMutationId: 'w3-g02-idem-create-2' }),
    );
    expect(distinct.entity!.id).not.toBe(entityId);
    const after = await harness.rows<{ entities: number }>(
      `select count(*)::integer entities from public.entities e
         join public.tasks t on t.entity_id = e.id
        where e.space_id = $1 and t.title = 'G02 idempotent task'`,
      [spaceId],
    );
    expect(after[0]!.entities).toBe(2);
  }, 60_000);

  // -------------------------------------------------------------------------
  // D. Optimistic concurrency
  // -------------------------------------------------------------------------

  it('D: conflicts a stale entities.patch expectedVersion with no partial write', async () => {
    const target = await createTask('occ', { content: { description: 'original body' } });

    const patched = successData<CommandResultLike>(
      await harness.request('PATCH', `/v2/entities/${target}`, {
        clientMutationId: 'w3-g02-occ-first',
        expectedVersion: 1,
        title: 'G02 occ v2',
      }),
    );
    expect(patched.entity).toMatchObject({ title: 'G02 occ v2', version: 2 });

    const stale = await harness.request<CommandResultLike>('PATCH', `/v2/entities/${target}`, {
      clientMutationId: 'w3-g02-occ-stale',
      expectedVersion: 1,
      title: 'G02 occ MUST NOT LAND',
      content: { description: 'must not land either' },
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');
    // The loser is told what it lost the race to, rather than having to ask.
    expect((stale.body.error?.details as { current?: { version: number } } | undefined)?.current)
      .toMatchObject({ id: target, version: 2, title: 'G02 occ v2' });

    const rows = await harness.rows<{
      version: number;
      title: string;
      description: string;
      ledger: number;
      versions: number;
    }>(
      `select e.version, t.title, t.description,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = 'w3-g02-occ-stale') ledger,
              (select count(*)::integer from public.entity_versions where entity_id = $1) versions
         from public.entities e join public.tasks t on t.entity_id = e.id
        where e.id = $1`,
      [target],
    );
    expect(rows[0]).toMatchObject({
      version: 2,
      title: 'G02 occ v2',
      description: 'original body',
      ledger: 0,
    });

    // PROBE-RED: the CURRENT version is accepted, so the guard rejects staleness
    // rather than rejecting every patch.
    const fresh = successData<CommandResultLike>(
      await harness.request('PATCH', `/v2/entities/${target}`, {
        clientMutationId: 'w3-g02-occ-fresh',
        expectedVersion: 2,
        content: { description: 'second body' },
      }),
    );
    expect(fresh.entity).toMatchObject({ version: 3 });
  }, 60_000);

  // -------------------------------------------------------------------------
  // E. Command safety — work must not cross into `done`
  // -------------------------------------------------------------------------

  it('E: entities.commands.work REFUSES status=done with invariant_violation/use_complete_command and no status change', async () => {
    const target = await createTask('work-safety');

    // An ordinary transition lands, so the "unchanged" assertion below has a
    // non-default value to protect (PROBE-RED for the no-effect claim).
    const working = successData<CommandResultLike>(
      await harness.request('POST', `/v2/entities/${target}/commands/work`, {
        clientMutationId: 'w3-g02-work-working',
        status: 'working',
      }),
    );
    expect(working.entity).toMatchObject({ state: { kind: 'task', workStatus: 'working' } });

    const refused = await harness.request<CommandResultLike>(
      'POST',
      `/v2/entities/${target}/commands/work`,
      { clientMutationId: 'w3-g02-work-done', status: 'done' },
    );

    const after = await harness.rows<{
      work_status: string;
      ledger: number;
      completed_edges: number;
    }>(
      `select t.work_status,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = 'w3-g02-work-done') ledger,
              (select count(*)::integer from public.edges
                where dst_id = $1 and type = 'completed_by') completed_edges
         from public.tasks t where t.entity_id = $1`,
      [target],
    );

    // Reported as one object so a failure prints the exact observed refusal.
    expect({
      status: refused.status,
      code: refused.body.error?.code ?? null,
      message: refused.body.error?.message ?? null,
      details: refused.body.error?.details ?? null,
      workStatus: after[0]?.work_status,
      ledger: after[0]?.ledger,
      completedEdges: after[0]?.completed_edges,
    }).toEqual({
      status: 409,
      code: 'invariant_violation',
      message: expect.any(String),
      details: expect.objectContaining({ reason: 'use_complete_command' }),
      workStatus: 'working',
      ledger: 0,
      completedEdges: 0,
    });
  }, 60_000);

  it('E2: only entities.commands.complete crosses into done, and it pays the completion gate atomically', async () => {
    const target = await createTask('complete', { content: { pointsEstimate: 3 } });

    const completed = successData<CommandResultLike>(
      await harness.request('POST', `/v2/entities/${target}/commands/complete`, {
        clientMutationId: 'w3-g02-complete',
        expectedVersion: await versionOf(target),
        completerIds: [memberId],
      }),
    );
    expect(completed.entity).toMatchObject({ state: { kind: 'task', workStatus: 'done' } });

    const rows = await harness.rows<{
      work_status: string;
      completed_edges: number;
      awards: number;
      ledger: number;
    }>(
      `select t.work_status,
              (select count(*)::integer from public.edges
                where src_id = $1 and type = 'completed_by') completed_edges,
              (select count(*)::integer from public.point_events
                where ref_id = $1 and reason = 'award') awards,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = 'w3-g02-complete') ledger
         from public.tasks t where t.entity_id = $1`,
      [target],
    );
    expect(rows[0]).toEqual({ work_status: 'done', completed_edges: 1, awards: 1, ledger: 1 });
  }, 60_000);

  // -------------------------------------------------------------------------
  // F. Restricted, materializer-owned kinds
  // -------------------------------------------------------------------------

  it('F: refuses generic creation of every materializer-owned kind, with no envelope written', async () => {
    for (const kind of ['message', 'work_session', 'project', 'member', 'interaction_profile']) {
      const refused = await harness.request('POST', '/v2/entities', {
        clientMutationId: `w3-g02-restricted-create-${kind}`,
        spaceId,
        kind,
        title: `G02 illegal ${kind}`,
      });
      expect({ kind, status: refused.status, code: errorCode(refused) })
        .toEqual({ kind, status: 400, code: 'invalid_input' });
    }

    const rows = await harness.rows<{ ledger: number; strays: number }>(
      `select
         (select count(*)::integer from public.command_ledger
           where client_mutation_id like 'w3-g02-restricted-create-%') ledger,
         (select count(*)::integer from public.entities
           where space_id = $1
             and kind in ('message', 'work_session', 'project', 'interaction_profile')) strays`,
      [spaceId],
    );
    expect(rows[0]).toEqual({ ledger: 0, strays: 0 });
  }, 60_000);

  it('F2: refuses generic mutation of a materialized `member` and of the `project` projection', async () => {
    // `member` — materialized by the Space lifecycle, present since beforeAll.
    const memberDetail = successData<DetailLike>(await harness.request('GET', `/v2/entities/${memberId}`));
    expect(memberDetail.kind).toBe('member');

    const memberPatch = await harness.request('PATCH', `/v2/entities/${memberId}`, {
      clientMutationId: 'w3-g02-restricted-member-patch',
      expectedVersion: memberDetail.version,
      title: 'G02 hijacked member',
    });
    expect(memberPatch.status).toBe(403);
    expect(errorCode(memberPatch)).toBe('forbidden');

    const memberDelete = await harness.request('DELETE', `/v2/entities/${memberId}`, {
      clientMutationId: 'w3-g02-restricted-member-delete',
    });
    expect(memberDelete.status).toBe(403);
    expect(errorCode(memberDelete)).toBe('forbidden');

    const memberMove = await harness.request('POST', `/v2/entities/${memberId}/move`, {
      clientMutationId: 'w3-g02-restricted-member-move',
      parentId: null,
      position: 9,
      expectedVersion: memberDetail.version,
    });
    expect(memberMove.status).toBe(403);
    expect(errorCode(memberMove)).toBe('forbidden');

    // `project` — materialized by the project link, never by entities.create.
    const project = successData<{ id: string }>(
      await harness.request('POST', '/v2/projects', {
        clientMutationId: 'w3-g02-project-create',
        name: 'W3 G02 project',
        workingDir: '/tmp/tm8-w3-g02',
      }),
    );
    successData(await harness.request('POST', `/v2/spaces/${spaceId}/projects`, {
      clientMutationId: 'w3-g02-project-link',
      projectId: project.id,
    }));
    const projectionRows = await harness.rows<{ projection_id: string }>(
      `select project_entity_id::text projection_id from public.project_links
        where space_id = $1 and project_id = $2`,
      [spaceId, project.id],
    );
    const projectionId = projectionRows[0]!.projection_id;

    const projectionDetail = successData<DetailLike>(
      await harness.request('GET', `/v2/entities/${projectionId}`),
    );
    expect(projectionDetail).toMatchObject({
      kind: 'project',
      capabilities: { canEdit: false, canDelete: false, canAddChild: false },
    });
    // A projection has no hierarchy to lend: it is not a container.
    expect(projectionDetail.hierarchy).toEqual({ parent: null, path: [], children: { items: [], nextCursor: null } });

    const projectionPatch = await harness.request('PATCH', `/v2/entities/${projectionId}`, {
      clientMutationId: 'w3-g02-restricted-projection-patch',
      expectedVersion: projectionDetail.version,
      title: 'G02 hijacked projection',
    });
    expect(projectionPatch.status).toBe(403);
    expect(errorCode(projectionPatch)).toBe('forbidden');

    const projectionDelete = await harness.request('DELETE', `/v2/entities/${projectionId}`, {
      clientMutationId: 'w3-g02-restricted-projection-delete',
    });
    expect(projectionDelete.status).toBe(403);
    expect(errorCode(projectionDelete)).toBe('forbidden');

    const rows = await harness.rows<{
      ledger: number;
      member_title: string | null;
      member_deleted: boolean;
      projection_deleted: boolean;
    }>(
      `select
         (select count(*)::integer from public.command_ledger
           where client_mutation_id like 'w3-g02-restricted-%') ledger,
         (select display_name from public.members where entity_id = $1) member_title,
         (select deleted_at is not null from public.entities where id = $1) member_deleted,
         (select deleted_at is not null from public.entities where id = $2) projection_deleted`,
      [memberId, projectionId],
    );
    expect(rows[0]).toMatchObject({ ledger: 0, member_deleted: false, projection_deleted: false });
    expect(rows[0]!.member_title).not.toBe('G02 hijacked member');

    // PROBE-RED: the identical generic calls succeed on an UNrestricted kind,
    // so the refusals above are about ownership, not about the call shape.
    const ordinary = await createTask('restricted-probe');
    const ordinaryPatch = successData<CommandResultLike>(
      await harness.request('PATCH', `/v2/entities/${ordinary}`, {
        clientMutationId: 'w3-g02-probe-ordinary-patch',
        expectedVersion: 1,
        title: 'G02 ordinary renamed',
      }),
    );
    expect(ordinaryPatch.entity).toMatchObject({ title: 'G02 ordinary renamed' });
  }, 60_000);

  // -------------------------------------------------------------------------
  // G. Lifecycle — delete / restore
  // -------------------------------------------------------------------------

  it('G: round-trips delete → restore with DB-observable soft deletion, and refuses a BODY-LESS delete', async () => {
    const parent = await createTask('lifecycle-parent');
    const target = await createTask('lifecycle', { parentId: parent });

    // W2 disclosure §7e: entities.delete is bound to RequiredCommandContext, so
    // a body-less DELETE is `400 invalid_input`, NOT a silent success.
    const bodyless = await harness.request('DELETE', `/v2/entities/${target}`);
    expect(bodyless.status).toBe(400);
    expect(errorCode(bodyless)).toBe('invalid_input');

    const bodylessRestore = await harness.request('POST', `/v2/entities/${target}/restore`);
    expect(bodylessRestore.status).toBe(400);
    expect(errorCode(bodylessRestore)).toBe('invalid_input');

    const stillLive = await harness.rows<{ deleted: boolean }>(
      `select deleted_at is not null deleted from public.entities where id = $1`,
      [target],
    );
    expect(stillLive[0]).toEqual({ deleted: false });

    const deleted = successData<CommandResultLike>(
      await harness.request('DELETE', `/v2/entities/${target}`, {
        clientMutationId: 'w3-g02-lifecycle-delete',
      }),
    );
    expect(deleted.undo?.token).toBeTruthy();

    const afterDelete = await harness.rows<{ deleted: boolean }>(
      `select deleted_at is not null deleted from public.entities where id = $1`,
      [target],
    );
    expect(afterDelete[0]).toEqual({ deleted: true });

    // Derived visibility: a tombstone is not found by the live read paths and
    // disappears from its parent's children.
    const goneRead = await harness.request('GET', `/v2/entities/${target}`);
    expect(goneRead.status).toBe(404);
    expect(errorCode(goneRead)).toBe('not_found');
    const childrenAfterDelete = successData<PageLike<SummaryLike>>(
      await harness.request('GET', `/v2/entities/${parent}/children`),
    );
    expect(childrenAfterDelete.items.map((item) => item.id)).not.toContain(target);

    const restored = successData<CommandResultLike>(
      await harness.request('POST', `/v2/entities/${target}/restore`, {
        clientMutationId: 'w3-g02-lifecycle-restore',
      }),
    );
    expect(restored.entity).toMatchObject({ id: target, deletedAt: null });

    const childrenAfterRestore = successData<PageLike<SummaryLike>>(
      await harness.request('GET', `/v2/entities/${parent}/children`),
    );
    expect(childrenAfterRestore.items.map((item) => item.id)).toContain(target);

    const rows = await harness.rows<{ deleted: boolean; ledger: number }>(
      `select (select deleted_at is null from public.entities where id = $1) deleted,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id in
                  ('w3-g02-lifecycle-delete', 'w3-g02-lifecycle-restore')) ledger`,
      [target],
    );
    expect(rows[0]).toEqual({ deleted: true, ledger: 2 });
  }, 60_000);

  // -------------------------------------------------------------------------
  // H. Cursors — rejection AND order-insensitive acceptance
  // -------------------------------------------------------------------------

  it('H1: rejects a children cursor minted under a different parent, and a connections cursor minted under a different filter', async () => {
    const parentA = await createTask('cursor-parent-a');
    const parentB = await createTask('cursor-parent-b');
    await createTask('cursor-a1', { parentId: parentA });
    await createTask('cursor-a2', { parentId: parentA });
    await createTask('cursor-b1', { parentId: parentB });
    await createTask('cursor-b2', { parentId: parentB });

    const pageA = successData<PageLike<SummaryLike>>(
      await harness.request('GET', `/v2/entities/${parentA}/children?limit=1`),
    );
    expect(pageA.items).toHaveLength(1);
    expect(pageA.nextCursor).toBeTruthy();

    const crossParent = await harness.request(
      'GET',
      `/v2/entities/${parentB}/children?limit=1&cursor=${encodeURIComponent(pageA.nextCursor!)}`,
    );
    expect(crossParent.status).toBe(400);
    expect(errorCode(crossParent)).toBe('invalid_cursor');

    // A cursor minted for a DIFFERENT OPERATION must not resume this one either:
    // the fingerprint is scoped by operation, not only by its filters.
    for (const [operation, path] of [
      ['versions', `/v2/entities/${parentA}/versions`],
      ['activity', `/v2/entities/${parentA}/activity`],
      ['connections', `/v2/entities/${parentA}/connections`],
    ] as const) {
      const foreign = await harness.request(
        'GET',
        `${path}?limit=1&cursor=${encodeURIComponent(pageA.nextCursor!)}`,
      );
      expect({ operation, status: foreign.status, code: errorCode(foreign) })
        .toEqual({ operation, status: 400, code: 'invalid_cursor' });
    }

    // PROBE-RED: the SAME parent accepts the same cursor and advances, so the
    // rejection above is about the fingerprint and not about cursors at large.
    const secondA = successData<PageLike<SummaryLike>>(
      await harness.request(
        'GET',
        `/v2/entities/${parentA}/children?limit=1&cursor=${encodeURIComponent(pageA.nextCursor!)}`,
      ),
    );
    expect(secondA.items).toHaveLength(1);
    expect(secondA.items[0]!.id).not.toBe(pageA.items[0]!.id);
  }, 60_000);

  it('H2: entities.connections accepts a cursor across filter spellings that differ only in value ORDER, and resumes at the SAME position', async () => {
    const hub = await createTask('conn-hub');
    const peerOne = await createTask('conn-peer-1');
    const peerTwo = await createTask('conn-peer-2');

    successData(await harness.request('POST', '/v2/edges', {
      clientMutationId: 'w3-g02-conn-edge-relates',
      srcId: hub,
      dstId: peerOne,
      type: 'relates_to',
      props: {},
    }));
    successData(await harness.request('POST', '/v2/edges', {
      clientMutationId: 'w3-g02-conn-edge-depends',
      srcId: hub,
      dstId: peerTwo,
      type: 'depends_on',
      props: { hard: true },
    }));

    // Ground truth: the full ordered page, so "resumed at the same position"
    // is checked against reality rather than against another cursor's output.
    const full = successData<PageLike<EdgeViewLike>>(
      await harness.request(
        'GET',
        `/v2/entities/${hub}/connections?direction=outgoing&type=relates_to&type=depends_on&limit=10`,
      ),
    );
    expect(full.items).toHaveLength(2);
    expect(full.nextCursor).toBeNull();

    const minted = successData<PageLike<EdgeViewLike>>(
      await harness.request(
        'GET',
        `/v2/entities/${hub}/connections?direction=outgoing&type=relates_to&type=depends_on&limit=1`,
      ),
    );
    expect(minted.items).toHaveLength(1);
    expect(minted.items[0]!.id).toBe(full.items[0]!.id);
    expect(minted.nextCursor).toBeTruthy();
    const cursor = encodeURIComponent(minted.nextCursor!);

    // `= any(...)` is order-insensitive, so an order-SENSITIVE fingerprint
    // would reject a valid cursor; a too-LOOSE one would resume from the wrong
    // row. Both failure modes are covered: accepted AND identical to truth.
    const spellings: Array<[string, string]> = [
      ['same order', `type=relates_to&type=depends_on`],
      ['reversed order', `type=depends_on&type=relates_to`],
      ['comma-spelled', `types=relates_to,depends_on`],
      ['comma-spelled reversed', `types=depends_on,relates_to`],
      ['mixed spelling', `type=depends_on&types=relates_to`],
    ];
    for (const [label, filter] of spellings) {
      const resumed = await harness.request<PageLike<EdgeViewLike>>(
        'GET',
        `/v2/entities/${hub}/connections?direction=outgoing&${filter}&limit=1&cursor=${cursor}`,
      );
      const page = successData<PageLike<EdgeViewLike>>(resumed);
      expect({ label, ids: page.items.map((edge) => edge.id), nextCursor: page.nextCursor })
        .toEqual({ label, ids: [full.items[1]!.id], nextCursor: null });
    }

    // PROBE-RED: a filter that genuinely DIFFERS (not merely reordered) is
    // rejected, so the acceptance above is not a fingerprint that accepts all.
    for (const different of [
      `direction=incoming&type=relates_to&type=depends_on`,
      `direction=outgoing&type=relates_to`,
      `direction=outgoing&type=relates_to&type=depends_on&sort=updatedAt`,
      `direction=outgoing&type=relates_to&type=depends_on&order=asc`,
    ]) {
      const rejected = await harness.request(
        'GET',
        `/v2/entities/${hub}/connections?${different}&limit=1&cursor=${cursor}`,
      );
      expect({ different, status: rejected.status, code: errorCode(rejected) })
        .toEqual({ different, status: 400, code: 'invalid_cursor' });
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // I. Reactions
  // -------------------------------------------------------------------------

  it('I: entities.react keeps like/dislike mutually exclusive while star is independent, with matching counters', async () => {
    const target = await createTask('react');

    const react = async (reaction: string, enabled: boolean, suffix: string): Promise<DetailLike> => {
      const result = successData<CommandResultLike>(
        await harness.request('PUT', `/v2/entities/${target}/reaction`, {
          clientMutationId: `w3-g02-react-${suffix}`,
          reaction,
          enabled,
        }),
      );
      if (!result.entity) throw new Error(`react ${suffix} returned no entity`);
      return result.entity;
    };

    const liked = await react('like', true, 'like');
    expect(liked.counters).toMatchObject({ likes: 1, dislikes: 0, stars: 0, viewerReaction: 'like' });

    const disliked = await react('dislike', true, 'dislike');
    expect(disliked.counters).toMatchObject({ likes: 0, dislikes: 1, stars: 0, viewerReaction: 'dislike' });

    const starred = await react('star', true, 'star');
    expect(starred.counters).toMatchObject({ likes: 0, dislikes: 1, stars: 1 });

    const edges = await harness.rows<{ type: string }>(
      `select type from public.edges where dst_id = $1 and src_id = $2
         and type in ('likes','dislikes','stars') order by type`,
      [target, memberId],
    );
    expect(edges.map((row) => row.type)).toEqual(['dislikes', 'stars']);

    const cleared = await react('dislike', false, 'undislike');
    expect(cleared.counters).toMatchObject({ likes: 0, dislikes: 0, stars: 1 });

    const finalEdges = await harness.rows<{ type: string }>(
      `select type from public.edges where dst_id = $1 and src_id = $2
         and type in ('likes','dislikes','stars') order by type`,
      [target, memberId],
    );
    expect(finalEdges.map((row) => row.type)).toEqual(['stars']);

    // Reactions are counters, never connections: they must not surface in the
    // detail's connection groups.
    const detail = successData<DetailLike>(await harness.request('GET', `/v2/entities/${target}`));
    const groupTypes = [...detail.connections.outgoing, ...detail.connections.incoming]
      .map((group) => group.type);
    expect(groupTypes).not.toContain('stars');
    expect(groupTypes).not.toContain('likes');
  }, 60_000);

  // -------------------------------------------------------------------------
  // J. Points ledger
  // -------------------------------------------------------------------------

  it('J: entities.points.add APPENDS to the immutable ledger and never edits a total directly', async () => {
    const before = await harness.rows<{ events: number; points: number }>(
      `select (select count(*)::integer from public.point_events where entity_id = $1) events,
              (select coalesce(points, 0)::integer from public.entity_counters where entity_id = $1) points`,
      [memberId],
    );
    const baseEvents = before[0]!.events;
    const basePoints = before[0]!.points;

    for (const [suffix, amount] of [['first', 4], ['second', 7]] as const) {
      successData(await harness.request('POST', `/v2/entities/${memberId}/points`, {
        clientMutationId: `w3-g02-points-${suffix}`,
        amount,
        reason: 'grant',
      }));
    }

    // The replay must not pay twice.
    successData(await harness.request('POST', `/v2/entities/${memberId}/points`, {
      clientMutationId: 'w3-g02-points-first',
      amount: 4,
      reason: 'grant',
    }));

    const after = await harness.rows<{
      events: number;
      points: number;
      ledger_sum: number;
      amounts: string;
    }>(
      `select (select count(*)::integer from public.point_events where entity_id = $1) events,
              (select coalesce(points, 0)::integer from public.entity_counters where entity_id = $1) points,
              (select coalesce(sum(amount), 0)::integer from public.point_events where entity_id = $1) ledger_sum,
              (select string_agg(amount::text, ',' order by created_at, id)
                 from public.point_events where entity_id = $1
                  and client_event_id like 'w3-g02-points-%') amounts`,
      [memberId],
    );
    expect(after[0]).toMatchObject({
      events: baseEvents + 2,
      points: basePoints + 11,
      amounts: '4,7',
    });
    // The counter is a cache OF the ledger: the two must agree exactly.
    expect(after[0]!.points).toBe(after[0]!.ledger_sum);

    // A negative grant APPENDS a compensating row rather than editing history.
    successData(await harness.request('POST', `/v2/entities/${memberId}/points`, {
      clientMutationId: 'w3-g02-points-reversal',
      amount: -7,
      reason: 'grant',
    }));
    const reversed = await harness.rows<{ events: number; points: number; ledger_sum: number }>(
      `select (select count(*)::integer from public.point_events where entity_id = $1) events,
              (select coalesce(points, 0)::integer from public.entity_counters where entity_id = $1) points,
              (select coalesce(sum(amount), 0)::integer from public.point_events where entity_id = $1) ledger_sum`,
      [memberId],
    );
    expect(reversed[0]).toMatchObject({ events: baseEvents + 3, points: basePoints + 4 });
    expect(reversed[0]!.points).toBe(reversed[0]!.ledger_sum);

    // Points go to a member or team_member only — a task is refused with no row.
    const task = await createTask('points-illegal');
    const refused = await harness.request('POST', `/v2/entities/${task}/points`, {
      clientMutationId: 'w3-g02-points-illegal',
      amount: 5,
      reason: 'grant',
    });
    expect(refused.status).toBe(400);
    expect(errorCode(refused)).toBe('invalid_input');
    const illegal = await harness.rows<{ events: number }>(
      `select count(*)::integer events from public.point_events where entity_id = $1`,
      [task],
    );
    expect(illegal[0]).toEqual({ events: 0 });
  }, 60_000);

  // -------------------------------------------------------------------------
  // Move / pull / linkPr / linkCommit / tracking.refresh
  // -------------------------------------------------------------------------

  it('M: entities.move reparents under version control, issues an undo handle, and conflicts when stale', async () => {
    const fromParent = await createTask('move-from');
    const toParent = await createTask('move-to');
    const target = await createTask('move-target', { parentId: fromParent });

    const before = await versionOf(target);
    const moved = successData<CommandResultLike>(
      await harness.request('POST', `/v2/entities/${target}/move`, {
        clientMutationId: 'w3-g02-move',
        parentId: toParent,
        position: 3,
        expectedVersion: before,
      }),
    );
    expect(moved.entity).toMatchObject({ id: target, parentId: toParent, position: 3, version: before + 1 });
    expect(moved.undo?.token).toBeTruthy();
    expect(moved.activity?.verb).toBe('moved');

    const stale = await harness.request('POST', `/v2/entities/${target}/move`, {
      clientMutationId: 'w3-g02-move-stale',
      parentId: fromParent,
      position: 1,
      expectedVersion: before,
    });
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');

    const rows = await harness.rows<{
      parent_id: string;
      version: number;
      ledger: number;
      undo_tokens: number;
    }>(
      `select e.parent_id::text parent_id, e.version,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id in ('w3-g02-move', 'w3-g02-move-stale')) ledger,
              (select count(*)::integer from public.undo_tokens where token = $2) undo_tokens
         from public.entities e where e.id = $1`,
      [target, moved.undo!.token],
    );
    expect(rows[0]).toEqual({
      parent_id: toParent,
      version: before + 1,
      ledger: 1,
      undo_tokens: 1,
    });
  }, 60_000);

  it('P: entities.commands.pull pins an immutable projection and refuses a version that does not exist', async () => {
    const target = await createTask('pull');
    const version = await versionOf(target);

    const pulled = successData<CommandResultLike>(
      await harness.request('POST', `/v2/entities/${target}/commands/pull`, {
        clientMutationId: 'w3-g02-pull',
        pinnedVersion: version,
        localId: 'w3-local-1',
      }),
    );
    expect(pulled.edge).toMatchObject({ type: 'pulled', target: { id: target } });

    const refused = await harness.request('POST', `/v2/entities/${target}/commands/pull`, {
      clientMutationId: 'w3-g02-pull-future',
      pinnedVersion: version + 99,
    });
    expect(refused.status).toBe(400);
    expect(errorCode(refused)).toBe('invalid_input');

    const rows = await harness.rows<{
      edges: number;
      pinned: number;
      has_projection: boolean;
      ledger: number;
    }>(
      `select count(*)::integer edges,
              max((props->>'pinnedVersion')::integer) pinned,
              bool_or(props ? 'projectionHash') has_projection,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id in ('w3-g02-pull', 'w3-g02-pull-future')) ledger
         from public.edges where dst_id = $1 and type = 'pulled'`,
      [target],
    );
    expect(rows[0]).toEqual({ edges: 1, pinned: version, has_projection: true, ledger: 1 });
  }, 60_000);

  it('T: linkPr / linkCommit materialize tracked artifacts, and tracking.refresh queues them (202)', async () => {
    const target = await createTask('tracking');

    const linkedPr = successData<CommandResultLike>(
      await harness.request('POST', `/v2/entities/${target}/commands/link-pr`, {
        clientMutationId: 'w3-g02-link-pr',
        url: 'https://github.com/tm8-test/tm8/pull/42',
      }),
    );
    expect(linkedPr.edge).toMatchObject({ type: 'tracks', source: { id: target } });

    const linkedCommit = successData<CommandResultLike>(
      await harness.request('POST', `/v2/entities/${target}/commands/link-commit`, {
        clientMutationId: 'w3-g02-link-commit',
        url: 'https://github.com/tm8-test/tm8/commit/0f1e2d3c4b5a6978',
      }),
    );
    expect(linkedCommit.edge).toMatchObject({ type: 'tracks', source: { id: target } });

    const artifacts = await harness.rows<{ pr_entity: string; commit_entity: string }>(
      `select
         (select entity_id::text from public.pull_requests
           where space_id = $1 and repo = 'tm8-test/tm8' and number = 42) pr_entity,
         (select entity_id::text from public.commits
           where space_id = $1 and sha = '0f1e2d3c4b5a6978') commit_entity`,
      [spaceId],
    );
    const prEntity = artifacts[0]!.pr_entity;
    const commitEntity = artifacts[0]!.commit_entity;
    expect(prEntity).toBeTruthy();
    expect(commitEntity).toBeTruthy();

    // A URL that is not a PR/commit URL is refused with no artifact written.
    for (const [suffix, path, bad] of [
      ['pr-bad', 'link-pr', 'https://github.com/tm8-test/tm8'],
      ['commit-bad', 'link-commit', 'https://github.com/tm8-test/tm8/commit/zzz'],
      ['pr-nonurl', 'link-pr', 'not-a-url'],
    ] as const) {
      const refused = await harness.request('POST', `/v2/entities/${target}/commands/${path}`, {
        clientMutationId: `w3-g02-link-${suffix}`,
        url: bad,
      });
      expect({ suffix, status: refused.status, code: errorCode(refused) })
        .toEqual({ suffix, status: 400, code: 'invalid_input' });
    }

    const refreshBody = {
      clientMutationId: 'w3-g02-refresh-targeted',
      entityIds: [prEntity, commitEntity],
    };
    const queued = await harness.request<RefreshAccepted>('POST', '/v2/tracking/refresh', refreshBody);
    expect(queued.status).toBe(202);
    const accepted = successData<RefreshAccepted>(queued);
    expect(accepted).toMatchObject({ accepted: true, status: 'queued' });
    expect(accepted.requestIds).toHaveLength(1);

    const replay = await harness.request<RefreshAccepted>('POST', '/v2/tracking/refresh', refreshBody);
    expect(replay.status).toBe(202);
    expect(successData<RefreshAccepted>(replay)).toEqual(accepted);

    // A non-trackable entity id is refused rather than silently ignored.
    const wrongKind = await harness.request('POST', '/v2/tracking/refresh', {
      clientMutationId: 'w3-g02-refresh-wrong-kind',
      entityIds: [target],
    });
    expect(wrongKind.status).toBe(404);
    expect(errorCode(wrongKind)).toBe('not_found');

    const rows = await harness.rows<{
      requests: number;
      entity_ids: string[] | null;
      ledger: number;
    }>(
      `select
         (select count(*)::integer from public.tracking_refresh_requests
           where id = $1) requests,
         (select entity_ids::text[] from public.tracking_refresh_requests where id = $1) entity_ids,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id in
             ('w3-g02-refresh-targeted', 'w3-g02-refresh-wrong-kind')) ledger`,
      [accepted.requestIds[0]],
    );
    expect(rows[0]!.requests).toBe(1);
    expect([...(rows[0]!.entity_ids ?? [])].sort()).toEqual([prEntity, commitEntity].sort());
    expect(rows[0]!.ledger).toBe(1);
  }, 60_000);

  /**
   * `tracking.refresh` fans out over every Space the caller can read:
   * `queue_tracking_refresh` (017:643) loops the caller's `members` rows and
   * queues one request per Space, raising 42501 only when there is NONE.
   * `entityIds` is optional in `TrackingRefreshInputSchema`, so the unscoped
   * form is a first-class call and must be accepted, not refused.
   *
   * The three forms below differ only in HOW MANY loop iterations they produce,
   * which isolates the fan-out itself as the variable under test.
   */
  it('R: tracking.refresh accepts one Space, several Spaces, and the unscoped whole-account form', async () => {
    const homeTask = await createTask('refresh-home');
    const awayTask = await createTask('refresh-away', {}, otherSpaceId);

    const linkPr = async (taskId: string, suffix: string, number: number): Promise<void> => {
      successData(await harness.request('POST', `/v2/entities/${taskId}/commands/link-pr`, {
        clientMutationId: `w3-g02-refresh-link-${suffix}`,
        url: `https://github.com/tm8-test/tm8/pull/${number}`,
      }));
    };
    await linkPr(homeTask, 'home', 101);
    await linkPr(awayTask, 'away', 202);

    const artifacts = await harness.rows<{ home_pr: string; away_pr: string }>(
      `select
         (select entity_id::text from public.pull_requests where space_id = $1 and number = 101) home_pr,
         (select entity_id::text from public.pull_requests where space_id = $2 and number = 202) away_pr`,
      [spaceId, otherSpaceId],
    );
    const homePr = artifacts[0]!.home_pr;
    const awayPr = artifacts[0]!.away_pr;
    expect(homePr).toBeTruthy();
    expect(awayPr).toBeTruthy();

    // One Space — a single loop iteration.
    const single = await harness.request<RefreshAccepted>('POST', '/v2/tracking/refresh', {
      clientMutationId: 'w3-g02-refresh-one-space',
      entityIds: [homePr],
    });
    expect({
      form: 'one space',
      status: single.status,
      error: single.body.error?.code ?? null,
      message: single.body.error?.message ?? null,
      requestIds: single.body.data?.requestIds.length ?? null,
    }).toEqual({ form: 'one space', status: 202, error: null, message: null, requestIds: 1 });

    // Two Spaces — two loop iterations, one queued request each.
    const spanning = await harness.request<RefreshAccepted>('POST', '/v2/tracking/refresh', {
      clientMutationId: 'w3-g02-refresh-two-spaces',
      entityIds: [homePr, awayPr],
    });
    expect({
      form: 'two spaces',
      status: spanning.status,
      error: spanning.body.error?.code ?? null,
      message: spanning.body.error?.message ?? null,
      requestIds: spanning.body.data?.requestIds.length ?? null,
    }).toEqual({ form: 'two spaces', status: 202, error: null, message: null, requestIds: 2 });

    // Unscoped — every readable Space.
    const unscoped = await harness.request<RefreshAccepted>('POST', '/v2/tracking/refresh', {
      clientMutationId: 'w3-g02-refresh-unscoped',
    });
    expect({
      form: 'unscoped',
      status: unscoped.status,
      error: unscoped.body.error?.code ?? null,
      message: unscoped.body.error?.message ?? null,
      requestIds: unscoped.body.data?.requestIds.length ?? null,
    }).toEqual({ form: 'unscoped', status: 202, error: null, message: null, requestIds: 2 });

    const rows = await harness.rows<{ spaces: number; ledger: number }>(
      `select
         (select count(distinct space_id)::integer from public.tracking_refresh_requests) spaces,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id like 'w3-g02-refresh-%space%'
              or client_mutation_id = 'w3-g02-refresh-unscoped') ledger`,
    );
    expect(rows[0]).toMatchObject({ spaces: 2 });
    expect(rows[0]!.ledger).toBe(3);
  }, 60_000);

  // -------------------------------------------------------------------------
  // K. Reads
  // -------------------------------------------------------------------------

  it('K: get / children / hierarchy / connections / versions / activity return their documented shapes over real data', async () => {
    const root = await createTask('read-root');
    const child = await createTask('read-child', { parentId: root });
    const sibling = await createTask('read-sibling', { parentId: root });
    const peer = await createTask('read-peer');

    successData(await harness.request('POST', '/v2/edges', {
      clientMutationId: 'w3-g02-read-edge',
      srcId: root,
      dstId: peer,
      type: 'relates_to',
      props: { note: 'read shape' },
    }));
    successData<CommandResultLike>(
      await harness.request('PATCH', `/v2/entities/${root}`, {
        clientMutationId: 'w3-g02-read-patch',
        expectedVersion: await versionOf(root),
        title: 'G02 read-root v2',
      }),
    );

    // entities.get
    const detail = successData<DetailLike>(await harness.request('GET', `/v2/entities/${root}`));
    expect(detail).toMatchObject({
      id: root,
      spaceId,
      kind: 'task',
      title: 'G02 read-root v2',
      deletedAt: null,
      content: { kind: 'task' },
      state: { kind: 'task' },
    });
    expect(detail.counters).toMatchObject({ likes: 0, dislikes: 0, stars: 0 });
    expect(typeof detail.capabilities.canEdit).toBe('boolean');
    expect(detail.connections.outgoing.find((group) => group.type === 'relates_to')?.edges[0])
      .toMatchObject({ source: { id: root }, target: { id: peer } });
    expect(detail.hierarchy.children.items.map((item) => item.id).sort())
      .toEqual([child, sibling].sort());

    // entities.children — keyset paging with no repeats and no omissions.
    const firstPage = successData<PageLike<SummaryLike>>(
      await harness.request('GET', `/v2/entities/${root}/children?limit=1`),
    );
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toBeTruthy();
    const secondPage = successData<PageLike<SummaryLike>>(
      await harness.request(
        'GET',
        `/v2/entities/${root}/children?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor!)}`,
      ),
    );
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.id)))
      .toEqual(new Set([child, sibling]));

    // entities.hierarchy
    const hierarchy = successData<HierarchyLike>(
      await harness.request('GET', `/v2/entities/${child}/hierarchy`),
    );
    expect(hierarchy.parent?.id).toBe(root);
    expect(hierarchy.path.map((item) => item.id)).toEqual([root]);
    expect(hierarchy.children).toEqual({ items: [], nextCursor: null });

    // entities.connections
    const connections = successData<PageLike<EdgeViewLike>>(
      await harness.request('GET', `/v2/entities/${root}/connections?direction=outgoing`),
    );
    expect(connections.items.map((edge) => edge.type)).toContain('relates_to');
    const relatesEdge = connections.items.find((edge) => edge.type === 'relates_to');
    expect(relatesEdge).toMatchObject({
      source: { id: root },
      target: { id: peer },
      props: { note: 'read shape' },
    });
    expect(Date.parse(relatesEdge!.createdAt)).not.toBeNaN();

    // entities.versions.
    //
    // `internal.snapshot_entity_version` (001:1130) DEBOUNCES: a further edit by
    // the SAME actor inside `version_debounce_window()` (5 minutes) is folded
    // into the open snapshot — the envelope version still advances, but no new
    // `entity_versions` row appears. A new row is opened only when the ACTOR
    // changes. Both halves are asserted, so the row count below is the rule
    // rather than a coincidence of how many patches this test happened to make.
    const folded = successData<PageLike<VersionItem>>(
      await harness.request('GET', `/v2/entities/${root}/versions`),
    );
    expect(folded.items).toHaveLength(1);
    expect(folded.items[0]).toMatchObject({ entityId: root, version: await versionOf(root) });
    expect(folded.nextCursor).toBeNull();

    const teammate = successData<CommandResultLike>(
      await harness.request('POST', '/v2/entities', {
        clientMutationId: 'w3-g02-read-teammate',
        spaceId,
        kind: 'team_member',
        title: 'G02 read teammate',
        content: { identity: 'W3 G02 versions actor', model: 'claude-sonnet-5', agentTool: 'claude-code' },
      }),
    ).entity!.id;

    successData<CommandResultLike>(
      await harness.request('PATCH', `/v2/entities/${root}`, {
        clientMutationId: 'w3-g02-read-patch-teammate',
        actorId: teammate,
        expectedVersion: await versionOf(root),
        title: 'G02 read-root v3',
      }),
    );

    const versions = successData<PageLike<VersionItem>>(
      await harness.request('GET', `/v2/entities/${root}/versions`),
    );
    expect(versions.items).toHaveLength(2);
    expect(versions.items.map((item) => item.version))
      .toEqual([...versions.items.map((item) => item.version)].sort((a, b) => b - a));
    expect(versions.items[0]).toMatchObject({ entityId: root, changedBy: { id: teammate } });
    expect(versions.items[1]!.changedBy?.id).not.toBe(teammate);
    expect(versions.items[0]!.snapshot).toBeTypeOf('object');
    expect(Date.parse(versions.items[0]!.changedAt)).not.toBeNaN();

    const versionsPaged = successData<PageLike<VersionItem>>(
      await harness.request('GET', `/v2/entities/${root}/versions?limit=1`),
    );
    expect(versionsPaged.items).toHaveLength(1);
    expect(versionsPaged.nextCursor).toBeTruthy();
    const versionsNext = successData<PageLike<VersionItem>>(
      await harness.request(
        'GET',
        `/v2/entities/${root}/versions?limit=1&cursor=${encodeURIComponent(versionsPaged.nextCursor!)}`,
      ),
    );
    expect(versionsNext.items[0]!.version).toBeLessThan(versionsPaged.items[0]!.version);

    // entities.activity
    const activity = successData<PageLike<ActivityItemLike>>(
      await harness.request('GET', `/v2/entities/${root}/activity`),
    );
    expect(activity.items.length).toBeGreaterThan(0);
    expect(activity.items.map((item) => item.verb)).toContain('updated');
    expect(activity.items[0]).toMatchObject({ entityId: root });
    expect(activity.items[0]!.actor).not.toBeNull();
    expect(Date.parse(activity.items[0]!.createdAt)).not.toBeNaN();
  }, 60_000);

  // -------------------------------------------------------------------------
  // L. Authorization / RLS negatives
  // -------------------------------------------------------------------------

  it('L: never reveals or mutates rows outside the caller\'s reachable Space, and hides tombstones uniformly', async () => {
    // An absent id and a tombstoned id are indistinguishable — the tombstone
    // leaks nothing about what exists.
    const buried = await createTask('rls-buried');
    successData(await harness.request('DELETE', `/v2/entities/${buried}`, {
      clientMutationId: 'w3-g02-rls-bury',
    }));

    for (const id of [ABSENT_UUID, buried]) {
      for (const suffix of ['', '/children', '/hierarchy', '/connections', '/versions', '/activity']) {
        const response = await harness.request('GET', `/v2/entities/${id}${suffix}`);
        expect({ id, suffix, status: response.status, code: errorCode(response) })
          .toEqual({ id, suffix, status: 404, code: 'not_found' });
      }
    }

    // A cross-Space reparent is refused and leaves NO partial write behind.
    const mover = await createTask('rls-mover');
    const moverVersion = await versionOf(mover);
    const crossSpace = await harness.request('POST', `/v2/entities/${mover}/move`, {
      clientMutationId: 'w3-g02-rls-cross-move',
      parentId: otherSpaceTask,
      position: 1,
      expectedVersion: moverVersion,
    });
    expect(crossSpace.status).toBeGreaterThanOrEqual(400);
    expect(['invariant_violation', 'forbidden', 'invalid_input', 'not_found'])
      .toContain(errorCode(crossSpace));

    const moverRows = await harness.rows<{ parent_id: string | null; version: number; ledger: number }>(
      `select e.parent_id::text parent_id, e.version,
              (select count(*)::integer from public.command_ledger
                where client_mutation_id = 'w3-g02-rls-cross-move') ledger
         from public.entities e where e.id = $1`,
      [mover],
    );
    expect(moverRows[0]).toEqual({ parent_id: null, version: moverVersion, ledger: 0 });

    // A read scoped to one Space never spills rows from the other.
    const otherDetail = successData<DetailLike>(
      await harness.request('GET', `/v2/entities/${otherSpaceTask}`),
    );
    expect(otherDetail.spaceId).toBe(otherSpaceId);
    const parent = await createTask('rls-parent');
    await createTask('rls-child', { parentId: parent });
    const children = successData<PageLike<SummaryLike>>(
      await harness.request('GET', `/v2/entities/${parent}/children`),
    );
    expect(children.items.every((item) => item.spaceId === spaceId)).toBe(true);
    expect(children.items.map((item) => item.id)).not.toContain(otherSpaceTask);

    // A cross-Space edge cannot be minted to smuggle a peer into connections.
    const crossEdge = await harness.request('POST', '/v2/edges', {
      clientMutationId: 'w3-g02-rls-cross-edge',
      srcId: parent,
      dstId: otherSpaceTask,
      type: 'relates_to',
      props: {},
    });
    expect(crossEdge.status).toBeGreaterThanOrEqual(400);
    const crossEdgeRows = await harness.rows<{ edges: number }>(
      `select count(*)::integer edges from public.edges where src_id = $1 and dst_id = $2`,
      [parent, otherSpaceTask],
    );
    expect(crossEdgeRows[0]).toEqual({ edges: 0 });
  }, 60_000);

  // -------------------------------------------------------------------------
  // Composition boundary — G02 is the right SET, not merely the right COUNT
  // -------------------------------------------------------------------------

  it('X: entities.feed and entities.context belong to G13 and still answer an honest 501', async () => {
    const anchor = await createTask('composition-anchor');
    for (const suffix of ['feed', 'context']) {
      const response = await harness.request('GET', `/v2/entities/${anchor}/${suffix}`);
      expect({ suffix, status: response.status, code: errorCode(response) })
        .toEqual({ suffix, status: 501, code: 'not_implemented' });
    }

    // PROBE-RED: a G02 read on the SAME entity is composed and answers 200, so
    // the 501s above are about those two operations and not about the path.
    const composed = await harness.request('GET', `/v2/entities/${anchor}/connections`);
    expect(composed.status).toBe(200);
  }, 60_000);
});
