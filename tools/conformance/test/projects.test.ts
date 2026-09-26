/**
 * projects.* conformance (AM-2 §1, T-D17) — projects are linked RESOURCES,
 * not entities: no hierarchy/edges/messages, just the resource DTO + the op
 * family, linked to spaces many-to-many. Part of the Phase 1A vertical slice
 * ("space + project link"), so these are hard expectations: red against the
 * stub, green at G1A.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ProjectResourceSchema, type ProjectResource } from '@tm8/contract';
import { api, expectError } from '../src/client.js';
import { buildWorld, expectValid, type World } from '../src/world.js';

let w: World;

beforeAll(async () => {
  w = await buildWorld('projects');
});

type ProjectPage = { items: unknown[]; nextCursor: string | null };

async function createProject(name: string): Promise<ProjectResource> {
  const res = await api.command('projects.create', {
    name, workingDir: `/tmp/conf-projects/${name}`, repoUrl: null,
    clientMutationId: `cmid-proj-${randomUUID()}`,
  });
  return expectValid(ProjectResourceSchema, res, `project ${name}`);
}

describe('projects.* (AM-2 §1, T-D17)', () => {
  it('create returns a schema-valid resource; trust defaults to untrusted (explicit grant model)', async () => {
    const p = await createProject(`p-${randomUUID().slice(0, 8)}`);
    expect(p.trust).toBe('untrusted');
    const got = expectValid(ProjectResourceSchema, await api.read('projects.get', { projectId: p.id }), 'projects.get');
    expect(got.id).toBe(p.id);
  });

  it('update changes trust and spawn defaults', async () => {
    const p = await createProject(`p-${randomUUID().slice(0, 8)}`);
    await api.command('projects.update', {
      trust: 'trusted', defaults: { model: 'claude-opus-4-8', mode: 'worker' },
      clientMutationId: `cmid-proj-up-${randomUUID()}`,
    }, { projectId: p.id });
    const got = expectValid(ProjectResourceSchema, await api.read('projects.get', { projectId: p.id }), 'updated project');
    expect(got.trust).toBe('trusted');
    expect(got.defaults.model).toBe('claude-opus-4-8');
  });

  it('link/unlink bind the project to a space (M2M); list?spaceId= reflects it', async () => {
    const p = await createProject(`p-${randomUUID().slice(0, 8)}`);
    await api.command('projects.link', { projectId: p.id, clientMutationId: `cmid-link-${randomUUID()}` }, { spaceId: w.spaceId });
    const linked = await api.read('projects.list', {}, { spaceId: w.spaceId }) as ProjectPage;
    expect(linked.items.map((i) => expectValid(ProjectResourceSchema, i, 'linked project').id)).toContain(p.id);

    await api.command('projects.unlink', { clientMutationId: `cmid-unlink-${randomUUID()}` }, { spaceId: w.spaceId, projectId: p.id });
    const after = await api.read('projects.list', {}, { spaceId: w.spaceId }) as ProjectPage;
    expect(after.items.map((i) => (i as ProjectResource).id)).not.toContain(p.id);
  });

  it('linking a nonexistent project is a typed not_found', async () => {
    await expectError(
      api.command('projects.link', { projectId: `proj-missing-${randomUUID()}` }, { spaceId: w.spaceId }),
      'not_found',
    );
  });

  it('project is not an entity kind: entities.create refuses kind "project"', async () => {
    await expectError(api.command('entities.create', {
      spaceId: w.spaceId, kind: 'project', title: 'not an entity',
    }), 'invalid_input');
  });
});
