// @vitest-environment jsdom
/**
 * The Project files browser source (U2): the registry entry on the rail and in
 * the browser column, lazy listing per opened folder, single vs double click,
 * the project switcher with per-project state, reveal of the active file tab,
 * and the unavailable / empty / error / truncated states.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectFileListing } from '@tm8/contract';
import { browserSources } from '../tab-workspace/adapters/browserSources';
import { getBrowserSourceStore, resetBrowserSourceStores } from '../tab-workspace/runtime/browserSourceStore';
import { resetRailStores } from '../tab-workspace/runtime/railStore';
import { createWorkspaceStore, type WorkspaceStore } from '../tab-workspace/runtime/store';
import { Browser } from '../tab-workspace/view/Browser';
import { WorkspaceProvider, type WorkspaceContextValue, type WorkspaceGateHandles } from '../tab-workspace/view/context';
import { WorkspaceRail } from '../tab-workspace/view/WorkspaceRail';
import { getProjectTreeStore, projectTreeKey, resetProjectTreeStores } from './treeStore';

const SPACE = 'space-pft';
const ROOTS: Record<string, string> = { p1: '/work/app', p2: '/work/lib' };

function listing(projectId: string, rel: string, dirs: string[], files: string[], truncated = false): ProjectFileListing {
  const root = ROOTS[projectId]!;
  const base = rel ? `${root}/${rel}` : root;
  return {
    projectId,
    workingDir: root,
    path: base,
    parentPath: rel ? root : null,
    separator: '/',
    directories: dirs.map((name) => ({ name, path: `${base}/${name}` })),
    files: files.map((name) => ({
      name,
      path: `${base}/${name}`,
      sizeBytes: 1,
      modifiedAt: '2026-10-07T00:00:00Z',
      mime: 'text/plain',
      attachable: true,
    })),
    truncated,
    maxSizeBytes: 1_000_000,
  };
}

/** A fake node: `tree[projectId][relDir] = [dirs, files, truncated?]`. */
type FakeTree = Record<string, Record<string, [string[], string[], boolean?]>>;
const TREE: FakeTree = {
  p1: {
    '': [['src', '.git', 'node_modules'], ['README.md']],
    src: [['balance'], ['index.ts']],
    'src/balance': [[], ['rounding.ts', 'format.ts']],
    node_modules: [['react'], []],
  },
  p2: { '': [['lib'], ['package.json']], lib: [[], ['a.ts']] },
};

function fakeList(tree: FakeTree = TREE) {
  return vi.fn(async (projectId: string, path?: string) => {
    const root = ROOTS[projectId]!;
    const rel = path === undefined || path === root ? '' : path.slice(root.length + 1);
    const entry = tree[projectId]?.[rel];
    if (!entry) throw new Error(`ENOENT ${rel}`);
    return listing(projectId, rel, entry[0], entry[1], entry[2] ?? false);
  });
}

const PROJECTS = [
  { id: 'p1', name: 'app' },
  { id: 'p2', name: 'lib' },
];

function mount({
  list = fakeList(),
  projects = PROJECTS,
  withFiles = true,
  ui = 'browser',
}: { list?: ReturnType<typeof fakeList>; projects?: unknown[]; withFiles?: boolean; ui?: 'browser' | 'rail' } = {}) {
  const store = createWorkspaceStore('viewer-1', SPACE);
  const dispatch = vi.fn(() => ({ status: 'applied' }) as never);
  const seam = {
    projects: vi.fn(async () => projects),
    ...(withFiles ? { projectFiles: { list, read: vi.fn(), attach: vi.fn() } } : {}),
  };
  const gate = {
    data: ui === 'browser' ? { seam } : undefined,
    shellTabs: [],
    openPalette: vi.fn(),
    onSelectViewTab: vi.fn(),
    navigateTo: vi.fn(),
    accountSlot: undefined,
    activeViewTabId: null,
  } as unknown as WorkspaceGateHandles;
  const value = {
    runtime: { dispatch } as never,
    store,
    dispatch,
    viewerId: 'viewer-1',
    spaceId: SPACE,
    gate,
  } as WorkspaceContextValue;
  const view = render(
    <WorkspaceProvider value={value}>{ui === 'browser' ? <Browser /> : <WorkspaceRail />}</WorkspaceProvider>,
  );
  return { view, store, dispatch, list, seam };
}

const row = (path: string) =>
  document.querySelector<HTMLElement>(`[data-file-path="${path}"], [data-dir-path="${path}"]`);
const rowPaths = () =>
  Array.from(document.querySelectorAll<HTMLElement>('[data-file-path], [data-dir-path]')).map(
    (el) => el.dataset.filePath ?? el.dataset.dirPath,
  );

function activateFile(store: WorkspaceStore, projectId: string, path: string) {
  act(() => {
    store.setState({
      tabs: { t1: { id: 't1', type: 'file', projectId, path, preview: false } },
      orderedTabIds: ['t1'],
      presentation: { surface: 'tab', tabId: 't1' },
    } as never);
  });
}

beforeEach(() => {
  window.localStorage.clear();
  resetRailStores();
  resetBrowserSourceStores();
  resetProjectTreeStores();
});
afterEach(() => cleanup());

describe('the registry entry', () => {
  it('registers Project files as a non-entity browser source', () => {
    expect(browserSources().map((s) => [s.id, s.label])).toEqual([['project-files', 'Project files']]);
  });

  it('the rail draws it from the registry; a press shows it, a kind press clears it', () => {
    const { dispatch } = mount({ ui: 'rail' });
    const sources = within(screen.getByTestId('tws-rail-sources'));
    const button = sources.getByRole('button', { name: 'Project files' });
    fireEvent.click(button);
    expect(getBrowserSourceStore(SPACE).getState().source).toBe('project-files');
    expect(button.getAttribute('aria-current')).toBe('true');
    /* No kind reads current while a source shows. */
    expect(document.querySelectorAll('button[data-kind][aria-current="true"]')).toHaveLength(0);

    const [task] = Array.from(document.querySelectorAll<HTMLButtonElement>('button[data-kind="task"]'));
    fireEvent.click(task!);
    expect(getBrowserSourceStore(SPACE).getState().source).toBeNull();
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ command: 'workspace.browser.set' }));
  });
});

describe('the Project files panel', () => {
  beforeEach(() => getBrowserSourceStore(SPACE).getState().setSource('project-files'));

  it('the browser column shows the selected source', async () => {
    mount();
    expect(screen.getByTestId('tws-browser').dataset.source).toBe('project-files');
    expect(await screen.findByTestId('pft')).toBeTruthy();
  });

  it('says so when the node cannot read project folders', async () => {
    mount({ withFiles: false });
    expect(await screen.findByText('Project files unavailable')).toBeTruthy();
  });

  it('says so when no project is connected', async () => {
    mount({ projects: [] });
    expect(await screen.findByText('No projects connected')).toBeTruthy();
  });

  it('lists lazily: the root on mount, then one call per folder opened', async () => {
    const { list } = mount();
    await waitFor(() => expect(row('src')).toBeTruthy());
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenLastCalledWith('p1', undefined);
    /* Folders first, .git hidden, node_modules dimmed. */
    expect(rowPaths()).toEqual(['node_modules', 'src', 'README.md']);
    expect(row('node_modules')!.dataset.dim).toBe('true');
    expect(row('src')!.dataset.dim).toBeUndefined();

    fireEvent.click(row('src')!);
    await waitFor(() => expect(row('src/index.ts')).toBeTruthy());
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenLastCalledWith('p1', '/work/app/src');

    /* Closing and reopening does not list again. */
    fireEvent.click(row('src')!);
    fireEvent.click(row('src')!);
    expect(row('src/index.ts')).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);

    /* node_modules still opens. */
    fireEvent.click(row('node_modules')!);
    await waitFor(() => expect(row('node_modules/react')).toBeTruthy());
    expect(row('node_modules/react')!.dataset.dim).toBe('true');

    fireEvent.click(screen.getByTestId('pft-collapse'));
    expect(rowPaths()).toEqual(['node_modules', 'src', 'README.md']);
  });

  it('a single click opens a preview tab, a double click keeps it', async () => {
    const { dispatch } = mount();
    await waitFor(() => expect(row('README.md')).toBeTruthy());
    fireEvent.click(row('README.md')!);
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: 'workspace.files.open',
        args: { projectId: 'p1', path: 'README.md', preview: true },
      }),
    );
    fireEvent.doubleClick(row('README.md')!);
    expect(dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        command: 'workspace.files.open',
        args: { projectId: 'p1', path: 'README.md', preview: false },
      }),
    );
  });

  it('filters by name and remembers the filter', async () => {
    mount();
    await waitFor(() => expect(row('src')).toBeTruthy());
    fireEvent.change(screen.getByTestId('pft-filter'), { target: { value: 'read' } });
    expect(rowPaths()).toEqual(['README.md']);
    expect(getProjectTreeStore(SPACE).getState().views.p1?.filter).toBe('read');
  });

  it('switching projects keeps each project\'s open folders and filter, persisted', async () => {
    const { list } = mount();
    await waitFor(() => expect(row('src')).toBeTruthy());
    fireEvent.click(row('src')!);
    await waitFor(() => expect(row('src/index.ts')).toBeTruthy());

    fireEvent.change(screen.getByTestId('pft-project'), { target: { value: 'p2' } });
    await waitFor(() => expect(row('lib')).toBeTruthy());
    expect(list).toHaveBeenLastCalledWith('p2', undefined);
    expect(row('src')).toBeNull();
    fireEvent.change(screen.getByTestId('pft-filter'), { target: { value: 'pack' } });

    fireEvent.change(screen.getByTestId('pft-project'), { target: { value: 'p1' } });
    await waitFor(() => expect(row('src/index.ts')).toBeTruthy());
    expect((screen.getByTestId('pft-filter') as HTMLInputElement).value).toBe('');

    const stored = JSON.parse(window.localStorage.getItem(projectTreeKey(SPACE))!);
    expect(stored.projectId).toBe('p1');
    expect(stored.views.p1.open).toEqual(['src']);
    expect(stored.views.p2.filter).toBe('pack');

    /* A reload restores the project and its open folders. */
    cleanup();
    resetProjectTreeStores();
    mount();
    await waitFor(() => expect(row('src/index.ts')).toBeTruthy());
    expect((screen.getByTestId('pft-project') as HTMLSelectElement).value).toBe('p1');
  });

  it('reveals the active file tab: opens its folders and selects it', async () => {
    const { store, list } = mount();
    await waitFor(() => expect(row('src')).toBeTruthy());
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    activateFile(store, 'p1', 'src/balance/rounding.ts');
    await waitFor(() => expect(row('src/balance/rounding.ts')).toBeTruthy());
    expect(list).toHaveBeenCalledWith('p1', '/work/app/src');
    expect(list).toHaveBeenCalledWith('p1', '/work/app/src/balance');
    expect(row('src/balance/rounding.ts')!.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(scrolled).toHaveBeenCalled());
    expect(getProjectTreeStore(SPACE).getState().views.p1?.open).toEqual(['src', 'src/balance']);

    /* A file of another project is not revealed here. */
    activateFile(store, 'p2', 'lib/a.ts');
    expect(row('src/balance/rounding.ts')!.getAttribute('aria-selected')).toBe('false');
  });

  it('a folder that cannot be read says so inline and retries', async () => {
    const tree: FakeTree = { p1: { '': [['secret'], []] }, p2: {} };
    const list = fakeList(tree);
    mount({ list });
    await waitFor(() => expect(row('secret')).toBeTruthy());
    fireEvent.click(row('secret')!);
    const error = await screen.findByTestId('pft-dir-error');
    expect(error.textContent).toContain('ENOENT secret');
    tree.p1!.secret = [[], ['ok.txt']];
    fireEvent.click(within(error).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(row('secret/ok.txt')).toBeTruthy());
    expect(screen.queryByTestId('pft-dir-error')).toBeNull();
  });

  it('a listing cut short ends with "More files not shown"', async () => {
    mount({ list: fakeList({ p1: { '': [[], ['a.ts'], true] }, p2: {} }) });
    expect((await screen.findByTestId('pft-more')).textContent).toContain('More files not shown');
  });
});
