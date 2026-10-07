import { describe, expect, it } from 'vitest';
import { buildChangeTree, commonDir, filesUnder, isOutsideAnyRepo, relativeTo, visibleChangeRows } from './change-paths';

const tree = (paths: string[]) => buildChangeTree(paths.map((p) => ({ rel: p, item: p })));
const rows = (paths: string[], collapsed: string[] = []) =>
  visibleChangeRows(tree(paths), new Set(collapsed)).map(({ node, depth }) => `${depth}:${node.kind}:${node.name}`);

describe('change-paths', () => {
  it('compacts single-folder chains and puts folders before files', () => {
    expect(rows(['packages/ui/src/a.ts', 'packages/ui/src/b.ts', 'README.md'])).toEqual([
      '0:dir:packages/ui/src',
      '1:file:a.ts',
      '1:file:b.ts',
      '0:file:README.md',
    ]);
  });

  it('is open by default and hides a collapsed folder’s rows', () => {
    expect(rows(['src/a.ts', 'src/lib/b.ts'], ['src'])).toEqual(['0:dir:src']);
    expect(rows(['src/a.ts', 'src/lib/b.ts'])).toEqual(['0:dir:src', '1:dir:lib', '2:file:b.ts', '1:file:a.ts']);
  });

  it('counts and collects every file beneath a folder', () => {
    const [src] = tree(['src/a.ts', 'src/lib/b.ts']);
    expect(src!.kind === 'dir' ? src!.fileCount : -1).toBe(2);
    expect(filesUnder(src!).sort()).toEqual(['src/a.ts', 'src/lib/b.ts']);
  });

  it('finds the common directory and strips it', () => {
    const root = commonDir(['/repo/pkg/a.ts', '/repo/pkg/sub/b.ts']);
    expect(root).toBe('/repo/pkg/');
    expect(relativeTo(root, '/repo/pkg/sub/b.ts')).toBe('sub/b.ts');
    expect(commonDir([])).toBe('');
  });

  it('treats temp and credential paths as outside any repo (D9)', () => {
    expect(isOutsideAnyRepo('/tmp/x.txt')).toBe(true);
    expect(isOutsideAnyRepo('/home/tm8/prod-data/credentials/id_x/gh.json')).toBe(true);
    expect(isOutsideAnyRepo('/home/tm8/prod-data/scratch/s/w1/a.ts')).toBe(false);
  });
});
