// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { CollabError, type ProjectId, type ProjectResource } from '@tm8/contract';

import { FIXTURE_BRANCH_TOPOLOGY } from '../fixtures';
import {
  BranchTopologyList,
  ProjectBranchesSection,
  type ProjectBranchesPort,
} from './BranchTopologyList';

const project: ProjectResource = {
  id: 'proj-tm8ui' as ProjectId,
  name: 'tm8-ui',
  workingDir: '/fixture/tm8-ui',
  trust: 'trusted',
  defaults: {},
  createdAt: '2026-07-28T12:00:00.000Z',
  updatedAt: '2026-07-28T12:00:00.000Z',
};

function port(overrides: Partial<ProjectBranchesPort> = {}): ProjectBranchesPort {
  return {
    projects: vi.fn().mockResolvedValue([project]),
    branches: vi.fn().mockResolvedValue(FIXTURE_BRANCH_TOPOLOGY),
    ...overrides,
  };
}

describe('BranchTopologyList', () => {
  it('renders the trunk WITH its provenance — the source is never dropped', () => {
    const r = render(<BranchTopologyList topology={FIXTURE_BRANCH_TOPOLOGY} />);
    expect(r.container.querySelector('.brt__trunk')?.textContent).toBe('trunk main');
    // 'origin_head' is a different claim than a guess; the label says which.
    expect(r.getByTestId('trunk-source').textContent).toBe("from the remote's HEAD");
  });

  it('states the guessed provenances too, in their own words', () => {
    const guessed = { ...FIXTURE_BRANCH_TOPOLOGY, defaultBranchSource: 'current_branch' as const };
    const r = render(<BranchTopologyList topology={guessed} />);
    expect(r.getByTestId('trunk-source').textContent).toBe('guessed from the checked-out branch');
  });

  it('shows drift per branch and "trunk" on the default row — never "0 behind main" on main itself', () => {
    const r = render(<BranchTopologyList topology={FIXTURE_BRANCH_TOPOLOGY} />);
    const rows = r.getAllByTestId('branch-row');
    expect(rows).toHaveLength(5);

    const mainRow = rows.find((row) => row.textContent?.includes('main'))!;
    expect(mainRow.textContent).toContain('trunk');
    expect(mainRow.textContent).not.toContain('↑0');

    const drifted = rows.find((row) => row.textContent?.includes('feat/diff-renderer'))!;
    expect(drifted.textContent).toContain('↑3');
    expect(drifted.textContent).toContain('↓11');
  });

  it('marks current, merged and stale with worded pills (colour is never alone)', () => {
    const r = render(<BranchTopologyList topology={FIXTURE_BRANCH_TOPOLOGY} />);
    const rows = r.getAllByTestId('branch-row');
    const current = rows.find((row) => row.textContent?.includes('feat/branch-topology-ui'))!;
    expect(current.textContent).toContain('current');
    const merged = rows.find((row) => row.textContent?.includes('fix/gate-localstorage'))!;
    expect(merged.textContent).toContain('merged');
    const stale = rows.find((row) => row.textContent?.includes('spike/old-terminal-probe'))!;
    expect(stale.textContent).toContain('stale');
    expect(stale.textContent).toContain('no upstream');
  });

  it('a truncated read is a STATED cut; an untruncated one says nothing', () => {
    const r1 = render(
      <BranchTopologyList topology={{ ...FIXTURE_BRANCH_TOPOLOGY, truncated: true }} />,
    );
    expect(r1.getByTestId('branch-truncated')).toBeTruthy();
    r1.unmount();

    const r2 = render(<BranchTopologyList topology={FIXTURE_BRANCH_TOPOLOGY} />);
    expect(r2.queryByTestId('branch-truncated')).toBeNull();
  });

  it('zero branches is an explained empty, not a blank region', () => {
    const r = render(
      <BranchTopologyList topology={{ ...FIXTURE_BRANCH_TOPOLOGY, branches: [] }} />,
    );
    expect(r.getByText(/no local branches/)).toBeTruthy();
  });
});

describe('ProjectBranchesSection', () => {
  it('lists linked projects and fetches branches ONLY on expand — one rev-list per branch is a budget', async () => {
    const p = port();
    const r = render(<ProjectBranchesSection port={p} />);
    await waitFor(() => expect(r.getByTestId('project-branches-row')).toBeTruthy());
    expect(p.branches).not.toHaveBeenCalled();

    fireEvent.click(r.getByRole('button', { name: 'show branches' }));
    await waitFor(() => expect(r.getByTestId('branch-topology')).toBeTruthy());
    expect(p.branches).toHaveBeenCalledWith('proj-tm8ui');

    // Collapse and re-open: the loaded answer is kept, not re-fetched.
    fireEvent.click(r.getByRole('button', { name: 'hide branches' }));
    fireEvent.click(r.getByRole('button', { name: 'show branches' }));
    await waitFor(() => expect(r.getByTestId('branch-topology')).toBeTruthy());
    expect(p.branches).toHaveBeenCalledTimes(1);

    // Refresh is the deliberate re-read.
    fireEvent.click(r.getByRole('button', { name: 'refresh' }));
    await waitFor(() => expect(p.branches).toHaveBeenCalledTimes(2));
  });

  it('invalid_input renders as a fact about the project, not a tm8 fault', async () => {
    const p = port({
      branches: vi
        .fn()
        .mockRejectedValue(new CollabError('invalid_input', 'workingDir is not a git repository')),
    });
    const r = render(<ProjectBranchesSection port={p} />);
    await waitFor(() => expect(r.getByRole('button', { name: 'show branches' })).toBeTruthy());
    fireEvent.click(r.getByRole('button', { name: 'show branches' }));
    await waitFor(() => expect(r.getByTestId('branches-error')).toBeTruthy());
    expect(r.getByTestId('branches-error').textContent).toContain('not a git repository');
    expect(r.getByTestId('branches-error').textContent).not.toContain('read failed');
  });

  it('other rejections say the READ failed, with the message carried', async () => {
    const p = port({
      branches: vi.fn().mockRejectedValue(new CollabError('upstream_unavailable', 'node unreachable')),
    });
    const r = render(<ProjectBranchesSection port={p} />);
    await waitFor(() => expect(r.getByRole('button', { name: 'show branches' })).toBeTruthy());
    fireEvent.click(r.getByRole('button', { name: 'show branches' }));
    await waitFor(() => expect(r.getByTestId('branches-error')).toBeTruthy());
    expect(r.getByTestId('branches-error').textContent).toContain('read failed');
    expect(r.getByTestId('branches-error').textContent).toContain('node unreachable');
  });

  it('zero linked projects is an explained empty; a failed projects read is a stated failure', async () => {
    const empty = render(<ProjectBranchesSection port={port({ projects: vi.fn().mockResolvedValue([]) })} />);
    await waitFor(() => expect(empty.getByText(/No projects are linked/)).toBeTruthy());

    const broken = render(
      <ProjectBranchesSection
        port={port({ projects: vi.fn().mockRejectedValue(new CollabError('forbidden', 'not a member')) })}
      />,
    );
    await waitFor(() => expect(broken.getByTestId('projects-error')).toBeTruthy());
    expect(broken.getByTestId('projects-error').textContent).toContain('not a member');
  });
});
