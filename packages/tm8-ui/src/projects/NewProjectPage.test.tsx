// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { ProjectId, ProjectResource, SpaceId } from '@tm8/contract';

import { NewProjectPage, PROJECT_ADD_FORBIDDEN } from './NewProjectPage';
import { explainProjectError, folderBaseName, type ProjectAddPort } from './project-draft';
import { getKind } from '../domain/registry';
import { resolveAction } from '../domain/actions';
import { build, defaultRoute, parse } from '../routes/codec';

const space = { id: 'space-tm8' as SpaceId, name: 'tm8' };

const project: ProjectResource = {
  id: 'project-1' as ProjectId,
  name: 'tm8-space',
  workingDir: '/home/tm8/projects/tm8-space',
  trust: 'trusted',
  defaults: {},
  createdAt: '2026-10-02T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

function port(overrides: Partial<ProjectAddPort> = {}): ProjectAddPort {
  return {
    directories: vi.fn().mockImplementation(async (path?: string) => ({
      roots: ['/home/tm8/projects'],
      path: path ?? '/home/tm8/projects',
      parentPath: path ? '/home/tm8/projects' : null,
      separator: '/',
      directories: path ? [] : [{ name: 'tm8-space', path: '/home/tm8/projects/tm8-space' }],
      truncated: false,
    })),
    createProject: vi.fn().mockResolvedValue(project),
    linkProject: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn().mockResolvedValue({ patches: [] }),
    ...overrides,
  };
}

function renderPage(p: ProjectAddPort | null, extra: Partial<Parameters<typeof NewProjectPage>[0]> = {}) {
  const onCreated = vi.fn();
  const view = render(
    <NewProjectPage space={space} nodeLabel="local node" port={p} onCreated={onCreated} onCancel={() => {}} {...extra} />,
  );
  return { view, onCreated };
}

async function pickFolder(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole('button', { name: 'Browse folders' }));
  await waitFor(() => view.getByRole('button', { name: /tm8-space/ }));
  fireEvent.click(view.getByRole('button', { name: /tm8-space/ }));
  await waitFor(() => view.getByText('/home/tm8/projects/tm8-space'));
  fireEvent.click(view.getByRole('button', { name: 'Use this folder' }));
}

describe('Create Project page — adds to the CURRENT space', () => {
  it('creates and links the project into this space, trusted by default, named from the folder', async () => {
    const p = port();
    const { view, onCreated } = renderPage(p);
    expect((view.getByRole('checkbox', { name: /Trust this folder/ }) as HTMLInputElement).checked).toBe(true);

    await pickFolder(view);
    expect((view.getByLabelText('Project name') as HTMLInputElement).value).toBe('tm8-space');
    fireEvent.change(view.getByLabelText('Project name'), { target: { value: 'tm8' } });
    fireEvent.click(view.getByRole('button', { name: 'Create project' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(project, false));
    expect(p.createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'tm8',
      workingDir: '/home/tm8/projects/tm8-space',
      ensureWorkingDir: false,
      trust: 'trusted',
    }));
    expect(p.linkProject).toHaveBeenCalledWith('space-tm8', expect.objectContaining({ projectId: 'project-1' }));
    expect(p.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: 'space-tm8',
      content: expect.objectContaining({ mechanism: expect.stringContaining('the Create Project page') }),
    }));
  });

  it('never overwrites a typed name with the folder suggestion', async () => {
    const { view } = renderPage(port());
    fireEvent.change(view.getByLabelText('Project name'), { target: { value: 'mine' } });
    await pickFolder(view);
    expect((view.getByLabelText('Project name') as HTMLInputElement).value).toBe('mine');
  });

  it('an incomplete draft makes no request', () => {
    const p = port();
    const { view } = renderPage(p);
    fireEvent.click(view.getByRole('button', { name: 'Create project' }));
    view.getByText('Give the project a name, or remove the project.');
    expect(p.createProject).not.toHaveBeenCalled();
  });
});

describe('Create Project page — refusals explained, not raw', () => {
  it('a NON-ADMIN viewer sees what to ask for, and every source is disabled', () => {
    const p = port();
    const { view } = renderPage(p, { viewerIsNodeAdmin: false });
    view.getByText(PROJECT_ADD_FORBIDDEN);
    expect((view.getByRole('button', { name: 'Create project' }) as HTMLButtonElement).disabled).toBe(true);
    expect((view.getByRole('button', { name: 'Browse folders' }) as HTMLButtonElement).closest('fieldset')!.disabled).toBe(true);
  });

  it('a folder granted to ANOTHER space is explained in plain words', async () => {
    const p = port({ linkProject: vi.fn().mockRejectedValue(new Error('this folder belongs to another space')) });
    const { view, onCreated } = renderPage(p);
    await pickFolder(view);
    fireEvent.click(view.getByRole('button', { name: 'Create project' }));
    await waitFor(() => view.getByText(/already a project in another Space/));
    expect(view.queryByText(/^.*this folder belongs to another space.*$/)).toBeNull();
    expect(onCreated).not.toHaveBeenCalled();
    view.getByRole('button', { name: 'Retry' });
  });

  it('a server gate-admin refusal is explained the same way as the up-front one', () => {
    expect(explainProjectError(new Error('forbidden: gate-admin access is required to register a folder')))
      .toMatch(/Only a node admin can register a folder/);
    expect(explainProjectError(new Error('disk on fire'))).toBe('disk on fire');
  });

  it('with no node filesystem on this seam, says so and offers nothing', () => {
    const { view } = renderPage(null);
    view.getByText(/no access to the node’s folders/);
    expect(view.queryByRole('button', { name: 'Browse folders' })).toBeNull();
  });
});

describe('Create Project — the door', () => {
  it('the project kind is born by `new-project`, and the route round-trips', () => {
    expect(getKind('project').list.quickStart).toBe('new-project');
    expect(resolveAction('new-project').availability({} as never)).toEqual({ kind: 'available' });
    const { hash } = build(defaultRoute('019fbd5a-3c5b-71ea-9b91-1d3baa50da25' as SpaceId, { view: 'newProject' }));
    expect(hash).toMatch(/\/new-project$/);
    expect(parse(hash).route?.target).toEqual({ view: 'newProject' });
  });

  it('folderBaseName reads either separator and ignores a trailing one', () => {
    expect(folderBaseName('/home/tm8/projects/tm8-space/')).toBe('tm8-space');
    expect(folderBaseName('C:\\work\\site')).toBe('site');
    expect(folderBaseName('/')).toBe('');
  });
});
