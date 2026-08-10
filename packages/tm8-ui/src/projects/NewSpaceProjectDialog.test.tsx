// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import type {
  EntityId,
  ProjectId,
  ProjectResource,
  SpaceId,
  SpaceSummary,
} from '@tm8/contract';

import {
  FOLDER_CONNECT_FORBIDDEN,
  NewSpaceProjectDialog,
  newOnboardingMutationIds,
  onboardSpaceProject,
  type ProjectOnboardingPort,
} from './NewSpaceProjectDialog';

const space: SpaceSummary = {
  id: 'space-1' as SpaceId,
  name: 'Studio',
  description: '',
  memberCount: 1,
  unreadTotal: 0,
  createdAt: '2026-08-02T00:00:00.000Z',
};

const project: ProjectResource = {
  id: 'project-1' as ProjectId,
  name: 'Website',
  workingDir: '/srv/projects/website',
  trust: 'untrusted',
  defaults: {},
  createdAt: '2026-08-02T00:00:00.000Z',
  updatedAt: '2026-08-02T00:00:00.000Z',
};

function port(overrides: Partial<ProjectOnboardingPort> = {}): ProjectOnboardingPort {
  return {
    directories: vi.fn().mockResolvedValue({
      roots: ['/srv/projects'],
      path: '/srv/projects',
      parentPath: null,
      separator: '/',
      directories: [{ name: 'existing', path: '/srv/projects/existing' }],
      truncated: false,
    }),
    createSpace: vi.fn().mockResolvedValue({
      space,
      memberId: 'member-1' as EntityId,
      defaultChannelId: 'channel-1' as EntityId,
    }),
    createProject: vi.fn().mockResolvedValue(project),
    linkProject: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn().mockResolvedValue({ patches: [] }),
    ...overrides,
  };
}

describe('Space and node-local project onboarding', () => {
  it('runs the four durable stages in order and records an honest memory', async () => {
    const calls: string[] = [];
    const p = port({
      createSpace: vi.fn(async () => {
        calls.push('space');
        return { space, memberId: 'member-1' as EntityId, defaultChannelId: 'channel-1' as EntityId };
      }),
      createProject: vi.fn(async () => {
        calls.push('project');
        return project;
      }),
      linkProject: vi.fn(async () => { calls.push('link'); }),
      createMemory: vi.fn(async () => {
        calls.push('memory');
        return { patches: [] };
      }),
    });
    const ids = newOnboardingMutationIds('fixed');

    await onboardSpaceProject(p, {
      spaceName: ' Studio ',
      projectName: ' Website ',
      workingDir: '/srv/projects/website',
      ensureWorkingDir: true,
      trusted: false,
    }, ids);

    expect(calls).toEqual(['space', 'project', 'link', 'memory']);
    expect(p.createSpace).toHaveBeenCalledWith({
      name: 'Studio',
      visibility: 'private',
      clientMutationId: ids.space,
    });
    expect(p.createProject).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Website',
      workingDir: '/srv/projects/website',
      ensureWorkingDir: true,
      trust: 'untrusted',
      clientMutationId: ids.project,
    }));
    expect(p.linkProject).toHaveBeenCalledWith(space.id, {
      projectId: project.id,
      clientMutationId: ids.link,
    });
    expect(p.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      clientMutationId: ids.memory,
      spaceId: space.id,
      kind: 'memory',
      content: expect.objectContaining({
        statement: expect.stringContaining('/srv/projects/website'),
        doesNotEstablish: expect.stringContaining('does not establish file synchronization'),
      }),
    }));
  });

  it('browses an allowed node root, selects a new child, and keeps trust off by default', async () => {
    const p = port();
    const onCreated = vi.fn();
    const view = render(
      <NewSpaceProjectDialog
        open
        nodeLabel="local node"
        port={p}
        onDismiss={() => {}}
        onCreated={onCreated}
      />,
    );

    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    fireEvent.change(view.getByLabelText('Project name'), { target: { value: 'Website' } });
    expect((view.getByRole('checkbox', { name: /Trust this folder/ }) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(view.getByRole('button', { name: 'Browse folders' }));

    await waitFor(() => expect(p.directories).toHaveBeenCalledWith(undefined));
    fireEvent.change(view.getByLabelText('Create a new folder here'), { target: { value: 'website' } });
    fireEvent.click(view.getByRole('button', { name: 'Use new folder' }));
    expect(view.getByText('/srv/projects/website')).toBeTruthy();
    fireEvent.click(view.getByRole('button', { name: 'Create Space & add project' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(space));
    expect(p.createProject).toHaveBeenCalledWith(expect.objectContaining({
      workingDir: '/srv/projects/website',
      ensureWorkingDir: true,
      trust: 'untrusted',
    }));
  });

  it('can replay the same mutation ids after a staged failure', async () => {
    const ids = newOnboardingMutationIds('retry');
    const createMemory = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ patches: [] });
    const p = port({ createMemory });
    const input = {
      spaceName: 'Studio',
      projectName: 'Website',
      workingDir: '/srv/projects/website',
      ensureWorkingDir: false,
      trusted: false,
    };

    await expect(onboardSpaceProject(p, input, ids)).rejects.toMatchObject({ stage: 'memory' });
    await expect(onboardSpaceProject(p, input, ids)).resolves.toEqual({ space, project });

    expect(p.createSpace).toHaveBeenNthCalledWith(1, expect.objectContaining({ clientMutationId: ids.space }));
    expect(p.createSpace).toHaveBeenNthCalledWith(2, expect.objectContaining({ clientMutationId: ids.space }));
    expect(p.createProject).toHaveBeenNthCalledWith(1, expect.objectContaining({ clientMutationId: ids.project }));
    expect(p.createProject).toHaveBeenNthCalledWith(2, expect.objectContaining({ clientMutationId: ids.project }));
    expect(createMemory).toHaveBeenNthCalledWith(1, expect.objectContaining({
      clientMutationId: ids.memory,
      content: expect.objectContaining({ measuredAt: ids.measuredAt }),
    }));
    expect(createMemory).toHaveBeenNthCalledWith(2, expect.objectContaining({
      clientMutationId: ids.memory,
      content: expect.objectContaining({ measuredAt: ids.measuredAt }),
    }));
  });

  it('a resolved NON-ADMIN viewer is refused up front: truthful notice, Browse and submit disabled, no saga committed', async () => {
    const p = port();
    const view = render(
      <NewSpaceProjectDialog
        open
        nodeLabel="local node"
        viewerIsNodeAdmin={false}
        port={p}
        onDismiss={() => {}}
        onCreated={() => {}}
      />,
    );
    view.getByText(FOLDER_CONNECT_FORBIDDEN);
    expect((view.getByRole('button', { name: 'Browse folders' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    fireEvent.change(view.getByLabelText('Project name'), { target: { value: 'Website' } });
    expect(
      (view.getByRole('button', { name: 'Create Space & add project' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    // The half-onboarded-Space failure mode: nothing durable may have run.
    expect(p.directories).not.toHaveBeenCalled();
    expect(p.createSpace).not.toHaveBeenCalled();
  });

  it('an UNRESOLVED viewer standing keeps the flow available — the server stays the backstop', async () => {
    const p = port();
    const view = render(
      <NewSpaceProjectDialog
        open
        nodeLabel="local node"
        port={p}
        onDismiss={() => {}}
        onCreated={() => {}}
      />,
    );
    expect(view.queryByText(FOLDER_CONNECT_FORBIDDEN)).toBeNull();
    expect((view.getByRole('button', { name: 'Browse folders' }) as HTMLButtonElement).disabled).toBe(false);
  });
});
