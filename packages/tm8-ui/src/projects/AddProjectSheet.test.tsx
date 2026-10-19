// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type { EntityId, ProjectCloneJob, ProjectId, SpaceId, SpaceProject } from '@tm8/contract';

import { getKind, resolveAction } from '../domain';
import { rootBirthDispatch } from '../panels/ListRootHeader';
import { AddProjectSheet, addProjectPort, type AddProjectPort } from './AddProjectSheet';

const SPACE = 'space-1' as SpaceId;

const spaceProject: SpaceProject = {
  id: 'project-entity-1' as EntityId,
  spaceId: SPACE,
  folderId: 'folder-1' as ProjectId,
  name: 'Website',
  trust: 'untrusted',
  defaults: {},
  materializedVersion: 1,
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
};

function job(status: ProjectCloneJob['status'], patch: Partial<ProjectCloneJob> = {}): ProjectCloneJob {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    spaceId: SPACE,
    repoUrl: 'https://github.com/octo/hello.git',
    directoryName: 'hello',
    status,
    credentialSource: status === 'queued' ? null : 'member',
    defaultBranch: status === 'succeeded' ? 'main' : null,
    project: status === 'succeeded' ? spaceProject : null,
    error: null,
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    finishedAt: null,
    ...patch,
  };
}

function port(overrides: Partial<AddProjectPort> = {}): AddProjectPort {
  return {
    directories: vi.fn().mockResolvedValue({
      roots: ['/srv/projects'],
      path: '/srv/projects',
      parentPath: null,
      separator: '/',
      directories: [{ name: 'existing', path: '/srv/projects/existing' }],
      truncated: false,
    }),
    add: vi.fn().mockResolvedValue(spaceProject),
    clone: vi.fn().mockResolvedValue(job('queued')),
    cloneJob: vi.fn().mockResolvedValue(job('succeeded')),
    ...overrides,
  };
}

describe('the Projects list is born by Add project (task 01a13574)', () => {
  it('the registry names add-project as the project kind’s birth verb, and the header performs it when wired', () => {
    expect(getKind('project').list.quickStart).toBe('add-project');
    expect(resolveAction('add-project').label).toBe('Add project');
    const onAction = vi.fn();
    const dispatch = rootBirthDispatch('project', { onAction, wiredActions: ['add-project'] });
    expect(dispatch?.refusal).toBeNull();
    dispatch!.perform();
    expect(onAction).toHaveBeenCalledWith('add-project', '');
  });

  it('builds no port for a seam without spaceProjects, or without a space', () => {
    const files = { putBytes: vi.fn() } as never;
    expect(addProjectPort({ files }, SPACE)).toBeNull();
    const spaceProjects = { directories: vi.fn(), add: vi.fn(), clone: vi.fn(), cloneJob: vi.fn() };
    expect(addProjectPort({ files, spaceProjects }, null)).toBeNull();
    const built = addProjectPort({ files, spaceProjects }, SPACE)!;
    void built.directories('/x');
    expect(spaceProjects.directories).toHaveBeenCalledWith(SPACE, '/x');
    expect(built.importFolder).toBeUndefined();
  });
});

describe('AddProjectSheet', () => {
  it('a project left with no working directory is added with none, and the form says it gets ~/<name>', async () => {
    const p = port();
    const onAdded = vi.fn();
    const view = render(<AddProjectSheet nodeLabel="node" port={p} onAdded={onAdded} onCancel={vi.fn()} />);
    fireEvent.change(view.getByLabelText('Project name'), { target: { value: 'Docs Site' } });
    const field = view.getByLabelText('Working directory') as HTMLInputElement;
    expect(field.placeholder).toBe('~/docs-site');
    expect(view.getByTestId('project-default-dir').textContent).toContain('~/docs-site');
    fireEvent.click(view.getByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('project-entity-1'));
    const input = vi.mocked(p.add).mock.calls[0]![0];
    expect(input).toMatchObject({ name: 'Docs Site' });
    // No workingDir and no ensure flag: the server picks and creates ~/docs-site.
    expect('workingDir' in input).toBe(false);
    expect('ensureWorkingDir' in input).toBe(false);
  });

  it('a typed working directory is sent as is', async () => {
    const p = port();
    const view = render(<AddProjectSheet nodeLabel="node" port={p} onAdded={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(view.getByLabelText('Project name'), { target: { value: 'API' } });
    fireEvent.change(view.getByLabelText('Working directory'), { target: { value: '~/repos/api' } });
    expect(view.queryByTestId('project-default-dir')).toBeNull();
    fireEvent.click(view.getByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(p.add).toHaveBeenCalled());
    expect(vi.mocked(p.add).mock.calls[0]![0]).toMatchObject({ name: 'API', workingDir: '~/repos/api' });
    expect('ensureWorkingDir' in vi.mocked(p.add).mock.calls[0]![0]).toBe(false);
  });

  it('refuses an empty directory when the name gives no folder name', async () => {
    const p = port();
    const view = render(<AddProjectSheet nodeLabel="node" port={p} onAdded={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(view.getByLabelText('Project name'), { target: { value: '!!!' } });
    fireEvent.click(view.getByRole('button', { name: 'Add project' }));
    expect(view.getByRole('alert').textContent).toMatch(/choose the folder/);
    expect(p.add).not.toHaveBeenCalled();
  });

  it('adds a folder already on the node through spaces.projects.create', async () => {
    const p = port();
    const onAdded = vi.fn();
    const view = render(<AddProjectSheet nodeLabel="node" port={p} onAdded={onAdded} onCancel={vi.fn()} />);
    fireEvent.change(view.getByLabelText('Project name'), { target: { value: 'Website' } });
    fireEvent.click(view.getByRole('button', { name: 'Browse folders' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Use this folder' })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: /existing/ }));
    await waitFor(() => expect(p.directories).toHaveBeenCalledWith('/srv/projects/existing'));
    fireEvent.click(view.getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(view.getByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('project-entity-1'));
    expect(p.add).toHaveBeenCalledWith(expect.objectContaining({ name: 'Website', workingDir: '/srv/projects' }));
  });

  it('shows the node’s refusal verbatim and keeps the form', async () => {
    const p = port({ add: vi.fn().mockRejectedValue(new Error('only a space admin can add a project to this space; ask a space admin')) });
    const view = render(<AddProjectSheet nodeLabel="node" port={p} onAdded={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(view.getByLabelText('Project name'), { target: { value: 'Website' } });
    fireEvent.click(view.getByRole('button', { name: 'Browse folders' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Use this folder' })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(view.getByRole('button', { name: 'Add project' }));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('ask a space admin'));
    expect((view.getByLabelText('Project name') as HTMLInputElement).value).toBe('Website');
  });

  it('clones a GitHub repository as a job, following it until the project lands', async () => {
    const cloneJob = vi.fn()
      .mockResolvedValueOnce(job('cloning'))
      .mockResolvedValueOnce(job('succeeded'));
    const p = port({ cloneJob });
    const onAdded = vi.fn();
    const view = render(<AddProjectSheet nodeLabel="node" port={p} onAdded={onAdded} onCancel={vi.fn()} pollMs={1} />);
    fireEvent.click(view.getByRole('radio', { name: /GitHub repository/ }));
    fireEvent.change(view.getByLabelText('GitHub repository URL'), { target: { value: 'https://github.com/octo/hello' } });
    // The repository names both the project and the new folder.
    expect((view.getByLabelText('Project name') as HTMLInputElement).value).toBe('hello');
    expect((view.getByLabelText(/New folder name/) as HTMLInputElement).value).toBe('hello');
    fireEvent.click(view.getByRole('button', { name: 'Choose destination' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Use this folder' })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(view.getByRole('button', { name: 'Clone & add' }));
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith('project-entity-1'));
    expect(p.clone).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/octo/hello', destinationParent: '/srv/projects', directoryName: 'hello', name: 'hello',
    }));
    expect(cloneJob).toHaveBeenCalledTimes(2);
  });

  it('a failed clone shows the node’s reason and lets the viewer retry', async () => {
    const p = port({ cloneJob: vi.fn().mockResolvedValue(job('failed', { error: { code: 'upstream_unavailable', message: 'git clone failed: Repository not found' } })) });
    const onAdded = vi.fn();
    const view = render(<AddProjectSheet nodeLabel="node" port={p} onAdded={onAdded} onCancel={vi.fn()} pollMs={1} />);
    fireEvent.click(view.getByRole('radio', { name: /GitHub repository/ }));
    fireEvent.change(view.getByLabelText('GitHub repository URL'), { target: { value: 'octo/hello' } });
    fireEvent.click(view.getByRole('button', { name: 'Choose destination' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Use this folder' })).toBeTruthy());
    fireEvent.click(view.getByRole('button', { name: 'Use this folder' }));
    fireEvent.click(view.getByRole('button', { name: 'Clone & add' }));
    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('Repository not found'));
    expect(onAdded).not.toHaveBeenCalled();
    expect(view.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it('refuses an empty form without a request, and disables upload when the node has none', () => {
    const p = port();
    const view = render(<AddProjectSheet nodeLabel="node" port={p} onAdded={vi.fn()} onCancel={vi.fn()} />);
    expect((view.getByRole('radio', { name: /Upload a folder or files/ }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(view.getByRole('button', { name: 'Add project' }));
    expect(view.getByRole('alert').textContent).toContain('Give the project a name.');
    expect(p.add).not.toHaveBeenCalled();
  });
});
