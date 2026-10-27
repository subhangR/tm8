// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, waitFor, within } from '@testing-library/react';
import {
  CollabError,
  type EdgeView,
  type EntityDetail,
  type EntitySummary,
  type ProjectBranchTopology,
  type ProjectResource,
} from '@tm8/contract';
import { getKind } from '../../domain';
import { ada, fixtureDetails, projectTm8Ui, sessionLive, taskQueued } from '../../fixtures';
import type { ProjectRecordPort } from '../../projects/project-record';
import { GovernedWithRecord } from './GovernedWithRecord';
import type { GovernedBlockRef } from './GovernedBody';

/**
 * THE PROJECT PAGE (task 01a15a00): the folder and its trust read from the
 * node record, changed in place by the one viewer the node accepts it from,
 * the folder's git, and everything recorded in the project with a kind filter.
 */

const NOW = '2026-10-20T12:00:00.000Z';
const BLOCKS = getKind('project').panel.blocks as readonly GovernedBlockRef[];

function record(over: Partial<ProjectResource> = {}): ProjectResource {
  return {
    id: 'proj-tm8ui',
    name: 'tm8-ui',
    workingDir: '/home/ada/code/tm8',
    projectEntityId: projectTm8Ui.id,
    trust: 'untrusted',
    defaults: {},
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

const TOPOLOGY: ProjectBranchTopology = {
  projectId: 'proj-tm8ui',
  defaultBranch: 'main',
  defaultBranchSource: 'origin_head',
  truncated: false,
  staleAfterDays: 30,
  branches: [
    { name: 'main', head: 'aaaaaaa1', lastCommitAt: NOW, subject: 'release', upstream: 'origin/main', ahead: 0, behind: 0, isDefault: true, isCurrent: false, merged: true, stale: false },
    { name: 'feat/folder', head: 'bbbbbbb2', lastCommitAt: NOW, subject: 'show the folder', upstream: null, ahead: 3, behind: 1, isDefault: false, isCurrent: true, merged: false, stale: false },
  ],
};

function makePort(over: Partial<ProjectRecordPort> = {}, records: ProjectResource[] = [record()]): ProjectRecordPort {
  return {
    list: vi.fn(async () => records),
    branches: vi.fn(async () => TOPOLOGY),
    worktrees: vi.fn(async () => ({ projectId: 'proj-tm8ui', generatedAt: NOW, lanes: [], pairs: [] })),
    update: vi.fn(async (_id, patch) => ({ ...record(), ...patch, projectEntityId: undefined })),
    ...over,
  };
}

function edge(id: string, source: EntitySummary, target: EntitySummary): EdgeView {
  return { id, type: 'in_project', source, target, props: {}, createdBy: ada, createdAt: NOW, updatedAt: NOW };
}

function detail(linked: readonly EntitySummary[] = []): EntityDetail {
  const base = fixtureDetails[projectTm8Ui.id]!;
  return {
    ...base,
    connections: {
      ...base.connections,
      incoming: linked.length
        ? [{ type: 'in_project', direction: 'incoming', label: 'in project', edges: linked.map((row, i) => edge(`e${i}`, row, base)) }]
        : [],
    },
  };
}

function renderPage(port: ProjectRecordPort | null, linked: readonly EntitySummary[] = []) {
  return render(
    <div className="cv2-root">
      <GovernedWithRecord detail={detail(linked)} blocks={BLOCKS} port={port} onOpenEntity={vi.fn()} />
    </div>,
  );
}

describe('the working folder', () => {
  it('shows the node record’s path and says what starts there', async () => {
    const view = renderPage(makePort());
    const path = await view.findByText('/home/ada/code/tm8');
    expect(path).toBeTruthy();
    expect(view.getByTestId('governed-path').textContent).toContain('start in this folder');
  });

  it('lets the viewer who can see the path change it, through projects.update', async () => {
    const port = makePort();
    const view = renderPage(port);
    fireEvent.click(await view.findByTestId('governed-path-edit'));
    const field = view.getByLabelText('Working folder') as HTMLInputElement;
    expect(field.value).toBe('/home/ada/code/tm8');
    fireEvent.change(field, { target: { value: '/home/ada/code/other' } });
    fireEvent.click(view.getByRole('button', { name: 'Save folder' }));
    await waitFor(() => expect(port.update).toHaveBeenCalledWith('proj-tm8ui', { workingDir: '/home/ada/code/other' }));
    // The answer replaces the record in place: the new path shows, the editor closes.
    expect(await view.findByText('/home/ada/code/other')).toBeTruthy();
    expect(view.queryByTestId('governed-folder-edit')).toBeNull();
  });

  it('keeps the editor open with the node’s refusal', async () => {
    const port = makePort({ update: vi.fn(async () => { throw new Error('gate admin required'); }) });
    const view = renderPage(port);
    fireEvent.click(await view.findByTestId('governed-path-edit'));
    fireEvent.change(view.getByLabelText('Working folder'), { target: { value: '/srv/x' } });
    fireEvent.click(view.getByRole('button', { name: 'Save folder' }));
    expect((await view.findByRole('alert')).textContent).toContain('gate admin required');
    expect(view.getByTestId('governed-folder-edit')).toBeTruthy();
  });

  it('tells a member the path is node-admin only, and offers no edit', async () => {
    const view = renderPage(makePort({}, [record({ workingDir: undefined })]));
    expect((await view.findByTestId('governed-path-hidden')).textContent).toContain('Only a node admin');
    expect(view.queryByTestId('governed-path-edit')).toBeNull();
  });

  it('with no port, the path reads as not loaded — never as empty', () => {
    const view = renderPage(null);
    expect(view.getByTestId('governed-path-hollow').textContent).toContain('Folder not loaded');
  });
});

describe('trust, from the project page', () => {
  it('an untrusted project is trusted in place after a confirm that names the folder', async () => {
    const port = makePort();
    const view = renderPage(port);
    fireEvent.click(await view.findByRole('button', { name: 'Trust this project' }));
    const confirm = view.getByTestId('governed-trust-confirm');
    expect(confirm.textContent).toContain('/home/ada/code/tm8');
    expect(port.update).not.toHaveBeenCalled();
    fireEvent.click(within(confirm).getByRole('button', { name: 'Trust' }));
    await waitFor(() => expect(port.update).toHaveBeenCalledWith('proj-tm8ui', { trust: 'trusted' }));
    await waitFor(() => expect(view.getByTestId('governed-trust').getAttribute('data-trust')).toBe('trusted'));
    expect(view.getByRole('button', { name: 'Untrust' })).toBeTruthy();
  });

  it('a member sees who can trust it, and no switch', async () => {
    const view = renderPage(makePort({}, [record({ workingDir: undefined })]));
    expect((await view.findByTestId('governed-trust-ask')).textContent).toContain('node admin');
    expect(view.queryByTestId('governed-trust-toggle')).toBeNull();
  });
});

describe('git status', () => {
  it('names the current branch and where it stands against the default', async () => {
    const view = renderPage(makePort());
    const current = await view.findByTestId('governed-git-current');
    expect(current.textContent).toContain('feat/folder');
    expect(current.textContent).toContain('↑3 ↓1 vs main');
    expect(view.getByTestId('governed-git').textContent).toContain('2 branches');
    expect(view.getByTestId('governed-git-worktrees').textContent).toBe('0 active worktrees');
  });

  it('says a folder that is not a repository is not one', async () => {
    const port = makePort({ branches: vi.fn(async () => { throw new CollabError('invalid_input', 'not a git repository'); }) });
    const view = renderPage(port);
    expect((await view.findByTestId('governed-git-error')).textContent).toBe('This folder is not a git repository.');
  });
});

describe('everything in the project, filterable', () => {
  it('lists what is recorded in the project and filters it by kind', async () => {
    const view = renderPage(makePort(), [sessionLive, taskQueued]);
    const work = view.getByTestId('governed-work');
    expect(within(work).getAllByTestId('governed-work-row')).toHaveLength(2);
    fireEvent.click(within(work).getByRole('tab', { name: new RegExp(getKind(sessionLive.kind).labelPlural) }));
    const rows = within(work).getAllByTestId('governed-work-row');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute('data-kind')).toBe(sessionLive.kind);
    fireEvent.click(within(work).getByRole('tab', { name: /All/ }));
    expect(within(work).getAllByTestId('governed-work-row')).toHaveLength(2);
  });

  it('says what will appear when nothing has run yet', () => {
    const view = renderPage(makePort());
    expect(view.getByTestId('governed-work').textContent).toContain('Nothing has run in this project yet');
  });
});
