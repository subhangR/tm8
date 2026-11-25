import { describe, expect, it } from 'vitest';

import { expandHomePath, projectDirName, projectHomeDisplayPath } from '../src/index.js';

describe('the home default for a project working directory', () => {
  it('turns a project name into one safe folder name', () => {
    expect(projectDirName('My Project!')).toBe('my-project');
    expect(projectDirName('  tm8  ')).toBe('tm8');
    expect(projectDirName('a/b\\c')).toBe('a-b-c');
    expect(projectDirName('../..')).toBe('');
    expect(projectDirName('.hidden')).toBe('hidden');
    expect(projectDirName('!!!')).toBe('');
  });

  it('shows the default as ~/<dir>, or nothing when the name gives no folder', () => {
    expect(projectHomeDisplayPath('Docs Site')).toBe('~/docs-site');
    expect(projectHomeDisplayPath('')).toBeNull();
  });

  it('shows the default beneath the node projects folder when it is known', () => {
    expect(projectHomeDisplayPath('Docs Site', '/var/lib/tm8/prod/projects')).toBe('/var/lib/tm8/prod/projects/docs-site');
    expect(projectHomeDisplayPath('Docs Site', '/srv/projects/')).toBe('/srv/projects/docs-site');
    expect(projectHomeDisplayPath('Docs Site', null)).toBe('~/docs-site');
    expect(projectHomeDisplayPath('!!!', '/srv/projects')).toBeNull();
  });

  it('expands only a leading ~ or ~/', () => {
    expect(expandHomePath('~', '/home/me')).toBe('/home/me');
    expect(expandHomePath('~/work/tm8', '/home/me/')).toBe('/home/me/work/tm8');
    expect(expandHomePath('/srv/tm8', '/home/me')).toBe('/srv/tm8');
    expect(expandHomePath('~other/x', '/home/me')).toBe('~other/x');
  });
});
