// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { render, renderHook, waitFor } from '@testing-library/react';
import type { ProjectResource } from '@tm8/contract';
import { projectTm8Ui } from '../fixtures';
import type { Seam } from '../data/seam';
import { projectRecordPort, recordFor, shortPath, type ProjectRecordPort } from './project-record';
import { useProjectRowNote } from './ProjectRowNote';

const NOW = '2026-10-20T12:00:00.000Z';

function record(over: Partial<ProjectResource> = {}): ProjectResource {
  return {
    id: 'folder-1',
    name: 'tm8',
    workingDir: '/home/ada/code/tm8',
    projectEntityId: projectTm8Ui.id,
    trust: 'trusted',
    defaults: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function seam(over: Partial<Seam> = {}) {
  return {
    projects: vi.fn(async () => [record()]),
    projectBranches: vi.fn(),
    projectContention: vi.fn(),
    ...over,
  } as unknown as Pick<Seam, 'projects' | 'projectBranches' | 'projectContention' | 'projectAdmin' | 'projectSetup'>;
}

describe('projectRecordPort', () => {
  it('is one port per seam and space, so a read keyed on it does not re-run each render', () => {
    const s = seam();
    expect(projectRecordPort(s, 'space-1')).toBe(projectRecordPort(s, 'space-1'));
    expect(projectRecordPort(s, 'space-2')).not.toBe(projectRecordPort(s, 'space-1'));
    expect(projectRecordPort(s, null)).toBeNull();
  });

  it('offers update only over a seam that can make projects.update, with a mutation id', async () => {
    expect(projectRecordPort(seam(), 'space-1')!.update).toBeUndefined();
    const update = vi.fn(async () => record());
    const port = projectRecordPort(seam({ projectAdmin: { update } }), 'space-1')!;
    await port.update!('folder-1', { trust: 'untrusted' });
    expect(update).toHaveBeenCalledWith('folder-1', expect.objectContaining({ trust: 'untrusted', clientMutationId: expect.stringMatching(/^project-update:/) }));
  });
});

describe('recordFor', () => {
  it('matches the project entity, or the folder its content names', () => {
    const rows = [record(), record({ id: 'folder-2', projectEntityId: null })];
    expect(recordFor(rows, projectTm8Ui.id)?.id).toBe('folder-1');
    expect(recordFor(rows, 'other', { projectId: 'folder-2' } as never)?.id).toBe('folder-2');
    expect(recordFor(rows, 'nobody')).toBeNull();
  });
});

describe('shortPath', () => {
  it('folds a home directory to ~', () => {
    expect(shortPath('/home/ada/code/tm8')).toBe('~/code/tm8');
    expect(shortPath('/Users/ada')).toBe('~');
    expect(shortPath('/srv/tm8')).toBe('/srv/tm8');
  });
});

describe('useProjectRowNote', () => {
  function port(rows: ProjectResource[]): ProjectRecordPort {
    return { list: vi.fn(async () => rows), branches: vi.fn(), worktrees: vi.fn() };
  }

  it('gives a project row its folder, and says when it is untrusted', async () => {
    const p = port([record({ trust: 'untrusted' })]);
    const { result } = renderHook(() => useProjectRowNote(p));
    await waitFor(() => expect(result.current!(projectTm8Ui)).not.toBeNull());
    const view = render(<div>{result.current!(projectTm8Ui)}</div>);
    expect(view.container.textContent).toBe('~/code/tm8· untrusted');
  });

  it('tells a member the path is hidden rather than drawing nothing', async () => {
    const p = port([record({ workingDir: undefined })]);
    const { result } = renderHook(() => useProjectRowNote(p));
    await waitFor(() => expect(result.current!(projectTm8Ui)).not.toBeNull());
    const view = render(<div>{result.current!(projectTm8Ui)}</div>);
    expect(view.container.textContent).toContain('folder: node admins only');
  });

  it('is absent without a port, so other lists keep their rows', () => {
    const { result } = renderHook(() => useProjectRowNote(null));
    expect(result.current).toBeUndefined();
  });
});
