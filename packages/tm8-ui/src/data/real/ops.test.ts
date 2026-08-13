/**
 * ops.ts — the four seam↔server divergences, pinned (see the ops.ts header).
 *
 * These are the tests that would fail the day the server or the seam moves, and
 * they are written so the failure names WHICH one moved.
 */
import { describe, expect, it } from 'vitest';
import { OPERATIONS, bindPath, isOperationName } from '@tm8/contract';
import { LIVENESS_OP, createOps, livenessPath } from './ops';
import { createHttpClient } from './http';
import { fakeFetch, type FakeFetch } from './test-support';

function harness(reply: unknown = {}): { ops: ReturnType<typeof createOps>; f: FakeFetch } {
  const f = fakeFetch(() => ({ data: reply }));
  const ops = createOps(createHttpClient({ fetch: f.fetch }), {
    newClientMutationId: (prefix) => `${prefix}_fixed`,
  });
  return { ops, f };
}

describe('ops: execution.liveness — catalog row A21 (Delta 2, dd41e89)', () => {
  it('the canary retired honestly: the row EXISTS and the catalog owns the path', () => {
    // This test spent its first life asserting the row's ABSENCE (the scheduled
    // failure that fired on Delta 2's landing, per the disposition written in
    // liveness-absent.itest.ts). It flips, as planned, to assert presence — and
    // the literal-path branch it guarded is deleted, so the catalog is now the
    // ONLY source of this path.
    expect(isOperationName(LIVENESS_OP)).toBe(true);
    const names: readonly string[] = OPERATIONS.map((op) => op.name);
    expect(names).toContain(LIVENESS_OP);
  });

  it('binds via the catalog to the C-1 path shape', () => {
    expect(livenessPath('sp-1')).toBe('/v2/spaces/sp-1/execution/liveness');
    expect(livenessPath('sp-1')).toBe(bindPath(LIVENESS_OP, { spaceId: 'sp-1' }));
  });

  it('percent-encodes the spaceId (bindPath property, inherited not reimplemented)', () => {
    expect(livenessPath('a/b')).toBe('/v2/spaces/a%2Fb/execution/liveness');
  });

  it('stamps spaceId onto the snapshot from the REQUEST (C-1 does not echo it)', async () => {
    const { ops } = harness({ liveEntityIds: ['ws-1'], nodeBootId: 'boot-A', checkedAt: '2026-07-28T12:00:00.000Z' });
    const snap = await ops.liveness('sp-9');
    expect(snap).toEqual({
      spaceId: 'sp-9',
      liveEntityIds: ['ws-1'],
      nodeBootId: 'boot-A',
      checkedAt: '2026-07-28T12:00:00.000Z',
    });
  });
});

describe('ops: launch resources', () => {
  it('loads projects for the active space through the catalog operation', async () => {
    const projects = [{ id: 'project-1', name: 'tm8' }];
    const { ops, f } = harness(projects);
    await expect(ops.projects('space-1')).resolves.toEqual(projects);
    expect(f.last().method).toBe('GET');
    expect(f.last().url).toBe('/v2/projects?spaceId=space-1');
  });

  it('loads space profile defaults through the catalog settings operation', async () => {
    const settings = { defaultInteractionProfileId: 'profile-1', settingsRevision: 3 };
    const { ops, f } = harness(settings);
    await expect(ops.spaceSettings('space-1')).resolves.toEqual(settings);
    expect(f.last().method).toBe('GET');
    expect(f.last().url).toBe('/v2/spaces/space-1/settings');
  });

  it('loads branch topology through the catalog operation, params bound and opts as query', async () => {
    const topology = { projectId: 'project-1', branches: [] };
    const { ops, f } = harness(topology);

    // No opts: the query string is ABSENT, not `?staleAfterDays=undefined` —
    // several server query parsers 400 on garbage keys.
    await expect(ops.projectBranches('project-1')).resolves.toEqual(topology);
    expect(f.last().method).toBe('GET');
    expect(f.last().url).toBe('/v2/projects/project-1/branches');

    await ops.projectBranches('project-1', { staleAfterDays: 14, limit: 50 });
    expect(f.last().url).toBe('/v2/projects/project-1/branches?staleAfterDays=14&limit=50');
  });

  it('binds the session git rail reads and verbs to their catalog routes', async () => {
    const status = { sessionId: 's-1', available: true };
    const { ops, f } = harness(status);

    await expect(ops.gitStatus('s-1' as never)).resolves.toEqual(status);
    expect(f.last().method).toBe('GET');
    expect(f.last().url).toBe('/v2/work-sessions/s-1/git/status');

    // No opts ⇒ no query string; the cap travels only when the caller sets it.
    await ops.gitDiff('s-1' as never);
    expect(f.last().url).toBe('/v2/work-sessions/s-1/git/diff');
    await ops.gitDiff('s-1' as never, { maxBytes: 4096 });
    expect(f.last().url).toBe('/v2/work-sessions/s-1/git/diff?maxBytes=4096');

    await ops.gitCheckpoint('s-1' as never, { message: 'cp' });
    expect(f.last().method).toBe('POST');
    expect(f.last().url).toBe('/v2/work-sessions/s-1/git/checkpoint');

    await ops.gitRollback('s-1' as never, { to: 'abc', force: true });
    expect(f.last().url).toBe('/v2/work-sessions/s-1/git/rollback');
    await ops.gitCommit('s-1' as never, { message: 'm', all: true });
    expect(f.last().url).toBe('/v2/work-sessions/s-1/git/commit');
    await ops.gitMerge('s-1' as never, {});
    expect(f.last().url).toBe('/v2/work-sessions/s-1/git/merge');
  });

  it('uses catalog bindings for node-local onboarding reads and commands', async () => {
    const listing = {
      roots: ['/srv/projects'],
      path: '/srv/projects',
      parentPath: null,
      separator: '/' as const,
      directories: [],
      truncated: false,
    };
    const { ops, f } = harness(listing);

    await expect(ops.projectDirectories('/srv/projects')).resolves.toEqual(listing);
    expect(f.last().method).toBe('GET');
    expect(f.last().url).toBe('/v2/project-directories?path=%2Fsrv%2Fprojects');

    await ops.createSpace({ name: 'Studio', clientMutationId: 'space-1' });
    expect(f.last()).toMatchObject({
      method: 'POST',
      url: '/v2/spaces',
      body: { name: 'Studio', clientMutationId: 'space-1' },
    });

    await ops.createProject({
      name: 'Website',
      workingDir: '/srv/projects/website',
      ensureWorkingDir: true,
      clientMutationId: 'project-1',
    });
    expect(f.last()).toMatchObject({
      method: 'POST',
      url: '/v2/projects',
      body: expect.objectContaining({ ensureWorkingDir: true }),
    });

    await ops.linkProject('space-1', { projectId: 'project-1', clientMutationId: 'link-1' });
    expect(f.last()).toMatchObject({
      method: 'POST',
      url: '/v2/spaces/space-1/projects',
      body: { projectId: 'project-1', clientMutationId: 'link-1' },
    });
  });

  it('uses catalog bindings for reading and attaching from a connected project folder', async () => {
    const listing = {
      projectId: 'project-1',
      workingDir: '/srv/projects/website',
      path: '/srv/projects/website/docs',
      parentPath: '/srv/projects/website',
      separator: '/' as const,
      directories: [],
      files: [],
      truncated: false,
      maxSizeBytes: 1024,
    };
    const { ops, f } = harness(listing);

    await expect(ops.projectFiles('project-1', '/srv/projects/website/docs')).resolves.toEqual(listing);
    expect(f.last().method).toBe('GET');
    expect(f.last().url).toBe('/v2/projects/project-1/files?path=%2Fsrv%2Fprojects%2Fwebsite%2Fdocs');

    await ops.attachProjectFile('project-1', {
      clientMutationId: 'attach-1',
      spaceId: 'space-1',
      path: '/srv/projects/website/docs/guide.md',
      targets: ['task-1'],
    });
    expect(f.last()).toMatchObject({
      method: 'POST',
      url: '/v2/projects/project-1/files/attach',
      body: {
        clientMutationId: 'attach-1',
        spaceId: 'space-1',
        path: '/srv/projects/website/docs/guide.md',
        targets: ['task-1'],
      },
    });
  });
});

describe('ops: canonical file upload lifecycle', () => {
  it('uses the three catalog operations and the server-granted raw PUT', async () => {
    const replies = [
      {
        uploadId: 'upload-1',
        uploadUrl: '/v2/files/uploads/upload-1/content',
        token: 'grant-1',
        expiresAt: '2026-07-30T12:00:00.000Z',
        maxSizeBytes: 1024,
      },
      undefined,
      { patches: [], entity: { id: 'file-1' } },
      { patches: [] },
    ];
    const f = fakeFetch(() => {
      const reply = replies.shift();
      return reply === undefined ? { status: 204, raw: '' } : { data: reply };
    });
    const ops = createOps(createHttpClient({ fetch: f.fetch }));
    const grant = await ops.fileUploadInit({
      clientMutationId: 'init-1',
      spaceId: 'space-1',
      name: 'plan.txt',
      mime: 'text/plain',
      sizeBytes: 4,
      checksumSha256: 'a'.repeat(64),
    });
    await ops.fileUploadBytes(grant, new Blob(['plan']));
    await ops.fileUploadComplete('upload-1', { clientMutationId: 'complete-1' });
    await ops.fileUploadAbort('upload-1', { clientMutationId: 'abort-1' });

    expect(f.calls.map((call) => [call.method, call.url])).toEqual([
      ['POST', '/v2/files/uploads'],
      ['PUT', '/v2/files/uploads/upload-1/content'],
      ['POST', '/v2/files/uploads/upload-1/complete'],
      ['POST', '/v2/files/uploads/upload-1/abort'],
    ]);
    expect(f.calls[2]?.body).toEqual({ clientMutationId: 'complete-1' });
  });
});

describe('ops: graph hydration', () => {
  it('posts the complete graph lens through the catalog operation', async () => {
    const result = { nodes: [], edges: [], clusters: [] };
    const { ops, f } = harness(result);
    const query = { spaceId: 'space-1', layout: 'graph' as const, limit: 150 };

    await expect(ops.graph(query)).resolves.toEqual(result);
    expect(f.last().method).toBe('POST');
    expect(f.last().url).toBe('/v2/graph/query');
    expect(f.last().body).toEqual(query);
  });
});

describe('ops: divergence 1 — no task route; fields travel inside content', () => {
  it('createTask posts kind:"task" with content-nested payload fields', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.createTask({
      clientMutationId: 'cmid-1',
      spaceId: 'sp-1',
      title: 'ship it',
      description: 'the description',
      priority: 'high',
      pointsEstimate: 3,
      dueDate: null,
      parentId: 'e-parent',
    });

    expect(f.last().method).toBe('POST');
    expect(f.last().url).toBe('/v2/entities');
    expect(f.last().body).toEqual({
      parentId: 'e-parent',
      clientMutationId: 'cmid-1',
      spaceId: 'sp-1',
      kind: 'task',
      title: 'ship it',
      // Top-level task fields would be a 400: CreateEntityInputSchema is strict.
      content: { description: 'the description', priority: 'high', pointsEstimate: 3, dueDate: null },
    });
  });

  it('synthesizes a clientMutationId only when the caller omitted one (it is required server-side)', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.createTask({ spaceId: 'sp-1', title: 't' });
    expect((f.last().body as { clientMutationId: string }).clientMutationId).toBe('task_fixed');
  });

  it('patchTask nests workStatus in content — update_task_content reads it from there', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.patchTask('e-1', { expectedVersion: 4, workStatus: 'working', title: 'renamed' });

    expect(f.last().method).toBe('PATCH');
    expect(f.last().url).toBe('/v2/entities/e-1');
    expect(f.last().body).toEqual({
      title: 'renamed',
      expectedVersion: 4,
      content: { workStatus: 'working' },
    });
  });

  it('preserves an explicit null (clears the field) while dropping undefined', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.patchTask('e-1', { expectedVersion: 1, dueDate: null });
    expect(f.last().body).toEqual({ expectedVersion: 1, content: { dueDate: null } });
  });
});

describe('ops: divergence 2 — editMessage lifts a bare MessageView', () => {
  it('wraps the returned view as the authoritative patch list, inventing nothing', async () => {
    const view = { id: 'm-1', title: 'msg', version: 2 };
    const { ops } = harness(view);
    const result = await ops.editMessage('m-1', { clientMutationId: 'c', expectedVersion: 1, body: 'edited' });
    expect(result).toEqual({ patches: [view] });
    expect(result).not.toHaveProperty('entity');
  });
});

describe('ops: divergence 3 — the mutation ids the seam has no slot for', () => {
  it('markRead synthesizes the clientMutationId the server requires', async () => {
    const { ops, f } = harness({});
    await ops.markRead('n-1');
    expect(f.last().method).toBe('PUT');
    expect(f.last().url).toBe('/v2/inbox/n-1/read');
    expect(f.last().body).toEqual({ clientMutationId: 'read_fixed' });
  });

  it('upsertReadMark does NOT send lastReadAt — the schema is strict and the server stamps it', async () => {
    const { ops, f } = harness({});
    await ops.upsertReadMark('a-1');
    expect(f.last().url).toBe('/v2/read-marks/a-1');
    expect(f.last().body).toEqual({ clientMutationId: 'mark_fixed' });
    expect(f.last().body).not.toHaveProperty('lastReadAt');
  });
});

describe('ops: command bodies the server actually requires', () => {
  it('DELETE carries the command context as a body', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.deleteEntity('e-1', { clientMutationId: 'cmid-9' });
    expect(f.last().method).toBe('DELETE');
    expect(f.last().body).toEqual({ clientMutationId: 'cmid-9' });
  });

  it('an omitted context reaches the server as {} — an honest invalid_input, not a forged id', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.deleteEntity('e-1');
    expect(f.last().body).toEqual({});
  });

  /**
   * The relationship writes. `edges.create` is one POST to a collection and
   * carries its endpoints in the BODY; `edges.delete` addresses the edge by
   * its own id in the PATH. Pinned because they are the pair behind the task
   * tile's Assigned control, and a URL that reads plausibly but is wrong fails
   * as a 404 the UI would report as "could not assign".
   */
  it('createEdge POSTs the endpoints; deleteEdge addresses the edge by id', async () => {
    const { ops, f } = harness({ patches: [] });
    await ops.createEdge({ srcId: 'task-1', dstId: 'member-1', type: 'assigned_to' });
    expect(f.last().method).toBe('POST');
    expect(f.last().url).toBe('/v2/edges');
    expect(f.last().body).toEqual({ srcId: 'task-1', dstId: 'member-1', type: 'assigned_to' });

    await ops.deleteEdge('edge-1', { clientMutationId: 'cmid-e' });
    expect(f.last().method).toBe('DELETE');
    // `:edgeId`, not `:id` — the catalog names this one differently from the
    // entity routes and an unbound placeholder would travel as a literal.
    expect(f.last().url).toBe('/v2/edges/edge-1');
    expect(f.last().body).toEqual({ clientMutationId: 'cmid-e' });
  });
});

describe('ops: events.poll cursor vocabulary', () => {
  it('sends since as a decimal integer (a non-numeric value is a hard 400 invalid_cursor)', async () => {
    const { ops, f } = harness({ items: [], nextCursor: '0' });
    await ops.pollEvents('sp-1', 41, 200);
    expect(f.last().method).toBe('GET');
    expect(f.last().url).toBe('/v2/spaces/sp-1/events?since=41&limit=200');
    // The control: no `cursor` param exists on this op.
    expect(f.last().url).not.toContain('cursor=');
  });
});

describe('ops: paged reads carry cursor + limit', () => {
  it('children, activity, messages and handoffs all page the same way', async () => {
    const { ops, f } = harness({ items: [], nextCursor: null });
    await ops.children('e-1', { cursor: 'c1', limit: 10 });
    expect(f.last().url).toBe('/v2/entities/e-1/children?cursor=c1&limit=10');
    await ops.activity('e-1', { cursor: 'c2' });
    expect(f.last().url).toBe('/v2/entities/e-1/activity?cursor=c2');
    await ops.messages('a-1', { limit: 5 });
    expect(f.last().url).toBe('/v2/entities/a-1/messages?limit=5');
    await ops.handoffs('ws-1');
    expect(f.last().url).toBe('/v2/work-sessions/ws-1/handoffs');
  });

  it('feed carries scope, order, and around beside the page opts', async () => {
    const { ops, f } = harness({ items: [], nextCursor: null, previousCursor: null });
    await ops.feed('e-1', {
      scope: 'session_chat_v1',
      order: 'oldest',
      around: 'message:01900000-0000-7000-8000-000000000010',
      limit: 20,
    });
    expect(f.last().url).toBe(
      '/v2/entities/e-1/feed?limit=20&scope=session_chat_v1&order=oldest&around=message%3A01900000-0000-7000-8000-000000000010',
    );
  });
});
