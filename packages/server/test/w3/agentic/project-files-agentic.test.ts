import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from '../public-harness.js';

/**
 * The connected-project-folder lane over REAL HTTP, a REAL database and REAL
 * bytes on disk.
 *
 * The unit tests for this feature drive a FakeDb, which is the right shape for
 * asserting the ledger call ORDER but proves nothing about the ledger itself:
 * `w2_init_file_upload` through `w2_complete_file_upload` are plpgsql, and the
 * invariants that matter most here — the frozen target set, the replayed
 * mutation id, the `attached_to` edge — live in SQL, not in TypeScript. This
 * test exists so "attach reuses the upload ledger" is a measured claim rather
 * than a design intention.
 *
 * The proof of the whole round trip is the download at the end: the bytes the
 * node read off its own disk come back over HTTP identical, under a checksum
 * the server recomputed rather than echoed.
 */
describe('W3 connected project folder — read and attach over the public surface', () => {
  let harness: W3PublicServer;
  let scratch: string;
  let workingDir: string;
  let previousRoots: string | undefined;

  beforeAll(async () => {
    harness = await startW3PublicServer('agentic_project_files');
    scratch = await realpath(await mkdtemp(join(tmpdir(), 'tm8-pf-agentic-')));
    workingDir = join(scratch, 'website');
    await mkdir(join(workingDir, 'docs'), { recursive: true });
    // `configuredRoots()` reads the environment per request, so the allow-list
    // is set here rather than baked into the harness.
    previousRoots = process.env.TM8_PROJECT_ROOTS;
    process.env.TM8_PROJECT_ROOTS = scratch;
  }, 120_000);

  afterAll(async () => {
    if (previousRoots === undefined) delete process.env.TM8_PROJECT_ROOTS;
    else process.env.TM8_PROJECT_ROOTS = previousRoots;
    await rm(scratch, { recursive: true, force: true });
    await harness?.close();
  }, 120_000);

  it('lists a real folder, attaches a real file to a task, and serves the same bytes back', async () => {
    const spaceRes = await harness.request('POST', '/v2/spaces', {
      clientMutationId: 'pf-space-1',
      name: 'Project Files Space',
    });
    expect(spaceRes.status).toBe(201);
    const spaceId = successData(spaceRes).space.id as string;

    const taskRes = await harness.request('POST', '/v2/entities', {
      clientMutationId: 'pf-task-1',
      spaceId,
      kind: 'task',
      title: 'Attach the release notes',
    });
    expect(taskRes.status).toBe(201);
    const taskId = successData(taskRes).entity.id as string;

    const projectRes = await harness.request('POST', '/v2/projects', {
      clientMutationId: 'pf-project-1',
      name: 'Website',
      workingDir,
    });
    expect(projectRes.status).toBe(201);
    const projectId = successData(projectRes).id as string;
    const linkRes = await harness.request('POST', `/v2/spaces/${spaceId}/projects`, {
      clientMutationId: 'pf-link-1',
      projectId,
    });
    expect(linkRes.status).toBe(200);

    // Written HERE, so the bytes the server reads are bytes this test authored.
    const contents = `release notes for ${taskId}\n`;
    await writeFile(join(workingDir, 'NOTES.md'), contents);
    await writeFile(join(scratch, 'outside.txt'), 'not in the project');
    await symlink(join(scratch, 'outside.txt'), join(workingDir, 'escape.md'));

    const listRes = await harness.request('GET', `/v2/projects/${projectId}/files`);
    expect(listRes.status).toBe(200);
    const listing = successData(listRes) as {
      projectId: string;
      workingDir: string;
      files: Array<{ name: string; path: string; sizeBytes: number; mime: string; attachable: boolean }>;
      directories: Array<{ name: string }>;
    };
    expect(listing.projectId).toBe(projectId);
    expect(listing.workingDir).toBe(workingDir);
    expect(listing.directories.map((row) => row.name)).toEqual(['docs']);
    // The symlink is absent, not merely unattachable.
    expect(listing.files.map((row) => row.name)).toEqual(['NOTES.md']);
    expect(listing.files[0]).toMatchObject({
      sizeBytes: Buffer.byteLength(contents),
      mime: 'text/markdown',
      attachable: true,
    });

    const attachRes = await harness.request('POST', `/v2/projects/${projectId}/files/attach`, {
      clientMutationId: 'pf-attach-1',
      spaceId,
      path: listing.files[0]!.path,
      targets: [taskId],
    });
    expect(attachRes.status, JSON.stringify(attachRes.body ?? attachRes)).toBeLessThan(300);
    const attached = successData(attachRes) as { entity: { id: string; kind: string }; state?: unknown };
    expect(attached.entity.kind).toBe('file');
    const fileEntityId = attached.entity.id;

    // THE ROUND TRIP, and the reason this test exists. The bytes the node read
    // off its own disk come back over HTTP byte-for-byte, under a checksum the
    // server recomputed from storage rather than echoed from the request.
    // `fetch` directly, not harness.request: this route answers raw bytes, not
    // the JSON envelope.
    const downloadUrl = new URL(`/v2/files/${fileEntityId}/download`, harness.baseUrl).toString();
    const downloadRes = await fetch(downloadUrl);
    expect(downloadRes.status).toBe(200);
    expect(await downloadRes.text()).toBe(contents);
    const digest = createHash('sha256').update(contents).digest('hex');
    expect(downloadRes.headers.get('x-tm8-checksum-sha256')).toBe(digest);
    expect(downloadRes.headers.get('content-type')).toBe('text/markdown');

    // The attachment is a real graph edge on the task, not a private record.
    const connectionsRes = await harness.request('GET', `/v2/entities/${taskId}/connections`);
    expect(connectionsRes.status).toBe(200);
    const connections = JSON.stringify(successData(connectionsRes));
    expect(connections).toContain('attached_to');
    expect(connections).toContain(fileEntityId);
  }, 180_000);

  it('replays one mutation id instead of attaching the file twice', async () => {
    const spaceId = successData(await harness.request('POST', '/v2/spaces', {
      clientMutationId: 'pf-space-2',
      name: 'Replay Space',
    })).space.id as string;

    const replayDir = join(scratch, 'replay');
    await mkdir(replayDir, { recursive: true });
    const projectId = successData(await harness.request('POST', '/v2/projects', {
      clientMutationId: 'pf-project-2',
      name: 'Replay Project',
      workingDir: replayDir,
    })).id as string;
    const linkRes = await harness.request('POST', `/v2/spaces/${spaceId}/projects`, {
      clientMutationId: 'pf-link-2',
      projectId,
    });
    expect(linkRes.status).toBe(200);

    const path = join(replayDir, 'REPLAY.md');
    await writeFile(path, 'replay me\n');

    const first = await harness.request('POST', `/v2/projects/${projectId}/files/attach`, {
      clientMutationId: 'pf-attach-replay',
      spaceId,
      path,
    });
    expect(first.status).toBeLessThan(300);
    const firstId = successData(first).entity.id as string;

    const second = await harness.request('POST', `/v2/projects/${projectId}/files/attach`, {
      clientMutationId: 'pf-attach-replay',
      spaceId,
      path,
    });
    expect(second.status, JSON.stringify(second.body)).toBeLessThan(300);
    // The SAME file entity, not a second one carrying the same bytes.
    expect(successData(second).entity.id).toBe(firstId);
  }, 180_000);

  it('refuses a path outside the project working directory, over the wire', async () => {
    const spaceId = successData(await harness.request('POST', '/v2/spaces', {
      clientMutationId: 'pf-space-3',
      name: 'Refusal Space',
    })).space.id as string;

    const refusalDir = join(scratch, 'refusal');
    await mkdir(refusalDir, { recursive: true });
    await symlink(join(scratch, 'outside.txt'), join(refusalDir, 'escape.md'));
    const projectId = successData(await harness.request('POST', '/v2/projects', {
      clientMutationId: 'pf-project-3',
      name: 'Refusal Project',
      workingDir: refusalDir,
    })).id as string;
    const linkRes = await harness.request('POST', `/v2/spaces/${spaceId}/projects`, {
      clientMutationId: 'pf-link-3',
      projectId,
    });
    expect(linkRes.status).toBe(200);

    const outside = await harness.request('POST', `/v2/projects/${projectId}/files/attach`, {
      clientMutationId: 'pf-attach-outside',
      spaceId,
      path: join(scratch, 'outside.txt'),
    });
    expect(outside.status).toBe(403);

    // A symlink whose target is outside is refused for the same reason, and it
    // is the case a containment check on the REQUESTED path would have missed.
    const viaSymlink = await harness.request('POST', `/v2/projects/${projectId}/files/attach`, {
      clientMutationId: 'pf-attach-symlink',
      spaceId,
      path: join(refusalDir, 'escape.md'),
    });
    expect(viaSymlink.status).toBe(403);

    const listOutside = await harness.request(
      'GET',
      `/v2/projects/${projectId}/files?path=${encodeURIComponent(scratch)}`,
    );
    expect(listOutside.status).toBe(403);
  }, 180_000);
});
