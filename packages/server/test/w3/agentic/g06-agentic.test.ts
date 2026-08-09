import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startW3PublicServer } from '../public-harness.js';
import { observeG06DatabaseOutcome } from '../agentic-observer.js';

// Operations selected via generated discovery only (bun test/w3/discovery-adapter.ts):
//   root                    -> nouns: space (22 ops), project (7 ops), entity (20 ops), tracking, undo, ...
//   noun space (2 pages)    -> spaces.create, spaces.get, ... (no command-replay primitive here)
//   noun project            -> projects.create, projects.get, projects.link, projects.unlink,
//                               projects.update, projects.list, projects.associations.correct
//   noun entity (2 pages)   -> entities.create requires kind in a fixed enum with no generic
//                               "project" kind, so the ProjectResource node is the `project`
//                               noun itself (projects.create), not an `entity`.
//   noun tracking / undo    -> tracking.refresh, commands.undo (no explicit "replay" verb)
// Command replay was selected by public-error probing rather than a dedicated verb: POST
// /v2/projects requires `clientMutationId`, and resubmitting the identical body+
// clientMutationId returns the exact same record (identical updatedAt) instead of erroring or
// duplicating -- i.e. idempotent command replay, confirmed by the DB observer emitting exactly
// one `projects.create` mutation label for that clientMutationId even though it was POSTed twice.

describe('W3.G06 agentic generated-discovery workflow', () => {
  let harness: Awaited<ReturnType<typeof startW3PublicServer>>;

  beforeAll(async () => {
    harness = await startW3PublicServer('agentic_g06');
  });

  afterAll(async () => {
    await harness.close();
  });

  it('creates two spaces, replays a project-create command, links/reads/updates a nullable repo field, then unlinks and relinks the project across spaces with a stable projection', async () => {
    // 1. Create two Spaces.
    const spaceOneRes = await harness.request('POST', '/v2/spaces', {
      name: 'G06 Agentic Space One',
      clientMutationId: 'g06-agentic-space1-create',
    });
    expect(spaceOneRes.status).toBe(201);
    const spaceOneId: string = spaceOneRes.body.data.space.id;

    const spaceTwoRes = await harness.request('POST', '/v2/spaces', {
      name: 'G06 Agentic Space Two',
      clientMutationId: 'g06-agentic-space2-create',
    });
    expect(spaceTwoRes.status).toBe(201);
    const spaceTwoId: string = spaceTwoRes.body.data.space.id;
    expect(spaceTwoId).not.toBe(spaceOneId);

    // 2. Create one node ProjectResource (the `project` noun) with no repo configured yet.
    const createRes = await harness.request('POST', '/v2/projects', {
      name: 'G06 Agentic Repo',
      workingDir: '/tmp/g06-agentic-repo',
      clientMutationId: 'g06-agentic-project-create',
    });
    expect(createRes.status).toBe(201);
    const projectId: string = createRes.body.data.id;
    expect(createRes.body.data.repoUrl).toBeNull();
    expect(createRes.body.data.activeLinkCount).toBe(0);

    // 3. Replay the create command: identical body + identical clientMutationId.
    const replayRes = await harness.request('POST', '/v2/projects', {
      name: 'G06 Agentic Repo',
      workingDir: '/tmp/g06-agentic-repo',
      clientMutationId: 'g06-agentic-project-create',
    });
    expect(replayRes.status).toBe(201);
    expect(replayRes.body.data.id).toBe(projectId);
    expect(replayRes.body.data.updatedAt).toBe(createRes.body.data.updatedAt);

    const listAfterReplay = await harness.request('GET', '/v2/projects');
    expect(listAfterReplay.status).toBe(200);
    expect(
      listAfterReplay.body.data.filter((p: { id: string }) => p.id === projectId).length,
    ).toBe(1);

    // 4. Link the ProjectResource into both Spaces.
    const linkOneRes = await harness.request('POST', `/v2/spaces/${spaceOneId}/projects`, {
      projectId,
      clientMutationId: 'g06-agentic-link-space1',
    });
    expect(linkOneRes.status).toBe(200);

    const linkTwoRes = await harness.request('POST', `/v2/spaces/${spaceTwoId}/projects`, {
      projectId,
      clientMutationId: 'g06-agentic-link-space2',
    });
    expect(linkTwoRes.status).toBe(200);

    // 5. Read/list it.
    const getAfterLink = await harness.request('GET', `/v2/projects/${projectId}`);
    expect(getAfterLink.status).toBe(200);
    expect(getAfterLink.body.data.activeLinkCount).toBe(2);

    const listAfterLink = await harness.request('GET', '/v2/projects');
    expect(listAfterLink.body.data.map((p: { id: string }) => p.id)).toContain(projectId);

    const linkedOutcome = await observeG06DatabaseOutcome(harness, projectId, [
      'g06-agentic-link-space1',
      'g06-agentic-link-space2',
    ]);
    expect(linkedOutcome.project.exists).toBe(true);
    expect(linkedOutcome.projections).toHaveLength(2);
    expect(linkedOutcome.projections.every((p: { live: boolean }) => p.live)).toBe(true);
    const spaceTwoProjectionId = linkedOutcome.projections.find(
      (p: { spaceId: string }) => p.spaceId === spaceTwoId,
    )?.projectionId;
    expect(spaceTwoProjectionId).toBeTruthy();

    // 6. Update a visible project field, and exercise the explicit nullable repo state.
    const renameRes = await harness.request('PATCH', `/v2/projects/${projectId}`, {
      name: 'G06 Agentic Repo Renamed',
      clientMutationId: 'g06-agentic-project-rename',
    });
    expect(renameRes.status).toBe(200);
    expect(renameRes.body.data.name).toBe('G06 Agentic Repo Renamed');

    const setRepoRes = await harness.request('PATCH', `/v2/projects/${projectId}`, {
      repoUrl: 'https://example.com/g06-agentic-repo.git',
      clientMutationId: 'g06-agentic-project-set-repo',
    });
    expect(setRepoRes.status).toBe(200);
    expect(setRepoRes.body.data.repoUrl).toBe('https://example.com/g06-agentic-repo.git');

    const clearRepoRes = await harness.request('PATCH', `/v2/projects/${projectId}`, {
      repoUrl: null,
      clientMutationId: 'g06-agentic-project-clear-repo',
    });
    expect(clearRepoRes.status).toBe(200);
    expect(clearRepoRes.body.data.repoUrl).toBeNull();

    // 7. Strict invalid-input refusal: unlink requires a body object with clientMutationId.
    const invalidUnlinkRes = await harness.request(
      'DELETE',
      `/v2/spaces/${spaceTwoId}/projects/${projectId}`,
    );
    expect(invalidUnlinkRes.status).toBe(400);
    expect(invalidUnlinkRes.body.error.code).toBe('invalid_input');

    // 8. Unlink one Space for real.
    const unlinkRes = await harness.request(
      'DELETE',
      `/v2/spaces/${spaceTwoId}/projects/${projectId}`,
      { clientMutationId: 'g06-agentic-unlink-space2' },
    );
    expect(unlinkRes.status).toBe(200);

    const getAfterUnlink = await harness.request('GET', `/v2/projects/${projectId}`);
    expect(getAfterUnlink.body.data.activeLinkCount).toBe(1);

    const unlinkedOutcome = await observeG06DatabaseOutcome(harness, projectId, [
      'g06-agentic-unlink-space2',
    ]);
    expect(unlinkedOutcome.mutations).toContainEqual({
      clientMutationId: 'g06-agentic-unlink-space2',
      operation: 'projects.unlink',
    });
    const spaceTwoProjectionAfterUnlink = unlinkedOutcome.projections.find(
      (p: { spaceId: string }) => p.spaceId === spaceTwoId,
    );
    expect(spaceTwoProjectionAfterUnlink?.live).toBe(false);
    expect(spaceTwoProjectionAfterUnlink?.projectionId).toBe(spaceTwoProjectionId);

    // 9. Relink to demonstrate a stable logical resource/projection.
    const relinkRes = await harness.request('POST', `/v2/spaces/${spaceTwoId}/projects`, {
      projectId,
      clientMutationId: 'g06-agentic-relink-space2',
    });
    expect(relinkRes.status).toBe(200);

    const getAfterRelink = await harness.request('GET', `/v2/projects/${projectId}`);
    expect(getAfterRelink.body.data.activeLinkCount).toBe(2);
    expect(getAfterRelink.body.data.repoUrl).toBeNull();

    const relinkedOutcome = await observeG06DatabaseOutcome(harness, projectId, [
      'g06-agentic-project-create',
      'g06-agentic-relink-space2',
    ]);
    const spaceTwoProjectionAfterRelink = relinkedOutcome.projections.find(
      (p: { spaceId: string }) => p.spaceId === spaceTwoId,
    );
    expect(spaceTwoProjectionAfterRelink?.live).toBe(true);
    // Same logical projection identity survives unlink -> relink.
    expect(spaceTwoProjectionAfterRelink?.projectionId).toBe(spaceTwoProjectionId);
    // The replayed create command still resolves to exactly one tracked mutation.
    expect(relinkedOutcome.mutations).toContainEqual({
      clientMutationId: 'g06-agentic-project-create',
      operation: 'projects.create',
    });
    expect(
      relinkedOutcome.mutations.filter(
        (m: { clientMutationId: string }) => m.clientMutationId === 'g06-agentic-project-create',
      ),
    ).toHaveLength(1);
    // Same 120s budget and the same reason as its siblings: this `it` boots the
    // DB-backed harness itself. It currently lands just inside vitest's 5s
    // default, which is not a margin — it is a coin flip on a loaded runner.
  }, 120_000);
});
