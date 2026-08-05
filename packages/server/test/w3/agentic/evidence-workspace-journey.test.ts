import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startW3PublicServer, successData, type W3PublicServer } from '../public-harness.js';

/**
 * A TRANSCRIPT, not an assertion sheet.
 *
 * This walks the whole user journey — browse my workspace, create a folder in
 * it, connect it as a private project, then read and attach a file out of it —
 * against a REAL server, a REAL database and REAL bytes on disk, printing what
 * the wire actually carried at each step. It exists so the flow can be read
 * rather than taken on trust.
 *
 * It still asserts, because a transcript nobody checks is a screenshot.
 */
describe('EVIDENCE — the connected-folder journey end to end', () => {
  let harness: W3PublicServer;
  let base: string;
  const log: string[] = [];

  const say = (step: string, detail: string) => log.push(`${step.padEnd(34)} ${detail}`);

  beforeAll(async () => {
    harness = await startW3PublicServer('evidence_workspace');
    base = await mkdtemp(join(tmpdir(), 'tm8-evidence-'));
    process.env.TM8_USER_WORKSPACE_ROOT = base;
  }, 180_000);

  afterAll(async () => {
    delete process.env.TM8_USER_WORKSPACE_ROOT;
    console.log(`\n${'='.repeat(78)}\nTRANSCRIPT — real server, real database, real files\n${'='.repeat(78)}`);
    for (const line of log) console.log(line);
    console.log('='.repeat(78));
    await rm(base, { recursive: true, force: true });
    await harness?.close();
  }, 180_000);

  it('browses my own workspace, creates a folder in it, and works on it', async () => {
    // THE WHOLE POINT: run as an ORDINARY MEMBER, not the loopback owner.
    // The harness authenticates as auto-owner, which IS a node admin — and a
    // node admin was never the case that was broken. Every human account on a
    // deployed node is a non-admin, so the evidence has to be gathered as one.
    await harness.request('POST', '/v2/auth/signup', {
      username: 'evidence_member', password: 'correct-horse-battery-staple',
    });
    const login = successData(await harness.request('POST', '/v2/auth/login', {
      username: 'evidence_member', password: 'correct-horse-battery-staple',
    })) as { token: string };
    const asMember = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(new URL(path, harness.baseUrl), {
        method,
        headers: {
          authorization: `Bearer ${login.token}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      const parsed = text ? JSON.parse(text) : {};
      return { status: response.status, data: parsed.data, error: parsed.error };
    };
    say('acting as', 'evidence_member (NOT a node admin)');

    // The member makes their own Space, which is what the onboarding dialog
    // does: create a Space, then connect a folder to it.
    const spaceRes = await asMember('POST', '/v2/spaces', {
      clientMutationId: 'ev-space', name: 'Evidence Space',
    });
    expect(spaceRes.status, JSON.stringify(spaceRes.error)).toBeLessThan(300);
    const spaceId = (spaceRes.data as { space: { id: string } }).space.id;
    say('1. Space created by member', spaceId);

    // STEP 2 — the operation that used to answer "node-admin access is
    // required". No path is supplied: the server answers with MY workspace.
    const browsed = await asMember('GET', '/v2/project-directories');
    expect(browsed.status, JSON.stringify(browsed.error)).toBe(200);
    const browse = browsed.data as {
      roots: string[]; path: string; parentPath: string | null; directories: unknown[];
    };
    say('2. Browse with no path', browse.path);
    say('   roots I may see', JSON.stringify(browse.roots));
    say('   can I walk above it?', browse.parentPath === null ? 'no — parentPath is null' : 'YES (BUG)');
    // ONE root, and it is mine — a node admin would additionally see
    // TM8_PROJECT_ROOTS here, which is the case that was never broken.
    expect(browse.roots).toEqual([browse.path]);
    expect(browse.parentPath).toBeNull();

    // STEP 3 — create a NEW folder inside it, the "create a new folder in local
    // storage" half of the ask. ensureWorkingDir is what makes the directory.
    const newFolder = join(browse.path, 'my-first-project');
    const created = await asMember('POST', '/v2/projects', {
      clientMutationId: 'ev-project',
      name: 'My First Project',
      workingDir: newFolder,
      ensureWorkingDir: true,
      spaceId,
    });
    expect(created.status, JSON.stringify(created.error)).toBeLessThan(300);
    const project = created.data as { id: string; workingDir: string; shareMode: string; ownerAccountId: string | null };
    say('3. New folder created', project.workingDir);
    say('   visible to others?', project.shareMode === 'private' ? 'no — private by default' : project.shareMode);
    expect(project.workingDir).toBe(newFolder);

    // STEP 4 — something appears in the folder. On a real node this is an agent
    // working, or a `git clone` the agent ran. Here the test writes it, so the
    // bytes are ones this file authored and can compare against later.
    const contents = '# notes\nwritten on the node, read back through the API\n';
    await writeFile(join(newFolder, 'NOTES.md'), contents);
    await writeFile(join(newFolder, 'app.ts'), 'export const answer = 42;\n');
    say('4. Files placed in it', 'NOTES.md, app.ts');

    // STEP 5 — read the folder back through the API.
    const listed = await asMember('GET', `/v2/projects/${project.id}/files`);
    expect(listed.status, JSON.stringify(listed.error)).toBe(200);
    const listing = listed.data as {
      path: string; files: Array<{ name: string; path: string; sizeBytes: number; mime: string; attachable: boolean }>;
    };
    say('5. Folder read via API', listing.files.map((f) => `${f.name} (${f.sizeBytes}b, ${f.mime})`).join(', '));
    expect(listing.files.map((f) => f.name)).toEqual(['app.ts', 'NOTES.md']);

    // STEP 6 — attach one to a task. The bytes never touch the browser.
    const taskRes = await asMember('POST', '/v2/entities', {
      clientMutationId: 'ev-task', spaceId, kind: 'task', title: 'Review the notes',
    });
    expect(taskRes.status, JSON.stringify(taskRes.error)).toBeLessThan(300);
    const taskId = (taskRes.data as { entity: { id: string } }).entity.id;
    const notes = listing.files.find((f) => f.name === 'NOTES.md')!;
    const attachRes = await asMember('POST', `/v2/projects/${project.id}/files/attach`, {
      clientMutationId: 'ev-attach', spaceId, path: notes.path, targets: [taskId],
    });
    expect(attachRes.status, JSON.stringify(attachRes.error)).toBeLessThan(300);
    const attached = attachRes.data as { entity: { id: string; kind: string } };
    say('6. Attached to a task', `${attached.entity.kind} ${attached.entity.id} -> task ${taskId}`);
    expect(attached.entity.kind).toBe('file');

    // STEP 7 — the round trip. Bytes read off the node's disk, stored, served
    // back, and compared against what step 4 wrote.
    // WITH the member's own bearer: the download is authorized like every
    // other read, so an unauthenticated fetch correctly answers not_found.
    const download = await fetch(new URL(`/v2/files/${attached.entity.id}/download`, harness.baseUrl), {
      headers: { authorization: `Bearer ${login.token}` },
    });
    const roundTripped = await download.text();
    say('7. Downloaded back', `${roundTripped.length} bytes, identical: ${roundTripped === contents}`);
    expect(roundTripped).toBe(contents);
    expect(roundTripped).toBe(await readFile(join(newFolder, 'NOTES.md'), 'utf8'));

    // STEP 8 — the refusals, so the confinement is shown and not claimed.
    const outside = await asMember('GET', `/v2/project-directories?path=${encodeURIComponent(base)}`);
    say('8. Browse ABOVE my workspace', `${outside.status} ${outside.error?.message ?? ''}`);
    expect(outside.status).toBe(403);

    const steal = await asMember('POST', `/v2/projects/${project.id}/files/attach`, {
      clientMutationId: 'ev-steal', spaceId, path: '/etc/passwd',
    });
    say('   attach /etc/passwd', `${steal.status} ${steal.error?.message ?? ''}`);
    expect(steal.status).toBe(403);
  }, 180_000);
});
