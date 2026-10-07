// @vitest-environment jsdom
/**
 * The Project files tree as data (U2): ordering (folders first, by name),
 * `.git` hidden, `node_modules` dimmed with its contents, the truncated row,
 * filtering over listed folders, which folders are still to list, and the
 * per-project remembered state.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFileListing } from '@tm8/contract';
import { ancestorDirs, pendingDirs, treeRows, type DirState } from './tree';
import { createProjectTreeStore, projectTreeKey } from './treeStore';

const ROOT = '/work/app';

function listing(rel: string, dirs: string[], files: string[], truncated = false): ProjectFileListing {
  const base = rel ? `${ROOT}/${rel}` : ROOT;
  return {
    projectId: 'p1',
    workingDir: ROOT,
    path: base,
    parentPath: rel ? ROOT : null,
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

const ready = (l: ProjectFileListing): DirState => ({ status: 'ready', listing: l });

describe('treeRows', () => {
  it('draws folders first, each group by name, and never .git', () => {
    const dirs = new Map([['', ready(listing('', ['src', '.git', 'docs'], ['b.ts', 'A.md', '.git', 'a10.ts', 'a2.ts']))]]);
    const rows = treeRows(dirs, new Set());
    expect(rows.map((r) => (r.type === 'dir' || r.type === 'file' ? `${r.type}:${r.path}` : r.type))).toEqual([
      'dir:docs',
      'dir:src',
      'file:A.md',
      'file:a2.ts',
      'file:a10.ts',
      'file:b.ts',
    ]);
  });

  it('dims node_modules and everything under it, and it still opens', () => {
    const dirs = new Map([
      ['', ready(listing('', ['node_modules', 'src'], []))],
      ['node_modules', ready(listing('node_modules', ['react'], ['x.js']))],
    ]);
    const rows = treeRows(dirs, new Set(['node_modules']));
    const dim = Object.fromEntries(rows.flatMap((r) => (r.type === 'dir' || r.type === 'file' ? [[r.path, r.dim]] : [])));
    expect(dim).toEqual({ node_modules: true, 'node_modules/react': true, 'node_modules/x.js': true, src: false });
  });

  it('nests open folders one level deeper, with a loading row until listed', () => {
    const dirs = new Map([['', ready(listing('', ['src'], ['README.md']))]]);
    const rows = treeRows(dirs, new Set(['src']));
    expect(rows).toEqual([
      { type: 'dir', path: 'src', name: 'src', depth: 0, open: true, dim: false },
      { type: 'loading', parent: 'src', depth: 1 },
      { type: 'file', path: 'README.md', name: 'README.md', depth: 0, dim: false },
    ]);
  });

  it('ends a truncated directory with a "more not shown" row', () => {
    const dirs = new Map([['', ready(listing('', [], ['a.ts'], true))]]);
    expect(treeRows(dirs, new Set()).at(-1)).toEqual({ type: 'more', parent: '', depth: 0 });
  });

  it('shows a directory read error inline', () => {
    const dirs = new Map<string, DirState>([
      ['', ready(listing('', ['src'], []))],
      ['src', { status: 'error', message: 'EACCES' }],
    ]);
    expect(treeRows(dirs, new Set(['src']))[1]).toEqual({ type: 'error', parent: 'src', depth: 1, message: 'EACCES' });
  });

  it('filters by name over listed folders, opening the ones holding a match', () => {
    const dirs = new Map([
      ['', ready(listing('', ['src', 'docs'], ['round.md', 'other.ts']))],
      ['src', ready(listing('src', ['balance'], ['index.ts']))],
      ['src/balance', ready(listing('src/balance', [], ['rounding.ts', 'format.ts']))],
    ]);
    const rows = treeRows(dirs, new Set(), 'ROUND');
    expect(rows.map((r) => (r.type === 'dir' ? `dir:${r.path}:${r.open}` : r.type === 'file' ? r.path : r.type))).toEqual([
      'dir:src:true',
      'dir:src/balance:true',
      'src/balance/rounding.ts',
      'round.md',
    ]);
  });
});

describe('pendingDirs (lazy: one list per reachable open folder)', () => {
  it('asks for the root first, then only open folders whose parents are listed', () => {
    expect(pendingDirs(new Map(), new Set(['src', 'src/a']))).toEqual(['']);
    const dirs = new Map([['', ready(listing('', ['src', 'docs'], []))]]);
    expect(pendingDirs(dirs, new Set(['src', 'src/a']))).toEqual(['src']);
    const more = new Map([...dirs, ['src', { status: 'loading' } as DirState]]);
    expect(pendingDirs(more, new Set(['src', 'src/a']))).toEqual([]);
  });

  it('names a file\'s folders to reveal it', () => {
    expect(ancestorDirs('a/b/c.ts')).toEqual(['a', 'a/b']);
    expect(ancestorDirs('c.ts')).toEqual([]);
  });
});

describe('treeStore: per-project state, persisted', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps open folders, filter and scroll per project and restores them after a reload', () => {
    const store = createProjectTreeStore('s1');
    store.getState().selectProject('p1');
    store.getState().setOpen('p1', 'src', true);
    store.getState().setFilter('p1', 'round');
    store.getState().setScroll('p1', 120);
    store.getState().selectProject('p2');
    store.getState().openAll('p2', ['lib', 'lib/x']);

    const reloaded = createProjectTreeStore('s1');
    const state = reloaded.getState();
    expect(state.projectId).toBe('p2');
    expect(state.views.p1).toEqual({ open: ['src'], filter: 'round', scrollTop: 120 });
    expect(state.views.p2).toEqual({ open: ['lib', 'lib/x'], filter: '', scrollTop: 0 });
    reloaded.getState().collapseAll('p1');
    expect(reloaded.getState().views.p1?.open).toEqual([]);
    expect(createProjectTreeStore('s2').getState().views).toEqual({});
  });

  it('survives garbage in storage', () => {
    window.localStorage.setItem(projectTreeKey('s1'), '{"projectId":3,"views":{"p1":{"open":[1,"a"],"scrollTop":-4}}}');
    expect(createProjectTreeStore('s1').getState()).toMatchObject({
      projectId: null,
      views: { p1: { open: ['a'], filter: '', scrollTop: 0 } },
    });
  });
});
