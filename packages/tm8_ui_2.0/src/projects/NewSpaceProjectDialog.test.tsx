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
  validateOnboarding,
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

const folderSource = {
  name: 'Website',
  trusted: false,
  source: { kind: 'folder' as const, workingDir: '/srv/projects/website', ensureWorkingDir: true },
};

function addProject(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole('checkbox', { name: /Add a project/ }));
}

describe('Create Space — the Space alone', () => {
  it('creates a Space with no project at all: one command, no project saga', async () => {
    const p = port();
    const onCreated = vi.fn();
    const view = render(
      <NewSpaceProjectDialog open nodeLabel="local node" port={p} onDismiss={() => {}} onCreated={onCreated} />,
    );

    expect(view.getByRole('heading', { name: 'Create Space' })).toBeTruthy();
    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    fireEvent.click(view.getByRole('button', { name: 'Create Space' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(space));
    expect(p.createProject).not.toHaveBeenCalled();
    expect(p.linkProject).not.toHaveBeenCalled();
    expect(p.createMemory).not.toHaveBeenCalled();
  });

  it('an EMPTY name shows an inline error and makes NO request', async () => {
    const p = port();
    const view = render(
      <NewSpaceProjectDialog open nodeLabel="local node" port={p} onDismiss={() => {}} onCreated={() => {}} />,
    );

    fireEvent.click(view.getByRole('button', { name: 'Create Space' }));

    expect(view.getByRole('alert').textContent).toContain('Give the Space a name.');
    expect(p.createSpace).not.toHaveBeenCalled();
  });

  it('validation names the missing piece for each source, and passes when complete', () => {
    expect(validateOnboarding({ spaceName: '   ' })).toContain('Space a name');
    expect(validateOnboarding({ spaceName: 'Studio' })).toBeNull();
    expect(validateOnboarding({
      spaceName: 'Studio',
      project: { ...folderSource, name: '  ' },
    })).toContain('project a name');
    expect(validateOnboarding({
      spaceName: 'Studio',
      project: { ...folderSource, source: { kind: 'folder', workingDir: '', ensureWorkingDir: false } },
    })).toContain('local folder');
    expect(validateOnboarding({
      spaceName: 'Studio',
      project: {
        name: 'Website',
        trusted: false,
        source: { kind: 'github', repoUrl: 'not a url', workingDir: '/srv/x', ensureWorkingDir: true },
      },
    })).toContain('GitHub repository URL');
    expect(validateOnboarding({
      spaceName: 'Studio',
      project: {
        name: 'Website',
        trusted: false,
        source: { kind: 'upload', destinationParent: '/srv/projects', rootName: 'website', files: [] },
      },
    })).toContain('folder or files to upload');
    expect(validateOnboarding({ spaceName: 'Studio', project: folderSource })).toBeNull();
  });
});

describe('Create Space — a project from a node-local folder', () => {
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
      project: { ...folderSource, name: ' Website ' },
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
      <NewSpaceProjectDialog open nodeLabel="local node" port={p} onDismiss={() => {}} onCreated={onCreated} />,
    );

    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    addProject(view);
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

  it('names the consequence when browsing lands on the filesystem root, and keeps it on the selection', async () => {
    // The picker OPENS on home, but `/` is one click away in the roots rail
    // and up the parent chain, so an admin can still land here. Choosing it is
    // allowed — they may mean it — but it exposes every readable file under
    // that path to every member of the space through the file browser, so it
    // must not be silent. The default stops the common case; this stops the
    // determined one.
    const p = port({
      directories: vi.fn().mockResolvedValue({
        roots: ['/'],
        path: '/',
        parentPath: null,
        separator: '/',
        directories: [{ name: 'srv', path: '/srv' }],
        truncated: false,
      }),
    });
    const view = render(
      <NewSpaceProjectDialog open nodeLabel="local node" port={p} onDismiss={() => {}} onCreated={() => {}} />,
    );

    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    addProject(view);
    fireEvent.click(view.getByRole('button', { name: 'Browse folders' }));
    await waitFor(() => expect(p.directories).toHaveBeenCalled());

    const warned = await view.findAllByRole('alert');
    expect(warned.some((el) => /root of the whole filesystem/.test(el.textContent ?? ''))).toBe(true);
    expect(warned.some((el) => /every member of this space will be able to read/i.test(el.textContent ?? '')))
      .toBe(true);

    // Taking it anyway is permitted, and the warning follows the selection out
    // of the browser rather than vanishing with the dialog that raised it.
    fireEvent.click(view.getByRole('button', { name: 'Use this folder' }));
    await waitFor(() => {
      const alerts = view.getAllByRole('alert');
      expect(alerts.some((el) => /root of the whole filesystem/.test(el.textContent ?? ''))).toBe(true);
    });
  });

  it('stays quiet for an ordinary project folder', async () => {
    const p = port();
    const view = render(
      <NewSpaceProjectDialog open nodeLabel="local node" port={p} onDismiss={() => {}} onCreated={() => {}} />,
    );
    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    addProject(view);
    fireEvent.click(view.getByRole('button', { name: 'Browse folders' }));
    await waitFor(() => expect(p.directories).toHaveBeenCalled());

    // `/srv/projects` is broad-ish but it is not a home directory and not the
    // root; warning here would be the noise that teaches admins to click
    // through the warning that matters.
    expect(view.queryAllByRole('alert').some((el) => /able to read files under it/.test(el.textContent ?? '')))
      .toBe(false);
  });

  it('a folder that already HAS a project links that project instead of dead-ending on the constraint', async () => {
    // `working_dir` is node-globally unique by design; the raw
    // `projects_working_dir_key` refusal used to surface verbatim and Retry
    // could only ever replay it. The existing project IS what the user
    // pointed at, so the saga finds it and links it.
    const existing: ProjectResource = {
      ...project,
      id: 'project-existing' as ProjectId,
      name: 'tm8',
      trust: 'trusted',
    };
    const p = port({
      createProject: vi.fn().mockRejectedValue(
        new Error('duplicate key value violates unique constraint "projects_working_dir_key"'),
      ),
      listProjects: vi.fn().mockResolvedValue([
        { ...project, id: 'project-other' as ProjectId, workingDir: '/srv/projects/other' },
        existing,
      ]),
    });
    const ids = newOnboardingMutationIds('reuse');

    const result = await onboardSpaceProject(p, { spaceName: 'Studio', project: folderSource }, ids);

    expect(result.project).toEqual(existing);
    expect(p.linkProject).toHaveBeenCalledWith(space.id, {
      projectId: existing.id,
      clientMutationId: ids.link,
    });
    // The recorded memory says the truth: reused, not created.
    expect(p.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({
        statement: expect.stringContaining('EXISTING project'),
        mechanism: expect.stringContaining('already-connected folder'),
      }),
    }));
  });

  it('a working-dir conflict with NO project match still surfaces the original refusal', async () => {
    const conflict = new Error('duplicate key value violates unique constraint "projects_working_dir_key"');
    const p = port({
      createProject: vi.fn().mockRejectedValue(conflict),
      listProjects: vi.fn().mockResolvedValue([
        { ...project, workingDir: '/srv/projects/unrelated' },
      ]),
    });

    await expect(
      onboardSpaceProject(p, { spaceName: 'Studio', project: folderSource }, newOnboardingMutationIds('x')),
    ).rejects.toMatchObject({ stage: 'project', message: conflict.message });
    expect(p.linkProject).not.toHaveBeenCalled();
  });

  it('a port without listProjects keeps the old behavior: the conflict propagates', async () => {
    const conflict = new Error('duplicate key value violates unique constraint "projects_working_dir_key"');
    // port() carries no listProjects unless a test provides one.
    const p = port({ createProject: vi.fn().mockRejectedValue(conflict) });

    await expect(
      onboardSpaceProject(p, { spaceName: 'Studio', project: folderSource }, newOnboardingMutationIds('y')),
    ).rejects.toMatchObject({ stage: 'project', message: conflict.message });
  });

  it('a NON-conflict createProject failure never triggers the lookup', async () => {
    const p = port({
      createProject: vi.fn().mockRejectedValue(new Error('forbidden: node-admin access is required')),
      listProjects: vi.fn(),
    });

    await expect(
      onboardSpaceProject(p, { spaceName: 'Studio', project: folderSource }, newOnboardingMutationIds('z')),
    ).rejects.toMatchObject({ stage: 'project' });
    expect(p.listProjects).not.toHaveBeenCalled();
  });

  it('can replay the same mutation ids after a staged failure', async () => {
    const ids = newOnboardingMutationIds('retry');
    const createMemory = vi.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockResolvedValueOnce({ patches: [] });
    const p = port({ createMemory });
    const input = { spaceName: 'Studio', project: folderSource };

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
  });
});

describe('Create Space — server error and double submit', () => {
  it('a REJECTED creation keeps the dialog open with every value preserved', async () => {
    const p = port({ createSpace: vi.fn().mockRejectedValue(new Error('name already taken')) });
    const onCreated = vi.fn();
    const view = render(
      <NewSpaceProjectDialog open nodeLabel="local node" port={p} onDismiss={() => {}} onCreated={onCreated} />,
    );

    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    fireEvent.click(view.getByRole('button', { name: 'Create Space' }));

    await waitFor(() => expect(view.getByRole('alert').textContent).toContain('name already taken'));
    expect(onCreated).not.toHaveBeenCalled();
    // The input survived the refusal — retyping it is the bug this guards.
    expect((view.getByLabelText('Space name') as HTMLInputElement).value).toBe('Studio');
    expect(view.getByRole('dialog')).toBeTruthy();
  });

  it('TWO clicks in the same tick create exactly one Space', async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const createSpace = vi.fn(async () => {
      await gate;
      return { space, memberId: 'member-1' as EntityId, defaultChannelId: 'channel-1' as EntityId };
    });
    const p = port({ createSpace });
    const onCreated = vi.fn();
    const view = render(
      <NewSpaceProjectDialog open nodeLabel="local node" port={p} onDismiss={() => {}} onCreated={onCreated} />,
    );

    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    const button = view.getByRole('button', { name: 'Create Space' });
    fireEvent.click(button);
    fireEvent.click(button);

    expect(createSpace).toHaveBeenCalledTimes(1);
    release!();
    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(createSpace).toHaveBeenCalledTimes(1);
  });
});

describe('Create Space — GitHub repository', () => {
  it('RECORDS repoUrl on the project and clones nothing', async () => {
    const p = port();
    const ids = newOnboardingMutationIds('gh');

    await onboardSpaceProject(p, {
      spaceName: 'Studio',
      project: {
        name: 'Website',
        trusted: false,
        source: {
          kind: 'github',
          repoUrl: 'https://github.com/acme/website',
          workingDir: '/srv/projects/website',
          ensureWorkingDir: true,
        },
      },
    }, ids);

    expect(p.createProject).toHaveBeenCalledWith(expect.objectContaining({
      repoUrl: 'https://github.com/acme/website',
      workingDir: '/srv/projects/website',
    }));
    expect(p.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({
        statement: expect.stringContaining('nothing has been cloned'),
        doesNotEstablish: expect.stringContaining('does not establish a clone'),
      }),
    }));
  });

  it('suggests the project name from the repository URL', async () => {
    const p = port();
    const view = render(
      <NewSpaceProjectDialog open nodeLabel="local node" port={p} onDismiss={() => {}} onCreated={() => {}} />,
    );
    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    addProject(view);
    fireEvent.click(view.getByRole('radio', { name: /GitHub repository/ }));
    fireEvent.change(view.getByLabelText('GitHub repository URL'), {
      target: { value: 'https://github.com/acme/website.git' },
    });
    expect((view.getByLabelText('Project name') as HTMLInputElement).value).toBe('website');
  });
});

describe('Create Space — uploaded folder', () => {
  it('imports the picked files into a new root and skips the separate link call', async () => {
    const importFolder = vi.fn(() => ({ result: Promise.resolve(project), cancel: vi.fn() }));
    const p = port({ importFolder });
    const files = [{ file: new File(['x'], 'index.html'), relativePath: 'site/index.html' }];

    const result = await onboardSpaceProject(p, {
      spaceName: 'Studio',
      project: {
        name: 'Website',
        trusted: true,
        source: { kind: 'upload', destinationParent: '/srv/projects', rootName: 'site', files },
      },
    }, newOnboardingMutationIds('up'));

    expect(importFolder).toHaveBeenCalledWith(expect.objectContaining({
      spaceId: space.id,
      projectName: 'Website',
      destinationParent: '/srv/projects',
      rootName: 'site',
      trust: 'trusted',
      files,
    }));
    // `folderUploads.complete` links the project itself; a second link would
    // be a duplicate, not a safety net.
    expect(p.linkProject).not.toHaveBeenCalled();
    expect(result.project).toEqual(project);
    expect(p.createMemory).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.objectContaining({ statement: expect.stringContaining('uploaded from a browser') }),
    }));
  });

  it('a node that does not serve folder uploads disables the radio instead of failing at submit', () => {
    const view = render(
      <NewSpaceProjectDialog open nodeLabel="local node" port={port()} onDismiss={() => {}} onCreated={() => {}} />,
    );
    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    addProject(view);
    expect((view.getByRole('radio', { name: /Upload a folder or files/ }) as HTMLInputElement).disabled).toBe(true);
  });
});

describe('Create Space — node-admin standing', () => {
  it('a resolved NON-ADMIN viewer loses the PROJECT section but still gets the Space', async () => {
    const p = port();
    const onCreated = vi.fn();
    const view = render(
      <NewSpaceProjectDialog
        open
        nodeLabel="local node"
        viewerIsNodeAdmin={false}
        port={p}
        onDismiss={() => {}}
        onCreated={onCreated}
      />,
    );
    view.getByText(FOLDER_CONNECT_FORBIDDEN);
    expect((view.getByRole('checkbox', { name: /Add a project/ }) as HTMLInputElement).disabled).toBe(true);

    fireEvent.change(view.getByLabelText('Space name'), { target: { value: 'Studio' } });
    fireEvent.click(view.getByRole('button', { name: 'Create Space' }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledWith(space));
    // The half-onboarded-Space failure mode: no project may have been attempted.
    expect(p.createProject).not.toHaveBeenCalled();
    expect(p.directories).not.toHaveBeenCalled();
  });

  it('an UNRESOLVED viewer standing keeps the flow available — the server stays the backstop', () => {
    const view = render(
      <NewSpaceProjectDialog open nodeLabel="local node" port={port()} onDismiss={() => {}} onCreated={() => {}} />,
    );
    expect(view.queryByText(FOLDER_CONNECT_FORBIDDEN)).toBeNull();
    expect((view.getByRole('checkbox', { name: /Add a project/ }) as HTMLInputElement).disabled).toBe(false);
  });
});
