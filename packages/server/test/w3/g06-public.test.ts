import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  errorCode,
  startW3PublicServer,
  successData,
  type W3PublicServer,
} from './public-harness.js';

interface ProjectResource {
  id: string;
  name: string;
  repoUrl?: string | null;
  workingDir: string;
  trust: 'trusted' | 'untrusted';
  defaults: Record<string, unknown>;
  linkFrozen?: boolean;
  activeLinkCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface LinkResult {
  spaceId: string;
  projectId: string;
  patches: [];
}

describe.sequential('W3.G06 projects and associations through the production Server', () => {
  let harness: W3PublicServer;
  let spaceA = '';
  let spaceB = '';
  let ownerMemberA = '';
  let projectId = '';
  let projectionA = '';
  let projectionB = '';

  beforeAll(async () => {
    harness = await startW3PublicServer('g06');
    const first = successData<{ space: { id: string }; memberId: string }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g06-space-a',
        name: 'W3 G06 A',
      }),
    );
    const second = successData<{ space: { id: string } }>(
      await harness.request('POST', '/v2/spaces', {
        clientMutationId: 'w3-g06-space-b',
        name: 'W3 G06 B',
      }),
    );
    spaceA = first.space.id;
    spaceB = second.space.id;
    ownerMemberA = first.memberId;
  }, 120_000);

  afterAll(async () => {
    await harness?.close();
  }, 30_000);

  it('creates and replays one node project, then exposes complete global/get shapes', async () => {
    const body = {
      clientMutationId: 'w3-g06-project-create',
      name: 'W3 project',
      workingDir: '/tmp/tm8-w3-g06',
      repoUrl: 'https://example.test/tm8.git',
      trust: 'trusted',
      defaults: { model: 'gpt-5.6', agentTool: 'codex', mode: 'worker' },
    };
    const created = successData<ProjectResource>(await harness.request('POST', '/v2/projects', body));
    const replay = successData<ProjectResource>(await harness.request('POST', '/v2/projects', body));
    expect(replay).toEqual(created);
    expect(created).toMatchObject({
      name: body.name,
      workingDir: body.workingDir,
      repoUrl: body.repoUrl,
      trust: 'trusted',
      defaults: body.defaults,
      linkFrozen: false,
      activeLinkCount: 0,
    });
    expect(Date.parse(created.createdAt)).not.toBeNaN();
    projectId = created.id;

    const listed = successData<ProjectResource[]>(await harness.request('GET', '/v2/projects'));
    expect(listed.map((project) => project.id)).toContain(projectId);
    const got = successData<ProjectResource>(await harness.request('GET', `/v2/projects/${projectId}`));
    expect(got).toEqual(created);

    const rows = await harness.rows<{ projects: number; ledger: number }>(
      `select
         (select count(*)::integer from public.projects where id = $1) projects,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g06-project-create') ledger`,
      [projectId],
    );
    expect(rows[0]).toEqual({ projects: 1, ledger: 1 });
  });

  it('links into two Spaces, replays, filters list by active mapping, and records projections', async () => {
    const link = async (spaceId: string, cmid: string): Promise<LinkResult> => successData<LinkResult>(
      await harness.request('POST', `/v2/spaces/${spaceId}/projects`, {
        clientMutationId: cmid,
        projectId,
      }),
    );
    const linkedA = await link(spaceA, 'w3-g06-link-a');
    const replayA = await link(spaceA, 'w3-g06-link-a');
    const linkedB = await link(spaceB, 'w3-g06-link-b');
    expect(replayA).toEqual(linkedA);
    expect(linkedA).toEqual({ spaceId: spaceA, projectId, patches: [] });
    expect(linkedB).toEqual({ spaceId: spaceB, projectId, patches: [] });

    const filteredA = successData<ProjectResource[]>(
      await harness.request('GET', `/v2/projects?spaceId=${spaceA}`),
    );
    expect(filteredA.map((project) => project.id)).toContain(projectId);
    const badSpace = await harness.request('GET', '/v2/projects?spaceId=not-a-uuid');
    expect(badSpace.status).toBe(400);
    expect(errorCode(badSpace)).toBe('invalid_input');

    const rows = await harness.rows<{
      space_id: string;
      projection_id: string;
      version: number;
      name: string;
      deleted: boolean;
    }>(
      `select links.space_id::text, links.project_entity_id::text projection_id,
              entity.version, detail.name, entity.deleted_at is not null deleted
         from public.project_links links
         join public.entities entity on entity.id = links.project_entity_id
         join public.project_projection_details detail on detail.entity_id = entity.id
        where links.project_id = $1 order by links.space_id`,
      [projectId],
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.name === 'W3 project' && !row.deleted)).toBe(true);
    projectionA = rows.find((row) => row.space_id === spaceA)!.projection_id;
    projectionB = rows.find((row) => row.space_id === spaceB)!.projection_id;
    const resource = successData<ProjectResource>(await harness.request('GET', `/v2/projects/${projectId}`));
    expect(resource.activeLinkCount).toBe(2);
  });

  it('fans an update to every active projection once and preserves explicit repoUrl null', async () => {
    const before = await harness.rows<{ id: string; version: number }>(
      `select entity.id::text, entity.version
         from public.entities entity
         join public.project_projection_details detail on detail.entity_id = entity.id
        where detail.project_id = $1 order by entity.id`,
      [projectId],
    );
    const body = {
      clientMutationId: 'w3-g06-update',
      name: 'W3 project updated',
      repoUrl: null,
      defaults: { model: 'gpt-5.6', agentTool: 'codex', mode: 'coordinator' },
    };
    const updated = successData<ProjectResource>(
      await harness.request('PATCH', `/v2/projects/${projectId}`, body),
    );
    const replay = successData<ProjectResource>(
      await harness.request('PATCH', `/v2/projects/${projectId}`, body),
    );
    expect(replay).toEqual(updated);
    expect(updated).toMatchObject({ name: body.name, repoUrl: null, activeLinkCount: 2 });

    const after = await harness.rows<{ id: string; version: number; name: string; repo_url: string | null }>(
      `select entity.id::text, entity.version, detail.name, detail.repo_url
         from public.entities entity
         join public.project_projection_details detail on detail.entity_id = entity.id
        where detail.project_id = $1 order by entity.id`,
      [projectId],
    );
    expect(after.map(({ id, version }) => ({ id, version }))).toEqual(
      before.map(({ id, version }) => ({ id, version: version + 1 })),
    );
    expect(after.every((row) => row.name === body.name && row.repo_url === null)).toBe(true);
    const ledger = await harness.rows<{ count: number }>(
      `select count(*)::integer count from public.command_ledger
        where client_mutation_id = 'w3-g06-update'`,
    );
    expect(ledger[0]?.count).toBe(1);
  });

  it('unlinks and relinks by restoring the same stable projection identity', async () => {
    const body = { clientMutationId: 'w3-g06-unlink-b' };
    const unlinked = successData<LinkResult>(
      await harness.request('DELETE', `/v2/spaces/${spaceB}/projects/${projectId}`, body),
    );
    const replay = successData<LinkResult>(
      await harness.request('DELETE', `/v2/spaces/${spaceB}/projects/${projectId}`, body),
    );
    expect(replay).toEqual(unlinked);
    expect(unlinked).toEqual({ spaceId: spaceB, projectId, patches: [] });

    const absent = successData<ProjectResource[]>(
      await harness.request('GET', `/v2/projects?spaceId=${spaceB}`),
    );
    expect(absent.map((project) => project.id)).not.toContain(projectId);
    const deleted = await harness.rows<{ deleted: boolean; active_links: number; event_rows: number }>(
      `select
         (select deleted_at is not null from public.entities where id = $1) deleted,
         (select active_link_count::integer from public.projects where id = $2) active_links,
         (select count(*)::integer from public.workspace_events
           where space_id = $3 and payload->>'id' = $1::text
             and client_mutation_id = 'w3-g06-unlink-b') event_rows`,
      [projectionB, projectId, spaceB],
    );
    expect(deleted[0]).toEqual({ deleted: true, active_links: 1, event_rows: 1 });

    const relink = successData<LinkResult>(
      await harness.request('POST', `/v2/spaces/${spaceB}/projects`, {
        clientMutationId: 'w3-g06-relink-b',
        projectId,
      }),
    );
    expect(relink.projectId).toBe(projectId);
    const restored = await harness.rows<{ projection_id: string; deleted: boolean; active_links: number }>(
      `select links.project_entity_id::text projection_id,
              entity.deleted_at is not null deleted, resource.active_link_count::integer active_links
         from public.project_links links
         join public.entities entity on entity.id = links.project_entity_id
         join public.projects resource on resource.id = links.project_id
        where links.space_id = $1 and links.project_id = $2`,
      [spaceB, projectId],
    );
    expect(restored[0]).toEqual({ projection_id: projectionB, deleted: false, active_links: 2 });
  });

  it('enforces the frozen 16 active-Space-link cap through public commands', async () => {
    const capped = successData<ProjectResource>(await harness.request('POST', '/v2/projects', {
      clientMutationId: 'w3-g06-cap-project',
      name: 'W3 capped project',
      workingDir: '/tmp/tm8-w3-g06-cap',
    }));
    const spaces: string[] = [];
    for (let index = 0; index < 17; index += 1) {
      const space = successData<{ space: { id: string } }>(
        await harness.request('POST', '/v2/spaces', {
          clientMutationId: `w3-g06-cap-space-${index}`,
          name: `W3 G06 cap ${index}`,
        }),
      );
      spaces.push(space.space.id);
    }
    for (const [index, spaceId] of spaces.slice(0, 16).entries()) {
      successData<LinkResult>(await harness.request('POST', `/v2/spaces/${spaceId}/projects`, {
        clientMutationId: `w3-g06-cap-link-${index}`,
        projectId: capped.id,
      }));
    }
    const seventeenth = await harness.request('POST', `/v2/spaces/${spaces[16]}/projects`, {
      clientMutationId: 'w3-g06-cap-link-16',
      projectId: capped.id,
    });
    expect(seventeenth.status).toBe(429);
    expect(errorCode(seventeenth)).toBe('limit_exceeded');

    const rows = await harness.rows<{ links: number; active_link_count: number; failed_ledger: number }>(
      `select
         (select count(*)::integer from public.space_projects where project_id = $1) links,
         (select active_link_count::integer from public.projects where id = $1) active_link_count,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g06-cap-link-16') failed_ledger`,
      [capped.id],
    );
    expect(rows[0]).toEqual({ links: 16, active_link_count: 16, failed_ledger: 0 });
  }, 120_000);

  it('corrects a materialized artifact association with version guard, replay, and no partial write', async () => {
    const artifactId = await harness.database.transaction(async (client) => {
      await client.query('set local role tm8_graph_owner');
      const id = (await client.query<{ id: string }>('select internal.new_id()::text id')).rows[0]!.id;
      await client.query(
        `insert into public.entities(id, space_id, kind, created_by)
         values ($1, $2, 'pull_request', $3)`,
        [id, spaceA, ownerMemberA],
      );
      await client.query(
        `insert into public.pull_requests(entity_id, space_id, url, repo, number, title)
         values ($1, $2, 'https://example.test/w3/g06/1', 'tm8/w3', 1, 'W3 G06 PR')`,
        [id, spaceA],
      );
      await client.query(`select internal.w1_set_writer('materialized')`);
      await client.query(
        `insert into public.edges(space_id, src_id, dst_id, type, props, created_by)
         values ($1, $2, $3, 'in_project', '{}'::jsonb, $4)`,
        [spaceA, id, projectionA, ownerMemberA],
      );
      await client.query(`select internal.w1_set_writer(null)`);
      return id;
    });

    const stale = await harness.request(
      'POST',
      `/v2/entities/${artifactId}/commands/correct-project-association`,
      {
        clientMutationId: 'w3-g06-correct-stale',
        projectId,
        expectedArtifactVersion: 99,
      },
    );
    expect(stale.status).toBe(409);
    expect(errorCode(stale)).toBe('version_conflict');

    const body = {
      clientMutationId: 'w3-g06-correct',
      projectId,
      expectedArtifactVersion: 1,
    };
    const corrected = successData<{
      artifactId: string;
      projectId: string;
      outcome: 'removed' | 'demoted' | 'unchanged';
      edge: unknown | null;
    }>(await harness.request(
      'POST',
      `/v2/entities/${artifactId}/commands/correct-project-association`,
      body,
    ));
    const replay = successData<typeof corrected>(await harness.request(
      'POST',
      `/v2/entities/${artifactId}/commands/correct-project-association`,
      body,
    ));
    expect(replay).toEqual(corrected);
    expect(corrected).toEqual({ artifactId, projectId, outcome: 'removed', edge: null });

    const unknown = await harness.request(
      'POST',
      `/v2/entities/${artifactId}/commands/correct-project-association`,
      { ...body, clientMutationId: 'w3-g06-correct-unknown', unknownField: true },
    );
    expect(unknown.status).toBe(400);
    expect(errorCode(unknown)).toBe('invalid_input');

    const rows = await harness.rows<{ edge_rows: number; success_ledger: number; failed_ledger: number }>(
      `select
         (select count(*)::integer from public.edges
           where src_id = $1 and dst_id = $2 and type = 'in_project') edge_rows,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id = 'w3-g06-correct') success_ledger,
         (select count(*)::integer from public.command_ledger
           where client_mutation_id in ('w3-g06-correct-stale', 'w3-g06-correct-unknown')) failed_ledger`,
      [artifactId, projectionA],
    );
    expect(rows[0]).toEqual({ edge_rows: 0, success_ledger: 1, failed_ledger: 0 });
  });
});
